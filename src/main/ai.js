'use strict';

// AI commit messages: the staged diff goes to a provider the user picked,
// with their own API key, and a commit message comes back.
//
// Nothing here runs unless the user presses Generate. Keys live in the
// KeyVault (encrypted with the OS keychain via Electron's safeStorage) and
// never reach the renderer; the renderer only learns whether one is saved.

const PROVIDERS = [
  { id: 'openai', name: 'OpenAI', api: 'openai', base: 'https://api.openai.com/v1', needsKey: true, model: 'gpt-5-mini', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', name: 'Anthropic', api: 'anthropic', base: 'https://api.anthropic.com/v1', needsKey: true, model: 'claude-haiku-5-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openrouter', name: 'OpenRouter', api: 'openai', base: 'https://openrouter.ai/api/v1', needsKey: true, model: 'openai/gpt-5-mini', keyUrl: 'https://openrouter.ai/settings/keys' },
  { id: 'gemini', name: 'Google Gemini', api: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true, model: 'gemini-2.5-flash', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'ollama', name: 'Ollama (on this computer)', api: 'ollama', base: 'http://localhost:11434', needsKey: false, model: 'llama3.2', customBase: true },
  { id: 'custom', name: 'OpenAI-compatible endpoint', api: 'openai', base: '', needsKey: false, optionalKey: true, model: '', customBase: true },
];
const PROVIDER = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

const MAX_DIFF_CHARS = 24000;
const MAX_FILE_CHARS = 5000;
const TIMEOUT_MS = 60000;

// Changes nobody wants summarised line by line.
const NOISY = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|Gemfile\.lock|poetry\.lock|composer\.lock|go\.sum|Podfile\.lock|[^/]+\.min\.(js|css)|[^/]+\.map)$/;

class AiError extends Error {
  constructor(message, kind = 'AI_ERROR') {
    super(message);
    this.kind = kind;
  }
}

/**
 * Shrink a unified diff to fit a prompt: lockfiles and minified files are
 * reduced to a note, each file is capped, and the whole is capped.
 */
function condenseDiff(diff, { maxChars = MAX_DIFF_CHARS, perFile = MAX_FILE_CHARS } = {}) {
  const parts = String(diff || '').split(/^(?=diff --git )/m).filter((p) => p.trim());
  const out = [];
  let used = 0;
  let dropped = 0;
  for (const part of parts) {
    const file = (part.match(/^diff --git a\/(.+?) b\/(.+)$/m) || [])[2] || '';
    let chunk = part;
    if (NOISY.test(file) || /^Binary files /m.test(part)) {
      const head = part.split('\n').slice(0, 1).join('\n');
      chunk = `${head}\n(${/^Binary files /m.test(part) ? 'binary file' : 'generated file'} changed; contents omitted)\n`;
    } else if (chunk.length > perFile) {
      chunk = `${chunk.slice(0, perFile).replace(/\n[^\n]*$/, '')}\n… (${chunk.length - perFile} more characters of this file omitted)\n`;
    }
    if (used + chunk.length > maxChars) {
      dropped++;
      continue;
    }
    out.push(chunk);
    used += chunk.length;
  }
  if (dropped) out.push(`… (${dropped} more file${dropped === 1 ? '' : 's'} omitted for length)\n`);
  return out.join('');
}

/** The instructions and the material, as a system and a user message. */
function buildPrompt({ diff, files = [], branch = null, recent = [], instructions = '', amend = false }) {
  const system = [
    'You write Git commit messages.',
    'Reply with the commit message only: no preamble, no Markdown, no code fences, no quotes.',
    'First line: a summary of the change in the imperative mood ("Add", "Fix", "Remove"), at most 72 characters, no trailing full stop.',
    'If the change needs explaining, add a blank line and then a short body, wrapped at 72 characters, saying what changed and why. Skip the body for small, obvious changes.',
    'Describe what the diff actually does. Do not invent motivation, tickets or test results.',
    'If the recent commits follow a convention (for example Conventional Commits like "feat: …" or a ticket prefix), follow it.',
    instructions && String(instructions).trim() ? `The user's own instructions, which take priority over the style rules above:\n${String(instructions).trim()}` : '',
  ].filter(Boolean).join('\n');

  const lines = [];
  if (amend) lines.push('This message replaces the message of the commit being amended; describe the whole commit.');
  if (branch) lines.push(`Branch: ${branch}`);
  if (recent.length) lines.push(`Recent commit subjects on this branch:\n${recent.map((s) => `- ${s}`).join('\n')}`);
  if (files.length) lines.push(`Files in this commit:\n${files.map((f) => `${f.status || 'M'} ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ''}`).join('\n')}`);
  lines.push(`Staged diff:\n${condenseDiff(diff)}`);
  return { system, user: lines.join('\n\n') };
}

