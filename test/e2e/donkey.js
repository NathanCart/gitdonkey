'use strict';

// End-to-end: the donkey in the corner. He's there in 3D and says hello, he
// reacts to pokes, spins, frantic clicking and his menu, he comments on a
// commit (unless he's been told to be quiet), and Settings or his menu switch
// him off and on, which sticks. Screenshots land in test/e2e/shots/.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { launch } = require('./harness');

const results = [];
let t;
let LINES;

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
const donkey = () => win().locator('#donkey');
const bubble = () => win().locator('#donkey .donkey-says');
const said = () => bubble().evaluate((el) => (el.classList.contains('on') ? el.textContent : ''));
const settings = () => win().evaluate(() => window.__gitdonkey.settings);

/** Wait until he says one of the `type` lines (placeholders match anything). */
function saysOneOf(type) {
  const patterns = LINES[type].map((l) => new RegExp(`^${l.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{\w+\\?\}/g, '.+')}$`));
  return waitFor(async () => {
    const text = await said();
    return patterns.some((p) => p.test(text)) && text;
  }, { message: `a “${type}” line`, timeout: 6000 });
}

function clickMenu(label) {
  return t.app.evaluate(({ Menu }, wanted) => {
    const find = (items) => {
      for (const it of items) {
        if (it.label === wanted) return it;
        const sub = it.submenu && find(it.submenu.items);
        if (sub) return sub;
      }
      return null;
    };
    find(Menu.getApplicationMenu().items).click();
  }, label);
}

async function donkeyMenu(label) {
  await win().locator('.donkey-hit').click({ button: 'right' });
  await win().locator('.menu-item', { hasText: label }).click();
}

async function setDonkeyInSettings(on) {
  await clickMenu('Settings…');
  const label = modal().locator('label.check', { hasText: 'Show the donkey' });
  if ((await label.locator('input').isChecked()) !== on) await label.click();
  await modal().locator('.btn-key', { hasText: 'Save' }).click();
}

async function main() {
  ({ LINES } = await import(pathToFileURL(path.join(__dirname, '../../src/renderer/lib/donkey-lines.js')).href));
  t = await launch();
  await win().locator('.g-row').first().waitFor({ timeout: 20000 });

  await step('the donkey sits in the bottom-left corner, in 3D, and says hello', async () => {
    await donkey().waitFor();
    const box = await win().locator('.donkey-hit').boundingBox();
    const view = await win().evaluate(() => ({ w: innerWidth, h: innerHeight }));
    if (box.x > 40 || view.h - (box.y + box.height) > 60) throw new Error(`not in the corner: ${JSON.stringify(box)}`);
    if (!(await win().locator('#donkey canvas').count())) console.log('      (no WebGL here: the flat donkey stood in)');
    await saysOneOf('hello');
    await t.shot('30-donkey-hello');
  });

  await step('a poke gets a word, a double-click spins him, frantic clicking annoys him', async () => {
    await win().waitForTimeout(400);
    await win().locator('.donkey-hit').click();
    await saysOneOf('poke');
    await win().locator('.donkey-hit').dblclick();
    await saysOneOf('spin');
    await win().waitForTimeout(600);
    await win().locator('.donkey-hit').click({ clickCount: 6, delay: 40 });
    await saysOneOf('annoyed');
  });

  await step('his menu feeds him, tells a joke, and keeps the keyboard in mind', async () => {
    await win().waitForTimeout(2600); // let him finish sulking
    await donkeyMenu('Feed hay');
    await saysOneOf('feed');
    await donkeyMenu('Tell me a joke');
    await saysOneOf('joke');
    await win().locator('.donkey-hit').focus();
    await win().keyboard.press('Enter');
    await saysOneOf('poke');
    await win().keyboard.press('Shift+F10');
    await win().locator('.menu-item', { hasText: 'Spin' }).waitFor();
    await win().keyboard.press('Escape');
    await t.shot('31-donkey-joke');
  });

  await step('he comments on a commit, unless he’s been told to be quiet', async () => {
    await donkeyMenu('Be quiet for an hour');
    await saysOneOf('quiet');
    await win().waitForTimeout(3000);
    await win().locator('.commit-summary').fill('Quiet commit');
    await win().locator('.commit-btn').click();
    await win().locator('.g-row', { hasText: 'Quiet commit' }).first().waitFor();
    await win().waitForTimeout(800);
    if (await said()) throw new Error(`talked while quiet: “${await said()}”`);
    await donkeyMenu('Talk again');
    await saysOneOf('talk');
    await win().waitForTimeout(3000);
    // Stage a new file, then commit it with the commit button.
    fs.writeFileSync(path.join(t.fx.repo, 'hay.txt'), 'one bale\n');
    await win().evaluate(() => window.__gitdonkey.refresh());
    await win().locator('.files-unstaged .file', { hasText: 'hay.txt' }).first().waitFor();
    await win().evaluate(async () => {
      const app = window.__gitdonkey;
      await window.gitdonkey.git(app.tab.root, 'stage', ['hay.txt']);
      await app.refresh();
    });
    await win().locator('.commit-summary').fill('Add a bale of hay');
    await win().locator('.commit-btn').click();
    const line = await saysOneOf('commit');
    if (/\{|\}/.test(line)) throw new Error(`unfilled line: ${line}`);
    await t.shot('32-donkey-commit');
  });

  await step('Settings switches him off and on, and it sticks', async () => {
    await setDonkeyInSettings(false);
    await waitFor(async () => !(await donkey().count()), { message: 'the donkey to go' });
    if ((await settings()).donkey !== false) throw new Error('setting not saved');
    if (await win().evaluate(() => document.body.classList.contains('has-donkey'))) throw new Error('sidebar still leaves room for him');
    await setDonkeyInSettings(true);
    await donkey().waitFor();
    await saysOneOf('back');
    if ((await settings()).donkey !== true) throw new Error('setting not saved');
  });

  await step('“Hide the donkey” in his menu switches him off too', async () => {
    await donkeyMenu('Hide the donkey');
    await waitFor(async () => !(await donkey().count()), { message: 'the donkey to go' });
    if ((await settings()).donkey !== false) throw new Error('setting not saved');
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
