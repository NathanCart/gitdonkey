// Virtualized commit graph: DOM rows for text, one canvas for the cables.
import { h, icon, clear, avatar, legend } from './dom.js';
import { shortHash, relativeTime, fullDate } from './lib/util.js';
import { kb } from './api.js';
import { avatarImage } from './avatars.js';
import { pullTag } from './pulls.js';

export const ROW_H = 28;
const LANE_W = 17;
const PAD_L = 14;
const OVERSCAN = 14;

export class GraphView {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.rows = [];
    this.layout = { rows: [], width: 1, tail: [] };
    this.refsByHash = new Map();
    this.selectedIndex = -1;
    this.matchSet = null;
    this.first = -1;
    this.last = -1;
    this.wip = null;
    this.build();
  }

  build() {
    this.filterBtn = h('button', { class: 'icon-btn gh-filter', title: 'Filter the graph: branches, remote branches, tags, an author', 'aria-label': 'Filter the graph', onClick: (e) => this.app.graphFilterMenu(e.currentTarget) }, icon('list-filter', { size: 13 }));
    this.header = h('div', { class: 'graph-head' },
      h('div', { class: 'gh-cell gh-refs' }, legend('Branch / Tag'), this.filterBtn, h('div', { class: 'col-resize', title: 'Drag to resize', onMousedown: (e) => this.startResize(e) })),
      h('div', { class: 'gh-cell gh-graph' }, legend('Graph')),
      h('div', { class: 'gh-cell gh-msg' }, legend('Commit message')),
      h('div', { class: 'gh-cell gh-author' }, legend('Author')),
      h('div', { class: 'gh-cell gh-date' }, legend('Date')),
      h('div', { class: 'gh-cell gh-sha' }, legend('SHA')));
    this.searchBar = h('div', { class: 'graph-search', hidden: true });
    this.filterBar = h('div', { class: 'graph-filterbar', hidden: true });
    this.scroller = h('div', { class: 'graph-scroll', tabindex: '0', 'aria-label': 'Commit graph' });
    this.spacer = h('div', { class: 'graph-spacer' });
    this.win = h('div', { class: 'graph-window' });
    this.canvas = h('canvas', { class: 'graph-canvas', 'aria-hidden': 'true' });
    this.rowsEl = h('div', { class: 'graph-rows', role: 'list' });
    this.win.append(this.canvas, this.rowsEl);
    this.spacer.appendChild(this.win);
    this.scroller.appendChild(this.spacer);
    this.empty = h('div', { class: 'graph-empty', hidden: true });
    this.el.append(this.header, this.filterBar, this.searchBar, this.scroller, this.empty);

    this.scroller.addEventListener('scroll', () => this.update());
    new ResizeObserver(() => this.update(true)).observe(this.scroller);

    this.rowsEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const row = e.target.closest('.g-row');
      if (!row) return;
      this.scroller.focus({ preventScroll: true });
      this.app.selectRow(Number(row.dataset.i), { scroll: false });
    });
    this.rowsEl.addEventListener('dblclick', (e) => {
      const plug = e.target.closest('.plug');
      if (plug) {
        const ref = this.refFromEl(plug);
        if (ref) this.app.checkoutRef(ref);
      }
    });
    this.rowsEl.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.g-row');
      if (!row) return;
      e.preventDefault();
      const i = Number(row.dataset.i);
      const plug = e.target.closest('.plug');
      this.app.selectRow(i, { scroll: false });
      if (plug) this.app.refMenu(this.refFromEl(plug), e.clientX, e.clientY);
      else this.app.commitMenu(this.rows[i], e.clientX, e.clientY);
    });
    this.scroller.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        this.app.moveSelection(1);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        this.app.moveSelection(-1);
      } else if (e.key === 'PageDown') {
        e.preventDefault();
        this.app.moveSelection(Math.floor(this.scroller.clientHeight / ROW_H));
      } else if (e.key === 'PageUp') {
        e.preventDefault();
        this.app.moveSelection(-Math.floor(this.scroller.clientHeight / ROW_H));
      } else if (e.key === 'Home') {
        e.preventDefault();
        this.app.selectRow(0, { center: false });
      } else if (e.key === 'End') {
        e.preventDefault();
        this.app.selectRow(this.rows.length - 1, { center: false });
      }
    });
    this.app.patch.bindTargets(this.rowsEl, (el) => this.refFromEl(el), this.scroller);
  }

  /** Put spinners on (or take them off) the plugs whose branches started or stopped working. */
  syncWorking() {
    for (const plug of this.rowsEl.querySelectorAll('.plug')) {
      const ref = this.refFromEl(plug);
      if (!ref) continue;
      const working = this.app.isRefWorking(ref);
      if (working === plug.classList.contains('working')) continue;
      const color = plug.style.getPropertyValue('--lane');
      plug.replaceWith(plugEl(ref, Number(plug.dataset.ref), color, { working }));
    }
  }

  refFromEl(el) {
    const row = el.closest('.g-row');
    if (!row) return null;
    const refs = this.refsByHash.get(this.rows[Number(row.dataset.i)]?.hash) || [];
    return refs[Number(el.dataset.ref)] || null;
  }

  setData({ rows, layout, refsByHash, selectedIndex, wip, emptyText }) {
    this.rows = rows;
    this.layout = layout;
    this.refsByHash = refsByHash;
    this.selectedIndex = selectedIndex;
    this.wip = wip;
    this.spacer.style.height = `${rows.length * ROW_H}px`;
    const graphW = Math.min(Math.max(layout.width, 1) * LANE_W + PAD_L * 2, this.app.layout.graphMax || 340);
    this.el.style.setProperty('--graph-w', `${graphW}px`);
    this.el.style.setProperty('--refs-w', `${this.app.layout.refs}px`);
    this.empty.hidden = rows.length > 0;
    if (!rows.length) {
      clear(this.empty).append(h('div', { class: 'empty-title' }, emptyText || 'No commits yet'), h('div', { class: 'empty-sub' }, 'Stage some files and make the first commit from the panel on the right.'));
    }
    this.update(true);
  }

  setSelected(i, { scroll = true } = {}) {
    this.selectedIndex = i;
    if (scroll && i >= 0) this.scrollToIndex(i);
    for (const el of this.rowsEl.children) el.classList.toggle('selected', Number(el.dataset.i) === i);
    this.update();
    this.draw();
  }

  /** What the graph is filtered to (words for the bar, or null), and whose commits to dim. */
  setFilter(words, dim) {
    this.dimFn = dim;
    this.filterBtn.classList.toggle('on', Boolean(words));
    this.filterBar.hidden = !words;
    if (!words) return;
    clear(this.filterBar).append(
      icon('list-filter', { size: 13 }),
      h('span', { class: 'gf-text' }, words.join(' · ')),
      h('button', { class: 'btn btn-tiny', onClick: (e) => this.app.graphFilterMenu(e.currentTarget) }, 'Change'),
      h('button', { class: 'btn btn-tiny', onClick: () => this.app.clearGraphFilter() }, 'Show everything'));
  }

  dimmed(i) {
    const c = this.rows[i];
    return Boolean((this.matchSet && !this.matchSet.has(i)) || (this.dimFn && c && !c.wip && this.dimFn(c)));
  }

  setMatches(set) {
    this.matchSet = set;
    this.update(true);
  }

  scrollToIndex(i, { center = false } = {}) {
    const top = i * ROW_H;
    const s = this.scroller;
    if (center || top < s.scrollTop || top + ROW_H > s.scrollTop + s.clientHeight) {
      s.scrollTop = center ? top - s.clientHeight / 2 + ROW_H / 2 : top < s.scrollTop ? top - ROW_H * 2 : top - s.clientHeight + ROW_H * 3;
    }
  }

  update(force = false) {
    const n = this.rows.length;
    const s = this.scroller;
    const first = Math.max(0, Math.floor(s.scrollTop / ROW_H) - OVERSCAN);
    const last = Math.min(n - 1, Math.ceil((s.scrollTop + s.clientHeight) / ROW_H) + OVERSCAN);
    if (!force && first === this.first && last === this.last) return;
    this.first = first;
    this.last = last;
    this.renderRows();
    this.draw();
    if (n && last >= n - 40) this.app.loadMore();
  }

  renderRows() {
    clear(this.rowsEl);
    this.win.style.transform = `translateY(${this.first * ROW_H}px)`;
    const frag = document.createDocumentFragment();
    for (let i = this.first; i <= this.last; i++) frag.appendChild(this.renderRow(i));
    this.rowsEl.appendChild(frag);
  }

  renderRow(i) {
    const c = this.rows[i];
    const L = this.layout.rows[i];
    const refs = this.refsByHash.get(c.hash) || [];
    const dim = this.dimmed(i);
    const row = h('div', {
      class: ['g-row', c.wip && 'g-wip', i === this.selectedIndex && 'selected', dim && 'dim', (this.matchSet || this.dimFn) && !dim && !c.wip && 'match'],
      role: 'listitem',
      dataset: { i: String(i) },
      style: { '--lane': L.color },
    });
    row.appendChild(this.refsCell(refs, L.color));
    row.appendChild(h('div', { class: 'g-cell g-graph' }));
    if (c.wip) {
      const w = this.wip || {};
      row.appendChild(h('div', { class: 'g-cell g-msg' },
        h('span', { class: 'wip-label' }, w.opLabel || 'Uncommitted changes'),
        w.conflicted ? h('span', { class: 'count c-conflict', title: 'Conflicted' }, icon('triangle-alert', { size: 12 }), w.conflicted) : null,
        w.unstaged ? h('span', { class: 'count c-mod', title: 'Unstaged' }, icon('file-pen-line', { size: 12 }), w.unstaged) : null,
        w.staged ? h('span', { class: 'count c-add', title: 'Staged' }, icon('check', { size: 12 }), w.staged) : null));
      row.appendChild(h('div', { class: 'g-cell g-author' }));
      row.appendChild(h('div', { class: 'g-cell g-date' }));
      row.appendChild(h('div', { class: 'g-cell g-sha' }));
      return row;
    }
    row.appendChild(h('div', { class: 'g-cell g-msg', title: c.subject }, h('span', { class: 'msg-text' }, c.subject || '(no message)')));
    row.appendChild(h('div', { class: 'g-cell g-author', title: `${c.author} <${c.email}>` }, avatar(c.author, c.email, 18), h('span', { class: 'author-name' }, c.author)));
    row.appendChild(h('div', { class: 'g-cell g-date', title: fullDate(c.date) }, relativeTime(c.date)));
    row.appendChild(h('div', { class: 'g-cell g-sha' }, shortHash(c.hash)));
    return row;
  }

  refsCell(refs, color) {
    const cell = h('div', { class: 'g-cell g-refs' });
    if (!refs.length) return cell;
    const plugs = h('div', { class: 'plugs' });
    refs.forEach((r, idx) => plugs.appendChild(plugEl(r, idx, color, { working: this.app.isRefWorking(r) })));
    cell.appendChild(plugs);
    if (refs.length > 1) {
      cell.appendChild(h('span', { class: 'plug-more', title: refs.map((r) => r.name).join('\n') }, `+${refs.length - 1}`));
      cell.classList.add('multi');
    }
    return cell;
  }

  draw() {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const width = this.el.style.getPropertyValue('--graph-w') ? parseFloat(this.el.style.getPropertyValue('--graph-w')) : 120;
    const count = this.last - this.first + 1;
    const height = Math.max(0, count) * ROW_H;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (count <= 0) return;
    const x = (col) => PAD_L + col * LANE_W;
    const yOf = (r) => (r - this.first) * ROW_H + ROW_H / 2;
    const n = this.rows.length;
    const caseColor = getComputedStyle(document.documentElement).getPropertyValue('--case').trim() || '#0b0c0e';
    const boneColor = getComputedStyle(document.documentElement).getPropertyValue('--legend').trim() || '#ece8df';
    const alphaFor = (r) => (this.dimmed(r) ? 0.28 : 1);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Cables: edges from row r-1 into row r.
    for (let r = Math.max(1, this.first); r <= Math.min(this.last + 1, n - 1); r++) {
      const y2 = yOf(r);
      const y1 = y2 - ROW_H;
      // Straight runs first, curves on top: a cable that changes lanes passes over the others.
      const edges = this.layout.rows[r].edges;
      for (const pass of [false, true]) {
        for (const e of edges) {
          if ((e.from !== e.to) !== pass) continue;
          ctx.globalAlpha = Math.min(alphaFor(r), alphaFor(r - 1));
          cable(ctx, x(e.from), y1, x(e.to), y2, e.color, e.dashed, caseColor);
        }
      }
    }
    // Open tails continue below the last loaded row.
    if (this.last === n - 1 && this.layout.tail.length) {
      const y1 = yOf(n - 1);
      for (const e of this.layout.tail) {
        ctx.globalAlpha = 0.6;
        cable(ctx, x(e.from), y1, x(e.to), y1 + ROW_H * 0.8, e.color, e.dashed, caseColor);
      }
    }
    // Jacks.
    for (let r = this.first; r <= this.last; r++) {
      const c = this.rows[r];
      const L = this.layout.rows[r];
      const cx = x(L.col);
      const cy = yOf(r);
      ctx.globalAlpha = alphaFor(r);
      const refs = this.refsByHash.get(c.hash);
      let img = null;
      if (refs && refs.length) {
        // Leader from the plug column into the jack.
        ctx.strokeStyle = L.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, cy);
        ctx.lineTo(cx - 8, cy);
        ctx.stroke();
      }
      if (c.wip) {
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = L.color;
        ctx.lineWidth = 2;
        ctx.fillStyle = caseColor;
        ctx.beginPath();
        ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      } else if (c.parents.length > 1) {
        ctx.fillStyle = L.color;
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fill();
      } else if ((img = avatarImage(c.email))) {
        ctx.fillStyle = L.color;
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = caseColor;
        ctx.fill();
        ctx.drawImage(img, cx - 8, cy - 8, 16, 16);
        ctx.restore();
      } else {
        ctx.fillStyle = L.color;
        ctx.beginPath();
        ctx.arc(cx, cy, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = caseColor;
        ctx.beginPath();
        ctx.arc(cx, cy, 3.25, 0, Math.PI * 2);
        ctx.fill();
        if (c.hash === this.app.headHash) {
          ctx.fillStyle = boneColor;
          ctx.beginPath();
          ctx.arc(cx, cy, 1.75, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (r === this.selectedIndex) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = boneColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy, c.parents.length > 1 && !c.wip ? 8 : img ? 12.5 : 10.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------ column resize

  startResize(e) {
    e.preventDefault();
    const startX = e.clientX;
    const start = this.app.layout.refs;
    const move = (ev) => {
      const w = Math.max(90, Math.min(420, start + ev.clientX - startX));
      this.app.layout.refs = w;
      this.el.style.setProperty('--refs-w', `${w}px`);
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing');
      this.app.saveLayout();
    };
    document.body.classList.add('resizing');
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  // ------------------------------------------------------------ search bar

  openSearch({ query = '', onInput, onNext, onPrev, onClose, onLoadAll }) {
    clear(this.searchBar);
    const input = h('input', { class: 'input search-input', placeholder: 'Find commits by message, author or SHA', value: query, spellcheck: 'false' });
    this.searchCount = h('span', { class: 'search-count' });
    this.searchLoadAll = h('button', { class: 'btn btn-small', hidden: true, onClick: onLoadAll }, 'Search full history');
    this.searchBar.append(
      icon('search', { size: 14 }),
      input,
      this.searchCount,
      this.searchLoadAll,
      h('button', { class: 'icon-btn', title: `Previous match (${kb('⇧↵')})`, onClick: onPrev }, icon('chevron-up', { size: 14 })),
      h('button', { class: 'icon-btn', title: `Next match (${kb('↵')})`, onClick: onNext }, icon('chevron-down', { size: 14 })),
      h('button', { class: 'icon-btn', title: 'Close (Esc)', onClick: onClose }, icon('x', { size: 14 })),
    );
    input.addEventListener('input', () => onInput(input.value));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) onPrev();
        else onNext();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    });
    this.searchBar.hidden = false;
    input.focus();
    input.select();
    this.searchInput = input;
  }

  setSearchStatus(text, { canLoadAll = false } = {}) {
    if (this.searchCount) this.searchCount.textContent = text;
    if (this.searchLoadAll) this.searchLoadAll.hidden = !canLoadAll;
  }

  closeSearch() {
    this.searchBar.hidden = true;
    clear(this.searchBar);
    this.searchInput = null;
  }
}

function cablePath(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  if (x1 === x2) ctx.lineTo(x2, y2);
  else {
    const dy = y2 - y1;
    ctx.bezierCurveTo(x1, y1 + dy * 0.62, x2, y2 - dy * 0.62, x2, y2);
  }
}

/** A patch cable: a dark sheath so crossings read as one cable over another, then the coloured body. */
function cable(ctx, x1, y1, x2, y2, color, dashed, sheath) {
  if (dashed) ctx.setLineDash([4, 5]);
  if (x1 !== x2 && !dashed) {
    ctx.strokeStyle = sheath;
    ctx.lineWidth = 6.5;
    cablePath(ctx, x1, y1, x2, y2);
    ctx.stroke();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 3.5;
  cablePath(ctx, x1, y1, x2, y2);
  ctx.stroke();
  if (dashed) ctx.setLineDash([]);
}

export function plugEl(ref, idx, color, { working = false } = {}) {
  const lit = ref.isHead;
  const el = h('span', {
    class: ['plug', `plug-${ref.type}`, lit && 'lit', working && 'working'],
    'aria-busy': working ? 'true' : null,
    style: { '--lane': color },
    dataset: ref.type === 'tag' || ref.type === 'head' ? { ref: String(idx) } : { ref: String(idx), patchable: '1' },
    draggable: ref.type === 'tag' ? 'false' : 'true',
    title: plugTitle(ref),
  });
  // Something's being done to it (push, pull, checkout…): a spinner where its jack or cloud is.
  if (working) el.appendChild(h('span', { class: 'plug-spin', 'aria-hidden': 'true' }));
  else if (ref.type === 'tag') el.appendChild(icon('tag', { size: 11 }));
  else if (ref.type === 'remote') el.appendChild(icon('cloud', { size: 12 }));
  else if (ref.type === 'head') el.appendChild(icon('crosshair', { size: 11 }));
  else el.appendChild(h('span', { class: 'plug-jack' }));
  el.appendChild(h('span', { class: 'plug-name' }, ref.name));
  if (ref.type === 'local' && ref.remotes && ref.remotes.length) el.appendChild(h('span', { class: 'plug-sync', title: `In sync with ${ref.remotes.join(', ')}` }, icon('cloud', { size: 11 })));
  if (ref.pr) el.appendChild(pullTag(ref.pr));
  if (ref.worktree) el.appendChild(h('span', { class: 'plug-wt', title: `Checked out in the worktree ${ref.worktree.path}` }, icon('folder-tree', { size: 11 })));
  const b = ref.type === 'local' ? ref.branch : null;
  if (b && (b.ahead || b.behind)) {
    el.classList.toggle('diverged', Boolean(b.ahead && b.behind));
    el.appendChild(h('span', { class: 'plug-ab' }, b.ahead ? h('span', { class: 'ab ahead' }, `↑${b.ahead}`) : null, b.behind ? h('span', { class: 'ab behind' }, `↓${b.behind}`) : null));
  }
  return el;
}

/** How a branch stands against the branch it tracks, in words. */
export function syncText(b) {
  if (!b || !b.upstream) return '';
  if (b.gone) return `${b.upstream} no longer exists on the remote`;
  if (b.ahead && b.behind) return `Split from ${b.upstream}: ${b.ahead} commit${b.ahead === 1 ? '' : 's'} to push, ${b.behind} to pull`;
  if (b.ahead) return `${b.ahead} commit${b.ahead === 1 ? '' : 's'} to push to ${b.upstream}`;
  if (b.behind) return `${b.behind} commit${b.behind === 1 ? '' : 's'} to pull from ${b.upstream}`;
  return `In sync with ${b.upstream}`;
}

function plugTitle(ref) {
  if (ref.type === 'local') {
    const sync = ref.branch && (ref.branch.ahead || ref.branch.behind || ref.branch.gone) ? `\n${syncText(ref.branch)}` : '';
    const where = ref.worktree ? `\nChecked out in the worktree ${ref.worktree.path} · double-click to open it` : '\nDouble-click to check out';
    return `${ref.isHead ? 'Current branch' : 'Local branch'} ${ref.name}${ref.remotes?.length ? ` (also ${ref.remotes.join(', ')})` : ''}${sync}${where} · drag onto another branch to merge or rebase`;
  }
  if (ref.type === 'remote') return `Remote branch ${ref.name}\nDouble-click to check out · drag onto a branch to merge`;
  if (ref.type === 'tag') return `Tag ${ref.name}${ref.tag?.message ? `\n${ref.tag.message}` : ''}`;
  return 'Detached HEAD';
}