/** Clean a model's reply into { summary, description }. */
function parseMessage(text) {
  let t = String(text || '').replace(/\r\n?/g, '\n').trim();
  // Reasoning models sometimes leak their thinking in tags.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const fenced = t.match(/^```[\w-]*\n([\s\S]*?)\n?```$/);
  if (fenced) t = fenced[1].trim();
  t = t.replace(/^(?:commit message|message)\s*:\s*/i, '').trim();
  if (/^(["'`])[\s\S]*\1$/.test(t) && !t.slice(1, -1).includes(t[0])) t = t.slice(1, -1).trim();
  const [first = '', ...rest] = t.split('\n');
  const summary = first.replace(/^#+\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1').replace(/\.$/, '').trim();
  const description = rest.join('\n').replace(/^\n+/, '').replace(/\s+$/, '');
  if (!summary) throw new AiError('The model replied without a commit message.', 'AI_EMPTY');
  return { summary, description };
}

function baseFor(provider, baseUrl) {
  const base = (provider.customBase && baseUrl ? baseUrl : provider.base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(base)) throw new AiError(provider.id === 'custom' ? 'Enter the endpoint’s base URL, like http://localhost:1234/v1.' : 'Invalid base URL.', 'AI_CONFIG');
  return base;
}

/** What an HTTP failure means, in words someone can act on. */
async function failure(res, provider) {
  let detail = '';
  try {
    const body = await res.text();
    try {
      const j = JSON.parse(body);
      detail = (j.error && (j.error.message || (typeof j.error === 'string' ? j.error : ''))) || j.message || '';
    } catch {
      detail = body.slice(0, 200);
    }
  } catch {}
  const name = provider.name;
  const say = (msg, kind) => new AiError(detail ? `${msg} (${detail.trim().slice(0, 240)})` : msg, kind);
  if (res.status === 401 || res.status === 403) return say(`${name} rejected the API key.`, 'AI_AUTH');
  if (res.status === 404) return say(`${name} doesn’t know that model.`, 'AI_MODEL');
  if (res.status === 429) return say(`${name} is rate limiting you, or the account is out of credit.`, 'AI_RATE');
  if (res.status === 400 || res.status === 413 || res.status === 422) return say(`${name} refused the request.`, 'AI_REQUEST');
  return say(`${name} answered with an error (HTTP ${res.status}).`, 'AI_HTTP');
}

async function call(fetchImpl, url, init, provider, signal) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal });
  } catch (e) {
    if (signal && signal.aborted) throw new AiError(`${provider.name} took too long to answer.`, 'AI_TIMEOUT');
    throw new AiError(`Couldn’t reach ${provider.name}${provider.id === 'ollama' ? '. Is Ollama running?' : '.'} (${e.message})`, 'AI_NETWORK');
  }
  if (!res.ok) throw await failure(res, provider);
  try {
    return await res.json();
  } catch {
    throw new AiError(`${provider.name} sent a reply GitDonkey couldn’t read.`, 'AI_HTTP');
  }
}

