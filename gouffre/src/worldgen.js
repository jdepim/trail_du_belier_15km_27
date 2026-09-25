// Procedural mine generation (DESIGN.md §3). Deterministic for a given seed.
//
// generateWorld(seed) -> { world, spawns, chests, camp, arena, seed }
//   spawns : [{ key, tx, ty, x, y, anchor, layer, depth }]
//            anchor 'floor'  : (x, y) = centre-bottom of the footprint (feet on the floor)
//            anchor 'ceiling': (x, y) = centre-top (hanging from the ceiling)
//            anchor 'air'    : (x, y) = centre of the footprint
//   chests : [{ tx, ty, x, y, kind: 'relic'|'gold', layer, depth, opened:false }]
//            (x, y) = centre-bottom, the chest stands on tile (tx, ty + 1)
import {
  TILE, WORLD_W, WORLD_H, SURFACE_Y, BEDROCK_COLS, BEDROCK_ROWS,
  LAYERS, layerAtDepth, ENEMY_SPAWN_RULES, WORLDGEN as G,
} from './config.js';
import { createRng, createNoise2D, fbm2D, normalizeSeed } from './rng.js';
import { World } from './world.js';
import { TILE_ID as T, SOLID, BACK } from './tiles.js';

const W = WORLD_W;
const H = WORLD_H;
const rowOf = (d) => SURFACE_Y + d;
const depthOf = (ty) => ty - SURFACE_Y;

/** Natural rock that ores / crystals / lava are allowed to replace. */
const NATURAL = new Uint8Array(256);
for (const k of ['DIRT', 'CLAY', 'STONE', 'GRANITE', 'CRYSTAL_ROCK', 'BASALT', 'OBSIDIAN']) NATURAL[T[k]] = 1;

export function generateWorld(seedInput) {
  const seed = normalizeSeed(seedInput);
  const rng = createRng(seed);
  const world = new World(W, H);
  const ctx = {
    seed, rng, world,
    nWave: createNoise2D(seed ^ 0x51ed),
    nA: createNoise2D(seed ^ 0xa11ce),
    nB: createNoise2D(seed ^ 0xb0b),
    nC: createNoise2D(seed ^ 0xc0ffee),
    nCave: createNoise2D(seed ^ 0xca5e),
    nHill: createNoise2D(seed ^ 0x4111),
    protect: new Uint8Array(W * H), // 1 = structure tile, cave passes must not touch
    rooms: [], geodes: [], lakes: [],
  };

  fillBase(ctx);
  carveCaves(ctx.rng.fork('caves'), ctx);
  carveWorms(ctx.rng.fork('worms'), ctx);
  buildCatacombRooms(ctx.rng.fork('rooms'), ctx);
  buildGeodes(ctx.rng.fork('geodes'), ctx);
  buildLavaLakes(ctx.rng.fork('lava'), ctx);
  const arena = buildArena(ctx);
  crustExposedLava(world); // the arena vestibule is carved after sealLava()
  placeOres(ctx.rng.fork('ores'), ctx);
  placeLifeCrystals(ctx.rng.fork('life'), ctx);
  const camp = buildCamp(ctx);
  placeDecorations(ctx.rng.fork('deco'), ctx);
  applyBedrock(world);
  world.finalize();
  const chests = placeChests(ctx.rng.fork('chests'), ctx);
  const spawns = placeSpawns(ctx.rng.fork('spawns'), ctx, arena, chests);

  return { world, spawns, chests, camp, arena, seed };
}

// ------------------------------------------------------------------ helpers

function get(world, tx, ty) { return world.get(tx, ty); }
function set(world, tx, ty, id) { world.setRaw(tx, ty, id); }
function isAir(world, tx, ty) { return world.inBounds(tx, ty) && world.get(tx, ty) === T.AIR; }
function inner(tx) { return tx >= BEDROCK_COLS && tx < W - BEDROCK_COLS; }

function backForDepth(d) {
  if (d < 0) return BACK.NONE;
  if (d < LAYERS[1].d0) return BACK.SOIL;
  if (d < LAYERS[2].d0) return BACK.STONE;
  if (d < LAYERS[3].d0) return BACK.GRANITE;
  return BACK.BASALT;
}

// ------------------------------------------------------------------ 1. base rock

