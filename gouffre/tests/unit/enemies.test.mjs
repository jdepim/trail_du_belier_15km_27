// Enemies, combat, pickups and the boss (DESIGN.md §6). No DOM: sprites/HUD are never drawn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TILE, LAYERS, ENEMY_STATS, ENEMY_SCALING, ENEMY_SPAWN_RULES, PLAYER, BOSS, DROPS, SURFACE_Y, WORLDGEN, HIT_STOP,
} from '../../src/config.js';
import { TILE_ID, SOLID } from '../../src/tiles.js';
import { generateWorld } from '../../src/worldgen.js';
import { createRng } from '../../src/rng.js';
import { EnemyManager, ENEMY_DEFS, scaleStat, findSpawnSpot, spawnTileValid, lineOfSight } from '../../src/enemies.js';
import { EntityManager } from '../../src/entities.js';
import { boxWorld, worldFrom, fakeGame, standOn } from './helpers.mjs';

const DT = 1 / 60;

/**
 * Box world placed below the surface line (flyers are kept out of the camp, so
 * behaviour tests must happen underground): OFF solid rows, then a w × h box.
 */
const OFF = SURFACE_Y + 6;
function deepBox(w, h) {
  const rows = [];
  for (let y = 0; y < OFF + h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) r += y < OFF || x === 0 || x === w - 1 || y === OFF + h - 1 ? '#' : '.';
    rows.push(r);
  }
  return worldFrom(rows);
}

/** Fake game with real EnemyManager + EntityManager around a world. */
function combatGame(world, extra = {}) {
  const game = fakeGame(world);
  game.camera = { x: 0, y: 0, viewW: 480, viewH: 216, shake() { game.events.shakes++; } };
  game.hud = { toast() {}, banner(t) { game.events.toasts.push(t); }, flashDamage() {}, flash() {} };
  game.lighting = { addLight() {} };
  game.run = { gold: 0, kills: 0, ngPlus: false };
  game.save = { ngPlus: false };
  game.gen = { seed: 7, arena: null, ...(extra.gen || {}) };
  game.entities = new EntityManager(game);
  game.enemies = new EnemyManager(game);
  game.defeated = 0;
  game.onBossDefeated = () => { game.defeated++; };
  return game;
}

/** Centre the fake camera on the player (enemies only think near the camera). */
function follow(game) {
  const p = game.player;
  game.camera.x = p.cx - game.camera.viewW / 2;
  game.camera.y = p.cy - game.camera.viewH / 2;
}

/** Advance the enemy + pickup systems (the player stands still, i-frames tick down). */
function run(game, seconds) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const p = game.player;
    p.iframes -= DT; p.hurtT -= DT;
    game.enemies.update(DT);
    game.entities.update(DT);
    game.time += DT;
  }
}

// ------------------------------------------------------------------ scaling & balance

test('depth scaling: hp × (1 + d/60), dmg × (1 + d/80), × 1.5 in NG+', () => {
  assert.equal(scaleStat(10, 0, 'hp'), 10);
  assert.equal(scaleStat(10, 60, 'hp'), 20);
  assert.equal(scaleStat(10, 80, 'dmg'), 20);
  assert.equal(scaleStat(10, 120, 'hp', true), 10 * 3 * ENEMY_SCALING.ngPlusMul);
  assert.equal(scaleStat(10, -5, 'hp'), 10, 'negative depth clamps to 0');
});

test('spawned enemies carry depth-scaled stats, NG+ read from the run', () => {
  const game = combatGame(boxWorld(20, 12));
  const e = game.enemies.spawn('skeleton', 100, 150, { anchor: 'floor', depth: 120 });
  assert.equal(e.maxHp, Math.round(ENEMY_STATS.skeleton.hp * 3));
  assert.equal(e.hp, e.maxHp);
  assert.equal(e.dmg, Math.round(ENEMY_STATS.skeleton.dmg * 2.5));
  assert.equal(e.projDmg, Math.round(ENEMY_STATS.skeleton.projDmg * 2.5));
  game.run.ngPlus = true;
  const f = game.enemies.spawn('skeleton', 100, 150, { anchor: 'floor', depth: 120 });
  assert.equal(f.maxHp, Math.round(ENEMY_STATS.skeleton.hp * 3 * 1.5));
});

