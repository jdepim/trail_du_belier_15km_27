// Regressions for camera snapping, dynamic lights and audio resume (no DOM needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../../src/render.js';
import { Lighting } from '../../src/lighting.js';
import { AudioSystem } from '../../src/audio.js';
import { TILE, LIGHT } from '../../src/config.js';
import { boxWorld, fakeGame } from './helpers.mjs';

test('camera anchored to the player keeps the hero on one screen column while both move', () => {
  const game = fakeGame(boxWorld(80, 20));
  const cam = new Camera(game);
  const out = { x: 0, y: 0 };
  const cols = new Set();
  let px = 100.3;
  for (let f = 0; f < 240; f++) {
    // player and camera move together (steady follow) with different sub-pixel phases
    px += 95 / 120;
    cam.prevX = cam.x; cam.x = px - 180.77; cam.prevY = cam.y = 50.4;
    cam.renderPos(1, out, px, 80.2);
    cols.add(Math.round(px) - out.x);
  }
  assert.equal(cols.size, 1, `hero screen x values: ${[...cols]}`);
  // a camera resting on a whole-pixel bound stays exactly there while the anchor moves
  cam.prevX = cam.x = 0;
  const xs = new Set();
  for (let f = 0; f < 50; f++) xs.add(cam.renderPos(1, out, 37.1 + f * 0.37, 80).x);
  assert.deepEqual([...xs], [0]);
  // without an anchor it is a plain rounded position (shake included)
  cam.prevX = cam.x = 10.4; cam.shakeX = 1.3;
  assert.equal(cam.renderPos(1, out).x, 12);
});

test('dynamic lights survive render frames without a fixed tick until clearDynamic()', () => {
  const game = fakeGame(boxWorld(40, 30));
  game.player.reset(3 * TILE, 28 * TILE);
  game.player.stats.lanternRadius = 1;
  const L = new Lighting(game);
  const lx = 30 * TILE + 8, ly = 10 * TILE + 8;
  const at = () => { const i = 30 - L.tx0, j = 10 - L.ty0; return L.L[j * L.w + i]; };
  L.clearDynamic();
  L.addLight(lx, ly, 1, [255, 40, 40]);
  for (let frame = 0; frame < 3; frame++) { L.compute(0, 0, 40 * TILE, 30 * TILE); assert.equal(at(), 1, `frame ${frame}`); }
  L.clearDynamic();
  L.compute(0, 0, 40 * TILE, 30 * TILE);
  assert.ok(at() < 0.5, 'gone after the next tick rebuilt the list without it');
  // pooled: re-adding does not grow the pool
  for (let t = 0; t < 10; t++) { L.clearDynamic(); L.addLight(lx, ly, 0.8); L.addLight(lx, ly + 16, 0.8); }
  assert.equal(L.dynamic.length, 2);
  assert.equal(L.dynamicCount, 2);
  assert.ok(LIGHT.margin > 0);
});

test('audio resumes from WebKit\'s "interrupted" state and swallows resume() rejections', async () => {
  const a = new AudioSystem();
  let calls = 0;
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const state of ['interrupted', 'suspended']) {
      a.ctx = { state, resume() { calls++; return Promise.reject(new Error('not allowed')); } };
      a.resume();
    }
    a.ctx = { state: 'running', resume() { calls++; return Promise.resolve(); } };
    a.resume();
    a.ctx = { state: 'closed', resume() { calls++; return Promise.resolve(); } };
    a.resume();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(calls, 2, 'resume() only for interrupted / suspended');
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
