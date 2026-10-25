'use strict';

// End-to-end: finding the changes in a long file. A map beside the diff marks
// each change; ⌥↓ / ⌥↑ and the arrows step through them with an "n of N"
// count; Full file opens at the first change instead of line 1.

const fs = require('fs');
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
const refresh = () => win().evaluate(() => window.__gitdonkey.refresh());
const git = (...args) => execFileSync('git', args, { cwd: t.fx.repo, env: { ...process.env, HOME: t.home }, encoding: 'utf8' });
const count = () => win().locator('#detail .change-count').innerText();
async function waitCount(text) {
  let seen = '';
  await waitFor(async () => (seen = await count()) === text, { message: `the count to read “${text}”` }).catch((e) => {
    throw new Error(`${e.message}, it reads “${seen}”`);
  });
}

/** Is the row holding `text` inside the visible part of the diff? */
const onScreen = (text) => win().evaluate((needle) => {
  const body = document.querySelector('#detail .detail-body');
  const row = [...body.querySelectorAll('.dl')].find((r) => r.textContent.includes(needle));
  if (!row) return false;
  const a = body.getBoundingClientRect();
  const b = row.getBoundingClientRect();
  return b.top >= a.top && b.bottom <= a.bottom;
}, text);

const LINES = Array.from({ length: 400 }, (_, i) => `export const setting${i + 1} = ${i + 1};`);

async function main() {
  t = await launch();
  await win().locator('.g-row').first().waitFor({ timeout: 20000 });

  await step('a 400-line file with three changes far apart', async () => {
    fs.writeFileSync(path.join(t.fx.repo, 'src/settings.js'), `${LINES.join('\n')}\n`);
    git('add', 'src/settings.js');
    git('commit', '-qm', 'Add settings');
    const next = [...LINES];
    next[149] = 'export const setting150 = 1500; // changed';
    next.splice(330, 0, 'export const added1 = true;', 'export const added2 = true;');
    next.splice(249, 1);
    fs.writeFileSync(path.join(t.fx.repo, 'src/settings.js'), `${next.join('\n')}\n`);
    await refresh();
    await win().locator('.files-unstaged .file', { hasText: 'settings.js' }).first().click();
    await win().locator('#detail .hunk').first().waitFor();
  });

  await step('the change map marks each change, coloured by kind', async () => {
    const ruler = win().locator('#detail .change-ruler');
    await ruler.waitFor();
    const kinds = await ruler.locator('.cr-mark').evaluateAll((els) => els.map((e) => [...e.classList].find((c) => c !== 'cr-mark')));
    if (kinds.join() !== 'mod,del,add') throw new Error(`marks: ${kinds.join()}`);
    const tops = await ruler.locator('.cr-mark').evaluateAll((els) => els.map((e) => parseFloat(e.style.top)));
    if (!(tops[0] < tops[1] && tops[1] < tops[2])) throw new Error(`marks out of order: ${tops}`);
  });

  await step('Full file opens at the first change, not line 1, and flashes it', async () => {
    await win().locator('#detail .seg-btn', { hasText: 'Full file' }).click();
    await waitFor(() => win().locator('#detail .dl').count().then((n) => n > 400), { message: 'the whole file' });
    await waitFor(() => onScreen('setting150 = 1500'), { message: 'the first change on screen' });
    if (await onScreen('setting1 = 1;')) throw new Error('still showing the top of the file');
    if (!(await win().locator('#detail .dl.flash').count())) throw new Error('no flash');
    await waitCount('1 of 3');
    await t.shot('35-diff-change-map');
  });

  await step('⌥↓ and the arrow step to the next change and count up', async () => {
    await win().locator('#detail .detail-body').click({ position: { x: 5, y: 5 } }).catch(() => {});
    await win().keyboard.press('Alt+ArrowDown');
    await waitFor(() => onScreen('setting249 = 249;'), { message: 'the deletion on screen' });
    await waitCount('2 of 3');
    await win().locator('#detail .change-nav [aria-label="Next change"]').click();
    await waitFor(() => onScreen('added2 = true'), { message: 'the addition on screen' });
    await waitCount('3 of 3');
    if (!(await win().locator('#detail .change-nav [aria-label="Next change"]').isDisabled())) throw new Error('Next should be disabled at the last change');
  });

  await step('⌥↑ goes back, and clicking a mark jumps to it', async () => {
    await win().keyboard.press('Alt+ArrowUp');
    await waitCount('2 of 3');
    await win().locator('#detail .change-ruler .cr-mark.mod').click();
    await waitFor(() => onScreen('setting150 = 1500'), { message: 'the first change on screen' });
    await waitCount('1 of 3');
  });

  await step('works the same in the split layout', async () => {
    await win().locator('#detail .seg-btn', { hasText: 'Split' }).click();
    await win().locator('#detail .diff-split').waitFor();
    await waitFor(async () => (await win().locator('#detail .change-ruler .cr-mark').count()) === 3, { message: 'three marks in split' });
    await waitFor(() => onScreen('setting150 = 1500'), { message: 'the first change on screen in split' });
    await win().keyboard.press('Alt+ArrowDown');
    await waitCount('2 of 3');
    await win().locator('#detail .seg-btn', { hasText: 'Unified' }).click();
    await win().locator('#detail .seg-btn', { hasText: 'Hunks' }).click();
  });

  await step('no map for a file view or a diff with nothing to show', async () => {
    await win().locator('#detail .diff-unified').waitFor();
    fs.writeFileSync(path.join(t.fx.repo, 'src/settings.js'), `${LINES.join('\n')}\n`);
    git('add', 'src/settings.js');
    await refresh();
    await waitFor(async () => (await win().locator('#detail .change-ruler').isHidden()) || !(await win().locator('#detail').isVisible()), { message: 'map hidden once the change is gone' });
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
