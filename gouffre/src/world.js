// World grid: tile types, back walls, mining damage and change tracking.
import { TILE, CHUNK, TILE_REGEN_DELAY } from './config.js';
import { TILES, TILE_ID, SOLID, tileDef } from './tiles.js';

const BEDROCK = TILE_ID.BEDROCK;
const AIR = TILE_ID.AIR;
/** Changed-tile ring buffer size (the renderer redraws only those cells of its cached chunks). */
export const DIRTY_LOG = 512;

// Decorations that need a solid neighbour to exist (see worldgen placeDecorations):
// 1 = hangs from the tile above, 2 = stands on the tile below, 3 = clings to above/left/right.
const SUPPORT = new Uint8Array(256);
SUPPORT[TILE_ID.ROOTS] = 1; SUPPORT[TILE_ID.STALACTITE] = 1;
SUPPORT[TILE_ID.STALAGMITE] = 2; SUPPORT[TILE_ID.MUSHROOM] = 2; SUPPORT[TILE_ID.BONES_DECO] = 2;
SUPPORT[TILE_ID.COBWEB] = 3;

export class World {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.types = new Uint8Array(w * h);      // tile type ids
    this.back = new Uint8Array(w * h);       // back-wall style (tiles.BACK)
    this.damage = new Float32Array(w * h);   // accumulated mining damage (hp units)
    this.damageAge = new Float32Array(w * h);// seconds since the last hit
    this.damaged = [];                       // indices with damage > 0 (small list)
    this.chunksX = Math.ceil(w / CHUNK);
    this.chunksY = Math.ceil(h / CHUNK);
    this.chunkVersion = new Uint32Array(this.chunksX * this.chunksY);
    this.skyTop = new Int16Array(w);         // first solid row of each column
    this.version = 0;                        // bumps on every tile change
    this.damageVersion = 0;                  // bumps when crack overlays change
    // every markDirty() also appends the tile index here (ring of DIRTY_LOG entries,
    // dirtyCount = total ever written): the renderer patches just those cells of its
    // cached chunks instead of redrawing whole 16x16 chunks
    this.dirtyLog = new Int32Array(DIRTY_LOG);
    this.dirtyCount = 0;
    // 1 = cannot be mined (camp ground, headframe beam): damageTile() answers tooHard + locked
    this.locked = new Uint8Array(w * h);
  }

  idx(tx, ty) { return ty * this.w + tx; }
  inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h; }

  /** Make a tile unmineable (camp ground, headframe beam). */
  lock(tx, ty, on = true) { if (this.inBounds(tx, ty)) this.locked[ty * this.w + tx] = on ? 1 : 0; }
  isLocked(tx, ty) { return this.inBounds(tx, ty) && this.locked[ty * this.w + tx] === 1; }

  /** Tile id at (tx, ty); out of bounds reads as bedrock. */
  get(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return BEDROCK;
    return this.types[ty * this.w + tx];
  }

  def(tx, ty) { return TILES[this.get(tx, ty)]; }

  isSolid(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return true;
    return SOLID[this.types[ty * this.w + tx]] === 1;
  }

  /** Solid test at a pixel position. */
  isSolidAt(px, py) { return this.isSolid(Math.floor(px / TILE), Math.floor(py / TILE)); }

  getBack(tx, ty) {
    if (!this.inBounds(tx, ty)) return 0;
    return this.back[ty * this.w + tx];
  }

  /** Change a tile; clears its damage and marks its chunk dirty. */
  set(tx, ty, id) {
    if (!this.inBounds(tx, ty)) return;
    const i = ty * this.w + tx;
    if (this.types[i] === id && this.damage[i] === 0) return;
    this.types[i] = id;
    if (this.damage[i] > 0) { this.damage[i] = 0; this.damageVersion++; }
    this._updateSkyTop(tx);
    this.markDirty(tx, ty);
  }

  /** Raw write without dirty tracking (used by worldgen before finalize()). */
  setRaw(tx, ty, id) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return;
    this.types[ty * this.w + tx] = id;
  }
  setBackRaw(tx, ty, b) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return;
    this.back[ty * this.w + tx] = b;
  }

  /**
   * Mark the chunk containing (tx, ty) dirty. Neighbouring chunks are dirtied too
   * when the tile sits on a chunk edge, because edge shading reads neighbours.
   */
  markDirty(tx, ty) {
    this.version++;
    this.dirtyLog[this.dirtyCount % DIRTY_LOG] = ty * this.w + tx;
    this.dirtyCount++;
    const cx = Math.floor(tx / CHUNK), cy = Math.floor(ty / CHUNK);
    this._bumpChunk(cx, cy);
    const lx = tx - cx * CHUNK, ly = ty - cy * CHUNK;
    if (lx === 0) this._bumpChunk(cx - 1, cy);
    if (lx === CHUNK - 1) this._bumpChunk(cx + 1, cy);
    if (ly === 0) this._bumpChunk(cx, cy - 1);
    if (ly === CHUNK - 1) this._bumpChunk(cx, cy + 1);
  }

  _bumpChunk(cx, cy) {
    if (cx < 0 || cy < 0 || cx >= this.chunksX || cy >= this.chunksY) return;
    this.chunkVersion[cy * this.chunksX + cx]++;
  }

  _updateSkyTop(tx) {
    let ty = 0;
    while (ty < this.h && !SOLID[this.types[ty * this.w + tx]]) ty++;
    this.skyTop[tx] = ty;
  }

  /** Recompute derived data after bulk generation. */
  finalize() {
    for (let tx = 0; tx < this.w; tx++) this._updateSkyTop(tx);
    this.damage.fill(0);
    this.damageAge.fill(0);
    this.damaged.length = 0;
    this.version++;
    for (let i = 0; i < this.chunkVersion.length; i++) this.chunkVersion[i]++;
  }

  /**
   * Apply mining damage.
   * @returns {{hit:boolean, broken:boolean, tooHard:boolean, locked:boolean, tileId:number, ratio:number}}
   *   hit: a damageable solid tile was struck; ratio: damage / hp after the hit;
   *   locked: tooHard because the tile is locked (camp ground), whatever the pickaxe.
   */
  damageTile(tx, ty, dmg, tier) {
    const res = { hit: false, broken: false, tooHard: false, locked: false, tileId: AIR, ratio: 0 };
    if (!this.inBounds(tx, ty)) { res.tooHard = true; res.tileId = BEDROCK; return res; }
    const i = ty * this.w + tx;
    const id = this.types[i];
    const def = TILES[id];
    res.tileId = id;
    if (!def || !def.solid) return res;
    if (this.locked[i]) { res.tooHard = true; res.locked = true; return res; }
    if (def.hp === Infinity || tier < def.tier) { res.tooHard = true; return res; }
    res.hit = true;
    const wasZero = this.damage[i] <= 0;
    this.damage[i] += dmg;
    this.damageAge[i] = 0;
    if (this.damage[i] >= def.hp - 1e-6) {
      this.types[i] = AIR;
      this.damage[i] = 0;
      res.broken = true;
      res.ratio = 1;
      this._updateSkyTop(tx);
      this.markDirty(tx, ty);
    } else {
      res.ratio = this.damage[i] / def.hp;
      if (wasZero) this.damaged.push(i);
    }
    this.damageVersion++;
    return res;
  }

  /** Does the decoration at (tx, ty) still have what holds it? (true for non-dependent tiles) */
  decoSupported(tx, ty) {
    const kind = SUPPORT[this.get(tx, ty)];
    if (kind === 1) return this.isSolid(tx, ty - 1);
    if (kind === 2) return this.isSolid(tx, ty + 1);
    if (kind === 3) return this.isSolid(tx, ty - 1) || this.isSolid(tx - 1, ty) || this.isSolid(tx + 1, ty);
    return true;
  }

  /**
   * After the tile at (tx, ty) was removed: clear neighbouring decorations that
   * lost their support (hanging roots/stalactites below, stalagmites/mushrooms/
   * skulls above, cobwebs beside). onCleared(tx, ty, id) lets the caller add FX.
   * @returns {number} number of decorations removed
   */
  clearDetachedDeco(tx, ty, onCleared = null) {
    let n = 0;
    for (let k = 0; k < 4; k++) {
      const nx = tx + (k === 2 ? -1 : k === 3 ? 1 : 0);
      const ny = ty + (k === 0 ? 1 : k === 1 ? -1 : 0);
      const id = this.get(nx, ny);
      if (!SUPPORT[id] || this.decoSupported(nx, ny)) continue;
      this.set(nx, ny, AIR);
      n++;
      if (onCleared) onCleared(nx, ny, id);
    }
    return n;
  }

  /** Crack stage 0..3 for rendering. */
  crackStage(tx, ty) {
    const i = ty * this.w + tx;
    const d = this.damage[i];
    if (d <= 0) return 0;
    const hp = tileDef(this.types[i]).hp;
    return Math.min(3, Math.max(1, Math.ceil((d / hp) * 3)));
  }

  /** Heal unfinished damage after TILE_REGEN_DELAY seconds without hits. */
  update(dt) {
    const list = this.damaged;
    for (let k = list.length - 1; k >= 0; k--) {
      const i = list[k];
      if (this.damage[i] <= 0) { list[k] = list[list.length - 1]; list.pop(); continue; }
      this.damageAge[i] += dt;
      if (this.damageAge[i] >= TILE_REGEN_DELAY) {
        this.damage[i] = 0;
        this.damageVersion++;
        list[k] = list[list.length - 1];
        list.pop();
      }
    }
  }

  /** True if an AABB (pixels) overlaps any solid tile. */
  rectSolid(x, y, w, h) {
    const x0 = Math.floor(x / TILE), x1 = Math.floor((x + w - 1e-4) / TILE);
    const y0 = Math.floor(y / TILE), y1 = Math.floor((y + h - 1e-4) / TILE);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) if (this.isSolid(tx, ty)) return true;
    }
    return false;
  }

  /** Highest hazard damage among tiles overlapped by an AABB (0 if none). */
  rectHazard(x, y, w, h) {
    const x0 = Math.floor(x / TILE), x1 = Math.floor((x + w - 1e-4) / TILE);
    const y0 = Math.floor(y / TILE), y1 = Math.floor((y + h - 1e-4) / TILE);
    let best = 0;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const hz = TILES[this.get(tx, ty)].hazard;
        if (hz > best) best = hz;
      }
    }
    return best;
  }

  /** Copy of the type grid (used by tests for determinism checks). */
  snapshot() { return this.types.slice(); }
}
