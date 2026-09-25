// Canvas HUD + bitmap pixel font (digits, capitals, French accents, punctuation).
// drawText(ctx, str, x, y, color, opts) draws at internal resolution; y = cap top.
import { SURFACE_Y, LAYERS, layerAtDepth } from './config.js';
import { drawSprite } from './sprites.js';
import { RELICS } from './meta.js';

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
G['≈'] = '.....|.##.#|#..#.|.....|.##.#|#..#.|.....';
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

/** Cached number -> text (the HUD rebuilds a string only when its value changes). */
class TextMemo {
  constructor(fmt) { this.fmt = fmt; this.a = NaN; this.b = NaN; this.s = ''; }
  get(a, b = 0) { if (a !== this.a || b !== this.b) { this.a = a; this.b = b; this.s = this.fmt(a, b); } return this.s; }
}

const MAX_TOASTS = 3;       // visible at once; more wait in the queue
const MAX_QUEUE = 8;
const ORE_ICON = {};        // ore key -> sprite name (no string building while drawing)
function oreIcon(k) { return ORE_ICON[k] || (ORE_ICON[k] = 'ore_' + k); }

export class Hud {
  constructor(game) {
    this.game = game;
    this.toasts = [];
    this.queue = [];
    this.bannerT = 0; this.bannerTitle = ''; this.bannerSub = '';
    this.hurtFlash = 0;
    this.hpShown = 60;
    this.hint = null;
    this.flashT = 0; this.flashDur = 1; this.flashColor = '#ffffff';
    this.bossShown = -1; // lagging boss HP (white trail), -1 = no fight
    this.tallyData = null; this.tallyT = 0; this.tallyShown = 0; this.tallyFrom = 0; this.tallyTick = 0; this.tallyDone = false;
    this.bankShown = 0;  // banked gold as displayed (counts up after a tally)
    this.goldPulse = 0;
    this.txt = {
      hp: new TextMemo((a, b) => `${a}/${b}`), gold: new TextMemo((a) => String(a)), bag: new TextMemo((a, b) => `${a}/${b}`),
      est: new TextMemo((a) => `≈${a}`), bank: new TextMemo((a) => String(a)), depth: new TextMemo((a) => (a > 0 ? `-${a} M` : '0 M')),
      ng: new TextMemo((a) => `NG+${a}`), tally: new TextMemo((a) => `+${a} OR`),
    };
  }

  /** New world: drop pending messages and the tally. */
  reset() {
    this.toasts.length = 0; this.queue.length = 0;
    this.tallyData = null; this.tallyT = 0;
    this.hurtFlash = 0; this.flashT = 0;
    this.bankShown = this.game.save ? this.game.save.gold : 0;
    this.hpShown = this.game.player ? this.game.player.stats.maxHp : 60;
  }

  /** Full-screen colour flash (boss death...). */
  flash(color = '#ffffff', dur = 0.4) { this.flashColor = color; this.flashDur = dur; this.flashT = dur; }

  /**
   * Short centred message, queued (at most MAX_TOASTS on screen, the rest wait).
   * opts: { color, sub, life, icon (sprite name drawn before the text) }
   */
  toast(text, opts = {}) {
    const existing = this.toasts.find((t) => t.text === text) || this.queue.find((t) => t.text === text);
    if (existing) { existing.t = Math.min(existing.t, 0.15); existing.life = opts.life ?? 1.4; existing.sub = opts.sub || existing.sub; return; }
    const t = { text, sub: opts.sub || '', color: opts.color || '#f2e6c8', t: 0, life: opts.life ?? 1.4, icon: opts.icon || null };
    if (this.toasts.length < MAX_TOASTS) this.toasts.push(t);
    else { this.queue.push(t); if (this.queue.length > MAX_QUEUE) this.queue.shift(); }
  }

  /** Big layer / event banner. */
  banner(title, sub = '') { this.bannerTitle = title; this.bannerSub = sub; this.bannerT = 3.2; }

  flashDamage() { this.hurtFlash = 0.35; }

  /** Desktop hint line (e.g. "E : FORGE"); null to hide. */
  setHint(text) { this.hint = text; }

