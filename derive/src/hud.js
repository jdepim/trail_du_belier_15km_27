// Canvas HUD + bitmap pixel font (capitals, digits, French accents, punctuation, arrows, ⌂).
//
//   drawText(ctx, str, x, y, color, opts?) -> width   y = cap top; opts { align 'left'|'center'|'right',
//        outline (colour) | shadow (true | colour | false), alpha, scale (integer) }. Outlined / shadowed
//        labels are cached as small canvases (one drawImage per label, no per-frame string work).
//   measureText(str) -> width in px (scale 1); hasGlyphs(str) -> every character drawable
//   new Hud(game)
//     update(dt)                 fixed tick: timers, toasts, discovery cache, zone entries, warning chirps
//     draw(ctx)                  whole HUD at internal resolution (reads game.view: w, h, camX, camY)
//     toast(text, opts?)         queued message { color, life, icon } (3 on screen, duplicates refreshed)
//     banner(title, sub?, opts?) big centred title (2× font) + sub line; opts.icon = sprite name
//     tip(line1, line2?, opts?)  onboarding panel { key, life }; waits for banners, one at a time
//     cancelTip(key), tipActive
//     zoneName(name)             place name at the top centre (also shown automatically on zone entry)
//     reset()                    new life / world: clear messages
// Layout (DESIGN §10): bars + charges + salvage top-left, zone / banner / warnings / tip / toasts in the
// top-centre column, radar arrows (RADAR.maxArrows nearest places) on the screen edges; the top-right buttons and both bottom thumb
// areas (HUD_LAYOUT) stay clear.
import { ZONES, POIS, PLAYER } from './config.js';
import { drawSprite } from './sprites.js';
import { poiDiscovered } from './meta.js';
import { HUD_LAYOUT as HL, RADAR } from './render-config.js';

// 5x7 glyphs ('#' = pixel). Narrow glyphs are narrower strings.
const G = {
  A: '.###.|#...#|#...#|#####|#...#|#...#|#...#', B: '####.|#...#|#...#|####.|#...#|#...#|####.',
  C: '.###.|#...#|#....|#....|#....|#...#|.###.', D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
  E: '#####|#....|#....|####.|#....|#....|#####', F: '#####|#....|#....|####.|#....|#....|#....',
  G: '.###.|#...#|#....|#.###|#...#|#...#|.####', H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
  I: '###|.#.|.#.|.#.|.#.|.#.|###', J: '..###|...#.|...#.|...#.|#..#.|#..#.|.##..',
  K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#', L: '#....|#....|#....|#....|#....|#....|#####',
  M: '#...#|##.##|#.#.#|#.#.#|#...#|#...#|#...#', N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
  O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.', P: '####.|#...#|#...#|####.|#....|#....|#....',
  Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#', R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
  S: '.####|#....|#....|.###.|....#|....#|####.', T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
  U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.', V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
  W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#', X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
  Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..', Z: '#####|....#|...#.|..#..|.#...|#....|#####',
  'Œ': '.####|#.#..|#.#..|#.###|#.#..|#.#..|.####',
  0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.', 1: '.#.|##.|.#.|.#.|.#.|.#.|###',
  2: '.###.|#...#|....#|...#.|..#..|.#...|#####', 3: '####.|....#|....#|.###.|....#|....#|####.',
  4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.', 5: '#####|#....|####.|....#|....#|#...#|.###.',
  6: '.###.|#....|#....|####.|#...#|#...#|.###.', 7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
  8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.', 9: '.###.|#...#|#...#|.####|....#|....#|.###.',
  '.': '.|.|.|.|.|.|#', ',': '..|..|..|..|##|.#|#.', '!': '#|#|#|#|#|.|#', '?': '.###.|#...#|....#|...#.|..#..|.....|..#..',
  ':': '.|.|#|.|.|#|.', ';': '..|..|.#|..|..|.#|#.', "'": '#|#|.|.|.|.|.', '’': '#|#|.|.|.|.|.', '"': '#.#|#.#|...|...|...|...|...',
  '-': '...|...|...|###|...|...|...', '+': '.....|..#..|..#..|#####|..#..|..#..|.....', '/': '....#|...#.|...#.|..#..|.#...|.#...|#....',
  '(': '.#|#.|#.|#.|#.|#.|.#', ')': '#.|.#|.#|.#|.#|.#|#.', '%': '##..#|##..#|...#.|..#..|.#...|#..##|#..##',
  '×': '.....|#...#|.#.#.|..#..|.#.#.|#...#|.....', '<': '...#|..#.|.#..|#...|.#..|..#.|...#', '>': '#...|.#..|..#.|...#|..#.|.#..|#...',
  '=': '....|....|####|....|####|....|....', '_': '....|....|....|....|....|....|####', '—': '......|......|......|######|......|......|......',
  '·': '.|.|.|#|.|.|.', '*': '.....|#.#.#|.###.|#####|.###.|#.#.#|.....', '#': '.#.#.|#####|.#.#.|.#.#.|.#.#.|#####|.#.#.',
  '…': '.....|.....|.....|.....|.....|.....|#.#.#', '⌂': '..#..|.###.|#####|#...#|#.#.#|#.#.#|#####',
};
G['↑'] = '..#..|.###.|#.#.#|..#..|..#..|..#..|..#..';
G['↓'] = '..#..|..#..|..#..|..#..|#.#.#|.###.|..#..';
G['←'] = '.......|..#....|.#.....|#######|.#.....|..#....|.......';
G['→'] = '.......|....#..|.....#.|#######|.....#.|....#..|.......';
G['≈'] = '.....|.##.#|#..#.|.....|.##.#|#..#.|.....';
G['−'] = G['-']; G['–'] = G['-']; G['«'] = '.....|..#.#|.#.#.|#.#..|.#.#.|..#.#|.....'; G['»'] = '.....|#.#..|.#.#.|..#.#|.#.#.|#.#..|.....';
// accented capitals = base glyph + mark (3 px wide, 2 rows above or below the glyph)
const MARKS = { acute: '..#|.#.', grave: '#..|.#.', circ: '.#.|#.#', diaer: '...|#.#', ced: '.#.|##.' };
const ACCENTS = {
  'É': ['E', 'acute'], 'È': ['E', 'grave'], 'Ê': ['E', 'circ'], 'Ë': ['E', 'diaer'], 'À': ['A', 'grave'], 'Â': ['A', 'circ'],
  'Ç': ['C', 'ced'], 'Ô': ['O', 'circ'], 'Î': ['I', 'circ'], 'Ï': ['I', 'diaer'], 'Ù': ['U', 'grave'], 'Û': ['U', 'circ'], 'Ü': ['U', 'diaer'],
  'Ö': ['O', 'diaer'], 'Ä': ['A', 'diaer'],
};

