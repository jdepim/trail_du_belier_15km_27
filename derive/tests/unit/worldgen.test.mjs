import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld } from '../../src/worldgen.js';
import { STRUCTURES, LEGEND, planCells, planSize } from '../../src/structures.js';
import { TILE_ID, SOLID, TILES } from '../../src/tiles.js';
import { TILE, POIS, CENTER, BOUNDARY, PLAYER, ZONE_ID, WORLD_TILES } from '../../src/config.js';
import { gravityAt } from '../../src/physics.js';
import { heatField } from '../../src/hazards.js';
import { LOG_KEYS } from '../../src/meta.js';
import { buildGrid, flood } from '../../tools/solver.mjs';
import { cachedGen } from './helpers.mjs';

const N = WORLD_TILES;
const gen = cachedGen(1);

test('plans only use legend characters and match their items / logs lists', () => {
  const allLogs = [];
  for (const key of Object.keys(STRUCTURES)) {
    const s = STRUCTURES[key];
    for (const row of s.rows) for (const ch of row) assert.ok(LEGEND[ch], `${key}: unknown char '${ch}'`);
    assert.equal(planCells(key, 'P').length, s.items.length, `${key}: one item per pad`);
    assert.equal(planCells(key, 'T').length, s.logs.length, `${key}: one log per terminal`);
    allLogs.push(...s.logs);
  }
  assert.deepEqual([...allLogs].sort(), [...LOG_KEYS].sort(), 'every log sits on exactly one terminal');
  assert.equal(planCells('albatros', 'X').length, 1, 'one spawn');
  assert.equal(planCells('albatros', 'B').length, 1, 'one workbench');
  assert.equal(planCells('ulysse', 'A').length, 1, 'one capsule hatch');
  const { w, h } = planSize('orion');
  assert.ok(w >= 60 && h >= 36, 'Orion is the big station');
});

test('every POI and record exists at the fixed macro layout', () => {
  for (const p of POIS) {
    const g = gen.pois.find((q) => q.key === p.key);
    assert.ok(g, `poi ${p.key}`);
    if (p.key !== 'tycho') assert.deepEqual([g.x, g.y], [p.x, p.y], `${p.key} at its fixed position`);
  }
  for (const key of ['albatros', 'colibri', 'orion', 'helios', 'ulysse', 'mistral']) {
    const b = gen.structures[key], p = POIS.find((q) => q.key === key);
    assert.ok(p.x > b.x0 && p.x < b.x1 && p.y > b.y0 && p.y < b.y1, `${key} stamped around its POI`);
  }
  assert.deepEqual(gen.items.map((i) => i.key).sort(), ['anchor', 'explosives', 'heatshield', 'keycard']);
  assert.equal(gen.satellites.length, 6);
  assert.equal(gen.doors.length, 3, 'three Orion entrances');
  assert.equal(gen.turrets.length, 3);
  assert.equal(gen.lasers.length, 3);
  assert.equal(gen.vents.length, 4);
  assert.equal(gen.terminals.length, LOG_KEYS.length);
  assert.ok(gen.crates.length >= 25, `${gen.crates.length} crates`);
  assert.equal(gen.refills.length, 1);
  assert.equal(gen.lockers.length, 1);
  assert.ok(gen.workbench && gen.capsule && gen.dock && gen.rubble);
  for (const v of gen.vents) assert.equal(Math.abs(v.dirX) + Math.abs(v.dirY), 1);
  for (const l of gen.lasers) assert.ok(Math.hypot(l.x1 - l.x0, l.y1 - l.y0) >= 3 * TILE - 1e-6, 'laser spans a 3-tile corridor');
  // heat shield in the moon, anchor between the suns, capsule close to the Maelström
  const hs = gen.items.find((i) => i.key === 'heatshield');
  assert.ok(Math.hypot(hs.x - gen.moon.x, hs.y - gen.moon.y) < gen.moon.r * 0.5);
  const an = gen.items.find((i) => i.key === 'anchor');
  assert.ok(Math.abs(Math.hypot(an.x - gen.suns[0].x, an.y - gen.suns[0].y) - Math.hypot(an.x - gen.suns[1].x, an.y - gen.suns[1].y)) < 16);
  const m = gen.blackHoles[0];
  const dCap = Math.hypot(gen.capsule.x - m.x, gen.capsule.y - m.y);
  assert.ok(dCap > 300 && dCap < 400, `capsule ${dCap} px from the Maelström`);
});

