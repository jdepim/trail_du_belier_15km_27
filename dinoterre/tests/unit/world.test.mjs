import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld } from '../../src/worldgen.js';
import { TILE_ID } from '../../src/tiles.js';
import { WATER_LEVEL, SPAWN_TX, TILE } from '../../src/config.js';
import { Game } from '../../src/game.js';
import { BIOMES } from '../../src/data/biomes.js';
import { run } from './helpers.mjs';

test('world generation is deterministic', () => {
  const a = generateWorld(123), b = generateWorld(123), c = generateWorld(124);
  assert.deepEqual(a.tiles, b.tiles);
  assert.notDeepEqual(a.tiles, c.tiles);
});

test('the open world contains every biome, water, trees, cliffs and fossils', () => {
  const w = generateWorld(9);
  const biomes = new Set(w.biome);
  for (const id of Object.keys(BIOMES)) assert.ok(biomes.has(id), id);
  let water = 0, trunks = 0, cliffs = 0;
  for (const t of w.tiles) { if (t === TILE_ID.water) water++; if (t === TILE_ID.trunk) trunks++; }
  for (let x = 1; x < w.w; x++) if (Math.abs(w.surface[x] - w.surface[x - 1]) >= 5) cliffs++;
  assert.ok(water > 500, `water ${water}`);
  assert.ok(trunks > 100, `trunks ${trunks}`);
  assert.ok(cliffs > 10, `cliffs ${cliffs}`);
  assert.ok(w.bonePiles.length > 5);
});

test('the start is dry, flat ground in the plain', () => {
  for (const seed of [1, 2, 3, 99]) {
    const w = generateWorld(seed);
    assert.equal(w.biome[SPAWN_TX], 'plaine');
    assert.ok(w.surface[SPAWN_TX] < WATER_LEVEL);
    assert.ok(w.isSolid(w.spawn.tx, w.spawn.ty + 1));
    assert.ok(!w.isSolid(w.spawn.tx, w.spawn.ty));
  }
});

test('a full game runs for 3 minutes with spawns and night without errors', () => {
  const g = new Game({ seed: 5, species: 'robuste' });
  g.input.setAxis({ x: 1, y: 0 });
  let saw = new Set();
  run(g, 180, (i) => {
    if (i % 60 === 0) {
      for (const c of g.creatures) saw.add(c.def.id);
      if (!g.player.alive) return;
      if (i % 120 === 0) g.input.press('jump'); else g.input.release('jump');
      if (i % 30 === 0) g.input.press('attack'); else g.input.release('attack');
    }
  });
  assert.ok(saw.size >= 2, `creatures seen: ${[...saw]}`);
  assert.ok(g.clock > 180);
});

test('save → load round trip keeps buildings, resources, allies and position', () => {
  const g = new Game({ seed: 11, species: 'agile', spawnCreatures: false });
  g.inventory.addAll({ skin: 20, bone: 20, meat: 3 });
  run(g, 0.5);
  g.builder.start('tente');
  assert.ok(g.builder.place(), g.builder.validate().reason);
  g.builder.start('palissade');
  g.player.facing = -1;
  assert.ok(g.builder.place(), g.builder.validate().reason);
  const data = JSON.parse(JSON.stringify(g.save()));
  const h = new Game({ save: data, spawnCreatures: false });
  assert.equal(h.player.species.id, 'agile');
  assert.equal(h.structures.length, 1);
  assert.equal(h.respawnPoint, h.structures[0]);
  assert.equal(h.inventory.count('skin'), g.inventory.count('skin'));
  assert.equal(h.builtTiles.length, 3);
  for (const t of g.builtTiles) assert.equal(h.world.get(t.tx, t.ty), TILE_ID.bonewall);
  assert.ok(Math.abs(h.player.x - g.player.x) < 1);
});
