// Unified input: keyboard, touch (virtual stick + buttons), gamepad and injection.
//
// API (DESIGN.md §12):
//   input.moveX / input.moveY  : -1..1 movement axes (dead zone applied)
//   input.aimX / input.aimY    : normalised aim vector, (0,0) when neutral
//   input.aimActive            : true when a direction is being held
//   input.pressed(a) / released(a) : edge flags, valid for exactly one fixed tick
//   input.held(a)              : current state
//   actions: 'jump' 'attack' 'grapple' 'interact' 'pause'
//   input.inject({ x, y, jump, attack, grapple, interact, pause }) / input.tap(a) / clearInjected()
//   menus (gamepad): input.navX / navY (stick / D-pad focus moves, with auto-repeat),
//   input.takePadBack() (B pressed); main.js hands them to ui.move() / ui.back()
//
// Edge semantics: DOM events latch presses/releases; beginTick() moves latched edges
// into the tick-visible set and endTick() clears it. When a frame runs zero fixed
// ticks the latch survives to the next frame; when a frame runs several ticks only
// the first one sees the edge. Nothing is lost or duplicated.
import { TOUCH } from './config.js';

export const ACTIONS = ['jump', 'attack', 'grapple', 'interact', 'pause'];

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  Space: 'jump', KeyZ: 'jump', KeyX: 'attack', KeyJ: 'attack',
  KeyC: 'grapple', KeyK: 'grapple', KeyE: 'interact',
  Escape: 'pause', KeyP: 'pause',
};
const DIRS = ['left', 'right', 'up', 'down'];

const BUTTON_DEFS = [
  { action: 'jump', label: 'Saut', icon: 'icon_jump' },
  { action: 'attack', label: 'Frapper', icon: 'icon_pick' },
  { action: 'grapple', label: 'Grappin', icon: 'icon_hook' },
];

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/** Apply a radial dead zone + rescale to a stick vector. */
export function shapeStick(x, y, deadZone = TOUCH.deadZone, fullTilt = TOUCH.fullTilt) {
  const mag = Math.hypot(x, y);
  if (mag < deadZone) return { x: 0, y: 0, mag: 0 };
  const m = clamp((mag - deadZone) / (fullTilt - deadZone), 0, 1);
  return { x: (x / mag) * m, y: (y / mag) * m, mag: m };
}

export class Input {
  constructor() {
    this.sources = { kb: {}, touch: {}, pad: {}, inject: {} };
    this.raw = {};
    this.latchP = {}; this.latchR = {};
    this.tickP = {}; this.tickR = {};
    for (const a of ACTIONS) { this.raw[a] = false; this.latchP[a] = this.latchR[a] = false; this.tickP[a] = this.tickR[a] = false; }
    this.kbDirs = { left: false, right: false, up: false, down: false };
    this.touchStick = { x: 0, y: 0, active: false };
    this.padStick = { x: 0, y: 0 };
    this.padConnected = false;
    // after resetAll() (state change) a pad button that is still held must be released
    // before it counts again: a held A / Start would otherwise re-press at once on the
    // next poll and confirm the menu that just opened (victory "Continuer (NG+)"...)
    this.padBlock = {};
    this.padBackHeld = false; this.padBackBlocked = false; this.padBackEdge = false;
    this.navX = 0; this.navY = 0;           // pending menu focus move (-1 / 0 / 1)
    this._navDX = 0; this._navDY = 0; this._navNext = 0;
    this.injectStick = { x: 0, y: 0, active: false };
    this.moveX = 0; this.moveY = 0;
    this.aimX = 0; this.aimY = 0; this.aimActive = false;
    this.lastSource = 'kb';
    this.pendingTapRelease = new Set();
    this.onAnyInput = null;      // callback (used to unlock audio)
    this.onKey = null;           // raw keydown hook (debug / mute)
    // touch UI state
    this.touches = new Map();    // identifier -> { kind: 'stick'|'button', btn }
    this.stickId = null;
    this.stickOrigin = { x: 0, y: 0 };
    this.stickKnob = { x: 0, y: 0 };
    this.buttons = [];
    this.controlsVisible = false;
    this.touchEnabled = false;
    this.contextLabel = null;
    this.el = null;
    this.safe = { l: 0, r: 0, t: 0, b: 0 };
  }

