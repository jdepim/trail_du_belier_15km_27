import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Input, shapeStick } from '../../src/input.js';

test('a press survives frames with zero fixed ticks and is seen by exactly one tick', () => {
  const inp = new Input();
  inp._setAction('kb', 'jump', true);   // key down between ticks
  // frame 1: zero fixed updates -> nothing consumed
  // frame 2: three fixed updates
  const seen = [];
  for (let i = 0; i < 3; i++) { inp.beginTick(); seen.push(inp.pressed('jump')); inp.endTick(); }
  assert.deepEqual(seen, [true, false, false]);
  assert.equal(inp.held('jump'), true);
  inp._setAction('kb', 'jump', false);
  inp.beginTick();
  assert.equal(inp.released('jump'), true);
  assert.equal(inp.held('jump'), false);
  inp.endTick();
  inp.beginTick();
  assert.equal(inp.released('jump'), false);
  inp.endTick();
});

test('a tap shorter than a tick still produces a press (and held during that tick)', () => {
  const inp = new Input();
  inp._setAction('touch', 'attack', true);
  inp._setAction('touch', 'attack', false);
  inp.beginTick();
  assert.equal(inp.pressed('attack'), true);
  assert.equal(inp.held('attack'), true);
  assert.equal(inp.released('attack'), true);
  inp.endTick();
});

test('sources are OR-ed: releasing one source keeps the action held', () => {
  const inp = new Input();
  inp._setAction('kb', 'grapple', true);
  inp._setAction('touch', 'grapple', true);
  inp._setAction('kb', 'grapple', false);
  inp.beginTick();
  assert.equal(inp.held('grapple'), true);
  assert.equal(inp.pressed('grapple'), true);
  assert.equal(inp.released('grapple'), false);
  inp.endTick();
});

test('inject() and tap() drive axes and actions', () => {
  const inp = new Input();
  inp.inject({ x: 1, y: 0 });
  inp.beginTick();
  assert.equal(inp.moveX, 1); assert.equal(inp.aimActive, true);
  inp.endTick();
  inp.inject({ x: 0.1, y: 0.1 }); // inside the dead zone
  inp.beginTick();
  assert.equal(inp.moveX, 0); assert.equal(inp.aimActive, false);
  inp.endTick();
  inp.tap('jump');
  inp.beginTick(); assert.equal(inp.pressed('jump'), true); inp.endTick();
  inp.beginTick(); assert.equal(inp.held('jump'), false); assert.equal(inp.released('jump'), true); inp.endTick();
  inp.inject({ x: 0, y: -1 });
  inp.beginTick();
  assert.equal(inp.moveX, 0, 'pure up does not walk');
  assert.equal(inp.aimY, -1);
  inp.endTick();
  inp.clearInjected();
  inp.beginTick(); assert.equal(inp.aimActive, false); inp.endTick();
});

test('stick shaping applies the dead zone and full tilt', () => {
  assert.deepEqual(shapeStick(0.1, 0), { x: 0, y: 0, mag: 0 });
  const s = shapeStick(0.8, 0);
  assert.equal(s.mag, 1); assert.equal(s.x, 1);
  const h = shapeStick(0.41, 0);
  assert.ok(h.mag > 0.4 && h.mag < 0.6);
});

// ---------------------------------------------------------------- regressions (review fixes)

/** Input with three fake on-screen buttons (no DOM): jump at x=100, attack at x=200, grapple at x=300. */
function touchInput() {
  const inp = new Input();
  const mkEl = () => { const set = new Set(); return { classList: { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), remove: (c) => set.delete(c), contains: (c) => set.has(c) } }; };
  inp.buttons = ['jump', 'attack', 'grapple'].map((action, i) => ({ action, el: mkEl(), x: 100 * (i + 1), y: 100, r: 30 }));
  inp.controlsVisible = true;
  const ev = (...pts) => ({ preventDefault() {}, changedTouches: pts.map(([id, x, y]) => ({ identifier: id, clientX: x, clientY: y })) });
  return { inp, ev, btn: (a) => inp.buttons.find((b) => b.action === a) };
}

