'use strict';
/**
 * AuditPrompter v2 — funcionalidades novas (carregado depois de app.js; usa S, rt, settings e os utilitários de lá).
 *
 *  1. Participantes e "quem está falando" (identificação assistida de locutor)
 *  2. Importar transcrição pronta (Teams .vtt/.docx, .srt, .txt) ou gravação (áudio/vídeo → Whisper local)
 *  3. Print da tela compartilhada como evidência do momento marcado
 *  4. Memória do projeto entre reuniões e visão consolidada (RCM sem duplicidade)
 *  5. Revisão de encerramento da reunião
 */

// ============================================================================
// 1. PARTICIPANTES E QUEM ESTÁ FALANDO
// ============================================================================
// Cada linha de "Participantes": Nome — Cargo/Área — Papel. Quem tem "auditor" no cargo/papel conduz a reunião.
function parseParticipants() {
  return String((S && S.participants) || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, ...rest] = line.split(/\s+[—–-]\s+/);
      const detail = norm(rest.join(' '));
      const isAuditor = /\bauditor(a|es|as)?\b/.test(detail) && !/\bauditad/.test(detail);
      return { name: (name || line).trim(), detail: rest.join(' — '), role: isAuditor ? 'auditor' : 'auditado' };
    })
    .filter((p) => p.name);
}

// Opções para o áudio da reunião: os entrevistados cadastrados (ou o genérico "Auditado").
function speakerOptions() {
  const interviewees = parseParticipants().filter((p) => p.role === 'auditado');
  const opts = interviewees.length ? interviewees.map((p) => ({ name: p.name, detail: p.detail })) : [];
  if (!opts.some((o) => o.name === 'Auditado')) opts.unshift({ name: 'Auditado', detail: 'genérico' });
  return opts.slice(0, 9);
}

function setActiveSpeaker(name) {
  if (!S) return;
  S.activeSpeaker = name;
  renderSpeakerBar();
  syncFloatingTeleprompter();
  scheduleSave();
}

function setActiveSpeakerByIndex(i) {
  const opt = speakerOptions()[i];
  if (!opt) return;
  setActiveSpeaker(opt.name);
  showToast(`Quem está falando agora: ${opt.name}`, 1800);
}

function renderSpeakerBar() {
  const bar = $('speakerBar');
  if (!bar || !S) return;
  const opts = speakerOptions();
  if (!opts.some((o) => o.name === S.activeSpeaker)) S.activeSpeaker = opts.length > 1 ? opts[1].name : 'Auditado';
  bar.classList.toggle('hidden', opts.length <= 1);
  $('speakerBarChips').innerHTML = opts
    .map(
      (o, i) =>
        `<button class="spk-chip ${o.name === S.activeSpeaker ? 'active' : ''}" data-spk="${escapeAttr(o.name)}" title="${escapeAttr(o.detail || '')} — Ctrl+Alt+${i + 1}"><kbd>${i + 1}</kbd> ${escapeHtml(o.name)}</button>`
    )
    .join('');
}

async function editTranscriptSpeaker(entryId) {
  const entry = S.transcript.find((t) => t.id === entryId);
  if (!entry) return;
  const names = ['Auditor', 'Auditado', ...parseParticipants().map((p) => p.name)];
  const options = Array.from(new Set(names));
  const idx = S.transcript.indexOf(entry);
  // Falas seguintes da mesma origem com o mesmo rótulo (bloco contínuo) podem ser corrigidas juntas.
  let run = 0;
  for (let i = idx + 1; i < S.transcript.length && S.transcript[i].speaker === entry.speaker && S.transcript[i].source === entry.source; i++) run += 1;
  const values = await openForm({
    title: `Quem falou em T${entry.seq}?`,
    subtitle: entry.text.slice(0, 140),
    fields: [
      { name: 'speaker', label: 'Locutor', type: 'select', options, value: entry.speaker },
      { name: 'custom', label: 'Ou digite outro nome', placeholder: 'Ex.: Carlos — Tesouraria' },
      ...(run > 0
        ? [{ name: 'scope', label: 'Aplicar a', type: 'select', options: ['Só esta fala', `Esta e as ${run} fala(s) seguinte(s) com o mesmo rótulo`], value: 'Só esta fala' }]
        : [])
    ]
  });
  if (!values) return;
  const speaker = values.custom || values.speaker;
  const count = values.scope && !values.scope.startsWith('Só') ? run : 0;
  for (let i = idx; i <= idx + count; i++) {
    S.transcript[i].speaker = speaker;
    S.transcript[i].role = inferRole(speaker, 'manual');
  }
  commit();
}

