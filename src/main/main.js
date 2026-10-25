'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard, screen, nativeImage, net, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

if (process.env.GITDONKEY_USER_DATA) app.setPath('userData', process.env.GITDONKEY_USER_DATA);
app.setName('GitDonkey');

const { GitRepo, resolveRoot, initRepo, cloneRepo, configureGit, detectGitHubCli, githubCliCredentialConfig, credentialHelpers, enableCredentialHelper, signingKeys } = require('./git');
const { AskpassServer } = require('./askpass');
const { Store } = require('./store');
const { RepoWatcher } = require('./watcher');
const { AvatarService } = require('./avatars');
const { PROVIDERS, PROVIDER, AiError, buildPrompt, buildThemePrompt, buildConflictPrompt, buildExplainPrompt, buildPullPrompt, buildReviewPrompt, parsePullReply, parseReviewReply, parseMessage, complete, listModels, KeyVault } = require('./ai');
const { Updater } = require('./updater');
const { GitHub, githubRemote } = require('./github');

// Methods of GitRepo the renderer may call.
const GIT_METHODS = new Set([
  'info', 'status', 'refs', 'log', 'searchCommits', 'stashes', 'remotes', 'opState', 'commitDetails',
  'changedFiles', 'diff', 'blob', 'showFile', 'fileHistory', 'blame', 'lastCommitMessage', 'isAncestor',
  'revParse', 'identity', 'setIdentity', 'stage', 'stageAll', 'unstage', 'unstageAll', 'discard',
  'discardFull', 'discardAll', 'applyPatch', 'ignore', 'readFile', 'writeFile', 'commit', 'checkout',
  'checkoutDetached', 'checkoutRemote', 'validateBranchName', 'createBranch', 'deleteBranch',
  'renameBranch', 'setUpstream', 'fastForwardBranch', 'merge', 'rebase', 'rebaseInteractive',
  'rangeCommits', 'cherryPick', 'revert', 'reset', 'abortOperation', 'continueOperation', 'skipRebase',
  'conflictDetails', 'resolveConflict', 'markResolved', 'createTag', 'deleteTag', 'pushTag',
  'deleteRemoteTag', 'stashSave', 'stashApply', 'stashDrop', 'fetch', 'pull', 'push',
  'deleteRemoteBranch', 'addRemote', 'removeRemote', 'renameRemote', 'setRemoteUrl', 'emptyTree', 'hasHead',
  'stashStore', 'snapshot', 'keepStash', 'snapshots', 'deleteSnapshot', 'restoreSnapshot', 'lostCommits', 'danglingCommits',
  'commitsBetween', 'checkoutPull', 'commitPatch', 'rangePatch', 'signature', 'signingConfig', 'setSigning',
  'submodules', 'updateSubmodules', 'lfsInfo', 'lfsTrack', 'worktrees', 'addWorktree', 'removeWorktree', 'pruneWorktrees',
]);
// Methods whose first argument is an options object that may receive onProgress.
const PROGRESS_METHODS = new Set(['fetch', 'pull', 'push', 'updateSubmodules']);

const STORE_KEYS = new Set(['settings', 'tabs', 'activeTab', 'layout', 'themes']);

/** The last theme the renderer applied, checked, for painting the next launch before the renderer runs. */
function cachedTheme() {
  const t = store && store.get('themeCache');
  if (!t || typeof t !== 'object' || !t.vars || typeof t.vars !== 'object') return null;
  const vars = {};
  for (const [k, v] of Object.entries(t.vars).slice(0, 64)) {
    if (/^--[a-z0-9-]{1,24}$/.test(k) && typeof v === 'string' && /^[#\w(),.\s%-]{1,48}$/.test(v)) vars[k] = v;
  }
  return { vars, scheme: t.scheme === 'light' ? 'light' : 'dark' };
}

let mainWindow = null;
let store = null;
let watcher = null;
let avatars = null;
let askpass = null;
let githubCli = null;
let vault = null;
const aiFetch = (url, init) => net.fetch(url, init);
let updater = null;
let github = null;
const askpassWaiters = new Map();

/** Show the renderer's sign-in dialog for a Git / SSH prompt. */
function askRenderer(req) {
  if (!mainWindow || mainWindow.isDestroyed()) return Promise.resolve(null);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      askpassWaiters.delete(id);
      resolve(null);
    }, 5 * 60 * 1000);
    askpassWaiters.set(id, (result) => {
      clearTimeout(timer);
      askpassWaiters.delete(id);
      resolve(result);
    });
    send('askpass:request', { id, ...req });
  });
}
const repos = new Map();
const knownWorktrees = new Set();
const pendingOpen = [];

