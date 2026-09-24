// Rendering: integer-scaled internal canvas, camera, parallax backdrop, chunk-cached
// tiles, dynamic tiles (lava, torches), cracks, player, rope, then lighting + HUD.
import { TILE, CHUNK, WORLD_W, WORLD_H, SURFACE_Y, BASE_VIEW_H, CAMERA } from './config.js';
import { TILES, SOLID, TILE_ID as T } from './tiles.js';
import {
  getTileTexture, tileVariantCount, getBackTexture, getCrack, getLavaFrame, getFlameFrame,
  drawSprite, backdrop,
} from './sprites.js';
import { hash2 } from './rng.js';

const OUTLINE = '#07050b';
const WORLD_PX_W = WORLD_W * TILE;
const WORLD_PX_H = WORLD_H * TILE;

// ------------------------------------------------------------------ camera

export class Camera {
  constructor(game) {
    this.game = game;
    this.x = 0; this.y = 0; this.prevX = 0; this.prevY = 0;
    this.viewW = 400; this.viewH = BASE_VIEW_H;
    this.lookX = 0; this.lookY = 0;
    this.shakeT = 0; this.shakeDur = 1; this.shakeMag = 0;
    this.shakeX = 0; this.shakeY = 0;
    this._seed = 1;
  }

  _target() {
    const p = this.game.player;
    return {
      x: p.cx + this.lookX - this.viewW / 2,
      y: p.cy + CAMERA.offsetY + this.lookY - this.viewH / 2,
    };
  }

  _clamp() {
    const maxX = WORLD_PX_W - this.viewW, maxY = WORLD_PX_H - this.viewH;
    // bounds are whole pixels so a camera resting on a bound never shimmers
    this.x = maxX < 0 ? Math.floor(maxX / 2) : Math.max(0, Math.min(maxX, this.x));
    this.y = maxY < 0 ? Math.floor(maxY / 2) : Math.max(0, Math.min(maxY, this.y));
  }

  /** Jump straight to the player (spawn, teleport). */
  snap() {
    const p = this.game.player;
    this.lookX = p.facing * CAMERA.lookAheadX; this.lookY = 0;
    const t = this._target();
    this.x = t.x; this.y = t.y;
    this._clamp();
    this.prevX = this.x; this.prevY = this.y;
  }

  update(dt) {
    const p = this.game.player;
    this.prevX = this.x; this.prevY = this.y;
    const wantX = p.facing * CAMERA.lookAheadX + p.vx * CAMERA.lookVelX;
    this.lookX += (wantX - this.lookX) * (1 - Math.exp(-CAMERA.lookAheadRate * dt));
    let wantY = Math.max(-CAMERA.lookUpMax, Math.min(CAMERA.lookDownMax, p.vy * CAMERA.lookVelY));
    // hanging from the grapple: look up toward the anchor
    const gr = p.grapple;
    if (gr && gr.state === 'attached') wantY = Math.max(-CAMERA.anchorLookMax, Math.min(0, (gr.anchorY - p.cy) * CAMERA.anchorLook));
    this.lookY += (wantY - this.lookY) * (1 - Math.exp(-2.5 * dt));
    const t = this._target();
    const kx = 1 - Math.exp(-CAMERA.followX * dt);
    const ky = 1 - Math.exp(-(Math.abs(p.vy) > 250 ? CAMERA.followYFast : CAMERA.followY) * dt);
    this.x += (t.x - this.x) * kx;
    this.y += (t.y - this.y) * ky;
    this._clamp();
    // shake: decaying random offset
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const k = Math.max(0, this.shakeT / this.shakeDur) * this.shakeMag;
      this._seed = (this._seed * 16807) % 2147483647;
      const a = (this._seed / 2147483647) * Math.PI * 2;
      this.shakeX = Math.cos(a) * k; this.shakeY = Math.sin(a) * k;
    } else { this.shakeX = 0; this.shakeY = 0; }
  }

  /** Screen shake (px, s). Stronger shakes override weaker ones. */
  shake(intensity, duration) {
    const cur = this.shakeT > 0 ? this.shakeMag * (this.shakeT / this.shakeDur) : 0;
    if (intensity >= cur) { this.shakeMag = intensity; this.shakeDur = duration; this.shakeT = duration; }
  }

  /**
   * Interpolated, pixel-snapped camera position for rendering.
   * With an anchor (the interpolated player position) the camera is snapped
   * relative to the anchor's rounded position: cam = round(a) - round(a - cam).
   * Rounding camera and player independently makes the hero flip between two
   * screen columns almost every frame while running; this keeps the hero
   * steady and lets the world carry the whole-pixel stepping instead. A camera
   * resting on an integer bound still maps to exactly that bound.
   */
  renderPos(alpha, out = { x: 0, y: 0 }, anchorX = null, anchorY = null) {
    const x = this.prevX + (this.x - this.prevX) * alpha + this.shakeX;
    const y = this.prevY + (this.y - this.prevY) * alpha + this.shakeY;
    out.x = anchorX === null ? Math.round(x) : Math.round(anchorX) - Math.round(anchorX - x);
    out.y = anchorY === null ? Math.round(y) : Math.round(anchorY) - Math.round(anchorY - y);
    return out;
  }
}

