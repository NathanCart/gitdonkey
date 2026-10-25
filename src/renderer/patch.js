// Drag-to-patch: dragging a branch plug draws a live, sagging cable to the
// cursor. Dropping it on another branch plug opens the patch menu.

const SVG_NS = 'http://www.w3.org/2000/svg';
// Holding a cable near the top or bottom of the graph or sidebar scrolls it,
// faster nearer (and past) the edge, so a branch far away can be reached.
const EDGE = 56;
const BEYOND = 36;
const MAX_SPEED = 26;
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export class PatchBay {
  constructor(app) {
    this.app = app;
    this.drag = null;
    this.target = null;
    this.scrollers = [];
    this.pointer = null;
    this.frame = 0;
    this.blank = new Image();
    this.blank.src = BLANK;
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('patch-overlay');
    this.svg.innerHTML = '<path class="patch-cable"/><path class="patch-core"/><circle class="patch-jack" r="7"/><circle class="patch-jack-hole" r="3"/><circle class="patch-tip" r="6.5"/><circle class="patch-tip-hole" r="2.5"/>';
    this.svg.style.display = 'none';
    document.body.appendChild(this.svg);
    this.label = document.createElement('div');
    this.label.className = 'patch-label';
    this.label.hidden = true;
    document.body.appendChild(this.label);
    document.addEventListener('dragover', (e) => {
      if (!this.drag) return;
      this.pointer = { x: e.clientX, y: e.clientY };
      this.drawTo(e.clientX, e.clientY);
    });
    document.addEventListener('dragend', () => this.end());
    document.addEventListener('drop', () => this.end());
    // The graph redraws its rows as it scrolls, so the plug that started the
    // drag may be gone by the time it ends; a pointer moving with no button
    // held means it has.
    document.addEventListener('pointermove', (e) => {
      if (this.drag && e.buttons === 0) this.end();
    });
  }

  /** `scroller` is the element that scrolls the targets (the container itself by default). */
  bindTargets(container, resolveRef, scroller = container) {
    this.scrollers.push(scroller);
    container.addEventListener('dragstart', (e) => {
      const el = e.target.closest && e.target.closest('[draggable="true"]');
      if (!el) return;
      const ref = resolveRef(el);
      if (!ref || ref.type === 'tag') {
        e.preventDefault();
        return;
      }
      this.begin(e, el, ref);
    });
    container.addEventListener('dragover', (e) => {
      if (!this.drag) return;
      const el = e.target.closest && e.target.closest('[data-patchable]');
      const ref = el ? resolveRef(el) : null;
      if (ref && this.accepts(ref)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'link';
        this.setTarget(el, ref);
      } else this.setTarget(null);
    });
    container.addEventListener('dragleave', (e) => {
      if (this.target && !this.target.contains(e.relatedTarget)) this.setTarget(null);
    });
    container.addEventListener('drop', (e) => {
      if (!this.drag) return;
      const el = e.target.closest && e.target.closest('[data-patchable]');
      const ref = el ? resolveRef(el) : null;
      if (!ref || !this.accepts(ref)) return;
      e.preventDefault();
      const src = this.drag.ref;
      this.end();
      this.app.onPatch(src, ref, e.clientX, e.clientY);
    });
  }

  accepts(ref) {
    if (!this.drag || ref.type === 'tag' || ref.type === 'head') return false;
    const src = this.drag.ref;
    return !(src.type === ref.type && src.name === ref.name);
  }

  begin(e, el, ref) {
    const r = el.getBoundingClientRect();
    const color = getComputedStyle(el).getPropertyValue('--lane').trim() || getComputedStyle(el).getPropertyValue('--jack').trim() || '#ece8df';
    this.drag = { ref, x0: r.left + 9, y0: r.top + r.height / 2, color, el, scroller: this.scrollers.find((s) => s.contains(el)) || null };
    el.classList.add('patching');
    el.addEventListener('dragend', () => this.end(), { once: true });
    // Where the pointer is: dragover only fires over things that might take a
    // drop, but the plug being dragged hears 'drag' all the way (even after
    // the graph has redrawn its row away).
    this.drag.onDrag = (ev) => {
      if (!this.drag || (!ev.clientX && !ev.clientY)) return;
      this.pointer = { x: ev.clientX, y: ev.clientY };
      this.drawTo(ev.clientX, ev.clientY);
    };
    el.addEventListener('drag', this.drag.onDrag);
    this.pointer = { x: e.clientX, y: e.clientY };
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.autoScroll());
    e.dataTransfer.effectAllowed = 'link';
    e.dataTransfer.setData('text/plain', ref.name);
    e.dataTransfer.setDragImage(this.blank, 0, 0);
    this.svg.style.setProperty('--cable', color);
    this.svg.style.display = 'block';
    document.body.classList.add('is-patching');
    this.drawTo(e.clientX, e.clientY);
  }

  drawTo(x, y) {
    if (!this.drag || (x === 0 && y === 0)) return;
    const { x0, y0 } = this.drag;
    const dist = Math.hypot(x - x0, y - y0);
    const sag = Math.min(150, dist * 0.38);
    const mx = (x0 + x) / 2;
    const my = Math.max(y0, y) + sag;
    const d = `M ${x0} ${y0} Q ${mx} ${my} ${x} ${y}`;
    const [cableEl, core, jack, jackHole, tip, tipHole] = this.svg.children;
    cableEl.setAttribute('d', d);
    core.setAttribute('d', d);
    jack.setAttribute('cx', x0);
    jack.setAttribute('cy', y0);
    jackHole.setAttribute('cx', x0);
    jackHole.setAttribute('cy', y0);
    tip.setAttribute('cx', x);
    tip.setAttribute('cy', y);
    tipHole.setAttribute('cx', x);
    tipHole.setAttribute('cy', y);
  }

  /** Scroll whichever list the cable is held at the edge of; the cable stays on its plug. */
  autoScroll() {
    this.frame = 0;
    if (!this.drag) return;
    const p = this.pointer;
    if (p) {
      for (const s of this.scrollers) {
        const r = s.getBoundingClientRect();
        if (!r.height || p.x < r.left || p.x > r.right) continue;
        let t = 0;
        if (p.y < r.top + EDGE && p.y > r.top - BEYOND) t = -(r.top + EDGE - p.y) / (EDGE + BEYOND);
        else if (p.y > r.bottom - EDGE && p.y < r.bottom + BEYOND) t = (p.y - (r.bottom - EDGE)) / (EDGE + BEYOND);
        if (!t) continue;
        const step = Math.sign(t) * Math.max(2, Math.round(MAX_SPEED * t * t));
        const before = s.scrollTop;
        s.scrollTop = before + step;
        const moved = s.scrollTop - before;
        if (moved && this.drag.scroller === s) {
          this.drag.y0 -= moved;
          this.drawTo(p.x, p.y);
        }
      }
    }
    this.frame = requestAnimationFrame(() => this.autoScroll());
  }

  setTarget(el, ref) {
    if (this.target === el) return;
    if (this.target) this.target.classList.remove('patch-target');
    this.target = el;
    if (el) el.classList.add('patch-target');
    if (el && ref && this.drag) {
      const r = el.getBoundingClientRect();
      this.label.textContent = `Patch ${this.drag.ref.name} → ${ref.name}`;
      this.label.style.left = `${r.left}px`;
      this.label.style.top = `${Math.max(4, r.top - 30)}px`;
      this.label.hidden = false;
    } else this.label.hidden = true;
  }

  end() {
    if (!this.drag) return;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.pointer = null;
    this.drag.el.removeEventListener('drag', this.drag.onDrag);
    this.drag.el.classList.remove('patching');
    this.setTarget(null);
    this.drag = null;
    this.svg.style.display = 'none';
    this.label.hidden = true;
    document.body.classList.remove('is-patching');
  }
}