test('spawn is free and inside the dock; key items stand on open tiles', () => {
  const w = gen.world;
  assert.equal(w.circleSolid(gen.spawn.x, gen.spawn.y, PLAYER.radius + 2), false);
  const d = gen.dock;
  assert.ok(gen.spawn.x > d.x0 && gen.spawn.x < d.x1 && gen.spawn.y > d.y0 && gen.spawn.y < d.y1);
  assert.equal(w.zoneAt(gen.spawn.x, gen.spawn.y), ZONE_ID.albatros);
  for (const it of gen.items) {
    assert.equal(w.isSolidAt(it.x, it.y), false, `${it.key} on a free tile`);
    assert.equal(w.get(it.tx, it.ty), TILE_ID.PAD);
  }
  for (const list of [gen.terminals, gen.crates, gen.refills, gen.lockers, gen.pickups, gen.caches, gen.turrets]) {
    for (const r of list) assert.equal(w.isSolidAt(r.x, r.y), false, `${r.id} on a free tile`);
  }
});

/** Loose flood (every non-solid tile, 8 neighbours) from `start`, bounded to a box of tiles. */
function looseFlood(world, start, box) {
  const seen = new Uint8Array(N * N);
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const i = stack.pop();
    const x = i % N, y = (i / N) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < box.x0 || ny < box.y0 || nx > box.x1 || ny > box.y1) continue;
      const j = ny * N + nx;
      if (seen[j] || SOLID[world.types[j]]) continue;
      seen[j] = 1;
      stack.push(j);
    }
  }
  return seen;
}

function sealedCheck(zone, bounds, margin, maxX = Infinity) {
  const w = gen.world;
  const box = { x0: Math.floor(bounds.x0 / TILE) - margin, y0: Math.floor(bounds.y0 / TILE) - margin, x1: Math.ceil(bounds.x1 / TILE) + margin, y1: Math.ceil(bounds.y1 / TILE) + margin };
  const start = box.y0 * N + box.x0;
  assert.equal(SOLID[w.types[start]], 0, 'flood starts in open space');
  const seen = looseFlood(w, start, box);
  let inside = 0, leaked = 0;
  for (let ty = box.y0; ty <= box.y1; ty++) for (let tx = box.x0; tx <= box.x1; tx++) {
    const i = ty * N + tx;
    if (w.interior[i] !== zone || SOLID[w.types[i]] || tx * TILE >= maxX) continue;
    inside++;
    if (seen[i]) leaked++;
  }
  return { inside, leaked };
}

test('Orion is closed: its keycard doors are the only way in', () => {
  const r = sealedCheck(ZONE_ID.orion, gen.structures.orion, 6);
  assert.ok(r.inside > 1000, `${r.inside} interior tiles`);
  assert.equal(r.leaked, 0, 'no interior tile reachable from outside with the doors closed');
});

test('the rubble plug is the only way into the Tycho gallery', () => {
  const m = gen.moon;
  const bounds = { x0: m.x - m.r - 40, y0: m.y - m.r - 40, x1: m.x + m.r + 40, y1: m.y + m.r + 40 };
  // the mouth east of the plug is part of the gallery zone but lies outside the seal
  const r = sealedCheck(ZONE_ID.tycho, bounds, 2, gen.rubble.x0);
  assert.ok(r.inside > 500, `${r.inside} gallery tiles`);
  assert.equal(r.leaked, 0);
  // the plug spans the whole tunnel: rock above and below it
  const rb = gen.rubble;
  const w = gen.world;
  for (let tx = rb.x0 / TILE; tx < rb.x1 / TILE; tx++) {
    assert.equal(SOLID[w.get(tx, rb.y0 / TILE - 1)], 1);
    assert.equal(SOLID[w.get(tx, rb.y1 / TILE)], 1);
  }
  // and the mouth outside the plug is open to space
  assert.equal(w.isSolidAt(rb.x1 + 60, rb.y), false);
});

