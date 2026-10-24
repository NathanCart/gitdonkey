'use strict';

// End-to-end: themes. Every built-in theme applies to the whole window, the
// choice survives a restart, the builder edits, checks and saves a theme,
// theme codes copy and import, and the AI box designs a theme through an
// OpenAI-compatible endpoint on 127.0.0.1. Screenshots land in test/e2e/shots/.

const http = require('http');
const path = require('path');
const { pathToFileURL } = require('url');
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
const themeCard = (id) => win().locator(`.th-card[data-theme="${id}"]`);
const rootVar = (name) => win().evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
const current = () => win().evaluate(() => window.__gitdonkey.settings.theme);

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
    const item = find(Menu.getApplicationMenu().items);
    if (!item) throw new Error(`no ${wanted} menu item`);
    item.click();
  }, label);
}

async function openPicker() {
  await clickMenu('Themes…');
  await win().locator('.themes .th-card').first().waitFor();
}

async function cardMenu(id, label) {
  await win().locator(`.th-item:has(.th-card[data-theme="${id}"]) .th-more`).click();
  await win().locator('.menu-item', { hasText: label }).click();
}

/** An OpenAI-compatible endpoint that designs one theme, with a legend too dim to read. */
function aiServer() {
  const seen = [];
  const reply = {
    name: 'Sunset Strip',
    colors: {
      case: '#1a0d14', panel: '#22121b', 'panel-2': '#2a1721', 'panel-3': '#341c29', 'panel-4': '#402333',
      seam: '#0d060a', rule: '#3a2030', 'rule-2': '#4f2c41', legend: '#5a3a48', 'legend-2': '#e0b8a8', 'legend-3': '#c49a8c',
      keycap: '#ff8c42', 'keycap-hover': '#ffa866', 'keycap-ink': '#1a0d14',
      red: '#ff5e5b', amber: '#ffb347', cyan: '#5ad1d6', green: '#9bd65a', violet: '#b48cff', pink: '#ff6fa8', blue: '#6f9bff', orange: '#ff8c42', teal: '#4fd1a5', bone: '#f2d5c4',
    },
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
      else res.end(JSON.stringify({ choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` } }] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, reply, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

async function main() {
  const themes = await import(pathToFileURL(path.join(__dirname, '../../src/renderer/lib/themes.js')).href);
  t = await launch({ env: { GITDONKEY_NO_KEYCHAIN: '1' } });
  t.app.process().once('exit', (code) => console.log(`      (GitDonkey exited with ${code})`));
  await win().locator('.g-row').first().waitFor({ timeout: 20000 });

  await step('Settings shows the theme and opens the picker over it', async () => {
    await clickMenu('Settings…');
    await modal().locator('.settings-extra', { hasText: 'Patch Bay' }).waitFor();
    await modal().locator('[data-action="themes"]').click();
    await win().locator('.overlay.docked .themes').waitFor();
    const settingsHidden = await win().evaluate(() => getComputedStyle(document.querySelector('#layer > .overlay:not(.docked)')).visibility === 'hidden');
    if (!settingsHidden) throw new Error('Settings stayed over the app while choosing');
    const count = await win().locator('.themes .th-card[data-theme]').count();
    if (count !== themes.BUILT_IN.length) throw new Error(`${count} theme cards, expected ${themes.BUILT_IN.length}`);
    await t.shot('25-themes');
  });

  await step('every built-in theme repaints the window, graph lanes included', async () => {
    for (const theme of themes.BUILT_IN) {
      const r = themes.resolveTheme(theme);
      await themeCard(theme.id).click();
      await waitFor(async () => (await rootVar('--case')) === r.colors.case, { message: `${theme.name} case colour` });
      const scheme = await win().evaluate(() => document.documentElement.style.colorScheme);
      if (scheme !== r.scheme) throw new Error(`${theme.name}: color-scheme ${scheme}, expected ${r.scheme}`);
      const lane = await win().evaluate(() => document.querySelector('.g-row .plug') && getComputedStyle(document.querySelector('.g-row .plug')).getPropertyValue('--lane').trim());
      if (!themes.CABLES.some((k) => r.colors[k] === lane)) throw new Error(`${theme.name}: lane colour ${lane} isn't one of its cables`);
      if ((await current()) !== theme.id) throw new Error(`${theme.name} wasn't saved as the choice`);
      if (theme.id === 'studio-paper') await t.shot('26-theme-studio-paper');
    }
  });

  await step('Done brings Settings back, naming the chosen theme', async () => {
    await themeCard('studio-paper').click();
    await modal().locator('.btn', { hasText: 'Done' }).click();
    await modal().locator('.settings-extra', { hasText: 'Studio Paper' }).waitFor();
    await win().keyboard.press('Escape');
  });

  await step('the next window opens in the chosen theme', async () => {
    const bg = await t.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor());
    if (bg.toLowerCase() !== themes.THEME_BY_ID['studio-paper'].colors.case) throw new Error(`window background ${bg}`);
  });

  await step('theme builder: live preview, readability check and fix, save', async () => {
    await openPicker();
    await win().locator('.th-card.th-new').click();
    await win().locator('.theme-builder').waitFor();
    const hex = (key) => win().locator(`.tb-row[data-token="${key}"] .tb-hex`);
    // Started from the chosen theme (Studio Paper): retint the case, then make the text unreadable.
    await hex('case').fill('#fff8ec');
    await waitFor(async () => (await rootVar('--case')) === '#fff8ec', { message: 'live preview of Case' });
    await hex('legend').fill('#d9d2c4');
    await win().locator('.tb-report', { hasText: 'hard to read' }).waitFor();
    await win().locator('.tb-read .btn', { hasText: 'Fix readability' }).click();
    await win().locator('.tb-report', { hasText: 'Everything is readable' }).waitFor();
    const fixed = await hex('legend').inputValue();
    if (themes.contrast(fixed, '#fff8ec') < 7) throw new Error(`legend ${fixed} still too faint`);
    await win().locator('.theme-builder .field input').fill('E2E Midnight');
    await t.shot('27-theme-builder');
    await win().locator('.theme-builder .btn-key', { hasText: 'Save theme' }).click();
    await themeCard('custom-e2e-midnight').waitFor();
    if ((await current()) !== 'custom-e2e-midnight') throw new Error(`current theme ${await current()}`);
    if ((await rootVar('--case')) !== '#fff8ec') throw new Error('saved theme not applied');
  });

  await step('Cancel in the builder puts the chosen theme back', async () => {
    await cardMenu('dracula', 'Customise…');
    await win().locator('.theme-builder').waitFor();
    await waitFor(async () => (await rootVar('--case')) === themes.THEME_BY_ID.dracula.colors.case, { message: 'Dracula preview' });
    await win().locator('.theme-builder .btn', { hasText: 'Cancel' }).click();
    await waitFor(async () => (await rootVar('--case')) === '#fff8ec', { message: 'chosen theme restored' });
  });

  await step('a theme code copies and imports back', async () => {
    await cardMenu('custom-e2e-midnight', 'Copy theme code');
    const code = await t.app.evaluate(({ clipboard }) => clipboard.readText());
    const data = JSON.parse(code);
    if (data.name !== 'E2E Midnight' || data.colors.case !== '#fff8ec') throw new Error(`code: ${code.slice(0, 120)}`);
    await win().locator('.themes-modal .btn', { hasText: 'Import…' }).click();
    await modal().locator('input').fill('not a theme');
    await modal().locator('.btn-key', { hasText: 'Import' }).click();
    await modal().locator('.field-error', { hasText: 'theme code' }).waitFor();
    await modal().locator('input').fill(code);
    await modal().locator('.btn-key', { hasText: 'Import' }).click();
    await themeCard('custom-e2e-midnight-2').waitFor();
    if ((await current()) !== 'custom-e2e-midnight-2') throw new Error('imported theme not chosen');
  });

  const ai = await aiServer();
  await step('AI designs a theme from a description with the AI provider, readable', async () => {
    try {
      await win().locator('.th-card.th-new').click();
      await win().locator('.theme-builder').waitFor();
      // Not set up yet: the key opens AI settings, which this run points at the fake endpoint.
      await win().locator('.tb-generate', { hasText: 'Set up AI' }).click();
      await modal().locator('select').first().selectOption('custom');
      const input = (label) => modal().locator('.field', { hasText: label }).locator('input');
      await input('Base URL').fill(ai.url);
      await input('Model').fill('donkey-1');
      await modal().locator('.btn-key', { hasText: 'Save' }).click();
      await win().locator('.tb-generate', { hasText: 'Generate' }).waitFor();
      await win().locator('.tb-ai input').fill('sunset');
      await win().locator('.tb-ai input').press('Enter');
      await win().locator('.tb-ai-status', { hasText: 'Designed by' }).waitFor();
      const call = ai.seen.find((s) => s.url.endsWith('/chat/completions'));
      const sent = JSON.parse(call.body);
      if (sent.model !== 'donkey-1' || !/Theme: sunset/.test(sent.messages[1].content) || !/JSON only/.test(sent.messages[0].content)) throw new Error(`request: ${call.body.slice(0, 200)}`);
      if ((await win().locator('.theme-builder .field input').inputValue()) !== 'Sunset Strip') throw new Error('name not filled');
      if ((await rootVar('--case')) !== ai.reply.colors.case) throw new Error('AI colours not previewed');
      if (!(await win().locator('.tb-ai-status', { hasText: 'adjusted' }).count())) throw new Error('the dim legend was not fixed');
      await win().locator('.tb-report', { hasText: 'Everything is readable' }).waitFor();
      await t.shot('28-theme-ai');
      await win().locator('.theme-builder .btn-key', { hasText: 'Save theme' }).click();
      await themeCard('custom-sunset-strip').waitFor();
    } finally {
      ai.server.close();
    }
  });

  await step('with the Keychain declined, an API key still works until quit, with a way to reopen', async () => {
    await win().locator('.themes-modal .btn-key', { hasText: 'Done' }).click();
    await win().locator('.overlay.docked').waitFor({ state: 'detached' });
    await clickMenu('AI Commit Messages…');
    await modal().locator('select').first().selectOption('openai');
    await modal().locator('.field', { hasText: 'API key' }).locator('input').fill('sk-e2e-not-saved');
    await modal().locator('.btn-key', { hasText: 'Save' }).click();
    const notice = win().locator('.toast', { hasText: 'Key kept until you quit' });
    await notice.waitFor();
    if (!(await notice.locator('button', { hasText: 'Reopen GitDonkey' }).count())) throw new Error('no Reopen GitDonkey action');
    const providers = await win().evaluate(() => window.gitdonkey.invoke('ai:providers'));
    if (!providers.find((p) => p.id === 'openai').hasKey) throw new Error('key not kept for the session');
    const stored = await win().evaluate(() => window.gitdonkey.invoke('store:get', 'settings'));
    if (JSON.stringify(stored).includes('sk-e2e-not-saved')) throw new Error('key written to settings');
    await t.shot('29-keychain-declined');
    await openPicker();
  });

  await step('deleting the chosen theme falls back to Patch Bay', async () => {
    await cardMenu('custom-sunset-strip', 'Delete…');
    await modal().locator('.btn-key', { hasText: 'Delete' }).click();
    await waitFor(async () => (await current()) === 'patch-bay', { message: 'fallback to Patch Bay' });
    if (await themeCard('custom-sunset-strip').count()) throw new Error('card still there');
    if ((await rootVar('--case')) !== themes.THEME_BY_ID['patch-bay'].colors.case) throw new Error('Patch Bay not applied');
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
