// Per-tile light map (DESIGN.md §9).
// Two flood-fill passes over the visible tiles (+ margin):
//   A. emissive tiles (lava, crystals, torches, glowing ores), sky light and
//      dynamic lights (forge fire, enemies...) with a fixed falloff;
//   B. the player's lantern, whose falloff follows the (upgradable) radius and is
//      seeded from the exact player position so the halo moves smoothly.
// Light passes freely through open tiles, lights the first layer of solid tiles
// (so walls read) and dies quickly inside rock. The result becomes a tiny RGBA
// darkness canvas drawn upscaled WITH smoothing (soft halo), plus an additive
// coloured glow canvas.
import { TILE, SURFACE_Y, LIGHT } from './config.js';
import { SOLID, EMIT, TILES } from './tiles.js';

const DIAG = Math.SQRT2;
const DEFAULT_COLOR = [255, 170, 90];
// glow splat weights over a 7×7 block (radius 3), computed once: the per-frame
// Math.hypot calls (≈ 6 700 per frame near lava) were the top lighting hotspot
const SPLAT_R = 3;
const SPLAT_N = SPLAT_R * 2 + 1;
const KERNEL = new Float32Array(SPLAT_N * SPLAT_N);
for (let dj = -SPLAT_R; dj <= SPLAT_R; dj++) {
  for (let di = -SPLAT_R; di <= SPLAT_R; di++) {
    KERNEL[(dj + SPLAT_R) * SPLAT_N + di + SPLAT_R] = Math.max(0, 1 - Math.sqrt(di * di + dj * dj) / (SPLAT_R + 0.5)) * 0.32;
  }
}

export class Lighting {
  constructor(game) {
    this.game = game;
    this.cap = 0;
    this.w = 0; this.h = 0; this.tx0 = 0; this.ty0 = 0;
    this.dark = null; this.glow = null;
    // Dynamic lights (enemies, projectiles...): a pooled list rebuilt once per
    // fixed tick (clearDynamic() then addLight()); every rendered frame reads
    // the latest list, so lights stay on during frames without a tick (120 Hz),
    // hit-stop and pause.
    this.dynamic = [];   // pool of { x, y, intensity, color }
    this.dynamicCount = 0;
    this.statics = [];   // persistent world lights (camp props)
    this.flicker = 1;
    // cells touched by glow splats this frame (the additive pass only draws that box)
    this.gx0 = 0; this.gy0 = 0; this.gx1 = -1; this.gy1 = -1;
    this._tint = null;   // pre-rendered warm lantern tint for the current radius
    this._tintR = -1;
  }

  _ensure(w, h) {
    if (w * h > this.cap) {
      this.cap = w * h;
      this.L = new Float32Array(this.cap);
      this.Lp = new Float32Array(this.cap);
      this.solid = new Uint8Array(this.cap);
      this.gr = new Float32Array(this.cap); this.gg = new Float32Array(this.cap); this.gb = new Float32Array(this.cap);
      this.queue = new Int32Array(this.cap * 8);
    }
    if (w !== this.w || h !== this.h || !this.dark) {
      this.w = w; this.h = h;
      if (typeof document !== 'undefined') {
        this.dark = document.createElement('canvas'); this.dark.width = w; this.dark.height = h;
        this.glow = document.createElement('canvas'); this.glow.width = w; this.glow.height = h;
        this.darkCtx = this.dark.getContext('2d'); this.glowCtx = this.glow.getContext('2d');
        this.darkImg = this.darkCtx.createImageData(w, h);
        this.glowImg = this.glowCtx.createImageData(w, h);
      }
    }
  }

  /** Start a new dynamic-light list (called once per fixed tick before the producers). */
  clearDynamic() { this.dynamicCount = 0; }

  /** Add a dynamic light (world px) valid until the next clearDynamic(). No allocation once warm. */
  addLight(x, y, intensity = 0.8, color = DEFAULT_COLOR) {
    let lt = this.dynamic[this.dynamicCount];
    if (!lt) { lt = { x: 0, y: 0, intensity: 0, color: DEFAULT_COLOR }; this.dynamic.push(lt); }
    lt.x = x; lt.y = y; lt.intensity = intensity; lt.color = color;
    this.dynamicCount++;
  }

  /** Persistent light (camp props); cleared on new world. */
  addStatic(x, y, intensity = 0.8, color = DEFAULT_COLOR) { this.statics.push({ x, y, intensity, color }); }
  clearStatics() { this.statics.length = 0; }

