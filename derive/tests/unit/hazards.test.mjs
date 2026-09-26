import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SUNS, HAZARDS, ASTEROIDS, PLAYER, CENTER, BELT, BOUNDARY, ZONE_ID } from '../../src/config.js';
import { TILE_ID } from '../../src/tiles.js';
import { ASTEROID_MODE, heatField } from '../../src/hazards.js';
import { fakeGame, worldFrom, emptyGen, tick, px, cachedGen, ORIGIN, boxWorld } from './helpers.mjs';

const DT = 1 / 60;

function sunGen(world) {
  // a flare-only sun (no heat, no gravity) at test tile (5, 5)
  const sun = { key: 'helios_a', name: 'Hélios A', x: px(5), y: px(5), coreR: 20, heatR: 650, heatMax: 0, heatExp: 2, mu: 0, influence: 1, cause: 'sun_a' };
  return emptyGen(world, { suns: [sun], spawn: { x: px(45), y: px(5) } });
}

function rows(wall) {
  const r = [];
  for (let y = 0; y < 11; y++) r.push('.'.repeat(25) + (wall ? '#' : '.') + '.'.repeat(24));
  return r;
}

function runFlare(g) {
  const s = g.hazards.suns[0];
  s.nextFlare = 0.01;
  let sawWarn = false, sawRing = false;
  for (let i = 0; i < 260; i++) {
    tick(g, 1, DT);
    if (s.flareState === 'warn') sawWarn = true;
    if (s.flareState === 'ring') sawRing = true;
  }
  assert.ok(sawWarn && sawRing, 'telegraph then ring');
  assert.equal(s.flareState, 'idle', 'ring died out');
  assert.ok(s.nextFlare >= SUNS.flare.intervalMin - 1);
}

test('a flare hurts in the open and is blocked by a solid obstacle', () => {
  const open = fakeGame({ gen: sunGen(worldFrom(rows(false))) });
  runFlare(open);
  assert.equal(open.player.hull, PLAYER.maxHull - SUNS.flare.damage, 'hit once by the ring');
  assert.ok(open.events.audio.includes('flare_warn') && open.events.audio.includes('flare'));
  const sheltered = fakeGame({ gen: sunGen(worldFrom(rows(true))) });
  runFlare(sheltered);
  assert.equal(sheltered.player.hull, PLAYER.maxHull, 'the wall shades the astronaut');
  assert.ok(sheltered.events.particles.includes('shelter'));
  const shielded = fakeGame({ gen: sunGen(worldFrom(rows(false))) });
  shielded.save.items.heatshield = true;
  runFlare(shielded);
  assert.ok(Math.abs(shielded.player.hull - (PLAYER.maxHull - SUNS.flare.damage * SUNS.flare.shieldMul)) < 1e-9, 'shield × 0.2');
});

test('heat: shield × SUNS.shieldMul, insulated interiors, SURCHAUFFE level', () => {
  const gen = cachedGen(1);
  const g = fakeGame({ gen });
  const s = gen.suns[0];
  const raw = g.hazards.heatAt(s.x, s.y - 400, false);
  assert.ok(raw > 20);
  assert.ok(Math.abs(g.hazards.heatAt(s.x, s.y - 400, true) - raw * SUNS.shieldMul) < 1e-9);
  const an = gen.items.find((i) => i.key === 'anchor');
  assert.equal(gen.world.zoneAt(an.x, an.y), ZONE_ID.helios);
  assert.ok(heatField(gen.world, gen.suns, an.x, an.y) < heatField(gen.world, gen.suns, an.x, an.y - 70) * 0.1, 'the observatory hull insulates');
  g.save.items.heatshield = true;
  g.player.reset(s.x, s.y - 450);
  tick(g, 1, DT);
  assert.ok(g.hazards.heatAtPlayer > 0 && g.hazards.heatLevel > 0);
  assert.ok(g.player.hull < PLAYER.maxHull);
  assert.equal(g.player.dead, false);
});