test('no solid tile in a black-hole horizon or a sun core; satellites are outside deadly zones', () => {
  const w = gen.world;
  const bodies = [...gen.blackHoles.map((b) => ({ x: b.x, y: b.y, r: b.horizon })), ...gen.suns.map((s) => ({ x: s.x, y: s.y, r: s.coreR }))];
  for (const b of bodies) {
    for (let ty = Math.floor((b.y - b.r) / TILE); ty <= Math.floor((b.y + b.r) / TILE); ty++) {
      for (let tx = Math.floor((b.x - b.r) / TILE); tx <= Math.floor((b.x + b.r) / TILE); tx++) {
        if (Math.hypot((tx + 0.5) * TILE - b.x, (ty + 0.5) * TILE - b.y) < b.r) assert.equal(SOLID[w.get(tx, ty)], 0);
      }
    }
  }
  const g = { ax: 0, ay: 0, mag: 0, bh: 0 };
  for (const s of gen.satellites) {
    assert.equal(heatField(w, gen.suns, s.x, s.y), 0, `${s.id} cool`);
    gravityAt(s.x, s.y, gen.gravitySources, g);
    assert.ok(g.mag < PLAYER.thrustAccel * 0.5, `${s.id} gravity ${g.mag}`);
    assert.ok(Math.hypot(s.x - CENTER, s.y - CENTER) < BOUNDARY.r - 300, `${s.id} inside the sector`);
  }
});

test('every interactable record is reachable on the strict grid (corridors wide enough)', () => {
  const items = { keycard: true, explosives: true, heatshield: true, anchor: true };
  const grid = buildGrid(gen, items, 'strict');
  const seen = flood(gen, grid, { allowHeat: true });
  const reached = (x, y, slack) => {
    const c = grid.cell;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const cx = Math.floor(x / c) + dx, cy = Math.floor(y / c) + dy;
      if (seen[cy * grid.n + cx] && Math.hypot((cx + 0.5) * c - x, (cy + 0.5) * c - y) <= slack) return true;
    }
    return false;
  };
  const all = [
    ...gen.items.map((r) => [r, 12]), ...gen.terminals.map((r) => [r, 22]), ...gen.crates.map((r) => [r, 22]),
    ...gen.caches.map((r) => [r, 22]), ...gen.pickups.map((r) => [r, 22]), ...gen.refills.map((r) => [r, 22]),
    ...gen.lockers.map((r) => [r, 22]), ...gen.satellites.map((r) => [r, 28]), ...gen.doors.map((r) => [r, 28]),
    [{ id: 'workbench', ...gen.workbench }, 22], [{ id: 'capsule', ...gen.capsule }, 22],
  ];
  for (const [r, slack] of all) assert.ok(reached(r.x, r.y, slack), `${r.id || r.key} reachable`);
});

test('generation is deterministic; the seed only changes the filling, never the ids', () => {
  const a = generateWorld(12345), b = generateWorld(12345), c = generateWorld(777);
  assert.deepEqual(a.world.types, b.world.types);
  assert.notDeepEqual(a.world.types, c.world.types, 'belt clusters differ');
  const ids = (g) => [...g.crates, ...g.caches, ...g.doors, ...g.terminals, ...g.satellites, ...g.items, ...g.turrets].map((r) => r.id);
  assert.deepEqual(ids(a), ids(c), 'record ids are stable across seeds');
  assert.equal(new Set(ids(a)).size, ids(a).length, 'ids are unique');
  assert.deepEqual(a.spawn, c.spawn);
  assert.deepEqual(a.items, c.items);
  for (const cr of a.crates) assert.ok(cr.value >= 8 && cr.value <= 16);
});

test('the belt holds static asteroid clusters inside its annulus, with fragile fringes', () => {
  const w = gen.world;
  let rock = 0, fragile = 0, outside = 0;
  for (let i = 0; i < w.types.length; i++) {
    const id = w.types[i];
    if (id !== TILE_ID.ASTEROID && id !== TILE_ID.ASTEROID_SMALL && id !== TILE_ID.ICE) continue;
    const x = (i % N + 0.5) * TILE - CENTER, y = (((i / N) | 0) + 0.5) * TILE - CENTER;
    const r = Math.hypot(x, y);
    if (id === TILE_ID.ASTEROID_SMALL) fragile++; else rock++;
    if (r < 1850 || r > 2400) outside++;
  }
  assert.ok(rock + fragile > 800, `${rock + fragile} asteroid tiles`);
  assert.ok(fragile > 100, 'fragile small rocks for the explosives');
  const shelter = outside; // the twin-sun shelter rocks are the only asteroids outside the belt
  assert.ok(shelter < 1200, `${shelter} asteroid tiles outside the belt`);
  assert.ok(TILES[TILE_ID.MOON_DUST] && w.get(Math.floor(gen.moon.x / TILE), Math.floor((gen.moon.y - gen.moon.r + 4) / TILE)) !== TILE_ID.SPACE);
});
