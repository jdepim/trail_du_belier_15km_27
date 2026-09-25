// Pixel art defined in code, rasterised once at load.
//
//  - Characters / props / icons: string rows + palettes (one char = one pixel).
//  - The player is assembled per frame from hand-drawn parts (hood, torso, cape)
//    plus code-drawn limbs and pickaxe, then gets an automatic 1px outline.
//  - Tile textures are generated procedurally with pixel-art rules (cells with
//    bevelled cracks, dithered noise, bricks...) from each tile's 4-colour ramp.
//
// API:
//   loadSprites()                         build everything (call once, needs DOM)
//   getSprite(name) -> { canvas, w, h, frames, ax, ay }
//   drawSprite(ctx, name, frame, x, y, flipX)  (x, y) = the sprite's anchor point
//   getTileTexture(id, variant), tileVariantCount(id), getBackTexture(back, variant)
//   getCrack(stage 1..3), getLavaFrame(i, surface), getFlameFrame(i)
//   makeIcon(name, cssPx) -> canvas for DOM buttons
//   backdrop  { skyColumn, stars, moon, mountains, castle, hills }
import { TILES, TILE_ID as T, BACK, BACK_COUNT, TILE_COUNT } from './tiles.js';
import { mulberry32, hash2 } from './rng.js';

const TS = 16;
const sprites = new Map();
const tileTex = [];
const backTex = [];
let cracks = [];
let lavaFrames = [], lavaTopFrames = [], flameFrames = [];
export const backdrop = {};
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
  get(x, y) { const i = (y * this.w + x) * 4; return [this.d[i], this.d[i + 1], this.d[i + 2], this.d[i + 3]]; }
  fill(col) { for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, col); return this; }
  rect(x, y, w, h, col) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, col); }
  /** Draw string rows with a palette; '.' and ' ' are transparent. */
  rows(rows, pal, ox = 0, oy = 0, flip = false) {
    for (let y = 0; y < rows.length; y++) {
      const r = rows[y];
      for (let x = 0; x < r.length; x++) {
        const col = pal[r[x]];
        if (col) this.set(flip ? ox + r.length - 1 - x : ox + x, oy + y, col);
      }
    }
    return this;
  }
  /** Composite another Pix on top (alpha > 0 wins). */
  blit(src, ox = 0, oy = 0) {
    for (let y = 0; y < src.h; y++) for (let x = 0; x < src.w; x++) {
      const i = (y * src.w + x) * 4;
      if (src.d[i + 3] > 0) this.set(ox + x, oy + y, [src.d[i], src.d[i + 1], src.d[i + 2]], src.d[i + 3]);
    }
    return this;
  }
  /** 1px outline around the opaque silhouette. */
  outline(col) {
    const add = [];
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (this.alpha(x, y) > 0) continue;
      if (this.alpha(x - 1, y) > 128 || this.alpha(x + 1, y) > 128 || this.alpha(x, y - 1) > 128 || this.alpha(x, y + 1) > 128) add.push(x, y);
    }
    for (let k = 0; k < add.length; k += 2) this.set(add[k], add[k + 1], col);
    return this;
  }
  /** Bresenham line, optional thickness (extra pixel to the right/below). */
  line(x0, y0, x1, y1, col, thick = 1) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.set(x0, y0, col);
      if (thick > 1) { if (dx > -dy) this.set(x0, y0 + 1, col); else this.set(x0 + 1, y0, col); }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }
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

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
const bayer = (x, y) => BAYER4[(y & 3) * 4 + (x & 3)];

// ------------------------------------------------------------------ sprite registry

function addSprite(name, frames, ax = 0, ay = 0) {
  const w = frames[0].w, h = frames[0].h;
  const strip = mkCanvas(w * frames.length, h);
  const g = strip.getContext('2d');
  frames.forEach((f, i) => g.drawImage(f instanceof Pix ? f.toCanvas() : f, i * w, 0));
  sprites.set(name, { name, canvas: strip, w, h, frames: frames.length, ax, ay, flip: null });
}

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

/** Draw frame `frame` of sprite `name` so that its anchor lands on (x, y). */
export function drawSprite(ctx, name, frame, x, y, flipX = false) {
  const s = sprites.get(name);
  if (!s) return;
  const f = ((frame | 0) % s.frames + s.frames) % s.frames;
  if (flipX) {
    ctx.drawImage(flipped(s), (s.frames - 1 - f) * s.w, 0, s.w, s.h, Math.round(x - (s.w - s.ax)), Math.round(y - s.ay), s.w, s.h);
  } else {
    ctx.drawImage(s.canvas, f * s.w, 0, s.w, s.h, Math.round(x - s.ax), Math.round(y - s.ay), s.w, s.h);
  }
}

/** Canvas with a sprite frame upscaled (integer factor) for DOM usage. */
export function makeIcon(name, cssPx) {
  const s = sprites.get(name);
  if (!s) return null;
  const dpr = typeof window !== 'undefined' ? Math.min(3, window.devicePixelRatio || 1) : 1;
  const k = Math.max(1, Math.floor((cssPx * dpr) / Math.max(s.w, s.h)));
  const c = mkCanvas(s.w * k, s.h * k);
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(s.canvas, 0, 0, s.w, s.h, 0, 0, s.w * k, s.h * k);
  c.style.width = (s.w * k) / dpr + 'px';
  c.style.height = (s.h * k) / dpr + 'px';
  c.style.imageRendering = 'pixelated';
  return c;
}

export function getTileTexture(id, variant) { const v = tileTex[id]; return v ? v[variant % v.length] : null; }
export function tileVariantCount(id) { return tileTex[id] ? tileTex[id].length : 0; }
export function getBackTexture(back, variant) { const v = backTex[back]; return v ? v[variant % v.length] : null; }
export function getCrack(stage) { return cracks[Math.max(0, Math.min(2, stage - 1))]; }
export function getLavaFrame(i, surface) { const a = surface ? lavaTopFrames : lavaFrames; return a[((i % a.length) + a.length) % a.length]; }
export function getFlameFrame(i) { return flameFrames[((i % flameFrames.length) + flameFrames.length) % flameFrames.length]; }

// ------------------------------------------------------------------ tile textures

function texNoise(seed, cols, opts = {}) {
  const p = new Pix(TS, TS);
  const n = periodicNoise(seed, 4);
  const n2 = periodicNoise(seed ^ 77, 8);
  const r = mulberry32(seed);
  const [c0, c1, c2, c3] = cols;
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const v = n(x / 4, y / 4) * 0.55 + n2(x / 2, y / 2) * 0.45 + bayer(x, y) * 0.22;
    p.set(x, y, v < 0.34 ? c1 : v < 0.7 ? c2 : c3);
  }
  for (let k = 0; k < (opts.specks ?? 6); k++) p.set(r() * TS, r() * TS, c0);
  const pebbles = opts.pebbles ?? 0;
  for (let k = 0; k < pebbles; k++) {
    const px = 1 + Math.floor(r() * 13), py = 1 + Math.floor(r() * 13);
    const pc = opts.pebbleCols || ['#2a2a33', '#5a5a66', '#7c7c88'];
    p.set(px, py, pc[2]); p.set(px + 1, py, pc[1]); p.set(px, py + 1, pc[1]); p.set(px + 1, py + 1, pc[1]);
    p.set(px, py + 2, pc[0]); p.set(px + 1, py + 2, pc[0]);
  }
  return p;
}

/** Voronoi cells with dark cracks and a light top / dark bottom bevel per cell. */
function texCells(seed, cols, opts = {}) {
  const p = new Pix(TS, TS);
  const r = mulberry32(seed);
  const nC = opts.cells ?? 5;
  const pts = [];
  for (let i = 0; i < nC; i++) pts.push([r() * TS, r() * TS, r()]);
  const crack = new Uint8Array(TS * TS);
  const cell = new Uint8Array(TS * TS);
  const metric = opts.metric || 'euclid';
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    let d1 = 1e9, d2 = 1e9, id = 0;
    for (let i = 0; i < nC; i++) {
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
        const dx = x + 0.5 - (pts[i][0] + ox * TS), dy = y + 0.5 - (pts[i][1] + oy * TS);
        const d = metric === 'cheb' ? Math.max(Math.abs(dx), Math.abs(dy)) : metric === 'manhattan' ? Math.abs(dx) + Math.abs(dy) : Math.hypot(dx, dy * (opts.squash ?? 1));
        if (d < d1) { d2 = d1; d1 = d; id = i; } else if (d < d2) d2 = d;
      }
    }
    cell[y * TS + x] = id;
    if (d2 - d1 < (opts.crack ?? 1.0)) crack[y * TS + x] = 1;
  }
  const [c0, c1, c2, c3] = cols;
  const at = (x, y) => crack[((y + TS) % TS) * TS + ((x + TS) % TS)];
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    if (crack[y * TS + x]) { p.set(x, y, c0); continue; }
    const tone = pts[cell[y * TS + x]][2];
    let col = tone < 0.3 ? c1 : c2;
    if (at(x, y - 1) || at(x - 1, y)) col = c3;          // lit top-left rim
    else if (at(x, y + 1) || at(x + 1, y)) col = c1;     // shaded bottom-right rim
    else if (bayer(x, y) + (tone - 0.5) * 0.4 > 0.42) col = c3;
    p.set(x, y, col);
  }
  const specks = opts.specks ?? 4;
  for (let k = 0; k < specks; k++) {
    const x = Math.floor(r() * TS), y = Math.floor(r() * TS);
    if (!crack[y * TS + x]) p.set(x, y, opts.speckCols ? opts.speckCols[k % opts.speckCols.length] : c1);
  }
  return p;
}

function texClay(seed, cols) {
  const p = new Pix(TS, TS);
  const r = mulberry32(seed);
  const n = periodicNoise(seed, 4);
  const [c0, c1, c2, c3] = cols;
  const phase = r() * 6;
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const wave = Math.sin((x / TS) * Math.PI * 2 + phase) * 1.2 + n(x / 4, y / 4) * 2;
    const band = Math.floor((y + wave + 16) / 3) % 4;
    let col = [c2, c1, c2, c3][band];
    if (band === 1 && bayer(x, y) > 0.3) col = c2;
    p.set(x, y, col);
  }
  for (let k = 0; k < 5; k++) p.set(r() * TS, r() * TS, c0);
  return p;
}

function texBrick(seed, cols, opts = {}) {
  const p = new Pix(TS, TS);
  const r = mulberry32(seed);
  const [c0, c1, c2, c3] = cols;
  const bh = opts.bh ?? 4, bw = opts.bw ?? 8;
  for (let row = 0; row < TS / bh; row++) {
    const off = row % 2 ? bw / 2 : 0;
    for (let b = -1; b < TS / bw + 1; b++) {
      const x0 = b * bw + off;
      const tone = r();
      const base = tone < 0.2 ? c1 : tone > 0.85 ? mix(c2, c3, 0.5) : c2;
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const px = x0 + x, py = row * bh + y;
        if (px < 0 || px >= TS) continue;
        let col = base;
        if (y === bh - 1 || x === bw - 1) col = c0;          // mortar
        else if (y === 0 || x === 0) col = c3;              // lit edge
        else if (y === bh - 2 || x === bw - 2) col = c1;    // shaded edge
        p.set(px, py, col);
      }
      if (r() < 0.35) { // chipped corner
        const cx = x0 + 1 + Math.floor(r() * (bw - 3)), cy = row * bh + 1 + Math.floor(r() * (bh - 2));
        if (cx >= 0 && cx < TS) p.set(cx, cy, c1);
      }
    }
  }
  return p;
}

function texBasalt(seed, cols) {
  const p = new Pix(TS, TS);
  const r = mulberry32(seed);
  const [c0, c1, c2, c3] = cols;
  const xs = [0, 5 + Math.floor(r() * 2), 10 + Math.floor(r() * 2), 16];
  for (let k = 0; k < 3; k++) {
    const x0 = xs[k], x1 = xs[k + 1];
    const brk = 3 + Math.floor(r() * 10);
    for (let y = 0; y < TS; y++) for (let x = x0; x < x1; x++) {
      let col = c2;
      if (x === x0) col = c0;
      else if (x === x0 + 1) col = c3;
      else if (x === x1 - 1) col = c1;
      if (y === brk) col = c0;
      else if (y === brk + 1 && x !== x0) col = c3;
      else if (col === c2 && bayer(x, y) > 0.38) col = c1;
      p.set(x, y, col);
    }
  }
  return p;
}

function texObsidian(seed, cols) {
  // glassy volcanic rock: angular facets (Chebyshev cells) with bright glints on the facet edges
  const p = texCells(seed, [cols[0], cols[0], cols[1], cols[2]], { cells: 4, crack: 0.7, metric: 'cheb', specks: 0 });
  const r = mulberry32(seed ^ 0x51);
  const [, , c2, c3] = cols;
  // one diagonal glossy streak
  const s = 2 + Math.floor(r() * 9);
  for (let i = 0; i < 5; i++) { p.set(s + i, 11 - i, i === 2 ? '#8a6ab8' : c3); if (i < 4) p.set(s + i + 1, 11 - i, c2); }
  for (let k = 0; k < 2; k++) p.set(r() * TS, r() * TS, '#9a7ad0');
  return p;
}

function texArena(seed, cols, rune) {
  const p = new Pix(TS, TS);
  const [c0, c1, c2, c3] = cols;
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const by = y % 8, bx = (x + (y >= 8 ? 8 : 0)) % 16;
    let col = c2;
    if (by === 7 || bx === 15) col = c0;
    else if (by === 0 || bx === 0) col = c3;
    else if (by === 6 || bx === 14) col = c1;
    else if (by === 1 || bx === 1) col = mix(c2, c3, 0.4);
    else if (bayer(x, y) > 0.4) col = c1;
    p.set(x, y, col);
  }
  if (rune) {
    const R = ['..r..', '.rRr.', 'rRrRr', '..R..', '.r.r.'];
    p.rows(R, { r: '#7a1026', R: '#e0304e' }, 5, 2);
  }
  return p;
}

