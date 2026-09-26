// Pooled particle system (struct of arrays, no allocation per particle or per frame).
//
//   new Particles(game?)                       game only gives chunk bounces against world tiles
//   spawn(kind, x, y, opts?)                   opts is read synchronously and never kept (reused buffers OK)
//   update(dt)                                 integrate (space: no gravity, gentle drag)
//   draw(ctx, camX, camY, pass = 'all')        pass 'lit' (smoke, debris, gas: drawn under the darkness
//                                              layer) | 'emissive' (fire, sparks, rings, flashes: additive,
//                                              over the darkness) | 'all'
//   clear(), alive (count after the last update)
//
// Kinds emitted by the simulation (NOTES.md "Simulation"): exhaust brake boost spark death pickup item
//   door crate satellite gas gas_warn shelter muzzle debris rock explosion.
// Presentation kinds: tile (opts.material = tile key: broken-tile chunks, for game.tileBroken), smoke,
//   embers, dust, shards (opts.material 'ice' | 'glass'), glint, flash (opts.r, opts.color = glow
//   colour key), ring (opts.r, opts.color hex), debris also accepts opts.material = tile key.
// opts fields used: vx vy nx ny count power r material color.
import { TILE } from './config.js';
import { TILE_BY_KEY, SOLID } from './tiles.js';
import { getGlow, GLOW_RADII } from './sprites.js';
import { PARTICLES } from './render-config.js';

// render styles
const S_NONE = 0, S_DOT = 1, S_STREAK = 2, S_SMOKE = 3, S_RING = 4, S_FLASH = 5, S_GLINT = 6, S_SHARD = 7, S_CHUNK = 8;

// colour ramps (young -> old)
const RAMPS = [];
function ramp(...cols) { RAMPS.push(cols); return RAMPS.length - 1; }
const R_FIRE = ramp('#ffffff', '#fff2a0', '#ffc040', '#ff7a20', '#c83a10', '#5a1a0a');
const R_EXHAUST = ramp('#ffffff', '#fff0b8', '#ffc050', '#ff8a2a', '#b8401a', '#4a1a0e');
const R_COLD = ramp('#ffffff', '#e2efff', '#aac4e0', '#6a7c98', '#3a4458');
const R_SPARK = ramp('#ffffff', '#fff2a0', '#ffc040', '#ff8a2a');
const R_HOT = ramp('#ffffff', '#ffd0c0', '#ff6a4a', '#b8201c');
const R_ROCK = ramp('#a39280', '#86725e', '#5e4f41', '#3d332a');
const R_ICE = ramp('#ffffff', '#d4f3ff', '#86c2da', '#4d88a4');
const R_GLASS = ramp('#ffffff', '#b8ecff', '#4fa3c4', '#1f5670');
const R_SMOKE = ramp('#6a707c', '#4c515c', '#353943', '#22252c');
const R_VAPOR = ramp('#ffffff', '#e8eef6', '#b8c2d0', '#7c8698');
const R_GAS = ramp('#f4f0c0', '#d8d490', '#a8a468', '#6a6a3c', '#3a3a24');
const R_CYAN = ramp('#ffffff', '#bff4ff', '#6fe6ff', '#1f7a9a');
const R_GREEN = ramp('#ffffff', '#c8ffd8', '#5fef8f', '#1e7a44');
const R_GOLD = ramp('#ffffff', '#fff2b0', '#ffe07a', '#d8a02a');
const R_ORANGE = ramp('#ffffff', '#ffe0b0', '#ff9a2e', '#b8520e');
const R_RED = ramp('#ffffff', '#ffc0b0', '#ff4a3a', '#8a1a14');
const R_VIOLET = ramp('#ffffff', '#e8d0ff', '#c08aff', '#5a2a9a');
const R_METAL = ramp('#c8d0dc', '#9aa6b8', '#6d788c', '#3a404d');
const R_SUIT = ramp('#ffffff', '#e1e6ee', '#a6afc0', '#5c6576');
const KIND_RAMP = { salvage: R_GOLD, o2: R_CYAN, fuel: R_ORANGE, repair: R_RED, keycard: R_CYAN, explosives: R_RED, heatshield: R_ORANGE, anchor: R_VIOLET };
const KIND_GLOW = { salvage: 'amber', o2: 'cyan', fuel: 'orange', repair: 'red', keycard: 'cyan', explosives: 'red', heatshield: 'orange', anchor: 'violet' };
const MAT_RAMP = { metal: R_SPARK, rock: R_ROCK, ice: R_ICE, glass: R_GLASS };
const TILE_RAMPS = new Map(); // tile key -> ramp index (built lazily, once per key)
function tileRamp(key) {
  let r = TILE_RAMPS.get(key);
  if (r !== undefined) return r;
  const def = TILE_BY_KEY[key];
  r = def ? ramp(def.colors[3], def.colors[2], def.colors[1], def.colors[0]) : R_METAL;
  TILE_RAMPS.set(key, r);
  return r;
}
const EMPTY = {};
const TAU = Math.PI * 2;

