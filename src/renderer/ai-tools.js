// Reading changes with AI: explain a commit, summarise a branch, write a pull
// request, review what's staged. All with the provider set up for commit
// messages; nothing is sent until one of these is pressed.
import { h, icon, clear, led } from './dom.js';
import { invoke, isMac } from './api.js';
import { toast, openModal } from './ui.js';
import { pluralize } from './lib/util.js';
import * as dialogs from './dialogs.js';

/** The AI's plain-text answer as a paragraph, a list and a warning. */
export function aiText(text) {
  const out = [];
  let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) {
      list = null;
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      if (!list) {
        list = h('ul', { class: 'ai-list' });
        out.push(list);
      }
      list.appendChild(h('li', null, line.replace(/^[-*•]\s+/, '')));
      continue;
    }
    list = null;
    const warn = line.match(/^watch out:\s*(.*)$/i);
    out.push(warn ? h('p', { class: 'ai-warn' }, icon('triangle-alert', { size: 13 }), h('span', null, warn[1])) : h('p', null, line));
  }
  return h('div', { class: 'ai-text' }, out);
}

export class AiTools {
  constructor(app) {
    this.app = app;
    this.explained = new Map();
  }

  /** The AI settings, or null after sending the user to set them up. */
  ready() {
    const cfg = this.app.aiConfig();
    if (!cfg) dialogs.aiSettingsDialog(this.app);
    return cfg;
  }

  call(channel, args) {
    const cfg = this.app.aiConfig();
    return invoke(channel, { repo: this.app.repo, provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, instructions: cfg.instructions, ...args });
  }

  failed(title, e) {
    const reopen = e.kind === 'AI_KEY_LOCKED' && isMac ? [{ label: 'Reopen GitDonkey', run: () => invoke('app:relaunch') }] : [];
    toast({ type: 'error', title, message: e.message, actions: [...reopen, { label: 'AI settings…', run: () => dialogs.aiSettingsDialog(this.app) }] });
  }

  /** Explain a commit in the details panel. */
  async explain(hash) {
    if (!this.ready()) return;
    const repo = this.app.repo;
    const key = `${repo}:${hash}`;
    this.explained.set(key, { loading: true });
    this.app.panel.render();
    try {
      const text = await this.call('ai:explain', { hash });
      this.explained.set(key, { text, model: this.app.aiConfig().label });
      this.app.donkey.react('aiExplain');
    } catch (e) {
      this.explained.set(key, { error: e.message });
    }
    if (this.app.repo === repo) this.app.panel.render();
  }

  explanation(hash) {
    return this.explained.get(`${this.app.repo}:${hash}`) || null;
  }

  /** The explanation block in the commit details panel. */
  block(hash) {
    const x = this.explanation(hash);
    if (!x) return null;
    const head = h('div', { class: 'ai-head' }, icon('sparkles', { size: 13 }), h('span', null, 'Explained by AI'), h('span', { class: 'spacer' }),
      x.loading ? null : h('button', { class: 'icon-btn', title: 'Explain again', 'aria-label': 'Explain again', onClick: () => this.explain(hash) }, icon('rotate-cw', { size: 13 })),
      x.loading ? null : h('button', { class: 'icon-btn', title: 'Hide', 'aria-label': 'Hide the explanation', onClick: () => {
        this.explained.delete(`${this.app.repo}:${hash}`);
        this.app.panel.render();
      } }, icon('x', { size: 13 })));
    let content;
    if (x.loading) content = h('div', { class: 'ai-loading' }, h('div', { class: 'skel w90' }), h('div', { class: 'skel w70' }), h('div', { class: 'skel w80' }));
    else if (x.error) content = h('p', { class: 'ai-error' }, x.error);
    else content = [aiText(x.text), h('div', { class: 'ai-by' }, `${x.model}. Check it against the diff.`)];
    return h('section', { class: ['ai-card', x.loading && 'loading'], 'aria-busy': x.loading ? 'true' : null }, head, content);
  }

  /** What a branch changes compared with another, in a dialog. */
  async summarizeBranch(branch, base) {
    if (!this.ready()) return;
    const body = h('div', { class: 'stack' }, h('div', { class: 'ai-loading' }, h('div', { class: 'skel w90' }), h('div', { class: 'skel w70' }), h('div', { class: 'skel w80' })));
    let text = '';
    const copy = { label: 'Copy', run: () => this.app.copy(text, 'Summary copied'), disabled: true };
    const m = openModal({ title: `${branch} compared with ${base}`, width: 620, body, actions: [copy, { label: 'Done', primary: true, run: (close) => close(null) }] });
    try {
      text = await this.call('ai:explain', { base, head: branch });
      clear(body).append(aiText(text), h('div', { class: 'ai-by' }, `${this.app.aiConfig().label}. Check it against the diff.`));
      const btn = m.el.querySelector('.modal-foot .btn');
      if (btn) btn.disabled = false;
    } catch (e) {
      clear(body).appendChild(h('p', { class: 'ai-error' }, e.message));
    }
  }

