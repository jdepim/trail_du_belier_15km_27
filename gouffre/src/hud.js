// Canvas HUD + bitmap pixel font (digits, capitals, French accents, punctuation).
// drawText(ctx, str, x, y, color, opts) draws at internal resolution; y = cap top.
import { SURFACE_Y, LAYERS, layerAtDepth } from './config.js';
import { drawSprite } from './sprites.js';

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
  '.': '.|.|.|.|.|.|#', ',': '..|..|..|..|..|.#|#.', '!': '#|#|#|#|#|.|#', '?': '.###.|#...#|....#|...#.|..#..|.....|..#..',
  ':': '.|.|#|.|.|#|.', ';': '..|..|.#|..|..|.#|#.', "'": '#|#|.|.|.|.|.', '’': '#|#|.|.|.|.|.', '"': '#.#|#.#|...|...|...|...|...',
  '-': '...|...|...|###|...|...|...', '+': '.....|..#..|..#..|#####|..#..|..#..|.....', '/': '....#|...#.|...#.|..#..|.#...|.#...|#....',
  '(': '.#|#.|#.|#.|#.|#.|.#', ')': '#.|.#|.#|.#|.#|.#|#.', '%': '##..#|##..#|...#.|..#..|.#...|#..##|#..##',
  '×': '.....|#...#|.#.#.|..#..|.#.#.|#...#|.....', '<': '...#|..#.|.#..|#...|.#..|..#.|...#', '>': '#...|.#..|..#.|...#|..#.|.#..|#...',
  '=': '....|....|####|....|####|....|....', '_': '....|....|....|....|....|....|####', '—': '......|......|......|######|......|......|......',
  '·': '.|.|.|#|.|.|.', '*': '.....|#.#.#|.###.|#####|.###.|#.#.#|.....', '#': '.#.#.|#####|.#.#.|.#.#.|.#.#.|#####|.#.#.',
};
// typographic aliases
G['−'] = G['-']; G['–'] = G['-']; G['«'] = '.....|..#.#|.#.#.|#.#..|.#.#.|..#.#|.....'; G['»'] = '.....|#.#..|.#.#.|..#.#|.#.#.|#.#..|.....';
// accented capitals = base glyph + mark (3 px wide, 2 rows above or below the glyph)
const MARKS = { acute: '..#|.#.', grave: '#..|.#.', circ: '.#.|#.#', diaer: '...|#.#', ced: '.#.|##.' };
const ACCENTS = {
  'É': ['E', 'acute'], 'È': ['E', 'grave'], 'Ê': ['E', 'circ'], 'Ë': ['E', 'diaer'], 'À': ['A', 'grave'], 'Â': ['A', 'circ'],
  'Ç': ['C', 'ced'], 'Ô': ['O', 'circ'], 'Î': ['I', 'circ'], 'Ï': ['I', 'diaer'], 'Ù': ['U', 'grave'], 'Û': ['U', 'circ'], 'Ü': ['U', 'diaer'],
};

const CELL_W = 7, CELL_H = 11; // 2 rows of accent space above, 2 below
const CHARS = [...Object.keys(G), ...Object.keys(ACCENTS)];
const INDEX = new Map(CHARS.map((c, i) => [c, i]));
const WIDTH = new Map();
for (const c of CHARS) {
  const base = ACCENTS[c] ? ACCENTS[c][0] : c;
  WIDTH.set(c, G[base].split('|')[0].length);
}
const atlases = new Map();

function glyphRows(c) {
  if (ACCENTS[c]) return G[ACCENTS[c][0]].split('|');
  return G[c].split('|');
}

function atlas(color) {
  let a = atlases.get(color);
  if (a) return a;
  a = document.createElement('canvas');
  a.width = CHARS.length * CELL_W; a.height = CELL_H;
  const g = a.getContext('2d');
  g.fillStyle = color;
  CHARS.forEach((c, idx) => {
    const ox = idx * CELL_W;
    const rows = glyphRows(c);
    rows.forEach((r, y) => { for (let x = 0; x < r.length; x++) if (r[x] === '#') g.fillRect(ox + x, y + 2, 1, 1); });
    if (ACCENTS[c]) {
      const [, mark] = ACCENTS[c];
      const m = MARKS[mark].split('|');
      const w = WIDTH.get(c);
      const mx = ox + Math.floor((w - 3) / 2);
      const my = mark === 'ced' ? 9 : 0;
      m.forEach((r, y) => { for (let x = 0; x < 3; x++) if (r[x] === '#') g.fillRect(mx + x, my + y, 1, 1); });
    }
  });
  atlases.set(color, a);
  return a;
}

function normalize(str) { return String(str).toUpperCase(); }

/** Width in pixels of a string in the bitmap font. */
export function measureText(str) {
  let w = 0;
  for (const c of normalize(str)) w += c === ' ' ? 3 : (WIDTH.get(c) ?? 3) + 1;
  return Math.max(0, w - 1);
}

/**
 * Draw text; returns its width. opts: { align:'left'|'center'|'right', shadow:true|color|false,
 * outline:false|color, alpha }
 */