test('balance: layer 1 is gentle, every layer is a clear step up', () => {
  const avg = (L, kind, d) => {
    let s = 0, w = 0;
    for (const [k, wt] of Object.entries(L.enemies)) { s += wt * scaleStat(ENEMY_STATS[k][kind], d, kind); w += wt; }
    return s / w;
  };
  // layer 1 at its deepest: at most 3 strikes of the base pickaxe, at most ~8 damage per hit (7+ hits to die)
  const d1 = LAYERS[0].d1;
  for (const k of Object.keys(LAYERS[0].enemies)) {
    assert.ok(Math.ceil(scaleStat(ENEMY_STATS[k].hp, d1, 'hp') / 10) <= 3, `${k} dies in <= 3 hits`);
    assert.ok(scaleStat(ENEMY_STATS[k].dmg, d1, 'dmg') <= 8, `${k} hits softly`);
    assert.ok(PLAYER.maxHp / scaleStat(ENEMY_STATS[k].dmg, d1, 'dmg') >= 7);
  }
  for (let i = 1; i < 4; i++) {
    const a = LAYERS[i - 1], b = LAYERS[i];
    const ma = (a.d0 + a.d1) / 2, mb = (b.d0 + b.d1) / 2;
    assert.ok(avg(b, 'hp', mb) > avg(a, 'hp', ma) * 1.3, `hp step ${a.key} -> ${b.key}`);
    assert.ok(avg(b, 'dmg', mb) > avg(a, 'dmg', ma) * 1.3, `dmg step ${a.key} -> ${b.key}`);
  }
});

test('every enemy definition has the sprite variants the renderer asks for', () => {
  for (const [k, d] of Object.entries(ENEMY_DEFS)) {
    assert.equal(d.spr[0], 'enemy_' + k);
    assert.deepEqual(d.spr.slice(1), ['enemy_' + k + '_flash', 'enemy_' + k + '_tele']);
    assert.ok(d.w > 0 && d.h > 0 && d.hp > 0 && d.dmg > 0 && d.name);
  }
});

// ------------------------------------------------------------------ spawn validity

const SEEDS = [1, 42, 12345, 777, 2654435761, 99, 31337, 8];

test('worldgen spawns become enemies that never overlap solid tiles (8 seeds)', () => {
  for (const seed of SEEDS) {
    const gen = generateWorld(seed);
    const game = combatGame(gen.world, { gen });
    game.gen = gen;
    game.enemies.reset(gen.spawns);
    assert.equal(game.enemies.count, gen.spawns.length, 'one enemy per spawn');
    assert.ok(game.enemies.boss && game.enemies.boss.key === 'guardian', 'the Guardian waits in the Heart');
    for (const e of game.enemies.list) {
      assert.equal(gen.world.rectSolid(e.x, e.y, e.w, e.h), false, `[${seed}] ${e.key} at ${e.x},${e.y} inside rock`);
      assert.equal(gen.world.rectHazard(e.x, e.y, e.w, e.h), 0, `[${seed}] ${e.key} in lava`);
      assert.ok(e.y + e.h > SURFACE_Y * TILE, 'below the surface');
    }
  }
});