const CELL_W = 7, CELL_H = 11; // 2 rows of accent space above, 2 below
const CHARS = [...Object.keys(G), ...Object.keys(ACCENTS)];
const INDEX = new Map(CHARS.map((c, i) => [c, i]));
const WIDTH = new Map();
for (const c of CHARS) WIDTH.set(c, G[ACCENTS[c] ? ACCENTS[c][0] : c].split('|')[0].length);
const atlases = new Map();

function atlas(color) {
  let a = atlases.get(color);
  if (a) return a;
  a = document.createElement('canvas');
  a.width = CHARS.length * CELL_W; a.height = CELL_H;
  const g = a.getContext('2d');
  g.fillStyle = color;
  CHARS.forEach((c, idx) => {
    const ox = idx * CELL_W;
    const rows = G[ACCENTS[c] ? ACCENTS[c][0] : c].split('|');
    rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === '#') g.fillRect(ox + x, y + 2, 1, 1); });
    if (ACCENTS[c]) {
      const m = MARKS[ACCENTS[c][1]].split('|');
      const mx = ox + Math.floor((WIDTH.get(c) - 3) / 2);
      const my = ACCENTS[c][1] === 'ced' ? 9 : 0;
      m.forEach((r, y) => { for (let x = 0; x < 3; x++) if (r[x] === '#') g.fillRect(mx + x, my + y, 1, 1); });
    }
  });
  atlases.set(color, a);
  return a;
}

function normalize(str) { return String(str).toUpperCase(); }

/** True when every character of str (uppercased) has a glyph (spaces included). */
export function hasGlyphs(str) {
  for (const c of normalize(str)) if (c !== ' ' && !INDEX.has(c)) return false;
  return true;
}

/** Width in pixels of a string in the bitmap font (scale 1). */
export function measureText(str) {
  let w = 0;
  for (const c of normalize(str)) w += c === ' ' ? 3 : (WIDTH.get(c) ?? 3) + 1;
  return Math.max(0, w - 1);
}

function glyphPass(ctx, s, cx, y, col) {
  const a = atlas(col);
  let px = cx;
  for (const c of s) {
    if (c === ' ') { px += 3; continue; }
    const i = INDEX.get(c);
    if (i === undefined) { px += 4; continue; }
    ctx.drawImage(a, i * CELL_W, 0, CELL_W, CELL_H, px, y - 2, CELL_W, CELL_H);
    px += WIDTH.get(c) + 1;
  }
}

// Finished labels (fill + outline or shadow) cached as canvases, keyed style -> colour -> raw string
// (no string building per frame); a colour's map is dropped past LABEL_MAX entries.
const LABELS = { outline: new Map(), shadow: new Map() };
const LABEL_MAX = 200;

function cachedLabel(kind, styleCol, color, str) {
  let byColor = LABELS[kind].get(styleCol);
  if (!byColor) { byColor = new Map(); LABELS[kind].set(styleCol, byColor); }
  let byText = byColor.get(color);
  if (!byText) { byText = new Map(); byColor.set(color, byText); }
  let e = byText.get(str);
  if (e) return e;
  if (byText.size >= LABEL_MAX) byText.clear();
  const s = normalize(str);
  const w = measureText(s);
  const c = document.createElement('canvas');
  const pad = kind === 'outline' ? 1 : 0;
  c.width = Math.max(1, w + 2 * pad + 5);
  c.height = CELL_H + 2 * pad + 1;
  const g = c.getContext('2d');
  const ox = pad, oy = pad + 2;
  if (kind === 'outline') {
    glyphPass(g, s, ox - 1, oy, styleCol); glyphPass(g, s, ox + 1, oy, styleCol);
    glyphPass(g, s, ox, oy - 1, styleCol); glyphPass(g, s, ox, oy + 1, styleCol);
    glyphPass(g, s, ox + 1, oy + 1, styleCol);
  } else glyphPass(g, s, ox + 1, oy + 1, styleCol);
  glyphPass(g, s, ox, oy, color);
  e = { canvas: c, w, ox, oy };
  byText.set(str, e);
  return e;
}


