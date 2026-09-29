// Shared test helpers: ASCII test worlds, a scriptable input, a headless game context with no-op
// presentation (audio / particles / camera / hud / ui record what they receive), and a tick driver
// following the DESIGN §13 fixed-step order (player -> hazards -> entities).
import { World } from '../../src/world.js';
import { TILE_ID } from '../../src/tiles.js';
import { TILE, WORLD_TILES } from '../../src/config.js';
import { Player } from '../../src/player.js';
import { Hazards } from '../../src/hazards.js';
import { Entities } from '../../src/entities.js';
import { generateWorld } from '../../src/worldgen.js';
import { defaultSave, createRun, applyUpgrades } from '../../src/meta.js';

/** Test rows are stamped with their top-left tile at (ORIGIN, ORIGIN): near the sector centre. */
export const ORIGIN = 600;
/** Pixel centre of test tile (tx, ty). */
export const px = (t) => (ORIGIN + t + 0.5) * TILE;

const CHARS = {
  '#': TILE_ID.HULL, '.': TILE_ID.SPACE, r: TILE_ID.RUBBLE, s: TILE_ID.ASTEROID_SMALL, a: TILE_ID.ASTEROID,
  D: TILE_ID.DOOR_LOCKED, f: TILE_ID.FLOOR, '=': TILE_ID.WINDOW,
};

/** Full-size world (open space) with the ASCII rows stamped at ORIGIN. zone: interior id for 'f' tiles. */
export function worldFrom(rows, zone = 0) {
  const world = new World(WORLD_TILES, WORLD_TILES);
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < rows[y].length; x++) {
      const id = CHARS[rows[y][x]] ?? TILE_ID.SPACE;
      world.setRaw(ORIGIN + x, ORIGIN + y, id);
      if (rows[y][x] === 'f') world.setZoneRaw(ORIGIN + x, ORIGIN + y, zone);
    }
  }
  world.finalize();
  return world;
}

/** Open box: hull border, space inside. */
export function boxWorld(w, h) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let r = '';
    for (let x = 0; x < w; x++) r += x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.';
    rows.push(r);
  }
  return worldFrom(rows);
}

/** Minimal gen record for hand-built worlds (no bodies unless given). */
export function emptyGen(world, extra = {}) {
  return {
    seed: 1, world, spawn: { x: px(2), y: px(2) }, dock: null, pois: [], structures: {},
    suns: [], blackHoles: [], moon: null, belt: null, gravitySources: [],
    satellites: [], items: [], doors: [], terminals: [], crates: [], caches: [], pickups: [],
    refills: [], lockers: [], workbench: null, capsule: null, turrets: [], lasers: [], vents: [],
    debrisFields: [], rubble: null,
    ...extra,
  };
}

/** Scriptable input with the same surface as input.js (moveX / moveY / held / pressed). */
export class ScriptInput {
  constructor() {
    this.moveX = 0; this.moveY = 0;
    this._held = new Set();
    this._latch = new Set();
    this._tick = new Set();
  }
  stick(x, y) { this.moveX = x; this.moveY = y; }
  hold(a, on = true) { if (on) { if (!this._held.has(a)) this._latch.add(a); this._held.add(a); } else this._held.delete(a); }
  tap(a) { this._latch.add(a); }
  held(a) { return this._held.has(a) || this._tick.has(a); }
  pressed(a) { return this._tick.has(a); }
  beginTick() { this._tick = this._latch; this._latch = new Set(); }
  endTick() { this._tick = new Set(); }
}

const genCache = new Map();
/** generateWorld(seed), cached (tests must not mutate the returned world unless they regenerate). */
export function cachedGen(seed) {
  if (!genCache.has(seed)) genCache.set(seed, generateWorld(seed));
  return genCache.get(seed);
}

/**
 * Headless game context. opts: { world, gen, save, lifeSeed }.
 * game.events records every hook / juice call: audio, particles, shakes, hitStops, toasts,
 * deaths, items, logs, satellites, reveals, deposits, states, victories, broken, persists.
 */
export function fakeGame(opts = {}) {
  const gen = opts.gen || emptyGen(opts.world || boxWorld(40, 40));
  const events = {
    audio: [], particles: [], shakes: 0, hitStops: 0, toasts: [], deaths: [], items: [], logs: [],
    satellites: [], reveals: [], deposits: 0, states: [], victories: 0, broken: [], persists: 0,
  };
  const save = opts.save || defaultSave(1);
  const game = {
    world: gen.world, gen, save, run: createRun(save), time: 0, flags: {}, state: 'PLAYING',
    input: new ScriptInput(),
    audio: { play: (n) => events.audio.push(n) },
    particles: { spawn: (k) => events.particles.push(k) },
    camera: { shake: () => { events.shakes++; } },
    hud: null, ui: null,
    hitStop: () => { events.hitStops++; },
    toast: (t) => events.toasts.push(t),
    banner: () => {},
    onPlayerDeath: (c) => events.deaths.push(c),
    onItem: (k) => events.items.push(k),
    onLog: (k) => events.logs.push(k),
    onSatellite: (id) => events.satellites.push(id),
    reveal: (x, y, r) => events.reveals.push([x, y, r]),
    persist: () => { events.persists++; return true; },
    victory: () => { events.victories++; },
    setState: (s) => events.states.push(s),
    tileBroken: (tx, ty, id, cause) => events.broken.push([tx, ty, id, cause]),
    events,
  };
  game.player = new Player(game);
  game.hazards = new Hazards(game);
  game.entities = new Entities(game);
  applyUpgrades(game.player, save);
  game.hazards.reset(gen, opts.lifeSeed ?? 1);
  game.entities.reset(gen, opts.lifeSeed ?? 1);
  game.player.reset(gen.spawn.x, gen.spawn.y);
  return game;
}

/** Run n fixed ticks in the DESIGN §13 order. opts.only = 'player' skips hazards / entities. */
export function tick(game, n = 1, dt = 1 / 60, opts = {}) {
  for (let i = 0; i < n; i++) {
    game.input.beginTick();
    game.player.update(dt);
    if (opts.only !== 'player') {
      game.hazards.update(dt);
      game.entities.update(dt);
    }
    game.input.endTick();
    game.time += dt;
  }
}