function texBeam(seed, cols) {
  const p = new Pix(TS, TS);
  const r = mulberry32(seed);
  const [c0, c1, c2, c3] = cols;
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    let col = c2;
    if (y === 0 || y === 15) col = c0;
    else if (y === 1) col = c3;
    else if (y === 14) col = c1;
    else if ((y === 5 || y === 10) && (x + y) % 7 !== 0) col = c1;
    else if (bayer(x, y * 3) > 0.42) col = c1;
    p.set(x, y, col);
  }
  for (const bx of [2, 13]) { p.set(bx, 4, '#2a2a30'); p.set(bx, 11, '#2a2a30'); p.set(bx, 3, '#8a8a99'); p.set(bx, 10, '#8a8a99'); }
  if (r() < 0.5) p.set(8, 7, c0);
  return p;
}

/** Iron portcullis of the Heart (sealed while the Guardian fights). */
function texGate(cols, variant) {
  const p = new Pix(TS, TS);
  const [c0, c1, c2, c3] = cols;
  p.fill('#050308');
  for (let x = 1; x < TS; x += 4) {
    for (let y = 0; y < TS; y++) { p.set(x, y, c3); p.set(x + 1, y, c2); p.set(x + 2, y, c1); }
  }
  for (const y of [5, 12]) {
    for (let x = 0; x < TS; x++) { p.set(x, y, c2); p.set(x, y + 1, c1); p.set(x, y - 1, c0); }
    for (let x = 2; x < TS; x += 4) p.set(x, y, c3);
  }
  if (variant) for (let x = 1; x < TS; x += 4) { p.set(x + 1, 15, c3); p.set(x + 1, 14, c2); } // spike tips
  return p;
}

function texGrass(seed) {
  const dirt = TILES[T.DIRT].colors;
  const p = texNoise(seed, dirt, { specks: 5, pebbles: 1 });
  const g = TILES[T.GRASS].colors;
  const r = mulberry32(seed ^ 99);
  for (let x = 0; x < TS; x++) {
    const depth = 3 + Math.floor(r() * 2.6);
    for (let y = 0; y < depth; y++) {
      const col = y === 0 ? (r() < 0.75 ? g[3] : g[2]) : y < depth - 1 ? (bayer(x, y) > 0.1 ? g[2] : g[1]) : g[1];
      p.set(x, y, col);
    }
    p.set(x, depth, g[0]);
  }
  return p;
}

const NUGGETS = [
  ['................', '.oo.............', 'o32o.......oo...', 'o221o.....o32o..', '.o11o.....o221o.', '..oo.......o1o..', '......ooo...o...',
    '.....o332o......', '....o32221o.....', '....o22111o.....', '.....o111o......', '..oo..ooo....oo.', '.o32o.......o32o', '.o21o.......o21o', '..oo.........oo.', '................'],
  ['................', '.......oo.......', '......o32o......', '..oo..o21o...oo.', '.o32o..oo...o32o', '.o221o......o21o', '..o1o...ooo..oo.',
    '...o...o332o....', '......o32211o...', '......o2211o....', '..oo...o11o.....', '.o32o...oo...oo.', '.o211o......o32o', '..o1o.......o21o', '...o.........oo.', '................'],
];

const CRYSTAL_MAP = [
  '................', '......o.........', '.....o3o........', '.....o34o...o...', '....o334o..o3o..', '.o..o3321o.o34o.', 'o3o.o3321o.o321o',
  'o34oo3221oo3321o', 'o321o3221o33221o', '.o21o3211o32211o', '.o21o3211o3221o.', '..o1o3211o3211o.', '..o11o211o211o..', '...oooooooooo...', '................', '................'];
const LIFE_MAP = [
  '................', '................', '................', '...oo.....oo....', '..o34o...o32o...', '.o3432o.o3221o..', '.o33222o222211o.',
  '.o32222222211o..', '..o2222222211o..', '...o22222211o...', '....o222211o....', '.....o2211o.....', '......o21o......', '.......oo.......', '................', '................'];
const BONES_MAP = [
  ['dddddddddddddddd', 'dd.oooo.dddddddd', 'd.o3332o.ooo.ddd', 'd.o3e3eo.o22o.dd', 'd.o2332oo2332odd', 'dd.o22o.o2222odd', 'd.oooooooo22o.dd', 'o33333222o.oo.dd',
    'o22222111ooooodd', 'doooooo.o3332o.d', 'dd.oo...o3e3eo.d', 'd.o32o..o2332o.d', 'd.o221o..o22o..d', 'dd.o1o.oooooooo.', 'ddd.o.o2222111od', 'dddddooooooooodd'],
  ['dddddddddddddddd', 'd.oo.oooooo.dddd', 'do32o2222211o.dd', 'd.o21oooooooo.dd', 'dd.oo..oooo..ddd', 'dddd..o3332o.ddd', 'ddd..o.3e3eo.ddd', 'dd.oo3o2332o.ddd',
    'd.o3321o22o..ddd', 'd.o2211oooooooo.', 'dd.oooo2222211od', 'ddd.oooooooooodd', 'dd.oooo.dd.oo.dd', 'd.o3332o.do32o.d', 'd.o3e3eo.do21o.d', 'dd.oooo.dd.oo.dd'],
];

function oreOverlay(base, cols, variant) {
  const p = new Pix(TS, TS);
  p.blit(base);
  p.rows(NUGGETS[variant % 2], { o: shade(cols[0], 0.8), 1: cols[1], 2: cols[2], 3: cols[3] });
  return p;
}

function buildTileTextures() {
  const base = (id, n, fn) => { tileTex[id] = []; for (let v = 0; v < n; v++) tileTex[id].push(fn(hash2(id, v, 0xbeef), v)); };
  const C = (k) => TILES[T[k]].colors;
  base(T.BEDROCK, 3, (s) => texCells(s, C('BEDROCK'), { cells: 4, crack: 1.6, specks: 3, speckCols: ['#3a3446'] }));
  base(T.DIRT, 4, (s, v) => texNoise(s, C('DIRT'), { specks: 6, pebbles: v % 2 }));
  base(T.GRASS, 3, (s) => texGrass(s));
  base(T.CLAY, 3, (s) => texClay(s, C('CLAY')));
  base(T.STONE, 4, (s) => texCells(s, C('STONE'), { cells: 5, crack: 1.0, specks: 3 }));
  base(T.BRICK, 3, (s) => texBrick(s, C('BRICK')));
  base(T.BONE, 2, (s, v) => new Pix(TS, TS).rows(BONES_MAP[v], { d: '#1c1612', o: '#140f0b', 1: C('BONE')[1], 2: C('BONE')[2], 3: C('BONE')[3], e: '#050304' }));
  base(T.GRANITE, 3, (s) => texCells(s, C('GRANITE'), { cells: 6, crack: 0.8, specks: 9, speckCols: ['#b8a8ae', '#1a1418', '#a09096'] }));
  base(T.CRYSTAL_ROCK, 3, (s) => texCells(s, C('CRYSTAL_ROCK'), { cells: 4, crack: 0.9, metric: 'manhattan', specks: 4, speckCols: ['#8fd0f0'] }));
  base(T.BASALT, 3, (s) => texBasalt(s, C('BASALT')));
  base(T.OBSIDIAN, 3, (s) => texObsidian(s, C('OBSIDIAN')));
  base(T.ARENA, 3, (s, v) => texArena(s, C('ARENA'), v === 2));
  base(T.BEAM, 2, (s) => texBeam(s, C('BEAM')));
  base(T.GATE, 2, (s, v) => texGate(C('GATE'), v));
  // ores on top of their base rock
  for (const def of TILES) {
    if (!def.ore) continue;
    const baseId = T[def.base.toUpperCase()];
    tileTex[def.id] = [0, 1, 2].map((v) => oreOverlay(tileTex[baseId][v % tileTex[baseId].length], def.colors, v));
  }
  const cr = C('CRYSTAL');
  tileTex[T.CRYSTAL] = [0, 1].map((v) => {
    const p = new Pix(TS, TS).blit(tileTex[T.CRYSTAL_ROCK][v]);
    return p.rows(CRYSTAL_MAP, { o: '#06141e', 1: cr[1], 2: cr[2], 3: cr[3], 4: '#ffffff' }, 0, 0, v === 1);
  });
  const lc = C('LIFE_CRYSTAL');
  tileTex[T.LIFE_CRYSTAL] = [0, 1].map((v) => new Pix(TS, TS).blit(tileTex[T.STONE][v]).rows(LIFE_MAP, { o: '#2a0612', 1: lc[1], 2: lc[2], 3: lc[3], 4: '#ffffff' }));
  buildDecoTextures();
  for (let i = 0; i < TILE_COUNT; i++) {
    if (tileTex[i]) tileTex[i] = tileTex[i].map((p) => (p instanceof Pix ? p.toCanvas() : p));
  }
}

const DECO_MAPS = {
  torch: [['', '', '', '', '', '', '', '......o33o......', '......o21o......', '.......oo.......', '.....ommMmo.....', '......omMo......', '.......mo.......', '......omo.......', '.......o........']],
  bones_deco: [
    ['', '', '', '', '', '', '', '', '', '', '.....oooo.......', '....o3332o......', '....o3e3eo...oo.', '....o2332o..o32o', '.ooo.o22o..o3221', 'o33332oooooo2222'],
    ['', '', '', '', '', '', '', '', '', '', '', '..oo........oo..', '.o32ooooooooo32o', '.o2222222221o21o', '..oooooooooo.oo.', '...oo.....oooo..'],
  ],
  cobweb: [['w...w.....w.....', '.w..w....w......', '..wwwww.w.......', '.w.w..ww....w...', 'w..w.w.ww..w....', '...ww...w.w.....', '..w.w....w......', '.w...w..w.w.....', 'w.....ww...w....', '.....w.w........', '....w...w.......', '...w............', '..w.............', '................', '................', '................']],
  stalactite: [
    ['o1233221o.oo12oo', '.o12321o..o121o.', '.o1221o...o21o..', '..o221o....o1o..', '..o21o.....oo...', '...o1o..........', '...o1o..........', '....o...........'],
    ['.oo1222332oo.o1o', '..o1223221o..oo.', '...o12321o......', '...o1221o.......', '....o21o........', '....o21o........', '.....o1o........', '.....oo.........', '......o.........'],
  ],
  stalagmite: [['', '', '', '', '', '', '', '', '.........o......', '........o3o.....', '........o31o....', '...o...o321o....', '..o3o..o321o....', '..o32o.o3221o...', '.o3221o32221o...', 'o32222132222211o']],
  roots: [
    ['.o1o..o21o...o1o', '.o1...o1o...o1o.', '..o1..o1....o1..', '..o1...o1...o1..', '...o1..o1....o..', '...o1...o.......', '....o...........'],
    ['o21o...o1o..o21o', '.o1o...o1...o1o.', '.o1...o1o....o1.', '..o1..o1.....o1.', '..o1...o......o.', '...o............', '................'],
  ],
  mushroom: [['', '', '', '', '', '', '', '', '........oo......', '.......o33o.....', '..oo..o3223o....', '.o33o.oo22oo....', 'o3223o..44......', 'oo22oo..44......', '...4....44......', '...4....44......']],
  post: [Array.from({ length: 16 }, (_, y) => (y % 5 === 4 ? '.....o1111o.....' : '.....o2321o.....'))],
};

function buildDecoTextures() {
  for (const key of Object.keys(DECO_MAPS)) {
    const def = TILES[T[key.toUpperCase()]];
    const c = def.colors;
    const pal = { o: shade(c[0], 0.7), 1: c[1], 2: c[2], 3: c[3], 4: '#d8f0e8', e: '#050304', w: '#8a90a0', m: '#3a3a44', M: '#7a7a88' };
    if (key === 'cobweb') pal.w = '#9aa2b4';
    tileTex[def.id] = DECO_MAPS[key].map((rows) => new Pix(TS, TS).rows(rows, pal));
  }
}

// back walls: flat, dark, low-contrast "cave wall" textures so open space reads as
// clearly recessed behind the (bright, outlined) solid blocks
function texBackWall(seed, cols) {
  const [base, dark, crack, speck] = cols;
  const p = new Pix(TS, TS);
  const r = mulberry32(seed);
  const n = periodicNoise(seed, 4);
  for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
    const v = n(x / 4, y / 4) + bayer(x, y) * 0.35;
    p.set(x, y, v < 0.5 ? dark : base);
  }
  // a couple of faint strata / cracks
  for (let k = 0; k < 2; k++) {
    let x = Math.floor(r() * TS), y = Math.floor(r() * TS);
    const len = 4 + Math.floor(r() * 6);
    for (let i = 0; i < len; i++) {
      p.set(x, y, crack);
      x = (x + 1) % TS;
      if (r() < 0.35) y = (y + (r() < 0.5 ? 1 : TS - 1)) % TS;
    }
  }
  for (let k = 0; k < 3; k++) p.set(r() * TS, r() * TS, speck);
  return p;
}

function buildBackTextures() {
  const W = {
    [BACK.SOIL]: ['#2b1e16', '#21170f', '#150e0a', '#3a2a1e'],
    [BACK.STONE]: ['#22232d', '#1a1a23', '#101017', '#2f303c'],
    [BACK.GRANITE]: ['#2a2129', '#20191f', '#140f14', '#3a2f36'],
    [BACK.CRYSTAL]: ['#14283a', '#0f1e2d', '#09131e', '#26465e'],
    [BACK.BASALT]: ['#261b1a', '#1c1413', '#120c0b', '#38261f'],
  };
  for (let b = 1; b < BACK_COUNT; b++) {
    backTex[b] = [0, 1, 2].map((v) => {
      const seed = hash2(b, v, 0xbac4);
      if (b === BACK.BRICK) return texBrick(seed, ['#110b10', '#1e161c', '#271e25', '#342932']).toCanvas();
      if (b === BACK.ARENA) return texArena(seed, ['#0c060e', '#1a0f1f', '#231629', '#2f1f36'], false).toCanvas();
      return texBackWall(seed, W[b]).toCanvas();
    });
  }
}