// ------------------------------------------------------------------ renderer

const MAX_CHUNKS = 28;

export class Renderer {
  constructor(game, display) {
    this.game = game;
    this.display = display;
    this.dctx = display.getContext('2d', { alpha: false });
    this.buf = document.createElement('canvas');
    this.ctx = this.buf.getContext('2d');
    this.scale = 1; this.W = 320; this.H = 180; this.offX = 0; this.offY = 0;
    this.chunks = new Map(); // key -> { canvas, version, used }
    this.frameNo = 0;
    this._cam = { x: 0, y: 0 };
    this._pp = { x: 0, y: 0 };
  }

  /** Size the display canvas to device pixels and pick the integer scale (§9). */
  resize(cssW, cssH, dpr) {
    const devW = Math.max(1, Math.round(cssW * dpr)), devH = Math.max(1, Math.round(cssH * dpr));
    this.display.width = devW; this.display.height = devH;
    this.display.style.width = cssW + 'px'; this.display.style.height = cssH + 'px';
    this.scale = Math.max(1, Math.round(devH / BASE_VIEW_H));
    this.W = Math.floor(devW / this.scale);
    this.H = Math.floor(devH / this.scale);
    this.buf.width = this.W; this.buf.height = this.H;
    this.offX = Math.floor((devW - this.W * this.scale) / 2);
    this.offY = Math.floor((devH - this.H * this.scale) / 2);
    this.cssToInternal = dpr / this.scale;
    this.ctx.imageSmoothingEnabled = false;
    this.dctx.imageSmoothingEnabled = false;
    const cam = this.game.camera;
    cam.viewW = this.W; cam.viewH = this.H;
  }

  /** Drop every cached chunk (new world). */
  invalidateAll() { this.chunks.clear(); }

  render(alpha) {
    const g = this.game;
    const ctx = this.ctx;
    this.frameNo++;
    const pp = this._playerPos(alpha);
    const cam = g.camera.renderPos(alpha, this._cam, pp.x, pp.y);
    const cx = cam.x, cy = cam.y;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#05030a';
    ctx.fillRect(0, 0, this.W, this.H);
    this.drawBackdrop(ctx, cx, cy);
    this.drawTiles(ctx, cx, cy);
    this.drawDynamicTiles(ctx, cx, cy);
    this.drawCracks(ctx, cx, cy);
    this.drawCamp(ctx, cx, cy);
    g.entities.draw(ctx, cx, cy, alpha);
    g.enemies.draw(ctx, cx, cy, alpha);
    this.drawRope(ctx, cx, cy, alpha);
    this.drawPlayer(ctx, cx, cy);
    g.particles.draw(ctx, cx, cy);
    this.drawReticle(ctx, cx, cy);
    g.lighting.compute(cx, cy, this.W, this.H);
    g.lighting.draw(ctx, cx, cy, alpha);
    g.hud.draw(ctx, this.W, this.H);
    // present: nearest-neighbour integer upscale
    const d = this.dctx;
    d.imageSmoothingEnabled = false;
    d.drawImage(this.buf, 0, 0, this.W, this.H, this.offX, this.offY, this.W * this.scale, this.H * this.scale);
  }

