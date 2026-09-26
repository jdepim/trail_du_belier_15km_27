// Rendering (DESIGN §9): integer-scaled internal canvas (CSS upscale), camera, parallax starfield with
// regional nebulae, chunk-cached tiles with baked light direction, celestial bodies, entities, the
// astronaut and its flames, interior darkness pierced by the headlamp and panel lights, screen
// overlays (heat, ion storm, black hole vignette), the HUD, the map state and the victory cinematic.
// render() also drives the audio loops and the ambience zone from the game state (the simulation
// never calls audio.setLoop / setZone).
//
//   new Camera(game)
//     x, y            world position of the view CENTRE (smoothed, look-ahead in the velocity direction)
//     update(dt)      fixed tick; snap() jumps onto the player; shake(px, s) (stronger overrides weaker)
//     renderPos(alpha, out, anchorX?, anchorY?) -> out { x, y } integer TOP-LEFT of the view this frame
//   new Renderer(game, canvas)
//     resize(cssW, cssH, dpr)   scale = max(1, floor(deviceH / VIEW.targetHeight)); the canvas holds the
//                               internal W×H image, CSS upscales it (image-rendering: pixelated) and centres
//                               it; sets game.view = { w, h, scale, cssToInternal, camX, camY }
//     render(alpha)             TITLE: drifting starfield · MAP: drawMap · VICTORY: fade then cinematic ·
//                               every other state: the world (frozen behind DOM overlays when not ticking)
//     invalidateAll()           new world: drop cached chunks and the map terrain
//     victoryT / victoryDone    cinematic clock (s) / true once VICTORY_CINE.total has elapsed
//     chunkBuilds, cellPatches  cache statistics (tests / debug)
import { TILE, CHUNK, VIEW, CAMERA, CENTER, ZONES, POI_BY_KEY, HAZARDS, SUNS } from './config.js';
import { TILES, TILE_ID as T, SOLID, LIGHT } from './tiles.js';
import { getTileTexture, tileVariant, drawSprite, getSprite, getGlow, backdrop, celestial } from './sprites.js';
import { drawMap, invalidateMap } from './mapview.js';
import { drawText } from './hud.js';
import { raycast } from './physics.js';
import { hash2 } from './rng.js';
import { LIGHT_DIR, BACKDROP, NEBULA_REGIONS, DARK, FX, VICTORY_CINE } from './render-config.js';

const TAU = Math.PI * 2;
const CHUNK_PX = CHUNK * TILE;
const MAX_CHUNKS = 48;
const OUTLINE = '#05070c';
const SPACE = T.SPACE, DOOR_L = T.DOOR_LOCKED, DOOR_O = T.DOOR_OPEN, WINDOW = T.WINDOW;
const IS_DOOR = new Uint8Array(256); IS_DOOR[DOOR_L] = 1; IS_DOOR[DOOR_O] = 1;
const DARK_ZONE = new Uint8Array(256);
for (const z of ZONES) DARK_ZONE[z.id] = z.dark ? 1 : 0;
const AST_NAMES = [0, 1, 2].map((s) => [0, 1, 2, 3].map((v) => `ast_${s}_${v}`));
const ITEM_SPRITE = { keycard: 'item_keycard', explosives: 'item_explosives', heatshield: 'item_heatshield', anchor: 'item_anchor' };
const ITEM_GLOW = { keycard: 'cyan', explosives: 'red', heatshield: 'orange', anchor: 'violet' };
const PICKUP_SPRITE = { salvage: 'pk_salvage', o2: 'pk_o2', fuel: 'pk_fuel', repair: 'pk_repair' };
const FLAME = ['#ffffff', '#fff2a0', '#ffc040', '#ff7a20', '#c83a10'];
const RETRO = ['#ffffff', '#d8eaff', '#9ab8e0'];
const MOTE = ['#5a2a8a', '#9a3a9a', '#e05a5a', '#ffa040', '#fff0c0'];
const DASH = [4, 6];
const NO_DASH = [];
const KEY_HINT = new Map(); // context label -> 'E : LABEL' (built once per label)

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ------------------------------------------------------------------ camera

export class Camera {
  constructor(game) {
    this.game = game;
    this.x = CENTER; this.y = CENTER; this.prevX = CENTER; this.prevY = CENTER;
    this.lookX = 0; this.lookY = 0;
    this.shakeT = 0; this.shakeDur = 1; this.shakeMag = 0;
    this.shakeX = 0; this.shakeY = 0;
    this._seed = 1;
  }

  snap() {
    const p = this.game.player;
    if (!p) return;
    this.lookX = 0; this.lookY = 0;
    this.x = p.x; this.y = p.y;
    this.prevX = this.x; this.prevY = this.y;
  }

  update(dt) {
    const p = this.game.player;
    this.prevX = this.x; this.prevY = this.y;
    if (p) {
      let wx = p.vx * CAMERA.lookAheadVel, wy = p.vy * CAMERA.lookAheadVel;
      const m = Math.hypot(wx, wy);
      if (m > CAMERA.lookAhead) { wx *= CAMERA.lookAhead / m; wy *= CAMERA.lookAhead / m; }
      const kl = 1 - Math.exp(-CAMERA.lookAheadRate * dt);
      this.lookX += (wx - this.lookX) * kl; this.lookY += (wy - this.lookY) * kl;
      const k = 1 - Math.exp(-CAMERA.smoothing * dt);
      this.x += (p.x + this.lookX - this.x) * k;
      this.y += (p.y + this.lookY - this.y) * k;
    }
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const mag = Math.max(0, this.shakeT / this.shakeDur) * this.shakeMag;
      this._seed = (this._seed * 16807) % 2147483647;
      const a = (this._seed / 2147483647) * TAU;
      this.shakeX = Math.cos(a) * mag; this.shakeY = Math.sin(a) * mag;
    } else { this.shakeX = 0; this.shakeY = 0; }
  }

  shake(px, s) {
    const cur = this.shakeT > 0 ? this.shakeMag * (this.shakeT / this.shakeDur) : 0;
    if (px >= cur) { this.shakeMag = px; this.shakeDur = s; this.shakeT = s; }
  }

  /**
   * Interpolated, pixel-snapped top-left of the view. With an anchor (the interpolated player) the
   * camera is snapped relative to the anchor's rounded position, cam = round(a) - round(a - cam), so
   * the astronaut never shimmers between two screen columns while both move.
   */
  renderPos(alpha, out, anchorX = null, anchorY = null) {
    const v = this.game.view;
    const w = v ? v.w : 0, h = v ? v.h : 0;
    const x = this.prevX + (this.x - this.prevX) * alpha + this.shakeX - w / 2;
    const y = this.prevY + (this.y - this.prevY) * alpha + this.shakeY - h / 2;
    out.x = anchorX === null ? Math.round(x) : Math.round(anchorX) - Math.round(anchorX - x);
    out.y = anchorY === null ? Math.round(y) : Math.round(anchorY) - Math.round(anchorY - y);
    return out;
  }
}

// ------------------------------------------------------------------ renderer

export class Renderer {
  constructor(game, canvas) {
    this.game = game;
    this.display = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.W = 320; this.H = 180; this.scale = 1;
    if (!game.view) game.view = { w: this.W, h: this.H, scale: 1, cssToInternal: 1, camX: 0, camY: 0 };
    this.chunks = new Map();
    this.frameNo = 0; this.chunkBuilds = 0; this.cellPatches = 0;
    this._built = 0;
    this._logWorld = null; this._logSeen = 0;
    this._cam = { x: 0, y: 0 };
    this._pp = { x: 0, y: 0 };
    this._ray = { x: 0, y: 0, tx: 0, ty: 0, t: 0 };
    this.clock = 0; this._last = 0;
    this.victoryT = 0; this.victoryDone = false;
    this._zone = '';
    this._lightCap = 0;
    this.darkCanvas = null; this.glowCanvas = null;
    this._lightDir = { x: LIGHT_DIR.x, y: LIGHT_DIR.y };
  }

  resize(cssW, cssH, dpr) {
    const devW = Math.max(1, Math.round(cssW * dpr)), devH = Math.max(1, Math.round(cssH * dpr));
    this.scale = Math.max(1, Math.floor(devH / VIEW.targetHeight));
    this.W = Math.floor(devW / this.scale);
    this.H = Math.floor(devH / this.scale);
    const offX = Math.floor((devW - this.W * this.scale) / 2), offY = Math.floor((devH - this.H * this.scale) / 2);
    this.display.width = this.W; this.display.height = this.H;
    const st = this.display.style;
    if (st) {
      st.width = (this.W * this.scale) / dpr + 'px'; st.height = (this.H * this.scale) / dpr + 'px';
      st.left = offX / dpr + 'px'; st.top = offY / dpr + 'px';
    }
    this.cssToInternal = dpr / this.scale;
    const v = this.game.view;
    v.w = this.W; v.h = this.H; v.scale = this.scale; v.cssToInternal = this.cssToInternal;
    this.ctx.imageSmoothingEnabled = false;
  }

