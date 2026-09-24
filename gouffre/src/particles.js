// Pooled particle system: particles.spawn(kind, x, y, opts).
// Struct-of-arrays storage, no allocation per particle.
import { PARTICLE_MAX, TILE } from './config.js';
import { TILES } from './tiles.js';

const K_NONE = 0, K_DEBRIS = 1, K_DUST = 2, K_SPARK = 3, K_EMBER = 4, K_BLOOD = 5, K_GLINT = 6, K_SMOKE = 7;

const DUST_COLORS = ['#8a7f73', '#6d645b', '#a39a8e'];
const SPARK_COLORS = ['#fff6c2', '#ffd34d', '#ff9e2c'];
const EMBER_COLORS = ['#ffcf4d', '#ff8a1f', '#ff5a1a', '#c2410c'];
const BLOOD_COLORS = ['#b3122e', '#7a0a1f', '#e0304e'];
const SMOKE_COLORS = ['#3a3440', '#2c2833', '#4a4452'];

export class Particles {
  constructor(game, max = PARTICLE_MAX) {
    this.game = game;
    this.max = max;
    this.kind = new Uint8Array(max);
    this.x = new Float32Array(max); this.y = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.color = new Array(max).fill('#fff');
    this.cursor = 0;
    this.alive = 0;
    this._rng = 0x9e3779b9;
  }

  _rand() {
    // xorshift: cheap, allocation-free, determinism not required for visuals
    let x = this._rng;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this._rng = x >>> 0;
    return this._rng / 4294967296;
  }

  _alloc() {
    // ring buffer: overwrite the oldest when full
    for (let n = 0; n < this.max; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      if (this.kind[i] === K_NONE) return i;
    }
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    return i;
  }

  _emit(k, x, y, vx, vy, life, size, grav, color) {
    const i = this._alloc();
    this.kind[i] = k; this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size; this.grav[i] = grav;
    this.color[i] = color;
  }

  /**
   * kinds: 'debris' (opts.tileId), 'chip' (opts.tileId), 'dust', 'land', 'spark',
   * 'ember', 'blood', 'glint', 'smoke', 'poof' (enemy death, opts.color)
   * opts: { count, tileId, color, vx, vy, spread }
   */
  spawn(kind, x, y, opts = {}) {
    const r = () => this._rand();
    const count = opts.count ?? 6;
    switch (kind) {
      case 'debris': case 'chip': {
        const cols = TILES[opts.tileId ?? 0].colors;
        const big = kind === 'debris';
        for (let n = 0; n < count; n++) {
          const a = r() * Math.PI * 2;
          const sp = (big ? 40 : 25) + r() * (big ? 110 : 60);
          this._emit(K_DEBRIS,
            x + (r() - 0.5) * (big ? 12 : 4), y + (r() - 0.5) * (big ? 12 : 4),
            Math.cos(a) * sp + (opts.vx || 0), Math.sin(a) * sp - (big ? 60 : 40) + (opts.vy || 0),
            0.45 + r() * (big ? 0.7 : 0.35), big ? 1 + Math.floor(r() * 3) : 1 + Math.floor(r() * 2), 520,
            cols[1 + Math.floor(r() * 3)]);
        }
        break;
      }
      case 'dust': case 'land': {
        for (let n = 0; n < count; n++) {
          const side = kind === 'land' ? (n % 2 ? 1 : -1) : (r() - 0.5) * 2;
          this._emit(K_DUST, x + side * (2 + r() * 4), y - r() * 2,
            side * (15 + r() * 35), -8 - r() * 22, 0.3 + r() * 0.35, 2 + Math.floor(r() * 2), -10,
            DUST_COLORS[Math.floor(r() * DUST_COLORS.length)]);
        }
        break;
      }
      case 'spark': {
        for (let n = 0; n < count; n++) {
          const a = r() * Math.PI * 2, sp = 60 + r() * 140;
          this._emit(K_SPARK, x, y, Math.cos(a) * sp, Math.sin(a) * sp - 30, 0.15 + r() * 0.25, 1, 400,
            SPARK_COLORS[Math.floor(r() * SPARK_COLORS.length)]);
        }
        break;
      }
      case 'ember': {
        for (let n = 0; n < count; n++) {
          this._emit(K_EMBER, x + (r() - 0.5) * (opts.spread ?? 10), y - r() * 4,
            (r() - 0.5) * 30, -20 - r() * 60, 0.6 + r() * 0.9, 1 + Math.floor(r() * 1.6), -25,
            EMBER_COLORS[Math.floor(r() * EMBER_COLORS.length)]);
        }
        break;
      }
      case 'blood': {
        for (let n = 0; n < count; n++) {
          const a = r() * Math.PI * 2, sp = 30 + r() * 90;
          this._emit(K_BLOOD, x, y, Math.cos(a) * sp, Math.sin(a) * sp - 50, 0.4 + r() * 0.4, 1 + Math.floor(r() * 2), 600,
            opts.color || BLOOD_COLORS[Math.floor(r() * BLOOD_COLORS.length)]);
        }
        break;
      }
      case 'poof': {
        for (let n = 0; n < count; n++) {
          const a = r() * Math.PI * 2, sp = 20 + r() * 70;
          this._emit(K_DUST, x, y, Math.cos(a) * sp, Math.sin(a) * sp, 0.35 + r() * 0.35, 2 + Math.floor(r() * 2), -20,
            opts.color || DUST_COLORS[Math.floor(r() * DUST_COLORS.length)]);
        }
        break;
      }
      case 'glint': {
        this._emit(K_GLINT, x, y, 0, 0, 0.45, 1, 0, opts.color || '#ffffff');
        break;
      }
      case 'smoke': {
        for (let n = 0; n < count; n++) {
          this._emit(K_SMOKE, x + (r() - 0.5) * 4, y, (r() - 0.3) * 8, -10 - r() * 10, 1.6 + r() * 1.2, 2, -3,
            SMOKE_COLORS[Math.floor(r() * SMOKE_COLORS.length)]);
        }
        break;
      }
      default: break;
    }
  }