  // ------------------------------------------------------------ core state
  _setAction(source, action, down) {
    const src = this.sources[source];
    if (!!src[action] === down) return;
    src[action] = down;
    const was = this.raw[action];
    const now = !!(this.sources.kb[action] || this.sources.touch[action] || this.sources.pad[action] || this.sources.inject[action]);
    this.raw[action] = now;
    if (!was && now) this.latchP[action] = true;
    if (was && !now) this.latchR[action] = true;
    if (down) this.lastSource = source;
  }

  /** Call before each fixed update. */
  beginTick() {
    for (const a of ACTIONS) {
      this.tickP[a] = this.latchP[a];
      this.tickR[a] = this.latchR[a];
      this.latchP[a] = false;
      this.latchR[a] = false;
    }
    this._updateAxes();
  }

  /** Call after each fixed update. */
  endTick() {
    for (const a of ACTIONS) { this.tickP[a] = false; this.tickR[a] = false; }
    if (this.pendingTapRelease.size) {
      for (const a of this.pendingTapRelease) this._setAction('inject', a, false);
      this.pendingTapRelease.clear();
    }
  }

  pressed(a) { return this.tickP[a]; }
  released(a) { return this.tickR[a]; }
  held(a) { return this.raw[a] || this.tickP[a]; }

  /** Release everything (blur, state change). */
  resetAll() {
    if (this.padConnected) {
      for (const a of ACTIONS) this.padBlock[a] = true;
      this.padBackBlocked = true;
    }
    for (const s of Object.keys(this.sources)) for (const a of ACTIONS) this._setAction(s, a, false);
    for (const d of DIRS) this.kbDirs[d] = false;
    this.touchStick.active = false; this.touchStick.x = this.touchStick.y = 0;
    this.touches.clear(); this.stickId = null;
    this.injectStick.active = false;
    for (const b of this.buttons) b.el.classList.remove('down');
    this._renderStick();
    this._updateAxes();
  }

  _updateAxes() {
    // pick the stick source: injected > touch > gamepad > keyboard
    let sx = 0, sy = 0, active = false, analog = false;
    if (this.injectStick.active) { sx = this.injectStick.x; sy = this.injectStick.y; active = true; analog = true; }
    else if (this.touchStick.active) { sx = this.touchStick.x; sy = this.touchStick.y; active = true; analog = true; }
    else if (Math.hypot(this.padStick.x, this.padStick.y) > 0.25) { sx = this.padStick.x; sy = this.padStick.y; active = true; analog = true; }
    else {
      sx = (this.kbDirs.right ? 1 : 0) - (this.kbDirs.left ? 1 : 0);
      sy = (this.kbDirs.down ? 1 : 0) - (this.kbDirs.up ? 1 : 0);
      active = sx !== 0 || sy !== 0;
    }
    if (analog) {
      const s = shapeStick(sx, sy);
      // horizontal / vertical components get their own dead zone so pure up/down
      // aiming doesn't creep sideways
      const ax = Math.abs(sx) < TOUCH.deadZone ? 0 : clamp((Math.abs(sx) - TOUCH.deadZone) / (TOUCH.fullTilt - TOUCH.deadZone), 0, 1) * Math.sign(sx);
      const ay = Math.abs(sy) < TOUCH.deadZone ? 0 : clamp((Math.abs(sy) - TOUCH.deadZone) / (TOUCH.fullTilt - TOUCH.deadZone), 0, 1) * Math.sign(sy);
      this.moveX = ax; this.moveY = ay;
      if (s.mag > 0) {
        const m = Math.hypot(sx, sy);
        this.aimX = sx / m; this.aimY = sy / m; this.aimActive = true;
      } else { this.aimX = 0; this.aimY = 0; this.aimActive = false; }
    } else {
      this.moveX = sx; this.moveY = sy;
      if (active) { const m = Math.hypot(sx, sy); this.aimX = sx / m; this.aimY = sy / m; }
      else { this.aimX = 0; this.aimY = 0; }
      this.aimActive = active;
    }
  }

