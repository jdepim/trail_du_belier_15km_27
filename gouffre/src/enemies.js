// Enemies, enemy projectiles and the boss (DESIGN.md §6).
//
//   EnemyManager(game)
//     reset(spawns)              new world: instantiate every worldgen spawn (+ the Guardian)
//     spawn(key, x, y, opts)     create an enemy (anchor semantics as worldgen spawns) -> Enemy
//     update(dt)                 fixed tick: AI of enemies near the camera, projectiles, respawn
//     draw(ctx, camX, camY, a)   enemies + projectiles (interpolated)
//     addLights(lighting)        imps, ghosts, fireballs, boss (called once per fixed tick)
//     damageInBox(box, dmg, fromX, opts) -> hits   (the player's pickaxe; also deflects bones / fireballs)
//     hurt(e, dmg, fromX, opts) / kill(e)
//     boss, bossBar, bossDefeated, gatesSealed
//
// Enemies are pooled objects (dead ones are recycled), projectiles live in a fixed
// pool; nothing is allocated per tick. Only enemies within ~1.5 screens of the
// camera think and move (ENEMY_ACTIVE); the others sleep where they are.
// Depth scaling: hp × (1 + d/60), dmg × (1 + d/80), × 1.5 in NG+ (game.save.ngPlus / game.run.ngPlus).
import {
  TILE, SURFACE_Y, WORLD_W, BEDROCK_COLS, layerAtDepth, WORLDGEN, ENEMY_SCALING, ENEMY_STATS,
  ENEMY_AI as AI, ENEMY_SPAWNING as SP, ENEMY_ACTIVE, ENEMY_SPAWN_RULES, DROPS, BOSS,
} from './config.js';
import { TILES, TILE_ID, SOLID } from './tiles.js';
import { moveAndCollide } from './physics.js';
import { drawSprite } from './sprites.js';
import { createRng } from './rng.js';

const NAMES = {
  slime: 'Gelée', bat: 'Chauve-souris', skeleton: 'Squelette', spider: 'Araignée', ghost: 'Spectre',
  imp: 'Diablotin de feu', golem: 'Golem', guardian: "Le Gardien de l'Abysse",
};

/**
 * Base definitions per enemy key (stats from config.ENEMY_STATS). Sprite names of
 * every variant are precomputed so drawing never builds strings:
 * spr = [normal, hit flash, telegraph tint], alt = same for the alternate look
 * (bat hanging asleep, Guardian enraged).
 */
export const ENEMY_DEFS = {};
for (const key of Object.keys(ENEMY_STATS)) {
  const sprite = 'enemy_' + key;
  const altBase = key === 'bat' ? 'enemy_bat_hang' : key === 'guardian' ? 'enemy_guardian_rage' : sprite;
  ENEMY_DEFS[key] = {
    key, name: NAMES[key], sprite, ...ENEMY_STATS[key],
    spr: [sprite, sprite + '_flash', sprite + '_tele'],
    alt: [altBase, altBase + '_flash', altBase + '_tele'],
  };
}

/**
 * Depth scaling from DESIGN §6: hp × (1 + d/60), dmg × (1 + d/80), × 1.5 in NG+.
 * ngPlus = NG+ level (true = 1): × (1 + 0.5 × level), so NG+2 = × 2.
 */
export function scaleStat(base, depth, kind, ngPlus = 0) {
  const d = Math.max(0, depth);
  const k = kind === 'hp' ? 1 + d * ENEMY_SCALING.hpPerM : 1 + d * ENEMY_SCALING.dmgPerM;
  const lv = ngPlus === true ? 1 : Math.max(0, Number(ngPlus) || 0);
  return base * k * (1 + (ENEMY_SCALING.ngPlusMul - 1) * lv);
}

// sprites drawn from the feet (bottom-centre); the others from the hitbox centre
const FEET = { slime: 1, skeleton: 1, golem: 1, guardian: 1 };
// enemies that ignore gravity
const FLYING = { bat: 1, ghost: 1, imp: 1 };
// particle colour of hits / deaths
const GORE = {
  slime: '#6fcf6a', bat: '#7a1a2a', skeleton: '#e8e0c8', spider: '#9ac04a', ghost: '#b8e0ff',
  imp: '#fb923c', golem: '#8a7a78', guardian: '#b070f0',
};
const HIT_PITCH = { slime: 0.8, bat: 1.4, skeleton: 1.2, spider: 1.25, ghost: 1.5, imp: 1.1, golem: 0.6, guardian: 0.5 };
// windup states (drawn with the red "tele" tint blinking)
const TELE = { windup: 1, charge: 1, shake: 1, slam_wind: 1, swipe_wind: 1, claw_wind: 1, summon_wind: 1, rain_wind: 1, charge_wind: 1 };

const CAMP_CEIL = (SURFACE_Y + 2) * TILE; // flyers stay below this line
const FIRE_LIGHT = [255, 120, 40];
const GHOST_LIGHT = [120, 170, 255];
const BOSS_LIGHT = [255, 60, 90];
const RAGE_LIGHT = [255, 90, 30];
const WARN_LIGHT = [255, 70, 40];
const ABYSS_LIGHT = [200, 90, 255];

function approach(v, target, step) {
  if (v < target) return Math.min(v + step, target);
  if (v > target) return Math.max(v - step, target);
  return v;
}
function overlap(ax, ay, aw, ah, bx, by, bw, bh) { return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by; }

/**
 * Allocation-free grid line of sight (DDA): true when no solid tile lies strictly
 * between the two points (the end tiles themselves are not tested).
 */
export function lineOfSight(world, x0, y0, x1, y1) {
  let tx = Math.floor(x0 / TILE), ty = Math.floor(y0 / TILE);
  const ex = Math.floor(x1 / TILE), ey = Math.floor(y1 / TILE);
  const dx = x1 - x0, dy = y1 - y0;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(TILE / dx) : Infinity, tdy = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
  let tmx = dx !== 0 ? (dx > 0 ? (tx + 1) * TILE - x0 : x0 - tx * TILE) / Math.abs(dx) : Infinity;
  let tmy = dy !== 0 ? (dy > 0 ? (ty + 1) * TILE - y0 : y0 - ty * TILE) / Math.abs(dy) : Infinity;
  for (let guard = 0; guard < 96; guard++) {
    if (tx === ex && ty === ey) return true;
    if (tmx < tmy) { tmx += tdx; tx += stepX; } else { tmy += tdy; ty += stepY; }
    if (tx === ex && ty === ey) return true;
    if (world.isSolid(tx, ty)) return false;
  }
  return true;
}

// ------------------------------------------------------------------ spawn rules

function blocked(world, tx, ty) { const id = world.get(tx, ty); return SOLID[id] === 1 || id === TILE_ID.LAVA; }

function lavaNear(world, tx0, ty0, tx1, ty1) {
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (world.get(tx, ty) === TILE_ID.LAVA) return true;
  return false;
}

/**
 * Worldgen placement rules (ENEMY_SPAWN_RULES) for an enemy of `key` whose footprint
 * is anchored at tile (tx, ty): floor = bottom-left tile of the footprint (solid below),
 * ceiling = the hanging tile (solid above, 3 free tiles), air = bottom-left of a free footprint.
 */
export function spawnTileValid(world, key, tx, ty) {
  const rule = ENEMY_SPAWN_RULES[key];
  if (!rule) return false;
  if (rule.anchor === 'ceiling') {
    if (!world.isSolid(tx, ty - 1) || world.get(tx, ty - 1) === TILE_ID.GATE) return false;
    for (let j = 0; j < 3; j++) if (blocked(world, tx, ty + j)) return false;
    return true;
  }
  for (let j = 0; j < rule.h; j++) for (let i = 0; i < rule.w; i++) if (blocked(world, tx + i, ty - j)) return false;
  if (rule.anchor === 'floor') for (let i = 0; i < rule.w; i++) if (!world.isSolid(tx + i, ty + 1)) return false;
  return !lavaNear(world, tx - 1, ty - rule.h, tx + rule.w, ty + 1);
}

/** Anchor point in px of a footprint (same semantics as worldgen spawn records). */
export function anchorPoint(key, tx, ty, out) {
  const rule = ENEMY_SPAWN_RULES[key];
  out.anchor = rule.anchor;
  if (rule.anchor === 'floor') { out.x = (tx + rule.w / 2) * TILE; out.y = (ty + 1) * TILE; }
  else if (rule.anchor === 'ceiling') { out.x = tx * TILE + TILE / 2; out.y = ty * TILE; }
  else { out.x = (tx + rule.w / 2) * TILE; out.y = (ty + 1 - rule.h / 2) * TILE; }
  return out;
}

function pickWeighted(map, rnd) {
  let total = 0;
  for (const k in map) total += map[k];
  let r = rnd() * total;
  let last = null;
  for (const k in map) { last = k; r -= map[k]; if (r < 0) return k; }
  return last;
}

/**
 * Off-screen respawn spot around (px, py): random tiles between minDistTiles and
 * maxDistTiles from the player, in the regular layers only (not the camp, not the
 * Heart), outside `view` (+ margin), following the worldgen placement rules.
 * The enemy key is picked from the layer of the candidate tile.
 * @returns out = { key, x, y, anchor, tx, ty } | null
 */
export function findSpawnSpot(world, rnd, px, py, view, out, tries = SP.tries) {
  const ptx = Math.floor(px / TILE), pty = Math.floor(py / TILE);
  const maxD = SP.maxDistTiles, minD = SP.minDistTiles;
  for (let n = 0; n < tries; n++) {
    const dx = Math.round((rnd() * 2 - 1) * maxD), dy = Math.round((rnd() * 2 - 1) * maxD * 0.65);
    if (Math.max(Math.abs(dx), Math.abs(dy)) < minD) continue;
    const tx = ptx + dx, ty = pty + dy;
    if (tx <= BEDROCK_COLS || tx >= WORLD_W - BEDROCK_COLS - 2) continue;
    const d = ty - SURFACE_Y;
    if (d < WORLDGEN.minSpawnDepth || ty > WORLDGEN.arena.y0 - 3) continue;
    const layer = layerAtDepth(d);
    if (layer.index >= 4) continue;
    const key = pickWeighted(layer.enemies, rnd);
    if (!spawnTileValid(world, key, tx, ty)) continue;
    const rule = ENEMY_SPAWN_RULES[key];
    const x0 = tx * TILE, x1 = (tx + rule.w) * TILE;
    const y0 = rule.anchor === 'ceiling' ? ty * TILE : (ty - rule.h + 1) * TILE, y1 = (ty + (rule.anchor === 'ceiling' ? 3 : 1)) * TILE;
    if (view && overlap(x0, y0, x1 - x0, y1 - y0, view.x - 16, view.y - 16, view.w + 32, view.h + 32)) continue;
    anchorPoint(key, tx, ty, out);
    out.key = key; out.tx = tx; out.ty = ty;
    return out;
  }
  return null;
}

