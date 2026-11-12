/**
 * AuditPrompter — servidor local.
 *
 * - Escuta SOMENTE em 127.0.0.1 (não fica exposto na rede do cliente).
 * - Serve apenas uma lista fechada de arquivos estáticos (sem path traversal).
 * - Guarda as chaves de API em %APPDATA%\AuditPrompter\config.json (ou variáveis de ambiente);
 *   as chaves nunca são devolvidas ao navegador.
 * - Transcreve o áudio 100% localmente com Whisper (faster-whisper) via /api/transcribe — o áudio não sai do computador.
 *   O reconhecimento gratuito do Google continua disponível, mas só quando o auditor escolhe explicitamente (engine "google").
 * - Faz o proxy das chamadas para Anthropic (SDK oficial, com streaming) e Google Gemini.
 * - Guarda projetos, reuniões e prints de evidência FORA da pasta do programa (e do OneDrive):
 *   %LOCALAPPDATA%\AuditPrompter\projetos_auditoria (ou a pasta indicada em AUDITPROMPTER_DATA_DIR).
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile, spawn } = require('child_process');
const readline = require('readline');
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
  '/extras.js': { file: 'extras.js', type: 'application/javascript; charset=utf-8' },
  '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
  '/logo-af.png': { file: 'logo-af.png', type: 'image/png' }
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
// Transcrição 100% LOCAL — Whisper (faster-whisper) em processo Python persistente
// ---------------------------------------------------------------------------
const WHISPER_MODEL = process.env.AUDITPROMPTER_WHISPER_MODEL || 'small';
const whisper = {
  available: false,
  proc: null,
  loaded: false,
  loading: false,
  pending: new Map()
};

function checkWhisperAvailable() {
  return new Promise((resolve) => {
    execFile('python', ['-c', 'import faster_whisper'], { timeout: 60000 }, (err) => {
      whisper.available = !err;
      resolve(whisper.available);
    });
  });
}

// A verificação leva alguns segundos na partida. Quem pergunta o estado (a tela, ao abrir) espera por ela,
// para não receber "Whisper não instalado" só porque a checagem ainda não terminou.
let whisperCheckPromise = null;
function whisperReady() {
  if (!whisperCheckPromise) whisperCheckPromise = checkWhisperAvailable();
  return whisperCheckPromise;
}

function ensureWhisperWorker() {
  if (whisper.proc) return whisper.proc;
  const proc = spawn('python', ['-u', path.join(ROOT, 'transcribe_worker.py')], {
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', AUDITPROMPTER_WHISPER_MODEL: WHISPER_MODEL },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  whisper.proc = proc;
  whisper.loaded = false;
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return;
    }
    if (msg.loaded) {
      whisper.loaded = true;
      whisper.loading = false;
      console.log(`[Whisper] Modelo "${msg.model}" carregado — transcrição local pronta.`);
      return;
    }
    const job = msg.id && whisper.pending.get(msg.id);
    if (!job) return;
    if (msg.segment) {
      if (job.onSegment) job.onSegment(msg.segment, msg.duration);
      return;
    }
    whisper.pending.delete(msg.id);
    whisper.loaded = true;
    whisper.loading = false;
    if (msg.error) job.reject(new Error(msg.error));
    else job.resolve(String(msg.text || ''));
  });
  let stderrTail = '';
  proc.stderr.on('data', (d) => {
    stderrTail = (stderrTail + String(d)).slice(-600);
  });
  const fail = (reason) => {
    if (whisper.proc === proc) whisper.proc = null;
    whisper.loaded = false;
    whisper.loading = false;
    for (const [, job] of whisper.pending) job.reject(new Error(reason));
    whisper.pending.clear();
  };
  proc.on('error', (err) => fail(`Não foi possível iniciar o Whisper local: ${err.message}`));
  proc.on('exit', (code) => fail(`O processo do Whisper local encerrou (código ${code}). ${stderrTail.trim().split('\n').pop() || ''}`));
  return proc;
}

// Carrega o modelo em segundo plano para a primeira fala não esperar o carregamento.
function warmupWhisper() {
  if (!whisper.available || whisper.loaded || whisper.loading) return;
  whisper.loading = true;
  try {
    ensureWhisperWorker().stdin.write(JSON.stringify({ cmd: 'warmup' }) + '\n');
  } catch (_) {
    whisper.loading = false;
  }
}

function whisperTranscribeFile(filePath, { prompt = '', stream = false, onSegment = null } = {}) {
  return new Promise((resolve, reject) => {
    if (!whisper.available) {
      reject(Object.assign(new Error('Whisper local não instalado. Rode: pip install faster-whisper'), { status: 503 }));
      return;
    }
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    whisper.pending.set(id, { resolve, reject, onSegment });
    try {
      ensureWhisperWorker().stdin.write(JSON.stringify({ id, path: filePath, prompt: String(prompt || '').slice(0, 600), stream }) + '\n');
    } catch (err) {
      whisper.pending.delete(id);
      reject(err);
    }
  });
}

async function transcribeLocalWhisper(audioBuffer, mimeType, prompt) {
  const id = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const mt = String(mimeType || '');
  const ext = mt.includes('wav') ? 'wav' : mt.includes('ogg') ? 'ogg' : 'webm';
  const tmpIn = path.join(os.tmpdir(), `audit_wh_${id}.${ext}`);
  fs.writeFileSync(tmpIn, audioBuffer);
  try {
    const text = await whisperTranscribeFile(tmpIn, { prompt });
    if (text) console.log(`[Transcrição local]: "${text.slice(0, 120)}"`);
    return text;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch (_) {}
  }
}

// --- Importação de gravações (áudio/vídeo) com progresso -------------------
const importJobs = new Map();

function startAudioImportJob(filePath, prompt) {
  const jobId = 'imp-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const job = { id: jobId, segments: [], duration: 0, done: false, error: '' };
  importJobs.set(jobId, job);
  whisperTranscribeFile(filePath, {
    prompt,
    stream: true,
    onSegment: (seg, duration) => {
      job.segments.push(seg);
      if (duration) job.duration = duration;
    }
  })
    .catch((err) => {
      job.error = err.message;
    })
    .finally(() => {
      job.done = true;
      try { fs.unlinkSync(filePath); } catch (_) {}
      setTimeout(() => importJobs.delete(jobId), 30 * 60 * 1000);
    });
  return job;
}

function receiveUploadToTempFile(req, ext) {
  return new Promise((resolve, reject) => {
    const MAX = 2 * 1024 * 1024 * 1024;
    const safeExt = /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'bin';
    const tmp = path.join(os.tmpdir(), `audit_imp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${safeExt}`);
    const out = fs.createWriteStream(tmp);
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        req.destroy();
        out.destroy();
        try { fs.unlinkSync(tmp); } catch (_) {}
        reject(Object.assign(new Error('Arquivo maior que 2 GB.'), { status: 413 }));
      }
    });
    req.pipe(out);
    out.on('finish', () => resolve({ path: tmp, size }));
    out.on('error', reject);
    req.on('error', reject);
  });
}

function extractDocxText(buffer) {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `audit_docx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.docx`);
    fs.writeFileSync(tmp, buffer);
    const py = [
      'import sys, docx',
      'sys.stdout.reconfigure(encoding="utf-8")',
      'd = docx.Document(sys.argv[1])',
      'out = [p.text for p in d.paragraphs]',
      'for t in d.tables:',
      '    for r in t.rows:',
      '        out.append(" | ".join(c.text.strip() for c in r.cells))',
      'print(chr(10).join(out))'
    ].join('\n');
    execFile('python', ['-c', py, tmp], { timeout: 30000, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(tmp); } catch (_) {}
      if (err) reject(new Error(`Não foi possível ler o arquivo Word: ${String(stderr || err.message).trim().split('\n').pop()}`));
      else resolve(String(stdout || ''));
    });
  });
}

// ---------------------------------------------------------------------------
// Transcrição pelo reconhecimento gratuito do Google (NUVEM — só por escolha explícita).
// O áudio é enviado aos servidores do Google. Não é usado por padrão.
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

// Versão em streaming (NDJSON) para os insights ao vivo: o navegador recebe o texto à medida que é gerado.
//   {"d": "pedaço de texto"} ... {"done": true, "text": "...", "model": "..."}  |  {"error": "mensagem"}
async function handleClaudeStream(body, req, res) {
  const client = getAnthropicClient();
  if (!client) {
    sendJson(res, 400, { error: { message: 'Chave Anthropic não configurada no servidor local.' } });
    return;
  }

  const model = ALLOWED_CLAUDE_MODELS.has(body.model) ? body.model : 'claude-sonnet-5-5';
  const effort = ALLOWED_EFFORT.has(body.effort) ? body.effort : 'low';
  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 8000, 256), 16000);

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
    output_config: { effort },
    stream: true
  };
  if (systemBlocks.length > 0) params.system = systemBlocks;
  if (body.schema && typeof body.schema === 'object') {
    params.output_config.format = { type: 'json_schema', schema: body.schema };
  }
  // No modo rápido, o Haiku 5.5 responde sem a etapa de raciocínio (menor tempo até o 1º texto).
  if (body.fast && model === 'claude-haiku-5-5') params.thinking = { type: 'disabled' };

  const useFallbacks = MODELS_WITH_FALLBACK.has(model);
  const open = (p) =>
    useFallbacks
      ? client.beta.messages.create({ ...p, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : client.messages.create(p);

  let stream;
  try {
    stream = await open(params);
  } catch (err) {
    if (err instanceof Anthropic.BadRequestError && params.thinking) {
      console.log(`[API stream] ${model} não aceitou o modo sem raciocínio (${String(err.message).slice(0, 140)}); repetindo no modo padrão.`);
      delete params.thinking;
      stream = await open(params);
    } else {
      throw err;
    }
  }

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  let finished = false;
  res.on('close', () => {
    if (!finished) {
      try { stream.controller.abort(); } catch (_) {}
    }
  });

  let text = '';
  let stopReason = '';
  let usedModel = model;
  try {
    for await (const ev of stream) {
      if (ev.type === 'message_start') {
        usedModel = (ev.message && ev.message.model) || usedModel;
      } else if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') {
        text += ev.delta.text;
        res.write(JSON.stringify({ d: ev.delta.text }) + '\n');
      } else if (ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) {
        stopReason = ev.delta.stop_reason;
      }
    }
    if (stopReason === 'refusal') {
      res.write(JSON.stringify({ error: 'O modelo recusou esta solicitação. Reformule o trecho ou use o motor local.' }) + '\n');
    } else {
      res.write(JSON.stringify({ done: true, text, model: usedModel, stop_reason: stopReason }) + '\n');
    }
  } catch (err) {
    const info = describeAnthropicError(err);
    console.log(`[API stream ${info.status}] ${info.message}`);
    res.write(JSON.stringify({ error: info.message }) + '\n');
  }
  finished = true;
  res.end();
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
// Os dados de auditoria ficam fora da pasta do programa (que pode estar no OneDrive/Git):
//   Windows: %LOCALAPPDATA%\AuditPrompter\projetos_auditoria   |   outros: ~/.auditprompter/projetos_auditoria
// Para usar outra pasta (ex.: unidade criptografada), defina AUDITPROMPTER_DATA_DIR.
const DATA_DIR_FROM_ENV = Boolean(process.env.AUDITPROMPTER_DATA_DIR);
const PROJECTS_DIR = DATA_DIR_FROM_ENV
  ? path.resolve(process.env.AUDITPROMPTER_DATA_DIR)
  : path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'AuditPrompter') : path.join(os.homedir(), '.auditprompter'), 'projetos_auditoria');
const PROJECTS_SESSIONS_DIR = path.join(PROJECTS_DIR, 'sessoes');
const PROJECTS_INDEX_PATH = path.join(PROJECTS_DIR, 'index.json');
const EVIDENCE_DIR = path.join(PROJECTS_DIR, 'evidencias');
const LEGACY_PROJECTS_DIRS = [path.join(ROOT, 'projetos_auditoria'), path.join(ROOT, '..', 'projetos_auditoria')];
let migratedFromLegacy = '';

// Primeira execução: COPIA (não move) o histórico da pasta antiga para a nova pasta de dados.
function migrateLegacyProjectsOnce() {
  if (DATA_DIR_FROM_ENV || fs.existsSync(PROJECTS_INDEX_PATH)) return;
  for (const legacy of LEGACY_PROJECTS_DIRS) {
    try {
      if (path.resolve(legacy) !== path.resolve(PROJECTS_DIR) && fs.existsSync(path.join(legacy, 'index.json'))) {
        fs.mkdirSync(PROJECTS_DIR, { recursive: true });
        fs.cpSync(legacy, PROJECTS_DIR, { recursive: true });
        migratedFromLegacy = path.resolve(legacy);
        return;
      }
    } catch (err) {
      console.error('Não foi possível copiar o histórico antigo:', err.message);
    }
  }
}

function ensureProjectsStorage() {
  migrateLegacyProjectsOnce();
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

function sessionMtime(fpath) {
  try {
    return fs.statSync(fpath).mtimeMs;
  } catch (_) {
    return null;
  }
}

// knownMtime: data de modificação do arquivo que o navegador viu por último. Se o arquivo mudou
// desde então (ex.: um agente na IDE editou o JSON), a gravação é recusada com "conflict" para o
// navegador mesclar as alterações externas em vez de sobrescrevê-las.
function saveSessionToDisk(sessionObj, { knownMtime = null, force = false } = {}) {
  if (!sessionObj || !sessionObj.id) {
    throw Object.assign(new Error('Objeto de sessão inválido.'), { status: 400 });
  }
  const targetPath = sessionFilePath(sessionObj.id);
  const currentMtime = sessionMtime(targetPath);
  if (!force && currentMtime !== null && (knownMtime === null || Math.abs(currentMtime - Number(knownMtime)) > 2)) {
    let diskSession = null;
    try {
      diskSession = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    } catch (_) {}
    if (diskSession) return { conflict: true, session: diskSession, mtime: currentMtime };
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
  return { project, sessionSummary: summaryEntry, mtime: sessionMtime(fpath) };
}

// --- Prints de evidência (quadro da tela compartilhada) ---------------------
function evidencePath(sessionId, evidenceId) {
  const sid = safeFileId(sessionId);
  const eid = safeFileId(evidenceId);
  if (!sid || !eid) throw Object.assign(new Error('Identificador de evidência inválido.'), { status: 400 });
  return path.join(EVIDENCE_DIR, sid, `${eid}.jpg`);
}

function removeEvidenceDir(sessionId) {
  const sid = safeFileId(sessionId);
  if (!sid) return;
  try { fs.rmSync(path.join(EVIDENCE_DIR, sid), { recursive: true, force: true }); } catch (_) {}
}

// --- Visão consolidada do projeto (memória entre reuniões) ------------------
function normKey(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function consolidateProject(projectId) {
  const pid = safeFileId(projectId);
  const idx = readProjectsIndex();
  const project = idx.projects.find((p) => p.id === pid) || null;
  const summaries = idx.sessions.filter((s) => s.projectId === pid).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const meetings = [];
  const risks = new Map();
  const controls = new Map();
  const pbc = new Map();
  const openPoints = new Map();

  for (const sum of summaries) {
    let ses;
    try {
      ses = JSON.parse(fs.readFileSync(sessionFilePath(sum.id), 'utf8'));
    } catch (_) {
      continue;
    }
    const title = String(ses.meetingTitle || ses.topic || 'Reunião');
    const questions = Array.isArray(ses.questions) ? ses.questions : [];
    meetings.push({
      id: sum.id,
      title,
      createdAt: ses.createdAt || sum.createdAt,
      participants: String(ses.participants || ''),
      transcriptCount: Array.isArray(ses.transcript) ? ses.transcript.length : 0,
      topics: questions.filter((q) => q.asked || q.origin === 'ia' || q.origin === 'local').map((q) => q.topicTitle || q.category).filter(Boolean).slice(0, 12),
      statements: questions
        .filter((q) => q.topicSummary && (q.origin === 'ia' || q.asked))
        .map((q) => `${q.topicTitle || q.category}: ${q.topicSummary}`.slice(0, 280))
        .slice(0, 10)
    });

    const riskById = {};
    (ses.risks || []).forEach((r) => {
      const key = normKey(r.title);
      if (!key) return;
      riskById[r.id] = key;
      const cur = risks.get(key) || { title: r.title, severity: r.severity, description: r.description || '', recommendation: r.recommendation || '', assertion: r.assertion || '', validated: false, meetings: [], controls: [] };
      cur.severity = r.severity || cur.severity;
      cur.description = r.description || cur.description;
      cur.recommendation = r.recommendation || cur.recommendation;
      cur.validated = cur.validated || Boolean(r.validated);
      if (!cur.meetings.includes(title)) cur.meetings.push(title);
      risks.set(key, cur);
    });
    (ses.controls || []).forEach((c) => {
      const key = normKey(c.name);
      if (!key) return;
      const cur = controls.get(key) || { name: c.name, type: c.type, nature: c.nature, frequency: c.frequency, owner: c.owner || '', status: c.status, validated: false, meetings: [], riskKeys: [] };
      cur.status = c.status || cur.status;
      cur.owner = c.owner || cur.owner;
      cur.validated = cur.validated || Boolean(c.validated);
      if (!cur.meetings.includes(title)) cur.meetings.push(title);
      (c.riskIds || []).forEach((rid) => {
        const rk = riskById[rid];
        if (rk && !cur.riskKeys.includes(rk)) cur.riskKeys.push(rk);
      });
      controls.set(key, cur);
    });
    (ses.pbcList || []).forEach((p) => {
      const key = normKey(p.title);
      if (!key) return;
      pbc.set(key, { title: p.title, status: p.status || 'Pendente', owner: p.owner || '', dueDate: p.dueDate || '', category: p.category || '', meeting: title });
    });
    (ses.openPoints || []).forEach((o) => {
      const key = normKey(o.text);
      if (!key) return;
      const cur = openPoints.get(key);
      // A situação mais recente prevalece (uma reunião posterior pode ter resolvido o ponto).
      openPoints.set(key, { text: o.text, kind: o.kind || 'pendencia', status: o.status || 'aberto', meeting: (cur && cur.meeting) || o.fromMeeting || title, sessionId: sum.id });
    });
  }

  const controlList = Array.from(controls.values());
  const riskList = Array.from(risks.entries()).map(([key, r]) => ({
    ...r,
    controls: controlList.filter((c) => c.riskKeys.includes(key)).map((c) => c.name)
  }));
  return {
    project,
    meetings,
    risks: riskList,
    controls: controlList.map((c) => ({ ...c, risks: c.riskKeys.map((k) => (risks.get(k) || {}).title).filter(Boolean), riskKeys: undefined })),
    pbc: Array.from(pbc.values()),
    openPoints: Array.from(openPoints.values())
  };
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
      await whisperReady();
      const cfg = readConfig();
      sendJson(res, 200, {
        claude: Boolean(getClaudeKey()),
        gemini: Boolean(getGeminiKey()),
        transcribe: true,
        whisper: whisper.available,
        whisperLoaded: whisper.loaded,
        whisperModel: WHISPER_MODEL,
        dataDir: PROJECTS_DIR,
        migratedFrom: migratedFromLegacy,
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
      // Padrão: Whisper local. O Google só é usado quando o navegador pede explicitamente engine "google".
      if (body.engine === 'google') {
        const text = await transcribeAudioBuffer(audioBuffer, body.mimeType || 'audio/wav');
        sendJson(res, 200, { text, engine: 'google' });
        return;
      }
      if (!whisper.available) {
        sendJson(res, 503, { error: { message: 'Whisper local não instalado neste computador (pip install faster-whisper).' } });
        return;
      }
      const text = await transcribeLocalWhisper(audioBuffer, body.mimeType || 'audio/wav', body.prompt || '');
      sendJson(res, 200, { text, engine: 'whisper' });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/whisper/warmup') {
      if (!whisper.available) await checkWhisperAvailable();
      warmupWhisper();
      sendJson(res, 200, { whisper: whisper.available, loaded: whisper.loaded, model: WHISPER_MODEL });
      return;
    }

    // --- Importação de transcrições e gravações ---
    if (req.method === 'POST' && urlPath === '/api/import/docx') {
      const body = await readBody(req);
      const text = await extractDocxText(Buffer.from(String(body.dataBase64 || ''), 'base64'));
      sendJson(res, 200, { text });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/import/audio') {
      if (!whisper.available) {
        req.resume();
        sendJson(res, 503, { error: { message: 'Whisper local não instalado neste computador (pip install faster-whisper).' } });
        return;
      }
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const ext = String(u.searchParams.get('ext') || 'bin').toLowerCase();
      const prompt = String(u.searchParams.get('prompt') || '');
      const uploaded = await receiveUploadToTempFile(req, ext);
      const job = startAudioImportJob(uploaded.path, prompt);
      sendJson(res, 200, { jobId: job.id, size: uploaded.size });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/import/status') {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const job = importJobs.get(u.searchParams.get('id') || '');
      if (!job) {
        sendJson(res, 404, { error: { message: 'Importação não encontrada (o servidor foi reiniciado?).' } });
        return;
      }
      const from = Math.max(0, Number(u.searchParams.get('from')) || 0);
      sendJson(res, 200, { segments: job.segments.slice(from), total: job.segments.length, duration: job.duration, done: job.done, error: job.error });
      return;
    }

    // --- Prints de evidência da tela compartilhada ---
    if (req.method === 'POST' && urlPath === '/api/evidence') {
      const body = await readBody(req);
      const evidenceId = `ev-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      const fpath = evidencePath(body.sessionId, evidenceId);
      const buf = Buffer.from(String(body.imageBase64 || ''), 'base64');
      if (buf.length < 500 || buf[0] !== 0xff || buf[1] !== 0xd8) {
        sendJson(res, 400, { error: { message: 'Imagem inválida (esperado JPEG).' } });
        return;
      }
      fs.mkdirSync(path.dirname(fpath), { recursive: true });
      fs.writeFileSync(fpath, buf);
      sendJson(res, 200, { ok: true, id: evidenceId, bytes: buf.length });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/evidence') {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      const fpath = evidencePath(u.searchParams.get('session'), u.searchParams.get('id'));
      if (!fs.existsSync(fpath)) {
        sendJson(res, 404, { error: { message: 'Print não encontrado.' } });
        return;
      }
      const img = fs.readFileSync(fpath);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': img.length, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      res.end(img);
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/claude/stream') {
      const body = await readBody(req);
      await handleClaudeStream(body, req, res);
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
      // Resolve no servidor o caminho dos prints de evidência (o navegador só conhece os IDs).
      if (body.data && Array.isArray(body.data.moments)) {
        body.data.moments.forEach((m) => {
          delete m.shotPath;
          if (!m.shotId) return;
          try {
            const p = evidencePath(body.data.sessionId, m.shotId);
            if (fs.existsSync(p)) m.shotPath = p;
          } catch (_) {}
        });
      }
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
        removeEvidenceDir(s.id);
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
      sendJson(res, 200, { session: sessionData, mtime: sessionMtime(fpath) });
      return;
    }

    if (req.method === 'GET' && urlPath === '/api/projects/consolidated') {
      const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
      sendJson(res, 200, consolidateProject(u.searchParams.get('projectId') || ''));
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/projects/session') {
      const body = await readBody(req);
      const hasEnvelope = Boolean(body.session);
      const result = saveSessionToDisk(body.session || body, {
        knownMtime: hasEnvelope && typeof body.knownMtime === 'number' ? body.knownMtime : null,
        force: hasEnvelope ? Boolean(body.force) : true
      });
      if (result.conflict) {
        sendJson(res, 409, result);
        return;
      }
      sendJson(res, 200, { ok: true, ...result });
      return;
    }

    if (req.method === 'POST' && urlPath === '/api/projects/session/delete') {
      const body = await readBody(req);
      const sid = safeFileId(body.sessionId);
      try { fs.unlinkSync(sessionFilePath(sid)); } catch (_) {}
      removeEvidenceDir(sid);
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
  console.log('  Criado por Auditor do Futuro (Jefferson Cavalcante) - aiauditor.com.br');
  console.log(`  Servidor local ativo em: ${url} (somente este computador)`);
  console.log(`  Chaves em: ${CONFIG_PATH}`);
  console.log(`  Dados das auditorias em: ${PROJECTS_DIR}`);
  console.log(`  Anthropic: ${getClaudeKey() ? 'chave configurada' : 'sem chave'} | Gemini: ${getGeminiKey() ? 'chave configurada' : 'sem chave'}`);
  console.log('==============================================================');
  ensureProjectsStorage();
  if (migratedFromLegacy) console.log(`  Histórico copiado de ${migratedFromLegacy} para a nova pasta de dados (o original foi mantido).`);
  whisperReady().then((ok) => {
    console.log(
      ok
        ? `  Transcrição local (Whisper "${WHISPER_MODEL}"): disponível — o áudio não sai deste computador.`
        : '  Transcrição local (Whisper): NÃO instalada. Rode "pip install faster-whisper" para transcrever sem enviar áudio à nuvem.'
    );
    if (ok) warmupWhisper();
  });
  if (process.argv.includes('--open')) {
    exec(`start "" "${url}"`);
  }
});