  // ------------------------------------------------------------ injection (tests / debug)
  /**
   * Programmatic input. `x`/`y` set a virtual stick (-1..1); pass `stick:false` or
   * omit both to release it. Booleans set action states (edges are generated).
   */
  inject(state = {}) {
    if ('x' in state || 'y' in state) {
      this.injectStick.x = state.x ?? 0;
      this.injectStick.y = state.y ?? 0;
      this.injectStick.active = state.stick !== false && (this.injectStick.x !== 0 || this.injectStick.y !== 0);
    }
    if (state.stick === false) this.injectStick.active = false;
    for (const a of ACTIONS) if (a in state) this._setAction('inject', a, !!state[a]);
    this._updateAxes();
  }

  /** Press an action for exactly one tick. */
  tap(action) {
    this._setAction('inject', action, true);
    this.pendingTapRelease.add(action);
  }

  clearInjected() {
    this.injectStick.active = false; this.injectStick.x = this.injectStick.y = 0;
    for (const a of ACTIONS) this._setAction('inject', a, false);
    this._updateAxes();
  }

  // ------------------------------------------------------------ keyboard
  /** A key typed into a text field (menu save-transfer code) is not a game key. */
  _typing(e) {
    const t = e.target, tag = t && t.tagName;
    return tag === 'TEXTAREA' || tag === 'INPUT';
  }

  _onKeyDown(e) {
    if (this._typing(e)) return;
    if (this.onKey) this.onKey(e);
    const m = KEYMAP[e.code];
    if (!m) return;
    e.preventDefault();
    if (this.onAnyInput) this.onAnyInput();
    // Directions are level-triggered: auto-repeat re-asserts a key that is still
    // held after resetAll() (pause / blur), so walking resumes without re-pressing.
    if (DIRS.includes(m)) {
      if (!this.kbDirs[m]) { this.kbDirs[m] = true; this.lastSource = 'kb'; this._updateAxes(); }
      return;
    }
    if (e.repeat) return; // actions are edge-triggered: never re-press on repeat
    this._setAction('kb', m, true);
  }

  _onKeyUp(e) {
    const m = KEYMAP[e.code];
    if (!m) return;
    if (this._typing(e) && !this.kbDirs[m] && !this.raw[m]) return;
    e.preventDefault();
    if (DIRS.includes(m)) { this.kbDirs[m] = false; this._updateAxes(); }
    else this._setAction('kb', m, false);
  }