/** Draw text; returns its width (scaled). See the header for opts. */
export function drawText(ctx, str, x, y, color = '#ffffff', opts = NO_OPTS) {
  const prevAlpha = ctx.globalAlpha;
  if (opts.alpha !== undefined) ctx.globalAlpha = prevAlpha * opts.alpha;
  const k = opts.scale > 1 ? opts.scale | 0 : 1;
  let w;
  if (opts.outline || opts.shadow !== false) {
    const e = opts.outline
      ? cachedLabel('outline', opts.outline, color, str)
      : cachedLabel('shadow', typeof opts.shadow === 'string' ? opts.shadow : '#05060b', color, str);
    w = e.w * k;
    const cx = Math.round(opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x);
    if (k === 1) ctx.drawImage(e.canvas, cx - e.ox, Math.round(y) - e.oy);
    else ctx.drawImage(e.canvas, 0, 0, e.canvas.width, e.canvas.height, cx - e.ox * k, Math.round(y) - e.oy * k, e.canvas.width * k, e.canvas.height * k);
  } else {
    const s = normalize(str);
    w = measureText(s);
    const cx = Math.round(opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x);
    glyphPass(ctx, s, cx, Math.round(y), color);
  }
  ctx.globalAlpha = prevAlpha;
  return w;
}
const NO_OPTS = {};

// ------------------------------------------------------------------ helpers (pure, unit-tested)

/** Cached number -> text: the string is rebuilt only when a value changes. */
export class TextMemo {
  constructor(fmt) { this.fmt = fmt; this.a = NaN; this.b = NaN; this.s = ''; }
  get(a, b = 0) { if (a !== this.a || b !== this.b) { this.a = a; this.b = b; this.s = this.fmt(a, b); } return this.s; }
}

/** Distance labels, precomputed once: distLabel(px) -> '125 m' (rounded to RADAR.distStep metres). */
const DIST_LABELS = [];
for (let m = 0; m <= RADAR.maxDist; m += RADAR.distStep) DIST_LABELS.push(m + ' m');
export function distLabel(px) {
  const i = Math.round(px / 8 / RADAR.distStep);
  return DIST_LABELS[Math.max(0, Math.min(DIST_LABELS.length - 1, i))];
}

/**
 * Radar arrow position on the screen border (out.x, out.y, out.edge 0 top / 1 right / 2 bottom / 3 left)
 * for a direction (dx, dy) seen from the screen point (cx, cy), inside the inset rectangle
 * [x0, x1] × [y0, y1], then slid along its edge out of the reserved corners:
 * top edge x ∈ [topMin, topMax] minus the message column ]topGap0, topGap1[ (pushed to its nearer side),
 * bottom x ∈ [botMin, botMax], left y ∈ [leftMin, leftMax], right y ∈ [rightMin, rightMax]
 * (lim = { x0, y0, x1, y1, topMin, topMax, topGap0, topGap1, botMin, botMax, leftMin, leftMax, rightMin, rightMax }).
 */
export function edgePoint(cx, cy, dx, dy, lim, out) {
  let t = Infinity;
  if (dx > 0) t = Math.min(t, (lim.x1 - cx) / dx);
  if (dx < 0) t = Math.min(t, (lim.x0 - cx) / dx);
  if (dy > 0) t = Math.min(t, (lim.y1 - cy) / dy);
  if (dy < 0) t = Math.min(t, (lim.y0 - cy) / dy);
  if (!Number.isFinite(t)) t = 0;
  let x = cx + dx * t, y = cy + dy * t;
  const eps = 0.5;
  let edge;
  if (y <= lim.y0 + eps) {
    edge = 0; y = lim.y0;
    if (x > lim.topGap0 && x < lim.topGap1) x = x - lim.topGap0 < lim.topGap1 - x ? lim.topGap0 : lim.topGap1;
    x = Math.max(lim.topMin, Math.min(lim.topMax, x));
  }
  else if (y >= lim.y1 - eps) { edge = 2; x = Math.max(lim.botMin, Math.min(lim.botMax, x)); y = lim.y1; }
  else if (x >= lim.x1 - eps) { edge = 1; y = Math.max(lim.rightMin, Math.min(lim.rightMax, y)); x = lim.x1; }
  else { edge = 3; y = Math.max(lim.leftMin, Math.min(lim.leftMax, y)); x = lim.x0; }
  out.x = x; out.y = y; out.edge = edge;
  return out;
}

// ------------------------------------------------------------------ HUD

