'use strict';

const fs = require('fs');
const path = require('path');

// Tiny JSON settings store with debounced, atomic writes.
class Store {
  constructor(dir) {
    this.file = path.join(dir, 'gitdonkey-state.json');
    this.data = {};
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) || {};
    } catch {
      this.data = {};
    }
    this.timer = null;
  }

  get(key, fallback = undefined) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.scheduleSave();
  }

  scheduleSave() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
  }

  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('Failed to save state', e);
    }
  }

  addRecent(root) {
    const list = (this.get('recent') || []).filter((r) => r.path !== root);
    list.unshift({ path: root, name: path.basename(root), opened: Date.now() });
    this.set('recent', list.slice(0, 20));
  }

  removeRecent(root) {
    this.set('recent', (this.get('recent') || []).filter((r) => r.path !== root));
  }
}

module.exports = { Store };
