// World grid: tile types, interior zone map, persistent modifications and change tracking.
//
//   new World(w, h)
//     types: Uint8Array(w*h) tile ids (tiles.js)       interior: Uint8Array(w*h) zone ids (config.ZONES)
//     get(tx, ty) / def(tx, ty) / isSolid(tx, ty) / isSolidAt(px, py)   (out of bounds = solid hull)
//     zone(tx, ty) / zoneAt(px, py)                     zone id (0 = open space)
//     set(tx, ty, id)            runtime change: logged in `mods` (persistent, saved as
//                                save.world.mods), marks the chunk dirty, appends to `dirtyLog`
//     setRaw / setZoneRaw        worldgen writes (no logging); finalize() once generation is done
//     applyMods(list)            re-apply saved [[tileIndex, tileId], ...] (invalid entries skipped)
//     exportMods() -> [[tileIndex, tileId], ...]
//     circleSolid(x, y, r)       does a circle overlap any solid tile?
//     blast(x, y, r) -> [{ tx, ty, id }]   breaks FRAGILE tiles whose centre is within r (only those)
//   Change tracking for the renderer (same protocol as Gouffre):
//     version (bumps on every change), chunkVersion[cy * chunksX + cx] (a chunk and its edge
//     neighbours bump when one of its tiles changes), dirtyLog (ring of the last DIRTY_LOG changed
//     tile indices) + dirtyCount (total ever written: entries dirtyCount - DIRTY_LOG .. dirtyCount - 1).
import { TILE, CHUNK } from './config.js';
import { TILES, TILE_ID, SOLID, FRAGILE, TILE_COUNT } from './tiles.js';

const HULL = TILE_ID.HULL;
/** Changed-tile ring buffer size (the renderer redraws only those cells of its cached chunks). */
export const DIRTY_LOG = 512;

export class World {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.types = new Uint8Array(w * h);
    this.interior = new Uint8Array(w * h);
    this.chunksX = Math.ceil(w / CHUNK);
    this.chunksY = Math.ceil(h / CHUNK);
    this.chunkVersion = new Uint32Array(this.chunksX * this.chunksY);
    this.version = 0;
    this.dirtyLog = new Int32Array(DIRTY_LOG);
    this.dirtyCount = 0;
    this.mods = new Map();           // tileIndex -> tileId, every runtime change since generation
  }

  idx(tx, ty) { return ty * this.w + tx; }
  inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h; }

  /** Tile id at (tx, ty); out of bounds reads as hull. */
  get(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return HULL;
    return this.types[ty * this.w + tx];
  }

  def(tx, ty) { return TILES[this.get(tx, ty)]; }

  isSolid(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return true;
    return SOLID[this.types[ty * this.w + tx]] === 1;
  }

  isSolidAt(px, py) { return this.isSolid(Math.floor(px / TILE), Math.floor(py / TILE)); }

  zone(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return 0;
    return this.interior[ty * this.w + tx];
  }

  zoneAt(px, py) { return this.zone(Math.floor(px / TILE), Math.floor(py / TILE)); }

  /** Runtime tile change: logged as a persistent modification. */
  set(tx, ty, id) {
    if (!this.inBounds(tx, ty)) return;
    const i = ty * this.w + tx;
    if (this.types[i] === id) return;
    this.types[i] = id;
    this.mods.set(i, id);
    this.markDirty(tx, ty);
  }

  /** Raw write without logging / dirty tracking (worldgen, before finalize()). */
  setRaw(tx, ty, id) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return;
    this.types[ty * this.w + tx] = id;
  }

  setZoneRaw(tx, ty, zone) {
    if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return;
    this.interior[ty * this.w + tx] = zone;
  }

  /** Mark the chunk of (tx, ty) dirty (plus the neighbour chunk when on an edge: shading reads neighbours). */
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

  /** After bulk generation: forget modifications, invalidate every chunk. */
  finalize() {
    this.mods.clear();
    this.version++;
    for (let i = 0; i < this.chunkVersion.length; i++) this.chunkVersion[i]++;
  }

  /** Re-apply saved modifications ([[tileIndex, tileId], ...]); returns how many were applied. */
  applyMods(list) {
    if (!Array.isArray(list)) return 0;
    const n = this.w * this.h;
    let applied = 0;
    for (const m of list) {
      if (!Array.isArray(m) || m.length < 2) continue;
      const i = m[0], id = m[1];
      if (!Number.isInteger(i) || !Number.isInteger(id) || i < 0 || i >= n || id < 0 || id >= TILE_COUNT) continue;
      this.set(i % this.w, Math.floor(i / this.w), id);
      applied++;
    }
    return applied;
  }

  exportMods() {
    const out = [];
    for (const [i, id] of this.mods) out.push([i, id]);
    return out;
  }

  /** True if the circle (x, y, r) overlaps a solid tile. */
  circleSolid(x, y, r) {
    const x0 = Math.floor((x - r) / TILE), x1 = Math.floor((x + r) / TILE);
    const y0 = Math.floor((y - r) / TILE), y1 = Math.floor((y + r) / TILE);
    const r2 = r * r;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        if (!this.isSolid(tx, ty)) continue;
        const cx = x < tx * TILE ? tx * TILE : x > (tx + 1) * TILE ? (tx + 1) * TILE : x;
        const cy = y < ty * TILE ? ty * TILE : y > (ty + 1) * TILE ? (ty + 1) * TILE : y;
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < r2) return true;
      }
    }
    return false;
  }

  /**
   * Explosion: every FRAGILE tile whose centre lies within r of (x, y) turns into its
   * breaksTo tile (rubble -> moon_floor, asteroid_small -> space). Other tiles are untouched.
   * @returns {{tx:number, ty:number, id:number}[]} the broken tiles (id = the tile before)
   */
  blast(x, y, r) {
    const out = [];
    const x0 = Math.floor((x - r) / TILE), x1 = Math.floor((x + r) / TILE);
    const y0 = Math.floor((y - r) / TILE), y1 = Math.floor((y + r) / TILE);
    const r2 = r * r;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const id = this.get(tx, ty);
        if (!FRAGILE[id] || !this.inBounds(tx, ty)) continue;
        const dx = (tx + 0.5) * TILE - x, dy = (ty + 0.5) * TILE - y;
        if (dx * dx + dy * dy > r2) continue;
        this.set(tx, ty, TILES[id].breaksToId);
        out.push({ tx, ty, id });
      }
    }
    return out;
  }

  /** Copy of the type grid (tests: determinism checks). */
  snapshot() { return this.types.slice(); }
}
