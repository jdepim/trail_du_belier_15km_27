// Pixel art defined in code, rasterised once at boot (no image files).
//
//  - Icons / props / items: string rows + palettes (one char = one pixel), auto-outlined.
//  - Astronaut (16 directions), asteroids (3 sizes × 4 shapes × 16 rotation frames), turret
//    barrels and radar arrows are rasterised from analytic shapes with a fixed world light.
//  - Tile textures (8 px) come from 8/16/32 px seamless blocks cut into tiles, so hull plates,
//    tread plates and regolith read as continuous surfaces; tileVariant(id, tx, ty) picks the piece.
//  - Celestial assets: animated sun disks + dithered coronas, accretion disk frames with
//    differential rotation, nebula textures per region, star layers, glows, vignettes, the Earth.
//
// API (all synchronous; loadSprites() needs a DOM, the rest only reads what it built):
//   loadSprites()                               build everything once
//   getSprite(name) -> { canvas, w, h, frames, ax, ay } | null, hasSprite(name), spriteNames()
//   drawSprite(ctx, name, frame, x, y, opts?)   (x, y) = the sprite anchor; opts.flipX
//   makeIcon(name, cssPx) -> data URL (PNG) of the sprite integer-upscaled for DOM buttons
//   getTileTexture(id, variant) -> 8×8 canvas | null, tileVariant(id, tx, ty), tileVariantCount(id)
//   getGlow(color, r) -> additive glow canvas (color: GLOW_COLORS key, r: GLOW_RADII value)
//   backdrop  { layers: [canvas ×3], twinklers: [Float32Array ×3], nebula: { key: canvas }, staticNoise, vignette }
//   celestial { sun: { key: [frames] }, corona: { key: canvas }, disk: { key: [frames] }, earth }
// Sprite names (see tools/sprites.html): astro / astro_hurt / astro_dim (16 dirs), ast_<size>_<v>,
//   pk_salvage (4 variants) pk_cache pk_o2 pk_fuel pk_repair, item_<key> (+ alias <key>), up_<key>
//   (+ alias upg_<key>), brake boost charge action map pause, hull o2 fuel salvage, hud_* (HUD
//   minis), poi_*, radar_arrow (16 dirs), crate (closed, open), terminal (unread ×2, read), refill,
//   locker, workbench, hatch (locked, ready), turret_base, turret_gun (32 dirs), turret_dead,
//   charge (2), bolt, door_h / door_v / door_open_h / door_open_v (3 parts), capsule_ship.
import { TILES, TILE_ID as T, TILE_COUNT } from './tiles.js';
import { SUNS, BLACK_HOLES } from './config.js';
import { mulberry32, hash2 } from './rng.js';
import { BACKDROP, FX, LIGHT_DIR } from './render-config.js';

const TAU = Math.PI * 2;
const TS = 8;
const OUTLINE = '#07080d';
const sprites = new Map();
const tileTex = [];        // id -> [8×8 canvas]
const tileInfo = [];       // id -> { period, variants, sub }
const glows = {};           // color -> { r: canvas }
const iconCache = new Map();
export const backdrop = {};
export const celestial = {};
export const GLOW_COLORS = {
  cyan: '#6fe6ff', orange: '#ff9a32', red: '#ff4436', green: '#5fef8f', white: '#fff4dc',
  violet: '#b07aff', amber: '#ffc04a', teal: '#5fe8d0',
};
export const GLOW_RADII = [6, 12, 24, 48];
let loaded = false;

// ------------------------------------------------------------------ colour + pixel helpers

const rgbCache = new Map();
function rgb(hex) {
  let c = rgbCache.get(hex);
  if (c) return c;
  let s = hex.slice(1);
  if (s.length === 3) s = s.split('').map((ch) => ch + ch).join('');
  c = [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16), s.length >= 8 ? parseInt(s.slice(6, 8), 16) : 255];
  rgbCache.set(hex, c);
  return c;
}
function toHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(r) + h(g) + h(b);
}
function shade(hex, k) { const [r, g, b] = rgb(hex); return toHex(r * k, g * k, b * k); }
function mix(a, b, t) { const A = rgb(a), B = rgb(b); return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); }

function mkCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** Tiny RGBA pixel buffer. */
class Pix {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Uint8ClampedArray(w * h * 4); }
  set(x, y, col, a = 255) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h || !col) return;
    const c = typeof col === 'string' ? rgb(col) : col;
    const i = (y * this.w + x) * 4;
    this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = a === 255 && c[3] !== undefined ? c[3] : a;
  }
  alpha(x, y) { if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0; return this.d[(y * this.w + x) * 4 + 3]; }
  rect(x, y, w, h, col, a = 255) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, col, a); return this; }
  /** Draw string rows with a palette; '.' and ' ' are transparent. */
  rows(rows, pal, ox = 0, oy = 0) {
    for (let y = 0; y < rows.length; y++) {
      const r = rows[y];
      for (let x = 0; x < r.length; x++) { const col = pal[r[x]]; if (col) this.set(ox + x, oy + y, col); }
    }
    return this;
  }
  /** 1px outline around the opaque silhouette. */
  outline(col = OUTLINE) {
    const add = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.alpha(x, y) > 0) continue;
      if (this.alpha(x - 1, y) > 128 || this.alpha(x + 1, y) > 128 || this.alpha(x, y - 1) > 128 || this.alpha(x, y + 1) > 128) add.push(x, y);
    }
    for (let k = 0; k < add.length; k += 2) this.set(add[k], add[k + 1], col);
    return this;
  }
  line(x0, y0, x1, y1, col) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (let guard = 0; guard < 512; guard++) {
      this.set(x0, y0, col);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return this;
  }
  disc(cx, cy, r, col) {
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) this.set(x, y, col);
    }
    return this;
  }
  /** Replace every opaque pixel of colour `from` by `to` (palette swaps). */
  swap(map) {
    for (let i = 0; i < this.d.length; i += 4) {
      if (!this.d[i + 3]) continue;
      const k = toHex(this.d[i], this.d[i + 1], this.d[i + 2]);
      const to = map[k];
      if (to) { const c = rgb(to); this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; }
    }
    return this;
  }
  copy() { const p = new Pix(this.w, this.h); p.d.set(this.d); return p; }
  toCanvas() {
    const c = mkCanvas(this.w, this.h);
    const g = c.getContext('2d');
    const img = g.createImageData(this.w, this.h);
    img.data.set(this.d);
    g.putImageData(img, 0, 0);
    return c;
  }
}

/** Value noise on a lattice that wraps every `period` cells (seamless textures). */
function periodicNoise(seed, period) {
  const lat = (ix, iy) => hash2(((ix % period) + period) % period, ((iy % period) + period) % period, seed) / 4294967296;
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = lat(x0, y0), b = lat(x0 + 1, y0), c = lat(x0, y0 + 1), d = lat(x0 + 1, y0 + 1);
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  };
}

