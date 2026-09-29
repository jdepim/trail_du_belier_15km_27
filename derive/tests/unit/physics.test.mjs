import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveCircle, raycast, collideCircles, gravityAt, heatAt, distToSegment, MAX_STEP } from '../../src/physics.js';
import { PLAYER, SUNS, BLACK_HOLES, MOON, TILE } from '../../src/config.js';
import { UPGRADES } from '../../src/meta.js';
import { worldFrom, px, cachedGen, ORIGIN } from './helpers.mjs';

// a one-tile-thick vertical wall at column 20
const WALL = [];
for (let y = 0; y < 21; y++) WALL.push('.'.repeat(20) + '#' + '.'.repeat(20));

const body = (x, y, vx, vy, r = PLAYER.radius) => ({ x, y, vx, vy, r, restitution: PLAYER.restitution, friction: PLAYER.friction });

test('no tunnelling through a 1-tile wall, even at hardMaxSpeed and a huge dt', () => {
  const w = worldFrom(WALL);
  const wallX = (ORIGIN + 20) * TILE;
  for (const dt of [1 / 60, 1 / 30, 0.25]) {
    const b = body(wallX - 40, px(10), PLAYER.hardMaxSpeed, 0);
    let hit = false;
    for (let i = 0; i < 20; i++) { const r = moveCircle(b, dt, w); if (r.hit) hit = true; }
    assert.ok(hit, 'hit reported');
    assert.ok(b.x + b.r <= wallX + 1e-6, `stays left of the wall (dt ${dt}: x+r=${b.x + b.r})`);
  }
  assert.ok(MAX_STEP <= 3 && MAX_STEP < PLAYER.radius);
});

test('head-on bounce: restitution, impact speed and normal', () => {
  const w = worldFrom(WALL);
  const wallX = (ORIGIN + 20) * TILE;
  const b = body(wallX - PLAYER.radius - 2, px(10), 200, 0);
  const r = moveCircle(b, 1 / 60, w);
  assert.equal(r.hit, true);
  assert.ok(Math.abs(r.impact - 200) < 1e-6, `impact ${r.impact}`);
  assert.equal(r.nx, -1); assert.equal(r.ny, 0);
  assert.ok(Math.abs(b.vx + 200 * PLAYER.restitution) < 1e-6, `bounced to ${b.vx}`);
});

test('glancing hit keeps most tangential speed (light friction)', () => {
  const w = worldFrom(WALL);
  const wallX = (ORIGIN + 20) * TILE;
  const b = body(wallX - PLAYER.radius - 1, px(5), 100, 100);
  const r = moveCircle(b, 1 / 60, w);
  assert.ok(r.hit);
  assert.ok(Math.abs(r.impact - 100) < 1e-6);
  assert.ok(Math.abs(b.vy - 100 * (1 - PLAYER.friction)) < 1e-6, `tangential ${b.vy}`);
  assert.ok(b.vx < 0);
});

test('a still body touching a wall reports no impact; corners deflect smoothly', () => {
  const w = worldFrom(['..........', '.....#....', '..........']);
  const b = body((ORIGIN + 5) * TILE - PLAYER.radius, px(1), 0, 0);
  const r = moveCircle(b, 1 / 60, w);
  assert.equal(r.impact, 0);
  // diagonal onto the tile's top-left corner
  const c = body((ORIGIN + 5) * TILE - 8, (ORIGIN + 1) * TILE - 8, 80, 80);
  for (let i = 0; i < 30; i++) moveCircle(c, 1 / 60, w);
  assert.ok(!w.circleSolid(c.x, c.y, c.r - 0.01), 'never ends inside the tile');
});

test('raycast finds the first solid tile on a segment (allocation-free out)', () => {
  const w = worldFrom(WALL);
  const out = { x: 0, y: 0, tx: 0, ty: 0, t: 0 };
  assert.equal(raycast(w, px(5), px(10), px(35), px(10), out), true);
  assert.equal(out.tx, ORIGIN + 20);
  assert.ok(Math.abs(out.x - (ORIGIN + 20) * TILE) < 1e-6);
  assert.ok(out.t > 0 && out.t < 1);
  assert.equal(raycast(w, px(5), px(10), px(15), px(3)), false, 'segment ends before the wall');
  assert.equal(raycast(w, px(22), px(0), px(39), px(20)), false);
  assert.equal(raycast(w, px(5), px(1), px(35), px(19)), true, 'diagonal crossing');
});

