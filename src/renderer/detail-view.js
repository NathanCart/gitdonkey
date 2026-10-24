// Center detail view: diff (unified / split, hunk + line staging), file,
// history, blame, and the conflict merge tool.
import { h, icon, clear, legend, statusBadge, avatar, authorColor, led } from './dom.js';
import { parseDiff, buildPatch, splitRows } from './lib/diff-parse.js';
import { parseConflicts, resolveConflicts, conflictCount, conflictContext, parseResolutionReply } from './lib/conflicts.js';
import { splitPath, languageFor, imageMime, shortHash, relativeTime, fullDate, pluralize } from './lib/util.js';
import { git, invoke } from './api.js';
import { confirmDialog } from './ui.js';
import { aiSettingsDialog } from './dialogs.js';
import hljs from '../../node_modules/@highlightjs/cdn-assets/es/highlight.min.js';

const MAX_HIGHLIGHT_LINES = 6000;
const WORKING_KINDS = new Set(['unstaged', 'untracked', 'staged']);
const ZERO = /^0+$/;

export class DetailView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.spec = null;
    this.mode = 'diff';
    this.token = 0;
    this.head = h('div', { class: 'detail-head' });
    this.body = h('div', { class: 'detail-body' });
    this.selBar = h('div', { class: 'sel-bar', hidden: true });
    this.el.append(this.head, this.body, this.selBar);
    this.el.hidden = true;
    this.lineSel = new Map();
    this.lastSel = null;
    this.body.addEventListener('mousedown', (e) => this.onLineMouse(e));
  }

  get repo() {
    return this.app.repo;
  }

  isOpen() {
    return Boolean(this.spec);
  }

  open(spec, { mode } = {}) {
    this.spec = spec;
    this.mode = spec.kind === 'conflict' ? 'merge' : mode || (this.mode === 'merge' ? 'diff' : this.mode || 'diff');
    if (this.mode === 'merge' && spec.kind !== 'conflict') this.mode = 'diff';
    this.lineSel = new Map();
    this.lastText = null;
    this.history = null;
    this.historyIndex = 0;
    this.merge = null;
    this.el.hidden = false;
    this.el.classList.remove('leaving');
    this.renderHead();
    this.load();
  }

  close() {
    this.spec = null;
    this.token++;
    this.el.hidden = true;
    clear(this.body);
    clear(this.head);
    this.selBar.hidden = true;
  }

  setMode(mode) {
    if (!this.spec || mode === this.mode) return;
    this.mode = mode;
    this.lineSel = new Map();
    this.lastText = null;
    this.renderHead();
    this.load();
  }

  /** Called after every repository refresh. */
  async refresh() {
    if (!this.spec) return;
    if (this.mode === 'diff' && WORKING_KINDS.has(this.spec.kind)) await this.load({ quiet: true });
    else this.renderHead();
  }

  // ------------------------------------------------------------ header

  renderHead() {
    const s = this.spec;
    if (!s) return;
    const { dir, name } = splitPath(s.path);
    const kindLabel = { unstaged: 'Unstaged', untracked: 'Untracked', staged: 'Staged', commit: s.hash ? shortHash(s.hash) : 'Commit', conflict: 'Conflict' }[s.kind] || '';
    const modes = [
      ['diff', 'Diff', s.kind !== 'conflict'],
      ['merge', 'Merge', s.kind === 'conflict'],
      ['file', 'File', true],
      ['history', 'History', s.kind !== 'untracked' && s.status !== 'A' && Boolean(this.app.headHash)],
      ['blame', 'Blame', s.kind !== 'untracked' && s.status !== 'D' && s.status !== 'A' && Boolean(this.app.headHash)],
    ].filter(([, , show]) => show);
    const st = this.app.settings;
    const right = [];
    if (this.mode === 'diff' || this.mode === 'history') {
      right.push(h('div', { class: 'seg', role: 'group', 'aria-label': 'Diff layout' },
        h('button', { class: ['seg-btn', st.diffMode !== 'split' && 'on'], title: 'Unified diff', onClick: () => this.app.setSetting('diffMode', 'unified') }, icon('list', { size: 14 }), 'Unified'),
        h('button', { class: ['seg-btn', st.diffMode === 'split' && 'on'], title: 'Side-by-side diff', onClick: () => this.app.setSetting('diffMode', 'split') }, icon('columns-2', { size: 14 }), 'Split')));
      right.push(h('div', { class: 'seg', role: 'group', 'aria-label': 'Context' },
        h('button', { class: ['seg-btn', st.diffContext !== 'full' && 'on'], title: 'Show changed hunks only', onClick: () => this.app.setSetting('diffContext', 'hunks') }, 'Hunks'),
        h('button', { class: ['seg-btn', st.diffContext === 'full' && 'on'], title: 'Show the whole file', onClick: () => this.app.setSetting('diffContext', 'full') }, 'Full file')));
      right.push(h('button', {
        class: ['icon-btn', 'toggle', st.ignoreWhitespace && 'on'],
        title: st.ignoreWhitespace ? 'Showing changes ignoring whitespace (staging lines is off)' : 'Ignore whitespace changes',
        'aria-pressed': String(Boolean(st.ignoreWhitespace)),
        onClick: () => this.app.setSetting('ignoreWhitespace', !st.ignoreWhitespace),
      }, icon('text', { size: 15 })));
    }
    const actions = [];
    if (s.kind === 'unstaged' || s.kind === 'untracked') {
      actions.push(h('button', { class: 'btn btn-small btn-key', onClick: () => this.app.stage([fileOf(s)]) }, 'Stage file'));
      actions.push(h('button', { class: 'btn btn-small btn-danger', onClick: () => this.app.discard([fileOf(s)]) }, 'Discard'));
    } else if (s.kind === 'staged') {
      actions.push(h('button', { class: 'btn btn-small', onClick: () => this.app.unstage([fileOf(s)]) }, 'Unstage file'));
    }
    actions.push(h('button', { class: 'icon-btn', title: 'More', onClick: (e) => this.app.fileMenu([fileOf(s)], s.kind === 'untracked' ? 'unstaged' : s.kind === 'conflict' ? 'conflicted' : s.kind, e.clientX, e.clientY) }, icon('ellipsis', { size: 16 })));

    clear(this.head).append(
      h('div', { class: 'dh-row' },
        h('button', { class: 'btn btn-small dh-close', title: 'Close (Esc)', onClick: () => this.app.closeDetail() }, icon('arrow-left', { size: 14 }), 'Graph'),
        statusBadge(s.untracked ? '?' : s.status),
        h('div', { class: 'dh-path', title: s.path },
          s.oldPath && s.oldPath !== s.path ? h('span', { class: 'dh-old' }, s.oldPath, icon('arrow-right', { size: 12 })) : null,
          h('span', { class: 'dh-dir' }, dir), h('span', { class: 'dh-name' }, name)),
        h('span', { class: 'dh-kind' }, kindLabel),
        h('span', { class: 'spacer' }),
        actions),
      h('div', { class: 'dh-row dh-tools' },
        h('div', { class: 'tabs-mini', role: 'tablist' }, modes.map(([id, label]) => h('button', {
          class: ['tab-mini', this.mode === id && 'on'],
          role: 'tab',
          'aria-selected': String(this.mode === id),
          onClick: () => this.setMode(id),
        }, label))),
        h('span', { class: 'spacer' }),
        right));
  }

  // ------------------------------------------------------------ loading

  async load({ quiet = false } = {}) {
    const token = ++this.token;
    const s = this.spec;
    if (!quiet) clear(this.body).appendChild(h('div', { class: 'detail-loading' }, h('div', { class: 'skel w60' }), h('div', { class: 'skel w80' }), h('div', { class: 'skel w40' })));
    try {
      if (this.mode === 'diff') await this.loadDiff(token, s, { quiet });
      else if (this.mode === 'file') await this.loadFile(token, s);
      else if (this.mode === 'history') await this.loadHistory(token, s);
      else if (this.mode === 'blame') await this.loadBlame(token, s);
      else if (this.mode === 'merge') await this.loadMerge(token, s);
    } catch (e) {
      if (token !== this.token) return;
      clear(this.body).appendChild(h('div', { class: 'detail-msg error' }, h('div', { class: 'dm-title' }, 'Could not load this view'), h('div', null, e.message)));
    }
  }

  diffArgs(s) {
    const st = this.app.settings;
    const base = { path: s.path, oldPath: s.oldPath || null, context: st.diffContext === 'full' ? 100000 : 3, ignoreWhitespace: Boolean(st.ignoreWhitespace) };
    if (s.kind === 'commit') return { ...base, kind: 'commit', from: s.from, to: s.to };
    return { ...base, kind: s.kind };
  }

  async loadDiff(token, s, { quiet }) {
    const res = await git(this.repo, 'diff', this.diffArgs(s));
    if (token !== this.token) return;
    if (quiet && res.text === this.lastText) return;
    const scroll = this.body.scrollTop;
    this.lastText = res.text;
    this.lineSel = new Map();
    this.updateSelBar();
    clear(this.body);
    if (res.tooLarge) {
      this.body.appendChild(this.message('This diff is too large to show', 'Open the file in your editor to review it.', [{ label: 'Open file', run: () => this.app.openExternal(s.path) }]));
      return;
    }
    const file = parseDiff(res.text)[0];
    if (!file) {
      const ws = this.app.settings.ignoreWhitespace;
      this.body.appendChild(this.message(ws ? 'Only whitespace changed' : 'No content changes', ws ? 'Turn off “ignore whitespace” to see them.' : 'The change is a mode or metadata change only.'));
      return;
    }
    if (file.binary) {
      if (imageMime(s.path)) await this.renderImageDiff(token, s);
      else this.body.appendChild(this.message('Binary file', 'GitDonkey cannot show a text diff for this file.'));
      return;
    }
    this.file = file;
    this.renderDiff(file, s);
    if (quiet) this.body.scrollTop = scroll;
  }

  canStage() {
    const s = this.spec;
    return Boolean(s && WORKING_KINDS.has(s.kind) && !this.app.settings.ignoreWhitespace);
  }

  renderDiff(file, s) {
    const lang = languageFor(s.path);
    const total = file.hunks.reduce((n, hk) => n + hk.lines.length, 0);
    const hl = makeHighlighter(lang, total);
    const split = this.app.settings.diffMode === 'split';
    const stageable = this.canStage();
    const wrap = h('div', { class: ['diff', split ? 'diff-split' : 'diff-unified', stageable && 'stageable'] });
    file.hunks.forEach((hunk, hi) => {
      const actions = [];
      if (stageable) {
        if (s.kind === 'staged') actions.push(h('button', { class: 'btn btn-tiny', onClick: () => this.applyHunk(hi, 'unstage') }, 'Unstage hunk'));
        else {
          actions.push(h('button', { class: 'btn btn-tiny btn-key', onClick: () => this.applyHunk(hi, 'stage') }, 'Stage hunk'));
          if (s.kind === 'unstaged') actions.push(h('button', { class: 'btn btn-tiny btn-danger', onClick: () => this.applyHunk(hi, 'discard') }, 'Discard hunk'));
        }
      }
      const block = h('div', { class: 'hunk', dataset: { h: String(hi) } },
        h('div', { class: 'hunk-head' }, h('span', { class: 'hunk-range' }, `@@ −${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`), hunk.section ? h('span', { class: 'hunk-section' }, hunk.section) : null, h('span', { class: 'spacer' }), actions));
      if (split) {
        for (const row of splitRows(hunk)) block.appendChild(splitLine(row, hi, hl));
      } else {
        hunk.lines.forEach((l, li) => block.appendChild(unifiedLine(l, hi, li, hl)));
      }
      wrap.appendChild(block);
    });
    this.body.appendChild(wrap);
  }

  // ------------------------------------------------------------ line selection

  onLineMouse(e) {
    if (e.button !== 0 || !this.canStage() || this.mode !== 'diff') return;
    const cell = e.target.closest('[data-l]');
    if (!cell || !cell.classList.contains('chg')) return;
    e.preventDefault();
    const hi = Number(cell.dataset.h);
    const li = Number(cell.dataset.l);
    if (e.shiftKey && this.lastSel && this.lastSel.hi === hi) {
      const hunk = this.file.hunks[hi];
      const [a, b] = this.lastSel.li < li ? [this.lastSel.li, li] : [li, this.lastSel.li];
      const set = this.lineSel.get(hi) || new Set();
      for (let k = a; k <= b; k++) if (hunk.lines[k].type === '+' || hunk.lines[k].type === '-') set.add(k);
      this.lineSel.set(hi, set);
    } else {
      const set = this.lineSel.get(hi) || new Set();
      if (set.has(li)) set.delete(li);
      else set.add(li);
      if (set.size) this.lineSel.set(hi, set);
      else this.lineSel.delete(hi);
      this.lastSel = { hi, li };
    }
    for (const el of this.body.querySelectorAll('[data-l].chg')) {
      const set = this.lineSel.get(Number(el.dataset.h));
      el.classList.toggle('sel', Boolean(set && set.has(Number(el.dataset.l))));
    }
    this.updateSelBar();
  }

  selectedCount() {
    let n = 0;
    for (const s of this.lineSel.values()) n += s.size;
    return n;
  }

  updateSelBar() {
    const n = this.selectedCount();
    clear(this.selBar);
    if (!n || !this.spec) {
      this.selBar.hidden = true;
      return;
    }
    const s = this.spec;
    const buttons = s.kind === 'staged'
      ? [h('button', { class: 'btn btn-small btn-key', onClick: () => this.applyLines('unstage') }, 'Unstage lines')]
      : [
          h('button', { class: 'btn btn-small btn-key', onClick: () => this.applyLines('stage') }, 'Stage lines'),
          s.kind === 'unstaged' ? h('button', { class: 'btn btn-small btn-danger', onClick: () => this.applyLines('discard') }, 'Discard lines') : null,
        ];
    this.selBar.append(h('span', { class: 'sel-count' }, `${pluralize(n, 'line')} selected`), ...buttons.filter(Boolean), h('button', { class: 'btn btn-small', onClick: () => {
      this.lineSel = new Map();
      for (const el of this.body.querySelectorAll('.sel')) el.classList.remove('sel');
      this.updateSelBar();
    } }, 'Clear'));
    this.selBar.hidden = false;
  }

  async applyHunk(hi, action) {
    await this.applySelection(new Map([[hi, 'all']]), action);
  }

  async applyLines(action) {
    const sel = new Map([...this.lineSel.entries()].map(([k, v]) => [k, new Set(v)]));
    await this.applySelection(sel, action);
  }

  async applySelection(selection, action) {
    const reverse = action !== 'stage';
    const patch = buildPatch(this.file, selection, { reverse });
    if (!patch) return;
    if (action === 'discard') {
      const ok = await confirmDialog({ title: 'Discard changes', message: 'Discard the selected changes from your working tree? This cannot be undone.', okLabel: 'Discard', danger: true });
      if (!ok) return;
    }
    const label = { stage: 'Stage', unstage: 'Unstage', discard: 'Discard' }[action];
    await this.app.run(`${label} changes`, () => git(this.repo, 'applyPatch', patch, { cached: action !== 'discard', reverse }));
  }

  // ------------------------------------------------------------ images

  async renderImageDiff(token, s) {
    const mime = imageMime(s.path);
    const sides = {
      unstaged: [{ rev: 'index', path: s.path }, { rev: 'working', path: s.path }],
      untracked: [null, { rev: 'working', path: s.path }],
      staged: [{ rev: 'HEAD', path: s.oldPath || s.path }, { rev: 'index', path: s.path }],
      commit: [{ rev: s.from, path: s.oldPath || s.path }, { rev: s.to, path: s.path }],
    }[s.kind] || [null, null];
    const [before, after] = await Promise.all(sides.map((side) => (side && !(side.rev === s.from && s.status === 'A') ? git(this.repo, 'blob', side).catch(() => null) : null)));
    if (token !== this.token) return;
    const pane = (label, blob) => h('figure', { class: 'img-pane' },
      h('figcaption', null, legend(label), blob && !blob.tooLarge ? h('span', { class: 'img-size' }, formatBytes(blob.size)) : null),
      h('div', { class: 'img-stage' }, blob && blob.base64
        ? h('img', { src: `data:${mime};base64,${blob.base64}`, alt: `${label} ${s.path}`, onLoad: (e) => {
            const dims = e.target.closest('figure').querySelector('.img-size');
            if (dims) dims.textContent = `${e.target.naturalWidth}×${e.target.naturalHeight} · ${dims.textContent}`;
          } })
        : h('div', { class: 'img-none' }, blob && blob.tooLarge ? 'Too large to preview' : 'No image')));
    this.body.appendChild(h('div', { class: 'img-diff' }, pane('Before', before), pane('After', after)));
  }

  // ------------------------------------------------------------ file view

  async loadFile(token, s) {
    const rev = s.kind === 'commit' ? s.to : s.kind === 'staged' ? 'index' : 'working';
    const p = s.kind === 'commit' && s.status === 'D' ? s.oldPath || s.path : s.path;
    const useRev = s.kind === 'commit' && s.status === 'D' ? s.from : rev;
    const res = await git(this.repo, 'showFile', { rev: useRev, path: p });
    if (token !== this.token) return;
    clear(this.body);
    if (!res) {
      this.body.appendChild(this.message('File not found at this revision'));
      return;
    }
    if (res.tooLarge) {
      this.body.appendChild(this.message('File too large to show', '', [{ label: 'Open file', run: () => this.app.openExternal(s.path) }]));
      return;
    }
    if (res.binary) {
      if (imageMime(p)) {
        const blob = await git(this.repo, 'blob', { rev: useRev, path: p });
        if (token !== this.token) return;
        this.body.appendChild(h('div', { class: 'img-diff single' }, h('figure', { class: 'img-pane' }, h('div', { class: 'img-stage' }, h('img', { src: `data:${imageMime(p)};base64,${blob.base64}`, alt: p })))));
      } else this.body.appendChild(this.message('Binary file', `${formatBytes(res.size)}`));
      return;
    }
    const lines = res.text.replace(/\n$/, '').split('\n');
    const hl = makeHighlighter(languageFor(p), lines.length);
    const wrap = h('div', { class: 'diff diff-unified file-view' });
    const block = h('div', { class: 'hunk' });
    lines.forEach((text, i) => block.appendChild(h('div', { class: 'dl ctx' }, h('span', { class: 'ln' }, String(i + 1)), codeCell(text, hl))));
    wrap.appendChild(block);
    this.body.appendChild(wrap);
  }

  // ------------------------------------------------------------ history

  async loadHistory(token, s) {
    const p = s.kind === 'commit' && s.status === 'D' ? s.oldPath || s.path : s.path;
    if (!this.history || this.history.path !== p) {
      const list = await git(this.repo, 'fileHistory', p);
      if (token !== this.token) return;
      this.history = { path: p, list };
      this.historyIndex = 0;
    }
    const { list } = this.history;
    clear(this.body);
    if (!list.length) {
      this.body.appendChild(this.message('No history', 'This file has not been committed yet.'));
      return;
    }
    const diffHost = h('div', { class: 'hist-diff' });
    const listEl = h('div', { class: 'hist-list', role: 'listbox', 'aria-label': 'File history' }, list.map((c, i) => h('button', {
      class: ['hist-item', i === this.historyIndex && 'on'],
      role: 'option',
      'aria-selected': String(i === this.historyIndex),
      onClick: () => {
        this.historyIndex = i;
        this.loadHistory(++this.token, s);
      },
    },
    h('span', { class: 'hist-top' }, avatar(c.author, c.email, 16), h('span', { class: 'hist-subject' }, c.subject)),
    h('span', { class: 'hist-meta' }, h('span', { class: 'mono' }, shortHash(c.hash)), ` · ${c.author} · ${relativeTime(c.date)}`, c.status === 'R' ? ` · renamed from ${c.oldPath}` : ''))));
    this.body.appendChild(h('div', { class: 'hist' }, listEl, diffHost));
    const entry = list[this.historyIndex];
    const from = entry.parents[0] || (await git(this.repo, 'emptyTree'));
    const st = this.app.settings;
    const res = await git(this.repo, 'diff', { kind: 'commit', from, to: entry.hash, path: entry.path, oldPath: entry.oldPath, context: st.diffContext === 'full' ? 100000 : 3, ignoreWhitespace: Boolean(st.ignoreWhitespace) });
    if (token !== this.token) return;
    const file = parseDiff(res.text)[0];
    diffHost.appendChild(h('div', { class: 'hist-head' },
      h('span', { class: 'hist-head-subject' }, entry.subject),
      h('button', { class: 'btn btn-tiny', onClick: () => this.app.selectCommit(entry.hash, { scroll: true, closeDetail: true }) }, 'Show in graph')));
    if (!file) diffHost.appendChild(this.message('No content changes'));
    else if (file.binary) diffHost.appendChild(this.message('Binary file changed'));
    else {
      const prev = this.body;
      const tmp = h('div');
      this.body = tmp;
      const saved = this.spec;
      this.renderDiff(file, { ...saved, kind: 'commit', path: entry.path });
      this.body = prev;
      diffHost.append(...tmp.childNodes);
    }
  }

  // ------------------------------------------------------------ blame

  async loadBlame(token, s) {
    const rev = s.kind === 'commit' ? s.to : null;
    const res = await git(this.repo, 'blame', s.path, rev);
    if (token !== this.token) return;
    clear(this.body);
    const hl = makeHighlighter(languageFor(s.path), res.lines.length);
    const wrap = h('div', { class: 'blame' });
    let prev = null;
    for (const line of res.lines) {
      const c = res.commits[line.hash] || {};
      const uncommitted = ZERO.test(line.hash);
      const first = line.hash !== prev;
      prev = line.hash;
      const gutter = first
        ? h('button', {
            class: ['blame-gutter', 'first', uncommitted && 'uncommitted'],
            title: uncommitted ? 'Not committed yet' : `${c.summary}\n${c.author} · ${fullDate(c.date)}\nClick to select this commit`,
            onClick: () => !uncommitted && this.app.selectCommit(line.hash, { scroll: true, closeDetail: true }),
          },
          h('span', { class: 'blame-dot', style: { background: uncommitted ? 'var(--legend-3)' : authorColor(c.email || c.author) } }),
          h('span', { class: 'blame-sha mono' }, uncommitted ? 'working' : shortHash(line.hash)),
          h('span', { class: 'blame-summary' }, uncommitted ? 'Uncommitted change' : c.summary),
          h('span', { class: 'blame-when' }, uncommitted ? '' : relativeTime(c.date)))
        : h('span', { class: 'blame-gutter' });
      wrap.appendChild(h('div', { class: ['blame-line', first && 'first'] }, gutter, h('span', { class: 'ln' }, String(line.line)), codeCell(line.text, hl)));
    }
    this.body.appendChild(wrap);
  }

  // ------------------------------------------------------------ merge tool

  async loadMerge(token, s) {
    const det = await git(this.repo, 'conflictDetails', s.path);
    if (token !== this.token) return;
    clear(this.body);
    const text = det.working;
    const binaryish = text === null || (det.ours === null) !== (det.theirs === null) || text.includes('\0');
    const segments = text && !binaryish ? parseConflicts(text) : null;
    if (!segments || !conflictCount(segments)) {
      const what = det.ours === null ? 'Deleted in your branch (ours), modified in theirs.' : det.theirs === null ? 'Modified in your branch (ours), deleted in theirs.' : text === null ? 'The file is missing from the working tree.' : 'No conflict markers left in this file.';
      this.body.appendChild(this.message('Choose a side for this file', what, [
        { label: det.ours === null ? 'Keep deleted (ours)' : 'Use ours', run: () => this.app.resolveConflict(s.path, 'ours') },
        { label: det.theirs === null ? 'Delete (theirs)' : 'Use theirs', run: () => this.app.resolveConflict(s.path, 'theirs') },
        ...(text !== null && !text.includes('\0') ? [{ label: 'Mark resolved as is', run: () => this.app.markResolved([s.path]) }] : []),
      ]));
      return;
    }
    this.merge = { segments, resolutions: [], manual: false, text, suggestions: new Map(), ai: null };
    this.renderMerge();
  }

  renderMerge() {
    const s = this.spec;
    const m = this.merge;
    const total = conflictCount(m.segments);
    const done = m.resolutions.filter(Boolean).length;
    const op = this.app.data?.opState;
    const oursName = op && op.type === 'rebase' ? 'Upstream (ours)' : 'Current branch (ours)';
    const theirsName = op && op.type === 'rebase' ? 'Your commit (theirs)' : 'Incoming (theirs)';
    clear(this.body);
    const bar = h('div', { class: 'merge-bar' },
      h('div', { class: 'merge-progress' },
        h('span', { class: 'mp-count' }, `${done} of ${pluralize(total, 'conflict')} resolved`),
        h('span', { class: 'mp-track' }, h('span', { class: 'mp-fill', style: { width: `${(done / total) * 100}%` } }))),
      h('span', { class: 'spacer' }),
      this.aiButtons(),
      h('button', { class: 'btn btn-small', onClick: () => this.app.resolveConflict(s.path, 'ours') }, 'Take all ours'),
      h('button', { class: 'btn btn-small', onClick: () => this.app.resolveConflict(s.path, 'theirs') }, 'Take all theirs'),
      h('button', { class: ['btn', 'btn-small', m.manual && 'on'], 'aria-pressed': String(m.manual), onClick: () => {
        m.manual = !m.manual;
        if (m.manual) m.manualText = resolveConflicts(m.segments, m.resolutions);
        this.renderMerge();
      } }, icon('pencil', { size: 13 }), 'Edit output'),
      h('button', { class: 'btn btn-small btn-key', onClick: () => this.saveMerge() }, 'Save & mark resolved'));
    this.body.appendChild(bar);
    if (m.ai && m.ai.status) {
      this.body.appendChild(h('div', { class: ['ai-note', m.ai.bad && 'bad'], role: 'status' }, icon('sparkles', { size: 13 }), h('span', null, m.ai.status)));
    }

    if (m.manual) {
      const ta = h('textarea', { class: 'input merge-editor mono', spellcheck: 'false' }, m.manualText);
      ta.addEventListener('input', () => {
        m.manualText = ta.value;
      });
      this.body.appendChild(ta);
      requestAnimationFrame(() => ta.focus());
      return;
    }
    const lang = languageFor(s.path);
    const hl = makeHighlighter(lang, m.text.split('\n').length);
    const wrap = h('div', { class: 'merge' });
    let n = 0;
    for (const seg of m.segments) {
      if (seg.type === 'text') {
        wrap.appendChild(contextBlock(seg.lines, hl));
        continue;
      }
      const idx = n++;
      const r = m.resolutions[idx];
      const choose = (val) => {
        m.resolutions[idx] = val;
        this.renderMerge();
      };
      if (r) {
        const lines = r.lines || (r === 'ours' ? seg.ours : r === 'theirs' ? seg.theirs : r === 'both' ? [...seg.ours, ...seg.theirs] : [...seg.theirs, ...seg.ours]);
        const label = r.lines ? 'Kept the AI suggestion' : { ours: 'Kept ours', theirs: 'Kept theirs', both: 'Kept both (ours first)', 'both-theirs-first': 'Kept both (theirs first)' }[r];
        wrap.appendChild(h('div', { class: 'conflict resolved' },
          h('div', { class: 'conflict-head' }, h('span', { class: 'led led-green' }), h('span', null, `Conflict ${idx + 1} · ${label}`), h('span', { class: 'spacer' }), h('button', { class: 'btn btn-tiny', onClick: () => choose(undefined) }, 'Change')),
          codeBlock(lines, hl, 'res')));
        continue;
      }
      wrap.appendChild(h('div', { class: 'conflict' },
        h('div', { class: 'conflict-head' }, h('span', { class: 'led led-red' }), h('span', null, `Conflict ${idx + 1}`), h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-tiny', onClick: () => choose('both') }, 'Both, ours first'),
          h('button', { class: 'btn btn-tiny', onClick: () => choose('both-theirs-first') }, 'Both, theirs first')),
        h('div', { class: 'conflict-sides' },
          h('div', { class: 'side ours' },
            h('div', { class: 'side-head' }, legend(oursName), h('span', { class: 'side-ref mono' }, seg.oursLabel), h('span', { class: 'spacer' }), h('button', { class: 'btn btn-tiny btn-key', onClick: () => choose('ours') }, 'Use ours')),
            codeBlock(seg.ours, hl, 'ours')),
          h('div', { class: 'side theirs' },
            h('div', { class: 'side-head' }, legend(theirsName), h('span', { class: 'side-ref mono' }, seg.theirsLabel), h('span', { class: 'spacer' }), h('button', { class: 'btn btn-tiny btn-key', onClick: () => choose('theirs') }, 'Use theirs')),
            codeBlock(seg.theirs, hl, 'theirs'))),
        this.suggestionBlock(idx, hl)));
    }
    this.body.appendChild(wrap);
  }

  // ------------------------------------------------------------ AI suggestions

  aiButtons() {
    const m = this.merge;
    const ai = this.app.aiConfig();
    const open = conflictContext(m.segments).filter((c) => !m.resolutions[c.index]);
    const ready = [...m.suggestions.keys()].filter((i) => !m.resolutions[i]);
    const busy = Boolean(m.ai && m.ai.busy);
    return [
      ready.length > 1 ? h('button', { class: 'btn btn-small', dataset: { action: 'ai-use-all' }, onClick: () => {
        for (const i of ready) m.resolutions[i] = { lines: m.suggestions.get(i).lines };
        this.renderMerge();
      } }, `Use ${ready.length} suggestions`) : null,
      h('button', {
        class: 'btn btn-small ai-resolve',
        dataset: { action: 'ai-resolve' },
        disabled: busy || m.manual || !open.length,
        'aria-busy': busy ? 'true' : null,
        title: ai ? `Suggest a resolution for each conflict with ${ai.label}. Nothing changes until you use one.` : 'Uses the same AI provider and key as AI commit messages',
        onClick: () => this.aiResolve(),
      }, icon('sparkles', { size: 13 }), busy ? 'Thinking…' : ai ? 'Resolve with AI' : 'Set up AI…'),
    ];
  }

  suggestionBlock(idx, hl) {
    const m = this.merge;
    const sug = m.suggestions.get(idx);
    if (!sug) return null;
    const use = () => {
      m.resolutions[idx] = { lines: sug.lines };
      this.renderMerge();
    };
    const edit = () => {
      m.resolutions[idx] = { lines: sug.lines };
      m.manual = true;
      m.manualText = resolveConflicts(m.segments, m.resolutions);
      this.renderMerge();
    };
    const dismiss = () => {
      m.suggestions.delete(idx);
      this.renderMerge();
    };
    const lamp = { high: 'green', medium: 'amber', low: 'red' }[sug.confidence];
    return h('div', { class: 'ai-suggestion', dataset: { conflict: String(idx + 1) } },
      h('div', { class: 'ai-sug-head' }, icon('sparkles', { size: 13 }), h('span', null, 'AI suggestion'),
        h('span', { class: 'ai-conf', title: 'How sure the model says it is' }, led(lamp), `${sug.confidence} confidence`),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-tiny', onClick: dismiss }, 'Dismiss'),
        h('button', { class: 'btn btn-tiny', onClick: edit }, 'Edit'),
        h('button', { class: 'btn btn-tiny btn-key', onClick: use }, 'Use suggestion')),
      sug.why ? h('p', { class: 'ai-why' }, sug.why) : null,
      codeBlock(sug.lines, hl, 'ai'));
  }

  /** Ask the AI commit-message provider for a resolution of every open conflict; they come back as suggestions. */
  async aiResolve() {
    const m = this.merge;
    const s = this.spec;
    const ai = this.app.aiConfig();
    if (!ai) {
      await aiSettingsDialog(this.app);
      if (this.merge === m) this.renderMerge();
      return;
    }
    const all = conflictContext(m.segments);
    const open = all.filter((c) => !m.resolutions[c.index]);
    if (!open.length) return;
    const op = this.app.data && this.app.data.opState;
    const first = open[0];
    const operation = op ? `a ${op.type} is in progress` : /stash/i.test(`${first.oursLabel} ${first.theirsLabel}`) ? 'a stash was applied on top of local changes' : 'a merge';
    m.ai = { busy: true, status: `Asking ${ai.label} about ${pluralize(open.length, 'conflict')}…` };
    this.renderMerge();
    try {
      const text = await invoke('ai:resolve', {
        provider: ai.provider, model: ai.model, baseUrl: ai.baseUrl, path: s.path, operation,
        oursLabel: first.oursLabel, theirsLabel: first.theirsLabel,
        conflicts: open.map((c) => ({ index: c.index, ours: c.ours, base: c.base, theirs: c.theirs, before: c.before, after: c.after })),
      });
      const got = parseResolutionReply(text, all.length);
      let added = 0;
      for (const [i, sug] of got) {
        if (m.resolutions[i]) continue;
        m.suggestions.set(i, sug);
        added++;
      }
      const left = open.length - added;
      m.ai = { status: `${pluralize(added, 'suggestion')} from ${ai.label}${left ? `, ${left} left for you` : ''}. Read each one before you use it; nothing changes until you do.` };
      if (this.app.donkey) this.app.donkey.react('aiResolve');
    } catch (e) {
      m.ai = { status: e.message || 'That didn’t work. Try again.', bad: true };
    }
    if (this.merge === m) this.renderMerge();
  }

  async saveMerge() {
    const m = this.merge;
    const content = m.manual ? m.manualText : resolveConflicts(m.segments, m.resolutions);
    const remaining = conflictCount(parseConflicts(content));
    if (remaining) {
      const ok = await confirmDialog({
        title: 'Unresolved conflicts',
        message: `${pluralize(remaining, 'conflict')} still ${remaining === 1 ? 'has' : 'have'} markers. Save and mark the file resolved anyway?`,
        okLabel: 'Save anyway',
        danger: true,
      });
      if (!ok) return;
    }
    await this.app.saveResolution(this.spec.path, content);
  }

  // ------------------------------------------------------------ helpers

  message(title, sub, actions = []) {
    return h('div', { class: 'detail-msg' },
      h('div', { class: 'dm-title' }, title),
      sub ? h('div', { class: 'dm-sub' }, sub) : null,
      actions.length ? h('div', { class: 'dm-actions' }, actions.map((a) => h('button', { class: 'btn', onClick: a.run }, a.label))) : null);
  }
}