/** Seamless fbm over a `size` px square (octave periods 4, 8, 16... cells across the square). */
function seamlessFbm(seed, size, base = 4, octaves = 3) {
  const ns = [];
  for (let o = 0; o < octaves; o++) ns.push({ n: periodicNoise(seed + o * 101, base << o), k: (base << o) / size, a: 1 / (1 << o) });
  let norm = 0;
  for (const o of ns) norm += o.a;
  return (x, y) => { let s = 0; for (const o of ns) s += o.n(x * o.k, y * o.k) * o.a; return s / norm; };
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
const bayer = (x, y) => BAYER4[(y & 3) * 4 + (x & 3)];

// ------------------------------------------------------------------ sprite registry

function addSprite(name, frames, ax = null, ay = null) {
  const w = frames[0].w, h = frames[0].h;
  const strip = mkCanvas(w * frames.length, h);
  const g = strip.getContext('2d');
  frames.forEach((f, i) => g.drawImage(f instanceof Pix ? f.toCanvas() : f, i * w, 0));
  const s = { name, canvas: strip, w, h, frames: frames.length, ax: ax === null ? Math.floor(w / 2) : ax, ay: ay === null ? Math.floor(h / 2) : ay, flip: null };
  sprites.set(name, s);
  return s;
}
function alias(name, target) { sprites.set(name, sprites.get(target)); }

function flipped(s) {
  if (s.flip) return s.flip;
  const c = mkCanvas(s.canvas.width, s.canvas.height);
  const g = c.getContext('2d');
  g.translate(c.width, 0); g.scale(-1, 1);
  g.drawImage(s.canvas, 0, 0);
  s.flip = c;
  return c;
}

export function getSprite(name) { return sprites.get(name) || null; }
export function hasSprite(name) { return sprites.has(name); }
export function spriteNames() { return [...sprites.keys()]; }

/** Draw frame `frame` of sprite `name` so that its anchor lands on (x, y). opts: { flipX }. */
export function drawSprite(ctx, name, frame, x, y, opts) {
  const s = sprites.get(name);
  if (!s) return;
  const f = ((frame | 0) % s.frames + s.frames) % s.frames;
  if (opts && opts.flipX) {
    ctx.drawImage(flipped(s), (s.frames - 1 - f) * s.w, 0, s.w, s.h, Math.round(x - (s.w - s.ax)), Math.round(y - s.ay), s.w, s.h);
  } else {
    ctx.drawImage(s.canvas, f * s.w, 0, s.w, s.h, Math.round(x - s.ax), Math.round(y - s.ay), s.w, s.h);
  }
}

/** PNG data URL of frame 0 of `name`, integer-upscaled to about cssPx CSS pixels (DOM buttons). */
export function makeIcon(name, cssPx) {
  const s = sprites.get(name);
  if (!s || typeof document === 'undefined') return null;
  const dpr = typeof window !== 'undefined' ? Math.min(3, window.devicePixelRatio || 1) : 1;
  const k = Math.max(1, Math.round((cssPx * dpr) / Math.max(s.w, s.h)));
  const key = name + '|' + k;
  const hit = iconCache.get(key);
  if (hit) return hit;
  const c = mkCanvas(s.w * k, s.h * k);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(s.canvas, 0, 0, s.w, s.h, 0, 0, s.w * k, s.h * k);
  const url = c.toDataURL('image/png');
  iconCache.set(key, url);
  return url;
}

export function getTileTexture(id, variant) { const v = tileTex[id]; return v && v.length ? v[((variant % v.length) + v.length) % v.length] : null; }
export function tileVariantCount(id) { return tileTex[id] ? tileTex[id].length : 0; }

/** Texture index for the tile at (tx, ty): blocks of `period` px stay continuous across tiles. */
export function tileVariant(id, tx, ty) {
  const info = tileInfo[id];
  if (!info) return 0;
  const s = info.sub;
  const v = info.variants > 1 ? hash2(Math.floor(tx / s), Math.floor(ty / s), 0x7157 + id) % info.variants : 0;
  return v * s * s + (((ty % s) + s) % s) * s + (((tx % s) + s) % s);
}

export function getGlow(color, r) { const t = glows[color]; return (t && t[r]) || null; }

// ------------------------------------------------------------------ tile textures

/** Register `variants` blocks of period px, built by fn(v) -> Pix, cut into 8×8 tiles. */
function tileSet(id, period, variants, fn) {
  const sub = period / TS;
  const list = [];
  for (let v = 0; v < variants; v++) {
    const block = fn(v);
    const bc = block.toCanvas();
    for (let sy = 0; sy < sub; sy++) for (let sx = 0; sx < sub; sx++) {
      const c = mkCanvas(TS, TS);
      c.getContext('2d').drawImage(bc, sx * TS, sy * TS, TS, TS, 0, 0, TS, TS);
      list.push(c);
    }
  }
  tileTex[id] = list;
  tileInfo[id] = { period, variants, sub };
}

/** Riveted metal plates (period 16): seams on the top / left edges, rivets, detail variants. */
function texPlates(seed, cols, v, opts = {}) {
  const P = 16, p = new Pix(P, P);
  const [c0, c1, c2, c3] = cols;
  const r = mulberry32(seed + v * 31);
  const n = periodicNoise(seed + v, 4);
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    const t = n(x / 4, y / 4) + bayer(x, y) * 0.35;
    p.set(x, y, t < 0.3 ? c1 : c2);
  }
  // seams: dark line + light lip
  for (let i = 0; i < P; i++) { p.set(i, 0, c0); p.set(0, i, c0); p.set(i, 1, c3); p.set(1, i, mix(c2, c3, 0.5)); p.set(i, P - 1, c1); p.set(P - 1, i, c1); }
  if (opts.rivets !== false) for (const [x, y] of [[3, 3], [12, 3], [3, 12], [12, 12]]) { p.set(x, y, c3); p.set(x + 1, y + 1, c0); }
  if (v === 1) { // vent grille
    for (let k = 0; k < 4; k++) { for (let x = 5; x < 11; x++) { p.set(x, 5 + k * 2, c0); p.set(x, 6 + k * 2, c3); } }
  } else if (v === 2) { // inset panel
    for (let i = 4; i < 12; i++) { p.set(i, 4, c0); p.set(4, i, c0); p.set(i, 11, c3); p.set(11, i, c3); }
    p.set(7, 7, opts.lamp || c3); p.set(8, 7, c1);
  } else if (v === 3) { // weld line + scratches
    for (let x = 2; x < 14; x++) if ((x + v) % 3) p.set(x, 8, c1);
    for (let k = 0; k < 3; k++) { const x = 3 + Math.floor(r() * 9), y = 3 + Math.floor(r() * 9); p.set(x, y, c3); p.set(x + 1, y, c1); }
  }
  return p;
}

/** Twisted, scorched wreck hull (period 16). */
function texWreck(seed, cols, v) {
  const p = texPlates(seed, cols, v === 3 ? 0 : v, { rivets: v !== 2 });
  const n = periodicNoise(seed ^ 0x55, 4);
  const [c0, c1] = cols;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const s = n(x / 4 + v, y / 4) + bayer(x, y) * 0.3;
    if (s > 0.78) p.set(x, y, '#171010');
    else if (s > 0.66) p.set(x, y, c1);
  }
  // bent seam
  for (let x = 0; x < 16; x++) { const y = 6 + Math.round(Math.sin((x + v * 5) * 0.5) * 1.5); p.set(x, y, c0); p.set(x, y + 1, cols[3]); }
  if (v === 3) for (let k = 0; k < 5; k++) p.set(4 + k * 2, 11 + (k & 1), '#c25a22'); // rust
  return p;
}

/** White shuttle hull (period 16): clean panels, thin seams, a few decals. */
function texShuttle(seed, cols, v) {
  const P = 16, p = new Pix(P, P);
  const [c0, c1, c2, c3] = cols;
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) p.set(x, y, bayer(x, y) > 0.38 ? c2 : c3);
  for (let i = 0; i < P; i++) { p.set(i, 0, c1); p.set(0, i, c1); p.set(i, P - 1, mix(c2, c1, 0.4)); }
  if (v === 1) for (let x = 3; x < 13; x++) { p.set(x, 7, '#3f6fd8'); p.set(x, 8, '#2a4ea8'); }
  if (v === 2) { for (let i = 5; i < 11; i++) { p.set(i, 5, c1); p.set(i, 10, c1); p.set(5, i, c1); p.set(10, i, c1); } p.set(7, 7, c0); }
  if (v === 3) { p.set(4, 4, c1); p.set(11, 4, c1); p.set(4, 11, c1); p.set(11, 11, c1); }
  return p;
}

/** Periodic rock / regolith (period 32) with craterlets and pebbles. */
function texRock(seed, cols, v, opts = {}) {
  const P = 32, p = new Pix(P, P);
  const [c0, c1, c2, c3] = cols;
  const f = seamlessFbm(seed + v * 7, P, 4, 3);
  const r = mulberry32(seed * 3 + v);
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    const t = f(x, y) + bayer(x, y) * (opts.dither ?? 0.16) + (opts.bias ?? 0);
    p.set(x, y, t < 0.36 ? c0 : t < 0.47 ? c1 : t < 0.62 ? c2 : c3);
  }
  const craters = opts.craters ?? 3;
  for (let k = 0; k < craters; k++) {
    const cx = r() * P, cy = r() * P, cr = 1.6 + r() * (opts.craterMax ?? 3);
    for (let y = -4; y <= 4; y++) for (let x = -4; x <= 4; x++) {
      const d = Math.hypot(x, y);
      const px = ((Math.round(cx + x) % P) + P) % P, py = ((Math.round(cy + y) % P) + P) % P;
      if (d < cr - 0.8) p.set(px, py, x + y > 0 ? c1 : c0);
      else if (d < cr + 0.3) p.set(px, py, x + y > 0 ? c3 : c1);
    }
  }
  for (let k = 0; k < (opts.pebbles ?? 5); k++) {
    const x = Math.floor(r() * P), y = Math.floor(r() * P);
    p.set(x, y, c3); p.set((x + 1) % P, (y + 1) % P, c0);
  }
  return p;
}

/** Cracked small-rock fringe (period 8): lighter, with dark fracture lines (reads as breakable). */
function texFragile(seed, cols, v) {
  const p = new Pix(8, 8);
  const [c0, c1, c2, c3] = cols;
  const n = periodicNoise(seed + v, 2);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const t = n(x / 4, y / 4) + bayer(x, y) * 0.3; p.set(x, y, t < 0.35 ? c1 : t < 0.7 ? c2 : c3); }
  const r = mulberry32(seed * 7 + v);
  let x = Math.floor(r() * 8), y = 0;
  while (y < 8) { p.set(x, y, c0); y++; x = (x + (r() < 0.5 ? -1 : 1) + 8) % 8; }
  if (v & 1) { p.set(1, 5, c0); p.set(2, 5, c0); p.set(3, 6, c0); }
  return p;
}

