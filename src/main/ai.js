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

const fileList = (files) => files.map((f) => `${f.status || 'M'} ${f.path}${f.oldPath ? ` (from ${f.oldPath})` : ''}`).join('\n');

/**
 * Explain a commit, or what a branch changes compared with another, for a
 * teammate: one sentence, a few points, and a warning only if one's due.
 */
function buildExplainPrompt({ commit = null, range = null, files = [], diff = '' }) {
  const system = [
    'You explain Git changes to a developer on the same team.',
    'Reply in plain text with no Markdown headings, bold or code fences:',
    'first one sentence saying what the change does;',
    'then up to six short lines, each starting with "- ", on the main changes and why they matter;',
    'then, only if there is a real risk or something a reviewer should check, one line starting with "Watch out: ".',
    'Describe what the diff actually does. Do not guess at motivation the diff and messages don’t show.',
  ].join('\n');
  const lines = [];
  if (commit) {
    lines.push(`Commit by ${commit.author}: ${commit.subject}`);
    if (commit.body) lines.push(commit.body);
  }
  if (range) {
    lines.push(`Branch ${range.head}, compared with ${range.base}.`);
    if (range.commits.length) lines.push(`Its commits, newest first:\n${range.commits.map((c) => `- ${c.subject}`).join('\n')}`);
  }
  if (files.length) lines.push(`Files:\n${fileList(files)}`);
  lines.push(`Diff:\n${condenseDiff(diff, { maxChars: 30000 })}`);
  return { system, user: lines.join('\n\n') };
}

/** Title and description for a pull request from a branch's commits and diff. */
function buildPullPrompt({ base, head, commits = [], files = [], diff = '', instructions = '' }) {
  const system = [
    'You write GitHub pull request titles and descriptions.',
    'Reply with JSON only, no code fences: {"title": "...", "body": "..."}.',
    'title: what the pull request does, in the imperative mood, at most 72 characters, no trailing full stop.',
    'body: Markdown. One short paragraph on what changes and why, then a "## Changes" list of the main changes. Add "## Testing" only if the diff shows tests. Under 250 words.',
    'Describe what the diff actually does. Do not invent tickets, screenshots or test results.',
    instructions && String(instructions).trim() ? `The user's own instructions, which take priority over the style rules above:\n${String(instructions).trim()}` : '',
  ].filter(Boolean).join('\n');
  const lines = [`Merging ${head} into ${base}.`];
  if (commits.length) lines.push(`Commits, newest first:\n${commits.map((c) => `- ${c.subject}`).join('\n')}`);
  if (files.length) lines.push(`Files:\n${fileList(files)}`);
  lines.push(`Diff:\n${condenseDiff(diff, { maxChars: 30000 })}`);
  return { system, user: lines.join('\n\n') };
}

const SEVERITIES = new Set(['high', 'medium', 'low']);

/** A review of the staged changes: real problems only, as JSON. */
function buildReviewPrompt({ diff, files = [], branch = null }) {
  const system = [
    'You review code changes before they are committed, like a careful senior engineer.',
    'Look for bugs, crashes, security problems, data loss, broken edge cases, and mistakes that would break the build. Skip style, naming and formatting.',
    'Reply with JSON only, no code fences: {"summary": "...", "issues": [{"file": "path/in/repo", "line": 12, "severity": "high", "title": "...", "detail": "..."}]}.',
    'severity: "high" (will break or is unsafe), "medium" (likely wrong), or "low" (worth a look).',
    'line: the line number in the new version of the file, read from the diff hunk headers, or null.',
    'title: under 80 characters. detail: one or two sentences on what goes wrong and how to fix it.',
    'Only report problems you can point to in the diff. If there are none, give an empty issues list.',
    'summary: one sentence on the overall state of the change.',
  ].join('\n');
  const lines = [];
  if (branch) lines.push(`Branch: ${branch}`);
  if (files.length) lines.push(`Files:\n${fileList(files)}`);
  lines.push(`Staged diff:\n${condenseDiff(diff, { maxChars: 40000, perFile: 12000 })}`);
  return { system, user: lines.join('\n\n') };
}

/** The JSON object in a reply, with or without code fences or a sentence around it. */
function parseJsonReply(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  const bad = () => new AiError('The AI’s reply wasn’t in the expected format. Try again, or pick another model.', 'AI_FORMAT');
  if (start === -1 || end <= start) throw bad();
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    throw bad();
  }
}