// ============================================================================
// 2. IMPORTAR TRANSCRIÇÃO OU GRAVAÇÃO
// ============================================================================
const AUDIO_EXTS = ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'opus', 'webm', 'mp4', 'mkv', 'mov', 'aac', 'flac', 'wma', 'avi'];

function cleanCueText(t) {
  return String(t || '')
    .replace(/<\/?[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortStamp(ts) {
  // "00:01:23.450" | "0:1:23.4" | "1:23" → "00:01:23"
  const parts = String(ts).split(/[.,]/)[0].split(':').map((x) => x.padStart(2, '0'));
  while (parts.length < 3) parts.unshift('00');
  return parts.slice(-3).join(':');
}

/**
 * Converte o texto de uma transcrição pronta em falas { speaker, time, text }.
 * Formatos aceitos:
 *  - WebVTT / SRT (Teams, Zoom, Meet): blocos "00:00:03.000 --> 00:00:06.000", com <v Nome>texto</v> ou "Nome: texto"
 *  - Word do Teams: linha de tempo "0:0:3.0 --> 0:0:6.0", depois o nome, depois a fala; ou "Nome   0:03" e a fala abaixo
 *  - Texto simples: "[00:01] Nome: fala", "Nome: fala" ou parágrafos soltos
 */
function parseTranscriptText(raw) {
  const text = String(raw || '').replace(/\r/g, '').replace(/^﻿/, '');
  const lines = text.split('\n');
  const out = [];
  const push = (speaker, time, body) => {
    const clean = cleanCueText(body);
    if (!clean) return;
    const sp = cleanCueText(speaker) || 'Participante';
    const last = out[out.length - 1];
    // Junta legendas consecutivas da mesma pessoa numa fala só (até ~500 caracteres).
    if (last && last.speaker === sp && last.text.length + clean.length < 500) last.text += ` ${clean}`;
    else out.push({ speaker: sp, time: time || '', text: clean });
  };
  const ARROW = /^\s*(\d{1,2}:\d{1,2}(?::\d{1,2})?(?:[.,]\d+)?)\s*-->\s*(\d{1,2}:\d{1,2}(?::\d{1,2})?(?:[.,]\d+)?)/;
  const NAME_LINE = /^[A-ZÀ-Ý][\wÀ-ÿ.'’-]*(?:\s+[\wÀ-ÿ.'’()-]+){0,5}$/;

  if (lines.some((l) => ARROW.test(l))) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const m = ARROW.exec(lines[i]);
      if (!m) {
        i += 1;
        continue;
      }
      const time = shortStamp(m[1]);
      i += 1;
      const block = [];
      while (i < lines.length && lines[i].trim() && !ARROW.test(lines[i])) {
        block.push(lines[i].trim());
        i += 1;
      }
      // O identificador numérico/GUID da legenda seguinte pode ficar no fim do bloco anterior: descarta.
      while (block.length > 1 && /^(\d+|[0-9a-f-]{20,}(\/\d+-\d+)?)$/i.test(block[block.length - 1])) block.pop();
      if (block.length) blocks.push({ time, block });
    }
    // No Word do Teams o nome vem sozinho na 1ª linha do bloco. Só é tratado como nome o que se repete
    // em vários blocos (ou consta nos participantes) — uma frase curta qualquer não vira "locutor".
    const firstLineCount = {};
    blocks.forEach(({ block }) => {
      if (block.length > 1 && block[0].length <= 60 && NAME_LINE.test(block[0])) firstLineCount[block[0]] = (firstLineCount[block[0]] || 0) + 1;
    });
    const knownNames = parseParticipants().map((p) => norm(p.name));
    const isNameLine = (l) => firstLineCount[l] >= 2 || knownNames.includes(norm(l));
    blocks.forEach(({ time, block }) => {
      let speaker = '';
      let body = block.join(' ');
      const v = /^<v\s+([^>]+)>/i.exec(body);
      if (v) {
        speaker = v[1];
      } else if (block.length > 1 && isNameLine(block[0])) {
        speaker = block[0];
        body = block.slice(1).join(' ');
      } else {
        const c = /^([^:]{2,50}):\s+(.+)$/.exec(body);
        if (c && !/\d{1,2}$/.test(c[1])) {
          speaker = c[1];
          body = c[2];
        }
      }
      push(speaker, time, body);
    });
    return out;
  }

  // Sem "-->": texto corrido.
  const HEADER = /^(.{2,60}?)\s{2,}(\d{1,2}:\d{2}(?::\d{2})?)\s*$/; // "Maria Silva   0:03"
  const BRACKET = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–—]?\s*([^:]{2,60}):\s*(.+)$/; // "[00:01] Maria: fala"
  const COLON = /^([A-ZÀ-Ý][^:]{1,58}):\s+(.+)$/; // "Maria Silva: fala"
  let pending = null;
  lines.forEach((line) => {
    const l = line.trim();
    if (!l || /^WEBVTT/i.test(l)) return;
    let m;
    if ((m = HEADER.exec(l))) {
      pending = { speaker: m[1], time: shortStamp(m[2]) };
    } else if ((m = BRACKET.exec(l))) {
      push(m[2], shortStamp(m[1]), m[3]);
      pending = null;
    } else if (pending) {
      push(pending.speaker, pending.time, l);
    } else if ((m = COLON.exec(l))) {
      push(m[1], '', m[2]);
    } else {
      push('Participante', '', l);
    }
  });
  return out;
}

