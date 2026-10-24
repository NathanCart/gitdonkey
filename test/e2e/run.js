'use strict';

// End-to-end: drives the real Electron app through every major workflow
// against a demo repository and a bare "origin", asserting on both the UI and
// the resulting Git state. Screenshots land in test/e2e/shots/.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { launch } = require('./harness');

const results = [];
let t;
let repo;
let bare;

const isMac = process.platform === 'darwin';
const MOD = isMac ? 'Meta' : 'Control';

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: t.home, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' } }).trim();
}

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
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✔ ${name}`);
  } catch (e) {
    const toasts = await t.win.locator('.toast').allTextContents().catch(() => []);
    if (toasts.length) e.message += `\n      visible toasts: ${toasts.join(' | ')}`;
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✖ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
    await t.shot(`FAIL-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`).catch(() => {});
  }
}

const win = () => t.win;
const row = (text) => win().locator('.g-row', { hasText: text }).first();
const menuItem = (text) => win().locator('.menu-item', { hasText: text }).first();
const modal = () => win().locator('.modal').last();
const toastWith = (text) => win().locator('.toast', { hasText: text }).first();
const sbItem = (text) => win().locator('.sb-item', { hasText: text }).first();
const fileRow = (section, name) => win().locator(`.files-${section} .file`, { hasText: name }).first();

async function clickKey(id) {
  await win().locator(`.key[data-key="${id}"]`).click();
}

async function closeToasts() {
  await win().evaluate(() => document.querySelectorAll('.toast').forEach((el) => el.remove()));
}

async function main() {
  t = await launch();
  repo = t.fx.repo;
  bare = t.fx.bare;
  console.log(`Fixture: ${repo}`);
  await win().waitForSelector('.g-row', { timeout: 20000 });
  await win().waitForTimeout(400);

  await step('opens the repository from the command line with no errors', async () => {
    const title = await win().locator('.tab.on .tab-name').textContent();
    if (title !== 'harbor-api') throw new Error(`tab title ${title}`);
    if (await win().locator('.toast-error').count()) throw new Error(await win().locator('.toast-error').first().textContent());
    await t.shot('01-graph');
  });

  await step('graph shows every commit, WIP row, plugs and lanes', async () => {
    const commitCount = Number(git('rev-list', '--count', '--branches', '--remotes', '--tags', 'HEAD'));
    const rows = await win().evaluate(() => window.__gitdonkey.rows.length);
    if (rows !== commitCount + 1) throw new Error(`rows ${rows} vs commits ${commitCount} + WIP`);
    await row('Uncommitted changes').waitFor();
    // Every WIP count stays fully visible inside the message column.
    const clipped = await win().evaluate(() => {
      const cell = document.querySelector('.g-row.g-wip .g-msg').getBoundingClientRect();
      return [...document.querySelectorAll('.g-row.g-wip .count')].some((c) => c.getBoundingClientRect().right > cell.right + 0.5);
    });
    if (clipped) throw new Error('WIP counts are clipped');
    // Header cells never spill past the graph pane into the commit panel.
    const spill = await win().evaluate(() => {
      const pane = document.querySelector('#graph').getBoundingClientRect();
      return [...document.querySelectorAll('.graph-head .gh-cell')].filter((c) => getComputedStyle(c).display !== 'none' && c.getBoundingClientRect().right > pane.right + 0.5).map((c) => c.textContent);
    });
    if (spill.length) throw new Error(`header cells overflow: ${spill}`);
    // Every commit row carries its stamped short SHA at the default window size.
    const shas = await win().evaluate(() => [...document.querySelectorAll('.g-row:not(.g-wip) .g-sha')].filter((c) => getComputedStyle(c).display !== 'none' && /^[0-9a-f]{7}$/.test(c.textContent)).length);
    if (shas < 10) throw new Error(`SHA column hidden (${shas} visible)`);
    // Offline, every author shows an initials avatar in the author column.
    const initialsShown = await win().locator('.g-row .g-author .avatar', { hasText: 'MO' }).count();
    if (!initialsShown) throw new Error('author avatars missing');
    for (const name of ['develop', 'origin/develop', 'feature/rate-limiter', 'release/1.1', 'fix/null-session', 'feature/auth-tokens', 'v1.0.0']) {
      if (!(await win().locator('.plug', { hasText: name }).count())) throw new Error(`missing plug ${name}`);
    }
    const lit = await win().locator('.plug.lit').textContent();
    if (!lit.includes('develop')) throw new Error(`lit plug ${lit}`);
    const width = await win().evaluate(() => window.__gitdonkey.layoutData.width);
    if (width < 3) throw new Error(`graph width ${width}`);
    // Rows line up with the canvas: every row is exactly one row-height tall.
    const heights = await win().evaluate(() => [...document.querySelectorAll('.g-row')].slice(0, 6).map((r) => r.getBoundingClientRect().height));
    if (heights.some((h) => Math.abs(h - 28) > 0.5)) throw new Error(`row heights ${heights}`);
  });

  await step('sidebar lists local, remote, stash and tag refs with ahead counts', async () => {
    for (const s of ['auth-tokens', 'rate-limiter', 'null-session', '1.1', 'main']) await sbItem(s).waitFor({ timeout: 3000 });
    const remote = win().locator('.sb-sec-remote');
    if (!(await remote.locator('.sb-remote', { hasText: 'origin' }).count())) throw new Error('origin remote missing');
    if ((await remote.locator('.sb-item').count()) !== 3) throw new Error(`remote branches ${await remote.locator('.sb-item').count()}`);
    const sectionBox = await remote.boundingBox();
    if (sectionBox.height < 80) throw new Error(`remote section collapsed (${sectionBox.height}px)`);
    if (!(await win().locator('.sb-stash', { hasText: 'audit: clear() experiment' }).count())) throw new Error('stash missing');
    const ahead = await win().locator('.sb-branch.head .ab.ahead').textContent();
    if (ahead.trim() !== '2') throw new Error(`ahead ${ahead}`);
    if ((await win().locator('.sb-tag').count()) !== 3) throw new Error('tags');
  });

  await step('sidebar filter narrows the tree', async () => {
    await win().locator('.sb-filter-input').fill('rate');
    await waitFor(async () => (await win().locator('.sb-sec-local .sb-item').count()) === 1, { message: 'filter' });
    await win().locator('.sb-filter-input').fill('');
  });

  await step('working tree panel shows staged, unstaged and untracked files', async () => {
    await fileRow('unstaged', 'router.js').waitFor();
    await fileRow('unstaged', 'ports.js').waitFor();
    await fileRow('staged', 'README.md').waitFor();
    const label = await win().locator('.commit-btn').textContent();
    if (!/Commit 1 file to develop/.test(label)) throw new Error(label);
    if (!(await win().locator('.commit-btn').isDisabled())) throw new Error('commit should be disabled without summary');
  });

  await step('opens a diff, renders hunks with syntax highlighting', async () => {
    await fileRow('unstaged', 'router.js').click();
    await win().locator('#detail .hunk').first().waitFor();
    if (!(await win().locator('#detail .dl.add').count())) throw new Error('no added lines');
    if (!(await win().locator('#detail .code .hljs-string').count())) throw new Error('no syntax highlighting');
    await t.shot('02-diff-unified');
  });

  await step('split diff view', async () => {
    await win().locator('#detail .seg-btn', { hasText: 'Split' }).click();
    await win().locator('#detail .diff-split').waitFor();
    await t.shot('03-diff-split');
    await win().locator('#detail .seg-btn', { hasText: 'Unified' }).click();
    await win().locator('#detail .diff-unified').waitFor();
  });

  await step('stages a single line from an untracked file', async () => {
    await fileRow('unstaged', 'ports.js').click();
    await win().locator('#detail .dl.add').first().waitFor();
    await win().locator('#detail .dl.add', { hasText: 'export function isPort' }).click();
    await win().locator('.sel-bar').waitFor();
    await t.shot('04-line-selection');
    await win().locator('.sel-bar .btn', { hasText: 'Stage lines' }).click();
    await waitFor(() => git('show', ':src/ports.js').includes('export function isPort'), { message: 'line staged' });
    const idx = git('show', ':src/ports.js');
    if (idx.includes('PORTS')) throw new Error(`unselected lines staged: ${idx}`);
    await fileRow('staged', 'ports.js').waitFor();
    await fileRow('unstaged', 'ports.js').waitFor();
  });

  await step('stages a whole hunk', async () => {
    await fileRow('unstaged', 'router.js').click();
    await win().locator('#detail .hunk-head .btn', { hasText: 'Stage hunk' }).first().click();
    await waitFor(() => git('diff', '--cached', '--name-only').includes('src/router.js'), { message: 'hunk staged' });
    await fileRow('staged', 'router.js').waitFor();
    // The open diff follows the file into the staged list.
    await waitFor(async () => (await win().locator('#detail .dh-kind').textContent()) === 'Staged', { message: 'diff switched to staged' });
    await win().locator('#detail .hunk-head .btn', { hasText: 'Unstage hunk' }).first().waitFor();
  });

  await step('unstages a file and stages everything', async () => {
    await win().keyboard.press('Escape');
    await win().locator('#detail').waitFor({ state: 'hidden' });
    await fileRow('staged', 'router.js').hover();
    await fileRow('staged', 'router.js').locator('.row-action').click();
    await waitFor(() => !git('diff', '--cached', '--name-only').includes('src/router.js'), { message: 'unstaged' });
    await win().locator('.files-unstaged .files-head .btn', { hasText: 'Stage all' }).click();
    await waitFor(() => git('diff', '--name-only') === '' && !git('status', '--porcelain').includes('??'), { message: 'all staged' });
  });

  let committed;
  await step('commits with summary and description (⌘↵)', async () => {
    await win().locator('.commit-summary').fill('Add ports registry and cached vessels route');
    await win().locator('.commit-desc').fill('Synthetic commit made by the end-to-end test.');
    const label = await win().locator('.commit-btn').textContent();
    if (!/Commit 3 files to develop/.test(label)) throw new Error(label);
    await win().locator('.commit-desc').press(`${MOD}+Enter`);
    await waitFor(() => git('log', '-1', '--format=%s') === 'Add ports registry and cached vessels route', { message: 'commit' });
    committed = git('rev-parse', 'HEAD');
    if (git('log', '-1', '--format=%b').trim() !== 'Synthetic commit made by the end-to-end test.') throw new Error('body');
    await row('Add ports registry').waitFor();
    if (await row('Uncommitted changes').count()) throw new Error('WIP row should be gone');
    if ((await win().locator('.commit-summary').inputValue()) !== '') throw new Error('summary not cleared');
    await t.shot('05-after-commit');
  });

  await step('undo and redo the commit', async () => {
    await clickKey('undo');
    await waitFor(() => git('rev-parse', 'HEAD') !== committed, { message: 'undo' });
    await waitFor(() => git('diff', '--cached', '--name-only').split('\n').length === 3, { message: 'changes back in index' });
    await row('Uncommitted changes').waitFor();
    await clickKey('redo');
    await waitFor(() => git('rev-parse', 'HEAD') === committed, { message: 'redo' });
    await closeToasts();
  });

  await step('commit details panel shows metadata and changed files', async () => {
    await row('Add ports registry').click();
    await win().locator('.cd-subject', { hasText: 'Add ports registry' }).waitFor();
    if ((await win().locator('.files-commit .file').count()) !== 3) throw new Error('changed files');
    await win().locator('.files-commit .file', { hasText: 'router.js' }).click();
    await win().locator('#detail .hunk').first().waitFor();
    await t.shot('06-commit-details');
  });

  await step('file history and blame views', async () => {
    await win().locator('#detail .tab-mini', { hasText: 'History' }).click();
    await win().locator('#detail .hist-item').first().waitFor();
    if ((await win().locator('#detail .hist-item').count()) < 3) throw new Error('history entries');
    await t.shot('07-history');
    await win().locator('#detail .tab-mini', { hasText: 'Blame' }).click();
    await win().locator('#detail .blame-line').first().waitFor();
    await t.shot('08-blame');
    await win().locator('#detail .tab-mini', { hasText: 'File' }).click();
    await win().locator('#detail .file-view').waitFor();
    await win().keyboard.press('Escape');
  });

  await step('keyboard navigation through commits', async () => {
    await row('Add ports registry').click();
    await win().locator('.graph-scroll').press('ArrowDown');
    await win().locator('.cd-subject', { hasText: 'Log slow requests' }).waitFor();
    await win().locator('.graph-scroll').press('ArrowUp');
    await win().locator('.cd-subject', { hasText: 'Add ports registry' }).waitFor();
  });

  await step('create a branch from the toolbar and check it out', async () => {
    await clickKey('branch');
    await modal().locator('input.input').fill('feature/e2e-branch');
    await modal().locator('input.input').press('Enter');
    await waitFor(() => git('rev-parse', '--abbrev-ref', 'HEAD') === 'feature/e2e-branch', { message: 'branch checked out' });
    await win().locator('.plug.lit', { hasText: 'feature/e2e-branch' }).waitFor();
    await sbItem('e2e-branch').waitFor();
  });

  await step('rejects an invalid branch name inline', async () => {
    await clickKey('branch');
    await modal().locator('input.input').fill('bad..name');
    await modal().locator('input.input').press('Enter');
    await modal().locator('.field-error', { hasText: 'not a valid branch name' }).waitFor();
    await win().keyboard.press('Escape');
    await modal().waitFor({ state: 'detached' }).catch(() => {});
  });

  await step('check out a branch by double-clicking it in the sidebar, then undo', async () => {
    await sbItem('develop').dblclick();
    await waitFor(() => git('rev-parse', '--abbrev-ref', 'HEAD') === 'develop', { message: 'develop' });
    await clickKey('undo');
    await waitFor(() => git('rev-parse', '--abbrev-ref', 'HEAD') === 'feature/e2e-branch', { message: 'undo checkout' });
    await sbItem('develop').dblclick();
    await waitFor(() => git('rev-parse', '--abbrev-ref', 'HEAD') === 'develop', { message: 'develop again' });
    await closeToasts();
  });

  await step('drag a branch plug onto the current branch to merge (patch cable)', async () => {
    const src = win().locator('.plug', { hasText: 'feature/rate-limiter' }).first();
    const dst = win().locator('.plug.lit', { hasText: 'develop' }).first();
    await src.scrollIntoViewIfNeeded();
    const a = await src.boundingBox();
    const b = await dst.boundingBox();
    await win().mouse.move(a.x + 20, a.y + a.height / 2);
    await win().mouse.down();
    await win().mouse.move(a.x + 60, a.y + 40, { steps: 4 });
    await win().mouse.move(b.x + 30, b.y + b.height / 2, { steps: 12 });
    await win().waitForTimeout(100);
    // A real drag repeats dragover while resting; a 1px settle does the same here.
    await win().mouse.move(b.x + 32, b.y + b.height / 2 + 1, { steps: 2 });
    await win().locator('.patch-label', { hasText: 'Patch feature/rate-limiter → develop' }).waitFor();
    await win().locator('.plug.lit.patch-target').waitFor();
    await t.shot('09-patch-cable');
    await win().mouse.up();
    await menuItem('Merge feature/rate-limiter into develop').waitFor({ timeout: 4000 });
    await t.shot('10-patch-menu');
    await menuItem('Merge feature/rate-limiter into develop').click();
    await waitFor(() => git('log', '-1', '--format=%P').split(' ').length === 2, { message: 'merge commit' });
    await row("Merge branch 'feature/rate-limiter' into develop").waitFor();
    await closeToasts();
  });

  await step('merge conflict: banner, merge tool, resolve, commit', async () => {
    git('checkout', '-q', '-b', 'conflict-demo', 'HEAD~1');
    fs.writeFileSync(path.join(repo, 'src/cors.js'), "const ALLOWED = new Set(['https://harbor.example.dev', 'https://staging.harbor.example.dev']);\n\nexport function allowed(origin) {\n  return ALLOWED.has(origin);\n}\n");
    git('commit', '-qam', 'Allow the staging dashboard origin');
    git('checkout', '-q', 'develop');
    fs.writeFileSync(path.join(repo, 'src/cors.js'), "const ALLOWED = new Set(['https://harbor.example.dev', 'http://localhost:5173']);\n\nexport function allowed(origin) {\n  return ALLOWED.has(origin);\n}\n");
    git('commit', '-qam', 'Allow the local dev server origin');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await sbItem('conflict-demo').click({ button: 'right' });
    await menuItem('Merge conflict-demo into develop').click();
    await win().locator('.op-banner', { hasText: 'Merge in progress' }).waitFor();
    await fileRow('conflicted', 'cors.js').waitFor();
    if (!(await win().locator('.commit-btn').isDisabled())) throw new Error('commit must be disabled while conflicted');
    await fileRow('conflicted', 'cors.js').click();
    await win().locator('#detail .conflict').first().waitFor();
    await t.shot('11-merge-tool');
    await win().locator('#detail .conflict-head .btn', { hasText: 'Both, ours first' }).click();
    await win().locator('#detail .conflict.resolved').waitFor();
    await win().locator('#detail .btn', { hasText: 'Save & mark resolved' }).click();
    await waitFor(() => !git('diff', '--name-only', '--diff-filter=U'), { message: 'resolved' });
    const content = fs.readFileSync(path.join(repo, 'src/cors.js'), 'utf8');
    if (content.includes('<<<<<<<') || !content.includes('localhost') || !content.includes('staging')) throw new Error(content);
    await waitFor(async () => !(await win().locator('.commit-btn').isDisabled()), { message: 'commit enabled' });
    const summary = await win().locator('.commit-summary').inputValue();
    if (!summary.includes("Merge branch 'conflict-demo'")) throw new Error(`merge message prefill: ${summary}`);
    await win().locator('.commit-btn').click();
    await waitFor(() => git('log', '-1', '--format=%s').startsWith("Merge branch 'conflict-demo'"), { message: 'merge committed' });
    await win().locator('.op-banner').waitFor({ state: 'hidden' });
    await closeToasts();
  });

  await step('rebase conflict can be aborted from the banner', async () => {
    git('checkout', '-q', '-b', 'rebase-demo', 'HEAD~3');
    fs.writeFileSync(path.join(repo, 'src/cors.js'), 'export const allowed = () => true;\n');
    git('commit', '-qam', 'Open CORS for debugging');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await sbItem('develop').click({ button: 'right' });
    await menuItem('Rebase rebase-demo onto develop').click();
    await win().locator('.op-banner', { hasText: 'Rebase in progress' }).waitFor();
    await win().locator('.op-banner .btn', { hasText: 'Abort rebase' }).click();
    await modal().locator('.btn', { hasText: 'Abort rebase' }).click();
    await waitFor(() => !fs.existsSync(path.join(repo, '.git/rebase-merge')), { message: 'rebase aborted' });
    git('checkout', '-q', 'develop');
    git('branch', '-D', 'rebase-demo');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await closeToasts();
  });

  await step('push the current branch (ahead of origin)', async () => {
    await clickKey('push');
    await waitFor(() => git('rev-parse', 'develop') === execFileSync('git', ['rev-parse', 'develop'], { cwd: bare, encoding: 'utf8' }).trim(), { message: 'pushed' });
    await toastWith('Pushed develop').waitFor();
    await closeToasts();
  });

  await step('push a new branch sets its upstream', async () => {
    git('checkout', '-q', 'feature/e2e-branch');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await waitFor(async () => (await win().locator('.plug-btn', { hasText: 'feature/e2e-branch' }).count()) > 0, { message: 'branch shown' });
    await clickKey('push');
    await modal().locator('.btn-key', { hasText: 'Push' }).click();
    await waitFor(() => git('rev-parse', '--abbrev-ref', 'feature/e2e-branch@{upstream}') === 'origin/feature/e2e-branch', { message: 'upstream' });
    git('checkout', '-q', 'develop');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await closeToasts();
  });

  await step('fetch and pull new commits from origin', async () => {
    const other = path.join(t.work, 'other');
    execFileSync('git', ['clone', '-q', bare, other], { env: { ...process.env, HOME: t.home } });
    execFileSync('git', ['checkout', '-q', 'develop'], { cwd: other });
    fs.writeFileSync(path.join(other, 'CHANGELOG.md'), '# Changelog\n');
    execFileSync('git', ['add', '.'], { cwd: other });
    execFileSync('git', ['commit', '-qm', 'Start a changelog'], { cwd: other, env: { ...process.env, HOME: t.home } });
    execFileSync('git', ['push', '-q'], { cwd: other, env: { ...process.env, HOME: t.home } });
    await clickKey('fetch');
    await win().locator('.key[data-key="pull"] .key-badge.behind').waitFor();
    await t.shot('12-behind');
    await clickKey('pull');
    await waitFor(() => fs.existsSync(path.join(repo, 'CHANGELOG.md')), { message: 'pulled' });
    await row('Start a changelog').waitFor();
    await closeToasts();
  });

  await step('rejected push offers pull or force push', async () => {
    const other = path.join(t.work, 'other');
    fs.writeFileSync(path.join(other, 'CHANGELOG.md'), '# Changelog\n\n- remote change\n');
    execFileSync('git', ['commit', '-qam', 'Remote changelog entry'], { cwd: other, env: { ...process.env, HOME: t.home } });
    execFileSync('git', ['push', '-q'], { cwd: other, env: { ...process.env, HOME: t.home } });
    fs.writeFileSync(path.join(repo, 'NOTES.md'), 'local\n');
    git('add', 'NOTES.md');
    git('commit', '-qm', 'Local notes');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await clickKey('push');
    await modal().locator('.modal-text', { hasText: "has commits you don't have" }).waitFor();
    await t.shot('13-push-rejected');
    await modal().locator('.btn', { hasText: 'Pull' }).click();
    await waitFor(() => git('log', '-1', '--format=%P').split(' ').length === 2, { message: 'pulled with merge' });
    await clickKey('push');
    await waitFor(() => git('rev-parse', 'develop') === execFileSync('git', ['rev-parse', 'develop'], { cwd: bare, encoding: 'utf8' }).trim(), { message: 'pushed after pull' });
    await closeToasts();
  });

  await step('stash and pop from the toolbar', async () => {
    fs.appendFileSync(path.join(repo, 'README.md'), '\nStash me.\n');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await row('Uncommitted changes').waitFor();
    await clickKey('stash');
    await waitFor(() => git('stash', 'list').split('\n').length === 2, { message: 'stashed' });
    await waitFor(async () => (await row('Uncommitted changes').count()) === 0, { message: 'clean tree' });
    await clickKey('pop');
    await waitFor(() => fs.readFileSync(path.join(repo, 'README.md'), 'utf8').includes('Stash me.') && git('stash', 'list').split('\n').length === 1, { message: 'popped' });
    await win().locator('.files-unstaged .file', { hasText: 'README.md' }).waitFor();
    await win().locator('.files-unstaged .file', { hasText: 'README.md' }).click({ button: 'right' });
    await menuItem('Discard changes').click();
    await modal().locator('.btn', { hasText: 'Discard' }).click();
    await waitFor(() => git('status', '--porcelain') === '', { message: 'discarded' });
    await closeToasts();
  });

  await step('stash details and apply from the sidebar', async () => {
    await win().locator('.sb-stash').first().click();
    await win().locator('.cd-panel .legend', { hasText: 'Stash' }).waitFor();
    await win().locator('.cd-panel .file', { hasText: 'audit.js' }).waitFor();
    await t.shot('14-stash');
    await win().locator('.cd-panel .btn', { hasText: 'Apply' }).click();
    await waitFor(() => git('status', '--porcelain').includes('src/audit.js'), { message: 'applied' });
    git('checkout', '--', 'src/audit.js');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await closeToasts();
  });

  await step('tag a commit from the graph context menu', async () => {
    await row('Start a changelog').click({ button: 'right' });
    await menuItem('Create tag here').click();
    await modal().locator('input.input').fill('v1.2.0');
    await modal().locator('textarea').fill('Release 1.2.0');
    await modal().locator('.btn-key').click();
    await waitFor(() => git('tag', '--list').includes('v1.2.0'), { message: 'tag' });
    if (git('cat-file', '-t', 'v1.2.0') !== 'tag') throw new Error('expected annotated tag');
    await win().locator('.plug-tag', { hasText: 'v1.2.0' }).waitFor();
    await closeToasts();
  });

  await step('cherry-pick and revert from the context menu', async () => {
    const pick = git('rev-parse', 'feature/auth-tokens~1');
    git('checkout', '-q', '-b', 'pick-target', 'v1.0.0');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await row('Add signed session tokens').click({ button: 'right' });
    await menuItem('Cherry-pick onto pick-target').click();
    await waitFor(() => git('log', '-1', '--format=%s') === 'Add signed session tokens' && git('rev-parse', 'HEAD') !== pick, { message: 'cherry-picked' });
    await win().evaluate(() => window.__gitdonkey.selectWip());
    await waitFor(async () => (await row('Add signed session tokens').count()) > 0);
    await win().locator('.g-row', { hasText: 'Add signed session tokens' }).first().click({ button: 'right' });
    await menuItem('Revert this commit').click();
    await waitFor(() => git('log', '-1', '--format=%s').startsWith('Revert'), { message: 'reverted' });
    git('checkout', '-q', 'develop');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await closeToasts();
  });

  await step('reset (mixed) to an earlier commit and undo it', async () => {
    const before = git('rev-parse', 'HEAD');
    await row('Local notes').click({ button: 'right' });
    await menuItem('Reset develop to this commit').hover();
    await menuItem('Mixed').click();
    await waitFor(() => git('rev-parse', 'HEAD') !== before, { message: 'reset' });
    await clickKey('undo');
    await waitFor(() => git('rev-parse', 'HEAD') === before && git('status', '--porcelain') === '', { message: 'reset undone' });
    await closeToasts();
  });

  await step('interactive rebase: reword and drop', async () => {
    git('checkout', '-q', '-b', 'irb', 'develop');
    for (const [f, m] of [['a.txt', 'irb one'], ['b.txt', 'irb two'], ['c.txt', 'irb three']]) {
      fs.writeFileSync(path.join(repo, f), `${m}\n`);
      git('add', f);
      git('commit', '-qm', m);
    }
    await win().evaluate(() => window.__gitdonkey.refresh());
    await row('Merge remote-tracking branch').waitFor().catch(() => {});
    const baseSubject = git('log', '-1', '--format=%s', 'HEAD~3');
    await row(baseSubject).click({ button: 'right' });
    await menuItem('Interactive rebase from here').click();
    await modal().locator('.irb-row').first().waitFor();
    const rows = modal().locator('.irb-row');
    // Newest first: irb three, irb two, irb one.
    await rows.nth(1).locator('select').selectOption('drop');
    await rows.nth(2).locator('select').selectOption('reword');
    await rows.nth(2).locator('.irb-msg').fill('irb one (reworded)');
    await t.shot('15-interactive-rebase');
    await modal().locator('.btn-key', { hasText: 'Start rebase' }).click();
    await waitFor(() => git('log', '-2', '--format=%s') === 'irb three\nirb one (reworded)', { message: 'rebased' });
    if (fs.existsSync(path.join(repo, 'b.txt'))) throw new Error('dropped commit still present');
    git('checkout', '-q', 'develop');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await closeToasts();
  });

  await step('delete a branch and undo the deletion', async () => {
    const hash = git('rev-parse', 'irb');
    await sbItem('irb').click({ button: 'right' });
    await menuItem('Delete irb').click();
    await modal().locator('.btn-key', { hasText: 'Delete branch' }).click();
    await waitFor(() => !git('branch', '--list', 'irb'), { message: 'deleted' });
    await clickKey('undo');
    await waitFor(() => git('rev-parse', 'irb') === hash, { message: 'restored' });
    await closeToasts();
  });

  await step('find commits by message, author and SHA', async () => {
    await clickKey('search');
    await win().locator('.search-input').fill('rate');
    await waitFor(async () => /of/.test(await win().locator('.search-count').textContent()), { message: 'matches' });
    const count = await win().locator('.search-count').textContent();
    await t.shot('16-search');
    void count;
    await win().locator('.search-input').fill('Hana Kobayashi');
    await waitFor(async () => {
      const authors = await win().evaluate(() => window.__gitdonkey.search.matches.map((i) => window.__gitdonkey.rows[i].author));
      return authors.length === 3 && authors.every((a) => a === 'Hana Kobayashi');
    }, { message: 'author matches' });
    await win().locator('.search-input').fill('4');
    await win().locator('.search-input').fill(await win().evaluate(() => window.__gitdonkey.rows[5].hash.slice(0, 8)));
    await waitFor(() => win().evaluate(() => window.__gitdonkey.search.matches.length === 1), { message: 'sha match' });
    await win().locator('.search-input').press('Escape');
    await win().locator('.graph-search').waitFor({ state: 'hidden' });
  });

  await step('settings dialog', async () => {
    await clickKey('settings');
    await modal().locator('select').first().waitFor();
    await t.shot('17-settings');
    await win().keyboard.press('Escape');
  });

  await step('new tab shows the welcome screen; clone a repository', async () => {
    await win().locator('#tab-add').click();
    await win().locator('.w-action[data-action="clone"]').waitFor();
    await win().waitForTimeout(200);
    await t.shot('18-welcome');
    await win().locator('.w-action[data-action="clone"]').click();
    await modal().locator('input.input').first().fill(bare);
    const parent = path.join(t.work, 'clones');
    fs.mkdirSync(parent);
    await modal().locator('input.input').nth(1).fill(parent);
    await modal().locator('input.input').nth(2).fill('harbor-clone');
    await win().evaluate(() => {
      window.__toastLog = [];
      new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach((n) => n.classList && n.classList.contains('toast') && window.__toastLog.push(n.textContent)))).observe(document.body, { childList: true, subtree: true });
    });
    const before = await win().evaluate(() => ({ tabs: window.__gitdonkey.tabs.map((x) => x.name), active: window.__gitdonkey.tab.name }));
    await modal().locator('.btn-key', { hasText: 'Clone' }).click();
    try {
      await waitFor(async () => (await win().locator('.tab.on .tab-name').textContent()) === 'harbor-clone', { message: 'clone tab', timeout: 20000 });
    } catch (e) {
      const after = await win().evaluate(() => ({ toasts: window.__toastLog, tabs: window.__gitdonkey.tabs.map((x) => `${x.name}:${x.root}`), active: window.__gitdonkey.tab.name, modals: [...document.querySelectorAll('.modal')].map((m) => m.textContent.slice(0, 200)) }));
      throw new Error(`${e.message}\n      before: ${JSON.stringify(before)}\n      after: ${JSON.stringify(after)}`);
    }
    await win().locator('.g-row').first().waitFor();
    if (!fs.existsSync(path.join(parent, 'harbor-clone/.git'))) throw new Error('clone missing');
    await closeToasts();
  });

  await step('init a new repository with a first commit', async () => {
    await win().locator('#tab-add').click();
    await win().locator('.w-action[data-action="init"]').click();
    await modal().locator('input.input').first().fill(t.work);
    await modal().locator('input.input').nth(1).fill('brand-new');
    await modal().locator('.btn-key').click();
    await waitFor(async () => (await win().locator('.tab.on .tab-name').textContent()) === 'brand-new', { message: 'init tab' });
    await row('Initial commit').waitFor();
    await closeToasts();
  });

  await step('switching tabs keeps each repository', async () => {
    const names = await win().locator('.tab .tab-name').allTextContents();
    if (names.join(',') !== 'harbor-api,harbor-clone,brand-new') throw new Error(`tabs: ${names}`);
    await win().locator('.tab', { hasText: 'harbor-api' }).click();
    await win().locator('.plug-btn', { hasText: 'develop' }).waitFor();
    await win().locator('.tab', { hasText: 'brand-new' }).locator('.tab-x').click();
    await waitFor(async () => (await win().locator('.tab').count()) === 2, { message: 'tab closed' });
    await win().locator('.tab', { hasText: 'harbor-clone' }).click();
    await win().locator('.plug-btn', { hasText: 'harbor-clone' }).waitFor();
    await win().locator('.tab', { hasText: 'harbor-api' }).click();
    await win().locator('.plug-btn', { hasText: 'harbor-api' }).waitFor();
  });

  await step('external change is picked up by the file watcher', async () => {
    await win().evaluate(() => window.__gitdonkey.selectWip());
    fs.writeFileSync(path.join(repo, 'WATCHED.md'), 'hello\n');
    await fileRow('unstaged', 'WATCHED.md').waitFor({ timeout: 8000 });
    fs.rmSync(path.join(repo, 'WATCHED.md'));
    await waitFor(async () => (await fileRow('unstaged', 'WATCHED.md').count()) === 0, { message: 'watch removal', timeout: 8000 });
  });

  await step('a remote that needs a login prompts in GitDonkey and sends those credentials', async () => {
    const http = require('http');
    const seen = [];
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization;
      if (!auth) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="donkey"' });
        res.end();
        return;
      }
      seen.push(Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString());
      res.writeHead(404);
      res.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      git('remote', 'add', 'locked', `http://127.0.0.1:${port}/harbor.git`);
      await win().evaluate(() => window.__gitdonkey.refresh());
      await win().evaluate(() => { window.__gitdonkey.fetchRemote('locked'); });
      const m = win().locator('.modal', { hasText: `Sign in to 127.0.0.1:${port}` });
      await m.waitFor({ timeout: 15000 });
      await t.shot('20-sign-in');
      await m.locator('input.input').first().fill('donkey');
      await m.locator('input[type=password]').fill('hee-haw-token');
      const remember = m.locator('input[type=checkbox]');
      if (await remember.count()) await remember.uncheck({ force: true });
      await m.locator('.btn-key', { hasText: 'Sign in' }).click();
      await waitFor(() => seen.includes('donkey:hee-haw-token'), { message: 'credentials reached the server', timeout: 15000 });
      git('remote', 'remove', 'locked');
      await win().evaluate(() => window.__gitdonkey.refresh());
      await closeToasts();
    } finally {
      server.close();
    }
  });

  await t.shot('19-final');
  const consoleErrors = t.errors.filter((e) => !/Electron Security Warning/.test(e));
  await step('no renderer errors were logged', async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.join('\n'));
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
