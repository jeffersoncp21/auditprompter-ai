'use strict';
/**
 * AuditPrompter AI — Copiloto & Teleprompter Ao Vivo de Auditoria Interna.
 *
 * Arquitetura:
 *  - Sessão (S): tudo o que pertence a uma reunião. Salva automaticamente no navegador a cada alteração.
 *  - Configurações (settings): preferências do auditor. As chaves de API ficam no servidor local.
 *  - Runtime (rt): estado efêmero (streams de áudio, timers, fila de análise, janela flutuante).
 *
 * Fluxo ao vivo:
 *  Microfone  → reconhecimento de voz do navegador → transcrição "Auditor"
 *  Áudio da reunião → blocos de áudio → Gemini (transcrição literal) → transcrição "Auditado"
 *  Nova fala na transcrição → análise agendada (com pausa e intervalo mínimo, uma por vez)
 *  → cartões pareados (assunto × pergunta/tela) + RCM + pontos em aberto + divergências.
 */

// ============================================================================
// UTILITÁRIOS
// ============================================================================
const $ = (id) => document.getElementById(id);

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function nowTime(withSeconds = true) {
  const opts = withSeconds ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
  return new Date().toLocaleTimeString('pt-BR', opts);
}

function safeGet(key, fallback = null) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch (_) {}
}

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
const escapeAttr = escapeHtml;

function norm(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function showToast(message, ms = 3600) {
  const container = $('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, ms);
}

function downloadFile(content, filename, mimeType) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function sanitizeFileName(name) {
  return String(name || 'Auditoria')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 40);
}

function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateBr(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('pt-BR');
}

function formatDueDate(yyyyMmDd) {
  if (!yyyyMmDd) return '';
  const [y, m, d] = String(yyyyMmDd).split('-');
  return y && m && d ? `${d}/${m}/${y}` : yyyyMmDd;
}

async function copyToClipboard(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    if (okMessage) showToast(okMessage);
    return true;
  } catch (_) {
    showToast('Não foi possível copiar automaticamente. Selecione o texto e copie manualmente.');
    return false;
  }
}

function extractJsonObject(rawText) {
  const cleaned = String(rawText || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last > first) return JSON.parse(cleaned.slice(first, last + 1));
  return JSON.parse(cleaned);
}

const METHODOLOGY_LABELS = {
  walkthrough_coso: 'Walkthrough fim-a-fim (TOD) + COSO ICIF',
  sox_ipe: 'Auditoria SOX + rigor em evidências (IPE)',
  itgc_sod: 'Auditoria de TI (ITGC) + Segregação de Funções (SoD)',
  operational_risk: 'Riscos operacionais, fraude e eficiência'
};

// ============================================================================
// CONFIGURAÇÕES (preferências — sem chaves de API)
// ============================================================================
const SETTINGS_DEFAULTS = {
  theme: 'light',
  provider: 'claude',
  liveModel: 'claude-opus-5-5',
  liveEffort: 'low',
  reportModel: 'claude-opus-5-5',
  geminiModel: 'gemini-2.5-flash',
  sysChunkSec: 7,
  autoAnalyze: 'on',
  minAnalyzeGapSec: 10,
  persona: '',
  fontSize: 1.08
};

const settings = loadSettings();