function fileToBase64(file) {
  return file.arrayBuffer().then((buf) => arrayBufferToBase64(buf));
}

async function importTranscriptFile(file) {
  if (!file) return;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  try {
    if (AUDIO_EXTS.includes(ext) || /^(audio|video)\//.test(file.type)) {
      await importRecordingFile(file, ext);
      return;
    }
    let raw;
    if (ext === 'docx') {
      if (!serverStatus.online) throw new Error('abra o AuditPrompter pelo Iniciar_Teleprompter.bat para ler arquivos Word');
      const res = await api('/api/import/docx', { body: { dataBase64: await fileToBase64(file) } });
      raw = (res && res.text) || '';
    } else {
      raw = await file.text();
    }
    const entries = parseTranscriptText(raw);
    if (!entries.length) throw new Error('nenhuma fala encontrada no arquivo');
    await finishTranscriptImport(entries, file.name);
  } catch (err) {
    showToast(`Não foi possível importar "${file.name}": ${err.message}`, 7000);
  }
}

// Pergunta quem é o auditor entre os nomes encontrados e grava as falas na transcrição.
async function finishTranscriptImport(entries, fileName) {
  const speakers = Array.from(new Set(entries.map((e) => e.speaker)));
  const known = parseParticipants();
  const preset = speakers.filter((sp) => {
    const p = known.find((k) => norm(k.name) === norm(sp));
    return p ? p.role === 'auditor' : /^auditor\b/.test(norm(sp));
  });
  let auditors = preset;
  if (speakers.length > 1 || (speakers.length === 1 && speakers[0] !== 'Participante')) {
    const values = await openForm({
      title: `Importar ${entries.length} fala(s) de "${fileName}"`,
      subtitle: 'Marque quem conduziu a reunião (auditoria). As falas dos demais são tratadas como relato do auditado e geram os insights.',
      fields: [{ name: 'auditors', label: 'Quem é da auditoria?', type: 'checkboxes', options: speakers.map((sp) => ({ value: sp, label: `${sp} (${entries.filter((e) => e.speaker === sp).length} falas)` })), value: preset }],
      submitLabel: 'Importar falas'
    });
    if (!values) return;
    auditors = values.auditors || [];
  }
  entries.forEach((e) => addTranscript(e.speaker, 'import', e.text, { time: e.time, role: auditors.includes(e.speaker) ? 'auditor' : 'auditado' }));
  // Nomes novos entram na lista de participantes (facilita corrigir locutor e alimenta o contexto da IA).
  const missing = speakers.filter((sp) => sp !== 'Participante' && !known.some((k) => norm(k.name) === norm(sp)));
  if (missing.length) {
    S.participants = [S.participants.trim(), ...missing.map((sp) => `${sp} — ${auditors.includes(sp) ? 'Auditor' : 'Auditado'}`)].filter(Boolean).join('\n');
    fillScopeForm();
  }
  commit();
  switchView('transcript');
  await offerBacklogAnalysis(entries.length);
}

