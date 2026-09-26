// Canvas renderer: small internal image upscaled with nearest-neighbour by CSS.
import { TILE, VIEW_H, WATER_LEVEL } from './config.js';
export { Camera } from './camera.js';
import { TILE_ID, SOLID, TILE_DEFS } from './tiles.js';
import { bakeDino, bakeTiles, bakeProps, makeCanvas } from './sprites.js';
import { SPECIES } from './data/species.js';
import { CREATURES } from './data/creatures.js';
import { BIOMES } from './data/biomes.js';
import { makeNoise1D, clamp, hash2 } from './rng.js';
import { drawText, textWidth } from './font.js';

const WATER_COL = 'rgba(40, 110, 170, 0.55)';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.W = 320; this.H = VIEW_H; this.scale = 1;
    this.tiles = bakeTiles();
    this.props = bakeProps();
    this.dinos = {};
    for (const s of Object.values(SPECIES)) this.dinos[`p:${s.id}`] = bakeDino(s.look);
    for (const c of Object.values(CREATURES)) this.dinos[`c:${c.id}`] = bakeDino(c.look);
    this.far = makeNoise1D(4242); this.near = makeNoise1D(777);
    this.textCache = new Map();
    this.light = null;
    this.resize();
  }

  /** Integer device-pixel scale so the view is about VIEW_H pixels tall (or wide in portrait). */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const cw = window.innerWidth, ch = window.innerHeight;
    const minDim = Math.min(cw, ch) * dpr;
    this.scale = Math.max(1, Math.round(minDim / VIEW_H));
    this.W = Math.ceil((cw * dpr) / this.scale);
    this.H = Math.ceil((ch * dpr) / this.scale);
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    this.canvas.style.width = `${(this.W * this.scale) / dpr}px`;
    this.canvas.style.height = `${(this.H * this.scale) / dpr}px`;
    this.ctx.imageSmoothingEnabled = false;
    this.light = makeCanvas(this.W, this.H);
  }

  text(s, color) {
    const key = s + '|' + color;
    let c = this.textCache.get(key);
    if (!c) {
      c = makeCanvas(textWidth(s) + 2, 7);
      drawText(c.getContext('2d'), s, 1, 1, color, '#000');
      if (this.textCache.size > 200) this.textCache.clear();
      this.textCache.set(key, c);
    }
    return c;
  }

  draw(game) {
    const { ctx, W, H } = this;
    const cam = game.camera;
    const cx = Math.round(cam.x + cam.ox), cy = Math.round(cam.y + cam.oy);
    this.drawSky(game, cx, cy);
    ctx.save();
    ctx.translate(-cx, -cy);
    const x0 = Math.max(0, Math.floor(cx / TILE)), x1 = Math.min(game.world.w - 1, Math.ceil((cx + W) / TILE));
    const y0 = Math.max(0, Math.floor(cy / TILE)), y1 = Math.min(game.world.h - 1, Math.ceil((cy + H) / TILE));
    this.drawTiles(game.world, x0, x1, y0, y1);
    for (const s of game.structures) this.drawStructure(s, game);
    for (const b of game.bonePiles) if (b.ready) ctx.drawImage(this.props.bones[0], Math.round(b.x), Math.round(b.y));
    for (const c of game.carcasses) this.drawBody(`c:${c.def.id}`, c, 'dead', 0, c.life < 10 && Math.floor(c.life * 4) % 2 === 0);
    for (const c of game.creatures) this.drawCreature(c, game);
    for (const a of game.allies) this.drawCreature(a, game);
    this.drawPlayer(game.player, game);
    if (game.builder.active) this.drawGhost(game);
    this.drawWater(game.world, x0, x1, y0, y1, game.time);
    this.drawParticles(game.particles);
    ctx.restore();
    this.drawNight(game, cx, cy);
    ctx.save();
    ctx.translate(-cx, -cy);
    this.drawMarkers(game);
    this.drawFloats(game.particles);
    ctx.restore();
  }

  // ------------------------------------------------------------------ background
  drawSky(game, cx, cy) {
    const { ctx, W, H } = this;
    const biome = BIOMES[game.world.biomeAtPx(game.player.cx)];
    const n = game.nightAmount;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, mix('#3a78c0', '#070a1e', n));
    g.addColorStop(1, mix(biome.sky, '#1a1a3a', n));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // sun / moon
    const phase = game.dayPhase;
    const a = phase * Math.PI * 2;
    const sx = W * 0.5 + Math.cos(a - Math.PI / 2) * W * 0.42, sy = H * 0.55 + Math.sin(a - Math.PI / 2) * H * 0.45;
    ctx.fillStyle = n > 0.5 ? '#e8e8f0' : '#fff2b0';
    ctx.fillRect(Math.round(n > 0.5 ? W - sx : sx) - 4, Math.round(n > 0.5 ? H * 1.1 - sy : sy) - 4, 8, 8);
    if (n > 0.3) {
      ctx.fillStyle = `rgba(255,255,255,${(n - 0.3) * 1.2})`;
      for (let i = 0; i < 40; i++) ctx.fillRect(Math.floor(hash2(i, 1, 3) * W), Math.floor(hash2(i, 2, 3) * H * 0.6), 1, 1);
    }
    // parallax hills
    const baseY = WATER_LEVEL * TILE - cy;
    const layer = (noise, par, amp, off, col) => {
      ctx.fillStyle = col;
      for (let x = 0; x < W; x += 2) {
        const wx = (x + cx * par);
        const h = off + noise(wx * 0.004, 3) * amp;
        const y = Math.round(baseY * (0.3 + par) - h);
        ctx.fillRect(x, y, 2, H - y);
      }
    };
    layer(this.far, 0.15, 40, 70, mix(shade(biome.hills, 0.35), '#101428', n * 0.8));
    layer(this.near, 0.35, 22, 30, mix(biome.hills, '#0c1020', n * 0.8));
  }

  // ------------------------------------------------------------------ world
  drawTiles(world, x0, x1, y0, y1) {
    const ctx = this.ctx;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const id = world.tiles[ty * world.w + tx];
        if (id === TILE_ID.air || id === TILE_ID.water) continue;
        const v = (hash2(tx, ty, 5) * 4) | 0;
        let img;
        const def = TILE_DEFS[id];
        if (def.top && !SOLID[world.get(tx, ty - 1)]) img = this.tiles[`${id}top`][v];
        else img = this.tiles[id][v];
        ctx.drawImage(img, tx * TILE, ty * TILE);
      }
    }
    // depth darkening under the surface
    for (let tx = x0; tx <= x1; tx++) {
      const s = world.surface[tx];
      for (let band = 0; band < 4; band++) {
        const yA = (s + 3 + band * 3) * TILE;
        if (yA > (y1 + 1) * TILE) break;
        ctx.fillStyle = `rgba(10,6,16,${0.16 + band * 0.14})`;
        ctx.fillRect(tx * TILE, yA, TILE, band === 3 ? (y1 + 1) * TILE - yA : 3 * TILE);
      }
    }
  }

  drawWater(world, x0, x1, y0, y1, time) {
    const ctx = this.ctx;
    ctx.fillStyle = WATER_COL;
    for (let tx = x0; tx <= x1; tx++) {
      let run = -1;
      for (let ty = y0; ty <= y1 + 1; ty++) {
        const w = ty <= y1 && world.tiles[ty * world.w + tx] === TILE_ID.water;
        if (w && run < 0) run = ty;
        if (!w && run >= 0) { ctx.fillRect(tx * TILE, run * TILE, TILE, (ty - run) * TILE); run = -1; }
      }
    }
    // surface ripples
    ctx.fillStyle = 'rgba(210, 240, 255, 0.75)';
    for (let tx = x0; tx <= x1; tx++) {
      if (world.get(tx, WATER_LEVEL) !== TILE_ID.water || world.get(tx, WATER_LEVEL - 1) === TILE_ID.water) continue;
      for (let i = 0; i < TILE; i += 2) {
        const x = tx * TILE + i;
        if (Math.sin(x * 0.3 + time * 3) > 0.2) ctx.fillRect(x, WATER_LEVEL * TILE, 2, 1);
      }
    }
  }

  drawStructure(s, game) {
    const ctx = this.ctx;
    const frames = this.props[s.def.id];
    if (!frames) { ctx.fillStyle = '#c89060'; ctx.fillRect(s.x, s.y, s.w, s.h); return; }
    const img = frames[Math.floor(s.anim * 8) % frames.length];
    ctx.drawImage(img, Math.round(s.x + (s.w - img.width) / 2), Math.round(s.y + s.h - img.height));
    if (s.def.id === 'feu' && Math.random() < 0.08) game.particles.spawn('spark', s.cx, s.y + 2, { n: 1 });
  }

  // ------------------------------------------------------------------ bodies
  /** Draw a baked dino so its feet sit on the body's bottom, centred horizontally. */
  drawBody(key, body, pose, blinkOff, hidden, flash) {
    if (hidden) return;
    const set = this.dinos[key];
    const frames = (flash && set.flash[pose]) || set[pose] || set.idle0;
    const img = frames[body.facing > 0 ? 0 : 1];
    let x, y;
    if (pose === 'climb0' || pose === 'climb1') {
      x = body.facing > 0 ? body.x + body.w - img.width + 1 : body.x - 1;
      y = body.y + body.h - img.height + Math.max(0, (img.height - body.h) / 2);
    } else {
      x = body.x + body.w / 2 - img.width / 2;
      y = body.y + body.h - img.height + 1;
    }
    this.ctx.drawImage(img, Math.round(x), Math.round(y));
  }

  poseOf(b, speedRef) {
    if (b.state === 'climb') return Math.abs(b.vy) > 1 ? (Math.floor(b.anim * 6) % 2 ? 'climb1' : 'climb0') : 'climb0';
    if (b.attackT > 0) return 'attack';
    if (b.inWater) return Math.floor(b.anim * 3) % 2 ? 'swim1' : 'swim0';
    if (!b.onGround) return b.vy < 0 ? 'jump' : 'fall';
    const moving = Math.abs(b.vx) > 6;
    if (moving) return `walk${Math.floor(b.anim * Math.max(6, Math.abs(b.vx) / speedRef * 10)) % 4}`;
    return Math.floor(b.anim * 1.5) % 2 ? 'idle1' : 'idle0';
  }

  drawPlayer(p, game) {
    const key = `p:${p.species.id}`;
    if (p.state === 'dead') { this.drawBody(key, p, 'dead'); return; }
    const pose = this.poseOf(p, p.species.walkSpeed);
    const blink = p.hurtT > 0 && Math.floor(p.hurtT * 20) % 2 === 0;
    this.drawBody(key, p, pose, 0, blink);
  }

  drawCreature(c, game) {
    const pose = c.attackT > 0 ? 'attack' : this.poseOf(c, c.stats.speed);
    this.drawBody(`c:${c.def.id}`, c, pose, 0, false, c.hurtT > 0);
    const ctx = this.ctx;
    if (c.ally) {
      // green collar dot + carried loot
      ctx.fillStyle = '#7fe07f';
      ctx.fillRect(Math.round(c.cx), Math.round(c.y) - 3, 1, 1);
      if (c.carrying) { ctx.fillStyle = '#f2ead0'; ctx.fillRect(Math.round(c.cx) - 1, Math.round(c.y) - 6, 3, 2); }
    }
    if (c.hp < c.stats.hp && c.alive) {
      const w = Math.max(8, Math.min(20, c.w));
      const x = Math.round(c.cx - w / 2), y = Math.round(c.y) - (c.ally ? 9 : 5);
      ctx.fillStyle = '#000'; ctx.fillRect(x - 1, y - 1, w + 2, 3);
      ctx.fillStyle = c.ally ? '#7fe07f' : '#e04040';
      ctx.fillRect(x, y, Math.max(1, Math.round((w * c.hp) / c.stats.hp)), 1);
    }
  }

  drawGhost(game) {
    const b = game.builder;
    const g = b.ghost();
    const v = b.validate(g);
    const ctx = this.ctx;
    ctx.globalAlpha = 0.55;
    const def = b.def;
    if (def.kind === 'structure' && this.props[def.id]) {
      const img = this.props[def.id][0];
      ctx.drawImage(img, g.tx * TILE + (g.w * TILE - img.width) / 2, (g.ty + g.h) * TILE - img.height);
    } else {
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
        const ch = def.pattern[y][x];
        if (!ch || ch === ' ') continue;
        ctx.drawImage(this.tiles[TILE_ID[def.tiles[ch]]][0], (g.tx + x) * TILE, (g.ty + y) * TILE);
      }
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = v.ok ? '#7fe07f' : '#ff5050';
    ctx.lineWidth = 1;
    ctx.strokeRect(g.tx * TILE + 0.5, g.ty * TILE + 0.5, g.w * TILE - 1, g.h * TILE - 1);
  }

  drawParticles(ps) {
    const ctx = this.ctx;
    for (const p of ps.list) {
      ctx.globalAlpha = Math.min(1, p.life / p.max * 2);
      ctx.fillStyle = p.color;
      ctx.fillRect(Math.round(p.x), Math.round(p.y), p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  drawFloats(ps) {
    const ctx = this.ctx;
    for (const f of ps.floats) {
      const img = this.text(f.text, f.color);
      ctx.globalAlpha = f.t > 0.9 ? Math.max(0, 1 - (f.t - 0.9) / 0.4) : 1;
      ctx.drawImage(img, Math.round(f.x - img.width / 2), Math.round(f.y - 7));
    }
    ctx.globalAlpha = 1;
  }

  drawMarkers(game) {
    const it = game.interactTarget;
    if (it && it.entity && !game.builder.active) {
      const e = it.entity;
      const y = Math.round(e.y - 9 + Math.sin(game.time * 6) * 1.5);
      const x = Math.round(e.x + e.w / 2);
      const ctx = this.ctx;
      ctx.fillStyle = '#000'; ctx.fillRect(x - 2, y - 1, 5, 4);
      ctx.fillStyle = '#ffe08a'; ctx.fillRect(x - 1, y, 3, 1); ctx.fillRect(x, y + 1, 1, 1);
    }
  }

  // ------------------------------------------------------------------ night & lights
  drawNight(game, cx, cy) {
    const n = game.nightAmount;
    if (n <= 0.02) return;
    const { W, H } = this;
    const lc = this.light.getContext('2d');
    lc.globalCompositeOperation = 'source-over';
    lc.clearRect(0, 0, W, H);
    lc.fillStyle = `rgba(6, 8, 30, ${0.72 * n})`;
    lc.fillRect(0, 0, W, H);
    lc.globalCompositeOperation = 'destination-out';
    const hole = (x, y, r) => {
      const g = lc.createRadialGradient(x - cx, y - cy, 0, x - cx, y - cy, r);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      lc.fillStyle = g;
      lc.fillRect(x - cx - r, y - cy - r, r * 2, r * 2);
    };
    hole(game.player.cx, game.player.cy, 46);
    for (const s of game.structures) if (s.def.light) hole(s.cx, s.y + s.h / 2, s.def.light * (0.95 + Math.sin(s.anim * 9) * 0.05));
    this.ctx.drawImage(this.light, 0, 0);
    // warm glow of fires
    const ctx = this.ctx;
    for (const s of game.structures) {
      if (!s.def.light) continue;
      const x = s.cx - cx, y = s.y + s.h / 2 - cy;
      const g = ctx.createRadialGradient(x, y, 0, x, y, s.def.light * 0.7);
      g.addColorStop(0, `rgba(255,170,60,${0.22 * n})`);
      g.addColorStop(1, 'rgba(255,170,60,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - s.def.light, y - s.def.light, s.def.light * 2, s.def.light * 2);
    }
  }
}

function parse(hex) {
  if (hex.startsWith('rgb')) return hex.match(/\d+/g).map(Number);
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, t) {
  const A = parse(a), B = parse(b);
  return `rgb(${Math.round(A[0] + (B[0] - A[0]) * t)},${Math.round(A[1] + (B[1] - A[1]) * t)},${Math.round(A[2] + (B[2] - A[2]) * t)})`;
}
function shade(hex, f) { return mix(hex, '#ffffff', f); }