  /** Relax light values outward (queue-based flood fill with 8-neighbour spread). */
  _flood(L, qLen, falloff) {
    const { w, h, solid, queue } = this;
    const qCap = queue.length;
    let head = 0, tail = qLen;
    while (head !== tail) {
      const i = queue[head]; head = (head + 1) % qCap;
      const v = L[i];
      const cost = solid[i] ? LIGHT.solidFalloff : falloff;
      if (v - cost <= 0.01) continue;
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          let c = cost;
          if (dx && dy) {
            if (solid[y * w + nx] && solid[ny * w + x]) continue; // no leaking through diagonal cracks
            c *= DIAG;
          }
          const nv = v - c;
          if (nv > L[j] + 0.01) {
            L[j] = nv;
            queue[tail] = j; tail = (tail + 1) % qCap;
            if (tail === head) return; // queue saturated: good enough
          }
        }
      }
    }
  }

  compute(camX, camY, viewW, viewH) {
    const g = this.game;
    const world = g.world;
    const M = LIGHT.margin;
    const tx0 = Math.floor(camX / TILE) - M, ty0 = Math.floor(camY / TILE) - M;
    const w = Math.ceil(viewW / TILE) + 1 + 2 * M, h = Math.ceil(viewH / TILE) + 1 + 2 * M;
    this._ensure(w, h);
    this.tx0 = tx0; this.ty0 = ty0;
    const { L, Lp, solid, gr, gg, gb, queue } = this;
    const n = w * h;
    L.fill(0, 0, n); Lp.fill(0, 0, n); gr.fill(0, 0, n); gg.fill(0, 0, n); gb.fill(0, 0, n);
    this.gx0 = w; this.gy0 = h; this.gx1 = -1; this.gy1 = -1;
    let q = 0;
    const qCap = queue.length;
    const push = (i) => { if (q < qCap) queue[q++] = i; };

    // --- pass A: emissive tiles + sky + dynamic/static lights
    for (let j = 0; j < h; j++) {
      const ty = ty0 + j;
      for (let i = 0; i < w; i++) {
        const tx = tx0 + i;
        const k = j * w + i;
        const id = world.get(tx, ty);
        solid[k] = SOLID[id];
        const e = EMIT[id];
        if (e > 0) {
          if (e > L[k]) { L[k] = e; push(k); }
          const c = TILES[id].lightColor;
          this._splat(i, j, e, c);
        } else if (!solid[k] && tx >= 0 && tx < world.w && ty < world.skyTop[tx] && ty >= 0) {
          if (LIGHT.skyLight > L[k]) { L[k] = LIGHT.skyLight; push(k); }
        }
      }
    }
    const addPoint = (lt) => {
      const i = Math.floor(lt.x / TILE) - tx0, j = Math.floor(lt.y / TILE) - ty0;
      if (i < 0 || j < 0 || i >= w || j >= h) return;
      const k = j * w + i;
      if (lt.intensity > L[k]) { L[k] = lt.intensity; push(k); }
      this._splat(i, j, lt.intensity, lt.color);
    };
    for (const lt of this.statics) addPoint(lt);
    for (let k = 0; k < this.dynamicCount; k++) addPoint(this.dynamic[k]);
    this._flood(L, q, LIGHT.emitFalloff);

    // --- pass B: lantern, seeded around the exact player position
    const p = g.player;
    if (!p.dead || p.deadT < 1.5) {
      const R = Math.max(1, p.stats.lanternRadius);
      const fall = 1 / R;
      this.flicker = 1 - LIGHT.lanternFlicker * 0.12 * (Math.sin(g.time * 13) * 0.5 + Math.sin(g.time * 31) * 0.3 + 0.2);
      const lx = (p.x + p.w / 2) / TILE - tx0, ly = (p.y + 8) / TILE - ty0;
      const pi = Math.floor(lx), pj = Math.floor(ly);
      q = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        const i = pi + di, j = pj + dj;
        if (i < 0 || j < 0 || i >= w || j >= h) continue;
        const k = j * w + i;
        if (solid[k] && (di || dj)) continue;
        const ddx = i + 0.5 - lx, ddy = j + 0.5 - ly;
        const v = 1 - Math.sqrt(ddx * ddx + ddy * ddy) * fall;
        if (v > Lp[k]) { Lp[k] = v; push(k); }
      }
      this._flood(Lp, q, fall);
    }

    if (!this.dark) return;
    // --- compose darkness + glow images
    const dd = this.darkImg.data, gd = this.glowImg.data;
    const [dr, dg, db] = LIGHT.darkColor;
    const fl = this.flicker;
    for (let j = 0; j < h; j++) {
      const ty = ty0 + j;
      const d = ty - SURFACE_Y;
      let amb, maxDark;
      if (d < 0) { amb = LIGHT.surfaceAmbient; maxDark = 0.5; }
      else {
        amb = Math.max(0, LIGHT.undergroundAmbient - d * LIGHT.ambientFade);
        maxDark = LIGHT.minDark + (LIGHT.maxDark - LIGHT.minDark) * Math.min(1, d / 260);
      }
      for (let i = 0; i < w; i++) {
        const k = j * w + i;
        let light = Math.max(L[k], Lp[k] * fl, amb);
        if (light > 1) light = 1;
        light = 1 - (1 - light) * (1 - light); // ease-out: broad lit core, soft edge
        const a = maxDark * (1 - light);
        const o = k * 4;
        dd[o] = dr; dd[o + 1] = dg; dd[o + 2] = db; dd[o + 3] = a * 255;
        gd[o] = Math.min(255, gr[k]); gd[o + 1] = Math.min(255, gg[k]); gd[o + 2] = Math.min(255, gb[k]);
        gd[o + 3] = 255;
      }
    }
    this.darkCtx.putImageData(this.darkImg, 0, 0);
    this.glowCtx.putImageData(this.glowImg, 0, 0);
  }

  /** Accumulate coloured glow around a source (no occlusion; subtle tint only). */
  _splat(i, j, e, c) {
    const { w, h, gr, gg, gb } = this;
    const R = SPLAT_R;
    const y0 = Math.max(0, j - R), y1 = Math.min(h - 1, j + R);
    const x0 = Math.max(0, i - R), x1 = Math.min(w - 1, i + R);
    if (x1 < x0 || y1 < y0) return;
    const cr = c[0] * e, cg = c[1] * e, cb = c[2] * e;
    for (let y = y0; y <= y1; y++) {
      const krow = (y - j + R) * SPLAT_N + R - i;
      const row = y * w;
      for (let x = x0; x <= x1; x++) {
        const f = KERNEL[krow + x];
        if (f <= 0) continue;
        const k = row + x;
        gr[k] += cr * f; gg[k] += cg * f; gb[k] += cb * f;
      }
    }
    if (x0 < this.gx0) this.gx0 = x0;
    if (x1 > this.gx1) this.gx1 = x1;
    if (y0 < this.gy0) this.gy0 = y0;
    if (y1 > this.gy1) this.gy1 = y1;
  }

  /** Warm radial lantern tint, rendered once per radius (was a new gradient every frame). */
  _lanternTint(r) {
    const R = Math.max(1, Math.round(r));
    if (this._tint && this._tintR === R) return this._tint;
    const c = document.createElement('canvas');
    c.width = c.height = R * 2;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(R, R, 0, R, R, R);
    grd.addColorStop(0, 'rgba(255,190,110,0.16)');
    grd.addColorStop(1, 'rgba(255,150,70,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, R * 2, R * 2);
    this._tint = c; this._tintR = R;
    return c;
  }

  draw(ctx, camX, camY) {
    if (!this.dark) return;
    const x = this.tx0 * TILE - camX, y = this.ty0 * TILE - camY;
    const W = this.w * TILE, H = this.h * TILE;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.dark, 0, 0, this.w, this.h, x, y, W, H);
    // coloured bloom from emissive tiles on top of the darkness: only the box the splats
    // touched (+1 cell so the smoothed edge fades out on zeros); nothing to add = no pass
    if (this.gx1 >= this.gx0) {
      const bx0 = Math.max(0, this.gx0 - 1), by0 = Math.max(0, this.gy0 - 1);
      const bx1 = Math.min(this.w - 1, this.gx1 + 1), by1 = Math.min(this.h - 1, this.gy1 + 1);
      const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = LIGHT.glowAlpha;
      ctx.drawImage(this.glow, bx0, by0, bw, bh, x + bx0 * TILE, y + by0 * TILE, bw * TILE, bh * TILE);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    // warm lantern tint around the player
    const p = this.game.player;
    if (!p.dead) {
      const px = p.x + p.w / 2 - camX, py = p.y + 8 - camY;
      const r = p.stats.lanternRadius * TILE * 0.75;
      const tint = this._lanternTint(r);
      const R = tint.width / 2;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(tint, Math.round(px - R), Math.round(py - R));
    }
    ctx.restore();
    ctx.imageSmoothingEnabled = false;
  }
}