function fillBase(ctx) {
  const { world, nWave, nA, nB, nC, nHill } = ctx;
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const d = depthOf(ty);
      if (d < 0) { set(world, tx, ty, T.AIR); world.setBackRaw(tx, ty, BACK.NONE); continue; }
      // wavy layer boundaries: effective depth drifts a few tiles
      const ed = d + (fbm2D(nWave, tx * 0.14, ty * 0.09, 2) - 0.5) * 8;
      const a = fbm2D(nA, tx * 0.11, ty * 0.11, 3);
      const b = fbm2D(nB, tx * 0.15, ty * 0.15, 3);
      let id;
      if (ed < 40) {
        const stoneT = 0.75 - Math.max(0, ed) * 0.0035;
        if (b > stoneT) id = T.STONE;
        else if (a > 0.62) id = T.CLAY;
        else id = T.DIRT;
      } else if (ed < 100) {
        const c = fbm2D(nC, tx * 0.3, ty * 0.3, 2);
        if (ed < 47 && a > 0.56) id = T.DIRT;
        else if (c > 0.74) id = T.BONE;
        else id = T.STONE;
      } else if (ed < 180) {
        id = a > 0.61 ? T.CRYSTAL_ROCK : T.GRANITE;
      } else {
        id = b > 0.63 ? T.OBSIDIAN : T.BASALT;
      }
      set(world, tx, ty, id);
      world.setBackRaw(tx, ty, backForDepth(Math.max(0, Math.round(ed))));
    }
  }
  // grass on the surface row
  for (let tx = 0; tx < W; tx++) set(world, tx, SURFACE_Y, T.GRASS);
  // gentle hills rising toward the world edges, outside the flat camp
  for (let tx = BEDROCK_COLS; tx < W - BEDROCK_COLS; tx++) {
    if (tx >= G.campFlatX0 && tx <= G.campFlatX1) continue;
    const distEdge = tx < G.campFlatX0 ? G.campFlatX0 - tx : tx - G.campFlatX1;
    const rise = Math.min(distEdge, 12) * 0.28;
    const h = Math.max(0, Math.round(rise + (nHill(tx * 0.25, 3.7) - 0.5) * 3 - 0.3));
    for (let k = 1; k <= h; k++) {
      const ty = SURFACE_Y - k;
      set(world, tx, ty, k === h ? T.GRASS : T.DIRT);
    }
    if (h > 0) set(world, tx, SURFACE_Y, T.DIRT);
  }
}

// ------------------------------------------------------------------ 2. caves (noise + cellular automaton)

function caveAirProbability(ctx, tx, ty) {
  const d = depthOf(ty);
  if (d < G.caveStartDepth) return 0;
  if (tx >= G.campFlatX0 && tx <= G.campFlatX1 && d < G.campCaveFreeDepth) return 0;
  // interpolate layer openness so it grows smoothly with depth
  const L = layerAtDepth(d);
  const next = LAYERS[Math.min(L.index + 1, 3)];
  const t = Math.min(1, Math.max(0, (d - L.d0) / Math.max(1, L.d1 - L.d0)));
  let p = L.index >= 4 ? 0 : L.caveAir + (next.caveAir - L.caveAir) * t * 0.5;
  p += (fbm2D(ctx.nCave, tx / 9, ty / 9, 2) - 0.5) * G.caveNoiseAmp;
  if (d < G.caveStartDepth + 7) p *= (d - G.caveStartDepth) / 7;
  return p;
}

function carveCaves(rng, ctx) {
  const { world } = ctx;
  const y0 = rowOf(G.caveStartDepth), y1 = G.arena.y0 - 3;
  const x0 = BEDROCK_COLS, x1 = W - BEDROCK_COLS - 1;
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  let wall = new Uint8Array(cw * ch);
  let next = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const p = caveAirProbability(ctx, x0 + i, y0 + j);
      wall[j * cw + i] = rng.next() < p ? 0 : 1;
    }
  }
  for (let it = 0; it < G.caIterations; it++) {
    for (let j = 0; j < ch; j++) {
      for (let i = 0; i < cw; i++) {
        let n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di, jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= cw || jj >= ch) n++;
            else n += wall[jj * cw + ii];
          }
        }
        // forced-solid cells (camp ground, near surface) stay solid
        const forced = caveAirProbability(ctx, x0 + i, y0 + j) <= 0;
        next[j * cw + i] = forced || n >= 5 ? 1 : 0;
      }
    }
    const t = wall; wall = next; next = t;
  }
  // remove tiny pockets (< 6 cells): they read as noise, not caves
  const seen = new Uint8Array(cw * ch);
  const stack = [];
  const region = [];
  for (let s = 0; s < cw * ch; s++) {
    if (wall[s] || seen[s]) continue;
    region.length = 0;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const c = stack.pop();
      region.push(c);
      const ci = c % cw, cj = (c / cw) | 0;
      if (ci > 0) visit(c - 1); if (ci < cw - 1) visit(c + 1);
      if (cj > 0) visit(c - cw); if (cj < ch - 1) visit(c + cw);
    }
    if (region.length < 6) for (const c of region) wall[c] = 1;
  }
  function visit(c) { if (!wall[c] && !seen[c]) { seen[c] = 1; stack.push(c); } }

  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) if (!wall[j * cw + i]) set(world, x0 + i, y0 + j, T.AIR);
  }
}

// ------------------------------------------------------------------ 3. worm tunnels

function carveDisc(ctx, cx, cy, r, minY, maxY) {
  const { world, protect } = ctx;
  const ri = Math.ceil(r);
  for (let dy = -ri; dy <= ri; dy++) {
    for (let dx = -ri; dx <= ri; dx++) {
      if (dx * dx + dy * dy > r * r + 0.3) continue;
      const tx = Math.round(cx) + dx, ty = Math.round(cy) + dy;
      if (tx < BEDROCK_COLS + 1 || tx > W - BEDROCK_COLS - 2 || ty < minY || ty > maxY) continue;
      if (protect[ty * W + tx]) continue;
      set(world, tx, ty, T.AIR);
    }
  }
}