/** Faceted ice (period 16). */
function texIce(seed, cols, v) {
  const P = 16, p = new Pix(P, P);
  const [c0, c1, c2, c3] = cols;
  const r = mulberry32(seed + v * 13);
  const pts = [];
  for (let i = 0; i < 6; i++) pts.push([r() * P, r() * P, r()]);
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) {
    let d1 = 1e9, d2 = 1e9, id = 0;
    for (let i = 0; i < pts.length; i++) for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const d = Math.hypot(x + 0.5 - pts[i][0] - ox * P, y + 0.5 - pts[i][1] - oy * P);
      if (d < d1) { d2 = d1; d1 = d; id = i; } else if (d < d2) d2 = d;
    }
    const tone = pts[id][2];
    p.set(x, y, d2 - d1 < 0.9 ? c3 : tone < 0.33 ? c1 : tone < 0.75 ? c2 : mix(c2, c3, 0.5));
  }
  p.set(Math.floor(r() * P), Math.floor(r() * P), '#ffffff');
  if (c0) p.set(Math.floor(r() * P), Math.floor(r() * P), c0);
  return p;
}

/** Boulder pile (period 16) for the Tycho rubble plug. */
function texRubble(seed, cols, v) {
  const P = 16, p = new Pix(P, P);
  const [c0, c1, c2, c3] = cols;
  p.rect(0, 0, P, P, '#15110e');
  const r = mulberry32(seed + v * 17);
  for (let k = 0; k < 9; k++) {
    const cx = r() * P, cy = r() * P, rr = 2 + r() * 2.6;
    for (let y = -5; y <= 5; y++) for (let x = -5; x <= 5; x++) {
      const d = Math.hypot(x, y);
      if (d > rr) continue;
      const px = ((Math.round(cx + x) % P) + P) % P, py = ((Math.round(cy + y) % P) + P) % P;
      const lit = -(x * 0.7 + y * 0.7) / rr;
      p.set(px, py, d > rr - 0.9 ? c0 : lit > 0.35 ? c3 : lit > -0.25 ? c2 : c1);
    }
  }
  return p;
}

function texFloor(cols, v) {
  const P = 16, p = new Pix(P, P);
  const [c0, c1, c2, c3] = cols;
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) p.set(x, y, bayer(x, y) > 0.3 ? c1 : c2);
  for (let i = 0; i < P; i++) { p.set(i, 0, c0); p.set(0, i, c0); p.set(i, 8, c0); p.set(8, i, c0); p.set(i, 1, c3); p.set(i, 9, c3); }
  for (const [x, y] of [[2, 3], [13, 3], [2, 13], [13, 13], [5, 5], [10, 11]]) if ((x + y + v) % 3) p.set(x, y, c3);
  if (v === 1) { p.rect(10, 3, 4, 3, c0); p.set(11, 4, c3); }
  return p;
}

function texGrate(cols, v) {
  const p = new Pix(8, 8);
  const [c0, c1, c2, c3] = cols;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const bar = x % 4 === 0 || y % 4 === 0;
    p.set(x, y, bar ? ((x % 4 === 0 && y % 4 === 0) ? c3 : c2) : ((x + y + v) % 3 === 0 ? c1 : c0));
  }
  return p;
}

function texPlating(cols, v) {
  const P = 16, p = new Pix(P, P);
  const [c0, c1, c2, c3] = cols;
  for (let y = 0; y < P; y++) for (let x = 0; x < P; x++) p.set(x, y, c1);
  // diamond tread
  for (let y = 0; y < P; y += 4) for (let x = (y / 4) % 2 ? 2 : 0; x < P; x += 4) { p.set(x, y, c3); p.set(x + 1, y + 1, c2); p.set(x + 1, y, c0); }
  for (let i = 0; i < P; i++) { p.set(i, 0, c0); p.set(0, i, c0); }
  if (v === 1) { p.set(4, 4, c3); p.set(11, 11, c3); }
  return p;
}

function texSolar(cols) {
  const p = new Pix(8, 8);
  const [c0, c1, c2, c3] = cols;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const edge = x === 0 || y === 0;
    p.set(x, y, edge ? '#aab4c6' : x + y < 6 ? c2 : c1);
  }
  p.set(2, 2, c3); p.set(3, 2, c3); p.set(2, 3, c3);
  p.set(7, 7, c0);
  return p;
}

function texWindow(cols, v) {
  const p = new Pix(8, 8);
  const [, c1, c2, c3] = cols;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) p.set(x, y, x + y < 5 ? c2 : c1, 150);
  // reflection streaks (diagonal, continuous across tiles)
  for (let k = 0; k < 8; k++) { const x = (k + 2 + v) % 8, y = 7 - k; if ((k + v) % 4 < 2) p.set(x, y, c3, 200); }
  return p;
}

function texPanel(cols, v) {
  const p = new Pix(8, 8);
  const [c0, c1, c2, c3] = cols;
  p.rect(0, 0, 8, 8, '#161a22');
  p.rect(0, 0, 8, 1, '#2a303c');
  p.rect(1, 1, 6, 6, '#0b0e14');
  if (v === 0) { p.rect(2, 2, 4, 3, c1); p.rect(2, 2, 4, 1, c2); p.set(2, 6, c3); p.set(4, 6, '#ff8a3a'); }
  else if (v === 1) { p.rect(2, 2, 4, 2, c1); p.set(2, 3, c3); p.set(4, 3, c2); p.set(2, 5, '#5fef8f'); p.set(4, 5, c0); p.set(5, 5, '#ffcf4a'); }
  else if (v === 2) { p.rect(2, 2, 2, 4, c1); p.set(5, 2, c3); p.set(5, 4, '#ff5a4a'); p.set(5, 5, c2); }
  else { p.rect(2, 2, 4, 4, c0); p.set(3, 3, c2); p.set(4, 3, c3); p.set(3, 4, c1); }
  return p;
}

function texLight(cols) {
  const p = new Pix(8, 8);
  const [, c1, c2, c3] = cols;
  const f = TILES[T.FLOOR].colors;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) p.set(x, y, bayer(x, y) > 0.3 ? f[1] : f[2]);
  p.rect(1, 2, 6, 4, c1); p.rect(2, 3, 4, 2, c3); p.set(2, 2, c2); p.set(5, 2, c2);
  return p;
}

function texPad(cols) {
  const p = new Pix(8, 8);
  const [c0, c1, c2, c3] = cols;
  p.rect(0, 0, 8, 8, c0);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const d = Math.hypot(x + 0.5 - 4, y + 0.5 - 4);
    if (d > 2.6 && d < 3.7) p.set(x, y, (x + y) % 2 ? c3 : c2);
    else if (d <= 2.6) p.set(x, y, c1);
  }
  p.set(3, 3, c2); p.set(4, 4, c2);
  return p;
}

function texEmitter(cols) {
  const p = new Pix(8, 8);
  const [c0, c1, c2, c3] = cols;
  p.rect(0, 0, 8, 8, '#262a33'); p.rect(0, 0, 8, 1, '#4a5260'); p.rect(0, 7, 8, 1, '#12151b');
  p.rect(2, 2, 4, 4, c0); p.rect(3, 3, 2, 2, c2); p.set(3, 3, c3); p.set(2, 2, c1);
  return p;
}

function texVent(cols) {
  const p = new Pix(8, 8);
  const [c0, c1, c2, c3] = cols;
  const rock = TILES[T.MOON_ROCK].colors;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) p.set(x, y, bayer(x, y) > 0 ? rock[1] : rock[2]);
  p.rect(1, 1, 6, 6, c1); p.rect(2, 2, 4, 4, '#07060a');
  for (let k = 2; k < 6; k += 2) { p.set(k, 3, c2); p.set(k + 1, 4, c3); }
  p.set(1, 1, c3); p.set(6, 6, c0);
  return p;
}

function texHazard(cols) {
  const p = new Pix(8, 8);
  const [c0, , c2, c3] = cols;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) p.set(x, y, ((x + y) & 7) < 4 ? (y === 0 ? c3 : c2) : c0);
  return p;
}

function texDoorOpen(cols) {
  const p = new Pix(8, 8);
  const f = TILES[T.FLOOR].colors;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) p.set(x, y, bayer(x, y) > 0.3 ? f[0] : f[1]);
  for (let i = 0; i < 8; i++) { p.set(i, 2, cols[1]); p.set(i, 5, cols[1]); }
  return p;
}