function loadSettings() {
  let stored = {};
  try {
    stored = JSON.parse(safeGet('ap_settings', '{}')) || {};
  } catch (_) {}
  const legacy = {
    theme: safeGet('auditprompter_theme') || undefined,
    persona: safeGet('auditprompter_persona') || undefined,
    fontSize: parseFloat(safeGet('auditprompter_fontsize', '')) || undefined,
    geminiModel: safeGet('auditprompter_gemini_model') || undefined
  };
  Object.keys(legacy).forEach((k) => legacy[k] === undefined && delete legacy[k]);
  const merged = Object.assign({}, SETTINGS_DEFAULTS, legacy, stored);
  if (!['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].includes(merged.liveModel)) merged.liveModel = 'claude-opus-5-5';
  if (!['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].includes(merged.reportModel)) merged.reportModel = 'claude-opus-5-5';
  if (!['claude', 'gemini'].includes(merged.provider)) merged.provider = 'claude';
  return merged;
}

function persistSettings() {
  safeSet('ap_settings', JSON.stringify(settings));
}

const serverStatus = { online: false, claude: false, gemini: false };

// ============================================================================
// RUNTIME (efêmero)
// ============================================================================
const rt = {
  audioCtx: null,
  sysStream: null,
  sysAnalyser: null,
  sysSegments: null,
  sysEnergy: false,
  sysCycleTimer: null,
  micStream: null,
  micAnalyser: null,
  micSegments: null,
  micEnergy: false,
  speechRecognition: null,
  transcribeQueue: [],
  transcribing: false,
  isAnalyzing: false,
  pendingAnalysis: null,
  analyzeTimer: null,
  analyzeDueAt: 0,
  lastAutoAnalysisAt: 0,
  pipWindow: null,
  tpFilter: 'all',
  focusedQuestionId: null,
  simulationIndex: 0,
  saveTimer: null,
  vuFrame: null,
  statusTicker: null
};

// ============================================================================
// SESSÃO (persistida)
// ============================================================================
const SESSION_PREFIX = 'ap_session_';
const SESSION_INDEX_KEY = 'ap_sessions_index';
const CURRENT_SESSION_KEY = 'ap_current_session';

let S = null;

function newSessionObject(templateKey = 'p2p') {
  const now = new Date().toISOString();
  const session = {
    version: 2,
    id: uid('ses'),
    projectId: '',
    meetingTitle: 'Reunião 01 — Walkthrough',
    createdAt: now,
    updatedAt: now,
    templateKey,
    topic: 'Mapeamento de Processo e Controles Internos',
    methodology: 'walkthrough_coso',
    scope: '',
    participants: '',
    prepMaterial: '',
    plannedQuestionsText: '',
    consent: null,
    coachingTip:
      'Inicie a reunião pedindo ao entrevistado para explicar o processo desde o gatilho inicial até a conclusão, compartilhando a tela do sistema principal.',
    transcript: [],
    transcriptSeq: 0,
    analyzedUpTo: 0,
    questions: [],
    screenRequests: [],
    risks: [],
    controls: [],
    pbcList: [],
    moments: [],
    openPoints: [],
    divergences: [],
    checklist: getDefaultChecklist(),
    counters: { R: 0, C: 0, P: 0 },
    report: { narrative: '', minutes: null, steps5w2h: [], generatedBy: '', generatedAt: '' }
  };
  S = session;
  if (templateKey && AUDIT_TEMPLATES[templateKey]) applyTemplateToSession(templateKey, { replaceScript: true });
  return session;
}

function nextCode(kind) {
  S.counters[kind] = (S.counters[kind] || 0) + 1;
  return `${kind}${String(S.counters[kind]).padStart(2, '0')}`;
}

function readSessionIndex() {
  try {
    const arr = JSON.parse(safeGet(SESSION_INDEX_KEY, '[]'));
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function writeSessionIndex(list) {
  safeSet(SESSION_INDEX_KEY, JSON.stringify(list));
}

function loadSessionById(id) {
  try {
    const raw = safeGet(SESSION_PREFIX + id);
    if (!raw) return null;
    return upgradeSession(JSON.parse(raw));
  } catch (_) {
    return null;
  }
}

// Garante campos de versões anteriores/arquivos importados.
function upgradeSession(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const base = {
    version: 2,
    projectId: '',
    meetingTitle: 'Reunião 01 — Walkthrough',
    templateKey: 'custom',
    topic: 'Mapeamento de Processo',
    methodology: 'walkthrough_coso',
    scope: '',
    participants: '',
    prepMaterial: '',
    plannedQuestionsText: '',
    consent: null,
    coachingTip: '',
    transcript: [],
    transcriptSeq: 0,
    analyzedUpTo: 0,
    questions: [],
    screenRequests: [],
    risks: [],
    controls: [],
    pbcList: [],
    moments: [],
    openPoints: [],
    divergences: [],
    checklist: getDefaultChecklist(),
    counters: { R: 0, C: 0, P: 0 },
    report: { narrative: '', minutes: null, steps5w2h: [], generatedBy: '', generatedAt: '' }
  };
  const s = Object.assign(base, obj);
  if (!s.id) s.id = uid('ses');
  if (!s.createdAt) s.createdAt = new Date().toISOString();
  ['transcript', 'questions', 'screenRequests', 'risks', 'controls', 'pbcList', 'moments', 'openPoints', 'divergences'].forEach((k) => {
    if (!Array.isArray(s[k])) s[k] = [];
  });
  s.transcriptSeq = Math.max(s.transcriptSeq || 0, s.transcript.length);
  s.transcript.forEach((t, i) => {
    if (!t.seq) t.seq = i + 1;
    if (!t.source) t.source = 'manual';
  });
  s.analyzedUpTo = Math.min(s.analyzedUpTo || 0, s.transcript.length);
  s.risks.forEach((r) => {
    if (!r.id) r.id = uid('r');
    if (!r.code) r.code = '';
    if (!r.source) r.source = 'IA';
  });
  s.controls.forEach((c) => {
    if (!c.id) c.id = uid('c');
    if (!Array.isArray(c.riskIds)) c.riskIds = [];
    if (!c.source) c.source = 'IA';
  });
  s.pbcList.forEach((p) => {
    if (!p.id) p.id = uid('pbc');
    if (!p.status || !PBC_STATUSES.includes(p.status)) p.status = 'Pendente';
  });
  s.questions.forEach((q) => {
    if (!q.origin) q.origin = 'roteiro';
  });
  if (!s.counters) s.counters = { R: 0, C: 0, P: 0 };
  ['R', 'C', 'P'].forEach((k) => (s.counters[k] = s.counters[k] || 0));
  const fixCodes = (list, kind) =>
    list.forEach((item) => {
      if (!item.code) {
        s.counters[kind] += 1;
        item.code = `${kind}${String(s.counters[kind]).padStart(2, '0')}`;
      }
    });
  fixCodes(s.risks.slice().reverse(), 'R');
  fixCodes(s.controls.slice().reverse(), 'C');
  fixCodes(s.pbcList.slice().reverse(), 'P');
  if (!s.report || typeof s.report !== 'object') s.report = base.report;
  if (!Array.isArray(s.checklist) || s.checklist.length === 0) s.checklist = getDefaultChecklist();
  return s;
}

const projectsStore = {
  projects: [],
  sessions: [],
  selectedProjectId: '',
  searchHits: {},
  searchQuery: '',
  expandedSessionId: '',
  expandedCache: {},
  diskSyncTimer: null
};

function activeProjectObj() {
  if (!S) return null;
  return projectsStore.projects.find((p) => p.id === S.projectId) || null;
}

function persistToDiskSoon() {
  if (!serverStatus.online || !S) return;
  clearTimeout(projectsStore.diskSyncTimer);
  projectsStore.diskSyncTimer = setTimeout(async () => {
    try {
      const res = await api('/api/projects/session', { body: { session: S } });
      if (res && res.project) {
        S.projectId = res.project.id;
        safeSet(SESSION_PREFIX + S.id, JSON.stringify(S));
        const pIdx = projectsStore.projects.findIndex((p) => p.id === res.project.id);
        if (pIdx >= 0) projectsStore.projects[pIdx] = res.project;
        else projectsStore.projects.unshift(res.project);
        if (res.sessionSummary) {
          projectsStore.sessions = [res.sessionSummary, ...projectsStore.sessions.filter((x) => x.id !== res.sessionSummary.id)];
        }
        if (!projectsStore.selectedProjectId) projectsStore.selectedProjectId = res.project.id;
        renderHeader();
        const ind = $('saveIndicator');
        if (ind) ind.textContent = `Salvo no disco às ${nowTime(false)}`;
      }
    } catch (_) {}
  }, 500);
}

function persistNow() {
  if (!S) return;
  clearTimeout(rt.saveTimer);
  rt.saveTimer = null;
  S.updatedAt = new Date().toISOString();
  const ok = safeSet(SESSION_PREFIX + S.id, JSON.stringify(S));
  const index = readSessionIndex().filter((e) => e.id !== S.id);
  index.unshift({
    id: S.id,
    projectId: S.projectId || '',
    meetingTitle: S.meetingTitle || S.topic,
    topic: S.topic,
    createdAt: S.createdAt,
    updatedAt: S.updatedAt,
    counts: { transcript: S.transcript.length, topics: S.questions.length, risks: S.risks.length, controls: S.controls.length, pbc: S.pbcList.length }
  });
  if (ok) {
    writeSessionIndex(index);
    safeSet(CURRENT_SESSION_KEY, S.id);
  }
  const indicator = $('saveIndicator');
  if (indicator) {
    indicator.textContent = ok ? `Salvo às ${nowTime(false)}` : '⚠ Falha no navegador — salvando em disco...';
    indicator.classList.toggle('error', !ok);
  }
  persistToDiskSoon();
}

function scheduleSave() {
  clearTimeout(rt.saveTimer);
  rt.saveTimer = setTimeout(persistNow, 400);
}

function loadCurrentSessionOrCreate() {
  const currentId = safeGet(CURRENT_SESSION_KEY);
  const loaded = currentId ? loadSessionById(currentId) : null;
  if (loaded) {
    S = loaded;
  } else {
    newSessionObject('p2p');
    persistNow();
  }
}

// Toda alteração de dados passa por aqui: re-renderiza, sincroniza a janela flutuante e salva.
function commit() {
  renderAll();
  syncFloatingTeleprompter();
  scheduleSave();
}

// ============================================================================
// TEMPLATES / ROTEIRO
// ============================================================================
function applyTemplateToSession(templateKey, { replaceScript = true } = {}) {
  const tpl = AUDIT_TEMPLATES[templateKey];
  if (!tpl) return;
  S.templateKey = templateKey;
  S.topic = tpl.topic;
  S.methodology = tpl.methodology;
  S.scope = tpl.scope;
  S.coachingTip = tpl.coachingTip;

  if (replaceScript) {
    S.questions = S.questions.filter((q) => q.origin !== 'roteiro');
  }
  const scriptQuestions = JSON.parse(JSON.stringify(tpl.questions || [])).map((q) => ({
    ...q,
    id: uid('q'),
    origin: 'roteiro',
    time: '',
    sourceIds: [],
    asked: false
  }));
  S.questions = [...S.questions, ...scriptQuestions];

  (tpl.screenRequests || []).forEach((s) => addScreenRequest({ title: s.title, script: s.script, ipeTip: s.ipeTip }));
  (tpl.risks || []).forEach((r) => addRisk({ ...r, source: 'Roteiro' }));
  (tpl.controls || []).forEach((c) => addControl({ ...c, source: 'Roteiro' }));
}

function generateSmartLocalTopicGuide(topic, scope) {
  S.coachingTip = `Conduza o walkthrough de "${topic}" pedindo ao entrevistado para compartilhar a tela de ${scope || 'sistema'} e demonstrar 1 transação real do início ao fim (Test of Design - TOD).`;
  const sys = scope || 'seu sistema principal';
  const guide = [
    {
      priority: 'critica',
      category: 'Walkthrough / Fluxo Fim-a-Fim',
      topicTitle: `1. Gatilho e Entrada do Processo (${topic})`,
      topicSummary: `Mapeamento do evento inicial que dispara o processo, áreas solicitantes e canais de entrada em ${sys}.`,
      text: `Para iniciarmos o mapeamento de "${topic}", você pode me explicar qual é o gatilho que inicia o processo e quais são as principais etapas até a conclusão?`,
      rationale: 'Entender o fluxo ponta a ponta (entradas, processamento, saídas) antes de aprofundar nos pontos de controle.',
      screenTitle: `Walkthrough ao vivo de caso real (${topic})`,
      screenScript: `Você pode compartilhar sua tela em ${sys} e abrir um caso real processado recentemente para acompanharmos as telas e o log de aprovação?`,
      ipeTip: 'IPE: capturar tela com código da transação, usuário executor, aprovador, data/hora e parâmetros.'
    },
    {
      priority: 'critica',
      category: 'Alçadas & Aprovação Sistêmica',
      topicTitle: '2. Alçadas de Aprovação e Travas Sistêmicas',
      topicSummary: 'Verificação se as aprovações ocorrem dentro do sistema com bloqueio preventivo automático ou se dependem de controles manuais.',
      text: `Em "${topic}", onde ficam registradas as aprovações? O sistema possui trava automática de alçada ou alguém consegue concluir a etapa sem aprovação prévia?`,
      rationale: 'Diferenciar controles preventivos automáticos (parametrizados) de controles manuais dependentes de pessoas.'
    },
    {
      priority: 'alta',
      category: 'Segregação de Funções (SoD)',
      topicTitle: '3. Segregação de Funções e Perfis de Acesso',
      topicSummary: 'Avaliação de conflitos entre quem solicita/executa a transação e quem aprova, altera cadastros ou realiza estornos.',
      text: `Quem executa ou solicita as atividades em "${topic}" possui acesso no sistema para também aprovar, alterar cadastros-base ou fazer ajustes/estornos?`,
      rationale: 'Avaliar conflitos de Segregação de Funções (SoD) e perfis de acesso excessivos.'
    },
    {
      priority: 'alta',
      category: 'Exceções & Controles Detectivos',
      topicTitle: '4. Tratamento de Exceções, Urgências e Conciliação',
      topicSummary: 'Mapeamento de fluxos emergenciais fora do padrão e relatórios detectivos usados para monitorar pendências.',
      text: `Quando ocorre uma urgência, erro ou exceção fora do fluxo normal de "${topic}", como isso é tratado e qual relatório ou conciliação garante que nada ficou pendente?`,
      rationale: 'Mapear caminhos de contorno (bypass) e controles detectivos de monitoramento.',
      screenTitle: 'Relatório de monitoramento / conciliação (validação de IPE)',
      screenScript: 'Pode mostrar na tela como você extrai o relatório de acompanhamento ou conciliação desse processo e quais filtros são utilizados?',
      ipeTip: 'IPE: verificar se o relatório é extraído direto da base oficial e se pode ser editado manualmente antes da revisão.'
    }
  ];
  S.questions = S.questions.filter((q) => q.origin !== 'roteiro');
  guide.forEach((g) => {
    S.questions.push({ ...g, id: uid('q'), origin: 'roteiro', time: '', riskAlert: '', sourceIds: [], asked: false });
    if (g.screenTitle) addScreenRequest({ title: g.screenTitle, script: g.screenScript, ipeTip: g.ipeTip });
  });
}

// ============================================================================
// MODELO DE DADOS: adicionar itens (com deduplicação e códigos)
// ============================================================================
const PBC_STATUSES = ['Pendente', 'Solicitado', 'Recebido', 'Validado', 'Não aplicável'];
const SEVERITIES = ['Alto', 'Médio', 'Baixo'];
const TOD_STATUSES = ['Desenho adequado', 'Com gap / fragilidade', 'Em avaliação (walkthrough)', 'Não testado'];
const ASSERTIONS = ['', 'Existência / Ocorrência', 'Completude', 'Exatidão / Precisão', 'Valorização / Alocação', 'Direitos e Obrigações', 'Apresentação e Divulgação', 'Autorização', 'Corte (Cut-off)'];

function validSourceIds(ids) {
  if (!Array.isArray(ids)) return [];
  const known = new Set(S.transcript.map((t) => `T${t.seq}`));
  return ids.map((x) => String(x).trim().toUpperCase()).filter((x) => known.has(x));
}

function addTranscript(speaker, source, text) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  S.transcriptSeq += 1;
  const entry = { id: uid('tr'), seq: S.transcriptSeq, time: nowTime(), speaker, source, text: clean };
  S.transcript.push(entry);
  return entry;
}

function addScreenRequest({ title, script, ipeTip }) {
  if (!title || !script) return;
  if (S.screenRequests.some((s) => norm(s.title) === norm(title))) return;
  S.screenRequests.unshift({ id: uid('s'), title, script, ipeTip: ipeTip || '', status: 'pending' });
}

function addRisk(r) {
  const title = String(r.title || '').trim();
  if (!title) return null;
  const existing = S.risks.find((x) => norm(x.title) === norm(title));
  if (existing) return existing;
  const risk = {
    id: uid('r'),
    code: nextCode('R'),
    severity: SEVERITIES.includes(r.severity) ? r.severity : 'Alto',
    title,
    description: r.description || '',
    recommendation: r.recommendation || '',
    assertion: r.assertion || '',
    source: r.source || 'IA',
    validated: Boolean(r.validated),
    sourceIds: validSourceIds(r.sourceIds),
    createdAt: new Date().toISOString()
  };
  S.risks.unshift(risk);
  return risk;
}

function addControl(c) {
  const name = String(c.name || '').trim();
  if (!name) return null;
  const existing = S.controls.find((x) => norm(x.name) === norm(name));
  if (existing) {
    (c.riskIds || []).forEach((rid) => !existing.riskIds.includes(rid) && existing.riskIds.push(rid));
    return existing;
  }
  const control = {
    id: uid('c'),
    code: nextCode('C'),
    name,
    type: c.type || 'Preventivo',
    nature: c.nature || 'Manual',
    frequency: c.frequency || 'Por transação',
    owner: c.owner || '',
    assertion: c.assertion || '',
    status: c.status || 'Em avaliação (walkthrough)',
    riskIds: Array.isArray(c.riskIds) ? c.riskIds.slice() : [],
    source: c.source || 'IA',
    validated: Boolean(c.validated),
    sourceIds: validSourceIds(c.sourceIds),
    createdAt: new Date().toISOString()
  };
  S.controls.unshift(control);
  return control;
}

function addPbc(p, { notify = true } = {}) {
  const title = String(p.title || '').trim();
  if (!title) return null;
  const existing = S.pbcList.find((x) => norm(x.title) === norm(title));
  if (existing) {
    if (notify) showToast(`Já consta na lista PBC: ${existing.code}`);
    return existing;
  }
  const item = {
    id: uid('pbc'),
    code: nextCode('P'),
    category: p.category || inferPbcCategory(title, p.detail || ''),
    priority: p.priority || 'Alta',
    title,
    purpose: p.purpose || 'Validar o desenho e a rastreabilidade do controle interno (Walkthrough / TOD).',
    detail: p.detail || 'Extrair com parâmetros de seleção, código da transação e data/hora visíveis (IPE).',
    owner: p.owner || '',
    dueDate: p.dueDate || '',
    format: p.format || 'Original (.xlsx / .pdf / Print integral)',
    status: PBC_STATUSES.includes(p.status) ? p.status : 'Pendente',
    source: p.source || 'Manual',
    questionId: p.questionId || '',
    createdAt: new Date().toISOString()
  };
  S.pbcList.unshift(item);
  if (notify) showToast(`Incluído na lista PBC: ${item.code} — ${title}`);
  return item;
}

function addOpenPoint(o) {
  const text = String(o.text || '').trim();
  if (!text) return null;
  if (S.openPoints.some((x) => norm(x.text) === norm(text))) return null;
  const item = {
    id: uid('op'),
    text,
    kind: ['sem_resposta', 'contradicao', 'pendencia'].includes(o.kind) ? o.kind : 'pendencia',
    status: 'aberto',
    source: o.source || 'IA',
    sourceIds: validSourceIds(o.sourceIds),
    time: nowTime(false)
  };
  S.openPoints.unshift(item);
  return item;
}

function addDivergence(d) {
  if (!d.documented && !d.stated) return null;
  const key = norm(`${d.documented} ${d.stated}`);
  if (S.divergences.some((x) => norm(`${x.documented} ${x.stated}`) === key)) return null;
  const item = {
    id: uid('dv'),
    documented: d.documented || '',
    stated: d.stated || '',
    impact: d.impact || '',
    source: d.source || 'IA',
    validated: false,
    sourceIds: validSourceIds(d.sourceIds),
    time: nowTime(false)
  };
  S.divergences.unshift(item);
  return item;
}

function addQuestion(q, origin) {
  const text = String(q.text || '').trim();
  if (!text) return null;
  const normText = norm(text);
  const normTopic = norm(q.topicTitle || '');
  if (S.questions.some((x) => norm(x.text) === normText || (normTopic && normTopic.length > 10 && norm(x.topicTitle) === normTopic))) return null;
  const item = {
    id: uid('q'),
    time: nowTime(false),
    origin,
    priority: ['critica', 'alta', 'normal'].includes(q.priority) ? q.priority : 'alta',
    category: q.category || 'Sondagem de Controle',
    topicTitle: q.topicTitle || q.category || 'Assunto mapeado na reunião',
    topicSummary: q.topicSummary || '',
    riskAlert: q.riskAlert || '',
    text,
    rationale: q.rationale || 'Validação de desenho de controle interno (TOD).',
    screenTitle: q.screenTitle || '',
    screenScript: q.screenScript || '',
    ipeTip: q.ipeTip || '',
    sourceIds: validSourceIds(q.sourceIds),
    asked: false
  };
  return item;
}

function markChecklist(ids) {
  (ids || []).forEach((id) => {
    const item = S.checklist.find((c) => c.id === id);
    if (item) item.covered = true;
  });
}

// ============================================================================
// SERVIDOR LOCAL / API
// ============================================================================
async function api(path, { method = 'POST', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-AuditPrompter': '1' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const txt = await res.text();
  let data = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch (_) {}
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || (data && data.message) || txt || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function refreshServerStatus() {
  try {
    const data = await api('/api/config', { method: 'GET' });
    serverStatus.online = true;
    serverStatus.claude = Boolean(data.claude);
    serverStatus.gemini = Boolean(data.gemini);
  } catch (_) {
    serverStatus.online = false;
    serverStatus.claude = false;
    serverStatus.gemini = false;
  }
  updateSettingsBadge();
  updateCaptureWarning();
}

// Versões anteriores guardavam as chaves no localStorage: move para o servidor e apaga do navegador.
async function migrateLegacyKeys() {
  const claudeKey = safeGet('auditprompter_claude_key', '');
  const geminiKey = safeGet('auditprompter_gemini_key', '');
  if (!claudeKey && !geminiKey) return;
  if (!serverStatus.online) return;
  try {
    await api('/api/config', { body: { claudeApiKey: claudeKey || undefined, geminiApiKey: geminiKey || undefined } });
    ['auditprompter_claude_key', 'auditprompter_gemini_key', 'auditprompter_claude_model', 'auditprompter_ai_provider', 'auditprompter_auto_interval'].forEach(safeRemove);
    await refreshServerStatus();
    showToast('Chaves de API migradas do navegador para o servidor local (mais seguro).', 5000);
  } catch (_) {}
}

function analysisProvider() {
  if (!serverStatus.online) return 'local';
  if (settings.provider === 'gemini') return serverStatus.gemini ? 'gemini' : serverStatus.claude ? 'claude' : 'local';
  return serverStatus.claude ? 'claude' : serverStatus.gemini ? 'gemini' : 'local';
}

function captureMode() {
  return (S.consent && S.consent.mode) || 'full';
}

function canTranscribeSystemAudio() {
  return serverStatus.online && captureMode() === 'full';
}

async function geminiGenerate(parts, { json = false } = {}) {
  const payload = {
    contents: [{ role: 'user', parts }],
    generationConfig: json ? { responseMimeType: 'application/json', temperature: 0.3 } : { temperature: 0.1 }
  };
  const data = await api('/api/gemini', { body: { model: settings.geminiModel, payload } });
  return ((data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [])
    .map((p) => p.text || '')
    .join('');
}

async function claudeMessage({ system, prompt, schema, model, effort }) {
  const data = await api('/api/claude/message', {
    body: { system, prompt, schema, model, effort, max_tokens: 16000 }
  });
  return data && data.text ? data.text : '';
}

// Chamada estruturada (JSON) independente do provedor.
async function aiJson({ provider, systemBlocks, prompt, schema, model, effort }) {
  if (provider === 'claude') {
    const text = await claudeMessage({ system: systemBlocks.map((t) => ({ text: t })), prompt, schema, model, effort });
    return extractJsonObject(text);
  }
  const text = await geminiGenerate(
    [
      {
        text: `${systemBlocks.join('\n\n')}\n\n${prompt}\n\nResponda SOMENTE com um objeto JSON válido que siga exatamente este JSON Schema:\n${JSON.stringify(schema)}`
      }
    ],
    { json: true }
  );
  return extractJsonObject(text);
}

// ============================================================================
// CAPTURA DE ÁUDIO
// ============================================================================
function ensureAudioContext() {
  if (!rt.audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    rt.audioCtx = new Ctx();
  }
  if (rt.audioCtx.state === 'suspended') rt.audioCtx.resume();
  return rt.audioCtx;
}

// Grava blocos independentes (cada bloco é um arquivo de áudio completo, com cabeçalho).
function createSegmentRecorder(stream) {
  const mimeType =
    ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find(
      (t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)
    ) || '';
  let rec = null;

  function start() {
    const chunks = [];
    rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    rec._chunks = chunks;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    rec.start();
  }

  function cut() {
    return new Promise((resolve) => {
      if (!rec || rec.state === 'inactive') {
        resolve(null);
        return;
      }
      const old = rec;
      old.onstop = () => {
        resolve(old._chunks.length ? new Blob(old._chunks, { type: old.mimeType || mimeType || 'audio/webm' }) : null);
      };
      try {
        old.stop();
      } catch (_) {
        resolve(null);
      }
      if (stream.active) {
        try {
          start();
        } catch (_) {
          rec = null;
        }
      } else {
        rec = null;
      }
    });
  }

  function stop() {
    if (rec && rec.state !== 'inactive') {
      rec.onstop = null;
      try {
        rec.stop();
      } catch (_) {}
    }
    rec = null;
  }

  return { start, cut, stop };
}

// Converte o bloco gravado em WAV 16 kHz mono (formato aceito com segurança pelo Gemini).
async function blobToWavBase64(blob) {
  const arrayBuf = await blob.arrayBuffer();
  const ctx = ensureAudioContext();
  const decoded = await ctx.decodeAudioData(arrayBuf.slice(0));
  const targetRate = 16000;
  const length = Math.max(1, Math.ceil(decoded.duration * targetRate));
  const offline = new OfflineAudioContext(1, length, targetRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);

  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return arrayBufferToBase64(buffer);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function blobToAudioPart(blob) {
  try {
    return { inlineData: { mimeType: 'audio/wav', data: await blobToWavBase64(blob) } };
  } catch (_) {
    const raw = arrayBufferToBase64(await blob.arrayBuffer());
    return { inlineData: { mimeType: (blob.type || 'audio/webm').split(';')[0], data: raw } };
  }
}

// --- Consentimento / LGPD -------------------------------------------------
let consentResolver = null;

function ensureConsent() {
  if (S.consent && S.consent.informed) return Promise.resolve(true);
  return new Promise((resolve) => {
    consentResolver = resolve;
    $('consentInformedChk').checked = false;
    const current = captureMode();
    document.querySelectorAll('input[name="captureMode"]').forEach((r) => (r.checked = r.value === current));
    $('consentModal').classList.remove('hidden');
  });
}

function confirmConsent() {
  if (!$('consentInformedChk').checked) {
    showToast('Confirme que os participantes foram informados para continuar.');
    return;
  }
  const mode = (document.querySelector('input[name="captureMode"]:checked') || {}).value || 'full';
  S.consent = { informed: true, mode, at: new Date().toISOString() };
  $('consentModal').classList.add('hidden');
  commit();
  if (consentResolver) consentResolver(true);
  consentResolver = null;
}

function cancelConsent() {
  $('consentModal').classList.add('hidden');
  if (consentResolver) consentResolver(false);
  consentResolver = null;
}

// --- Áudio da reunião (auditado) -----------------------------------------
async function toggleSystemAudio() {
  if (rt.sysStream) {
    stopSystemAudio();
    return;
  }
  if (!(await ensureConsent())) return;
  const mode = captureMode();
  if (mode !== 'full') {
    await noticeDialog(
      'Áudio da reunião desativado nesta sessão',
      mode === 'mic_only'
        ? 'No modo "Só meu microfone" o áudio da reunião não é capturado. Registre a fala do auditado no campo de anotação. Para mudar o modo, use "Nova sessão" ou edite o consentimento em Preparação.'
        : 'No modo "Sem áudio" nada é gravado. Registre os pontos manualmente no campo de anotação.'
    );
    return;
  }

  try {
    showToast('Selecione a aba/janela da reunião e marque "Compartilhar áudio".', 5000);
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include'
    });
    const audioTracks = displayStream.getAudioTracks();
    if (audioTracks.length === 0) {
      displayStream.getTracks().forEach((t) => t.stop());
      await noticeDialog(
        'Áudio da reunião não detectado',
        'Na janela de compartilhamento, marque "Compartilhar também o áudio do sistema" (tela inteira) ou "Compartilhar áudio da guia" (aba do Teams/Meet no navegador) antes de clicar em Compartilhar.'
      );
      return;
    }

    const ctx = ensureAudioContext();
    rt.sysStream = displayStream;
    const audioOnly = new MediaStream([audioTracks[0]]);
    const source = ctx.createMediaStreamSource(audioOnly);
    rt.sysAnalyser = ctx.createAnalyser();
    rt.sysAnalyser.fftSize = 256;
    source.connect(rt.sysAnalyser);

    audioTracks[0].onended = () => stopSystemAudio();
    displayStream.getVideoTracks().forEach((vt) => (vt.onended = () => stopSystemAudio()));

    rt.sysSegments = createSegmentRecorder(audioOnly);
    rt.sysSegments.start();
    rt.sysEnergy = false;
    clearInterval(rt.sysCycleTimer);
    rt.sysCycleTimer = setInterval(flushSystemSegment, Math.max(5, Number(settings.sysChunkSec) || 7) * 1000);

    $('sysAudioCard').classList.add('active-sys');
    $('sysAudioStateText').textContent = 'Ativo';
    $('liveInterimText').textContent = canTranscribeSystemAudio()
      ? 'Escutando o áudio da reunião — a fala do auditado será transcrita em blocos.'
      : 'Áudio da reunião conectado, mas sem transcrição (veja o aviso acima).';
    startVuMeterLoop();
    updateLiveStatusIndicator();
    updateCaptureWarning();
    showToast('Áudio da reunião conectado.');
  } catch (err) {
    console.warn('Captura do áudio do sistema cancelada ou com erro:', err);
  }
}

function stopSystemAudio() {
  clearInterval(rt.sysCycleTimer);
  rt.sysCycleTimer = null;
  if (rt.sysSegments) {
    // Aproveita o último trecho antes de desligar.
    const segs = rt.sysSegments;
    rt.sysSegments = null;
    if (rt.sysEnergy && canTranscribeSystemAudio()) {
      segs.cut().then((blob) => blob && enqueueTranscription(blob, 'Auditado', 'sys'));
    }
    setTimeout(() => segs.stop(), 50);
  }
  if (rt.sysStream) {
    rt.sysStream.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    rt.sysStream = null;
  }
  rt.sysAnalyser = null;
  $('sysAudioCard').classList.remove('active-sys');
  $('sysAudioStateText').textContent = 'Off';
  $('sysVuBar').style.width = '0%';
  updateLiveStatusIndicator();
  updateCaptureWarning();
  showToast('Áudio da reunião desconectado.');
}

async function flushSystemSegment(force = false) {
  if (!rt.sysSegments) return;
  const hadEnergy = rt.sysEnergy || force;
  rt.sysEnergy = false;
  const blob = await rt.sysSegments.cut();
  if (!hadEnergy || !blob || blob.size < 800) return;
  if (!canTranscribeSystemAudio()) return;
  enqueueTranscription(blob, 'Auditado', 'sys');
}

// --- Microfone (auditor) --------------------------------------------------
async function toggleMicAudio() {
  if (rt.micStream) {
    stopMicAudio();
    return;
  }
  if (!(await ensureConsent())) return;
  if (captureMode() === 'text_only') {
    await noticeDialog('Modo sem áudio', 'Nesta sessão nada é gravado. Registre os pontos no campo de anotação.');
    return;
  }

  try {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
    const ctx = ensureAudioContext();
    rt.micStream = micStream;
    const source = ctx.createMediaStreamSource(micStream);
    rt.micAnalyser = ctx.createAnalyser();
    rt.micAnalyser.fftSize = 256;
    source.connect(rt.micAnalyser);

    const hasWebSpeech = Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    rt.webSpeechProducedAt = 0;
    if (hasWebSpeech) {
      startWebSpeechRecognition();
    }
    if (serverStatus.online && captureMode() !== 'text_only') {
      rt.micSegments = createSegmentRecorder(micStream);
      rt.micSegments.start();
      rt.micEnergy = false;
      rt.micCycleTimer = setInterval(flushMicSegment, Math.max(5, Number(settings.sysChunkSec) || 7) * 1000);
    }

    $('micAudioCard').classList.add('active-mic');
    $('micAudioStateText').textContent = 'Ativo';
    $('liveInterimText').textContent = 'Ouvindo seu microfone — fale normalmente na reunião.';
    startVuMeterLoop();
    updateLiveStatusIndicator();
    updateCaptureWarning();
    showToast('Microfone ativado.');
  } catch (_) {
    await noticeDialog('Microfone indisponível', 'Não foi possível acessar o microfone. Verifique as permissões do navegador (ícone de cadeado na barra de endereço).');
  }
}

function stopMicAudio() {
  if (rt.speechRecognition) {
    const rec = rt.speechRecognition;
    rt.speechRecognition = null;
    rec.onend = null;
    try {
      rec.stop();
    } catch (_) {}
  }
  clearInterval(rt.micCycleTimer);
  rt.micCycleTimer = null;
  if (rt.micSegments) {
    rt.micSegments.stop();
    rt.micSegments = null;
  }
  if (rt.micStream) {
    rt.micStream.getTracks().forEach((t) => t.stop());
    rt.micStream = null;
  }
  rt.micAnalyser = null;
  $('micAudioCard').classList.remove('active-mic');
  $('micAudioStateText').textContent = 'Off';
  $('micVuBar').style.width = '0%';
  $('captionDot').classList.remove('speaking');
  updateLiveStatusIndicator();
  updateCaptureWarning();
  showToast('Microfone desligado.');
}

async function flushMicSegment(force = false) {
  if (!rt.micSegments) return;
  const hadEnergy = rt.micEnergy || force;
  rt.micEnergy = false;
  const blob = await rt.micSegments.cut();
  if (!hadEnergy || !blob || blob.size < 800) return;
  if (rt.webSpeechProducedAt && Date.now() - rt.webSpeechProducedAt < 6500 && !force) return;
  enqueueTranscription(blob, 'Auditor', 'mic');
}

function startWebSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition || rt.speechRecognition) return;
  const recognition = new SpeechRecognition();
  recognition.lang = 'pt-BR';
  recognition.continuous = true;
  recognition.interimResults = true;

  recognition.onresult = (event) => {
    const captionEl = $('liveInterimText');
    const dotEl = $('captionDot');
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const chunk = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        const finalText = chunk.trim();
        if (finalText.length > 2) {
          rt.webSpeechProducedAt = Date.now();
          addTranscript('Auditor', 'mic', finalText);
          captionEl.textContent = `Você: "${finalText}"`;
          dotEl.classList.remove('speaking');
          commit();
          scheduleAnalysis();
        }
      } else {
        interim += chunk;
      }
    }
    if (interim.trim()) {
      captionEl.textContent = `Ouvindo (você): "${interim.trim()}..."`;
      dotEl.classList.add('speaking');
    }
  };

  recognition.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      showToast('Reconhecimento de voz bloqueado pelo navegador.', 5000);
      rt.speechRecognition = null;
    }
  };

  recognition.onend = () => {
    if (rt.micStream && rt.speechRecognition === recognition) {
      try {
        recognition.start();
      } catch (_) {}
    }
  };

  try {
    recognition.start();
    rt.speechRecognition = recognition;
  } catch (_) {}
}

// --- Fila de transcrição (uma chamada por vez, em ordem) -------------------
function enqueueTranscription(blob, speaker, source) {
  rt.transcribeQueue.push({ blob, speaker, source });
  processTranscriptionQueue();
}

async function processTranscriptionQueue() {
  if (rt.transcribing) return;
  rt.transcribing = true;
  try {
    while (rt.transcribeQueue.length > 0) {
      const job = rt.transcribeQueue.shift();
      updateCycleStatus('Transcrevendo áudio...');
      try {
        const audioPart = await blobToAudioPart(job.blob);
        let text = '';
        if (serverStatus.gemini) {
          try {
            text = await geminiGenerate([
              {
                text:
                  'Transcreva LITERALMENTE, em português do Brasil, a fala deste trecho de áudio de uma reunião de auditoria. ' +
                  'Não resuma, não corrija o conteúdo e não invente palavras. Remova apenas vícios como "ãh" e "né" repetidos. ' +
                  'Se der para distinguir vozes diferentes, comece cada fala com "Participante 1:", "Participante 2:" etc. ' +
                  'Se não houver fala inteligível, responda exatamente: [SILENCIO]'
              },
              audioPart
            ]);
          } catch (_) {}
        }
        if (!text || !text.trim()) {
          const localRes = await api('/api/transcribe', {
            body: {
              audioBase64: audioPart.inlineData.data,
              mimeType: audioPart.inlineData.mimeType
            }
          });
          text = (localRes && localRes.text) || '';
        }
        const clean = String(text || '').trim();
        if (clean && !/^\[?\s*sil[eê]ncio\s*\]?\.?$/i.test(clean) && clean.length > 3) {
          addTranscript(job.speaker, job.source, clean);
          $('liveInterimText').textContent = `${job.speaker}: "${clean.slice(0, 160)}${clean.length > 160 ? '…' : ''}"`;
          commit();
          scheduleAnalysis();
        }
      } catch (err) {
        console.warn('Falha na transcrição:', err);
        showToast(`Falha ao transcrever o áudio: ${err.message}`, 5000);
      }
    }
  } finally {
    rt.transcribing = false;
    updateCycleStatus();
  }
}

// --- Indicadores ----------------------------------------------------------
function updateLiveStatusIndicator() {
  $('liveStatusDot').classList.toggle('active', Boolean(rt.sysStream || rt.micStream));
}

function startVuMeterLoop() {
  if (rt.vuFrame) return;
  const data = new Uint8Array(64);
  const tick = () => {
    if (!rt.sysAnalyser && !rt.micAnalyser) {
      rt.vuFrame = null;
      return;
    }
    if (rt.sysAnalyser) {
      rt.sysAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const peak = Math.max(...data);
      const pct = Math.min(100, Math.round((avg / 45) * 100));
      $('sysVuBar').style.width = `${pct}%`;
      if (pct >= 1 || peak > 10) {
        rt.sysEnergy = true;
        $('captionDot').classList.add('speaking');
      }
    }
    if (rt.micAnalyser) {
      rt.micAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const peak = Math.max(...data);
      const pct = Math.min(100, Math.round((avg / 45) * 100));
      $('micVuBar').style.width = `${pct}%`;
      if (pct >= 2 || peak > 14) {
        rt.micEnergy = true;
        $('captionDot').classList.add('speaking');
      }
    }
    rt.vuFrame = requestAnimationFrame(tick);
  };
  rt.vuFrame = requestAnimationFrame(tick);
}

function updateCaptureWarning() {
  const el = $('captureWarning');
  if (!el) return;
  const messages = [];
  if (!serverStatus.online) {
    messages.push('Servidor local não encontrado: abra o AuditPrompter pelo arquivo "Iniciar_Teleprompter.bat". Sem ele, só o motor local (palavras-chave) funciona e nada é enviado à IA.');
  } else if (rt.sysStream && !canTranscribeSystemAudio()) {
    messages.push(
      captureMode() !== 'full'
        ? 'Modo de captura sem áudio da reunião: registre a fala do auditado no campo de anotação.'
        : 'A fala do AUDITADO não está sendo transcrita: configure a chave do Google Gemini em "Configurações de IA" ou registre os pontos no campo de anotação. Hoje só o seu microfone é transcrito.'
    );
  }
  if (serverStatus.online && analysisProvider() === 'local' && (rt.sysStream || rt.micStream)) {
    messages.push('Sem chave de IA configurada: os insights vêm do motor local por palavras-chave (sugestões limitadas).');
  }
  el.innerHTML = messages.map((m) => `<div>⚠ ${escapeHtml(m)}</div>`).join('');
  el.classList.toggle('hidden', messages.length === 0);
  syncFloatingTeleprompter();
}

function updateCycleStatus(override) {
  const el = $('cycleStatusText');
  if (!el) return;
  if (override) {
    el.textContent = override;
    return;
  }
  if (rt.isAnalyzing) {
    el.textContent = 'IA analisando...';
  } else if (rt.transcribing) {
    el.textContent = 'Transcrevendo áudio...';
  } else if (rt.analyzeTimer && rt.analyzeDueAt) {
    const secs = Math.max(0, Math.ceil((rt.analyzeDueAt - Date.now()) / 1000));
    el.textContent = `Insight em ${secs}s`;
  } else if (rt.sysStream || rt.micStream) {
    el.textContent = settings.autoAnalyze === 'on' ? 'Escutando...' : 'Modo manual (Ctrl+Alt+A)';
  } else {
    el.textContent = 'Standby';
  }
}

// ============================================================================
// AGENDADOR DE ANÁLISE (uma por vez, com pausa e intervalo mínimo)
// ============================================================================
function scheduleAnalysis() {
  if (settings.autoAnalyze !== 'on') {
    updateCycleStatus();
    return;
  }
  const unanalyzedText = S.transcript
    .slice(S.analyzedUpTo)
    .map((t) => t.text)
    .join(' ')
    .trim();
  const wordCount = unanalyzedText ? unanalyzedText.split(/\s+/).length : 0;
  if (wordCount < 7) {
    updateCycleStatus('Ouvindo frase completa...');
    return;
  }
  clearTimeout(rt.analyzeTimer);
  const sinceLast = Date.now() - rt.lastAutoAnalysisAt;
  const wait = Math.max(3500, Number(settings.minAnalyzeGapSec || 15) * 1000 - sinceLast);
  rt.analyzeDueAt = Date.now() + wait;
  rt.analyzeTimer = setTimeout(() => {
    rt.analyzeTimer = null;
    rt.analyzeDueAt = 0;
    runAnalysis({ manual: false });
  }, wait);
  updateCycleStatus();
}

async function runAnalysis({ manual = false, instruction = '', focusQuestionId = '' } = {}) {
  if (rt.isAnalyzing) {
    // Não descarta: guarda para rodar assim que a análise atual terminar.
    const p = rt.pendingAnalysis || { manual: false, instruction: '', focusQuestionId: '' };
    rt.pendingAnalysis = {
      manual: p.manual || manual,
      instruction: instruction || p.instruction,
      focusQuestionId: focusQuestionId || p.focusQuestionId
    };
    if (manual) showToast('Análise em andamento — o pedido entrou na fila.');
    return;
  }

  if (manual) {
    clearTimeout(rt.analyzeTimer);
    rt.analyzeTimer = null;
    rt.analyzeDueAt = 0;
    if (rt.sysSegments && rt.sysEnergy) await flushSystemSegment(true);
    if (rt.micSegments && rt.micEnergy) await flushMicSegment(true);
    let waitLoops = 0;
    while (rt.transcribing && waitLoops < 40) {
      await new Promise((r) => setTimeout(r, 250));
      waitLoops++;
    }
  }

  const newEntries = S.transcript.slice(S.analyzedUpTo);
  if (!manual && !instruction && newEntries.length === 0) return;

  const upTo = S.transcript.length;
  rt.isAnalyzing = true;
  setAnalyzingUI(true);
  const provider = analysisProvider();

  try {
    if (provider === 'local') {
      analyzeWithLocalAuditEngine(newEntries, { instruction, focusQuestionId, manual });
    } else {
      const parsed = await callLiveAnalysis(provider, newEntries, instruction);
      applyAiInsights(parsed);
    }
    S.analyzedUpTo = upTo;
  } catch (err) {
    console.error('Erro na análise de IA:', err);
    showToast(`IA indisponível (${err.message}). Usando o motor local nesta rodada.`, 6000);
    analyzeWithLocalAuditEngine(newEntries, { instruction, focusQuestionId, manual });
    S.analyzedUpTo = upTo;
  } finally {
    rt.isAnalyzing = false;
    if (!manual) rt.lastAutoAnalysisAt = Date.now();
    setAnalyzingUI(false);
    commit();

    const pending = rt.pendingAnalysis;
    rt.pendingAnalysis = null;
    if (pending && (pending.manual || pending.instruction || S.transcript.length > S.analyzedUpTo)) {
      setTimeout(() => runAnalysis(pending), 250);
    } else if (S.transcript.length > S.analyzedUpTo) {
      scheduleAnalysis();
    }
  }
}

function setAnalyzingUI(analyzing) {
  $('analyzeBtnSpinner').classList.toggle('hidden', !analyzing);
  $('analyzeBtnIcon').classList.toggle('hidden', analyzing);
  updateCycleStatus();
}

// ============================================================================
// PROMPTS E SCHEMAS
// ============================================================================
const LIVE_SYSTEM_PROMPT = `Você é um copiloto sênior de Auditoria Interna, Controles Internos, Riscos e Compliance (perfil CIA, CISA, CRMA), especialista em COSO ICIF, SOX, normas do IIA, ITGC, ISO 27001, walkthrough / Test of Design (TOD) e validação de IPE (Information Produced by the Entity).

Você apoia um auditor AO VIVO durante uma reunião de walkthrough. A cada chamada você recebe as falas novas da transcrição e devolve, em JSON, o que ajuda o auditor nos próximos minutos.

Como trabalhar:
- Baseie-se SOMENTE no que está na transcrição e no material de preparação. Não invente fatos, valores, nomes de sistemas ou pessoas. Se algo não foi dito, trate como pergunta a fazer, não como fato.
- Cada fala da transcrição tem um identificador (ex.: T12). Em todo bloco, risco, controle, ponto em aberto e divergência, preencha "sourceIds" com os identificadores das falas que sustentam o item. Itens sem base direta na transcrição (ex.: perguntas de sondagem) podem ter "sourceIds" vazio.
- "topicSummary" é uma síntese fiel e limpa do que o auditado relatou (sem vícios de linguagem e sem acrescentar conclusões). Conclusões e alertas vão em "riskAlert".
- "text" é a próxima pergunta, em 1ª pessoa, pronta para o auditor ler em voz alta: curta, específica e neutra (sem tom acusatório).
- "screenScript" é o pedido educado para o auditado mostrar algo na tela agora; "ipeTip" diz o que observar para a evidência ser confiável (parâmetros, transação, usuário, data/hora, completude).
- Gere NO MÁXIMO 1 bloco principal em "blocos" por rodada (focado no assunto mais importante que acabou de ser falado). Se as falas novas forem apenas fragmentos curtos, cumprimentos ou conversa social sem conteúdo de processo, devolva "blocos": [] (lista vazia).
- Não repita perguntas que já estão na lista de perguntas existentes.
- Riscos: só registre quando a fala indicar fragilidade concreta. Não duplique riscos já existentes (use os códigos informados).
- Controles: registre controles descritos pelo auditado. Em "mitigaRiscos" informe os códigos dos riscos existentes (ex.: "R03") ou o título exato de um risco novo desta mesma resposta que o controle mitiga.
- "checklistCobertos": IDs do checklist (ex.: "chk-3") que as falas efetivamente cobriram.
- "pontosEmAberto": perguntas do auditor que ficaram sem resposta, respostas contraditórias e pendências combinadas (ex.: "enviará o relatório depois").
- "divergencias": só quando houver material de preparação e a fala contradisser o que está documentado (ex.: política diz alçada de R$ 50 mil e o auditado disse R$ 100 mil).
- Escreva em português do Brasil. Seja conciso: o auditor lê durante a conversa.`;

const LIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['direcionamento', 'blocos', 'riscos', 'controles', 'checklistCobertos', 'pontosEmAberto', 'divergencias'],
  properties: {
    direcionamento: { type: 'string' },
    blocos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['priority', 'category', 'topicTitle', 'topicSummary', 'riskAlert', 'text', 'rationale', 'screenTitle', 'screenScript', 'ipeTip', 'sourceIds'],
        properties: {
          priority: { type: 'string', enum: ['critica', 'alta', 'normal'] },
          category: { type: 'string' },
          topicTitle: { type: 'string' },
          topicSummary: { type: 'string' },
          riskAlert: { type: 'string' },
          text: { type: 'string' },
          rationale: { type: 'string' },
          screenTitle: { type: 'string' },
          screenScript: { type: 'string' },
          ipeTip: { type: 'string' },
          sourceIds: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    riscos: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'title', 'description', 'recommendation', 'assertion', 'sourceIds'],
        properties: {
          severity: { type: 'string', enum: ['Alto', 'Médio', 'Baixo'] },
          title: { type: 'string' },
          description: { type: 'string' },
          recommendation: { type: 'string' },
          assertion: { type: 'string' },
          sourceIds: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    controles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'type', 'nature', 'frequency', 'owner', 'assertion', 'status', 'mitigaRiscos', 'sourceIds'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['Preventivo', 'Detectivo'] },
          nature: { type: 'string', enum: ['Automático', 'Manual', 'Híbrido'] },
          frequency: { type: 'string' },
          owner: { type: 'string' },
          assertion: { type: 'string' },
          status: { type: 'string', enum: ['Desenho adequado', 'Com gap / fragilidade', 'Em avaliação (walkthrough)'] },
          mitigaRiscos: { type: 'array', items: { type: 'string' } },
          sourceIds: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    checklistCobertos: { type: 'array', items: { type: 'string' } },
    pontosEmAberto: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'kind', 'sourceIds'],
        properties: {
          text: { type: 'string' },
          kind: { type: 'string', enum: ['sem_resposta', 'contradicao', 'pendencia'] },
          sourceIds: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    divergencias: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['documented', 'stated', 'impact', 'sourceIds'],
        properties: {
          documented: { type: 'string' },
          stated: { type: 'string' },
          impact: { type: 'string' },
          sourceIds: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
};

// Bloco de contexto estável da sessão (vai em cache junto com as instruções).
function buildSessionContextBlock() {
  const lines = [
    'CONTEXTO DA AUDITORIA',
    `- Processo / tema: ${S.topic}`,
    `- Metodologia: ${METHODOLOGY_LABELS[S.methodology] || S.methodology}`,
    `- Sistemas / escopo: ${S.scope || '(não informado)'}`
  ];
  if (S.participants.trim()) lines.push(`- Participantes:\n${S.participants.trim()}`);
  if (settings.persona) lines.push(`- Diretrizes específicas do auditor: ${settings.persona}`);
  if (S.prepMaterial.trim()) {
    lines.push('', 'MATERIAL DE PREPARAÇÃO (o que está documentado — use para apontar divergências):', S.prepMaterial.trim());
  } else {
    lines.push('', 'MATERIAL DE PREPARAÇÃO: nenhum (não gere divergências).');
  }
  return lines.join('\n');
}

function formatTranscriptLine(t) {
  return `[T${t.seq} ${t.time} ${t.speaker}] ${t.text}`;
}

function buildLivePrompt(newEntries, instruction) {
  const contextEntries = S.transcript.slice(Math.max(0, S.analyzedUpTo - 15), S.analyzedUpTo);
  const pendingQuestions = S.questions.filter((q) => !q.asked).slice(0, 25);
  const askedQuestions = S.questions.filter((q) => q.asked).slice(0, 15);
  return [
    'CHECKLIST DO WALKTHROUGH:',
    S.checklist.map((c) => `${c.id}: ${c.title} — ${c.covered ? 'COBERTO' : 'PENDENTE'}`).join('\n'),
    '',
    'PERGUNTAS JÁ NO TELEPROMPTER (não repetir):',
    pendingQuestions.map((q) => `- ${q.text}`).join('\n') || '(nenhuma)',
    askedQuestions.length ? `\nPERGUNTAS JÁ FEITAS:\n${askedQuestions.map((q) => `- ${q.text}`).join('\n')}` : '',
    '',
    'RISCOS JÁ REGISTRADOS:',
    S.risks.map((r) => `${r.code}: ${r.title}`).join('\n') || '(nenhum)',
    '',
    'CONTROLES JÁ REGISTRADOS:',
    S.controls.map((c) => `${c.code}: ${c.name}`).join('\n') || '(nenhum)',
    '',
    'PONTOS EM ABERTO JÁ REGISTRADOS:',
    S.openPoints.filter((o) => o.status === 'aberto').map((o) => `- ${o.text}`).join('\n') || '(nenhum)',
    '',
    'FALAS ANTERIORES (contexto):',
    contextEntries.map(formatTranscriptLine).join('\n') || '(início da reunião)',
    '',
    'FALAS NOVAS (analise estas):',
    newEntries.map(formatTranscriptLine).join('\n') || '(nenhuma fala nova)',
    instruction ? `\nPEDIDO DO AUDITOR: ${instruction}` : ''
  ].join('\n');
}

async function callLiveAnalysis(provider, newEntries, instruction) {
  return aiJson({
    provider,
    systemBlocks: [LIVE_SYSTEM_PROMPT, buildSessionContextBlock()],
    prompt: buildLivePrompt(newEntries, instruction),
    schema: LIVE_SCHEMA,
    model: settings.liveModel,
    effort: settings.liveEffort
  });
}

function applyAiInsights(parsed) {
  if (!parsed || typeof parsed !== 'object') return;
  const origin = 'ia';
  if (parsed.direcionamento) S.coachingTip = parsed.direcionamento;

  const newQuestions = [];
  (parsed.blocos || []).forEach((b) => {
    const q = addQuestion(b, origin);
    if (q) newQuestions.push(q);
    if (b.screenTitle && b.screenScript) addScreenRequest({ title: b.screenTitle, script: b.screenScript, ipeTip: b.ipeTip });
  });
  S.questions = [...newQuestions, ...S.questions];

  const riskByTitle = {};
  (parsed.riscos || []).forEach((r) => {
    const risk = addRisk({ ...r, source: 'IA' });
    if (risk) riskByTitle[norm(r.title)] = risk.id;
  });

  (parsed.controles || []).forEach((c) => {
    const riskIds = [];
    (c.mitigaRiscos || []).forEach((ref) => {
      const code = String(ref).trim().toUpperCase();
      const byCode = S.risks.find((r) => r.code === code);
      const byTitle = riskByTitle[norm(ref)] || (S.risks.find((r) => norm(r.title) === norm(ref)) || {}).id;
      const id = byCode ? byCode.id : byTitle;
      if (id && !riskIds.includes(id)) riskIds.push(id);
    });
    addControl({ ...c, riskIds, source: 'IA' });
  });

  markChecklist(parsed.checklistCobertos);
  (parsed.pontosEmAberto || []).forEach((o) => addOpenPoint({ ...o, source: 'IA' }));
  if (S.prepMaterial.trim()) (parsed.divergencias || []).forEach((d) => addDivergence({ ...d, source: 'IA' }));

  if (newQuestions.length > 0) {
    rt.focusedQuestionId = newQuestions[0].id;
    flashNewInsight();
    setTimeout(() => {
      const streamEl = $('pairedStreamContainer');
      if (streamEl) streamEl.scrollTo({ top: 0, behavior: 'smooth' });
    }, 60);
  }
}

function flashNewInsight() {
  const dot = $('captionDot');
  if (dot) {
    dot.classList.add('speaking');
    setTimeout(() => dot.classList.remove('speaking'), 1200);
  }
}

// ============================================================================
// MOTOR LOCAL (CONTINGÊNCIA, SEM IA) — regras combinadas para reduzir falsos positivos
// ============================================================================
const LOCAL_RULES = [
  {
    id: 'bypass',
    test: (t) =>
      (/(whats ?app|por e-?mail|por mensagem|verbal|por telefone)/.test(t) && /(aprov|autoriz|libera|de acordo)/.test(t)) ||
      /(regulariz\w* (depois|na semana|posterior)|depois (a gente )?regulariz|a posteriori|pagamento sem pedido|paga(mos)? sem pedido)/.test(t),
    coaching: 'Possível bypass: aprovação fora do sistema (mensagem/e-mail) ou regularização posterior. Questione a trava sistêmica antes do pagamento.',
    question: {
      priority: 'critica',
      category: 'Exceção / Bypass de Controle',
      topicTitle: 'Aprovação fora do sistema e regularização posterior',
      riskAlert: 'Possível gap: execução antes da aprovação formal no sistema (contorno de alçada).',
      text: 'Como o sistema permite concluir essa etapa antes de a aprovação estar registrada nele? Existe alguma trava que exija a aprovação formal antes?',
      rationale: 'Testar se o sistema permite bypass do fluxo de aprovação (execução sem aprovação / regularização a posteriori).',
      screenTitle: 'Exemplo recente aprovado fora do sistema',
      screenScript: 'Você pode mostrar na tela um caso recente aprovado por e-mail ou mensagem e como ele ficou registrado no sistema?',
      ipeTip: 'IPE: verificar quem liberou no sistema, se a aprovação foi anexada e qual relatório monitora essas exceções.'
    },
    risk: {
      severity: 'Alto',
      title: 'Aprovação informal e regularização posterior no sistema',
      description: 'Execução antes da formalização e aprovação no sistema anula o controle preventivo de alçadas.',
      recommendation: 'Bloquear a execução sem aprovação registrada e criar fluxo de aprovação expressa dentro do próprio sistema.'
    },
    checklist: ['chk-3', 'chk-5']
  },
  {
    id: 'sod_bank',
    test: (t) =>
      (/(cadastr|alter|mud|atualiz)/.test(t) && /(conta bancaria|dados bancarios|conta do fornecedor|banco do fornecedor)/.test(t)) ||
      (/mesma pessoa/.test(t) && /(aprov|lanc|pag|cadastr)/.test(t)),
    coaching: 'Possível conflito de Segregação de Funções: quem cadastra ou altera dados bancários também participa do pagamento.',
    question: {
      priority: 'critica',
      category: 'Segregação de Funções (SoD)',
      topicTitle: 'Alteração de dados bancários sem aprovação independente',
      riskAlert: 'Risco de fraude / SoD: mesma área altera dados bancários e participa do pagamento.',
      text: 'Se alguém alterar hoje a conta bancária de um fornecedor no sistema, o cadastro fica bloqueado até que uma segunda pessoa aprove a alteração?',
      rationale: 'Mitigar risco de desvio de pagamentos para contas bancárias adulteradas.',
      screenTitle: 'Tela de cadastro de fornecedores e log de alterações bancárias',
      screenScript: 'Pode abrir a manutenção de fornecedores e mostrar se o campo de dados bancários fica aberto para edição pelo seu perfil?',
      ipeTip: 'IPE: capturar a transação, o perfil do usuário e o log de alterações com data/hora e aprovador.'
    },
    risk: {
      severity: 'Alto',
      title: 'Conflito de Segregação de Funções (cadastro bancário × pagamento)',
      description: 'A mesma área possui acesso para alterar dados bancários e participar do fluxo de pagamento, sem validação independente.',
      recommendation: 'Segregar o cadastro mestre e exigir dupla aprovação (com confirmação junto ao fornecedor) para alterações bancárias.'
    },
    checklist: ['chk-2', 'chk-4']
  },
  {
    id: 'excel_ipe',
    test: (t) => /(excel|planilha)/.test(t) && /(manual|apag|exclu|filtr|edit|ajust|copi|colo)/.test(t),
    critical: (t) => /(ninguem (mais )?(precisa )?revis|sem revis|nao (tem|ha) revis|ninguem confere)/.test(t),
    coaching: 'Fragilidade de IPE: base extraída para planilha e manipulada manualmente. Verifique completude, exatidão e revisão independente.',
    question: {
      priority: 'alta',
      category: 'Integridade de IPE & Revisão',
      topicTitle: 'Planilha com edição manual da base',
      riskAlert: 'Risco de IPE: base editável manualmente, sem garantia de completude e exatidão.',
      text: 'Como vocês garantem que nenhuma linha válida foi excluída ao tratar a planilha, e quem revisa formalmente o resultado contra o sistema ou o razão?',
      rationale: 'Testar completude e exatidão (C&A) da informação produzida pela entidade e a segregação preparador × revisor.',
      screenTitle: 'Planilha de controle e relatório de origem no sistema',
      screenScript: 'Pode abrir a última planilha fechada e mostrar de qual tela ou relatório do sistema os dados foram extraídos?',
      ipeTip: 'IPE: verificar parâmetros da extração, total batido com o sistema e evidência de revisão (quem e quando).'
    },
    risk: {
      severity: 'Médio',
      title: 'Manipulação manual de base em planilha (risco de IPE)',
      description: 'Extração de dados com tratamento manual em planilha sem trilha de alterações.',
      recommendation: 'Automatizar o relatório no sistema/BI ou instituir batimento de totais e revisão formal documentada.'
    },
    control: {
      name: 'Controle em planilha eletrônica',
      type: 'Detectivo',
      nature: 'Manual',
      frequency: 'Mensal',
      status: 'Com gap / fragilidade'
    },
    checklist: ['chk-6', 'chk-7']
  },
  {
    id: 'shared_user',
    test: (t) => /(usuario|login|senha|acesso)/.test(t) && /(compartilhad|generic|master|todo mundo usa|mesma senha|emprest)/.test(t),
    coaching: 'Violação de ITGC: uso de credencial compartilhada — perda de rastreabilidade individual.',
    question: {
      priority: 'critica',
      category: 'ITGC / Rastreabilidade de Acesso',
      topicTitle: 'Uso de usuário compartilhado ou genérico',
      riskAlert: 'Violação de ITGC e SoD: sem rastreabilidade individual e com possível contorno de alçadas.',
      text: 'Quantas pessoas conhecem a senha desse usuário e como é possível identificar no log quem realmente executou cada transação?',
      rationale: 'Contas compartilhadas anulam a trilha de auditoria (não repúdio) e violam a política de segurança da informação.',
      screenTitle: 'Log de transações do usuário genérico',
      screenScript: 'Pode consultar na tela o histórico de transações desse usuário nos últimos 30 dias e mostrar se existe delegação nominal no sistema?',
      ipeTip: 'IPE: solicitar a lista de contas genéricas/serviço ativas e o log de transações críticas executadas por elas.'
    },
    risk: {
      severity: 'Alto',
      title: 'Uso de conta genérica/compartilhada',
      description: 'Perda de rastreabilidade individual e possível contorno das travas de segregação de funções.',
      recommendation: 'Bloquear o usuário compartilhado e usar delegação temporária nominal no sistema.'
    },
    checklist: ['chk-4', 'chk-7']
  },
  {
    id: 'no_approval',
    test: (t) => /(sem aprovac|nao (tem|ha|existe|passa por) aprovac|ninguem aprova|nao precisa (de )?aprovac)/.test(t),
    coaching: 'Etapa relatada sem aprovação: entenda o motivo, o volume e se há controle compensatório.',
    question: {
      priority: 'alta',
      category: 'Alçada & Aprovação',
      topicTitle: 'Etapa executada sem aprovação',
      riskAlert: 'Possível ausência de controle preventivo de aprovação.',
      text: 'Nesse caso sem aprovação, existe algum limite de valor ou revisão posterior que compense? Quantos casos assim acontecem por mês?',
      rationale: 'Avaliar a ausência de controle preventivo e a existência de controle compensatório detectivo.',
      screenTitle: 'Relatório de transações sem aprovação',
      screenScript: 'Conseguimos extrair agora a lista das transações desse tipo no último mês para vermos o volume e os valores?',
      ipeTip: 'IPE: registrar os filtros usados, o período e o total de registros.'
    },
    checklist: ['chk-3']
  },
  {
    id: 'no_lock',
    test: (t) => /(nao (tem|ha|existe) (nenhum )?(controle|trava|bloqueio)|o sistema (deixa|permite|aceita))/.test(t),
    coaching: 'Ausência de trava sistêmica relatada: confirme na tela e avalie controle detectivo compensatório.',
    question: {
      priority: 'alta',
      category: 'Sistema / ITGC',
      topicTitle: 'Ausência de trava sistêmica',
      riskAlert: 'Possível ausência de controle automático preventivo.',
      text: 'Podemos simular na tela essa situação para confirmar que o sistema realmente permite? E existe algum relatório que identifique depois esses casos?',
      rationale: 'Confirmar o desenho do controle automático (TOD) e identificar controle detectivo compensatório.',
      screenTitle: 'Simulação da situação no sistema',
      screenScript: 'Você pode reproduzir essa situação em ambiente de teste ou mostrar um caso real para registrarmos a evidência?',
      ipeTip: 'IPE: capturar a parametrização da transação e o perfil do usuário que executou.'
    },
    checklist: ['chk-6']
  }
];

function analyzeWithLocalAuditEngine(entries, { instruction = '', focusQuestionId = '', manual = false } = {}) {
  const now = nowTime(false);

  if (focusQuestionId) {
    const q = S.questions.find((x) => x.id === focusQuestionId);
    if (q) {
      const follow = addQuestion(
        {
          priority: 'critica',
          category: 'Aprofundamento / Exceções',
          topicTitle: `Aprofundamento: ${q.topicTitle || q.category}`,
          topicSummary: `Sondagem de falhas, contornos (bypass) e comprovação documental do ponto: "${(q.topicTitle || q.text).slice(0, 80)}".`,
          text: 'Aprofundando esse ponto: já aconteceu algum caso nos últimos meses em que essa regra precisou ser contornada em caráter de exceção? Como ficou registrado?',
          rationale: `Teste de tratamento de exceções derivado de: "${q.text.slice(0, 80)}..."`,
          screenTitle: 'Amostra de 1 transação recente na tela (TOD)',
          screenScript: 'Se pegarmos 1 item processado na semana passada, qual log ou documento comprova que essa validação funcionou?',
          ipeTip: 'IPE: confirmar retenção de evidência auditável (log de aprovação, usuário e carimbo de tempo).'
        },
        'local'
      );
      if (follow) S.questions.unshift(follow);
      return;
    }
  }

  const relevant = entries.filter((e) => e.speaker !== 'Auditor');
  const text = norm(relevant.map((e) => e.text).join(' '));
  const sourceIds = relevant.map((e) => `T${e.seq}`);
  const lastSummary = relevant.length ? relevant[relevant.length - 1].text : '';
  let hits = 0;

  LOCAL_RULES.forEach((rule) => {
    if (!text || !rule.test(text)) return;
    hits += 1;
    S.coachingTip = rule.coaching;
    const qData = { ...rule.question, topicSummary: lastSummary, sourceIds };
    if (rule.critical && rule.critical(text)) qData.priority = 'critica';
    const q = addQuestion(qData, 'local');
    if (q) S.questions.unshift(q);
    if (rule.question.screenTitle) addScreenRequest({ title: rule.question.screenTitle, script: rule.question.screenScript, ipeTip: rule.question.ipeTip });
    let risk = null;
    if (rule.risk) risk = addRisk({ ...rule.risk, severity: rule.critical && rule.critical(text) ? 'Alto' : rule.risk.severity, source: 'Local', sourceIds });
    if (rule.control) addControl({ ...rule.control, riskIds: risk ? [risk.id] : [], source: 'Local', sourceIds });
    markChecklist(rule.checklist);
  });

  if (hits === 0 && (manual || relevant.length > 0) && (relevant.length > 0 || instruction)) {
    const clean = lastSummary || instruction || S.topic;
    const shortTopic = clean.length > 58 ? `${clean.slice(0, 58)}...` : clean;
    const q = addQuestion(
      {
        priority: 'normal',
        category: 'Aprofundamento de Walkthrough',
        topicTitle: `Assunto mapeado: ${shortTopic}`,
        topicSummary: clean,
        text: 'Sobre esse ponto: o sistema faz alguma validação automática para impedir erro, ou depende da conferência manual de alguém? Quem confere e como fica registrado?',
        rationale: 'Identificar a natureza do controle (automático × manual) e testar o desenho (TOD).',
        screenTitle: 'Demonstração da etapa em tela (walkthrough TOD)',
        screenScript: 'Você pode mostrar essa etapa diretamente no sistema com um exemplo real para registrarmos a evidência do walkthrough?',
        ipeTip: 'IPE: capturar a tela com campos obrigatórios, travas e registro de log.',
        sourceIds
      },
      'local'
    );
    if (q) {
      q.time = now;
      S.questions.unshift(q);
    }
  }
}

// ============================================================================
// AÇÕES DO TELEPROMPTER
// ============================================================================
function submitManualNote() {
  const input = $('manualTranscriptInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  const speaker = $('speakerSelect').value || 'Auditado';
  addTranscript(speaker, 'manual', text);
  $('liveInterimText').textContent = `Mapeando: "${text}"`;
  commit();
  runAnalysis({ manual: true });
}

function runSimulatedSpeech() {
  const scenario = SIMULATION_SCENARIOS[rt.simulationIndex % SIMULATION_SCENARIOS.length];
  rt.simulationIndex += 1;
  addTranscript('Auditado', 'simulado', scenario.text);
  $('liveInterimText').textContent = `Fala simulada: "${scenario.text.slice(0, 120)}…"`;
  commit();
  runAnalysis({ manual: true });
}

function drillDownQuestion(questionId) {
  const q = S.questions.find((x) => x.id === questionId);
  if (!q) return;
  showToast('Gerando aprofundamento (teste de exceção e evidência)...');
  runAnalysis({
    manual: true,
    focusQuestionId: questionId,
    instruction: `Aprofunde o assunto "${q.topicTitle || q.category}" a partir da pergunta: "${q.text}". Gere 1 a 2 blocos de aprofundamento: teste de cenário de falha/contorno e comprovação em tela (IPE).`
  });
}

function toggleAsked(questionId) {
  const q = S.questions.find((x) => x.id === questionId);
  if (!q) return;
  q.asked = !q.asked;
  q.askedAt = q.asked ? nowTime(false) : '';
  if (q.asked && rt.focusedQuestionId === questionId) moveFocus(1, { silent: true });
  commit();
}

function questionToPbc(questionId) {
  const q = S.questions.find((x) => x.id === questionId);
  if (!q) return;
  addPbc({
    title: q.screenTitle || q.topicTitle,
    detail: q.ipeTip || q.rationale,
    source: q.origin === 'ia' ? 'IA' : 'Teleprompter',
    questionId: q.id
  });
  commit();
}

function questionToOpenPoint(questionId) {
  const q = S.questions.find((x) => x.id === questionId);
  if (!q) return;
  const op = addOpenPoint({ text: `Sem resposta: ${q.text}`, kind: 'sem_resposta', source: 'Manual', sourceIds: q.sourceIds });
  showToast(op ? 'Registrado em Pontos em Aberto.' : 'Já consta em Pontos em Aberto.');
  commit();
}

function filteredQuestions() {
  const f = rt.tpFilter;
  return S.questions.filter((q) => {
    if (f === 'pending') return !q.asked;
    if (f === 'planned') return q.origin === 'planejada' || q.origin === 'roteiro';
    if (f === 'emergent') return q.origin === 'ia' || q.origin === 'local';
    if (f === 'gaps') return Boolean(q.riskAlert) || q.priority === 'critica';
    return true;
  });
}

function moveFocus(direction, { silent = false } = {}) {
  const pending = filteredQuestions().filter((q) => !q.asked);
  if (pending.length === 0) {
    rt.focusedQuestionId = null;
    if (!silent) showToast('Nenhuma pergunta pendente neste filtro.');
    renderTeleprompter();
    syncFloatingTeleprompter();
    return;
  }
  let idx = pending.findIndex((q) => q.id === rt.focusedQuestionId);
  idx = idx === -1 ? 0 : (idx + direction + pending.length) % pending.length;
  rt.focusedQuestionId = pending[idx].id;
  renderTeleprompter();
  syncFloatingTeleprompter();
  const el = document.querySelector(`.paired-row[data-qid="${rt.focusedQuestionId}"]`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function focusedQuestion() {
  return S.questions.find((q) => q.id === rt.focusedQuestionId) || filteredQuestions().find((q) => !q.asked) || null;
}

function markMoment(fromEntryId) {
  let entries;
  if (fromEntryId) {
    entries = S.transcript.filter((t) => t.id === fromEntryId);
  } else {
    entries = S.transcript.slice(-3);
  }
  const fq = focusedQuestion();
  const moment = {
    id: uid('mo'),
    time: nowTime(),
    note: '',
    excerpt: entries.map((t) => `[${t.time}] ${t.speaker}: ${t.text}`).join('\n'),
    transcriptIds: entries.map((t) => `T${t.seq}`),
    questionText: fq ? fq.text : ''
  };
  S.moments.unshift(moment);
  commit();
  showToast(`★ Momento marcado às ${moment.time}. Anote o contexto em "Transcrição & Momentos".`);
}

// ============================================================================
// ATALHOS DE TECLADO (janela principal e flutuante)
// ============================================================================
function handleHotkey(e) {
  if (e.altKey && !e.ctrlKey && e.code === 'Space') {
    e.preventDefault();
    runAnalysis({ manual: true });
    return;
  }
  if (!(e.ctrlKey && e.altKey)) return;
  const map = {
    KeyA: () => runAnalysis({ manual: true }),
    KeyJ: () => moveFocus(1),
    KeyK: () => moveFocus(-1),
    KeyD: () => {
      const q = focusedQuestion();
      if (q) {
        rt.focusedQuestionId = q.id;
        toggleAsked(q.id);
        showToast(q.asked ? 'Pergunta marcada como feita.' : 'Pergunta reaberta.');
      }
    },
    KeyP: () => {
      const q = focusedQuestion();
      if (q) questionToPbc(q.id);
    },
    KeyM: () => markMoment(),
    KeyN: () => {
      window.focus();
      switchView('live');
      $('manualTranscriptInput').focus();
    },
    KeyF: () => openFloatingTeleprompter()
  };
  const fn = map[e.code];
  if (fn) {
    e.preventDefault();
    e.stopPropagation();
    fn();
  }
}

// ============================================================================
// MODAIS (substituem alert/prompt/confirm, que travam a tela durante a call)
// ============================================================================
let formResolver = null;

function openForm({ title, subtitle = '', fields = [], submitLabel = 'Salvar', cancelLabel = 'Cancelar', hideCancel = false, html = '', danger = false }) {
  if (formResolver) formResolver(null);
  $('formModalTitle').textContent = title;
  $('formModalSubtitle').textContent = subtitle;
  const body = $('formModalBody');
  body.innerHTML =
    html +
    fields
      .map((f) => {
        const id = `ff_${f.name}`;
        const label = f.label ? `<label for="${id}">${escapeHtml(f.label)}</label>` : '';
        if (f.type === 'info') return `<div class="form-info">${f.html || escapeHtml(f.value || '')}</div>`;
        if (f.type === 'textarea') {
          return `<div class="form-group">${label}<textarea id="${id}" rows="${f.rows || 3}" ${f.readonly ? 'readonly' : ''}>${escapeHtml(f.value || '')}</textarea></div>`;
        }
        if (f.type === 'select') {
          // Preserva valores antigos/importados que não estão na lista (não troca o dado em silêncio).
          const baseOptions = f.options || [];
          const known = baseOptions.some((o) => (typeof o === 'string' ? o : o.value) === f.value);
          const opts = (known || !f.value ? baseOptions : [f.value, ...baseOptions])
            .map((o) => {
              const val = typeof o === 'string' ? o : o.value;
              const lab = typeof o === 'string' ? o || '(não informado)' : o.label;
              return `<option value="${escapeAttr(val)}" ${val === f.value ? 'selected' : ''}>${escapeHtml(lab)}</option>`;
            })
            .join('');
          return `<div class="form-group">${label}<select id="${id}">${opts}</select></div>`;
        }
        if (f.type === 'checkboxes') {
          const values = Array.isArray(f.value) ? f.value : [];
          const opts = (f.options || []).length
            ? f.options
                .map(
                  (o) =>
                    `<label class="inline-check"><input type="checkbox" name="${id}" value="${escapeAttr(o.value)}" ${values.includes(o.value) ? 'checked' : ''}/> ${escapeHtml(o.label)}</label>`
                )
                .join('')
            : '<div class="hint-text">Nenhuma opção disponível.</div>';
          return `<div class="form-group">${label}<div class="checkbox-list">${opts}</div></div>`;
        }
        return `<div class="form-group">${label}<input id="${id}" type="${f.type === 'date' ? 'date' : 'text'}" value="${escapeAttr(f.value || '')}" placeholder="${escapeAttr(f.placeholder || '')}" /></div>`;
      })
      .join('');

  $('formModalSubmit').textContent = submitLabel;
  $('formModalSubmit').classList.toggle('btn-danger', danger);
  $('formModalCancel').textContent = cancelLabel;
  $('formModalCancel').classList.toggle('hidden', hideCancel);
  $('formModal').classList.remove('hidden');

  const firstInput = body.querySelector('input:not([type=checkbox]), textarea, select');
  setTimeout(() => (firstInput ? firstInput.focus() : $('formModalSubmit').focus()), 30);

  return new Promise((resolve) => {
    formResolver = (submitted) => {
      formResolver = null;
      $('formModal').classList.add('hidden');
      if (!submitted) {
        resolve(null);
        return;
      }
      const values = {};
      fields.forEach((f) => {
        const id = `ff_${f.name}`;
        if (f.type === 'info') return;
        if (f.type === 'checkboxes') {
          values[f.name] = Array.from(body.querySelectorAll(`input[name="${id}"]:checked`)).map((x) => x.value);
        } else {
          const el = $(id);
          values[f.name] = el ? el.value.trim() : '';
        }
      });
      resolve(values);
    };
    formResolver.fields = fields;
  });
}

function submitFormModal() {
  if (!formResolver) return;
  const missing = (formResolver.fields || []).find((f) => f.required && !($(`ff_${f.name}`) || {}).value?.trim());
  if (missing) {
    showToast(`Preencha: ${missing.label}`);
    return;
  }
  formResolver(true);
}

function confirmDialog(message, { title = 'Confirmar', okLabel = 'Confirmar', danger = false } = {}) {
  return openForm({ title, fields: [{ type: 'info', name: 'msg', value: message }], submitLabel: okLabel, danger }).then((v) => v !== null);
}

function noticeDialog(title, message) {
  return openForm({ title, fields: [{ type: 'info', name: 'msg', value: message }], submitLabel: 'Entendi', hideCancel: true });
}

// ============================================================================
// RENDERIZAÇÃO
// ============================================================================
function renderAll() {
  renderHeader();
  renderChecklist();
  renderTeleprompter();
  renderTranscript();
  renderMoments();
  renderMatrix();
  if ($('view-report').classList.contains('active')) renderReportPreview();
  if ($('view-sessions').classList.contains('active')) renderSessions();
}

function renderHeader() {
  const prj = activeProjectObj();
  const prjCode = prj ? prj.code : 'AUD-2026-01';
  const prjName = prj ? prj.name : S.topic;
  const meetTitle = S.meetingTitle || 'Reunião 01 — Walkthrough';

  $('headerTopicDisplay').textContent = `${meetTitle} · ${S.topic}`;
  if ($('headerProjectCodePill')) $('headerProjectCodePill').textContent = prjCode;
  if ($('sidebarProjectCode')) $('sidebarProjectCode').textContent = prjCode;
  if ($('sidebarProjectName')) $('sidebarProjectName').textContent = prjName;
  if ($('sidebarMeetingTitle')) $('sidebarMeetingTitle').textContent = meetTitle;
  if ($('projectsCountBadge')) $('projectsCountBadge').textContent = String(Math.max(1, projectsStore.projects.length));

  $('transcriptCountBadge').textContent = String(S.transcript.length);
  $('sidebarMatrixBadge').textContent = String(S.risks.length + S.controls.length + S.pbcList.length);
}

const ORIGIN_LABELS = {
  roteiro: { label: 'Roteiro', cls: 'origin-plan' },
  planejada: { label: 'Planejada', cls: 'origin-plan' },
  ia: { label: 'IA — revisar', cls: 'origin-ai' },
  local: { label: 'Detecção local', cls: 'origin-local' }
};

function sourceLinks(ids) {
  if (!ids || ids.length === 0) return '';
  return ids
    .map((id) => {
      const t = S.transcript.find((x) => `T${x.seq}` === id);
      return `<button class="src-link" data-src="${escapeAttr(id)}" title="${escapeAttr(t ? t.text : '')}">${escapeHtml(id)}${t ? ` · ${escapeHtml(t.time.slice(0, 5))}` : ''}</button>`;
    })
    .join('');
}

function renderTeleprompter() {
  $('liveCoachingText').textContent = String(S.coachingTip || '').replace(/^[\u{1F300}-\u{1FAFF}☀-➿]+\s*/u, '');
  $('countQuestions').textContent = String(S.questions.length);

  const container = $('pairedStreamContainer');
  const list = filteredQuestions();
  if (list.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding: 28px; text-align: center;">Nenhum tópico neste filtro. Ligue o áudio, registre uma fala acima ou use "Simular".</div>`;
    return;
  }
  if (!rt.focusedQuestionId || !S.questions.some((q) => q.id === rt.focusedQuestionId && !q.asked)) {
    const firstPending = list.find((q) => !q.asked);
    rt.focusedQuestionId = firstPending ? firstPending.id : null;
  }

  container.innerHTML = list
    .map((q) => {
      const badgeClass = q.priority === 'critica' ? 'badge-critica' : q.priority === 'alta' ? 'badge-alta' : 'badge-normal';
      const priorityLabel = q.priority === 'critica' ? 'CRÍTICO' : q.priority === 'alta' ? 'ALTA PRIORIDADE' : 'MAPEAMENTO';
      const origin = ORIGIN_LABELS[q.origin] || ORIGIN_LABELS.roteiro;
      const timeLabel = q.time ? `às ${q.time}` : '';
      const summaryLabel = q.origin === 'ia' ? '<span class="summary-label">Síntese da IA — conferir com a transcrição</span>' : '';
      const focused = q.id === rt.focusedQuestionId ? 'focused' : '';
      const inPbc = S.pbcList.some((p) => p.questionId === q.id);

      return `
        <div class="paired-row priority-${q.priority} ${q.asked ? 'row-done' : ''} ${focused}" data-qid="${q.id}">
          <div class="paired-left">
            <div class="topic-meta-top">
              <span class="tp-badge badge-cat">${escapeHtml(q.category)}</span>
              <span class="origin-chip ${origin.cls}">${origin.label}</span>
              <span class="topic-time">${escapeHtml(timeLabel)}</span>
            </div>
            <div class="topic-title">${escapeHtml(q.topicTitle || q.category)}</div>
            ${q.topicSummary ? `${summaryLabel}<div class="topic-summary">${escapeHtml(q.topicSummary)}</div>` : ''}
            ${q.riskAlert ? `<div class="topic-risk-pill"><strong>Ponto de atenção:</strong> ${escapeHtml(q.riskAlert)}</div>` : ''}
            ${q.sourceIds && q.sourceIds.length ? `<div class="src-row">Fonte: ${sourceLinks(q.sourceIds)}</div>` : ''}
          </div>
          <div class="paired-right">
            <div class="insight-question-block">
              <div class="insight-label">
                <span class="tp-badge ${badgeClass}">${priorityLabel}</span>
                <span>${focused ? '▶ EM FOCO — ' : ''}O QUE PERGUNTAR</span>
              </div>
              <div class="tp-script-text">“${escapeHtml(q.text)}”</div>
              <div class="tp-rationale"><strong>Objetivo / Controle:</strong> ${escapeHtml(q.rationale)}</div>
            </div>
            ${
              q.screenScript
                ? `<div class="insight-screen-box">
                    <div class="screen-box-title">PEDIR NA TELA / EVIDÊNCIA — ${escapeHtml(q.screenTitle)}</div>
                    <div class="screen-box-script">“${escapeHtml(q.screenScript)}”</div>
                    ${q.ipeTip ? `<div class="screen-box-ipe">${escapeHtml(q.ipeTip)}</div>` : ''}
                  </div>`
                : ''
            }
            <div class="tp-card-actions">
              <button class="btn-tp-action ${q.asked ? 'done' : ''}" data-action="toggle-asked" data-id="${q.id}">${q.asked ? `Feita ${q.askedAt ? `às ${escapeHtml(q.askedAt)}` : ''}` : 'Marcar como feita'}</button>
              <button class="btn-tp-action" data-action="drill" data-id="${q.id}">Aprofundar</button>
              <button class="btn-tp-action" data-action="add-pbc" data-id="${q.id}" ${inPbc ? 'disabled' : ''}>${inPbc ? 'No PBC ✓' : '+ PBC'}</button>
              <button class="btn-tp-action" data-action="open-point" data-id="${q.id}">Ficou sem resposta</button>
              <button class="btn-tp-action" data-action="copy" data-id="${q.id}">Copiar</button>
            </div>
          </div>
        </div>`;
    })
    .join('');
}

function renderChecklist() {
  const covered = S.checklist.filter((c) => c.covered).length;
  const total = S.checklist.length;
  $('checklistProgressPill').textContent = `${covered}/${total}`;
  $('checklistProgressBar').style.width = `${total ? Math.round((covered / total) * 100) : 0}%`;
  $('checklistContainer').innerHTML = S.checklist
    .map(
      (item) => `
      <div class="chk-item ${item.covered ? 'covered' : ''}" data-chk="${item.id}">
        <div class="chk-box">${item.covered ? '✓' : ''}</div>
        <div class="chk-body">
          <div class="chk-title">${escapeHtml(item.title)}</div>
          <div class="chk-hint">${escapeHtml(item.hint)}</div>
        </div>
      </div>`
    )
    .join('');
}

const SOURCE_CLASSES = { mic: 'spk-auditor', sys: 'spk-auditado', manual: 'spk-manual', simulado: 'spk-sim' };
const SOURCE_LABELS = { mic: 'microfone', sys: 'áudio da reunião', manual: 'registro manual', simulado: 'simulação' };

function renderTranscript() {
  const feed = $('transcriptFeed');
  if (!feed) return;
  const q = norm($('transcriptSearch') ? $('transcriptSearch').value : '');
  const entries = S.transcript.filter((t) => !q || norm(`${t.speaker} ${t.text}`).includes(q));
  if (entries.length === 0) {
    feed.innerHTML = `<div class="empty-state">${S.transcript.length ? 'Nada encontrado para a busca.' : 'Nenhuma fala registrada ainda.'}</div>`;
    return;
  }
  feed.innerHTML = entries
    .map(
      (t) => `
      <div class="tr-entry" data-tid="T${t.seq}">
        <div class="tr-meta">
          <span class="tr-id">T${t.seq}</span>
          <span class="tr-time">${escapeHtml(t.time)}</span>
          <span class="speaker-chip ${SOURCE_CLASSES[t.source] || 'spk-manual'}">${escapeHtml(t.speaker)}</span>
          <span class="tr-source">${escapeHtml(SOURCE_LABELS[t.source] || t.source)}</span>
          <span class="tr-actions">
            <button class="btn-inline" data-tr-moment="${t.id}" title="Marcar esta fala como momento">★</button>
            <button class="btn-inline" data-tr-del="${t.id}" title="Excluir fala">✕</button>
          </span>
        </div>
        <div class="tr-text">${escapeHtml(t.text)}</div>
      </div>`
    )
    .join('');
}

function renderMoments() {
  $('momentsCountBadge').textContent = String(S.moments.length);
  const box = $('momentsList');
  if (S.moments.length === 0) {
    box.innerHTML = '<div class="empty-state">Nenhum momento marcado. Use ★ Momento ou Ctrl+Alt+M durante a reunião.</div>';
    return;
  }
  box.innerHTML = S.moments
    .map(
      (m) => `
      <div class="pbc-card moment-card">
        <div class="risk-header"><span class="risk-title">★ ${escapeHtml(m.time)}</span>
          <span>${m.transcriptIds.map((id) => `<button class="src-link" data-src="${id}">${id}</button>`).join('')}</span></div>
        ${m.excerpt ? `<pre class="moment-excerpt">${escapeHtml(m.excerpt)}</pre>` : '<div class="hint-text">Sem falas registradas no momento da marcação.</div>'}
        ${m.questionText ? `<div class="hint-text">Pergunta em foco: “${escapeHtml(m.questionText)}”</div>` : ''}
        <textarea class="moment-note" data-moment-note="${m.id}" rows="2" placeholder="Anotação do auditor (ex.: gestor confirmou que aprova por WhatsApp)">${escapeHtml(m.note)}</textarea>
        <div class="card-actions">
          <button class="btn-inline" data-moment-pbc="${m.id}">→ PBC</button>
          <button class="btn-inline" data-moment-del="${m.id}">Remover</button>
        </div>
      </div>`
    )
    .join('');
}

function sourceChip(source, validated) {
  const cls = source === 'Manual' ? 'origin-plan' : source === 'Roteiro' ? 'origin-plan' : source === 'Local' ? 'origin-local' : 'origin-ai';
  return `<span class="origin-chip ${cls}">${escapeHtml(source)}</span>${
    validated ? '<span class="origin-chip origin-ok">Validado</span>' : source === 'Manual' ? '' : '<span class="origin-chip origin-pending">Não validado</span>'
  }`;
}

function renderMatrix() {
  // Banner de revisão
  const pendingReview = [...S.risks, ...S.controls].filter((x) => !x.validated && x.source !== 'Manual').length + S.divergences.filter((d) => !d.validated).length;
  const banner = $('aiReviewBanner');
  banner.innerHTML = pendingReview
    ? `<strong>${pendingReview}</strong> item(ns) gerados por IA / motor local ainda não validados pelo auditor. Revise e clique em "Validar" antes de usar no papel de trabalho.`
    : '';
  banner.classList.toggle('hidden', pendingReview === 0);

  // Riscos
  $('risksCountBadge').textContent = String(S.risks.length);
  $('risksList').innerHTML = S.risks.length
    ? S.risks
        .map((r) => {
          const ctrls = S.controls.filter((c) => c.riskIds.includes(r.id));
          const sevClass = r.severity === 'Alto' ? 'badge-critica' : r.severity === 'Médio' ? 'badge-alta' : 'badge-normal';
          return `
          <div class="risk-card ${r.severity !== 'Alto' ? 'sev-medio' : ''}">
            <div class="risk-header">
              <span class="risk-title"><span class="code-tag">${escapeHtml(r.code)}</span> ${escapeHtml(r.title)}</span>
              <span class="tp-badge ${sevClass}">${escapeHtml(r.severity)}</span>
            </div>
            <div class="chip-row">${sourceChip(r.source, r.validated)}${r.assertion ? `<span class="meta-pill">${escapeHtml(r.assertion)}</span>` : ''}</div>
            ${r.description ? `<div class="risk-desc">${escapeHtml(r.description)}</div>` : ''}
            ${r.recommendation ? `<div class="risk-rec"><strong>Recomendação:</strong> ${escapeHtml(r.recommendation)}</div>` : ''}
            <div class="link-row">${
              ctrls.length
                ? `Mitigado por: ${ctrls.map((c) => `<span class="link-pill">${escapeHtml(c.code)}</span>`).join(' ')}`
                : '<span class="warn-text">Sem controle mitigante vinculado (gap)</span>'
            }</div>
            ${r.sourceIds && r.sourceIds.length ? `<div class="src-row">Fonte: ${sourceLinks(r.sourceIds)}</div>` : ''}
            <div class="card-actions">
              <button class="btn-inline" data-risk-edit="${r.id}">Editar</button>
              <button class="btn-inline" data-risk-validate="${r.id}">${r.validated ? 'Desfazer validação' : 'Validar'}</button>
              <button class="btn-inline" data-risk-del="${r.id}">Excluir</button>
            </div>
          </div>`;
        })
        .join('')
    : '<div class="empty-state">Nenhum risco ou gap registrado até o momento.</div>';

  // Controles
  $('controlsCountBadge').textContent = String(S.controls.length);
  $('controlsTabContent').innerHTML = S.controls.length
    ? S.controls
        .map((c) => {
          const risks = S.risks.filter((r) => c.riskIds.includes(r.id));
          return `
          <div class="control-card">
            <div class="risk-header"><span class="risk-title"><span class="code-tag">${escapeHtml(c.code)}</span> ${escapeHtml(c.name)}</span></div>
            <div class="chip-row">${sourceChip(c.source, c.validated)}</div>
            <div class="control-meta">
              <span class="meta-pill">${escapeHtml(c.type)}</span>
              <span class="meta-pill">${escapeHtml(c.nature)}</span>
              <span class="meta-pill">${escapeHtml(c.frequency)}</span>
              <span class="meta-pill ${/gap/i.test(c.status) ? 'pill-warn' : ''}">TOD: ${escapeHtml(c.status)}</span>
              ${c.owner ? `<span class="meta-pill">Resp.: ${escapeHtml(c.owner)}</span>` : ''}
              ${c.assertion ? `<span class="meta-pill">${escapeHtml(c.assertion)}</span>` : ''}
            </div>
            <div class="link-row">${risks.length ? `Mitiga: ${risks.map((r) => `<span class="link-pill">${escapeHtml(r.code)}</span>`).join(' ')}` : '<span class="hint-text">Sem risco vinculado</span>'}</div>
            ${c.sourceIds && c.sourceIds.length ? `<div class="src-row">Fonte: ${sourceLinks(c.sourceIds)}</div>` : ''}
            <div class="card-actions">
              <button class="btn-inline" data-ctrl-edit="${c.id}">Editar</button>
              <button class="btn-inline" data-ctrl-validate="${c.id}">${c.validated ? 'Desfazer validação' : 'Validar'}</button>
              <button class="btn-inline" data-ctrl-del="${c.id}">Excluir</button>
            </div>
          </div>`;
        })
        .join('')
    : '<div class="empty-state">Nenhum controle catalogado nesta sessão.</div>';

  // PBC
  $('pbcCountBadge').textContent = String(S.pbcList.length);
  $('pbcTabContent').innerHTML = S.pbcList.length
    ? S.pbcList
        .map(
          (p) => `
          <div class="pbc-card">
            <div class="risk-header"><span class="risk-title"><span class="code-tag">${escapeHtml(p.code)}</span> ${escapeHtml(p.title)}</span></div>
            ${p.detail ? `<div class="risk-desc">${escapeHtml(p.detail)}</div>` : ''}
            <div class="control-meta">
              <span class="meta-pill">Resp.: ${escapeHtml(p.owner || 'a definir')}</span>
              <span class="meta-pill">Prazo: ${escapeHtml(formatDueDate(p.dueDate) || 'a definir')}</span>
              ${p.format ? `<span class="meta-pill">Formato: ${escapeHtml(p.format)}</span>` : ''}
            </div>
            <div class="pbc-status-row">
              <select class="status-select" data-pbc-status="${p.id}">
                ${PBC_STATUSES.map((s) => `<option ${s === p.status ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
              <span>
                <button class="btn-inline" data-pbc-edit="${p.id}">Editar</button>
                <button class="btn-inline" data-pbc-del="${p.id}">Remover</button>
              </span>
            </div>
          </div>`
        )
        .join('')
    : '<div class="empty-state">Nenhuma solicitação de evidência (PBC) adicionada.</div>';

  // Pontos em aberto
  const KIND_LABELS = { sem_resposta: 'Sem resposta', contradicao: 'Contradição', pendencia: 'Pendência' };
  $('openPointsCountBadge').textContent = String(S.openPoints.filter((o) => o.status === 'aberto').length);
  $('openPointsList').innerHTML = S.openPoints.length
    ? S.openPoints
        .map(
          (o) => `
          <div class="pbc-card ${o.status === 'resolvido' ? 'is-resolved' : ''}">
            <div class="chip-row"><span class="meta-pill">${KIND_LABELS[o.kind] || o.kind}</span><span class="origin-chip ${o.source === 'IA' ? 'origin-ai' : 'origin-plan'}">${escapeHtml(o.source)}</span><span class="hint-text">${escapeHtml(o.time || '')}</span></div>
            <div class="risk-desc">${escapeHtml(o.text)}</div>
            ${o.sourceIds && o.sourceIds.length ? `<div class="src-row">Fonte: ${sourceLinks(o.sourceIds)}</div>` : ''}
            <div class="card-actions">
              <button class="btn-inline" data-op-toggle="${o.id}">${o.status === 'aberto' ? 'Marcar resolvido' : 'Reabrir'}</button>
              <button class="btn-inline" data-op-pbc="${o.id}">→ PBC</button>
              <button class="btn-inline" data-op-del="${o.id}">Excluir</button>
            </div>
          </div>`
        )
        .join('')
    : '<div class="empty-state">Nenhum ponto em aberto.</div>';

  // Divergências
  $('divergencesCountBadge').textContent = String(S.divergences.length);
  $('divergencesList').innerHTML = S.divergences.length
    ? S.divergences
        .map(
          (d) => `
          <div class="risk-card sev-medio">
            <div class="chip-row">${sourceChip(d.source, d.validated)}</div>
            <div class="diverg-grid">
              <div><div class="mini-label">DOCUMENTADO</div>${escapeHtml(d.documented)}</div>
              <div><div class="mini-label">RELATADO NA REUNIÃO</div>${escapeHtml(d.stated)}</div>
            </div>
            ${d.impact ? `<div class="risk-rec"><strong>Impacto:</strong> ${escapeHtml(d.impact)}</div>` : ''}
            ${d.sourceIds && d.sourceIds.length ? `<div class="src-row">Fonte: ${sourceLinks(d.sourceIds)}</div>` : ''}
            <div class="card-actions">
              <button class="btn-inline" data-dv-validate="${d.id}">${d.validated ? 'Desfazer validação' : 'Validar'}</button>
              <button class="btn-inline" data-dv-risk="${d.id}">→ Risco</button>
              <button class="btn-inline" data-dv-del="${d.id}">Excluir</button>
            </div>
          </div>`
        )
        .join('')
    : `<div class="empty-state">${S.prepMaterial.trim() ? 'Nenhuma divergência identificada até o momento.' : 'Inclua o material de preparação (política, procedimento) para a IA comparar com o relato.'}</div>`;
}

// ============================================================================
// EDIÇÃO DE ITENS DA MATRIZ
// ============================================================================
async function editRisk(riskId) {
  const r = riskId ? S.risks.find((x) => x.id === riskId) : null;
  const values = await openForm({
    title: r ? `Editar risco ${r.code}` : 'Novo risco / gap',
    fields: [
      { name: 'title', label: 'Título', value: r ? r.title : '', required: true },
      { name: 'severity', label: 'Severidade', type: 'select', options: SEVERITIES, value: r ? r.severity : 'Alto' },
      { name: 'assertion', label: 'Afirmação / objetivo de controle', type: 'select', options: ASSERTIONS, value: r ? r.assertion : '' },
      { name: 'description', label: 'Descrição da fragilidade', type: 'textarea', value: r ? r.description : '' },
      { name: 'recommendation', label: 'Recomendação / controle mitigatório', type: 'textarea', value: r ? r.recommendation : '' }
    ]
  });
  if (!values) return;
  if (r) {
    Object.assign(r, values);
  } else {
    const created = addRisk({ ...values, source: 'Manual', validated: true });
    if (!created) return;
  }
  commit();
}

async function editControl(controlId) {
  const c = controlId ? S.controls.find((x) => x.id === controlId) : null;
  const values = await openForm({
    title: c ? `Editar controle ${c.code}` : 'Novo controle',
    fields: [
      { name: 'name', label: 'Nome / descrição do controle', value: c ? c.name : '', required: true },
      { name: 'type', label: 'Tipo', type: 'select', options: ['Preventivo', 'Detectivo'], value: c ? c.type : 'Preventivo' },
      { name: 'nature', label: 'Natureza', type: 'select', options: ['Automático', 'Manual', 'Híbrido'], value: c ? c.nature : 'Manual' },
      { name: 'frequency', label: 'Frequência', type: 'select', options: ['Por transação', 'Diário', 'Semanal', 'Mensal', 'Trimestral', 'Anual', 'Sob demanda'], value: c ? c.frequency : 'Por transação' },
      { name: 'owner', label: 'Responsável pelo controle', value: c ? c.owner : '' },
      { name: 'assertion', label: 'Afirmação / objetivo de controle', type: 'select', options: ASSERTIONS, value: c ? c.assertion : '' },
      { name: 'status', label: 'Avaliação de desenho (TOD)', type: 'select', options: TOD_STATUSES, value: c ? c.status : 'Em avaliação (walkthrough)' },
      {
        name: 'riskIds',
        label: 'Riscos mitigados por este controle',
        type: 'checkboxes',
        options: S.risks.map((r) => ({ value: r.id, label: `${r.code} — ${r.title}` })),
        value: c ? c.riskIds : []
      }
    ]
  });
  if (!values) return;
  if (c) {
    Object.assign(c, values);
  } else {
    addControl({ ...values, source: 'Manual', validated: true });
  }
  commit();
}

async function editPbc(pbcId) {
  const p = pbcId ? S.pbcList.find((x) => x.id === pbcId) : null;
  const values = await openForm({
    title: p ? `Editar item ${p.code} da Carta PBC` : 'Incluir Documento / Base / Evidência (PBC)',
    fields: [
      { name: 'category', label: 'Categoria Metodológica', type: 'select', options: PBC_CATEGORIES, value: p && p.category ? p.category : PBC_CATEGORIES[2] },
      { name: 'priority', label: 'Prioridade / Criticidade', type: 'select', options: ['Crítica', 'Alta', 'Média', 'Complementar'], value: p && p.priority ? p.priority : 'Alta' },
      { name: 'title', label: 'Documento / Base / Evidência Solicitada', value: p ? p.title : '', required: true },
      { name: 'purpose', label: 'Objetivo do Teste / Risco Associado', value: p && p.purpose ? p.purpose : 'Validação de desenho e conformidade do controle (Walkthrough / TOD).' },
      { name: 'detail', label: 'Critérios Técnicos de Extração & Requisitos de IPE', type: 'textarea', value: p ? p.detail : 'Apresentar print integral com parâmetros de filtro aplicados, código da transação/tela, usuário e data/hora da extração.' },
      { name: 'format', label: 'Formato Aceito', type: 'select', options: ['Base bruta original (.xlsx/.csv) + Print de filtros', 'Print integral de tela com data/hora e T-Code', 'PDF oficial / Normativo vigente', 'Extração de Log / Matriz de Perfis', 'Amostra documental fim-a-fim (PDF/Anexos)', 'Outro'], value: p && p.format ? p.format : 'Base bruta original (.xlsx/.csv) + Print de filtros' },
      { name: 'owner', label: 'Ponto Focal / Responsável', value: p ? p.owner : (S.pbcMeta && S.pbcMeta.recipient) || '' },
      { name: 'dueDate', label: 'Prazo Específico (opcional)', type: 'date', value: p ? p.dueDate : '' },
      { name: 'status', label: 'Status de Atendimento', type: 'select', options: PBC_STATUSES, value: p ? p.status : 'Pendente' }
    ]
  });
  if (!values) return;
  if (p) {
    Object.assign(p, values);
  } else {
    addPbc({ ...values, source: 'Manual' });
  }
  commit();
}

async function addManualOpenPoint() {
  const values = await openForm({
    title: 'Novo ponto em aberto',
    fields: [
      { name: 'text', label: 'Descrição', type: 'textarea', required: true },
      {
        name: 'kind',
        label: 'Tipo',
        type: 'select',
        options: [
          { value: 'pendencia', label: 'Pendência' },
          { value: 'sem_resposta', label: 'Pergunta sem resposta' },
          { value: 'contradicao', label: 'Contradição' }
        ],
        value: 'pendencia'
      }
    ]
  });
  if (!values) return;
  addOpenPoint({ ...values, source: 'Manual' });
  commit();
}

async function deleteItem(listName, id, label) {
  const ok = await confirmDialog(`Excluir ${label}? Esta ação não pode ser desfeita.`, { title: 'Excluir', okLabel: 'Excluir', danger: true });
  if (!ok) return;
  S[listName] = S[listName].filter((x) => x.id !== id);
  if (listName === 'risks') S.controls.forEach((c) => (c.riskIds = c.riskIds.filter((rid) => rid !== id)));
  commit();
}

function jumpToSource(srcId) {
  switchView('transcript');
  if ($('transcriptSearch').value) {
    $('transcriptSearch').value = '';
    renderTranscript();
  }
  const el = document.querySelector(`.tr-entry[data-tid="${srcId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1800);
  } else {
    showToast('Fala de origem não encontrada (pode ter sido excluída).');
  }
}

// ============================================================================
// JANELA FLUTUANTE (Document Picture-in-Picture)
// ============================================================================
async function openFloatingTeleprompter() {
  if (rt.pipWindow && !rt.pipWindow.closed) {
    rt.pipWindow.focus();
    return;
  }
  let win = null;
  if ('documentPictureInPicture' in window) {
    try {
      win = await window.documentPictureInPicture.requestWindow({ width: 500, height: 680 });
    } catch (err) {
      console.warn('PiP indisponível, usando popup:', err);
    }
  }
  if (!win) {
    win = window.open('', 'AuditPrompterFloating', 'width=500,height=680,menubar=no,toolbar=no,location=no,status=no');
  }
  if (!win) {
    await noticeDialog('Janela flutuante bloqueada', 'Permita pop-ups para este endereço (ícone na barra de endereço) e tente novamente.');
    return;
  }
  rt.pipWindow = win;
  setupPipWindowDOM(win);
  syncFloatingTeleprompter();
  win.addEventListener('pagehide', () => {
    rt.pipWindow = null;
  });
  showToast('Janela flutuante ativa — atalhos Ctrl+Alt também funcionam nela.');
}

function setupPipWindowDOM(win) {
  const dark = settings.theme === 'dark';
  win.document.head.innerHTML = `
    <meta charset="UTF-8" />
    <title>AuditPrompter</title>
    <style>
      body { margin:0; padding:12px; background:${dark ? '#0a0a0c' : '#f4f6f9'}; color:${dark ? '#f4f4f6' : '#0f172a'};
        font-family:'Inter',-apple-system,system-ui,sans-serif; display:flex; flex-direction:column; gap:8px; }
      .hdr { display:flex; justify-content:space-between; align-items:center; gap:6px; }
      .ttl { font-family:monospace; font-weight:600; font-size:.7rem; letter-spacing:.06em; opacity:.7; }
      button { background:${dark ? '#f4f4f6' : '#0f172a'}; color:${dark ? '#09090b' : '#fff'}; border:none; border-radius:4px;
        padding:5px 9px; font-size:.72rem; font-weight:600; cursor:pointer; }
      button.ghost { background:transparent; color:inherit; border:1px solid ${dark ? '#33333b' : '#cbd5e1'}; }
      .warn { background:#7f1d1d; color:#fee2e2; padding:6px 8px; border-radius:4px; font-size:.72rem; }
      .coach { border:1px solid ${dark ? '#232329' : '#e2e8f0'}; background:${dark ? '#131317' : '#fff'}; padding:7px 9px; border-radius:4px; font-size:.76rem; line-height:1.4; opacity:.9; }
      .card { background:${dark ? '#111114' : '#fff'}; border:1px solid ${dark ? '#232329' : '#e2e8f0'}; border-left:3px solid #64748b; border-radius:4px; padding:10px; }
      .card.critica { border-left-color:#dc2626; }
      .card.focus { outline:2px solid #0284c7; }
      .tag { font-family:monospace; font-size:.62rem; font-weight:600; opacity:.6; text-transform:uppercase; display:block; margin-bottom:4px; }
      .q { font-size:var(--fs,1rem); font-weight:500; line-height:1.45; }
      .scr { margin-top:7px; font-size:.82rem; line-height:1.4; padding-top:6px; border-top:1px dashed ${dark ? '#33333b' : '#e2e8f0'}; }
      .sub { font-size:.7rem; opacity:.6; margin-top:4px; }
      .acts { display:flex; gap:5px; margin-top:8px; flex-wrap:wrap; }
      input { width:100%; box-sizing:border-box; background:${dark ? '#111114' : '#fff'}; color:inherit; border:1px solid ${dark ? '#232329' : '#cbd5e1'}; border-radius:4px; padding:7px 8px; font-size:.78rem; }
      .keys { font-size:.64rem; opacity:.55; }
    </style>`;
  win.document.body.innerHTML = `
    <div class="hdr">
      <span class="ttl">AUDITPROMPTER</span>
      <span>
        <button class="ghost" id="pipMoment" title="Ctrl+Alt+M">★ Momento</button>
        <button class="ghost" id="pipNext" title="Ctrl+Alt+J">Próxima ›</button>
        <button id="pipAnalyze" title="Ctrl+Alt+A">Insight</button>
      </span>
    </div>
    <div id="pipWarn"></div>
    <div class="coach" id="pipCoach"></div>
    <input type="text" id="pipNote" placeholder="Fala do auditado / observação (Enter)" />
    <div id="pipCards"></div>
    <div class="keys">Ctrl+Alt: A insight · J/K navegar · D feita · P PBC · M momento</div>`;

  win.document.getElementById('pipAnalyze').addEventListener('click', () => runAnalysis({ manual: true }));
  win.document.getElementById('pipNext').addEventListener('click', () => moveFocus(1));
  win.document.getElementById('pipMoment').addEventListener('click', () => markMoment());
  const input = win.document.getElementById('pipNote');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) {
      addTranscript('Auditado', 'manual', input.value.trim());
      input.value = '';
      commit();
      runAnalysis({ manual: true });
    }
  });
  win.document.getElementById('pipCards').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'done') toggleAsked(btn.dataset.id);
    if (btn.dataset.act === 'pbc') questionToPbc(btn.dataset.id);
  });
  win.document.addEventListener('keydown', handleHotkey);
}

function syncFloatingTeleprompter() {
  const win = rt.pipWindow;
  if (!win || win.closed) return;
  const doc = win.document;
  const coach = doc.getElementById('pipCoach');
  const cards = doc.getElementById('pipCards');
  if (!coach || !cards) return;

  const warnEl = $('captureWarning');
  doc.getElementById('pipWarn').innerHTML = warnEl && !warnEl.classList.contains('hidden') ? `<div class="warn">${warnEl.innerHTML}</div>` : '';
  coach.innerHTML = `<strong>Foco:</strong> ${escapeHtml(String(S.coachingTip || '').replace(/^[\u{1F300}-\u{1FAFF}☀-➿]+\s*/u, ''))}`;
  doc.body.style.setProperty('--fs', `${settings.fontSize}rem`);

  const pending = filteredQuestions().filter((q) => !q.asked);
  const focusIdx = Math.max(0, pending.findIndex((q) => q.id === rt.focusedQuestionId));
  const ordered = pending.length ? [pending[focusIdx], ...pending.filter((_, i) => i !== focusIdx)].slice(0, 4) : [];

  cards.innerHTML = ordered.length
    ? ordered
        .map(
          (q, i) => `
        <div class="card ${q.priority === 'critica' ? 'critica' : ''} ${i === 0 ? 'focus' : ''}" style="margin-bottom:8px">
          <span class="tag">${i === 0 ? '▶ EM FOCO · ' : ''}${escapeHtml(q.category)}</span>
          <div class="q">“${escapeHtml(q.text)}”</div>
          ${q.screenScript ? `<div class="scr"><strong>Tela:</strong> ${escapeHtml(q.screenScript)}</div>` : ''}
          ${q.ipeTip ? `<div class="sub">${escapeHtml(q.ipeTip)}</div>` : ''}
          <div class="acts">
            <button data-act="done" data-id="${q.id}">✓ Feita</button>
            <button class="ghost" data-act="pbc" data-id="${q.id}">+ PBC</button>
          </div>
        </div>`
        )
        .join('')
    : '<div class="sub">Nenhuma pergunta pendente.</div>';
}

// ============================================================================
// CONFIGURAÇÕES
// ============================================================================
function applyTheme(themeName) {
  settings.theme = themeName === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', settings.theme);
  $('themeBtnLabel').textContent = settings.theme === 'light' ? 'Tema: Claro' : 'Tema: Escuro';
  persistSettings();
}

function applyFontSize() {
  document.documentElement.style.setProperty('--tp-font-size', `${settings.fontSize}rem`);
}

function adjustFontSize(delta) {
  settings.fontSize = Math.min(1.7, Math.max(0.88, +(settings.fontSize + delta).toFixed(2)));
  persistSettings();
  applyFontSize();
  syncFloatingTeleprompter();
}

function updateSettingsBadge() {
  const badge = $('apiKeyStatusBadge');
  if (!serverStatus.online) {
    badge.textContent = 'Offline';
    badge.className = 'status-tag missing';
    return;
  }
  const parts = [];
  if (serverStatus.claude) parts.push('Claude');
  if (serverStatus.gemini) parts.push('Gemini');
  badge.textContent = parts.length ? parts.join('+') : 'Local';
  badge.className = `status-tag ${parts.length ? 'ok' : 'missing'}`;
}

function openSettings() {
  $('aiProviderSelect').value = settings.provider;
  $('sysChunkIntervalSelect').value = String(settings.sysChunkSec);
  $('autoAnalyzeSelect').value = settings.autoAnalyze;
  $('minAnalyzeGapSelect').value = String(settings.minAnalyzeGapSec);
  $('liveModelSelect').value = settings.liveModel;
  $('liveEffortSelect').value = settings.liveEffort;
  $('reportModelSelect').value = settings.reportModel;
  $('geminiModelSelect').value = settings.geminiModel;
  $('auditorPersonaInput').value = settings.persona;
  $('claudeApiKeyInput').value = '';
  $('geminiApiKeyInput').value = '';
  $('settingsTestResult').textContent = '';
  renderKeyStatus();
  $('settingsModal').classList.remove('hidden');
}

function renderKeyStatus() {
  const off = !serverStatus.online;
  $('claudeKeyStatus').textContent = off ? '(servidor offline)' : serverStatus.claude ? '✓ chave salva no servidor local' : 'sem chave';
  $('geminiKeyStatus').textContent = off ? '(servidor offline)' : serverStatus.gemini ? '✓ chave salva no servidor local' : 'sem chave';
}

async function saveKeysFromInputs() {
  const claudeApiKey = $('claudeApiKeyInput').value.trim();
  const geminiApiKey = $('geminiApiKeyInput').value.trim();
  if (!claudeApiKey && !geminiApiKey) return;
  await api('/api/config', { body: { claudeApiKey: claudeApiKey || undefined, geminiApiKey: geminiApiKey || undefined } });
  $('claudeApiKeyInput').value = '';
  $('geminiApiKeyInput').value = '';
  await refreshServerStatus();
  renderKeyStatus();
}

async function saveSettings() {
  settings.provider = $('aiProviderSelect').value;
  settings.sysChunkSec = parseInt($('sysChunkIntervalSelect').value, 10) || 12;
  settings.autoAnalyze = $('autoAnalyzeSelect').value;
  settings.minAnalyzeGapSec = parseInt($('minAnalyzeGapSelect').value, 10) || 15;
  settings.liveModel = $('liveModelSelect').value;
  settings.liveEffort = $('liveEffortSelect').value;
  settings.reportModel = $('reportModelSelect').value;
  settings.geminiModel = $('geminiModelSelect').value;
  settings.persona = $('auditorPersonaInput').value.trim();
  persistSettings();
  try {
    await saveKeysFromInputs();
  } catch (err) {
    $('settingsTestResult').textContent = `Não foi possível salvar as chaves: ${err.message}`;
    return;
  }
  if (rt.sysCycleTimer) {
    clearInterval(rt.sysCycleTimer);
    rt.sysCycleTimer = setInterval(flushSystemSegment, settings.sysChunkSec * 1000);
  }
  $('settingsModal').classList.add('hidden');
  updateCaptureWarning();
  updateCycleStatus();
  showToast('Configurações salvas.');
}

async function removeKey(which) {
  const ok = await confirmDialog(`Remover a chave ${which === 'claude' ? 'Anthropic' : 'Gemini'} do servidor local?`, { title: 'Remover chave', okLabel: 'Remover', danger: true });
  if (!ok) {
    $('settingsModal').classList.remove('hidden');
    return;
  }
  try {
    await api('/api/config', { body: which === 'claude' ? { claudeApiKey: null } : { geminiApiKey: null } });
    await refreshServerStatus();
    showToast('Chave removida.');
  } catch (err) {
    showToast(`Erro: ${err.message}`);
  }
  $('settingsModal').classList.remove('hidden');
  renderKeyStatus();
}

async function testClaudeConnection() {
  const out = $('settingsTestResult');
  out.textContent = 'Testando conexão com a Anthropic...';
  try {
    await saveKeysFromInputs();
    const data = await api('/api/claude/test', { body: {} });
    out.textContent = `✓ ${data.message}${data.models && data.models.length ? ` Modelos disponíveis: ${data.models.join(', ')}.` : ''}`;
  } catch (err) {
    out.textContent = `✕ ${err.message}`;
  }
}

async function testGeminiConnection() {
  const out = $('settingsTestResult');
  out.textContent = 'Testando conexão com o Google Gemini...';
  try {
    await saveKeysFromInputs();
    settings.geminiModel = $('geminiModelSelect').value;
    const text = await geminiGenerate([{ text: 'Responda apenas: OK' }]);
    out.textContent = text ? '✓ Conexão com o Gemini validada.' : '✕ Resposta vazia do Gemini.';
  } catch (err) {
    out.textContent = `✕ ${err.message}`;
  }
}

// ============================================================================
// PREPARAÇÃO / ESCOPO
// ============================================================================
function fillScopeForm() {
  $('templateSelect').value = AUDIT_TEMPLATES[S.templateKey] ? S.templateKey : 'custom';
  $('auditMethodologySelect').value = S.methodology;
  $('auditTopicInput').value = S.topic;
  $('auditScopeInput').value = S.scope;
  $('participantsInput').value = S.participants;
  $('prepMaterialInput').value = S.prepMaterial;
  $('plannedQuestionsInput').value = S.plannedQuestionsText;
  updatePrepInfo();
}

function updatePrepInfo() {
  const n = S.prepMaterial.length;
  const approxTokens = Math.round(n / 4);
  $('prepMaterialInfo').textContent = `${n.toLocaleString('pt-BR')} caracteres (~${approxTokens.toLocaleString('pt-BR')} tokens, enviados em cache a cada análise)`;
}

async function importPrepFiles(files) {
  const parts = [];
  for (const file of files) {
    if (file.size > 3 * 1024 * 1024) {
      showToast(`${file.name}: arquivo maior que 3 MB — cole apenas o trecho relevante.`, 5000);
      continue;
    }
    const text = await file.text();
    parts.push(`=== ${file.name} ===\n${text.trim()}`);
  }
  if (!parts.length) return;
  S.prepMaterial = [S.prepMaterial.trim(), ...parts].filter(Boolean).join('\n\n');
  $('prepMaterialInput').value = S.prepMaterial;
  updatePrepInfo();
  commit();
  showToast(`${parts.length} arquivo(s) importado(s) para o material de preparação.`);
}

function applyPlannedQuestions() {
  S.plannedQuestionsText = $('plannedQuestionsInput').value;
  const lines = S.plannedQuestionsText
    .split('\n')
    .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((l) => l.length > 3);
  let added = 0;
  lines.forEach((text, i) => {
    const q = addQuestion(
      {
        priority: 'normal',
        category: 'Roteiro planejado',
        topicTitle: `Pergunta planejada ${i + 1}`,
        text,
        rationale: 'Pergunta preparada pelo auditor no planejamento.'
      },
      'planejada'
    );
    if (q) {
      q.time = '';
      S.questions.push(q);
      added += 1;
    }
  });
  commit();
  showToast(added ? `${added} pergunta(s) planejada(s) adicionada(s) ao teleprompter.` : 'Nenhuma pergunta nova (todas já estavam no teleprompter).');
}

async function startAuditTopic() {
  S.topic = $('auditTopicInput').value.trim() || 'Mapeamento de Processo e Controles Internos';
  S.methodology = $('auditMethodologySelect').value;
  S.scope = $('auditScopeInput').value.trim();
  const tplKey = $('templateSelect').value;

  const hasScript = S.questions.some((q) => q.origin === 'roteiro');
  if (hasScript) {
    const ok = await confirmDialog('Substituir as perguntas do roteiro atual? As perguntas planejadas, as geradas pela IA e todo o restante da sessão são mantidos.', {
      title: 'Carregar roteiro',
      okLabel: 'Substituir roteiro'
    });
    if (!ok) return;
  }

  if (tplKey !== 'custom' && AUDIT_TEMPLATES[tplKey]) {
    const keepTopic = S.topic;
    const keepScope = S.scope;
    const keepMethod = S.methodology;
    applyTemplateToSession(tplKey, { replaceScript: true });
    S.topic = keepTopic || S.topic;
    S.scope = keepScope || S.scope;
    S.methodology = keepMethod || S.methodology;
  } else {
    S.templateKey = 'custom';
    generateSmartLocalTopicGuide(S.topic, S.scope);
  }
  rt.focusedQuestionId = null;
  commit();
  switchView('live');

  if (analysisProvider() !== 'local') {
    runAnalysis({
      manual: true,
      instruction: `Início da reunião sobre "${S.topic}". Gere as melhores perguntas iniciais de walkthrough (fluxo fim-a-fim, alçadas, sistemas, segregação de funções e exceções), o que pedir para mostrar na tela (IPE) e os riscos/controles esperados deste processo, sem repetir as perguntas que já existem.`
    });
  } else {
    showToast('Roteiro carregado.');
  }
}

// ============================================================================
// CONTROLE POR PROJETOS DE AUDITORIA & HISTÓRICO DE REUNIÕES (DISCO + LOCAL)
// ============================================================================
const PROJECT_STATUSES = ['Planejamento', 'Em Execução', 'Relatório / Validação', 'Concluído'];
const TEMPLATE_OPTIONS_LIST = [
  'p2p — Compras e Pagamentos (Procure-to-Pay)',
  'iam — Gestão de Acessos e Identidades (ITGC / IAM)',
  'o2c — Vendas, Crédito e Recebimento (Order-to-Cash)',
  'r2r — Fechamento Contábil e Conciliações (R2R)',
  'hr — Folha de Pagamento e RH',
  'inv — Estoque, Inventário e Logística',
  'fraud — Prevenção a Fraudes e Pagamentos Críticos',
  'custom — Em branco / Personalizado'
];

async function syncProjectsWithServer(queryStr = '') {
  if (!serverStatus.online) {
    // Fallback offline usando índice do navegador
    const localIdx = readSessionIndex();
    if (projectsStore.projects.length === 0 && S) {
      const pid = S.projectId || 'prj-local';
      S.projectId = pid;
      projectsStore.projects = [{ id: pid, code: 'AUD-LOCAL', name: S.topic, clientUnit: S.scope || '', status: 'Em Execução', updatedAt: S.updatedAt }];
      projectsStore.sessions = localIdx.map((e) => ({ ...e, projectId: e.projectId || pid, meetingTitle: e.meetingTitle || e.topic }));
      projectsStore.selectedProjectId = pid;
    }
    renderHeader();
    if ($('view-sessions') && $('view-sessions').classList.contains('active')) renderSessions();
    return;
  }

  try {
    const url = queryStr ? `/api/projects?q=${encodeURIComponent(queryStr)}` : '/api/projects';
    let data = await api(url, { method: 'GET' });

    // Se o navegador tinha sessões salvas no localStorage que ainda não estão no disco, migra todas automaticamente!
    if (!queryStr) {
      const diskIds = new Set((data.sessions || []).map((s) => s.id));
      const localEntries = readSessionIndex();
      let migratedAny = false;

      // Se o disco já tinha projetos/sessões e a sessão atual do navegador está vazia (nova aba/outro navegador), carrega a mais recente do disco!
      if (data.sessions && data.sessions.length > 0 && S && S.transcript.length === 0 && !diskIds.has(S.id) && localEntries.length <= 1) {
        const latestDiskId = data.sessions[0].id;
        const diskLoaded = await fetchSessionFromDiskOrLocal(latestDiskId);
        if (diskLoaded) {
          S = diskLoaded;
          safeSet(SESSION_PREFIX + S.id, JSON.stringify(S));
          safeSet(CURRENT_SESSION_KEY, S.id);
          fillScopeForm();
        }
      } else {
        // Garante que a sessão atual (ex.: tudo o que foi feito hoje!) e quaisquer outras do navegador subam para o disco
        for (const loc of localEntries) {
          if (!diskIds.has(loc.id)) {
            const full = loc.id === S.id ? S : loadSessionById(loc.id);
            if (full) {
              const saved = await api('/api/projects/session', { body: { session: full } });
              if (loc.id === S.id && saved && saved.project) {
                S.projectId = saved.project.id;
                safeSet(SESSION_PREFIX + S.id, JSON.stringify(S));
              }
              migratedAny = true;
            }
          }
        }
        if (!diskIds.has(S.id)) {
          const saved = await api('/api/projects/session', { body: { session: S } });
          if (saved && saved.project) {
            S.projectId = saved.project.id;
            safeSet(SESSION_PREFIX + S.id, JSON.stringify(S));
          }
          migratedAny = true;
        }
        if (migratedAny) {
          data = await api('/api/projects', { method: 'GET' });
        }
      }
    }

    projectsStore.projects = data.projects || [];
    projectsStore.sessions = data.sessions || [];
    projectsStore.searchHits = data.searchHits || {};
    projectsStore.searchQuery = queryStr;

    if (!projectsStore.selectedProjectId || !projectsStore.projects.some((p) => p.id === projectsStore.selectedProjectId)) {
      projectsStore.selectedProjectId = (S && S.projectId) || (projectsStore.projects[0] && projectsStore.projects[0].id) || '';
    }

    renderAll();
  } catch (err) {
    console.warn('Falha ao sincronizar projetos:', err);
  }
}

async function fetchSessionFromDiskOrLocal(sessionId) {
  if (serverStatus.online) {
    try {
      const res = await api(`/api/projects/session?id=${encodeURIComponent(sessionId)}`, { method: 'GET' });
      if (res && res.session) return upgradeSession(res.session);
    } catch (_) {}
  }
  return loadSessionById(sessionId);
}

function renderSessions() {
  const prjContainer = $('projectsListContainer');
  const detailHdr = $('projectDetailHeader');
  const sesContainer = $('sessionsList');
  if (!prjContainer || !sesContainer) return;

  const q = norm(projectsStore.searchQuery || '');
  const allProjects = projectsStore.projects.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  // Filtra projetos se houver busca ativa
  const filteredProjects = allProjects.filter((p) => {
    if (!q) return true;
    if (norm(`${p.code} ${p.name} ${p.clientUnit}`).includes(q)) return true;
    const pSessions = projectsStore.sessions.filter((s) => s.projectId === p.id);
    return pSessions.some((s) => norm(`${s.meetingTitle} ${s.topic}`).includes(q) || Boolean(projectsStore.searchHits[s.id]));
  });

  if (filteredProjects.length > 0 && !filteredProjects.some((p) => p.id === projectsStore.selectedProjectId)) {
    projectsStore.selectedProjectId = filteredProjects[0].id;
  }

  prjContainer.innerHTML = filteredProjects.length
    ? filteredProjects
        .map((p) => {
          const pSessions = projectsStore.sessions.filter((s) => s.projectId === p.id);
          const totalSpeeches = pSessions.reduce((acc, s) => acc + ((s.counts && s.counts.transcript) || 0), 0);
          const totalRisks = pSessions.reduce((acc, s) => acc + ((s.counts && s.counts.risks) || 0), 0);
          const isSelected = p.id === projectsStore.selectedProjectId;
          const isActiveAudit = S && S.projectId === p.id;

          return `
            <div class="project-item-card ${isSelected ? 'selected' : ''}" data-select-prj="${escapeAttr(p.id)}">
              <div class="prj-card-top">
                <span class="prj-code-badge">${escapeHtml(p.code || 'AUD')}</span>
                <span class="prj-status-pill ${p.status === 'Em Execução' ? 'active-exec' : ''}">${isActiveAudit ? '● Aberto · ' : ''}${escapeHtml(p.status || 'Em Execução')}</span>
              </div>
              <div class="prj-title">${escapeHtml(p.name)}</div>
              ${p.clientUnit ? `<div class="prj-unit">${escapeHtml(p.clientUnit)}</div>` : ''}
              <div class="prj-metrics">
                <span><strong>${pSessions.length}</strong> ${pSessions.length === 1 ? 'reunião' : 'reuniões'}</span>
                <span>·</span>
                <span><strong>${totalSpeeches}</strong> falas</span>
                <span>·</span>
                <span><strong>${totalRisks}</strong> riscos</span>
              </div>
            </div>`;
        })
        .join('')
    : '<div class="empty-state">Nenhum projeto encontrado. Clique em "+ Novo Projeto / Nova Auditoria" acima.</div>';

  const selectedProject = allProjects.find((p) => p.id === projectsStore.selectedProjectId);
  if (!selectedProject) {
    if (detailHdr) detailHdr.innerHTML = '';
    sesContainer.innerHTML = '<div class="empty-state">Selecione um projeto à esquerda ou crie uma nova auditoria.</div>';
    return;
  }

  const prjSessions = projectsStore.sessions
    .filter((s) => s.projectId === selectedProject.id)
    .filter((s) => {
      if (!q) return true;
      if (norm(`${selectedProject.code} ${selectedProject.name}`).includes(q)) return true;
      return norm(`${s.meetingTitle} ${s.topic}`).includes(q) || Boolean(projectsStore.searchHits[s.id]);
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  if (detailHdr) {
    detailHdr.innerHTML = `
      <div class="project-detail-banner">
        <div>
          <span class="prj-code-badge">${escapeHtml(selectedProject.code)}</span>
          <span class="prj-status-pill" style="margin-left:6px;">${escapeHtml(selectedProject.status || 'Em Execução')}</span>
          <div class="pdb-title">${escapeHtml(selectedProject.name)}</div>
          <div class="pdb-sub">
            ${selectedProject.clientUnit ? `Área / Unidade: <strong>${escapeHtml(selectedProject.clientUnit)}</strong> · ` : ''}
            ${selectedProject.auditorLead ? `Auditor: ${escapeHtml(selectedProject.auditorLead)} · ` : ''}
            Atualizado em ${escapeHtml(formatDateBr(selectedProject.updatedAt))}
          </div>
        </div>
        <div class="card-actions" style="margin-top:0;">
          <button class="btn-solid-sm" data-prj-new-meet="${escapeAttr(selectedProject.id)}">+ Nova Reunião neste Projeto</button>
          <button class="btn-inline" data-prj-edit="${escapeAttr(selectedProject.id)}">Editar Projeto</button>
          <button class="btn-inline" data-prj-del="${escapeAttr(selectedProject.id)}">Excluir Projeto</button>
        </div>
      </div>
    `;
  }

  sesContainer.innerHTML = prjSessions.length
    ? prjSessions
        .map((e) => {
          const isCurrent = S && e.id === S.id;
          const isExpanded = projectsStore.expandedSessionId === e.id;
          const cachedFull = projectsStore.expandedCache[e.id];
          const hits = projectsStore.searchHits[e.id];

          let drawerHtml = '';
          if (isExpanded && cachedFull) {
            const mappedTopics = (cachedFull.questions || []).filter((it) => it.origin !== 'roteiro' || it.asked);
            const trList = cachedFull.transcript || [];
            drawerHtml = `
              <div class="mhc-transcript-drawer">
                <div style="font-weight:700; margin-bottom:6px; color:var(--text-main);">Assuntos Mapeados nesta Reunião (${mappedTopics.length}):</div>
                ${
                  mappedTopics.length
                    ? `<ul style="margin:0 0 12px 18px; padding:0;">${mappedTopics
                        .map((it) => `<li><strong>${escapeHtml(it.topicTitle || it.category)}:</strong> ${escapeHtml(it.topicSummary || it.text)}</li>`)
                        .join('')}</ul>`
                    : '<div class="hint-text" style="margin-bottom:10px;">Nenhum assunto extra além do roteiro base.</div>'
                }
                <div style="font-weight:700; margin-bottom:6px; color:var(--text-main);">Histórico Completo do que foi Falado (${trList.length} registros):</div>
                ${
                  trList.length
                    ? trList
                        .map(
                          (t) =>
                            `<div style="padding:4px 0; border-bottom:1px dashed var(--border-line);"><strong>[T${t.seq} · ${escapeHtml(t.time)}] ${escapeHtml(t.speaker)}:</strong> ${escapeHtml(t.text)}</div>`
                        )
                        .join('')
                    : '<div class="hint-text">Nenhuma fala gravada nesta reunião ainda.</div>'
                }
              </div>`;
          }

          return `
            <div class="meeting-history-card ${isCurrent ? 'is-current' : ''}">
              <div class="risk-header">
                <div>
                  <span class="risk-title" style="font-size:0.9rem;">${escapeHtml(e.meetingTitle || e.topic || 'Reunião')}</span>
                  ${isCurrent ? '<span class="origin-chip origin-ok" style="margin-left:6px;">Aberta Agora</span>' : ''}
                  <div class="hint-text" style="margin-top:2px;">
                    Processo: ${escapeHtml(e.topic || '—')} · Data: ${escapeHtml(formatDateBr(e.createdAt))} · Última edição: ${escapeHtml(formatDateBr(e.updatedAt))}
                  </div>
                </div>
              </div>

              <div class="control-meta" style="margin-top:8px;">
                <span class="meta-pill"><strong>${(e.counts && e.counts.transcript) || 0}</strong> falas transcritas</span>
                <span class="meta-pill"><strong>${(e.counts && e.counts.topics) || 0}</strong> tópicos / insights</span>
                <span class="meta-pill"><strong>${(e.counts && e.counts.risks) || 0}</strong> riscos</span>
                <span class="meta-pill"><strong>${(e.counts && e.counts.controls) || 0}</strong> controles</span>
                <span class="meta-pill"><strong>${(e.counts && e.counts.pbc) || 0}</strong> itens PBC</span>
              </div>

              ${
                e.recentTopics && e.recentTopics.length
                  ? `<div class="mhc-topics-box"><strong>Principais assuntos discutidos:</strong> ${e.recentTopics.map(escapeHtml).join(' • ')}</div>`
                  : ''
              }

              ${
                hits && (hits.matchedLines.length || hits.matchedTopics.length)
                  ? `<div class="search-hit-box"><strong>Encontrado nesta reunião:</strong><br>${hits.matchedLines.map(escapeHtml).join('<br>')}</div>`
                  : ''
              }

              <div class="card-actions" style="margin-top:10px;">
                ${
                  isCurrent
                    ? `<button class="btn-solid-sm" data-ses-go-live="${e.id}">Ir para Mapeamento Ao Vivo</button>`
                    : `<button class="btn-solid-sm" data-ses-open="${e.id}">Abrir / Retomar esta Reunião</button>`
                }
                <button class="btn-ghost-sm" data-ses-preview="${e.id}">${isExpanded ? 'Ocultar o que foi falado ▲' : 'Ver tudo o que foi falado ▼'}</button>
                <button class="btn-inline" data-ses-rename="${e.id}">Renomear</button>
                <button class="btn-inline" data-ses-export="${e.id}">Exportar .json</button>
                ${isCurrent && prjSessions.length <= 1 ? '' : `<button class="btn-inline" data-ses-del="${e.id}">Excluir</button>`}
              </div>

              ${drawerHtml}
            </div>`;
        })
        .join('')
    : '<div class="empty-state">Nenhuma reunião neste projeto para o filtro informado.</div>';
}

function isCapturing() {
  return Boolean(rt.sysStream || rt.micStream);
}

async function stopCaptureIfNeeded(actionLabel) {
  if (!isCapturing()) return true;
  const ok = await confirmDialog(`A captura de áudio está ativa. Ela será encerrada para ${actionLabel}.`, { title: 'Encerrar captura', okLabel: 'Encerrar e continuar' });
  if (!ok) return false;
  if (rt.sysStream) stopSystemAudio();
  if (rt.micStream) stopMicAudio();
  return true;
}

function resetRuntimeForSession() {
  clearTimeout(rt.analyzeTimer);
  rt.analyzeTimer = null;
  rt.analyzeDueAt = 0;
  rt.pendingAnalysis = null;
  rt.transcribeQueue = [];
  rt.focusedQuestionId = null;
}

async function createNewProject() {
  const nextNum = String(projectsStore.projects.length + 1).padStart(2, '0');
  const suggestedCode = `AUD-${new Date().getFullYear()}-${nextNum}`;

  const values = await openForm({
    title: 'Novo Projeto / Nova Auditoria',
    subtitle: 'Crie um novo projeto isolado. Tudo que for transcrito, mapeado e gerado ficará salvo dentro dele.',
    fields: [
      { name: 'code', label: 'Código do Projeto / Auditoria', value: suggestedCode, required: true },
      { name: 'name', label: 'Nome do Projeto / Processo Auditado', placeholder: 'Ex.: Auditoria de Compras e Pagamentos (SAP)', required: true },
      { name: 'clientUnit', label: 'Empresa / Área / Unidade Auditada', placeholder: 'Ex.: Diretoria de Suprimentos — Matriz' },
      { name: 'auditorLead', label: 'Auditor(es) Responsável(is)', value: (S && S.pbcMeta && S.pbcMeta.auditorName) || '' },
      { name: 'templateChoice', label: 'Modelo Inicial de Roteiro', type: 'select', options: TEMPLATE_OPTIONS_LIST, value: TEMPLATE_OPTIONS_LIST[0] },
      { name: 'meetingTitle', label: 'Título da 1ª Reunião', value: 'Reunião 01 — Kick-off & Walkthrough' }
    ],
    submitLabel: 'Criar Projeto e Abrir'
  });
  if (!values) return;
  if (!(await stopCaptureIfNeeded('criar um novo projeto'))) return;

  persistNow();
  resetRuntimeForSession();

  const tplKey = String(values.templateChoice || 'p2p').split(' — ')[0].trim();
  let createdPrj = {
    id: uid('prj'),
    code: values.code.trim(),
    name: values.name.trim(),
    clientUnit: values.clientUnit.trim(),
    auditorLead: values.auditorLead.trim(),
    status: 'Em Execução'
  };

  if (serverStatus.online) {
    try {
      const res = await api('/api/projects/save', { body: createdPrj });
      if (res && res.project) createdPrj = res.project;
    } catch (_) {}
  }

  newSessionObject(tplKey === 'custom' ? 'custom' : tplKey);
  S.projectId = createdPrj.id;
  S.topic = createdPrj.name;
  S.scope = createdPrj.clientUnit || S.scope;
  S.meetingTitle = values.meetingTitle.trim() || 'Reunião 01 — Walkthrough';
  if (tplKey === 'custom') generateSmartLocalTopicGuide(S.topic, S.scope);

  projectsStore.projects.unshift(createdPrj);
  projectsStore.selectedProjectId = createdPrj.id;

  persistNow();
  fillScopeForm();
  commit();
  switchView('live');
  showToast(`Projeto criado e aberto: ${createdPrj.code} — ${createdPrj.name}`);
}

async function editProjectModal(projectId) {
  const prj = projectsStore.projects.find((p) => p.id === projectId);
  if (!prj) return;
  const values = await openForm({
    title: `Editar Projeto ${prj.code}`,
    fields: [
      { name: 'code', label: 'Código da Auditoria', value: prj.code, required: true },
      { name: 'name', label: 'Nome do Projeto / Auditoria', value: prj.name, required: true },
      { name: 'clientUnit', label: 'Empresa / Área / Unidade', value: prj.clientUnit || '' },
      { name: 'auditorLead', label: 'Auditor Responsável', value: prj.auditorLead || '' },
      { name: 'status', label: 'Status do Projeto', type: 'select', options: PROJECT_STATUSES, value: prj.status || 'Em Execução' }
    ]
  });
  if (!values) return;
  Object.assign(prj, values);
  if (serverStatus.online) {
    try {
      await api('/api/projects/save', { body: prj });
    } catch (_) {}
  }
  renderHeader();
  renderSessions();
  showToast('Dados do projeto atualizados.');
}

async function deleteProjectConfirm(projectId) {
  const prj = projectsStore.projects.find((p) => p.id === projectId);
  if (!prj) return;
  if (projectsStore.projects.length <= 1) {
    showToast('Crie outro projeto antes de excluir o único projeto ativo.');
    return;
  }
  const ok = await confirmDialog(`Excluir o projeto "${prj.code} — ${prj.name}" e todas as reuniões vinculadas a ele?`, {
    title: 'Excluir Projeto',
    okLabel: 'Excluir permanentemente',
    danger: true
  });
  if (!ok) return;

  const sesToRemove = projectsStore.sessions.filter((s) => s.projectId === projectId);
  sesToRemove.forEach((s) => safeRemove(SESSION_PREFIX + s.id));
  writeSessionIndex(readSessionIndex().filter((s) => s.projectId !== projectId));

  if (serverStatus.online) {
    try {
      await api('/api/projects/delete', { body: { projectId } });
    } catch (_) {}
  }

  projectsStore.projects = projectsStore.projects.filter((p) => p.id !== projectId);
  projectsStore.sessions = projectsStore.sessions.filter((s) => s.projectId !== projectId);

  if (S && S.projectId === projectId && projectsStore.sessions.length > 0) {
    await openSession(projectsStore.sessions[0].id);
  } else {
    projectsStore.selectedProjectId = (projectsStore.projects[0] && projectsStore.projects[0].id) || '';
    renderHeader();
    renderSessions();
  }
  showToast('Projeto excluído.');
}

async function createNewSession(explicitProjectId = '') {
  const targetPid = explicitProjectId || (S && S.projectId) || projectsStore.selectedProjectId;
  const prj = projectsStore.projects.find((p) => p.id === targetPid) || activeProjectObj();
  const existingMeetings = projectsStore.sessions.filter((s) => s.projectId === (prj ? prj.id : '')).length;
  const nextMeetNum = String(existingMeetings + 1).padStart(2, '0');

  const values = await openForm({
    title: `Nova Reunião no Projeto ${prj ? prj.code : ''}`,
    subtitle: prj ? prj.name : 'Adicione uma nova entrevista/walkthrough dentro deste mesmo projeto.',
    fields: [
      { name: 'meetingTitle', label: 'Título desta Reunião / Entrevista', value: `Reunião ${nextMeetNum} — Walkthrough Complementar`, required: true },
      { name: 'participants', label: 'Participantes / Entrevistados (opcional)', placeholder: 'Ex.: João Silva — Coordenador Financeiro' },
      {
        name: 'carryForward',
        label: 'Aproveitar dados já levantados neste projeto?',
        type: 'select',
        options: ['Sim — manter Escopo, Riscos, Controles e Lista PBC acumulados do projeto', 'Não — iniciar matriz e roteiro limpos nesta reunião'],
        value: 'Sim — manter Escopo, Riscos, Controles e Lista PBC acumulados do projeto'
      }
    ],
    submitLabel: 'Iniciar Reunião'
  });
  if (!values) return;
  if (!(await stopCaptureIfNeeded('iniciar uma nova reunião no projeto'))) return;

  persistNow();
  const prevSession = S ? JSON.parse(JSON.stringify(S)) : null;
  resetRuntimeForSession();

  const keepMatrix = String(values.carryForward || '').startsWith('Sim');
  newSessionObject(prevSession ? prevSession.templateKey : 'p2p');
  S.projectId = prj ? prj.id : targetPid;
  S.meetingTitle = values.meetingTitle.trim();
  S.participants = values.participants.trim();

  if (prevSession && keepMatrix) {
    S.topic = prevSession.topic;
    S.scope = prevSession.scope;
    S.methodology = prevSession.methodology;
    S.prepMaterial = prevSession.prepMaterial || '';
    S.risks = prevSession.risks || [];
    S.controls = prevSession.controls || [];
    S.pbcList = prevSession.pbcList || [];
    S.checklist = prevSession.checklist || getDefaultChecklist();
    S.counters = prevSession.counters || { R: 0, C: 0, P: 0 };
    S.pbcMeta = prevSession.pbcMeta || null;
  } else if (prj) {
    S.topic = prj.name;
    S.scope = prj.clientUnit || S.scope;
  }

  persistNow();
  fillScopeForm();
  commit();
  switchView('live');
  showToast(`Reunião iniciada: ${S.meetingTitle}`);
}

async function openSession(id) {
  if (!(await stopCaptureIfNeeded('abrir outra reunião'))) return;
  const loaded = await fetchSessionFromDiskOrLocal(id);
  if (!loaded) {
    showToast('Não foi possível carregar os dados desta reunião.');
    return;
  }
  persistNow();
  resetRuntimeForSession();
  S = loaded;
  projectsStore.selectedProjectId = S.projectId || projectsStore.selectedProjectId;
  safeSet(SESSION_PREFIX + S.id, JSON.stringify(S));
  safeSet(CURRENT_SESSION_KEY, S.id);
  fillScopeForm();
  commit();
  switchView('live');
  showToast(`Aberto: ${S.meetingTitle || S.topic} (${S.transcript.length} falas salvas)`);
}

async function toggleMeetingPreview(id) {
  if (projectsStore.expandedSessionId === id) {
    projectsStore.expandedSessionId = '';
    renderSessions();
    return;
  }
  const full = S && S.id === id ? S : await fetchSessionFromDiskOrLocal(id);
  if (!full) {
    showToast('Não foi possível carregar o histórico desta reunião.');
    return;
  }
  projectsStore.expandedCache[id] = full;
  projectsStore.expandedSessionId = id;
  renderSessions();
}

async function renameMeetingModal(id) {
  const full = S && S.id === id ? S : await fetchSessionFromDiskOrLocal(id);
  if (!full) return;
  const values = await openForm({
    title: 'Renomear Reunião',
    fields: [{ name: 'meetingTitle', label: 'Título da Reunião', value: full.meetingTitle || full.topic, required: true }]
  });
  if (!values) return;
  full.meetingTitle = values.meetingTitle.trim();
  if (S && S.id === id) S.meetingTitle = full.meetingTitle;
  safeSet(SESSION_PREFIX + full.id, JSON.stringify(full));
  if (serverStatus.online) {
    await api('/api/projects/session', { body: { session: full } });
    await syncProjectsWithServer(projectsStore.searchQuery);
  }
  renderHeader();
  renderSessions();
}

async function exportSession(id) {
  const data = S && id === S.id ? S : await fetchSessionFromDiskOrLocal(id);
  if (!data) return;
  downloadFile(JSON.stringify(data, null, 2), `Auditoria_${sanitizeFileName(data.meetingTitle || data.topic)}_${dateStamp()}.json`, 'application/json');
}

async function deleteSession(id) {
  const ok = await confirmDialog('Excluir esta reunião permanentemente do histórico do projeto?', { title: 'Excluir reunião', okLabel: 'Excluir', danger: true });
  if (!ok) return;
  safeRemove(SESSION_PREFIX + id);
  writeSessionIndex(readSessionIndex().filter((e) => e.id !== id));
  if (serverStatus.online) {
    try {
      await api('/api/projects/session/delete', { body: { sessionId: id } });
    } catch (_) {}
  }
  projectsStore.sessions = projectsStore.sessions.filter((s) => s.id !== id);
  if (S && S.id === id && projectsStore.sessions.length > 0) {
    await openSession(projectsStore.sessions[0].id);
  } else {
    renderSessions();
  }
}

async function importSessionFile(file) {
  try {
    const obj = JSON.parse(await file.text());
    const session = upgradeSession(obj);
    if (!session || !Array.isArray(session.transcript)) throw new Error('arquivo inválido');
    if (projectsStore.sessions.some((e) => e.id === session.id) || session.id === S.id) session.id = uid('ses');
    if (!session.projectId && S && S.projectId) session.projectId = S.projectId;
    if (!(await stopCaptureIfNeeded('abrir a reunião importada'))) return;
    persistNow();
    resetRuntimeForSession();
    S = session;
    persistNow();
    if (serverStatus.online) {
      await api('/api/projects/session', { body: { session: S } });
      await syncProjectsWithServer();
    }
    fillScopeForm();
    commit();
    showToast(`Reunião importada no projeto: ${S.meetingTitle || S.topic}`);
  } catch (err) {
    showToast(`Não foi possível importar: ${err.message}`, 5000);
  }
}

// ============================================================================
// PAPEL DE TRABALHO, ATA, 5W2H & EXPORTAÇÕES
// ============================================================================
const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['narrativa', 'ata', 'etapas5w2h', 'pontosEmAberto'],
  properties: {
    narrativa: { type: 'string' },
    ata: {
      type: 'object',
      additionalProperties: false,
      required: ['objetivo', 'participantes', 'principaisPontos', 'decisoes', 'encaminhamentos'],
      properties: {
        objetivo: { type: 'string' },
        participantes: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['nome', 'papel'], properties: { nome: { type: 'string' }, papel: { type: 'string' } } }
        },
        principaisPontos: { type: 'array', items: { type: 'string' } },
        decisoes: { type: 'array', items: { type: 'string' } },
        encaminhamentos: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['acao', 'responsavel', 'prazo'],
            properties: { acao: { type: 'string' }, responsavel: { type: 'string' }, prazo: { type: 'string' } }
          }
        }
      }
    },
    etapas5w2h: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['etapa', 'oQue', 'quem', 'quando', 'onde', 'porQue', 'como', 'quanto'],
        properties: {
          etapa: { type: 'string' },
          oQue: { type: 'string' },
          quem: { type: 'string' },
          quando: { type: 'string' },
          onde: { type: 'string' },
          porQue: { type: 'string' },
          como: { type: 'string' },
          quanto: { type: 'string' }
        }
      }
    },
    pontosEmAberto: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'kind'],
        properties: { text: { type: 'string' }, kind: { type: 'string', enum: ['sem_resposta', 'contradicao', 'pendencia'] } }
      }
    }
  }
};