  /** A pull request's title and description. Throws so the dialog can say why. */
  async describePull({ base, head }) {
    if (!this.app.aiConfig()) throw new Error('Set up AI first, in AI settings.');
    return this.call('ai:describePull', { base, head });
  }

  /** Review the staged changes, in a dialog that lists what it found. */
  async review() {
    if (!this.ready()) return;
    const app = this.app;
    const st = app.data && app.data.status;
    if (!st || !st.staged.length) {
      toast({ type: 'info', title: 'Stage something to review', message: 'The review reads the staged changes, the ones the next commit will have.' });
      return;
    }
    const body = h('div', { class: 'review' });
    let modal = null;
    const again = { label: 'Review again', run: () => run() };
    const run = async () => {
      clear(body).append(
        h('p', { class: 'modal-text rv-intro' }, `Reading ${pluralize(st.staged.length, 'staged file')} with ${app.aiConfig().label}…`),
        h('div', { class: 'ai-loading' }, h('div', { class: 'skel w90' }), h('div', { class: 'skel w60' }), h('div', { class: 'skel w80' })));
      try {
        const r = await this.call('ai:review', {});
        app.donkey.react('aiReview', { count: r.issues.length });
        clear(body).append(
          h('div', { class: ['review-summary', r.issues.length ? 'has-issues' : 'clean'] },
            led(r.issues.some((i) => i.severity === 'high') ? 'red' : r.issues.length ? 'amber' : 'green'),
            h('span', null, r.issues.length ? `${pluralize(r.issues.length, 'thing')} to look at.` : 'Nothing to worry about.'),
            r.summary ? h('span', { class: 'review-sum-text' }, r.summary) : null),
          r.issues.length ? h('div', { class: 'rv-list review-list' }, r.issues.map((x) => h('div', { class: ['review-row', `sev-${x.severity}`] },
            h('span', { class: 'sev' }, x.severity),
            h('div', { class: 'rv-text' },
              h('div', { class: 'rv-title' }, x.title || x.detail),
              x.detail && x.title ? h('div', { class: 'review-detail' }, x.detail) : null,
              x.file ? h('button', { type: 'button', class: 'stamp link review-loc', title: 'Show it in the staged diff', onClick: () => {
                modal.close(null);
                this.reveal(x.file, x.line);
              } }, `${x.file}${x.line ? `:${x.line}` : ''}`) : null)))) : null,
          h('div', { class: 'ai-by' }, `${app.aiConfig().label}. A second pair of eyes, not a guarantee.`));
      } catch (e) {
        clear(body).appendChild(h('p', { class: 'ai-error' }, e.message));
      }
    };
    modal = openModal({ title: 'AI review of the staged changes', width: 680, body, actions: [again, { label: 'Done', primary: true, run: (close) => close(null) }] });
    await run();
  }

  /** Open a file's staged diff at a line. */
  reveal(file, line) {
    const app = this.app;
    const st = app.data.status;
    const f = st.staged.find((x) => x.path === file) || st.unstaged.find((x) => x.path === file);
    if (!f) {
      toast({ type: 'info', title: `${file} isn’t changed any more` });
      return;
    }
    const staged = st.staged.includes(f);
    app.openFile({ kind: staged ? 'staged' : f.untracked ? 'untracked' : 'unstaged', path: f.path, oldPath: f.oldPath, status: f.status, untracked: f.untracked });
    if (line) app.detail.revealLine(line);
  }

  /** The branch to compare `branch` with: the repository's main line. */
  baseFor(branch) {
    const d = this.app.data;
    const prs = this.app.pulls.state();
    const names = new Set(d.refs.local.map((b) => b.name));
    const candidates = [prs.base && prs.base.defaultBranch, 'main', 'master', 'trunk', 'develop'].filter(Boolean);
    const local = candidates.find((n) => n !== branch && names.has(n));
    if (local) return local;
    const b = d.refs.local.find((x) => x.name === branch);
    return b && b.upstream ? b.upstream : null;
  }
}