test('explosions break rubble only, report broken tiles, hurt and push the astronaut', () => {
  const world = worldFrom([
    '##########',
    '#rrrr....#',
    '#rrrr....#',
    '#rrrr....#',
    '##########',
  ]);
  const g = fakeGame({ gen: emptyGen(world, { spawn: { x: px(7), y: px(2) } }) });
  const p = g.player;
  const n = g.hazards.explode(px(4), px(2), HAZARDS.charge.blastR, HAZARDS.charge.power, 'self');
  assert.ok(n >= 8, `${n} tiles broken`);
  assert.equal(g.events.broken.length, n);
  assert.ok(g.events.broken.every((b) => b[2] === TILE_ID.RUBBLE && b[3] === 'self'));
  assert.equal(world.get(ORIGIN + 2, ORIGIN + 2), TILE_ID.MOON_FLOOR);
  assert.equal(world.get(ORIGIN, ORIGIN + 2), TILE_ID.HULL, 'hull untouched');
  assert.ok(p.hull < PLAYER.maxHull, 'caught in the blast');
  assert.ok(p.vx > 100, `pushed away (${p.vx})`);
  assert.ok(g.events.audio.includes('explosion') && g.events.particles.includes('explosion'));
  assert.equal(g.hazards.explosions.filter((e) => e.active).length, 1);
  tick(g, Math.ceil(HAZARDS.explosionLife / DT) + 1, DT);
  assert.equal(g.hazards.explosions.filter((e) => e.active).length, 0, 'FX record expires');
  // a fatal blast names the cause
  p.reset(px(5), px(2)); p.hull = 2;
  g.hazards.explode(px(5), px(2), 40, 45, 'self');
  assert.equal(p.deathCause, 'self');
});

test('charges: fuse, drift with the dropping velocity, bounce, explode', () => {
  const world = boxWorld(60, 20);
  const g = fakeGame({ gen: emptyGen(world, { spawn: { x: px(5), y: px(10) } }) });
  assert.equal(g.hazards.dropCharge(px(10), px(10), 30, 0), true);
  const c = g.hazards.charges.find((q) => q.active);
  tick(g, 60, DT);
  assert.ok(c.x > px(10) + 25, 'drifts');
  assert.ok(c.fuse < HAZARDS.charge.fuse - 0.9);
  assert.ok(g.events.audio.includes('charge_beep'));
  tick(g, Math.ceil(HAZARDS.charge.fuse / DT), DT);
  assert.equal(c.active, false);
  assert.ok(g.events.audio.includes('explosion'));
});

test('asteroid collisions hurt above the safe speed and bounce both bodies', () => {
  const g = fakeGame({ world: boxWorld(80, 40) });
  const p = g.player;
  p.reset(px(20), px(20));
  const a = g.hazards.spawnAsteroid(ASTEROID_MODE.FREE, px(20) + 40, px(20), -300, 0, 2);
  assert.ok(a);
  tick(g, 20, DT);
  assert.ok(p.hull < PLAYER.maxHull - 30, `hull ${p.hull}`);
  assert.ok(p.vx < -100, 'the big rock throws the astronaut back');
  assert.ok(a.vx > -300, 'the rock lost speed');
  assert.ok(g.events.audio.includes('impact'));
  p.hull = 1; p.iframes = 0;
  g.hazards.spawnAsteroid(ASTEROID_MODE.FREE, p.x + 30, p.y, -400, 0, 2);
  tick(g, 20, DT);
  assert.equal(p.deathCause, 'impact');
});

