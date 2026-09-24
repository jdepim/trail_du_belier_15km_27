// Pickups (ores, coins, hearts) and chests — STUB for step 1.
// Chests from worldgen are kept and drawn so the mine looks populated; drops,
// magnetism, backpack, chest opening and relics are implemented in step 2.
import { TILE } from './config.js';
import { TILES } from './tiles.js';
import { drawSprite } from './sprites.js';

export class EntityManager {
  constructor(game) {
    this.game = game;
    this.chests = [];
    this.pickups = [];
  }

  /** New world: copy chest records from worldgen. */
  reset(gen) {
    this.chests = gen && gen.chests ? gen.chests.map((c) => ({ ...c })) : [];
    this.pickups.length = 0;
  }

  /** Called by game.tileBroken(): spawn whatever the tile drops. */
  onTileBroken(tx, ty, tileId) {
    const def = TILES[tileId];
    if (!def || !def.drop) return;
    this.spawnDrop(def.drop, tx * TILE + TILE / 2, ty * TILE + TILE / 2, def);
  }

  /** drop: 'ore:<key>' | 'heal'. TODO step 2: pooled pickups magnetised to the player. */
  spawnDrop(drop, x, y, def) {
    if (drop === 'heal') {
      // placeholder until heart pickups exist: heal directly
      const healed = this.game.player.heal(20);
      if (healed > 0) this.game.toast('+' + healed + ' PV', { color: '#ff7a95' });
    }
  }

  /** Coins dropped by enemies (value in gold). TODO step 2. */
  spawnCoins(x, y, value) {}

  /** Healing heart dropped by enemies. TODO step 2. */
  spawnHeart(x, y) {}

  update(dt) {}

  /** Nearest interactable for the contextual button: { label, kind, target } | null. TODO step 2. */
  interactionAt(player) { return null; }

  draw(ctx, camX, camY) {
    for (const c of this.chests) {
      const sx = Math.round(c.x - camX), sy = Math.round(c.y - camY);
      if (sx < -24 || sy < -24 || sx > ctx.canvas.width + 24 || sy > ctx.canvas.height + 24) continue;
      drawSprite(ctx, c.opened ? 'chest_open' : 'chest', 0, sx, sy);
    }
  }
}
