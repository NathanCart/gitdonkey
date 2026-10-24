// The donkey in the bottom-left corner: a little 3D GitDonkey who breathes,
// blinks, watches the pointer and says something about what you do in Git.
// Click to poke him, double-click to spin him, wiggle the pointer over him to
// pet him, right-click for hay, jokes and quiet. Settings switches him off.
import { THREE, buildDonkey, createMaterials, light } from './lib/donkey-model.js';
import { pickLine, eventForGit, moodOf } from './lib/donkey-lines.js';
import { h, logoMark } from './dom.js';
import { contextMenu } from './ui.js';
import { onGitCall } from './api.js';

const SIZE = 116;
const IDLE_AFTER = 15 * 60 * 1000;
const QUIET_FOR = 60 * 60 * 1000;
const EVENT_GAP = 2500; // between things he says on his own

const ease = (x) => 1 - (1 - x) ** 3;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export class Donkey {
  constructor(app) {
    this.app = app;
    this.el = null;
    this.quietUntil = 0;
    this.lastEventAt = 0;
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    onGitCall((call) => this.onGit(call));
  }

  get enabled() {
    return Boolean(this.el);
  }

  setEnabled(on, { greet = false } = {}) {
    if (on && !this.el) {
      this.mount();
      if (greet) this.say(pickLine('back'), { mood: 'happy', force: true });
    } else if (!on && this.el) {
      this.unmount();
    }
    document.body.classList.toggle('has-donkey', Boolean(on));
  }

  // ------------------------------------------------------------ DOM

  mount() {
    this.canvas = h('canvas', { width: String(SIZE), height: String(SIZE), 'aria-hidden': 'true' });
    this.hit = h('button', {
      type: 'button',
      class: 'donkey-hit',
      'aria-label': 'The donkey. Press Enter to poke him; Shift+F10 for more.',
      title: 'Poke, double-click, pet or right-click',
    }, this.canvas);
    this.bubble = h('p', { class: 'donkey-says', role: 'status', 'aria-live': 'polite', onClick: () => this.hush() });
    this.el = h('div', { id: 'donkey', class: 'donkey' }, this.hit, this.bubble);
    document.body.appendChild(this.el);

    this.state = {
      t: 0, hop: 0, hopV: 0, spin: 0, spinFrom: 0, spinAt: -1, shake: -1, chew: -1, yawn: -1, blinkAt: 2, blink: 0,
      earKick: [0, 0], droop: 0, wide: 0, happy: 0, look: { x: 0, y: 0 }, aim: { x: 0, y: 0 },
    };
    this.pokes = [];
    this.sulkUntil = 0;
    this.pet = { dir: 0, flips: [], last: 0 };
    this.clickTimer = 0;
    this.lastInput = Date.now();
    this.idleSaid = false;

    this.initGl();

    this.hit.addEventListener('click', (e) => {
      // A single click waits a moment so a double-click is a spin, not two
      // pokes; the third click on and every one after that is a poke.
      clearTimeout(this.clickTimer);
      if (e.detail === 2) return;
      if (e.detail >= 3) this.poke();
      else this.clickTimer = setTimeout(() => this.poke(), e.detail === 0 ? 0 : 220);
    });
    this.hit.addEventListener('dblclick', () => {
      clearTimeout(this.clickTimer);
      this.spin();
    });
    this.hit.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.menu(e.clientX, e.clientY);
    });
    this.hit.addEventListener('keydown', (e) => {
      if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
        e.preventDefault();
        const r = this.hit.getBoundingClientRect();
        this.menu(r.right, r.top);
      }
    });
    this.hit.addEventListener('pointermove', (e) => this.petting(e));
    this.onMove = (e) => {
      this.lastInput = Date.now();
      this.idleSaid = false;
      const r = this.hit.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      this.state.aim = { x: clamp((e.clientX - cx) / 700, -1, 1), y: clamp((e.clientY - cy) / 500, -1, 1) };
    };
    this.onKey = () => {
      this.lastInput = Date.now();
      this.idleSaid = false;
    };
    window.addEventListener('mousemove', this.onMove, { passive: true });
    window.addEventListener('keydown', this.onKey, true);
    this.idleTimer = setInterval(() => this.checkIdle(), 30000);
  }

  unmount() {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.clickTimer);
    clearTimeout(this.hideTimer);
    clearInterval(this.idleTimer);
    window.removeEventListener('mousemove', this.onMove);
    window.removeEventListener('keydown', this.onKey, true);
    if (this.renderer) {
      this.scene.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
      });
      for (const m of Object.values(this.materials).flat()) m.dispose();
      this.renderer.dispose();
      this.renderer = null;
    }
    this.el.remove();
    this.el = null;
  }

  // ------------------------------------------------------------ 3D

  initGl() {
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      this.renderer = null;
    }
    if (!this.renderer) {
      // No WebGL: the flat logo, still pokeable.
      this.canvas.replaceWith(h('span', { class: 'donkey-flat' }, logoMark(72)));
      this.el.classList.add('flat');
      return;
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(SIZE, SIZE, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    light(this.scene);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.camera.position.set(0, 0.1, 9.4);
    this.materials = createMaterials();
    this.model = buildDonkey(this.materials);
    this.model.root.position.y = -0.35;
    this.scene.add(this.model.root);
    this.recolor();
    this.last = performance.now();
    this.frameCount = 0;
    const loop = (now) => {
      this.frame = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.frame = requestAnimationFrame(loop);
  }

  /** Forelock cables in the theme's red, amber and cyan. */
  recolor() {
    if (!this.materials) return;
    const css = getComputedStyle(document.documentElement);
    ['--red', '--amber', '--cyan'].forEach((v, i) => {
      const c = css.getPropertyValue(v).trim();
      if (c) this.materials.cables[i].color.set(c);
    });
  }

  busy() {
    const s = this.state;
    return s.spinAt >= 0 || s.shake >= 0 || s.chew >= 0 || s.yawn >= 0 || Math.abs(s.hopV) > 0.01 || s.hop > 0.001 || s.blink > 0;
  }

  tick(now) {
    if (document.hidden) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    // Idle at about 30fps (15 when the window isn't focused); full speed while he's doing something.
    const every = this.busy() ? 1 : document.hasFocus() ? 2 : 4;
    if (++this.frameCount % every) return;
    this.last = now;
    const s = this.state;
    const m = this.model;
    s.t += dt;
    const motion = this.reduced ? 0 : 1;

    // Hop: a little spring.
    s.hopV -= 30 * dt;
    s.hop = Math.max(0, s.hop + s.hopV * dt);
    if (s.hop === 0 && s.hopV < 0) s.hopV = 0;

    // Spin: one full turn.
    let spin = 0;
    if (s.spinAt >= 0) {
      const p = (s.t - s.spinAt) / 0.9;
      if (p >= 1) s.spinAt = -1;
      else spin = ease(p) * Math.PI * 2;
    }
    // Head shake (worried or annoyed).
    let shake = 0;
    if (s.shake >= 0) {
      const p = (s.t - s.shake) / 0.7;
      if (p >= 1) s.shake = -1;
      else shake = Math.sin(p * Math.PI * 6) * 0.35 * (1 - p);
    }

    // Look towards the pointer, smoothly.
    s.look.x += (s.aim.x - s.look.x) * Math.min(1, dt * 6);
    s.look.y += (s.aim.y - s.look.y) * Math.min(1, dt * 6);

    const breathe = Math.sin(s.t * 2.1) * 0.06 * motion;
    m.root.position.y = -0.35 + breathe + s.hop * motion;
    m.root.rotation.y = s.look.x * 0.55 * motion + spin * motion + shake * motion;
    m.root.rotation.x = s.look.y * 0.3 * motion - s.wide * 0.15;
    m.root.rotation.z = Math.sin(s.t * 0.9) * 0.03 * motion - s.look.x * 0.06 * motion;

    // Ears: twitch now and then, kick when poked, droop when worried, perk up when happy.
    s.earKick = s.earKick.map((k) => k * Math.exp(-dt * 5));
    s.droop += ((s.mood === 'worried' ? 1 : 0) - s.droop) * Math.min(1, dt * 4);
    s.happy += ((s.mood === 'happy' ? 1 : 0) - s.happy) * Math.min(1, dt * 4);
    s.wide += ((s.mood === 'shocked' ? 1 : 0) - s.wide) * Math.min(1, dt * 6);
    if (Math.random() < dt * 0.25 * motion) s.earKick[Math.random() < 0.5 ? 0 : 1] = 0.35;
    m.ears.forEach((ear, i) => {
      const dir = ear.userData.side ? -1 : 1;
      ear.rotation.z = dir * (s.earKick[i] + s.droop * 0.55 - s.happy * 0.12 + Math.sin(s.t * 1.7 + i) * 0.03 * motion);
    });

    // Jaw: talk while the bubble is up, chew hay, yawn when idle.
    let jaw = 0;
    if (this.talkingUntil && now < this.talkingUntil) jaw = Math.max(0, Math.sin(s.t * 18)) * 0.12;
    if (s.chew >= 0) {
      const p = (s.t - s.chew) / 1.6;
      if (p >= 1) s.chew = -1;
      else jaw = Math.abs(Math.sin(p * Math.PI * 7)) * 0.16;
    }
    if (s.yawn >= 0) {
      const p = (s.t - s.yawn) / 1.8;
      if (p >= 1) s.yawn = -1;
      else jaw = Math.sin(p * Math.PI) * 0.35;
    }
    m.jaw.rotation.x = -jaw;
    m.jaw.position.y = -53.6 - jaw * 4;

    // Eyes: follow the pointer, blink every few seconds, go wide when shocked.
    if (s.t > s.blinkAt) {
      s.blink = 1;
      s.blinkAt = s.t + 2.5 + Math.random() * 4;
    }
    s.blink = Math.max(0, s.blink - dt * 7);
    const lid = s.blink > 0.5 ? (1 - s.blink) * 2 : s.blink * 2;
    m.pupils.forEach((p) => {
      p.position.x = p.userData.home.x + s.look.x * 1.3;
      p.position.y = p.userData.home.y - s.look.y * 1.1;
      p.scale.set(1 + s.wide * 0.35, Math.max(0.08, 1 - lid * 0.92 - s.happy * 0.35) + s.wide * 0.35, 1);
    });

    this.renderer.render(this.scene, this.camera);
  }

  // ------------------------------------------------------------ doing things

  hopUp(v = 7) {
    if (this.reduced) return;
    this.state.hopV = v;
  }

  setMood(mood) {
    this.state.mood = mood;
    clearTimeout(this.moodTimer);
    this.moodTimer = setTimeout(() => {
      if (this.state) this.state.mood = 'neutral';
    }, 3500);
  }

  poke() {
    const now = Date.now();
    if (!this.state) return;
    this.state.earKick = [0.6, 0.6];
    // Annoyed: he sulks for a moment, and more pokes only get a head shake.
    if (now < this.sulkUntil) {
      this.state.shake = this.state.t;
      return;
    }
    this.pokes = [...this.pokes.filter((t) => now - t < 3000), now];
    if (this.pokes.length >= 4) {
      this.pokes = [];
      this.sulkUntil = now + 2500;
      this.state.shake = this.state.t;
      this.say(pickLine('annoyed'), { mood: 'shocked', force: true });
      return;
    }
    this.hopUp();
    this.say(pickLine('poke'), { mood: 'happy', force: true });
  }

  spin() {
    if (!this.state) return;
    this.state.spinAt = this.state.t;
    this.hopUp(5);
    this.say(pickLine('spin'), { mood: 'happy', force: true });
  }

  feed() {
    if (!this.state) return;
    this.state.chew = this.state.t;
    this.say(pickLine('feed'), { mood: 'happy', force: true });
  }

  /** Wiggling the pointer back and forth over him is petting. */
  petting(e) {
    const p = this.pet;
    const dir = Math.sign(e.movementX || 0);
    const now = Date.now();
    if (!dir) return;
    if (p.dir && dir !== p.dir) p.flips = [...p.flips.filter((t) => now - t < 1500), now];
    p.dir = dir;
    if (p.flips.length >= 5 && now - p.last > 6000) {
      p.last = now;
      p.flips = [];
      this.say(pickLine('pet'), { mood: 'happy', force: true });
    }
  }

  menu(x, y) {
    const quiet = Date.now() < this.quietUntil;
    contextMenu(x, y, [
      { label: 'Poke', run: () => this.poke() },
      { label: 'Feed hay', run: () => this.feed() },
      { label: 'Spin', run: () => this.spin() },
      { label: 'Tell me a joke', run: () => this.say(pickLine('joke'), { force: true, hold: true }) },
      '-',
      quiet
        ? { label: 'Talk again', run: () => {
          this.quietUntil = 0;
          this.say(pickLine('talk'), { force: true });
        } }
        : { label: 'Be quiet for an hour', run: () => {
          this.say(pickLine('quiet'), { force: true });
          this.quietUntil = Date.now() + QUIET_FOR;
        } },
      { label: 'Hide the donkey', run: () => this.app.setSetting('donkey', false) },
    ]);
  }

  // ------------------------------------------------------------ talking

  /**
   * Say `text` in the bubble. Things he says on his own (`force` false) wait
   * their turn and stay quiet in quiet mode; pokes and menu picks always talk.
   */
  say(text, { mood = 'neutral', force = false, hold = false } = {}) {
    if (!this.el || !text) return false;
    const now = Date.now();
    if (!force) {
      if (now < this.quietUntil || now - this.lastEventAt < EVENT_GAP) return false;
      this.lastEventAt = now;
    }
    this.setMood(mood);
    if (this.state && mood === 'happy' && !force) this.hopUp(5);
    if (this.state && mood === 'worried') this.state.shake = this.state.t;
    this.bubble.textContent = text;
    this.bubble.classList.add('on');
    const ms = hold ? 8000 : clamp(1800 + text.length * 45, 2800, 6500);
    this.talkingUntil = performance.now() + Math.min(1400, 300 + text.length * 30);
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.hush(), ms);
    return true;
  }

  hush() {
    if (this.bubble) this.bubble.classList.remove('on');
  }

  /** Something happened in the app: say the line for it, if there is one. */
  react(type, vars = {}) {
    if (!this.el) return false;
    const defaults = { branch: this.app.currentBranch || 'this branch', remote: 'origin' };
    return this.say(pickLine(type, { ...defaults, ...vars }), { mood: moodOf(type) });
  }

  onGit(call) {
    if (!this.el) return;
    const ev = eventForGit(call);
    if (!ev) return;
    this.lastInput = Date.now();
    this.react(ev.type, ev.vars);
  }

  checkIdle() {
    if (!this.el || this.idleSaid || document.hidden || !document.hasFocus()) return;
    if (Date.now() - this.lastInput > IDLE_AFTER) {
      this.idleSaid = true;
      if (this.state) this.state.yawn = this.state.t;
      this.react('idle');
    }
  }
}