const O = { outline: '#05060b' };
const O_CENTER = { outline: '#05060b', align: 'center' };
const O_RIGHT = { outline: '#05060b', align: 'right' };
const BIG_A = { outline: '#05060b', align: 'center', scale: 2, alpha: 1 };   // alpha set before each use
const CENTER_A = { outline: '#05060b', align: 'center', alpha: 1 };
const WARN = [
  { key: 'o2', text: 'O2 BAS', color: '#6fe6ff' },
  { key: 'heat', text: 'SURCHAUFFE', color: '#ff7a2a' },
  { key: 'grav', text: 'GRAVITÉ CRITIQUE', color: '#c08aff' },
  { key: 'fuel', text: 'CARBURANT VIDE', color: '#ffb347' },
  { key: 'storm', text: 'TEMPÊTE IONIQUE', color: '#5fe8d0' },
];
const MAX_TOASTS = 3, MAX_QUEUE = 8;
const TAU = Math.PI * 2;

export class Hud {
  constructor(game) {
    this.game = game;
    this.clock = 0;
    this.toasts = []; this.queue = [];
    this.bannerT = 0; this.bannerTitle = ''; this.bannerSub = ''; this.bannerIcon = null;
    this.zoneT = 0; this.zoneText = ''; this.zoneLast = ''; this.zoneLastAt = -1e9; this.zoneId = -1;
    this.tipData = null; this.tipQueue = [];
    this.hullShown = 100; this.bankShown = -1; this.bankPulse = 0; this.carryPulse = 0; this.lastCarry = 0;
    this.warnOn = new Uint8Array(WARN.length);
    this.discovered = new Uint8Array(POIS.length);
    this.discT = 0;
    this.txt = {
      salvage: new TextMemo((a, b) => (b > 0 ? `FERRAILLE ${a} (+${b})` : `FERRAILLE ${a}`)),
    };
    this._pt = { x: 0, y: 0, edge: 0 };
    this._lim = { x0: 0, y0: 0, x1: 0, y1: 0, topMin: 0, topMax: 0, topGap0: 0, topGap1: 0, botMin: 0, botMax: 0, leftMin: 0, leftMax: 0, rightMin: 0, rightMax: 0 };
    this._placed = new Float32Array(POIS.length * 2);
    this._dist = new Float32Array(POIS.length);
    this.blockBottom = 40; this.blockRight = 110;
  }

  reset() {
    this.toasts.length = 0; this.queue.length = 0;
    this.tipData = null; this.tipQueue.length = 0;
    this.bannerT = 0; this.zoneT = 0; this.zoneId = -1;
    this.warnOn.fill(0);
    const p = this.game.player;
    this.hullShown = p ? p.hull : 100;
    this.bankShown = -1;
    this.discT = 0;
  }

  /** Short centred message, queued. opts: { color, life, icon } */
  toast(text, opts) {
    const o = opts || NO_OPTS;
    const life = o.life ?? HL.toastLife;
    const existing = this.toasts.find((t) => t.text === text) || this.queue.find((t) => t.text === text);
    if (existing) { existing.t = Math.min(existing.t, 0.15); existing.life = life; return; }
    const t = { text, color: o.color || '#e8eef8', t: 0, life, icon: o.icon || null };
    if (this.toasts.length < MAX_TOASTS) this.toasts.push(t);
    else { this.queue.push(t); if (this.queue.length > MAX_QUEUE) this.queue.shift(); }
  }

  banner(title, sub = '', opts) {
    this.bannerTitle = title; this.bannerSub = sub || ''; this.bannerIcon = (opts && opts.icon) || null;
    this.bannerT = HL.bannerLife;
    this.zoneT = 0;
  }

  zoneName(name) {
    if (!name) return;
    if (this.zoneT > 0 && this.zoneText === name) return;
    this.zoneText = name; this.zoneT = HL.zoneLife;
    this.zoneLast = name; this.zoneLastAt = this.clock;
  }

  tip(a, b = '', opts) {
    const o = opts || NO_OPTS;
    const t = { a, b: b || '', key: o.key || a, t: 0, life: o.life ?? HL.tipLife };
    if (this.tipData && this.tipData.key === t.key) { this.tipData.t = Math.min(this.tipData.t, 0.3); return; }
    if (this.tipQueue.some((q) => q.key === t.key)) return;
    if (!this.tipData) { this.tipData = t; return; }
    this.tipQueue.push(t);
    if (this.tipQueue.length > 4) this.tipQueue.shift();
    const cur = this.tipData;
    if (cur.t >= 3) cur.life = Math.min(cur.life, cur.t + 0.4);
  }

  cancelTip(key) {
    this.tipQueue = this.tipQueue.filter((q) => q.key !== key);
    const cur = this.tipData;
    if (cur && cur.key === key) {
      if (cur.t < 0.3) this.tipData = this.tipQueue.length ? this.tipQueue.shift() : null;
      else cur.life = Math.min(cur.life, cur.t + 0.4);
    }
  }

  get tipActive() { return !!this.tipData; }

