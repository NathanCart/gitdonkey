'use strict';

const fs = require('fs');
const path = require('path');

// Watches open repositories (worktree + .git) and reports debounced changes.
class RepoWatcher {
  constructor(onChange, { delay = 300 } = {}) {
    this.onChange = onChange;
    this.delay = delay;
    this.watchers = new Map();
    this.timers = new Map();
  }

  setRoots(roots) {
    const wanted = new Set(roots.filter((r) => typeof r === 'string' && path.isAbsolute(r)));
    for (const [root, w] of this.watchers) {
      if (!wanted.has(root)) {
        w.close();
        this.watchers.delete(root);
      }
    }
    for (const root of wanted) if (!this.watchers.has(root)) this.watch(root);
  }

  watch(root) {
    try {
      const w = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (filename && RepoWatcher.ignored(filename.toString())) return;
        this.bump(root);
      });
      w.on('error', () => {
        w.close();
        this.watchers.delete(root);
      });
      this.watchers.set(root, w);
    } catch {
      // Directory vanished or cannot be watched; focus-based refresh still works.
    }
  }

  static ignored(file) {
    const f = file.split(path.sep).join('/');
    if (f === '.git' || f.startsWith('.git/')) {
      const sub = f.slice(5);
      if (!sub) return false;
      if (sub.startsWith('objects/') || sub.startsWith('logs/') || sub.startsWith('hooks/')) return true;
      if (sub.endsWith('.lock') || sub === 'FETCH_HEAD' || sub === 'gc.pid' || sub.startsWith('fsmonitor')) return true;
      return false;
    }
    return false;
  }

  bump(root) {
    clearTimeout(this.timers.get(root));
    this.timers.set(
      root,
      setTimeout(() => {
        this.timers.delete(root);
        this.onChange(root);
      }, this.delay),
    );
  }

  closeAll() {
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

module.exports = { RepoWatcher };