test('off-screen respawn spots are valid, outside the view and in the right layer (8 seeds)', () => {
  const out = { key: null, x: 0, y: 0, anchor: 'floor', tx: 0, ty: 0 };
  for (const seed of SEEDS) {
    const gen = generateWorld(seed);
    const game = combatGame(gen.world, { gen });
    const rng = createRng(seed ^ 5);
    let found = 0;
    for (let k = 0; k < 60; k++) {
      const px = (4 + rng.int(0, 60)) * TILE, py = (SURFACE_Y + 12 + rng.int(0, 240)) * TILE;
      const view = { x: px - 240, y: py - 108, w: 480, h: 216 };
      const s = findSpawnSpot(gen.world, rng.next, px, py, view, out);
      if (!s) continue;
      found++;
      assert.ok(spawnTileValid(gen.world, s.key, s.tx, s.ty));
      const layer = LAYERS.find((L) => s.ty - SURFACE_Y >= L.d0 && s.ty - SURFACE_Y <= L.d1);
      assert.ok(layer && s.key in layer.enemies && layer.index < 4, `${s.key} belongs to its layer`);
      assert.ok(s.ty - SURFACE_Y >= WORLDGEN.minSpawnDepth && s.ty < WORLDGEN.arena.y0, 'not in the camp nor the Heart');
      const e = game.enemies.spawn(s.key, s.x, s.y, { anchor: s.anchor });
      assert.equal(gen.world.rectSolid(e.x, e.y, e.w, e.h), false, `[${seed}] respawned ${e.key} inside rock`);
      const inView = e.x < view.x + view.w && e.x + e.w > view.x && e.y < view.y + view.h && e.y + e.h > view.y;
      assert.equal(inView, false, 'spawned off-screen');
    }
    assert.ok(found > 20, `[${seed}] found ${found} spots`);
  }
});

test('respawn keeps the local population under the cap and only far from the player', () => {
  const gen = generateWorld(12345);
  const game = combatGame(gen.world, { gen });
  game.enemies.reset([]);
  const p = game.player;
  p.reset(36 * TILE, (SURFACE_Y + 60) * TILE);
  follow(game);
  run(game, 120);
  const local = game.enemies.list.filter((e) => e.alive && e.active);
  assert.ok(local.length > 0, 'something respawned');
  assert.ok(local.length <= 5, `local population ${local.length}`);
  for (const e of game.enemies.list) {
    if (!e.alive) continue;
    assert.equal(gen.world.rectSolid(e.x, e.y, e.w, e.h) && e.key !== 'ghost', false);
  }
});

test('line of sight is blocked by rock', () => {
  const game = combatGame(boxWorld(20, 10));
  const w = game.world;
  assert.equal(lineOfSight(w, 40, 40, 200, 40), true);
  w.set(8, 2, TILE_ID.STONE);
  assert.equal(lineOfSight(w, 40, 40, 200, 40), false);
});

// ------------------------------------------------------------------ combat

test('contact damage uses player.takeDamage: i-frames, knockback, armor hook', () => {
  const game = combatGame(boxWorld(30, 12));
  const p = game.player;
  standOn(game, 10, 11);
  follow(game);
  const e = game.enemies.spawn('slime', p.cx + 4, p.feetY, { anchor: 'floor', depth: 30 });
  e.cd = 99;
  const hp0 = p.hp;
  run(game, DT);
  assert.equal(p.hp, hp0 - e.dmg, 'hit once');
  assert.ok(p.iframes > 0.9, 'i-frames started');
  assert.ok(p.vx < 0, 'knocked away from the slime');
  p.x = e.x; p.vx = 0; p.vy = 0; // stay glued to it
  run(game, 0.5);
  assert.equal(p.hp, hp0 - e.dmg, 'no damage during i-frames');
  p.iframes = 0; p.stats.armor = 0.5; p.x = e.x; e.stun = 0;
  run(game, DT);
  assert.equal(p.hp, hp0 - e.dmg - Math.round(e.dmg * 0.5), 'armor halves the next hit');
});

test('enemy projectiles hurt the player once and stop on rock', () => {
  const game = combatGame(boxWorld(30, 12));
  const p = game.player;
  standOn(game, 10, 11);
  follow(game);
  const hp0 = p.hp;
  const pr = game.enemies.fire('fireball', p.cx - 40, p.cy, 200, 0, 9);
  run(game, 0.4);
  assert.equal(p.hp, hp0 - 9);
  assert.equal(pr.active, false, 'consumed on hit');
  const wall = game.enemies.fire('bone', 3 * TILE, 3 * TILE, -300, 0, 5);
  run(game, 0.3);
  assert.equal(wall.active, false, 'stopped by the wall');
  assert.equal(p.hp, hp0 - 9);
});

