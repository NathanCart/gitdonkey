'use strict';

// Launches GitDonkey under Playwright with an isolated HOME, user-data dir and
// demo repository.

const { _electron } = require('playwright-core');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeFixture } = require('./fixture');

const ROOT = path.resolve(__dirname, '../..');

async function launch({ fixture = true, args = [], show = Boolean(process.env.SHOW), outDir } = {}) {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitdonkey-e2e-')));
  const home = path.join(work, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = E2E Tester\n\temail = e2e@example.dev\n[init]\n\tdefaultBranch = main\n');
  const fx = fixture ? makeFixture(work) : null;
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GITDONKEY_USER_DATA: path.join(work, 'userdata'),
    GITDONKEY_MULTI_INSTANCE: '1',
    GITDONKEY_QUIT_ON_CLOSE: '1',
    GITDONKEY_OFFLINE: '1',
  };
  if (!show) env.GITDONKEY_HIDDEN = '1';
  const app = await _electron.launch({
    executablePath: require('electron'),
    args: [ROOT, ...(fx ? [fx.repo] : []), ...args],
    env,
    cwd: ROOT,
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  });
  win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}\n${e.stack || ''}`));
  const shots = outDir || path.join(ROOT, 'test', 'e2e', 'shots');
  fs.mkdirSync(shots, { recursive: true });
  const shot = (name) => win.screenshot({ path: path.join(shots, `${name}.png`) });
  return { app, win, work, home, fx, errors, shot, shots };
}

module.exports = { launch, ROOT };
