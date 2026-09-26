// Procedural pixel art. Dinosaurs are rasterised from the `look` parameters in data/ (body plan, sizes,
// colours, features) into small palette grids, outlined, then baked into canvases (both facings, all poses).
// Tiles, structures and icons are drawn the same way, once at start-up.
import { TILE } from './config.js';
import { TILE_DEFS } from './tiles.js';
import { hash2 } from './rng.js';

// palette slots of the dino grid
const T = 0, OUT = 1, BASE = 2, BELLY = 3, ACC = 4, HORN = 5, EYE = 6, EYEW = 7, SHADE = 8, MOUTH = 9, LIGHT = 10;

export function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function shadeHex(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (f < 0) { r *= 1 + f; g *= 1 + f; b *= 1 + f; } else { r += (255 - r) * f; g += (255 - g) * f; b += (255 - b) * f; }
  return `rgb(${r | 0},${g | 0},${b | 0})`;
}

class Grid {
  constructor(w, h) { this.w = w; this.h = h; this.a = new Uint8Array(w * h); }
  set(x, y, c) { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.a[y * this.w + x] = c; }
  get(x, y) { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.a[y * this.w + x] : 0; }
  rect(x, y, w, h, c) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c); }
  ellipse(x, y, w, h, c) {
    const rx = w / 2, ry = h / 2, cx = x + rx - 0.5, cy = y + ry - 0.5;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const dx = (x + i - cx) / rx, dy = (y + j - cy) / ry;
      if (dx * dx + dy * dy <= 1.08) this.set(x + i, y + j, c);
    }
  }
  outline() {
    const src = this.a.slice();
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
      if (src[y * this.w + x] !== T) continue;
      const n = (dx, dy) => { const xx = x + dx, yy = y + dy; return xx >= 0 && yy >= 0 && xx < this.w && yy < this.h ? src[yy * this.w + xx] : 0; };
      if ((n(1, 0) && n(1, 0) !== OUT) || (n(-1, 0) && n(-1, 0) !== OUT) || (n(0, 1) && n(0, 1) !== OUT) || (n(0, -1) && n(0, -1) !== OUT)) this.a[y * this.w + x] = OUT;
    }
  }
}

/**
 * Rasterise one pose of a dinosaur facing right.
 * pose: { walk: phase (radians) | null, jaw: 0..2, bob: px, swim: bool, air: 'up'|'down'|null }
 */