function buildCracks() {
  const maps = [
    ['', '', '', '', '', '.......x........', '......xx........', '.......x........', '.......xx.......', '........x.......'],
    ['', '', '...x............', '....x...........', '....xx....x.....', '.....x...x......', '......xxxx......', '.......x........', '......xx.x......', '.....x....xx....', '....x.......x...', '................'],
    ['x.......x.......', '.x.....x......x.', '..x...xx.....x..', '..xx..x.....x...', '....xxx....xx...', '.....x.xxxx.....', '....xx...x......', '...x.....xx...x.', '..x.......x..x..', '.x....x....xx...', 'x.....xx...x....', '.......x..x.....', '........xx......', '.......x..x.....', '......x....x....', '.....x......x...'],
  ];
  cracks = maps.map((m) => {
    const p = new Pix(TS, TS);
    for (let y = 0; y < m.length; y++) for (let x = 0; x < m[y].length; x++) {
      if (m[y][x] !== 'x') continue;
      p.set(x, y, [8, 5, 10], 230);
      if (p.alpha(x + 1, y + 1) === 0) p.set(x + 1, y + 1, [255, 255, 255], 50);
    }
    return p.toCanvas();
  });
}

function buildLava() {
  const cols = TILES[T.LAVA].colors;
  const n = periodicNoise(4242, 4);
  const n2 = periodicNoise(777, 8);
  for (let f = 0; f < 8; f++) {
    const mk = (surface) => {
      const p = new Pix(TS, TS);
      for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) {
        const t = f / 8;
        const v = n(x / 4 + t * 4, y / 4 + Math.sin(t * Math.PI * 2) * 0.5) * 0.6 + n2(x / 2 - t * 8, y / 2) * 0.4 + bayer(x, y) * 0.15;
        let col = v < 0.3 ? cols[0] : v < 0.52 ? cols[1] : v < 0.78 ? cols[2] : cols[3];
        if (surface) {
          const h = 2 + Math.round(Math.sin((x + f * 2) * 0.785) * 1.2);
          if (y < h - 1) continue;
          if (y === h - 1) col = cols[3];
          else if (y === h) col = mix(cols[3], cols[2], 0.4);
        }
        p.set(x, y, col);
      }
      return p.toCanvas();
    };
    lavaFrames.push(mk(false));
    lavaTopFrames.push(mk(true));
  }
  const FL = [
    ['...o...', '..oyo..', '..oyo..', '.oyYyo.', '.oyYYo.', 'oyYWYyo', '.oyYyo.', '..ooo..'],
    ['..o....', '..oyo..', '.oyyo..', '.oyYyo.', 'oyYYYo.', 'oyYWYyo', '.oyYyo.', '..ooo..'],
    ['....o..', '...oyo.', '..oyyo.', '.oyYyo.', '.oYYYyo', 'oyYWYyo', '.oyYyo.', '..ooo..'],
    ['...o...', '..oyo..', '.oyYo..', '.oyYyo.', '.oyYYyo', 'oyYWWyo', '.oyYyo.', '..ooo..'],
  ];
  flameFrames = FL.map((rows) => new Pix(7, 8).rows(rows, { o: '#c2410c', y: '#fb923c', Y: '#fde047', W: '#fffbe0' }).toCanvas());
}

// ------------------------------------------------------------------ the player

const PPAL = {
  H: '#2b2342', h: '#40345f', j: '#5d4b88', f: '#120c1a', e: '#ffd76a', E: '#fff6c8',
  C: '#221a36', c: '#342850', R: '#a3283a', r: '#631726',
  L: '#6e4629', l: '#4b301f', b: '#23160f', g: '#e0ac48', y: '#ffd35c', Y: '#fff4c0', k: '#8a6a2a',
  p: '#2a2640', P: '#3e3858', B: '#2e1d13', n: '#4d3322', s: '#e2b690', S: '#a87b5a',
  w: '#6a4222', W: '#9a6a3e', m: '#4e5769', M: '#9aa4b8', X: '#e8eef8',
};
const OUTLINE = '#0c0812';

// hood: 8 wide, drawn at (12, 9) + offsets
const HEAD = {
  normal: ['..HHhh..', '.Hhhhhjj', 'Hhhhhjjj', 'Hhhhffff', 'Hhhhfefe', 'Hhhhffff', '.HhhhHf.'],
  up: ['..HHhh..', '.Hhhhhjj', 'Hhhhfefe', 'Hhhhffff', 'Hhhhffff', 'Hhhhjjjj', '.HhhhHh.'],
  hurt: ['..HHhh..', '.Hhhhhjj', 'Hhhhhjjj', 'Hhhhffff', 'HhhhfEfE', 'Hhhhffff', '.HhhhHf.'],
};
// torso: 8 wide at (11, 16)
const TORSO = [
  'HhhhhhjH',
  'HhhhhhjH',
  'clLLLLLl',
  'clLLLLLl',
  'cbbbbbgb',
  'clLLLLLl',
  '.lLLLLLl',
  '.lllLLll',
];
// lantern hanging at the back of the belt (drawn over the cape)
const LANTERN = ['.k.', 'kyk', 'yYy', 'kyk'];
// cape variants: drawn so their right edge meets the back at x=13
const CAPE = {
  idle0: ['..Cc', '.CcR', '.CcR', 'CccR', 'CccR', 'CccR', 'CcRr', 'CcRr', 'CcRr', 'CcR.', 'CcR.', 'C.C.'],
  idle1: ['..Cc', '.CcR', '.CcR', 'CccR', 'CccR', 'CccR', 'CcRr', 'CcRr', 'CcRr', 'CcRr', '.CcR', '.C.C'],
  run0: ['....Cc', '..CccR', '.CccRr', 'CccRr.', 'CcRr..', 'CRr...', 'Rr....', 'r.....'],
  run1: ['....Cc', '...CcR', '..CcRr', '.CccRr', 'CccRr.', 'CcRr..', 'CRr...', 'R.....', 'r.....'],
  jump: ['..Cc', '.CcR', '.CcR', '.CcR', '.CcR', 'CccR', 'CcRr', 'CcRr', 'CcR.', 'CcR.', 'C.R.', 'C...'],
  fall: ['C.....', 'Cc..C.', 'CcRCc.', '.CcRcc', '..CcRc', '...CcR', '....Cc'],
};

function drawLeg(p, hipX, hipY, a1, a2, colLeg, colBoot, colBootHi) {
  const d = Math.PI / 180;
  const kx = hipX + Math.sin(a1 * d) * 4, ky = hipY + Math.cos(a1 * d) * 4;
  let ax = kx + Math.sin((a1 - a2) * d) * 3.6, ay = ky + Math.cos((a1 - a2) * d) * 3.6;
  if (ay > 29.5) ay = 29.5;
  p.line(hipX, hipY, kx, ky, colLeg, 2);
  p.line(kx, ky, ax, ay, colLeg, 2);
  const bx = Math.round(ax), by = Math.round(ay);
  p.rect(bx - 1, by, 3, 2, colBoot);
  p.set(bx + 2, by + 1, colBoot);
  p.set(bx, by, colBootHi);
}

function drawArm(p, sx, sy, hx, hy) {
  p.line(sx, sy, hx, hy, PPAL.h, 2);
  p.line(sx, sy, (sx + hx) / 2, (sy + hy) / 2, PPAL.j, 1);
  p.rect(Math.round(hx), Math.round(hy), 2, 2, PPAL.s);
  p.set(Math.round(hx), Math.round(hy) + 1, PPAL.S);
}

/** Pickaxe from grip (gx, gy) pointing at `ang` degrees (0 = right, 90 = down). */
function drawPick(layer, gx, gy, ang) {
  const d = Math.PI / 180, ca = Math.cos(ang * d), sa = Math.sin(ang * d);
  const L = 8;
  const ex = gx + ca * L, ey = gy + sa * L;
  layer.line(gx - ca * 2, gy - sa * 2, ex, ey, PPAL.w, 1);
  layer.line(gx - ca * 1, gy - sa * 1, gx + ca * 4, gy + sa * 4, PPAL.W, 1);
  // head: crescent perpendicular to the handle, tips curving back toward the grip
  const px = -sa, py = ca;
  let lx = null, ly = null;
  for (let t = -4.5; t <= 4.51; t += 0.25) {
    const back = (t * t) / 9;
    const hx = Math.round(ex + px * t - ca * back), hy = Math.round(ey + py * t - sa * back);
    if (hx === lx && hy === ly) continue;
    lx = hx; ly = hy;
    layer.set(hx, hy, Math.abs(t) >= 3.5 ? PPAL.X : PPAL.M);
    if (Math.abs(t) <= 1.5) layer.set(Math.round(hx + ca), Math.round(hy + sa), PPAL.m);
  }
  layer.set(Math.round(ex), Math.round(ey), PPAL.X);
}

// frame recipes: legs [a1, a2] back/front, bob, cape, head, hand, pick angle
const RUN_LEGS = [
  [[-30, 10], [32, 18]], [[-12, 40], [18, 4]], [[8, 70], [-2, 2]],
  [[30, 18], [-30, 10]], [[18, 4], [-12, 40]], [[-2, 2], [8, 70]],
];

function playerFrame(o) {
  const body = new Pix(32, 32);
  const bob = o.bob || 0;
  const dx = o.dx || 0;
  // cape (behind everything)
  const cape = CAPE[o.cape || 'idle0'];
  const cw = cape[0].length;
  body.rows(cape, PPAL, 13 - cw + dx + (o.capeDx || 0), 16 + bob);
  // back arm (short, mostly hidden)
  if (!o.noBackArm) { body.line(13 + dx, 18 + bob, 12 + dx, 21 + bob, PPAL.H, 2); }
  // legs
  const [lb, lf] = o.legs;
  const hipY = 23 + bob + (o.crouch || 0);
  drawLeg(body, 13.5 + dx, hipY, lb[0], lb[1], PPAL.p, PPAL.B, PPAL.n);
  drawLeg(body, 16.5 + dx, hipY, lf[0], lf[1], PPAL.P, PPAL.B, PPAL.n);
  // torso + head
  const ty = 16 + bob + (o.crouch || 0);
  body.rows(TORSO, PPAL, 11 + dx, ty);
  if (!o.noLantern) body.rows(LANTERN, PPAL, 9 + dx + (o.lanternDx || 0), ty + 5 + (o.lanternDy || 0));
  body.rows(HEAD[o.head || 'normal'], PPAL, 12 + dx + (o.headDx || 0), 9 + bob + (o.crouch || 0) + (o.headDy || 0));
  // front arm + tool
  const sx = 17 + dx, sy = 18 + bob + (o.crouch || 0);
  const [hx, hy] = o.hand;
  const tool = new Pix(32, 32);
  if (o.pick !== undefined && o.pick !== null) drawPick(tool, hx + 1, hy + 1, o.pick);
  if (o.launcher) { tool.rect(hx + 1, hy - 1, 3, 2, PPAL.m); tool.set(hx + 3, hy - 1, PPAL.X); }
  if (o.pickBehind) { body.blit(tool); drawArm(body, sx, sy, hx, hy); }
  else { drawArm(body, sx, sy, hx, hy); body.blit(tool); }
  body.outline(OUTLINE);
  return body;
}