function carveWorms(rng, ctx) {
  for (let li = 0; li < 4; li++) {
    const L = LAYERS[li];
    const minY = rowOf(Math.max(L.d0, G.caveStartDepth + 4));
    const maxY = Math.min(rowOf(L.d1), G.arena.y0 - 4);
    for (let k = 0; k < G.wormsPerLayer[li]; k++) {
      let x = rng.float(6, W - 7), y = rng.float(minY + 2, maxY - 2);
      let ang = rng.chance(0.75) ? rng.float(-0.5, 0.5) + (rng.chance(0.5) ? 0 : Math.PI) : rng.float(0.9, 2.2);
      const len = rng.int(24, 60);
      const r = rng.float(1.05, 1.7);
      for (let s = 0; s < len; s++) {
        carveDisc(ctx, x, y, r, minY, maxY);
        ang += rng.float(-0.35, 0.35);
        x += Math.cos(ang); y += Math.sin(ang) * 0.8;
        if (x < 5 || x > W - 6) { ang = Math.PI - ang; x = Math.min(W - 6, Math.max(5, x)); }
        if (y < minY + 1 || y > maxY - 1) { ang = -ang; y = Math.min(maxY - 1, Math.max(minY + 1, y)); }
      }
    }
  }
}

// ------------------------------------------------------------------ 4. catacomb rooms (layer 2)

function buildCatacombRooms(rng, ctx) {
  const { world, protect, rooms } = ctx;
  const L = LAYERS[1];
  const yMin = rowOf(L.d0) + 4, yMax = rowOf(L.d1) - 4;
  const target = rng.int(G.rooms.min, G.rooms.max);
  for (let attempt = 0; attempt < 80 && rooms.length < target; attempt++) {
    const w = rng.int(G.rooms.wMin, G.rooms.wMax);
    const h = rng.int(G.rooms.hMin, G.rooms.hMax);
    const x0 = rng.int(5, W - 6 - w), y0 = rng.int(yMin, yMax - h);
    const x1 = x0 + w - 1, y1 = y0 + h - 1; // interior
    if (rooms.some((r) => x0 - 4 <= r.x1 && x1 + 4 >= r.x0 && y0 - 4 <= r.y1 && y1 + 4 >= r.y0)) continue;
    rooms.push({ x0, y0, x1, y1 });
  }
  for (const r of rooms) {
    // shell + interior
    for (let ty = r.y0 - 1; ty <= r.y1 + 1; ty++) {
      for (let tx = r.x0 - 1; tx <= r.x1 + 1; tx++) {
        const interior = tx >= r.x0 && tx <= r.x1 && ty >= r.y0 && ty <= r.y1;
        set(world, tx, ty, interior ? T.AIR : T.BRICK);
        world.setBackRaw(tx, ty, BACK.BRICK);
        protect[ty * W + tx] = 1;
      }
    }
    // doorways (3 tall at floor level) + short corridors to the surrounding caves
    const doors = [];
    if (rng.chance(0.8)) doors.push(-1);
    if (rng.chance(0.8) || !doors.length) doors.push(1);
    for (const side of doors) {
      const wx = side < 0 ? r.x0 - 1 : r.x1 + 1;
      for (let ty = r.y1 - 2; ty <= r.y1; ty++) set(world, wx, ty, T.AIR);
      const len = rng.int(3, 9);
      for (let s = 1; s <= len; s++) {
        const tx = wx + side * s;
        if (tx < BEDROCK_COLS + 1 || tx > W - BEDROCK_COLS - 2) break;
        let opened = false;
        for (let ty = r.y1 - 2; ty <= r.y1; ty++) {
          if (protect[ty * W + tx]) continue;
          if (get(world, tx, ty) === T.AIR) opened = true;
          set(world, tx, ty, T.AIR);
        }
        // floor under the corridor so it's walkable
        if (!protect[(r.y1 + 1) * W + tx] && !SOLID[get(world, tx, r.y1 + 1)]) set(world, tx, r.y1 + 1, T.STONE);
        if (opened && s > 2) break;
      }
    }
    // collapsed ceiling
    if (rng.chance(0.35)) {
      const gx = rng.int(r.x0 + 1, r.x1 - 3);
      for (let tx = gx; tx < gx + rng.int(2, 3); tx++) set(world, tx, r.y0 - 1, T.AIR);
    }
    // torches along the back wall, bones on the floor, cobwebs in corners
    const torchRow = r.y0 + 1;
    for (let tx = r.x0 + rng.int(1, 3); tx <= r.x1 - 1; tx += rng.int(5, 7)) set(world, tx, torchRow, T.TORCH);
    for (let tx = r.x0; tx <= r.x1; tx++) {
      if (get(world, tx, r.y1) === T.AIR && rng.chance(0.2)) set(world, tx, r.y1, T.BONES_DECO);
    }
    if (rng.chance(0.7) && get(world, r.x0, r.y0) === T.AIR) set(world, r.x0, r.y0, T.COBWEB);
    if (rng.chance(0.7) && get(world, r.x1, r.y0) === T.AIR) set(world, r.x1, r.y0, T.COBWEB);
    // a hanging brick pillar in wide rooms: nice grapple anchor
    if (r.x1 - r.x0 >= 12 && rng.chance(0.6)) {
      const px = Math.round((r.x0 + r.x1) / 2);
      for (let ty = r.y0; ty <= r.y0 + 1; ty++) set(world, px, ty, T.BRICK);
    }
  }
}