export function drawText(ctx, str, x, y, color = '#ffffff', opts = {}) {
  const s = normalize(str);
  const w = measureText(s);
  let cx = Math.round(opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x);
  y = Math.round(y);
  const prevAlpha = ctx.globalAlpha;
  if (opts.alpha !== undefined) ctx.globalAlpha = prevAlpha * opts.alpha;
  const pass = (col, dx, dy) => {
    const a = atlas(col);
    let px = cx + dx;
    for (const c of s) {
      if (c === ' ') { px += 3; continue; }
      const i = INDEX.get(c);
      if (i === undefined) { px += 4; continue; }
      ctx.drawImage(a, i * CELL_W, 0, CELL_W, CELL_H, px, y - 2 + dy, CELL_W, CELL_H);
      px += WIDTH.get(c) + 1;
    }
  };
  if (opts.outline) { const o = opts.outline; pass(o, -1, 0); pass(o, 1, 0); pass(o, 0, -1); pass(o, 0, 1); pass(o, 1, 1); }
  else if (opts.shadow !== false) pass(typeof opts.shadow === 'string' ? opts.shadow : '#07040c', 1, 1);
  pass(color, 0, 0);
  ctx.globalAlpha = prevAlpha;
  return w;
}

// ------------------------------------------------------------------ HUD

const LAYER_COLORS = ['#7a5536', '#78646e', '#5f8fb0', '#c2410c', '#a3283a'];

export class Hud {
  constructor(game) {
    this.game = game;
    this.toasts = [];
    this.bannerT = 0; this.bannerTitle = ''; this.bannerSub = '';
    this.hurtFlash = 0;
    this.hpShown = 60;
    this.hint = null;
  }

  /** Short centred message. opts: { color, sub, life } */
  toast(text, opts = {}) {
    const existing = this.toasts.find((t) => t.text === text);
    if (existing) { existing.t = Math.min(existing.t, 0.15); existing.life = opts.life ?? 1.4; return; }
    this.toasts.push({ text, sub: opts.sub || '', color: opts.color || '#f2e6c8', t: 0, life: opts.life ?? 1.4 });
    if (this.toasts.length > 3) this.toasts.shift();
  }

  /** Big layer / event banner. */
  banner(title, sub = '') { this.bannerTitle = title; this.bannerSub = sub; this.bannerT = 3.2; }

  flashDamage() { this.hurtFlash = 0.35; }

  /** Desktop hint line (e.g. "E : FORGE"); null to hide. */
  setHint(text) { this.hint = text; }