function buildPlayer() {
  const idle = [0, 1, 2, 3].map((i) => playerFrame({
    legs: [[-4, 0], [6, 0]], bob: i === 2 ? 1 : 0, cape: i < 2 ? 'idle0' : 'idle1', hand: [19, 21 + (i === 2 ? 1 : 0)], pick: 72,
  }));
  const run = RUN_LEGS.map((legs, i) => playerFrame({
    legs, bob: i % 3 === 1 ? 1 : 0, cape: i % 2 ? 'run1' : 'run0', hand: [19 + (i < 3 ? 1 : 0), 20], pick: 40 + (i % 3) * 8, dx: 0,
  }));
  const jump = [
    playerFrame({ legs: [[-8, 40], [30, 70]], cape: 'jump', hand: [19, 19], pick: 30 }),
    playerFrame({ legs: [[-4, 20], [20, 40]], cape: 'jump', hand: [20, 18], pick: 15 }),
  ];
  const fall = [
    playerFrame({ legs: [[-18, 28], [14, 8]], cape: 'fall', capeDx: 1, hand: [20, 16], pick: 5 }),
    playerFrame({ legs: [[-14, 22], [18, 12]], cape: 'fall', capeDx: 1, hand: [20, 17], pick: 10 }),
  ];
  const stand = [[-4, 0], [6, 0]];
  const lunge = [[-16, 4], [18, 6]];
  const strikeSide = [
    playerFrame({ legs: stand, cape: 'idle1', hand: [15, 12], pick: -150, pickBehind: true, headDx: -1 }),
    playerFrame({ legs: lunge, cape: 'run0', hand: [22, 18], pick: -8, dx: 1 }),
    playerFrame({ legs: lunge, cape: 'run1', hand: [21, 21], pick: 50, dx: 1 }),
  ];
  const strikeUp = [
    playerFrame({ legs: stand, cape: 'idle0', hand: [19, 21], pick: 20, head: 'up' }),
    playerFrame({ legs: stand, cape: 'idle1', hand: [17, 10], pick: -92, head: 'up' }),
    playerFrame({ legs: stand, cape: 'idle0', hand: [19, 12], pick: -55, head: 'up' }),
  ];
  const crouch = [[-10, 50], [30, 60]];
  const strikeDown = [
    playerFrame({ legs: stand, cape: 'idle1', hand: [16, 11], pick: -115, pickBehind: true }),
    playerFrame({ legs: crouch, crouch: 2, cape: 'idle0', hand: [20, 22], pick: 78 }),
    playerFrame({ legs: crouch, crouch: 2, cape: 'idle0', hand: [20, 23], pick: 85 }),
  ];
  const grapple = [
    playerFrame({ legs: [[-10, 20], [14, 30]], cape: 'jump', hand: [20, 13], launcher: true, pick: null }),
    playerFrame({ legs: [[-24, 30], [24, 50]], cape: 'fall', hand: [20, 13], launcher: true, pick: null }),
  ];
  const hurt = [playerFrame({ legs: [[-20, 30], [10, 20]], cape: 'fall', head: 'hurt', headDx: -1, hand: [13, 14], pick: -160, pickBehind: true, dx: -1 })];
  const dead = [(() => {
    const p = new Pix(32, 32);
    p.rows(['..CcccRr....................', '.CccccRRrlLLLLlb....ppPPBB..', 'HhhhCcccRlLLLLLbgppppPPPnn..', 'Hhhfeffj.cRRrrlllLLppp..BB..'], PPAL, 3, 27);
    return p.outline(OUTLINE);
  })()];
  const A = 16, AY = 32; // anchor: centre-bottom (feet)
  addSprite('player_idle', idle, A, AY);
  addSprite('player_run', run, A, AY);
  addSprite('player_jump', jump, A, AY);
  addSprite('player_fall', fall, A, AY);
  addSprite('player_strike_side', strikeSide, A, AY);
  addSprite('player_strike_up', strikeUp, A, AY);
  addSprite('player_strike_down', strikeDown, A, AY);
  addSprite('player_grapple', grapple, A, AY);
  addSprite('player_hurt', hurt, A, AY);
  addSprite('player_dead', dead, A, AY);

  // swing smears (drawn over the player on the impact frame)
  const smear = (w, h, pts) => {
    const p = new Pix(w, h);
    pts.forEach(([x, y, a]) => p.set(x, y, '#fff8e8', a));
    return p;
  };
  const arc = (cx, cy, r0, r1, a0, a1, w, h) => {
    const pts = [];
    for (let a = a0; a <= a1; a += 0.04) {
      for (let rr = r0; rr <= r1; rr += 0.7) {
        const t = (a - a0) / (a1 - a0);
        pts.push([Math.round(cx + Math.cos(a) * rr), Math.round(cy + Math.sin(a) * rr), Math.round(60 + 170 * t * (rr - r0 + 1) / (r1 - r0 + 1))]);
      }
    }
    return smear(w, h, pts);
  };
  addSprite('slash_side', [arc(0, 12, 10, 13, -1.3, 1.1, 16, 26)], 0, 13);
  addSprite('slash_up', [arc(12, 16, 11, 14, -2.8, -0.3, 26, 18)], 13, 18);
  addSprite('slash_down', [arc(12, 0, 10, 13, 0.3, 2.8, 26, 16)], 13, 0);
}

// ------------------------------------------------------------------ props, enemies, pickups, icons

function S(name, rowsList, pal, ax = 0, ay = 0, outline = null) {
  const h = Math.max(...rowsList.map((r) => r.length));
  const w = Math.max(...rowsList.flat().map((r) => r.length));
  const frames = rowsList.map((rows) => {
    const p = new Pix(w + (outline ? 2 : 0), h + (outline ? 2 : 0)).rows(rows, pal, outline ? 1 : 0, outline ? 1 : 0);
    if (outline) p.outline(outline);
    return p;
  });
  addSprite(name, frames, ax + (outline ? 1 : 0), ay + (outline ? 1 : 0));
}

function buildProps() {
  const O = '#0c0812';
  // --- the Forge: stone smithy with a glowing furnace and a chimney (64 x 56)
  const forge = new Pix(80, 60);
  const st = ['#1c1a24', '#34323f', '#4a4757', '#625e70'];
  // stone walls
  for (let y = 22; y < 60; y++) for (let x = 6; x < 70; x++) {
    const by = (y - 22) % 6, bx = (x + (Math.floor((y - 22) / 6) % 2 ? 5 : 0)) % 10;
    let c = st[2];
    if (by === 5 || bx === 9) c = st[0]; else if (by === 0 || bx === 0) c = st[3]; else if (by === 4) c = st[1];
    forge.set(x, y, c);
  }
  // roof (dark slate, steep gothic gable)
  for (let y = 4; y < 24; y++) {
    const half = Math.round((y - 4) * 2.0) + 4;
    for (let x = 38 - half; x <= 38 + half; x++) {
      if (x < 2 || x > 76) continue;
      const edge = x === 38 - half || x === 38 + half;
      forge.set(x, y, edge ? O : ((x + y) % 4 === 0 ? '#2a2236' : (y % 3 === 0 ? '#1a1524' : '#322940')));
    }
  }
  for (let x = 0; x < 78; x++) forge.set(x, 23, '#1a1524');
  // chimney
  forge.rect(56, 0, 8, 18, st[1]); forge.rect(56, 0, 8, 2, st[3]); forge.rect(57, 2, 1, 16, st[3]); forge.rect(63, 2, 1, 16, st[0]);
  // furnace opening (glowing)
  forge.rect(12, 38, 20, 22, '#0a0608');
  for (let y = 40; y < 60; y++) for (let x = 14; x < 30; x++) {
    const t = (y - 40) / 20;
    forge.set(x, y, t > 0.7 ? '#ffd35c' : t > 0.45 ? '#ff8a1f' : t > 0.25 ? '#c2410c' : '#5a1405');
  }
  forge.rows(['..oooooooooooooooo..', '.o................o.', 'o..................o'], { o: st[3] }, 12, 36);
  // door
  forge.rect(44, 36, 14, 24, '#2a170c');
  for (let y = 36; y < 60; y++) { forge.set(44, y, O); forge.set(57, y, O); forge.set(50, y, '#1a0e06'); forge.set(51, y, '#3e2412'); }
  forge.rect(44, 35, 14, 1, O);
  forge.set(54, 48, '#e0ac48');
  // window with warm light
  forge.rect(34, 28, 6, 8, O); forge.rect(35, 29, 4, 6, '#ffcf6b'); forge.rect(36, 29, 1, 6, O); forge.rect(35, 31, 4, 1, O);
  // hanging sign: anvil
  forge.rect(62, 30, 12, 1, '#2a170c');
  forge.rows(['.oooooooo.', 'oMMMMMMMMo', '.ommmmmo..', '..ommmo...', '.oommmoo..'], { o: O, M: '#9aa4b8', m: '#545d70' }, 63, 33);
  forge.outline(O);
  addSprite('forge', [forge], 40, 60);

  // --- blacksmith NPC (burly, apron, hammer), 2 idle frames
  const smith = [
    ['.....ooo......', '....ossso.....', '...osesesо....', '...ossssso....', '...oSbbbSo....', '..oLLssssLLo..', '.oLLlaaaalLLo.', '.osLlaaaalLso.', '.os.laaaal.so.', '.oo.laaaal.oo.', '....laaaal....', '....pp..pp....', '....pp..pp....', '...BBB..BBB...'],
    ['.....ooo......', '....ossso.....', '...osesesо....', '...ossssso....', '...oSbbbSo....', '..oLLssssLLo..', '.oLLlaaaalLLo.', '.osLlaaaalLso.', '.os.laaaal.so.', '.oo.laaaal.Mo.', '....laaaal.M..', '....pp..pp....', '....pp..pp....', '...BBB..BBB...'],
  ].map((f) => f.map((r) => r.replace(/о/g, 'o')));
  S('smith', smith, { o: '#1a0f0a', s: '#d49a6a', S: '#8a5a3a', e: '#1a0f0a', b: '#5a3a22', L: '#5b2a1e', l: '#3a1a12', a: '#6b4a2e', p: '#2a2433', B: '#1e140e', M: '#9aa4b8' }, 7, 14, O);

  // --- camp props
  S('lamp', [['..ooo..', '.oyYyo.', '.oYWYo.', '.oyYyo.', '..omo..', '...m...', '...m...', '...m...', '...m...', '...m...', '...m...', '...m...', '...m...', '...m...', '...m...', '...m...', '...m...', '..mmm..', '.mmmmm.']],
    { o: '#2a2a30', y: '#ffb84d', Y: '#ffe08a', W: '#fffbe0', m: '#34323c' }, 3, 19, O);
  S('grave', [['..oooo..', '.o2332o.', 'o233332o', 'o2o33o2o', 'o233332o', 'o2o332o.', 'o233332o', 'o222222o', 'o111111o'], ['...o....', '..o3o...', '.oo3oo..', 'o33333o.', '.oo3oo..', '..o3o...', '..o2o...', '..o2o...', '.o111o..']],
    { o: '#14121a', 1: '#2a2833', 2: '#44424f', 3: '#5c5a68' }, 4, 9, O);
  const tree = new Pix(34, 44);
  const bark = '#1a1418';
  tree.line(17, 43, 17, 16, bark, 2); tree.line(18, 43, 19, 30, bark, 2);
  tree.line(17, 24, 8, 14, bark, 2); tree.line(8, 14, 4, 6, bark, 1); tree.line(8, 14, 12, 7, bark, 1);
  tree.line(18, 20, 27, 10, bark, 2); tree.line(27, 10, 31, 4, bark, 1); tree.line(27, 10, 24, 3, bark, 1);
  tree.line(17, 16, 15, 4, bark, 1); tree.line(15, 4, 17, 0, bark, 1); tree.line(18, 30, 25, 26, bark, 1);
  tree.line(12, 43, 22, 43, bark, 1);
  addSprite('tree', [tree], 17, 44);
  S('sign', [['.oooooooooo.', 'o2222222222o', 'o2o3o3o3o22o', 'o2222222222o', '.oooooooooo.', '.....ww.....', '.....ww.....', '.....ww.....', '.....ww.....']],
    { o: '#1a0e06', 2: '#6e4424', 3: '#c9b48a', w: '#4f3019' }, 6, 9, O);

  // --- chest (closed / open)
  const chestPal = { o: '#140a04', w: '#6e4424', W: '#8f5c32', d: '#3a2010', g: '#e0ac48', G: '#fff0a0', k: '#1a1a20' };
  S('chest', [['.oooooooooooo.', 'oWWWWWWWWWWWWo', 'owwwwwgGwwwwwo', 'oddddgkkgddddo', 'owwwwwggwwwwwo', 'owwwwwwwwwwwwo', 'oddddddddddddo', 'owwwwwwwwwwwwo', 'oggooooooooggo', '.oooooooooooo.']], chestPal, 7, 10, null);
  S('chest_open', [['.oooooooooooo.', 'oWWWWWWWWWWWWo', 'oddddddddddddo', '.oooooooooooo.', 'oGGGGGGGGGGGGo', 'owwwwwggwwwwwo', 'oddddddddddddo', 'owwwwwwwwwwwwo', 'oggooooooooggo', '.oooooooooooo.']], chestPal, 7, 10, null);

  // --- pickups
  const nug = ['.oo..', 'o32o.', 'o221o', '.o1o.', '..o..'];
  for (const def of TILES) {
    if (!def.ore) continue;
    S('ore_' + def.key, [nug], { o: shade(def.colors[0], 0.7), 1: def.colors[1], 2: def.colors[2], 3: def.colors[3] }, 2, 4, OUTLINE);
  }
  S('coin', [['.ooo.', 'oYyyo', 'oyYko', 'oykko', '.ooo.'], ['.oo.', 'oYyo', 'oyko', 'oyko', '.oo.'], ['.o.', 'oyo', 'oyo', 'oko', '.o.'], ['.oo.', 'oyYo', 'okyo', 'okyo', '.oo.']],
    { o: '#5a3a05', y: '#eab308', Y: '#fff3a3', k: '#b8860b' }, 2, 4, null);
  S('heart', [['.oo.oo.', 'oRRoRWo', 'oRRRRRo', '.oRRRo.', '..oRo..', '...o...'], ['.oo.oo.', 'oPPoPWo', 'oPRRRPo', '.oPRPo.', '..oPo..', '...o...']], { o: '#3a0612', R: '#e0304e', P: '#ff7a95', W: '#ffffff' }, 3, 5, null);
  // --- relics (run bonuses): 8 × 8 + outline, anchored centre-bottom (HUD row, toasts, chests)
  const RP = {
    w: '#f4f0e6', W: '#ffffff', G: '#b0b0bc', g: '#6a6a78', k: '#2e2c38', c: '#6ee7f5', C: '#2aa3b8',
    r: '#e0304e', R: '#ff8a9a', d: '#7a1428', y: '#fde047', Y: '#fff7c0', f: '#fb923c', F: '#c2410c',
    2: '#e0ac48', 1: '#8a6a2a', 3: '#fff0a0', n: '#6e4424', s: '#3aa442', S: '#a6f28e', D: '#1b5a26', p: '#b070f0',
  };
  const relic = (name, rows) => S(name, [rows], RP, 4, 8, OUTLINE);
  relic('relic_wing', ['...cc...', '..cWWc..', '.cW..Wc.', 'cW....Wc', '...cc...', '..cWWc..', '.cW..Wc.', 'cW....Wc']);
  relic('relic_magnet', ['GW....WG', 'Gg....gG', 'rR....Rr', 'rR....Rr', 'rR....Rr', 'rRr..rRr', '.rRrrRr.', '..dddd..']);
  relic('relic_fang', ['wwwwwwww', 'Gwwwwwwg', '.wW..Ww.', '.ww..ww.', '..w..w..', '..r..r..', '.....R..', '..r.....']);
  relic('relic_flame', ['.y...f..', '.fy.fyf.', 'fyYffyf.', 'GGGGGGGG', 'Gg.nn.gG', 'g..nn..g', '...nn...', '...nn...']);
  relic('relic_stone', ['.GGGGGG.', 'GwGGGgGG', 'GGGGgGGG', 'GGGgGGGG', 'gGGGGgGg', '.gGGGGg.', '..gGGg..', '...gg...']);
  relic('relic_feather', ['......ww', '....wwWG', '...wwWG.', '..wwWG..', '.wwWG...', '.wWG....', '.G......', 'G.......']);
  relic('relic_bolt', ['....yyy.', '...yYy..', '..yYy...', '.yYYYYy.', '...yYy..', '..yYy...', '..yy....', '.y......']);
  relic('relic_lantern', ['...kk...', '..k..k..', '.kkkkkk.', '.kcWWck.', '.kcWWck.', '.kCccCk.', '.kkkkkk.', '...kk...']);
  relic('relic_frenzy', ['R..R..R.', 'r..r..r.', '.r..r..r', '.r..r..r', '..d..d..', '..d..d..', '........', '........']);
  relic('relic_greed', ['..2222..', '.233332.', '.122221.', '..2222..', '.233332.', '.122221.', '.233332.', '.111111.']);
  relic('relic_heart', ['.ss..ss.', 'sSSssSSs', 'sSSSSSSs', 'sSSSSSDs', '.sSSSDs.', '..sSDs..', '...ss...', '........']);

  // --- Forge upgrade icons: 12 × 12 + outline (DOM, upscaled by makeIcon)
  const UP = {
    M: '#e8eef8', m: '#9aa4b8', K: '#545d70', b: '#6a4222', B: '#9a6a3e', r: '#e0304e', R: '#ff8a9a', d: '#7a1428',
    y: '#eab308', Y: '#fff3a3', k: '#8a5a0b', g: '#c9a86a', G: '#6a5238', w: '#f2e6c8', o: '#2a1a12', l: '#ffcf6b', L: '#ff9a3c',
    c: '#6ee7f5', n: '#3a2414', N: '#5a3a22', s: '#b0b0bc',
  };
  const up = (name, rows) => S(name, [rows], UP, 6, 6, OUTLINE);
  up('up_pick', ['..MMMMMMM...', '.MmmmmmmmMM.', 'Mm.....KmmM.', 'M.....bK.mM.', '.....bB...M.', '....bB......', '...bB.......', '..bB........', '.bB.........', 'bB..........', 'b...........', '............']);
  up('up_vitality', ['.rrr...rrr..', 'rRRrr.rrRrr.', 'rRRrrrrrrrr.', 'rRrrrrrrrrr.', 'rrrrrrrrrrr.', '.rrrrrrrrr..', '..rrrrrrdr..', '...rrrrdr...', '....rrdr....', '.....rd.....', '............', '............']);
  up('up_armor', ['.mm......mm.', 'mMMm....mMMm', 'mMmmmmmmmmMm', '.mMMMMMMMMm.', '.mMmmMMmmMm.', '.mMMMMMMMMm.', '.mmMMmmMMmm.', '..mMMMMMMm..', '..mmMMMMmm..', '...mMMMMm...', '....mmmm....', '............']);
  up('up_grapple', ['.....w......', '.....w......', '.....w......', '.....w......', '....MMM.....', '.M...M...M..', 'Mm...M...mM.', 'Mm...M...mM.', '.Mm..M..mM..', '..MmmMmmM...', '....MmM.....', '............']);
  up('up_bag', ['....gg......', '...g..g.....', '..NNNNNN....', '.NBBBBBBN...', 'NBBBBBBBBN..', 'NBBggBBBBN..', 'NBBgYgBBBN..', 'NBBBggBBBN..', 'NBBBBBBBBN..', '.NBBBBBBN...', '..NNNNNN....', '............']);
  up('up_lantern', ['....KK......', '...K..K.....', '..KKKKKK....', '..KlLLlK....', '..KLllLK....', '..KlYYlK....', '..KLYYLK....', '..KlLLlK....', '..KKKKKK....', '....KK......', '............', '............']);
  up('up_boots', ['...NNNN.....', '...NBBN.....', '...NBBN.....', '...NBBN.....', '...NBBN.....', '...NBBN.....', '..NBBBN.....', '.NBBBBBNNN..', 'NBBBBBBBBBN.', 'NBBBBBBBBBN.', 'nnnnnnnnnnn.', '............']);
  up('up_insurance', ['....oooo....', '...gYYYYg...', '....gggg....', '..NNNNNNNN..', '.NBBBBBBBBN.', 'NBBByyyBBBBN', 'NBByYYkyBBBN', 'NBByYkkyBBBN', 'NBBByyyBBBBN', '.NBBBBBBBBN.', '..NNNNNNNN..', '............']);

  // --- icons (UI buttons / HUD)
  const ip = { o: '#0c0812', w: '#f2e6c8', W: '#ffffff', g: '#c9a86a', m: '#9aa4b8', M: '#e8eef8', b: '#6a4222', B: '#9a6a3e', r: '#e0304e', R: '#ff8090', y: '#eab308', Y: '#fff3a3', k: '#8a5a0b', d: '#5a4a3a' };
  S('icon_jump', [['.....ww.....', '....wwww....', '...wwwwww...', '..wwwwwwww..', '.www.ww.www.', '.....ww.....', '.....ww.....', '.....ww.....', '............', '..gggggggg..', '.gggggggggg.']], ip, 6, 6, '#0c0812');
  S('icon_pick', [['...MMMMMM...', '.MMmmmmmmMM.', 'Mm...bb...mM', 'M....bb....M', '.....bb.....', '.....bb.....', '.....bB.....', '.....bB.....', '.....bB.....', '.....bB.....', '.....bb.....']], ip, 6, 6, '#0c0812');
  S('icon_hook', [['.....MM.....', '....MmmM....', '.....mm.....', '.M...mm...M.', 'Mm...mm...mM', 'Mm...mm...mM', '.Mm..mm..mM.', '..MmmmmmmM..', '....MmmM....', '.....ww.....', '....w..w....', '.....ww.....']], ip, 6, 6, '#0c0812');
  S('icon_pause', [['ww..ww', 'ww..ww', 'ww..ww', 'ww..ww', 'ww..ww', 'ww..ww']], ip, 3, 3, '#0c0812');
  S('icon_heart', [['.rr.rr.', 'rRrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...']], ip, 3, 3, '#0c0812');
  S('icon_coin', [['.yyy.', 'yYyky', 'yYyky', 'yykky', '.yyy.']], ip, 2, 2, '#0c0812');
  S('icon_bag', [['..dd..', '.d..d.', 'bbbbbb', 'bBBBBb', 'bBggBb', 'bBBBBb', '.bbbb.']], ip, 3, 3, '#0c0812');
  S('icon_bank', [['.bbbbb.', 'bBBBBBb', 'bbbyybb', 'bBByBBb', 'bBBBBBb', 'bbbbbbb']], ip, 3, 3, '#0c0812');
}