// ------------------------------------------------------------------ enemy objects

class Enemy {
  constructor() { this.alive = false; this.def = null; }
}

const MAX_PROJ = 64;

export class EnemyManager {
  constructor(game) {
    this.game = game;
    this.list = [];          // live enemies (dying ones included)
    this.pool = [];          // recycled Enemy objects
    this.projectiles = [];   // fixed pool of enemy projectiles
    for (let i = 0; i < MAX_PROJ; i++) this.projectiles.push({ active: false, type: '', x: 0, y: 0, vx: 0, vy: 0, w: 6, h: 6, dmg: 0, t: 0, life: 0, grav: 0, px: 0, py: 0, floorY: 0 });
    this.spawns = [];        // spawn records from worldgen
    this.boss = null;
    this.bossDefeated = false;
    this.gatesSealed = false;
    this.truce = false;      // the Guardian is dying: nothing may hurt the player any more
    this.arena = null;
    this.respawnT = 6;
    this.rng = createRng(1);
    this.time = 0;
    this.activeCount = 0;     // enemies that thought during the last tick
    this._res = { onGround: false, hitCeiling: false, hitLeft: false, hitRight: false };
    this._spot = { key: null, x: 0, y: 0, anchor: 'floor', tx: 0, ty: 0 };
    this._view = { x: 0, y: 0, w: 0, h: 0 };
    this._bar = { name: '', hp: 0, maxHp: 1, phase: 0, reveal: 0, flash: 0, dying: false };
  }

  /** NG+ level of the current run (copied from save.ngPlus when the mine is made). */
  get ngPlus() {
    const g = this.game;
    if (g.run && g.run.ngPlus !== undefined) return g.run.ngPlus === true ? 1 : Number(g.run.ngPlus) || 0;
    return g.save ? Number(g.save.ngPlus === true ? 1 : g.save.ngPlus) || 0 : 0;
  }

  /** New run / new world: take the worldgen spawn list and instantiate it. */
  reset(spawns) {
    for (const e of this.list) { e.alive = false; this.pool.push(e); }
    this.list.length = 0;
    for (const p of this.projectiles) p.active = false;
    this.spawns = spawns ? spawns.slice() : [];
    const gen = this.game.gen;
    this.arena = gen && gen.arena ? gen.arena : null;
    this.rng = createRng(((gen && gen.seed) || 1) ^ 0x5eed);
    this.boss = null;
    this.bossDefeated = false;
    this.gatesSealed = false;
    this.truce = false;
    this.respawnT = SP.interval[0];
    for (const s of this.spawns) {
      const e = this.spawn(s.key, s.x, s.y, { anchor: s.anchor, depth: s.depth });
      if (e) e.fromWorld = true;
    }
  }

  /**
   * Create an enemy of `key` at (x, y) with worldgen anchor semantics:
   * floor = centre-bottom, ceiling = centre-top (hanging), air = centre.
   * opts: { anchor, depth, minion, state }
   */
  spawn(key, x, y, opts = {}) {
    const def = ENEMY_DEFS[key];
    if (!def) return null;
    const e = this.pool.pop() || new Enemy();
    const anchor = opts.anchor || ENEMY_SPAWN_RULES[key].anchor;
    e.key = key; e.def = def; e.w = def.w; e.h = def.h;
    e.x = x - e.w / 2;
    e.y = anchor === 'floor' ? y - e.h : anchor === 'ceiling' ? y + (key === 'spider' ? AI.spider.hang : 0) : y - e.h / 2;
    e.prevX = e.x; e.prevY = e.y;
    e.homeX = e.x; e.homeY = e.y; e.anchorY = y;
    e.vx = 0; e.vy = 0;
    const depth = opts.depth ?? Math.max(0, Math.floor((e.y + e.h / 2) / TILE) - SURFACE_Y);
    const ng = this.ngPlus;
    e.depth = depth;
    e.maxHp = Math.max(1, Math.round(scaleStat(def.hp, depth, 'hp', ng)));
    e.hp = e.maxHp;
    e.dmg = Math.max(1, Math.round(scaleStat(def.dmg, depth, 'dmg', ng)));
    e.projDmg = def.projDmg ? Math.max(1, Math.round(scaleStat(def.projDmg, depth, 'dmg', ng))) : 0;
    e.gold = Math.max(1, Math.round(def.gold * (1 + depth * DROPS.goldPerM)));
    e.alive = true; e.active = false; e.dying = 0; e.noDrops = false;
    e.fromWorld = false; e.respawned = false; e.minion = !!opts.minion;
    e.facing = this.rng.chance(0.5) ? 1 : -1;
    e.onGround = false; e.flash = 0; e.stun = 0; e.cd = this.rng.float(0.3, 1.2);
    e.animT = this.rng.float(0, 2); e.stateT = 0; e.losT = 0; e.sees = false; e.alpha = 1;
    e.phase = 0; e.last = ''; e.forced = ''; e.boomT = 0; e.aux = 0; e.wander = false; e.revealT = 0;
    let state;
    switch (key) {
      case 'bat': state = anchor === 'ceiling' ? 'sleep' : 'fly'; break;
      case 'spider': state = anchor === 'ceiling' ? 'hang' : 'walk'; break;
      case 'ghost': state = 'float'; e.alpha = AI.ghost.alpha; break;
      case 'imp': state = 'fly'; break;
      case 'guardian': state = 'dormant'; e.facing = -1; break;
      case 'slime': state = 'idle'; break;
      default: state = 'walk';
    }
    e.state = opts.state || state;
    if (key === 'guardian') this.boss = e;
    this.list.push(e);
    return e;
  }

  get count() { return this.list.length; }

  _set(e, state) { e.state = state; e.stateT = 0; }

  // ---------------------------------------------------------------- update