  update(dt) {
    for (const t of this.toasts) t.t += dt;
    this.toasts = this.toasts.filter((t) => t.t < t.life);
    this.bannerT = Math.max(0, this.bannerT - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    const hp = this.game.player.hp;
    if (this.hpShown > hp) this.hpShown = Math.max(hp, this.hpShown - dt * Math.max(20, (this.hpShown - hp) * 2.5));
    else this.hpShown = hp;
  }

  draw(ctx, W, H) {
    const g = this.game;
    if (g.state === 'TITLE') return;
    const p = g.player;
    const safe = g.safe || { l: 0, r: 0, t: 0, b: 0 };
    const L = Math.max(6, safe.l + 4), T = Math.max(5, safe.t + 4), R = W - Math.max(6, safe.r + 4);

    // damage vignette / low HP pulse
    const low = p.hp > 0 && p.hp <= p.stats.maxHp * 0.25;
    const vig = Math.max(this.hurtFlash / 0.35 * 0.5, low ? 0.18 + 0.12 * Math.sin(g.time * 6) : 0);
    if (vig > 0.01) {
      ctx.fillStyle = '#b3122e';
      for (let i = 0; i < 6; i++) {
        ctx.globalAlpha = vig * (1 - i / 6) * 0.5;
        ctx.fillRect(0, i * 2, W, 2); ctx.fillRect(0, H - (i + 1) * 2, W, 2);
        ctx.fillRect(i * 2, 0, 2, H); ctx.fillRect(W - (i + 1) * 2, 0, 2, H);
      }
      ctx.globalAlpha = 1;
    }

    // --- HP bar
    drawSprite(ctx, 'icon_heart', 0, L + 4, T + 4);
    const bx = L + 12, by = T + 1, bw = 58, bh = 6;
    ctx.fillStyle = '#07040c'; ctx.fillRect(bx - 1, by - 1, bw + 2, bh + 2);
    ctx.fillStyle = '#2a0a12'; ctx.fillRect(bx, by, bw, bh);
    const max = p.stats.maxHp;
    const lagW = Math.round((this.hpShown / max) * bw), hpW = Math.round((p.hp / max) * bw);
    ctx.fillStyle = '#f2c0c8'; ctx.fillRect(bx, by, lagW, bh);
    ctx.fillStyle = '#b3122e'; ctx.fillRect(bx, by, hpW, bh);
    ctx.fillStyle = '#e0304e'; ctx.fillRect(bx, by, hpW, 2);
    ctx.fillStyle = '#6a0a1c'; ctx.fillRect(bx, by + bh - 1, hpW, 1);
    ctx.fillStyle = '#c9a86a';
    ctx.fillRect(bx - 2, by - 2, 2, 1); ctx.fillRect(bx + bw, by - 2, 2, 1); ctx.fillRect(bx - 2, by + bh + 1, 2, 1); ctx.fillRect(bx + bw, by + bh + 1, 2, 1);
    const O = { outline: '#07040c' };
    drawText(ctx, `${Math.ceil(p.hp)}/${max}`, bx + bw + 5, by - 0.5, '#f2e6c8', O);

    // --- gold + bag (run values filled by step 2)
    const run = g.run || { gold: 0, bag: [] };
    drawSprite(ctx, 'icon_coin', 0, L + 4, T + 16);
    drawText(ctx, String(run.gold | 0), L + 12, T + 12, '#ffe08a', O);
    const bagN = run.bagCount ?? (run.bag ? run.bag.length : 0);
    drawSprite(ctx, 'icon_bag', 0, L + 48, T + 16);
    drawText(ctx, `${bagN}/${p.stats.bagCapacity}`, L + 56, T + 12, bagN >= p.stats.bagCapacity ? '#ff8a6a' : '#d8cdb0', O);

    // --- depth meter (top right, left of the pause button area)
    const depth = p.depth;
    const layer = layerAtDepth(depth);
    const dx = R - (g.input.touchEnabled ? 30 : 0);
    const inCamp = p.feetY <= SURFACE_Y * 16;
    drawText(ctx, inCamp ? 'CAMP' : depth > 0 ? `-${depth} M` : '0 M', dx, T + 1, inCamp ? '#bfe3a0' : '#f2e6c8', { align: 'right', outline: '#07040c' });
    drawText(ctx, inCamp ? 'EN SÛRETÉ' : layer.name, dx, T + 12, '#a89ab8', { align: 'right', outline: '#07040c' });
    // layer gauge
    const gw = 44, gx = dx - gw, gy = T + 22;
    ctx.fillStyle = '#07040c'; ctx.fillRect(gx - 1, gy - 1, gw + 2, 4);
    const maxD = LAYERS[4].d1;
    for (const Lr of LAYERS) {
      const x0 = gx + Math.round((Lr.d0 / maxD) * gw), x1 = gx + Math.round((Math.min(Lr.d1 + 1, maxD) / maxD) * gw);
      ctx.fillStyle = LAYER_COLORS[Lr.index]; ctx.globalAlpha = 0.7; ctx.fillRect(x0, gy, Math.max(1, x1 - x0), 2);
    }
    ctx.globalAlpha = 1;
    const mx = gx + Math.round((Math.min(depth, maxD) / maxD) * gw);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(mx, gy - 2, 1, 6);
    if (g.run && g.run.bestDepth) {
      const bxm = gx + Math.round((Math.min(g.run.bestDepth, maxD) / maxD) * gw);
      ctx.fillStyle = '#ffd35c'; ctx.fillRect(bxm, gy + 3, 1, 2);
    }

    // --- layer banner
    if (this.bannerT > 0) {
      const a = Math.min(1, this.bannerT / 0.5, (3.2 - this.bannerT) / 0.4);
      const y = Math.round(H * 0.24);
      const tw = measureText(this.bannerTitle);
      ctx.globalAlpha = a * 0.6; ctx.fillStyle = '#07040c';
      ctx.fillRect(Math.round(W / 2 - tw / 2 - 18), y - 6, tw + 36, 26);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#a3283a';
      ctx.fillRect(Math.round(W / 2 - tw / 2 - 14), y + 3, 8, 1); ctx.fillRect(Math.round(W / 2 + tw / 2 + 6), y + 3, 8, 1);
      drawText(ctx, this.bannerTitle, W / 2, y, '#f2e6c8', { align: 'center', outline: '#07040c' });
      if (this.bannerSub) drawText(ctx, this.bannerSub, W / 2, y + 11, '#a89ab8', { align: 'center' });
      ctx.globalAlpha = 1;
    }

    // --- toasts
    let ty = Math.round(H * 0.36);
    for (const t of this.toasts) {
      const a = Math.min(1, t.t / 0.08, (t.life - t.t) / 0.3);
      const rise = Math.round(Math.min(1, t.t / 0.15) * -4);
      drawText(ctx, t.text, W / 2, ty + rise, t.color, { align: 'center', outline: '#07040c', alpha: a });
      if (t.sub) drawText(ctx, t.sub, W / 2, ty + rise + 10, '#b8aac8', { align: 'center', alpha: a * 0.9 });
      ty += t.sub ? 22 : 12;
    }

    if (this.hint && !g.input.touchEnabled) drawText(ctx, this.hint, W / 2, H - 16, '#ffe6a0', { align: 'center', outline: '#07040c' });

    if (g.flags && g.flags.debug) {
      const dbg = `${g.fps | 0} FPS  X${p.tileX} Y${p.tileY}  ${g.player.grapple.state.toUpperCase()}${g.flags.god ? '  GOD' : ''}`;
      drawText(ctx, dbg, L, H - 12, '#7fffd4');
    }
  }
}