// ------------------------------------------------------------------ enemies, boss, projectiles
// Procedural pixel art: shaded ellipses / limbs / polygons in the same dark SOTN
// ramps as the tiles, then the shared 1px outline. Every enemy faces right
// (drawSprite flips it). Each enemy sprite also gets two generated variants:
// `<name>_flash` (white hit flash) and `<name>_tele` (red attack telegraph).

function fillEllipse(p, cx, cy, rx, ry, col) {
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny <= 1) p.set(x, y, col);
    }
  }
}

/** Ellipse shaded with a 4-colour ramp (lit from the top-left), dithered bands. */
function shadeEllipse(p, cx, cy, rx, ry, ramp, opts = {}) {
  const lx = opts.lx ?? -0.55, ly = opts.ly ?? -0.75, hi = opts.hi ?? 0.92;
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry, d = nx * nx + ny * ny;
      if (d > 1 || (opts.clip && opts.clip(x, y))) continue;
      const nz = Math.sqrt(1 - d);
      const l = 0.5 + (nx * lx + ny * ly + nz * 0.55) * 0.5 + bayer(x, y) * 0.22;
      const i = l < 0.4 ? 0 : l < 0.64 ? 1 : l < hi ? 2 : 3;
      p.set(x, y, ramp[Math.min(ramp.length - 1, i)]);
    }
  }
}

/** Thick segment (round caps). */
function limb(p, x0, y0, x1, y1, r, col) {
  const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
  for (let i = 0; i <= n; i++) { const t = i / n; fillEllipse(p, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, r, col); }
}