function buildTileTextures() {
  const C = (id) => TILES[id].colors;
  for (let id = 0; id < TILE_COUNT; id++) { tileTex[id] = []; tileInfo[id] = null; }
  tileSet(T.HULL, 16, 4, (v) => texPlates(101, C(T.HULL), v, { lamp: '#ffd36a' }));
  tileSet(T.HULL_DARK, 16, 4, (v) => texPlates(202, C(T.HULL_DARK), v, { lamp: '#ff6a4a' }));
  tileSet(T.WRECK, 16, 4, (v) => texWreck(303, C(T.WRECK), v));
  tileSet(T.SHUTTLE, 16, 4, (v) => texShuttle(404, C(T.SHUTTLE), v));
  tileSet(T.WINDOW, 8, 2, (v) => texWindow(C(T.WINDOW), v));
  tileSet(T.FLOOR, 16, 2, (v) => texFloor(C(T.FLOOR), v));
  tileSet(T.GRATE, 8, 2, (v) => texGrate(C(T.GRATE), v));
  tileSet(T.MOON_ROCK, 32, 2, (v) => texRock(505, C(T.MOON_ROCK), v, { craters: 3 }));
  tileSet(T.MOON_CRATER, 32, 2, (v) => texRock(606, C(T.MOON_CRATER), v, { craters: 5, craterMax: 2 }));
  tileSet(T.MOON_DUST, 32, 2, (v) => texRock(707, C(T.MOON_DUST), v, { craters: 1, dither: 0.24, bias: 0.04 }));
  tileSet(T.MOON_FLOOR, 32, 2, (v) => texRock(808, C(T.MOON_FLOOR), v, { craters: 0, pebbles: 9, bias: 0.05 }));
  tileSet(T.RUBBLE, 16, 2, (v) => texRubble(909, C(T.RUBBLE), v));
  tileSet(T.ASTEROID, 32, 2, (v) => texRock(1010, C(T.ASTEROID), v, { craters: 4, craterMax: 2.4 }));
  tileSet(T.ASTEROID_SMALL, 8, 4, (v) => texFragile(1111, C(T.ASTEROID_SMALL), v));
  tileSet(T.ICE, 16, 3, (v) => texIce(1212, C(T.ICE), v));
  tileSet(T.DOOR_OPEN, 8, 1, () => texDoorOpen(C(T.DOOR_OPEN)));
  tileSet(T.PAD, 8, 1, () => texPad(C(T.PAD)));
  tileSet(T.PANEL, 8, 4, (v) => texPanel(C(T.PANEL), v));
  tileSet(T.LIGHT, 8, 1, () => texLight(C(T.LIGHT)));
  tileSet(T.SOLAR_PANEL, 8, 1, () => texSolar(C(T.SOLAR_PANEL)));
  tileSet(T.PLATING, 16, 2, (v) => texPlating(C(T.PLATING), v));
  tileSet(T.EMITTER, 8, 1, () => texEmitter(C(T.EMITTER)));
  tileSet(T.VENT, 8, 1, () => texVent(C(T.VENT)));
  tileSet(T.HAZARD_FLOOR, 8, 1, () => texHazard(C(T.HAZARD_FLOOR)));
}

/** Door pieces (8×8): h = horizontal door (end-left, middle, end-right), v = vertical. */
function buildDoors() {
  const lockedPart = (part) => {
    const p = new Pix(8, 8);
    p.rect(0, 0, 8, 8, '#3a1418');
    p.rect(0, 0, 8, 1, '#1a0a0c'); p.rect(0, 7, 8, 1, '#1a0a0c');
    p.rect(0, 1, 8, 1, '#7a2a2a'); p.rect(0, 6, 8, 1, '#240c10');
    for (let x = 0; x < 8; x++) { p.set(x, 3, '#ff4a3a'); p.set(x, 4, '#b8201c'); }
    if (part === 0) { p.rect(0, 0, 2, 8, '#262a33'); p.set(1, 2, '#ffb0a0'); p.set(1, 5, '#8a1a14'); }
    if (part === 2) { p.rect(6, 0, 2, 8, '#262a33'); p.set(6, 2, '#ffb0a0'); p.set(6, 5, '#8a1a14'); }
    if (part === 1) { p.set(3, 2, '#ffe0d0'); p.set(4, 2, '#ffe0d0'); p.rect(3, 5, 2, 1, '#ff8a6a'); }
    return p;
  };
  const openPart = (part) => {
    const p = texDoorOpen(TILES[T.DOOR_OPEN].colors);
    if (part === 0) { p.rect(0, 0, 2, 8, '#262a33'); p.set(1, 3, '#5fef8f'); p.set(1, 4, '#2e9a58'); }
    if (part === 2) { p.rect(6, 0, 2, 8, '#262a33'); p.set(6, 3, '#5fef8f'); p.set(6, 4, '#2e9a58'); }
    return p;
  };
  const rot = (p) => { const q = new Pix(8, 8); for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const i = (y * 8 + x) * 4; q.set(7 - y, x, [p.d[i], p.d[i + 1], p.d[i + 2]], p.d[i + 3]); } return q; };
  addSprite('door_h', [lockedPart(0), lockedPart(1), lockedPart(2)], 0, 0);
  addSprite('door_open_h', [openPart(0), openPart(1), openPart(2)], 0, 0);
  // vertical: rotate so part 0 is the top end
  addSprite('door_v', [rot(lockedPart(0)), rot(lockedPart(1)), rot(lockedPart(2))], 0, 0);
  addSprite('door_open_v', [rot(openPart(0)), rot(openPart(1)), rot(openPart(2))], 0, 0);
  // the registry texture of a locked door (map dumps, sprite sheet)
  tileTex[T.DOOR_LOCKED] = [lockedPart(1).toCanvas()];
  tileInfo[T.DOOR_LOCKED] = { period: 8, variants: 1, sub: 1 };
}

// ------------------------------------------------------------------ astronaut (16 directions)

const SUIT = ['#5c6576', '#a6afc0', '#e1e6ee', '#ffffff'];
const SUIT_HURT = ['#6e2a2e', '#c26a6e', '#f2a8aa', '#ffe2e2'];
const SUIT_DIM = ['#3a3f4a', '#5f6674', '#8a92a0', '#b0b6c2'];
const PACK = ['#2c323e', '#525c70', '#7a8699', '#a8b3c6'];
const DARKP = ['#1c2029', '#363c49', '#555e6e', '#78819a'];
const VISOR = ['#5e2606', '#bd5a14', '#f0982c', '#ffe6a4'];

/** Shaded level (0..3) of a local normal (nu, nv) rotated by (ca, sa) under the world light. */
function lightLevel(nu, nv, ca, sa, bias = 0) {
  const nx = nu * ca - nv * sa, ny = nu * sa + nv * ca;
  const s = nx * LIGHT_DIR.x + ny * LIGHT_DIR.y + bias;
  return s > 0.42 ? 3 : s > -0.18 ? 2 : s > -0.62 ? 1 : 0;
}

function astroFrame(dir, suit) {
  const S = 16, p = new Pix(S, S);
  const a = (dir * TAU) / 16, ca = Math.cos(a), sa = Math.sin(a);
  const K = 0.88;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const wx = x + 0.5 - 8, wy = y + 0.5 - 8;
    const u = (wx * ca + wy * sa) / K, v = (-wx * sa + wy * ca) / K;
    const av = Math.abs(v), sv = v < 0 ? -1 : 1;
    let col = null;
    // MMU hand controllers
    if (u > 0.4 && u < 2.3 && av > 3.3 && av < 4.4) col = DARKP[lightLevel(0.3, sv, ca, sa)];
    // backpack (MMU)
    else if (u > -3.5 && u < 0.7 && av < 2.15) {
      const edgeU = u < -2.8 ? -1 : u > 0.1 ? 1 : 0;
      const edgeV = av > 1.5 ? sv : 0;
      col = PACK[lightLevel(edgeU * 0.8, edgeV * 0.8, ca, sa, 0.1)];
      if (u < -2.8 && av > 0.9 && av < 2.0) col = '#1a1d24';           // rear nozzles
      if (u > -1.0 && u < -0.3 && av < 0.45) col = '#ff6a3a';           // status light
    } else {
      // helmet + visor
      const hu = u - 3.1, hr = 3.0;
      if (hu * hu + v * v < hr * hr) {
        if (hu > 1.0) col = VISOR[Math.min(3, lightLevel(hu / hr, v / hr, ca, sa, 0.15) + (hu > 1.5 && v < -0.2 && v > -1.3 ? 1 : 0))];
        else col = suit[lightLevel(hu / hr, v / hr, ca, sa, 0.1)];
      } else {
        // arms
        const au = (u - 0.5) / 2.1, avv = (av - 3.45) / 1.05;
        if (au * au + avv * avv < 1) col = u > 1.9 ? DARKP[lightLevel(au, avv * sv, ca, sa, 0.2)] : suit[lightLevel(au, avv * sv, ca, sa)];
        else {
          const tu = (u + 0.6) / 3.1, tv = v / 3.05;
          if (tu * tu + tv * tv < 1) col = suit[lightLevel(tu, tv, ca, sa)];
          else {
            const lu = (u + 4.9) / 2.45, lv = (av - 1.35) / 1.15;
            if (lu * lu + lv * lv < 1) col = u < -6.3 ? DARKP[lightLevel(lu, lv * sv, ca, sa, 0.2)] : suit[lightLevel(lu, lv * sv, ca, sa)];
          }
        }
      }
    }
    if (col) p.set(x, y, col);
  }
  return p.outline();
}