test('the pickaxe damages enemies in its arc: knockback, flash, death burst, coins', () => {
  const game = combatGame(boxWorld(30, 12));
  const p = game.player;
  standOn(game, 10, 11);
  follow(game);
  p.facing = 1;
  const e = game.enemies.spawn('slime', p.cx + 16, p.feetY, { anchor: 'floor', depth: 20 });
  e.cd = 99;
  const box = p.strikeBox('side');
  const hits = game.enemies.damageInBox(box, 10, p.cx, { dir: 'side' });
  assert.equal(hits, 1);
  assert.equal(e.hp, e.maxHp - 10);
  assert.ok(e.flash > 0 && e.vx > 0 && e.stun > 0, 'flash + knockback away + stun');
  assert.ok(game.events.audio.includes('enemy_hit'));
  // finish it
  e.x = p.x + p.w; e.stun = 0;
  game.enemies.damageInBox(box, 99, p.cx, { dir: 'side' });
  assert.ok(e.dying > 0, 'death flash');
  run(game, 0.2);
  assert.equal(e.alive, false);
  assert.equal(game.run.kills, 1);
  assert.ok(game.events.audio.includes('enemy_death'));
  assert.ok(game.events.particles.includes('poof') || game.events.particles.includes('blood'));
  assert.ok(game.entities.pickups.some((q) => q.active && q.kind === 1), 'coins dropped');
  // an enemy outside the arc is untouched
  const far = game.enemies.spawn('slime', p.cx - 60, p.feetY, { anchor: 'floor' });
  assert.equal(game.enemies.damageInBox(p.strikeBox('side'), 10, p.cx, {}), 0);
  assert.equal(far.hp, far.maxHp);
});

test('striking a bone out of the air deflects it', () => {
  const game = combatGame(boxWorld(30, 12));
  const p = game.player;
  standOn(game, 10, 11);
  p.facing = 1;
  const box = p.strikeBox('side');
  const pr = game.enemies.fire('bone', box.x + 6, box.y + 10, -100, 0, 5);
  game.enemies.damageInBox(box, 10, p.cx, {});
  assert.equal(pr.active, false);
});

test('a downward strike on an enemy in mid-air bounces the player (pogo)', () => {
  const game = fakeGame(boxWorld(20, 20));
  const p = game.player;
  p.reset(10 * TILE, 10 * TILE);
  p.onGround = false; p.vy = 150;
  game.enemies = { damageInBox: () => 1 };
  game.input.inject({ x: 0, y: 1 });
  p.strike();
  assert.ok(p.vy <= -PLAYER.pogoVel + 1e-6, `vy ${p.vy}`);
  assert.ok(game.events.hitStops > 0);
  assert.equal(HIT_STOP.enemy > 0, true);
});

test('behaviours: a bat wakes when the player comes close, a spider drops on a player below', () => {
  const game = combatGame(deepBox(30, 16));
  const p = game.player;
  standOn(game, 3, OFF + 15);
  follow(game);
  const bat = game.enemies.spawn('bat', 10 * TILE + 8, OFF * TILE, { anchor: 'ceiling' });
  const spider = game.enemies.spawn('spider', 20 * TILE + 8, OFF * TILE, { anchor: 'ceiling' });
  assert.equal(bat.state, 'sleep');
  assert.equal(spider.state, 'hang');
  run(game, 0.5);
  assert.equal(bat.state, 'sleep', 'still asleep while the player is far');
  assert.equal(spider.state, 'hang', 'spider waits');
  p.x = 10 * TILE + 3; p.y = (OFF + 3) * TILE; p.prevY = p.y; // right under the bat
  run(game, 0.5);
  assert.notEqual(bat.state, 'sleep', 'woke up');
  // spider: the player walks under it
  p.x = 20 * TILE + 3; p.y = (OFF + 8) * TILE - p.h;
  run(game, 1.2);
  assert.ok(['drop', 'walk', 'pause'].includes(spider.state), `spider ${spider.state}`);
  assert.ok(spider.y > (OFF + 3) * TILE, 'fell from its thread');
});

