import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ropeConstrainVelocity, ropeCorrection, aimAssist } from '../../src/grapple.js';
import { TILE_ID } from '../../src/tiles.js';
import { GRAPPLE } from '../../src/config.js';
import { worldFrom, boxWorld, fakeGame, tick } from './helpers.mjs';

const T = 16;

test('velocity projection removes only the outward radial component', () => {
  // player straight below the anchor, taut rope
  const out = ropeConstrainVelocity(50, 200, 0, 100, 0, 0, 100);
  assert.equal(out.vx, 50); assert.equal(out.vy, 0);
  const inward = ropeConstrainVelocity(0, -80, 0, 100, 0, 0, 100);
  assert.equal(inward.vy, -80, 'moving toward the anchor is free');
  const slack = ropeConstrainVelocity(0, 200, 0, 50, 0, 0, 100);
  assert.equal(slack.vy, 200, 'slack rope does not constrain');
});

test('positional correction brings the point back onto the circle', () => {
  const c = ropeCorrection(30, 40, 0, 0, 25); // dist 50
  assert.ok(Math.abs(Math.hypot(30 + c.dx, 40 + c.dy) - 25) < 1e-9);
  const none = ropeCorrection(3, 4, 0, 0, 25);
  assert.equal(none.dx, 0); assert.equal(none.dy, 0);
});

test('aim assist finds a target a few degrees off and prefers the smallest offset', () => {
  const rows = Array.from({ length: 20 }, () => '.'.repeat(30));
  const world = worldFrom(rows);
  // a single block up-right of the origin at ~ -60° (screen space)
  const ox = 5 * T, oy = 15 * T;
  world.set(8, 10, TILE_ID.STONE);
  const want = -70 * Math.PI / 180;
  const r = aimAssist(world, ox, oy, want, 120);
  assert.ok(r.hit, 'assisted hit');
  assert.equal(r.hit.tx, 8); assert.equal(r.hit.ty, 10);
  assert.notEqual(r.angle, want);
  const miss = aimAssist(world, ox, oy, Math.PI, 60); // 80 px from the world edge
  assert.equal(miss.hit, null);
});

function grappleWorld() {
  // big room with a ceiling
  const rows = [];
  for (let y = 0; y < 24; y++) {
    let r = '';
    for (let x = 0; x < 40; x++) r += x === 0 || x === 39 || y === 0 || y === 23 ? '#' : '.';
    rows.push(r);
  }
  return worldFrom(rows);
}

test('hook flies, attaches to the ceiling, and the pendulum stays on the rope without gaining energy', () => {
  const game = fakeGame(grappleWorld());
  const p = game.player;
  p.stats.grappleRange = 200;
  p.reset(20 * T, 10 * T); // hanging in the air, 9 tiles below the ceiling
  game.input.inject({ x: 0.6, y: -0.8 });
  game.input.tap('grapple');
  tick(game, 1);
  game.input.clearInjected();
  assert.equal(p.grapple.state, 'flying');
  for (let i = 0; i < 40 && p.grapple.state === 'flying'; i++) tick(game, 1);
  assert.equal(p.grapple.state, 'attached');
  assert.equal(p.grapple.anchorTy, 0, 'hooked into the ceiling');
  const L = p.grapple.length;
  let maxOver = 0;
  const early = [Infinity, -Infinity], late = [Infinity, -Infinity];
  for (let i = 0; i < 900; i++) {
    tick(game, 1);
    const d = Math.hypot(p.grapple.originX() - p.grapple.anchorX, p.grapple.originY() - p.grapple.anchorY);
    maxOver = Math.max(maxOver, d - p.grapple.length);
    assert.equal(game.world.rectSolid(p.x, p.y, p.w, p.h), false, 'never inside walls');
    const r = i < 240 ? early : i > 660 ? late : null;
    if (r) { r[0] = Math.min(r[0], p.x); r[1] = Math.max(r[1], p.x); }
  }
  assert.ok(maxOver < 1.0, `rope stretch ${maxOver}`);
  assert.ok(late[1] - late[0] < early[1] - early[0], 'swing amplitude decays slowly (no energy gain)');
  assert.ok(late[1] - late[0] > 40, 'but the pendulum keeps swinging');
  assert.ok(Math.abs(p.grapple.length - L) < 1e-6, 'length unchanged without reel input');
});