function registerRepo(root) {
  if (!repos.has(root)) repos.set(root, new GitRepo(root));
  return repos.get(root);
}

function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function launchPaths(argv) {
  const self = path.resolve(app.getAppPath());
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-') && a !== '.')
    .map((a) => path.resolve(a))
    .filter((a) => {
      if (a === self || a === path.dirname(process.execPath)) return false;
      try {
        return fs.statSync(a).isDirectory();
      } catch {
        return false;
      }
    });
}

function windowBounds() {
  const saved = store.get('window');
  const def = { width: 1440, height: 900 };
  if (!saved) return def;
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x < a.x + a.width - 100 && saved.x + saved.width > a.x + 100 && saved.y >= a.y - 20 && saved.y < a.y + a.height - 100;
  });
  return visible ? saved : { width: saved.width || def.width, height: saved.height || def.height };
}

function createWindow() {
  const bounds = windowBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 980,
    minHeight: 620,
    title: 'GitDonkey',
    backgroundColor: (() => {
      const t = cachedTheme();
      return t && /^#[0-9a-f]{6}$/i.test(t.vars['--case'] || '') ? t.vars['--case'] : '#0b0c0e';
    })(),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 13 },
    show: false,
    icon: path.join(__dirname, '../../assets/icon.png'),
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (store.get('maximized')) mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.once('ready-to-show', () => {
    if (!process.env.GITDONKEY_HIDDEN) mainWindow.show();
  });
  const saveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    store.set('maximized', mainWindow.isMaximized());
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized() && !mainWindow.isFullScreen()) store.set('window', mainWindow.getBounds());
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);
  mainWindow.on('focus', () => send('window:focus', {}));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
}

/** The .app this process runs from, when it's an installed bundle GitDonkey may replace with a new version. */
function updatableBundle() {
  if (process.platform !== 'darwin') return null;
  if (process.env.GITDONKEY_UPDATE_BUNDLE) return process.env.GITDONKEY_UPDATE_BUNDLE;
  if (!app.isPackaged) return null;
  const bundle = path.resolve(process.execPath, '../../..');
  return bundle.endsWith('.app') ? bundle : null;
}

function createUpdater() {
  const feed = process.env.GITDONKEY_UPDATE_FEED;
  updater = new Updater({
    fetch: (url, init) => net.fetch(url, init),
    store,
    dir: path.join(app.getPath('userData'), 'updates'),
    version: app.getVersion(),
    // An Intel build running under Rosetta is offered the Apple Silicon one.
    arch: app.runningUnderARM64Translation ? 'arm64' : process.arch,
    feedUrl: feed || undefined,
    offline: Boolean(process.env.GITDONKEY_OFFLINE) && !feed,
    bundle: updatableBundle(),
    // Linux: an AppImage replaces itself; a .deb install is offered the next .deb.
    appImage: process.platform === 'linux' && app.isPackaged ? process.env.APPIMAGE || null : null,
    deb: process.platform === 'linux' && app.isPackaged && !process.env.APPIMAGE,
    packaged: app.isPackaged,
    firstCheck: Number(process.env.GITDONKEY_UPDATE_DELAY) || undefined,
    openPath: (p) => shell.openPath(p),
    quit: () => app.quit(),
  });
  updater.on('state', (s) => send('update:state', s));
}

