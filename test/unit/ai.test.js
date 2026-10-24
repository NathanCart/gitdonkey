'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { newRepo, write, commitFile, git } = require('./helpers');
const { GitRepo } = require('../../src/main/git');
const { PROVIDERS, condenseDiff, buildPrompt, parseMessage, complete, listModels, KeyVault } = require('../../src/main/ai');

const PROMPT = { system: 'SYS', user: 'USER' };

/** A fetch that records the request and answers with `body` (JSON) and `status`. */
function fakeFetch(body, status = 200) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  fn.calls = calls;
  return fn;
}

test('condenseDiff omits lockfiles and binaries, caps each file and the total', () => {
  const file = (name, body) => `diff --git a/${name} b/${name}\nindex 1..2 100644\n--- a/${name}\n+++ b/${name}\n${body}`;
  const diff = [
    file('src/app.js', '@@ -1 +1 @@\n-a\n+b\n'),
    file('package-lock.json', `@@ -1 +1 @@\n${'+x\n'.repeat(500)}`),
    'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
    file('big.txt', `@@ -1 +1 @@\n${'+line of text\n'.repeat(1000)}`),
  ].join('');
  const out = condenseDiff(diff, { maxChars: 100000, perFile: 2000 });
  assert.match(out, /\+b/);
  assert.match(out, /package-lock\.json\n\(generated file changed; contents omitted\)/);
  assert.match(out, /logo\.png\n\(binary file changed; contents omitted\)/);
  assert.match(out, /more characters of this file omitted/);
  assert.ok(!out.includes('+x\n+x'));
  const tight = condenseDiff(diff, { maxChars: 300, perFile: 2000 });
  assert.match(tight, /1 more file omitted for length/);
  assert.ok(tight.length < 600);
  assert.equal(condenseDiff(''), '');
});

test('buildPrompt carries branch, files, recent subjects and the user instructions', () => {
  const p = buildPrompt({
    diff: 'diff --git a/a b/a\n+x\n',
    files: [{ path: 'a', status: 'M' }, { path: 'b', oldPath: 'c', status: 'R' }],
    branch: 'feature/hay',
    recent: ['feat: add hay', 'fix: stop braying'],
    instructions: 'Use Conventional Commits.',
    amend: true,
  });
  assert.match(p.system, /imperative mood/);
  assert.match(p.system, /Use Conventional Commits\./);
  assert.match(p.user, /Branch: feature\/hay/);
  assert.match(p.user, /- fix: stop braying/);
  assert.match(p.user, /R b \(from c\)/);
  assert.match(p.user, /replaces the message of the commit being amended/);
  assert.match(p.user, /Staged diff:\ndiff --git a\/a b\/a/);
  assert.doesNotMatch(buildPrompt({ diff: '' }).system, /own instructions/);
});

test('parseMessage cleans fences, labels, quotes, think tags and full stops', () => {
  assert.deepEqual(parseMessage('Add hay to the stable.'), { summary: 'Add hay to the stable', description: '' });
  assert.deepEqual(parseMessage('```\nFix bray volume\n\nIt was too loud.\n```'), { summary: 'Fix bray volume', description: 'It was too loud.' });
  assert.deepEqual(parseMessage('Commit message: "Remove the mule"'), { summary: 'Remove the mule', description: '' });
  assert.deepEqual(parseMessage('<think>hmm</think>\r\nfeat: add carrots\r\n\r\n\r\nBody line one\r\nline two\r\n'), { summary: 'feat: add carrots', description: 'Body line one\nline two' });
  assert.deepEqual(parseMessage('**Update README**'), { summary: 'Update README', description: '' });
  assert.throws(() => parseMessage('   '), (e) => e.kind === 'AI_EMPTY');
});