async function importRecordingFile(file, ext) {
  if (!serverStatus.online) throw new Error('abra o AuditPrompter pelo Iniciar_Teleprompter.bat para transcrever gravações');
  if (!serverStatus.whisper) throw new Error('o Whisper local não está instalado (pip install faster-whisper)');
  const sizeMb = (file.size / 1048576).toFixed(1);
  const ok = await confirmDialog(
    `Transcrever "${file.name}" (${sizeMb} MB) com o Whisper local? O arquivo não sai deste computador. Gravações longas levam alguns minutos (cerca de 1 minuto de processamento para cada 6 a 10 minutos de áudio, conforme o computador).`,
    { title: 'Importar gravação', okLabel: 'Transcrever' }
  );
  if (!ok) return;
  const box = $('importProgress');
  const setProgress = (msg) => {
    if (!box) return;
    box.textContent = msg;
    box.classList.toggle('hidden', !msg);
  };
  setProgress(`Enviando "${file.name}" ao servidor local…`);
  try {
    const up = await fetch(`/api/import/audio?ext=${encodeURIComponent(ext || 'bin')}&prompt=${encodeURIComponent(transcriptionPrompt())}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-AuditPrompter': '1' },
      body: file
    });
    const upData = await up.json();
    if (!up.ok) throw new Error((upData.error && upData.error.message) || `HTTP ${up.status}`);
    let got = 0;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1500));
      const st = await api(`/api/import/status?id=${encodeURIComponent(upData.jobId)}&from=${got}`, { method: 'GET' });
      (st.segments || []).forEach((seg) => {
        const mm = Math.floor(seg.start / 60);
        const ss = Math.floor(seg.start % 60);
        addTranscript('Participante (gravação)', 'import', seg.text, { time: `${String(Math.floor(mm / 60)).padStart(2, '0')}:${String(mm % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`, role: 'auditado' });
      });
      if (st.segments && st.segments.length) {
        got += st.segments.length;
        const lastEnd = st.segments[st.segments.length - 1].end;
        setProgress(`Transcrevendo localmente… ${st.duration ? Math.min(100, Math.round((lastEnd / st.duration) * 100)) : 0}% (${got} trechos)`);
        commit();
      }
      if (st.error) throw new Error(st.error);
      if (st.done) break;
    }
    setProgress('');
    if (!got) {
      showToast('Nenhuma fala reconhecida na gravação.', 6000);
      return;
    }
    switchView('transcript');
    showToast(`Gravação transcrita: ${got} trechos. Clique no nome do locutor (✎) para identificar quem falou.`, 7000);
    await offerBacklogAnalysis(got);
  } finally {
    setProgress('');
  }
}

async function offerBacklogAnalysis(count) {
  const provider = analysisProvider();
  const ok = await confirmDialog(
    `${count} fala(s) importada(s). Gerar agora os insights, riscos, controles e pontos em aberto a partir delas com ${provider === 'local' ? 'o motor local (palavras-chave)' : provider === 'claude' ? 'o Claude' : 'o Gemini'}?`,
    { title: 'Analisar a transcrição importada', okLabel: 'Analisar agora' }
  );
  if (ok) await analyzeBacklog();
}

// Analisa em lotes tudo o que ainda não passou pela IA (uso pós-reunião).
async function analyzeBacklog() {
  if (rt.isAnalyzing) {
    showToast('Já existe uma análise em andamento.');
    return;
  }
  const BATCH = 18;
  const total = S.transcript.length - S.analyzedUpTo;
  if (total <= 0) {
    showToast('Não há falas pendentes de análise.');
    return;
  }
  clearTimeout(rt.analyzeTimer);
  rt.analyzeTimer = null;
  rt.isAnalyzing = true;
  setAnalyzingUI(true);
  const provider = analysisProvider();
  const instruction =
    'Esta é uma transcrição IMPORTADA, analisada depois da reunião. Para este trecho, gere até 3 blocos com os assuntos de processo e controle mais relevantes; em "text" escreva a pergunta de follow-up que o auditor deve levar à próxima conversa.';
  let failed = 0;
  try {
    while (S.analyzedUpTo < S.transcript.length) {
      const upTo = Math.min(S.transcript.length, S.analyzedUpTo + BATCH);
      const batch = S.transcript.slice(S.analyzedUpTo, upTo);
      updateCycleStatus(`Analisando importação… ${Math.round(((upTo - (S.transcript.length - total)) / total) * 100)}%`);
      try {
        if (provider === 'local') analyzeWithLocalAuditEngine(batch, { instruction, manual: true });
        else applyAiInsights(await callLiveAnalysis(provider, batch, instruction));
      } catch (err) {
        failed += 1;
        console.warn('Falha em um lote da análise importada:', err);
        analyzeWithLocalAuditEngine(batch, { instruction, manual: true });
        if (failed === 1) showToast(`IA indisponível em um trecho (${err.message}). Usando o motor local nesse trecho.`, 6000);
      }
      S.analyzedUpTo = upTo;
      setLivePreview('');
      commit();
    }
  } finally {
    rt.isAnalyzing = false;
    rt.pendingAnalysis = null;
    setLivePreview('');
    setAnalyzingUI(false);
    commit();
  }
  showToast(`Análise concluída: ${S.questions.length} tópico(s), ${S.risks.length} risco(s), ${S.controls.length} controle(s). Revise e valide os itens gerados.`, 7000);
}

// ============================================================================
// 3. PRINT DA TELA COMPARTILHADA COMO EVIDÊNCIA
// ============================================================================
function liveVideoTrack() {
  return rt.sysStream ? rt.sysStream.getVideoTracks().find((t) => t.readyState === 'live') || null : null;
}

function screenShotAvailable() {
  return serverStatus.online && Boolean(liveVideoTrack());
}

async function grabFrameBitmap(track) {
  if (window.ImageCapture) {
    try {
      return await new ImageCapture(track).grabFrame();
    } catch (_) {}
  }
  // Alternativa: desenha o quadro atual a partir de um <video> temporário.
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  await video.play();
  await new Promise((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
  const bmp = await createImageBitmap(video);
  video.pause();
  video.srcObject = null;
  return bmp;
}

// Captura o quadro atual da tela compartilhada, com faixa de identificação (data/hora, projeto e reunião).
async function captureScreenFrame(label) {
  const track = liveVideoTrack();
  if (!track) return null;
  const bmp = await grabFrameBitmap(track);
  const scale = Math.min(1, 1600 / bmp.width);
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const band = 30;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h + band;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bmp, 0, 0, w, h);
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, h, w, band);
  ctx.fillStyle = '#f8fafc';
  ctx.font = '13px Inter, Arial, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 10, h + band / 2, w - 20);
  if (bmp.close) bmp.close();
  return canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
}

async function attachScreenShotToMoment(moment) {
  try {
    const prj = activeProjectObj();
    const label = `AuditPrompter · ${new Date().toLocaleString('pt-BR')} · ${prj ? prj.code : ''} · ${S.meetingTitle || S.topic} · print da tela compartilhada`;
    const sessionId = S.id;
    const imageBase64 = await captureScreenFrame(label);
    if (!imageBase64) return;
    const res = await api('/api/evidence', { body: { sessionId, imageBase64 } });
    if (res && res.id && S.id === sessionId) {
      moment.shotId = res.id;
      moment.shotSessionId = sessionId;
      commit();
    }
  } catch (err) {
    console.warn('Falha ao capturar o print:', err);
    showToast(`Momento marcado, mas o print da tela falhou: ${err.message}`, 6000);
  }
}

function momentShotsGalleryHtml() {
  const shots = S.moments.filter((m) => m.shotId);
  if (!shots.length) return '';
  return `<div class="shot-gallery">${shots
    .map(
      (m) => `<figure><img alt="Print às ${escapeAttr(m.time)}" src="/api/evidence?session=${encodeURIComponent(m.shotSessionId || S.id)}&id=${encodeURIComponent(m.shotId)}" />
        <figcaption>${escapeHtml(m.time)}${m.note ? ` — ${escapeHtml(m.note)}` : ''}</figcaption></figure>`
    )
    .join('')}</div>`;
}

// ============================================================================
// 4. MEMÓRIA DO PROJETO E VISÃO CONSOLIDADA
// ============================================================================
async function fetchConsolidated(projectId) {
  if (!serverStatus.online || !projectId) return null;
  // Garante que a reunião aberta já esteja no disco antes de consolidar.
  if (S && S.projectId === projectId) {
    try {
      const r = await diskSaveSession(S, { force: true });
      if (r && r.conflict) await diskSaveSession(S, { force: true });
    } catch (_) {}
  }
  try {
    return await api(`/api/projects/consolidated?projectId=${encodeURIComponent(projectId)}`, { method: 'GET' });
  } catch (_) {
    return null;
  }
}

// O que uma reunião nova herda das anteriores do mesmo projeto.
async function loadProjectCarryOver(projectId) {
  const data = await fetchConsolidated(projectId);
  if (!data || !Array.isArray(data.meetings)) return null;
  return {
    memory: {
      generatedAt: new Date().toISOString(),
      meetings: data.meetings.map((m) => ({
        title: m.title,
        date: m.createdAt ? new Date(m.createdAt).toLocaleDateString('pt-BR') : '',
        participants: String(m.participants || '').split('\n').map((l) => l.split(/\s+[—–-]\s+/)[0].trim()).filter(Boolean).join(', '),
        topics: m.topics || []
      })),
      statements: data.meetings.flatMap((m) => (m.statements || []).map((text) => ({ meeting: m.title, text }))).slice(-30)
    },
    openPoints: (data.openPoints || []).filter((o) => o.status === 'aberto')
  };
}

function csvCell(v) {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

async function openProjectConsolidated(projectId) {
  const data = await fetchConsolidated(projectId);
  if (!data) {
    showToast('Não foi possível montar a visão consolidada (servidor local offline?).');
    return;
  }
  const prj = data.project || {};
  const sevOrder = { Alto: 0, Médio: 1, Baixo: 2 };
  const risks = data.risks.slice().sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3));
  const openPts = data.openPoints.filter((o) => o.status === 'aberto');
  const pbcPending = data.pbc.filter((p) => !['Validado', 'Não aplicável'].includes(p.status));
  const uncovered = risks.filter((r) => !r.controls.length).length;
  const html = `
    <div class="consolidated">
      <div class="control-meta">
        <span class="meta-pill"><strong>${data.meetings.length}</strong> reunião(ões)</span>
        <span class="meta-pill"><strong>${risks.length}</strong> riscos únicos</span>
        <span class="meta-pill"><strong>${data.controls.length}</strong> controles únicos</span>
        <span class="meta-pill"><strong>${uncovered}</strong> risco(s) sem controle</span>
        <span class="meta-pill"><strong>${openPts.length}</strong> pendência(s) em aberto</span>
        <span class="meta-pill"><strong>${pbcPending.length}</strong> evidência(s) PBC a receber</span>
      </div>
      <h4>Matriz de Riscos e Controles do projeto</h4>
      ${tableHtml(
        ['Sev.', 'Risco', 'Controles que mitigam', 'Reuniões', 'Validado'],
        risks.map((r) => [r.severity || '—', r.title, r.controls.join('; ') || 'SEM CONTROLE (gap)', r.meetings.join('; '), r.validated ? 'Sim' : 'Não']),
        'Nenhum risco registrado neste projeto.'
      )}
      <h4>Pendências em aberto</h4>
      ${tableHtml(['Tipo', 'Pendência', 'Origem'], openPts.map((o) => [{ sem_resposta: 'Sem resposta', contradicao: 'Contradição', pendencia: 'Pendência' }[o.kind] || o.kind, o.text, o.meeting]), 'Nenhuma pendência em aberto.')}
      <h4>Evidências PBC a receber</h4>
      ${tableHtml(['Evidência', 'Status', 'Responsável', 'Reunião'], pbcPending.map((p) => [p.title, p.status, p.owner || 'A definir', p.meeting]), 'Nenhuma evidência pendente.')}
      <h4>Reuniões</h4>
      ${tableHtml(['Reunião', 'Data', 'Falas', 'Assuntos mapeados'], data.meetings.map((m) => [m.title, m.createdAt ? new Date(m.createdAt).toLocaleDateString('pt-BR') : '', m.transcriptCount, (m.topics || []).join('; ')]), '')}
    </div>`;
  const values = await openForm({
    title: `Visão consolidada — ${prj.code || ''} ${prj.name || ''}`,
    subtitle: 'Soma de todas as reuniões do projeto, sem duplicar riscos e controles repetidos entre reuniões.',
    html,
    submitLabel: 'Baixar RCM consolidada (.csv)',
    cancelLabel: 'Fechar'
  });
  if (!values) return;
  const rows = [['Severidade', 'Risco', 'Descrição', 'Controles que mitigam', 'Recomendação', 'Reuniões', 'Validado']];
  risks.forEach((r) => rows.push([r.severity, r.title, r.description, r.controls.join('; ') || 'SEM CONTROLE (gap)', r.recommendation, r.meetings.join('; '), r.validated ? 'Sim' : 'Não']));
  rows.push([], ['Controle', 'Tipo', 'Natureza', 'Frequência', 'Responsável', 'Avaliação TOD', 'Riscos mitigados', 'Reuniões']);
  data.controls.forEach((c) => rows.push([c.name, c.type, c.nature, c.frequency, c.owner, c.status, (c.risks || []).join('; '), c.meetings.join('; ')]));
  rows.push([], ['Pendência em aberto', 'Tipo', 'Origem']);
  openPts.forEach((o) => rows.push([o.text, o.kind, o.meeting]));
  downloadFile('﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\r\n'), `RCM_Consolidada_${sanitizeFileName(prj.code || prj.name)}_${dateStamp()}.csv`, 'text/csv;charset=utf-8');
}

// ============================================================================
// 5. REVISÃO DE ENCERRAMENTO DA REUNIÃO
// ============================================================================
function closingReviewData() {
  return {
    uncoveredChecklist: S.checklist.filter((c) => !c.covered),
    pendingCritical: S.questions.filter((q) => !q.asked && (q.priority === 'critica' || q.priority === 'alta')),
    openPoints: S.openPoints.filter((o) => o.status === 'aberto'),
    pbcIncomplete: S.pbcList.filter((p) => !['Validado', 'Não aplicável', 'Recebido'].includes(p.status) && (!p.owner || !p.dueDate)),
    risksWithoutControl: S.risks.filter((r) => !S.controls.some((c) => c.riskIds.includes(r.id))),
    unvalidated: [...S.risks, ...S.controls].filter((x) => !x.validated && x.source !== 'Manual').length,
    unanalyzed: S.transcript.length - S.analyzedUpTo
  };
}

async function openClosingReview() {
  const d = closingReviewData();
  const li = (items, fmt, max = 6) =>
    items.length
      ? `<ul>${items.slice(0, max).map((x) => `<li>${fmt(x)}</li>`).join('')}${items.length > max ? `<li class="hint-text">… e mais ${items.length - max}</li>` : ''}</ul>`
      : '<div class="closing-ok">✓ Nada pendente.</div>';
  const section = (title, count, body, hint) =>
    `<div class="closing-section ${count ? 'has-items' : ''}"><div class="closing-title"><span class="closing-count">${count}</span>${escapeHtml(title)}</div>${hint && count ? `<div class="hint-text">${escapeHtml(hint)}</div>` : ''}${body}</div>`;

  const askNow = d.pendingCritical.length + d.uncoveredChecklist.length;
  const script = [];
  if (d.openPoints.length) script.push(`ficaram ${d.openPoints.length} ponto(s) para retorno`);
  if (d.pbcIncomplete.length) script.push(`vou formalizar ${d.pbcIncomplete.length} solicitação(ões) de evidência — quem será o responsável e qual o prazo`);
  const scriptText = `“Antes de encerrarmos, só para confirmar: ${script.length ? script.join('; e ') : 'cobrimos todos os pontos previstos'}. Existe alguma exceção ao fluxo que não comentamos, ou alguém mais que devamos ouvir sobre este processo?”`;

  const html = `
    <div class="closing-review">
      <div class="closing-summary ${askNow ? 'warn' : 'ok'}">
        ${askNow ? `Ainda dá tempo de perguntar: <strong>${askNow}</strong> item(ns) abaixo dependem da presença do entrevistado.` : 'Roteiro e checklist cobertos. Confira as pendências formais antes de liberar os participantes.'}
      </div>
      ${section('Perguntas críticas / de alta prioridade não feitas', d.pendingCritical.length, li(d.pendingCritical, (q) => escapeHtml(q.text)), 'Pergunte agora ou registre como ponto em aberto.')}
      ${section('Etapas do checklist de walkthrough não cobertas', d.uncoveredChecklist.length, li(d.uncoveredChecklist, (c) => `<strong>${escapeHtml(c.title)}</strong> — ${escapeHtml(c.hint)}`, 8))}
      ${section('Pontos em aberto (sem resposta, contradições, pendências)', d.openPoints.length, li(d.openPoints, (o) => escapeHtml(o.text)), 'Combine responsável e prazo de retorno antes de encerrar.')}
      ${section('Evidências PBC sem responsável ou prazo', d.pbcIncomplete.length, li(d.pbcIncomplete, (p) => `${escapeHtml(p.code)} — ${escapeHtml(p.title)}`))}
      ${section('Riscos sem controle mitigante vinculado', d.risksWithoutControl.length, li(d.risksWithoutControl, (r) => `${escapeHtml(r.code)} — ${escapeHtml(r.title)}`), 'Pergunte se existe controle compensatório antes de tratar como gap.')}
      <div class="closing-script"><div class="closing-title">Fala sugerida de fechamento</div><div>${escapeHtml(scriptText)}</div></div>
      <div class="hint-text">Depois da reunião: ${d.unvalidated} item(ns) gerado(s) por IA aguardam a sua validação${d.unanalyzed > 0 ? ` e ${d.unanalyzed} fala(s) ainda não foram analisadas` : ''}.</div>
    </div>`;

  const values = await openForm({
    title: 'Antes de encerrar a reunião',
    subtitle: `${S.meetingTitle || S.topic} — ${S.transcript.length} fala(s) registradas`,
    html,
    submitLabel: 'Encerrar e ir para o Papel de Trabalho',
    cancelLabel: 'Voltar à reunião'
  });
  if (!values) return;

  // Perguntas críticas não feitas viram pontos em aberto para o follow-up (nada se perde).
  let moved = 0;
  d.pendingCritical.forEach((q) => {
    if (addOpenPoint({ text: `Sem resposta: ${q.text}`, kind: 'sem_resposta', source: 'Encerramento', sourceIds: q.sourceIds })) moved += 1;
  });
  if (rt.sysStream) stopSystemAudio();
  if (rt.micStream) stopMicAudio();
  S.closedAt = new Date().toISOString();
  commit();
  if (S.transcript.length > S.analyzedUpTo) await runAnalysis({ manual: true });
  switchView('report');
  switchReportSubTab('wp');
  showToast(`Reunião encerrada.${moved ? ` ${moved} pergunta(s) crítica(s) não feita(s) foram registradas como pontos em aberto.` : ''} Revise os itens e gere a narrativa do papel de trabalho.`, 7000);
}

// ============================================================================
// LIGAÇÕES DE EVENTOS
// ============================================================================
document.addEventListener('DOMContentLoaded', () => {
  const on = (id, evt, fn) => $(id) && $(id).addEventListener(evt, fn);

  on('speakerBarChips', 'click', (e) => {
    const b = e.target.closest('button[data-spk]');
    if (b) setActiveSpeaker(b.dataset.spk);
  });
  on('participantsInput', 'input', renderSpeakerBar);
  on('transcriptFeed', 'click', (e) => {
    const b = e.target.closest('button[data-tr-speaker]');
    if (b) editTranscriptSpeaker(b.dataset.trSpeaker);
  });
  on('importTranscriptInput', 'change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) importTranscriptFile(f);
  });
  on('btnAnalyzeBacklog', 'click', analyzeBacklog);
  on('btnScreenShot', 'click', () => markMoment(null, { requireShot: true }));
  on('btnCloseMeeting', 'click', openClosingReview);

  // Assinatura do criador (Auditor do Futuro)
  const openAbout = () => $('aboutModal') && $('aboutModal').classList.remove('hidden');
  on('btnAbout', 'click', openAbout);
  on('btnAboutTop', 'click', openAbout);
  on('aboutModal', 'click', (e) => {
    if (e.target === $('aboutModal')) $('aboutModal').classList.add('hidden');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && $('aboutModal')) $('aboutModal').classList.add('hidden');
  });

  renderSpeakerBar();
});

// A barra de locutores acompanha qualquer re-renderização (troca de reunião, edição de participantes).
const renderAllBase = renderAll;
renderAll = function renderAllWithExtras() {
  renderAllBase();
  renderSpeakerBar();
  const pending = S ? S.transcript.length - S.analyzedUpTo : 0;
  const btn = $('btnAnalyzeBacklog');
  if (btn) {
    btn.classList.toggle('hidden', pending < 8 || rt.isAnalyzing);
    btn.textContent = `Analisar ${pending} fala(s) pendente(s)`;
  }
};
