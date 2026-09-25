import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld } from '../../src/worldgen.js';
import { TILES, TILE_ID, SOLID } from '../../src/tiles.js';
import {
  WORLD_W, WORLD_H, SURFACE_Y, BEDROCK_COLS, BEDROCK_ROWS, LAYERS, TILE, PLAYER, ENEMY_SPAWN_RULES, WORLDGEN,
} from '../../src/config.js';

const SEEDS = [1, 42, 1337, 2024, 99999, 'gouffre', 3141592653];
const gens = new Map(SEEDS.map((s) => [s, generateWorld(s)]));

for (const seed of SEEDS) {
  const { world, spawns, chests, camp, arena } = gens.get(seed);

  test(`[${seed}] dimensions and bedrock borders`, () => {
    assert.equal(world.w, WORLD_W);
    assert.equal(world.h, WORLD_H);
    for (let ty = 0; ty < WORLD_H; ty++) {
      for (let tx = 0; tx < BEDROCK_COLS; tx++) {
        assert.equal(world.get(tx, ty), TILE_ID.BEDROCK, `left border ${tx},${ty}`);
        assert.equal(world.get(WORLD_W - 1 - tx, ty), TILE_ID.BEDROCK, `right border ${tx},${ty}`);
      }
    }
    for (let ty = WORLD_H - BEDROCK_ROWS; ty < WORLD_H; ty++) {
      for (let tx = 0; tx < WORLD_W; tx++) assert.equal(world.get(tx, ty), TILE_ID.BEDROCK, `bottom ${tx},${ty}`);
    }
  });

  test(`[${seed}] camp spawn is free and on solid ground, sky above the surface`, () => {
    const x = camp.spawnX - PLAYER.w / 2, y = camp.spawnY - PLAYER.h;
    assert.equal(world.rectSolid(x, y, PLAYER.w, PLAYER.h), false, 'player box free');
    assert.ok(world.isSolid(Math.floor(camp.spawnX / TILE), Math.floor(camp.spawnY / TILE)), 'ground under feet');
    // flat camp ground and open sky over the camp
    for (let tx = WORLDGEN.campFlatX0; tx <= WORLDGEN.campFlatX1; tx++) {
      if (tx >= camp.shaft.x0 && tx <= camp.shaft.x1) continue;
      assert.ok(world.isSolid(tx, SURFACE_Y), `camp ground ${tx}`);
      assert.ok(!world.isSolid(tx, SURFACE_Y - 1), `camp air ${tx}`);
    }
  });

  test(`[${seed}] entry shaft is open`, () => {
    for (let ty = camp.shaft.y0; ty <= camp.shaft.y1; ty++) {
      for (let tx = camp.shaft.x0; tx <= camp.shaft.x1; tx++) assert.ok(!world.isSolid(tx, ty), `shaft ${tx},${ty}`);
    }
    // the headframe beam gives a first grapple anchor above the shaft
    for (let tx = camp.beam.x0; tx <= camp.beam.x1; tx++) assert.equal(world.get(tx, camp.beam.y), TILE_ID.BEAM);
  });

  test(`[${seed}] every layer contains its ores`, () => {
    for (const L of LAYERS) {
      for (const ore of L.ores) {
        const id = TILE_ID[ore.toUpperCase()];
        let n = 0;
        for (let ty = SURFACE_Y + L.d0; ty <= SURFACE_Y + L.d1; ty++) for (let tx = 0; tx < WORLD_W; tx++) if (world.get(tx, ty) === id) n++;
        assert.ok(n >= WORLDGEN.minOreTiles, `${ore} in ${L.key}: ${n}`);
      }
    }
  });

  test(`[${seed}] enemy spawns are never inside solid tiles and match their layer`, () => {
    assert.ok(spawns.length > 20, 'enough spawns');
    for (const s of spawns) {
      const rule = ENEMY_SPAWN_RULES[s.key];
      assert.ok(rule, `known enemy ${s.key}`);
      for (let j = 0; j < rule.h; j++) {
        for (let i = 0; i < rule.w; i++) {
          const id = world.get(s.tx + i, s.ty - j);
          assert.ok(!SOLID[id] && id !== TILE_ID.LAVA, `${s.key} footprint free at ${s.tx + i},${s.ty - j}`);
        }
      }
      if (rule.anchor === 'floor') for (let i = 0; i < rule.w; i++) assert.ok(world.isSolid(s.tx + i, s.ty + 1), `${s.key} floor`);
      if (rule.anchor === 'ceiling') assert.ok(world.isSolid(s.tx, s.ty - 1), `${s.key} ceiling`);
      const L = LAYERS[s.layer];
      assert.ok(s.key in L.enemies, `${s.key} allowed in layer ${L.key}`);
      assert.ok(s.depth >= WORLDGEN.minSpawnDepth, 'not in the camp');
    }
    for (const L of LAYERS.slice(0, 4)) assert.ok(spawns.some((s) => s.layer === L.index), `spawns in ${L.key}`);
  });

  test(`[${seed}] boss arena is present with the Guardian inside`, () => {
    let open = 0, total = 0;
    for (let ty = arena.y0; ty <= arena.y1; ty++) for (let tx = arena.x0; tx <= arena.x1; tx++) { total++; if (!world.isSolid(tx, ty)) open++; }
    assert.ok(open / total > 0.85, 'arena mostly open');
    assert.ok(arena.y0 - SURFACE_Y >= LAYERS[4].d0, 'arena in the Heart');
    for (let ty = arena.outer.y0; ty <= arena.outer.y1; ty++) assert.equal(world.get(arena.outer.x0, ty), TILE_ID.ARENA, 'left wall');
    for (let tx = arena.x0; tx <= arena.x1; tx++) assert.ok(world.isSolid(tx, arena.y1 + 1), 'floor');
    const g = spawns.filter((s) => s.key === 'guardian');
    assert.equal(g.length, 1);
    assert.ok(g[0].tx >= arena.x0 && g[0].tx + 3 <= arena.x1 && g[0].ty === arena.y1);
    // the entrance through the ceiling is open
    for (let tx = arena.entrance.x0; tx <= arena.entrance.x1; tx++) assert.ok(!world.isSolid(tx, arena.outer.y0));
  });

  test(`[${seed}] chests stand on solid floor in open space`, () => {
    assert.ok(chests.length >= 6);
    for (const c of chests) {
      assert.ok(!world.isSolid(c.tx, c.ty) && !world.isSolid(c.tx, c.ty - 1), 'chest space free');
      assert.ok(world.isSolid(c.tx, c.ty + 1), 'chest floor');
      assert.ok(c.kind === 'relic' || c.kind === 'gold');
    }
  });

  test(`[${seed}] layer materials appear at their depth`, () => {
    const countIn = (id, d0, d1) => {
      let n = 0;
      for (let ty = SURFACE_Y + d0; ty <= SURFACE_Y + d1; ty++) for (let tx = 0; tx < WORLD_W; tx++) if (world.get(tx, ty) === id) n++;
      return n;
    };
    assert.ok(countIn(TILE_ID.DIRT, 0, 39) > 500);
    assert.ok(countIn(TILE_ID.BRICK, 40, 99) > 60, 'catacomb rooms');
    assert.ok(countIn(TILE_ID.GRANITE, 100, 179) > 500);
    assert.ok(countIn(TILE_ID.CRYSTAL, 100, 179) > 5, 'geode crystals');
    assert.ok(countIn(TILE_ID.BASALT, 180, 259) > 500);
    assert.ok(countIn(TILE_ID.LAVA, 180, 259) > 20, 'lava lakes');
    assert.equal(countIn(TILE_ID.LAVA, 0, 179), 0, 'no lava above the abyss');
  });
}

