// Unified input: on-screen touch controls (virtual joystick + action buttons) and keyboard fallback.
// Game code only reads `axis`, `held(name)` and `pressed(name)`; `endFrame()` clears the edges.

export const ACTIONS = ['jump', 'climb', 'swim', 'attack', 'interact'];

const KEYS = {
  ArrowLeft: ['x', -1], KeyA: ['x', -1], KeyQ: ['x', -1],
  ArrowRight: ['x', 1], KeyD: ['x', 1],
  ArrowUp: ['y', -1], KeyW: ['y', -1], KeyZ: ['y', -1],
  ArrowDown: ['y', 1], KeyS: ['y', 1],
  Space: 'jump', KeyK: 'jump',
  ShiftLeft: 'climb', ShiftRight: 'climb', KeyL: 'climb',
  KeyN: 'swim', KeyI: 'swim',
  KeyJ: 'attack', KeyF: 'attack',
  KeyE: 'interact', Enter: 'interact',
};

export class Input {
  constructor() {
    this.axis = { x: 0, y: 0 };
    this._held = new Set();
    this._pressed = new Set();
    this._keyAxis = { x: 0, y: 0, keys: new Set() };
    this._stick = { x: 0, y: 0 };
    this._override = null;   // test hook
    this.touchUsed = false;
  }

  held(a) { return this._held.has(a); }
  pressed(a) { return this._pressed.has(a); }

  press(a) {
    if (!this._held.has(a)) this._pressed.add(a);
    this._held.add(a);
  }
  release(a) { this._held.delete(a); }

  /** Called once per simulation step after the game read the input. */
  endFrame() { this._pressed.clear(); }

  /** Called before each step: merges joystick and keyboard axes. */
  update() {
    if (this._override) { this.axis.x = this._override.x || 0; this.axis.y = this._override.y || 0; return; }
    const kx = this._keyAxis.x, ky = this._keyAxis.y;
    this.axis.x = Math.abs(this._stick.x) > Math.abs(kx) ? this._stick.x : kx;
    this.axis.y = Math.abs(this._stick.y) > Math.abs(ky) ? this._stick.y : ky;
  }

  /** Test hook: force an axis ({x, y}) or clear with null. */
  setAxis(v) { this._override = v; this.update(); }
  clear() { this._override = null; this._held.clear(); this._pressed.clear(); this._stick.x = this._stick.y = 0; this.update(); }

  // ---------------------------------------------------------------- keyboard
  attachKeyboard(target = window) {
    const recompute = () => {
      let x = 0, y = 0;
      for (const code of this._keyAxis.keys) {
        const m = KEYS[code];
        if (Array.isArray(m)) { if (m[0] === 'x') x += m[1]; else y += m[1]; }
      }
      this._keyAxis.x = Math.max(-1, Math.min(1, x));
      this._keyAxis.y = Math.max(-1, Math.min(1, y));
    };
    target.addEventListener('keydown', (e) => {
      const m = KEYS[e.code];
      if (!m) return;
      e.preventDefault();
      if (Array.isArray(m)) { this._keyAxis.keys.add(e.code); recompute(); } else if (!e.repeat) this.press(m);
    });
    target.addEventListener('keyup', (e) => {
      const m = KEYS[e.code];
      if (!m) return;
      if (Array.isArray(m)) { this._keyAxis.keys.delete(e.code); recompute(); } else this.release(m);
    });
    target.addEventListener('blur', () => { this._keyAxis.keys.clear(); recompute(); this._held.clear(); });
  }

  // ---------------------------------------------------------------- touch
  /**
   * zone: element receiving joystick touches (floating stick); base/knob: visuals;
   * buttons: elements with data-btn="<action>".
   */
  attachTouch({ zone, base, knob, buttons }) {
    const R = 44;
    let stickId = null, ox = 0, oy = 0;
    const setKnob = (dx, dy) => { knob.style.transform = `translate(${dx}px, ${dy}px)`; };
    const showBase = (x, y) => {
      base.style.left = `${x - R}px`;
      base.style.top = `${y - R}px`;
      base.classList.add('active');
    };

    zone.addEventListener('pointerdown', (e) => {
      if (stickId !== null) return;
      e.preventDefault();
      this.touchUsed = true;
      stickId = e.pointerId;
      zone.setPointerCapture?.(e.pointerId);
      ox = e.clientX; oy = e.clientY;
      showBase(ox, oy);
      setKnob(0, 0);
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== stickId) return;
      e.preventDefault();
      let dx = e.clientX - ox, dy = e.clientY - oy;
      const d = Math.hypot(dx, dy);
      if (d > R) {
        // drag the base along so reversing direction is immediate
        ox += (dx / d) * (d - R); oy += (dy / d) * (d - R);
        dx = e.clientX - ox; dy = e.clientY - oy;
        showBase(ox, oy);
      }
      setKnob(dx, dy);
      const nx = dx / R, ny = dy / R;
      const dead = 0.22;
      this._stick.x = Math.abs(nx) < dead ? 0 : Math.max(-1, Math.min(1, nx));
      this._stick.y = Math.abs(ny) < dead ? 0 : Math.max(-1, Math.min(1, ny));
    });
    const endStick = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      this._stick.x = this._stick.y = 0;
      base.classList.remove('active');
      base.style.left = base.style.top = '';
      setKnob(0, 0);
    };
    zone.addEventListener('pointerup', endStick);
    zone.addEventListener('pointercancel', endStick);

    for (const el of buttons) {
      const action = el.dataset.btn;
      const ids = new Set();
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.touchUsed = true;
        el.setPointerCapture?.(e.pointerId);
        ids.add(e.pointerId);
        el.classList.add('down');
        this.press(action);
      });
      const up = (e) => {
        if (!ids.delete(e.pointerId)) return;
        if (ids.size === 0) { el.classList.remove('down'); this.release(action); }
      };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
    }
  }
}