// ------------------------------------------------------------------ 5. crystal geodes (layer 3)

function buildGeodes(rng, ctx) {
  const { world, protect, geodes } = ctx;
  const L = LAYERS[2];
  const count = rng.int(G.geodes.min, G.geodes.max);
  for (let attempt = 0; attempt < 60 && geodes.length < count; attempt++) {
    const rx = rng.int(4, 7), ry = rng.int(3, 5);
    const cx = rng.int(4 + rx + 2, W - 5 - rx - 2);
    const cy = rng.int(rowOf(L.d0) + ry + 3, rowOf(L.d1) - ry - 3);
    if (geodes.some((g) => Math.abs(g.cx - cx) < g.rx + rx + 4 && Math.abs(g.cy - cy) < g.ry + ry + 4)) continue;
    geodes.push({ cx, cy, rx, ry });
  }
  for (const g of geodes) {
    const shell = 1 + 1.8 / Math.min(g.rx, g.ry);
    const interior = [];
    for (let ty = g.cy - g.ry - 3; ty <= g.cy + g.ry + 3; ty++) {
      for (let tx = g.cx - g.rx - 3; tx <= g.cx + g.rx + 3; tx++) {
        const nx = (tx - g.cx) / g.rx, ny = (ty - g.cy) / g.ry;
        const nd = Math.sqrt(nx * nx + ny * ny);
        if (nd <= 1) {
          set(world, tx, ty, T.AIR);
          world.setBackRaw(tx, ty, BACK.CRYSTAL);
          interior.push([tx, ty]);
          protect[ty * W + tx] = 1;
        } else if (nd <= shell) {
          set(world, tx, ty, rng.chance(0.2) ? T.AMETHYST : T.CRYSTAL_ROCK);
          world.setBackRaw(tx, ty, BACK.CRYSTAL);
          protect[ty * W + tx] = 1;
        }
      }
    }
    // line the inner surface with glowing crystal clusters, keep the centre open
    for (const [tx, ty] of interior) {
      const touchesShell = SOLID[get(world, tx, ty + 1)] || SOLID[get(world, tx, ty - 1)] ||
        SOLID[get(world, tx - 1, ty)] || SOLID[get(world, tx + 1, ty)];
      const nx = (tx - g.cx) / g.rx, ny = (ty - g.cy) / g.ry;
      if (touchesShell && nx * nx + ny * ny > 0.45 && rng.chance(0.4)) set(world, tx, ty, T.CRYSTAL);
    }
  }
}

// ------------------------------------------------------------------ 6. lava (layer 4)

function buildLavaLakes(rng, ctx) {
  const { world, protect, lakes } = ctx;
  const L = LAYERS[3];
  const count = rng.int(G.lavaLakes.min, G.lavaLakes.max);
  for (let attempt = 0; attempt < 60 && lakes.length < count; attempt++) {
    const rx = rng.int(4, 9), ry = rng.int(2, 3);
    const cx = rng.int(4 + rx, W - 5 - rx);
    const cy = rng.int(rowOf(L.d0) + 6, rowOf(L.d1) - ry - 5);
    if (lakes.some((k) => Math.abs(k.cx - cx) < k.rx + rx + 3 && Math.abs(k.cy - cy) < 8)) continue;
    lakes.push({ cx, cy, rx, ry });
  }
  for (const k of lakes) {
    for (let tx = k.cx - k.rx; tx <= k.cx + k.rx; tx++) {
      const f = (tx - k.cx) / k.rx;
      const depth = Math.max(1, Math.round(k.ry * Math.sqrt(Math.max(0, 1 - f * f))));
      for (let ty = k.cy; ty < k.cy + depth; ty++) { set(world, tx, ty, T.LAVA); protect[ty * W + tx] = 1; }
      // headroom above the lava so the surface is visible
      if (Math.abs(f) < 0.9) for (let ty = k.cy - rng.int(2, 3); ty < k.cy; ty++) if (!protect[ty * W + tx]) set(world, tx, ty, T.AIR);
    }
  }
  // small pools filling the bottom of existing caves
  for (let ty = rowOf(L.d0) + 3; ty < rowOf(L.d1) - 2; ty++) {
    for (let tx = BEDROCK_COLS + 1; tx < W - BEDROCK_COLS - 1; tx++) {
      if (get(world, tx, ty) !== T.AIR || !SOLID[get(world, tx, ty + 1)]) continue;
      if (!rng.chance(G.lavaPoolChance)) continue;
      fillPool(ctx, tx, ty, rowOf(L.d0) + 2, rowOf(L.d1) - 1);
    }
  }
  sealLava(ctx, rng, rowOf(L.d0), rowOf(L.d1) + 1);
}