function fileOf(s) {
  return { path: s.path, oldPath: s.oldPath, status: s.status, untracked: s.kind === 'untracked' || s.untracked };
}

function makeHighlighter(lang, total) {
  if (!lang || total > MAX_HIGHLIGHT_LINES || !hljs.getLanguage(lang)) return null;
  const cache = new Map();
  return (text) => {
    if (cache.has(text)) return cache.get(text);
    let html;
    try {
      html = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      html = null;
    }
    cache.set(text, html);
    return html;
  };
}

function codeCell(text, hl) {
  const el = h('span', { class: 'code' });
  const html = hl ? hl(text) : null;
  if (html !== null && html !== undefined) el.innerHTML = html || ' ';
  else el.textContent = text || ' ';
  return el;
}

function unifiedLine(l, hi, li, hl) {
  if (l.type === '\\') return h('div', { class: 'dl nonl' }, h('span', { class: 'ln' }), h('span', { class: 'ln' }), h('span', { class: 'sign' }), h('span', { class: 'code' }, 'No newline at end of file'));
  const cls = l.type === '+' ? 'add' : l.type === '-' ? 'del' : 'ctx';
  const chg = l.type !== ' ';
  return h('div', { class: ['dl', cls, chg && 'chg'], dataset: { h: String(hi), l: String(li) } },
    h('span', { class: 'ln' }, l.oldNo ?? ''),
    h('span', { class: 'ln' }, l.newNo ?? ''),
    h('span', { class: 'sign' }, l.type === '+' ? '+' : l.type === '-' ? '−' : ''),
    codeCell(l.text, hl));
}

