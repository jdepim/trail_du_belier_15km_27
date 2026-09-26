// Progression solver (DESIGN.md §6.4): proves the métroidvania gating of a generated sector.
//
//   node tools/solver.mjs [seed]      prints the report (exit code 1 when a rule fails)
//   import { solveProgression, reachable, thermalCost } from '../../tools/solver.mjs'
//
// Two grids bracket the real physics so that every verdict is honest:
//   - 'loose'  : 8 px cells (one tile), a cell is open when its tile is not solid, 8-neighbour moves.
//                It lets through more than the 10 px astronaut can (1-tile gaps, diagonal corners),
//                so "NOT reachable on the loose grid" proves a lock is real.
//   - 'strict' : 16 px cells (2 × 2 tiles, all four free), 4-neighbour moves; the astronaut fits with
//                room to spare, so "reachable on the strict grid" proves a route exists.
// Blocking rules: solid tiles, keycard doors without the keycard, rubble without the explosives,
// sun cores and black-hole horizons (both grids); the strict grid also blocks any heat (unless the
// thermal cost is computed instead), gravity stronger than the base thrust (black holes × the anchor
// multiplier when owned) and the ion storm beyond BOUNDARY.r.
// Thermal criterion (anchor): the damage-minimising path from any heat-free reachable cell to the
// anchor pad, flown at PLAYER.hardMaxSpeed, must cost ≥ 1.5 × the best possible hull without the
// shield (loose grid: a lower bound) and ≤ 40 % of the base hull with it (strict grid: an upper bound).
import { fileURLToPath } from 'node:url';
import { TILE, WORLD_TILES, CENTER, BOUNDARY, PLAYER, SUNS, BLACK_HOLES } from '../src/config.js';
import { TILE_ID, SOLID } from '../src/tiles.js';
import { gravityAt } from '../src/physics.js';
import { heatField } from '../src/hazards.js';
import { UPGRADES } from '../src/meta.js';
import { generateWorld } from '../src/worldgen.js';

const DOOR = TILE_ID.DOOR_LOCKED, RUBBLE = TILE_ID.RUBBLE;

/** Best hull money can buy (Blindage maxed). */
export const MAX_HULL = (() => { const s = { maxHull: PLAYER.maxHull }; UPGRADES.hull.apply(s, UPGRADES.hull.max); return s.maxHull; })();

function tileOpen(world, tx, ty, items) {
  const id = world.get(tx, ty);
  if (id === DOOR) return !!items.keycard;
  if (id === RUBBLE) return !!items.explosives;
  return !SOLID[id];
}

/**
 * Build the passability + field grids for an item set.
 * @returns {{ mode, cell, n, open: Uint8Array, heat: Float32Array, toCell(x, y) -> index }}
 */
export function buildGrid(gen, items, mode) {
  const world = gen.world;
  const cell = mode === 'strict' ? 16 : 8;
  const n = (WORLD_TILES * TILE) / cell;
  const open = new Uint8Array(n * n);
  const heat = new Float32Array(n * n);
  const g = { ax: 0, ay: 0, mag: 0, bh: 0 };
  const mulBH = items.anchor ? BLACK_HOLES.anchorMul : 1;
  const r = PLAYER.radius;
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      let ok;
      if (mode === 'strict') {
        const tx = cx * 2, ty = cy * 2;
        ok = tileOpen(world, tx, ty, items) && tileOpen(world, tx + 1, ty, items) && tileOpen(world, tx, ty + 1, items) && tileOpen(world, tx + 1, ty + 1, items);
      } else {
        ok = tileOpen(world, cx, cy, items);
      }
      if (!ok) continue;
      const x = (cx + 0.5) * cell, y = (cy + 0.5) * cell;
      let dead = false;
      for (const s of gen.suns) if (Math.hypot(x - s.x, y - s.y) < s.coreR + r) dead = true;
      for (const b of gen.blackHoles) if (Math.hypot(x - b.x, y - b.y) < b.horizon + r) dead = true;
      if (dead) continue;
      let h = 0;
      for (const s of gen.suns) if (Math.hypot(x - s.x, y - s.y) < s.heatR) { h = heatField(world, gen.suns, x, y); break; }
      heat[cy * n + cx] = h;
      if (mode === 'strict') {
        if (Math.hypot(x - CENTER, y - CENTER) > BOUNDARY.r) continue;
        gravityAt(x, y, gen.gravitySources, g, mulBH);
        if (g.mag > PLAYER.thrustAccel) continue;
      }
      open[cy * n + cx] = 1;
    }
  }
  return { mode, cell, n, open, heat, toCell: (x, y) => Math.floor(y / cell) * n + Math.floor(x / cell) };
}