function rasterDino(look, pose) {
  const M = 1; // margin for the outline
  const g = new Grid(look.w + M * 2, look.h + M * 2 + 1);
  const H = look.h + M;       // ground row + 1
  const L = look.legs, B = look.body, HD = look.head;
  const bob = pose.bob || 0;
  const bx = B.x + M, bw = B.w, bh = B.h;
  const by = (look.plan === 'swimmer' ? B.y + M : H - L.len - bh) + bob;
  const f = look.features || [];
  const walk = pose.walk;

  // --- legs (far side first, in shade)
  const legPairs = look.plan === 'quad'
    ? [[bx + 2, 0], [bx + bw - L.thick - 2, Math.PI]]
    : look.plan === 'biped' ? [[bx + Math.round(bw * 0.3), 0]] : [];
  const drawLeg = (x, phase, far) => {
    let dx = 0, lift = 0;
    if (walk !== null && walk !== undefined) { dx = Math.round(Math.sin(walk + phase) * 1.4); lift = Math.cos(walk + phase) > 0.6 ? 1 : 0; }
    if (pose.air === 'up') { lift = 2; dx = far ? -1 : 1; }
    if (pose.air === 'down') { dx = far ? 1 : -1; }
    if (pose.swim) { dx = Math.round(Math.sin((walk || 0) + phase) * 2); lift = 1; }
    const top = by + bh - 2;
    const len = H - top - lift;
    const c = far ? SHADE : BASE;
    g.rect(x + (dx > 0 ? 0 : 0), top, L.thick, Math.max(1, len - 1), c);
    g.rect(x + dx, top + len - 1, L.thick + (look.plan === 'biped' ? 1 : 0), 1, c);   // foot
    if (f.includes('claws') && !far) g.set(x + dx + L.thick + 1, top + len - 1, HORN);
  };
  for (const [x, ph] of legPairs) drawLeg(x + 1, ph + Math.PI, true);

  // --- tail
  const tailY = by + Math.round(bh * 0.35);
  const wave = walk !== null && walk !== undefined ? Math.sin(walk * 0.5) : 0;
  for (let i = 0; i < look.tail.len; i++) {
    const k = i / look.tail.len;
    const t = Math.max(1, Math.round(look.tail.thick * (1 - k)));
    const y = tailY + Math.round(look.tail.rise * k * 2 + wave * k * 1.2) - Math.floor(t / 2) + Math.round(k * k * 2);
    g.rect(bx - i, y, 1, t, BASE);
  }
  if (f.includes('tailspikes')) {
    const ex = bx - look.tail.len + 1, ey = tailY + Math.round(look.tail.rise * 2) + 1;
    g.set(ex, ey - 2, HORN); g.set(ex + 1, ey - 3, HORN); g.set(ex + 2, ey - 2, HORN); g.set(ex + 2, ey - 3, HORN);
  }

  // --- body
  if (f.includes('plates')) {
    const n = Math.floor((bw - 4) / 3);
    for (let i = 0; i < n; i++) {
      const px = bx + 2 + i * 3;
      const hgt = 2 + Math.round(Math.sin((i + 0.5) / n * Math.PI) * 2);
      for (let j = 0; j < hgt; j++) g.rect(px + (j > hgt / 2 ? 0 : 0), by - j, Math.max(1, 3 - Math.floor(j * 2 / hgt) * 1), 1, ACC);
    }
  }
  g.ellipse(bx, by, bw, bh, BASE);
  // belly and top highlight
  for (let x = bx; x < bx + bw; x++) {
    let top = -1;
    for (let y = by; y < by + bh; y++) {
      if (g.get(x, y) !== BASE) continue;
      if (top < 0) { top = y; g.set(x, y, LIGHT); }
      if (y >= by + bh * 0.62) g.set(x, y, BELLY);
    }
  }
  if (f.includes('stripes')) for (let x = bx + 1; x < bx + bw - 1; x += 3) for (let y = by + 1; y < by + bh * 0.5; y++) if (g.get(x, y) === BASE) g.set(x, y, SHADE);
  if (f.includes('spots')) for (let x = bx; x < bx + bw; x++) for (let y = by; y < by + bh * 0.6; y++) if (g.get(x, y) === BASE && hash2(x, y, 7) < 0.14) g.set(x, y, SHADE);

  // --- neck and head
  let hx, hy;
  if (look.plan === 'swimmer') {
    let nx = bx + bw - 2, ny = by + 1;
    for (let i = 0; i < look.neck; i++) { g.rect(nx, ny, 2, 2, BASE); nx += 1; ny -= i % 2 === 0 ? 1 : 0; }
    hx = nx; hy = ny - 1 + (HD.dy + 3);
  } else if (look.plan === 'quad') {
    hx = bx + bw - 2 + look.neck; hy = by + HD.dy;
    g.rect(bx + bw - 3, hy + 1, look.neck + 3, Math.max(2, HD.h - 2), BASE);
  } else {
    hx = bx + bw - 2 + look.neck; hy = by + HD.dy;
    g.rect(bx + bw - 3, hy + HD.h - 2, look.neck + 3, by - hy - HD.h + 5, BASE);
  }
  const lunge = pose.jaw ? 1 : 0;
  hx += lunge;
  if (f.includes('frill')) { g.ellipse(hx - 3, hy - 2, 6, HD.h + 1, ACC); g.set(hx - 2, hy - 2, HORN); g.set(hx, hy - 3, HORN); }
  g.rect(hx, hy + 1, HD.w, HD.h - 1, BASE);
  g.rect(hx + 1, hy, HD.w - 2, 1, BASE);
  g.set(hx + HD.w - 1, hy + 1, BASE);
  // lower jaw & mouth
  const jaw = pose.jaw || 0;
  if (HD.h >= 3) {
    const my = hy + HD.h - 2;
    if (jaw) {
      g.rect(hx + 1, my + 1, HD.w - 2, jaw, T);
      g.rect(hx + 1, my + jaw, HD.w - 1, 1, MOUTH);
      g.rect(hx + 1, my + 1 + jaw, HD.w - 2, 1, BELLY);
      for (let x = hx + 2; x < hx + HD.w - 1; x += 2) { g.set(x, my + 1, HORN); g.set(x + 1, my + jaw, HORN); }
    } else {
      g.rect(hx + Math.floor(HD.w * 0.45), my, Math.ceil(HD.w * 0.55), 1, SHADE);
      g.rect(hx + 1, my + 1, HD.w - 2, 1, BELLY);
    }
  }
  // eye
  const ex = hx + Math.max(1, Math.floor(HD.w * 0.4)), ey = hy + 1;
  if (HD.h >= 5) { g.set(ex, ey, EYEW); g.set(ex + 1, ey, EYE); } else g.set(ex, ey, EYE);
  if (f.includes('brow')) { g.set(ex - 1, ey - 1, SHADE); g.set(ex, ey - 1, SHADE); g.set(ex + 1, ey - 1, SHADE); }
  if (f.includes('crest')) { g.set(hx + 1, hy - 1, ACC); g.set(hx, hy - 1, ACC); g.set(hx - 1, hy, ACC); if (HD.w > 4) g.set(hx + 2, hy - 1, ACC); }
  if (f.includes('horns')) {
    g.set(ex + 1, hy - 1, HORN); g.set(ex + 2, hy - 2, HORN); g.set(ex + 3, hy - 3, HORN); g.set(ex + 4, hy - 3, HORN);
    g.set(hx + HD.w - 2, hy, HORN); g.set(hx + HD.w - 1, hy - 1, HORN);
  }
  if (f.includes('horns-small')) { g.set(ex, hy - 1, HORN); g.set(ex - 1, hy - 2, HORN); }

  // --- near legs, arms, flippers
  for (const [x, ph] of legPairs) drawLeg(x, ph, false);
  if (look.plan === 'biped') {
    const ax = bx + bw - 3, ay = by + Math.floor(bh * 0.45);
    const reach = pose.jaw ? 1 : 0;
    g.set(ax, ay, SHADE); g.set(ax + 1, ay + 1, SHADE); g.set(ax + 1 + reach, ay + 2, SHADE);
  }
  if (look.plan === 'swimmer') {
    const ph = walk || 0;
    for (const [fx, o] of [[bx + 2, 0], [bx + bw - 4, Math.PI]]) {
      const d = Math.round(Math.sin(ph + o) * 1.5);
      g.set(fx, by + bh, BASE); g.set(fx - 1 + d, by + bh + 1, BASE); g.set(fx - 2 + d, by + bh + 1, SHADE);
    }
  }
  g.outline();
  return g;
}