  invalidateAll() { this.chunks.clear(); this._logWorld = null; invalidateMap(); }

  // ================================================================ frame

  render(alpha) {
    const g = this.game, ctx = this.ctx;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const rdt = this._last ? Math.min(0.1, Math.max(0, (now - this._last) / 1000)) : 1 / 60;
    this._last = now;
    this.clock += rdt;
    this.frameNo++;
    this._built = 0;
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    const state = g.state;
    if (state !== 'VICTORY') { this.victoryT = 0; this.victoryDone = false; }
    if (!g.world || !g.player || state === 'TITLE') { this._title(ctx); this._driveAudio(state); return; }
    if (state === 'MAP') { drawMap(ctx, g, this.W, this.H); this._driveAudio(state); return; }
    if (state === 'VICTORY') {
      this.victoryT += rdt;
      if (this.victoryT >= VICTORY_CINE.total) this.victoryDone = true;
      if (this.victoryT > VICTORY_CINE.fade) { this._cinematic(ctx, this.victoryT - VICTORY_CINE.fade); this._driveAudio(state); return; }
    }
    this._world(ctx, alpha, state);
    if (state === 'VICTORY') {
      ctx.globalAlpha = clamp01(this.victoryT / VICTORY_CINE.fade);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, this.W, this.H);
      ctx.globalAlpha = 1;
    }
    this._driveAudio(state);
  }

  _world(ctx, alpha, state) {
    const g = this.game, p = g.player;
    const pp = this._pp;
    pp.x = p.prevX + (p.x - p.prevX) * alpha;
    pp.y = p.prevY + (p.y - p.prevY) * alpha;
    const cam = g.camera.renderPos(alpha, this._cam, pp.x, pp.y);
    const cx = cam.x, cy = cam.y;
    g.view.camX = cx; g.view.camY = cy;
    const t = typeof g.time === 'number' ? g.time : this.clock;
    this._backdrop(ctx, cx, cy, t);
    this._tiles(ctx, cx, cy);
    this._tileFx(ctx, cx, cy, t);
    this._entitiesLit(ctx, cx, cy, alpha, t);
    this._player(ctx, cx, cy, t);
    if (g.particles) g.particles.draw(ctx, cx, cy, 'lit');
    this._darkness(ctx, cx, cy, t);
    this._bodies(ctx, cx, cy);
    this._emissive(ctx, cx, cy, alpha, t);
    if (g.particles) g.particles.draw(ctx, cx, cy, 'emissive');
    this._overlays(ctx, t);
    if (state === 'PLAYING') this._interactMarker(ctx, cx, cy);
    if (state !== 'VICTORY' && g.hud) g.hud.draw(ctx);
  }

  // ================================================================ backdrop

  _nebulaWeight(r, wx, wy) {
    let d;
    if (r.ring) d = Math.hypot(wx - CENTER, wy - CENTER);
    else { const poi = POI_BY_KEY[r.poi]; d = Math.hypot(wx - poi.x, wy - poi.y); }
    return clamp01((r.r1 - d) / (r.r1 - r.r0));
  }

  _backdrop(ctx, cx, cy, t) {
    const W = this.W, H = this.H;
    ctx.fillStyle = '#020309';
    ctx.fillRect(0, 0, W, H);
    // regional nebulae (cross-faded, parallax)
    const wx = cx + W / 2, wy = cy + H / 2;
    let sum = 0;
    const nb = backdrop.nebula;
    const nS = BACKDROP.nebulaTile * 2;
    const ox = -Math.round((((cx * BACKDROP.nebulaParallax) % nS) + nS) % nS);
    const oy = -Math.round((((cy * BACKDROP.nebulaParallax) % nS) + nS) % nS);
    for (let i = 0; i < NEBULA_REGIONS.length; i++) {
      const r = NEBULA_REGIONS[i];
      const w = this._nebulaWeight(r, wx, wy);
      if (w <= 0.01) continue;
      sum += w;
      this._tileImage(ctx, nb[r.key], ox, oy, nS, w);
    }
    const neutral = BACKDROP.nebulaBase * (1 - Math.min(1, sum));
    if (neutral > 0.01) this._tileImage(ctx, nb.neutral, ox, oy, nS, neutral);
    // star layers + twinkle
    const Ts = BACKDROP.tile;
    for (let li = 0; li < backdrop.layers.length; li++) {
      const par = BACKDROP.layers[li].parallax;
      const lx = -Math.round((((cx * par) % Ts) + Ts) % Ts), ly = -Math.round((((cy * par) % Ts) + Ts) % Ts);
      this._tileImage(ctx, backdrop.layers[li], lx, ly, Ts, 1);
      const tw = backdrop.twinklers[li];
      const n = tw.length / 5;
      if (!n) continue;
      const cols = backdrop.starCols;
      for (let y0 = ly; y0 < H; y0 += Ts) for (let x0 = lx; x0 < W; x0 += Ts) {
        for (let k = 0; k < n; k++) {
          const sx = x0 + tw[k * 5], sy = y0 + tw[k * 5 + 1];
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
          const b = 0.5 + 0.5 * Math.sin(t * tw[k * 5 + 3] + tw[k * 5 + 2]);
          ctx.globalAlpha = b * (li === 2 ? 1 : 0.75);
          ctx.fillStyle = cols[tw[k * 5 + 4]];
          ctx.fillRect(sx, sy, 1, 1);
          if (li === 2 && b > 0.8) { ctx.globalAlpha = (b - 0.8) * 3; ctx.fillRect(sx - 1, sy, 3, 1); ctx.fillRect(sx, sy - 1, 1, 3); }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  _tileImage(ctx, img, ox, oy, size, alpha) {
    ctx.globalAlpha = alpha;
    for (let y = oy; y < this.H; y += size) for (let x = ox; x < this.W; x += size) ctx.drawImage(img, x, y, size, size);
    ctx.globalAlpha = 1;
  }

  _title(ctx) {
    const a = this.clock * 0.012;
    const r = 3000;
    const cx = CENTER + Math.cos(a) * r - this.W / 2, cy = CENTER + Math.sin(a) * r * 0.8 - this.H / 2;
    this._backdrop(ctx, cx + this.clock * BACKDROP.titleDrift, cy, this.clock);
  }

  // ================================================================ tiles (chunk cache)

  _tiles(ctx, cx, cy) {
    const world = this.game.world;
    this._syncDirty(world);
    const c0x = Math.max(0, Math.floor(cx / CHUNK_PX)), c1x = Math.min(world.chunksX - 1, Math.floor((cx + this.W) / CHUNK_PX));
    const c0y = Math.max(0, Math.floor(cy / CHUNK_PX)), c1y = Math.min(world.chunksY - 1, Math.floor((cy + this.H) / CHUNK_PX));
    for (let ky = c0y; ky <= c1y; ky++) for (let kx = c0x; kx <= c1x; kx++) {
      const e = this._chunk(kx, ky);
      if (e.empty) continue;
      ctx.drawImage(e.canvas, kx * CHUNK_PX - cx, ky * CHUNK_PX - cy);
    }
    this._prefetch(world, c0x, c1x, c0y, c1y);
  }

  /** Keep a one-chunk ring around the view cached (one build per frame at most, only in idle frames). */
  _prefetch(world, c0x, c1x, c0y, c1y) {
    const x0 = Math.max(0, c0x - 1), x1 = Math.min(world.chunksX - 1, c1x + 1);
    const y0 = Math.max(0, c0y - 1), y1 = Math.min(world.chunksY - 1, c1y + 1);
    let missX = -1, missY = -1;
    for (let ky = y0; ky <= y1; ky++) for (let kx = x0; kx <= x1; kx++) {
      if (kx >= c0x && kx <= c1x && ky >= c0y && ky <= c1y) continue;
      const key = ky * world.chunksX + kx;
      const e = this.chunks.get(key);
      if (e && e.world === world && e.version === world.chunkVersion[key]) e.used = this.frameNo;
      else if (missX < 0) { missX = kx; missY = ky; }
    }
    if (missX < 0 || this._built > 0) return;
    if (this.chunks.size >= MAX_CHUNKS && !this.chunks.has(missY * world.chunksX + missX)) {
      let oldUsed = Infinity;
      for (const v of this.chunks.values()) if (v.used < oldUsed) oldUsed = v.used;
      if (oldUsed >= this.frameNo) return;
    }
    this._chunk(missX, missY);
  }

  _chunk(kx, ky) {
    const world = this.game.world;
    const key = ky * world.chunksX + kx;
    const ver = world.chunkVersion[key];
    let e = this.chunks.get(key);
    if (e && e.version === ver && e.world === world) { e.used = this.frameNo; return e; }
    if (!e) {
      let canvas;
      if (this.chunks.size >= MAX_CHUNKS) {
        let oldKey = -1, oldUsed = Infinity;
        for (const [k, v] of this.chunks) if (v.used < oldUsed) { oldUsed = v.used; oldKey = k; }
        canvas = this.chunks.get(oldKey).canvas;
        this.chunks.delete(oldKey);
      } else {
        canvas = document.createElement('canvas');
        canvas.width = CHUNK_PX; canvas.height = CHUNK_PX;
      }
      e = { canvas, version: -1, used: 0, world, logPos: 0, empty: false };
      this.chunks.set(key, e);
    }
    e.empty = this._buildChunk(kx, ky, e.canvas);
    e.version = ver; e.used = this.frameNo; e.world = world; e.logPos = world.dirtyCount;
    this._built++;
    this.chunkBuilds++;
    return e;
  }

  /** Light direction baked into a chunk: toward the nearest sun within reach, else the distant sun. */
  _chunkLight(kx, ky) {
    const hz = this.game.hazards;
    const ccx = (kx + 0.5) * CHUNK_PX, ccy = (ky + 0.5) * CHUNK_PX;
    const L = this._lightDir;
    L.x = LIGHT_DIR.x; L.y = LIGHT_DIR.y;
    const suns = hz && hz.suns && hz.suns.length ? hz.suns : null;
    if (!suns) return L;
    let best = 1500;
    for (const s of suns) {
      const d = Math.hypot(s.x - ccx, s.y - ccy);
      if (d < best && d > 1) { best = d; L.x = (s.x - ccx) / d; L.y = (s.y - ccy) / d; }
    }
    return L;
  }

  /** Apply the world's changed-tile log: redraw the 3×3 cells around each change in cached chunks. */
  _syncDirty(world) {
    const count = world.dirtyCount;
    if (this._logWorld !== world) { this._logWorld = world; this._logSeen = count; return; }
    const seen = this._logSeen;
    if (count === seen) return;
    this._logSeen = count;
    const log = world.dirtyLog, len = log.length;
    if (count - seen > len) return; // overflow: touched chunks rebuild in full
    for (let s = seen; s < count; s++) {
      const i = log[s % len];
      const tx = i % world.w, ty = (i / world.w) | 0;
      const kx0 = Math.max(0, Math.floor((tx - 1) / CHUNK)), kx1 = Math.min(world.chunksX - 1, Math.floor((tx + 1) / CHUNK));
      const ky0 = Math.max(0, Math.floor((ty - 1) / CHUNK)), ky1 = Math.min(world.chunksY - 1, Math.floor((ty + 1) / CHUNK));
      for (let ky = ky0; ky <= ky1; ky++) for (let kx = kx0; kx <= kx1; kx++) {
        const e = this.chunks.get(ky * world.chunksX + kx);
        if (!e || e.world !== world || e.logPos !== seen) continue;
        const bx = kx * CHUNK, by = ky * CHUNK;
        const L = this._chunkLight(kx, ky);
        const gc = e.canvas.getContext('2d');
        const x0 = Math.max(tx - 1, bx), x1 = Math.min(tx + 1, bx + CHUNK - 1, world.w - 1);
        const y0 = Math.max(ty - 1, by), y1 = Math.min(ty + 1, by + CHUNK - 1, world.h - 1);
        if (x1 < x0 || y1 < y0) continue;
        gc.clearRect((x0 - bx) * TILE, (y0 - by) * TILE, (x1 - x0 + 1) * TILE, (y1 - y0 + 1) * TILE);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this._drawCell(gc, world, x, y, (x - bx) * TILE, (y - by) * TILE, L);
        e.empty = false;
        this.cellPatches++;
      }
    }
    for (const [key, e] of this.chunks) if (e.world === world && e.logPos === seen) { e.logPos = count; e.version = world.chunkVersion[key]; }
  }

  /** Build a chunk canvas; returns true when it holds only empty space. */
  _buildChunk(kx, ky, canvas) {
    const world = this.game.world;
    const gc = canvas.getContext('2d');
    gc.imageSmoothingEnabled = false;
    gc.clearRect(0, 0, CHUNK_PX, CHUNK_PX);
    const L = this._chunkLight(kx, ky);
    const tx0 = kx * CHUNK, ty0 = ky * CHUNK;
    let empty = true;
    for (let j = 0; j < CHUNK; j++) {
      const ty = ty0 + j;
      if (ty >= world.h) break;
      const row = ty * world.w;
      for (let i = 0; i < CHUNK; i++) {
        const tx = tx0 + i;
        if (tx >= world.w) break;
        if (world.types[row + tx] === SPACE) continue;
        empty = false;
        this._drawCell(gc, world, tx, ty, i * TILE, j * TILE, L);
      }
    }
    return empty;
  }

  /** One tile of a chunk canvas; everything stays inside its own 8×8 cell (3×3 patching relies on it). */
  _drawCell(gc, world, tx, ty, px, py, L) {
    const id = world.get(tx, ty);
    if (id === SPACE) return;
    if (IS_DOOR[id]) { this._door(gc, world, tx, ty, px, py, id); return; }
    const tex = getTileTexture(id, tileVariant(id, tx, ty));
    if (tex) gc.drawImage(tex, px, py);
    const up = world.get(tx, ty - 1), dn = world.get(tx, ty + 1), lf = world.get(tx - 1, ty), rt = world.get(tx + 1, ty);
    if (SOLID[id]) this._edges(gc, id, px, py, up, dn, lf, rt, L);
    else this._floorShade(gc, px, py, up, dn, lf, rt, L, tx, ty);
  }

  _door(gc, world, tx, ty, px, py, id) {
    const h = IS_DOOR[world.get(tx - 1, ty)] || IS_DOOR[world.get(tx + 1, ty)];
    let part;
    if (h) part = !IS_DOOR[world.get(tx - 1, ty)] ? 0 : !IS_DOOR[world.get(tx + 1, ty)] ? 2 : 1;
    else part = !IS_DOOR[world.get(tx, ty - 1)] ? 0 : !IS_DOOR[world.get(tx, ty + 1)] ? 2 : 1;
    const s = getSprite(id === DOOR_L ? (h ? 'door_h' : 'door_v') : (h ? 'door_open_h' : 'door_open_v'));
    if (s) gc.drawImage(s.canvas, part * 8, 0, 8, 8, px, py, 8, 8);
  }

  /** Autotiled edges of a solid tile: outline + lit lip / shade on the open sides, rounded corners. */
  _edges(gc, id, px, py, up, dn, lf, rt, L) {
    const oU = !SOLID[up], oD = !SOLID[dn], oL = !SOLID[lf], oR = !SOLID[rt];
    const cols = TILES[id].colors;
    if (id === WINDOW) {
      // window frame against the surrounding hull
      gc.fillStyle = '#5d6d84';
      if (up !== WINDOW && !oU) gc.fillRect(px, py, TILE, 1);
      if (dn !== WINDOW && !oD) gc.fillRect(px, py + TILE - 1, TILE, 1);
      if (lf !== WINDOW && !oL) gc.fillRect(px, py, 1, TILE);
      if (rt !== WINDOW && !oR) gc.fillRect(px + TILE - 1, py, 1, TILE);
    }
    if (!(oU || oD || oL || oR)) return;
    const lip = (nx, ny) => nx * L.x + ny * L.y;
    const side = (open, nx, ny, x, y, w, h, ix, iy) => {
      if (!open) return;
      gc.fillStyle = OUTLINE; gc.fillRect(x, y, w, h);
      const k = lip(nx, ny);
      if (k > 0.25) { gc.globalAlpha = 0.35 + 0.4 * k; gc.fillStyle = cols[3]; gc.fillRect(ix, iy, w, h); }
      else if (k < -0.25) { gc.globalAlpha = 0.25 - 0.25 * k; gc.fillStyle = '#000'; gc.fillRect(ix, iy, w, h); }
      gc.globalAlpha = 1;
    };
    side(oU, 0, -1, px, py, TILE, 1, px, py + 1);
    side(oD, 0, 1, px, py + TILE - 1, TILE, 1, px, py + TILE - 2);
    side(oL, -1, 0, px, py, 1, TILE, px + 1, py);
    side(oR, 1, 0, px + TILE - 1, py, 1, TILE, px + TILE - 2, py);
    gc.fillStyle = OUTLINE;
    if (oU && oL) { gc.clearRect(px, py, 1, 1); gc.fillRect(px + 1, py + 1, 1, 1); }
    if (oU && oR) { gc.clearRect(px + TILE - 1, py, 1, 1); gc.fillRect(px + TILE - 2, py + 1, 1, 1); }
    if (oD && oL) { gc.clearRect(px, py + TILE - 1, 1, 1); gc.fillRect(px + 1, py + TILE - 2, 1, 1); }
    if (oD && oR) { gc.clearRect(px + TILE - 1, py + TILE - 1, 1, 1); gc.fillRect(px + TILE - 2, py + TILE - 2, 1, 1); }
  }

  /** Floor contact shadows (stronger when the wall stands between the floor and the light) + door stripes. */
  _floorShade(gc, px, py, up, dn, lf, rt, L, tx, ty) {
    gc.fillStyle = '#000';
    const sh = (wall, nx, ny, x, y, w, h, x2, y2, w2, h2) => {
      if (!SOLID[wall] || IS_DOOR[wall]) return;
      const k = nx * L.x + ny * L.y;
      gc.globalAlpha = 0.42; gc.fillRect(x, y, w, h);
      if (k > 0.2) { gc.globalAlpha = 0.22; gc.fillRect(x2, y2, w2, h2); }
    };
    sh(up, 0, -1, px, py, TILE, 1, px, py + 1, TILE, 2);
    sh(dn, 0, 1, px, py + TILE - 1, TILE, 1, px, py + TILE - 3, TILE, 2);
    sh(lf, -1, 0, px, py, 1, TILE, px + 1, py, 2, TILE);
    sh(rt, 1, 0, px + TILE - 1, py, 1, TILE, px + TILE - 3, py, 2, TILE);
    gc.globalAlpha = 1;
    // hazard stripes on the floor along a door
    const stripes = (x, y, w, h) => {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        gc.fillStyle = (((tx * TILE + x - px + i) + (ty * TILE + y - py + j)) & 3) < 2 ? '#f0c030' : '#1a1608';
        gc.fillRect(x + i, y + j, 1, 1);
      }
    };
    if (IS_DOOR[up]) stripes(px, py, TILE, 2);
    if (IS_DOOR[dn]) stripes(px, py + TILE - 2, TILE, 2);
    if (IS_DOOR[lf]) stripes(px, py, 2, TILE);
    if (IS_DOOR[rt]) stripes(px + TILE - 2, py, 2, TILE);
  }

  // ================================================================ per-frame tile effects

  /** Console LEDs and the dock markings (small, only over visible tiles). */
  _tileFx(ctx, cx, cy, t) {
    const g = this.game, world = g.world;
    const tx0 = Math.max(0, Math.floor(cx / TILE)), tx1 = Math.min(world.w - 1, Math.floor((cx + this.W) / TILE));
    const ty0 = Math.max(0, Math.floor(cy / TILE)), ty1 = Math.min(world.h - 1, Math.floor((cy + this.H) / TILE));
    const types = world.types, wW = world.w;
    const blink = Math.floor(t * 2.3);
    for (let ty = ty0; ty <= ty1; ty++) {
      const row = ty * wW;
      for (let tx = tx0; tx <= tx1; tx++) {
        if (types[row + tx] !== T.PANEL) continue;
        const h = hash2(tx, ty, 0x1ed);
        if (((h >>> 4) + blink) % 3 === 0) continue;
        ctx.fillStyle = (h & 3) === 0 ? '#ff6a4a' : (h & 3) === 1 ? '#5fef8f' : '#ffe07a';
        ctx.fillRect(tx * TILE - cx + 5 + (h & 1), ty * TILE - cy + 5, 1, 1);
      }
    }
    // dock: yellow corner brackets (pulse while docked)
    const en = g.entities;
    const d = en && en.dock;
    if (d) {
      const x0 = Math.round(d.x0 - cx), y0 = Math.round(d.y0 - cy), x1 = Math.round(d.x1 - cx) - 1, y1 = Math.round(d.y1 - cy) - 1;
      if (x1 > -10 && y1 > -10 && x0 < this.W + 10 && y0 < this.H + 10) {
        ctx.globalAlpha = en.inDock ? 0.7 + 0.3 * Math.sin(t * 6) : 0.75;
        ctx.fillStyle = '#f0c030';
        const k = 6;
        ctx.fillRect(x0, y0, k, 1); ctx.fillRect(x0, y0, 1, k);
        ctx.fillRect(x1 - k + 1, y0, k, 1); ctx.fillRect(x1, y0, 1, k);
        ctx.fillRect(x0, y1, k, 1); ctx.fillRect(x0, y1 - k + 1, 1, k);
        ctx.fillRect(x1 - k + 1, y1, k, 1); ctx.fillRect(x1, y1 - k + 1, 1, k);
        ctx.globalAlpha = 1;
      }
    }
  }

  // ================================================================ entities (under the darkness)

  _visible(x, y, cx, cy, m) { const sx = x - cx, sy = y - cy; return sx > -m && sy > -m && sx < this.W + m && sy < this.H + m; }

  _entitiesLit(ctx, cx, cy, alpha, t) {
    const g = this.game, en = g.entities, hz = g.hazards;
    const save = g.save;
    if (en) {
      for (const c of en.crates) if (this._visible(c.x, c.y, cx, cy, 12)) drawSprite(ctx, 'crate', c.opened ? 1 : 0, c.x - cx, c.y - cy);
      for (const r of en.refills) if (this._visible(r.x, r.y, cx, cy, 12)) drawSprite(ctx, 'refill', 0, r.x - cx, r.y - cy);
      for (const l of en.lockers) if (this._visible(l.x, l.y, cx, cy, 12)) drawSprite(ctx, 'locker', 0, l.x - cx, l.y - cy);
      if (en.workbench && this._visible(en.workbench.x, en.workbench.y, cx, cy, 16)) drawSprite(ctx, 'workbench', 0, en.workbench.x - cx, en.workbench.y - cy);
      if (en.capsule && this._visible(en.capsule.x, en.capsule.y, cx, cy, 12)) drawSprite(ctx, 'hatch', save && save.items && save.items.anchor ? 1 : 0, en.capsule.x - cx, en.capsule.y - cy);
      const blink = Math.floor(t * 2.5) & 1;
      for (const tm of en.terminals) if (this._visible(tm.x, tm.y, cx, cy, 10)) drawSprite(ctx, 'terminal', tm.read ? 2 : blink, tm.x - cx, tm.y - cy);
      // pickups
      for (const pk of en.pickups) {
        if (!pk.active) continue;
        const x = pk.prevX + (pk.x - pk.prevX) * alpha, y = pk.prevY + (pk.y - pk.prevY) * alpha;
        if (!this._visible(x, y, cx, cy, 8)) continue;
        if (pk.cacheId) drawSprite(ctx, 'pk_cache', Math.floor(t * 2) & 1, x - cx, y - cy);
        else drawSprite(ctx, PICKUP_SPRITE[pk.kind] || 'pk_salvage', pk.kind === 'salvage' ? pk.variant : 0, x - cx, y - cy);
      }
      // key items floating over their pad
      for (const it of en.items) {
        if (it.taken || !this._visible(it.x, it.y, cx, cy, 16)) continue;
        drawSprite(ctx, ITEM_SPRITE[it.key], 0, it.x - cx, it.y - cy - 2 + Math.round(Math.sin(t * 2.2) * 1.5));
      }
    }
    if (hz) {
      // turrets
      for (const tu of hz.turrets) {
        if (!this._visible(tu.x, tu.y, cx, cy, 20)) continue;
        const x = tu.x - cx, y = tu.y - cy;
        if (!tu.alive) {
          drawSprite(ctx, 'turret_dead', 0, x, y);
          ctx.fillStyle = '#4c515c';
          for (let k = 0; k < 3; k++) {
            const ph = (t * 0.6 + k / 3) % 1;
            ctx.globalAlpha = (1 - ph) * 0.6;
            ctx.fillRect(Math.round(x + Math.sin(ph * 5 + k) * 2), Math.round(y - 2 - ph * 12), 2, 2);
          }
          ctx.globalAlpha = 1;
          continue;
        }
        drawSprite(ctx, 'turret_base', 0, x, y);
        const f = ((Math.round(tu.angle / (TAU / 32)) % 32) + 32) % 32;
        drawSprite(ctx, 'turret_gun', f, x, y);
      }
      // charges
      for (const c of hz.charges) {
        if (!c.active) continue;
        const x = c.prevX + (c.x - c.prevX) * alpha, y = c.prevY + (c.y - c.prevY) * alpha;
        if (!this._visible(x, y, cx, cy, 50)) continue;
        drawSprite(ctx, 'charge', this._chargeOn(c, t) ? 1 : 0, x - cx, y - cy);
      }
      // asteroids
      for (const a of hz.asteroids) {
        if (!a.active) continue;
        const x = a.prevX + (a.x - a.prevX) * alpha, y = a.prevY + (a.y - a.prevY) * alpha;
        if (!this._visible(x, y, cx, cy, a.r + 4)) continue;
        const f = ((Math.round(a.angle / (TAU / 16)) % 16) + 16) % 16;
        drawSprite(ctx, AST_NAMES[a.size][a.variant & 3], f, x - cx, y - cy);
      }
      // gas jets (lit gas, under the darkness)
      for (const v of hz.vents) {
        if (v.state !== 'on' || !this._visible(v.x, v.y, cx, cy, v.length + 10)) continue;
        this._jet(ctx, v, cx, cy, t);
      }
    }
  }

  _chargeOn(c, t) {
    const k = c.fuseMax > 0 ? c.fuse / c.fuseMax : 0;
    const period = 0.08 + 0.42 * k;
    return (c.fuse % period) < period * 0.5;
  }

  _jet(ctx, v, cx, cy, t) {
    const px = -v.dirY, py = v.dirX;
    const fade = v.stateT < 0.1 ? v.stateT / 0.1 : v.stateT > 0.85 ? (1 - v.stateT) / 0.15 : 1;
    ctx.fillStyle = '#d8d490';
    for (let k = 0; k < 18; k++) {
      const along = ((k * 0.37 + t * 2.2) % 1) * v.length;
      const across = (((k * 0.61) % 1) - 0.5) * 2 * v.halfWidth * (0.5 + 0.5 * along / v.length);
      ctx.globalAlpha = 0.28 * fade * (1 - along / v.length);
      const x = v.x + v.dirX * along + px * across - cx, y = v.y + v.dirY * along + py * across - cy;
      ctx.fillRect(Math.round(x) - 1, Math.round(y) - 1, 3, 3);
    }
    ctx.globalAlpha = 1;
  }

  _player(ctx, cx, cy, t) {
    const p = this.game.player;
    if (p.iframes > 0 && !p.dead && Math.floor(p.iframes * 16) % 2 === 0) return;
    const x = Math.round(this._pp.x) - cx, y = Math.round(this._pp.y) - cy;
    if (p.dead) drawSprite(ctx, 'astro_dim', p.dir16 + Math.floor(p.deadT * 5), x, y);
    else drawSprite(ctx, p.hurtT > 0 ? 'astro_hurt' : 'astro', p.dir16, x, y);
  }

  // ================================================================ interior darkness

  _ensureLight(n, w, h) {
    if (n > this._lightCap) {
      this._lightCap = n;
      this.gSolid = new Uint8Array(n); this.gIndoor = new Uint8Array(n); this.gSpace = new Uint8Array(n);
      this.gLamp = new Float32Array(n); this.gTile = new Float32Array(n); this.gDyn = new Float32Array(n);
      this.gR = new Float32Array(n); this.gG = new Float32Array(n); this.gB = new Float32Array(n);
      this.queue = new Int32Array(n * 8);
    }
    if (!this.darkCanvas || this.darkCanvas.width !== w || this.darkCanvas.height !== h) {
      this.darkCanvas = document.createElement('canvas'); this.darkCanvas.width = w; this.darkCanvas.height = h;
      this.glowCanvas = document.createElement('canvas'); this.glowCanvas.width = w; this.glowCanvas.height = h;
      this.darkCtx = this.darkCanvas.getContext('2d'); this.glowCtx = this.glowCanvas.getContext('2d');
      this.darkImg = this.darkCtx.createImageData(w, h); this.glowImg = this.glowCtx.createImageData(w, h);
    }
  }

  /** Value relaxation flood (8 neighbours): solid cells receive light but never pass it on. */
  _flood(L, gw, gh, qLen, falloff) {
    const solid = this.gSolid, q = this.queue, cap = q.length;
    let head = 0, tail = qLen;
    while (head !== tail) {
      const i = q[head]; head = (head + 1) % cap;
      if (solid[i]) continue;
      const v = L[i];
      if (v - falloff <= 0.01) continue;
      const x = i % gw, y = (i / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= gh) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= gw) continue;
          const j = ny * gw + nx;
          let c = falloff;
          if (dx && dy) { if (solid[y * gw + nx] && solid[ny * gw + x]) continue; c *= 1.414; }
          const nv = v - c;
          if (nv > L[j] + 0.01) { L[j] = nv; q[tail] = j; tail = (tail + 1) % cap; if (tail === head) return; }
        }
      }
    }
  }

  _splat(A, gw, gh, gx, gy, v, r, colR, colG, colB) {
    const x0 = Math.max(0, Math.floor(gx - r)), x1 = Math.min(gw - 1, Math.ceil(gx + r));
    const y0 = Math.max(0, Math.floor(gy - r)), y1 = Math.min(gh - 1, Math.ceil(gy + r));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - gx, y + 0.5 - gy);
      if (d >= r) continue;
      const k = v * (1 - d / r);
      const i = y * gw + x;
      if (A) A[i] += k;
      if (colR >= 0) { this.gR[i] += colR * k; this.gG[i] += colG * k; this.gB[i] += colB * k; }
    }
  }

  _darkness(ctx, cx, cy, t) {
    const g = this.game, world = g.world, p = g.player;
    const M = DARK.margin;
    const vx0 = Math.floor(cx / TILE) - 1, vy0 = Math.floor(cy / TILE) - 1;
    const vw = Math.ceil(this.W / TILE) + 3, vh = Math.ceil(this.H / TILE) + 3;
    const gx0 = vx0 - M, gy0 = vy0 - M, gw = vw + 2 * M, gh = vh + 2 * M;
    const n = gw * gh;
    this._ensureLight(n, vw, vh);
    const solid = this.gSolid, indoor = this.gIndoor, space = this.gSpace;
    const types = world.types, zones = world.interior, wW = world.w, wH = world.h;
    let anyIndoor = false;
    for (let j = 0; j < gh; j++) {
      const ty = gy0 + j;
      for (let i = 0; i < gw; i++) {
        const tx = gx0 + i, k = j * gw + i;
        if (tx < 0 || ty < 0 || tx >= wW || ty >= wH) { solid[k] = 1; indoor[k] = 0; space[k] = 0; continue; }
        const wi = ty * wW + tx;
        const id = types[wi];
        const s = SOLID[id];
        solid[k] = s; space[k] = id === SPACE ? 1 : 0;
        let ind = DARK_ZONE[zones[wi]];
        if (ind && s) {
          // a hull tile facing open space is lit by the stars: only buried walls stay dark
          if ((tx > 0 && types[wi - 1] === SPACE) || (tx < wW - 1 && types[wi + 1] === SPACE) || (ty > 0 && types[wi - wW] === SPACE) || (ty < wH - 1 && types[wi + wW] === SPACE)) ind = 0;
        }
        indoor[k] = ind;
        if (ind && i >= M && j >= M && i < M + vw && j < M + vh) anyIndoor = true;
      }
    }
    if (!anyIndoor) return;
    const lamp = this.gLamp, tile = this.gTile, dyn = this.gDyn;
    lamp.fill(0, 0, n); tile.fill(0, 0, n); dyn.fill(0, 0, n);
    this.gR.fill(0, 0, n); this.gG.fill(0, 0, n); this.gB.fill(0, 0, n);
    // A. headlamp (path-distance flood from the astronaut)
    const q = this.queue;
    const pgx = this._pp.x / TILE - gx0, pgy = this._pp.y / TILE - gy0;
    if (!p.dead && pgx >= 0 && pgy >= 0 && pgx < gw && pgy < gh) {
      const k = Math.floor(pgy) * gw + Math.floor(pgx);
      lamp[k] = 1; q[0] = k;
      this._flood(lamp, gw, gh, 1, 1 / DARK.lampRange);
    }
    // B. tile lights (panels, ceiling lights, pads, doors, emitters)
    let qn = 0;
    for (let j = 0; j < gh; j++) {
      const ty = gy0 + j;
      if (ty < 0 || ty >= wH) continue;
      for (let i = 0; i < gw; i++) {
        const tx = gx0 + i;
        if (tx < 0 || tx >= wW) continue;
        const id = types[ty * wW + tx];
        const lv = LIGHT[id];
        if (lv <= 0) continue;
        const k = j * gw + i;
        const v = Math.min(1, lv * 1.25);
        if (v > tile[k]) tile[k] = v;
        q[qn++] = k;
        const c = TILES[id].lightColor;
        this._splat(null, gw, gh, i + 0.5, j + 0.5, lv * 0.5, 2 + lv * 5, c[0] / 255, c[1] / 255, c[2] / 255);
        if (qn >= q.length - 1) break;
      }
    }
    // the flood needs the queue from index 0: seeds were written in place
    if (qn) this._flood(tile, gw, gh, qn, DARK.tileFalloff);
    // C. dynamic lights
    this._dynLights(dyn, gw, gh, gx0, gy0, t);
    // compose the view window
    const dImg = this.darkImg.data, gImg = this.glowImg.data;
    const cos = Math.cos(p.angle), sin = Math.sin(p.angle);
    const half = DARK.lampHalfAngle, soft = DARK.lampSoft;
    let anyGlow = false;
    for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) {
      const k = (j + M) * gw + (i + M);
      const o = (j * vw + i) * 4;
      let light = tile[k] + dyn[k];
      let lampLit = 0;
      const lv = lamp[k];
      if (lv > 0) {
        const dx = i + M + 0.5 - pgx, dy = j + M + 0.5 - pgy;
        const d = Math.hypot(dx, dy);
        let cone = 1;
        if (d > 0.8) {
          const c = (dx * cos + dy * sin) / d;
          const ang = Math.acos(c < -1 ? -1 : c > 1 ? 1 : c);
          cone = ang <= half ? 1 : ang >= half + soft ? 0 : 1 - (ang - half) / soft;
        }
        const halo = d < DARK.haloRange ? (1 - d / DARK.haloRange) * 0.85 : 0;
        lampLit = Math.max(lv * cone * 1.15, halo);
        light += lampLit;
      }
      const ind = indoor[k];
      const a = ind ? DARK.base * (1 - clamp01(light)) : 0;
      dImg[o] = 3; dImg[o + 1] = 4; dImg[o + 2] = 12; dImg[o + 3] = Math.round(a * 255);
      // coloured light: tile / dynamic sources everywhere but open space, warm headlamp tint indoors
      const s = space[k] ? 0 : DARK.glow * 255;
      const lt = ind ? clamp01(lampLit) * DARK.lampTint * 255 : 0;
      const r = this.gR[k] * s + lt, gg = this.gG[k] * s + lt * 0.9, b = this.gB[k] * s + lt * 0.72;
      gImg[o] = r > 255 ? 255 : r; gImg[o + 1] = gg > 255 ? 255 : gg; gImg[o + 2] = b > 255 ? 255 : b; gImg[o + 3] = 255;
      if (r + gg + b > 3) anyGlow = true;
    }
    this.darkCtx.putImageData(this.darkImg, 0, 0);
    const ox = vx0 * TILE - cx, oy = vy0 * TILE - cy;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.darkCanvas, 0, 0, vw, vh, ox, oy, vw * TILE, vh * TILE);
    if (anyGlow) {
      this.glowCtx.putImageData(this.glowImg, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(this.glowCanvas, 0, 0, vw, vh, ox, oy, vw * TILE, vh * TILE);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.imageSmoothingEnabled = false;
  }

  /** Lights that move: lasers, bolts, charges, explosions, the MMU flame, pads with an item. */
  _dynLights(dyn, gw, gh, gx0, gy0, t) {
    const g = this.game, hz = g.hazards, en = g.entities, p = g.player;
    const tg = (v) => v / TILE;
    if (hz) {
      for (const l of hz.lasers) {
        if (l.state === 'off') continue;
        const on = l.state === 'on';
        if (!on && Math.floor(t * 8) % 2) continue;
        const len = Math.hypot(l.x1 - l.x0, l.y1 - l.y0);
        for (let s = 0; s <= len; s += 8) {
          const x = l.x0 + ((l.x1 - l.x0) * s) / (len || 1), y = l.y0 + ((l.y1 - l.y0) * s) / (len || 1);
          this._splat(dyn, gw, gh, tg(x) - gx0, tg(y) - gy0, on ? 0.7 : 0.25, on ? 3 : 2, 1, 0.25, 0.2);
        }
      }
      for (const b of hz.bolts) if (b.active) this._splat(dyn, gw, gh, tg(b.x) - gx0, tg(b.y) - gy0, 0.8, 3.5, 1, 0.5, 0.2);
      for (const c of hz.charges) if (c.active && this._chargeOn(c, t)) this._splat(dyn, gw, gh, tg(c.x) - gx0, tg(c.y) - gy0, 0.5, 2.5, 1, 0.2, 0.15);
      for (const e of hz.explosions) {
        if (!e.active) continue;
        const k = 1 - e.t / e.life;
        this._splat(dyn, gw, gh, tg(e.x) - gx0, tg(e.y) - gy0, 1.6 * k, tg(e.r) * 2.2, 1, 0.7, 0.35);
      }
      for (const tu of hz.turrets) if (tu.alive && tu.state === 'aim') this._splat(dyn, gw, gh, tg(tu.x) - gx0, tg(tu.y) - gy0, 0.4 * tu.telegraph, 3, 1, 0.1, 0.1);
      for (const v of hz.vents) if (v.state === 'warn') this._splat(dyn, gw, gh, tg(v.x) - gx0, tg(v.y) - gy0, 0.35, 2.5, 1, 0.8, 0.3);
    }
    if (en) for (const it of en.items) if (!it.taken) this._splat(dyn, gw, gh, tg(it.x) - gx0, tg(it.y) - gy0, 0.5, 5, 0.4, 0.8, 1);
    if (!p.dead && (p.thrust > 0 || p.boostT > 0)) {
      const k = p.boostT > 0 ? 0.9 : 0.45 * p.thrust;
      this._splat(dyn, gw, gh, tg(this._pp.x - Math.cos(p.angle) * 6) - gx0, tg(this._pp.y - Math.sin(p.angle) * 6) - gy0, k, 3, 1, 0.6, 0.3);
    }
  }

  // ================================================================ celestial bodies (emissive)

  _bodies(ctx, cx, cy) {
    const g = this.game, hz = g.hazards;
    if (!hz) return;
    const t = hz.time;
    for (const s of hz.suns) {
      const co = celestial.corona[s.key];
      const frames = celestial.sun[s.key];
      if (!co || !frames) continue;
      const gr = co.width; // drawn ×2: radius = width
      const sx = s.x - cx, sy = s.y - cy;
      const ringVisible = s.flareState === 'ring' && s.ringR > 0;
      if (sx + gr < 0 || sy + gr < 0 || sx - gr > this.W || sy - gr > this.H) {
        if (ringVisible) this._flareRing(ctx, s, sx, sy);
        continue;
      }
      const warn = s.flareState === 'warn' ? 0.5 + 0.5 * Math.sin(s.flareT * TAU * 3) : 0;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = Math.min(1, 0.8 + warn * 0.4);
      ctx.drawImage(co, Math.round(sx - gr), Math.round(sy - gr), gr * 2, gr * 2);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      const f = frames[Math.floor(t * FX.sunFps) % frames.length];
      ctx.drawImage(f, Math.round(sx - f.width / 2), Math.round(sy - f.height / 2));
      if (warn > 0) {
        const glow = getGlow('white', 48);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = warn * 0.8;
        const r = s.coreR * 1.35;
        ctx.drawImage(glow, Math.round(sx - r), Math.round(sy - r), Math.round(r * 2), Math.round(r * 2));
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
      // heat radius hint: faint dashed ring
      ctx.globalAlpha = FX.heatRingAlpha;
      ctx.strokeStyle = '#ff9a32'; ctx.lineWidth = 1;
      ctx.setLineDash(DASH);
      ctx.beginPath(); ctx.arc(Math.round(sx), Math.round(sy), s.heatR, 0, TAU); ctx.stroke();
      ctx.setLineDash(NO_DASH);
      ctx.globalAlpha = 1;
      if (ringVisible) this._flareRing(ctx, s, sx, sy);
    }
    for (const b of hz.blackHoles) {
      const frames = celestial.disk[b.key];
      if (!frames) continue;
      const sx = b.x - cx, sy = b.y - cy;
      const R = b.diskR * 2.2;
      if (sx + R < 0 || sy + R < 0 || sx - R > this.W || sy - R > this.H) continue;
      const f = frames[Math.floor(t * FX.diskFps) % frames.length];
      ctx.drawImage(f, Math.round(sx - f.width / 2), Math.round(sy - f.height / 2));
      // spiralling motes falling in
      ctx.globalCompositeOperation = 'lighter';
      const n = b.key === 'maelstrom' ? FX.bhMotes : FX.bhMotes >> 1;
      for (let i = 0; i < n; i++) {
        const ph = (t * (0.07 + (i % 7) * 0.012) + i * 0.618) % 1;
        const r = b.diskR * 2 * (1 - ph) + b.horizon * ph;
        const a = i * 2.39996 + t * 0.25 + (b.diskR * 2) / r * 0.9;
        const x = Math.round(sx + Math.cos(a) * r), y = Math.round(sy + Math.sin(a) * r);
        ctx.globalAlpha = Math.min(1, ph * 3) * 0.9;
        ctx.fillStyle = MOTE[Math.min(4, Math.floor(ph * 5))];
        ctx.fillRect(x, y, 1, 1);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  _flareRing(ctx, s, sx, sy) {
    const k = s.ringR / s.ringMaxR;
    const a = (1 - k * 0.75);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = '#ff7a20'; ctx.globalAlpha = a * 0.3; ctx.lineWidth = FX.flareRingWidth * 3;
    ctx.beginPath(); ctx.arc(Math.round(sx), Math.round(sy), s.ringR, 0, TAU); ctx.stroke();
    ctx.strokeStyle = '#ffe0a0'; ctx.globalAlpha = a * 0.9; ctx.lineWidth = FX.flareRingWidth * 0.6;
    ctx.beginPath(); ctx.arc(Math.round(sx), Math.round(sy), s.ringR, 0, TAU); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // ================================================================ emissive layer (over the darkness)

  _glowAt(ctx, key, r, x, y, a) {
    const img = getGlow(key, r);
    if (!img) return;
    ctx.globalAlpha = a;
    ctx.drawImage(img, Math.round(x - r), Math.round(y - r));
  }

  _emissive(ctx, cx, cy, alpha, t) {
    const g = this.game, hz = g.hazards, en = g.entities, p = g.player;
    ctx.globalCompositeOperation = 'lighter';
    if (en) {
      for (const it of en.items) {
        if (it.taken || !this._visible(it.x, it.y, cx, cy, 30)) continue;
        this._glowAt(ctx, ITEM_GLOW[it.key], 12, it.x - cx, it.y - cy - 2, 0.55 + 0.25 * Math.sin(t * 3));
        // light shaft
        ctx.globalAlpha = 0.12 + 0.06 * Math.sin(t * 3);
        ctx.fillStyle = '#6fe6ff';
        ctx.fillRect(Math.round(it.x - cx) - 2, Math.round(it.y - cy) - 20, 5, 18);
      }
      for (const s of en.satellites) {
        if (!this._visible(s.x, s.y, cx, cy, 20)) continue;
        const on = s.active ? Math.floor(t * 1.2) % 4 !== 0 : Math.floor(t * 2) % 2 === 0;
        if (!on) continue;
        this._glowAt(ctx, s.active ? 'green' : 'red', 6, s.x - cx, s.y - cy, 0.9);
        ctx.globalAlpha = 1; ctx.fillStyle = s.active ? '#c8ffd8' : '#ffc0b0';
        ctx.fillRect(Math.round(s.x - cx), Math.round(s.y - cy), 1, 1);
      }
      for (const pk of en.pickups) {
        if (!pk.active) continue;
        const ph = (t * 0.45 + ((pk.spin * 0.159) % 1)) % 1;
        if (ph > 0.07 && !pk.cacheId) continue;
        const x = Math.round(pk.prevX + (pk.x - pk.prevX) * alpha - cx), y = Math.round(pk.prevY + (pk.y - pk.prevY) * alpha - cy);
        if (x < -4 || y < -4 || x > this.W + 4 || y > this.H + 4) continue;
        if (pk.cacheId) { this._glowAt(ctx, 'amber', 6, x, y, 0.35 + 0.2 * Math.sin(t * 4)); if (ph > 0.07) continue; }
        ctx.globalAlpha = 1; ctx.fillStyle = '#ffffff';
        ctx.fillRect(x - 2, y - 1, 5, 1); ctx.fillRect(x, y - 3, 1, 5);
      }
    }
    if (hz) {
      // lasers
      for (const l of hz.lasers) {
        if (l.state === 'off') continue;
        if (!this._visible((l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2, cx, cy, Math.abs(l.x1 - l.x0) + Math.abs(l.y1 - l.y0))) continue;
        const x0 = Math.round(Math.min(l.x0, l.x1) - cx), y0 = Math.round(Math.min(l.y0, l.y1) - cy);
        const len = Math.round(Math.abs(l.vertical ? l.y1 - l.y0 : l.x1 - l.x0));
        if (l.state === 'warn') {
          if (Math.floor(t * 10) % 2) continue;
          ctx.globalAlpha = 0.35 + 0.4 * l.stateT; ctx.fillStyle = '#ff4a3a';
          for (let s = 0; s < len; s += 3) { if (l.vertical) ctx.fillRect(x0, y0 + s, 1, 1); else ctx.fillRect(x0 + s, y0, 1, 1); }
          continue;
        }
        const fl = 0.85 + 0.15 * Math.sin(t * 40 + l.x0);
        ctx.globalAlpha = 0.28 * fl; ctx.fillStyle = '#ff3020';
        if (l.vertical) ctx.fillRect(x0 - 3, y0, 7, len); else ctx.fillRect(x0, y0 - 3, len, 7);
        ctx.globalAlpha = 0.7 * fl; ctx.fillStyle = '#ff5a40';
        if (l.vertical) ctx.fillRect(x0 - 1, y0, 3, len); else ctx.fillRect(x0, y0 - 1, len, 3);
        ctx.globalAlpha = 1; ctx.fillStyle = '#fff0e0';
        if (l.vertical) ctx.fillRect(x0, y0, 1, len); else ctx.fillRect(x0, y0, len, 1);
      }
      // vents about to blow: amber pulse
      for (const v of hz.vents) {
        if (v.state !== 'warn' || !this._visible(v.x, v.y, cx, cy, 20)) continue;
        this._glowAt(ctx, 'amber', 6, v.x - cx, v.y - cy, 0.4 + 0.4 * Math.sin(t * 20));
      }
      // turret telegraph: laser sight to the first wall
      for (const tu of hz.turrets) {
        if (!tu.alive || !this._visible(tu.x, tu.y, cx, cy, 200)) continue;
        if (tu.state === 'aim') {
          if (Math.floor(t * (6 + tu.telegraph * 14)) % 2 === 0) {
            const range = HAZARDS.turret.range;
            const ex = tu.x + Math.cos(tu.angle) * range, ey = tu.y + Math.sin(tu.angle) * range;
            const hit = raycast(g.world, tu.x, tu.y, ex, ey, this._ray);
            const lx = hit ? this._ray.x : ex, ly = hit ? this._ray.y : ey;
            const len = Math.hypot(lx - tu.x, ly - tu.y);
            ctx.globalAlpha = 0.4 + 0.5 * tu.telegraph; ctx.fillStyle = '#ff3a2a';
            const c = Math.cos(tu.angle), s = Math.sin(tu.angle);
            for (let d = 8; d < len; d += 2) ctx.fillRect(Math.round(tu.x + c * d - cx), Math.round(tu.y + s * d - cy), 1, 1);
          }
          this._glowAt(ctx, 'red', 6, tu.x - cx, tu.y - cy, 0.3 + 0.6 * tu.telegraph);
        }
      }
      // bolts
      for (const b of hz.bolts) {
        if (!b.active) continue;
        const x = b.prevX + (b.x - b.prevX) * alpha - cx, y = b.prevY + (b.y - b.prevY) * alpha - cy;
        if (x < -10 || y < -10 || x > this.W + 10 || y > this.H + 10) continue;
        this._glowAt(ctx, 'orange', 6, x, y, 0.8);
        ctx.globalAlpha = 0.5; ctx.fillStyle = '#ff7a20';
        ctx.fillRect(Math.round(x - b.vx * 0.04), Math.round(y - b.vy * 0.04), 2, 2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        drawSprite(ctx, 'bolt', 0, x, y);
        ctx.globalCompositeOperation = 'lighter';
      }
      // charges: LED glow + blast radius once the fuse runs low
      for (const c of hz.charges) {
        if (!c.active) continue;
        const x = c.prevX + (c.x - c.prevX) * alpha - cx, y = c.prevY + (c.y - c.prevY) * alpha - cy;
        if (x < -60 || y < -60 || x > this.W + 60 || y > this.H + 60) continue;
        if (this._chargeOn(c, t)) this._glowAt(ctx, 'red', 6, x, y, 0.9);
        if (c.fuse < FX.chargeRingFuse) {
          ctx.globalAlpha = 0.25 + 0.35 * (1 - c.fuse / FX.chargeRingFuse);
          ctx.strokeStyle = '#ff4a3a'; ctx.lineWidth = 1;
          ctx.setLineDash(DASH);
          ctx.beginPath(); ctx.arc(Math.round(x), Math.round(y), HAZARDS.charge.blastR, 0, TAU); ctx.stroke();
          ctx.setLineDash(NO_DASH);
        }
      }
    }
    // MMU flames
    if (!p.dead) this._flames(ctx, cx, cy, t, p);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  _flames(ctx, cx, cy, t, p) {
    const x = Math.round(this._pp.x) - cx + 0.5, y = Math.round(this._pp.y) - cy + 0.5;
    const c = Math.cos(p.angle), s = Math.sin(p.angle);
    const boost = p.boostT > 0;
    if (p.thrust > 0 || boost) {
      const len = boost ? 9 + Math.random() * 3 : 2 + p.thrust * 4 + Math.random() * 1.6;
      for (let side = -1; side <= 1; side += 2) {
        const nx = x - c * 3.1 - s * side * 1.3, ny = y - s * 3.1 + c * side * 1.3;
        for (let k = 0; k < len; k++) {
          const f = k / len;
          ctx.globalAlpha = 1 - f * 0.5;
          ctx.fillStyle = FLAME[Math.min(4, Math.floor(f * 5))];
          const w = boost && k < len * 0.6 ? 2 : 1;
          ctx.fillRect(Math.floor(nx - c * k), Math.floor(ny - s * k), w, w);
        }
      }
      this._glowAt(ctx, 'orange', boost ? 12 : 6, x - c * 6, y - s * 6, boost ? 0.7 : 0.35 * p.thrust + 0.1);
    }
    if (p.braking && p.speed > 1) {
      const vx = p.vx / p.speed, vy = p.vy / p.speed;
      for (let side = -1; side <= 1; side += 2) {
        const nx = x + c * 1.5 - s * side * 3.6, ny = y + s * 1.5 + c * side * 3.6;
        const len = 2 + Math.random() * 2;
        for (let k = 1; k < len; k++) {
          ctx.globalAlpha = 1 - k / len;
          ctx.fillStyle = RETRO[Math.min(2, k - 1)];
          ctx.fillRect(Math.floor(nx + vx * k), Math.floor(ny + vy * k), 1, 1);
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // ================================================================ screen overlays

  _overlays(ctx, t) {
    const g = this.game, hz = g.hazards;
    if (!hz) return;
    const W = this.W, H = this.H;
    if (hz.bhProximity > 0.02) {
      ctx.imageSmoothingEnabled = true;
      ctx.globalAlpha = FX.bhVignette * Math.pow(hz.bhProximity, 1.4);
      ctx.drawImage(backdrop.vignette, 0, 0, W, H);
      ctx.imageSmoothingEnabled = false;
    }
    if (hz.heatLevel > 0.01) {
      ctx.globalAlpha = FX.heatTint * hz.heatLevel * (0.85 + 0.15 * Math.sin(t * 9));
      ctx.fillStyle = '#ff5a14';
      ctx.fillRect(0, 0, W, H);
    }
    const si = hz.stormIntensity;
    if (si > 0.02) {
      const img = backdrop.staticNoise;
      const h = hash2(this.frameNo, 7, 0x57);
      ctx.globalAlpha = FX.stormStatic * si;
      this._tileImageAlpha(ctx, img, -(h & 127), -((h >>> 8) & 127), 128);
      ctx.globalAlpha = 0.12 * si;
      ctx.fillStyle = '#12b8a8';
      ctx.fillRect(0, 0, W, H);
      if (((h >>> 16) & 255) < si * 70) {
        // horizontal glitch band
        const by = (h >>> 3) % H, bh = 2 + ((h >>> 12) & 7), dx = ((h >>> 20) & 15) - 8;
        ctx.globalAlpha = 1;
        ctx.drawImage(this.display, 0, by, W, bh, dx, by, W, bh);
      }
    }
    ctx.globalAlpha = 1;
  }

  _tileImageAlpha(ctx, img, ox, oy, size) {
    for (let y = oy; y < this.H; y += size) for (let x = ox; x < this.W; x += size) ctx.drawImage(img, x, y);
  }

  _interactMarker(ctx, cx, cy) {
    const g = this.game, en = g.entities, p = g.player;
    if (!en || !en.interactable || p.dead) return;
    const it = en.interactable;
    const x = Math.round(it.x - cx), y = Math.round(it.y - cy);
    const pulse = Math.floor(this.clock * FX.interactPulse) % 2;
    const r = 7 + pulse;
    ctx.fillStyle = '#bff4ff';
    ctx.fillRect(x - r, y - r, 3, 1); ctx.fillRect(x - r, y - r, 1, 3);
    ctx.fillRect(x + r - 2, y - r, 3, 1); ctx.fillRect(x + r, y - r, 1, 3);
    ctx.fillRect(x - r, y + r, 3, 1); ctx.fillRect(x - r, y + r - 2, 1, 3);
    ctx.fillRect(x + r - 2, y + r, 3, 1); ctx.fillRect(x + r, y + r - 2, 1, 3);
    const touch = !!(g.input && g.input.touchEnabled);
    let label = it.label;
    if (!touch) {
      label = KEY_HINT.get(it.label);
      if (!label) { label = 'E : ' + it.label; KEY_HINT.set(it.label, label); }
    }
    drawText(ctx, label, x, y - r - 11, '#e8f8ff', LABEL_OPTS);
  }

  // ================================================================ victory cinematic

  _cinematic(ctx, t) {
    const W = this.W, H = this.H;
    const flightEnd = VICTORY_CINE.flight, reEnd = flightEnd + VICTORY_CINE.reentry;
    ctx.fillStyle = '#010207'; ctx.fillRect(0, 0, W, H);
    const speed = 40 + Math.min(1, t / 2) * 520;
    // star streams (flying "up": stars stream down)
    const Ts = BACKDROP.tile;
    for (let li = 0; li < backdrop.layers.length; li++) {
      const par = (li + 1) * 0.5;
      const off = (t * speed * par) % Ts;
      const img = backdrop.layers[li];
      for (let k = 0; k < 3; k++) {
        ctx.globalAlpha = k === 0 ? 1 : 0.35 / k;
        const oy = Math.round(off - k * 3 * par) - Ts;
        for (let y = oy; y < H; y += Ts) for (let x = 0; x < W; x += Ts) ctx.drawImage(img, x, y);
      }
    }
    ctx.globalAlpha = 1;
    const earth = celestial.earth;
    const k = clamp01(t / reEnd);
    const size = Math.round(12 + Math.pow(k, 2.2) * H * 2.6);
    const ex = Math.round(W / 2 - size / 2), ey = Math.round(H * 0.18 - size * 0.2);
    ctx.drawImage(earth, 0, 0, earth.width, earth.height, ex, ey, size, size);
    const capsule = getSprite('capsule_ship');
    const bob = Math.round(Math.sin(t * 3) * 1.5);
    const shipX = W / 2, shipY = H * 0.62 + bob;
    if (t > flightEnd && t < reEnd) {
      // re-entry plasma around the heat shield (the capsule falls nose-down into the atmosphere)
      const q = (t - flightEnd) / VICTORY_CINE.reentry;
      const a = Math.sin(q * Math.PI);
      ctx.globalCompositeOperation = 'lighter';
      this._glowAt(ctx, 'orange', 24, shipX, shipY - 14, a);
      this._glowAt(ctx, 'white', 12, shipX, shipY - 12, a * 0.8);
      ctx.globalAlpha = a;
      for (let i = 0; i < 26; i++) {
        const sx = shipX + ((hash2(i, Math.floor(t * 20), 3) & 31) - 16), len = 6 + (hash2(i, 5, 9) & 15);
        ctx.fillStyle = FLAME[i % 5];
        ctx.fillRect(Math.round(sx), Math.round(shipY - 8 + (i % 4) * 3), 1, len);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    } else if (t <= flightEnd) {
      // main engine
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 8; i++) {
        ctx.fillStyle = FLAME[Math.min(4, i >> 1)];
        ctx.globalAlpha = 1 - i / 9;
        ctx.fillRect(Math.round(shipX) - 1, Math.round(shipY + 9 + i + (Math.random() * 2 | 0)), 3, 1);
      }
      this._glowAt(ctx, 'orange', 12, shipX, shipY + 12, 0.6);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    if (capsule) drawSprite(ctx, 'capsule_ship', 0, shipX, shipY);
    if (t > reEnd) {
      // under the parachute, the sky turns blue
      const q = clamp01((t - reEnd) / 1.5);
      ctx.globalAlpha = q;
      for (let i = 0; i < 6; i++) { ctx.fillStyle = SKY[i]; ctx.fillRect(0, Math.floor((H * i) / 6), W, Math.ceil(H / 6) + 1); }
      ctx.globalAlpha = 1;
      if (q > 0.5) {
        const py = Math.round(H * 0.5 + (t - reEnd) * 4);
        this._parachute(ctx, Math.round(W / 2), py - 26);
        ctx.strokeStyle = '#d8dce4'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(W / 2 - 13, py - 24); ctx.lineTo(W / 2 - 3, py - 6); ctx.moveTo(W / 2 + 13, py - 24); ctx.lineTo(W / 2 + 3, py - 6); ctx.stroke();
        drawSprite(ctx, 'capsule_ship', 0, W / 2, py + 2);
      }
    }
  }

  _parachute(ctx, x, y) {
    for (let j = 0; j < 12; j++) {
      const w = Math.round(Math.sqrt(1 - ((12 - j) / 12) ** 2) * 16);
      for (let i = -w; i < w; i++) {
        ctx.fillStyle = ((i + 16) >> 2) % 2 ? '#ffffff' : '#ff7a20';
        ctx.fillRect(x + i, y + j, 1, 1);
      }
    }
  }

  // ================================================================ audio driving

  _driveAudio(state) {
    const g = this.game, a = g.audio;
    if (!a || !a.setLoop) return;
    const p = g.player, hz = g.hazards;
    const live = state === 'PLAYING' && p && !p.dead && hz;
    a.setLoop('thrust', live ? Math.max(p.thrust, p.boostT > 0 ? 1 : 0) : 0);
    a.setLoop('brake', live && p.braking ? 1 : 0);
    a.setLoop('heat', live ? hz.heatLevel : 0);
    a.setLoop('rumble', live ? hz.bhProximity : 0);
    a.setLoop('alarm', live && p.o2Low ? 1 : 0);
    a.setLoop('storm', live ? hz.stormIntensity : 0);
    let zone = this._zone;
    if (!g.world || !p || state === 'TITLE') zone = 'title';
    else if (state === 'VICTORY') zone = 'victory';
    else if (state === 'PLAYING' || state === 'DEAD') zone = this._ambienceZone(p, hz);
    if (zone !== this._zone) { this._zone = zone; if (a.setZone) a.setZone(zone); }
    if (a.tick) a.tick();
  }

  _ambienceZone(p, hz) {
    const world = this.game.world;
    const z = world.zoneAt(p.x, p.y);
    if (DARK_ZONE[z]) return z === 7 ? 'selene' : 'interior';
    const near = (key, r) => { const poi = POI_BY_KEY[key]; return Math.hypot(p.x - poi.x, p.y - poi.y) < r; };
    if (hz && hz.stormIntensity > 0.35) return 'storm';
    if (near('maelstrom', 1500) || near('charybde', 900)) return 'maelstrom';
    if (near('twins', SUNS.heatR * 2)) return 'twins';
    if (near('selene', 1100)) return 'selene';
    return 'space';
  }
}

const LABEL_OPTS = { outline: '#05060b', align: 'center' };
const SKY = ['#1a3a78', '#2a5aa8', '#3a7ac8', '#5a9ad8', '#8ac0e8', '#c0e0f4'];
