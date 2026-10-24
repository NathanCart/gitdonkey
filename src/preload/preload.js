'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'update:state', 'update:check', 'update:download', 'update:cancel', 'update:install', 'update:skip',
  'app:info', 'repo:open', 'repo:close', 'repo:init', 'repo:clone', 'dialog:pickFolder',
  'store:get', 'store:set', 'recent:list', 'recent:remove', 'shell:openPath', 'shell:showItem',
  'shell:openExternal', 'shell:openTerminal', 'clipboard:write', 'watch:set', 'window:setTitle', 'avatar:get', 'avatar:clear', 'askpass:reply', 'credentials:status', 'credentials:remember',
  'ai:providers', 'ai:setKey', 'ai:models', 'ai:generate', 'ai:theme', 'theme:remember',
]);
const EVENTS = new Set(['repo:changed', 'git:progress', 'clone:progress', 'menu', 'open-path', 'window:focus', 'askpass:request', 'update:state']);

// Paint in the last theme from the first frame; the renderer applies the
// chosen one again once it has loaded.
try {
  const theme = ipcRenderer.sendSync('theme:cached');
  const paint = () => {
    const root = document.documentElement;
    if (!root || !theme) return false;
    for (const [k, v] of Object.entries(theme.vars)) root.style.setProperty(k, v);
    root.style.colorScheme = theme.scheme;
    return true;
  };
  if (theme && !paint()) document.addEventListener('readystatechange', paint, { once: true });
} catch {
  // No cached theme: the stylesheet's default it is.
}

contextBridge.exposeInMainWorld('gitdonkey', {
  git: (repo, method, ...args) => ipcRenderer.invoke('git', { repo, method, args }),
  invoke: (channel, ...args) => {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error(`Blocked event ${channel}`);
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
  platform: process.platform,
});