  // ---------------------------------------------------------------- backdrop
  drawBackdrop(ctx, cx, cy) {
    const groundY = SURFACE_Y * TILE - cy; // screen y of the surface line
    if (groundY < -8) return;
    const W = this.W;
    const refCamY = SURFACE_Y * TILE - this.H * 0.55;
    const dy = refCamY - cy; // >0 when looking higher than the usual camp view
    const skyTop = groundY - backdrop.skyH + 40 + dy * 0.1;
    ctx.fillStyle = '#05060f';
    ctx.fillRect(0, 0, W, Math.max(0, Math.ceil(skyTop)) + 1);
    ctx.drawImage(backdrop.skyColumn, 0, 0, 4, backdrop.skyH, 0, Math.round(skyTop), W, backdrop.skyH);
    const t = this.game.time;
    for (const s of backdrop.stars) {
      const sx = Math.round((((s.x - cx * 0.04) % 1024) + 1024) % 1024) % Math.max(W, 1024);
      if (sx >= W) continue;
      const sy = Math.round(s.y + skyTop - 20);
      const tw = 0.55 + 0.45 * Math.sin(t * (1 + s.b * 2) + s.p);
      ctx.globalAlpha = (0.35 + s.b * 0.65) * tw;
      ctx.fillStyle = s.big ? '#fff6dd' : '#b8c0ff';
      ctx.fillRect(sx, sy, 1, 1);
      if (s.big && tw > 0.8) { ctx.fillRect(sx - 1, sy, 3, 1); ctx.fillRect(sx, sy - 1, 1, 3); }
    }
    ctx.globalAlpha = 1;
    // moon with a soft halo
    const mx = Math.round(W * 0.74 - cx * 0.02), my = Math.round(skyTop + 38);
    ctx.globalAlpha = 0.85;
    ctx.drawImage(backdrop.moon, mx - 19, my - 19);
    ctx.globalAlpha = 1;
    const layer = (img, pf, yOff, color) => {
      const y = Math.round(groundY - img.height + yOff + dy * pf * 0.35);
      const w = img.width;
      let x = -Math.round(((cx * pf) % w + w) % w);
      for (; x < W; x += w) ctx.drawImage(img, x, y);
      if (color && y + img.height < groundY + 16) { ctx.fillStyle = color; ctx.fillRect(0, y + img.height, W, groundY + 16 - (y + img.height)); }
    };
    layer(backdrop.mountains, 0.1, 20, '#191834');
    // castle: a single silhouette placed to the right of the camp
    const cas = backdrop.castle;
    const casX = Math.round(W * 0.5 + 60 - cx * 0.22 + 120);
    const casY = Math.round(groundY - cas.height + 34 + dy * 0.1);
    ctx.drawImage(cas, casX, casY);
    ctx.fillStyle = '#0f0e22';
    if (casY + cas.height < groundY + 16) ctx.fillRect(casX, casY + cas.height, cas.width, groundY + 16 - casY - cas.height);
    // low fog band
    const fogY = Math.round(groundY - 26 + dy * 0.2);
    for (let i = 0; i < 4; i++) {
      ctx.globalAlpha = 0.05 + i * 0.03;
      ctx.fillStyle = '#6a5a8a';
      ctx.fillRect(0, fogY + i * 5, W, 5);
    }
    ctx.globalAlpha = 1;
    layer(backdrop.hills, 0.45, 12, '#0a0916');
  }