test('explosions split asteroids: L -> 2 M, S -> salvage', () => {
  const g = fakeGame({ world: boxWorld(80, 40) });
  g.player.reset(px(5), px(5));
  g.hazards.spawnAsteroid(ASTEROID_MODE.FREE, px(40), px(20), 0, 0, 2);
  g.hazards.explode(px(40) + 20, px(20), 40, 45, 'self');
  assert.equal(g.hazards.asteroids.filter((a) => a.active && a.size === 2).length, 0, 'the L is gone');
  const mids = g.hazards.asteroids.filter((a) => a.active);
  assert.equal(mids.length, 2);
  assert.ok(mids.every((a) => a.size === 1 && a.r === ASTEROIDS.radius[1]));
  for (const a of mids) a.active = false;
  g.hazards.spawnAsteroid(ASTEROID_MODE.FREE, px(40), px(20), 0, 0, 0);
  const before = g.entities.pickups.filter((q) => q.active).length;
  g.hazards.explode(px(40), px(20) + 10, 40, 45, 'self');
  assert.equal(g.hazards.asteroids.filter((a) => a.active).length, 0, 'an S shatters completely');
  const salvage = g.entities.pickups.filter((q) => q.active && q.kind === 'salvage');
  assert.ok(salvage.length > before, 'fragments of salvage');
  const total = salvage.reduce((s, q) => s + q.value, 0);
  assert.ok(total >= 2 && total <= 6, `worth ${total}`);
});

test('turrets aim at a visible astronaut, telegraph, fire slow bolts; walls block them', () => {
  const room = [];
  for (let y = 0; y < 30; y++) room.push(y === 0 || y === 29 ? '#'.repeat(40) : '#' + '.'.repeat(38) + '#');
  const g = fakeGame({ gen: emptyGen(worldFrom(room), { turrets: [{ id: 't', x: px(5), y: px(15) }], spawn: { x: px(20), y: px(15) } }) });
  let aimed = false;
  for (let i = 0; i < 60 * 5; i++) { tick(g, 1, DT); if (g.hazards.turrets[0].telegraph > 0) aimed = true; }
  assert.ok(aimed, 'telegraph shown');
  assert.ok(g.events.audio.includes('turret_lock') && g.events.audio.includes('turret_fire'));
  assert.ok(g.player.hull < PLAYER.maxHull, 'hit by a bolt');
  const t = g.hazards.turrets[0];
  assert.ok(Math.abs(Math.atan2(g.player.y - t.y, g.player.x - t.x) - t.angle) < 0.3, 'faces the astronaut');
  // behind a wall: never fires
  const walled = room.map((r, y) => (y > 0 && y < 29 ? r.slice(0, 12) + '#' + r.slice(13) : r));
  const g2 = fakeGame({ gen: emptyGen(worldFrom(walled), { turrets: [{ id: 't', x: px(5), y: px(15) }], spawn: { x: px(20), y: px(15) } }) });
  tick(g2, 60 * 5, DT);
  assert.ok(!g2.events.audio.includes('turret_fire'));
  assert.equal(g2.player.hull, PLAYER.maxHull);
  // a charge destroys it
  g.hazards.explode(t.x + 10, t.y, 40, 45, 'self');
  assert.equal(t.alive, false);
  assert.ok(g.events.audio.includes('turret_destroyed'));
});

test('laser barriers cycle off / warn / on and disintegrate on contact', () => {
  const L = HAZARDS.laser;
  const laser = { id: 'l', x0: px(20), y0: px(10) - 12, x1: px(20), y1: px(10) + 12, vertical: true, phase: 0 };
  const g = fakeGame({ gen: emptyGen(boxWorld(40, 20), { lasers: [laser], spawn: { x: px(20), y: px(10) } }) });
  const l = g.hazards.lasers[0];
  tick(g, Math.round(1 / DT), DT);
  assert.equal(l.state, 'off');
  assert.equal(g.player.hull, PLAYER.maxHull);
  tick(g, Math.round((L.off + 0.2 - 1) / DT), DT);
  assert.equal(l.state, 'warn');
  g.player.teleport(px(20), px(10));
  tick(g, Math.round((L.warn) / DT), DT);
  assert.equal(l.state, 'on');
  assert.equal(g.player.hull, PLAYER.maxHull - L.damage);
  assert.ok(Math.abs(g.player.vx) > 100, 'pushed out of the beam');
  assert.ok(g.events.audio.includes('laser_on'));
  g.player.teleport(px(20), px(10));
  g.player.iframes = 0; g.player.hull = 5;
  tick(g, 1, DT);
  assert.equal(g.player.deathCause, 'laser');
});