  // ------------------------------------------------------------ gamepad (optional)
  poll() {
    const pads = typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : null;
    let pad = null;
    if (pads) for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) {
      // pad lost (Bluetooth drop, low battery): release its stick and buttons
      if (this.padConnected) this._releasePad();
      return;
    }
    this.padConnected = true;
    const b = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
    let x = pad.axes[0] || 0, y = pad.axes[1] || 0;
    if (b(14)) x = -1; if (b(15)) x = 1; if (b(12)) y = -1; if (b(13)) y = 1;
    this.padStick.x = x; this.padStick.y = y;
    this._padAction('jump', b(0));
    this._padAction('attack', b(2) || b(7));
    this._padAction('grapple', b(1) || b(5) || b(6));
    this._padAction('interact', b(3));
    this._padAction('pause', b(9));
    // menu back (B): edge, blocked like the actions while held through a state change
    const back = b(1);
    if (this.padBackBlocked) { if (!back) this.padBackBlocked = false; }
    else if (back && !this.padBackHeld) this.padBackEdge = true;
    this.padBackHeld = back;
    this._padNav(x, y);
    this._updateAxes();
  }

  _padAction(a, down) {
    if (this.padBlock[a]) {
      if (!down) this.padBlock[a] = false; // released: counts again from the next press
      down = false;
    }
    this._setAction('pad', a, down);
  }

  /** Stick / D-pad -> menu focus moves: one on push, then auto-repeat while held. */
  _padNav(x, y) {
    let dx = 0, dy = 0;
    if (Math.max(Math.abs(x), Math.abs(y)) > 0.5) {
      if (Math.abs(x) > Math.abs(y)) dx = x > 0 ? 1 : -1; else dy = y > 0 ? 1 : -1;
    }
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (dx !== this._navDX || dy !== this._navDY) {
      this._navDX = dx; this._navDY = dy;
      if (dx || dy) { this.navX = dx; this.navY = dy; this._navNext = t + 380; }
    } else if ((dx || dy) && t >= this._navNext) {
      this.navX = dx; this.navY = dy; this._navNext = t + 150;
    }
  }

  /** True once per press of the pad's B button (menus: back). */
  takePadBack() { const v = this.padBackEdge; this.padBackEdge = false; return v; }

  _releasePad() {
    this.padConnected = false;
    this.padStick.x = 0; this.padStick.y = 0;
    this.padBlock = {}; this.padBackHeld = false; this.padBackBlocked = false; this.padBackEdge = false;
    this._navDX = 0; this._navDY = 0; this.navX = 0; this.navY = 0;
    for (const a of ACTIONS) this._setAction('pad', a, false);
    this._updateAxes();
  }

  // ------------------------------------------------------------ DOM binding
  /**
   * Bind DOM events. `layer` receives touches (full-screen element under menus);
   * `controlsRoot` hosts the visual controls; `iconFactory(name, px)` returns a canvas.
   */
  attach({ layer, controlsRoot, iconFactory, keyTarget = window }) {
    this.el = layer;
    this.controlsRoot = controlsRoot;
    keyTarget.addEventListener('keydown', (e) => this._onKeyDown(e));
    keyTarget.addEventListener('keyup', (e) => this._onKeyUp(e));
    window.addEventListener('blur', () => this.resetAll());
    window.addEventListener('gamepaddisconnected', () => { if (this.padConnected) this._releasePad(); });
    const opts = { passive: false };
    layer.addEventListener('touchstart', (e) => this._onTouchStart(e), opts);
    layer.addEventListener('touchmove', (e) => this._onTouchMove(e), opts);
    layer.addEventListener('touchend', (e) => this._onTouchEnd(e), opts);
    layer.addEventListener('touchcancel', (e) => this._onTouchEnd(e), opts);
    this.touchEnabled = (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) || 'ontouchstart' in window;
    this._buildControls(iconFactory);
    this.layout();
  }

  _buildControls(iconFactory) {
    const root = this.controlsRoot;
    root.innerHTML = '';
    const mk = (cls, parent = root) => { const d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; };
    this.ghostEl = mk('stick-ghost');
    this.stickEl = mk('stick-base');
    this.knobEl = mk('stick-knob', this.stickEl);
    this.buttons = [];
    for (const def of BUTTON_DEFS) {
      const el = mk('tbtn tbtn-' + def.action);
      if (iconFactory) { const c = iconFactory(def.icon, 30); if (c) { c.className = 'tbtn-icon'; el.appendChild(c); } }
      const lab = document.createElement('span'); lab.textContent = def.label; el.appendChild(lab);
      this.buttons.push({ action: def.action, el, x: 0, y: 0, r: TOUCH.buttonSize / 2 });
    }
    const pause = mk('tbtn tbtn-pause');
    if (iconFactory) { const c = iconFactory('icon_pause', 18); if (c) { c.className = 'tbtn-icon'; pause.appendChild(c); } }
    this.buttons.push({ action: 'pause', el: pause, x: 0, y: 0, r: 20 });
    const ctx = mk('tbtn tbtn-ctx');
    const ctxLab = document.createElement('span'); ctx.appendChild(ctxLab);
    this.ctxBtn = { action: 'interact', el: ctx, label: ctxLab, x: 0, y: 0, r: 30, hidden: true };
    this.buttons.push(this.ctxBtn);
    this._applyVisibility();
  }

  /** Recompute control positions (call on resize). */
  layout() {
    if (!this.controlsRoot || typeof window === 'undefined') return;
    const W = window.innerWidth, H = window.innerHeight;
    const s = this.safe;
    const R = W - Math.max(s.r, 8), B = H - Math.max(s.b, 6);
    const size = TOUCH.buttonSize;
    const pos = {
      jump: [R - 50, B - 52],
      attack: [R - 50 - 88, B - 40],
      grapple: [R - 66, B - 52 - 86],
      pause: [R - 26, Math.max(s.t, 6) + 26],
    };
    for (const b of this.buttons) {
      if (b === this.ctxBtn) continue;
      const p = pos[b.action];
      b.x = p[0]; b.y = p[1];
      const d = b.action === 'pause' ? 40 : size;
      b.r = d / 2;
      Object.assign(b.el.style, { width: d + 'px', height: d + 'px', left: (b.x - d / 2) + 'px', top: (b.y - d / 2) + 'px' });
    }
    const c = this.ctxBtn;
    c.x = R - 50 - 88 - 20; c.y = B - 40 - 84;
    Object.assign(c.el.style, { left: (c.x - 46) + 'px', top: (c.y - 22) + 'px' });
    this.ghostPos = { x: Math.max(s.l, 12) + 96, y: B - 86 };
    this._renderStick();
  }

  setSafeArea(safe) { this.safe = safe; this.layout(); }

  /** CSS px from the bottom of the screen to the top of the Saut / Frapper buttons (0 before layout). */
  bottomBand() {
    if (typeof window === 'undefined' || !this.buttons.length) return 0;
    let top = Infinity;
    for (const b of this.buttons) if (b.action === 'jump' || b.action === 'attack') top = Math.min(top, b.y - b.r);
    return top === Infinity ? 0 : Math.max(0, window.innerHeight - top);
  }

  setControlsVisible(v) { this.controlsVisible = v; if (!v) this.resetAll(); this._applyVisibility(); }

  /** Contextual interact button ("Forge"...). Pass null to hide. */
  setContextAction(label) {
    if (label === this.contextLabel) return;
    this.contextLabel = label;
    if (this.ctxBtn) {
      this.ctxBtn.hidden = !label;
      this.ctxBtn.label.textContent = label || '';
      if (!label) { this._setAction('touch', 'interact', false); this.ctxBtn.el.classList.remove('down'); }
      this._applyVisibility();
    }
  }

  _applyVisibility() {
    if (!this.controlsRoot) return;
    const show = this.controlsVisible && this.touchEnabled;
    this.controlsRoot.style.display = show ? 'block' : 'none';
    if (this.ctxBtn) this.ctxBtn.el.style.display = this.ctxBtn.hidden ? 'none' : 'flex';
  }

  _hitButton(x, y) {
    let best = null, bestD = Infinity;
    for (const b of this.buttons) {
      if (b.hidden) continue;
      const d = Math.hypot(x - b.x, y - b.y);
      if (d <= b.r + TOUCH.buttonHitPad && d < bestD) { best = b; bestD = d; }
    }
    return best;
  }

  _onTouchStart(e) {
    e.preventDefault();
    if (!this.touchEnabled) { this.touchEnabled = true; this._applyVisibility(); }
    if (this.onAnyInput) this.onAnyInput();
    this.lastSource = 'touch';
    for (const t of e.changedTouches) {
      const x = t.clientX, y = t.clientY;
      const btn = this._hitButton(x, y);
      if (btn) {
        this.touches.set(t.identifier, { kind: 'button', btn });
        this._pressButton(btn, true);
      } else if (x < this._viewW() * 0.5 && this.stickId === null) {
        this._startStick(t.identifier, x, y);
      }
    }
    this._updateAxes();
  }

  _viewW() { return typeof window !== 'undefined' ? window.innerWidth : 0; }

  /** Floating stick appears under the thumb at (x, y). */
  _startStick(id, x, y) {
    this.stickId = id;
    this.touches.set(id, { kind: 'stick' });
    this.stickOrigin.x = x; this.stickOrigin.y = y;
    this.stickKnob.x = x; this.stickKnob.y = y;
    this.touchStick.active = true; this.touchStick.x = 0; this.touchStick.y = 0;
    this._renderStick();
  }

  _onTouchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      let rec = this.touches.get(t.identifier);
      const x = t.clientX, y = t.clientY;
      if (!rec) {
        // A thumb that stayed on the stick through resetAll() (pause, blur,
        // rotation) is unknown now: adopt it as a fresh stick instead of ignoring it.
        if (this.stickId !== null || !this.controlsVisible || x >= this._viewW() * 0.5) continue;
        this._startStick(t.identifier, x, y);
        continue;
      }
      if (rec.kind === 'stick') {
        const R = TOUCH.stickRadius;
        let dx = x - this.stickOrigin.x, dy = y - this.stickOrigin.y;
        const m = Math.hypot(dx, dy);
        if (m > R * 1.25) {
          // floating stick: drag the base along so reversing direction is instant
          const k = (m - R * 1.25) / m;
          this.stickOrigin.x += dx * k; this.stickOrigin.y += dy * k;
          dx = x - this.stickOrigin.x; dy = y - this.stickOrigin.y;
        }
        const mm = Math.hypot(dx, dy);
        const cl = mm > R ? R / mm : 1;
        this.stickKnob.x = this.stickOrigin.x + dx * cl;
        this.stickKnob.y = this.stickOrigin.y + dy * cl;
        this.touchStick.x = (dx * cl) / R;
        this.touchStick.y = (dy * cl) / R;
        this._renderStick();
      } else if (rec.kind === 'button') {
        // sliding onto another action button switches to it (jump <-> attack rolls)
        const btn = this._hitButton(x, y);
        if (btn && btn !== rec.btn && btn.action !== 'pause' && rec.btn.action !== 'pause') {
          // re-point the record first: _pressButton(old, false) keeps a button down
          // while any touch record still references it (including this one)
          const old = rec.btn;
          rec.btn = btn;
          this._pressButton(old, false);
          this._pressButton(btn, true);
        }
      }
    }
    this._updateAxes();
  }

  _onTouchEnd(e) {
    e.preventDefault();
    if (this.onAnyInput) this.onAnyInput(); // older iOS only unlocks audio on touchend
    for (const t of e.changedTouches) {
      const rec = this.touches.get(t.identifier);
      if (!rec) continue;
      this.touches.delete(t.identifier);
      if (rec.kind === 'stick') {
        this.stickId = null;
        this.touchStick.active = false; this.touchStick.x = 0; this.touchStick.y = 0;
        this._renderStick();
      } else if (rec.kind === 'button') {
        this._pressButton(rec.btn, false);
      }
    }
    this._updateAxes();
  }

  _pressButton(btn, down) {
    // several fingers may hold the same button: keep it down while any does
    if (!down) {
      for (const r of this.touches.values()) if (r.kind === 'button' && r.btn === btn) return;
    }
    this._setAction('touch', btn.action, down);
    btn.el.classList.toggle('down', down);
  }

  _renderStick() {
    if (!this.stickEl) return;
    const R = TOUCH.stickRadius;
    if (this.touchStick.active) {
      this.stickEl.style.display = 'block';
      this.ghostEl.style.display = 'none';
      this.stickEl.style.transform = `translate(${this.stickOrigin.x - R}px, ${this.stickOrigin.y - R}px)`;
      const kx = this.stickKnob.x - this.stickOrigin.x, ky = this.stickKnob.y - this.stickOrigin.y;
      this.knobEl.style.transform = `translate(${kx}px, ${ky}px)`;
    } else {
      this.stickEl.style.display = 'none';
      this.ghostEl.style.display = 'block';
      if (this.ghostPos) this.ghostEl.style.transform = `translate(${this.ghostPos.x - R}px, ${this.ghostPos.y - R}px)`;
    }
  }

  /** Where each on-screen button is (CSS px), for tests. */
  getLayout() {
    const out = {};
    for (const b of this.buttons) out[b.action] = { x: b.x, y: b.y, r: b.r, hidden: !!b.hidden };
    out.stickGhost = this.ghostPos;
    return out;
  }
}

export function createInput() { return new Input(); }