test('complete: OpenAI-style chat completions (OpenAI, OpenRouter, custom)', async () => {
  const f = fakeFetch({ choices: [{ message: { content: 'Add hay' } }] });
  assert.equal(await complete({ provider: 'openai', key: 'sk-1', model: 'gpt-x' }, PROMPT, f), 'Add hay');
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.authorization, 'Bearer sk-1');
  assert.deepEqual(c.body, { model: 'gpt-x', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }] });

  const r = fakeFetch({ choices: [{ message: { content: [{ type: 'text', text: 'Add ' }, { type: 'text', text: 'carrots' }] } }] });
  assert.equal(await complete({ provider: 'openrouter', key: 'or-1' }, PROMPT, r), 'Add carrots');
  assert.equal(r.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(r.calls[0].body.model, PROVIDERS.find((p) => p.id === 'openrouter').model);
  assert.equal(r.calls[0].init.headers['x-title'], 'GitDonkey');

  const x = fakeFetch({ choices: [{ message: { content: 'ok' } }] });
  await complete({ provider: 'custom', model: 'local-model', baseUrl: 'http://localhost:1234/v1/' }, PROMPT, x);
  assert.equal(x.calls[0].url, 'http://localhost:1234/v1/chat/completions');
  assert.equal(x.calls[0].init.headers.authorization, undefined);
  await assert.rejects(complete({ provider: 'custom', model: 'm' }, PROMPT, x), (e) => e.kind === 'AI_CONFIG');
});

test('complete: Anthropic messages API', async () => {
  const f = fakeFetch({ content: [{ type: 'thinking', thinking: '…' }, { type: 'text', text: 'Fix the gate' }] });
  assert.equal(await complete({ provider: 'anthropic', key: 'ak', model: 'claude-x' }, PROMPT, f), 'Fix the gate');
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.init.headers['x-api-key'], 'ak');
  assert.equal(c.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(c.init.headers.authorization, undefined);
  assert.deepEqual(c.body, { model: 'claude-x', max_tokens: 1024, system: 'SYS', messages: [{ role: 'user', content: 'USER' }] });
});