  /**
   * Banking tally (meta.bankLoot summary: { items, oreValue, gold, total }): a panel
   * lists the ores and coins, the total counts up with coin ticks, then "cha-ching".
   */
  tally(summary) {
    if (!summary || !(summary.total > 0)) return;
    this.bannerT = Math.min(this.bannerT, 0.3); // the tally takes the stage
    const d = this.tallyData;
    if (d) {
      // a bank while the panel is still up (coins that landed a moment later): add it to
      // this trip's tally and count on from the value shown, instead of replacing it
      for (const it of summary.items) {
        const same = d.items.find((q) => q.key === it.key);
        if (same) same.count += it.count; else d.items.push({ ...it });
      }
      d.items.sort((a, b) => b.value - a.value);
      d.gold += summary.gold; d.oreValue += summary.oreValue; d.total += summary.total;
      this.tallyLabels = d.items.map((i) => '×' + i.count);
      this.tallyGold = String(d.gold);
      this.tallyFrom = this.tallyShown;
      this.tallyT = Math.min(this.tallyT, 0.35); // keep the panel, restart the count-up
      this.tallyDone = false; this.tallyTick = 0;
      this.tallyCount = Math.min(1.2, 0.35 + summary.total / 250);
      return;
    }
    this.tallyData = { items: summary.items.map((i) => ({ ...i })), gold: summary.gold, oreValue: summary.oreValue, total: summary.total };
    this.tallyLabels = summary.items.map((i) => '×' + i.count);
    this.tallyGold = String(summary.gold);
    this.tallyT = 0; this.tallyShown = 0; this.tallyFrom = 0; this.tallyTick = 0; this.tallyDone = false;
    this.tallyCount = Math.min(1.5, 0.45 + summary.total / 250);
  }

  get tallyActive() { return !!this.tallyData; }

