import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TILE_ID, TILES } from '../../src/tiles.js';
import { TILE_REGEN_DELAY, CHUNK } from '../../src/config.js';
import { worldFrom } from './helpers.mjs';

const rows = ['XXXXXX', 'X#BD.X', 'XXXXXX'];

test('damage accumulates and breaks a tile at its hp', () => {
  const w = worldFrom(rows);
  const v0 = w.version, c0 = w.chunkVersion[0];
  for (let i = 0; i < TILES[TILE_ID.STONE].hp - 1; i++) {
    const r = w.damageTile(1, 1, 1, 0);
    assert.equal(r.hit, true); assert.equal(r.broken, false);
  }
  assert.equal(w.crackStage(1, 1), 3);
  const r = w.damageTile(1, 1, 1, 0);
  assert.equal(r.broken, true);
  assert.equal(r.tileId, TILE_ID.STONE);
  assert.equal(w.get(1, 1), TILE_ID.AIR);
  assert.ok(w.version > v0, 'version bumped');
  assert.ok(w.chunkVersion[0] > c0, 'chunk marked dirty');
});

test('tier gates damage ("Trop dur !") and bedrock is indestructible', () => {
  const w = worldFrom(rows);
  const r = w.damageTile(2, 1, 5, 0);
  assert.equal(r.tooHard, true); assert.equal(r.hit, false);
  assert.equal(w.damage[w.idx(2, 1)], 0);
  const r2 = w.damageTile(2, 1, 5, 1);
  assert.equal(r2.broken, true);
  const b = w.damageTile(0, 0, 999, 99);
  assert.equal(b.tooHard, true);
  assert.equal(w.get(0, 0), TILE_ID.BEDROCK);
  assert.equal(w.damageTile(4, 1, 1, 0).hit, false, 'air is not damageable');
  assert.equal(w.damageTile(-5, 1, 1, 0).tooHard, true, 'out of bounds acts as bedrock');
});

test('unfinished damage heals after the regen delay', () => {
  const w = worldFrom(rows);
  w.damageTile(1, 1, 2, 0);
  assert.equal(w.damaged.length, 1);
  w.update(TILE_REGEN_DELAY - 0.5);
  assert.equal(w.damage[w.idx(1, 1)], 2);
  w.damageTile(1, 1, 1, 0); // a new hit resets the timer
  w.update(TILE_REGEN_DELAY - 0.1);
  assert.equal(w.damage[w.idx(1, 1)], 3);
  w.update(0.2);
  assert.equal(w.damage[w.idx(1, 1)], 0);
  assert.equal(w.damaged.length, 0);
  assert.equal(w.get(1, 1), TILE_ID.STONE);
});

test('set() dirties neighbouring chunks on chunk edges and tracks sky columns', () => {
  const w = worldFrom(Array.from({ length: CHUNK * 2 }, () => '#'.repeat(CHUNK * 2)));
  const before = Array.from(w.chunkVersion);
  w.set(CHUNK - 1, 3, TILE_ID.AIR); // right edge of chunk 0 -> chunk 1 dirty too
  assert.ok(w.chunkVersion[0] > before[0] && w.chunkVersion[1] > before[1]);
  assert.equal(w.chunkVersion[2], before[2]);
  const w2 = worldFrom(['...', '.#.', '###']);
  assert.equal(w2.skyTop[1], 1);
  w2.set(1, 1, TILE_ID.AIR);
  assert.equal(w2.skyTop[1], 2);
  assert.equal(w2.isSolid(-1, 0), true);
  assert.equal(w2.rectSolid(0, 0, 16, 16), false);
  assert.equal(w2.rectSolid(0, 20, 16, 16), true);
});

test('breaking a support tile clears decorations that hung from / stood on it', () => {
  const w = worldFrom(['#####', '#####', '#...#', '#...#', '#####']);
  w.set(1, 2, TILE_ID.ROOTS);       // hangs from (1,1)
  w.set(2, 2, TILE_ID.STALACTITE);  // hangs from (2,1)
  w.set(3, 3, TILE_ID.STALAGMITE);  // stands on (3,4)
  w.set(3, 2, TILE_ID.COBWEB);      // clings to (3,1) and (4,2)
  // break the roots' support
  let r; do { r = w.damageTile(1, 1, 99, 9); } while (!r.broken);
  const cleared = [];
  assert.equal(w.clearDetachedDeco(1, 1, (x, y, id) => cleared.push([x, y, id])), 1);
  assert.deepEqual(cleared, [[1, 2, TILE_ID.ROOTS]]);
  assert.equal(w.get(1, 2), TILE_ID.AIR);
  assert.equal(w.get(2, 2), TILE_ID.STALACTITE, 'neighbour still supported');
  // the floor under the stalagmite
  w.set(3, 4, TILE_ID.AIR);
  w.clearDetachedDeco(3, 4);
  assert.equal(w.get(3, 3), TILE_ID.AIR);
  // cobweb keeps hanging while one side still holds it
  w.set(3, 1, TILE_ID.AIR);
  assert.equal(w.clearDetachedDeco(3, 1), 0);
  assert.equal(w.get(3, 2), TILE_ID.COBWEB);
  w.set(4, 2, TILE_ID.AIR);
  w.clearDetachedDeco(4, 2);
  assert.equal(w.get(3, 2), TILE_ID.AIR, 'web falls once nothing solid touches it');
});