  update(dt) {
    const g = this.game, p = g.player;
    this.clock += dt;
    if (this.tipData && this.bannerT <= 0) {
      this.tipData.t += dt;
      if (this.tipData.t >= this.tipData.life) this.tipData = this.tipQueue.length ? this.tipQueue.shift() : null;
    }
    for (const t of this.toasts) t.t += dt;
    for (let i = this.toasts.length - 1; i >= 0; i--) if (this.toasts[i].t >= this.toasts[i].life) this.toasts.splice(i, 1);
    while (this.toasts.length < MAX_TOASTS && this.queue.length) this.toasts.push(this.queue.shift());
    this.bannerT = Math.max(0, this.bannerT - dt);
    this.zoneT = Math.max(0, this.zoneT - dt);
    this.bankPulse = Math.max(0, this.bankPulse - dt);
    this.carryPulse = Math.max(0, this.carryPulse - dt);
    if (!p) return;
    // lagging hull trail
    if (this.hullShown > p.hull) this.hullShown = Math.max(p.hull, this.hullShown - dt * Math.max(25, (this.hullShown - p.hull) * 2.5));
    else this.hullShown = p.hull;
    // banked salvage counts up after a deposit
    const bank = g.save ? g.save.salvage : 0;
    if (this.bankShown < 0 || bank < this.bankShown) this.bankShown = bank;
    else if (bank > this.bankShown) { this.bankShown = Math.min(bank, this.bankShown + Math.max(1, (bank - this.bankShown) * 6 * dt)); this.bankPulse = 0.5; }
    const carry = g.run ? g.run.salvage | 0 : 0;
    if (carry > this.lastCarry) this.carryPulse = 0.35;
    this.lastCarry = carry;
    // discovery cache for the radar
    this.discT -= dt;
    if (this.discT <= 0 && g.fog) {
      this.discT = RADAR.refresh;
      for (let i = 0; i < POIS.length; i++) if (!this.discovered[i] && poiDiscovered(g.fog, POIS[i])) this.discovered[i] = 1;
    }
    // zone entries
    if (g.world && !p.dead) {
      const z = g.world.zoneAt(p.x, p.y);
      if (z !== this.zoneId) {
        this.zoneId = z;
        const name = ZONES[z] ? ZONES[z].name : '';
        if (name && (name !== this.zoneLast || this.clock - this.zoneLastAt > 25)) this.zoneName(name);
      }
    }
    // warnings: chirp on onset (the O2 alarm has its own loop)
    const h = g.hazards;
    for (let i = 0; i < WARN.length; i++) {
      const on = this._warnActive(i, p, h) ? 1 : 0;
      if (on && !this.warnOn[i] && i !== 0 && g.audio && g.state === 'PLAYING') g.audio.play('warning', WARN_SND);
      this.warnOn[i] = on;
    }
  }

  _warnActive(i, p, h) {
    if (p.dead) return false;
    switch (WARN[i].key) {
      case 'o2': return !!p.o2Low;
      case 'heat': return !!(h && h.heatAtPlayer > 0.5);
      case 'grav': return !!(h && h.gravCritical);
      case 'fuel': return !!p.fuelEmpty;
      case 'storm': return !!(h && h.inStorm);
      default: return false;
    }
  }

  draw(ctx) {
    const g = this.game, p = g.player;
    const view = g.view;
    if (!p || !view) return;
    const W = view.w, H = view.h;
    const safe = g.safe || NO_SAFE;
    const L = Math.max(HL.margin, safe.l + 4), T = Math.max(HL.margin - 1, safe.t + 3);

    this._vignette(ctx, W, H, p);
    const bottom = this._resources(ctx, L, T, p, g);
    this.blockBottom = bottom; this.blockRight = L + 118;
    if (!p.dead) this._radar(ctx, W, H, L, T, safe, p, g, view, this._topHalf(W));

    // top-centre column: zone / banner, warnings, tip, toasts
    let y = T + 1;
    if (this.bannerT > 0) y = this._banner(ctx, W, y);
    else if (this.zoneT > 0) {
      const a = Math.min(1, this.zoneT / 0.5, (HL.zoneLife - this.zoneT) / 0.3);
      BIG_A.alpha = a;
      drawText(ctx, this.zoneText, W / 2, y, '#e8f4ff', BIG_A);
      y += 20;
    } else y += 2;
    let wy = Math.max(y, T + 22);
    const blink = Math.floor(this.clock * HL.warnBlink * 2) % 2 === 0;
    for (let i = 0; i < WARN.length; i++) {
      if (!this.warnOn[i]) continue;
      drawText(ctx, WARN[i].text, W / 2, wy, blink ? WARN[i].color : '#ffffff', O_CENTER);
      wy += 10;
    }
    let ty = Math.max(wy + 4, T + 46);
    if (this.tipData && this.bannerT <= 0) ty = this._tip(ctx, W, ty) + 6;
    ty = Math.max(ty, Math.round(H * 0.3));
    for (const t of this.toasts) {
      const a = Math.min(1, t.t / 0.1, (t.life - t.t) / 0.35);
      const rise = Math.round(Math.min(1, t.t / 0.15) * -3);
      CENTER_A.alpha = a;
      if (t.icon) {
        const w = drawText(ctx, t.text, W / 2 + 7, ty + rise, t.color, CENTER_A);
        const pa = ctx.globalAlpha; ctx.globalAlpha = pa * a;
        drawSprite(ctx, t.icon, 0, W / 2 + 7 - w / 2 - 8, ty + rise + 3);
        ctx.globalAlpha = pa;
      } else drawText(ctx, t.text, W / 2, ty + rise, t.color, CENTER_A);
      ty += 12;
    }
    if (g.flags && g.flags.debug) {
      drawText(ctx, (g.fps | 0) + ' FPS', W - Math.max(HL.margin, safe.r + 4), H - 12, '#7fffd4', O_RIGHT);
    }
  }