function buildAstronaut() {
  const mk = (suit) => { const f = []; for (let d = 0; d < 16; d++) f.push(astroFrame(d, suit)); return f; };
  addSprite('astro', mk(SUIT), 8, 8);
  addSprite('astro_hurt', mk(SUIT_HURT), 8, 8);
  addSprite('astro_dim', mk(SUIT_DIM), 8, 8);
}

// ------------------------------------------------------------------ asteroids

const AST_RAMPS = [
  ['#1a1411', '#3d322a', '#5e4f41', '#86725e', '#a8927a'],
  ['#161312', '#36302c', '#57504a', '#7c736b', '#9e958b'],
  ['#1c1410', '#46301f', '#6e4a2e', '#98693f', '#bf8c58'],
  ['#12222c', '#2a5068', '#4d88a4', '#86c2da', '#d4f3ff'],
];

function asteroidFrames(R, variant) {
  const size = Math.ceil(R * 2 + 4) | 1;
  const c = size / 2;
  const r = mulberry32(0xa57e + variant * 977 + R * 13);
  const bumps = [];
  for (let k = 0; k < 4; k++) bumps.push({ f: 2 + k + (k > 1 ? 1 : 0), a: (0.05 + r() * 0.08) * (k < 2 ? 1.3 : 0.7), ph: r() * TAU });
  const craters = [];
  const nC = R < 8 ? 1 : R < 13 ? 2 : 4;
  for (let k = 0; k < nC; k++) { const ang = r() * TAU, d = r() * R * 0.55; craters.push([Math.cos(ang) * d, Math.sin(ang) * d, R * (0.16 + r() * 0.14)]); }
  const ramp = AST_RAMPS[variant % 4];
  const n = periodicNoise(0x51 + variant, 64);
  const radius = (th) => { let k = 1; for (const b of bumps) k += b.a * Math.sin(b.f * th + b.ph); return R * 0.93 * k; };
  const frames = [];
  for (let f = 0; f < 16; f++) {
    const rot = (f * TAU) / 16;
    const cr = Math.cos(rot), sr = Math.sin(rot);
    const p = new Pix(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      const d = Math.hypot(dx, dy);
      const lth = Math.atan2(dy, dx) - rot;
      const rr = radius(lth);
      if (d > rr) continue;
      const lx = dx * cr + dy * sr, ly = -dx * sr + dy * cr; // rock-local coordinates
      const q = d / rr;
      const nz = Math.sqrt(Math.max(0, 1 - q * q));
      const lam = ((dx / rr) * LIGHT_DIR.x + (dy / rr) * LIGHT_DIR.y) * 0.8 + nz * 0.55;
      let lv = lam * 2.6 + (n(lx * 0.45 + 32, ly * 0.45 + 32) - 0.5) * 1.4 + bayer(x, y) * 0.5;
      for (const [cx, cy, crr] of craters) {
        const e = Math.hypot(lx - cx, ly - cy);
        if (e < crr) { lv -= 1.1; const wx = (lx - cx) * cr - (ly - cy) * sr, wy = (lx - cx) * sr + (ly - cy) * cr; if ((wx * LIGHT_DIR.x + wy * LIGHT_DIR.y) < -crr * 0.3) lv += 1.4; }
        else if (e < crr + 0.9) lv += 0.5;
      }
      const idx = Math.max(0, Math.min(4, Math.floor(lv + 1.6)));
      p.set(x, y, ramp[idx]);
    }
    frames.push(p.outline());
  }
  return frames;
}

function buildAsteroids() {
  const radii = [6, 11, 18];
  for (let s = 0; s < 3; s++) for (let v = 0; v < 4; v++) addSprite(`ast_${s}_${v}`, asteroidFrames(radii[s], v));
}

// ------------------------------------------------------------------ small props, items, icons

const PAL = {
  k: OUTLINE, w: '#ffffff', l: '#c8d0dc', s: '#9aa6b8', g: '#6d788c', d: '#3a404d', e: '#23272f',
  c: '#6fe6ff', C: '#1f7a9a', a: '#bff4ff', o: '#ff9a2e', O: '#b8520e', y: '#ffe07a', Y: '#d8a02a',
  r: '#ff4a3a', R: '#8a1a14', p: '#ffb0a0', v: '#c08aff', V: '#5a2a9a', b: '#5a86ff', B: '#1e3070',
  G: '#5fe08a', n: '#1e7a44', h: '#9a7250', H: '#5a3e28', t: '#f0c030', m: '#e05aa0',
};

/** Rows sprite; outlined unless outline === false. Rows are placed with a 1 px margin when outlined. */
function S(name, rowsList, opts = {}) {
  const frames = rowsList.map((rows) => {
    const m = opts.outline === false ? 0 : 1;
    const w = Math.max(...rows.map((r) => r.length)) + m * 2, h = rows.length + m * 2;
    const p = new Pix(w, h).rows(rows, opts.pal || PAL, m, m);
    return opts.outline === false ? p : p.outline(opts.outlineCol || OUTLINE);
  });
  return addSprite(name, frames, opts.ax ?? null, opts.ay ?? null);
}