test('reel in shortens the rope and lifts the player; jump releases with a boost', () => {
  const game = fakeGame(boxWorld(30, 14)); // ceiling 12 tiles above the floor
  const p = game.player;
  p.stats.grappleRange = 220;
  p.reset(15 * T, 13 * T); // standing on the floor
  tick(game, 2);
  game.input.inject({ x: 0, y: -1 }); // aim straight up
  game.input.tap('grapple');
  for (let i = 0; i < 40 && p.grapple.state !== 'attached'; i++) tick(game, 1);
  assert.equal(p.grapple.state, 'attached');
  const y0 = p.y, len0 = p.grapple.length;
  tick(game, 60); // holding up = reel in for 1 s
  assert.ok(p.grapple.length < len0 - 100, `reeled ${len0} -> ${p.grapple.length}`);
  assert.ok(p.y < y0 - 90, 'player lifted');
  game.input.inject({ x: 0, y: 0, stick: false });
  game.input.tap('jump');
  tick(game, 1);
  assert.equal(p.grapple.state, 'retracting');
  assert.ok(p.vy <= -GRAPPLE.releaseBoost + 1, 'upward release boost');
});

test('destroying the anchor tile releases the grapple', () => {
  const game = fakeGame(grappleWorld());
  const p = game.player;
  p.stats.grappleRange = 220;
  p.reset(20 * T, 12 * T);
  game.input.inject({ x: 0, y: -1 });
  game.input.tap('grapple');
  for (let i = 0; i < 40 && p.grapple.state !== 'attached'; i++) tick(game, 1);
  game.input.clearInjected();
  assert.equal(p.grapple.state, 'attached');
  game.world.set(p.grapple.anchorTx, p.grapple.anchorTy, TILE_ID.AIR);
  tick(game, 1);
  assert.equal(p.grapple.state, 'retracting');
});

test('a hook that hits nothing comes back; neutral aim goes up and forward', () => {
  const game = fakeGame(boxWorld(60, 60));
  const p = game.player;
  p.reset(30 * T, 50 * T);
  tick(game, 2);
  p.facing = 1;
  game.input.tap('grapple');
  tick(game, 1);
  assert.equal(p.grapple.state, 'flying');
  assert.ok(p.grapple.dirX > 0.25 && p.grapple.dirY < -0.85, 'neutral aim ~70° up, forward');
  for (let i = 0; i < 120 && p.grapple.state !== 'idle'; i++) tick(game, 1);
  assert.equal(p.grapple.state, 'idle');
});

// ---------------------------------------------------------------- regressions (review fixes)

/** Player falling at `fall` px/s, 90 px under the ceiling of a tall box, grapples straight up. */
function fallingCatch(fall, reel) {
  const game = fakeGame(boxWorld(20, 60));
  const p = game.player;
  const oy = T + 90; // rope origin 90 px under the ceiling face (y = 16)
  p.reset(10 * T + 8, oy - GRAPPLE.originOffsetY + p.h);
  p.vy = fall;
  game.input.inject({ x: 0, y: -1 });
  game.input.tap('grapple');
  tick(game, 1);
  if (!reel) game.input.clearInjected(); // stick released right after firing
  let worstUp = 0, attachLen = 0, vyAfterAttach = null, stretch = 0;
  for (let i = 0; i < 30; i++) {
    const y0 = p.y, was = p.grapple.state;
    tick(game, 1);
    if (was === 'attached') worstUp = Math.min(worstUp, p.y - y0);
    if (was !== 'attached' && p.grapple.state === 'attached') {
      attachLen = p.grapple.length;
      stretch = Math.hypot(p.grapple.originX() - p.grapple.anchorX, p.grapple.originY() - p.grapple.anchorY) - attachLen;
    } else if (was === 'attached' && vyAfterAttach === null) vyAfterAttach = p.vy;
  }
  return { game, p, worstUp, attachLen, vyAfterAttach, stretch };
}

