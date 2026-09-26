// Build mode: a ghost of the chosen building is shown in front of the player; "Poser" places it if valid.
import { TILE } from './config.js';
import { TILE_ID, SOLID, ONEWAY } from './tiles.js';
import { BUILDINGS } from './data/buildings.js';
import { Structure } from './entities.js';
import { overlap } from './physics.js';

export function footprint(def) {
  if (def.kind === 'tiles') return { w: Math.max(...def.pattern.map((r) => r.length)), h: def.pattern.length };
  return { w: def.w, h: def.h };
}

export class Builder {
  constructor(game) {
    this.game = game;
    this.def = null;
    this.dy = 0;
  }

  get active() { return !!this.def; }

  start(id) {
    this.def = BUILDINGS[id] || null;
    this.dy = 0;
  }
  cancel() { this.def = null; }
  nudge(d) { this.dy = Math.max(-6, Math.min(2, this.dy + d)); }

  /** Tile rectangle of the ghost for the current player position. */
  ghost() {
    const p = this.game.player, world = this.game.world;
    const { w, h } = footprint(this.def);
    const tx = p.facing > 0 ? Math.floor((p.x + p.w) / TILE) + 1 : Math.floor(p.x / TILE) - w;
    const feet = Math.floor((p.y + p.h - 1) / TILE);
    let ty = feet - (h - 1) + this.dy;
    if (this.def.needsGround && this.dy === 0) {
      // settle onto the ground in front (small dips), or rise over a small bump
      for (let i = 0; i < 4 && !this.groundUnder(tx, ty + h, w); i++) ty++;
      for (let i = 0; i < 3 && this.blocked(tx, ty, w, h); i++) ty--;
    }
    return { tx, ty, w, h };
  }

  groundUnder(tx, ty, w) {
    const world = this.game.world;
    for (let x = tx; x < tx + w; x++) {
      const id = world.get(x, ty);
      if (!SOLID[id] && !ONEWAY[id]) return false;
    }
    return true;
  }

  blocked(tx, ty, w, h) {
    const world = this.game.world;
    for (let y = ty; y < ty + h; y++) for (let x = tx; x < tx + w; x++) if (world.get(x, y) !== TILE_ID.air) return true;
    return false;
  }

  /** {ok, reason} for the ghost at g. */
  validate(g) {
    if (!this.def) return { ok: false, reason: '' };
    g = g || this.ghost();
    const { world, player, structures, inventory } = this.game;
    const def = this.def;
    if (g.tx < 1 || g.ty < 1 || g.tx + g.w >= world.w - 1 || g.ty + g.h >= world.h - 1) return { ok: false, reason: 'Hors du monde' };
    for (let y = g.ty; y < g.ty + g.h; y++) {
      for (let x = g.tx; x < g.tx + g.w; x++) {
        if (def.kind === 'tiles' && def.pattern[y - g.ty][x - g.tx] === ' ') continue;
        const id = world.get(x, y);
        if (id === TILE_ID.water) return { ok: false, reason: 'Pas dans l\'eau' };
        if (id !== TILE_ID.air && id !== TILE_ID.leaves) return { ok: false, reason: 'Place occupée' };
      }
    }
    if (def.needsGround && !this.groundUnder(g.tx, g.ty + g.h, g.w)) return { ok: false, reason: 'Il faut un sol plat' };
    const box = { x: g.tx * TILE, y: g.ty * TILE, w: g.w * TILE, h: g.h * TILE };
    for (const s of structures) if (overlap(box, s)) return { ok: false, reason: 'Trop près d\'un autre bâtiment' };
    if (def.kind === 'tiles') {
      if (overlap(box, player)) return { ok: false, reason: 'Recule un peu' };
      for (const a of this.game.allies) if (overlap(box, a)) return { ok: false, reason: 'Un allié gêne' };
    }
    if (!inventory.canAfford(def.cost)) return { ok: false, reason: 'Ressources insuffisantes' };
    return { ok: true, reason: '' };
  }

  place() {
    const g = this.ghost();
    const v = this.validate(g);
    const game = this.game;
    if (!v.ok) { game.toast(v.reason); game.audio.play('deny'); return false; }
    game.inventory.pay(this.def.cost);
    const def = this.def;
    if (def.kind === 'tiles') {
      for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
        const ch = def.pattern[y][x];
        if (!ch || ch === ' ') continue;
        game.setBuiltTile(g.tx + x, g.ty + y, def.tiles[ch]);
      }
    } else {
      // clear canopy leaves inside the footprint
      for (let y = g.ty; y < g.ty + g.h; y++) for (let x = g.tx; x < g.tx + g.w; x++) if (game.world.get(x, y) === TILE_ID.leaves) game.world.set(x, y, TILE_ID.air);
      game.addStructure(new Structure(def, g.tx, g.ty));
    }
    game.audio.play('build');
    game.particles.spawn('dust', (g.tx + g.w / 2) * TILE, (g.ty + g.h) * TILE, { n: 10 });
    game.float(def.name, (g.tx + g.w / 2) * TILE, g.ty * TILE - 4, '#ffe08a');
    game.stats.built++;
    if (!game.inventory.canAfford(def.cost)) this.cancel();
    return true;
  }
}
