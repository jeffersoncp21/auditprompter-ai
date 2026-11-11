/**
 * AuditPrompter — servidor local.
 *
 * - Escuta SOMENTE em 127.0.0.1 (não fica exposto na rede do cliente).
 * - Serve apenas uma lista fechada de arquivos estáticos (sem path traversal).
 * - Guarda as chaves de API em %APPDATA%\AuditPrompter\config.json (ou variáveis de ambiente);
 *   as chaves nunca são devolvidas ao navegador.
 * - Transcreve áudio da reunião e microfone localmente via /api/transcribe (Python SpeechRecognition + ffmpeg, sem exigir chave Gemini).
 * - Faz o proxy das chamadas para Anthropic (SDK oficial) e Google Gemini.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile } = require('child_process');
const AnthropicModule = require('@anthropic-ai/sdk');

const Anthropic = AnthropicModule.default || AnthropicModule;

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const CONFIG_DIR = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'AuditPrompter')
  : path.join(os.homedir(), '.auditprompter');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const MAX_BODY_BYTES = 30 * 1024 * 1024;

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'application/javascript; charset=utf-8' },
  '/templates.js': { file: 'templates.js', type: 'application/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' }
};

const MODELS_WITH_FALLBACK = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);
const ALLOWED_CLAUDE_MODELS = new Set([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001'
]);
const ALLOWED_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// ---------------------------------------------------------------------------
// Configuração / chaves
// ---------------------------------------------------------------------------
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 });
}

function getClaudeKey() {
  return (process.env.ANTHROPIC_API_KEY || readConfig().claudeApiKey || '').trim();
}

function getGeminiKey() {
  return (process.env.GEMINI_API_KEY || readConfig().geminiApiKey || '').trim();
}

let cachedClient = null;
let cachedClientKey = '';
function getAnthropicClient() {
  const key = getClaudeKey();
  if (!key) return null;
  if (!cachedClient || cachedClientKey !== key) {
    cachedClient = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 5 * 60 * 1000 });
    cachedClientKey = key;
  }
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Utilitários HTTP
// ---------------------------------------------------------------------------
function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Requisição muito grande.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(Object.assign(new Error('JSON inválido.'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function isTrustedApiRequest(req) {
  const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
  if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) return false;
  const origin = req.headers.origin;
  if (origin) {
    const allowedOrigins = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
    if (!allowedOrigins.has(origin.toLowerCase())) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Transcrição Local de Áudio (Áudio da Reunião + Microfone em pt-BR)
// ---------------------------------------------------------------------------
function transcribeAudioBuffer(audioBuffer, mimeType = 'audio/wav') {
  return new Promise((resolve) => {
    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const isWav = String(mimeType || '').includes('wav');
    const tmpIn = path.join(os.tmpdir(), `audit_in_${id}.${isWav ? 'wav' : 'webm'}`);
    const tmpWav = path.join(os.tmpdir(), `audit_out_${id}.wav`);

    const cleanup = () => {
      try { fs.unlinkSync(tmpIn); } catch (_) {}
      try { fs.unlinkSync(tmpWav); } catch (_) {}
    };

    try {
      fs.writeFileSync(tmpIn, audioBuffer);
    } catch (_) {
      cleanup();
      resolve('');
      return;
    }

    const runPythonRecognition = (wavFile) => {
      const pyScript = [
        'import sys, speech_recognition as sr',
        'sys.stdout.reconfigure(encoding="utf-8")',
        'r = sr.Recognizer()',
        'with sr.AudioFile(sys.argv[1]) as src:',
        '    audio = r.record(src)',
        'try:',
        '    print(r.recognize_google(audio, language="pt-BR"))',
        'except Exception:',
        '    pass'
      ].join('\n');

      execFile(
        'python',
        ['-c', pyScript, wavFile],
        { timeout: 20000, encoding: 'utf8' },
        (pyErr, stdout) => {
          cleanup();
          if (pyErr) {
            resolve('');
            return;
          }
          const text = String(stdout || '').trim();
          if (text) {
            console.log(`[Transcrição Ao Vivo]: "${text}"`);
          }
          resolve(text);
        }
      );
    };

    // Sempre passa pelo ffmpeg para normalizar volume e garantir PCM 16kHz mono limpo
    execFile(
      'ffmpeg',
      ['-y', '-i', tmpIn, '-vn', '-af', 'volume=1.8', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', tmpWav],
      { timeout: 15000 },
      (ffErr) => {
        if (!ffErr && fs.existsSync(tmpWav)) {
          runPythonRecognition(tmpWav);
        } else if (isWav && fs.existsSync(tmpIn)) {
          runPythonRecognition(tmpIn);
        } else {
          cleanup();
          resolve('');
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Anthropic (SDK oficial)
// ---------------------------------------------------------------------------
function describeAnthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 401, message: 'Chave Anthropic recusada (401). Verifique se foi copiada inteira.' };
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return { status: 403, message: 'Sem permissão para este modelo/recurso na sua conta Anthropic.' };
  }
  if (err instanceof Anthropic.NotFoundError) {
    return { status: 404, message: 'Modelo não encontrado ou não habilitado na sua conta Anthropic.' };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, message: 'Limite de requisições da Anthropic atingido. Aguarde alguns segundos.' };
  }
  if (err instanceof Anthropic.BadRequestError) {
    const msg = String(err.message || '');
    if (msg.toLowerCase().includes('credit balance')) {
      return { status: 400, message: 'Conta Anthropic sem créditos de API (console.anthropic.com → Billing).' };
    }
    return { status: 400, message: `Requisição recusada pela Anthropic: ${msg}` };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { status: 502, message: 'Sem conexão com a API da Anthropic (verifique internet/proxy corporativo).' };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: err.status || 500, message: `Erro da API Anthropic (${err.status}): ${err.message}` };
  }
  return { status: 500, message: err && err.message ? err.message : 'Erro desconhecido.' };
}

async function handleClaudeMessage(body) {
  const client = getAnthropicClient();
  if (!client) {
    return { status: 400, payload: { error: { message: 'Chave Anthropic não configurada no servidor local.' } } };
  }

  const model = ALLOWED_CLAUDE_MODELS.has(body.model) ? body.model : 'claude-sonnet-5-5';
  const effort = ALLOWED_EFFORT.has(body.effort) ? body.effort : 'medium';
  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 16000, 256), 16000);

  const systemBlocks = (Array.isArray(body.system) ? body.system : [])
    .filter((b) => b && typeof b.text === 'string' && b.text.trim())
    .map((b) => ({ type: 'text', text: b.text }));
  if (systemBlocks.length > 0) {
    systemBlocks[systemBlocks.length - 1].cache_control = { type: 'ephemeral' };
  }

  const params = {
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: String(body.prompt || '') }],
    output_config: { effort }
  };
  if (systemBlocks.length > 0) params.system = systemBlocks;
  if (body.schema && typeof body.schema === 'object') {
    params.output_config.format = { type: 'json_schema', schema: body.schema };
  }

  const betas = [];
  if (MODELS_WITH_FALLBACK.has(model)) {
    betas.push('server-side-fallback-2026-07-01');
    params.fallbacks = 'default';
  }

  let response;
  try {
    response = await client.beta.messages.create({ ...params, betas });
  } catch (err) {
    if (err instanceof Anthropic.NotFoundError || err instanceof Anthropic.BadRequestError) {
      // Fallback para modelo padrão sem output_config.effort caso o modelo não suporte effort
      const fallbackParams = {
        model: 'claude-sonnet-4-6',
        max_tokens: Math.min(maxTokens, 8192),
        messages: params.messages
      };
      if (systemBlocks.length > 0) fallbackParams.system = systemBlocks;
      response = await client.messages.create(fallbackParams);
    } else {
      throw err;
    }
  }

  if (response.stop_reason === 'refusal') {
    const category = response.stop_details && response.stop_details.category;
    return {
      status: 422,
      payload: {
        error: {
          message: `O modelo recusou esta solicitação${category ? ` (categoria: ${category})` : ''}. Reformule o trecho ou use o motor local.`
        }
      }
    };
  }

  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  return {
    status: 200,
    payload: {
      text,
      model: response.model,
      stop_reason: response.stop_reason,
      usage: response.usage
    }
  };
}

async function handleClaudeTest() {
  const client = getAnthropicClient();
  if (!client) return { status: 400, payload: { ok: false, message: 'Chave Anthropic não configurada.' } };
  const models = [];
  for await (const m of client.models.list()) {
    models.push(m.id);
    if (models.length >= 100) break;
  }
  const testModel = models.includes('claude-haiku-5-5')
    ? 'claude-haiku-5-5'
    : models.find((m) => m.includes('haiku') || m.includes('sonnet')) || 'claude-sonnet-4-6';
  const ping = await client.messages.create({
    model: testModel,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'Responda apenas: OK' }]
  });
  return {
    status: 200,
    payload: {
      ok: ping.stop_reason !== 'refusal',
      message: `Conexão Anthropic validada (${testModel}).`,
      models: models.filter((id) => ALLOWED_CLAUDE_MODELS.has(id))
    }
  };
}

// ---------------------------------------------------------------------------
// Google Gemini (REST — chave enviada em header, nunca na URL)
// ---------------------------------------------------------------------------
function forwardToGemini(model, payloadObj) {
  const key = getGeminiKey();
  return new Promise((resolve, reject) => {
    if (!key) {
      resolve({ status: 400, body: JSON.stringify({ error: { message: 'Chave Gemini não configurada no servidor local.' } }) });
      return;
    }
    const safeModel = /^[a-z0-9.\-]+$/i.test(model || '') ? model : 'gemini-2.5-flash';
    const payload = JSON.stringify(payloadObj || {});
    const req = https.request(
      {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: `/v1beta/models/${safeModel}:generateContent`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'x-goog-api-key': key
        },
        timeout: 120000
      },
      (gRes) => {
        let data = '';
        gRes.on('data', (c) => (data += c));
        gRes.on('end', () => resolve({ status: gRes.statusCode || 500, body: data }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado na chamada ao Gemini.')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Exportação Corporativa Nativa (.docx / .xlsx via export_builder.py)
// ---------------------------------------------------------------------------
function generateOfficeDocument(mode, dataObj) {
  return new Promise((resolve, reject) => {
    const allowedModes = {
      pbc_docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      wp_docx: { ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      audit_xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }
    };
    const spec = allowedModes[mode];
    if (!spec) {
      reject(Object.assign(new Error('Formato de exportação inválido.'), { status: 400 }));
      return;
    }

    const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const tmpJson = path.join(os.tmpdir(), `audit_exp_${id}.json`);
    const tmpOut = path.join(os.tmpdir(), `audit_exp_${id}.${spec.ext}`);
    const scriptPath = path.join(ROOT, 'export_builder.py');

    const cleanup = () => {
      try { fs.unlinkSync(tmpJson); } catch (_) {}
      try { fs.unlinkSync(tmpOut); } catch (_) {}
    };

    try {
      fs.writeFileSync(tmpJson, JSON.stringify(dataObj || {}), 'utf8');
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }

    execFile(
      'python',
      [scriptPath, mode, tmpJson, tmpOut],
      { timeout: 30000, encoding: 'utf8' },
      (err, _stdout, stderr) => {
        if (err || !fs.existsSync(tmpOut)) {
          cleanup();
          reject(new Error(`Falha ao gerar arquivo Office: ${stderr || (err && err.message) || 'erro desconhecido'}`));
          return;
        }
        try {
          const buf = fs.readFileSync(tmpOut);
          cleanup();
          resolve({ buffer: buf, mime: spec.mime, ext: spec.ext });
        } catch (readErr) {
          cleanup();
          reject(readErr);
        }
      }
    );
  });
}

// ---------------------------------------------------------------------------
// Persistência em Disco de Projetos & Histórico de Reuniões (projetos_auditoria/)
// ---------------------------------------------------------------------------
const PROJECTS_DIR = path.join(ROOT, 'projetos_auditoria');
const PROJECTS_SESSIONS_DIR = path.join(PROJECTS_DIR, 'sessoes');
const PROJECTS_INDEX_PATH = path.join(PROJECTS_DIR, 'index.json');

function ensureProjectsStorage() {
  fs.mkdirSync(PROJECTS_SESSIONS_DIR, { recursive: true });
  if (!fs.existsSync(PROJECTS_INDEX_PATH)) {
    fs.writeFileSync(PROJECTS_INDEX_PATH, JSON.stringify({ projects: [], sessions: [] }, null, 2), 'utf8');
  }
}

function readProjectsIndex() {
  ensureProjectsStorage();
  try {
    const parsed = JSON.parse(fs.readFileSync(PROJECTS_INDEX_PATH, 'utf8'));
    return {
      projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
    };
  } catch (_) {
    return { projects: [], sessions: [] };
  }
}

function writeProjectsIndex(idxObj) {
  ensureProjectsStorage();
  const tmp = PROJECTS_INDEX_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(idxObj, null, 2), 'utf8');
  fs.renameSync(tmp, PROJECTS_INDEX_PATH);
}

function safeFileId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function sessionFilePath(sessionId) {
  const clean = safeFileId(sessionId);
  if (!clean) throw Object.assign(new Error('ID de sessão inválido.'), { status: 400 });
  return path.join(PROJECTS_SESSIONS_DIR, `${clean}.json`);
}

function saveProjectMeta(projectInput) {
  const idx = readProjectsIndex();
  const now = new Date().toISOString();
  const id = safeFileId(projectInput.id) || `prj-${Date.now().toString(36)}`;
  let existing = idx.projects.find((p) => p.id === id);
  if (existing) {
    existing.code = String(projectInput.code || existing.code || '').trim();
    existing.name = String(projectInput.name || existing.name || 'Projeto de Auditoria').trim();
    existing.clientUnit = String(projectInput.clientUnit ?? existing.clientUnit ?? '').trim();
    existing.auditorLead = String(projectInput.auditorLead ?? existing.auditorLead ?? '').trim();
    existing.status = String(projectInput.status || existing.status || 'Em Execução').trim();
    existing.updatedAt = now;
  } else {
    const seq = idx.projects.length + 1;
    const year = new Date().getFullYear();
    existing = {
      id,
      code: String(projectInput.code || `AUD-${year}-${String(seq).padStart(2, '0')}`).trim(),
      name: String(projectInput.name || 'Auditoria Interna').trim(),
      clientUnit: String(projectInput.clientUnit || '').trim(),
      auditorLead: String(projectInput.auditorLead || '').trim(),
      status: String(projectInput.status || 'Em Execução').trim(),
      createdAt: projectInput.createdAt || now,
      updatedAt: now
    };
    idx.projects.unshift(existing);
  }
  writeProjectsIndex(idx);
  return { project: existing, index: idx };
}

function saveSessionToDisk(sessionObj) {
  if (!sessionObj || !sessionObj.id) {
    throw Object.assign(new Error('Objeto de sessão inválido.'), { status: 400 });
  }
  const idx = readProjectsIndex();
  const now = new Date().toISOString();

  // Garante que exista um Projeto vinculado
  let projectId = safeFileId(sessionObj.projectId);
  let project = projectId ? idx.projects.find((p) => p.id === projectId) : null;
  if (!project) {
    const seq = idx.projects.length + 1;
    const year = new Date().getFullYear();
    projectId = projectId || `prj-${Date.now().toString(36)}`;
    project = {
      id: projectId,
      code: `AUD-${year}-${String(seq).padStart(2, '0')}`,
      name: String(sessionObj.topic || 'Auditoria Interna').trim(),
      clientUnit: String(sessionObj.scope || '').slice(0, 80).trim(),
      auditorLead: '',
      status: 'Em Execução',
      createdAt: sessionObj.createdAt || now,
      updatedAt: now
    };
    idx.projects.unshift(project);
  } else {
    project.updatedAt = now;
  }

  sessionObj.projectId = project.id;
  sessionObj.updatedAt = now;

  const fpath = sessionFilePath(sessionObj.id);
  const tmpFile = fpath + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(sessionObj, null, 2), 'utf8');
  fs.renameSync(tmpFile, fpath);

  const transcriptArr = Array.isArray(sessionObj.transcript) ? sessionObj.transcript : [];
  const questionsArr = Array.isArray(sessionObj.questions) ? sessionObj.questions : [];
  const recentTopics = questionsArr
    .filter((q) => q.origin === 'ia' || q.origin === 'local' || q.asked)
    .slice(0, 4)
    .map((q) => q.topicTitle || q.category)
    .filter(Boolean);
  const recentQuotes = transcriptArr.slice(-3).map((t) => `[${t.time}] ${t.speaker}: ${String(t.text || '').slice(0, 140)}`);

  const summaryEntry = {
    id: safeFileId(sessionObj.id),
    projectId: project.id,
    meetingTitle: String(sessionObj.meetingTitle || sessionObj.topic || 'Reunião de Walkthrough').trim(),
    topic: String(sessionObj.topic || '').trim(),
    scope: String(sessionObj.scope || '').trim(),
    participants: String(sessionObj.participants || '').trim(),
    createdAt: sessionObj.createdAt || now,
    updatedAt: now,
    counts: {
      transcript: transcriptArr.length,
      topics: questionsArr.length,
      risks: Array.isArray(sessionObj.risks) ? sessionObj.risks.length : 0,
      controls: Array.isArray(sessionObj.controls) ? sessionObj.controls.length : 0,
      pbc: Array.isArray(sessionObj.pbcList) ? sessionObj.pbcList.length : 0
    },
    recentTopics,
    recentQuotes
  };

  idx.sessions = [summaryEntry, ...idx.sessions.filter((s) => s.id !== summaryEntry.id)];
  writeProjectsIndex(idx);
  return { project, sessionSummary: summaryEntry };
}

function searchSessionsOnDisk(queryStr) {
  const q = String(queryStr || '').trim().toLowerCase();
  const idx = readProjectsIndex();
  if (!q) return { ...idx, searchHits: {} };

  const searchHits = {};
  for (const s of idx.sessions) {
    try {
      const raw = JSON.parse(fs.readFileSync(sessionFilePath(s.id), 'utf8'));
      const matchedLines = (raw.transcript || [])
        .filter((t) => String(t.text || '').toLowerCase().includes(q) || String(t.speaker || '').toLowerCase().includes(q))
        .slice(0, 4)
        .map((t) => `[T${t.seq} • ${t.time}] ${t.speaker}: ${t.text}`);
      const matchedTopics = (raw.questions || [])
        .filter((item) => String(item.topicTitle || '').toLowerCase().includes(q) || String(item.topicSummary || '').toLowerCase().includes(q))
        .slice(0, 3)
        .map((item) => item.topicTitle);
      if (matchedLines.length || matchedTopics.length) {
        searchHits[s.id] = { matchedLines, matchedTopics };
      }
    } catch (_) {}
  }
  return { ...idx, searchHits };
}

// ---------------------------------------------------------------------------
// Roteamento
// ---------------------------------------------------------------------------
async function handleApi(req, res, urlPath) {
  if (!isTrustedApiRequest(req)) {
    sendJson(res, 403, { error: { message: 'Origem não autorizada.' } });
    return;
  }

  try {
    if (req.method === 'GET' && urlPath === '/api/config') {
      const cfg = readConfig();
      sendJson(res, 200, {
        claude: Boolean(getClaudeKey()),
        gemini: Boolean(getGeminiKey()),
        transcribe: true,
        claudeFromEnv: Boolean(process.env.ANTHROPIC_API_KEY),
        geminiFromEnv: Boolean(process.env.GEMINI_API_KEY),
        hasConfigFile: Object.keys(cfg).length > 0
      });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/config') {
      const body = await readBody(req);
      const cfg = readConfig();
      for (const [field, prop] of [['claudeApiKey', 'claudeApiKey'], ['geminiApiKey', 'geminiApiKey']]) {
        if (body[field] === null) {
          delete cfg[prop];
        } else if (typeof body[field] === 'string' && body[field].trim()) {
          cfg[prop] = body[field].trim();
        }
      }
      writeConfig(cfg);
      sendJson(res, 200, { ok: true, claude: Boolean(getClaudeKey()), gemini: Boolean(getGeminiKey()), transcribe: true });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/transcribe') {
      const body = await readBody(req);
      const base64 = String(body.audioBase64 || '').trim();
      if (!base64 || base64.length < 200) {
        sendJson(res, 200, { text: '' });
        return;
      }
      const audioBuffer = Buffer.from(base64, 'base64');
      const text = await transcribeAudioBuffer(audioBuffer, body.mimeType || 'audio/wav');
      sendJson(res, 200, { text });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/claude/message') {
      const body = await readBody(req);
      const result = await handleClaudeMessage(body);
      sendJson(res, result.status, result.payload);
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/claude/test') {
      const result = await handleClaudeTest();
      sendJson(res, result.status, result.payload);
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/gemini') {
      const body = await readBody(req);
      const result = await forwardToGemini(body.model, body.payload);
      res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(result.body);
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/export') {
      const body = await readBody(req);
      const result = await generateOfficeDocument(body.mode, body.data);
      res.writeHead(200, {
        'Content-Type': result.mime,
        'Content-Length': result.buffer.length,
        'Cache-Control': 'no-store'
      });
      res.end(result.buffer);
      return;
    }

    // --- Projetos & Histórico em Disco ---
    if (req.method === 'GET' && urlPath === '/api/projects') {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const q = u.searchParams.get('q') || '';
      sendJson(res, 200, searchSessionsOnDisk(q));
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/projects/save') {
      const body = await readBody(req);
      const out = saveProjectMeta(body || {});
      sendJson(res, 200, { ok: true, ...out });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/projects/delete') {
      const body = await readBody(req);
      const pid = safeFileId(body.projectId);
      const idx = readProjectsIndex();
      const toRemove = idx.sessions.filter((s) => s.projectId === pid);
      toRemove.forEach((s) => {
        try { fs.unlinkSync(sessionFilePath(s.id)); } catch (_) {}
      });
      idx.projects = idx.projects.filter((p) => p.id !== pid);
      idx.sessions = idx.sessions.filter((s) => s.projectId !== pid);
      writeProjectsIndex(idx);
      sendJson(res, 200, { ok: true, index: idx });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/projects/session') {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const sid = u.searchParams.get('id') || '';
      const fpath = sessionFilePath(sid);
      if (!fs.existsSync(fpath)) {
        sendJson(res, 404, { error: { message: 'Reunião não encontrada no disco.' } });
        return;
      }
      const sessionData = JSON.parse(fs.readFileSync(fpath, 'utf8'));
      sendJson(res, 200, { session: sessionData });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/projects/session') {
      const body = await readBody(req);
      const result = saveSessionToDisk(body.session || body);
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/projects/session/delete') {
      const body = await readBody(req);
      const sid = safeFileId(body.sessionId);
      try { fs.unlinkSync(sessionFilePath(sid)); } catch (_) {}
      const idx = readProjectsIndex();
      idx.sessions = idx.sessions.filter((s) => s.id !== sid);
      writeProjectsIndex(idx);
      sendJson(res, 200, { ok: true, index: idx });
      return;
    }

    sendJson(res, 404, { error: { message: 'Endpoint não encontrado.' } });
  } catch (err) {
    if (err && err.status && !(err instanceof Anthropic.APIError)) {
      sendJson(res, err.status, { error: { message: err.message } });
      return;
    }
    const info = describeAnthropicError(err);
    console.log(`[API ${info.status}] ${info.message}`);
    if (err instanceof Anthropic.APIConnectionError && err.cause) console.log('  causa:', String(err.cause.message || err.cause));
    sendJson(res, info.status, { error: { message: info.message } });
  }
}

function serveStatic(req, res, urlPath) {
  const entry = STATIC_FILES[urlPath];
  if (!entry || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 - Arquivo não encontrado');
    return;
  }
  fs.readFile(path.join(ROOT, entry.file), (error, content) => {
    if (error) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Erro interno do servidor.');
      return;
    }
    res.writeHead(200, {
      'Content-Type': entry.type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer'
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = String(req.url || '/').split('?')[0];
  if (urlPath.startsWith('/api/')) {
    handleApi(req, res, urlPath);
    return;
  }
  serveStatic(req, res, urlPath);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} já está em uso. O AuditPrompter provavelmente já está aberto em http://localhost:${PORT}`);
  } else {
    console.error('Erro no servidor:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log('==============================================================');
  console.log('  AUDITPROMPTER - Copiloto & Teleprompter de Auditoria');
  console.log(`  Servidor local ativo em: ${url} (somente este computador)`);
  console.log(`  Chaves em: ${CONFIG_PATH}`);
  console.log(`  Anthropic: ${getClaudeKey() ? 'chave configurada' : 'sem chave'} | Gemini: ${getGeminiKey() ? 'chave configurada' : 'sem chave'} | Transcrição Local: ATIVA`);
  console.log('==============================================================');
  if (process.argv.includes('--open')) {
    exec(`start "" "${url}"`);
  }
});