  /** Half width of the top-centre column this frame (zone name / banner / warnings), for the radar. */
  _topHalf(W) {
    let half = HL.topGapHalf;
    if (this.bannerT > 0) {
      const tw = measureText(this.bannerTitle) * 2 + (this.bannerIcon ? 22 : 0), sw = this.bannerSub ? measureText(this.bannerSub) : 0;
      half = Math.max(half, Math.min(W - 16, Math.max(tw, sw) + 24) / 2 + 6);
    } else if (this.zoneT > 0) half = Math.max(half, measureText(this.zoneText) + 8);
    for (let i = 0; i < WARN.length; i++) if (this.warnOn[i]) half = Math.max(half, measureText(WARN[i].text) / 2 + 12);
    return half;
  }

  _vignette(ctx, W, H, p) {
    const low = !p.dead && p.hull > 0 && p.hull <= p.stats.maxHull * HL.lowHull;
    const hurt = p.hurtT > 0 ? p.hurtT / 0.25 : 0;
    const v = Math.max(hurt * HL.hurtFlash, low ? 0.2 + 0.14 * Math.sin(this.clock * 6) : 0);
    if (v <= 0.01) return;
    ctx.fillStyle = '#c0182e';
    for (let i = 0; i < 6; i++) {
      ctx.globalAlpha = v * (1 - i / 6) * 0.55;
      ctx.fillRect(0, i * 2, W, 2); ctx.fillRect(0, H - (i + 1) * 2, W, 2);
      ctx.fillRect(i * 2, 0, 2, H); ctx.fillRect(W - (i + 1) * 2, 0, 2, H);
    }
    ctx.globalAlpha = 1;
  }

  /** Bars, charges and salvage (top-left); returns the bottom of the block. */
  _resources(ctx, L, T, p, g) {
    const s = p.stats;
    const blinkLow = Math.floor(this.clock * 4) % 2 === 0;
    const hullLow = p.hull <= s.maxHull * HL.lowHull;
    let right = this._bar(ctx, L, T, 0, 'hud_hull', p.hull, s.maxHull, PLAYER.maxHull, hullLow && blinkLow ? BAR_HULL_HI : BAR_HULL, this.hullShown);
    right = Math.max(right, this._bar(ctx, L, T, 1, 'hud_o2', p.o2, s.o2Max, PLAYER.o2Max, p.o2Low && blinkLow ? BAR_O2_HI : BAR_O2));
    right = Math.max(right, this._bar(ctx, L, T, 2, 'hud_fuel', p.fuel, s.fuelMax, PLAYER.fuelMax, p.fuelEmpty && blinkLow ? BAR_FUEL_HI : BAR_FUEL));
    let y = T + 3 * HL.barGap + 1;
    // charges (once the Explosives are owned)
    if (g.save && g.save.items && g.save.items.explosives) {
      for (let i = 0; i < s.maxCharges; i++) drawSprite(ctx, i < p.charges ? 'hud_charge' : 'hud_charge_off', 0, right + 7 + i * 8, T + 4 + (i % 2));
    }
    // salvage: banked (+ carried)
    const bank = Math.round(this.bankShown < 0 ? (g.save ? g.save.salvage : 0) : this.bankShown);
    const carry = g.run ? g.run.salvage | 0 : 0;
    drawSprite(ctx, 'hud_salvage', 0, L + 4, y + 3);
    const col = this.bankPulse > 0 && Math.floor(this.bankPulse * 14) % 2 ? '#ffffff' : this.carryPulse > 0 ? '#fff2b0' : '#ffe07a';
    drawText(ctx, this.txt.salvage.get(bank, carry), L + 11, y, col, O);
    return y + 10;
  }

  /** One resource bar (row i); returns its right edge. lag = trailing value (hull). */
  _bar(ctx, L, T, i, icon, value, max, base, colors, lag) {
    const y = T + i * HL.barGap;
    drawSprite(ctx, icon, 0, L + 4, y + 3);
    const w = Math.round(HL.barW * Math.min(1.5, 0.75 + 0.25 * (max / base)));
    const x = L + 11;
    ctx.fillStyle = '#05060b'; ctx.fillRect(x - 1, y, w + 2, HL.barH + 2);
    ctx.fillStyle = colors[0]; ctx.fillRect(x, y + 1, w, HL.barH);
    const f = Math.max(0, Math.min(1, value / max));
    if (lag !== undefined) { ctx.fillStyle = '#ffd8d8'; ctx.fillRect(x, y + 1, Math.round(Math.max(0, Math.min(1, lag / max)) * w), HL.barH); }
    const fw = Math.round(f * w);
    ctx.fillStyle = colors[1]; ctx.fillRect(x, y + 1, fw, HL.barH);
    ctx.fillStyle = colors[2]; ctx.fillRect(x, y + 1, fw, 1);
    ctx.fillStyle = colors[3]; ctx.fillRect(x, y + HL.barH, fw, 1);
    ctx.fillStyle = '#05060b';
    for (let k = 1; k < 4; k++) ctx.fillRect(x + Math.round((w * k) / 4), y + HL.barH, 1, 1);
    return x + w;
  }