const REPORT_SYSTEM_PROMPT = `Você redige papéis de trabalho de Auditoria Interna (walkthrough / Test of Design) em português do Brasil, com linguagem formal, objetiva e factual.
Regras:
- Use apenas o que está na transcrição, nos momentos marcados e nos registros da matriz. Não invente nomes, valores, datas ou sistemas; quando algo não foi informado, escreva "[a confirmar]".
- "narrativa": narrativa do walkthrough em parágrafos (fluxo do processo, controles observados, fragilidades e próximos passos), citando os códigos de riscos/controles (R01, C02) quando aplicável.
- "ata": objetivo da reunião, participantes (use a lista informada; não crie pessoas), principais pontos, decisões e encaminhamentos com responsável e prazo ("[a confirmar]" se não definidos).
- "etapas5w2h": uma linha por etapa do processo descrita (o quê, quem, quando, onde/sistema, por quê, como, quanto/volume).
- "pontosEmAberto": perguntas sem resposta, contradições e pendências que ainda não constem na lista informada.`;

function buildReportPrompt() {
  return [
    `PROCESSO: ${S.topic}`,
    `ESCOPO / SISTEMAS: ${S.scope || '[a confirmar]'}`,
    `METODOLOGIA: ${METHODOLOGY_LABELS[S.methodology] || S.methodology}`,
    `DATA: ${formatDateBr(S.createdAt)}`,
    `PARTICIPANTES INFORMADOS:\n${S.participants.trim() || '(não informados)'}`,
    '',
    'RISCOS:',
    S.risks.map((r) => `${r.code} [${r.severity}] ${r.title} — ${r.description} ${r.validated ? '(validado)' : '(não validado)'}`).join('\n') || '(nenhum)',
    '',
    'CONTROLES:',
    S.controls
      .map((c) => `${c.code} ${c.name} — ${c.type}/${c.nature}/${c.frequency}; TOD: ${c.status}; mitiga: ${S.risks.filter((r) => c.riskIds.includes(r.id)).map((r) => r.code).join(', ') || 'nenhum'}`)
      .join('\n') || '(nenhum)',
    '',
    'EVIDÊNCIAS SOLICITADAS (PBC):',
    S.pbcList.map((p) => `${p.code} ${p.title} — resp.: ${p.owner || '[a confirmar]'}; prazo: ${formatDueDate(p.dueDate) || '[a confirmar]'}; status: ${p.status}`).join('\n') || '(nenhuma)',
    '',
    'PONTOS EM ABERTO JÁ REGISTRADOS:',
    S.openPoints.map((o) => `- ${o.text} (${o.status})`).join('\n') || '(nenhum)',
    '',
    'MOMENTOS MARCADOS PELO AUDITOR:',
    S.moments.map((m) => `[${m.time}] ${m.note || '(sem anotação)'}\n${m.excerpt}`).join('\n\n') || '(nenhum)',
    '',
    'TRANSCRIÇÃO LITERAL:',
    S.transcript.map(formatTranscriptLine).join('\n') || '(sem transcrição)'
  ].join('\n');
}