export class Particles {
  constructor(game = null, max = PARTICLES.max) {
    this.game = game;
    this.max = max;
    this.style = new Uint8Array(max);
    this.emissive = new Uint8Array(max);
    this.x = new Float32Array(max); this.y = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max); this.grow = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.ramp = new Uint8Array(max);
    this.glow = new Array(max).fill(null);
    this.cursor = 0;
    this.alive = 0;
    this._rng = 0x9e3779b9;
  }

  _r() {
    let x = this._rng;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._rng = x >>> 0;
    return this._rng / 4294967296;
  }

  _alloc() {
    for (let n = 0; n < this.max; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      if (this.style[i] === S_NONE) return i;
    }
    const i = this.cursor; // full: overwrite the oldest slot in ring order
    this.cursor = (this.cursor + 1) % this.max;
    return i;
  }

  _emit(style, x, y, vx, vy, life, size, rampIdx, emissive, drag = PARTICLES.drag, grow = 0) {
    const i = this._alloc();
    this.style[i] = style; this.emissive[i] = emissive ? 1 : 0;
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size; this.grow[i] = grow;
    this.drag[i] = drag; this.ramp[i] = rampIdx; this.glow[i] = null;
    return i;
  }

  /** Burst of `n` particles around a direction (dirX, dirY) with a spread (rad) and speed range. */
  _burst(n, style, x, y, dirX, dirY, spread, s0, s1, l0, l1, size, rampIdx, emissive, drag, grow = 0, bvx = 0, bvy = 0) {
    const base = dirX || dirY ? Math.atan2(dirY, dirX) : 0;
    const full = !(dirX || dirY);
    for (let k = 0; k < n; k++) {
      const a = full ? this._r() * TAU : base + (this._r() - 0.5) * spread;
      const sp = s0 + this._r() * (s1 - s0);
      this._emit(style, x, y, Math.cos(a) * sp + bvx, Math.sin(a) * sp + bvy, l0 + this._r() * (l1 - l0), size, rampIdx, emissive, drag, grow);
    }
  }

  _ring(x, y, r, life, rampIdx) {
    // a ring stores its final radius in size (the radius eases out over its life)
    return this._emit(S_RING, x, y, 0, 0, life, r, rampIdx, true, 0);
  }

  _flash(x, y, r, life, glowKey) {
    const i = this._emit(S_FLASH, x, y, 0, 0, life, r, R_FIRE, true, 0);
    this.glow[i] = glowKey;
    return i;
  }

  spawn(kind, x, y, opts) {
    const o = opts || EMPTY;
    const count = o.count > 0 ? o.count : 0;
    const vx = o.vx || 0, vy = o.vy || 0, nx = o.nx || 0, ny = o.ny || 0;
    const power = o.power > 0 ? o.power : 1;
    switch (kind) {
      case 'exhaust': {
        const n = this._r() < power ? 2 : 1;
        for (let k = 0; k < n; k++) {
          this._emit(S_DOT, x + (this._r() - 0.5) * 2, y + (this._r() - 0.5) * 2, vx + (this._r() - 0.5) * 30, vy + (this._r() - 0.5) * 30,
            0.22 + this._r() * 0.25 * power, k === 0 && power > 0.7 ? 2 : 1, R_EXHAUST, true, 2.5);
        }
        break;
      }
      case 'brake':
        for (let k = 0; k < 2; k++) this._emit(S_SMOKE, x, y, vx + (this._r() - 0.5) * 40, vy + (this._r() - 0.5) * 40, 0.3 + this._r() * 0.2, 1, R_COLD, false, 4, 5);
        break;
      case 'boost': {
        const sp = Math.hypot(vx, vy) || 1;
        this._burst(count || 10, S_DOT, x, y, vx / sp, vy / sp, 0.9, sp * 0.5, sp * 1.1, 0.25, 0.5, 2, R_FIRE, true, 3);
        this._burst(5, S_SMOKE, x, y, vx / sp, vy / sp, 1.2, 20, 60, 0.5, 0.9, 2, R_SMOKE, false, 2.5, 5);
        this._flash(x, y, 10, 0.12, 'orange');
        break;
      }
      case 'spark': {
        const n = count || 6;
        const mat = o.material || '';
        if (mat === 'rock') {
          this._burst(n, S_DOT, x, y, nx, ny, 2.4, 20, 70 * power + 20, 0.35, 0.7, 1, R_ROCK, false, 2);
          this._burst(Math.ceil(n / 3), S_CHUNK, x, y, nx, ny, 2, 30, 90, 0.5, 0.9, 2, R_ROCK, false, 1);
          this._burst(3, S_SMOKE, x, y, nx, ny, 2, 8, 25, 0.6, 1, 2, R_ROCK, false, 2, 5);
        } else if (mat === 'ice' || mat === 'glass') {
          this._burst(n, S_SHARD, x, y, nx, ny, 2.4, 30, 110 * power + 30, 0.4, 0.8, 1, mat === 'ice' ? R_ICE : R_GLASS, true, 1.5);
        } else {
          const rp = mat === 'metal' ? R_SPARK : R_HOT;
          this._burst(n, S_STREAK, x, y, nx, ny, 2.2, 60, 160 * power + 60, 0.15, 0.4, 1, rp, true, 3);
        }
        if (power > 0.6) this._flash(x, y, 6, 0.08, 'white');
        break;
      }
      case 'death':
        this._burst(Math.round((count || 24) * 0.6), S_SMOKE, x, y, 0, 0, 0, 15, 70, 0.8, 1.6, 2, R_VAPOR, false, 1.6, 6, vx, vy);
        this._burst(12, S_STREAK, x, y, 0, 0, 0, 60, 180, 0.2, 0.5, 1, R_SPARK, true, 2.5, 0, vx, vy);
        this._burst(8, S_CHUNK, x, y, 0, 0, 0, 20, 80, 0.8, 1.6, 2, R_SUIT, false, 0.8, 0, vx, vy);
        this._ring(x, y, 34, 0.45, R_CYAN);
        this._flash(x, y, 20, 0.2, 'white');
        break;
      case 'pickup': {
        const rp = KIND_RAMP[o.material] ?? R_GOLD;
        this._burst(count || 5, S_GLINT, x, y, 0, 0, 0, 10, 40, 0.3, 0.55, 1, rp, true, 3);
        this._ring(x, y, 9, 0.25, rp);
        break;
      }
      case 'item': {
        const rp = KIND_RAMP[o.material] ?? R_CYAN;
        this._burst(count || 20, S_GLINT, x, y, 0, 0, 0, 20, 90, 0.6, 1.2, 1, rp, true, 1.5);
        this._ring(x, y, 40, 0.6, rp);
        this._ring(x, y, 22, 0.4, R_GOLD);
        this._flash(x, y, 30, 0.35, KIND_GLOW[o.material] || 'cyan');
        break;
      }
      case 'door':
        this._burst(count || 8, S_SMOKE, x, y, 0, 0, 0, 10, 40, 0.5, 0.9, 2, R_VAPOR, false, 2, 6);
        this._burst(6, S_GLINT, x, y, 0, 0, 0, 10, 30, 0.3, 0.6, 1, R_GREEN, true, 2);
        break;
      case 'crate':
        this._burst(count || 10, S_CHUNK, x, y, 0, 0, 0, 20, 70, 0.4, 0.8, 2, R_METAL, false, 2);
        this._burst(6, S_GLINT, x, y, 0, 0, 0, 10, 40, 0.4, 0.7, 1, R_GOLD, true, 2);
        this._burst(4, S_SMOKE, x, y, 0, 0, 0, 5, 20, 0.6, 1, 2, R_SMOKE, false, 2, 4);
        break;
      case 'satellite':
        this._ring(x, y, o.r > 0 ? o.r : 1600, 2.4, R_CYAN);
        this._ring(x, y, 120, 0.6, R_CYAN);
        this._flash(x, y, 24, 0.3, 'cyan');
        break;
      case 'gas':
      case 'gas_warn': {
        const warn = kind === 'gas_warn';
        const hw = (o.r || 8) * (warn ? 0.5 : 0.9);
        const px = -ny, py = nx;
        const n = warn ? 1 : 2;
        for (let k = 0; k < n; k++) {
          const off = (this._r() - 0.5) * 2 * hw;
          const sp = warn ? 0.5 + this._r() : 0.7 + this._r() * 0.6;
          this._emit(S_SMOKE, x + px * off, y + py * off, vx * sp + (this._r() - 0.5) * 20, vy * sp + (this._r() - 0.5) * 20,
            warn ? 0.35 + this._r() * 0.3 : 0.45 + this._r() * 0.3, warn ? 1 : 2, R_GAS, false, warn ? 3 : 1.2, warn ? 4 : 10);
        }
        break;
      }
      case 'shelter': {
        // flare plasma splashing on the obstacle: embers sprayed sideways
        const px = -ny, py = nx;
        for (let k = 0; k < (count || 8); k++) {
          const s = this._r() < 0.5 ? -1 : 1;
          const sp = 40 + this._r() * 90;
          this._emit(S_DOT, x, y, (px * s + nx * 0.4) * sp, (py * s + ny * 0.4) * sp, 0.4 + this._r() * 0.5, 1, R_FIRE, true, 1.5);
        }
        this._flash(x, y, 12, 0.18, 'orange');
        break;
      }
      case 'muzzle': {
        const sp = Math.hypot(vx, vy) || 1;
        this._burst(count || 3, S_STREAK, x, y, vx / sp, vy / sp, 0.8, 40, 110, 0.1, 0.25, 1, R_HOT, true, 3);
        this._flash(x, y, 8, 0.1, 'red');
        break;
      }
      case 'debris':
      case 'tile': {
        const rp = o.material ? tileRamp(o.material) : R_METAL;
        const n = count || (kind === 'tile' ? 5 : 14);
        this._burst(n, S_CHUNK, x, y, 0, 0, 0, 20, 90, 0.6, 1.3, 2, rp, false, 1.2);
        this._burst(Math.ceil(n / 2), S_DOT, x, y, 0, 0, 0, 10, 50, 0.4, 0.9, 1, rp, false, 2);
        this._burst(kind === 'tile' ? 2 : 6, S_SMOKE, x, y, 0, 0, 0, 5, 25, 0.8, 1.5, 2, R_SMOKE, false, 1.5, 6);
        if (kind === 'debris') { this._burst(10, S_STREAK, x, y, 0, 0, 0, 60, 160, 0.2, 0.45, 1, R_SPARK, true, 3); this._flash(x, y, 16, 0.2, 'orange'); }
        break;
      }
      case 'rock': {
        const rr = o.r || 8;
        const n = count || 8;
        for (let k = 0; k < n; k++) {
          const a = this._r() * TAU, d = this._r() * rr, sp = 20 + this._r() * 70;
          this._emit(S_CHUNK, x + Math.cos(a) * d, y + Math.sin(a) * d, vx + Math.cos(a) * sp, vy + Math.sin(a) * sp, 0.7 + this._r() * 0.9, this._r() < 0.4 ? 3 : 2, R_ROCK, false, 0.8);
        }
        this._burst(n, S_SMOKE, x, y, 0, 0, 0, 8, 35, 0.8, 1.4, 2, R_ROCK, false, 1.5, 7, vx, vy);
        break;
      }
      case 'explosion': {
        const rr = o.r || 40;
        this._flash(x, y, rr * 1.3, 0.22, 'white');
        this._flash(x, y, rr * 0.9, 0.4, 'orange');
        this._ring(x, y, rr * 1.7, 0.4, R_FIRE);
        const n = count || 30;
        for (let k = 0; k < n; k++) {
          const a = this._r() * TAU, sp = (0.3 + this._r() * 0.9) * rr * 3.2 * power;
          this._emit(S_SMOKE, x + Math.cos(a) * 3, y + Math.sin(a) * 3, Math.cos(a) * sp, Math.sin(a) * sp, 0.35 + this._r() * 0.35, 2, R_FIRE, true, 4, 9);
        }
        this._burst(Math.round(n * 0.6), S_STREAK, x, y, 0, 0, 0, 90, 260, 0.25, 0.6, 1, R_SPARK, true, 2);
        this._burst(Math.round(n * 0.5), S_SMOKE, x, y, 0, 0, 0, 15, rr * 1.6, 1.2, 2.2, 3, R_SMOKE, false, 1.4, 8);
        this._burst(8, S_CHUNK, x, y, 0, 0, 0, 40, 140, 0.8, 1.4, 2, R_METAL, false, 1);
        break;
      }
      case 'smoke':
        this._burst(count || 3, S_SMOKE, x, y, 0, 0, 0, 3, 15, 1, 1.8, 2, R_SMOKE, false, 1, 5, vx, vy);
        break;
      case 'embers':
        this._burst(count || 4, S_DOT, x, y, nx, ny, nx || ny ? 1.4 : 0, 10, 45, 0.6, 1.2, 1, R_FIRE, true, 1);
        break;
      case 'dust':
        this._burst(count || 4, S_SMOKE, x, y, nx, ny, nx || ny ? 2 : 0, 5, 30, 0.5, 1, 1, tileRamp(o.material || 'moon_dust'), false, 2.5, 4);
        break;
      case 'shards':
        this._burst(count || 6, S_SHARD, x, y, nx, ny, nx || ny ? 2.4 : 0, 30, 100, 0.4, 0.8, 1, o.material === 'glass' ? R_GLASS : R_ICE, true, 1.5);
        break;
      case 'glint':
        this._emit(S_GLINT, x, y, 0, 0, 0.45, 1, R_GOLD, true, 0);
        break;
      case 'flash':
        this._flash(x, y, o.r || 12, 0.2, o.color || 'white');
        break;
      case 'ring':
        this._ring(x, y, o.r || 24, 0.4, R_CYAN);
        break;
      default: break;
    }
  }

  update(dt) {
    const world = this.game ? this.game.world : null;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      const st = this.style[i];
      if (st === S_NONE) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.style[i] = S_NONE; this.glow[i] = null; continue; }
      alive++;
      if (st === S_RING || st === S_FLASH) continue;
      const k = Math.exp(-this.drag[i] * dt);
      this.vx[i] *= k; this.vy[i] *= k;
      if (this.grow[i] > 0) this.size[i] += this.grow[i] * dt;
      const nx = this.x[i] + this.vx[i] * dt, ny = this.y[i] + this.vy[i] * dt;
      if (st === S_CHUNK && world) {
        // chunks bounce off solid tiles
        if (SOLID[world.get(Math.floor(nx / TILE), Math.floor(this.y[i] / TILE))]) this.vx[i] *= -0.5; else this.x[i] = nx;
        if (SOLID[world.get(Math.floor(this.x[i] / TILE), Math.floor(ny / TILE))]) this.vy[i] *= -0.5; else this.y[i] = ny;
      } else {
        this.x[i] = nx; this.y[i] = ny;
      }
    }
    this.alive = alive;
  }

  draw(ctx, camX, camY, pass = 'all') {
    const want = pass === 'emissive' ? 1 : pass === 'lit' ? 0 : -1;
    const vw = ctx.canvas.width, vh = ctx.canvas.height;
    const prevOp = ctx.globalCompositeOperation;
    if (want === 1) ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.max; i++) {
      const st = this.style[i];
      if (st === S_NONE) continue;
      if (want >= 0 && this.emissive[i] !== want) continue;
      const age = 1 - this.life[i] / this.maxLife[i];
      const rp = RAMPS[this.ramp[i]];
      const col = rp[Math.min(rp.length - 1, Math.floor(age * rp.length))];
      const sx = this.x[i] - camX, sy = this.y[i] - camY;
      if (st === S_RING) {
        const rad = this.size[i] * (1 - (1 - age) * (1 - age));
        if (sx + rad < 0 || sy + rad < 0 || sx - rad > vw || sy - rad > vh || rad < 1) continue;
        ctx.globalAlpha = (1 - age) * 0.9;
        ctx.strokeStyle = col;
        ctx.lineWidth = rad > 200 ? 3 : 2;
        ctx.beginPath(); ctx.arc(Math.round(sx), Math.round(sy), rad, 0, TAU); ctx.stroke();
        continue;
      }
      if (st === S_FLASH) {
        const rad = this.size[i] * (0.6 + 0.4 * age);
        if (sx + rad < 0 || sy + rad < 0 || sx - rad > vw || sy - rad > vh) continue;
        const gr = rad > 30 ? GLOW_RADII[3] : rad > 16 ? GLOW_RADII[2] : rad > 8 ? GLOW_RADII[1] : GLOW_RADII[0];
        const img = getGlow(this.glow[i] || 'white', gr);
        if (!img) continue;
        ctx.globalAlpha = (1 - age) * (1 - age);
        const d = Math.round(rad * 2);
        ctx.drawImage(img, Math.round(sx - rad), Math.round(sy - rad), d, d);
        continue;
      }
      const ix = Math.round(sx), iy = Math.round(sy);
      if (ix < -12 || iy < -12 || ix > vw + 12 || iy > vh + 12) continue;
      ctx.fillStyle = col;
      if (st === S_SMOKE) {
        const s = Math.max(1, Math.round(this.size[i]));
        ctx.globalAlpha = (1 - age) * (this.emissive[i] ? 0.85 : 0.55);
        ctx.fillRect(ix - (s >> 1), iy - (s >> 1), s, s);
      } else if (st === S_STREAK) {
        ctx.globalAlpha = 1 - age * 0.5;
        ctx.fillRect(ix, iy, 1, 1);
        ctx.fillRect(Math.round(sx - this.vx[i] * 0.016), Math.round(sy - this.vy[i] * 0.016), 1, 1);
      } else if (st === S_GLINT) {
        const a = Math.round(2.5 * Math.sin(age * Math.PI));
        ctx.globalAlpha = 1;
        ctx.fillRect(ix - a, iy, a * 2 + 1, 1);
        ctx.fillRect(ix, iy - a, 1, a * 2 + 1);
      } else if (st === S_SHARD) {
        ctx.globalAlpha = 1 - age * 0.6;
        ctx.fillRect(ix, iy, 1, 1);
        if ((i + Math.floor(age * 12)) & 1) ctx.fillRect(ix + 1, iy - 1, 1, 1);
      } else if (st === S_CHUNK) {
        const s = this.size[i];
        ctx.globalAlpha = age > 0.75 ? (1 - age) * 4 : 1;
        ctx.fillRect(ix, iy, s, s);
      } else {
        const s = this.size[i];
        ctx.globalAlpha = age > 0.6 ? (1 - age) * 2.5 : 1;
        ctx.fillRect(ix, iy, s, s);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = prevOp;
  }

  clear() { this.style.fill(0); this.glow.fill(null); this.alive = 0; }
}