function buildIcons() {
  // ---- equipment (12×12 incl. outline)
  S('item_keycard', [[
    'llllllllll',
    'lwwwwwwwwl',
    'lwyyywccwl',
    'lwyOywwwwl',
    'lwyyywccwl',
    'lwwwwwwwwl',
    'lCCCCCCCCl',
    'llllllllll',
  ]]);
  S('item_explosives', [[
    '.......yo.',
    '......d...',
    'RrrRrrRrd.',
    'RrrRrrRrr.',
    'dddddddddd',
    'dcydddddd.',
    'RrrRrrRrr.',
    'RrrRrrRrr.',
    'RrrRrrRrr.',
    'RRrRRrRRr.',
  ]]);
  S('item_heatshield', [[
    '.ssssssss.',
    'sllllllllS',
    'sloooooolS',
    'slooyyoolS',
    'sloywwyolS',
    '.sOoyyoOS.',
    '.slOooOlS.',
    '..sOOOOS..',
    '...sllS...',
    '....sS....',
  ]]);
  S('item_anchor', [[
    '....vv....',
    '...v..v...',
    '....vv....',
    '.vvvvvvvv.',
    '....vv....',
    'v...vv...v',
    'vv..vv..vv',
    '.vv.vv.vv.',
    '..vvvvvv..',
    '....VV....',
  ]]);
  for (const k of ['keycard', 'explosives', 'heatshield', 'anchor']) alias(k, 'item_' + k);

  // ---- workbench upgrades
  S('up_o2', [[
    '...llll...',
    '....ss....',
    '..cccccc..',
    '.cawcccCC.',
    '.cacccccC.',
    '.cckkcccC.',
    '.ckcckccC.',
    '.cckkcCCC.',
    '.ccccCCCC.',
    '..CCCCCC..',
  ]], { pal: { ...PAL, k: '#0e3a4a' } });
  S('up_fuel', [[
    '..dd......',
    '.dooooood.',
    '.oyoooooO.',
    '.oyoOOooO.',
    '.oooOoOoO.',
    '.ooOooOoO.',
    '.oOooooOO.',
    '.ooooooOO.',
    '.OOOOOOOO.',
    '..........',
  ]]);
  S('up_thrust', [[
    '...ssss...',
    '..sllllS..',
    '..slllgS..',
    '...sgggS..',
    '..ssgggSS.',
    '.ssgggggSS',
    '..yywwyy..',
    '...yooy...',
    '....oo....',
    '....O.....',
  ]]);
  S('up_hull', [[
    'ssssssssss',
    'slllllllgs',
    'slwlllwlgs',
    'sllllllggs',
    'slllllgggs',
    'sllllggggs',
    'slwlggwggs',
    'slgggggggs',
    'sggggggggs',
    'ssssssssss',
  ]]);
  S('up_radar', [[
    '......G...',
    '..lll..G..',
    '.lwwwl..G.',
    'lwwllgl.G.',
    'lwllgggl..',
    '.llgggggl.',
    '..lgggggd.',
    '....ddd...',
    '...ddddd..',
    '..ddddddd.',
  ]]);
  S('up_magnet', [[
    '.rrr..rrr.',
    'rwrr..rrrR',
    'rrrR..rrrR',
    'rrrR..rrrR',
    'rrrR..rrrR',
    'rrrrrrrrRR',
    '.rrrrrrRR.',
    '..RRRRRR..',
    '.ll....ll.',
    '.ss....ss.',
  ]]);
  S('up_charges', [[
    '...yo...yo',
    '..d....d..',
    '.rrr..rrr.',
    'rwrrrrwrrr',
    'rrrrrrrrrr',
    'rrrRrrrrrR',
    '.rRR..rRR.',
    'dddddddddd',
    'dsssssssdd',
    'dddddddddd',
  ]]);
  for (const k of ['o2', 'fuel', 'thrust', 'hull', 'radar', 'magnet', 'charges']) alias('upg_' + k, 'up_' + k);

  // ---- touch controls
  S('brake', [[
    '...wwww...',
    '.wwwwwwww.',
    '.wwwwwwww.',
    'wwwwwwwwww',
    'wddddddddw',
    'wddddddddw',
    'wwwwwwwwww',
    '.wwwwwwww.',
    '.wwwwwwww.',
    '...wwww...',
  ]], { pal: { ...PAL, d: '#8a1a14' } });
  S('boost', [[
    'yy...yy...',
    '.yy...yy..',
    '..yy...yy.',
    '...yy...yy',
    '...yy...yy',
    '..yy...yy.',
    '.yy...yy..',
    'yy...yy...',
  ]]);
  S('charge', [[
    '......yo..',
    '.....d....',
    '...rrrr...',
    '..rwrrrr..',
    '.rwrrrrrr.',
    '.rrrrrrrr.',
    '.rrrrrrrR.',
    '.rrrrrrRR.',
    '..rrrRRR..',
    '...RRRR...',
  ]]);
  S('action', [[
    '...wwww...',
    '.ww....ww.',
    '.w......w.',
    'w...cc...w',
    'w..cccc..w',
    'w..cccc..w',
    'w...cc...w',
    '.w......w.',
    '.ww....ww.',
    '...wwww...',
  ]]);
  S('map', [[
    'lllsssllls',
    'lllsssllls',
    'lrlsssllls',
    'llrsssllrs',
    'lrlssslrls',
    'lllsrslrls',
    'lllssrrlls',
    'lllsssllls',
    'lllsssllls',
    'lllsssllls',
  ]]);
  S('pause', [[
    '.www..www.',
    '.www..www.',
    '.www..www.',
    '.www..www.',
    '.www..www.',
    '.www..www.',
    '.www..www.',
    '.www..www.',
  ]]);

  // ---- HUD minis (7×7 + outline) and their DOM-size aliases
  S('hud_hull', [['.rrrrr.', 'rprrrrr', 'rprrrrR', 'rrrrrrR', '.rrrrR.', '..rrR..', '...R...']]);
  S('hud_o2', [['..ccc..', '.caccc.', 'caccccC', 'cccccCC', 'ccccCCC', '.cccCC.', '..CCC..']]);
  S('hud_fuel', [['...y...', '..yy...', '..yoy..', '.yooo..', '.oooOo.', 'oOoOOo.', '.OOOO..']]);
  S('hud_salvage', [['.s.s.s.', 'sssssss', '.slllg.', 'ssl.lss', '.sgllg.', 'sssssss', '.s.s.s.']]);
  S('hud_charge', [['....y..', '...d...', '.rrr...', 'rrwrr..', 'rrrrr..', 'rrrrR..', '.rRR...']]);
  S('hud_charge_off', [['.......', '...d...', '.ddd...', 'ddsdd..', 'ddddd..', 'ddddd..', '.ddd...']]);
  alias('hull', 'hud_hull'); alias('o2', 'hud_o2'); alias('fuel', 'hud_fuel'); alias('salvage', 'hud_salvage');

  // ---- POI icons (map + radar)
  S('poi_home', [['...c...', '..ccc..', '.ccccc.', 'ccccccc', '.caaac.', '.ca.ac.', '.ccccc.']]);
  S('poi_shuttle', [['.......', 'll.....', '.lllll.', '.llllcl', '.lllll.', 'll.....', '.......']]);
  S('poi_station', [['...s...', '..sss..', '.scccs.', 'sscwcss', '.scccs.', '..sss..', '...s...']]);
  S('poi_moon', [['..lll..', '.llllg.', 'llglllg', 'lllllgg', 'lglllgg', '.llggg.', '..ggg..']]);
  S('poi_gallery', [['..hhh..', '.hhhhh.', 'hhkkkhh', 'hhkkkhh', 'hhkkkhh', 'hhkkkhh', 'hhkkkhh']]);
  S('poi_sun', [['y..y..y', '.yyyyy.', '.yyooy.', 'yyoooyy', '.yoooy.', '.yyyyy.', 'y..y..y']]);
  S('poi_observatory', [['....c..', '...c...', '..lll..', '.lllll.', '.lllll.', 'sssssss', 's.....s']]);
  S('poi_blackhole', [['..vvv..', '.voooov', 'vokkkov', 'vokkkov', 'vokkkov', 'voooov.', '..vvv..']]);
  S('poi_capsule', [['...l...', '..lll..', '..lcl..', '..lll..', '.lllll.', '.lsssl.', '..o.o..']]);
  S('poi_wreck', [['hh.....', 'hhh....', '.hhh.h.', '..h.hhh', '....hhh', '.....hh', '.......']]);
  S('poi_satellite', [['bb...bb', 'bb.s.bb', 'bbsssbb', 'bbsrsbb', 'bb.s.bb', 'bb...bb']]);
}

function buildProps() {
  // pickups (7×7 incl. outline)
  const salv = [
    ['.ss..', 'sllg.', '.lgg.', '..gs.', '...s.'],
    ['sssss', 'slllg', 'sl.lg', 'sgggg', '.....'],
    ['.s.s.', 'sllls', '.l.g.', 'sggss', '.s.s.'],
    ['..o..', '.sls.', 'sllgs', '.sgs.', '..s..'],
  ];
  S('pk_salvage', salv);
  S('pk_cache', [
    ['.ttttt.', 'tyyyyYt', 'tyHHHYt', 'ttttttt', 'tYHyHYt', 'tYYYYYt', '.ttttt.'],
    ['.ttttt.', 'twyyyYt', 'tyHHHYt', 'ttttttt', 'tYHwHYt', 'tYYYYYt', '.ttttt.'],
  ], { pal: { ...PAL, H: '#7a4a12' } });
  S('pk_o2', [['.ll.', 'cccc', 'cacC', 'cacC', 'cccC', 'cCCC']]);
  S('pk_fuel', [['.dd.', 'oooo', 'oyoO', 'oyOO', 'oooO', 'OOOO']]);
  S('pk_repair', [['lllll', 'llrll', 'lrrrl', 'llrll', 'lllls']]);

  // crate (closed, open) 10×10
  S('crate', [
    ['ssssssss', 'stlllltg', 'sltllgtg', 'sllttggg', 'sllttggg', 'sltggtgg', 'stgggggt', 'gggggggg'],
    ['ssssssss', 'seeeeeeg', 'seddddeg', 'sedddd.g', 'se.dddeg', 'seddddeg', 'seeeeeeg', 'gggggggg'],
  ]);
  // terminal overlay (unread, unread bright, read) on a console tile
  S('terminal', [
    ['dddddd', 'dYYYYd', 'dYttYd', 'dYYYYd', 'dddddd', '.d..d.'],
    ['dddddd', 'dtttyd', 'dtwwtd', 'dttttd', 'dddddd', '.d..d.'],
    ['dddddd', 'dnnnnd', 'dnGnnd', 'dnnGnd', 'dddddd', '.d..d.'],
  ]);
  S('refill', [[
    'dddddddd',
    'dcCdcCsd',
    'dacdacsd',
    'dccdccsd',
    'dccdccgd',
    'dCCdCCGd',
    'dddddddd',
    'sssssss.',
  ]]);
  S('locker', [[
    'ssssssss',
    'sddddddg',
    'sdrrrrdg',
    'sddddddg',
    'sdyddydg',
    'sddrrddg',
    'sddrrddg',
    'sddddddg',
    'gggggggg',
  ]]);
  S('workbench', [[
    'hhhhhhhhhhhh',
    'hsslhhhhyhhH',
    'hhhlhhdhhhhH',
    'hhhlhdddhrhH',
    'hhhhhhdhhhhH',
    'HHHHHHHHHHHH',
    'd..........d',
  ]]);
  S('hatch', [
    ['..ssss..', '.sddddg.', 'sdRrrRdg', 'sdrRRrdg', 'sdrRRrdg', 'sdRrrRdg', '.gddddg.', '..gggg..'],
    ['..ssss..', '.sddddg.', 'sdnGGndg', 'sdGwwGdg', 'sdGwwGdg', 'sdnGGndg', '.gddddg.', '..gggg..'],
  ]);
  S('turret_base', [[
    '..dddddd..',
    '.dggggggd.',
    'dgsssssgdd',
    'dgsdddsgdd',
    'dgsdrdsgdd',
    'dgsdddsgdd',
    'dgsssssgdd',
    '.dggggggd.',
    '..dddddd..',
  ]]);
  S('turret_dead', [[
    '..d..dd...',
    '.dgd.ggd..',
    'd.sss.gd..',
    'dgs.e.s.d.',
    '.gs.e..gd.',
    'dgse.dsg..',
    '.g.sss.gd.',
    '..dg.ggd..',
    '...d..d...',
  ]]);
  S('charge', [
    ['.ddd.', 'dsssd', 'dsrsd', 'dsssd', '.ddd.'],
    ['.ddd.', 'dsssd', 'dsysd', 'dsssd', '.ddd.'],
  ]);
  S('bolt', [['.oo.', 'oyyo', 'oyyo', '.oo.']], { outlineCol: '#5a1206' });
  S('capsule_ship', [[
    '.....ll.....',
    '....llll....',
    '....lccl....',
    '...llccll...',
    '...llllll...',
    '..llllllll..',
    '..lwllllll..',
    '..lwlllllg..',
    '..lllllllg..',
    '.llllllllgg.',
    '.lllllllggg.',
    '.sssssssssss',
    '.dhhhhhhhhhd',
    '..dddddddd..',
    '...dgggd....',
    '...ddddd....',
  ]]);
}