function gridToCanvas(g, colors, { rotate = false, flipY = false } = {}) {
  const pal = [null, colors.dark, colors.base, colors.belly, colors.accent, colors.horn || '#f2ead0', '#101010', '#ffffff',
    shadeHex(colors.base, -0.28), '#c0283a', shadeHex(colors.base, 0.22)];
  const W = rotate ? g.h : g.w, H = rotate ? g.w : g.h;
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
    const v = g.a[y * g.w + x];
    if (!v) continue;
    ctx.fillStyle = pal[v];
    let px = x, py = flipY ? g.h - 1 - y : y;
    if (rotate) { const nx = py, ny = g.w - 1 - x; px = nx; py = ny; }   // 90° counter-clockwise: head up, belly right
    ctx.fillRect(px, py, 1, 1);
  }
  return c;
}

function flipX(src) {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d');
  ctx.translate(src.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(src, 0, 0);
  return c;
}

function silhouette(src, color) {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return c;
}

const WALK = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];

/** All poses of one look: {pose: [rightCanvas, leftCanvas]} plus white flash versions. */
export function bakeDino(look) {
  const poses = {
    idle0: { walk: null }, idle1: { walk: null, bob: 1 },
    walk0: { walk: WALK[0] }, walk1: { walk: WALK[1] }, walk2: { walk: WALK[2] }, walk3: { walk: WALK[3] },
    jump: { walk: null, air: 'up' }, fall: { walk: null, air: 'down' },
    attack: { walk: null, jaw: look.head.h >= 5 ? 2 : 1 },
    swim0: { walk: 0, swim: true }, swim1: { walk: Math.PI, swim: true },
  };
  const out = {};
  for (const [name, pose] of Object.entries(poses)) {
    const g = rasterDino(look, pose);
    const r = gridToCanvas(g, look.colors);
    out[name] = [r, flipX(r)];
    if (name === 'walk0' || name === 'walk2') {
      const cr = gridToCanvas(g, look.colors, { rotate: true });
      out[name === 'walk0' ? 'climb0' : 'climb1'] = [cr, flipX(cr)];
    }
    if (name === 'idle0') {
      const d = gridToCanvas(g, look.colors, { flipY: true });
      out.dead = [d, flipX(d)];
    }
  }
  out.flash = {};
  for (const k of ['idle0', 'walk0', 'walk2', 'attack', 'jump', 'fall', 'swim0']) out.flash[k] = out[k].map((c) => silhouette(c, '#ffffff'));
  return out;
}