  _banner(ctx, W, y) {
    const a = Math.min(1, this.bannerT / 0.5, (HL.bannerLife - this.bannerT) / 0.35);
    const tw = measureText(this.bannerTitle) * 2, sw = this.bannerSub ? measureText(this.bannerSub) : 0;
    const pw = Math.min(W - 16, Math.max(tw + (this.bannerIcon ? 22 : 0), sw) + 24), ph = this.bannerSub ? 34 : 22;
    const px = Math.round(W / 2 - pw / 2);
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * a * 0.78;
    ctx.fillStyle = '#081222'; ctx.fillRect(px, y, pw, ph);
    ctx.globalAlpha = prev * a;
    ctx.fillStyle = '#2f8fb0';
    ctx.fillRect(px, y, pw, 1); ctx.fillRect(px, y + ph - 1, pw, 1);
    ctx.fillStyle = '#6fe6ff';
    ctx.fillRect(px - 1, y - 1, 4, 1); ctx.fillRect(px + pw - 3, y - 1, 4, 1); ctx.fillRect(px - 1, y + ph, 4, 1); ctx.fillRect(px + pw - 3, y + ph, 4, 1);
    let tx = W / 2;
    if (this.bannerIcon) { drawSprite(ctx, this.bannerIcon, 0, W / 2 - tw / 2 - 4, y + 11); tx += 8; }
    ctx.globalAlpha = prev;
    BIG_A.alpha = a; CENTER_A.alpha = a;
    drawText(ctx, this.bannerTitle, tx, y + 4, '#ffe9a8', BIG_A);
    if (this.bannerSub) drawText(ctx, this.bannerSub, W / 2, y + 22, '#bfe6ff', CENTER_A);
    return y + ph + 4;
  }

  _tip(ctx, W, y0) {
    const d = this.tipData;
    const a = Math.min(1, d.t / 0.25, (d.life - d.t) / 0.4);
    if (a <= 0) return y0;
    const wa = measureText(d.a), wb = d.b ? measureText(d.b) : 0;
    const pw = Math.min(W - 12, Math.max(wa, wb) + 16), ph = d.b ? 25 : 15;
    const px = Math.round(W / 2 - pw / 2), py = Math.round(y0 + (1 - Math.min(1, d.t / 0.25)) * -4);
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * a * 0.8;
    ctx.fillStyle = '#081222'; ctx.fillRect(px, py, pw, ph);
    ctx.globalAlpha = prev * a;
    ctx.fillStyle = '#1f5a74';
    ctx.fillRect(px, py, pw, 1); ctx.fillRect(px, py + ph - 1, pw, 1); ctx.fillRect(px, py, 1, ph); ctx.fillRect(px + pw - 1, py, 1, ph);
    ctx.fillStyle = '#6fe6ff';
    ctx.fillRect(px - 1, py - 1, 3, 1); ctx.fillRect(px + pw - 2, py - 1, 3, 1); ctx.fillRect(px - 1, py + ph, 3, 1); ctx.fillRect(px + pw - 2, py + ph, 3, 1);
    ctx.globalAlpha = prev;
    CENTER_A.alpha = a;
    drawText(ctx, d.a, W / 2, py + 4, '#bff4ff', CENTER_A);
    if (d.b) drawText(ctx, d.b, W / 2, py + 14, '#d8e2ee', CENTER_A);
    return py + ph;
  }