/** Rotated shapes: radar arrows (16 dirs), turret barrels (32 dirs). */
function buildRotated() {
  const arrows = [];
  for (let d = 0; d < 16; d++) {
    const a = (d * TAU) / 16, ca = Math.cos(a), sa = Math.sin(a);
    const p = new Pix(11, 11);
    for (let y = 0; y < 11; y++) for (let x = 0; x < 11; x++) {
      const wx = x + 0.5 - 5.5, wy = y + 0.5 - 5.5;
      const u = wx * ca + wy * sa, v = -wx * sa + wy * ca;
      if (u > -2.6 && u < 3.6 && Math.abs(v) < (3.6 - u) * 0.62) p.set(x, y, u > 1.2 ? '#ffffff' : '#bff4ff');
    }
    arrows.push(p.outline());
  }
  addSprite('radar_arrow', arrows, 5, 5);
  const guns = [];
  for (let d = 0; d < 32; d++) {
    const a = (d * TAU) / 32, ca = Math.cos(a), sa = Math.sin(a);
    const p = new Pix(17, 17);
    for (let y = 0; y < 17; y++) for (let x = 0; x < 17; x++) {
      const wx = x + 0.5 - 8.5, wy = y + 0.5 - 8.5;
      const u = wx * ca + wy * sa, v = -wx * sa + wy * ca;
      if (u > -1 && u < 7.2 && Math.abs(v) < 1.25) p.set(x, y, u > 6 ? '#3a1414' : Math.abs(v) < 0.5 ? '#aab4c6' : '#6d788c');
      else if (wx * wx + wy * wy < 2.6 * 2.6) p.set(x, y, wx + wy < 0 ? '#9aa6b8' : '#555e6e');
    }
    guns.push(p.outline());
  }
  addSprite('turret_gun', guns, 8, 8);
}

// ------------------------------------------------------------------ glows

function buildGlows() {
  for (const [key, hex] of Object.entries(GLOW_COLORS)) {
    const [cr, cg, cb] = rgb(hex);
    glows[key] = {};
    for (const r of GLOW_RADII) {
      const size = r * 2 + 1;
      const p = new Pix(size, size);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - r, y - r) / r;
        if (d >= 1) continue;
        const a = (1 - d) * (1 - d);
        const q = Math.floor(a * 5 + bayer(x, y) * 0.9) / 5;
        if (q > 0) p.set(x, y, [cr, cg, cb], Math.round(q * 200));
      }
      glows[key][r] = p.toCanvas();
    }
  }
}

// ------------------------------------------------------------------ backdrop

const STAR_COLS = ['#ffffff', '#d6e4ff', '#ffeccc', '#aebcff', '#ffd6c0'];
const NEBULA_COLS = {
  neutral: ['#140f33', '#241a52'],
  blue: ['#10285e', '#2a58a8'],
  orange: ['#4a1a08', '#a8481a'],
  violet: ['#2a0c48', '#6a2a98'],
  green: ['#062e2e', '#128a78'],
};

function buildBackdrop() {
  const Tt = BACKDROP.tile;
  backdrop.layers = [];
  backdrop.twinklers = [];
  BACKDROP.layers.forEach((L, li) => {
    const r = mulberry32(0x57a4 + li * 71);
    const c = mkCanvas(Tt, Tt);
    const g = c.getContext('2d');
    for (let i = 0; i < L.stars; i++) {
      const x = Math.floor(r() * Tt), y = Math.floor(r() * Tt);
      const b = (0.25 + r() * 0.75) * L.bright;
      g.globalAlpha = b;
      g.fillStyle = STAR_COLS[Math.floor(r() * STAR_COLS.length)];
      g.fillRect(x, y, 1, 1);
      if (li === 2 && b > 0.85) { g.globalAlpha = b * 0.45; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3); }
    }
    if (li === 0) {
      // distant galaxies: dithered smudges
      for (let k = 0; k < 2; k++) {
        const gx = 30 + r() * (Tt - 60), gy = 30 + r() * (Tt - 60), rx = 3 + r() * 3, ry = 1 + r() * 1.5, ang = r() * Math.PI;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        for (let y = -8; y <= 8; y++) for (let x = -8; x <= 8; x++) {
          const u = (x * ca + y * sa) / rx, v = (-x * sa + y * ca) / ry;
          const d = u * u + v * v;
          if (d > 1) continue;
          g.globalAlpha = (1 - d) * 0.3 + (bayer(x + 8, y + 8) > 0.3 ? 0.06 : 0);
          g.fillStyle = d < 0.12 ? '#fff0d8' : k === 1 ? '#b8a8ff' : '#e8c8b0';
          g.fillRect(Math.round(gx + x), Math.round(gy + y), 1, 1);
        }
      }
    }
    g.globalAlpha = 1;
    backdrop.layers.push(c);
    // twinklers: x, y, phase, speed, colour index
    const n = li === 0 ? 0 : BACKDROP.twinklers;
    const tw = new Float32Array(n * 5);
    for (let i = 0; i < n; i++) {
      tw[i * 5] = Math.floor(r() * Tt); tw[i * 5 + 1] = Math.floor(r() * Tt);
      tw[i * 5 + 2] = r() * TAU; tw[i * 5 + 3] = 0.6 + r() * 2.2; tw[i * 5 + 4] = Math.floor(r() * STAR_COLS.length);
    }
    backdrop.twinklers.push(tw);
  });
  backdrop.starCols = STAR_COLS;
  // nebula textures (dithered, seamless)
  const N = BACKDROP.nebulaTile;
  const fb = seamlessFbm(0x4eb1, N, 3, 4);
  const density = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) density[y * N + x] = Math.max(0, Math.min(1, (fb(x, y) - 0.42) * 2.6));
  backdrop.nebula = {};
  for (const [key, [c0, c1]] of Object.entries(NEBULA_COLS)) {
    const p = new Pix(N, N);
    const A = rgb(c0), B = rgb(c1);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dv = density[y * N + x];
      const q = Math.floor(dv * 4 + bayer(x, y) * 0.95);
      if (q <= 0) continue;
      const col = q >= 3 ? B : A;
      p.set(x, y, col, [0, 60, 105, 150, 190][Math.min(4, q)]);
    }
    backdrop.nebula[key] = p.toCanvas();
  }
  // ion storm static (sparse cyan / white noise), black hole vignette
  const st = new Pix(128, 128);
  const rs = mulberry32(0x5a71c);
  for (let i = 0; i < 1400; i++) {
    const x = Math.floor(rs() * 128), y = Math.floor(rs() * 128);
    const len = rs() < 0.2 ? 2 + Math.floor(rs() * 6) : 1;
    for (let k = 0; k < len; k++) st.set(x + k, y, rs() < 0.3 ? '#ffffff' : '#6fe6ff', 120 + Math.floor(rs() * 135));
  }
  backdrop.staticNoise = st.toCanvas();
  const vg = new Pix(64, 36);
  for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) {
    const d = Math.hypot((x + 0.5 - 32) / 32, (y + 0.5 - 18) / 18);
    const a = Math.max(0, Math.min(1, (d - 0.45) / 0.6));
    vg.set(x, y, [4, 0, 12], Math.round(a * a * 255));
  }
  backdrop.vignette = vg.toCanvas();
}

// ------------------------------------------------------------------ suns, black holes, Earth

const SUN_PALS = {
  helios_a: ['#7a2204', '#bd4a0c', '#ea8418', '#ffb832', '#ffe486', '#fffae4'],
  helios_b: ['#5a0e08', '#9a2408', '#d24c10', '#f27c22', '#ffb454', '#ffe6b8'],
};
const SUN_CORONA = { helios_a: '#ffc048', helios_b: '#ff7a2a' };