test('gas vents push while blowing', () => {
  const vent = { id: 'v', x: px(10), y: px(10), dirX: 1, dirY: 0, length: 88, halfWidth: 12, phase: 0 };
  const g = fakeGame({ gen: emptyGen(boxWorld(40, 20), { vents: [vent], spawn: { x: px(14), y: px(10) } }) });
  const V = HAZARDS.vent;
  tick(g, Math.round((V.off + V.warn - 0.1) / DT), DT);
  assert.ok(Math.abs(g.player.vx) < 1e-6, 'nothing while off / warning');
  assert.ok(g.events.particles.includes('gas_warn'));
  g.player.teleport(px(14), px(10));
  tick(g, 20, DT);
  assert.equal(g.hazards.vents[0].state, 'on');
  assert.ok(g.player.vx > 60, `pushed (${g.player.vx})`);
  assert.equal(g.player.hull, PLAYER.maxHull, 'the gas itself is harmless');
  assert.ok(g.events.particles.includes('gas'));
});

test('belt asteroids appear around a player in the belt, not at the centre; the Maelström spirals', () => {
  const gen = cachedGen(1);
  const g = fakeGame({ gen });
  tick(g, 90, DT);
  assert.equal(g.hazards.asteroids.filter((a) => a.active).length, 0, 'calm at the Albatros');
  g.player.reset(CENTER + (BELT.rInner + BELT.rOuter) / 2, CENTER);
  g.save.settings.assist = true;
  tick(g, 240, DT);
  const belt = g.hazards.asteroids.filter((a) => a.active && a.mode === ASTEROID_MODE.BELT);
  assert.ok(belt.length >= 6, `${belt.length} belt asteroids`);
  for (const a of belt) {
    const r = Math.hypot(a.x - CENTER, a.y - CENTER);
    assert.ok(r > BELT.rInner - 80 && r < BELT.rOuter + 80, 'inside the annulus');
    assert.ok(Math.hypot(a.x - g.player.x, a.y - g.player.y) < ASTEROIDS.recycleDist);
  }
  // counter-clockwise orbit on screen: east of the centre they move north
  const east = belt.filter((a) => Math.abs(a.y - CENTER) < 300);
  for (const a of east) assert.ok(a.vy < 0);
  // leaving recycles them
  g.player.reset(CENTER, CENTER);
  tick(g, 2, DT);
  assert.equal(g.hazards.asteroids.filter((a) => a.active).length, 0);
  const m = gen.blackHoles[0];
  g.save.items.anchor = true;
  g.player.reset(gen.capsule.x, gen.capsule.y + 60);
  tick(g, 60, DT);
  assert.ok(g.hazards.asteroids.some((a) => a.active && a.mode === ASTEROID_MODE.SPIRAL));
  assert.ok(g.hazards.bhProximity > 0.5);
  assert.ok(Math.hypot(g.player.x - m.x, g.player.y - m.y) > m.horizon);
});

test('HUD flags: gravity critical near the Maelström without the anchor; storm intensity', () => {
  const gen = cachedGen(1);
  const m = gen.blackHoles[0];
  const g = fakeGame({ gen });
  g.player.reset(m.x, m.y + 450);
  tick(g, 1, DT);
  assert.equal(g.hazards.gravCritical, true);
  const g2 = fakeGame({ gen });
  g2.save.items.anchor = true;
  g2.player.reset(m.x, m.y + 450);
  tick(g2, 1, DT);
  assert.equal(g2.hazards.gravCritical, false);
  const g3 = fakeGame({ gen });
  g3.player.reset(CENTER + BOUNDARY.r, CENTER);
  tick(g3, 1, DT);
  assert.ok(Math.abs(g3.hazards.stormIntensity - 0.5) < 0.02);
  assert.equal(g3.hazards.inStorm, false);
});
