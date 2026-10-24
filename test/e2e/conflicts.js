'use strict';

// End-to-end: conflicts left by a stash pop. Stash says why it can't run
// (instead of Git's "could not write index") and repeats count up on one toast;
// Show conflicts opens the merge tool; Resolve with AI asks an OpenAI-compatible
// endpoint on 127.0.0.1 and shows suggestions that change nothing until used.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch } = require('./harness');

const results = [];
let t;

async function waitFor(fn, { timeout = 10000, interval = 100, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for ${message}${last instanceof Error ? `: ${last.message}` : ''}`);
}

async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✖ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
    await t.shot(`FAIL-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => {});
  }
}

const win = () => t.win;
const modal = () => win().locator('.modal').last();
const refresh = () => win().evaluate(() => window.__gitdonkey.refresh());
const git = (...args) => execFileSync('git', args, { cwd: t.fx.repo, env: { ...process.env, HOME: t.home }, encoding: 'utf8' });
const CORS = (origins) => `const ALLOWED = new Set([${origins.map((o) => `'${o}'`).join(', ')}]);\n\nexport function allowed(origin) {\n  return ALLOWED.has(origin);\n}\n`;
const MERGED = CORS(['https://harbor.example.dev', 'http://localhost:5173', 'https://staging.harbor.example.dev']);

function aiServer() {
  const seen = [];
  const reply = {
    resolutions: [{
      conflict: 1,
      lines: MERGED.split('\n')[0],
      why: 'Both sides added an allowed origin, so keep both.',
      confidence: 'high',
    }],
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      seen.push({ url: req.url, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/models')) res.end(JSON.stringify({ data: [{ id: 'donkey-1' }] }));
      else res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

async function main() {
  t = await launch();
  await win().locator('.g-row').first().waitFor({ timeout: 20000 });

  await step('a stash pop that conflicts leaves the stash and a conflicted file, like the bug report', async () => {
    git('stash', 'push', '-u', '-q', '-m', 'fixture changes');
    fs.writeFileSync(path.join(t.fx.repo, 'src/cors.js'), CORS(['https://harbor.example.dev', 'https://staging.harbor.example.dev']));
    fs.writeFileSync(path.join(t.fx.repo, 'NOTES.md'), 'Staging dashboard origin added.\n');
    git('add', 'NOTES.md');
    git('stash', 'push', '-q', '-m', 'staging origin');
    fs.writeFileSync(path.join(t.fx.repo, 'src/cors.js'), CORS(['https://harbor.example.dev', 'http://localhost:5173']));
    git('commit', '-qam', 'Allow the local dev server origin');
    try {
      git('stash', 'pop');
    } catch {
      // exits 1 on conflict, keeping the stash
    }
    await refresh();
    await win().locator('.files-conflicted .file', { hasText: 'cors.js' }).first().waitFor();
    await win().locator('.files-staged .file', { hasText: 'NOTES.md' }).first().waitFor();
  });

  const stashCount = () => git('stash', 'list').trim().split('\n').filter(Boolean).length;
  let before = 0;
  await step('Stash explains the conflicts, and pressing it again counts up on one toast', async () => {
    before = stashCount();
    for (let i = 0; i < 3; i++) await win().locator('.key[data-key="stash"]').click();
    const toast = win().locator('.toast', { hasText: 'Can’t stash with conflicts' });
    await toast.waitFor();
    if ((await toast.count()) !== 1) throw new Error(`${await toast.count()} toasts`);
    const text = await toast.innerText();
    if (!/1 file is still conflicted \(cors\.js\)/.test(text)) throw new Error(`message: ${text}`);
    if (!/×3/.test(text)) throw new Error(`no ×3 counter: ${text}`);
    if (/could not write index/.test(await win().locator('.toasts').innerText())) throw new Error('Git’s raw message leaked through');
    if (stashCount() !== before) throw new Error(`${stashCount()} stashes, was ${before}: nothing should have been stashed`);
    await t.shot('33-stash-conflicts');
    await toast.locator('.btn', { hasText: 'Show conflicts' }).click();
    await win().locator('.merge-bar').waitFor();
  });

  const ai = await aiServer();
  await step('Resolve with AI suggests a merge, and nothing changes until it is used', async () => {
    try {
      // Not set up yet: the key opens AI settings.
      await win().locator('[data-action="ai-resolve"]', { hasText: 'Set up AI' }).click();
      await modal().locator('select').first().selectOption('custom');
      const input = (label) => modal().locator('.field', { hasText: label }).locator('input');
      await input('Base URL').fill(ai.url);
      await input('Model').fill('donkey-1');
      await modal().locator('.btn-key', { hasText: 'Save' }).click();
      await win().locator('[data-action="ai-resolve"]', { hasText: 'Resolve with AI' }).click();
      const sug = win().locator('.ai-suggestion[data-conflict="1"]');
      await sug.waitFor();
      if (!/Both sides added an allowed origin/.test(await sug.innerText())) throw new Error('no reason shown');
      if (!/high confidence/.test(await sug.innerText())) throw new Error('no confidence shown');
      const call = ai.seen.find((s) => s.url.endsWith('/chat/completions'));
      const sent = JSON.parse(call.body);
      const user = sent.messages[1].content;
      if (!/src\/cors\.js/.test(user) || !/localhost:5173/.test(user) || !/staging\.harbor/.test(user) || !/stash was applied/.test(user)) throw new Error(`prompt: ${user.slice(0, 400)}`);
      if (!/<<<<<<< /.test(fs.readFileSync(path.join(t.fx.repo, 'src/cors.js'), 'utf8'))) throw new Error('the file changed before the suggestion was used');
      await t.shot('34-ai-conflict-suggestion');
      await sug.locator('.btn', { hasText: 'Use suggestion' }).click();
      await win().locator('.conflict.resolved', { hasText: 'Kept the AI suggestion' }).waitFor();
      await win().locator('.merge-bar .btn-key', { hasText: 'Save & mark resolved' }).click();
      await waitFor(() => fs.readFileSync(path.join(t.fx.repo, 'src/cors.js'), 'utf8') === MERGED, { message: 'the suggestion saved to the file' });
      await waitFor(() => !git('diff', '--name-only', '--diff-filter=U').trim(), { message: 'cors.js marked resolved' });
    } finally {
      ai.server.close();
    }
  });

  await step('with the conflict resolved, Stash works again', async () => {
    await refresh();
    await win().locator('.key[data-key="stash"]').click();
    await win().locator('.toast', { hasText: 'Changes stashed' }).waitFor();
    if (stashCount() !== before + 1) throw new Error(`${stashCount()} stashes, expected ${before + 1}`);
  });

  await step('no renderer errors were logged', async () => {
    if (t.errors.length) throw new Error(t.errors.join('\n'));
  });
}

main()
  .catch((e) => {
    console.error('Fatal:', e);
    results.push({ name: 'fatal', ok: false, error: e.message });
  })
  .finally(async () => {
    if (t) await t.app.close().catch(() => {});
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