/** Filled polygon, pts = [x0, y0, x1, y1, ...]. */
function fillPoly(p, pts, col) {
  let minY = Infinity, maxY = -Infinity;
  for (let i = 1; i < pts.length; i += 2) { minY = Math.min(minY, pts[i]); maxY = Math.max(maxY, pts[i]); }
  for (let y = Math.floor(minY); y <= Math.ceil(maxY); y++) {
    const yc = y + 0.5, xs = [];
    for (let i = 0; i < pts.length; i += 2) {
      const j = (i + 2) % pts.length;
      const x0 = pts[i], y0 = pts[i + 1], x1 = pts[j], y1 = pts[j + 1];
      if ((y0 <= yc && y1 > yc) || (y1 <= yc && y0 > yc)) xs.push(x0 + ((yc - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.round(xs[k]); x < Math.round(xs[k + 1]); x++) p.set(x, y, col);
  }
}

const DEG = Math.PI / 180;
/** Point at `len` px from (x, y) in direction `ang` degrees (0 = right, 90 = down). */
const polar = (x, y, ang, len) => [x + Math.cos(ang * DEG) * len, y + Math.sin(ang * DEG) * len];

/** Add `<name>_flash` and `<name>_tele` tinted copies of a registered sprite. */
function addTintVariants(name) {
  const s = sprites.get(name);
  const tint = (color, alpha) => {
    const c = mkCanvas(s.canvas.width, s.canvas.height);
    const g = c.getContext('2d');
    g.drawImage(s.canvas, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.globalAlpha = alpha; g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
    return c;
  };
  sprites.set(name + '_flash', { ...s, name: name + '_flash', canvas: tint('#fffaf0', 0.88), flip: null });
  sprites.set(name + '_tele', { ...s, name: name + '_tele', canvas: tint('#ff2a1a', 0.38), flip: null });
}

// ---- Gelée (slime): glossy green jelly with a dark core and beady eyes
const SLIME_RAMP = ['#113a1b', '#21692d', '#3aa442', '#a6f28e'];
function slimeFrame(rx, ry, o = {}) {
  const p = new Pix(22, 17);
  const cx = 11, base = 15;
  const cy = base - ry + 1.5;
  shadeEllipse(p, cx, cy, rx, ry + 1, SLIME_RAMP, { clip: (x, y) => y > base, hi: 0.86 });
  // translucent darker core with a swallowed pebble
  fillEllipse(p, cx - 0.5, base - ry * 0.45, rx * 0.5, ry * 0.35, '#1b5a26');
  p.set(cx - 2, Math.round(base - ry * 0.45), '#3a3c4a'); p.set(cx - 1, Math.round(base - ry * 0.45), '#525566');
  // rim of light on the floor contact
  for (let x = Math.round(cx - rx + 2); x <= Math.round(cx + rx - 2); x++) if (p.alpha(x, base) && (x & 1)) p.set(x, base, '#2f8a3a');
  // eyes (looking right)
  const ey = Math.round(cy - ry * 0.3 + (o.eyeDy || 0));
  for (const ex of [Math.round(cx + rx * 0.05), Math.round(cx + rx * 0.55)]) {
    if (o.squint) { p.set(ex, ey + 1, '#07140a'); p.set(ex + 1, ey + 1, '#07140a'); continue; }
    p.rect(ex, ey, 2, 2, '#07140a');
    p.set(ex, ey, '#e8ffe0');
  }
  if (o.drops) for (const [dx, dy] of [[-rx - 1, -2], [rx + 1, -3], [-rx + 1, -5], [rx - 2, -6]]) p.set(Math.round(cx + dx), Math.round(base + dy), SLIME_RAMP[2]);
  return p.outline(OUTLINE);
}

// ---- Chauve-souris (bat): half sprites mirrored (front view)
function mirrorRows(half) { return half.map((r) => r + [...r].reverse().join('')); }
const BAT_PAL = { 1: '#241430', 2: '#4a2a5c', 3: '#70427e', b: '#4a2a3c', B: '#80546a', e: '#ff3a3a', t: '#e8e0c8', k: '#160a18' };
const BAT_FLY = [
  // wings up
  ['1........', '21.......', '221....b.', '3221...bB', '.3221.bBe', '..322bbBB', '...32bbBt', '....2bbbb', '.....bbb.', '......b..', '.........'],
  // wings level
  ['.........', '.........', '.......b.', '.......bB', '1.....bBe', '21...bbBB', '3221bbbBt', '.33322bbb', '..3.3.bb.', '......b..', '.........'],
  // wings down
  ['.........', '.........', '.......b.', '.......bB', '......bBe', '.....bbBB', '...12bbBt', '..1222bbb', '.1322.bb.', '1332..b..', '13.......'],
  // wings level (recover)
  ['.........', '.........', '.......b.', '.......bB', '......bBe', '1....bbBB', '32211bbBt', '.3332bbbb', '...3.2bb.', '......b..', '.........'],
];
const BAT_HANG = [
  // wrapped in its wings, upside down (feet at the top touching the ceiling)
  ['......k..', '......b..', '.....bbb.', '....12bb.', '....122B.', '....132B.', '....132B.', '....122b.', '.....2Bb.', '......Be.', '......bB.', '.......b.'],
  ['......k..', '......b..', '.....bbb.', '....12bb.', '....122B.', '....132B.', '....122B.', '....122b.', '.....2Bb.', '......Be.', '......bB.', '.......b.'],
  // unfolding (waking)
  ['......k..', '......b..', '1....bbb.', '21..1bbb.', '321122bB.', '.33222bB.', '...32bbB.', '.....bBb.', '.....bBb.', '......Be.', '......bB.', '.......b.'],
];

// ---- Squelette (skeleton): limbs drawn by angle like the player
const BONE = { hi: '#efe8d2', mid: '#c4b99c', lo: '#8a7f6a', dk: '#3e342a', eye: '#ff3c3c' };
const SKULL = ['.hhhh.', 'hhhhhm', 'hkkhkk', 'hkrhkr', 'mhhhhm', '.mdmd.', '.mmmm.'];
function boneLine(p, x0, y0, x1, y1) { p.line(x0, y0, x1, y1, BONE.mid, 1); p.set(Math.round(x0), Math.round(y0), BONE.hi); p.set(Math.round(x1), Math.round(y1), BONE.hi); }
function skeletonFrame(o) {
  const p = new Pix(24, 30);
  const bob = o.bob || 0, hipX = 11, hipY = 19 + bob;
  const legs = o.legs;
  // legs: thigh + shin (back leg darker)
  legs.forEach(([a1, a2], i) => {
    const col = i === 0 ? BONE.lo : BONE.mid;
    const [kx, ky] = polar(hipX + i, hipY, 90 - a1, 5);
    let [fx, fy] = polar(kx, ky, 90 - a1 + a2, 5);
    if (fy > 28.5) fy = 28.5;
    p.line(hipX + i, hipY, kx, ky, col, 1); p.line(kx, ky, fx, fy, col, 1);
    p.set(Math.round(kx), Math.round(ky), BONE.hi);
    p.rect(Math.round(fx) - 1, Math.round(fy), 3, 1, col); p.set(Math.round(fx) + 1, Math.round(fy), BONE.hi);
  });
  // back arm
  const shX = 12, shY = 11 + bob;
  const [ba1, ba2] = o.backArm || [100, 20];
  const [bex, bey] = polar(shX - 1, shY, ba1, 4); const [bhx, bhy] = polar(bex, bey, ba1 + ba2, 4);
  p.line(shX - 1, shY, bex, bey, BONE.lo, 1); p.line(bex, bey, bhx, bhy, BONE.lo, 1);
  // pelvis, spine, ribs
  p.rows(['.mhhm.', 'mh..hm'], { h: BONE.hi, m: BONE.mid }, hipX - 2, hipY - 1);
  p.line(12, 10 + bob, 12, hipY - 1, BONE.mid, 1);
  for (let r = 0; r < 3; r++) { p.line(9, 12 + r * 2 + bob, 15, 12 + r * 2 + bob, r === 0 ? BONE.hi : BONE.mid, 1); p.set(9, 12 + r * 2 + bob, BONE.lo); }
  p.rect(10, 11 + bob, 5, 1, BONE.hi);
  // skull (leans with the throw)
  p.rows(SKULL, { h: BONE.hi, m: BONE.mid, k: '#1a0e0e', r: BONE.eye, d: BONE.dk }, 10 + (o.headDx || 0), 3 + bob + (o.headDy || 0));
  // front arm (+ held bone)
  const [fa1, fa2] = o.frontArm || [80, -20];
  const [ex, ey] = polar(shX + 1, shY, fa1, 4); const [hx, hy] = polar(ex, ey, fa1 + fa2, 4);
  p.line(shX + 1, shY, ex, ey, BONE.hi, 1); p.line(ex, ey, hx, hy, BONE.mid, 1);
  p.set(Math.round(hx), Math.round(hy), BONE.hi);
  if (o.holdBone) {
    const [bx0, by0] = polar(hx, hy, o.holdBone, -3); const [bx1, by1] = polar(hx, hy, o.holdBone, 3);
    boneLine(p, bx0, by0, bx1, by1);
  }
  return p.outline(OUTLINE);
}

// ---- Araignée (spider): shaded body, 8 animated legs
const SPIDER_RAMP = ['#1c1022', '#35223f', '#563a66', '#7e5e90'];
function spiderFrame(o) {
  const p = new Pix(26, 16);
  const legCol = '#4a3558', farCol = '#24182c', jointCol = '#8a6a9a';
  const bx = 12, by = 8 + (o.dy || 0);
  const pose = o.pose || 'walk', ph = o.phase || 0;
  const REACH = [-9, -5, 5, 9];
  // side view facing right: 4 legs per side, knees high, feet on the floor
  const leg = (i, near) => {
    const rootX = bx + 1 + i * 0.9, rootY = by + (near ? 1 : 0);
    const reach = REACH[i] * (near ? 1 : 0.85);
    let kx, ky, fx, fy;
    if (pose === 'hang') { kx = rootX + reach * 0.35; ky = by - 3; fx = rootX + reach * 0.5; fy = by + 1 + (i % 2); }
    else if (pose === 'drop') { kx = rootX + reach * 0.75; ky = by - 5; fx = rootX + reach * 1.15; fy = by - 2 + (i % 2) * 2; }
    else {
      const s = Math.sin(ph * Math.PI / 2 + i * Math.PI / 2 + (near ? Math.PI : 0));
      const lift = Math.max(0, s) * 1.6;
      kx = rootX + reach * 0.55 + s; ky = by - 4 - lift;
      fx = rootX + reach + s * 1.5; fy = by + 6 - lift;
    }
    const col = near ? legCol : farCol;
    p.line(rootX, rootY, kx, ky, col, 1);
    p.line(kx, ky, fx, fy, col, 1);
    if (near) p.set(Math.round(kx), Math.round(ky), jointCol);
  };
  for (let i = 0; i < 4; i++) leg(i, false);
  // abdomen (rear) + cephalothorax (front, right)
  shadeEllipse(p, bx - 3, by - 1, 5, 4, SPIDER_RAMP);
  shadeEllipse(p, bx + 3.5, by + 0.5, 3, 2.5, SPIDER_RAMP);
  // red hourglass marking, eyes, fangs
  p.rows(['rr', '.r', 'rr'], { r: '#c8182e' }, bx - 4, by - 2);
  p.set(bx + 5, by, '#ff3050'); p.set(bx + 6, by, '#ff3050'); p.set(bx + 5, by - 1, '#ff8090'); p.set(bx + 4, by, '#a01028');
  p.set(bx + 6, by + 2, '#d8d0c0'); p.set(bx + 5, by + 2, '#8a7f6a');
  for (let i = 0; i < 4; i++) leg(i, true);
  return p.outline(OUTLINE);
}

// ---- Spectre (ghost): wavy tail, hollow eyes
const GHOST_RAMP = ['#3d5a7c', '#7a9ec6', '#c4dcf0', '#f4fbff'];
function ghostFrame(ph, attack) {
  const p = new Pix(22, 26);
  const cx = 11, top = 2;
  // body: head dome + tapering tail swaying with the phase
  for (let y = top; y < 25; y++) {
    const t = (y - top) / 22;
    let half = y < top + 7 ? Math.sqrt(Math.max(0, 49 - (top + 7 - y) ** 2)) * 0.95 : 6.6 - (y - top - 7) * 0.34;
    if (attack && y > top + 6 && y < top + 13) half += 1;
    if (half <= 0.3) continue;
    const off = Math.sin(y * 0.45 - ph * Math.PI / 2) * 2.2 * t;
    for (let x = Math.floor(cx - half + off); x <= Math.ceil(cx + half + off); x++) {
      if (Math.abs(x + 0.5 - cx - off) > half) continue;
      // ragged strands at the tail end
      if (y > top + 16 && Math.sin(x * 1.7 + ph * 1.3) > 0.35) continue;
      const nx = (x + 0.5 - cx - off) / Math.max(1, half);
      const l = 0.62 - nx * 0.3 - t * 0.45 + bayer(x, y) * 0.25 + (y < top + 4 ? 0.15 : 0);
      p.set(x, y, GHOST_RAMP[l < 0.28 ? 0 : l < 0.5 ? 1 : l < 0.78 ? 2 : 3]);
    }
  }
  // wispy arms
  const armY = top + 9;
  if (attack) {
    p.line(cx + 5, armY, cx + 10, armY - 2, GHOST_RAMP[2], 1); p.line(cx + 5, armY + 1, cx + 10, armY + 2, GHOST_RAMP[1], 1);
    p.line(cx - 5, armY, cx - 8, armY - 3, GHOST_RAMP[1], 1);
  } else {
    const s = ph % 2 ? 1 : 0;
    p.line(cx + 5, armY, cx + 8, armY + 3 + s, GHOST_RAMP[1], 1); p.line(cx - 5, armY, cx - 8, armY + 4 - s, GHOST_RAMP[1], 1);
  }
  // hollow eyes + mouth (looking right)
  const eyeCol = attack ? '#ff3a4a' : '#0a1420';
  p.rows(['kk', 'kk', 'kk'], { k: '#0a1420' }, cx + 1, top + 5); p.rows(['kk', 'kk', 'kk'], { k: '#0a1420' }, cx + 5, top + 5);
  p.set(cx + 1, top + 6, eyeCol); p.set(cx + 5, top + 6, eyeCol);
  if (attack) p.rows(['.kk.', 'kkkk', 'kkkk', '.kk.'], { k: '#0a1420' }, cx + 2, top + 9);
  else p.rows(['kk', 'kk'], { k: '#0a1420' }, cx + 3, top + 10);
  return p.outline('#1a2a44');
}

// ---- Diablotin de feu (imp): red demon, bat wings, fireball in the hands
const IMP = { dk: '#4a0a06', lo: '#8a1c0a', mid: '#c2410c', hi: '#f06a2a', eye: '#fde047', horn: '#f0e0c0', wing: '#3a0a10', wing2: '#6a1418' };
const IMP_WINGS = [-65, -20, 25, -20];
function impFrame(o) {
  const p = new Pix(24, 22);
  const cx = 12, cy = 11 + (o.bob || 0);
  // tail
  p.line(cx - 2, cy + 4, cx - 6, cy + 6, IMP.lo, 1); p.line(cx - 6, cy + 6, cx - 8, cy + 3, IMP.lo, 1);
  p.rows(['.d.', 'ddd'], { d: IMP.dk }, cx - 9, cy + 1);
  // wing (behind): membrane polygon from the shoulder
  const wa = o.wing;
  const [tx, ty] = polar(cx - 2, cy - 3, 180 + wa, 10);
  const [mx, my] = polar(cx - 2, cy - 3, 180 + wa * 0.4 + 25, 7);
  fillPoly(p, [cx - 1, cy - 4, tx, ty, mx, my, cx - 2, cy + 1], IMP.wing);
  p.line(cx - 1, cy - 4, tx, ty, IMP.wing2, 1); p.line(tx, ty, mx, my, IMP.wing2, 1);
  // legs
  p.line(cx - 1, cy + 4, cx - 2, cy + 8, IMP.lo, 1); p.line(cx + 1, cy + 4, cx + 2, cy + 8, IMP.mid, 1);
  // body + head
  shadeEllipse(p, cx, cy + 1.5, 3.2, 3.8, [IMP.dk, IMP.lo, IMP.mid, IMP.hi]);
  shadeEllipse(p, cx + 1, cy - 4.5, 3.6, 3.2, [IMP.dk, IMP.lo, IMP.mid, IMP.hi]);
  // horns, eyes, grin
  p.line(cx - 1, cy - 7, cx - 3, cy - 10, IMP.horn, 1); p.line(cx + 3, cy - 7, cx + 4, cy - 10, IMP.horn, 1);
  p.set(cx - 3, cy - 10, '#ffffff'); p.set(cx + 4, cy - 10, '#ffffff');
  p.set(cx + 2, cy - 5, IMP.eye); p.set(cx + 4, cy - 5, IMP.eye);
  p.line(cx + 1, cy - 3, cx + 4, cy - 3, IMP.dk, 1); p.set(cx + 2, cy - 3, IMP.horn); p.set(cx + 4, cy - 4, IMP.dk);
  // arms (+ fireball)
  if (o.cast) {
    p.line(cx + 2, cy, cx + 8, cy - 1, IMP.hi, 1); p.line(cx + 1, cy + 1, cx + 7, cy + 1, IMP.mid, 1);
  } else if (o.ball) {
    const r = o.ball;
    p.line(cx + 2, cy, cx + 5, cy - 1, IMP.hi, 1); p.line(cx + 1, cy + 1, cx + 5, cy + 2, IMP.mid, 1);
    fillEllipse(p, cx + 7, cy, r + 1, r + 1, '#c2410c'); fillEllipse(p, cx + 7, cy, r, r, '#fb923c'); fillEllipse(p, cx + 7, cy, r * 0.5, r * 0.5, '#fef08a');
  } else {
    p.line(cx + 2, cy, cx + 4, cy + 3, IMP.mid, 1); p.set(cx + 4, cy + 3, IMP.hi);
  }
  return p.outline(OUTLINE);
}

// ---- Golem: basalt boulders held together by magma
const GOLEM_RAMP = ['#1e1719', '#3b3031', '#5c4c49', '#7f6a62'];
function golemFrame(o) {
  const p = new Pix(36, 36);
  const bob = o.bob || 0, lean = o.lean || 0, cr = o.crouch || 0;
  const hx = 17 + lean, hy = 17 + bob + cr;
  const dark = GOLEM_RAMP.map((c) => shade(c, 0.72));
  const glow = o.dim ? '#7a2a0a' : '#ff8a1f', core = o.dim ? '#a0400c' : '#fde047';
  const [l0, l1] = o.legs || [0, 0];
  const [ba, fa] = o.arms || [100, 80];
  // back leg + back arm (darker, behind the torso)
  limb(p, hx - 3, hy + 5, 13 + l0, 30, 3, dark[1]);
  shadeEllipse(p, 13 + l0, 31.5, 4.2, 2.6, dark);
  const [bex, bey] = polar(hx - 6, hy - 4, ba, 6);
  const [bfx, bfy] = polar(bex, bey, ba - 20, 5);
  limb(p, hx - 6, hy - 4, bex, bey, 2.4, dark[1]); limb(p, bex, bey, bfx, bfy, 2.2, dark[1]);
  shadeEllipse(p, bfx, bfy, 3.6, 3.4, dark);
  // torso boulder with magma cracks
  shadeEllipse(p, hx, hy, 8.5, 7.8, GOLEM_RAMP);
  p.line(hx - 4, hy - 3, hx, hy + 1, glow, 1); p.line(hx, hy + 1, hx - 1, hy + 6, glow, 1); p.line(hx, hy + 1, hx + 5, hy + 2, glow, 1);
  p.set(hx, hy + 1, core); p.set(hx - 2, hy - 1, core);
  // front leg
  limb(p, hx + 3, hy + 5, 21 + l1, 30, 3.2, GOLEM_RAMP[1]);
  shadeEllipse(p, 21 + l1, 31.5, 4.4, 2.8, GOLEM_RAMP);
  p.set(21 + l1, 28, glow);
  // head on top: heavy brow, glowing eyes
  const hdx = Math.round(hx + 2 + (o.headDx || 0)), hdy = Math.round(hy - 9 + (o.headDy || 0));
  shadeEllipse(p, hdx, hdy, 4.8, 4, GOLEM_RAMP);
  p.rect(hdx - 2, hdy - 2, 7, 1, GOLEM_RAMP[0]);
  const eye = o.dim ? '#4a1a08' : core;
  p.rect(hdx, hdy - 1, 2, 1, eye); p.rect(hdx + 3, hdy - 1, 2, 1, eye);
  if (!o.dim) { p.set(hdx, hdy, glow); p.set(hdx + 3, hdy, glow); }
  p.rect(hdx, hdy + 2, 4, 1, GOLEM_RAMP[0]);
  // front arm: shoulder boulder, forearm, huge fist
  shadeEllipse(p, hx + 6, hy - 5, 4.2, 3.8, GOLEM_RAMP);
  const [fex, fey] = polar(hx + 7, hy - 4, fa, 6);
  const [ffx, ffy] = polar(fex, fey, fa - 25, 5);
  limb(p, hx + 7, hy - 4, fex, fey, 2.6, GOLEM_RAMP[1]); limb(p, fex, fey, ffx, ffy, 2.6, GOLEM_RAMP[1]);
  p.set(Math.round(fex), Math.round(fey), glow);
  shadeEllipse(p, ffx, ffy, 4.3, 4, GOLEM_RAMP);
  p.set(Math.round(ffx) + 1, Math.round(ffy) + 1, glow);
  if (o.stars) for (const [sx, sy] of [[hdx - 6, hdy - 6], [hdx + 2, hdy - 8], [hdx + 7, hdy - 5]]) p.rows(['.y.', 'yYy', '.y.'], { y: '#e0ac48', Y: '#fff4c0' }, Math.round(sx), Math.round(sy));
  return p.outline(OUTLINE);
}

// ---- Le Gardien de l'Abysse: armoured horned colossus with an abyssal core (64 x 64)
const GUARD = {
  normal: { a0: '#0e0a16', a1: '#221a34', a2: '#3a2c55', a3: '#5e4a86', cape: '#4a0c1e', cape2: '#7a1428', bone: '#d8cdb0', bone2: '#9a8e74', eye: '#ff3050', core: '#b070f0', core2: '#f0d8ff', fist: '#2e2444' },
  rage: { a0: '#140606', a1: '#321010', a2: '#5a1c14', a3: '#8a3a1c', cape: '#5a0a08', cape2: '#a0200c', bone: '#f0dcc0', bone2: '#b08a6a', eye: '#fde047', core: '#ff8a1f', core2: '#fff4c0', fist: '#401410' },
};
function guardianFrame(o, P) {
  const p = new Pix(64, 64);
  const ramp = [P.a0, P.a1, P.a2, P.a3];
  const bob = o.bob || 0, cr = o.crouch || 0, lean = o.lean || 0;
  const cx = 31 + lean, chestY = 30 + bob + cr;
  // cape (tattered) behind everything
  const cw = o.capeWave || 0;
  fillPoly(p, [cx - 10, chestY - 8, cx + 6, chestY - 8, cx + 4 + cw, 60, cx - 4 + cw, 62, cx - 12 + cw, 61, cx - 16 + cw, 58], P.cape);
  for (let x = cx - 15 + cw; x < cx + 4 + cw; x += 3) p.line(x, 57, x + 1, 62 - ((x * 7) % 3), P.cape2, 1);
  p.line(cx - 10, chestY - 7, cx - 15 + cw, 57, P.cape2, 1);
  // back arm
  const armBack = o.armBack || [110, 40];
  const shB = [cx - 9, chestY - 6];
  const [ebx, eby] = polar(shB[0], shB[1], armBack[0], 9);
  const [hbx, hby] = polar(ebx, eby, armBack[0] + armBack[1], 8);
  limb(p, shB[0], shB[1], ebx, eby, 3, shade(P.a1, 0.9));
  limb(p, ebx, eby, hbx, hby, 2.6, shade(P.a1, 0.9));
  shadeEllipse(p, hbx, hby, 4, 4, ramp.map((c) => shade(c, 0.75)));
  // legs (armoured greaves)
  const [lb, lf] = o.legs || [[-4, 4], [4, -4]];
  const hipY = chestY + 12;
  const leg = (dx, [kneeOff, footOff], dark) => {
    const kx = cx + dx + kneeOff * 0.6, ky = hipY + 7;
    const fx = cx + dx + footOff, fy = 61;
    const col = dark ? shade(P.a1, 0.85) : P.a2;
    limb(p, cx + dx, hipY, kx, ky, 3.4, col);
    limb(p, kx, ky, fx, fy - 2, 3, col);
    shadeEllipse(p, kx, ky, 2.6, 2.4, dark ? ramp.map((c) => shade(c, 0.8)) : ramp);
    p.rect(Math.round(fx) - 4, 61, 9, 2, dark ? P.a0 : P.a1); p.rect(Math.round(fx) - 3, 60, 7, 1, dark ? P.a1 : P.a3);
  };
  leg(-5, lb, true);
  leg(5, lf, false);
  // torso: shaded breastplate + belt + skirt plates
  shadeEllipse(p, cx, chestY, 12, 11, ramp);
  fillPoly(p, [cx - 9, hipY - 3, cx + 9, hipY - 3, cx + 11, hipY + 5, cx - 11, hipY + 5], P.a1);
  for (let x = cx - 9; x <= cx + 9; x += 4) p.line(x, hipY - 2, x - 1, hipY + 5, P.a0, 1);
  p.rect(cx - 10, hipY - 4, 21, 2, P.a0); p.rect(cx - 2, hipY - 5, 5, 4, P.bone2); p.set(cx, hipY - 4, P.bone);
  // ribs of bone over the chest + the abyssal core
  for (let r = 0; r < 3; r++) { p.line(cx - 7 + r, chestY - 4 + r * 3, cx - 2, chestY - 3 + r * 3, P.bone2, 1); p.line(cx + 2, chestY - 3 + r * 3, cx + 7 - r, chestY - 4 + r * 3, P.bone2, 1); }
  const coreR = o.coreR ?? 2.6;
  fillEllipse(p, cx, chestY - 1, coreR + 1.2, coreR + 1.2, P.a0);
  fillEllipse(p, cx, chestY - 1, coreR, coreR, P.core);
  fillEllipse(p, cx - 0.5, chestY - 1.5, coreR * 0.45, coreR * 0.45, P.core2);
  // head: horned skull helm
  const hx = cx + 3 + (o.headDx || 0), hy = chestY - 16 + (o.headDy || 0);
  shadeEllipse(p, hx, hy, 5.5, 5, ramp);
  // horns sweep back and up
  const horn = (sx, sy, dir) => {
    let x = sx, y = sy;
    for (let i = 0; i < 9; i++) {
      const nx = x + dir * (i < 4 ? 1 : 0.6), ny = y - (i < 3 ? 0.6 : 1.1);
      limb(p, x, y, nx, ny, i < 4 ? 1.3 : 0.7, i > 6 ? P.bone : P.bone2);
      x = nx; y = ny;
    }
  };
  horn(hx - 4, hy - 2, -1);
  horn(hx + 3, hy - 3, 1);
  // face: bone mask, glowing eyes, jaw
  fillPoly(p, [hx - 1, hy - 2, hx + 6, hy - 2, hx + 6, hy + 3, hx + 3, hy + 5, hx, hy + 3], P.bone2);
  fillPoly(p, [hx, hy - 2, hx + 6, hy - 2, hx + 5, hy + 1, hx + 1, hy + 1], P.bone);
  const eyeC = o.eyesOff ? '#2a1a2a' : P.eye;
  p.rect(Math.round(hx) + 1, Math.round(hy), 2, 1, eyeC); p.rect(Math.round(hx) + 4, Math.round(hy), 2, 1, eyeC);
  if (!o.eyesOff) { p.set(Math.round(hx) + 2, Math.round(hy) - 1, P.core2); p.set(Math.round(hx) + 5, Math.round(hy) - 1, P.core2); }
  p.rect(Math.round(hx) + 1, Math.round(hy) + 2 + (o.jaw || 0), 5, 1, P.a0);
  for (let k = 0; k < 3; k++) p.set(Math.round(hx) + 2 + k * 1.5, Math.round(hy) + 2 + (o.jaw || 0), P.bone);
  // spiked pauldrons
  shadeEllipse(p, cx - 9, chestY - 7, 5.5, 4.5, ramp);
  shadeEllipse(p, cx + 10, chestY - 7, 6, 5, ramp);
  for (const [sx, dir] of [[cx - 12, -1], [cx - 8, -1], [cx + 9, 1], [cx + 13, 1]]) limb(p, sx, chestY - 10, sx + dir, chestY - 14, 0.8, P.bone);
  // front arm + gauntlet fist
  const armF = o.armFront || [70, 30];
  const shF = [cx + 10, chestY - 5];
  const [efx, efy] = polar(shF[0], shF[1], armF[0], 10);
  const [hfx, hfy] = polar(efx, efy, armF[0] + armF[1], 9);
  limb(p, shF[0], shF[1], efx, efy, 3.4, P.a2);
  limb(p, efx, efy, hfx, hfy, 3, P.a2);
  shadeEllipse(p, efx, efy, 2.6, 2.6, ramp);
  shadeEllipse(p, hfx, hfy, 5, 4.6, [P.a0, P.fist, P.a2, P.a3]);
  if (o.claws) for (let k = -1; k <= 1; k++) { const [cx2, cy2] = polar(hfx, hfy, armF[0] + armF[1] + k * 22, 7.5); limb(p, hfx, hfy, cx2, cy2, 0.6, P.bone); }
  if (o.fire) {
    fillEllipse(p, hfx, hfy - 7, 4.5, 5, '#c2410c'); fillEllipse(p, hfx, hfy - 7.5, 3.2, 3.8, '#fb923c'); fillEllipse(p, hfx, hfy - 7, 1.8, 2, '#fef08a');
  }
  if (o.glowFists) { p.set(Math.round(hfx), Math.round(hfy), P.core2); p.set(Math.round(hbx), Math.round(hby), P.core2); }
  return p.outline(OUTLINE);
}

const GUARDIAN_POSES = [
  /* 0 idle      */ { armFront: [75, 25], armBack: [105, 30] },
  /* 1 idle 2    */ { bob: 1, armFront: [78, 22], armBack: [108, 28], coreR: 2.2, capeWave: 1 },
  /* 2 walk      */ { armFront: [60, 30], armBack: [120, 25], legs: [[-6, -7], [5, 6]], capeWave: -1 },
  /* 3 walk 2    */ { bob: 1, armFront: [95, 15], armBack: [90, 35], legs: [[-2, 4], [3, -5]], capeWave: 1 },
  /* 4 slam up   */ { armFront: [-95, -15], armBack: [-85, 15], headDy: -1, coreR: 3.4, glowFists: true, legs: [[-7, -6], [7, 7]] },
  /* 5 slam down */ { crouch: 6, armFront: [72, 4], armBack: [106, -4], headDy: 2, headDx: 1, jaw: 1, legs: [[-9, -9], [9, 9]], coreR: 3, glowFists: true },
  /* 6 roar      */ { armFront: [-20, -30], armBack: [200, 30], headDy: -2, headDx: -1, jaw: 2, coreR: 3.6, capeWave: 2, legs: [[-7, -7], [7, 7]] },
  /* 7 fire rain */ { armFront: [-80, 10], armBack: [140, 30], headDy: -2, fire: true, coreR: 3.2, jaw: 1 },
  /* 8 swipe up  */ { armFront: [200, 40], armBack: [120, 20], lean: -2, headDx: -1, legs: [[-6, -8], [6, 5]] },
  /* 9 swipe     */ { armFront: [10, 5], armBack: [150, 20], lean: 3, claws: true, legs: [[-8, -9], [8, 9]], jaw: 1 },
  /* 10 stunned  */ { crouch: 3, armFront: [100, 20], armBack: [95, 25], headDy: 3, headDx: 2, coreR: 1.6, eyesOff: false },
  /* 11 dormant  */ { crouch: 6, armFront: [90, -10], armBack: [100, -20], headDy: 5, headDx: 2, eyesOff: true, coreR: 1.2, legs: [[-9, -4], [9, 2]] },
  /* 12 charge   */ { lean: 5, crouch: 2, armFront: [150, -30], armBack: [160, -20], headDx: 3, headDy: 3, legs: [[-9, -10], [8, 10]], capeWave: -3, coreR: 3 },
];

function buildEnemies() {
  // Gelée: idle ×2, squash (telegraph), stretched (jump), splat (landing)
  addSprite('enemy_slime', [
    slimeFrame(7, 5.4), slimeFrame(7.6, 4.9), slimeFrame(8.6, 3.6, { squint: true, eyeDy: 1 }),
    slimeFrame(5.6, 7), slimeFrame(9.2, 2.8, { drops: true, squint: true }),
  ], 11, 16);

  // Chauve-souris: 4 flight frames, 3 hanging frames (asleep ×2, waking)
  S('enemy_bat', BAT_FLY.map(mirrorRows), BAT_PAL, 9, 6, OUTLINE);
  S('enemy_bat_hang', BAT_HANG.map(mirrorRows), BAT_PAL, 9, 4, OUTLINE);

  // Squelette: walk ×4, wind-up (bone raised), throw
  const walk = [[[-24, 20], [22, 8]], [[-6, 30], [6, 2]], [[20, 10], [-22, 18]], [[6, 2], [-6, 30]]];
  addSprite('enemy_skeleton', [
    ...walk.map((legs, i) => skeletonFrame({ legs, bob: i % 2, frontArm: [90 - (i % 2 ? 20 : -15), -25], backArm: [90 + (i % 2 ? 20 : -15), 25] })),
    skeletonFrame({ legs: [[-10, 5], [14, 6]], frontArm: [-120, -40], backArm: [120, 20], holdBone: 60, headDx: -1 }),
    skeletonFrame({ legs: [[-14, 8], [20, 10]], frontArm: [-15, 10], backArm: [150, 10], headDx: 1 }),
  ], 12, 29);

  // Araignée: walk ×4, hanging ×2, dropping
  addSprite('enemy_spider', [
    ...[0, 1, 2, 3].map((ph) => spiderFrame({ pose: 'walk', phase: ph })),
    spiderFrame({ pose: 'hang', phase: 0 }), spiderFrame({ pose: 'hang', phase: 1, dy: 1 }),
    spiderFrame({ pose: 'drop' }),
  ], 12, 9);

  // Spectre: float ×4, attack
  addSprite('enemy_ghost', [0, 1, 2, 3].map((ph) => ghostFrame(ph, false)).concat([ghostFrame(1, true)]), 11, 13);

  // Diablotin: flap ×4, charging ×2 (fireball grows), cast
  addSprite('enemy_imp', [
    ...IMP_WINGS.map((w, i) => impFrame({ wing: w, bob: i === 2 ? 1 : 0 })),
    impFrame({ wing: -40, ball: 1.4 }), impFrame({ wing: 10, ball: 2.2, bob: 1 }),
    impFrame({ wing: -60, cast: true }),
  ], 12, 11);

  // Golem: walk ×4, wind-up (stomp), charge ×2, stunned
  addSprite('enemy_golem', [
    golemFrame({ legs: [-2, 2], arms: [110, 70] }), golemFrame({ legs: [0, 0], arms: [100, 80], bob: 1 }),
    golemFrame({ legs: [2, -2], arms: [85, 100] }), golemFrame({ legs: [0, 0], arms: [95, 90], bob: 1 }),
    golemFrame({ legs: [-3, 3], arms: [-100, -80], crouch: 2, headDy: 1 }),
    golemFrame({ legs: [-4, 3], arms: [160, 20], lean: 3, headDx: 2, headDy: 3 }),
    golemFrame({ legs: [3, -3], arms: [150, 30], lean: 3, headDx: 2, headDy: 3, bob: 1 }),
    golemFrame({ legs: [-1, 1], arms: [120, 100], crouch: 2, headDy: 2, dim: true, stars: true }),
  ], 17, 35);

  // Le Gardien: 13 poses (see enemies.js _frame), normal and enraged palettes
  addSprite('enemy_guardian', GUARDIAN_POSES.map((o) => guardianFrame(o, GUARD.normal)), 32, 63);
  addSprite('enemy_guardian_rage', GUARDIAN_POSES.map((o) => guardianFrame({ ...o, coreR: (o.coreR ?? 2.6) + 0.8 }, GUARD.rage)), 32, 63);

  for (const n of ['enemy_slime', 'enemy_bat', 'enemy_bat_hang', 'enemy_skeleton', 'enemy_spider', 'enemy_ghost', 'enemy_imp', 'enemy_golem', 'enemy_guardian', 'enemy_guardian_rage']) addTintVariants(n);

  // ---- projectiles & fx
  // spinning bone
  addSprite('proj_bone', [0, 45, 90, 135].map((a) => {
    const p = new Pix(11, 11);
    const [x0, y0] = polar(5, 5, a, -3.5), [x1, y1] = polar(5, 5, a, 3.5);
    p.line(x0, y0, x1, y1, BONE.mid, 1);
    for (const [x, y] of [[x0, y0], [x1, y1]]) { p.set(Math.round(x), Math.round(y), BONE.hi); p.set(Math.round(x + Math.cos((a + 90) * DEG)), Math.round(y + Math.sin((a + 90) * DEG)), BONE.hi); }
    return p.outline(OUTLINE);
  }), 5, 5);
  // fireball with a flickering trail (faces right)
  addSprite('proj_fireball', [0, 1, 2].map((f) => {
    const p = new Pix(14, 10);
    for (let k = 0; k < 4; k++) fillEllipse(p, 7 - k * 1.8, 5 + ((k + f) % 2 ? 0.6 : -0.6), 2.4 - k * 0.45, 2 - k * 0.35, k < 2 ? '#c2410c' : '#7a1a08');
    fillEllipse(p, 9, 5, 3.3, 3, '#c2410c'); fillEllipse(p, 9.3, 5, 2.4, 2.2, '#fb923c'); fillEllipse(p, 9.8, 4.8, 1.3, 1.2, '#fef08a');
    p.set(10, 4, '#ffffff');
    if (f === 1) p.set(3, 3, '#fb923c'); if (f === 2) p.set(2, 7, '#fb923c');
    return p;
  }), 9, 5);
  // abyssal shockwave running along the floor (anchor = bottom centre)
  addSprite('proj_shock', [0, 1, 2].map((f) => {
    const p = new Pix(14, 18);
    const h = 13 + (f === 1 ? 2 : f === 2 ? -1 : 0);
    fillPoly(p, [2, 17, 6, 17 - h, 8, 17 - h + 2, 12, 17], '#5a2a8a');
    fillPoly(p, [4, 17, 7, 18 - h, 8, 19 - h, 10, 17], '#a45ee8');
    p.line(7, 19 - h, 8, 15, '#e3c4ff', 1);
    p.set(1 + f, 16, '#a45ee8'); p.set(12 - f, 15, '#e3c4ff');
    return p;
  }), 7, 17);
  // falling meteor (anchor = the burning head)
  addSprite('proj_meteor', [0, 1].map((f) => {
    const p = new Pix(12, 18);
    for (let k = 0; k < 5; k++) fillEllipse(p, 6 + ((k + f) % 2 ? 0.7 : -0.7), 12 - k * 2.2, 2.6 - k * 0.4, 1.8, k < 2 ? '#fb923c' : '#c2410c');
    fillEllipse(p, 6, 13, 3.4, 3.4, '#7a1a08'); fillEllipse(p, 6, 13, 2.6, 2.6, '#3b3031'); p.set(5, 12, '#fb923c'); p.set(7, 14, '#ff8a1f');
    p.set(4 + f, 4, '#fef08a');
    return p.outline('#2a0a04');
  }), 6, 13);
  // fire-rain warning sigil on the ceiling
  addSprite('fx_warn', [0, 1].map((f) => new Pix(11, 9).rows([
    '...rrrrr...', '..r.....r..', '.r..rRr..r.', 'r..rRWRr..r', '.r..rRr..r.', '..r.....r..', '...rrrrr...', '.....r.....', '.....R.....',
  ].map((r) => (f ? r.replace(/r/g, 'R') : r)), { r: '#8a1a10', R: '#ff5030', W: '#fff0a0' })), 5, 3);
}

// ------------------------------------------------------------------ backdrop (surface parallax)

function buildBackdrop() {
  // sky: dithered vertical gradient column (1 px wide, stretched horizontally)
  const skyH = 240;
  const stops = [[0, '#05060f'], [0.35, '#0d1030'], [0.62, '#1c1a44'], [0.82, '#3a2552'], [1, '#5a2f4a']];
  const sky = new Pix(4, skyH);
  const colAt = (t) => {
    for (let i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
      const k = (t - stops[i - 1][0]) / (stops[i][0] - stops[i - 1][0]);
      return mix(stops[i - 1][1], stops[i][1], k);
    }
    return stops[stops.length - 1][1];
  };
  for (let y = 0; y < skyH; y++) for (let x = 0; x < 4; x++) {
    const t = Math.min(1, Math.max(0, y / skyH + bayer(x, y) * 0.02));
    sky.set(x, y, colAt(Math.round(t * 24) / 24));
  }
  backdrop.skyColumn = sky.toCanvas();
  backdrop.skyH = skyH;
  const r = mulberry32(9001);
  backdrop.stars = Array.from({ length: 90 }, () => ({ x: r() * 1024, y: r() * 150, b: r(), p: r() * 6.28, big: r() < 0.12 }));
  // moon with a dithered halo (rings of decreasing density)
  const MS = 64, mc = 31.5;
  const moon = new Pix(MS, MS);
  for (let y = 0; y < MS; y++) for (let x = 0; x < MS; x++) {
    const dx = x - mc, dy = y - mc, d = Math.hypot(dx, dy);
    if (d < 11.5) moon.set(x, y, d > 10.3 ? '#cfc6ae' : (dx + dy > 6 ? '#d8d0b8' : '#f0e8d0'));
    else if (d < 30) {
      const k = 1 - (d - 11.5) / 18.5; // 1 near the moon -> 0 at the rim
      if (bayer(x, y) + 0.5 < k * k * 0.9) moon.set(x, y, '#3a3a6a', 255);
      else if (d < 15 && bayer(x + 1, y) + 0.5 < k) moon.set(x, y, '#5a5a8a', 255);
    }
  }
  [[8, 9, 2], [15, 14, 3], [9, 16, 1.5], [16, 7, 1.2]].forEach(([cx, cy, rr]) => {
    for (let y = -3; y <= 3; y++) for (let x = -3; x <= 3; x++) if (Math.hypot(x, y) <= rr) moon.set(cx + 19 + x, cy + 19 + y, '#c4bba2');
  });
  backdrop.moon = moon.toCanvas();
  // far mountains
  const mw = 640, mh = 110;
  const mnt = new Pix(mw, mh);
  const n1 = periodicNoise(31, 10), n2 = periodicNoise(57, 40);
  for (let x = 0; x < mw; x++) {
    const h = Math.round(mh * 0.25 + n1((x / mw) * 10, 0.5) * mh * 0.45 + n2((x / mw) * 40, 0.3) * 10);
    for (let y = mh - h; y < mh; y++) {
      const rim = y - (mh - h) < 2 && n1(((x + 3) / mw) * 10, 0.5) < n1((x / mw) * 10, 0.5);
      mnt.set(x, y, rim ? '#2e2c52' : '#191834');
    }
  }
  backdrop.mountains = mnt.toCanvas();
  // gothic castle on a crag
  const cw = 300, ch = 170;
  const cas = new Pix(cw, ch);
  const cc = '#0f0e22', cl = '#15142c';
  const crag = periodicNoise(88, 8);
  for (let x = 0; x < cw; x++) {
    const h = Math.round(40 + Math.sin((x / cw) * Math.PI) * 30 + crag(x / 20, 1) * 18);
    for (let y = ch - h; y < ch; y++) cas.set(x, y, cc);
  }
  const tower = (x, w, top, roof) => {
    cas.rect(x, top, w, ch - top, cc);
    cas.rect(x, top, 1, ch - top, cl);
    for (let k = 0; k < w; k += 2) cas.set(x + k, top - 1, cc);
    if (roof) for (let y = 0; y < roof; y++) { const hw = Math.round(((y + 1) / roof) * (w / 2 + 1)); cas.rect(x + Math.floor(w / 2) - hw, top - roof + y, hw * 2, 1, cc); }
  };
  tower(120, 26, 40, 34); tower(96, 14, 62, 24); tower(158, 16, 56, 26); tower(78, 10, 80, 18); tower(184, 12, 74, 20);
  tower(60, 44, 96, 0); tower(196, 50, 92, 0); tower(142, 8, 30, 28);
  for (let x = 60; x < 250; x += 3) cas.set(x, 95, cc);
  // lit windows
  const win = [[128, 60], [136, 60], [128, 76], [100, 80], [162, 72], [70, 108], [84, 104], [210, 104], [226, 110], [146, 44], [188, 90]];
  win.forEach(([x, y], i) => { cas.rect(x, y, 2, 3, i % 3 === 0 ? '#5a4a2a' : '#e0b050'); cas.set(x, y - 1, i % 3 === 0 ? '#3a3020' : '#b08a3a'); });
  backdrop.castle = cas.toCanvas();
  // near hills with dead trees and graves
  const hw2 = 640, hh = 80;
  const hills = new Pix(hw2, hh);
  const n3 = periodicNoise(123, 8);
  for (let x = 0; x < hw2; x++) {
    const h = Math.round(22 + n3((x / hw2) * 8, 0.2) * 26);
    for (let y = hh - h; y < hh; y++) hills.set(x, y, '#0a0916');
  }
  for (let k = 0; k < 9; k++) {
    const x = Math.floor(r() * hw2), baseY = hh - Math.round(22 + n3((x / hw2) * 8, 0.2) * 26);
    const th = 10 + Math.floor(r() * 16);
    hills.line(x, baseY, x, baseY - th, '#0a0916', 1);
    hills.line(x, baseY - th * 0.6, x - 5, baseY - th, '#0a0916', 1);
    hills.line(x, baseY - th * 0.5, x + 6, baseY - th * 0.9, '#0a0916', 1);
  }
  backdrop.hills = hills.toCanvas();
}

// ------------------------------------------------------------------ entry point

export function loadSprites() {
  if (loaded) return;
  buildTileTextures();
  buildBackTextures();
  buildCracks();
  buildLava();
  buildPlayer();
  buildProps();
  buildEnemies();
  buildBackdrop();
  loaded = true;
}
