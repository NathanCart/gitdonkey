'use strict';

// End-to-end: the 1.5 features. A branch that splits from its remote says so
// (labels, a banner, and before push or merge); destructive actions take a
// snapshot you can undo or recover; pull requests, worktrees, find in a
// diff, the command palette, AI explain / review, graph filters, signing,
// submodules and LFS.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { launch } = require('./harness');

const results = [];
let t;
const only = process.env.ONLY ? new RegExp(process.env.ONLY, 'i') : null;

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
  if (only && !only.test(name)) return;
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✖ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
    await t.shot(`FAIL-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => {});
    await closeModals();
  }
}

const win = () => t.win;
const modal = () => win().locator('.modal').last();
/** A dialog field by its exact label. */
const field = (m, label) => m.locator('.field').filter({ has: win().locator('.field-label', { hasText: new RegExp(`^${label}$`) }) });
const refresh = () => win().evaluate(() => window.__gitdonkey.refresh());
const env = () => ({ ...process.env, HOME: t.home, GIT_CONFIG_NOSYSTEM: '1' });
const git = (...args) => execFileSync('git', args, { cwd: t.fx.repo, env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' });
async function closeModals() {
  for (let i = 0; i < 4 && (await win().locator('.overlay').count()); i++) await win().keyboard.press('Escape');
}

/** A teammate commits `file` on `branch` and pushes it to origin. */
function teammatePush(branch, file, content) {
  const dir = fs.mkdtempSync(path.join(t.work, 'mate-'));
  gitIn(dir, 'clone', '-q', '-b', branch, t.fx.bare, 'c');
  const c = path.join(dir, 'c');
  fs.mkdirSync(path.dirname(path.join(c, file)), { recursive: true });
  fs.writeFileSync(path.join(c, file), content);
  gitIn(c, 'add', '-A');
  gitIn(c, '-c', 'user.name=Teammate', '-c', 'user.email=mate@example.dev', 'commit', '-qm', `Add ${file}`);
  gitIn(c, 'push', '-q', 'origin', branch);
}

/** A stand-in for api.github.com: GraphQL for the list, REST to open one. */
function fakeGitHub() {
  const state = { pulls: [], created: [], auth: [] };
  const node = (p) => ({
    number: p.number, title: p.title, url: `https://github.com/acme/harbor-api/pull/${p.number}`, isDraft: Boolean(p.draft),
    createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-24T10:00:00Z', additions: 10, deletions: 2, changedFiles: 3,
    reviewDecision: p.review || null, mergeable: 'MERGEABLE', author: { login: p.author || 'hana', avatarUrl: null },
    headRefName: p.head, headRefOid: p.oid || '0'.repeat(40), baseRefName: p.base,
    headRepositoryOwner: { login: p.fork || 'acme' }, headRepository: { nameWithOwner: `${p.fork || 'acme'}/harbor-api` },
    commits: { nodes: [{ commit: { statusCheckRollup: p.checks ? { state: p.checks } : null } }] },
  });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      state.auth.push(req.headers.authorization);
      res.setHeader('content-type', 'application/json');
      const json = body ? JSON.parse(body) : {};
      if (req.url === '/graphql') {
        res.end(JSON.stringify({ data: { viewer: { login: 'e2e' }, repository: {
          nameWithOwner: 'acme/harbor-api', isFork: false, defaultBranchRef: { name: 'main' }, parent: null,
          pullRequests: { nodes: state.pulls.map(node) },
        } } }));
      } else if (req.method === 'POST' && req.url === '/repos/acme/harbor-api/pulls') {
        state.created.push(json);
        const number = 9 + state.created.length - 1;
        state.pulls.unshift({ number, title: json.title, head: json.head, base: json.base, draft: json.draft });
        res.statusCode = 201;
        res.end(JSON.stringify({ number, html_url: `https://github.com/acme/harbor-api/pull/${number}` }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: 'Not Found' }));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

/** An OpenAI-compatible endpoint that answers by what it's asked to do. */
function fakeAi() {
  const seen = [];
  const ctl = { slow: false, dropped: 0 };
  const answer = (system) => {
    if (/You explain Git changes/.test(system)) return 'Adds rate-limit headers to every response.\n- Exposes X-RateLimit-Remaining\n- Counts tokens per client\nWatch out: the header shows how full the bucket is.';
    if (/pull request titles/.test(system)) return JSON.stringify({ title: 'Ship rate limits and the audit log', body: 'Adds rate limiting and an audit log.\n\n## Changes\n- Rate limiter\n- Audit log' });
    if (/review code changes/.test(system)) return JSON.stringify({ summary: 'One route is registered twice.', issues: [{ file: 'src/router.js', line: 6, severity: 'high', title: 'Duplicate /vessels route', detail: 'The second entry wins; remove one.' }] });
    return 'Update files';
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => {
      body += d;
    });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'donkey-1' }] }));
      const sent = JSON.parse(body);
      seen.push(sent);
      const reply = () => res.end(JSON.stringify({ choices: [{ message: { content: answer(sent.messages[0].content) } }] }));
      // Slow: answer in half a minute, unless GitDonkey hangs up first.
      if (!ctl.slow) return reply();
      const timer = setTimeout(reply, 30000);
      res.on('close', () => {
        if (!res.writableEnded) {
          clearTimeout(timer);
          ctl.dropped += 1;
        }
      });
      return undefined;
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, ctl, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

async function fetchAll() {
  await win().locator('.key[data-key="fetch"]').click();
  await win().locator('.toast', { hasText: 'Fetched all remotes' }).last().waitFor();
}