function buildLocalReport() {
  const participants = S.participants
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [nome, ...rest] = l.split(/\s+[—-]\s+/);
      return { nome: nome || l, papel: rest.join(' — ') || '[a confirmar]' };
    });
  return {
    narrativa:
      `Durante a sessão de walkthrough do processo "${S.topic}" (escopo: ${S.scope || '[a confirmar]'}), foram avaliados o fluxo do processo, alçadas de aprovação, segregação de funções, sistemas utilizados e evidências (IPE).\n\n` +
      `Foram registrados ${S.risks.length} riscos/gaps (${S.risks.filter((r) => r.validated).length} validados) e ${S.controls.length} controles. ` +
      `${S.risks.filter((r) => !S.controls.some((c) => c.riskIds.includes(r.id))).length} risco(s) não possuem controle mitigante vinculado. ` +
      `As evidências solicitadas (PBC) e os pontos em aberto estão listados nas seções seguintes para conclusão do Teste de Desenho (TOD).`,
    ata: {
      objetivo: `Walkthrough do processo "${S.topic}".`,
      participantes: participants,
      principaisPontos: S.questions.filter((q) => q.asked).map((q) => q.topicTitle),
      decisoes: [],
      encaminhamentos: S.pbcList
        .filter((p) => p.status !== 'Validado' && p.status !== 'Não aplicável')
        .map((p) => ({ acao: `Enviar evidência ${p.code}: ${p.title}`, responsavel: p.owner || '[a confirmar]', prazo: formatDueDate(p.dueDate) || '[a confirmar]' }))
    },
    etapas5w2h: [],
    pontosEmAberto: []
  };
}