  /**
   * Edge arrows toward discovered / in-range places (the Albatros always): only the
   * RADAR.maxArrows nearest ones (the map shows the rest), never inside the top-centre column
   * while it holds text, never under the touch controls; an arrow that finds no free slot on
   * its edge is dropped rather than drawn over another.
   */
  _radar(ctx, W, H, L, T, safe, p, g, view, topHalf) {
    const gen = g.gen;
    if (!gen || !gen.pois) return;
    const pois = gen.pois;
    const inset = RADAR.inset;
    const lim = this._lim;
    const sr = Math.max(0, safe.r), sb = Math.max(0, safe.b);
    lim.x0 = L + inset; lim.x1 = W - sr - inset - 4; lim.y0 = T + inset; lim.y1 = H - sb - inset - 6;
    // the DOM touch controls are laid out in CSS px from the screen corners (input.js layout());
    // nothing to keep clear without a touch screen
    const k = g.input && !g.input.touchEnabled ? 0 : view.cssToInternal || 1;
    const sl = Math.max(0, safe.l);
    lim.topMin = this.blockRight + 20; lim.topMax = W - sr - HL.topRightCss.w * k - 8;
    lim.topGap0 = W / 2 - topHalf; lim.topGap1 = W / 2 + topHalf;
    lim.botMin = sl + HL.bottomLeftCss.w * k; lim.botMax = W - sr - HL.bottomRightCss.w * k;
    lim.leftMin = this.blockBottom + 16; lim.leftMax = H - sb - HL.bottomLeftCss.h * k;
    lim.rightMin = Math.max(0, safe.t) + HL.topRightCss.h * k + 14; lim.rightMax = H - sb - HL.bottomRightCss.h * k;
    const camX = view.camX || 0, camY = view.camY || 0;
    const pcx = p.x - camX, pcy = p.y - camY;
    const range = p.stats.radarRange;
    const sats = g.entities ? g.entities.satellites : null;
    // candidates: known or in range, off screen, satellites not yet activated
    const dist = this._dist;
    let n = 0;
    for (let i = 0; i < pois.length; i++) {
      dist[i] = -1;
      const poi = pois[i];
      if (!poi.radar) continue;
      const d = Math.hypot(poi.x - p.x, poi.y - p.y);
      if (!poi.always && !this.discovered[i] && d > range) continue;
      if (poi.kind === 'satellite' && sats) { let done = false; for (const s of sats) if (s.id === poi.key && s.active) done = true; if (done) continue; }
      const sx = poi.x - camX, sy = poi.y - camY;
      if (sx > 10 && sy > 10 && sx < W - 10 && sy < H - 10) continue;
      dist[i] = poi.always ? 0 : d; // the Albatros always takes a slot
      n++;
    }
    let placed = 0;
    for (let shown = 0; shown < RADAR.maxArrows && shown < n; shown++) {
      let best = -1;
      for (let i = 0; i < pois.length; i++) if (dist[i] >= 0 && (best < 0 || dist[i] < dist[best])) best = i;
      if (best < 0) break;
      dist[best] = -1;
      const poi = pois[best];
      const dx = poi.x - p.x, dy = poi.y - p.y;
      const d = Math.hypot(dx, dy);
      const pt = edgePoint(pcx, pcy, dx / (d || 1), dy / (d || 1), lim, this._pt);
      if (!this._freeSlot(pt, lim, placed)) continue;
      this._placed[placed * 2] = pt.x; this._placed[placed * 2 + 1] = pt.y; placed++;
      const disc = poi.always || this.discovered[best];
      const ang = Math.atan2(dy, dx);
      const frame = ((Math.round(ang / (TAU / 16)) % 16) + 16) % 16;
      const pulse = poi.kind === 'blackhole' ? 0.75 + 0.25 * Math.sin(this.clock * 5) : 1;
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * (disc ? pulse : 0.6);
      const ax = Math.round(pt.x), ay = Math.round(pt.y);
      drawSprite(ctx, 'radar_arrow', frame, ax, ay);
      // icon + distance, inward from the arrow
      const ix = pt.edge === 1 ? ax - 14 : pt.edge === 3 ? ax + 14 : ax;
      const iy = pt.edge === 0 ? ay + 13 : pt.edge === 2 ? ay - 15 : ay - 3;
      drawSprite(ctx, poi.icon, 0, ix, iy);
      ctx.globalAlpha = prev;
      const col = !disc ? '#8a96aa' : poi.kind === 'blackhole' ? '#d8b0ff' : poi.always ? '#bff4ff' : '#e8eef8';
      const label = distLabel(d);
      if (pt.edge === 1) drawText(ctx, label, ix + 5, iy + 7, col, O_RIGHT);
      else if (pt.edge === 3) drawText(ctx, label, ix - 5, iy + 7, col, O);
      else drawText(ctx, label, ix, pt.edge === 0 ? iy + 7 : iy - 13, col, O_CENTER);
    }
  }

  /**
   * Slide pt along its edge (0, +s, −s, +2s, −2s…) to the first spot that overlaps no arrow
   * already placed and stays inside the edge limits (outside the top column). False = no room.
   */
  _freeSlot(pt, lim, placed) {
    const horiz = pt.edge === 0 || pt.edge === 2;
    const step = horiz ? RADAR.slotW : RADAR.slotH;
    const lo = pt.edge === 0 ? lim.topMin : pt.edge === 2 ? lim.botMin : pt.edge === 1 ? lim.rightMin : lim.leftMin;
    const hi = pt.edge === 0 ? lim.topMax : pt.edge === 2 ? lim.botMax : pt.edge === 1 ? lim.rightMax : lim.leftMax;
    const base = horiz ? pt.x : pt.y;
    for (let t = 0; t < 9; t++) {
      const off = ((t + 1) >> 1) * step * (t % 2 ? 1 : -1);
      const v = base + off;
      if (v < lo || v > hi) continue;
      if (pt.edge === 0 && v > lim.topGap0 - step / 2 && v < lim.topGap1 + step / 2) continue; // label half width
      const x = horiz ? v : pt.x, y = horiz ? pt.y : v;
      let hit = false;
      for (let k = 0; k < placed && !hit; k++) {
        if (Math.abs(this._placed[k * 2] - x) < RADAR.slotW && Math.abs(this._placed[k * 2 + 1] - y) < RADAR.slotH) hit = true;
      }
      if (hit) continue;
      pt.x = x; pt.y = y;
      return true;
    }
    return false;
  }
}

const NO_SAFE = { l: 0, r: 0, t: 0, b: 0 };
const WARN_SND = { volume: 0.6, pitch: 1, material: '' };
const BAR_HULL = ['#3a0c14', '#e0304e', '#ff8a9a', '#8a1024'];
const BAR_HULL_HI = ['#5a1420', '#ff6a7a', '#ffd0d8', '#c0203a'];
const BAR_O2 = ['#08283a', '#3ac8f0', '#bff4ff', '#1a7aa0'];
const BAR_O2_HI = ['#0e3e56', '#8ae8ff', '#ffffff', '#3ab0d8'];
const BAR_FUEL = ['#3a1a06', '#ff9a2e', '#ffe0a0', '#b8520e'];
const BAR_FUEL_HI = ['#5a2a0a', '#ffc070', '#ffffff', '#e07a2a'];
