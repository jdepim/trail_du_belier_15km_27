import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER } from '../../src/config.js';
import { TILE_ID } from '../../src/tiles.js';
import { worldFrom, boxWorld, fakeGame, tick, standOn } from './helpers.mjs';

const T = 16;

test('full jump reaches ~3.2 tiles, a short tap much less', () => {
  const game = fakeGame(boxWorld(20, 20));
  const p = game.player;
  standOn(game, 10, 19);
  const ground = p.y;
  game.input.inject({ jump: true });
  let top = p.y;
  for (let i = 0; i < 90; i++) { tick(game, 1); top = Math.min(top, p.y); }
  game.input.inject({ jump: false });
  const h = (ground - top) / T;
  assert.ok(h > 3.0 && h < 3.6, `full jump ${h.toFixed(2)} tiles`);
  tick(game, 60);
  assert.equal(p.onGround, true);
  const g2 = p.y;
  game.input.tap('jump');
  let top2 = p.y;
  for (let i = 0; i < 90; i++) { tick(game, 1); top2 = Math.min(top2, p.y); }
  const h2 = (g2 - top2) / T;
  assert.ok(h2 < h * 0.45, `short hop ${h2.toFixed(2)} tiles`);
});

test('running reaches max speed quickly and stops quickly', () => {
  const game = fakeGame(boxWorld(40, 10));
  const p = game.player;
  standOn(game, 5, 9);
  game.input.inject({ x: 1, y: 0 });
  tick(game, 8);
  assert.ok(p.vx > PLAYER.maxSpeed * 0.9, `accel ${p.vx}`);
  tick(game, 30);
  assert.ok(Math.abs(p.vx - PLAYER.maxSpeed) < 1e-6);
  game.input.clearInjected();
  tick(game, 6);
  assert.equal(p.vx, 0);
  assert.equal(p.anim, 'idle');
});

test('coyote time allows a late jump after walking off a ledge', () => {
  const game = fakeGame(worldFrom([
    '####################',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#..................#',
    '#######............#',
    '#..................#',
    '#..................#',
    '####################',
  ]));
  const p = game.player;
  standOn(game, 5, 6);
  game.input.inject({ x: 1, y: 0 });
  let t = 0;
  while (p.onGround && t < 120) { tick(game, 1); t++; }
  assert.equal(p.onGround, false, 'walked off');
  tick(game, 3); // 50 ms late
  game.input.tap('jump');
  tick(game, 1);
  assert.ok(p.vy < -200, 'coyote jump happened');
});

test('jump buffer triggers the jump on landing', () => {
  const game = fakeGame(boxWorld(20, 20));
  const p = game.player;
  p.reset(10 * T, 15 * T);
  // fall until just above the floor
  while (p.y + p.h < 19 * T - 12) tick(game, 1);
  game.input.inject({ jump: true }); // pressed before touching the ground, held
  let jumped = false;
  for (let i = 0; i < 10; i++) { tick(game, 1); if (p.vy < -200) jumped = true; }
  game.input.inject({ jump: false });
  assert.ok(jumped, 'buffered jump fired on landing');
});

test('pickaxe digs the tile below and the player falls into the hole', () => {
  const game = fakeGame(worldFrom([
    '##########',
    '#........#',
    '#........#',
    '#........#',
    '####DD####',
    '####DD####',
    '####DD####',
    '#........#',
    '##########',
  ]));
  const p = game.player;
  standOn(game, 4, 4);
  const y0 = p.y;
  game.input.inject({ x: 0, y: 1, attack: true }); // aim down + hold attack (auto-repeat)
  tick(game, 150);
  assert.ok(p.y > y0 + 3 * T - 1, `dug through 3 tiles (dy=${p.y - y0})`);
  assert.ok(game.events.broken.length >= 3);
  assert.ok(game.events.audio.includes('swing'));
});

test('side strike hits head and feet tiles; tier gate shows "Trop dur !"', () => {
  const game = fakeGame(worldFrom([
    '##########',
    '#........#',
    '#........#',
    '#...D..B.#',
    '#...D..B.#',
    '##########',
  ]));
  const p = game.player;
  standOn(game, 2, 5);
  p.facing = 1;
  // walk right until blocked by the dirt column (x=4)
  game.input.inject({ x: 1, y: 0 });
  tick(game, 30);
  game.input.inject({ x: 1, y: 0, attack: true });
  tick(game, 2);
  game.input.inject({ x: 1, y: 0, attack: false });
  assert.equal(game.world.get(4, 3), TILE_ID.AIR, 'head tile broken');
  assert.equal(game.world.get(4, 4), TILE_ID.AIR, 'feet tile broken');
  tick(game, 60);
  game.input.inject({ x: 1, y: 0, attack: true });
  tick(game, 3);
  assert.equal(game.world.get(7, 3), TILE_ID.BRICK, 'brick needs tier 1');
  assert.equal(game.world.damage[game.world.idx(7, 3)], 0, 'no damage dealt');
  assert.ok(game.events.toasts.includes('Trop dur !'));
  assert.ok(game.events.audio.includes('clink'));
});

test('takeDamage applies i-frames, knockback and death', () => {
  const game = fakeGame(boxWorld(20, 20));
  const p = game.player;
  standOn(game, 10, 19);
  let deaths = 0;
  game.onPlayerDeath = () => deaths++;
  assert.equal(p.takeDamage(10, p.cx + 20), true);
  assert.equal(p.hp, PLAYER.maxHp - 10);
  assert.ok(p.vx < 0 && p.vy < 0, 'knocked away from the source');
  assert.equal(p.takeDamage(10, p.cx + 20), false, 'i-frames');
  tick(game, 70);
  p.takeDamage(999);
  assert.equal(p.hp, 0);
  assert.equal(p.dead, true);
  assert.equal(deaths, 1);
});

test('lava hurts and bounces the player out', () => {
  const game = fakeGame(worldFrom([
    '##########',
    '#........#',
    '#........#',
    '#........#',
    '#LLLLLLLL#',
    '##########',
  ]));
  const p = game.player;
  p.reset(5 * T, 4 * T);
  tick(game, 6);
  assert.ok(p.hp < PLAYER.maxHp, 'burned');
  assert.ok(p.vy < 0, 'popped upward');
});

// ---------------------------------------------------------------- regressions (review fixes)

function floorWithHole(depth = 4) {
  const rows = [];
  for (let y = 0; y < 16; y++) {
    let r = '';
    for (let x = 0; x < 24; x++) {
      const border = x === 0 || x === 23 || y === 15;
      const hole = x === 10 && y >= 8 && y < 8 + depth;
      r += border || (y >= 8 && !hole) ? '#' : '.';
    }
    rows.push(r);
  }
  return worldFrom(rows);
}

test('idle on the rim of a 1-wide hole: no drag-in; more than half over it: slides in', () => {
  for (const ov of [1, 3, 5]) {
    const game = fakeGame(floorWithHole());
    const p = game.player;
    p.reset(11 * T - ov + p.w / 2, 8 * T); // left edge overlaps the hole (x 160..176) by ov px
    tick(game, 62);
    assert.equal(p.feetY, 8 * T, `stays on the rim with ${ov} px overlap`);
    assert.ok(Math.abs(p.x - (11 * T - ov)) < 1e-6, 'not pulled sideways');
  }
  const game = fakeGame(floorWithHole());
  const p = game.player;
  p.reset(11 * T - 8 + p.w / 2, 8 * T); // centre over the hole
  tick(game, 62);
  assert.ok(p.feetY > 8 * T + 2 * T, 'slid into the hole under its centre');
});
