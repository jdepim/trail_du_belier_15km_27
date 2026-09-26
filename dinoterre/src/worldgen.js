// Deterministic open-world generation: biome layout → height map → materials → water → trees → fossils.
import { WORLD_W, WORLD_H, SURFACE_BASE, WATER_LEVEL, SPAWN_TX } from './config.js';
import { TILE_ID } from './tiles.js';
import { World } from './world.js';
import { Rng, makeNoise1D, clamp, lerp } from './rng.js';
import { BIOMES, BIOME_RING } from './data/biomes.js';

const START_HALF = 45;   // half-width of the starting plain [tiles]
const EDGE = 8;          // wall thickness at the world borders
const BLEND = 14;        // tiles over which neighbouring biomes blend their heights

/** Biome id of each column: a calm plain in the middle, then BIOME_RING outwards on both sides. */
function layoutBiomes(w, rng) {
  const cols = new Array(w).fill('plaine');
  const bounds = [];   // [{from, to, id}]
  bounds.push({ from: SPAWN_TX - START_HALF, to: SPAWN_TX + START_HALF, id: 'plaine' });
  for (const dir of [1, -1]) {
    let x = dir > 0 ? SPAWN_TX + START_HALF : SPAWN_TX - START_HALF;
    let i = 0;
    while (dir > 0 ? x < w : x > 0) {
      const id = BIOME_RING[i % BIOME_RING.length];
      const len = rng.int(70, 130);
      const a = dir > 0 ? x : x - len, b = dir > 0 ? x + len : x;
      bounds.push({ from: a, to: b, id });
      x += dir * len;
      i++;
    }
  }
  for (const s of bounds) for (let x = Math.max(0, s.from); x < Math.min(w, s.to); x++) cols[x] = s.id;
  return cols;
}

export function generateWorld(seed = 1, w = WORLD_W, h = WORLD_H) {
  const rng = new Rng(seed);
  const noise = makeNoise1D(seed);
  const world = new World(w, h);
  world.seed = seed;
  world.biome = layoutBiomes(w, rng);

  // --- height map (blend offset/amp with neighbours so borders are not all cliffs)
  const heights = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let off = 0, amp = 0, freq = 0, wsum = 0;
    for (let d = -BLEND; d <= BLEND; d += 2) {
      const b = BIOMES[world.biome[clamp(x + d, 0, w - 1)]];
      const k = 1 - Math.abs(d) / (BLEND + 1);
      off += b.offset * k; amp += b.amp * k; freq += b.freq * k; wsum += k;
    }
    off /= wsum; amp /= wsum; freq /= wsum;
    let hgt = off + noise(x * freq, 3) * amp;
    const own = BIOMES[world.biome[x]];
    if (own.terrace) hgt = Math.round(hgt / own.terrace) * own.terrace;
    heights[x] = hgt;
  }
  // flat, safe start
  for (let x = SPAWN_TX - 8; x <= SPAWN_TX + 8; x++) heights[x] = lerp(heights[x], 1, 1 - Math.abs(x - SPAWN_TX) / 9);

  for (let x = 0; x < w; x++) {
    let s = Math.round(SURFACE_BASE - heights[x]);
    const edgeDist = Math.min(x, w - 1 - x);
    if (edgeDist < EDGE) s = 4;                         // world border walls
    world.surface[x] = clamp(s, 4, h - 12);
  }

  // --- materials
  for (let x = 0; x < w; x++) {
    const b = BIOMES[world.biome[x]];
    const s = world.surface[x];
    const edge = Math.min(x, w - 1 - x) < EDGE;
    const topSoil = rng.int(3, 5);
    for (let y = s; y < h; y++) {
      let id;
      if (edge || y >= h - 2) id = TILE_ID.bedrock;
      else if (y === s) id = TILE_ID[s >= WATER_LEVEL ? (b.top === 'grass' ? 'sand' : b.top) : b.top];
      else if (y < s + topSoil) id = TILE_ID[b.fill];
      else id = b.fill === 'redrock' ? TILE_ID.redrock : TILE_ID.stone;
      world.tiles[y * w + x] = id;
    }
    // --- water: every air cell at or below the water line
    for (let y = WATER_LEVEL; y < s; y++) world.tiles[y * w + x] = TILE_ID.water;
  }

  // --- trees (trunks are climbable, canopies are one-way platforms)
  let lastTree = -10;
  for (let x = EDGE + 2; x < w - EDGE - 2; x++) {
    const b = BIOMES[world.biome[x]];
    const s = world.surface[x];
    if (!b.trees || s >= WATER_LEVEL || x - lastTree < 5) continue;
    if (Math.abs(x - SPAWN_TX) < 4) continue;
    if (world.surface[x - 1] !== s || world.surface[x + 1] !== s) continue;
    if (!rng.chance(b.trees)) continue;
    const th = rng.int(b.treeH[0], b.treeH[1]);
    for (let y = s - 1; y >= s - th && y > 1; y--) world.tiles[y * w + x] = TILE_ID.trunk;
    const top = s - th;
    const rw = rng.int(2, 3);
    for (let dy = -2; dy <= 0; dy++) {
      const half = dy === -2 ? rw - 1 : rw;
      for (let dx = -half; dx <= half; dx++) {
        const tx = x + dx, ty = top + dy;
        if (ty > 0 && world.get(tx, ty) === TILE_ID.air) world.tiles[ty * w + tx] = TILE_ID.leaves;
      }
    }
    // a lower branch on tall trees
    if (th >= 10) {
      const by = s - Math.floor(th / 2), dir = rng.chance(0.5) ? 1 : -1;
      for (let dx = 1; dx <= 3; dx++) if (world.get(x + dir * dx, by) === TILE_ID.air) world.tiles[by * w + x + dir * dx] = TILE_ID.leaves;
    }
    lastTree = x;
  }

  // --- fossils (bone piles)
  for (let x = EDGE + 2; x < w - EDGE - 2; x++) {
    const b = BIOMES[world.biome[x]];
    if (Math.abs(x - SPAWN_TX) < 10) continue;
    if (world.surface[x] < WATER_LEVEL && rng.chance(b.bones)) {
      world.bonePiles.push({ tx: x, ty: world.surface[x] - 1 });
      x += 12;
    }
  }
  // one guaranteed pile close to the start, to teach harvesting
  const px = SPAWN_TX + 14;
  world.bonePiles.push({ tx: px, ty: world.surface[px] - 1 });

  world.spawn = { tx: SPAWN_TX, ty: world.surface[SPAWN_TX] - 1 };
  world.version++;
  return world;
}