function withTimeout(ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

function headersFor(provider, key) {
  const h = { 'content-type': 'application/json' };
  if (provider.api === 'anthropic') {
    h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
  } else if (provider.api === 'gemini') {
    h['x-goog-api-key'] = key;
  } else if (key) {
    h.authorization = `Bearer ${key}`;
  }
  if (provider.id === 'openrouter') {
    // OpenRouter's optional app attribution.
    h['http-referer'] = 'https://gitdonkey.com';
    h['x-title'] = 'GitDonkey';
  }
  return h;
}

function requireKey(provider, key) {
  if (provider.needsKey && !key) throw new AiError(`Add your ${provider.name} API key in AI settings.`, 'AI_NO_KEY');
}

/** Ask the provider to write the message; resolves with the reply text. */
async function complete({ provider: id, key, model, baseUrl }, { system, user }, fetchImpl, { timeout = TIMEOUT_MS } = {}) {
  const provider = PROVIDER[id];
  if (!provider) throw new AiError('Choose an AI provider first.', 'AI_CONFIG');
  requireKey(provider, key);
  const m = String(model || provider.model || '').trim();
  if (!m) throw new AiError('Enter a model name.', 'AI_CONFIG');
  const base = baseFor(provider, baseUrl);
  const t = withTimeout(timeout);
  try {
    if (provider.api === 'anthropic') {
      const j = await call(fetchImpl, `${base}/messages`, {
        method: 'POST',
        headers: headersFor(provider, key),
        body: JSON.stringify({ model: m, max_tokens: 1024, system, messages: [{ role: 'user', content: user }] }),
      }, provider, t.signal);
      return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    }
    if (provider.api === 'gemini') {
      const j = await call(fetchImpl, `${base}/models/${encodeURIComponent(m.replace(/^models\//, ''))}:generateContent`, {
        method: 'POST',
        headers: headersFor(provider, key),
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }] }),
      }, provider, t.signal);
      return ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map((p) => p.text || '').join('');
    }
    if (provider.api === 'ollama') {
      const j = await call(fetchImpl, `${base}/api/chat`, {
        method: 'POST',
        headers: headersFor(provider, key),
        body: JSON.stringify({ model: m, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      }, provider, t.signal);
      return (j.message && j.message.content) || '';
    }
    const j = await call(fetchImpl, `${base}/chat/completions`, {
      method: 'POST',
      headers: headersFor(provider, key),
      body: JSON.stringify({ model: m, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    }, provider, t.signal);
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    const content = msg && msg.content;
    return Array.isArray(content) ? content.map((c) => c.text || '').join('') : content || '';
  } finally {
    t.done();
  }
}

// Model ids that can't write text (embeddings, speech, images, moderation).
const NOT_CHAT = /(embed|whisper|tts|audio|transcribe|dall-e|image|moderation|realtime|search|computer-use|babbage|davinci)/i;

/** The provider's model ids, for the settings dialog's suggestions. */
async function listModels({ provider: id, key, baseUrl }, fetchImpl, { timeout = 15000 } = {}) {
  const provider = PROVIDER[id];
  if (!provider) throw new AiError('Choose an AI provider first.', 'AI_CONFIG');
  requireKey(provider, key);
  const base = baseFor(provider, baseUrl);
  const t = withTimeout(timeout);
  try {
    let ids;
    if (provider.api === 'gemini') {
      const j = await call(fetchImpl, `${base}/models?pageSize=200`, { headers: headersFor(provider, key) }, provider, t.signal);
      ids = (j.models || []).filter((x) => (x.supportedGenerationMethods || []).includes('generateContent')).map((x) => String(x.name).replace(/^models\//, ''));
    } else if (provider.api === 'ollama') {
      const j = await call(fetchImpl, `${base}/api/tags`, { headers: headersFor(provider, key) }, provider, t.signal);
      ids = (j.models || []).map((x) => x.name || x.model);
    } else {
      const j = await call(fetchImpl, `${base}/models${provider.api === 'anthropic' ? '?limit=1000' : ''}`, { headers: headersFor(provider, key) }, provider, t.signal);
      ids = (j.data || []).map((x) => x.id);
    }
    return [...new Set(ids.filter((x) => typeof x === 'string' && x && !NOT_CHAT.test(x)))].sort();
  } finally {
    t.done();
  }
}

/**
 * API keys, encrypted with the OS keychain (Electron safeStorage) and kept in
 * the app's state file as base64. Plain-text storage is never used.
 */
class KeyVault {
  constructor(store, safeStorage) {
    this.store = store;
    this.safe = safeStorage;
  }

  all() {
    return this.store.get('aiKeys') || {};
  }

  has(id) {
    return Boolean(this.all()[id]);
  }

  get(id) {
    const enc = this.all()[id];
    if (!enc) return null;
    try {
      return this.safe.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }

  set(id, key) {
    if (!PROVIDER[id]) throw new AiError('Unknown provider.', 'AI_CONFIG');
    const keys = { ...this.all() };
    const k = typeof key === 'string' ? key.trim() : '';
    if (!k) delete keys[id];
    else {
      if (!this.safe.isEncryptionAvailable()) throw new AiError('This system has no secure storage for API keys, so GitDonkey won’t save one.', 'AI_STORAGE');
      keys[id] = this.safe.encryptString(k).toString('base64');
    }
    this.store.set('aiKeys', keys);
    return Boolean(k);
  }
}

module.exports = { PROVIDERS, PROVIDER, AiError, condenseDiff, buildPrompt, parseMessage, complete, listModels, KeyVault };
