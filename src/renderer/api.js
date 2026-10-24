// Thin wrapper over the preload bridge. Every call resolves with data or
// throws an Error carrying `kind` (e.g. PUSH_REJECTED, NO_IDENTITY).

const bridge = window.gitdonkey;

export class GitError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind || null;
  }
}

export async function git(repo, method, ...args) {
  const r = await bridge.git(repo, method, ...args);
  if (!r || !r.ok) throw new GitError((r && r.error) || 'Unknown error', r && r.kind);
  return r.result;
}

export async function invoke(channel, ...args) {
  try {
    const r = await bridge.invoke(channel, ...args);
    if (r && typeof r === 'object' && 'ok' in r && ('result' in r || 'error' in r)) {
      if (!r.ok) throw new GitError(r.error, r.kind);
      return r.result;
    }
    return r;
  } catch (e) {
    if (e instanceof GitError) throw e;
    throw new GitError(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }
}

export function on(channel, cb) {
  return bridge.on(channel, cb);
}

export function pathForFile(file) {
  return bridge.pathForFile(file);
}

export const platform = bridge.platform;
export const isMac = platform === 'darwin';
export const isWindows = platform === 'win32';
export const sep = isWindows ? '\\' : '/';

/** Absolute on any platform: /posix, C:\\win, C:/win or \\\\unc. */
export function isAbsolutePath(p) {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(String(p || '').trim());
}
export const mod = isMac ? '⌘' : 'Ctrl+';

/** Shortcut text: Mac glyphs on macOS, words elsewhere ("⇧⌘S" → "Ctrl+Shift+S"). */
export function kb(s) {
  if (isMac) return s;
  const mods = [];
  let rest = s;
  while (rest && '⌘⇧⌥'.includes(rest[0])) {
    mods.push(rest[0]);
    rest = rest.slice(1);
  }
  const names = [];
  if (mods.includes('⌘')) names.push('Ctrl');
  if (mods.includes('⌥')) names.push('Alt');
  if (mods.includes('⇧')) names.push('Shift');
  return [...names, rest.replace('↵', 'Enter')].join('+');
}

export const revealLabel = isMac ? 'Show in Finder' : 'Show in Explorer';