  update(dt) {
    for (const t of this.toasts) t.t += dt;
    for (let i = this.toasts.length - 1; i >= 0; i--) if (this.toasts[i].t >= this.toasts[i].life) this.toasts.splice(i, 1);
    while (this.toasts.length < MAX_TOASTS && this.queue.length) this.toasts.push(this.queue.shift());
    this.bannerT = Math.max(0, this.bannerT - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt);
    this.flashT = Math.max(0, this.flashT - dt);
    this.goldPulse = Math.max(0, this.goldPulse - dt);
    const bar = this.game.enemies ? this.game.enemies.bossBar : null;
    if (!bar) this.bossShown = -1;
    else if (this.bossShown < 0 || this.bossShown < bar.hp) this.bossShown = bar.hp;
    else if (this.bossShown > bar.hp) this.bossShown = Math.max(bar.hp, this.bossShown - dt * Math.max(bar.maxHp * 0.08, (this.bossShown - bar.hp) * 2));
    const hp = this.game.player.hp;
    if (this.hpShown > hp) this.hpShown = Math.max(hp, this.hpShown - dt * Math.max(20, (this.hpShown - hp) * 2.5));
    else this.hpShown = hp;
    // banking tally
    const bank = this.game.save ? this.game.save.gold : 0;
    if (this.tallyData) {
      const d = this.tallyData;
      this.tallyT += dt;
      const t0 = 0.35;
      if (this.tallyT > t0 && !this.tallyDone) {
        const k = Math.min(1, (this.tallyT - t0) / this.tallyCount);
        this.tallyShown = Math.round(this.tallyFrom + (d.total - this.tallyFrom) * (1 - (1 - k) * (1 - k)));
        this.tallyTick -= dt;
        if (this.tallyTick <= 0 && k < 1) { this.tallyTick = 0.07; this.game.audio.play('coin', { pitch: 0.8 + k * 0.6, volume: 0.6 }); }
        if (k >= 1) { this.tallyDone = true; this.tallyShown = d.total; this.game.audio.play('bank', {}); this.goldPulse = 0.6; }
      }
      if (this.tallyT > t0 + this.tallyCount + 1.8) this.tallyData = null;
      // the banked counter follows the tally
      this.bankShown = bank - (d.total - this.tallyShown);
    } else if (this.bankShown !== bank) {
      this.bankShown = bank < this.bankShown ? bank : Math.min(bank, this.bankShown + Math.max(1, (bank - this.bankShown) * 8 * dt));
    }
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
    const lagW = Math.round((Math.min(this.hpShown, max) / max) * bw), hpW = Math.round((Math.min(p.hp, max) / max) * bw);
    ctx.fillStyle = '#f2c0c8'; ctx.fillRect(bx, by, lagW, bh);
    ctx.fillStyle = '#b3122e'; ctx.fillRect(bx, by, hpW, bh);
    ctx.fillStyle = '#e0304e'; ctx.fillRect(bx, by, hpW, 2);
    ctx.fillStyle = '#6a0a1c'; ctx.fillRect(bx, by + bh - 1, hpW, 1);
    ctx.fillStyle = '#c9a86a';
    ctx.fillRect(bx - 2, by - 2, 2, 1); ctx.fillRect(bx + bw, by - 2, 2, 1); ctx.fillRect(bx - 2, by + bh + 1, 2, 1); ctx.fillRect(bx + bw, by + bh + 1, 2, 1);
    const O = { outline: '#07040c' };
    const hpTw = drawText(ctx, this.txt.hp.get(Math.ceil(p.hp), max), bx + bw + 5, by - 0.5, '#f2e6c8', O);
    let leftRight = bx + bw + 5 + hpTw; // right edge of the top-left block (the boss bar keeps clear of it)

    // --- run gold + backpack (fill gauge + estimated value)
    const run = g.run;
    const gold = run ? run.gold | 0 : 0;
    const bagN = run ? run.bagCount | 0 : 0;
    const cap = p.stats.bagCapacity;
    drawSprite(ctx, 'icon_coin', 0, L + 4, T + 16);
    const gw0 = drawText(ctx, this.txt.gold.get(gold), L + 12, T + 12, '#ffe08a', O);
    const bx0 = L + Math.max(44, 12 + gw0 + 8);
    drawSprite(ctx, 'icon_bag', 0, bx0 + 3, T + 16);
    const full = bagN >= cap;
    const tw = drawText(ctx, this.txt.bag.get(bagN, cap), bx0 + 11, T + 12, full ? '#ff8a6a' : '#d8cdb0', O);
    // fill gauge under the count
    const gx0 = bx0 + 11, gwid = Math.max(tw, 20);
    ctx.fillStyle = '#07040c'; ctx.fillRect(gx0 - 1, T + 20, gwid + 2, 3);
    ctx.fillStyle = '#3a2a1a'; ctx.fillRect(gx0, T + 21, gwid, 1);
    ctx.fillStyle = full ? '#ff7a4a' : '#e8c878'; ctx.fillRect(gx0, T + 21, Math.round((Math.min(bagN, cap) / Math.max(1, cap)) * gwid), 1);
    leftRight = Math.max(leftRight, gx0 + gwid + 1);
    if (bagN > 0) {
      const est = Math.round((run.bagValue || 0) * (p.stats.oreMul || 1));
      const ew = drawText(ctx, this.txt.est.get(est), gx0 + gwid + 5, T + 12, '#bfae84', O);
      leftRight = Math.max(leftRight, gx0 + gwid + 5 + ew);
    }

    // --- relics (run bonuses)
    if (run && run.relics.length) {
      for (let i = 0; i < run.relics.length; i++) {
        const r = RELICS[run.relics[i]];
        if (r) drawSprite(ctx, r.icon, 0, L + 5 + i * 11, T + 32);
      }
    }

    // --- depth meter (top right, left of the pause button area)
    const depth = p.depth;
    const layer = layerAtDepth(depth);
    const dx = R - (g.input.touchEnabled ? 30 : 0);
    const inCamp = p.feetY <= SURFACE_Y * 16;
    if (inCamp) {
      drawText(ctx, 'CAMP', dx, T + 1, '#bfe3a0', { align: 'right', outline: '#07040c' });
      // banked gold (the Forge currency) is shown while in the camp
      const bankTxt = this.txt.bank.get(Math.round(this.bankShown));
      const bw2 = drawText(ctx, bankTxt, dx, T + 12, this.goldPulse > 0 && Math.floor(this.goldPulse * 12) % 2 ? '#ffffff' : '#ffe08a', { align: 'right', outline: '#07040c' });
      drawSprite(ctx, 'icon_bank', 0, dx - bw2 - 6, T + 17);
    } else {
      drawText(ctx, this.txt.depth.get(depth), dx, T + 1, '#f2e6c8', { align: 'right', outline: '#07040c' });
      drawText(ctx, layer.name, dx, T + 12, '#a89ab8', { align: 'right', outline: '#07040c' });
    }
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
    if (run && run.bestDepth) {
      const bxm = gx + Math.round((Math.min(run.bestDepth, maxD) / maxD) * gw);
      ctx.fillStyle = '#ffd35c'; ctx.fillRect(bxm, gy + 3, 1, 2);
    }
    if (g.save && g.save.stats.bestDepth) {
      const rx = gx + Math.round((Math.min(g.save.stats.bestDepth, maxD) / maxD) * gw);
      ctx.fillStyle = '#e0304e'; ctx.fillRect(rx, gy - 3, 1, 2);
    }
    if (run && run.ngPlus) drawText(ctx, this.txt.ng.get(run.ngPlus), dx, gy + 5, '#ff8aa0', { align: 'right', outline: '#07040c' });

    // --- boss bar (top centre)
    const bar = g.enemies ? g.enemies.bossBar : null;
    if (bar) this.drawBossBar(ctx, W, T, bar, leftRight);

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

    // --- banking tally
    if (this.tallyData) this.drawTally(ctx, W, H);

    // --- toasts
    let ty = Math.round(H * (this.tallyData ? 0.58 : 0.36));
    for (const t of this.toasts) {
      const a = Math.min(1, t.t / 0.08, (t.life - t.t) / 0.3);
      const rise = Math.round(Math.min(1, t.t / 0.15) * -4);
      if (t.icon) {
        const w = measureText(t.text);
        const x0 = Math.round(W / 2 - (w + 13) / 2);
        const prev = ctx.globalAlpha;
        ctx.globalAlpha = prev * a;
        drawSprite(ctx, t.icon, 0, x0 + 5, ty + rise + 8);
        ctx.globalAlpha = prev;
        drawText(ctx, t.text, x0 + 13, ty + rise, t.color, { outline: '#07040c', alpha: a });
      } else {
        drawText(ctx, t.text, W / 2, ty + rise, t.color, { align: 'center', outline: '#07040c', alpha: a });
      }
      if (t.sub) drawText(ctx, t.sub, W / 2, ty + rise + 10, '#b8aac8', { align: 'center', outline: '#07040c', alpha: a * 0.9 });
      ty += t.sub ? 22 : 12;
    }

    if (this.hint && !g.input.touchEnabled) drawText(ctx, this.hint, W / 2, H - 16, '#ffe6a0', { align: 'center', outline: '#07040c' });

    if (this.flashT > 0) {
      ctx.globalAlpha = Math.min(1, this.flashT / this.flashDur) * 0.85;
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }

    if (g.flags && g.flags.debug && g.enemies) {
      drawText(ctx, `${g.enemies.activeCount}/${g.enemies.count} ENN.`, R, H - 12, '#7fffd4', { align: 'right' });
    }
    if (g.flags && g.flags.debug) {
      const dbg = `${g.fps | 0} FPS  X${p.tileX} Y${p.tileY}  ${g.player.grapple.state.toUpperCase()}${g.flags.god ? '  GOD' : ''}`;
      drawText(ctx, dbg, L, H - 12, '#7fffd4');
    }
  }