/**
 * Flood fill from the spawn. opts.allowHeat: heat never blocks (default: strict grids block any heat).
 * @returns {Uint8Array} 1 = reached
 */
export function flood(gen, grid, { allowHeat = grid.mode === 'loose' } = {}) {
  const { n, open, heat } = grid;
  const seen = new Uint8Array(n * n);
  const start = grid.toCell(gen.spawn.x, gen.spawn.y);
  if (!open[start]) return seen;
  const q = new Int32Array(n * n);
  let head = 0, tail = 0;
  q[tail++] = start; seen[start] = 1;
  const diag = grid.mode === 'loose';
  while (head < tail) {
    const i = q[head++];
    const x = i % n, y = (i / n) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || (!diag && dx !== 0 && dy !== 0)) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (seen[j] || !open[j] || (!allowHeat && heat[j] > 0)) continue;
        seen[j] = 1;
        q[tail++] = j;
      }
    }
  }
  return seen;
}

/** Is the world point (x, y) (or a cell touching it) reached? */
function reachedNear(grid, seen, x, y, slack) {
  const { n, cell } = grid;
  const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
  const k = Math.ceil(slack / cell);
  for (let dy = -k; dy <= k; dy++) {
    for (let dx = -k; dx <= k; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      if (!seen[ny * n + nx]) continue;
      const px = (nx + 0.5) * cell, py = (ny + 0.5) * cell;
      if (Math.hypot(px - x, py - y) <= slack + cell * 0.71) return true;
    }
  }
  return false;
}

/** Can the astronaut reach (x, y) (within `slack` px) with this item set? */
export function reachable(gen, items, mode, x, y, slack = 12, opts) {
  const grid = buildGrid(gen, items, mode);
  const seen = flood(gen, grid, opts);
  return reachedNear(grid, seen, x, y, slack);
}

/**
 * Minimum heat damage (hull) from any heat-free reachable cell to (x, y), flying at `speed`,
 * heat × `mul` (the shield). Dijkstra over the grid; Infinity when unreachable.
 */
export function thermalCost(gen, items, mode, x, y, { speed = PLAYER.hardMaxSpeed, mul = 1, slack = 12 } = {}) {
  const grid = buildGrid(gen, items, mode);
  const { n, open, heat, cell } = grid;
  const seen = flood(gen, grid, { allowHeat: true });
  const dist = new Float64Array(n * n).fill(Infinity);
  // binary heap of cell indices keyed by dist
  const heap = new Int32Array(n * n * 2);
  let size = 0;
  const push = (i) => {
    let k = size++;
    heap[k] = i;
    while (k > 0) { const p = (k - 1) >> 1; if (dist[heap[p]] <= dist[heap[k]]) break; const t = heap[p]; heap[p] = heap[k]; heap[k] = t; k = p; }
  };
  const pop = () => {
    const top = heap[0];
    heap[0] = heap[--size];
    let k = 0;
    for (;;) {
      const l = 2 * k + 1, r = l + 1;
      let m = k;
      if (l < size && dist[heap[l]] < dist[heap[m]]) m = l;
      if (r < size && dist[heap[r]] < dist[heap[m]]) m = r;
      if (m === k) break;
      const t = heap[m]; heap[m] = heap[k]; heap[k] = t; k = m;
    }
    return top;
  };
  // sources: heat-free reached cells bordering the hot region
  const diag = grid.mode === 'loose';
  for (let i = 0; i < n * n; i++) {
    if (!seen[i] || heat[i] > 0) continue;
    const x0 = i % n, y0 = (i / n) | 0;
    let border = false;
    for (let dy = -1; dy <= 1 && !border; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x0 + dx, ny = y0 + dy;
      if (nx >= 0 && ny >= 0 && nx < n && ny < n && open[ny * n + nx] && heat[ny * n + nx] > 0) { border = true; break; }
    }
    if (border) { dist[i] = 0; push(i); }
  }
  const target = grid.toCell(x, y);
  const tx = target % n, ty = (target / n) | 0;
  const k = Math.ceil(slack / cell);
  const isTarget = (i) => { const cx = i % n, cy = (i / n) | 0; return Math.abs(cx - tx) <= k && Math.abs(cy - ty) <= k && Math.hypot((cx + 0.5) * cell - x, (cy + 0.5) * cell - y) <= slack + cell * 0.71; };
  const done = new Uint8Array(n * n);
  while (size > 0) {
    const i = pop();
    if (done[i]) continue;
    done[i] = 1;
    if (isTarget(i)) return dist[i];
    const x0 = i % n, y0 = (i / n) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if ((dx === 0 && dy === 0) || (!diag && dx !== 0 && dy !== 0)) continue;
        const nx = x0 + dx, ny = y0 + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const j = ny * n + nx;
        if (!open[j] || done[j]) continue;
        const len = (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * cell;
        const nd = dist[i] + ((heat[i] + heat[j]) * 0.5 * mul * len) / speed;
        if (nd < dist[j]) { dist[j] = nd; push(j); }
      }
    }
  }
  return Infinity;
}