async function generateReport() {
  const provider = analysisProvider();
  const btn = $('btnGenerateAiSummary');
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Redigindo...';
  try {
    let result;
    if (provider === 'local') {
      result = buildLocalReport();
      S.report.generatedBy = 'Modelo local (sem IA)';
    } else {
      showToast(`Redigindo narrativa, ata e 5W2H com ${provider === 'claude' ? 'Claude' : 'Gemini'}...`, 5000);
      result = await aiJson({
        provider,
        systemBlocks: [REPORT_SYSTEM_PROMPT],
        prompt: buildReportPrompt(),
        schema: REPORT_SCHEMA,
        model: settings.reportModel,
        effort: 'high'
      });
      S.report.generatedBy = provider === 'claude' ? `IA (${settings.reportModel})` : `IA (${settings.geminiModel})`;
    }
    S.report.narrative = result.narrativa || '';
    S.report.minutes = result.ata || null;
    S.report.steps5w2h = Array.isArray(result.etapas5w2h) ? result.etapas5w2h : [];
    S.report.generatedAt = new Date().toISOString();
    (result.pontosEmAberto || []).forEach((o) => addOpenPoint({ ...o, source: provider === 'local' ? 'Local' : 'IA' }));
    commit();
    renderReportPreview();
    showToast('Papel de trabalho atualizado. Revise o texto antes de usar.');
  } catch (err) {
    showToast(`Erro ao redigir: ${err.message}`, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function tableHtml(headers, rows, emptyText) {
  return `<table class="rcm-table"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${
    rows.length ? rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}">${escapeHtml(emptyText)}</td></tr>`
  }</tbody></table>`;
}

function rcmRows() {
  const rows = [];
  S.risks.forEach((r) => {
    const ctrls = S.controls.filter((c) => c.riskIds.includes(r.id));
    if (ctrls.length === 0) {
      rows.push({ r, c: null });
    } else {
      ctrls.forEach((c) => rows.push({ r, c }));
    }
  });
  S.controls.filter((c) => c.riskIds.length === 0).forEach((c) => rows.push({ r: null, c }));
  return rows;
}

function validationLabel(item) {
  if (!item) return '';
  if (item.source === 'Manual') return 'Manual';
  return item.validated ? `${item.source} — validado` : `${item.source} — NÃO validado`;
}

function participantsList() {
  return S.participants
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function renderReportPreview() {
  const container = $('reportPreviewContainer');
  if (!container) return;
  const covered = S.checklist.filter((c) => c.covered).length;
  const unvalidated = [...S.risks, ...S.controls].filter((x) => !x.validated && x.source !== 'Manual').length;
  const minutes = S.report.minutes;
  const includeTranscript = $('chkIncludeTranscript').checked;
  const consentText = S.consent
    ? `Participantes informados sobre transcrição/IA em ${formatDateBr(S.consent.at)} — modo: ${{ full: 'completo', mic_only: 'só microfone do auditor', text_only: 'sem áudio' }[S.consent.mode]}.`
    : 'Sem captura de áudio nesta sessão.';

  const rcm = rcmRows().map(({ r, c }) => [
    r ? `${r.code} — ${r.title}` : '(sem risco vinculado)',
    r ? r.severity : '',
    c ? `${c.code} — ${c.name}` : 'SEM CONTROLE (gap)',
    c ? `${c.type} / ${c.nature} / ${c.frequency}` : '',
    (c && c.assertion) || (r && r.assertion) || '',
    c ? c.status : '',
    r ? r.recommendation : '',
    [validationLabel(r), validationLabel(c)].filter(Boolean).join(' | ')
  ]);

  container.innerHTML = `
    <h2>Papel de Trabalho: Walkthrough de Auditoria Interna</h2>
    <p><strong>Processo:</strong> ${escapeHtml(S.topic)}<br>
    <strong>Escopo / Sistemas:</strong> ${escapeHtml(S.scope || '[a confirmar]')}<br>
    <strong>Metodologia:</strong> ${escapeHtml(METHODOLOGY_LABELS[S.methodology] || S.methodology)} | <strong>Data da sessão:</strong> ${escapeHtml(formatDateBr(S.createdAt))} | <strong>Cobertura do checklist:</strong> ${covered}/${S.checklist.length}<br>
    <strong>Transparência / LGPD:</strong> ${escapeHtml(consentText)}</p>
    ${unvalidated ? `<p class="ai-flag">Atenção: ${unvalidated} item(ns) da matriz ainda não foram validados pelo auditor.</p>` : ''}

    <h3>1. Narrativa do Walkthrough</h3>
    ${
      S.report.narrative
        ? `<p class="ai-flag">Texto gerado por ${escapeHtml(S.report.generatedBy)} em ${escapeHtml(formatDateBr(S.report.generatedAt))} — revisar antes de assinar.</p><p>${escapeHtml(S.report.narrative).replace(/\n/g, '<br>')}</p>`
        : `<p class="hint-text">Clique em "Redigir Narrativa, Ata e 5W2H" para gerar esta seção.</p>`
    }

    <h3>2. Ata da Reunião</h3>
    ${
      minutes
        ? `<p><strong>Objetivo:</strong> ${escapeHtml(minutes.objetivo || '')}</p>
           ${tableHtml(['Participante', 'Papel'], (minutes.participantes || []).map((p) => [p.nome, p.papel]), 'Participantes não informados.')}
           <p><strong>Principais pontos:</strong></p><ul>${(minutes.principaisPontos || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('') || '<li>—</li>'}</ul>
           <p><strong>Decisões:</strong></p><ul>${(minutes.decisoes || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('') || '<li>—</li>'}</ul>
           ${tableHtml(['Encaminhamento', 'Responsável', 'Prazo'], (minutes.encaminhamentos || []).map((e) => [e.acao, e.responsavel, e.prazo]), 'Sem encaminhamentos.')}`
        : `<p><strong>Participantes:</strong> ${participantsList().map(escapeHtml).join('; ') || '[a confirmar]'}</p><p class="hint-text">A ata completa é gerada junto com a narrativa.</p>`
    }

    <h3>3. Etapas do Processo (5W2H)</h3>
    ${tableHtml(
      ['Etapa', 'O quê', 'Quem', 'Quando', 'Onde / Sistema', 'Por quê', 'Como', 'Quanto'],
      (S.report.steps5w2h || []).map((s) => [s.etapa, s.oQue, s.quem, s.quando, s.onde, s.porQue, s.como, s.quanto]),
      S.report.generatedBy && S.report.generatedBy.startsWith('Modelo local')
        ? 'O detalhamento 5W2H é gerado apenas com IA configurada.'
        : 'Gerado junto com a narrativa.'
    )}

    <h3>4. Matriz de Riscos e Controles (RCM)</h3>
    ${tableHtml(['Risco', 'Severidade', 'Controle', 'Tipo / Natureza / Freq.', 'Afirmação', 'Avaliação (TOD)', 'Recomendação', 'Origem / Validação'], rcm, 'Nenhum risco ou controle registrado.')}

    <h3>5. Evidências Solicitadas (PBC)</h3>
    ${tableHtml(
      ['Cód.', 'Evidência', 'Critérios / IPE', 'Responsável', 'Prazo', 'Formato', 'Status'],
      S.pbcList.map((p) => [p.code, p.title, p.detail, p.owner || '[a definir]', formatDueDate(p.dueDate) || '[a definir]', p.format, p.status]),
      'Nenhuma evidência solicitada.'
    )}

    <h3>6. Pontos em Aberto e Divergências</h3>
    ${tableHtml(
      ['Tipo', 'Descrição', 'Status'],
      S.openPoints.map((o) => [{ sem_resposta: 'Sem resposta', contradicao: 'Contradição', pendencia: 'Pendência' }[o.kind] || o.kind, o.text, o.status]),
      'Nenhum ponto em aberto.'
    )}
    ${S.divergences.length ? tableHtml(['Documentado', 'Relatado', 'Impacto', 'Validação'], S.divergences.map((d) => [d.documented, d.stated, d.impact, d.validated ? 'Validado' : 'Não validado']), '') : ''}

    <h3>7. Perguntas Realizadas</h3>
    ${tableHtml(
      ['Horário', 'Assunto', 'Pergunta', 'Origem'],
      S.questions.filter((q) => q.asked).map((q) => [q.askedAt || '', q.topicTitle, q.text, (ORIGIN_LABELS[q.origin] || {}).label || q.origin]),
      'Nenhuma pergunta marcada como feita.'
    )}
    <p class="hint-text">${S.questions.filter((q) => !q.asked).length} pergunta(s) do teleprompter não foram marcadas como feitas.</p>

    <h3>8. Momentos Marcados</h3>
    ${tableHtml(['Horário', 'Anotação do auditor', 'Trecho'], S.moments.map((m) => [m.time, m.note, m.excerpt]), 'Nenhum momento marcado.')}

    ${
      includeTranscript
        ? `<h3>Anexo — Transcrição Literal</h3>${tableHtml(['ID', 'Horário', 'Quem', 'Fala'], S.transcript.map((t) => [`T${t.seq}`, t.time, t.speaker, t.text]), 'Sem transcrição.')}`
        : ''
    }`;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('falha ao carregar biblioteca'));
    document.head.appendChild(s);
  });
}

async function exportXlsx() {
  if (serverStatus.online) {
    return downloadOfficeExport('audit_xlsx', `Pacote_Auditoria_PBC_RCM_${sanitizeFileName(S.topic)}_${dateStamp()}.xlsx`);
  }
  try {
    if (!window.XLSX) await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
  } catch (_) {
    showToast('Sem acesso à biblioteca de Excel (internet/proxy). Baixando CSV no lugar.', 5000);
    exportRcmToCsv();
    return;
  }
  const XLSX = window.XLSX;
  const wb = XLSX.utils.book_new();
  const addSheet = (name, rows, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(rows);
    if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };

  addSheet(
    'Resumo',
    [
      ['Papel de Trabalho — Walkthrough de Auditoria Interna'],
      ['Processo', S.topic],
      ['Escopo / Sistemas', S.scope],
      ['Metodologia', METHODOLOGY_LABELS[S.methodology] || S.methodology],
      ['Data da sessão', formatDateBr(S.createdAt)],
      ['Participantes', participantsList().join('; ')],
      ['Consentimento', S.consent ? `${formatDateBr(S.consent.at)} — ${S.consent.mode}` : 'Sem captura de áudio'],
      ['Riscos', S.risks.length],
      ['Controles', S.controls.length],
      ['Evidências PBC', S.pbcList.length],
      ['Pontos em aberto', S.openPoints.filter((o) => o.status === 'aberto').length],
      [],
      ['Narrativa', S.report.narrative || '(não gerada)']
    ],
    [22, 100]
  );
  addSheet(
    'RCM',
    [
      ['Cód. Risco', 'Risco', 'Severidade', 'Descrição', 'Cód. Controle', 'Controle', 'Tipo', 'Natureza', 'Frequência', 'Responsável', 'Afirmação', 'Avaliação TOD', 'Recomendação', 'Origem risco', 'Origem controle'],
      ...rcmRows().map(({ r, c }) => [
        r ? r.code : '',
        r ? r.title : '',
        r ? r.severity : '',
        r ? r.description : '',
        c ? c.code : 'SEM CONTROLE',
        c ? c.name : '',
        c ? c.type : '',
        c ? c.nature : '',
        c ? c.frequency : '',
        c ? c.owner : '',
        (c && c.assertion) || (r && r.assertion) || '',
        c ? c.status : '',
        r ? r.recommendation : '',
        validationLabel(r),
        validationLabel(c)
      ])
    ],
    [9, 40, 10, 50, 11, 40, 11, 11, 13, 18, 18, 22, 50, 18, 18]
  );
  addSheet(
    'PBC',
    [
      ['Cód.', 'Evidência', 'Critérios / IPE', 'Responsável', 'Prazo', 'Formato', 'Status', 'Origem'],
      ...S.pbcList.map((p) => [p.code, p.title, p.detail, p.owner, formatDueDate(p.dueDate), p.format, p.status, p.source])
    ],
    [7, 45, 60, 20, 12, 28, 14, 12]
  );
  addSheet(
    'Pontos em aberto',
    [['Tipo', 'Descrição', 'Status', 'Origem', 'Fontes'], ...S.openPoints.map((o) => [o.kind, o.text, o.status, o.source, (o.sourceIds || []).join(', ')])],
    [14, 80, 12, 10, 14]
  );
  addSheet(
    'Divergências',
    [['Documentado', 'Relatado', 'Impacto', 'Validado', 'Fontes'], ...S.divergences.map((d) => [d.documented, d.stated, d.impact, d.validated ? 'Sim' : 'Não', (d.sourceIds || []).join(', ')])],
    [50, 50, 40, 10, 14]
  );
  addSheet(
    '5W2H',
    [['Etapa', 'O quê', 'Quem', 'Quando', 'Onde', 'Por quê', 'Como', 'Quanto'], ...(S.report.steps5w2h || []).map((s) => [s.etapa, s.oQue, s.quem, s.quando, s.onde, s.porQue, s.como, s.quanto])],
    [24, 36, 20, 18, 20, 30, 36, 16]
  );
  addSheet(
    'Perguntas',
    [['Status', 'Horário', 'Origem', 'Categoria', 'Assunto', 'Pergunta', 'Tela / evidência', 'IPE'], ...S.questions.map((q) => [q.asked ? 'Feita' : 'Pendente', q.askedAt || q.time || '', q.origin, q.category, q.topicTitle, q.text, q.screenScript, q.ipeTip])],
    [10, 10, 10, 24, 36, 70, 60, 50]
  );
  addSheet('Momentos', [['Horário', 'Anotação', 'Trecho', 'Fontes'], ...S.moments.map((m) => [m.time, m.note, m.excerpt, m.transcriptIds.join(', ')])], [10, 50, 90, 14]);
  addSheet('Transcrição', [['ID', 'Horário', 'Quem', 'Origem', 'Fala'], ...S.transcript.map((t) => [`T${t.seq}`, t.time, t.speaker, SOURCE_LABELS[t.source] || t.source, t.text])], [7, 10, 12, 16, 120]);

  XLSX.writeFile(wb, `Papel_de_Trabalho_${sanitizeFileName(S.topic)}_${dateStamp()}.xlsx`);
  showToast('Planilha Excel exportada.');
}

function exportRcmToCsv() {
  const rows = [
    ['Processo', 'Cód. Risco', 'Risco', 'Severidade', 'Descrição', 'Cód. Controle', 'Controle', 'Tipo', 'Natureza', 'Frequência', 'Responsável', 'Afirmação', 'Avaliação TOD', 'Recomendação', 'Origem / Validação']
  ];
  rcmRows().forEach(({ r, c }) =>
    rows.push([
      S.topic,
      r ? r.code : '',
      r ? r.title : '',
      r ? r.severity : '',
      r ? r.description : '',
      c ? c.code : 'SEM CONTROLE',
      c ? c.name : '',
      c ? c.type : '',
      c ? c.nature : '',
      c ? c.frequency : '',
      c ? c.owner : '',
      (c && c.assertion) || (r && r.assertion) || '',
      c ? c.status : '',
      r ? r.recommendation : '',
      [validationLabel(r), validationLabel(c)].filter(Boolean).join(' | ')
    ])
  );
  const csv = '﻿' + rows.map((row) => row.map((cell) => `"${String(cell == null ? '' : cell).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  downloadFile(csv, `Matriz_RCM_${sanitizeFileName(S.topic)}_${dateStamp()}.csv`, 'text/csv;charset=utf-8;');
  showToast('Matriz RCM exportada em CSV.');
}

function exportReportToMarkdown() {
  const m = S.report.minutes;
  const lines = [
    '# Papel de Trabalho: Walkthrough de Auditoria Interna',
    `**Processo:** ${S.topic}  `,
    `**Escopo / Sistemas:** ${S.scope || '[a confirmar]'}  `,
    `**Metodologia:** ${METHODOLOGY_LABELS[S.methodology] || S.methodology}  `,
    `**Data da sessão:** ${formatDateBr(S.createdAt)}  `,
    `**Participantes:** ${participantsList().join('; ') || '[a confirmar]'}  `,
    `**Transparência / LGPD:** ${S.consent ? `participantes informados em ${formatDateBr(S.consent.at)} (modo ${S.consent.mode})` : 'sem captura de áudio'}`,
    '',
    '## 1. Narrativa do Walkthrough',
    S.report.narrative ? `> Gerado por ${S.report.generatedBy} — revisar antes de assinar.\n\n${S.report.narrative}` : '_Não gerada._',
    '',
    '## 2. Ata da Reunião',
    ...(m
      ? [
          `**Objetivo:** ${m.objetivo}`,
          '',
          '**Participantes:**',
          ...(m.participantes || []).map((p) => `- ${p.nome} — ${p.papel}`),
          '',
          '**Principais pontos:**',
          ...(m.principaisPontos || []).map((x) => `- ${x}`),
          '',
          '**Decisões:**',
          ...((m.decisoes || []).length ? m.decisoes.map((x) => `- ${x}`) : ['- —']),
          '',
          '**Encaminhamentos:**',
          ...((m.encaminhamentos || []).length ? m.encaminhamentos.map((e) => `- [ ] ${e.acao} — ${e.responsavel} — ${e.prazo}`) : ['- —'])
        ]
      : ['_Não gerada._']),
    '',
    '## 3. Etapas do Processo (5W2H)',
    ...((S.report.steps5w2h || []).length
      ? [
          '| Etapa | O quê | Quem | Quando | Onde | Por quê | Como | Quanto |',
          '|---|---|---|---|---|---|---|---|',
          ...S.report.steps5w2h.map((s) => `| ${[s.etapa, s.oQue, s.quem, s.quando, s.onde, s.porQue, s.como, s.quanto].map((x) => String(x || '').replace(/\|/g, '/')).join(' | ')} |`)
        ]
      : ['_Não gerado._']),
    '',
    '## 4. Riscos e Gaps',
    ...S.risks.map((r) => {
      const ctrls = S.controls.filter((c) => c.riskIds.includes(r.id)).map((c) => c.code);
      return `- **${r.code} [${r.severity}] ${r.title}** — ${r.description} _Recomendação: ${r.recommendation}_ · Controles: ${ctrls.join(', ') || 'NENHUM (gap)'} · ${validationLabel(r)}`;
    }),
    '',
    '## 5. Controles',
    ...S.controls.map(
      (c) => `- **${c.code} ${c.name}** | ${c.type} | ${c.nature} | ${c.frequency} | Resp.: ${c.owner || '—'} | TOD: ${c.status} | Mitiga: ${S.risks.filter((r) => c.riskIds.includes(r.id)).map((r) => r.code).join(', ') || '—'} | ${validationLabel(c)}`
    ),
    '',
    '## 6. Evidências Solicitadas (PBC)',
    ...S.pbcList.map((p) => `- [ ] **${p.code} ${p.title}** — ${p.detail} · Resp.: ${p.owner || 'a definir'} · Prazo: ${formatDueDate(p.dueDate) || 'a definir'} · Formato: ${p.format || '—'} · _${p.status}_`),
    '',
    '## 7. Pontos em Aberto',
    ...S.openPoints.map((o) => `- [${o.status === 'aberto' ? ' ' : 'x'}] (${o.kind}) ${o.text}`),
    ...(S.divergences.length ? ['', '## 8. Divergências (Documentado × Relatado)', ...S.divergences.map((d) => `- **Documentado:** ${d.documented} · **Relatado:** ${d.stated} · **Impacto:** ${d.impact}`)] : []),
    '',
    '## Momentos Marcados',
    ...S.moments.map((mo) => `- **${mo.time}** ${mo.note || ''}\n  > ${mo.excerpt.replace(/\n/g, '\n  > ')}`),
    '',
    '## Anexo — Transcrição Literal',
    ...S.transcript.map((t) => `- **T${t.seq} [${t.time}] ${t.speaker}:** ${t.text}`)
  ];
  downloadFile(lines.join('\n'), `Walkthrough_${sanitizeFileName(S.topic)}_${dateStamp()}.md`, 'text/markdown;charset=utf-8;');
  showToast('Papel de trabalho exportado em Markdown.');
}

function pbcItemsForRequest() {
  const items = S.pbcList.filter((p) => p.status === 'Pendente' || p.status === 'Solicitado');
  return items.length ? items : S.pbcList;
}

function buildPbcEmailText() {
  const items = pbcItemsForRequest();
  return [
    `Prezados,`,
    '',
    `Conforme alinhado na reunião de walkthrough do processo "${S.topic}", solicitamos o envio das evidências abaixo:`,
    '',
    ...items.map(
      (p, i) =>
        `${i + 1}. [${p.code}] ${p.title}\n   Critérios: ${p.detail || '—'}\n   Responsável: ${p.owner || 'a definir'} | Prazo: ${formatDueDate(p.dueDate) || 'a definir'}${p.format ? ` | Formato: ${p.format}` : ''}`
    ),
    '',
    'Para relatórios extraídos de sistema, pedimos que a evidência mostre os filtros/parâmetros aplicados, o código da transação ou tela, o usuário e a data/hora da extração (requisitos de IPE).',
    '',
    'Ficamos à disposição para esclarecer qualquer ponto.',
    '',
    'Atenciosamente,'
  ].join('\n');
}

async function openPbcEmail() {
  if (S.pbcList.length === 0) {
    showToast('A lista PBC está vazia.');
    return;
  }
  const text = buildPbcEmailText();
  const subject = `Solicitação de evidências — Auditoria Interna — ${S.topic}`;
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.slice(0, 1800))}`;
  const values = await openForm({
    title: 'E-mail de solicitação de evidências (PBC)',
    subtitle: 'Revise o texto, copie ou abra no seu programa de e-mail.',
    html: `<p class="hint-text"><a href="${escapeAttr(mailto)}" target="_blank" rel="noopener">Abrir no programa de e-mail</a> (textos longos podem ser cortados — prefira copiar).</p>`,
    fields: [
      { name: 'subject', label: 'Assunto', value: subject },
      { name: 'body', label: 'Mensagem', type: 'textarea', rows: 14, value: text }
    ],
    submitLabel: 'Copiar texto',
    cancelLabel: 'Fechar'
  });
  if (values) {
    copyToClipboard(`${values.subject}\n\n${values.body}`, 'E-mail copiado. Cole no Outlook/Gmail.');
    S.pbcList.forEach((p) => {
      if (p.status === 'Pendente') p.status = 'Solicitado';
    });
    commit();
  }
}

function copyPbcForTeamsChat() {
  const items = pbcItemsForRequest();
  if (!items.length) {
    showToast('A lista PBC está vazia.');
    return;
  }
  const text =
    `*Evidências solicitadas — Auditoria Interna (${S.topic}):*\n\n` +
    items.map((p, i) => `${i + 1}. *${p.code} ${p.title}* — ${p.detail}${p.dueDate ? ` (prazo ${formatDueDate(p.dueDate)})` : ''}`).join('\n') +
    `\n\n_Por gentileza, enviar mostrando filtros/parâmetros, código da transação e data/hora da extração (IPE)._`;
  copyToClipboard(text, 'Lista PBC copiada para colar no chat.');
}

// ============================================================================
// EVENTOS
// ============================================================================

// ============================================================================
// METODOLOGIA DE CARTA DE SOLICITAÇÃO PBC / RFI & EXPORTAÇÕES OFFICE (.DOCX/.XLSX)
// ============================================================================
const PBC_CATEGORIES = [
  '1. Governança, Políticas e Normativos',
  '2. População / Base Analítica (Universo)',
  '3. Walkthrough / Teste de Desenho (TOD)',
  '4. Acessos, Perfis e Segregação (ITGC / SoD)',
  '5. Conciliações, Relatórios e Monitoramento'
];

function inferPbcCategory(title, detail) {
  const txt = norm(`${title} ${detail}`);
  if (/(politic|norma|procedimento|manual|fluxograma|alcad|regimento)/.test(txt)) return PBC_CATEGORIES[0];
  if (/(acesso|perfil|usuario|sod|segregac|desligad|login|suim|active directory)/.test(txt)) return PBC_CATEGORIES[3];
  if (/(conciliac|fechamento|balancete|razao|monitoramento|indicador|excecao)/.test(txt)) return PBC_CATEGORIES[4];
  if (/(base|populac|listagem completa|relatorio de todos|universo|extracao)/.test(txt)) return PBC_CATEGORIES[1];
  return PBC_CATEGORIES[2];
}

function addBusinessDaysStr(days = 5) {
  const d = new Date();
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) added += 1;
  }
  return d.toLocaleDateString('pt-BR');
}

function defaultPbcIntro(topic, recipient) {
  return (
    `Prezado(a) ${recipient || 'Gestor(a) / Ponto Focal'},\n\n` +
    `Em continuidade aos trabalhos de Auditoria Interna referentes ao processo "${topic}", e em alinhamento às Normas Globais de Auditoria Interna (IIA), diretrizes de controles internos (COSO ICIF) e critérios de confiabilidade de evidências (IPE — Information Produced by the Entity), relacionamos abaixo os documentos, bases de dados e evidências operacionais necessários para a conclusão do Walkthrough (Test of Design — TOD) e execução dos testes de auditoria.`
  );
}

function ensurePbcMeta() {
  if (!S.pbcMeta || typeof S.pbcMeta !== 'object') {
    const firstParticipant = participantsList()[0] || '';
    const refSeq = new Date().toISOString().slice(0, 7).replace('-', '');
    S.pbcMeta = {
      refCode: `RFI-AUD-${refSeq}-01`,
      auditPhase: 'Walkthrough & Teste de Desenho (TOD)',
      recipient: firstParticipant || 'Gestão da Área Auditada',
      auditorName: 'Auditoria Interna & Controles Internos',
      populationPeriod: 'Últimos 12 meses (ou período-base vigente)',
      slaDate: `${addBusinessDaysStr(5)} (5 dias úteis)`,
      deliveryChannel: 'Pasta Segura da Auditoria no SharePoint / Portal GRC',
      introText: defaultPbcIntro(S.topic, firstParticipant || 'Gestor(a)'),
      issueDate: new Date().toLocaleDateString('pt-BR')
    };
  }
  return S.pbcMeta;
}

function syncPbcMetaInputsFromState() {
  const m = ensurePbcMeta();
  if (!$('pbcRefInput')) return;
  $('pbcRefInput').value = m.refCode || '';
  $('pbcPhaseSelect').value = m.auditPhase || 'Walkthrough & Teste de Desenho (TOD)';
  $('pbcRecipientInput').value = m.recipient || '';
  $('pbcAuditorInput').value = m.auditorName || '';
  $('pbcPeriodInput').value = m.populationPeriod || '';
  $('pbcSlaInput').value = m.slaDate || '';
  $('pbcChannelInput').value = m.deliveryChannel || '';
  $('pbcIntroTextarea').value = m.introText || defaultPbcIntro(S.topic, m.recipient);
}

function readPbcMetaFromInputs() {
  const m = ensurePbcMeta();
  if (!$('pbcRefInput')) return m;
  m.refCode = $('pbcRefInput').value.trim() || m.refCode;
  m.auditPhase = $('pbcPhaseSelect').value;
  m.recipient = $('pbcRecipientInput').value.trim();
  m.auditorName = $('pbcAuditorInput').value.trim();
  m.populationPeriod = $('pbcPeriodInput').value.trim();
  m.slaDate = $('pbcSlaInput').value.trim();
  m.deliveryChannel = $('pbcChannelInput').value.trim();
  m.introText = $('pbcIntroTextarea').value.trim();
  m.issueDate = m.issueDate || new Date().toLocaleDateString('pt-BR');
  scheduleSave();
  return m;
}

function importMeetingSuggestionsToPbc({ silent = false } = {}) {
  ensurePbcMeta();
  let added = 0;

  // 1. Garante itens estruturais de metodologia caso a lista esteja vazia
  const baseline = [
    {
      category: PBC_CATEGORIES[0],
      priority: 'Alta',
      title: `Política, Norma ou Procedimento Operacional Vigente — ${S.topic}`,
      purpose: 'Confirmar diretrizes formais, alçadas documentadas, papéis e responsabilidades para confronto com a prática (Walkthrough).',
      detail: 'Enviar a versão vigente aprovada (com histórico de revisão/vigência), incluindo tabela formal de alçadas e fluxograma se existente.',
      format: 'PDF oficial / Normativo vigente',
      source: 'Metodologia IIA'
    }
  ];

  if (S.pbcList.length === 0) {
    baseline.forEach((b) => {
      if (addPbc(b, { notify: false })) added += 1;
    });
  }

  // 2. Importa pedidos de tela/evidência vinculados às perguntas da reunião
  S.questions.forEach((q) => {
    if (!q.screenTitle && !q.screenScript) return;
    const title = q.screenTitle || `Evidência de ${q.topicTitle || q.category}`;
    if (S.pbcList.some((p) => norm(p.title) === norm(title))) return;
    const res = addPbc(
      {
        category: inferPbcCategory(title, `${q.ipeTip || ''} ${q.category || ''}`),
        priority: q.priority === 'critica' ? 'Crítica' : q.priority === 'alta' ? 'Alta' : 'Média',
        title,
        purpose: q.rationale || 'Comprovar o desenho e funcionamento do controle relatado no walkthrough (TOD).',
        detail: [q.screenScript, q.ipeTip].filter(Boolean).join(' — '),
        format: /(relatorio|base|lista|extracao)/i.test(title)
          ? 'Base bruta original (.xlsx/.csv) + Print de filtros'
          : 'Print integral de tela com data/hora e T-Code',
        owner: S.pbcMeta.recipient || '',
        questionId: q.id,
        source: q.origin === 'ia' ? 'Reunião (IA)' : 'Walkthrough'
      },
      { notify: false }
    );
    if (res) added += 1;
  });

  // 3. Importa screenRequests avulsos
  S.screenRequests.forEach((sr) => {
    if (!sr.title || S.pbcList.some((p) => norm(p.title) === norm(sr.title))) return;
    const res = addPbc(
      {
        category: inferPbcCategory(sr.title, sr.ipeTip || ''),
        priority: 'Alta',
        title: sr.title,
        purpose: 'Evidenciar o funcionamento prático da etapa demonstrada / solicitada em reunião (TOD).',
        detail: [sr.script, sr.ipeTip].filter(Boolean).join(' — '),
        format: 'Print integral de tela com data/hora e T-Code',
        owner: S.pbcMeta.recipient || '',
        source: 'Walkthrough'
      },
      { notify: false }
    );
    if (res) added += 1;
  });

  commit();
  renderPbcLetterPreview();
  if (!silent) {
    showToast(added ? `${added} documento(s)/evidência(s) consolidados na Carta PBC.` : 'Todos os itens sugeridos já constam na Carta PBC.');
  }
  return added;
}

const PBC_LETTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['textoAbertura', 'itensPbc'],
  properties: {
    textoAbertura: { type: 'string' },
    itensPbc: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['categoria', 'prioridade', 'titulo', 'objetivoTeste', 'criteriosExtracaoIpe', 'formatoAceito'],
        properties: {
          categoria: { type: 'string', enum: PBC_CATEGORIES },
          prioridade: { type: 'string', enum: ['Crítica', 'Alta', 'Média', 'Complementar'] },
          titulo: { type: 'string' },
          objetivoTeste: { type: 'string' },
          criteriosExtracaoIpe: { type: 'string' },
          formatoAceito: { type: 'string' }
        }
      }
    }
  }
};

const PBC_LETTER_SYSTEM_PROMPT = `Você é um Gerente Sênior de Auditoria Interna e Controles Internos (CIA, CISA, SOX/PCAOB, COSO ICIF, Normas Globais do IIA).
Sua tarefa é elaborar uma CARTA FORMAL DE SOLICITAÇÃO DE DOCUMENTOS, BASES E EVIDÊNCIAS (PBC / RFI — Request for Information) impecável e sob medida com base na reunião de walkthrough realizada.

Diretrizes Metodológicas Obrigatórias:
1. Analise atentamente a transcrição da reunião, os sistemas citados (ex.: SAP, TOTVS, Oracle, portais, planilhas), as limitações mencionadas pelo auditado, os riscos/gaps e os pontos em aberto.
2. Estruture entre 6 e 12 itens concretos e cirúrgicos em "itensPbc", cobrindo de forma equilibrada as 5 categorias de Auditoria Interna:
   - "1. Governança, Políticas e Normativos" (políticas vigentes, matriz de alçadas documentada, fluxos);
   - "2. População / Base Analítica (Universo)" (bases completas de transações do período para Data Analytics e seleção de amostras, respeitando o que o sistema da empresa permite extrair);
   - "3. Walkthrough / Teste de Desenho (TOD)" (1 amostra real fim-a-fim com requisição, cotação, aprovação com log data/hora, NF e liquidação);
   - "4. Acessos, Perfis e Segregação (ITGC / SoD)" (extração de usuários com perfis críticos de aprovação/cadastro);
   - "5. Conciliações, Relatórios e Monitoramento" (controles detectivos, relatórios de exceção ou planilhas citadas na conversa).
3. Em "criteriosExtracaoIpe", especifique com rigor técnico de IPE (Information Produced by the Entity): quais campos mínimos devem constar, necessidade do print de parâmetros/filtros aplicados antes da extração, código da transação (ex.: T-Code SAP quando pertinente), data/hora e preservação da base bruta sem exclusão manual de linhas.
4. Em "textoAbertura", redija 2 parágrafos executivos, cordiais e técnicos contextualizando a solicitação conforme o que foi discutido na reunião.
5. Não duplique itens que já estejam idênticos na lista PBC atual; complemente e aprimore.`;

async function generateAiPbcLetter() {
  readPbcMetaFromInputs();
  const provider = analysisProvider();
  const btn = $('btnGenerateAiPbc');
  btn.disabled = true;
  const origLabel = btn.textContent;
  btn.textContent = 'Consolidando Carta PBC...';

  try {
    if (provider === 'local') {
      importMeetingSuggestionsToPbc({ silent: true });
      showToast('Carta PBC consolidada com os itens mapeados na reunião (modo local).');
      return;
    }

    showToast(`Estruturando Carta Formal PBC / RFI com ${provider === 'claude' ? 'Claude' : 'Gemini'}...`, 5000);
    const prompt = [
      `PROCESSO AUDITADO: ${S.topic}`,
      `ESCOPO / SISTEMAS: ${S.scope || '[a confirmar]'}`,
      `FASE: ${S.pbcMeta.auditPhase}`,
      `DESTINATÁRIO: ${S.pbcMeta.recipient || 'Gestor(a) da Área'}`,
      `PERÍODO-BASE: ${S.pbcMeta.populationPeriod}`,
      '',
      'ITENS JÁ NA LISTA PBC:',
      S.pbcList.map((p) => `- [${p.code}] ${p.title}`).join('\n') || '(nenhum ainda)',
      '',
      'RISCOS E GAPS IDENTIFICADOS NA REUNIÃO:',
      S.risks.map((r) => `- ${r.code} [${r.severity}] ${r.title}: ${r.description}`).join('\n') || '(nenhum)',
      '',
      'ASSUNTOS E TELAS MAPEADOS NA REUNIÃO:',
      S.questions.map((q) => `- ${q.topicTitle}: ${q.topicSummary || q.text} (Tela: ${q.screenTitle || '—'})`).join('\n') || '(nenhum)',
      '',
      'PONTOS EM ABERTO:',
      S.openPoints.map((o) => `- ${o.text}`).join('\n') || '(nenhum)',
      '',
      'TRANSCRIÇÃO DA REUNIÃO:',
      S.transcript.slice(-60).map(formatTranscriptLine).join('\n') || '(sem transcrição literal)'
    ].join('\n');

    const result = await aiJson({
      provider,
      systemBlocks: [PBC_LETTER_SYSTEM_PROMPT],
      prompt,
      schema: PBC_LETTER_SCHEMA,
      model: settings.reportModel,
      effort: 'high'
    });

    if (result.textoAbertura) {
      S.pbcMeta.introText = result.textoAbertura;
      $('pbcIntroTextarea').value = result.textoAbertura;
    }

    let added = 0;
    (result.itensPbc || []).forEach((it) => {
      const created = addPbc(
        {
          category: it.categoria,
          priority: it.prioridade,
          title: it.titulo,
          purpose: it.objetivoTeste,
          detail: it.criteriosExtracaoIpe,
          format: it.formatoAceito,
          owner: S.pbcMeta.recipient || '',
          source: 'IA (Metodologia IIA)'
        },
        { notify: false }
      );
      if (created) added += 1;
    });

    // Ordena por categoria metodológica para apresentação impecável na carta
    S.pbcList.sort((a, b) => String(a.category || '').localeCompare(String(b.category || '')));
    S.pbcList.forEach((p, idx) => {
      p.code = `P${String(idx + 1).padStart(2, '0')}`;
    });

    commit();
    renderPbcLetterPreview();
    showToast(`Carta PBC estruturada com sucesso (${added} novos itens adicionados).`);
  } catch (err) {
    console.error(err);
    importMeetingSuggestionsToPbc({ silent: true });
    showToast(`IA indisponível (${err.message}) — itens da reunião importados localmente.`, 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = origLabel;
  }
}

function buildExportPayload() {
  const m = readPbcMetaFromInputs();
  const coveredCount = S.checklist.filter((c) => c.covered).length;
  const includeTranscript = $('chkIncludeTranscript') ? $('chkIncludeTranscript').checked : true;

  const pbcItems = S.pbcList.map((p, i) => ({
    id: p.id,
    code: p.code || `P${String(i + 1).padStart(2, '0')}`,
    category: p.category || inferPbcCategory(p.title, p.detail),
    priority: p.priority || 'Alta',
    title: p.title || '',
    purpose: p.purpose || 'Validação de desenho de controle interno (Walkthrough / TOD).',
    detail: p.detail || '',
    format: p.format || 'Original (.xlsx / .pdf / Print integral)',
    owner: p.owner || m.recipient || 'A definir',
    dueDateFormatted: formatDueDate(p.dueDate) || m.slaDate || 'A definir',
    status: p.status || 'Pendente',
    source: p.source || 'Auditoria'
  }));

  const rcm = rcmRows().map(({ r, c }) => ({
    riskCode: r ? r.code : '—',
    riskTitle: r ? r.title : '(Controle sem risco vinculado)',
    riskLabel: r ? `${r.code} — ${r.title}` : '(Sem risco vinculado)',
    severity: r ? r.severity : '—',
    riskDesc: r ? r.description : '—',
    controlCode: c ? c.code : 'SEM CONTROLE',
    controlName: c ? c.name : 'Lacuna de controle (Gap)',
    controlLabel: c ? `${c.code} — ${c.name}` : 'SEM CONTROLE MITIGANTE',
    controlType: c ? c.type : '—',
    controlNature: c ? c.nature : '—',
    controlFreq: c ? c.frequency : '—',
    controlClass: c ? `${c.type} / ${c.nature} / ${c.frequency}` : '—',
    assertion: (c && c.assertion) || (r && r.assertion) || '—',
    todStatus: c ? c.status : 'Gap de Desenho',
    recommendation: r ? r.recommendation : '—'
  }));

  return {
    topic: S.topic,
    scope: S.scope,
    methodologyLabel: METHODOLOGY_LABELS[S.methodology] || S.methodology,
    createdAtFormatted: formatDateBr(S.createdAt),
    coveredCount,
    totalChecklist: S.checklist.length,
    participantsList: participantsList(),
    coachingTip: S.coachingTip,
    narrative: S.report.narrative || '',
    minutes: S.report.minutes || null,
    steps5w2h: S.report.steps5w2h || [],
    pbcMeta: m,
    pbcItems,
    rcmRows: rcm,
    risks: S.risks,
    controls: S.controls,
    openPoints: S.openPoints,
    divergences: S.divergences,
    questions: S.questions,
    includeTranscript,
    transcript: includeTranscript ? S.transcript : []
  };
}

async function downloadOfficeExport(mode, filename) {
  if ((mode === 'pbc_docx' || mode === 'audit_xlsx') && S.pbcList.length === 0) {
    importMeetingSuggestionsToPbc({ silent: true });
  }
  const payload = buildExportPayload();
  showToast('Gerando documento corporativo formatado...');
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AuditPrompter': '1' },
      body: JSON.stringify({ mode, data: payload })
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(txt || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(`Arquivo gerado com sucesso: ${filename}`);
  } catch (err) {
    console.error('Erro na exportação Office:', err);
    showToast(`Falha ao exportar arquivo Office: ${err.message}`, 6000);
  }
}

function renderPbcLetterPreview() {
  const container = $('pbcLetterPreviewContainer');
  if (!container) return;
  const m = ensurePbcMeta();
  const payload = buildExportPayload();
  const items = payload.pbcItems;
  const openPts = S.openPoints.filter((o) => o.status === 'aberto');

  const prioClass = (pr) => {
    const l = norm(pr);
    if (l.includes('crit')) return 'prio-critica';
    if (l.includes('alta')) return 'prio-alta';
    if (l.includes('med')) return 'prio-media';
    return 'prio-normal';
  };

  container.innerHTML = `
    <div class="doc-banner">
      <div>
        <div class="doc-banner-sub">Auditoria Interna &amp; Controles Internos • Requisição Formal (PBC / RFI)</div>
        <div class="doc-banner-title">Carta de Solicitação de Documentos, Bases e Evidências</div>
      </div>
      <div class="doc-banner-ref">
        <div><strong>REF: ${escapeHtml(m.refCode)}</strong></div>
        <div>EMISSÃO: ${escapeHtml(m.issueDate || new Date().toLocaleDateString('pt-BR'))}</div>
      </div>
    </div>

    <table class="doc-meta-table">
      <tr>
        <td class="meta-lbl">Processo Auditado</td>
        <td class="meta-val"><strong>${escapeHtml(S.topic)}</strong></td>
        <td class="meta-lbl">Fase Metodológica</td>
        <td class="meta-val">${escapeHtml(m.auditPhase)}</td>
      </tr>
      <tr>
        <td class="meta-lbl">Área / Sistemas</td>
        <td class="meta-val">${escapeHtml(S.scope || '—')}</td>
        <td class="meta-lbl">Período-Base (Corte)</td>
        <td class="meta-val">${escapeHtml(m.populationPeriod || '—')}</td>
      </tr>
      <tr>
        <td class="meta-lbl">Destinatário / Área</td>
        <td class="meta-val">${escapeHtml(m.recipient || '[Definir Ponto Focal]')}</td>
        <td class="meta-lbl">Prazo Limite (SLA)</td>
        <td class="meta-val"><strong>${escapeHtml(m.slaDate || '[Definir Prazo]')}</strong></td>
      </tr>
      <tr>
        <td class="meta-lbl">Equipe de Auditoria</td>
        <td class="meta-val">${escapeHtml(m.auditorName || 'Auditoria Interna')}</td>
        <td class="meta-lbl">Canal Seguro (LGPD)</td>
        <td class="meta-val">${escapeHtml(m.deliveryChannel || 'Pasta Segura / Portal')}</td>
      </tr>
    </table>

    <h3>1. Contextualização, Objetivo e Escopo Metodológico</h3>
    <p>${escapeHtml(m.introText || defaultPbcIntro(S.topic, m.recipient)).replace(/\n/g, '<br>')}</p>

    <h3>2. Relação Estruturada de Documentos, Bases e Evidências Requeridas (${items.length} itens)</h3>
    ${
      items.length === 0
        ? `<div class="empty-state">Nenhum item consolidado na Carta PBC ainda. Clique em <strong>"Consolidar / Enriquecer Carta PBC com IA"</strong> ou <strong>"Importar Sugestões da Reunião"</strong> acima para preencher automaticamente com base na conversa.</div>`
        : `
      <table class="rcm-table">
        <thead>
          <tr>
            <th style="width:6%">Cód.</th>
            <th style="width:14%">Categoria</th>
            <th style="width:8%">Prioridade</th>
            <th style="width:20%">Documento / Base / Evidência</th>
            <th style="width:17%">Objetivo do Teste / Risco</th>
            <th style="width:21%">Critérios de Extração &amp; IPE</th>
            <th style="width:9%">Formato / Prazo</th>
            <th class="no-print" style="width:5%">Ações</th>
          </tr>
        </thead>
        <tbody>
          ${items
            .map(
              (it) => `
            <tr>
              <td><strong>${escapeHtml(it.code)}</strong></td>
              <td>${escapeHtml(it.category)}</td>
              <td><span class="prio-pill ${prioClass(it.priority)}">${escapeHtml(it.priority)}</span></td>
              <td><strong>${escapeHtml(it.title)}</strong></td>
              <td>${escapeHtml(it.purpose)}</td>
              <td>${escapeHtml(it.detail)}</td>
              <td>${escapeHtml(it.format)}<br><span class="hint-text">SLA: ${escapeHtml(it.dueDateFormatted)}</span></td>
              <td class="no-print" style="white-space:nowrap;">
                <button class="btn-inline" data-letter-edit="${it.id}" title="Editar item">✎</button>
                <button class="btn-inline" data-letter-del="${it.id}" title="Remover item">✕</button>
              </td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>`
    }

    ${
      openPts.length
        ? `
      <h3>3. Esclarecimentos Complementares Pendentes do Walkthrough</h3>
      <p>Solicitamos adicionalmente a confirmação formal da área quanto aos pontos abaixo registrados durante a entrevista:</p>
      <ul>${openPts.map((o) => `<li>${escapeHtml(o.text)}</li>`).join('')}</ul>
    `
        : ''
    }

    <h3>${openPts.length ? '4' : '3'}. Protocolo Metodológico de Confiabilidade da Evidência — IPE (IIA / COSO / SOX)</h3>
    <div class="ipe-protocol-box">
      <div class="ipe-protocol-title">Padrão Obrigatório para Captura de Telas, Relatórios e Bases de Sistema</div>
      <ol class="ipe-protocol-list">
        <li><strong>Captura Integral e Ambiente Produtivo:</strong> Os prints de tela devem exibir a janela inteira, demonstrando o nome do sistema/ERP em Produção, código da transação (ex.: SAP T-Code), usuário logado e data/hora na barra do sistema operacional.</li>
        <li><strong>Evidência de Parâmetros e Filtros (Completude):</strong> Para relatórios ou bases extraídas do ERP/BI, anexar captura da tela de filtros aplicados antes da geração (empresa/CNPJ, período de corte inicial/final, centros de custo, status), comprovando que nenhum registro válido foi omitido.</li>
        <li><strong>Integridade de Bases em Excel / CSV (Exatidão):</strong> Disponibilizar o arquivo bruto original exportado pelo sistema sem exclusão manual de linhas (como estornos ou cancelamentos) ou colunas. Eventuais análises da área devem constar em aba separada mantendo a aba <code>Base_Original</code> intacta.</li>
        <li><strong>Totalizadores de Controle (Control Totals):</strong> Demonstrar a contagem total de linhas/registros e o somatório financeiro da base para cruzamento com o razão contábil ou painel oficial.</li>
        <li><strong>Amostra de Walkthrough Fim-a-Fim (TOD):</strong> Para comprovação de desenho de 1 transação real, enviar a trilha encadeada da mesma operação (solicitação &rarr; cotação &rarr; log de aprovação pela alçada com data/hora &rarr; nota fiscal &rarr; pagamento/contabilização).</li>
      </ol>
    </div>

    <h3>${openPts.length ? '5' : '4'}. Governança, Proteção de Dados (LGPD) e Rito de Entrega</h3>
    <p>
      • <strong>Nomenclatura e Canal Oficial:</strong> Identificar cada arquivo com o respectivo código da tabela (ex.: <code>P01_Politica.pdf</code>, <code>P02_Base_SAP.xlsx</code>) e disponibilizá-los exclusivamente em: <strong>${escapeHtml(m.deliveryChannel)}</strong>.<br>
      • <strong>LGPD e Sigilo:</strong> Evitar o envio de bases com dados pessoais sensíveis por canais não criptografados. Caso haja limitação sistêmica para extração de algum campo solicitado, favor sinalizar previamente à equipe de Auditoria Interna para alinhamento de procedimento alternativo.
    </p>
  `;
}

async function copyRichPbcEmail() {
  if (S.pbcList.length === 0) importMeetingSuggestionsToPbc({ silent: true });
  const m = readPbcMetaFromInputs();
  const payload = buildExportPayload();
  const items = payload.pbcItems;
  if (!items.length) {
    showToast('Adicione ou consolide os itens da Carta PBC primeiro.');
    return;
  }

  const subject = `[${m.refCode}] Solicitação de Documentos e Evidências (PBC) — Auditoria Interna: ${S.topic}`;
  const htmlMail = `
    <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;color:#0f172a;line-height:1.5;max-width:960px;">
      <div style="background:#0f172a;color:#ffffff;padding:14px 18px;border-radius:6px 6px 0 0;">
        <div style="font-size:10px;color:#93c5fd;font-weight:bold;letter-spacing:0.06em;text-transform:uppercase;">Auditoria Interna &amp; Controles Internos • ${escapeHtml(m.refCode)}</div>
        <div style="font-size:16px;font-weight:bold;margin-top:2px;">Solicitação Formal de Documentos, Bases e Evidências (PBC / RFI)</div>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px;border:1px solid #cbd5e1;">
        <tr>
          <td style="background:#f1f5f9;padding:6px 10px;border:1px solid #cbd5e1;font-weight:bold;width:18%;">Processo:</td>
          <td style="padding:6px 10px;border:1px solid #cbd5e1;width:32%;">${escapeHtml(S.topic)}</td>
          <td style="background:#f1f5f9;padding:6px 10px;border:1px solid #cbd5e1;font-weight:bold;width:18%;">Prazo (SLA):</td>
          <td style="padding:6px 10px;border:1px solid #cbd5e1;width:32%;font-weight:bold;color:#991b1b;">${escapeHtml(m.slaDate)}</td>
        </tr>
        <tr>
          <td style="background:#f1f5f9;padding:6px 10px;border:1px solid #cbd5e1;font-weight:bold;">Fase / Período:</td>
          <td style="padding:6px 10px;border:1px solid #cbd5e1;">${escapeHtml(m.auditPhase)} (${escapeHtml(m.populationPeriod)})</td>
          <td style="background:#f1f5f9;padding:6px 10px;border:1px solid #cbd5e1;font-weight:bold;">Canal de Entrega:</td>
          <td style="padding:6px 10px;border:1px solid #cbd5e1;">${escapeHtml(m.deliveryChannel)}</td>
        </tr>
      </table>
      <p>${escapeHtml(m.introText || defaultPbcIntro(S.topic, m.recipient)).replace(/\n/g, '<br>')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:12px;margin:14px 0;">
        <thead>
          <tr style="background:#0f172a;color:#ffffff;">
            <th style="padding:8px;border:1px solid #334155;text-align:left;">Cód.</th>
            <th style="padding:8px;border:1px solid #334155;text-align:left;">Categoria</th>
            <th style="padding:8px;border:1px solid #334155;text-align:left;">Prioridade</th>
            <th style="padding:8px;border:1px solid #334155;text-align:left;">Documento / Evidência Solicitada</th>
            <th style="padding:8px;border:1px solid #334155;text-align:left;">Critérios de Extração &amp; Requisitos de IPE</th>
            <th style="padding:8px;border:1px solid #334155;text-align:left;">Formato</th>
          </tr>
        </thead>
        <tbody>
          ${items
            .map(
              (it, i) => `
            <tr style="background:${i % 2 === 0 ? '#ffffff' : '#f8fafc'};">
              <td style="padding:7px;border:1px solid #cbd5e1;font-weight:bold;">${escapeHtml(it.code)}</td>
              <td style="padding:7px;border:1px solid #cbd5e1;">${escapeHtml(it.category)}</td>
              <td style="padding:7px;border:1px solid #cbd5e1;font-weight:bold;">${escapeHtml(it.priority)}</td>
              <td style="padding:7px;border:1px solid #cbd5e1;"><strong>${escapeHtml(it.title)}</strong><br><span style="color:#475569;font-size:11px;">Objetivo: ${escapeHtml(it.purpose)}</span></td>
              <td style="padding:7px;border:1px solid #cbd5e1;">${escapeHtml(it.detail)}</td>
              <td style="padding:7px;border:1px solid #cbd5e1;">${escapeHtml(it.format)}</td>
            </tr>`
            )
            .join('')}
        </tbody>
      </table>
      <div style="background:#eff6ff;border-left:4px solid #1e3a8a;padding:10px 14px;margin:14px 0;font-size:12px;">
        <strong style="color:#1e3a8a;">ORIENTAÇÕES OBRIGATÓRIAS DE EVIDÊNCIA SISTÊMICA (PROTOCOLO IPE):</strong><br>
        1. <strong>Prints Integrais:</strong> Exibir tela inteira com código da transação (ex.: T-Code SAP), ambiente produtivo, usuário e relógio (data/hora).<br>
        2. <strong>Parâmetros de Seleção:</strong> Anexar print dos filtros aplicados antes da extração (empresa, datas início/fim, centros de custo).<br>
        3. <strong>Bases em Excel/CSV:</strong> Enviar base bruta original exportada do sistema sem exclusão manual de linhas ou estornos.
      </div>
      <p>Ficamos à disposição para esclarecer qualquer dúvida.<br><br>Atenciosamente,<br><strong>${escapeHtml(m.auditorName || 'Auditoria Interna')}</strong></p>
    </div>
  `;

  const plainMail = `Assunto: ${subject}\n\n` + buildPbcEmailText();

  try {
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
      const item = new ClipboardItem({
        'text/html': new Blob([htmlMail], { type: 'text/html' }),
        'text/plain': new Blob([plainMail], { type: 'text/plain' })
      });
      await navigator.clipboard.write([item]);
      S.pbcList.forEach((p) => {
        if (p.status === 'Pendente') p.status = 'Solicitado';
      });
      commit();
      showToast('Carta formatada copiada! Cole diretamente no Outlook ou Gmail (Ctrl+V) com tabela e cores.');
      return;
    }
  } catch (_) {}
  copyToClipboard(plainMail, 'Carta copiada para a área de transferência.');
}

