import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveAndCollide, raycast, touchingBelow } from '../../src/physics.js';
import { worldFrom, boxWorld } from './helpers.mjs';

const T = 16;
const body = (x, y, vx = 0, vy = 0, w = 10, h = 22) => ({ x, y, w, h, vx, vy });

test('falling body lands exactly on the floor', () => {
  const world = boxWorld(10, 10); // floor top at y = 9*16 = 144
  const b = body(40, 60, 0, 0);
  let res;
  for (let i = 0; i < 120; i++) { b.vy = Math.min(380, b.vy + 950 / 60); res = moveAndCollide(b, 1 / 60, world); }
  assert.equal(b.y + b.h, 144);
  assert.equal(b.vy, 0);
  assert.equal(res.onGround, true);
  assert.equal(touchingBelow(b, world), true);
});

test('walls stop horizontal movement and report the side', () => {
  const world = boxWorld(10, 10);
  const b = body(40, 100, 300, 0);
  let res;
  for (let i = 0; i < 60; i++) { b.vx = 300; res = moveAndCollide(b, 1 / 60, world); }
  assert.equal(b.x + b.w, 9 * T);
  assert.equal(res.hitRight, true);
  assert.equal(b.vx, 0, 'velocity zeroed on impact');
  for (let i = 0; i < 60; i++) { b.vx = -300; res = moveAndCollide(b, 1 / 60, world); }
  assert.equal(b.x, T);
  assert.equal(res.hitLeft, true);
});

test('no tunnelling through a one-tile wall at extreme speed', () => {
  const world = worldFrom([
    '##########',
    '#...#....#',
    '#...#....#',
    '#...#....#',
    '##########',
  ]);
  const b = body(20, 20, 20000, 0, 10, 20);
  const res = moveAndCollide(b, 1 / 60, world); // would move 333 px in one step
  assert.equal(res.hitRight, true);
  assert.equal(b.x + b.w, 4 * T, 'stopped at the thin wall');
  const f = body(100, 17, 0, 50000, 10, 12);
  const r2 = moveAndCollide(f, 1 / 60, world);
  assert.equal(r2.onGround, true);
  assert.equal(f.y + f.h, 4 * T, 'stopped on the one-tile floor');
});

test('ceiling hit zeroes upward speed', () => {
  const world = boxWorld(10, 10);
  const b = body(40, 40, 0, -400);
  let res;
  for (let i = 0; i < 10 && !res?.hitCeiling; i++) res = moveAndCollide(b, 1 / 60, world);
  assert.equal(res.hitCeiling, true);
  assert.equal(b.y, T);
  assert.equal(b.vy, 0);
});

test('ceiling corner correction slides a rising body past a corner (<= 4 px)', () => {
  const world = worldFrom([
    '##########',
    '#...#....#',
    '#........#',
    '#........#',
    '#........#',
    '##########',
  ]);
  // body right edge overlaps the solid tile (4,1) by 3 px
  // x = 57 -> spans 57..67, clips the solid tile (x 64..80) by 3 px
  const b = { ...body(57, 50, 0, -300), cornerCorrection: 4 };
  for (let i = 0; i < 20; i++) moveAndCollide(b, 1 / 60, world);
  assert.ok(b.y < T + 1, 'kept rising into the gap');
  assert.ok(b.x + b.w <= 4 * T, 'shifted left of the corner');
  // without correction the same body bonks
  const c = body(57, 50, 0, -300);
  let res;
  for (let i = 0; i < 20 && !res?.hitCeiling; i++) res = moveAndCollide(c, 1 / 60, world);
  assert.equal(res.hitCeiling, true);
});

test('raycast returns the first solid tile and the hit point', () => {
  const world = boxWorld(10, 10);
  const hit = raycast(world, 40, 40, 1, 0, 500);
  assert.equal(hit.tx, 9); assert.equal(hit.ty, 2);
  assert.equal(hit.x, 144); assert.equal(hit.dist, 104);
  assert.equal(hit.nx, -1);
  assert.equal(raycast(world, 40, 40, 1, 0, 50), null, 'out of range');
  const up = raycast(world, 40, 40, 0, -1, 500);
  assert.equal(up.ty, 0); assert.equal(up.y, 16);
  const diag = raycast(world, 40, 40, 1, 1, 1000);
  assert.ok(diag.tx === 9 || diag.ty === 9);
});