function parsePullReply(text) {
  const j = parseJsonReply(text);
  const title = typeof j.title === 'string' ? j.title.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  if (!title) throw new AiError('The AI didn’t write a title. Try again.', 'AI_FORMAT');
  return { title, body: typeof j.body === 'string' ? j.body.trim() : '' };
}

function parseReviewReply(text) {
  const j = parseJsonReply(text);
  const issues = (Array.isArray(j.issues) ? j.issues : []).slice(0, 30).map((x) => ({
    file: typeof x.file === 'string' ? x.file.trim().replace(/^[ab]\//, '') : '',
    line: Number.isInteger(x.line) && x.line > 0 ? x.line : null,
    severity: SEVERITIES.has(String(x.severity).toLowerCase()) ? String(x.severity).toLowerCase() : 'low',
    title: typeof x.title === 'string' ? x.title.trim().slice(0, 200) : '',
    detail: typeof x.detail === 'string' ? x.detail.trim().slice(0, 1200) : '',
  })).filter((x) => x.title || x.detail);
  const rank = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { summary: typeof j.summary === 'string' ? j.summary.trim() : '', issues };
}

// The colours a theme sets, in the order the theme builder shows them
// (src/renderer/lib/themes.js has the same list).
const THEME_KEYS = [
  'case', 'panel', 'panel-2', 'panel-3', 'panel-4', 'seam', 'rule', 'rule-2',
  'legend', 'legend-2', 'legend-3', 'keycap', 'keycap-hover', 'keycap-ink',
  'red', 'amber', 'cyan', 'green', 'violet', 'pink', 'blue', 'orange', 'teal', 'bone',
];

/** A prompt for a whole colour theme from a description like "sunset". */
function buildThemePrompt(description) {
  const system = [
    'You design colour themes for GitDonkey, a desktop Git client styled like a modular synth: matte panels on thin seams, printed legends, and coloured patch cables for branches.',
    'Reply with JSON only, no prose and no code fences: {"name": "...", "colors": {...}} with every key below as a #rrggbb colour.',
    '- case: the deepest background (commit graph, input fields).',
    '- panel, panel-2, panel-3, panel-4: surfaces in small steps away from case towards the legend colour (panel: sidebars; panel-2: raised headers, menus, toasts; panel-3: hover; panel-4: pressed).',
    '- seam: the 1px gaps between modules (darker than case on a dark theme). rule and rule-2: borders, rule-2 stronger.',
    '- legend: main text. legend-2: secondary text. legend-3: muted hints.',
    '- keycap: primary buttons and highlights. keycap-hover: keycap when hovered. keycap-ink: text on keycap and on cable colours.',
    '- red (deletions, errors), amber (current branch, focus, selection), cyan (info), green (additions), violet, pink, blue, orange, teal, bone: patch cables, also used for graph lanes and syntax highlighting. Make them ten clearly different hues.',
    'Contrast: legend on panel at least 7:1; legend-2 and legend-3 on panel-2 at least 4.5:1; keycap-ink on keycap at least 4.5:1; every cable at least 3:1 against case and panel-2.',
    'Choose a light or dark base to suit the description. Put the mood into the backgrounds, the keycap and the cables, but keep red reddish, green greenish and amber warm so diffs and status still read.',
    'name: a short name for the theme, two or three words, in title case.',
  ].join('\n');
  return { system, user: `Theme: ${String(description).trim().slice(0, 300)}` };
}

const CONFLICT_LINES = 160; // per side of one conflict
const CONFLICT_CHARS = 40000; // for the whole prompt

/**
 * A prompt to resolve a file's conflicts. `conflicts` are
 * { index, ours, base, theirs, before, after } (arrays of lines), as
 * conflictContext() in src/renderer/lib/conflicts.js makes them.
 */
function buildConflictPrompt({ path: file, operation, oursLabel, theirsLabel, conflicts }) {
  const system = [
    'You resolve Git merge conflicts.',
    'For each conflict you get the lines from OURS (the side already checked out), THEIRS (the side being brought in), the common BASE when Git knows it, and a few lines of context before and after.',
    'Write the lines that should replace the whole conflict. Keep what both sides meant to do: when the changes are compatible, combine them; when they truly contradict, choose the side that is more complete or more deliberate and say why.',
    'Never output conflict markers. Keep the file’s indentation, quotes and style. Don’t add comments about the merge, and don’t repeat the context lines.',
    'Reply with JSON only, no prose and no code fences: {"resolutions":[{"conflict":1,"lines":["…"],"why":"one short sentence","confidence":"high"}]} with one entry per conflict. confidence is high, medium or low: low when you had to guess.',
  ].join('\n');
  const block = (lines) => {
    const list = (lines || []).slice(0, CONFLICT_LINES);
    const cut = (lines || []).length > CONFLICT_LINES ? `\n… ${lines.length - CONFLICT_LINES} more lines` : '';
    return `\`\`\`\n${list.join('\n')}${cut}\n\`\`\``;
  };
  const head = [
    `File: ${String(file).slice(0, 300)}`,
    `What happened: ${String(operation || 'merge').slice(0, 200)}`,
    `OURS is labelled “${String(oursLabel || 'HEAD').slice(0, 120)}”; THEIRS is labelled “${String(theirsLabel || 'incoming').slice(0, 120)}”.`,
  ].join('\n');
  let user = head;
  for (const c of conflicts) {
    const part = [
      `\n\nConflict ${c.index + 1}`,
      c.before && c.before.length ? `Context before:\n${block(c.before)}` : '',
      `OURS:\n${block(c.ours)}`,
      c.base ? `BASE:\n${block(c.base)}` : '',
      `THEIRS:\n${block(c.theirs)}`,
      c.after && c.after.length ? `Context after:\n${block(c.after)}` : '',
    ].filter(Boolean).join('\n');
    if (user.length + part.length > CONFLICT_CHARS) {
      user += `\n\n(The file has more conflicts; resolve the ones above.)`;
      break;
    }
    user += part;
  }
  return { system, user };
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
    if (signal && signal.aborted) throw stopped(signal, provider);
    throw new AiError(`Couldn’t reach ${provider.name}${provider.id === 'ollama' ? '. Is Ollama running?' : '.'} (${e.message})`, 'AI_NETWORK');
  }
  if (!res.ok) throw await failure(res, provider);
  try {
    return await res.json();
  } catch {
    // The answer can stall after the headers arrive (a model still thinking): stopped or timed out, say which.
    if (signal && signal.aborted) throw stopped(signal, provider);
    throw new AiError(`${provider.name} sent a reply GitDonkey couldn’t read.`, 'AI_HTTP');
  }
}