/** Write an opaque palette colour (pre-parsed [r, g, b]) straight into a Pix buffer. */
function put(p, i, c, alpha = 255) { const d = p.d, k = i * 4; d[k] = c[0]; d[k + 1] = c[1]; d[k + 2] = c[2]; d[k + 3] = alpha; }

function sunFrames(R, pal, seed) {
  const size = Math.ceil(R) * 2 + 2;
  const c = size / 2;
  const P = pal.map(rgb);
  const n1 = periodicNoise(seed, 16), n2 = periodicNoise(seed + 9, 8);
  // frame-independent: limb darkening + dither per pixel (-1 = outside the disk)
  const base = new Float32Array(size * size).fill(-1);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x + 0.5 - c, dy = y + 0.5 - c;
    const d = Math.hypot(dx, dy);
    if (d > R) continue;
    const mu = Math.sqrt(1 - (d / R) * (d / R));
    base[y * size + x] = 0.3 + 0.7 * Math.pow(mu, 0.55);
  }
  const frames = [];
  for (let f = 0; f < FX.sunFrames; f++) {
    const ph = (f / FX.sunFrames) * TAU;
    const ox = Math.cos(ph) * 2.2, oy = Math.sin(ph) * 2.2;
    const p = new Pix(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x, limb = base[i];
      if (limb < 0) continue;
      const dx = x + 0.5 - c, dy = y + 0.5 - c;
      const gran = n1(dx / 5 + ox + 16, dy / 5 + oy + 16) * 0.65 + n2(dx / 2.6 - oy + 8, dy / 2.6 + ox + 8) * 0.35;
      const v = limb * (0.78 + (gran - 0.5) * 0.55) + bayer(x, y) * 0.07 - (limb < 0.42 ? 0.06 : 0);
      put(p, i, P[Math.max(0, Math.min(5, Math.floor(v * 6)))]);
    }
    frames.push(p.toCanvas());
  }
  return frames;
}

function corona(R, hex) {
  const G = Math.round(R * 3.2);
  const half = Math.ceil(G / 2);
  const p = new Pix(half * 2, half * 2);
  const [cr, cg, cb] = rgb(hex);
  for (let y = 0; y < half * 2; y++) for (let x = 0; x < half * 2; x++) {
    const d = Math.hypot(x + 0.5 - half, y + 0.5 - half) * 2;
    if (d > G) continue;
    const t = Math.max(0, (d - R * 0.85) / (G - R * 0.85));
    const a = d < R * 0.85 ? 1 : Math.pow(1 - t, 2.4);
    const q = Math.floor(a * 7 + bayer(x, y) * 0.9) / 7;
    if (q > 0) p.set(x, y, [cr, cg, cb], Math.round(q * 170));
  }
  return p.toCanvas(); // drawn ×2
}

const DISK_PAL = ['#1c0632', '#3e0e5e', '#7a1c7c', '#c03c5e', '#ee7a2c', '#ffc454', '#fff2c8'];

function diskFrames(horizon, diskR, seed) {
  const size = Math.ceil(diskR) * 2 + 4;
  const c = size / 2, n = size * size;
  const F = FX.diskFrames, m = 3;
  const rin = horizon * 1.32;
  const P = DISK_PAL.map(rgb);
  const BLACK = rgb('#000000'), RING_HI = rgb('#fff6dc'), RING_LO = rgb('#ffd08a'), SHADOW = rgb('#0a0210');
  const grain = periodicNoise(seed, 32);
  // frame-independent terms: kind (0 none, 1 horizon, 2 photon ring, 3 shadow gap, 4 disk), angle,
  // spiral phase, band speed k, brightness envelope, doppler term, fade threshold
  const kind = new Uint8Array(n), th0 = new Float32Array(n), spiral = new Float32Array(n);
  const band = new Uint8Array(n), env = new Float32Array(n), fadeT = new Float32Array(n), aux = new Float32Array(n);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    const dx = x + 0.5 - c, dy = y + 0.5 - c;
    const r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
    th0[i] = th;
    if (r < horizon) { kind[i] = 1; continue; }
    if (r < horizon + 1.4) { kind[i] = 2; aux[i] = Math.cos(th - Math.PI) > -0.3 ? 1 : 0; continue; }
    if (r > diskR) continue;
    if (r < rin) { kind[i] = 3; aux[i] = Math.round(230 * (1 - (r - horizon) / (rin - horizon)) + 25); continue; }
    const t = (r - rin) / (diskR - rin);
    kind[i] = 4;
    band[i] = t < 0.3 ? 3 : t < 0.62 ? 2 : 1;
    spiral[i] = 6 * Math.log(r / rin) + grain(th * 5.09 + 16, r * 0.3) * 1.5;
    const gap = Math.abs(t - 0.3) < 0.025 || Math.abs(t - 0.62) < 0.02;
    env[i] = Math.pow(1 - t, 0.9) * (gap ? 0.45 : 1);
    aux[i] = Math.cos(th - Math.PI) * 0.16 * (1 - t) * (gap ? 0.45 : 1);
    fadeT[i] = t > 0.72 ? (t - 0.72) / 0.28 : 0;
  }
  const LUT = 1024, COS = new Float32Array(LUT);
  for (let j = 0; j < LUT; j++) COS[j] = Math.cos((j / LUT) * TAU);
  const toLut = LUT / TAU;
  const frames = [];
  for (let f = 0; f < F; f++) {
    const p = new Pix(size, size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const k = kind[i];
      if (k === 0) continue;
      if (k === 1) { put(p, i, BLACK); continue; }
      if (k === 2) { put(p, i, aux[i] ? RING_HI : RING_LO); continue; }
      if (k === 3) { put(p, i, SHADOW, aux[i]); continue; }
      const ph = (m * (th0[i] + (TAU * band[i] * f) / (F * m)) + spiral[i]) * toLut;
      const arm = 0.5 + 0.5 * COS[((ph | 0) % LUT + LUT) % LUT];
      const fade = fadeT[i];
      const b = bayer(x, y);
      if (fade > 0 && fade > 0.5 + b * 1.1 + (arm - 0.5) * 0.3) continue;
      const v = env[i] * (0.42 + 0.58 * arm) + aux[i];
      put(p, i, P[Math.max(0, Math.min(6, Math.floor(v * 7.4 + b * 0.7)))]);
    }
    frames.push(p.toCanvas());
  }
  return frames;
}

function buildEarth() {
  const R = 60, size = R * 2 + 6, c = size / 2;
  const n = periodicNoise(0xea27, 16), n2 = periodicNoise(0xc10d, 32);
  const p = new Pix(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = x + 0.5 - c, dy = y + 0.5 - c;
    const d = Math.hypot(dx, dy);
    if (d > R + 2.5) continue;
    if (d > R) { p.set(x, y, '#7fd4ff', d > R + 1.3 ? 90 : 170); continue; }
    const mu = Math.sqrt(1 - (d / R) ** 2);
    const u = Math.asin(dx / R) * 5 + 16, v = Math.asin(dy / R) * 5 + 16;
    const land = n(u, v) * 0.7 + n2(u * 2, v * 2) * 0.3;
    const cloud = n2(u * 1.6 + 7, v * 3.2) > 0.63;
    const lit = mu * 0.65 + (-(dx / R) * 0.5 - (dy / R) * 0.3) + bayer(x, y) * 0.12;
    let col;
    if (cloud) col = lit > 0.55 ? '#ffffff' : lit > 0.2 ? '#c8d8e8' : '#4a5a78';
    else if (land > 0.56) col = lit > 0.6 ? '#8ac86a' : lit > 0.3 ? '#4a8a3a' : lit > 0.05 ? '#2a5a2a' : '#0e2418';
    else col = lit > 0.6 ? '#4aa8ff' : lit > 0.3 ? '#2a6ad8' : lit > 0.05 ? '#1a3a8a' : '#0a1234';
    p.set(x, y, col);
  }
  celestial.earth = p.toCanvas();
}

function buildCelestial() {
  celestial.sun = {}; celestial.corona = {}; celestial.disk = {};
  let seed = 0x5a;
  for (const s of SUNS.list) {
    celestial.sun[s.key] = sunFrames(SUNS.coreR, SUN_PALS[s.key] || SUN_PALS.helios_a, seed++);
    celestial.corona[s.key] = corona(SUNS.coreR, SUN_CORONA[s.key] || '#ffc048');
  }
  for (const b of BLACK_HOLES.list) celestial.disk[b.key] = diskFrames(b.horizon, b.diskR, seed++);
  buildEarth();
}

// ------------------------------------------------------------------ entry point

export function loadSprites() {
  if (loaded) return;
  buildTileTextures();
  buildDoors();
  buildAstronaut();
  buildAsteroids();
  buildIcons();
  buildProps();
  buildRotated();
  buildGlows();
  buildBackdrop();
  buildCelestial();
  loaded = true;
}

/** Colour helpers shared with the renderer's baked tile shading. */
export const colorUtil = { shade, mix, rgb };