  /** "Butin mis à l'abri" panel: ore icons × counts, coins, and the counting total. */
  drawTally(ctx, W, H) {
    const d = this.tallyData;
    const t = this.tallyT, end = 0.35 + this.tallyCount + 1.8;
    const a = Math.min(1, t / 0.2, (end - t) / 0.4);
    if (a <= 0) return;
    const items = d.items;
    const n = items.length + (d.gold > 0 ? 1 : 0);
    const rowW = n * 30;
    const pw = Math.max(150, rowW + 20), ph = 50;
    const px = Math.round(W / 2 - pw / 2), py = Math.round(H * 0.15) + Math.round((1 - Math.min(1, t / 0.2)) * -6);
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * a * 0.82;
    ctx.fillStyle = '#07040c'; ctx.fillRect(px, py, pw, ph);
    ctx.globalAlpha = prev * a;
    ctx.fillStyle = '#6a5238'; ctx.fillRect(px, py, pw, 1); ctx.fillRect(px, py + ph - 1, pw, 1); ctx.fillRect(px, py, 1, ph); ctx.fillRect(px + pw - 1, py, 1, ph);
    ctx.fillStyle = '#c9a86a';
    ctx.fillRect(px - 1, py - 1, 3, 1); ctx.fillRect(px + pw - 2, py - 1, 3, 1); ctx.fillRect(px - 1, py + ph, 3, 1); ctx.fillRect(px + pw - 2, py + ph, 3, 1);
    drawText(ctx, 'BUTIN MIS À L’ABRI', W / 2, py + 4, '#e8c878', { align: 'center', outline: '#07040c', alpha: a });
    let x = Math.round(W / 2 - rowW / 2) + 4;
    const iy = py + 23;
    for (let i = 0; i < items.length; i++) {
      drawSprite(ctx, oreIcon(items[i].key), 0, x + 3, iy);
      drawText(ctx, this.tallyLabels[i], x + 8, iy - 6, '#d8cdb0', { outline: '#07040c', alpha: a });
      x += 30;
    }
    if (d.gold > 0) {
      drawSprite(ctx, 'icon_coin', 0, x + 3, iy - 2);
      drawText(ctx, this.tallyGold, x + 8, iy - 6, '#ffe08a', { outline: '#07040c', alpha: a });
    }
    const pulse = this.tallyDone && t < 0.35 + this.tallyCount + 0.5 ? '#ffffff' : '#ffe08a';
    drawText(ctx, this.txt.tally.get(this.tallyShown), W / 2, py + 35, pulse, { align: 'center', outline: '#3a2408', alpha: a });
    ctx.globalAlpha = prev;
  }