function switchReportSubTab(tabName) {
  document.querySelectorAll('#reportSubTabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.rtab === tabName));
  if ($('reportPanePbc')) $('reportPanePbc').classList.toggle('active', tabName === 'pbc');
  if ($('reportPaneWp')) $('reportPaneWp').classList.toggle('active', tabName === 'wp');
  if (tabName === 'pbc') {
    syncPbcMetaInputsFromState();
    renderPbcLetterPreview();
  } else {
    renderReportPreview();
  }
}

function switchView(viewName) {
  document.querySelectorAll('.sidebar-nav .nav-item').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === viewName));
  document.querySelectorAll('.view-container').forEach((v) => v.classList.toggle('active', v.id === `view-${viewName}`));
  if (viewName === 'report') {
    syncPbcMetaInputsFromState();
    renderPbcLetterPreview();
    renderReportPreview();
  }
  if (viewName === 'sessions') renderSessions();
}

function bindEvents() {
  document.querySelectorAll('.sidebar-nav .nav-item').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));
  $('btnEditTopicQuick').addEventListener('click', () => switchView('scope'));
  $('btnToggleTheme').addEventListener('click', () => {
    applyTheme(settings.theme === 'light' ? 'dark' : 'light');
    if (rt.pipWindow && !rt.pipWindow.closed) {
      setupPipWindowDOM(rt.pipWindow);
      syncFloatingTeleprompter();
    }
  });

  // Captura e análise
  $('btnToggleSystemAudio').addEventListener('click', toggleSystemAudio);
  $('btnToggleMicAudio').addEventListener('click', toggleMicAudio);
  $('btnAnalyzeNow').addEventListener('click', () => runAnalysis({ manual: true }));
  $('btnMarkMoment').addEventListener('click', () => markMoment());
  $('btnSimulateSpeech').addEventListener('click', runSimulatedSpeech);
  $('manualTranscriptInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitManualNote();
    }
  });
  $('btnSendManualNote').addEventListener('click', submitManualNote);
  document.addEventListener('keydown', handleHotkey);

  // Teleprompter
  document.querySelectorAll('#tpFilterTabs .seg-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tpFilterTabs .seg-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      rt.tpFilter = btn.dataset.filter;
      rt.focusedQuestionId = null;
      renderTeleprompter();
      syncFloatingTeleprompter();
    })
  );
  const btnClearEm = $('btnClearEmergent');
  if (btnClearEm) {
    btnClearEm.addEventListener('click', () => {
      S.questions = S.questions.filter((q) => q.asked || q.origin === 'roteiro' || q.origin === 'planejada');
      commit();
      showToast('Tópicos surgidos limpos (roteiro planejado mantido).');
    });
  }
  $('btnFontDec').addEventListener('click', () => adjustFontSize(-0.08));
  $('btnFontInc').addEventListener('click', () => adjustFontSize(0.08));
  $('pairedStreamContainer').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn && btn.dataset.src) {
      jumpToSource(btn.dataset.src);
      return;
    }
    if (btn && btn.dataset.action) {
      const id = btn.dataset.id;
      const q = S.questions.find((x) => x.id === id);
      if (btn.dataset.action === 'toggle-asked') toggleAsked(id);
      else if (btn.dataset.action === 'drill') drillDownQuestion(id);
      else if (btn.dataset.action === 'add-pbc') questionToPbc(id);
      else if (btn.dataset.action === 'open-point') questionToOpenPoint(id);
      else if (btn.dataset.action === 'copy' && q) copyToClipboard(q.text, 'Pergunta copiada.');
      return;
    }
    const row = e.target.closest('.paired-row');
    if (row && row.dataset.qid !== rt.focusedQuestionId) {
      rt.focusedQuestionId = row.dataset.qid;
      renderTeleprompter();
      syncFloatingTeleprompter();
    }
  });

  // Transcrição e momentos
  $('transcriptSearch').addEventListener('input', renderTranscript);
  $('btnClearTranscript').addEventListener('click', async () => {
    if (!S.transcript.length) return;
    const ok = await confirmDialog('Apagar toda a transcrição desta sessão? Os links de fonte dos cartões deixarão de funcionar.', { title: 'Limpar transcrição', okLabel: 'Apagar', danger: true });
    if (!ok) return;
    S.transcript = [];
    S.analyzedUpTo = 0;
    commit();
  });
  $('transcriptFeed').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.trMoment) markMoment(btn.dataset.trMoment);
    if (btn.dataset.trDel) {
      const ok = await confirmDialog('Excluir esta fala da transcrição?', { title: 'Excluir fala', okLabel: 'Excluir', danger: true });
      if (!ok) return;
      const idx = S.transcript.findIndex((t) => t.id === btn.dataset.trDel);
      if (idx !== -1) {
        S.transcript.splice(idx, 1);
        if (idx < S.analyzedUpTo) S.analyzedUpTo -= 1;
      }
      commit();
    }
  });
  $('momentsList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.src) jumpToSource(btn.dataset.src);
    if (btn.dataset.momentDel) {
      S.moments = S.moments.filter((m) => m.id !== btn.dataset.momentDel);
      commit();
    }
    if (btn.dataset.momentPbc) {
      const m = S.moments.find((x) => x.id === btn.dataset.momentPbc);
      if (m) {
        addPbc({ title: m.note || `Evidência do momento ${m.time}`, detail: m.excerpt.slice(0, 300), source: 'Momento' });
        commit();
      }
    }
  });
  $('momentsList').addEventListener('change', (e) => {
    const id = e.target.dataset.momentNote;
    if (!id) return;
    const m = S.moments.find((x) => x.id === id);
    if (m) {
      m.note = e.target.value;
      scheduleSave();
    }
  });

  // Preparação / escopo
  $('templateSelect').addEventListener('change', (e) => {
    const tpl = AUDIT_TEMPLATES[e.target.value];
    if (tpl) {
      $('auditTopicInput').value = tpl.topic;
      $('auditScopeInput').value = tpl.scope;
      $('auditMethodologySelect').value = tpl.methodology;
      showToast('Modelo selecionado. Clique em "Carregar Roteiro deste Tema" para aplicar.');
    }
  });
  $('btnStartAuditTopic').addEventListener('click', startAuditTopic);
  [
    ['auditTopicInput', 'topic'],
    ['auditScopeInput', 'scope'],
    ['participantsInput', 'participants'],
    ['plannedQuestionsInput', 'plannedQuestionsText']
  ].forEach(([elId, field]) =>
    $(elId).addEventListener('input', (e) => {
      S[field] = e.target.value;
      if (field === 'topic') renderHeader();
      scheduleSave();
    })
  );
  $('auditMethodologySelect').addEventListener('change', (e) => {
    S.methodology = e.target.value;
    scheduleSave();
  });
  $('prepMaterialInput').addEventListener('input', (e) => {
    S.prepMaterial = e.target.value;
    updatePrepInfo();
    scheduleSave();
  });
  $('prepFileInput').addEventListener('change', (e) => {
    importPrepFiles(Array.from(e.target.files || []));
    e.target.value = '';
  });
  $('btnApplyPlannedQuestions').addEventListener('click', applyPlannedQuestions);
  $('checklistContainer').addEventListener('click', (e) => {
    const el = e.target.closest('.chk-item');
    if (!el) return;
    const chk = S.checklist.find((c) => c.id === el.dataset.chk);
    if (chk) {
      chk.covered = !chk.covered;
      commit();
    }
  });

  // Matriz
  $('btnAddManualRisk').addEventListener('click', () => editRisk(null));
  $('btnAddManualControl').addEventListener('click', () => editControl(null));
  $('btnAddManualPbc').addEventListener('click', () => editPbc(null));
  $('btnAddOpenPoint').addEventListener('click', addManualOpenPoint);
  $('view-matrix').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const d = btn.dataset;
    if (d.src) return jumpToSource(d.src);
    if (d.riskEdit) return editRisk(d.riskEdit);
    if (d.riskValidate) {
      const r = S.risks.find((x) => x.id === d.riskValidate);
      if (r) r.validated = !r.validated;
      return commit();
    }
    if (d.riskDel) return deleteItem('risks', d.riskDel, 'este risco');
    if (d.ctrlEdit) return editControl(d.ctrlEdit);
    if (d.ctrlValidate) {
      const c = S.controls.find((x) => x.id === d.ctrlValidate);
      if (c) c.validated = !c.validated;
      return commit();
    }
    if (d.ctrlDel) return deleteItem('controls', d.ctrlDel, 'este controle');
    if (d.pbcEdit) return editPbc(d.pbcEdit);
    if (d.pbcDel) return deleteItem('pbcList', d.pbcDel, 'esta solicitação PBC');
    if (d.opToggle) {
      const o = S.openPoints.find((x) => x.id === d.opToggle);
      if (o) o.status = o.status === 'aberto' ? 'resolvido' : 'aberto';
      return commit();
    }
    if (d.opPbc) {
      const o = S.openPoints.find((x) => x.id === d.opPbc);
      if (o) addPbc({ title: o.text.replace(/^Sem resposta:\s*/i, '').slice(0, 140), detail: 'Originado de ponto em aberto da reunião.', source: 'Ponto em aberto' });
      return commit();
    }
    if (d.opDel) return deleteItem('openPoints', d.opDel, 'este ponto em aberto');
    if (d.dvValidate) {
      const dv = S.divergences.find((x) => x.id === d.dvValidate);
      if (dv) dv.validated = !dv.validated;
      return commit();
    }
    if (d.dvRisk) {
      const dv = S.divergences.find((x) => x.id === d.dvRisk);
      if (dv) {
        const r = addRisk({
          title: `Divergência entre norma e prática: ${dv.stated.slice(0, 80)}`,
          severity: 'Médio',
          description: `Documentado: ${dv.documented}. Relatado: ${dv.stated}. ${dv.impact}`,
          recommendation: 'Alinhar a prática à norma vigente ou revisar formalmente a norma.',
          source: 'Manual',
          validated: true,
          sourceIds: dv.sourceIds
        });
        showToast(r ? `Risco ${r.code} criado a partir da divergência.` : 'Risco já existente.');
      }
      return commit();
    }
    if (d.dvDel) return deleteItem('divergences', d.dvDel, 'esta divergência');
  });
  $('view-matrix').addEventListener('change', (e) => {
    const id = e.target.dataset.pbcStatus;
    if (!id) return;
    const p = S.pbcList.find((x) => x.id === id);
    if (p) {
      p.status = e.target.value;
      commit();
    }
  });

  // Relatório & Carta Formal de Solicitação PBC (RFI)
  document.querySelectorAll('#reportSubTabs .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchReportSubTab(btn.dataset.rtab));
  });
  if ($('pbcMetaForm')) {
    $('pbcMetaForm').addEventListener('input', () => {
      readPbcMetaFromInputs();
      renderPbcLetterPreview();
    });
  }
  if ($('btnGenerateAiPbc')) $('btnGenerateAiPbc').addEventListener('click', generateAiPbcLetter);
  if ($('btnImportMeetingScreensToPbc')) $('btnImportMeetingScreensToPbc').addEventListener('click', () => importMeetingSuggestionsToPbc({ silent: false }));
  if ($('btnAddPbcFromReport')) $('btnAddPbcFromReport').addEventListener('click', async () => { await editPbc(null); renderPbcLetterPreview(); });
  if ($('btnExportPbcDocx')) $('btnExportPbcDocx').addEventListener('click', () => downloadOfficeExport('pbc_docx', `Carta_Solicitacao_PBC_${sanitizeFileName(S.topic)}_${dateStamp()}.docx`));
  if ($('btnExportPbcXlsx')) $('btnExportPbcXlsx').addEventListener('click', () => downloadOfficeExport('audit_xlsx', `Controle_PBC_Tracker_${sanitizeFileName(S.topic)}_${dateStamp()}.xlsx`));
  if ($('btnCopyRichPbcEmail')) $('btnCopyRichPbcEmail').addEventListener('click', copyRichPbcEmail);
  if ($('btnPrintPbcLetter')) $('btnPrintPbcLetter').addEventListener('click', () => { switchReportSubTab('pbc'); window.print(); });
  if ($('pbcLetterPreviewContainer')) {
    $('pbcLetterPreviewContainer').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.letterEdit) {
        await editPbc(btn.dataset.letterEdit);
        renderPbcLetterPreview();
      } else if (btn.dataset.letterDel) {
        await deleteItem('pbcList', btn.dataset.letterDel, 'este item da Carta PBC');
        renderPbcLetterPreview();
      }
    });
  }

  $('btnGenerateAiSummary').addEventListener('click', generateReport);
  if ($('btnExportWpDocx')) $('btnExportWpDocx').addEventListener('click', () => downloadOfficeExport('wp_docx', `Papel_de_Trabalho_Walkthrough_${sanitizeFileName(S.topic)}_${dateStamp()}.docx`));
  $('btnExportXlsx').addEventListener('click', exportXlsx);
  $('btnExportCsvRcm').addEventListener('click', exportRcmToCsv);
  $('btnExportMarkdown').addEventListener('click', exportReportToMarkdown);
  $('btnPbcEmail').addEventListener('click', openPbcEmail);
  $('btnCopyPbcChat').addEventListener('click', copyPbcForTeamsChat);
  $('btnPrintReport').addEventListener('click', () => {
    switchReportSubTab('wp');
    renderReportPreview();
    window.print();
  });
  $('chkIncludeTranscript').addEventListener('change', renderReportPreview);

  // Projetos & Histórico de Reuniões
  if ($('btnSidebarProjectQuick')) {
    $('btnSidebarProjectQuick').addEventListener('click', () => switchView('sessions'));
  }
  if ($('btnNewProject')) {
    $('btnNewProject').addEventListener('click', createNewProject);
  }
  $('btnNewSession').addEventListener('click', () => createNewSession());
  $('btnExportSessionJson').addEventListener('click', () => {
    persistNow();
    exportSession(S.id);
  });
  $('importSessionInput').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) importSessionFile(f);
    e.target.value = '';
  });
  if ($('projectHistorySearch')) {
    let searchTimer = null;
    $('projectHistorySearch').addEventListener('input', (e) => {
      const val = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => syncProjectsWithServer(val), 260);
    });
  }
  if ($('projectsListContainer')) {
    $('projectsListContainer').addEventListener('click', (e) => {
      const card = e.target.closest('[data-select-prj]');
      if (!card) return;
      projectsStore.selectedProjectId = card.dataset.selectPrj;
      projectsStore.expandedSessionId = '';
      renderSessions();
    });
  }
  if ($('projectDetailHeader')) {
    $('projectDetailHeader').addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.prjNewMeet) createNewSession(btn.dataset.prjNewMeet);
      if (btn.dataset.prjEdit) editProjectModal(btn.dataset.prjEdit);
      if (btn.dataset.prjDel) deleteProjectConfirm(btn.dataset.prjDel);
    });
  }
  $('sessionsList').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.sesGoLive) switchView('live');
    if (btn.dataset.sesOpen) openSession(btn.dataset.sesOpen);
    if (btn.dataset.sesPreview) toggleMeetingPreview(btn.dataset.sesPreview);
    if (btn.dataset.sesRename) renameMeetingModal(btn.dataset.sesRename);
    if (btn.dataset.sesExport) exportSession(btn.dataset.sesExport);
    if (btn.dataset.sesDel) deleteSession(btn.dataset.sesDel);
  });

  // Configurações
  $('btnOpenSettings').addEventListener('click', openSettings);
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnTestClaudeKey').addEventListener('click', testClaudeConnection);
  $('btnTestApiKey').addEventListener('click', testGeminiConnection);
  $('btnRemoveClaudeKey').addEventListener('click', () => {
    $('settingsModal').classList.add('hidden');
    removeKey('claude');
  });
  $('btnRemoveGeminiKey').addEventListener('click', () => {
    $('settingsModal').classList.add('hidden');
    removeKey('gemini');
  });

  // Modais
  document.querySelectorAll('[data-close-modal]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const id = btn.dataset.closeModal;
      if (id === 'consentModal') cancelConsent();
      else $(id).classList.add('hidden');
    })
  );
  $('btnConfirmConsent').addEventListener('click', confirmConsent);
  $('btnShowShortcuts').addEventListener('click', () => $('shortcutsModal').classList.remove('hidden'));
  $('formModalSubmit').addEventListener('click', submitFormModal);
  $('formModalCancel').addEventListener('click', () => formResolver && formResolver(false));
  $('formModalClose').addEventListener('click', () => formResolver && formResolver(false));
  $('formModalBody').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      e.preventDefault();
      submitFormModal();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('formModal').classList.contains('hidden')) formResolver && formResolver(false);
    else if (!$('consentModal').classList.contains('hidden')) cancelConsent();
    else ['settingsModal', 'shortcutsModal'].forEach((id) => $(id).classList.add('hidden'));
  });

  $('btnOpenPiP').addEventListener('click', openFloatingTeleprompter);

  // Proteção contra perda de dados
  window.addEventListener('beforeunload', (e) => {
    persistNow();
    if (isCapturing()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistNow();
  });

  // Atualiza o contador "Insight em Xs"
  rt.statusTicker = setInterval(() => {
    if (rt.analyzeTimer) updateCycleStatus();
  }, 1000);
}

// ============================================================================
// INICIALIZAÇÃO
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(settings.theme);
  applyFontSize();
  loadCurrentSessionOrCreate();
  bindEvents();
  fillScopeForm();
  renderAll();
  updateCycleStatus();
  await refreshServerStatus();
  await migrateLegacyKeys();
  await syncProjectsWithServer();
  if (S.transcript.length > 0) showToast(`Sessão restaurada: ${S.topic} (${S.transcript.length} falas).`, 4500);
});
