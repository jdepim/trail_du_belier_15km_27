// Unified input: keyboard, touch (floating thrust stick + round buttons), gamepad and injection.
// Adapted from Gouffre's input.js (same WebKit fixes, same edge protocol).
//
// API (DESIGN.md §8, §13):
//   input.moveX / input.moveY    thrust vector in the world, norm 0..1 (radial dead zone applied;
//                                keyboard diagonals are normalised to 1)
//   input.pressed(a) / released(a)  edge flags, valid for exactly one fixed tick
//   input.held(a)                current state
//   actions: 'boost' 'brake' 'action' 'charge' 'map' 'pause'
//   input.beginTick() / endTick()  around every fixed tick (main.js)
//   input.inject({ x, y, stick, boost, brake, action, charge, map, pause }) / tap(a) / clearInjected()
//   input.setContextAction(label | null)   contextual Action button (Ouvrir, Lire, Établi…)
//   input.setButtonVisible(action, bool)   Charge stays hidden until the Explosives are found
//   input.setControlsVisible(bool), setSafeArea({ l, r, t, b }), layout(), getLayout() (tests)
//   input.attach({ layer, controlsRoot, iconFactory })   bind DOM; iconFactory(name, cssPx) -> data URL
//   menus (gamepad): navX / navY (stick / D-pad focus moves with auto-repeat), takePadBack() (B)
//   hooks: onAnyInput() (audio unlock), onKey(e) (raw keydown, debug keys)
//
// Edge semantics: DOM events latch presses / releases; beginTick() moves the latched edges into
// the tick-visible set and endTick() clears it. A frame with zero fixed ticks keeps the latch for
// the next frame; a frame with several ticks shows the edge to the first one only.
// Keyboard: event.code is the physical key, so WASD on QWERTY and ZQSD on AZERTY are the same
// keys; letters whose label moves between layouts (M) also match event.key.
import { TOUCH } from './config.js';

export const ACTIONS = ['boost', 'brake', 'action', 'charge', 'map', 'pause'];

const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
  ShiftLeft: 'brake', ShiftRight: 'brake', KeyX: 'brake',
  Space: 'boost', KeyE: 'action', KeyC: 'charge',
  Tab: 'map', KeyM: 'map', Escape: 'pause', KeyP: 'pause',
};
/** Fallback by typed character (AZERTY puts M on the Semicolon key). */
const KEYCHAR = { m: 'map' };
const DIRS = ['left', 'right', 'up', 'down'];

const BUTTON_DEFS = [
  { action: 'boost', label: 'Boost', icon: 'boost', size: 'big' },
  { action: 'brake', label: 'Frein', icon: 'brake', size: 'big' },
  { action: 'charge', label: 'Charge', icon: 'charge', size: 'big', hidden: true },
  { action: 'map', label: 'Carte', icon: 'map', size: 'small' },
  { action: 'pause', label: 'Pause', icon: 'pause', size: 'small' },
];
const SMALL_BTN = 40;          // CSS px, top-right square buttons
const CTX_W = 108, CTX_H = 46; // CSS px, contextual Action pill

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