let gh;
let ai;

async function main() {
  gh = await fakeGitHub();
  ai = await fakeAi();
  t = await launch({ env: { GITDONKEY_GITHUB_API: gh.url, GITDONKEY_GITHUB_TOKEN: 'e2e-token' } });
  await win().locator('.g-row').first().waitFor({ timeout: 20000 });
  await win().evaluate((url) => window.__gitdonkey.setSetting('ai', { provider: 'custom', models: { custom: 'donkey-1' }, baseUrls: { custom: url }, instructions: '' }, { silent: true }), ai.url);

  // ------------------------------------------------------------ split branches
  await step('a branch that splits from its remote says so: plug, sidebar and banner', async () => {
    teammatePush('develop', 'docs/teammate.md', '# From a teammate\n');
    await fetchAll();
    const banner = win().locator('.sync-banner');
    await banner.waitFor();
    const text = await banner.innerText();
    if (!/develop has split from origin\/develop/.test(text)) throw new Error(`banner: ${text}`);
    if (!/2 commits origin\/develop doesn’t, and it has 1 commit you don’t/.test(text)) throw new Error(`counts: ${text}`);
    const plug = win().locator('.plug.lit.diverged');
    await plug.waitFor();
    if (!/↑2/.test(await plug.innerText()) || !/↓1/.test(await plug.innerText())) throw new Error(`plug: ${await plug.innerText()}`);
    await win().locator('.sb-item.head .ab.split').waitFor();
    await t.shot('40-branch-split');
  });

  await step('pushing a split branch offers to pull first, then pushes', async () => {
    git('reset', '-q', 'README.md'); // Git won't merge over staged changes
    await refresh();
    await win().locator('.key[data-key="push"]').click();
    await modal().locator('.module-head', { hasText: 'develop has split from origin/develop' }).waitFor();
    await modal().locator('.btn', { hasText: 'Pull, then push' }).click();
    await win().locator('.toast', { hasText: 'Pushed develop to origin/develop' }).waitFor({ timeout: 15000 });
    await waitFor(() => win().locator('.sync-banner').isHidden(), { message: 'the banner to go once in sync' });
    if (!fs.existsSync(path.join(t.fx.repo, 'docs/teammate.md'))) throw new Error('the teammate’s commit was not pulled');
  });

  await step('merging into a branch that’s behind asks to pull first', async () => {
    teammatePush('develop', 'docs/second.md', '# Again\n');
    await fetchAll();
    await win().locator('.sync-banner', { hasText: 'origin/develop has 1 commit you don’t' }).waitFor();
    await win().locator('.sb-sec-local .sb-item', { hasText: 'rate-limiter' }).first().click({ button: 'right' });
    await win().locator('.menu-item', { hasText: 'Merge feature/rate-limiter into develop' }).click();
    await modal().locator('.module-head', { hasText: 'develop is behind origin/develop' }).waitFor();
    await modal().locator('.btn', { hasText: 'Pull, then merge' }).click();
    await win().locator('.toast', { hasText: 'Merged feature/rate-limiter into develop' }).waitFor({ timeout: 15000 });
    if (!fs.existsSync(path.join(t.fx.repo, 'docs/second.md'))) throw new Error('did not pull before merging');
    if (!fs.existsSync(path.join(t.fx.repo, 'src/limit.js'))) throw new Error('did not merge');
  });

  // ------------------------------------------------------------ safety net
  const routerNow = () => fs.readFileSync(path.join(t.fx.repo, 'src/router.js'), 'utf8');
  const portsThere = () => fs.existsSync(path.join(t.fx.repo, 'src/ports.js'));
  let edited = '';
  const discardAll = async () => {
    await win().locator('.wip-panel .icon-btn.danger[title^="Discard all"]').click();
    await modal().locator('.btn-key', { hasText: 'Discard everything' }).click();
    await waitFor(() => !portsThere(), { message: 'the working tree to be clean' });
  };

  await step('Discard all keeps a copy first, and Undo on its toast puts everything back', async () => {
    await refresh();
    edited = routerNow();
    if (!portsThere() || !/\/ports/.test(edited)) throw new Error('fixture WIP missing');
    await discardAll();
    const toastEl = win().locator('.toast', { hasText: 'Changes discarded' });
    await toastEl.waitFor();
    if (!/kept a copy of [23] files/.test(await toastEl.innerText())) throw new Error(await toastEl.innerText());
    await t.shot('41-discard-undo-toast');
    await toastEl.locator('.btn', { hasText: 'Undo' }).click();
    await waitFor(() => portsThere() && routerNow() === edited, { message: 'the changes to come back' });
  });

  await step('Recover lost work restores a discard, lists commits a hard reset left behind, and a deleted stash', async () => {
    await discardAll();
    await win().locator('.sb-sec-stashes .icon-btn[title^="Recover lost work"]').click();
    const rv = modal();
    await rv.locator('.rv-row', { hasText: 'Discard all changes' }).first().waitFor();
    await t.shot('42-recover-lost-work');
    await rv.locator('.rv-row', { hasText: 'Discard all changes' }).first().locator('.btn', { hasText: 'Restore' }).click();
    await waitFor(() => portsThere() && routerNow() === edited, { message: 'the snapshot to be restored' });

    // A hard reset leaves the newest commit with no branch pointing at it.
    const tipSubject = git('log', '-1', '--format=%s').trim();
    git('reset', '-q', '--hard', 'HEAD~1');
    await win().locator('.sb-sec-stashes .icon-btn[title^="Recover lost work"]').click();
    const lostRow = modal().locator('.rv-row', { hasText: tipSubject }).first();
    await lostRow.waitFor();
    if (!/after “reset: moving to HEAD~1”/.test(await lostRow.innerText())) throw new Error(await lostRow.innerText());
    await lostRow.locator('.btn', { hasText: 'Create branch' }).click();
    await modal().locator('input').first().fill('rescued');
    await modal().locator('.check', { hasText: 'Check it out' }).click();
    await modal().locator('.btn-key', { hasText: 'Create branch' }).click();
    await waitFor(() => git('log', '-1', '--format=%s', 'rescued').trim() === tipSubject, { message: 'the rescued branch' });

    // Deleting a stash keeps a copy too.
    await win().locator('.sb-stash').first().click({ button: 'right' });
    await win().locator('.menu-item', { hasText: 'Delete stash' }).click();
    await modal().locator('.btn-key', { hasText: 'Delete stash' }).click();
    await waitFor(() => !git('stash', 'list').trim(), { message: 'the stash to be deleted' });
    await win().locator('.sb-sec-stashes .icon-btn[title^="Recover lost work"]').click();
    const dropped = modal().locator('.rv-row', { hasText: 'Dropped stash: audit: clear() experiment' });
    await dropped.waitFor();
    await dropped.locator('.btn', { hasText: 'Keep as stash' }).click();
    await waitFor(() => /audit: clear\(\) experiment/.test(git('stash', 'list')), { message: 'the stash to be back' });
    if (/Dropped stash/.test(git('stash', 'list'))) throw new Error('it should come back under its own name');
  });

  // ------------------------------------------------------------ pull requests
  await step('a repository on GitHub lists its pull requests, with checks and reviews on the branches', async () => {
    gh.state.pulls = [
      { number: 7, title: 'Rate limiter headers', head: 'feature/rate-limiter', base: 'develop', checks: 'SUCCESS', review: 'APPROVED', oid: git('rev-parse', 'feature/rate-limiter').trim() },
      { number: 8, title: 'Fix typos in the README', head: 'docs/typos', base: 'main', checks: 'FAILURE', draft: true, fork: 'fan', author: 'fan' },
    ];
    // origin is "on GitHub"; pushes still land in the local test remote.
    git('remote', 'set-url', 'origin', 'https://github.com/acme/harbor-api.git');
    git('config', `url.${t.fx.bare}.pushInsteadOf`, 'https://github.com/acme/harbor-api.git');
    await refresh();
    const items = win().locator('.sb-sec-pulls .sb-pr');
    await waitFor(async () => (await items.count()) === 2, { message: 'two pull requests in the sidebar' });
    if (!/#7/.test(await items.nth(0).innerText()) || !(await items.nth(0).locator('.pr-led.checks-passing').count())) throw new Error('#7 should show passing checks');
    if (!(await items.nth(0).locator('.pr-review.ok').count())) throw new Error('#7 should show approved');
    if (!(await items.nth(1).evaluate((el) => el.classList.contains('draft')))) throw new Error('#8 is a draft');
    await win().locator('.plug', { hasText: 'feature/rate-limiter' }).locator('.pr-tag.checks-passing', { hasText: '#7' }).first().waitFor();
    if (gh.state.auth.some((a) => a !== 'Bearer e2e-token')) throw new Error(`auth: ${gh.state.auth.join(', ')}`);
    await items.nth(0).click();
    await win().locator('.cd-subject', { hasText: 'Expose limiter headers' }).waitFor();
    await t.shot('43-pull-requests');
  });

  await step('open a pull request for the current branch: it pushes first if needed, then shows up', async () => {
    await win().locator('.sb-sec-pulls .icon-btn[title^="Open a pull request"]').click();
    const m = modal();
    await m.locator('.module-head', { hasText: 'Open a pull request for develop' }).waitFor();
    if ((await m.locator('select').inputValue()) !== 'main') throw new Error('should merge into the default branch');
    await m.locator('.ai-key', { hasText: 'Write with AI' }).click();
    const title = m.locator('.field', { hasText: 'Title' }).locator('input');
    await waitFor(async () => (await title.inputValue()) === 'Ship rate limits and the audit log', { message: 'the AI’s title' });
    if (!/## Changes/.test(await m.locator('textarea').inputValue())) throw new Error('the AI’s description');
    const asked = ai.seen.find((s) => /pull request titles/.test(s.messages[0].content));
    if (!/Merging develop into origin\/main/.test(asked.messages[1].content)) throw new Error(asked.messages[1].content.slice(0, 300));
    await m.locator('textarea').fill('Rate limits, audit log, faster search.');
    await m.locator('.btn-key', { hasText: 'Open pull request' }).click();
    await win().locator('.toast', { hasText: 'Opened pull request #9' }).waitFor({ timeout: 15000 });
    const sent = gh.state.created[0];
    if (sent.head !== 'develop' || sent.base !== 'main' || sent.title !== 'Ship rate limits and the audit log' || !/audit log/.test(sent.body)) throw new Error(JSON.stringify(sent));
    if (git('rev-parse', 'develop').trim() !== git('rev-parse', 'origin/develop').trim()) throw new Error('develop was not pushed first');
    await win().locator('.plug.lit .pr-tag', { hasText: '#9' }).waitFor();
  });

  // Back to a plain local remote for the rest.
  git('remote', 'set-url', 'origin', t.fx.bare);
  try {
    git('config', '--unset', `url.${t.fx.bare}.pushInsteadOf`);
  } catch {
    // not set when the pull request steps were skipped
  }

  // ------------------------------------------------------------ worktrees
  await step('check out a branch in a new worktree; it opens in a tab and shows in the sidebar', async () => {
    await win().locator('.sb-sec-local .sb-item', { hasText: 'main' }).last().click({ button: 'right' });
    await win().locator('.menu-item', { hasText: 'Check out in a new worktree' }).click();
    const m = modal();
    await m.locator('.module-head', { hasText: 'New worktree' }).waitFor();
    const folder = await m.locator('.field', { hasText: 'Folder' }).locator('input').inputValue();
    if (folder !== path.join(path.dirname(t.fx.repo), 'harbor-api-main')) throw new Error(`folder: ${folder}`);
    if (!/Checks out main/.test(await m.locator('.field', { hasText: 'Branch' }).innerText())) throw new Error('hint should say it checks out main');
    await m.locator('.btn-key', { hasText: 'Create worktree' }).click();
    await win().locator('.tab.on', { hasText: 'harbor-api-main' }).waitFor({ timeout: 15000 });
    if (!fs.existsSync(path.join(folder, 'src/server.js'))) throw new Error('worktree folder is empty');
    await win().locator('.tab', { hasText: /^harbor-api$/ }).click();
    await win().locator('.tab.on', { hasText: /^harbor-api$/ }).waitFor();
    const items = win().locator('.sb-sec-worktrees .sb-worktree');
    await waitFor(async () => (await items.count()) === 2, { message: 'two worktrees in the sidebar' });
    await win().locator('.plug', { hasText: 'main' }).locator('.plug-wt').first().waitFor();
    await t.shot('44-worktrees');
  });

  await step('a branch checked out in another worktree opens that worktree; Remove deletes it', async () => {
    await win().locator('.plug', { hasText: /^main/ }).first().dblclick();
    await win().locator('.tab.on', { hasText: 'harbor-api-main' }).waitFor();
    await win().locator('.tab', { hasText: /^harbor-api$/ }).click();
    await win().locator('.tab.on', { hasText: /^harbor-api$/ }).waitFor();
    const folder = path.join(path.dirname(t.fx.repo), 'harbor-api-main');
    await win().locator('.sb-sec-worktrees .sb-worktree', { hasText: 'harbor-api-main' }).click({ button: 'right' });
    await win().locator('.menu-item', { hasText: 'Remove worktree' }).click();
    await modal().locator('.btn-key', { hasText: 'Remove worktree' }).click();
    await waitFor(() => !fs.existsSync(folder), { message: 'the worktree folder to be removed' });
    await waitFor(async () => !(await win().locator('.tab', { hasText: 'harbor-api-main' }).count()), { message: 'its tab to close' });
    await waitFor(async () => !(await win().locator('.sb-sec-worktrees').count()), { message: 'the section to go with one worktree left' });
  });

  // ------------------------------------------------------------ find in a diff
  await step('⌘F in an open diff finds in it: count, next, the whole file, Esc', async () => {
    fs.appendFileSync(path.join(t.fx.repo, 'src/router.js'), '\nexport const fallback = (req, res) => json(res, { ok: false, json: true });\n');
    await refresh();
    await win().locator('.g-row.g-wip').click();
    await win().locator('.wip-panel .file', { hasText: 'router.js' }).first().click();
    await win().locator('#detail .hunk').first().waitFor();
    await win().evaluate(() => window.__gitdonkey.command('search'));
    const bar = win().locator('#detail .find-bar');
    await bar.waitFor();
    if (!(await win().evaluate(() => document.activeElement.classList.contains('find-input')))) throw new Error('the find box should have focus');
    await win().keyboard.type('json');
    const count = () => bar.locator('.find-count').innerText();
    await waitFor(async () => /^1 of \d+$/.test(await count()), { message: 'a match count' });
    const total = Number((await count()).split(' of ')[1]);
    const painted = await win().evaluate(() => CSS.highlights.get('find-hit').size);
    if (painted !== total) throw new Error(`${painted} highlighted, ${total} counted`);
    await win().keyboard.press('Enter');
    await waitFor(async () => (await count()) === `2 of ${total}`, { message: 'the second match' });
    await win().keyboard.press('Shift+Enter');
    await waitFor(async () => (await count()) === `1 of ${total}`, { message: 'back to the first' });
    await t.shot('45-find-in-diff');
    await bar.locator('.find-whole').click();
    await waitFor(async () => Number(((await count()).split(' of ')[1]) || 0) > total, { message: 'more matches in the whole file' });
    await bar.locator('.find-input').fill('nothing-like-this');
    await waitFor(async () => (await count()) === 'No matches', { message: 'no matches' });
    await win().keyboard.press('Escape');
    await waitFor(() => bar.isHidden(), { message: 'the find bar to close' });
    if (!(await win().locator('#detail .hunk').count())) throw new Error('Esc in find should leave the diff open');
    if (await win().evaluate(() => CSS.highlights.has('find-hit'))) throw new Error('highlights left behind');
    await win().evaluate(() => window.__gitdonkey.setSetting('diffContext', 'hunks'));
    await win().keyboard.press('Escape');
    await win().evaluate(() => window.__gitdonkey.command('search'));
    await win().locator('.graph-search').waitFor();
    await win().keyboard.press('Escape');
  });

  // ------------------------------------------------------------ command palette
  await step('the command palette finds commands, files and branches, and runs them', async () => {
    await win().evaluate(() => window.__gitdonkey.command('palette'));
    const pal = win().locator('.modal.palette');
    await pal.waitFor();
    await win().keyboard.type('ports');
    const first = pal.locator('.palette-row').first();
    await waitFor(async () => /src\/ports\.js/.test(await first.innerText()) && /Changed file/.test(await first.innerText()), { message: 'the changed file first' });
    await t.shot('46-command-palette');
    await win().keyboard.press('Enter');
    await win().locator('#detail .dh-name', { hasText: 'ports.js' }).waitFor();
    await win().keyboard.press('Escape');

    await win().evaluate(() => window.__gitdonkey.command('palette'));
    await pal.waitFor();
    await win().keyboard.type('rcvr lost');
    await waitFor(async () => /Recover lost work/.test(await pal.locator('.palette-row.on').innerText()), { message: 'fuzzy match on Recover lost work' });
    await win().keyboard.press('Enter');
    await modal().locator('.module-head', { hasText: 'Recover lost work' }).waitFor();
    await win().keyboard.press('Escape');

    await win().evaluate(() => window.__gitdonkey.command('palette'));
    await pal.waitFor();
    await win().keyboard.type('check out rate');
    await waitFor(async () => /Check out feature\/rate-limiter/.test(await pal.locator('.palette-row.on').innerText()), { message: 'the branch' });
    await win().keyboard.press('Escape');
    await waitFor(async () => !(await win().locator('.modal.palette').count()), { message: 'the palette to close' });
  });

  // ------------------------------------------------------------ AI
  await step('Explain on a commit shows what it does, in the details panel', async () => {
    await win().locator('.g-row', { hasText: 'Expose limiter headers' }).click();
    await win().locator('.cd-subject', { hasText: 'Expose limiter headers' }).waitFor();
    await win().locator('.cd-panel .explain-btn').click();
    const card = win().locator('.cd-panel .ai-card:not(.loading)');
    await card.waitFor();
    if (!/Adds rate-limit headers/.test(await card.innerText()) || (await card.locator('.ai-list li').count()) !== 2 || !(await card.locator('.ai-warn').count())) throw new Error(await card.innerText());
    const asked = ai.seen.find((s) => /You explain Git changes/.test(s.messages[0].content));
    if (!/Expose limiter headers/.test(asked.messages[1].content) || !/X-RateLimit/.test(asked.messages[1].content)) throw new Error('the commit and its diff should be sent');
    await t.shot('47-ai-explain');
  });

  await step('Summarise a branch compares it with main', async () => {
    await win().locator('.sb-sec-local .sb-item', { hasText: 'rate-limiter' }).first().click({ button: 'right' });
    await win().locator('.menu-item', { hasText: 'Summarise with AI (vs main)' }).click();
    await modal().locator('.ai-text', { hasText: 'Adds rate-limit headers' }).waitFor();
    const asked = ai.seen.filter((s) => /You explain Git changes/.test(s.messages[0].content)).pop();
    if (!/Branch feature\/rate-limiter, compared with main/.test(asked.messages[1].content)) throw new Error(asked.messages[1].content.slice(0, 200));
    await modal().locator('.btn-key', { hasText: 'Done' }).click();
  });

  await step('Review reads the staged changes and jumps to what it found', async () => {
    git('add', 'src/router.js');
    await refresh();
    await win().locator('.g-row.g-wip').click();
    await win().locator('.wip-panel .review-btn').click();
    const m = modal();
    await m.locator('.review-summary', { hasText: '1 thing to look at' }).waitFor();
    if (!(await m.locator('.review-row.sev-high', { hasText: 'Duplicate /vessels route' }).count())) throw new Error('the issue should be listed');
    const asked = ai.seen.find((s) => /review code changes/.test(s.messages[0].content));
    if (!/src\/router\.js/.test(asked.messages[1].content) || !/\+export const fallback|cached: true/.test(asked.messages[1].content)) throw new Error('the staged diff should be sent');
    await t.shot('48-ai-review');
    await m.locator('.review-loc', { hasText: 'src/router.js:6' }).click();
    await win().locator('#detail .dh-kind', { hasText: 'Staged' }).waitFor();
    await waitFor(async () => (await win().locator('#detail .dl.flash').count()) > 0, { message: 'line 6 to flash' });
    const lineNo = await win().locator('#detail .dl.flash').first().locator('.ln').nth(1).innerText();
    if (lineNo !== '6') throw new Error(`landed on ${lineNo}`);
    await win().keyboard.press('Escape');
  });

  // ------------------------------------------------------------ graph filters
  const rowWith = (text) => win().locator('.g-row', { hasText: text });
  await step('the graph shows only the current branch, hides a branch, and highlights an author', async () => {
    await win().locator('.g-row.g-wip').click();
    await rowWith('Expose limiter headers').first().waitFor();
    await win().locator('.gh-filter').click();
    await win().locator('.menu-item', { hasText: 'Only develop' }).click();
    await win().locator('.graph-filterbar', { hasText: 'Only develop' }).waitFor();
    await waitFor(async () => !(await rowWith('Expose limiter headers').count()), { message: 'rate-limiter’s commits to go' });
    if (!(await rowWith('Add audit log').count())) throw new Error('develop’s own commits should stay');
    if (!(await win().locator('.gh-filter.on').count())) throw new Error('the filter key should light up');
    await t.shot('49-graph-filter');
    await win().locator('.graph-filterbar .btn', { hasText: 'Show everything' }).click();
    await rowWith('Expose limiter headers').first().waitFor();
    if (await win().locator('.graph-filterbar').isVisible()) throw new Error('the bar should go');

    await win().locator('.sb-sec-local .sb-item', { hasText: 'rate-limiter' }).first().click({ button: 'right' });
    await win().locator('.menu-item', { hasText: 'Hide in the graph' }).click();
    await win().locator('.graph-filterbar', { hasText: 'Hiding feature/rate-limiter' }).waitFor();
    await waitFor(async () => !(await win().locator('.plug', { hasText: /^feature\/rate-limiter/ }).count()), { message: 'its plug to go' });
    await win().locator('.sb-sec-local .sb-item.graph-hidden', { hasText: 'rate-limiter' }).locator('.gh-eye').click();
    await waitFor(async () => !(await win().locator('.graph-filterbar').isVisible()), { message: 'nothing hidden any more' });

    await win().locator('.gh-filter').click();
    await win().locator('.menu-item', { hasText: 'Highlight one author' }).hover();
    await win().locator('.menu-item', { hasText: /^Hana Kobayashi/ }).click();
    await win().locator('.graph-filterbar', { hasText: 'Highlighting Hana Kobayashi' }).waitFor();
    await waitFor(async () => (await rowWith('Expose limiter headers').first().evaluate((el) => !el.classList.contains('dim'))) && (await rowWith('Add audit log').first().evaluate((el) => el.classList.contains('dim'))), { message: 'others’ commits dimmed' });
    await win().locator('.graph-filterbar .btn', { hasText: 'Show everything' }).click();
    await waitFor(async () => !(await win().locator('.g-row.dim').count()), { message: 'nothing dimmed' });
  });

  // ------------------------------------------------------------ signing
  await step('sign commits with an SSH key from Settings; the commit shows Verified', async () => {
    const ssh = path.join(t.home, '.ssh');
    fs.mkdirSync(ssh, { recursive: true });
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'e2e@laptop', '-f', path.join(ssh, 'id_ed25519')]);
    await win().locator('.key[data-key="settings"]').click();
    await modal().locator('[data-action="signing"]').click();
    const m = modal();
    await m.locator('.module-head', { hasText: 'Sign commits' }).waitFor();
    await field(m, 'Sign with').locator('select').selectOption('ssh');
    if (!/id_ed25519\.pub/.test(await field(m, 'SSH key').locator('select').innerText())) throw new Error('the key in ~/.ssh should be offered');
    await field(m, 'For').locator('select').selectOption('local');
    await t.shot('50-signing');
    await m.locator('.btn-key', { hasText: 'Save' }).click();
    await win().locator('.toast', { hasText: 'Commits will be signed' }).waitFor();
    await win().keyboard.press('Escape');
    if (git('config', '--local', 'gpg.format').trim() !== 'ssh') throw new Error('gpg.format');
    if (!fs.readFileSync(path.join(ssh, 'allowed_signers'), 'utf8').includes('ssh-ed25519')) throw new Error('own key should be trusted');
    await win().locator('.g-row.g-wip').click();
    await win().locator('.wip-panel .sign-mark').waitFor();
    if (!git('diff', '--cached', '--name-only').trim()) {
      git('add', 'README.md');
      await refresh();
    }
    await win().locator('.commit-summary').fill('A signed commit');
    await win().locator('.commit-btn').click();
    await win().locator('.toast', { hasText: 'Committed' }).first().waitFor();
    await win().locator('.g-row', { hasText: 'A signed commit' }).click();
    const badge = win().locator('.cd-panel .sig-badge.sig-verified');
    await badge.waitFor();
    if (!/Verified/.test(await badge.innerText())) throw new Error(await badge.innerText());
    git('config', '--local', 'commit.gpgsign', 'false');
  });

  // ------------------------------------------------------------ submodules and LFS
  await step('a submodule that isn’t set up gets a banner; setting it up and its changes show plainly', async () => {
    const lib = path.join(t.work, 'shared-lib');
    fs.mkdirSync(lib);
    gitIn(lib, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(lib, 'lib.js'), 'export const v = 1;\n');
    gitIn(lib, 'add', '-A');
    gitIn(lib, '-c', 'user.name=Lib', '-c', 'user.email=lib@example.dev', 'commit', '-qm', 'lib v1');
    fs.appendFileSync(path.join(t.home, '.gitconfig'), '[protocol "file"]\n\tallow = always\n');
    git('reset', '-q');
    git('submodule', 'add', '-q', lib, 'vendor/shared-lib');
    git('commit', '-qm', 'Add the shared lib', '--', '.gitmodules', 'vendor/shared-lib');
    git('submodule', 'deinit', '-q', '-f', 'vendor/shared-lib');
    await refresh();
    await win().locator('.g-row.g-wip').click().catch(() => {});
    const banner = win().locator('.repo-banner', { hasText: 'The submodule vendor/shared-lib isn’t set up' });
    await banner.waitFor();
    await win().locator('.sb-sec-submodules .sb-submodule.sub-missing', { hasText: 'vendor/shared-lib' }).waitFor();
    await banner.locator('.btn', { hasText: 'Set it up' }).click();
    await win().locator('.toast', { hasText: 'vendor/shared-lib is at the recorded commit' }).waitFor({ timeout: 15000 });
    await waitFor(() => fs.existsSync(path.join(t.fx.repo, 'vendor/shared-lib/lib.js')), { message: 'the submodule checked out' });
    await waitFor(() => win().locator('.repo-banner').isHidden(), { message: 'the banner to go' });

    const inner = path.join(t.fx.repo, 'vendor/shared-lib');
    fs.writeFileSync(path.join(inner, 'lib.js'), 'export const v = 2;\n');
    gitIn(inner, '-c', 'user.name=Lib', '-c', 'user.email=lib@example.dev', 'commit', '-qam', 'lib v2');
    await refresh();
    const row = win().locator('.wip-panel .files-unstaged .file', { hasText: 'shared-lib' });
    await row.waitFor();
    if (!/new commits/.test(await row.innerText())) throw new Error(await row.innerText());
    await row.click();
    await win().locator('#detail .detail-msg', { hasText: 'Submodule vendor/shared-lib' }).waitFor();
    if (!/Moved from [0-9a-f]{7} to [0-9a-f]{7}/.test(await win().locator('#detail .detail-msg').innerText())) throw new Error('should say where it moved');
    await t.shot('51-submodule');
    await win().keyboard.press('Escape');
  });

  await step('a repository using Git LFS without it installed says so, and pointer files read as LFS files', async () => {
    fs.writeFileSync(path.join(t.fx.repo, '.gitattributes'), '*.psd filter=lfs diff=lfs merge=lfs -text\n');
    fs.mkdirSync(path.join(t.fx.repo, 'design'), { recursive: true });
    fs.writeFileSync(path.join(t.fx.repo, 'design/logo.psd'), `version https://git-lfs.github.com/spec/v1\noid sha256:${'c'.repeat(64)}\nsize 2621440\n`);
    git('add', '.gitattributes', 'design/logo.psd');
    git('commit', '-qm', 'Add the logo (LFS)', '--', '.gitattributes', 'design/logo.psd');
    await refresh();
    const banner = win().locator('.repo-banner', { hasText: 'Git LFS isn’t installed' });
    await banner.waitFor();
    if (!/\*\.psd/.test(await banner.innerText())) throw new Error('should name the LFS patterns');
    await win().locator('.g-row', { hasText: 'Add the logo (LFS)' }).click();
    await win().locator('.cd-panel .file', { hasText: 'logo.psd' }).click();
    await win().locator('#detail .detail-msg', { hasText: 'Stored in Git LFS' }).waitFor();
    if (!/2\.5 MB, new/.test(await win().locator('#detail .detail-msg').innerText())) throw new Error(await win().locator('#detail .detail-msg').innerText());
    await win().keyboard.press('Escape');
    await win().locator('.g-row.g-wip').click().catch(() => {});
    await banner.locator('.btn', { hasText: 'Not now' }).click();
    await waitFor(() => win().locator('.repo-banner').isHidden(), { message: 'dismissed' });
  });

  // ------------------------------------------------------------ clicking and dragging in a long graph
  const scroller = () => win().locator('.graph-scroll');
  const scrollTop = () => scroller().evaluate((el) => el.scrollTop);
  await step('clicking a commit selects it where it is, so a double-click lands on the same branch', async () => {
    // Enough history to scroll: 60 commits on a branch of their own.
    const tree = git('rev-parse', 'HEAD^{tree}').trim();
    let parent = git('rev-parse', 'HEAD').trim();
    for (let i = 1; i <= 60; i++) parent = git('commit-tree', tree, '-p', parent, '-m', `Filler ${i}`).trim();
    git('update-ref', 'refs/heads/filler', parent);
    await refresh();
    await win().locator('.g-row', { hasText: 'Filler 60' }).waitFor();
    await win().keyboard.press('Escape');
    await scroller().evaluate((el) => {
      el.scrollTop = 400;
    });
    await waitFor(async () => (await scrollTop()) === 400, { message: 'scrolled' });
    // A row near the bottom of what's on screen: centring it would scroll a long way.
    const low = await win().evaluate(() => {
      const s = document.querySelector('.graph-scroll').getBoundingClientRect();
      const rows = [...document.querySelectorAll('.g-row')].filter((r) => {
        const b = r.getBoundingClientRect();
        return b.bottom < s.bottom - 10 && b.top > s.bottom - 160;
      });
      return rows.length ? rows[0].querySelector('.msg-text').textContent : null;
    });
    if (!low) throw new Error('no row near the bottom');
    await win().locator('.g-row', { hasText: low }).first().click();
    await win().locator('.g-row.selected', { hasText: low }).waitFor();
    await win().waitForTimeout(150);
    if ((await scrollTop()) !== 400) throw new Error(`the graph scrolled to ${await scrollTop()} on a click`);

    // Double-click a branch below: its plug must not move between the clicks.
    // Bring release/1.1 into view, near the bottom (the graph only draws rows near the screen).
    await win().evaluate(() => {
      const app = window.__gitdonkey;
      const i = app.indexByHash.get(app.data.refs.local.find((b) => b.name === 'release/1.1').hash);
      app.graph.scroller.scrollTop = Math.max(0, (i + 3) * 28 - app.graph.scroller.clientHeight);
    });
    const plug = win().locator('.plug', { hasText: /^release\/1\.1/ }).first();
    await plug.waitFor();
    await win().waitForTimeout(100);
    const at = await scrollTop();
    const box = await plug.boundingBox();
    await plug.dblclick();
    await win().waitForTimeout(150);
    if ((await scrollTop()) !== at) throw new Error('the graph moved between the clicks');
    const now = await plug.boundingBox();
    if (Math.abs(now.y - box.y) > 1) throw new Error('the plug moved between the clicks');
    // The double-click asked to check it out: a stash question if the changes are in the way, or done.
    await waitFor(async () => (await win().locator('.modal', { hasText: 'Stash & continue' }).count()) > 0 || git('branch', '--show-current').trim() === 'release/1.1', { message: 'the double-click to check out release/1.1' });
    if (await win().locator('.modal', { hasText: 'Stash & continue' }).count()) await modal().locator('.btn', { hasText: 'Cancel' }).click();
    else git('checkout', '-q', 'develop');
    await refresh();
  });

  await step('holding a branch cable at the bottom edge scrolls the graph down, and at the top scrolls it back', async () => {
    await scroller().evaluate((el) => {
      el.scrollTop = 0;
    });
    const src = win().locator('.plug', { hasText: /^filler/ }).first();
    await src.waitFor();
    const a = await src.boundingBox();
    const box = await scroller().boundingBox();
    await win().mouse.move(a.x + 20, a.y + a.height / 2);
    await win().mouse.down();
    await win().mouse.move(a.x + 60, a.y + 40, { steps: 4 });
    await win().mouse.move(box.x + box.width / 2, box.y + box.height - 12, { steps: 10 });
    await waitFor(async () => (await scrollTop()) > 600, { message: 'the graph to scroll down while held at the edge' });
    if (!(await win().locator('.patch-overlay').isVisible())) throw new Error('the cable should still be drawn');
    await t.shot('52-drag-autoscroll');
    await win().mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    const held = await scrollTop();
    await win().waitForTimeout(300);
    if (Math.abs((await scrollTop()) - held) > 2) throw new Error('it should stop scrolling away from the edges');
    await win().mouse.move(box.x + box.width / 2, box.y - 10, { steps: 10 });
    await waitFor(async () => (await scrollTop()) < held - 300, { message: 'the graph to scroll back up over the header' });
    await win().mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
    await win().mouse.up();
    await waitFor(async () => !(await win().locator('.patch-overlay').isVisible()), { message: 'the cable to go when dropped on nothing' });
    if (await win().locator('.menu').count()) throw new Error('dropping on nothing should open no menu');
  });

  // ------------------------------------------------------------ waiting: AI and pushes
  await step('a slow AI review counts the seconds and Stop stops it', async () => {
    ai.ctl.slow = true;
    try {
      fs.writeFileSync(path.join(t.fx.repo, 'src/slow.js'), 'export const slow = 1;\n');
      git('add', 'src/slow.js');
      await refresh();
      await win().locator('.g-row.g-wip').click();
      await win().locator('.wip-panel .review-btn').click();
      const m = modal();
      await waitFor(async () => /Reading \d+ staged files? with .*… [2-9]s/.test(await m.innerText()), { message: 'the seconds counting up', timeout: 8000 });
      await t.shot('53-ai-waiting');
      const key = m.locator('.modal-foot .btn').first();
      if ((await key.innerText()) !== 'Stop') throw new Error(`the key reads ${await key.innerText()}`);
      await key.click();
      await m.locator('.rv-intro', { hasText: 'Stopped.' }).waitFor();
      await waitFor(async () => (await key.innerText()) === 'Review again', { message: 'Review again' });
      await waitFor(() => ai.ctl.dropped >= 1, { message: 'the request to be hung up on' });
      await m.locator('.btn-key', { hasText: 'Done' }).click();

      // Generate, pressed again, stops too.
      const asked = ai.seen.length;
      await win().locator('.wip-panel .ai-btn', { hasText: 'Generate' }).click();
      await waitFor(async () => /Stop · \d+s/.test(await win().locator('.wip-panel .ai-btn').innerText()), { message: 'Generate to read Stop' });
      await waitFor(() => ai.seen.length > asked, { message: 'the request to reach the AI' });
      await win().locator('.wip-panel .ai-btn').click();
      await waitFor(async () => (await win().locator('.wip-panel .ai-btn').innerText()).trim() === 'Generate', { message: 'Generate again' });
      await waitFor(() => ai.ctl.dropped >= 2, { message: 'the second request to be hung up on' });
      if (await win().locator('.toast', { hasText: 'Couldn’t write a message' }).count()) throw new Error('stopping isn’t an error');
    } finally {
      ai.ctl.slow = false;
    }
  });

  await step('while pushing, the Push key spins and can’t be pressed, and so does the branch', async () => {
    const hook = path.join(t.fx.repo, '.git/hooks/pre-push');
    fs.writeFileSync(hook, '#!/bin/sh\nsleep 2\n', { mode: 0o755 });
    try {
      git('commit', '-qm', 'Something to push');
      await refresh();
      await win().locator('.key[data-key="push"]').click();
      const key = win().locator('.key[data-key="push"].working');
      await key.waitFor();
      if (!(await key.isDisabled())) throw new Error('Push should be disabled while it runs');
      await win().locator('.plug.lit.working .plug-spin').first().waitFor();
      await win().locator('.sb-sec-local .sb-item.head .sb-spin').waitFor();
      await t.shot('54-push-working');
      await win().locator('.toast', { hasText: /Pushed develop/ }).first().waitFor({ timeout: 15000 });
      await waitFor(async () => !(await win().locator('.key.working, .plug.working, .sb-spin').count()), { message: 'the spinners to stop' });
      if (git('rev-parse', 'develop').trim() !== git('rev-parse', 'origin/develop').trim()) throw new Error('not pushed');
    } finally {
      fs.rmSync(hook, { force: true });
    }
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
    if (gh) gh.server.close();
    if (ai) ai.server.close();
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