/** Flood the basin below `level = ty` from (sx, sy); abort if it leaks or grows too big. */
function fillPool(ctx, sx, sy, yMin, yMax) {
  const { world, protect } = ctx;
  const level = sy;
  const seen = new Set();
  const stack = [sy * W + sx];
  seen.add(stack[0]);
  const cells = [];
  while (stack.length) {
    const c = stack.pop();
    cells.push(c);
    if (cells.length > G.lavaPoolMax) return;
    const tx = c % W, ty = (c / W) | 0;
    if (ty > yMax) return;
    const nbs = [[tx - 1, ty], [tx + 1, ty], [tx, ty + 1]];
    for (const [nx, ny] of nbs) {
      if (ny < level) continue;
      if (!inner(nx)) return;
      const id = get(world, nx, ny);
      if (SOLID[id] || id === T.LAVA) continue;
      const ni = ny * W + nx;
      if (seen.has(ni)) continue;
      seen.add(ni); stack.push(ni);
    }
  }
  for (const c of cells) { world.types[c] = T.LAVA; protect[c] = 1; }
}

/** Make sure lava never touches open air sideways/below (it's static) and add obsidian crust. */
function sealLava(ctx, rng, y0, y1) {
  const { world } = ctx;
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = BEDROCK_COLS; tx < W - BEDROCK_COLS; tx++) {
      if (get(world, tx, ty) !== T.LAVA) continue;
      for (const [nx, ny] of [[tx - 1, ty], [tx + 1, ty], [tx, ty + 1]]) {
        const id = get(world, nx, ny);
        if (!SOLID[id] && id !== T.LAVA) set(world, nx, ny, rng.chance(0.6) ? T.OBSIDIAN : T.BASALT);
        else if (NATURAL[id] && rng.chance(0.35)) set(world, nx, ny, T.OBSIDIAN);
      }
    }
  }
}

/**
 * Final invariant pass: lava that has open space beside or below it (because a
 * later pass carved next to it) cools into obsidian. Unlike sealLava() this
 * converts the lava itself, so the carved space stays open. One pass suffices:
 * turning lava solid never exposes another lava tile.
 */
function crustExposedLava(world) {
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (get(world, tx, ty) !== T.LAVA) continue;
      for (const [nx, ny] of [[tx - 1, ty], [tx + 1, ty], [tx, ty + 1]]) {
        const id = get(world, nx, ny);
        if (!SOLID[id] && id !== T.LAVA) { set(world, tx, ty, T.OBSIDIAN); break; }
      }
    }
  }
}

// ------------------------------------------------------------------ 7. boss arena (the Heart)

function buildArena(ctx) {
  const { world, protect } = ctx;
  const A = G.arena;
  // everything in the Heart outside the arena is dense obsidian / basalt
  for (let ty = A.y0 - 2; ty <= A.y1; ty++) {
    for (let tx = BEDROCK_COLS; tx < W - BEDROCK_COLS; tx++) {
      const b = fbm2D(ctx.nB, tx * 0.2, ty * 0.2, 2);
      set(world, tx, ty, b > 0.55 ? T.OBSIDIAN : T.BASALT);
      world.setBackRaw(tx, ty, BACK.BASALT);
    }
  }
  const ix0 = A.x0 + 2, ix1 = A.x1 - 2, iy0 = A.y0 + 2, iy1 = A.y1 - 1;
  for (let ty = A.y0; ty <= A.y1; ty++) {
    for (let tx = A.x0; tx <= A.x1; tx++) {
      const interior = tx >= ix0 && tx <= ix1 && ty >= iy0 && ty <= iy1;
      set(world, tx, ty, interior ? T.AIR : T.ARENA);
      world.setBackRaw(tx, ty, BACK.ARENA);
      protect[ty * W + tx] = 1;
    }
  }
  // entrance through the ceiling + a small vestibule above it
  const ex0 = Math.floor(W / 2) - 2, ex1 = ex0 + 3;
  for (let ty = A.y0 - 6; ty < iy0; ty++) {
    for (let tx = ex0 - (ty < A.y0 - 2 ? 2 : 0); tx <= ex1 + (ty < A.y0 - 2 ? 2 : 0); tx++) {
      set(world, tx, ty, T.AIR);
      if (ty >= A.y0) world.setBackRaw(tx, ty, BACK.ARENA);
    }
  }
  // floating platforms and pillars (grapple anchors, cover)
  const plats = [[ix0 + 5, iy1 - 3, 5], [ix1 - 9, iy1 - 3, 5], [ex0 - 3, iy0 + 3, 10]];
  for (const [px, py, pw] of plats) for (let tx = px; tx < px + pw; tx++) set(world, tx, py, T.ARENA);
  for (const px of [ix0 + 14, ix1 - 14]) {
    for (let ty = iy0; ty <= iy0 + 2; ty++) set(world, px, ty, T.ARENA);
  }
  // torches on the back wall
  for (let tx = ix0 + 2; tx <= ix1 - 2; tx += 7) {
    if (get(world, tx, iy0 + 5) === T.AIR) set(world, tx, iy0 + 5, T.TORCH);
  }
  const bossX = (W / 2) * TILE;
  const bossY = (iy1 + 1) * TILE;
  return {
    x0: ix0, x1: ix1, y0: iy0, y1: iy1,          // interior (tiles, inclusive)
    outer: { x0: A.x0, x1: A.x1, y0: A.y0, y1: A.y1 },
    entrance: { x0: ex0, x1: ex1, y: A.y0 },
    bossX, bossY,
  };
}

