import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, DIRTY_LOG } from '../../src/world.js';
import { TILE_ID, TILES, SOLID, FRAGILE } from '../../src/tiles.js';
import { TILE, CHUNK, WORLD_TILES } from '../../src/config.js';
import { worldFrom, ORIGIN, px } from './helpers.mjs';

test('tile registry: ids, lookup tables and fragile targets', () => {
  assert.equal(TILE_ID.SPACE, 0);
  assert.equal(SOLID[TILE_ID.HULL], 1);
  assert.equal(SOLID[TILE_ID.FLOOR], 0);
  assert.equal(SOLID[TILE_ID.DOOR_LOCKED], 1);
  assert.equal(SOLID[TILE_ID.DOOR_OPEN], 0);
  assert.equal(SOLID[TILE_ID.WINDOW], 1);
  assert.equal(FRAGILE[TILE_ID.RUBBLE], 1);
  assert.equal(FRAGILE[TILE_ID.ASTEROID_SMALL], 1);
  assert.equal(FRAGILE[TILE_ID.ASTEROID], 0);
  assert.equal(FRAGILE[TILE_ID.HULL], 0);
  assert.equal(TILES[TILE_ID.RUBBLE].breaksToId, TILE_ID.MOON_FLOOR);
  assert.equal(TILES[TILE_ID.ASTEROID_SMALL].breaksToId, TILE_ID.SPACE);
  for (const t of TILES) assert.equal(t.colors.length, 4, `${t.key} has a 4-colour ramp`);
});

test('runtime changes are logged as persistent mods and re-applied on a fresh world', () => {
  const w = new World(64, 64);
  w.setRaw(3, 3, TILE_ID.DOOR_LOCKED);
  w.finalize();
  assert.equal(w.mods.size, 0, 'worldgen writes are not mods');
  const v0 = w.version, c0 = w.chunkVersion[0];
  w.set(3, 3, TILE_ID.DOOR_OPEN);
  w.set(10, 12, TILE_ID.HULL);
  w.set(10, 12, TILE_ID.HULL); // no-op
  assert.ok(w.version > v0);
  assert.ok(w.chunkVersion[0] > c0, 'chunk dirty');
  const mods = w.exportMods();
  assert.deepEqual(mods.sort((a, b) => a[0] - b[0]), [[3 * 64 + 3, TILE_ID.DOOR_OPEN], [12 * 64 + 10, TILE_ID.HULL]]);
  const w2 = new World(64, 64);
  w2.setRaw(3, 3, TILE_ID.DOOR_LOCKED);
  w2.finalize();
  const n = w2.applyMods([...mods, 'junk', [-1, 2], [5, 999], [1.5, 1], [99999999, 1]]);
  assert.equal(n, 2, 'invalid entries skipped');
  assert.equal(w2.get(3, 3), TILE_ID.DOOR_OPEN);
  assert.equal(w2.get(10, 12), TILE_ID.HULL);
  assert.equal(w2.exportMods().length, 2, 'applied mods stay logged for the next save');
  assert.equal(w2.applyMods(null), 0);
});

test('dirty log ring records changed tiles; edge tiles bump neighbour chunks', () => {
  const w = new World(CHUNK * 3, CHUNK * 3);
  w.finalize();
  const before = w.chunkVersion.slice();
  w.set(CHUNK, CHUNK + 5, TILE_ID.HULL); // left edge of chunk (1, 1)
  assert.equal(w.dirtyCount, 1);
  assert.equal(w.dirtyLog[0], (CHUNK + 5) * w.w + CHUNK);
  assert.ok(w.chunkVersion[1 * 3 + 1] > before[1 * 3 + 1]);
  assert.ok(w.chunkVersion[1 * 3 + 0] > before[1 * 3 + 0], 'neighbour on the left bumped');
  for (let i = 0; i < DIRTY_LOG + 5; i++) w.set(i % w.w, 2 + ((i / w.w) | 0), TILE_ID.HULL);
  assert.equal(w.dirtyCount, DIRTY_LOG + 6);
});

test('blast breaks only fragile tiles within the radius', () => {
  const w = worldFrom([
    '#########',
    '#rrr.sss#',
    '#rrr.aaa#',
    '#rrr.sss#',
    '#########',
  ]);
  const cx = px(2), cy = px(2);
  const broken = w.blast(cx, cy, 13);
  const keys = broken.map((b) => TILES[b.id].key);
  assert.ok(broken.length >= 5, `broke ${broken.length}`);
  assert.ok(keys.every((k) => k === 'rubble'), 'only rubble in range');
  assert.equal(w.get(ORIGIN + 2, ORIGIN + 2), TILE_ID.MOON_FLOOR, 'rubble becomes gallery floor');
  assert.equal(w.get(ORIGIN, ORIGIN + 2), TILE_ID.HULL, 'hull survives');
  const b2 = w.blast(px(6), px(2), 20);
  assert.ok(b2.every((b) => b.id === TILE_ID.ASTEROID_SMALL));
  assert.equal(w.get(ORIGIN + 6, ORIGIN + 2), TILE_ID.ASTEROID, 'big asteroid is not fragile');
  assert.equal(w.get(ORIGIN + 6, ORIGIN + 1), TILE_ID.SPACE, 'small asteroid shattered');
  assert.ok(w.mods.size >= broken.length + b2.length, 'blast results are persistent mods');
});

test('solid queries, zones and circle overlap', () => {
  const w = worldFrom(['#ff', '...'], 3);
  assert.equal(w.isSolid(ORIGIN, ORIGIN), true);
  assert.equal(w.isSolid(ORIGIN + 1, ORIGIN), false);
  assert.equal(w.isSolid(-1, 5), true, 'out of bounds is solid');
  assert.equal(w.isSolid(WORLD_TILES, 5), true);
  assert.equal(w.zoneAt(px(1), px(0)), 3);
  assert.equal(w.zoneAt(px(1), px(1)), 0);
  assert.equal(w.circleSolid(px(1), px(0), 5), true, 'touches the hull tile on the left');
  assert.equal(w.circleSolid(px(1) + 1, px(0), 5), false, 'exactly tangent does not count');
  assert.equal(w.circleSolid(px(2), px(1), 3), false);
  assert.equal(w.isSolidAt((ORIGIN + 0.5) * TILE, (ORIGIN + 0.5) * TILE), true);
});
