// Right-hand module: working tree (stage / commit) or commit details.
import { h, icon, clear, avatar, led, legend, statusBadge, jack, kbd } from './dom.js';
import { buildTree, splitPath, shortHash, relativeTime, fullDate, pluralize } from './lib/util.js';
import { kb } from './api.js';

const SUMMARY_SOFT_LIMIT = 72;

export class Panel {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.buildWip();
    this.commitView = h('div', { class: 'cd-panel', hidden: true });
    this.el.append(this.wip, this.commitView);
  }

  // ------------------------------------------------------------ working tree

  buildWip() {
    this.wipHead = h('div', { class: 'module-head' });
    this.wipSub = h('div', { class: 'wip-sub' });
    this.banner = h('div', { class: 'op-banner', hidden: true });
    this.sections = h('div', { class: 'wip-sections' });

    this.summary = h('input', { class: 'input commit-summary', placeholder: 'Summary', spellcheck: 'true', 'aria-label': 'Commit summary', autocomplete: 'off' });
    this.counter = h('span', { class: 'char-count', title: 'Keep summaries under 72 characters' });
    this.desc = h('textarea', { class: 'input commit-desc', placeholder: 'Description', rows: '3', spellcheck: 'true', 'aria-label': 'Commit description' });
    this.amendBox = h('input', { type: 'checkbox', 'aria-label': 'Amend previous commit' });
    this.amendLabel = h('label', { class: 'check' }, this.amendBox, h('span', { class: 'check-box' }, icon('check', { size: 12, stroke: 3 })), h('span', null, 'Amend previous commit'));
    this.commitBtn = h('button', { class: 'btn btn-key btn-block commit-btn', type: 'button', onClick: () => this.submit() });
    this.commitHint = h('div', { class: 'commit-hint' });
    this.box = h('div', { class: 'commit-box' },
      h('div', { class: 'commit-legend' }, legend('Commit message'), this.counter),
      this.summary,
      this.desc,
      h('div', { class: 'commit-row' }, this.amendLabel, h('span', { class: 'commit-kbd' }, kbd(`${kb('⌘↵')}`))),
      this.commitBtn,
      this.commitHint);

    const onEdit = () => {
      this.saveDraft();
      this.updateCommitButton();
    };
    this.summary.addEventListener('input', onEdit);
    this.desc.addEventListener('input', onEdit);
    const onKey = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Enter' && e.target === this.summary) {
        e.preventDefault();
        this.desc.focus();
      }
    };
    this.summary.addEventListener('keydown', onKey);
    this.desc.addEventListener('keydown', onKey);
    this.amendBox.addEventListener('change', () => this.app.toggleAmend(this.amendBox.checked));

    this.wip = h('div', { class: 'wip-panel' }, this.wipHead, this.wipSub, this.banner, this.sections, this.box);
  }

  loadDraft() {
    const d = this.app.tab?.ui.draft || {};
    this.summary.value = d.summary || '';
    this.desc.value = d.description || '';
    this.amendBox.checked = Boolean(d.amend);
    this.updateCommitButton();
  }

  saveDraft() {
    const tab = this.app.tab;
    if (!tab) return;
    tab.ui.draft = { ...(tab.ui.draft || {}), summary: this.summary.value, description: this.desc.value, amend: this.amendBox.checked };
  }

  setMessage(message, { amend } = {}) {
    const text = String(message || '').replace(/\r/g, '');
    const nl = text.indexOf('\n');
    this.summary.value = nl === -1 ? text : text.slice(0, nl);
    this.desc.value = nl === -1 ? '' : text.slice(nl + 1).replace(/^\n+/, '');
    if (amend !== undefined) this.amendBox.checked = amend;
    this.saveDraft();
    this.updateCommitButton();
  }

  message() {
    const s = this.summary.value.trim();
    const d = this.desc.value.replace(/\s+$/, '');
    return d.trim() ? `${s}\n\n${d}` : s;
  }

  submit() {
    if (this.commitBtn.disabled) return;
    this.app.commitFromPanel(this.message(), this.amendBox.checked);
  }

  render() {
    const tab = this.app.tab;
    if (!tab || !this.app.data) return;
    const sel = tab.ui.selection || { type: 'wip' };
    const isWip = sel.type === 'wip';
    this.wip.hidden = !isWip;
    this.commitView.hidden = isWip;
    if (isWip) this.renderWip();
    else this.renderDetails();
  }

  renderWip() {
    const d = this.app.data;
    const st = d.status;
    const op = d.opState;
    const total = st.unstaged.length + st.staged.length + st.conflicted.length;
    const head = d.refs.head;
    const view = this.app.settings.fileView;

    clear(this.wipHead).append(
      led(st.conflicted.length ? 'red' : total ? 'amber' : 'green', st.conflicted.length ? 'Conflicts' : total ? 'Uncommitted changes' : 'Clean'),
      legend('Working tree'),
      h('span', { class: 'spacer' }),
      h('div', { class: 'seg', role: 'group', 'aria-label': 'File view' },
        h('button', { class: ['seg-btn', view === 'path' && 'on'], title: 'Path view', 'aria-pressed': String(view === 'path'), onClick: () => this.app.setSetting('fileView', 'path') }, icon('list', { size: 14 })),
        h('button', { class: ['seg-btn', view === 'tree' && 'on'], title: 'Tree view', 'aria-pressed': String(view === 'tree'), onClick: () => this.app.setSetting('fileView', 'tree') }, icon('list-tree', { size: 14 }))),
      h('button', { class: 'icon-btn', title: `Stash all changes (${kb('⌘⌥S')})`, disabled: !total, onClick: () => this.app.stash() }, icon('archive', { size: 15 })),
      h('button', { class: 'icon-btn danger', title: 'Discard all changes…', disabled: !total, onClick: () => this.app.discardAll() }, icon('trash-2', { size: 15 })));

    const branchColor = this.app.laneColorFor(head.hash) || 'var(--legend-3)';
    clear(this.wipSub).append(
      h('span', { class: 'wip-count' }, total ? pluralize(total, 'change') : 'No changes'),
      h('span', { class: 'wip-on' }, 'on'),
      head.detached
        ? h('span', { class: 'chip-ref detached', title: 'Detached HEAD' }, icon('crosshair', { size: 12 }), shortHash(head.hash))
        : h('span', { class: 'chip-ref', style: { '--jack': branchColor } }, jack(branchColor, { lit: true, size: 9 }), head.branch));

    this.renderBanner(op, st);

    clear(this.sections);
    if (st.conflicted.length) {
      this.sections.appendChild(this.fileSection('conflicted', 'Conflicted', st.conflicted, [
        { label: 'Mark all resolved', run: () => this.app.markResolved(st.conflicted.map((f) => f.path)), title: 'Stage every conflicted file as resolved' },
      ], view));
    }
    this.sections.appendChild(this.fileSection('unstaged', 'Unstaged', st.unstaged, st.unstaged.length ? [
      { label: 'Stage all', run: () => this.app.stageAll(), title: `Stage all changes (${kb('⌘⇧S')})`, key: true },
    ] : [], view, total ? 'Everything is staged.' : 'Nothing to commit. Working tree clean.'));
    this.sections.appendChild(this.fileSection('staged', 'Staged', st.staged, st.staged.length ? [
      { label: 'Unstage all', run: () => this.app.unstageAll(), title: `Unstage all changes (${kb('⌘⇧U')})` },
    ] : [], view, 'Stage files, hunks or lines to include them in the next commit.'));

    this.updateCommitButton();
  }

  renderBanner(op, st) {
    clear(this.banner);
    if (!op) {
      this.banner.hidden = true;
      return;
    }
    this.banner.hidden = false;
    const conflicts = st.conflicted.length;
    const titles = {
      merge: 'Merge in progress',
      rebase: `Rebase in progress${op.step && op.total ? ` · ${op.step} of ${op.total}` : ''}`,
      'cherry-pick': 'Cherry-pick in progress',
      revert: 'Revert in progress',
      am: 'Patch application in progress',
    };
    const desc = conflicts
      ? `${pluralize(conflicts, 'conflicted file')}. Resolve each one, then continue.`
      : op.type === 'merge'
        ? 'All conflicts resolved. Commit to finish the merge.'
        : 'All conflicts resolved. Continue to finish.';
    const buttons = [];
    if (op.type === 'rebase') {
      buttons.push(h('button', { class: 'btn btn-small btn-key', disabled: conflicts > 0, onClick: () => this.app.continueOp() }, 'Continue'));
      buttons.push(h('button', { class: 'btn btn-small', onClick: () => this.app.skipRebase() }, 'Skip commit'));
    } else if (op.type !== 'merge') {
      buttons.push(h('button', { class: 'btn btn-small btn-key', disabled: conflicts > 0, onClick: () => this.app.continueOp() }, 'Continue'));
    }
    buttons.push(h('button', { class: 'btn btn-small btn-danger', onClick: () => this.app.abortOp() }, `Abort ${op.type === 'cherry-pick' ? 'cherry-pick' : op.type}`));
    this.banner.append(
      h('div', { class: 'op-title' }, led(conflicts ? 'red' : 'amber'), h('span', null, titles[op.type] || op.type)),
      h('div', { class: 'op-desc' }, desc),
      h('div', { class: 'op-actions' }, buttons));
  }

  fileSection(kind, title, files, actions, view, emptyText) {
    const list = h('div', { class: 'file-list', role: 'listbox', 'aria-label': `${title} files`, 'aria-multiselectable': 'true' });
    if (!files.length) list.appendChild(h('div', { class: 'file-empty' }, emptyText || ''));
    else if (view === 'tree') this.renderTree(list, buildTree(files), kind, 0, files);
    else for (const f of files) list.appendChild(this.fileRow(f, kind, 0, files));
    return h('section', { class: ['files', `files-${kind}`, !files.length && 'is-empty'] },
      h('div', { class: 'files-head' },
        legend(title),
        h('span', { class: 'files-count' }, String(files.length)),
        h('span', { class: 'spacer' }),
        actions.map((a) => h('button', { class: ['btn', 'btn-small', a.key && 'btn-key'], title: a.title, onClick: a.run }, a.label))),
      list);
  }

  renderTree(list, nodes, kind, depth, all) {
    const tab = this.app.tab;
    tab.ui.treeCollapsed ||= {};
    for (const n of nodes) {
      if (n.type === 'dir') {
        const key = `${kind}:${n.path}`;
        const open = !tab.ui.treeCollapsed[key];
        const files = collectFiles(n);
        list.appendChild(h('div', {
          class: 'file dir',
          style: { '--indent': String(depth) },
          onClick: () => {
            tab.ui.treeCollapsed[key] = open;
            this.render();
          },
          onContextmenu: (e) => {
            e.preventDefault();
            this.app.fileMenu(files, kind, e.clientX, e.clientY);
          },
        },
        h('span', { class: ['chev', open && 'open'] }, icon('chevron-right', { size: 12 })),
        icon(open ? 'folder-open' : 'folder', { size: 14 }),
        h('span', { class: 'file-name' }, h('span', { class: 'fn' }, n.name)),
        this.rowAction(kind, files)));
        if (open) this.renderTree(list, n.children, kind, depth + 1, all);
      } else {
        list.appendChild(this.fileRow(n.file, kind, depth, all, n.name));
      }
    }
  }

  rowAction(kind, files) {
    const label = kind === 'unstaged' ? 'Stage' : kind === 'staged' ? 'Unstage' : kind === 'conflicted' ? 'Resolve' : null;
    if (!label) return null;
    return h('button', {
      class: 'row-action',
      title: kind === 'conflicted' ? 'Open the merge tool' : `${label} ${files.length > 1 ? `${files.length} files` : 'file'}`,
      onClick: (e) => {
        e.stopPropagation();
        if (kind === 'unstaged') this.app.stage(files);
        else if (kind === 'staged') this.app.unstage(files);
        else this.app.openFile({ kind: 'conflict', path: files[0].path, status: 'U', conflict: files[0].conflict });
      },
    }, label);
  }

  fileRow(f, kind, depth, all, displayName) {
    const tab = this.app.tab;
    const sel = tab.ui.fileSel;
    const isSel = sel && sel.kind === kind && sel.paths.has(f.path);
    const active = this.app.isDetailFile(kind, f);
    const { dir, name } = splitPath(f.path);
    const row = h('div', {
      class: ['file', active && 'active', isSel && 'selected'],
      role: 'option',
      'aria-selected': String(Boolean(isSel)),
      style: { '--indent': String(depth) },
      title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
      dataset: { path: f.path },
    },
    statusBadge(f.untracked ? '?' : f.status),
    h('span', { class: 'file-name' }, h('span', { class: 'fn' }, displayName || name), !displayName && dir ? h('span', { class: 'fd' }, dir) : null),
    f.additions !== undefined && kind === 'commit' ? h('span', { class: 'file-stat' }, f.binary ? h('span', { class: 'bin' }, 'bin') : [f.additions ? h('span', { class: 'add' }, `+${f.additions}`) : null, f.deletions ? h('span', { class: 'del' }, `−${f.deletions}`) : null]) : null,
    this.rowAction(kind, [f]));

    row.addEventListener('click', (e) => this.onFileClick(e, f, kind, all));
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.row-action')) return;
      if (kind === 'unstaged') this.app.stage([f]);
      else if (kind === 'staged') this.app.unstage([f]);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const s = tab.ui.fileSel;
      const files = s && s.kind === kind && s.paths.has(f.path) && s.paths.size > 1 ? all.filter((x) => s.paths.has(x.path)) : [f];
      if (!(s && s.kind === kind && s.paths.has(f.path))) {
        tab.ui.fileSel = { kind, paths: new Set([f.path]), anchor: f.path };
        this.syncRowState();
      }
      this.app.fileMenu(files, kind, e.clientX, e.clientY);
    });
    return row;
  }

  /** Update active / selected row classes without rebuilding the lists. */
  syncRowState() {
    const tab = this.app.tab;
    const sel = tab.ui.fileSel;
    for (const section of this.el.querySelectorAll('.files')) {
      const kind = ['unstaged', 'staged', 'conflicted', 'commit'].find((k) => section.classList.contains(`files-${k}`));
      for (const row of section.querySelectorAll('.file[data-path]')) {
        const f = { path: row.dataset.path, to: this.app.details?.data?.hash };
        const isSel = Boolean(sel && sel.kind === kind && sel.paths.has(row.dataset.path));
        row.classList.toggle('selected', isSel);
        row.setAttribute('aria-selected', String(isSel));
        row.classList.toggle('active', this.app.isDetailFile(kind, f));
      }
    }
  }

  onFileClick(e, f, kind, all) {
    if (e.target.closest('.row-action')) return;
    const tab = this.app.tab;
    const cur = tab.ui.fileSel && tab.ui.fileSel.kind === kind ? tab.ui.fileSel : { kind, paths: new Set(), anchor: null };
    if (e.metaKey || e.ctrlKey) {
      const paths = new Set(cur.paths);
      if (paths.has(f.path)) paths.delete(f.path);
      else paths.add(f.path);
      tab.ui.fileSel = { kind, paths, anchor: f.path };
      this.syncRowState();
      return;
    }
    if (e.shiftKey && cur.anchor) {
      const order = all.map((x) => x.path);
      const a = order.indexOf(cur.anchor);
      const b = order.indexOf(f.path);
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        tab.ui.fileSel = { kind, paths: new Set(order.slice(lo, hi + 1)), anchor: cur.anchor };
        this.syncRowState();
        return;
      }
    }
    tab.ui.fileSel = { kind, paths: new Set([f.path]), anchor: f.path };
    if (kind === 'commit') this.app.openFile({ ...f, kind: 'commit' });
    else if (kind === 'conflicted') this.app.openFile({ kind: 'conflict', path: f.path, status: 'U', conflict: f.conflict });
    else this.app.openFile({ kind: f.untracked ? 'untracked' : kind, path: f.path, oldPath: f.oldPath, status: f.status, untracked: f.untracked });
  }

  updateCommitButton() {
    const d = this.app.data;
    if (!d) return;
    const st = d.status;
    const op = d.opState;
    const summary = this.summary.value.trim();
    const amend = this.amendBox.checked;
    const branch = d.refs.head.detached ? 'detached HEAD' : d.refs.head.branch;
    let label;
    let enabled = Boolean(summary);
    let hint = '';
    if (st.conflicted.length) {
      label = 'Resolve conflicts to commit';
      enabled = false;
    } else if (op && op.type === 'rebase') {
      label = 'Continue rebase';
      enabled = true;
      hint = 'Applies the remaining commits. The message above is used for the current commit.';
    } else if (op && (op.type === 'cherry-pick' || op.type === 'revert')) {
      label = `Continue ${op.type}`;
    } else if (op && op.type === 'merge') {
      label = `Commit merge to ${branch}`;
    } else if (amend) {
      label = st.staged.length ? `Amend with ${pluralize(st.staged.length, 'staged file')}` : 'Amend message';
      enabled = enabled && Boolean(this.app.headHash);
    } else if (!st.staged.length) {
      label = st.unstaged.length ? 'Stage changes to commit' : 'Nothing to commit';
      enabled = false;
    } else {
      label = `Commit ${pluralize(st.staged.length, 'file')} to ${branch}`;
      if (!summary) hint = 'Write a summary to commit.';
    }
    this.commitBtn.textContent = label;
    this.commitBtn.disabled = !enabled;
    this.commitHint.textContent = hint;
    this.commitHint.hidden = !hint;
    const left = SUMMARY_SOFT_LIMIT - summary.length;
    this.counter.textContent = String(left);
    this.counter.classList.toggle('over', left < 0);
    this.counter.classList.toggle('near', left >= 0 && left < 10);
    this.amendBox.disabled = !this.app.headHash || Boolean(op);
  }

  // ------------------------------------------------------------ commit / stash details

  renderDetails() {
    const tab = this.app.tab;
    const sel = tab.ui.selection;
    const det = this.app.details;
    clear(this.commitView);
    const isStash = sel.type === 'stash';
    const hash = isStash ? sel.stash.hash : sel.hash;
    const color = isStash ? 'var(--legend-2)' : this.app.laneColorFor(hash) || 'var(--legend-2)';
    const headActions = [];
    if (isStash) {
      headActions.push(
        h('button', { class: 'btn btn-small btn-key', onClick: () => this.app.applyStash(sel.stash, { pop: true }) }, 'Pop'),
        h('button', { class: 'btn btn-small', onClick: () => this.app.applyStash(sel.stash, { pop: false }) }, 'Apply'),
        h('button', { class: 'icon-btn danger', title: 'Delete stash', onClick: () => this.app.dropStash(sel.stash) }, icon('trash-2', { size: 15 })));
    }
    headActions.push(h('button', { class: 'icon-btn', title: 'Back to working tree', onClick: () => this.app.selectWip() }, icon('x', { size: 15 })));
    this.commitView.appendChild(h('div', { class: 'module-head' }, h('span', { class: 'led', style: { background: color } }), legend(isStash ? 'Stash' : 'Commit'), h('span', { class: 'spacer' }), headActions));

    if (!det || det.hash !== hash || det.loading) {
      this.commitView.appendChild(h('div', { class: 'cd-loading' }, h('div', { class: 'skel w70' }), h('div', { class: 'skel w40' }), h('div', { class: 'skel w90' })));
      return;
    }
    if (det.error) {
      this.commitView.appendChild(h('div', { class: 'cd-error' }, det.error));
      return;
    }
    const c = det.data;
    const files = c.files;
    const adds = files.reduce((n, f) => n + (f.additions || 0), 0);
    const dels = files.reduce((n, f) => n + (f.deletions || 0), 0);
    const view = this.app.settings.fileView;
    const list = h('div', { class: 'file-list', role: 'listbox', 'aria-label': 'Changed files' });
    if (!files.length) list.appendChild(h('div', { class: 'file-empty' }, 'No file changes in this commit.'));
    else if (view === 'tree') this.renderTree(list, buildTree(files), 'commit', 0, files);
    else for (const f of files) list.appendChild(this.fileRow(f, 'commit', 0, files));

    const subject = isStash ? sel.stash.summary || c.subject : c.subject;
    const sameCommitter = c.committer === c.author && c.committerEmail === c.email;
    this.commitView.appendChild(h('div', { class: 'cd-scroll' },
      h('div', { class: 'cd-top' },
        h('h2', { class: 'cd-subject' }, subject || '(no message)'),
        c.body && !isStash ? h('div', { class: 'cd-body' }, c.body) : null,
        h('div', { class: 'cd-person' },
          avatar(c.author, c.email, 30),
          h('div', { class: 'cd-who' }, h('div', { class: 'cd-name' }, c.author), h('div', { class: 'cd-email' }, c.email)),
          h('div', { class: 'cd-when', title: fullDate(c.date) }, relativeTime(c.date))),
        sameCommitter ? null : h('div', { class: 'cd-committer' }, `Committed by ${c.committer} · ${relativeTime(c.commitDate)}`),
        h('div', { class: 'cd-ids' },
          h('div', { class: 'cd-id' }, legend('SHA'), h('button', { class: 'stamp', title: 'Copy full SHA', onClick: () => this.app.copy(c.hash, 'SHA copied') }, shortHash(c.hash, 10), icon('copy', { size: 12 }))),
          h('div', { class: 'cd-id' }, legend(isStash ? 'Based on' : c.parents.length > 1 ? 'Parents' : 'Parent'),
            c.parents.length
              ? (isStash ? c.parents.slice(0, 1) : c.parents).map((p) => h('button', { class: 'stamp link', title: 'Select parent', onClick: () => this.app.selectCommit(p, { scroll: true }) }, shortHash(p)))
              : h('span', { class: 'cd-none' }, 'root commit')),
          h('div', { class: 'cd-id' }, legend('Date'), h('span', { class: 'cd-date' }, fullDate(c.date))))),
      h('section', { class: 'files files-commit' },
        h('div', { class: 'files-head' },
          legend(pluralize(files.length, 'file')),
          adds ? h('span', { class: 'add mono' }, `+${adds}`) : null,
          dels ? h('span', { class: 'del mono' }, `−${dels}`) : null,
          h('span', { class: 'spacer' }),
          h('div', { class: 'seg', role: 'group', 'aria-label': 'File view' },
            h('button', { class: ['seg-btn', view === 'path' && 'on'], title: 'Path view', onClick: () => this.app.setSetting('fileView', 'path') }, icon('list', { size: 14 })),
            h('button', { class: ['seg-btn', view === 'tree' && 'on'], title: 'Tree view', onClick: () => this.app.setSetting('fileView', 'tree') }, icon('list-tree', { size: 14 })))),
        list)));
  }
}

function collectFiles(node) {
  const out = [];
  for (const c of node.children) {
    if (c.type === 'dir') out.push(...collectFiles(c));
    else out.push(c.file);
  }
  return out;
}
