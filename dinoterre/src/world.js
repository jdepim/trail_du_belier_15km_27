// Tile grid of the open world + queries used by physics, AI and rendering.
import { TILE, WORLD_W, WORLD_H, SPAWN_TX } from './config.js';
import { TILE_ID, SOLID, ONEWAY, WATER, CLIMB } from './tiles.js';
import { clamp } from './rng.js';

export class World {
  constructor(w = WORLD_W, h = WORLD_H) {
    this.w = w;
    this.h = h;
    this.tiles = new Uint8Array(w * h);
    this.surface = new Int16Array(w);   // first solid row of each column (terrain only)
    this.biome = new Array(w).fill('plaine');
    this.bonePiles = [];                // [{tx, ty}] fossil spots generated with the world
    this.spawn = { tx: Math.floor(w / 2), ty: 0 };
    this.version = 0;                   // bumped on every edit (render cache invalidation)
  }

  inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < this.w && ty < this.h; }

  /** Tile id; outside the world: bedrock on the sides and bottom, air above. */
  get(tx, ty) {
    if (tx < 0 || tx >= this.w || ty >= this.h) return TILE_ID.bedrock;
    if (ty < 0) return TILE_ID.air;
    return this.tiles[ty * this.w + tx];
  }

  set(tx, ty, id) {
    if (!this.inBounds(tx, ty)) return;
    this.tiles[ty * this.w + tx] = id;
    this.version++;
  }

  isSolid(tx, ty) { return SOLID[this.get(tx, ty)] === 1; }
  isOneway(tx, ty) { return ONEWAY[this.get(tx, ty)] === 1; }
  isWater(tx, ty) { return WATER[this.get(tx, ty)] === 1; }
  isClimbable(tx, ty) { return CLIMB[this.get(tx, ty)] === 1; }

  solidAt(px, py) { return this.isSolid(Math.floor(px / TILE), Math.floor(py / TILE)); }
  waterAt(px, py) { return this.isWater(Math.floor(px / TILE), Math.floor(py / TILE)); }

  /** Topmost standable row (solid or platform) at or below `fromTy` in column tx, or -1. */
  groundBelow(tx, fromTy = 0) {
    for (let ty = Math.max(0, fromTy); ty < this.h; ty++) {
      const id = this.get(tx, ty);
      if (SOLID[id] || ONEWAY[id]) return ty;
    }
    return -1;
  }

  biomeAtPx(px) { return this.biome[clamp(Math.floor(px / TILE), 0, this.w - 1)]; }

  /** 0 near the start, 1 at the far edges of the world. */
  danger(tx) { return clamp(Math.abs(tx - SPAWN_TX) / (this.w * 0.42), 0, 1); }
}
