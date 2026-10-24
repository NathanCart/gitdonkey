// Update notice. When a newer GitDonkey release is out, a raised-ply card in
// the toast stack (so it sits clear of the commit module) offers it, and a key
// on the status strip keeps it one click away after "Later". The main process
// (updater.js) does the checking, downloading and installing.
import { invoke, on, isMac } from './api.js';
import { h, icon, led, clear, append } from './dom.js';
import { toast, mountToast, confirmDialog } from './ui.js';
import { relativeTime } from './lib/util.js';

const MB = 1024 * 1024;
const amount = (n) => (n < MB ? `${Math.round(n / 1024)} KB` : `${(n / MB).toFixed(n >= 100 * MB ? 0 : 1)} MB`);
const percent = (p) => (p && p.total ? Math.min(100, Math.floor((p.received / p.total) * 100)) : 0);

export class Updates {
  constructor(app) {
    this.app = app;
    this.state = null;
    this.card = null;
    this.shown = false;
    this.later = null; // the version put off with Later this session
    this.note = null; // what's left for the user after the installer was opened for them
    this.drawn = null; // the status the card was last built for
  }

  async init() {
    on('update:state', (s) => this.update(s));
    this.update(await invoke('update:state'));
  }

  get version() {
    return this.state && this.state.release ? this.state.release.version : null;
  }

  get restarts() {
    return !this.note && ['replace', 'installer'].includes(this.state.install);
  }

  update(s) {
    const prev = this.state;
    this.state = s;
    const v = this.version;
    if (s.status === 'available' && v && v !== s.skipped && v !== this.later) {
      if (!this.shown && this.app.donkey) this.app.donkey.react('update', { version: v });
      this.shown = true;
    }
    // A download that finishes or fails brings the card back.
    if (prev && prev.status === 'downloading' && s.status !== 'downloading') this.shown = true;
    if (!v) this.shown = false;
    this.render();
    this.app.renderStatus();
  }

  /** Check for Updates… always answers, and shows a skipped version too. */
  async check() {
    let s;
    try {
      s = await invoke('update:check');
    } catch (e) {
      toast({ type: 'error', title: 'Couldn’t check for updates', message: e.message });
      return;
    }
    if (s.release) {
      this.later = null;
      this.show();
    } else toast({ type: 'success', title: 'GitDonkey is up to date', message: `${s.version} is the latest version.` });
  }

  show() {
    this.shown = true;
    this.render();
  }

  hide() {
    this.shown = false;
    this.render();
  }

  putOff() {
    this.later = this.version;
    this.hide();
  }

  skip() {
    const v = this.version;
    this.hide();
    return invoke('update:skip', v);
  }

  download() {
    const s = this.state;
    if (s.install === 'page') return invoke('shell:openExternal', s.release.url);
    this.note = null;
    return invoke('update:download');
  }

  async install() {
    const s = this.state;
    if (this.restarts) {
      const busy = this.app.busy[this.app.busy.length - 1];
      if (busy) {
        toast({ type: 'warn', title: `Wait for ${busy} to finish`, message: 'GitDonkey restarts to update, which would cut it short.' });
        return;
      }
      const writing = this.app.tabs.some((t) => (t === this.app.tab ? this.app.panel.message() : t.ui.draft && (t.ui.draft.summary || t.ui.draft.description)));
      if (writing && !(await confirmDialog({ title: 'Restart to update?', message: 'GitDonkey reopens your tabs, but not the commit message you’re writing.', okLabel: 'Restart' }))) return;
    }
    try {
      const r = await invoke('update:install');
      if (r && r.done === 'opened') {
        const why = r.reason ? `${r.reason} ` : '';
        this.note = isMac ? `${why}The installer is open: drag GitDonkey into Applications, then open it again.` : `${why}The installer is open. Follow its steps to finish.`;
        this.show();
      }
    } catch (e) {
      toast({ type: 'error', title: 'Couldn’t install the update', message: e.message, actions: [{ label: 'Release page', run: () => invoke('shell:openExternal', s.release.url) }] });
    }
  }