test('complete: Gemini and Ollama', async () => {
  const g = fakeFetch({ candidates: [{ content: { parts: [{ text: 'Add ' }, { text: 'apples' }] } }] });
  assert.equal(await complete({ provider: 'gemini', key: 'gk', model: 'models/gemini-x' }, PROMPT, g), 'Add apples');
  assert.equal(g.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
  assert.equal(g.calls[0].init.headers['x-goog-api-key'], 'gk');
  assert.ok(!g.calls[0].url.includes('gk'), 'the key never goes in the URL');
  assert.deepEqual(g.calls[0].body.systemInstruction, { parts: [{ text: 'SYS' }] });

  const o = fakeFetch({ message: { role: 'assistant', content: 'Drink water' } });
  assert.equal(await complete({ provider: 'ollama' }, PROMPT, o), 'Drink water');
  assert.equal(o.calls[0].url, 'http://localhost:11434/api/chat');
  assert.equal(o.calls[0].body.stream, false);
});

test('complete: missing keys, HTTP errors, network failures and timeouts become plain words', async () => {
  await assert.rejects(complete({ provider: 'openai', key: '' }, PROMPT, fakeFetch({})), (e) => e.kind === 'AI_NO_KEY');
  await assert.rejects(complete({ provider: 'nope', key: 'k' }, PROMPT, fakeFetch({})), (e) => e.kind === 'AI_CONFIG');
  await assert.rejects(
    complete({ provider: 'openai', key: 'bad' }, PROMPT, fakeFetch({ error: { message: 'Incorrect API key provided' } }, 401)),
    (e) => e.kind === 'AI_AUTH' && /OpenAI rejected the API key/.test(e.message) && /Incorrect API key/.test(e.message),
  );
  await assert.rejects(complete({ provider: 'anthropic', key: 'k' }, PROMPT, fakeFetch({ error: { message: 'model: x' } }, 404)), (e) => e.kind === 'AI_MODEL');
  await assert.rejects(complete({ provider: 'openrouter', key: 'k' }, PROMPT, fakeFetch('slow down', 429)), (e) => e.kind === 'AI_RATE' && /slow down/.test(e.message));
  await assert.rejects(complete({ provider: 'ollama' }, PROMPT, async () => {
    throw new Error('ECONNREFUSED');
  }), (e) => e.kind === 'AI_NETWORK' && /Is Ollama running/.test(e.message));
  const hang = (_url, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(complete({ provider: 'openai', key: 'k' }, PROMPT, hang, { timeout: 20 }), (e) => e.kind === 'AI_TIMEOUT');
});

test('listModels filters to text models for each API', async () => {
  const oa = fakeFetch({ data: [{ id: 'gpt-b' }, { id: 'text-embedding-3-small' }, { id: 'gpt-a' }, { id: 'whisper-1' }, { id: 'gpt-a' }] });
  assert.deepEqual(await listModels({ provider: 'openai', key: 'k' }, oa), ['gpt-a', 'gpt-b']);
  assert.equal(oa.calls[0].url, 'https://api.openai.com/v1/models');
  const an = fakeFetch({ data: [{ id: 'claude-y' }] });
  assert.deepEqual(await listModels({ provider: 'anthropic', key: 'k' }, an), ['claude-y']);
  assert.equal(an.calls[0].url, 'https://api.anthropic.com/v1/models?limit=1000');
  const ge = fakeFetch({ models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }] });
  assert.deepEqual(await listModels({ provider: 'gemini', key: 'k' }, ge), ['gemini-a']);
  const ol = fakeFetch({ models: [{ name: 'llama3.2:latest' }] });
  assert.deepEqual(await listModels({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' }, ol), ['llama3.2:latest']);
  assert.equal(ol.calls[0].url, 'http://127.0.0.1:11434/api/tags');
});

test('KeyVault encrypts keys, never stores plain text, and forgets them', () => {
  const data = {};
  const store = { get: (k) => data[k], set: (k, v) => { data[k] = v; } };
  let available = true;
  const safe = {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${[...s].reverse().join('')}`),
    decryptString: (b) => [...b.toString().slice(4)].reverse().join(''),
  };
  const vault = new KeyVault(store, safe);
  assert.equal(vault.has('openai'), false);
  assert.equal(vault.set('openai', '  sk-secret  '), true);
  assert.equal(vault.has('openai'), true);
  assert.equal(vault.get('openai'), 'sk-secret');
  assert.ok(!JSON.stringify(data).includes('sk-secret'));
  assert.equal(vault.set('openai', ''), false);
  assert.equal(vault.has('openai'), false);
  assert.throws(() => vault.set('nope', 'k'), (e) => e.kind === 'AI_CONFIG');
  available = false;
  assert.throws(() => vault.set('anthropic', 'k'), (e) => e.kind === 'AI_STORAGE');
  assert.equal(vault.has('anthropic'), false);
});

test('commitContext: staged diff, files, branch and recent subjects; amend covers the whole commit', async () => {
  const dir = newRepo();
  const repo = new GitRepo(dir);
  write(dir, 'first.txt', 'hello\n');
  git(dir, 'add', 'first.txt');
  let ctx = await repo.commitContext();
  assert.deepEqual(ctx.files.map((f) => [f.path, f.status]), [['first.txt', 'A']]);
  assert.match(ctx.diff, /\+hello/);
  assert.equal(ctx.branch, 'main');
  assert.deepEqual(ctx.recent, []);
  git(dir, 'commit', '-q', '-m', 'Add first');
  commitFile(dir, 'second.txt', 'two\n', 'Add second');
  write(dir, 'second.txt', 'two\nmore\n');
  write(dir, 'unstaged.txt', 'not staged\n');
  git(dir, 'add', 'second.txt');
  ctx = await repo.commitContext();
  assert.deepEqual(ctx.files.map((f) => f.path), ['second.txt']);
  assert.match(ctx.diff, /\+more/);
  assert.doesNotMatch(ctx.diff, /\+two/);
  assert.deepEqual(ctx.recent, ['Add second', 'Add first']);
  ctx = await repo.commitContext({ amend: true });
  assert.match(ctx.diff, /\+two\n\+more/);
  assert.deepEqual(ctx.recent, ['Add first']);
});