function menuCommand(command) {
  return () => send('menu', { command });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac
      ? [{
          label: 'GitDonkey',
          submenu: [
            { role: 'about' },
            { label: 'Check for Updates…', click: menuCommand('check-updates') },
            { type: 'separator' },
            { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: menuCommand('settings') },
            { label: 'Themes…', click: menuCommand('themes') },
            { label: 'AI Commit Messages…', click: menuCommand('ai-settings') },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Repository…', accelerator: 'CmdOrCtrl+O', click: menuCommand('open') },
        { label: 'Clone Repository…', accelerator: 'CmdOrCtrl+Shift+N', click: menuCommand('clone') },
        { label: 'Init Repository…', accelerator: 'CmdOrCtrl+Alt+N', click: menuCommand('init') },
        { type: 'separator' },
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: menuCommand('new-tab') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: menuCommand('close-tab') },
        { label: 'Next Tab', accelerator: 'Ctrl+Tab', click: menuCommand('next-tab') },
        { label: 'Previous Tab', accelerator: 'Ctrl+Shift+Tab', click: menuCommand('prev-tab') },
        { type: 'separator' },
        { label: 'Open in Terminal', accelerator: 'CmdOrCtrl+Alt+T', click: menuCommand('terminal') },
        { label: isMac ? 'Show in Finder' : 'Show in Explorer', accelerator: 'CmdOrCtrl+Shift+R', click: menuCommand('reveal') },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'Settings…', accelerator: 'Ctrl+,', click: menuCommand('settings') }, { label: 'Themes…', click: menuCommand('themes') }, { label: 'AI Commit Messages…', click: menuCommand('ai-settings') }, { role: 'quit' }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: menuCommand('search') },
        { label: 'Filter Branches', accelerator: 'CmdOrCtrl+Alt+F', click: menuCommand('filter') },
      ],
    },
    {
      label: 'Repository',
      submenu: [
        { label: 'Fetch All', accelerator: 'CmdOrCtrl+Shift+F', click: menuCommand('fetch') },
        { label: 'Pull', accelerator: 'CmdOrCtrl+Shift+L', click: menuCommand('pull') },
        { label: 'Push', accelerator: 'CmdOrCtrl+Shift+P', click: menuCommand('push') },
        { type: 'separator' },
        { label: 'Create Branch…', accelerator: 'CmdOrCtrl+B', click: menuCommand('branch') },
        { label: 'New Worktree…', click: menuCommand('new-worktree') },
        { label: 'Stash', accelerator: 'CmdOrCtrl+Alt+S', click: menuCommand('stash') },
        { label: 'Pop Stash', accelerator: 'CmdOrCtrl+Alt+P', click: menuCommand('pop') },
        { type: 'separator' },
        { label: 'Stage All Changes', accelerator: 'CmdOrCtrl+Shift+S', click: menuCommand('stage-all') },
        { label: 'Unstage All Changes', accelerator: 'CmdOrCtrl+Shift+U', click: menuCommand('unstage-all') },
        { label: 'Discard All Changes…', click: menuCommand('discard-all') },
        { type: 'separator' },
        { label: 'Undo Last Git Action', click: menuCommand('undo') },
        { label: 'Redo Git Action', click: menuCommand('redo') },
        { label: 'Recover Lost Work…', click: menuCommand('recover') },
        { type: 'separator' },
        { label: 'Open Pull Request…', click: menuCommand('create-pr') },
        { label: 'Connect GitHub…', click: menuCommand('connect-github') },
        { type: 'separator' },
        { label: 'Add Remote…', click: menuCommand('add-remote') },
        { label: 'Git Identity…', click: menuCommand('identity') },
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: menuCommand('refresh') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command Palette…', accelerator: 'CmdOrCtrl+P', click: menuCommand('palette') },
        { type: 'separator' },
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+J', click: menuCommand('toggle-sidebar') },
        { label: 'Toggle Commit Panel', accelerator: 'CmdOrCtrl+K', click: menuCommand('toggle-panel') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: menuCommand('shortcuts') },
        ...(isMac ? [] : [{ type: 'separator' }, { label: 'Check for Updates…', click: menuCommand('check-updates') }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function ok(result) {
  return { ok: true, result };
}

function fail(err) {
  return { ok: false, error: err && err.message ? err.message : String(err), kind: err && err.kind ? err.kind : null };
}

function registerIpc() {
  ipcMain.handle('git', async (event, { repo, method, args } = {}) => {
    try {
      if (!GIT_METHODS.has(method)) throw new Error(`Unknown method ${method}`);
      const r = repos.get(repo);
      if (!r) throw new Error('Repository is not open');
      const callArgs = Array.isArray(args) ? [...args] : [];
      if (PROGRESS_METHODS.has(method)) {
        callArgs[0] = {
          ...(callArgs[0] || {}),
          onProgress: (p) => send('git:progress', { repo, method, ...p }),
        };
      }
      const result = await r[method](...callArgs);
      // Worktrees live outside the repository's folder; let Finder / Terminal open them.
      if (method === 'worktrees') for (const w of result) knownWorktrees.add(w.path);
      return ok(result);
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    home: app.getPath('home'),
    launchPaths: [...launchPaths(process.argv), ...pendingOpen.splice(0)],
  }));

  ipcMain.handle('update:state', () => updater.state());
  ipcMain.handle('update:check', async () => {
    try {
      return ok(await updater.check({ manual: true }));
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('update:download', () => {
    updater.download();
    return updater.state();
  });
  ipcMain.handle('update:cancel', () => {
    updater.cancel();
    return true;
  });
  ipcMain.handle('update:install', async () => {
    try {
      return ok(await updater.install());
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('update:skip', (_e, version) => {
    updater.skip(typeof version === 'string' ? version : null);
    return true;
  });

  ipcMain.handle('repo:open', async (_e, dir) => {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return fail(new Error('Invalid folder'));
    if (!fs.existsSync(dir)) return fail(new Error(`Folder not found: ${dir}`));
    const root = await resolveRoot(dir);
    if (!root) return fail(new Error(`${dir} is not a Git repository`));
    registerRepo(root);
    store.addRecent(root);
    return ok({ root, name: path.basename(root) });
  });

  ipcMain.handle('repo:close', (_e, root) => {
    repos.delete(root);
    return ok(true);
  });

  ipcMain.handle('repo:init', async (_e, opts = {}) => {
    try {
      const root = await initRepo(opts.dir, opts);
      registerRepo(root);
      store.addRecent(root);
      return ok({ root, name: path.basename(root) });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('repo:clone', async (_e, { url, dest } = {}) => {
    try {
      const root = await cloneRepo(url, dest, { onProgress: (p) => send('clone:progress', p) });
      registerRepo(root);
      store.addRecent(root);
      return ok({ root, name: path.basename(root) });
    } catch (e) {
      return fail(e);
    }
  });

  ipcMain.handle('dialog:pickFolder', async (_e, { title, defaultPath, buttonLabel } = {}) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Choose a folder',
      defaultPath: defaultPath || app.getPath('home'),
      buttonLabel: buttonLabel || 'Choose',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  ipcMain.handle('store:get', (_e, key) => (STORE_KEYS.has(key) ? store.get(key) : undefined));
  ipcMain.handle('store:set', (_e, key, value) => {
    if (!STORE_KEYS.has(key)) return false;
    store.set(key, value);
    return true;
  });
  ipcMain.handle('recent:list', () => (store.get('recent') || []).map((r) => ({ ...r, exists: fs.existsSync(r.path) })));
  ipcMain.handle('recent:remove', (_e, root) => {
    store.removeRecent(root);
    return true;
  });

  const insideOpenRepo = (raw) => {
    if (typeof raw !== 'string' || !raw) return false;
    const p = path.resolve(raw);
    return [...repos.keys(), ...knownWorktrees].some((root) => p === root || p.startsWith(root + path.sep));
  };
  ipcMain.handle('shell:openPath', async (_e, p) => (insideOpenRepo(p) ? shell.openPath(path.resolve(p)) : 'Not allowed'));
  ipcMain.handle('shell:showItem', (_e, p) => {
    if (insideOpenRepo(p)) shell.showItemInFolder(path.resolve(p));
    return true;
  });
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
    return true;
  });
  ipcMain.handle('shell:openTerminal', (_e, root) => {
    if (!repos.has(root) && !knownWorktrees.has(root)) return false;
    if (process.platform === 'darwin') spawn('open', ['-a', 'Terminal', root], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], { cwd: root, detached: true, stdio: 'ignore' }).unref();
    else spawn('x-terminal-emulator', [], { cwd: root, detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return true;
  });
  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(String(text));
    return true;
  });
  ipcMain.handle('watch:set', (_e, roots) => {
    watcher.setRoots(Array.isArray(roots) ? roots.filter((r) => repos.has(r)) : []);
    return true;
  });
  ipcMain.handle('avatar:get', (_e, email) => avatars.get(email));
  ipcMain.handle('askpass:reply', (_e, id, result) => {
    const done = askpassWaiters.get(id);
    if (done) done(result && typeof result === 'object' ? result : null);
    return true;
  });
  ipcMain.handle('credentials:status', async () => ({ helpers: await credentialHelpers(), github: githubCli }));
  ipcMain.handle('credentials:remember', () => enableCredentialHelper());
  ipcMain.handle('signing:keys', () => signingKeys());
  // A public key to paste into GitHub: only .pub files in ~/.ssh.
  ipcMain.handle('signing:publicKey', async (_e, file) => {
    const p = path.resolve(String(file || '').replace(/^~(?=\/)/, app.getPath('home')));
    if (!p.endsWith('.pub') || path.dirname(p) !== path.join(app.getPath('home'), '.ssh')) return null;
    return fs.promises.readFile(p, 'utf8').then((t) => t.trim()).catch(() => null);
  });
  ipcMain.handle('avatar:clear', () => avatars.clear().then(() => true));

  // AI requests the renderer can stop: each carries a requestId, and ai:cancel aborts it.
  const aiJobs = new Map();
  const aiJob = (requestId) => {
    const ctl = new AbortController();
    const id = typeof requestId === 'string' && requestId ? requestId : null;
    if (id) aiJobs.set(id, ctl);
    return { signal: ctl.signal, done: () => id && aiJobs.delete(id) };
  };
  ipcMain.handle('ai:cancel', (_e, requestId) => {
    const ctl = aiJobs.get(requestId);
    if (ctl) ctl.abort();
    return Boolean(ctl);
  });

  // AI commit messages. Keys go in and never come back out to the renderer.
  ipcMain.handle('ai:providers', () => PROVIDERS.map((p) => ({ ...p, hasKey: vault.has(p.id) })));
  ipcMain.handle('ai:setKey', (_e, id, key) => {
    try {
      return ok(vault.set(id, key));
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('ai:models', async (_e, { provider, key, baseUrl } = {}) => {
    try {
      // A key typed into the dialog but not saved yet is used for this request only.
      const k = typeof key === 'string' && key.trim() ? key.trim() : vault.require(provider);
      return ok(await listModels({ provider, key: k, baseUrl }, aiFetch));
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('ai:generate', async (_e, { repo, provider, model, baseUrl, instructions, amend, requestId } = {}) => {
    const job = aiJob(requestId);
    try {
      const r = repos.get(repo);
      if (!r) throw new Error('Repository is not open');
      const ctx = await r.commitContext({ amend: Boolean(amend) });
      if (!ctx.files.length) throw new AiError('Stage some changes first, so there’s something to describe.', 'AI_NOTHING');
      const text = await complete({ provider, key: vault.require(provider), model, baseUrl }, buildPrompt({ ...ctx, instructions, amend: Boolean(amend) }), aiFetch, { signal: job.signal });
      return ok({ ...parseMessage(text), model: (model || (PROVIDER[provider] && PROVIDER[provider].model) || '').trim() });
    } catch (e) {
      return fail(e);
    } finally {
      job.done();
    }
  });
  ipcMain.handle('ai:resolve', async (_e, { provider, model, baseUrl, path: file, operation, oursLabel, theirsLabel, conflicts, requestId } = {}) => {
    const job = aiJob(requestId);
    try {
      const lines = (x) => Array.isArray(x) && x.every((l) => typeof l === 'string');
      if (typeof file !== 'string' || !Array.isArray(conflicts) || !conflicts.length || conflicts.length > 200) throw new AiError('Nothing to resolve.', 'AI_CONFIG');
      const clean = conflicts.map((c) => {
        if (!c || !Number.isInteger(c.index) || !lines(c.ours) || !lines(c.theirs) || (c.base !== null && c.base !== undefined && !lines(c.base))) throw new AiError('Those conflicts couldn’t be read.', 'AI_CONFIG');
        return { index: c.index, ours: c.ours, theirs: c.theirs, base: c.base || null, before: lines(c.before) ? c.before : [], after: lines(c.after) ? c.after : [] };
      });
      const prompt = buildConflictPrompt({ path: file, operation, oursLabel, theirsLabel, conflicts: clean });
      return ok(await complete({ provider, key: vault.require(provider), model, baseUrl }, prompt, aiFetch, { maxTokens: 8192, timeout: 120000, effort: 'low', signal: job.signal }));
    } catch (e) {
      return fail(e);
    } finally {
      job.done();
    }
  });

  // GitHub pull requests.
  const githubFor = async (root) => {
    const r = repos.get(root);
    if (!r) throw new Error('Repository is not open');
    const gh = githubRemote(await r.remotes());
    if (!gh) throw Object.assign(new Error('This repository has no GitHub remote.'), { kind: 'GH_NONE' });
    return gh;
  };
  ipcMain.handle('gh:status', async (_e, root) => {
    try {
      const r = repos.get(root);
      const remote = r ? githubRemote(await r.remotes()) : null;
      const auth = await github.auth();
      return ok({ remote, signedIn: Boolean(auth), source: auth ? auth.source : null, gh: Boolean(githubCli), saved: vault.has('github') });
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('gh:pulls', async (_e, root) => {
    try {
      const gh = await githubFor(root);
      return ok({ remote: gh.remote, ...(await github.pulls(gh)) });
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('gh:createPull', async (_e, { root, base, head, baseBranch, title, body, draft } = {}) => {
    try {
      const gh = await githubFor(root);
      if (!base || typeof base.owner !== 'string' || typeof base.name !== 'string') throw new Error('Choose the repository to open it on.');
      if (typeof head !== 'string' || !head || typeof baseBranch !== 'string' || !baseBranch) throw new Error('Choose the branches to compare.');
      return ok(await github.createPull({ base, from: gh, head, baseBranch, title, body, draft }));
    } catch (e) {
      return fail(e);
    }
  });
  ipcMain.handle('gh:setToken', (_e, token) => {
    try {
      return ok(vault.set('github', token));
    } catch (e) {
      return fail(e);
    }
  });

  // Reading changes with AI: explain a commit or a branch, write a pull request, review what's staged.
  const aiRepo = (root) => {
    const r = repos.get(root);
    if (!r) throw new Error('Repository is not open');
    return r;
  };
  const ai = ({ provider, model, baseUrl }) => ({ provider, key: vault.require(provider), model, baseUrl });
  ipcMain.handle('ai:explain', async (_e, { repo, hash, base, head, requestId, ...cfg } = {}) => {
    const job = aiJob(requestId);
    try {
      const r = aiRepo(repo);
      const material = hash ? await r.commitPatch(hash) : await r.rangePatch(base, head);
      if (!hash && !material.range.commits.length) throw new AiError(`${head} has no commits that ${base} doesn’t.`, 'AI_NOTHING');
      const text = await complete(ai(cfg), buildExplainPrompt(material), aiFetch, { maxTokens: 1500, signal: job.signal });
      return ok(String(text || '').trim());
    } catch (e) {
      return fail(e);
    } finally {
      job.done();
    }
  });
  ipcMain.handle('ai:describePull', async (_e, { repo, base, head, requestId, ...cfg } = {}) => {
    const job = aiJob(requestId);
    try {
      const m = await aiRepo(repo).rangePatch(base, head);
      if (!m.range.commits.length) throw new AiError(`${head} has no commits that ${base} doesn’t.`, 'AI_NOTHING');
      const text = await complete(ai(cfg), buildPullPrompt({ ...m.range, files: m.files, diff: m.diff, instructions: cfg.instructions }), aiFetch, { maxTokens: 2048, signal: job.signal });
      return ok(parsePullReply(text));
    } catch (e) {
      return fail(e);
    } finally {
      job.done();
    }
  });
  ipcMain.handle('ai:review', async (_e, { repo, requestId, ...cfg } = {}) => {
    const job = aiJob(requestId);
    try {
      const ctx = await aiRepo(repo).commitContext({ amend: false });
      if (!ctx.files.length) throw new AiError('Stage some changes first, so there’s something to review.', 'AI_NOTHING');
      const text = await complete(ai(cfg), buildReviewPrompt(ctx), aiFetch, { maxTokens: 4096, timeout: 120000, effort: 'low', signal: job.signal });
      return ok({ ...parseReviewReply(text), files: ctx.files.length });
    } catch (e) {
      return fail(e);
    } finally {
      job.done();
    }
  });

  ipcMain.handle('ai:theme', async (_e, { provider, model, baseUrl, description, requestId } = {}) => {
    const job = aiJob(requestId);
    try {
      if (typeof description !== 'string' || !description.trim()) throw new AiError('Describe the theme you want first.', 'AI_CONFIG');
      return ok(await complete({ provider, key: vault.require(provider), model, baseUrl }, buildThemePrompt(description), aiFetch, { maxTokens: 2048, signal: job.signal }));
    } catch (e) {
      return fail(e);
    } finally {
      job.done();
    }
  });

  // Themes: the renderer keeps a copy here so the next window opens in it.
  ipcMain.handle('theme:remember', (_e, t) => {
    if (!t || typeof t !== 'object') return false;
    store.set('themeCache', { vars: t.vars, scheme: t.scheme });
    const c = cachedTheme();
    if (mainWindow && c && /^#[0-9a-f]{6}$/i.test(c.vars['--case'] || '')) mainWindow.setBackgroundColor(c.vars['--case']);
    return true;
  });
  ipcMain.on('theme:cached', (e) => {
    e.returnValue = cachedTheme();
  });

  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
    return true;
  });

  ipcMain.handle('window:setTitle', (_e, title) => {
    if (mainWindow) mainWindow.setTitle(String(title || 'GitDonkey'));
    return true;
  });
}

app.on('open-file', (e, p) => {
  e.preventDefault();
  if (mainWindow) send('open-path', { path: p });
  else pendingOpen.push(p);
});

const gotLock = process.env.GITDONKEY_MULTI_INSTANCE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    for (const p of launchPaths(argv)) send('open-path', { path: p });
  });

  app.whenReady().then(async () => {
    store = new Store(app.getPath('userData'));
    // GITDONKEY_NO_KEYCHAIN (tests): behave as if the Keychain prompt was declined.
    const noKeychain = { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('Encryption is not available.'); }, decryptString: () => { throw new Error('Decryption is not available.'); } };
    vault = new KeyVault(store, process.env.GITDONKEY_NO_KEYCHAIN ? noKeychain : safeStorage);
    try {
      askpass = new AskpassServer(path.join(app.getPath('userData'), 'askpass'), askRenderer);
      configureGit({ env: await askpass.start() });
    } catch (e) {
      console.error('Credential prompts unavailable:', e.message);
    }
    detectGitHubCli().then((gh) => {
      githubCli = gh;
      if (gh) configureGit({ config: githubCliCredentialConfig(gh) });
    });
    createUpdater();
    github = new GitHub({
      fetch: (url, init) => net.fetch(url, init),
      vault,
      ghPath: () => githubCli,
      api: process.env.GITDONKEY_GITHUB_API || undefined,
      offline: Boolean(process.env.GITDONKEY_OFFLINE) && !process.env.GITDONKEY_GITHUB_API,
    });
    watcher = new RepoWatcher((root) => send('repo:changed', { root }));
    avatars = new AvatarService(path.join(app.getPath('userData'), 'avatars'), (url, init) => net.fetch(url, init), { offline: Boolean(process.env.GITDONKEY_OFFLINE) });
    registerIpc();
    buildMenu();
    if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
      const img = nativeImage.createFromPath(path.join(__dirname, '../../assets/icon.png'));
      if (!img.isEmpty()) app.dock.setIcon(img);
    }
    createWindow();
    updater.start();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    if (store) store.flush();
    if (watcher) watcher.closeAll();
    if (askpass) askpass.stop();
    if (updater) updater.stop();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || process.env.GITDONKEY_QUIT_ON_CLOSE) app.quit();
  });
}