// ------------------------------------------------------------------ 8. ores

function placeOres(rng, ctx) {
  const { world, protect } = ctx;
  for (const key of Object.keys(G.ores)) {
    const spec = G.ores[key];
    const id = T[key.toUpperCase()];
    const y0 = rowOf(spec.d0), y1 = rowOf(spec.d1);
    let placed = 0;
    const vein = () => {
      let x = rng.int(BEDROCK_COLS + 1, W - BEDROCK_COLS - 2);
      // deeper part of the band is slightly richer
      let y = Math.round(y0 + (y1 - y0) * Math.pow(rng.next(), 0.8));
      const size = rng.int(spec.size[0], spec.size[1]);
      for (let s = 0; s < size * 2 && s < 14; s++) {
        const i = y * W + x;
        if (inner(x) && y >= y0 && y <= y1 && NATURAL[world.types[i]] && !protect[i]) {
          world.types[i] = id; placed++;
        }
        const dir = rng.int(0, 3);
        if (dir === 0) x++; else if (dir === 1) x--; else if (dir === 2) y++; else y--;
      }
    };
    for (let v = 0; v < spec.veins; v++) vein();
    for (let guard = 0; placed < G.minOreTiles && guard < 200; guard++) vein();
  }
  // risk pays: rubies in the natural rock that crusts the lava lakes (layer 4)
  const crust = G.lavaCrustOre;
  if (crust) {
    const spec = G.ores[crust.key], id = T[crust.key.toUpperCase()];
    const y0 = rowOf(spec.d0), y1 = rowOf(spec.d1);
    for (let y = y0; y <= y1; y++) {
      for (let x = BEDROCK_COLS; x < W - BEDROCK_COLS; x++) {
        const i = y * W + x;
        if (!NATURAL[world.types[i]] || protect[i]) continue;
        const lava = world.types[i - 1] === T.LAVA || world.types[i + 1] === T.LAVA || world.types[i - W] === T.LAVA || world.types[i + W] === T.LAVA;
        if (lava && rng.chance(crust.chance)) world.types[i] = id;
      }
    }
  }
}

function placeLifeCrystals(rng, ctx) {
  const { world, protect } = ctx;
  let placed = 0;
  for (let attempt = 0; attempt < 4000 && placed < G.lifeCrystals; attempt++) {
    const tx = rng.int(BEDROCK_COLS + 1, W - BEDROCK_COLS - 2);
    const ty = rng.int(rowOf(30), G.arena.y0 - 4);
    const i = ty * W + tx;
    if (!NATURAL[world.types[i]] || protect[i]) continue;
    const exposed = isAir(world, tx, ty - 1) || isAir(world, tx, ty + 1) || isAir(world, tx - 1, ty) || isAir(world, tx + 1, ty);
    if (!exposed) continue;
    world.types[i] = T.LIFE_CRYSTAL;
    placed++;
  }
}

// ------------------------------------------------------------------ 9. camp

function buildCamp(ctx) {
  const { world, protect } = ctx;
  // flat camp: air above the surface, solid ground below
  for (let tx = G.campFlatX0; tx <= G.campFlatX1; tx++) {
    for (let ty = 0; ty < SURFACE_Y; ty++) { set(world, tx, ty, T.AIR); world.setBackRaw(tx, ty, BACK.NONE); }
    set(world, tx, SURFACE_Y, T.GRASS);
    for (let ty = SURFACE_Y + 1; ty <= SURFACE_Y + 4; ty++) {
      if (!SOLID[get(world, tx, ty)]) set(world, tx, ty, T.DIRT);
    }
  }
  // entry shaft with solid walls
  for (let ty = SURFACE_Y; ty < SURFACE_Y + G.shaftDepth; ty++) {
    for (let tx = G.shaftX0; tx <= G.shaftX1; tx++) { set(world, tx, ty, T.AIR); protect[ty * W + tx] = 1; }
    for (const wx of [G.shaftX0 - 1, G.shaftX1 + 1]) {
      if (!SOLID[get(world, wx, ty)] || get(world, wx, ty) === T.LIFE_CRYSTAL) set(world, wx, ty, T.DIRT);
    }
  }
  // shaft floor (so the first dig is a deliberate choice)
  for (let tx = G.shaftX0; tx <= G.shaftX1; tx++) {
    const ty = SURFACE_Y + G.shaftDepth;
    if (!SOLID[get(world, tx, ty)]) set(world, tx, ty, T.DIRT);
  }
  // headframe: posts (deco) + solid crossbeam, a first grapple anchor
  for (let ty = G.beamY + 1; ty < SURFACE_Y; ty++) {
    set(world, G.beamX0, ty, T.POST);
    set(world, G.beamX1, ty, T.POST);
  }
  for (let tx = G.beamX0; tx <= G.beamX1; tx++) set(world, tx, G.beamY, T.BEAM);
  // trapdoor planks over the shaft mouth: the camp is walkable end to end and the
  // first dig (↓ + Frapper on the planks) opens the mine; main.js closes it again
  // once the hero is back on the camp ground
  for (let tx = G.shaftX0; tx <= G.shaftX1; tx++) set(world, tx, SURFACE_Y, T.TRAPDOOR);
  // the camp ground row and the headframe beam cannot be mined: the Forge, the spawn and
  // the camp's grapple anchor always stay usable (the mine starts below this row)
  for (let tx = G.campFlatX0; tx <= G.campFlatX1; tx++) if (tx < G.shaftX0 || tx > G.shaftX1) world.lock(tx, SURFACE_Y);
  for (let tx = G.beamX0; tx <= G.beamX1; tx++) world.lock(tx, G.beamY);

  const forgeX = ((G.forgeX0 + G.forgeX1 + 1) / 2) * TILE;
  return {
    surfaceY: SURFACE_Y,
    bankY: SURFACE_Y * TILE,                    // y < bankY (feet) = safe zone
    spawnX: G.spawnTx * TILE + TILE / 2,       // centre-bottom of the player
    spawnY: SURFACE_Y * TILE,
    shaft: { x0: G.shaftX0, x1: G.shaftX1, y0: SURFACE_Y + 1, y1: SURFACE_Y + G.shaftDepth - 1 }, // open part, under the trapdoor
    trapdoor: { x0: G.shaftX0, x1: G.shaftX1, y: SURFACE_Y },
    beam: { x0: G.beamX0, x1: G.beamX1, y: G.beamY },
    forge: {
      x0: G.forgeX0 * TILE, x1: (G.forgeX1 + 1) * TILE, x: forgeX, y: SURFACE_Y * TILE,
      npcX: G.forgeX1 * TILE + 4, interactRadius: 30,
    },
    props: [
      { kind: 'grave', x: 17 * TILE + 8 }, { kind: 'grave', x: 19 * TILE + 4 },
      { kind: 'tree', x: 44 * TILE }, { kind: 'lamp', x: 33 * TILE + 8 },
      { kind: 'lamp', x: 41 * TILE + 8 }, { kind: 'sign', x: 39 * TILE + 10 },
      { kind: 'grave', x: 52 * TILE + 6 },
    ],
  };
}