test('generation is deterministic for a given seed', () => {
  const a = generateWorld(777), b = generateWorld(777);
  assert.deepEqual(a.world.types, b.world.types);
  assert.deepEqual(a.world.back, b.world.back);
  assert.deepEqual(a.spawns, b.spawns);
  assert.deepEqual(a.chests, b.chests);
  const c = generateWorld(778);
  assert.notDeepEqual(a.world.types, c.world.types);
});

test('tile registry follows the design (hp / tier / ores)', () => {
  const T = (k) => TILES[TILE_ID[k]];
  assert.deepEqual([T('DIRT').hp, T('DIRT').tier], [1, 0]);
  assert.deepEqual([T('CLAY').hp, T('STONE').hp, T('BRICK').tier, T('GRANITE').tier, T('BASALT').tier], [2, 4, 1, 2, 3]);
  assert.equal(T('BEDROCK').hp, Infinity);
  for (const t of TILES.filter((d) => d.ore)) {
    const host = TILES.find((d) => d.key === t.host);
    assert.equal(t.hp, host.hp + 1, `${t.key} hp`);
    assert.equal(t.tier, host.tier, `${t.key} tier`);
    assert.ok(t.value > 0 && t.drop === 'ore:' + t.key);
  }
  assert.ok(T('LAVA').hazard > 0 && !T('LAVA').solid && T('LAVA').light > 0);
});

// Regression: the boss-arena vestibule used to be carved after sealLava(), leaving
// lava hanging over / beside open air in ~1/3 of seeds (e.g. 2654435761).
test('lava never touches open space sideways or below (40 seeds)', () => {
  const seeds = [2654435761, ...Array.from({ length: 39 }, (_, i) => ((i + 1) * 2654435761) >>> 0)];
  for (const seed of seeds) {
    const { world } = generateWorld(seed);
    for (let ty = 0; ty < WORLD_H; ty++) {
      for (let tx = 0; tx < WORLD_W; tx++) {
        if (world.get(tx, ty) !== TILE_ID.LAVA) continue;
        for (const [nx, ny] of [[tx - 1, ty], [tx + 1, ty], [tx, ty + 1]]) {
          const id = world.get(nx, ny);
          assert.ok(SOLID[id] || id === TILE_ID.LAVA, `[${seed}] lava ${tx},${ty} exposed to ${TILES[id].key} at ${nx},${ny}`);
        }
      }
    }
  }
});