function splitLine(row, hi, hl) {
  const half = (l, side) => {
    if (!l) return h('div', { class: 'half empty' }, h('span', { class: 'ln' }), h('span', { class: 'sign' }), h('span', { class: 'code' }));
    const cls = l.type === '+' ? 'add' : l.type === '-' ? 'del' : 'ctx';
    const chg = l.type !== ' ';
    return h('div', { class: ['half', cls, chg && 'chg'], dataset: chg ? { h: String(hi), l: String(l.index) } : {} },
      h('span', { class: 'ln' }, side === 'left' ? l.oldNo ?? '' : l.newNo ?? ''),
      h('span', { class: 'sign' }, l.type === '+' ? '+' : l.type === '-' ? '−' : ''),
      codeCell(l.text, hl));
  };
  return h('div', { class: 'dl split' }, half(row.left, 'left'), half(row.right, 'right'));
}

function codeBlock(lines, hl, cls) {
  return h('div', { class: ['code-block', cls] }, lines.length
    ? lines.map((t) => h('div', { class: 'cb-line' }, codeCell(t, hl)))
    : h('div', { class: 'cb-line empty' }, h('span', { class: 'code' }, '(empty)')));
}

function contextBlock(lines, hl) {
  const keep = 3;
  if (lines.length <= keep * 2 + 2) return codeBlock(lines, hl, 'ctx');
  const wrap = h('div', { class: 'ctx-wrap' });
  const head = codeBlock(lines.slice(0, keep), hl, 'ctx');
  const tail = codeBlock(lines.slice(-keep), hl, 'ctx');
  const hidden = lines.length - keep * 2;
  const expander = h('button', { class: 'ctx-expand', onClick: () => {
    wrap.replaceWith(codeBlock(lines, hl, 'ctx'));
  } }, icon('chevron-down', { size: 12 }), `${hidden} unchanged lines`);
  wrap.append(head, expander, tail);
  return wrap;
}

function formatBytes(n) {
  if (n === undefined || n === null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