  /** Boss health bar: name, framed bar with phase notches, damage trail, intro fill. */
  drawBossBar(ctx, W, T, bar, leftRight = 0) {
    // centred, never over the top-left block (gold, backpack estimate): 7 px of frame + 6 px gap
    const bw = Math.max(60, Math.min(170, Math.round(W * 0.38), Math.floor(W - 2 * (leftRight + 13)))), bh = 5;
    const bx = Math.round(W / 2 - bw / 2), by = T + 11;
    const a = Math.min(1, bar.reveal * 2);
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * a;
    drawText(ctx, bar.name, W / 2, T, bar.dying ? '#a89ab8' : '#e8c878', { align: 'center', outline: '#07040c' });
    ctx.fillStyle = '#07040c'; ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    ctx.fillStyle = '#1c0816'; ctx.fillRect(bx, by, bw, bh);
    const shownHp = bar.hp * bar.reveal; // the bar fills up during the intro roar
    const lag = Math.round((Math.max(this.bossShown, shownHp) / bar.maxHp) * bw * Math.min(1, bar.reveal));
    const fw = Math.round((shownHp / bar.maxHp) * bw);
    ctx.fillStyle = '#f2c0c8'; ctx.fillRect(bx, by, lag, bh);
    const hot = bar.flash > 0;
    ctx.fillStyle = hot ? '#ff9ab0' : bar.phase >= 2 ? '#c2410c' : '#8a1a4a'; ctx.fillRect(bx, by, fw, bh);
    ctx.fillStyle = hot ? '#ffe0e8' : bar.phase >= 2 ? '#fb923c' : '#c0306a'; ctx.fillRect(bx, by, fw, 2);
    ctx.fillStyle = '#3a0620'; ctx.fillRect(bx, by + bh - 1, fw, 1);
    // phase notches (66 % / 33 %)
    ctx.fillStyle = '#07040c';
    ctx.fillRect(bx + Math.round(bw * 0.66), by - 1, 1, bh + 2);
    ctx.fillRect(bx + Math.round(bw * 0.33), by - 1, 1, bh + 2);
    // gothic frame corners + end caps
    ctx.fillStyle = '#c9a86a';
    ctx.fillRect(bx - 3, by - 3, 3, 1); ctx.fillRect(bx + bw, by - 3, 3, 1);
    ctx.fillRect(bx - 3, by + bh + 2, 3, 1); ctx.fillRect(bx + bw, by + bh + 2, 3, 1);
    ctx.fillRect(bx - 4, by + 1, 1, bh - 2); ctx.fillRect(bx + bw + 3, by + 1, 1, bh - 2);
    ctx.fillStyle = '#e0304e';
    ctx.fillRect(bx - 6, by + 2, 2, 1); ctx.fillRect(bx + bw + 4, by + 2, 2, 1);
    ctx.globalAlpha = prev;
  }
}
