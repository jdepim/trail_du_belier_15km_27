// Shared test helpers: tiny worlds and a fake game context (no DOM needed).
import { World } from '../../src/world.js';
import { TILE_ID } from '../../src/tiles.js';
import { Input } from '../../src/input.js';
import { Player } from '../../src/player.js';
import { TILE } from '../../src/config.js';

/** Build a world from ASCII rows: '#' stone, 'B' brick, 'X' bedrock, 'L' lava, '.' air. */
export function worldFrom(rows) {
  const h = rows.length, w = rows[0].length;
  const world = new World(w, h);
  const map = { '#': TILE_ID.STONE, B: TILE_ID.BRICK, X: TILE_ID.BEDROCK, L: TILE_ID.LAVA, D: TILE_ID.DIRT, '.': TILE_ID.AIR };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) world.setRaw(x, y, map[rows[y][x]] ?? TILE_ID.AIR);
  world.finalize();
  return world;
}

/** Open box world: solid border, air inside. */
export function boxWorld(w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) r += x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.';
    rows.push(r);
  }
  return worldFrom(rows);
}

export function fakeGame(world) {
  const events = { audio: [], particles: [], shakes: 0, toasts: [], broken: [], hitStops: 0 };
  const game = {
    world,
    time: 0,
    flags: {},
    input: new Input(),
    audio: { play: (n, o) => events.audio.push(n) },
    particles: { spawn: (k) => events.particles.push(k) },
    camera: { shake: () => { events.shakes++; } },
    hitStop: () => { events.hitStops++; },
    toast: (t) => events.toasts.push(t),
    enemies: { damageInBox: () => 0 },
    tileBroken: (tx, ty, id) => events.broken.push([tx, ty, id]),
    hud: null,
    events,
  };
  game.player = new Player(game);
  return game;
}

/** Run n fixed ticks of the player with the input edge protocol. */
export function tick(game, n = 1, dt = 1 / 60) {
  for (let i = 0; i < n; i++) {
    game.input.beginTick();
    game.player.update(dt);
    game.input.endTick();
    game.time += dt;
  }
}

/** Place the player feet-centred on tile column tx, standing on top of row groundTy. */
export function standOn(game, tx, groundTy) {
  game.player.reset(tx * TILE + TILE / 2, groundTy * TILE);
  tick(game, 2);
}