// ------------------------------------------------------------------------ tiles
export function bakeTiles() {
  const variants = 4;
  const atlas = {};
  TILE_DEFS.forEach((d, id) => {
    if (!d.colors) return;
    atlas[id] = [];
    for (let v = 0; v < variants; v++) {
      const c = makeCanvas(TILE, TILE);
      const ctx = c.getContext('2d');
      const [base, dark, light] = d.colors;
      const px = (x, y, col) => { ctx.fillStyle = col; ctx.fillRect(x, y, 1, 1); };
      const r = (x, y) => hash2(x + v * 17, y + id * 31, 99);
      if (d.key === 'trunk') {
        ctx.fillStyle = base; ctx.fillRect(2, 0, 4, 8);
        for (let y = 0; y < 8; y++) { px(2, y, dark); if (r(1, y) < 0.4) px(4, y, dark); px(5, y, light); }
      } else if (d.key === 'leaves') {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const edge = (x === 0 || x === 7 || y === 0 || y === 7) && r(x, y) < 0.35;
          if (edge) continue;
          px(x, y, r(x, y) < 0.2 ? light : r(x + 9, y) < 0.3 ? dark : base);
        }
      } else if (d.key === 'bonewall') {
        ctx.fillStyle = '#5a4e3a'; ctx.fillRect(0, 0, 8, 8);
        for (const yy of [1, 5]) { ctx.fillStyle = base; ctx.fillRect(0, yy, 8, 2); px(0, yy, light); px(7, yy + 1, dark); px(3 + v % 2, yy, light); }
        px(1, 0, base); px(6, 4, base); px(2, 7, base);
      } else if (d.key === 'hideplat') {
        ctx.fillStyle = base; ctx.fillRect(0, 0, 8, 3);
        ctx.fillStyle = light; ctx.fillRect(0, 0, 8, 1);
        ctx.fillStyle = dark; ctx.fillRect(0, 3, 8, 1);
        px(1, 4, '#e8dfc0'); px(6, 4, '#e8dfc0'); px(1, 5, '#b8ac88'); px(6, 5, '#b8ac88');
      } else {
        ctx.fillStyle = base; ctx.fillRect(0, 0, 8, 8);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          const n = r(x, y);
          if (n < 0.12) px(x, y, dark); else if (n > 0.92) px(x, y, light);
        }
        if (d.key === 'stone' || d.key === 'bedrock' || d.key === 'redrock') { ctx.fillStyle = dark; ctx.fillRect(0, 7, 8, 1); ctx.fillRect(7, 0, 1, 8); if (d.key === 'redrock') { ctx.fillStyle = light; ctx.fillRect(0, 3 + (v % 2), 8, 1); } }
      }
      atlas[id].push(c);
      if (d.top) {
        // "top" version: grass or moss on the exposed surface
        const t = makeCanvas(TILE, TILE);
        const tc = t.getContext('2d');
        tc.drawImage(c, 0, 0);
        const [g0, g1, g2] = d.top;
        for (let x = 0; x < 8; x++) {
          const depth = 2 + (r(x, 50) < 0.5 ? 1 : 0);
          for (let y = 0; y < depth; y++) { tc.fillStyle = y === 0 ? g2 : y === depth - 1 ? g1 : g0; tc.fillRect(x, y, 1, 1); }
        }
        atlas[`${id}top`] = atlas[`${id}top`] || [];
        atlas[`${id}top`].push(t);
      }
    }
  });
  return atlas;
}