  // ---------------------------------------------------------------- tiles (chunk cache)
  drawTiles(ctx, cx, cy) {
    const world = this.game.world;
    const c0x = Math.max(0, Math.floor(cx / (CHUNK * TILE))), c1x = Math.min(world.chunksX - 1, Math.floor((cx + this.W) / (CHUNK * TILE)));
    const c0y = Math.max(0, Math.floor(cy / (CHUNK * TILE))), c1y = Math.min(world.chunksY - 1, Math.floor((cy + this.H) / (CHUNK * TILE)));
    for (let ky = c0y; ky <= c1y; ky++) {
      for (let kx = c0x; kx <= c1x; kx++) {
        const canvas = this._chunk(kx, ky);
        ctx.drawImage(canvas, kx * CHUNK * TILE - cx, ky * CHUNK * TILE - cy);
      }
    }
  }

  _chunk(kx, ky) {
    const world = this.game.world;
    const key = ky * world.chunksX + kx;
    const ver = world.chunkVersion[key];
    let e = this.chunks.get(key);
    if (e && e.version === ver && e.world === world) { e.used = this.frameNo; return e.canvas; }
    if (!e) {
      let canvas;
      if (this.chunks.size >= MAX_CHUNKS) {
        // evict the least recently used chunk and reuse its canvas
        let oldKey = -1, oldUsed = Infinity;
        for (const [k, v] of this.chunks) if (v.used < oldUsed) { oldUsed = v.used; oldKey = k; }
        canvas = this.chunks.get(oldKey).canvas;
        this.chunks.delete(oldKey);
      } else {
        canvas = document.createElement('canvas');
        canvas.width = CHUNK * TILE; canvas.height = CHUNK * TILE;
      }
      e = { canvas, version: -1, used: 0, world };
      this.chunks.set(key, e);
    }
    this._buildChunk(kx, ky, e.canvas);
    e.version = ver; e.used = this.frameNo; e.world = world;
    return e.canvas;
  }

