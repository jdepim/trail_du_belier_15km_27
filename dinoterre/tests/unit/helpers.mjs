// Shared helpers: tiny hand-made worlds and a headless game placed in them.
import { World } from '../../src/world.js';
import { TILE_ID } from '../../src/tiles.js';
import { Game } from '../../src/game.js';
import { STEP, TILE } from '../../src/config.js';

/** Rows of ASCII: '#' stone, '~' water, 'T' trunk, '=' leaves (platform), '.' air. Surface = first solid row. */
export function worldFrom(rows) {
  const h = rows.length, w = rows[0].length;
  const world = new World(w, h);
  const map = { '#': TILE_ID.stone, '~': TILE_ID.water, T: TILE_ID.trunk, '=': TILE_ID.leaves, '.': TILE_ID.air };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) world.tiles[y * w + x] = map[rows[y][x]] ?? TILE_ID.air;
  for (let x = 0; x < w; x++) { let s = 0; while (s < h && !world.isSolid(x, s)) s++; world.surface[x] = s; }
  world.spawn = { tx: 2, ty: world.surface[2] - 1 };
  return world;
}

/** Flat ground at row `ground`, optional wall of `wallH` tiles at column `wallX`. */
export function flatWorld({ w = 60, h = 40, ground = 30, wallX = -1, wallH = 0 } = {}) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) {
      const solid = y >= ground || x === 0 || x === w - 1 || (x === wallX && y >= ground - wallH);
      r += solid ? '#' : '.';
    }
    rows.push(r);
  }
  return worldFrom(rows);
}

/** A headless game (no spawns) moved into `world`, player feet at tile (tx, feet row). */
export function gameIn(world, species = 'robuste', tx = 5) {
  const g = new Game({ seed: 1, species, spawnCreatures: false });
  g.world = world;
  g.bonePiles = [];
  g.creatures = [];
  g.stats.hints = { move: 1, hunger: 1, build: 1, tame: 1, climb: 1, swim: 1, carcass: 1 };
  placePlayer(g, tx);
  return g;
}

export function placePlayer(g, tx, feetRow) {
  const p = g.player;
  const ty = feetRow ?? g.world.surface[tx];
  p.x = (tx + 0.5) * TILE - p.w / 2;
  p.y = ty * TILE - p.h;
  p.vx = p.vy = 0;
  p.onGround = true;
  p.state = 'normal';
}

export function run(g, seconds, each) {
  const n = Math.round(seconds / STEP);
  for (let i = 0; i < n; i++) { g.update(STEP); if (each && each(i) === false) break; }
}
