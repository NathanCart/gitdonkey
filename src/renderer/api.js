// Thin wrapper over the preload bridge. Every call resolves with data or
// throws an Error carrying `kind` (e.g. PUSH_REJECTED, NO_IDENTITY).

const bridge = window.gitdonkey;

export class GitError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind || null;
  }
}

const gitListeners = new Set();

/** Hear about every Git call: { repo, method, args, ok, result, error }. Returns an unsubscribe function. */
export function onGitCall(fn) {
  gitListeners.add(fn);
  return () => gitListeners.delete(fn);
}

function tell(call) {
  for (const fn of gitListeners) {
    try {
      fn(call);
    } catch (e) {
      console.warn(e);
    }
  }
}

export async function git(repo, method, ...args) {
  const r = await bridge.git(repo, method, ...args);
  if (!r || !r.ok) {
    const error = new GitError((r && r.error) || 'Unknown error', r && r.kind);
    tell({ repo, method, args, ok: false, error });
    throw error;
  }
  tell({ repo, method, args, ok: true, result: r.result });
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

let aiSeq = 0;

/**
 * An AI request that can be stopped. `onTick(seconds)` is called every second
 * while it runs. Returns { promise, cancel }; a cancelled request rejects with
 * kind AI_CANCELLED.
 */
export function aiRequest(channel, args, { onTick } = {}) {
  const requestId = `ai-${Date.now()}-${++aiSeq}`;
  const start = Date.now();
  const timer = onTick ? setInterval(() => onTick(Math.round((Date.now() - start) / 1000)), 1000) : null;
  const promise = invoke(channel, { ...args, requestId }).finally(() => clearInterval(timer));
  return { promise, cancel: () => invoke('ai:cancel', requestId).catch(() => false) };
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