/** Radial dead zone + rescale of a stick vector into `out` ({ x, y, mag }, norm 0..1). */
export function shapeStick(x, y, out, deadZone = TOUCH.deadZone, fullTilt = TOUCH.fullTilt) {
  const mag = Math.hypot(x, y);
  if (mag < deadZone) { out.x = 0; out.y = 0; out.mag = 0; return out; }
  const m = clamp((mag - deadZone) / (fullTilt - deadZone), 0, 1);
  out.x = (x / mag) * m; out.y = (y / mag) * m; out.mag = m;
  return out;
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
    // after resetAll() (state change) a pad button still held must be released before it counts
    // again: a held A / Start would otherwise re-press at once and confirm the menu that just opened
    this.padBlock = {};
    this.padBackHeld = false; this.padBackBlocked = false; this.padBackEdge = false;
    this.navX = 0; this.navY = 0;
    this._navDX = 0; this._navDY = 0; this._navNext = 0;
    this.injectStick = { x: 0, y: 0, active: false };
    this._shaped = { x: 0, y: 0, mag: 0 };
    this.moveX = 0; this.moveY = 0;
    this.lastSource = 'kb';
    this.pendingTapRelease = new Set();
    this.onAnyInput = null;
    this.onKey = null;
    // touch UI
    this.touches = new Map();    // identifier -> { kind: 'stick' | 'button', btn }
    this.stickId = null;
    this.stickOrigin = { x: 0, y: 0 };
    this.stickKnob = { x: 0, y: 0 };
    this.buttons = [];
    this.ctxBtn = null;
    this.controlsVisible = false;
    this.touchEnabled = false;
    this.contextLabel = null;
    this.controlsRoot = null;
    this.ghostPos = null;
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

  beginTick() {
    for (const a of ACTIONS) {
      this.tickP[a] = this.latchP[a];
      this.tickR[a] = this.latchR[a];
      this.latchP[a] = false;
      this.latchR[a] = false;
    }
    this._updateAxes();
  }

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
    // stick source priority: injected > touch > gamepad > keyboard
    let sx = 0, sy = 0, analog = true;
    if (this.injectStick.active) { sx = this.injectStick.x; sy = this.injectStick.y; }
    else if (this.touchStick.active) { sx = this.touchStick.x; sy = this.touchStick.y; }
    else if (Math.hypot(this.padStick.x, this.padStick.y) > TOUCH.deadZone) { sx = this.padStick.x; sy = this.padStick.y; }
    else {
      analog = false;
      sx = (this.kbDirs.right ? 1 : 0) - (this.kbDirs.left ? 1 : 0);
      sy = (this.kbDirs.down ? 1 : 0) - (this.kbDirs.up ? 1 : 0);
    }
    if (analog) {
      const s = shapeStick(sx, sy, this._shaped);
      this.moveX = s.x; this.moveY = s.y;
    } else {
      const m = Math.hypot(sx, sy);
      this.moveX = m ? sx / m : 0; this.moveY = m ? sy / m : 0;
    }
  }

  // ------------------------------------------------------------ injection (tests / debug)
  /**
   * Programmatic input. `x` / `y` set a virtual stick (-1..1, same dead zone as touch); pass
   * `stick: false` (or both 0) to release it. Booleans set action states (edges are generated).
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
  /** A key typed into a text field (save transfer code) is not a game key. */
  _typing(e) {
    const t = e.target, tag = t && t.tagName;
    return tag === 'TEXTAREA' || tag === 'INPUT';
  }

  _map(e) { return KEYMAP[e.code] || (typeof e.key === 'string' ? KEYCHAR[e.key.toLowerCase()] : undefined); }

  _onKeyDown(e) {
    if (this._typing(e)) return;
    if (this.onKey) this.onKey(e);
    const m = this._map(e);
    if (!m) return;
    e.preventDefault();
    if (this.onAnyInput) this.onAnyInput();
    // directions are level-triggered: auto-repeat re-asserts a key still held after resetAll()
    // (pause / blur), so thrusting resumes without pressing it again
    if (DIRS.includes(m)) {
      if (!this.kbDirs[m]) { this.kbDirs[m] = true; this.lastSource = 'kb'; this._updateAxes(); }
      return;
    }
    if (e.repeat) return; // actions are edge-triggered: never re-press on auto-repeat
    this._setAction('kb', m, true);
  }

  _onKeyUp(e) {
    const m = this._map(e);
    if (!m) return;
    if (this._typing(e) && !this.kbDirs[m] && !this.raw[m]) return;
    e.preventDefault();
    if (DIRS.includes(m)) { this.kbDirs[m] = false; this._updateAxes(); }
    else this._setAction('kb', m, false);
  }

  // ------------------------------------------------------------ gamepad (standard mapping)
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
    this._padAction('boost', b(0));
    this._padAction('brake', b(1) || b(6));
    this._padAction('charge', b(2));
    this._padAction('action', b(3));
    this._padAction('map', b(8));
    this._padAction('pause', b(9));
    // menu back (B): an edge, blocked like the actions while held through a state change
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
   * Bind DOM events. `layer` receives touches (full-screen element under the menus);
   * `controlsRoot` hosts the visual controls; `iconFactory(name, cssPx)` returns an image URL.
   */
  attach({ layer, controlsRoot, iconFactory, keyTarget = window }) {
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
    root.replaceChildren();
    const mk = (cls, parent = root) => { const d = document.createElement('div'); d.className = cls; parent.appendChild(d); return d; };
    const addIcon = (el, name, px) => {
      const url = iconFactory ? iconFactory(name, px) : null;
      if (!url) return;
      const img = document.createElement('img');
      img.className = 'tbtn-icon'; img.alt = ''; img.draggable = false;
      img.width = px; img.height = px; img.src = url;
      el.appendChild(img);
    };
    this.ghostEl = mk('stick-ghost');
    this.stickEl = mk('stick-base');
    this.knobEl = mk('stick-knob', this.stickEl);
    this.buttons = [];
    for (const def of BUTTON_DEFS) {
      const el = mk(`tbtn tbtn-${def.action} tbtn-${def.size}`);
      addIcon(el, def.icon, def.size === 'big' ? 28 : 20);
      const lab = document.createElement('span'); lab.textContent = def.label; el.appendChild(lab);
      const d = def.size === 'big' ? TOUCH.buttonSize : SMALL_BTN;
      this.buttons.push({ action: def.action, el, x: 0, y: 0, r: d / 2, d, hidden: !!def.hidden });
    }
    const ctx = mk('tbtn tbtn-ctx');
    addIcon(ctx, 'action', 18);
    const ctxLab = document.createElement('span'); ctx.appendChild(ctxLab);
    this.ctxBtn = { action: 'action', el: ctx, label: ctxLab, x: 0, y: 0, r: CTX_H / 2, d: CTX_H, hidden: true };
    this.buttons.push(this.ctxBtn);
    this._applyVisibility();
  }

  /** Recompute control positions (call on resize). */
  layout() {
    if (!this.controlsRoot || typeof window === 'undefined') return;
    const W = window.innerWidth, H = window.innerHeight;
    const s = this.safe;
    const R = W - Math.max(s.r, 8), B = H - Math.max(s.b, 6), T = Math.max(s.t, 6);
    const pos = {
      boost: [R - 42, B - 46],
      brake: [R - 42 - 84, B - 34],
      charge: [R - 56, B - 46 - 80],
      map: [R - 20 - 52, T + 22],
      pause: [R - 20, T + 22],
    };
    for (const b of this.buttons) {
      if (b === this.ctxBtn) continue;
      const p = pos[b.action];
      b.x = p[0]; b.y = p[1];
      Object.assign(b.el.style, { width: b.d + 'px', height: b.d + 'px', left: (b.x - b.d / 2) + 'px', top: (b.y - b.d / 2) + 'px' });
    }
    const c = this.ctxBtn;
    c.x = R - 42 - 84 - 30; c.y = B - 34 - 78;
    Object.assign(c.el.style, { width: CTX_W + 'px', height: CTX_H + 'px', left: (c.x - CTX_W / 2) + 'px', top: (c.y - CTX_H / 2) + 'px' });
    this.ghostPos = { x: Math.max(s.l, 12) + 96, y: B - 86 };
    this._renderStick();
  }

  setSafeArea(safe) { this.safe = safe; this.layout(); }

  setControlsVisible(v) { this.controlsVisible = v; if (!v) this.resetAll(); this._applyVisibility(); }

  /** Contextual Action button ("Ouvrir", "Établi"…). Pass null to hide it. */
  setContextAction(label) {
    if (label === this.contextLabel) return;
    this.contextLabel = label;
    if (!this.ctxBtn) return;
    this.ctxBtn.hidden = !label;
    this.ctxBtn.label.textContent = label || '';
    if (!label) this._forceRelease(this.ctxBtn);
    this._applyVisibility();
  }

  /** Show / hide one of the round buttons (Charge until the Explosives are owned). */
  setButtonVisible(action, visible) {
    const b = this.buttons.find((x) => x.action === action && x !== this.ctxBtn);
    if (!b || b.hidden === !visible) return;
    b.hidden = !visible;
    if (!visible) this._forceRelease(b);
    this._applyVisibility();
  }

  /** A button that disappears under a finger: drop its touch records and release it. */
  _forceRelease(btn) {
    for (const [id, r] of this.touches) if (r.kind === 'button' && r.btn === btn) this.touches.delete(id);
    this._setAction('touch', btn.action, false);
    btn.el.classList.remove('down');
  }

  _applyVisibility() {
    if (!this.controlsRoot) return;
    const show = this.controlsVisible && this.touchEnabled;
    this.controlsRoot.style.display = show ? 'block' : 'none';
    for (const b of this.buttons) b.el.style.display = b.hidden ? 'none' : 'flex';
  }

  _hitButton(x, y) {
    let best = null, bestD = Infinity;
    for (const b of this.buttons) {
      if (b.hidden) continue;
      let d, pad;
      if (b === this.ctxBtn) {
        // pill: distance to its rectangle
        d = Math.hypot(Math.max(0, Math.abs(x - b.x) - CTX_W / 2), Math.max(0, Math.abs(y - b.y) - CTX_H / 2));
        pad = 8;
      } else {
        d = Math.max(0, Math.hypot(x - b.x, y - b.y) - b.r);
        pad = b.d === SMALL_BTN ? 8 : TOUCH.buttonHitPad;
      }
      if (d <= pad && d < bestD) { best = b; bestD = d; }
    }
    return best;
  }

  _viewW() { return typeof window !== 'undefined' ? window.innerWidth : 0; }

  _onTouchStart(e) {
    e.preventDefault();
    if (!this.touchEnabled) { this.touchEnabled = true; this._applyVisibility(); }
    if (this.onAnyInput) this.onAnyInput();
    this.lastSource = 'touch';
    for (const t of e.changedTouches) {
      const x = t.clientX, y = t.clientY;
      const btn = this.controlsVisible ? this._hitButton(x, y) : null;
      if (btn) {
        this.touches.set(t.identifier, { kind: 'button', btn });
        this._pressButton(btn, true);
      } else if (x < this._viewW() * 0.5 && this.stickId === null) {
        this._startStick(t.identifier, x, y);
      }
    }
    this._updateAxes();
  }

  /** The floating stick appears under the thumb at (x, y). */
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
      const rec = this.touches.get(t.identifier);
      const x = t.clientX, y = t.clientY;
      if (!rec) {
        // a thumb that stayed on the stick through resetAll() (pause, blur, rotation) is unknown
        // now: adopt it as a fresh stick instead of ignoring it
        if (this.stickId !== null || !this.controlsVisible || x >= this._viewW() * 0.5) continue;
        this._startStick(t.identifier, x, y);
        continue;
      }
      if (rec.kind === 'stick') {
        const R = TOUCH.stickRadius;
        let dx = x - this.stickOrigin.x, dy = y - this.stickOrigin.y;
        const m = Math.hypot(dx, dy);
        if (m > R * 1.25) {
          // floating stick: drag the base along so reversing the thrust is instant
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
        // sliding onto another round button switches to it (Frein <-> Boost); never onto or off
        // the menu buttons (Carte, Pause)
        const btn = this._hitButton(x, y);
        const menu = (b) => b.action === 'pause' || b.action === 'map';
        if (btn && btn !== rec.btn && !menu(btn) && !menu(rec.btn)) {
          // re-point the record first: _pressButton(old, false) keeps a button down while any
          // touch record still references it (this one included)
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
      } else {
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

  /** Where each on-screen control is (CSS px), for the tests. */
  getLayout() {
    const out = {};
    for (const b of this.buttons) out[b.action] = { x: b.x, y: b.y, r: b.r, hidden: !!b.hidden };
    out.stickGhost = this.ghostPos ? { x: this.ghostPos.x, y: this.ghostPos.y } : null;
    return out;
  }
}

export function createInput() { return new Input(); }