test('catching a fall with the grapple never teleports or flings the player', () => {
  for (const fall of [150, 250, 380]) {
    const r = fallingCatch(fall, false);
    assert.equal(r.p.grapple.state, 'attached', `attached (fall ${fall})`);
    assert.ok(r.attachLen > GRAPPLE.range, `rope takes the real distance (${r.attachLen.toFixed(1)} px)`);
    assert.ok(r.stretch < 0.5, 'rope is not over-stretched at attach');
    assert.ok(r.worstUp > -1, `no upward yank without reeling (fall ${fall}: ${r.worstUp.toFixed(1)} px)`);
    assert.ok(r.vyAfterAttach > -20, `no upward launch (vy ${r.vyAfterAttach.toFixed(1)})`);
  }
  // holding up reels at the reel speed, not faster
  const r = fallingCatch(380, true);
  const maxStep = (GRAPPLE.reelSpeed * 1.6) / 60 + 0.5;
  assert.ok(r.worstUp > -maxStep, `reel step ${r.worstUp.toFixed(1)} px <= ${maxStep.toFixed(1)}`);
});

test('the rope never corrects more than GRAPPLE.maxCorrection px in one tick', () => {
  const game = fakeGame(grappleWorld());
  const p = game.player;
  p.stats.grappleRange = 220;
  p.reset(20 * T, 12 * T);
  game.input.inject({ x: 0, y: -1 });
  game.input.tap('grapple');
  for (let i = 0; i < 40 && p.grapple.state !== 'attached'; i++) tick(game, 1);
  game.input.clearInjected();
  assert.equal(p.grapple.state, 'attached');
  p.grapple.length = 30; // force a huge excess (~100 px)
  let worst = 0;
  for (let i = 0; i < 40; i++) {
    const x0 = p.x, y0 = p.y;
    tick(game, 1);
    worst = Math.max(worst, Math.hypot(p.x - x0, p.y - y0));
  }
  assert.ok(worst <= GRAPPLE.maxCorrection + 7, `largest per-tick displacement ${worst.toFixed(1)} px`);
});

test('pressing Grappin while the hook retracts re-fires immediately (no dropped press)', () => {
  for (const delay of [0, 1, 2, 3]) {
    const game = fakeGame(boxWorld(30, 40));
    const p = game.player;
    p.reset(15 * T + 8, T + 100);
    game.input.inject({ x: 0, y: -1 });
    game.input.tap('grapple');
    tick(game, 20);
    assert.equal(p.grapple.state, 'attached');
    game.input.inject({ x: 0, y: -1, jump: true });
    tick(game, 1);
    game.input.inject({ x: 0, y: -1, jump: false });
    assert.equal(p.grapple.state, 'retracting');
    tick(game, delay);
    game.input.tap('grapple');
    tick(game, 1);
    assert.equal(p.grapple.state, 'flying', `fired ${delay + 1} ticks after the release`);
  }
});

test('on death the hook retracts instead of freezing mid-air', () => {
  for (const when of ['attached', 'flying']) {
    const game = fakeGame(grappleWorld());
    const p = game.player;
    p.stats.grappleRange = 220;
    p.reset(20 * T, 12 * T);
    game.input.inject({ x: 0, y: -1 });
    game.input.tap('grapple');
    tick(game, 1);
    if (when === 'attached') for (let i = 0; i < 40 && p.grapple.state !== 'attached'; i++) tick(game, 1);
    game.input.clearInjected();
    assert.equal(p.grapple.state, when);
    p.takeDamage(9999);
    assert.equal(p.dead, true);
    tick(game, 60);
    assert.equal(p.grapple.state, 'idle', `hook back after death (${when})`);
  }
});