test('ghosts float through walls, skeletons turn at walls', () => {
  const game = combatGame(deepBox(40, 12));
  const p = game.player;
  standOn(game, 26, OFF + 11);
  follow(game);
  for (let y = OFF + 1; y < OFF + 11; y++) game.world.set(20, y, TILE_ID.STONE);
  const ghost = game.enemies.spawn('ghost', 17 * TILE, (OFF + 8) * TILE, { anchor: 'air' });
  run(game, 4);
  assert.ok(ghost.x > 21 * TILE, `ghost crossed the wall (${ghost.x})`);
  const sk = game.enemies.spawn('skeleton', 18 * TILE, (OFF + 11) * TILE, { anchor: 'floor' });
  sk.facing = 1; sk.cd = 99;
  run(game, 3);
  assert.ok(sk.x + sk.w <= 20 * TILE + 0.01, 'never walked into the wall');
  assert.equal(sk.facing, -1, 'turned around');
});

// ------------------------------------------------------------------ pickups

test('coins are magnetised and collected into the run gold; hearts heal only when hurt', () => {
  const game = combatGame(boxWorld(30, 12));
  const p = game.player;
  standOn(game, 10, 11);
  game.entities.spawnCoins(p.cx + 12, p.cy, 11, { count: 4 });
  const coins = game.entities.pickups.filter((q) => q.active);
  assert.equal(coins.length, 4);
  assert.equal(coins.reduce((s, q) => s + q.value, 0), 11, 'value split exactly');
  run(game, 2);
  assert.equal(game.run.gold, 11);
  assert.equal(game.entities.pickups.filter((q) => q.active).length, 0);
  assert.ok(game.events.audio.includes('coin'));
  // heart at full HP stays on the ground
  game.entities.spawnHeart(p.cx + 10, p.cy, 15);
  run(game, 1.5);
  assert.equal(game.entities.pickups.filter((q) => q.active).length, 1, 'heart waits');
  p.hp = 30;
  run(game, 1.5);
  assert.equal(p.hp, 45, 'healed 15');
  assert.equal(game.entities.pickups.filter((q) => q.active).length, 0);
});

test('pickups fall, bounce and rest on the floor, then vanish after their lifetime', () => {
  const game = combatGame(boxWorld(40, 12));
  const p = game.player;
  standOn(game, 3, 11);
  game.entities.spawnCoins(30 * TILE, 4 * TILE, 1, { count: 1 });
  const c = game.entities.pickups.find((q) => q.active);
  run(game, 3);
  assert.ok(Math.abs(c.y + c.h - 11 * TILE) < 0.5, 'resting on the floor');
  assert.equal(c.vx, 0);
  run(game, DROPS.life);
  assert.equal(c.active, false, 'expired');
  assert.equal(game.run.gold, 0);
  assert.ok(p);
});

test('life crystals drop a heart pickup instead of healing instantly', () => {
  const game = combatGame(boxWorld(20, 12));
  game.player.hp = 10;
  game.entities.onTileBroken(5, 5, TILE_ID.LIFE_CRYSTAL);
  assert.equal(game.player.hp, 10);
  const h = game.entities.pickups.find((q) => q.active);
  assert.equal(h.kind, 2);
  assert.equal(h.value, DROPS.crystalHeal);
});

// ------------------------------------------------------------------ the Guardian

function arenaGame(seed = 12345) {
  const gen = generateWorld(seed);
  const game = combatGame(gen.world, { gen });
  game.gen = gen;
  game.enemies.reset(gen.spawns);
  return { game, gen, a: gen.arena };
}

function enterArena(game, a, dx = 8) {
  const p = game.player;
  p.reset((a.x0 + dx) * TILE + 8, (a.y1 + 1) * TILE);
  follow(game);
}