test('collideCircles: equal masses exchange velocity, immovable bodies reflect', () => {
  const a = { x: 0, y: 0, vx: 100, vy: 0, r: 5, m: 1 }, b = { x: 9, y: 0, vx: 0, vy: 0, r: 5, m: 1 };
  const n = collideCircles(a, b, 1);
  assert.ok(Math.abs(n - 100) < 1e-6);
  assert.ok(Math.abs(a.vx) < 1e-6 && Math.abs(b.vx - 100) < 1e-6);
  assert.ok(b.x - a.x >= 10 - 1e-9, 'separated');
  const p = { x: 0, y: 0, vx: 50, vy: 0, r: 5, m: 1 }, wall = { x: 10, y: 0, vx: 0, vy: 0, r: 6, m: Infinity };
  collideCircles(p, wall, 0.5);
  assert.ok(Math.abs(p.vx + 25) < 1e-6);
  assert.equal(wall.x, 10);
  assert.equal(collideCircles({ x: 0, y: 0, vx: 0, vy: 0, r: 1 }, { x: 5, y: 0, vx: 0, vy: 0, r: 1 }, 1), -1);
  assert.ok(Math.abs(distToSegment(5, 5, 0, 0, 10, 0) - 5) < 1e-9);
});

test('gravity targets of DESIGN §6.1', () => {
  const gen = cachedGen(1);
  const g = { ax: 0, ay: 0, mag: 0, bh: 0 };
  const m = gen.blackHoles.find((b) => b.key === 'maelstrom');
  // Maelström: at 600 px the pull equals the base thrust (±5 %)
  gravityAt(m.x + 600, m.y, gen.gravitySources, g);
  assert.ok(Math.abs(g.mag / PLAYER.thrustAccel - 1) < 0.05, `600 px: ${g.mag}`);
  assert.ok(g.ax < 0, 'pulls toward the hole');
  // at the capsule: more than the fully upgraded thrust + the brake, unless anchored
  const up = { thrustAccel: PLAYER.thrustAccel, cruiseSpeed: 0 };
  UPGRADES.thrust.apply(up, UPGRADES.thrust.max);
  gravityAt(gen.capsule.x, gen.capsule.y, gen.gravitySources, g);
  assert.ok(g.mag > up.thrustAccel + PLAYER.brakeDecel, `capsule: ${g.mag} vs ${up.thrustAccel + PLAYER.brakeDecel}`);
  assert.ok(g.bh > 0 && Math.abs(g.bh - g.mag) < 1e-6, 'all of it comes from the black hole');
  gravityAt(gen.capsule.x, gen.capsule.y, gen.gravitySources, g, BLACK_HOLES.anchorMul);
  assert.ok(g.mag < PLAYER.thrustAccel, `anchored capsule: ${g.mag}`);
  // suns ~60 px/s² at 300 px, moon ~25 px/s² at the surface
  const s = gen.suns[0];
  gravityAt(s.x, s.y - 300, [gen.gravitySources.find((q) => q.key === s.key)], g);
  assert.ok(Math.abs(g.mag - 60) < 3, `sun 300 px: ${g.mag}`);
  const moonSrc = [gen.gravitySources.find((q) => q.key === 'selene')];
  gravityAt(gen.moon.x + MOON.r, gen.moon.y, moonSrc, g);
  assert.ok(Math.abs(g.mag - 25) < 1.5, `moon surface: ${g.mag}`);
  // linear inside the body, nothing beyond the influence radius
  gravityAt(gen.moon.x + MOON.r / 2, gen.moon.y, moonSrc, g);
  assert.ok(Math.abs(g.mag - 12.5) < 1, `half radius: ${g.mag}`);
  gravityAt(gen.moon.x + MOON.influence + 1, gen.moon.y, moonSrc, g);
  assert.equal(g.mag, 0);
  // the sector centre is calm
  gravityAt(gen.spawn.x, gen.spawn.y, gen.gravitySources, g);
  assert.equal(g.mag, 0);
});

test('heat: zero beyond heatR, rising steeply toward the core', () => {
  const gen = cachedGen(1);
  const s = gen.suns[0];
  const one = [s];
  assert.equal(heatAt(s.x + SUNS.heatR + 1, s.y, one), 0);
  let prev = 0;
  for (let d = SUNS.heatR - 20; d >= SUNS.coreR; d -= 40) {
    const h = heatAt(s.x, s.y + d, one);
    assert.ok(h > prev, `increases toward the core (${d} px: ${h})`);
    prev = h;
  }
  assert.ok(Math.abs(heatAt(s.x + SUNS.coreR, s.y, one) - SUNS.heatMax) < 1e-6, 'heatMax at the core surface');
  assert.ok(heatAt(s.x, s.y - SUNS.heatR * 0.9, one) < 12, 'the outer rim is only a warning');
});