  update(dt) {
    const g = this.game, cam = g.camera;
    this.time += dt;
    const ccx = cam.x + cam.viewW / 2, ccy = cam.y + cam.viewH / 2;
    const rx = cam.viewW * ENEMY_ACTIVE.rangeX, ry = cam.viewH * ENEMY_ACTIVE.rangeY;
    const far = cam.viewW * SP.despawnScreens;
    const list = this.list;
    let nActive = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      e.prevX = e.x; e.prevY = e.y;
      if (!e.alive) continue;
      const ex = e.x + e.w / 2, ey = e.y + e.h / 2;
      const adx = Math.abs(ex - ccx), ady = Math.abs(ey - ccy);
      // the boss thinks whenever it fights, or when the player is inside its arena
      e.active = (adx < rx && ady < ry) || (e === this.boss && (e.state !== 'dormant' || this.playerInArena()));
      if (!e.active) {
        if (e.respawned && (adx > far || ady > far)) e.alive = false; // recycle far respawns
        continue;
      }
      nActive++;
      this._think(e, dt);
    }
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].alive) continue;
      const e = list[i];
      list[i] = list[list.length - 1];
      list.pop();
      if (e === this.boss) this.boss = null;
      this.pool.push(e);
    }
    this.activeCount = nActive;
    this._updateProjectiles(dt);
    this._respawn(dt);
  }

  _think(e, dt) {
    e.animT += dt; e.stateT += dt; e.flash -= dt; e.stun -= dt; e.cd -= dt;
    if (e.key === 'guardian') { this._guardian(e, dt); this._contact(e); return; }
    if (e.dying > 0) {
      e.dying -= dt;
      if (e.dying <= 0) this._burst(e);
      return;
    }
    switch (e.key) {
      case 'slime': this._slime(e, dt); break;
      case 'bat': this._bat(e, dt); break;
      case 'skeleton': this._skeleton(e, dt); break;
      case 'spider': this._spider(e, dt); break;
      case 'ghost': this._ghost(e, dt); break;
      case 'imp': this._imp(e, dt); break;
      case 'golem': this._golem(e, dt); break;
      default: break;
    }
    // flyers never follow the player up into the camp (the surface is safe ground)
    if (FLYING[e.key] && e.y < CAMP_CEIL) { e.y = CAMP_CEIL; if (e.vy < 0) e.vy = 0; }
    // walkers that stumble into lava burn
    if (!FLYING[e.key] && this.game.world.rectHazard(e.x + 1, e.y + 2, e.w - 2, e.h - 2) > 0) {
      e.noDrops = true;
      this.game.particles.spawn('ember', e.x + e.w / 2, e.y + e.h, { count: 12, spread: e.w });
      this.kill(e);
      return;
    }
    this._contact(e);
  }

  /** Contact damage to the player (i-frames and knockback are handled by player.takeDamage). */
  _contact(e) {
    const p = this.game.player;
    if (p.dead || this.truce || e.stun > 0 || e.dying > 0 || !e.alive) return;
    let mul = 1;
    switch (e.state) {
      case 'retreat': case 'dormant': case 'intro': case 'phase': case 'dying': return;
      case 'charge': mul = e.key === 'golem' ? AI.golem.chargeDmgMul : e.key === 'guardian' ? BOSS.chargeDmgMul : 1; break;
      default: break;
    }
    const s = AI.contactShrink;
    // the charging Guardian runs head down: its contact box is lower, so it can be jumped
    const duck = e.key === 'guardian' && e.state === 'charge' ? BOSS.chargeDuck : 0;
    if (!overlap(e.x + s, e.y + s + duck, e.w - 2 * s, e.h - 2 * s - duck, p.x, p.y, p.w, p.h)) return;
    if (p.takeDamage(e.dmg * mul, e.x + e.w / 2, { cause: e.key })) {
      if (e.key === 'bat') { this._set(e, 'flee'); }
      else if (e.key === 'ghost') { this._set(e, 'retreat'); }
      if (e.state === 'sleep') this._set(e, 'fly');
    }
  }

  _gravity(e, dt) { e.vy = Math.min(AI.maxFall, e.vy + AI.gravity * dt); }

  _move(e, dt) {
    const res = moveAndCollide(e, dt, this.game.world, this._res);
    e.onGround = res.onGround;
    return res;
  }

  /** Cached line of sight from the enemy's eyes to the player's centre (re-tested every 0.15 s). */
  _sees(e, dt) {
    e.losT -= dt;
    if (e.losT <= 0) {
      e.losT = 0.15;
      const p = this.game.player;
      e.sees = lineOfSight(this.game.world, e.x + e.w / 2, e.y + Math.min(6, e.h / 2), p.cx, p.cy);
    }
    return e.sees;
  }

  /** True when the floor continues one step ahead of a walker facing `dir`. */
  _floorAhead(e, dir) {
    const w = this.game.world;
    const fx = dir > 0 ? e.x + e.w + 1 : e.x - 1;
    return w.isSolid(Math.floor(fx / TILE), Math.floor((e.y + e.h + 2) / TILE));
  }

  // ---------------------------------------------------------------- behaviours

  /** Gelée: idles, squashes (telegraph) then hops toward a nearby player. */
  _slime(e, dt) {
    const A = AI.slime, p = this.game.player, g = this.game;
    const dx = p.cx - (e.x + e.w / 2), dy = p.cy - (e.y + e.h / 2);
    this._gravity(e, dt);
    if (e.onGround && e.stun <= 0) {
      e.vx = approach(e.vx, 0, 700 * dt);
      if (e.state === 'air') {
        this._set(e, 'land');
        if (this._onScreen(e)) g.particles.spawn('land', e.x + e.w / 2, e.y + e.h, { count: 3 });
      }
      if (e.state === 'land' && e.stateT > 0.14) this._set(e, 'idle');
      const aggro = !p.dead && Math.abs(dx) < A.aggroX && Math.abs(dy) < A.aggroY;
      if (e.state === 'idle' && e.cd <= 0) {
        e.wander = !aggro;
        e.facing = aggro ? (dx >= 0 ? 1 : -1) : (this.rng.chance(0.5) ? 1 : -1);
        if (e.wander && !this._floorAhead(e, e.facing)) e.facing = -e.facing;
        this._set(e, 'squash');
      }
      if (e.state === 'squash' && e.stateT >= A.squash) {
        const k = e.wander ? 0.45 : 1;
        e.vx = e.facing * A.hopVx * k * (0.85 + this.rng.next() * 0.3);
        e.vy = -A.hopVy * (e.wander ? 0.6 : 1);
        e.onGround = false;
        this._set(e, 'air');
        e.cd = e.wander ? this.rng.float(1.6, 3.2) : this.rng.float(A.hopEvery[0], A.hopEvery[1]);
        if (this._onScreen(e)) g.audio.play('squish', { pitch: 0.9 + this.rng.next() * 0.3 });
      }
    } else if (!e.onGround && e.state !== 'air' && e.stun <= 0) this._set(e, 'air');
    else if (e.onGround && e.stun > 0) e.vx = approach(e.vx, 0, 500 * dt);
    const vx0 = e.vx;
    const res = this._move(e, dt);
    if (res.hitLeft || res.hitRight) e.vx = -vx0 * 0.3;
  }

  /** Chauve-souris: sleeps on the ceiling, wakes near the player, sine flight toward them. */
  _bat(e, dt) {
    const A = AI.bat, p = this.game.player, world = this.game.world;
    const ex = e.x + e.w / 2, ey = e.y + e.h / 2;
    const dx = p.cx - ex, dy = p.cy - 4 - ey;
    const dist = Math.hypot(dx, dy);
    switch (e.state) {
      case 'sleep': {
        e.vx = 0; e.vy = 0;
        const unsupported = !world.isSolid(Math.floor(ex / TILE), Math.floor((e.anchorY - 1) / TILE));
        if (unsupported || (!p.dead && dist < A.wake && this._sees(e, dt))) {
          this._set(e, 'wake');
          if (this._onScreen(e)) this.game.audio.play('bat', {});
        }
        return;
      }
      case 'wake':
        e.vy = 30;
        if (e.stateT > 0.3) this._set(e, 'fly');
        break;
      case 'flee': {
        const s = dist > 0 ? 1 / dist : 0;
        e.vx = approach(e.vx, -dx * s * e.def.speed * 1.2, 400 * dt);
        e.vy = approach(e.vy, -e.def.speed * 0.9, 400 * dt);
        if (e.stateT > A.flee) this._set(e, 'fly');
        break;
      }
      default: { // fly
        if (e.stun > 0) { e.vx = approach(e.vx, 0, 300 * dt); e.vy = approach(e.vy, 0, 300 * dt); break; }
        if (p.dead || dist > A.giveUp) {
          e.vx = approach(e.vx, Math.cos(e.animT * 0.9) * 30, 120 * dt);
          e.vy = approach(e.vy, Math.sin(e.animT * 1.7) * 20, 120 * dt);
        } else {
          const s = dist > 0 ? e.def.speed / dist : 0;
          e.vx = approach(e.vx, dx * s, 260 * dt);
          e.vy = approach(e.vy, dy * s + Math.cos(e.animT * A.bobFreq) * A.bob, 320 * dt);
        }
        if (Math.abs(e.vx) > 4) e.facing = e.vx > 0 ? 1 : -1;
      }
    }
    const res = this._move(e, dt);
    if (res.hitLeft || res.hitRight) e.vy -= 360 * dt; // slide up along walls instead of sticking
    if (res.hitCeiling && e.state === 'flee') this._set(e, 'fly');
  }

  /** Squelette: patrols (turns at ledges / walls), telegraphs then lobs bones at the player. */
  _skeleton(e, dt) {
    const A = AI.skeleton, p = this.game.player;
    const ex = e.x + e.w / 2;
    const dx = p.cx - ex, dy = p.cy - (e.y + 6);
    this._gravity(e, dt);
    const inRange = !p.dead && Math.abs(dx) < A.sight && Math.abs(dy) < A.sightY;
    switch (e.state) {
      case 'windup':
        e.vx = approach(e.vx, 0, 500 * dt);
        e.facing = dx >= 0 ? 1 : -1;
        if (e.stateT >= A.windup) {
          this._throwBone(e);
          this._set(e, 'throw');
          e.cd = this.rng.float(A.cooldown[0], A.cooldown[1]);
        }
        break;
      case 'throw':
        e.vx = approach(e.vx, 0, 500 * dt);
        if (e.stateT > 0.32) this._set(e, 'walk');
        break;
      default: // walk
        if (e.stun > 0) { e.vx = approach(e.vx, 0, 400 * dt); break; }
        if (inRange && e.cd <= 0 && e.onGround && this._sees(e, dt)) {
          this._set(e, 'windup');
          this.game.audio.play('telegraph', { pitch: 1.2 });
          break;
        }
        if (e.onGround && (!this._floorAhead(e, e.facing))) e.facing = -e.facing;
        e.vx = approach(e.vx, e.facing * e.def.speed, 300 * dt);
    }
    const vx0 = e.vx;
    const res = this._move(e, dt);
    if (e.state === 'walk' && (res.hitLeft || res.hitRight) && e.stun <= 0) { e.facing = vx0 > 0 ? -1 : 1; }
  }

  _throwBone(e) {
    const A = AI.skeleton, p = this.game.player;
    const x = e.x + e.w / 2 + e.facing * 4, y = e.y + 4;
    const T = A.boneTime;
    let vx = (p.cx - x) / T;
    let vy = (p.cy - y - 0.5 * A.boneGrav * T * T) / T;
    const m = Math.hypot(vx, vy);
    if (m > A.boneMaxV) { vx *= A.boneMaxV / m; vy *= A.boneMaxV / m; }
    this.fire('bone', x, y, vx, vy, e.projDmg);
    this.game.audio.play('throw', {});
  }

  /** Araignée: hangs on a thread, drops when the player passes below, then runs at them. */
  _spider(e, dt) {
    const A = AI.spider, p = this.game.player, world = this.game.world, g = this.game;
    const ex = e.x + e.w / 2;
    const dx = p.cx - ex;
    switch (e.state) {
      case 'hang': case 'shake': {
        e.vx = 0; e.vy = 0;
        e.y = e.anchorY + A.hang + Math.sin(e.animT * 2) * 1.2;
        const unsupported = !world.isSolid(Math.floor(ex / TILE), Math.floor((e.anchorY - 1) / TILE));
        if (e.state === 'hang') {
          const below = p.y > e.y && p.y - e.y < A.triggerY && Math.abs(dx) < A.triggerX + p.w / 2;
          if (unsupported || (!p.dead && below && this._sees(e, dt))) {
            this._set(e, 'shake');
            if (this._onScreen(e)) g.audio.play('telegraph', { pitch: 1.6 });
          }
        } else if (e.stateT >= A.shake || unsupported) {
          this._set(e, 'drop');
          e.vy = 40;
          if (this._onScreen(e)) g.audio.play('spider', {});
        }
        return;
      }
      case 'drop':
        this._gravity(e, dt);
        this._move(e, dt);
        if (e.onGround) {
          this._set(e, 'walk');
          e.aux = this.rng.float(A.run[0], A.run[1]);
          if (this._onScreen(e)) g.particles.spawn('land', ex, e.y + e.h, { count: 4 });
        }
        return;
      case 'pause':
        this._gravity(e, dt);
        e.vx = approach(e.vx, 0, 600 * dt);
        if (e.stateT >= e.aux) { this._set(e, 'walk'); e.aux = this.rng.float(A.run[0], A.run[1]); }
        break;
      default: // walk (scuttle toward the player)
        this._gravity(e, dt);
        if (e.stun > 0) { e.vx = approach(e.vx, 0, 500 * dt); break; }
        if (!p.dead && Math.abs(dx) > 4) e.facing = dx > 0 ? 1 : -1;
        e.vx = approach(e.vx, e.facing * e.def.speed, 700 * dt);
        if (e.stateT >= e.aux) { this._set(e, 'pause'); e.aux = this.rng.float(A.pause[0], A.pause[1]); }
    }
    const vx0 = e.vx;
    const res = this._move(e, dt);
    if ((res.hitLeft || res.hitRight) && e.stun <= 0) {
      // hop over a one-tile step, otherwise turn around
      if (e.onGround && !world.isSolid(Math.floor((vx0 > 0 ? e.x + e.w + 1 : e.x - 1) / TILE), Math.floor((e.y - 8) / TILE))) e.vy = -200;
      else e.facing = vx0 > 0 ? -1 : 1;
    }
  }

  /** Spectre: floats through walls toward the player, semi-transparent, drifts off after a hit. */
  _ghost(e, dt) {
    const A = AI.ghost, p = this.game.player;
    const ex = e.x + e.w / 2, ey = e.y + e.h / 2;
    const dx = p.cx - ex, dy = p.cy - ey;
    const dist = Math.hypot(dx, dy);
    const sp = e.def.speed;
    if (e.state === 'retreat') {
      const s = dist > 0 ? sp * 1.3 / dist : 0;
      e.vx = approach(e.vx, -dx * s, 200 * dt);
      e.vy = approach(e.vy, -dy * s - 10, 200 * dt);
      e.alpha = approach(e.alpha, 0.22, dt);
      if (e.stateT > A.drift) this._set(e, 'float');
    } else if (e.stun > 0) {
      e.vx = approach(e.vx, 0, 220 * dt); e.vy = approach(e.vy, 0, 220 * dt);
    } else if (!p.dead && dist < A.aggro) {
      const s = dist > 0 ? sp / dist : 0;
      e.vx = approach(e.vx, dx * s, 90 * dt);
      e.vy = approach(e.vy, dy * s + Math.sin(e.animT * 3) * 10, 90 * dt);
      e.alpha = approach(e.alpha, A.alpha + Math.sin(e.animT * 4) * 0.08, dt);
    } else {
      e.vx = approach(e.vx, Math.cos(e.animT * 0.7) * 12, 40 * dt);
      e.vy = approach(e.vy, Math.sin(e.animT * 1.3) * 8 + (e.homeY - e.y) * 0.3, 40 * dt);
      e.alpha = approach(e.alpha, A.alpha * 0.8, dt);
    }
    if (Math.abs(dx) > 3 && e.state !== 'retreat') e.facing = dx > 0 ? 1 : -1;
    e.state = e.state === 'retreat' ? 'retreat' : dist < 40 && !p.dead ? 'attack' : 'float';
    e.x += e.vx * dt; e.y += e.vy * dt;
    // stay inside the mine (never above the camp ground)
    const minX = BEDROCK_COLS * TILE, maxX = (WORLD_W - BEDROCK_COLS) * TILE - e.w;
    if (e.x < minX) e.x = minX; else if (e.x > maxX) e.x = maxX;
    const minY = (SURFACE_Y + 3) * TILE;
    if (e.y < minY) { e.y = minY; if (e.vy < 0) e.vy = 0; }
  }

  /** Diablotin de feu: hovers beside / above the player, charges then shoots fireballs. */
  _imp(e, dt) {
    const A = AI.imp, p = this.game.player;
    const ex = e.x + e.w / 2, ey = e.y + e.h / 2;
    const dx = p.cx - ex, dy = p.cy - ey;
    const dist = Math.hypot(dx, dy);
    const aggro = !p.dead && dist < A.aggro;
    if (Math.abs(dx) > 3) e.facing = dx > 0 ? 1 : -1;
    switch (e.state) {
      case 'charge':
        e.vx = approach(e.vx, 0, 200 * dt);
        e.vy = approach(e.vy, Math.sin(e.animT * 8) * 8, 200 * dt);
        if (e.stateT >= A.windup) {
          const s = dist > 0 ? A.fireSpeed / dist : 0;
          const fx = ex + e.facing * 6, fy = ey + 1;
          this.fire('fireball', fx, fy, dx * s, dy * s, e.projDmg);
          this.game.audio.play('fireball', {});
          this._set(e, 'cast');
          e.cd = this.rng.float(A.cooldown[0], A.cooldown[1]);
        }
        break;
      case 'cast':
        if (e.stateT > 0.3) this._set(e, 'fly');
        break;
      default: { // fly
        if (e.stun > 0) { e.vx = approach(e.vx, 0, 260 * dt); e.vy = approach(e.vy, 0, 260 * dt); break; }
        let tx, ty;
        if (aggro) { tx = p.cx - (dx >= 0 ? 1 : -1) * A.keepDist; ty = p.cy - A.hover; }
        else { tx = e.homeX + e.w / 2 + Math.cos(e.animT * 0.6) * 24; ty = e.homeY + e.h / 2; }
        const ddx = tx - ex, ddy = ty - ey, dd = Math.hypot(ddx, ddy);
        const s = dd > 4 ? e.def.speed / dd : 0;
        e.vx = approach(e.vx, ddx * s, 200 * dt);
        e.vy = approach(e.vy, ddy * s + Math.sin(e.animT * 6) * 14, 240 * dt);
        if (aggro && e.cd <= 0 && dist < A.aggro * 0.9 && this._sees(e, dt)) {
          this._set(e, 'charge');
          this.game.audio.play('charge', {});
        }
      }
    }
    this._move(e, dt);
  }

  /** Golem: slow heavy patrol; when the player is level with it, stomps (telegraph) then charges. */
  _golem(e, dt) {
    const A = AI.golem, p = this.game.player, g = this.game;
    const ex = e.x + e.w / 2;
    const dx = p.cx - ex;
    this._gravity(e, dt);
    switch (e.state) {
      case 'windup':
        e.vx = 0;
        if (Math.floor(e.stateT / 0.25) !== Math.floor((e.stateT - dt) / 0.25) && this._onScreen(e)) {
          g.particles.spawn('dust', ex - e.facing * 8, e.y + e.h, { count: 3 });
          g.camera.shake(1, 0.08);
        }
        if (e.stateT >= A.windup) { this._set(e, 'charge'); g.audio.play('roar', { pitch: 1.6, volume: 0.6 }); }
        break;
      case 'charge': {
        e.vx = e.facing * A.chargeSpeed;
        if (this._onScreen(e) && Math.floor(e.stateT * 12) !== Math.floor((e.stateT - dt) * 12)) g.particles.spawn('dust', ex - e.facing * 10, e.y + e.h, { count: 2 });
        if (e.stateT >= A.chargeTime || (e.onGround && !this._floorAhead(e, e.facing))) { this._set(e, 'walk'); e.vx = 0; e.cd = 1.4; }
        break;
      }
      case 'stun':
        e.vx = approach(e.vx, 0, 400 * dt);
        if (e.stateT >= A.stun) { this._set(e, 'walk'); e.cd = 1.8; }
        break;
      default: { // walk
        if (e.stun > 0) { e.vx = approach(e.vx, 0, 300 * dt); break; }
        const level = Math.abs(p.feetY - (e.y + e.h)) < A.sightY;
        if (!p.dead && level && Math.abs(dx) < A.sightX && e.cd <= 0 && e.onGround && this._sees(e, dt)) {
          e.facing = dx >= 0 ? 1 : -1;
          this._set(e, 'windup');
          g.audio.play('telegraph', { pitch: 0.6 });
          break;
        }
        if (e.onGround && !this._floorAhead(e, e.facing)) e.facing = -e.facing;
        e.vx = approach(e.vx, e.facing * e.def.speed, 200 * dt);
        // heavy footsteps
        const step = Math.floor(e.animT * 2);
        if (step !== e.aux) { e.aux = step; if (this._onScreen(e)) { g.particles.spawn('dust', ex, e.y + e.h, { count: 2 }); g.audio.play('land', { volume: 0.25 }); } }
      }
    }
    const vx0 = e.vx;
    const res = this._move(e, dt);
    if (res.hitLeft || res.hitRight) {
      if (e.state === 'charge') {
        this._set(e, 'stun');
        g.camera.shake(3.5, 0.3);
        g.audio.play('slam', { volume: 0.7 });
        g.particles.spawn('debris', ex + e.facing * 14, e.y + e.h / 2, { tileId: TILE_ID.BASALT, count: 10 });
        e.vx = -e.facing * 40;
      } else if (e.stun <= 0) e.facing = vx0 > 0 ? -1 : 1;
    }
  }

  // ---------------------------------------------------------------- the Guardian (boss)

  /** Player fully inside the arena interior (safe to seal the gates above them). */
  playerInArena() {
    const a = this.arena, p = this.game.player;
    if (!a) return false;
    return p.y >= (a.outer.y0 + 2) * TILE && p.feetY <= (a.y1 + 1) * TILE + 1 && p.cx >= a.x0 * TILE && p.cx <= (a.x1 + 1) * TILE;
  }



  setGates(sealed) {
    const a = this.arena, g = this.game;
    if (!a) return;
    const ent = a.entrance;
    for (let ty = a.outer.y0; ty <= a.outer.y0 + 1; ty++) {
      for (let tx = ent.x0; tx <= ent.x1; tx++) {
        const cur = g.world.get(tx, ty);
        if (sealed && !SOLID[cur]) g.world.set(tx, ty, TILE_ID.GATE);
        else if (!sealed && cur === TILE_ID.GATE) g.world.set(tx, ty, TILE_ID.AIR);
        g.particles.spawn('dust', tx * TILE + 8, ty * TILE + 14, { count: 3 });
        if (!sealed) g.particles.spawn('debris', tx * TILE + 8, ty * TILE + 8, { tileId: TILE_ID.GATE, count: 3 });
      }
    }
    this.gatesSealed = sealed;
    g.audio.play('gate', {});
    g.camera.shake(2.5, 0.3);
  }

  _bossAwake(e) {
    const g = this.game;
    this._set(e, 'intro');
    e.revealT = 0;
    this.setGates(true);
    g.audio.play('roar', {});
    g.camera.shake(4, 1.0);
    if (g.hud) g.hud.banner("LE GARDIEN DE L'ABYSSE", 'Le Cœur se referme sur toi');
  }

  _minions() {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) { const m = this.list[i]; if (m.alive && m.minion && m.dying <= 0) n++; }
    return n;
  }

  _guardian(e, dt) {
    const g = this.game, p = g.player, a = this.arena;
    if (!a) return;
    const floorY = (a.y1 + 1) * TILE;
    e.y = floorY - e.h; e.vy = 0;
    const bMin = a.x0 * TILE + 2, bMax = (a.x1 + 1) * TILE - e.w - 2; // walkable span
    const ex = e.x + e.w / 2;
    const dx = p.cx - ex;
    const ph = e.phase;
    if (e.state !== 'dormant') e.revealT += dt;
    switch (e.state) {
      case 'dormant':
        if (!p.dead && this.playerInArena()) this._bossAwake(e);
        return;
      case 'intro':
        e.facing = dx >= 0 ? 1 : -1;
        if (e.stateT >= BOSS.intro) { this._set(e, 'walk'); e.cd = 0.8; }
        return;
      case 'phase':
        e.vx = 0;
        if (e.stateT < 0.05) { g.audio.play('roar', { pitch: 0.9 }); g.camera.shake(4, 0.8); }
        if (Math.floor(e.stateT * 10) !== Math.floor((e.stateT - dt) * 10)) g.particles.spawn(ph >= 2 ? 'ember' : 'poof', ex, e.y + 10, { count: 6, color: '#a45ee8', spread: 30 });
        if (e.stateT >= BOSS.phaseTime) { this._set(e, 'walk'); e.cd = 0.6; }
        return;
      case 'dying': this._bossDying(e, dt); return;
      case 'slam_wind':
        e.vx = 0;
        if (e.stateT >= BOSS.slamWindup[ph]) { this._set(e, 'slam'); this._slam(e); }
        return;
      case 'slam':
        if (ph >= 1 && e.aux === 0 && e.stateT >= 0.45) { e.aux = 1; this._slam(e); }
        if (e.stateT >= (ph >= 1 ? 0.75 : 0.35)) { this._set(e, 'recover'); e.aux = BOSS.slamRecover; }
        return;
      case 'swipe_wind':
        e.vx = 0;
        if (e.stateT >= BOSS.swipeWindup) { this._set(e, 'swipe'); g.audio.play('swing', { pitch: 0.5 }); g.audio.play('roar', { pitch: 2, volume: 0.4 }); }
        return;
      case 'swipe': {
        // the claw sweeps the whole body height (and a little above the head) in front of it
        const x0 = e.facing > 0 ? ex : ex - 60;
        if (!p.dead && overlap(x0, e.y - BOSS.swipeReachUp, 60, e.h + BOSS.swipeReachUp, p.x, p.y, p.w, p.h)) this._bossHit(e.dmg * BOSS.swipeDmgMul, ex);
        if (e.stateT >= 0.18) { this._set(e, 'recover'); e.aux = 0.55; }
        return;
      }
      case 'claw_wind':
        // crouches, then claws upward: the answer to a player hanging on a rope, standing on a
        // platform or bouncing on its head (in every phase)
        e.vx = 0;
        if (Math.abs(dx) > 6) e.facing = dx > 0 ? 1 : -1;
        if (e.stateT >= BOSS.clawWindup) {
          this._set(e, 'claw');
          g.audio.play('swing', { pitch: 0.4 });
          g.audio.play('roar', { pitch: 1.7, volume: 0.45 });
          for (let k = -2; k <= 2; k++) g.particles.spawn('spark', ex + k * 14, e.y - 10 - (2 - Math.abs(k)) * 12, { count: 2 });
        }
        return;
      case 'claw':
        // both claws sweep up over the head: reaches whoever it chose it for (clawRange)
        if (!p.dead && overlap(ex - BOSS.clawRange + 2, e.y - BOSS.clawReach, 2 * BOSS.clawRange - 4, BOSS.clawReach + e.h * 0.5, p.x, p.y, p.w, p.h)) this._bossHit(e.dmg * BOSS.clawDmgMul, ex);
        if (e.stateT >= 0.2) { this._set(e, 'recover'); e.aux = 0.6; }
        return;
      case 'summon_wind':
        e.vx = 0;
        if (Math.floor(e.stateT * 8) !== Math.floor((e.stateT - dt) * 8)) g.particles.spawn('poof', ex, e.y + 6, { count: 3, color: '#8a2ab0' });
        if (e.stateT >= BOSS.summonWindup) { this._summon(e); this._set(e, 'recover'); e.aux = 0.7; }
        return;
      case 'rain_wind':
        e.vx = 0;
        if (Math.floor(e.stateT * 10) !== Math.floor((e.stateT - dt) * 10)) g.particles.spawn('ember', ex, e.y + 4, { count: 3, spread: 24 });
        if (e.stateT >= BOSS.rainWindup) { this._fireRain(e); this._set(e, 'recover'); e.aux = 1.0; }
        return;
      case 'charge_wind':
        e.vx = 0;
        e.facing = dx >= 0 ? 1 : -1;
        if (Math.floor(e.stateT * 6) !== Math.floor((e.stateT - dt) * 6)) { g.particles.spawn('dust', ex - e.facing * 16, floorY, { count: 4 }); g.camera.shake(1.2, 0.1); }
        if (e.stateT >= BOSS.chargeWindup) { this._set(e, 'charge'); g.audio.play('roar', { pitch: 1.3 }); }
        return;
      case 'charge':
        e.vx = e.facing * BOSS.chargeSpeed;
        e.x += e.vx * dt;
        if (Math.floor(e.stateT * 14) !== Math.floor((e.stateT - dt) * 14)) g.particles.spawn('dust', ex - e.facing * 18, floorY, { count: 3 });
        if (e.x <= bMin || e.x >= bMax || e.stateT > 5) {
          e.x = Math.max(bMin, Math.min(bMax, e.x));
          this._set(e, 'stun');
          e.vx = 0;
          g.camera.shake(6, 0.5);
          g.audio.play('slam', {});
          g.particles.spawn('debris', e.facing > 0 ? e.x + e.w : e.x, e.y + e.h / 2, { tileId: TILE_ID.ARENA, count: 16 });
          for (let k = 0; k < 5; k++) g.particles.spawn('debris', a.x0 * TILE + this.rng.next() * (a.x1 - a.x0) * TILE, (a.y0 + 0.5) * TILE, { tileId: TILE_ID.ARENA, count: 2 });
        }
        return;
      case 'stun':
        if (e.stateT >= BOSS.chargeStun) { this._set(e, 'walk'); e.cd = BOSS.attackGap[ph]; }
        return;
      case 'recover':
        e.vx = approach(e.vx, 0, 400 * dt);
        if (e.stateT >= e.aux) { this._set(e, 'walk'); e.cd = BOSS.attackGap[ph]; }
        return;
      default: { // walk toward the player, pick attacks
        const spd = BOSS.walkSpeed[ph];
        if (Math.abs(dx) > 6) e.facing = dx > 0 ? 1 : -1;
        e.vx = approach(e.vx, Math.abs(dx) > 34 ? e.facing * spd : 0, 220 * dt);
        e.x = Math.max(bMin, Math.min(bMax, e.x + e.vx * dt));
        if (e.cd <= 0 && !p.dead) this._bossChoose(e, dx);
      }
    }
  }

  _bossChoose(e, dx) {
    const ph = e.phase, g = this.game, p = g.player;
    const adx = Math.abs(dx);
    const level = Math.abs(p.feetY - (e.y + e.h)) < 40;      // the player is on the arena floor
    const above = p.feetY < e.y + BOSS.clawAbove;            // on a rope / platform / its head
    let pick = '';
    if (e.forced) {
      // the phase's signature attack opens it (phase 3: fire rain, then a charge)
      const f = e.forced;
      e.forced = f === 'rain' ? 'charge' : '';
      if (f === 'summon' && this._minions() >= BOSS.maxMinions) pick = '';
      else if (f === 'charge' && !level) pick = '';
      else pick = f;
    }
    if (pick) { /* forced */ }
    else if (above && adx < BOSS.clawRange && e.last !== 'claw') pick = 'claw';
    else if (adx < BOSS.swipeRange && e.last !== 'swipe') pick = 'swipe';
    else {
      // weighted choice without allocation
      const wSlam = e.last === 'slam' ? 0.4 : 1.2;
      const wSummon = ph >= 1 && this._minions() < BOSS.maxMinions && e.last !== 'summon' ? 1 : 0;
      const wRain = ph >= 2 && e.last !== 'rain' ? 1.3 : 0;
      const wCharge = ph >= 2 && e.last !== 'charge' && level && adx > 40 ? 1.1 : 0;
      let r = this.rng.next() * (wSlam + wSummon + wRain + wCharge);
      if ((r -= wSlam) < 0) pick = 'slam';
      else if ((r -= wSummon) < 0) pick = 'summon';
      else if ((r -= wRain) < 0) pick = 'rain';
      else pick = 'charge';
    }
    e.last = pick;
    e.aux = 0;
    this._set(e, pick + '_wind');
    g.audio.play('telegraph', { pitch: 0.5 });
  }

  _slam(e) {
    const g = this.game, p = g.player, a = this.arena;
    const floorY = (a.y1 + 1) * TILE;
    const ex = e.x + e.w / 2;
    g.camera.shake(5, 0.4);
    g.audio.play('slam', {});
    for (let s = -1; s <= 1; s += 2) {
      g.particles.spawn('debris', ex + s * 22, floorY - 2, { tileId: TILE_ID.ARENA, count: 8 });
      g.particles.spawn('dust', ex + s * 22, floorY, { count: 5 });
      this.fire('shock', ex + s * 26, floorY - 7, s * BOSS.shockSpeed, 0, Math.round(e.projDmg * BOSS.shockDmgMul));
    }
    // the fists themselves: they come down from above the head, anything beside the body is hit
    if (!p.dead && Math.abs(p.cx - ex) < 40 && p.feetY > e.y - 6) this._bossHit(e.projDmg * BOSS.shockDmgMul, ex);
  }

  /** A Guardian blow landed on the player: damage, and a hit knocks them off their rope. */
  _bossHit(dmg, fromX) {
    const p = this.game.player;
    if (this.truce || !p.takeDamage(dmg, fromX, { cause: 'guardian' })) return false;
    if (p.grapple && p.grapple.state === 'attached') p.grapple.release(false);
    return true;
  }

  _summon(e) {
    const g = this.game, a = this.arena;
    const ceilY = (a.y0 + 1) * TILE;
    const room = BOSS.maxMinions - this._minions();
    const ex = e.x + e.w / 2;
    g.audio.play('roar', { pitch: 1.2, volume: 0.7 });
    let made = 0;
    for (let s = -1; s <= 1; s += 2) {
      if (made >= room) break;
      const x = Math.max((a.x0 + 2) * TILE, Math.min((a.x1 - 1) * TILE, ex + s * 110));
      const m = this.spawn('bat', x, ceilY + 8, { anchor: 'air', minion: true, state: 'fly', depth: e.depth });
      if (m) { m.cd = 0.4; g.particles.spawn('poof', x, ceilY + 8, { count: 12, color: '#8a2ab0' }); made++; }
    }
    if (e.phase >= 2 && made < room) {
      const p = g.player;
      const side = p.cx < (a.x0 + a.x1) * TILE / 2 ? 1 : -1;
      const x = side > 0 ? (a.x1 - 2) * TILE : (a.x0 + 3) * TILE;
      const m = this.spawn('skeleton', x, (a.y1 + 1) * TILE, { anchor: 'floor', minion: true, depth: e.depth });
      if (m) { m.facing = -side; m.cd = 0.8; g.particles.spawn('poof', x, (a.y1 + 0.2) * TILE, { count: 14, color: '#8a2ab0' }); }
    }
  }

  _fireRain(e) {
    const g = this.game, p = g.player, a = this.arena;
    const x0 = (a.x0 + 1) * TILE, x1 = a.x1 * TILE;
    const sp = BOSS.rainSpacing;
    const y = (a.y0 + 0.3) * TILE;
    // one meteor always falls right above the player; the gaps between them are safe
    const off = ((p.cx - x0) % sp + sp) % sp;
    let k = 0;
    for (let x = x0 + off; x <= x1; x += sp, k++) this.fire('warn', x, y, 0, 0, 0, BOSS.rainWarn + (k % 3) * 0.05);
    // second, offset wave in the last phase
    if (e.phase >= 2) for (let x = x0 + off + sp / 2; x <= x1; x += sp) this.fire('warn', x, y, 0, 0, 0, BOSS.rainWarn + 1.0);
    g.audio.play('fireball', { pitch: 0.6 });
  }

  _bossDying(e, dt) {
    const g = this.game;
    e.vx = 0;
    e.boomT -= dt;
    if (e.boomT <= 0) {
      e.boomT = Math.max(0.06, 0.18 - e.stateT * 0.04);
      const x = e.x + this.rng.next() * e.w, y = e.y + this.rng.next() * e.h;
      g.particles.spawn('ember', x, y, { count: 6, spread: 8 });
      g.particles.spawn('debris', x, y, { tileId: TILE_ID.OBSIDIAN, count: 4 });
      g.particles.spawn('poof', x, y, { count: 5, color: '#a45ee8' });
      g.particles.spawn('spark', x, y, { count: 4 });
      g.audio.play('boss_hit', { pitch: 0.7 + this.rng.next() * 0.6 });
      g.camera.shake(2 + e.stateT, 0.15);
      e.flash = 0.06;
    }
    if (e.stateT >= BOSS.deathTime) this._bossFinale(e);
  }

  _bossFinale(e) {
    const g = this.game;
    const cx = e.x + e.w / 2, cy = e.y + e.h / 2;
    g.particles.spawn('poof', cx, cy, { count: 40, color: '#b070f0' });
    g.particles.spawn('ember', cx, cy, { count: 30, spread: 40 });
    g.particles.spawn('debris', cx, cy, { tileId: TILE_ID.OBSIDIAN, count: 30 });
    g.particles.spawn('blood', cx, cy, { count: 20, color: '#e0304e' });
    g.camera.shake(8, 0.9);
    g.audio.play('boss_death', {});
    if (g.hud && g.hud.flash) g.hud.flash('#ffffff', 0.6);
    if (g.entities) {
      g.entities.spawnCoins(cx, cy, e.gold, { count: BOSS.coins });
      g.entities.spawnHeart(cx - 10, cy, DROPS.heartHeal * 2);
      g.entities.spawnHeart(cx + 10, cy, DROPS.heartHeal * 2);
    }
    this._clearBossField();
    e.alive = false;
    this.bossDefeated = true;
    this.setGates(false);
    if (g.run) g.run.kills = (g.run.kills || 0) + 1;
    if (g.onBossDefeated) g.onBossDefeated();
  }

  /** The Guardian is beaten: its minions vanish (no drops) and every hostile projectile is gone. */
  _clearBossField() {
    for (let i = 0; i < this.list.length; i++) { const m = this.list[i]; if (m.alive && m.minion && m.dying <= 0) { m.noDrops = true; this.kill(m); } }
    for (const pr of this.projectiles) if (pr.active) this._killProj(pr, true);
  }

  /** World y the camera centres on during the boss fight (whole arena in view), or null. */
  get cameraFocusY() {
    const b = this.boss, a = this.arena;
    if (!a || !this.gatesSealed || !b || !b.alive || !this.playerInArena()) return null;
    return ((a.y0 + a.y1 + 2) * TILE) / 2;
  }

  /** Arena floor / interior top (world px) for the fight framing (render.js Camera). */
  get arenaFloorY() { return this.arena ? (this.arena.y1 + 1) * TILE : 0; }
  get arenaTopY() { return this.arena ? this.arena.y0 * TILE : 0; }

  /** HUD data for the boss bar, or null when no fight is on (object reused). */
  get bossBar() {
    const b = this.boss;
    if (!b || !b.alive || b.state === 'dormant') return null;
    const o = this._bar;
    o.name = b.def.name; o.hp = b.hp; o.maxHp = b.maxHp; o.phase = b.phase;
    o.reveal = Math.min(1, b.revealT / 1.2); o.flash = Math.max(0, b.flash); o.dying = b.state === 'dying';
    return o;
  }

  // ---------------------------------------------------------------- combat

  _invulnerable(e) {
    return e.dying > 0 || e.state === 'dormant' || e.state === 'intro' || e.state === 'phase' || e.state === 'dying';
  }

  /**
   * Apply player strike damage to every enemy overlapping `box` ({x,y,w,h} px).
   * Bones and fireballs caught in the arc are deflected (destroyed).
   * @returns {number} number of enemies hit (the caller triggers hit-stop/shake).
   */
  damageInBox(box, dmg, fromX, opts = {}) {
    let hits = 0;
    const g = this.game;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (!e.alive || e.dying > 0 || !overlap(box.x, box.y, box.w, box.h, e.x, e.y, e.w, e.h)) continue;
      if (this._invulnerable(e)) {
        if (e.state !== 'dying') { g.particles.spawn('spark', box.x + box.w / 2, box.y + box.h / 2, { count: 4 }); g.audio.play('clink', {}); }
        continue;
      }
      this.hurt(e, dmg, fromX, opts);
      hits++;
    }
    for (const pr of this.projectiles) {
      if (!pr.active || (pr.type !== 'bone' && pr.type !== 'fireball')) continue;
      if (!overlap(box.x, box.y, box.w, box.h, pr.x - pr.w / 2, pr.y - pr.h / 2, pr.w, pr.h)) continue;
      this._killProj(pr, true);
      g.audio.play('clink', {});
      g.particles.spawn('spark', pr.x, pr.y, { count: 6 });
    }
    return hits;
  }

  /** Damage an enemy: flash, knockback, stun, particles, sfx; kills at 0 hp. */
  hurt(e, dmg, fromX = null, opts = {}) {
    if (!e.alive || this._invulnerable(e)) return false;
    const g = this.game;
    const ex = e.x + e.w / 2, ey = e.y + e.h / 2;
    dmg = Math.max(1, Math.round(dmg));
    e.hp -= dmg;
    e.flash = 0.13;
    if (g.entities && g.entities.popup) g.entities.popup(String(dmg), ex, e.y - 2, '#f2e6c8');
    if (e.key === 'guardian') {
      g.particles.spawn('blood', ex + (fromX === null ? 0 : Math.sign(fromX - ex) * e.w * 0.35), ey - 6, { count: 8, color: GORE.guardian });
      g.particles.spawn('spark', ex, ey - 6, { count: 3 });
      g.audio.play('boss_hit', { pitch: 1 + this.rng.next() * 0.2 });
      // phase gating: a single blow never carries it past the next threshold
      const gate = e.phase === 0 ? BOSS.phase2 : e.phase === 1 ? BOSS.phase3 : 0;
      if (gate > 0) e.hp = Math.max(e.hp, Math.floor(e.maxHp * gate));
      const f = e.hp / e.maxHp;
      if (e.hp <= 0) { this.kill(e); return true; }
      if ((e.phase === 0 && f <= BOSS.phase2) || (e.phase === 1 && f <= BOSS.phase3)) {
        e.phase++;
        e.forced = BOSS.signature[e.phase] || '';
        this._set(e, 'phase');
        for (const pr of this.projectiles) if (pr.active && pr.type === 'warn') pr.active = false;
        if (g.hud) g.hud.toast(e.phase === 1 ? 'LE GARDIEN APPELLE SES SERVITEURS' : 'LE GARDIEN S’ENRAGE !', { color: '#ff7a95', life: 2 });
      }
      return true;
    }
    const k = 1 - e.def.kbResist;
    const sx = fromX === null ? -e.facing : ex >= fromX ? 1 : -1;
    if (opts.dir === 'up') { e.vy = -AI.knockbackY * 1.4 * k; e.vx = sx * AI.knockbackX * 0.3 * k; }
    else if (opts.dir === 'down') { e.vy = AI.knockbackY * k; e.vx = sx * AI.knockbackX * 0.4 * k; }
    else { e.vx = sx * AI.knockbackX * k; e.vy = -AI.knockbackY * (FLYING[e.key] ? 0.3 : 1) * k; }
    e.stun = AI.hitStun * (e.key === 'golem' ? 0.35 : 1);
    if (e.state === 'charge' && e.key === 'golem') e.stun = 0; // a charging golem is not stopped by a pick
    if (e.state === 'sleep') this._set(e, 'fly');
    if (e.state === 'hang' || e.state === 'shake') { this._set(e, 'drop'); }
    if (e.state === 'windup' && e.key === 'skeleton') this._set(e, 'walk'); // interrupts the throw
    if (e.state === 'charge' && e.key === 'imp') { this._set(e, 'fly'); e.cd = 0.8; } // snuffs the fireball
    g.particles.spawn('blood', ex, ey, { count: 7, color: GORE[e.key] });
    g.audio.play('enemy_hit', { pitch: HIT_PITCH[e.key] || 1 });
    if (e.hp <= 0) this.kill(e);
    return true;
  }

  /** Kill: short white flash (dying), then a burst of particles and drops. */
  kill(e) {
    if (!e.alive || e.dying > 0 || e.state === 'dying') return;
    const g = this.game;
    e.hp = 0;
    if (e.key === 'guardian') {
      this._set(e, 'dying');
      e.boomT = 0;
      this._lifeSteal(e);
      // truce: during the 3 s death sequence nothing can hurt the player any more
      this.truce = true;
      this._clearBossField();
      g.audio.play('roar', { pitch: 0.7 });
      g.hitStop(0.2);
      return;
    }
    e.dying = 0.1;
    e.vx *= 0.3;
    this._lifeSteal(e);
    g.hitStop(AI.killHitStop);
    g.camera.shake(e.key === 'golem' ? 4 : 2.2, 0.16);
    if (g.run && !e.minion) g.run.kills = (g.run.kills || 0) + 1;
  }

  /** Vampirisme relic: the player heals on every kill (not on summoned minions). */
  _lifeSteal(e) {
    const g = this.game, p = g.player;
    const heal = p && p.stats ? p.stats.killHeal : 0;
    if (!(heal > 0) || p.dead || e.minion) return;
    const n = p.heal(heal);
    if (n > 0 && g.entities && g.entities.popup) {
      g.entities.popup('+' + n + ' PV', p.cx, p.y - 10, '#ff5a7a');
      g.particles.spawn('blood', e.x + e.w / 2, e.y + e.h / 2, { count: 6, color: '#ff3a5a' });
    }
  }

  _burst(e) {
    const g = this.game;
    const x = e.x + e.w / 2, y = e.y + e.h / 2;
    const col = GORE[e.key];
    g.audio.play('enemy_death', { pitch: HIT_PITCH[e.key] || 1 });
    switch (e.key) {
      case 'slime': g.particles.spawn('blood', x, y, { count: 18, color: col }); g.particles.spawn('poof', x, y, { count: 6, color: '#35894e' }); break;
      case 'skeleton': g.particles.spawn('debris', x, y, { tileId: TILE_ID.BONE, count: 16 }); g.particles.spawn('poof', x, y, { count: 6 }); break;
      case 'ghost': g.particles.spawn('poof', x, y, { count: 20, color: col }); g.particles.spawn('glint', x, y - 4, { color: '#ffffff' }); break;
      case 'imp': g.particles.spawn('ember', x, y, { count: 18, spread: 12 }); g.particles.spawn('smoke', x, y, { count: 4 }); g.particles.spawn('spark', x, y, { count: 8 }); break;
      case 'golem':
        g.particles.spawn('debris', x, y, { tileId: TILE_ID.BASALT, count: 22 });
        g.particles.spawn('ember', x, y, { count: 10, spread: 16 });
        g.particles.spawn('dust', x, e.y + e.h, { count: 8 });
        break;
      default: g.particles.spawn('blood', x, y, { count: 12, color: col }); g.particles.spawn('poof', x, y, { count: 8, color: '#3a2840' });
    }
    e.alive = false;
    if (e.noDrops || !g.entities) return;
    if (e.minion) { if (this.rng.next() < DROPS.minionHeart) g.entities.spawnHeart(x, y - 2); return; } // no coins from summons
    g.entities.spawnCoins(x, y, e.gold);
    const p = g.player;
    const chance = p.hp < p.stats.maxHp * 0.35 ? DROPS.heartChanceLow : DROPS.heartChance;
    if (this.rng.next() < chance) g.entities.spawnHeart(x, y - 2);
  }

  // ---------------------------------------------------------------- projectiles

  /** Fire an enemy projectile ('bone' | 'fireball' | 'shock' | 'meteor' | 'warn'). Pooled. */
  fire(type, x, y, vx, vy, dmg, life = AI.projLife) {
    let pr = null;
    for (let i = 0; i < this.projectiles.length; i++) if (!this.projectiles[i].active) { pr = this.projectiles[i]; break; }
    if (!pr) return null;
    pr.active = true; pr.type = type; pr.x = x; pr.y = y; pr.px = x; pr.py = y; pr.vx = vx; pr.vy = vy; pr.dmg = dmg; pr.t = 0; pr.life = life;
    pr.floorY = this.arena ? (this.arena.y1 + 1) * TILE : y + 150;
    switch (type) {
      case 'bone': pr.w = 6; pr.h = 6; pr.grav = AI.skeleton.boneGrav; break;
      case 'fireball': pr.w = 6; pr.h = 6; pr.grav = 0; break;
      case 'shock': pr.w = 10; pr.h = 14; pr.grav = 0; break;
      case 'meteor': pr.w = 8; pr.h = 10; pr.grav = 520; break;
      default: pr.w = 1; pr.h = 1; pr.grav = 0; // warn marker: harmless, drops a meteor when it expires
    }
    return pr;
  }

  _killProj(pr, silent = false) {
    pr.active = false;
    if (silent) return;
    const g = this.game;
    switch (pr.type) {
      case 'bone': g.particles.spawn('debris', pr.x, pr.y, { tileId: TILE_ID.BONE, count: 5 }); g.audio.play('hit', { material: 'bone', volume: 0.5 }); break;
      case 'fireball': g.particles.spawn('ember', pr.x, pr.y, { count: 8, spread: 6 }); g.particles.spawn('spark', pr.x, pr.y, { count: 4 }); g.audio.play('fizz', {}); break;
      case 'meteor': g.particles.spawn('ember', pr.x, pr.y, { count: 12, spread: 10 }); g.particles.spawn('dust', pr.x, pr.y, { count: 3 }); g.camera.shake(1.2, 0.08); g.audio.play('fizz', { pitch: 0.7 }); break;
      case 'shock': g.particles.spawn('poof', pr.x, pr.y, { count: 6, color: '#a45ee8' }); break;
      default: break;
    }
  }

  _updateProjectiles(dt) {
    const g = this.game, world = g.world, p = g.player;
    for (let i = 0; i < this.projectiles.length; i++) {
      const pr = this.projectiles[i];
      if (!pr.active) continue;
      pr.px = pr.x; pr.py = pr.y;
      pr.t += dt;
      if (pr.type === 'warn') {
        if (Math.floor(pr.t * 12) !== Math.floor((pr.t - dt) * 12)) g.particles.spawn('ember', pr.x, pr.y + 2, { count: 1, spread: 6 });
        if (pr.t >= pr.life) { pr.active = false; this.fire('meteor', pr.x, pr.y, 0, 60, this.boss ? Math.round(this.boss.projDmg) : 20); }
        continue;
      }
      if (pr.t >= pr.life) { this._killProj(pr); continue; }
      pr.vy += pr.grav * dt;
      pr.x += pr.vx * dt; pr.y += pr.vy * dt;
      if (pr.type === 'shock') {
        const ahead = pr.x + Math.sign(pr.vx) * pr.w / 2;
        const tyFeet = Math.floor((pr.y + pr.h / 2 + 2) / TILE);
        if (world.isSolid(Math.floor(ahead / TILE), Math.floor(pr.y / TILE)) || !world.isSolid(Math.floor(pr.x / TILE), tyFeet)) { this._killProj(pr); continue; }
        if (Math.floor(pr.t * 20) !== Math.floor((pr.t - dt) * 20)) g.particles.spawn('dust', pr.x, pr.y + pr.h / 2, { count: 1 });
      } else if (world.isSolid(Math.floor(pr.x / TILE), Math.floor(pr.y / TILE))) {
        if (pr.type === 'fireball' || pr.type === 'meteor') {
          // fire burns soft soil (dirt, grass) it hits; rock just stops it
          const tx = Math.floor(pr.x / TILE), ty = Math.floor(pr.y / TILE), id = world.get(tx, ty);
          if (TILES[id].hp <= 1 && TILES[id].tier === 0 && !world.isLocked(tx, ty)) { world.set(tx, ty, TILE_ID.AIR); if (g.tileBroken) g.tileBroken(tx, ty, id, 'fire'); }
          pr.x -= pr.vx * dt; pr.y -= pr.vy * dt;
        }
        this._killProj(pr);
        continue;
      } else if (pr.type === 'fireball' && Math.floor(pr.t * 30) !== Math.floor((pr.t - dt) * 30)) {
        g.particles.spawn('ember', pr.x, pr.y, { count: 1, spread: 2 });
      } else if (pr.type === 'meteor' && Math.floor(pr.t * 40) !== Math.floor((pr.t - dt) * 40)) {
        g.particles.spawn('ember', pr.x, pr.y - 3, { count: 1, spread: 4 });
      }
      if (!p.dead && !this.truce && overlap(pr.x - pr.w / 2, pr.y - pr.h / 2, pr.w, pr.h, p.x, p.y, p.w, p.h)) {
        if (p.takeDamage(pr.dmg, pr.x, { cause: pr.type }) && pr.type !== 'shock') this._killProj(pr);
      }
    }
  }

  // ---------------------------------------------------------------- respawn

  _respawn(dt) {
    const g = this.game, p = g.player, cam = g.camera;
    if (p.dead) return;
    const li = layerAtDepth(p.depth).index;
    if (li >= 4 || p.depth < WORLDGEN.minSpawnDepth - 4) return;
    this.respawnT -= dt;
    if (this.respawnT > 0) return;
    this.respawnT = SP.interval[li];
    let local = 0, total = 0;
    for (let i = 0; i < this.list.length; i++) {
      const e = this.list[i];
      if (!e.alive || e.key === 'guardian') continue;
      total++;
      if (e.active && !e.minion) local++;
    }
    if (local >= SP.localCap[li] || total >= SP.globalCap) return;
    const v = this._view;
    v.x = cam.x; v.y = cam.y; v.w = cam.viewW; v.h = cam.viewH;
    const s = findSpawnSpot(g.world, this.rng.next, p.cx, p.cy, v, this._spot);
    if (!s) { this.respawnT = 1.5; return; }
    const e = this.spawn(s.key, s.x, s.y, { anchor: s.anchor });
    if (e) e.respawned = true;
  }

  // ---------------------------------------------------------------- rendering

  _onScreen(e) {
    const cam = this.game.camera;
    return e.x + e.w > cam.x - 8 && e.x < cam.x + cam.viewW + 8 && e.y + e.h > cam.y - 8 && e.y < cam.y + cam.viewH + 8;
  }

  /** Sprite name + frame for an enemy's current state. */
  _frame(e) {
    const t = e.animT;
    switch (e.key) {
      case 'slime':
        switch (e.state) {
          case 'squash': return 2;
          case 'air': return e.vy < 60 ? 3 : 1;
          case 'land': return 4;
          default: return Math.floor(t * 3) % 2;
        }
      case 'bat': return e.state === 'sleep' ? Math.floor(t * 1.5) % 2 : e.state === 'wake' ? 2 : Math.floor(t * 12) % 4;
      case 'skeleton':
        if (e.state === 'windup') return 4;
        if (e.state === 'throw') return 5;
        return Math.abs(e.vx) > 3 ? Math.floor(t * 6) % 4 : 0;
      case 'spider':
        switch (e.state) {
          case 'hang': return 4 + (Math.floor(t * 2) % 2);
          case 'shake': return 4 + (Math.floor(e.stateT * 20) % 2);
          case 'drop': return 6;
          case 'pause': return Math.floor(t * 4) % 2 ? 0 : 1;
          default: return Math.abs(e.vx) > 5 ? Math.floor(t * 14) % 4 : 0;
        }
      case 'ghost': return e.state === 'attack' ? 4 : Math.floor(t * 6) % 4;
      case 'imp': return e.state === 'charge' ? 4 + (Math.floor(e.stateT * 14) % 2) : e.state === 'cast' ? 6 : Math.floor(t * 12) % 4;
      case 'golem':
        switch (e.state) {
          case 'windup': return 4;
          case 'charge': return 5 + (Math.floor(t * 8) % 2);
          case 'stun': return 7;
          default: return Math.abs(e.vx) > 2 ? Math.floor(t * 4) % 4 : 0;
        }
      case 'guardian':
        switch (e.state) {
          case 'dormant': return 11;
          case 'intro': return e.stateT < 0.5 ? 11 : e.stateT < 0.8 ? 0 : 6;
          case 'phase': return 6;
          case 'slam_wind': return 4;
          case 'slam': return 5;
          case 'recover': return e.last === 'slam' && e.stateT < 0.35 ? 5 : e.last === 'swipe' && e.stateT < 0.2 ? 9 : e.last === 'claw' && e.stateT < 0.2 ? 4 : 0;
          case 'swipe_wind': return 8;
          case 'swipe': return 9;
          case 'claw_wind': return 5;
          case 'claw': return 4;
          case 'summon_wind': return 6;
          case 'rain_wind': return 7;
          case 'charge_wind': case 'charge': return 12;
          case 'stun': case 'dying': return 10;
          default: return Math.abs(e.vx) > 4 ? 2 + (Math.floor(t * 3) % 2) : Math.floor(t * 1.6) % 2;
        }
      default: return 0;
    }
  }

  draw(ctx, camX, camY, alpha) {
    const vw = ctx.canvas.width, vh = ctx.canvas.height;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive || !e.active) continue;
      const ix = Math.round(e.prevX + (e.x - e.prevX) * alpha) - camX;
      const iy = Math.round(e.prevY + (e.y - e.prevY) * alpha) - camY;
      if (ix + e.w < -48 || iy + e.h < -60 || ix > vw + 48 || iy > vh + 48) continue;
      this._drawEnemy(ctx, e, ix, iy);
    }
    for (let i = 0; i < this.projectiles.length; i++) {
      const pr = this.projectiles[i];
      if (!pr.active) continue;
      const x = Math.round(pr.px + (pr.x - pr.px) * alpha) - camX, y = Math.round(pr.py + (pr.y - pr.py) * alpha) - camY;
      if (x < -16 || y < -16 || x > vw + 16 || y > vh + 16) continue;
      switch (pr.type) {
        case 'bone': drawSprite(ctx, 'proj_bone', Math.floor(pr.t * 14), x, y, pr.vx < 0); break;
        case 'fireball': drawSprite(ctx, 'proj_fireball', Math.floor(pr.t * 14), x, y, pr.vx < 0); break;
        case 'shock': drawSprite(ctx, 'proj_shock', Math.floor(pr.t * 12), x, y + pr.h / 2, pr.vx < 0); break;
        case 'meteor': drawSprite(ctx, 'proj_meteor', Math.floor(pr.t * 12), x, y, false); break;
        case 'warn': {
          const k = Math.min(1, pr.t / Math.max(0.01, pr.life));
          if (Math.floor(pr.t * (6 + k * 14)) % 2 === 0 || k > 0.8) drawSprite(ctx, 'fx_warn', Math.floor(pr.t * 8), x, y, false);
          // column hint down to the floor + a pulsing target mark where it lands
          const fy = Math.round(pr.floorY) - camY;
          ctx.globalAlpha = 0.1 + 0.22 * k;
          ctx.fillStyle = '#ff5030';
          ctx.fillRect(x - 3, y + 6, 1, fy - y - 6); ctx.fillRect(x + 3, y + 6, 1, fy - y - 6);
          ctx.globalAlpha = 0.35 + 0.5 * k * (Math.floor(pr.t * 12) % 2 ? 1 : 0.6);
          ctx.fillRect(x - 4, fy - 1, 9, 1); ctx.fillRect(x - 2, fy - 2, 5, 1);
          ctx.globalAlpha = 1;
          break;
        }
        default: break;
      }
    }
  }

  _drawEnemy(ctx, e, sx, sy) {
    const flip = e.facing < 0;
    const fx = sx + e.w / 2;
    const fy = FEET[e.key] ? sy + e.h : sy + e.h / 2;
    const names = (e.key === 'bat' && (e.state === 'sleep' || e.state === 'wake')) || (e.key === 'guardian' && e.phase >= 2) ? e.def.alt : e.def.spr;
    const frame = this._frame(e);
    // spider thread
    if (e.key === 'spider' && (e.state === 'hang' || e.state === 'shake' || (e.state === 'drop' && e.stateT < 0.12))) {
      const top = Math.round(e.anchorY) - (Math.round(e.prevY) - sy);
      ctx.fillStyle = '#b8b0c8';
      ctx.globalAlpha = 0.55;
      ctx.fillRect(Math.round(fx), top, 1, Math.max(0, Math.round(fy - 3) - top));
      ctx.globalAlpha = 1;
    }
    let variant = 0; // 0 normal, 1 hit flash, 2 telegraph tint
    if (e.flash > 0 || e.dying > 0) variant = 1;
    else if (TELE[e.state] && Math.floor(e.stateT * 14) % 2 === 0) variant = 2;
    let a = 1;
    if (e.key === 'ghost') a = e.alpha;
    let yOff = 0;
    if (e.key === 'guardian' && e.state === 'dying') {
      a = Math.max(0, 1 - Math.max(0, e.stateT - BOSS.deathTime * 0.5) / (BOSS.deathTime * 0.5));
      yOff = Math.round(Math.max(0, e.stateT - 1) * 6);
      if (Math.floor(e.stateT * 30) % 2) variant = 1;
    }
    if (e.key === 'guardian' && (e.state === 'stun')) yOff = 1;
    if (a < 1) ctx.globalAlpha = a;
    drawSprite(ctx, names[variant], frame, fx, fy + yOff, flip);
    if (a < 1) ctx.globalAlpha = 1;
  }

  /** Dynamic lights (imps, ghosts, fireballs, boss, fire-rain warnings). Called once per fixed tick. */
  addLights(lighting) {
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive || !e.active) continue;
      const x = e.x + e.w / 2, y = e.y + e.h / 2;
      switch (e.key) {
        case 'imp': lighting.addLight(x, y, e.state === 'charge' ? 0.7 + 0.15 * Math.sin(e.stateT * 30) : 0.5, FIRE_LIGHT); break;
        case 'ghost': lighting.addLight(x, y, 0.3 * (e.alpha / AI.ghost.alpha), GHOST_LIGHT); break;
        case 'golem': lighting.addLight(x, e.y + 8, e.state === 'windup' || e.state === 'charge' ? 0.55 : 0.28, FIRE_LIGHT); break;
        case 'guardian':
          if (e.state !== 'dormant') lighting.addLight(x, e.y + 10, e.phase >= 2 ? 0.8 : 0.6, e.phase >= 2 ? RAGE_LIGHT : BOSS_LIGHT);
          else lighting.addLight(x, e.y + 10, 0.35, BOSS_LIGHT);
          if (e.state === 'rain_wind' || e.state === 'summon_wind') lighting.addLight(x, e.y - 8, 0.8, e.state === 'rain_wind' ? FIRE_LIGHT : ABYSS_LIGHT);
          break;
        default: break;
      }
    }
    for (let i = 0; i < this.projectiles.length; i++) {
      const pr = this.projectiles[i];
      if (!pr.active) continue;
      if (pr.type === 'fireball' || pr.type === 'meteor') lighting.addLight(pr.x, pr.y, 0.75, FIRE_LIGHT);
      else if (pr.type === 'shock') lighting.addLight(pr.x, pr.y, 0.55, ABYSS_LIGHT);
      else if (pr.type === 'warn') lighting.addLight(pr.x, pr.y + 6, 0.35 + 0.4 * Math.min(1, pr.t / pr.life), WARN_LIGHT);
    }
  }
}