test('Guardian: sleeps until the player enters, then seals the gates and roars (invulnerable)', () => {
  const { game, a } = arenaGame();
  const b = game.enemies.boss;
  const en = game.enemies;
  game.player.reset(36 * TILE, (a.outer.y0 - 3) * TILE); // vestibule above the arena
  follow(game);
  run(game, 0.5);
  assert.equal(b.state, 'dormant');
  assert.equal(en.bossBar, null, 'no bar before the fight');
  assert.equal(en.damageInBox({ x: b.x, y: b.y, w: b.w, h: b.h }, 50, b.x - 10, {}), 0, 'dormant = invulnerable');
  enterArena(game, a);
  run(game, DT * 2);
  assert.equal(b.state, 'intro');
  assert.equal(en.gatesSealed, true);
  for (let tx = a.entrance.x0; tx <= a.entrance.x1; tx++) {
    assert.equal(game.world.get(tx, a.outer.y0), TILE_ID.GATE, 'entrance sealed');
    assert.equal(SOLID[game.world.get(tx, a.outer.y0 + 1)], 1);
  }
  const bar = en.bossBar;
  assert.ok(bar && bar.name === "Le Gardien de l'Abysse" && bar.maxHp === b.maxHp);
  assert.ok(en.cameraFocusY > a.y0 * TILE && en.cameraFocusY < (a.y1 + 1) * TILE, 'camera frames the arena');
  assert.equal(en.hurt(b, 10, null, {}), false, 'intro = invulnerable');
  run(game, BOSS.intro + 0.1);
  assert.notEqual(b.state, 'intro');
});

test('Guardian: 3 phases at 66 % / 33 %, each transition invulnerable, new attacks unlock', () => {
  const { game, a } = arenaGame();
  const b = game.enemies.boss, en = game.enemies;
  game.flags.god = true; // the test is about the boss, keep the player alive
  enterArena(game, a, 4);
  run(game, BOSS.intro + 0.2);
  assert.equal(b.phase, 0);
  const seen = new Set();
  for (let i = 0; i < 40 * 60; i++) { run(game, DT); seen.add(b.state); }
  assert.ok(seen.has('slam_wind') || seen.has('swipe_wind'), 'phase 1 attacks');
  assert.ok(!seen.has('rain_wind') && !seen.has('summon_wind'), 'no later attacks in phase 1');
  en.hurt(b, Math.ceil(b.maxHp * 0.35), null, {});
  assert.equal(b.phase, 1);
  assert.equal(b.state, 'phase');
  assert.equal(en.hurt(b, 10, null, {}), false, 'invulnerable while roaring');
  run(game, BOSS.phaseTime + 0.1);
  seen.clear();
  for (let i = 0; i < 40 * 60; i++) { run(game, DT); seen.add(b.state); }
  assert.ok(seen.has('summon_wind'), 'phase 2 summons');
  assert.ok(en.list.some((m) => m.minion), 'minions exist');
  en.hurt(b, b.hp - Math.floor(b.maxHp * 0.3), null, {});
  assert.equal(b.phase, 2);
  run(game, BOSS.phaseTime + 0.1);
  seen.clear();
  let warned = false;
  for (let i = 0; i < 40 * 60; i++) { run(game, DT); seen.add(b.state); if (en.projectiles.some((q) => q.active && q.type === 'warn')) warned = true; }
  assert.ok(seen.has('rain_wind') || seen.has('charge_wind'), 'phase 3 attacks');
  assert.ok(warned || seen.has('charge_wind'), 'fire rain telegraphs its meteors');
});

test('Guardian: death sequence, drops, gates reopen and game.onBossDefeated fires once', () => {
  const { game, a } = arenaGame();
  const b = game.enemies.boss, en = game.enemies;
  game.flags.god = true;
  enterArena(game, a);
  run(game, BOSS.intro + 0.2);
  en.hurt(b, b.maxHp * 0.5, null, {});
  run(game, BOSS.phaseTime + 0.1);
  en.hurt(b, b.hp + 10, null, {});
  assert.equal(b.state, 'dying');
  assert.equal(game.defeated, 0, 'not yet: the death sequence plays first');
  run(game, BOSS.deathTime + 0.2);
  assert.equal(game.defeated, 1);
  assert.equal(en.bossDefeated, true);
  assert.equal(en.gatesSealed, false);
  assert.equal(en.boss, null);
  assert.equal(en.bossBar, null);
  for (let tx = a.entrance.x0; tx <= a.entrance.x1; tx++) assert.equal(game.world.get(tx, a.outer.y0), TILE_ID.AIR, 'entrance open');
  assert.ok(game.entities.pickups.filter((q) => q.active).length >= BOSS.coins, 'treasure dropped');
  assert.equal(en.list.filter((m) => m.minion && m.alive).length, 0, 'minions vanish');
  run(game, 3);
  assert.equal(game.defeated, 1, 'fires once');
});