// ------------------------------------------------------------------ 10. decorations

function placeDecorations(rng, ctx) {
  const { world } = ctx;
  for (let ty = SURFACE_Y + 2; ty < G.arena.y0 - 2; ty++) {
    const d = depthOf(ty);
    const li = layerAtDepth(d).index;
    for (let tx = BEDROCK_COLS; tx < W - BEDROCK_COLS; tx++) {
      if (get(world, tx, ty) !== T.AIR) continue;
      const above = get(world, tx, ty - 1), below = get(world, tx, ty + 1);
      const ceil = SOLID[above] && NATURAL[above];
      const floor = SOLID[below] && NATURAL[below];
      const openBelow = isAir(world, tx, ty + 1);
      if (ceil && openBelow) {
        if (li === 0 && d < 30 && rng.chance(0.22)) { set(world, tx, ty, T.ROOTS); continue; }
        if (rng.chance(0.09)) { set(world, tx, ty, T.STALACTITE); continue; }
        if ((li === 1 || li === 2) && (SOLID[get(world, tx - 1, ty)] || SOLID[get(world, tx + 1, ty)]) && rng.chance(0.25)) {
          set(world, tx, ty, T.COBWEB); continue;
        }
      }
      if (floor && isAir(world, tx, ty - 1)) {
        if (li === 1 && rng.chance(0.07)) { set(world, tx, ty, T.BONES_DECO); continue; }
        if (li === 2 && rng.chance(0.09)) { set(world, tx, ty, T.MUSHROOM); continue; }
        if (li === 0 && d > 10 && rng.chance(0.03)) { set(world, tx, ty, T.MUSHROOM); continue; }
        if (rng.chance(0.05)) { set(world, tx, ty, T.STALAGMITE); continue; }
      }
    }
  }
}

function applyBedrock(world) {
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (tx < BEDROCK_COLS || tx >= W - BEDROCK_COLS || ty >= H - BEDROCK_ROWS) {
        world.setRaw(tx, ty, T.BEDROCK);
        if (ty >= SURFACE_Y) world.setBackRaw(tx, ty, BACK.BASALT);
      }
    }
  }
}

// ------------------------------------------------------------------ 11. chests & enemy spawns

function footprintOpen(world, tx, ty, w, h) {
  // (tx, ty) = bottom-left tile of the footprint
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const id = world.get(tx + i, ty - j);
      if (SOLID[id] || id === T.LAVA) return false;
    }
  }
  return true;
}

function nearLava(world, tx, ty, r) {
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (world.get(tx + i, ty + j) === T.LAVA) return true;
  return false;
}