/**
 * Full §6.4 report. Each entry: { ok, detail }. report.ok = every rule holds.
 */
export function solveProgression(gen) {
  const item = (k) => gen.items.find((i) => i.key === k);
  const none = {}, K = { keycard: true }, KE = { keycard: true, explosives: true };
  const KEH = { keycard: true, explosives: true, heatshield: true }, ALL = { ...KEH, anchor: true };
  const rules = [];
  const rule = (name, ok, detail) => rules.push({ name, ok: !!ok, detail });
  const kc = item('keycard'), ex = item('explosives'), hs = item('heatshield'), an = item('anchor');
  const r1 = reachable(gen, none, 'strict', kc.x, kc.y);
  rule('keycard reachable with {} (no door, heat or crushing gravity)', r1, `strict grid: ${r1}`);
  const r2a = reachable(gen, K, 'strict', ex.x, ex.y);
  const r2b = reachable(gen, none, 'loose', ex.x, ex.y);
  rule('explosives reachable with {keycard}', r2a, `strict grid: ${r2a}`);
  rule('explosives NOT reachable with {}', !r2b, `loose grid: ${r2b}`);
  const r3a = reachable(gen, KE, 'strict', hs.x, hs.y);
  const r3b = reachable(gen, K, 'loose', hs.x, hs.y);
  rule('heatshield reachable with {keycard, explosives}', r3a, `strict grid: ${r3a}`);
  rule('heatshield NOT reachable without explosives', !r3b, `loose grid: ${r3b}`);
  const hot = thermalCost(gen, KE, 'loose', an.x, an.y, { mul: 1 });
  const cool = thermalCost(gen, KEH, 'strict', an.x, an.y, { mul: SUNS.shieldMul });
  rule(`anchor without shield costs ≥ 1.5 × max hull (${1.5 * MAX_HULL})`, hot >= 1.5 * MAX_HULL, `loose grid, ${PLAYER.hardMaxSpeed} px/s: ${hot.toFixed(1)} hull`);
  rule(`anchor with shield costs ≤ 40 % of base hull (${0.4 * PLAYER.maxHull})`, cool <= 0.4 * PLAYER.maxHull, `strict grid, ${PLAYER.hardMaxSpeed} px/s: ${cool.toFixed(1)} hull`);
  const r5a = reachable(gen, ALL, 'strict', gen.capsule.x, gen.capsule.y);
  const r5b = reachable(gen, KEH, 'strict', gen.capsule.x, gen.capsule.y);
  rule('capsule reachable with every item (gravity under the base thrust with the anchor)', r5a, `strict grid: ${r5a}`);
  rule('capsule gravity-locked without the anchor', !r5b, `strict grid: ${r5b}`);
  return { ok: rules.every((r) => r.ok), rules, thermal: { unshielded: hot, shielded: cool, maxHull: MAX_HULL, baseHull: PLAYER.maxHull } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const seed = process.argv[2] !== undefined ? process.argv[2] : 1;
  const t0 = Date.now();
  const gen = generateWorld(seed);
  const rep = solveProgression(gen);
  for (const r of rep.rules) console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name} — ${r.detail}`);
  console.log(`${rep.ok ? 'progression OK' : 'progression BROKEN'} (seed ${gen.seed}, ${Date.now() - t0} ms)`);
  process.exitCode = rep.ok ? 0 : 1;
}