  _buildChunk(kx, ky, canvas) {
    const world = this.game.world;
    const g = canvas.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, canvas.width, canvas.height);
    const tx0 = kx * CHUNK, ty0 = ky * CHUNK;
    for (let j = 0; j < CHUNK; j++) {
      const ty = ty0 + j;
      if (ty >= world.h) break;
      for (let i = 0; i < CHUNK; i++) {
        const tx = tx0 + i;
        if (tx >= world.w) break;
        const px = i * TILE, py = j * TILE;
        const id = world.get(tx, ty);
        const h = hash2(tx, ty, 0x7157);
        if (SOLID[id]) {
          g.drawImage(getTileTexture(id, h % tileVariantCount(id)), px, py);
          this._edges(g, world, tx, ty, px, py, id);
        } else {
          const back = world.getBack(tx, ty);
          if (back) {
            g.drawImage(getBackTexture(back, h % 3), px, py);
            this._backShadow(g, world, tx, ty, px, py);
          }
          if (id !== T.AIR && id !== T.LAVA) { // deco (torch flames are drawn dynamically)
            const n = tileVariantCount(id);
            if (n) {
              const tex = getTileTexture(id, (h >>> 3) % n);
              // cobwebs hug the solid side
              if (id === T.COBWEB && SOLID[world.get(tx + 1, ty)] && !SOLID[world.get(tx - 1, ty)]) {
                g.save(); g.translate(px + TILE, py); g.scale(-1, 1); g.drawImage(tex, 0, 0); g.restore();
              } else g.drawImage(tex, px, py);
            }
          }
          // grass blades poking up from a grass tile below
          if (world.get(tx, ty + 1) === T.GRASS) this._grassTuft(g, px, py, h);
        }
      }
    }
  }

  /** Dark outline + rim light on the air-facing sides of a solid tile. */
  _edges(g, world, tx, ty, px, py, id) {
    const up = !SOLID[world.get(tx, ty - 1)], dn = !SOLID[world.get(tx, ty + 1)];
    const lf = !SOLID[world.get(tx - 1, ty)], rt = !SOLID[world.get(tx + 1, ty)];
    if (!(up || dn || lf || rt)) return;
    const cols = TILES[id].colors;
    if (up) {
      g.fillStyle = OUTLINE; g.fillRect(px, py, TILE, 1);
      if (id !== T.GRASS) { g.fillStyle = cols[3]; g.globalAlpha = 0.55; g.fillRect(px, py + 1, TILE, 1); g.globalAlpha = 1; }
    }
    if (dn) {
      g.fillStyle = OUTLINE; g.fillRect(px, py + TILE - 1, TILE, 1);
      g.fillStyle = '#000'; g.globalAlpha = 0.35; g.fillRect(px, py + TILE - 3, TILE, 2); g.globalAlpha = 1;
    }
    if (lf) {
      g.fillStyle = OUTLINE; g.fillRect(px, py, 1, TILE);
      g.fillStyle = cols[3]; g.globalAlpha = 0.25; g.fillRect(px + 1, py + 1, 1, TILE - 2); g.globalAlpha = 1;
    }
    if (rt) {
      g.fillStyle = OUTLINE; g.fillRect(px + TILE - 1, py, 1, TILE);
      g.fillStyle = '#000'; g.globalAlpha = 0.3; g.fillRect(px + TILE - 2, py, 1, TILE); g.globalAlpha = 1;
    }
    // rounded convex corners
    g.fillStyle = OUTLINE;
    if (up && lf) { g.clearRect(px, py, 1, 1); g.fillRect(px + 1, py + 1, 1, 1); }
    if (up && rt) { g.clearRect(px + TILE - 1, py, 1, 1); g.fillRect(px + TILE - 2, py + 1, 1, 1); }
    if (dn && lf) { g.clearRect(px, py + TILE - 1, 1, 1); g.fillRect(px + 1, py + TILE - 2, 1, 1); }
    if (dn && rt) { g.clearRect(px + TILE - 1, py + TILE - 1, 1, 1); g.fillRect(px + TILE - 2, py + TILE - 2, 1, 1); }
  }

  /** Soft contact shadows on the back wall next to solid tiles. */
  _backShadow(g, world, tx, ty, px, py) {
    g.fillStyle = '#000';
    if (SOLID[world.get(tx, ty - 1)]) {
      g.globalAlpha = 0.5; g.fillRect(px, py, TILE, 2);
      g.globalAlpha = 0.3; g.fillRect(px, py + 2, TILE, 2);
      g.globalAlpha = 0.15; g.fillRect(px, py + 4, TILE, 3);
    }
    if (SOLID[world.get(tx - 1, ty)]) { g.globalAlpha = 0.35; g.fillRect(px, py, 2, TILE); g.globalAlpha = 0.15; g.fillRect(px + 2, py, 2, TILE); }
    if (SOLID[world.get(tx + 1, ty)]) { g.globalAlpha = 0.35; g.fillRect(px + TILE - 2, py, 2, TILE); g.globalAlpha = 0.15; g.fillRect(px + TILE - 4, py, 2, TILE); }
    if (SOLID[world.get(tx, ty + 1)]) { g.globalAlpha = 0.2; g.fillRect(px, py + TILE - 1, TILE, 1); }
    g.globalAlpha = 1;
  }

  _grassTuft(g, px, py, h) {
    const cols = TILES[T.GRASS].colors;
    for (let k = 0; k < 16; k++) {
      const r = (h >>> (k % 24)) & 7;
      if (r < 3) continue;
      const bh = r > 5 ? 3 : r > 3 ? 2 : 1;
      g.fillStyle = r > 5 ? cols[2] : cols[3];
      g.fillRect(px + k, py + TILE - bh, 1, bh);
    }
  }

  // ---------------------------------------------------------------- animated tiles
  drawDynamicTiles(ctx, cx, cy) {
    const world = this.game.world;
    const t = this.game.time;
    const tx0 = Math.max(0, Math.floor(cx / TILE)), tx1 = Math.min(world.w - 1, Math.floor((cx + this.W) / TILE));
    const ty0 = Math.max(0, Math.floor(cy / TILE)), ty1 = Math.min(world.h - 1, Math.floor((cy + this.H) / TILE));
    const lavaF = Math.floor(t * 6);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const id = world.types[ty * world.w + tx];
        if (id === T.LAVA) {
          const above = world.get(tx, ty - 1);
          const surface = above !== T.LAVA && !SOLID[above];
          ctx.drawImage(getLavaFrame(lavaF + ((tx * 3) & 7), surface), tx * TILE - cx, ty * TILE - cy);
        } else if (id === T.TORCH) {
          ctx.drawImage(getFlameFrame(Math.floor(t * 10 + tx * 7)), tx * TILE - cx + 5, ty * TILE - cy);
        }
      }
    }
  }

  drawCracks(ctx, cx, cy) {
    const world = this.game.world;
    for (const i of world.damaged) {
      if (world.damage[i] <= 0) continue;
      const tx = i % world.w, ty = (i / world.w) | 0;
      const sx = tx * TILE - cx, sy = ty * TILE - cy;
      if (sx < -TILE || sy < -TILE || sx > this.W || sy > this.H) continue;
      ctx.drawImage(getCrack(world.crackStage(tx, ty)), sx, sy);
    }
  }

  // ---------------------------------------------------------------- camp props
  drawCamp(ctx, cx, cy) {
    const camp = this.game.gen && this.game.gen.camp;
    if (!camp) return;
    const groundY = camp.surfaceY * TILE - cy;
    if (groundY < -8 || groundY > this.H + 80) return;
    for (const p of camp.props) {
      const sx = p.x - cx;
      if (sx < -40 || sx > this.W + 40) continue;
      drawSprite(ctx, p.kind, 0, sx, groundY);
    }
    const f = camp.forge;
    drawSprite(ctx, 'forge', 0, f.x - cx, groundY);
    drawSprite(ctx, 'smith', Math.floor(this.game.time * 1.5) % 2, f.npcX - cx, groundY, true);
  }

  // ---------------------------------------------------------------- player + rope
  /** Interpolated player top-left for this frame (shared object, computed once in render()). */
  _playerPos(alpha) {
    const p = this.game.player;
    this._pp.x = p.prevX + (p.x - p.prevX) * alpha;
    this._pp.y = p.prevY + (p.y - p.prevY) * alpha;
    return this._pp;
  }

  drawPlayer(ctx, cx, cy) {
    const p = this.game.player;
    if (p.iframes > 0 && !p.dead && Math.floor(p.iframes * 16) % 2 === 0) return; // i-frame blink
    const pos = this._pp;
    // same rounding as the camera anchor: steady on screen while the camera follows
    const fx = Math.round(pos.x) + Math.round(p.w / 2) - cx;
    const fy = Math.round(pos.y) + p.h - cy;
    const flip = p.facing < 0;
    drawSprite(ctx, 'player_' + p.anim, p.animFrame, fx, fy + 1, flip);
    if (p.anim.startsWith('strike_') && p.animFrame === 1) {
      ctx.globalAlpha = 0.75;
      if (p.anim === 'strike_side') drawSprite(ctx, 'slash_side', 0, fx + p.facing * 7, fy - 12, flip);
      else if (p.anim === 'strike_up') drawSprite(ctx, 'slash_up', 0, fx, fy - 20, flip);
      else drawSprite(ctx, 'slash_down', 0, fx, fy - 4, flip);
      ctx.globalAlpha = 1;
    }
  }

  _plot(ctx, x0, y0, x1, y1, colA, colB) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy, n = 0;
    for (let guard = 0; guard < 600; guard++) {
      ctx.fillStyle = (n++ >> 1) & 1 ? colB : colA;
      ctx.fillRect(x0, y0, 1, 1);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  drawRope(ctx, cx, cy, alpha) {
    const gr = this.game.player.grapple;
    if (gr.state === 'idle') return;
    const p = this.game.player;
    const pos = this._pp;
    const ox = Math.round(pos.x) + p.w / 2 + p.facing * 4 - cx, oy = Math.round(pos.y) + 6 - cy;
    const hx = gr.prevHookX + (gr.hookX - gr.prevHookX) * alpha - cx;
    const hy = gr.prevHookY + (gr.hookY - gr.prevHookY) * alpha - cy;
    const dist = Math.hypot(hx - ox, hy - oy);
    const slack = gr.state === 'attached' ? Math.max(0, gr.length - dist) : 0;
    const colA = '#b08850', colB = '#6e5232';
    if (slack > 2) {
      // sagging rope: quadratic curve sampled into short segments
      const sag = Math.min(18, slack * 0.6);
      const mx = (ox + hx) / 2, my = (oy + hy) / 2 + sag;
      let lx = ox, ly = oy;
      const n = Math.max(4, Math.ceil(dist / 6));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const x = (1 - t) * (1 - t) * ox + 2 * (1 - t) * t * mx + t * t * hx;
        const y = (1 - t) * (1 - t) * oy + 2 * (1 - t) * t * my + t * t * hy;
        this._plot(ctx, lx, ly, x, y, colA, colB);
        lx = x; ly = y;
      }
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      this._plot(ctx, ox, oy + 1, hx, hy + 1, 'rgba(0,0,0,0.35)', 'rgba(0,0,0,0.35)');
      this._plot(ctx, ox, oy, hx, hy, colA, colB);
    }
    // hook head: metal diamond with prongs facing the flight direction
    const x = Math.round(hx), y = Math.round(hy);
    const ddx = gr.dirX, ddy = gr.dirY;
    ctx.fillStyle = OUTLINE; ctx.fillRect(x - 2, y - 1, 5, 3); ctx.fillRect(x - 1, y - 2, 3, 5);
    ctx.fillStyle = '#9aa4b8'; ctx.fillRect(x - 1, y, 3, 1); ctx.fillRect(x, y - 1, 1, 3);
    ctx.fillStyle = '#e8eef8'; ctx.fillRect(x, y, 1, 1);
    const px = -ddy, py = ddx;
    ctx.fillStyle = '#c8d0de';
    ctx.fillRect(Math.round(x + px * 2 - ddx), Math.round(y + py * 2 - ddy), 1, 1);
    ctx.fillRect(Math.round(x - px * 2 - ddx), Math.round(y - py * 2 - ddy), 1, 1);
  }

  /** Predicted grapple anchor: pulsing corner brackets. */
  drawReticle(ctx, cx, cy) {
    const g = this.game;
    const gr = g.player.grapple;
    const p = g.player;
    if (g.state !== 'PLAYING' || gr.state !== 'idle' || !gr.predicted || p.dead) return;
    if (p.strikeT > 0 || g.input.held('attack') || g.input.aimY > 0.5) return; // digging: keep it clean
    const x = Math.round(gr.predicted.x - cx), y = Math.round(gr.predicted.y - cy);
    const pulse = 0.5 + 0.5 * Math.sin(g.time * 8);
    ctx.globalAlpha = (g.input.aimActive ? 0.55 : 0.25) + pulse * 0.3;
    ctx.fillStyle = '#ffe6a0';
    const r = 4 + Math.round(pulse);
    const corner = (ax, ay, hx, vy) => {
      ctx.fillRect(ax, ay, 1, 1); ctx.fillRect(ax + hx, ay, 1, 1); ctx.fillRect(ax + hx * 2, ay, 1, 1);
      ctx.fillRect(ax, ay + vy, 1, 1); ctx.fillRect(ax, ay + vy * 2, 1, 1);
    };
    corner(x - r, y - r, 1, 1); corner(x + r, y - r, -1, 1);
    corner(x - r, y + r, 1, -1); corner(x + r, y + r, -1, -1);
    ctx.fillRect(x, y, 1, 1);
    ctx.globalAlpha = 1;
  }
}