  /** The status-strip key, while an update is waiting, downloading or ready. */
  statusKey() {
    const s = this.state;
    const v = this.version;
    if (!s || !v || (s.status === 'available' && v === s.skipped)) return null;
    const [state, text] = {
      available: ['cyan', `Update to ${v}`],
      downloading: ['amber', `Downloading ${v} · ${percent(s.progress)}%`],
      ready: ['green', this.restarts ? 'Restart to update' : `${v} downloaded`],
      installing: ['amber', `Installing ${v}…`],
    }[s.status] || [];
    if (!state) return null;
    return h('button', { class: 'st-update', type: 'button', title: `GitDonkey ${v}`, onClick: () => this.show() }, led(state), text);
  }

  render() {
    const s = this.state;
    if (!this.shown || !this.version) {
      if (this.card) this.card.remove();
      this.card = null;
      this.drawn = null;
      return;
    }
    if (!this.card) {
      this.card = h('section', { class: ['toast', 'toast-pinned', 'update-card'], 'aria-label': 'GitDonkey update' });
      mountToast(this.card);
    }
    // Progress ticks repaint the bar in place, so Cancel keeps its hover and focus.
    if (s.status !== 'downloading' || this.drawn !== 'downloading') {
      this.drawn = s.status;
      append(clear(this.card), this.body(s));
    }
    if (s.status === 'downloading') {
      const p = s.progress || { received: 0, total: 0 };
      this.bar.style.width = `${percent(p)}%`;
      this.bytes.textContent = p.total ? `${amount(p.received)} of ${amount(p.total)}` : amount(p.received);
    }
  }

  body(s) {
    const r = s.release;
    const head = (state, title, close) => h('div', { class: 'toast-head' },
      led(state),
      h('div', { class: 'toast-title' }, title),
      close ? h('button', { class: 'icon-btn toast-x', type: 'button', title: 'Later', 'aria-label': 'Later', onClick: close }, icon('x', { size: 14 })) : null);
    const key = (label, run, primary = false) => h('button', { class: ['btn', 'btn-small', primary && 'btn-key'], type: 'button', dataset: { update: label }, onClick: run }, label);
    const error = s.error ? h('div', { class: 'update-error', role: 'alert' }, s.error) : null;

    if (s.status === 'downloading') {
      this.bar = h('span', { class: 'mp-fill' });
      this.bytes = h('span', { class: 'update-bytes' });
      return [
        head('amber', `Downloading GitDonkey ${r.version}`, () => this.hide()),
        h('div', { class: 'update-progress' }, h('span', { class: 'mp-track wide' }, this.bar), this.bytes),
        h('div', { class: 'toast-actions' }, key('Cancel', () => invoke('update:cancel'))),
      ];
    }
    if (s.status === 'installing') {
      return [head('amber', `Installing GitDonkey ${r.version}…`), h('div', { class: 'toast-msg' }, 'GitDonkey restarts in a moment.')];
    }
    if (s.status === 'ready') {
      const how = this.note || (this.restarts ? 'Restart to finish updating. Your tabs come back.' : isMac ? 'Open the installer and drag GitDonkey into Applications.' : 'Open the installer to finish updating.');
      return [
        head('green', `GitDonkey ${r.version} is ready`, () => this.hide()),
        h('div', { class: 'toast-msg' }, how),
        error,
        h('div', { class: 'toast-actions' }, key(this.restarts ? 'Restart to update' : 'Open installer', () => this.install(), true), key('Later', () => this.hide())),
      ];
    }
    const notes = (r.notes || []).slice(0, 12);
    return [
      head('cyan', `GitDonkey ${r.version} is available`, () => this.putOff()),
      h('div', { class: 'toast-msg update-meta' },
        h('span', null, `You have ${s.version}${r.publishedAt ? ` · released ${relativeTime(r.publishedAt)}` : ''}`),
        h('button', { class: 'update-link', type: 'button', onClick: () => invoke('shell:openExternal', r.url) }, 'Release notes', icon('external-link', { size: 12 }))),
      notes.length
        ? h('div', { class: 'update-notes' }, notes.map((b) => (b.kind === 'h' ? h('div', { class: 'un-h' }, b.text) : h('div', { class: b.kind === 'li' ? 'un-li' : 'un-p' }, b.text))))
        : null,
      error,
      h('div', { class: 'toast-actions' },
        key(s.install === 'page' ? 'Download' : 'Update', () => this.download(), true),
        key('Later', () => this.putOff()),
        r.version === s.skipped ? null : key('Skip this version', () => this.skip())),
    ];
  }
}