test('sliding a finger from one button to another and lifting releases both', () => {
  for (const [from, to] of [['jump', 'attack'], ['attack', 'jump']]) {
    const { inp, ev, btn } = touchInput();
    const a = btn(from), b = btn(to);
    inp._onTouchStart(ev([1, a.x, a.y]));
    assert.equal(inp.raw[from], true);
    inp._onTouchMove(ev([1, b.x, b.y]));
    assert.equal(inp.raw[from], false, `${from} released when the finger leaves it`);
    assert.equal(inp.raw[to], true, `${to} pressed`);
    assert.equal(a.el.classList.contains('down'), false);
    inp._onTouchMove(ev([1, a.x, a.y])); // and back
    assert.equal(inp.raw[to], false);
    assert.equal(inp.raw[from], true);
    inp._onTouchEnd(ev([1, a.x, a.y]));
    for (const k of ['jump', 'attack', 'grapple']) assert.equal(inp.raw[k], false, `${k} up after touchend`);
    assert.ok(inp.buttons.every((x) => !x.el.classList.contains('down')), 'no button stuck down');
    assert.equal(inp.touches.size, 0);
  }
  // a second finger still holding the old button keeps it down
  const { inp, ev, btn } = touchInput();
  inp._onTouchStart(ev([1, btn('jump').x, 100], [2, btn('jump').x + 5, 100]));
  inp._onTouchMove(ev([1, btn('attack').x, 100]));
  assert.equal(inp.raw.jump, true, 'other finger still on Saut');
  inp._onTouchEnd(ev([2, btn('jump').x + 5, 100]));
  assert.equal(inp.raw.jump, false);
});

test('a direction key still held after resetAll() comes back with its auto-repeat', () => {
  const inp = new Input();
  const key = (type, code, repeat = false) => inp[type === 'down' ? '_onKeyDown' : '_onKeyUp']({ code, repeat, preventDefault() {} });
  key('down', 'ArrowRight');
  inp.beginTick(); assert.equal(inp.moveX, 1); inp.endTick();
  inp.resetAll(); // pause / blur
  inp.beginTick(); assert.equal(inp.moveX, 0); inp.endTick();
  key('down', 'ArrowRight', true); // OS auto-repeat while still held
  inp.beginTick(); assert.equal(inp.moveX, 1, 'walking resumes'); inp.endTick();
  key('up', 'ArrowRight');
  inp.beginTick(); assert.equal(inp.moveX, 0); inp.endTick();
  // actions are never re-pressed by auto-repeat
  key('down', 'Space');
  inp.beginTick(); assert.equal(inp.pressed('jump'), true); inp.endTick();
  inp.resetAll();
  key('down', 'Space', true);
  inp.beginTick(); assert.equal(inp.pressed('jump'), false); assert.equal(inp.held('jump'), false); inp.endTick();
});

test('a thumb left on the stick through resetAll() is adopted by its next move', () => {
  const { inp, ev } = touchInput();
  const hadWindow = 'window' in globalThis;
  if (!hadWindow) globalThis.window = { innerWidth: 800 };
  try {
    inp._onTouchStart(ev([7, 50, 150]));
    inp._onTouchMove(ev([7, 90, 150]));
    inp.beginTick(); assert.equal(inp.moveX, 1); inp.endTick();
    inp.resetAll();
    inp.beginTick(); assert.equal(inp.moveX, 0); inp.endTick();
    inp._onTouchMove(ev([7, 92, 150])); // adopted: becomes the stick origin
    assert.equal(inp.stickId, 7);
    inp._onTouchMove(ev([7, 132, 150]));
    inp.beginTick(); assert.equal(inp.moveX, 1, 'walking again'); inp.endTick();
    inp._onTouchEnd(ev([7, 132, 150]));
    inp.beginTick(); assert.equal(inp.moveX, 0); inp.endTick();
  } finally {
    if (!hadWindow) delete globalThis.window;
  }
});

test('a gamepad that disconnects releases its stick and buttons', () => {
  const inp = new Input();
  const pad = { connected: true, axes: [1, 0], buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 2 })) };
  let pads = [pad];
  const nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { getGamepads: () => pads }, configurable: true });
  try {
    inp.poll();
    inp.beginTick(); assert.equal(inp.moveX, 1); assert.equal(inp.held('attack'), true); inp.endTick();
    pads = [null];
    inp.poll();
    inp.beginTick(); assert.equal(inp.moveX, 0, 'stick released'); assert.equal(inp.held('attack'), false, 'button released'); inp.endTick();
  } finally {
    if (nav) Object.defineProperty(globalThis, 'navigator', nav); else delete globalThis.navigator;
  }
});