function stopped(signal, provider) {
  return signal.reason === 'cancel'
    ? new AiError('Stopped.', 'AI_CANCELLED')
    : new AiError(`${provider.name} took too long to answer. Try again, or choose a faster model in AI settings.`, 'AI_TIMEOUT');
}

/** A signal that fires after `ms`, or when `cancel` (another signal) does, with the reason 'cancel'. */
function withTimeout(ms, cancel = null) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('timeout'), ms);
  const onCancel = () => ctl.abort('cancel');
  if (cancel) {
    if (cancel.aborted) onCancel();
    else cancel.addEventListener('abort', onCancel, { once: true });
  }
  return {
    signal: ctl.signal,
    done: () => {
      clearTimeout(timer);
      if (cancel) cancel.removeEventListener('abort', onCancel);
    },
  };
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
/**
 * How hard a model may think before it answers. "Thinking" models (DeepSeek,
 * o-series, GPT-5, Gemini 2.5) otherwise reason at length first, which for a
 * commit message means minutes of waiting. `none` asks them not to; `low` for
 * jobs that benefit from a moment's thought (reviews, conflicts).
 */
function reasoningFor(provider, model, effort) {
  if (!effort) return {};
  if (provider.id === 'openrouter') return { reasoning: { effort } };
  if (provider.id === 'openai' && /^(gpt-5|o\d)/i.test(model)) {
    return { reasoning_effort: effort === 'none' ? (/^gpt-5/i.test(model) ? 'minimal' : 'low') : effort };
  }
  return {};
}