// ------------------------------------------------------------------------ structures & props
function fromRows(rows, pal) {
  const h = rows.length, w = Math.max(...rows.map((r) => r.length));
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  for (let y = 0; y < h; y++) for (let x = 0; x < rows[y].length; x++) {
    const ch = rows[y][x];
    if (ch === '.' || ch === ' ' || !pal[ch]) continue;
    ctx.fillStyle = pal[ch];
    ctx.fillRect(x, y, 1, 1);
  }
  return c;
}

export function bakeProps() {
  const P = {};
  // tent 32×24 (4×3 tiles)
  {
    const c = makeCanvas(32, 24), x = c.getContext('2d');
    const px = (a, b, col) => { x.fillStyle = col; x.fillRect(a, b, 1, 1); };
    for (let y = 2; y < 24; y++) {
      const half = Math.floor((y - 2) * 0.72) + 1;
      for (let i = -half; i <= half; i++) {
        const xx = 16 + i;
        if (xx < 0 || xx > 31) continue;
        const edge = Math.abs(i) === half;
        const col = edge ? '#3a220e' : ((xx + (y >> 2)) % 6 === 0 ? '#8a5a32' : (i < 0 ? '#b07a48' : '#c89060'));
        px(xx, y, col);
      }
    }
    // entrance
    for (let y = 13; y < 24; y++) { const hw = Math.floor((y - 13) * 0.45) + 1; for (let i = -hw; i <= hw; i++) px(16 + i, y, '#1e120a'); }
    // bone poles
    for (const [a, b] of [[15, 0], [16, 0], [17, 1], [14, 1]]) px(a, b, '#f2ead0');
    for (let i = 0; i < 4; i++) { px(4 + i * 7, 23, '#f2ead0'); }
    x.fillStyle = '#f2ead0'; x.fillRect(9, 9, 1, 1); x.fillRect(22, 9, 1, 1);
    P.tente = [c];
  }
  // fire 16×16, 3 frames
  P.feu = [0, 1, 2].map((f) => {
    const c = makeCanvas(16, 16), x = c.getContext('2d');
    const px = (a, b, col) => { x.fillStyle = col; x.fillRect(a, b, 1, 1); };
    // stones & bones
    for (let i = 0; i < 16; i += 3) { px(i, 15, '#6a6a74'); px(i + 1, 15, '#8a8a94'); px(i + 1, 14, '#6a6a74'); }
    x.fillStyle = '#e8dfc0'; x.fillRect(3, 13, 10, 1); x.fillStyle = '#b8ac88'; x.fillRect(5, 12, 7, 1);
    // flames
    const cols = ['#ffe070', '#ffa030', '#e04a20'];
    for (let y = 2; y < 12; y++) {
      const w = Math.round((12 - y) * 0.45 + Math.sin((y + f * 2) * 1.3) * 0.8);
      for (let i = -w; i <= w; i++) {
        const k = Math.abs(i) / Math.max(1, w);
        px(8 + i + (y < 6 ? (f - 1) : 0), y, cols[k < 0.4 && y > 5 ? 0 : k < 0.8 ? 1 : 2]);
      }
    }
    return c;
  });
  // nest 24×8
  P.nid = [fromRows([
    '........................',
    '.......aa..bb..aa.......',
    '......acca.bccb.acca....',
    '..tt.tacca.bccb.accat.t.',
    '.tuttutaatttbbttaattutt.',
    'tututtuttututtuttuttutut',
    '.tuttutuututtutuututtut.',
    '..tttttttttttttttttttt..',
  ], { a: '#9ab87a', c: '#d4e8b8', b: '#d8c890', t: '#6a4a28', u: '#8a6a3a' })];
  // bone pile 10×5
  P.bones = [fromRows([
    '...ab.....',
    '.aabbba.a.',
    'abbaabbbab',
    'baabbaabba',
    '.bbbbbbbb.',
  ], { a: '#f2ead0', b: '#c8bc98' })];
  return P;
}

/** Resource icon from its 8×8 map (data/resources.js). */
export function bakeIcon(res) {
  return fromRows(res.icon, res.palette);
}
