'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'app:info', 'repo:open', 'repo:close', 'repo:init', 'repo:clone', 'dialog:pickFolder',
  'store:get', 'store:set', 'recent:list', 'recent:remove', 'shell:openPath', 'shell:showItem',
  'shell:openExternal', 'shell:openTerminal', 'clipboard:write', 'watch:set', 'window:setTitle', 'avatar:get', 'avatar:clear', 'askpass:reply', 'credentials:status', 'credentials:remember',
]);
const EVENTS = new Set(['repo:changed', 'git:progress', 'clone:progress', 'menu', 'open-path', 'window:focus', 'askpass:request']);

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