async function complete({ provider: id, key, model, baseUrl }, { system, user }, fetchImpl, { timeout = TIMEOUT_MS, maxTokens = 1024, effort = 'none', signal = null } = {}) {
  const provider = PROVIDER[id];
  if (!provider) throw new AiError('Choose an AI provider first.', 'AI_CONFIG');
  requireKey(provider, key);
  const m = String(model || provider.model || '').trim();
  if (!m) throw new AiError('Enter a model name.', 'AI_CONFIG');
  const base = baseFor(provider, baseUrl);
  const t = withTimeout(timeout, signal);
  try {
    if (provider.api === 'anthropic') {
      const j = await call(fetchImpl, `${base}/messages`, {
        method: 'POST',
        headers: headersFor(provider, key),
        body: JSON.stringify({ model: m, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
      }, provider, t.signal);
      return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    }
    if (provider.api === 'gemini') {
      // Flash models can skip thinking altogether; Pro ones can't, but get a small budget.
      const thinking = effort === 'none' && /flash/i.test(m) ? { thinkingBudget: 0 } : effort === 'none' || effort === 'low' ? { thinkingBudget: 1024 } : null;
      const j = await call(fetchImpl, `${base}/models/${encodeURIComponent(m.replace(/^models\//, ''))}:generateContent`, {
        method: 'POST',
        headers: headersFor(provider, key),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens + (thinking ? thinking.thinkingBudget : 0), ...(thinking && /2\.5|thinking/i.test(m) ? { thinkingConfig: thinking } : {}) },
        }),
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
    // OpenAI's own reasoning models only take max_completion_tokens; everyone else max_tokens.
    // The limit covers any thinking as well as the answer, so thinking gets room on top.
    const room = maxTokens + (effort === 'none' ? 0 : effort === 'low' ? Math.round(maxTokens / 2) : maxTokens);
    const limit = provider.id === 'openai' ? { max_completion_tokens: room } : { max_tokens: room };
    const body = { model: m, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...limit, ...reasoningFor(provider, m, effort) };
    const post = (b) => call(fetchImpl, `${base}/chat/completions`, { method: 'POST', headers: headersFor(provider, key), body: JSON.stringify(b) }, provider, t.signal);
    let j;
    try {
      j = await post(body);
    } catch (e) {
      // A model that must think refuses "don't": ask again without saying.
      if (e.kind !== 'AI_REQUEST' || !/reason|effort|think/i.test(e.message)) throw e;
      delete body.reasoning;
      delete body.reasoning_effort;
      j = await post(body);
    }
    const choice = j.choices && j.choices[0];
    const msg = choice && choice.message;
    const content = msg && msg.content;
    const text = Array.isArray(content) ? content.map((c) => c.text || '').join('') : content || '';
    if (!text.trim() && choice && choice.finish_reason === 'length') {
      throw new AiError(`${provider.name}’s model used up its reply thinking, before writing an answer. Try again, or choose a model that doesn’t think first.`, 'AI_LENGTH');
    }
    return text;
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
// When the system won't encrypt (on macOS: the Keychain prompt was declined,
// and macOS keeps saying no until GitDonkey restarts), a key is kept in memory
// for this session instead of being refused, and is never written in plain text.
const KEYCHAIN_LOCKED = 'GitDonkey can’t read your saved API key because macOS Keychain access was declined. Reopen GitDonkey and click Always Allow, or paste the key again in AI settings to use it until you quit.';

// Secrets kept alongside the AI keys.
const OTHER_KEYS = new Set(['github']);

class KeyVault {
  constructor(store, safeStorage) {
    this.store = store;
    this.safe = safeStorage;
    this.session = new Map();
  }

  all() {
    return this.store.get('aiKeys') || {};
  }

  has(id) {
    return this.session.has(id) || Boolean(this.all()[id]);
  }

  get(id) {
    if (this.session.has(id)) return this.session.get(id);
    const enc = this.all()[id];
    if (!enc) return null;
    try {
      return this.safe.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }

  /** The key to send, or null when there's none; throws when one is saved but can't be read right now. */
  require(id) {
    const key = this.get(id);
    if (!key && this.has(id)) throw new AiError(KEYCHAIN_LOCKED, 'AI_KEY_LOCKED');
    return key;
  }

  /** Save a key (empty forgets it). Returns 'saved', 'session' (kept until quit, see above) or 'cleared'. */
  set(id, key) {
    if (!PROVIDER[id] && !OTHER_KEYS.has(id)) throw new AiError('Unknown provider.', 'AI_CONFIG');
    const keys = { ...this.all() };
    const k = typeof key === 'string' ? key.trim() : '';
    this.session.delete(id);
    if (!k) {
      delete keys[id];
      this.store.set('aiKeys', keys);
      return 'cleared';
    }
    let enc = null;
    try {
      if (this.safe.isEncryptionAvailable()) enc = this.safe.encryptString(k).toString('base64');
    } catch {
      enc = null;
    }
    if (!enc) {
      this.session.set(id, k);
      return 'session';
    }
    keys[id] = enc;
    this.store.set('aiKeys', keys);
    return 'saved';
  }
}

module.exports = {
  PROVIDERS, PROVIDER, AiError, condenseDiff, buildPrompt, buildThemePrompt, buildConflictPrompt, buildExplainPrompt, buildPullPrompt, buildReviewPrompt,
  parseJsonReply, parsePullReply, parseReviewReply, THEME_KEYS, parseMessage, complete, listModels, KeyVault,
};