function placeChests(rng, ctx) {
  const { world, rooms } = ctx;
  const chests = [];
  const ok = (tx, ty) => footprintOpen(world, tx, ty, 1, 2) && SOLID[world.get(tx, ty + 1)] &&
    world.get(tx, ty + 1) !== T.LIFE_CRYSTAL && !nearLava(world, tx, ty, 2) &&
    !chests.some((c) => Math.abs(c.tx - tx) + Math.abs(c.ty - ty) < G.chestSpacing);
  const add = (tx, ty) => {
    const d = depthOf(ty);
    chests.push({
      tx, ty, x: tx * TILE + TILE / 2, y: (ty + 1) * TILE,
      kind: rng.chance(G.relicChestChance) ? 'relic' : 'gold',
      layer: layerAtDepth(d).index, depth: d, opened: false,
    });
    // clear deco under the chest
    if (world.get(tx, ty) !== T.AIR) world.types[ty * W + tx] = T.AIR;
  };
  // catacomb rooms usually hold a chest
  for (const r of rooms) {
    if (!rng.chance(0.7)) continue;
    for (let k = 0; k < 10; k++) {
      const tx = rng.int(r.x0 + 1, r.x1 - 1);
      if (ok(tx, r.y1)) { add(tx, r.y1); break; }
    }
  }
  // cave chests per layer
  for (let li = 0; li < 4; li++) {
    const L = LAYERS[li];
    const cands = [];
    for (let ty = rowOf(Math.max(L.d0, G.minSpawnDepth + 4)); ty <= rowOf(L.d1); ty++) {
      for (let tx = BEDROCK_COLS + 1; tx < W - BEDROCK_COLS - 1; tx++) {
        if (world.get(tx, ty) === T.AIR && SOLID[world.get(tx, ty + 1)]) cands.push(ty * W + tx);
      }
    }
    rng.shuffle(cands);
    let n = 0;
    for (const c of cands) {
      if (n >= L.chestCount) break;
      const tx = c % W, ty = (c / W) | 0;
      if (ok(tx, ty)) { add(tx, ty); n++; }
    }
  }
  return chests;
}

function spawnCandidates(world, li, anchor, w, h) {
  const L = LAYERS[li];
  const out = [];
  const yStart = rowOf(Math.max(L.d0, G.minSpawnDepth));
  const yEnd = Math.min(rowOf(L.d1), G.arena.y0 - 3);
  for (let ty = yStart; ty <= yEnd; ty++) {
    for (let tx = BEDROCK_COLS + 1; tx < W - BEDROCK_COLS - w; tx++) {
      if (anchor === 'floor') {
        if (!footprintOpen(world, tx, ty, w, h)) continue;
        let floor = true;
        for (let i = 0; i < w; i++) { const b = world.get(tx + i, ty + 1); if (!SOLID[b]) floor = false; }
        if (!floor || nearLava(world, tx, ty, 1)) continue;
        out.push([tx, ty]);
      } else if (anchor === 'ceiling') {
        // (tx, ty) = the hanging tile; needs solid above and room to drop below
        if (!SOLID[world.get(tx, ty - 1)]) continue;
        if (!footprintOpen(world, tx, ty + 2, 1, 3)) continue;
        out.push([tx, ty]);
      } else {
        if (!footprintOpen(world, tx, ty, w, h) || nearLava(world, tx, ty, 1)) continue;
        out.push([tx, ty]);
      }
    }
  }
  return out;
}

function placeSpawns(rng, ctx, arena, chests) {
  const { world } = ctx;
  const spawns = [];
  const far = (tx, ty) => !spawns.some((s) => Math.abs(s.tx - tx) + Math.abs(s.ty - ty) < G.spawnSpacing) &&
    !chests.some((c) => Math.abs(c.tx - tx) + Math.abs(c.ty - ty) < 3);
  for (let li = 0; li < 4; li++) {
    const L = LAYERS[li];
    const pools = {};
    for (const key of Object.keys(L.enemies)) {
      const rule = ENEMY_SPAWN_RULES[key];
      const tag = rule.anchor + rule.w + 'x' + rule.h;
      if (!pools[tag]) pools[tag] = rng.shuffle(spawnCandidates(world, li, rule.anchor, rule.w, rule.h));
    }
    let made = 0;
    for (let tries = 0; tries < L.spawnCount * 6 && made < L.spawnCount; tries++) {
      const key = rng.weighted(L.enemies);
      const rule = ENEMY_SPAWN_RULES[key];
      const pool = pools[rule.anchor + rule.w + 'x' + rule.h];
      while (pool.length) {
        const [tx, ty] = pool.pop();
        if (!far(tx, ty)) continue;
        spawns.push(makeSpawn(key, rule, tx, ty));
        made++;
        break;
      }
    }
  }
  // the Guardian waits in the middle of the arena
  const gRule = ENEMY_SPAWN_RULES.guardian;
  const gtx = Math.floor(W / 2) - 2, gty = arena.y1;
  spawns.push(makeSpawn('guardian', gRule, gtx, gty));
  return spawns;
}

function makeSpawn(key, rule, tx, ty) {
  const d = depthOf(ty);
  let x, y;
  if (rule.anchor === 'floor') { x = (tx + rule.w / 2) * TILE; y = (ty + 1) * TILE; }
  else if (rule.anchor === 'ceiling') { x = tx * TILE + TILE / 2; y = ty * TILE; }
  else { x = (tx + rule.w / 2) * TILE; y = (ty + 1 - rule.h / 2) * TILE; }
  return { key, tx, ty, x, y, anchor: rule.anchor, w: rule.w, h: rule.h, layer: layerAtDepth(d).index, depth: d };
}