  update(dt) {
    const world = this.game.world;
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      const k = this.kind[i];
      if (k === K_NONE) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.kind[i] = K_NONE; continue; }
      alive++;
      this.vy[i] += this.grav[i] * dt;
      if (k === K_DUST || k === K_SMOKE) { this.vx[i] *= 1 - 3 * dt; this.vy[i] *= 1 - 2 * dt; }
      if (k === K_EMBER) this.vx[i] += Math.sin((this.life[i] + i) * 9) * 40 * dt;
      const nx = this.x[i] + this.vx[i] * dt;
      const ny = this.y[i] + this.vy[i] * dt;
      if ((k === K_DEBRIS || k === K_BLOOD) && world) {
        // simple bounce off solid tiles
        if (world.isSolid(Math.floor(nx / TILE), Math.floor(this.y[i] / TILE))) { this.vx[i] *= -0.35; }
        else this.x[i] = nx;
        if (world.isSolid(Math.floor(this.x[i] / TILE), Math.floor(ny / TILE))) {
          this.vy[i] *= -0.3; this.vx[i] *= 0.6;
          if (Math.abs(this.vy[i]) < 20) { this.vy[i] = 0; this.grav[i] = 0; this.vx[i] *= 0.5; }
        } else this.y[i] = ny;
      } else {
        this.x[i] = nx; this.y[i] = ny;
      }
    }
    this.alive = alive;
  }

  draw(ctx, camX, camY) {
    const vw = ctx.canvas.width, vh = ctx.canvas.height;
    for (let i = 0; i < this.max; i++) {
      const k = this.kind[i];
      if (k === K_NONE) continue;
      const sx = Math.round(this.x[i] - camX), sy = Math.round(this.y[i] - camY);
      if (sx < -8 || sy < -8 || sx > vw + 8 || sy > vh + 8) continue;
      const t = this.life[i] / this.maxLife[i];
      let s = this.size[i];
      let alpha = 1;
      if (k === K_DUST) { alpha = t * 0.8; s = Math.max(1, Math.round(s * (0.6 + (1 - t) * 0.8))); }
      else if (k === K_SMOKE) { alpha = Math.min(1, t * 1.5) * 0.55; s = Math.round(2 + (1 - t) * 4); }
      else if (k === K_EMBER) alpha = t < 0.3 ? t / 0.3 : 1;
      else if (k === K_DEBRIS || k === K_BLOOD) alpha = t < 0.25 ? t / 0.25 : 1;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.color[i];
      if (k === K_GLINT) {
        const a = Math.round(3 * Math.sin(t * Math.PI));
        ctx.fillRect(sx - a, sy, a * 2 + 1, 1);
        ctx.fillRect(sx, sy - a, 1, a * 2 + 1);
      } else if (k === K_SPARK) {
        ctx.fillRect(sx, sy, 1, 1);
        ctx.fillRect(Math.round(sx - this.vx[i] * 0.012), Math.round(sy - this.vy[i] * 0.012), 1, 1);
      } else {
        const h = s / 2 | 0;
        ctx.fillRect(sx - h, sy - h, s, s);
      }
    }
    ctx.globalAlpha = 1;
  }

  clear() { this.kind.fill(0); this.alive = 0; }
}
