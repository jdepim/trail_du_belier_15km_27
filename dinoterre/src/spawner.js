// Keeps the world alive around the player: spawns creatures in off-screen zones according to
// the biome, the distance from the start (danger) and the time of day; despawns far ones.
import { TILE, SPAWN, WATER_LEVEL } from './config.js';
import { CREATURES } from './data/creatures.js';
import { BIOMES } from './data/biomes.js';
import { Creature } from './creature.js';

export class Spawner {
  constructor(game) {
    this.game = game;
    this.t = 0;
  }

  /** Spawn candidates for a biome at a danger level: [{def, weight}]. */
  static table(biomeId, danger, night) {
    const out = [];
    for (const def of Object.values(CREATURES)) {
      const s = def.spawn;
      if (!s || !s.biomes.includes(biomeId) || danger < s.minDanger) continue;
      out.push({ def, weight: s.weight * (night && s.night ? s.night : 1) });
    }
    return out;
  }

  update(dt) {
    this.t -= dt;
    if (this.t > 0) return;
    this.t = SPAWN.interval;
    const g = this.game, p = g.player;
    const ptx = Math.floor(p.cx / TILE);
    const pz = Math.floor(ptx / SPAWN.zone);

    // despawn far creatures (allies are never despawned)
    g.creatures = g.creatures.filter((c) => Math.abs(Math.floor(c.cx / TILE / SPAWN.zone) - pz) <= SPAWN.despawnZones);

    const view = g.viewTiles();
    for (let z = pz - SPAWN.radiusZones; z <= pz + SPAWN.radiusZones; z++) {
      const x0 = z * SPAWN.zone, x1 = x0 + SPAWN.zone;
      if (x0 < 8 || x1 > g.world.w - 8) continue;
      const count = g.creatures.filter((c) => c.cx >= x0 * TILE && c.cx < x1 * TILE).length;
      const biome = BIOMES[g.world.biome[x0 + (SPAWN.zone >> 1)]];
      const want = biome.density * (g.isNight ? 1.3 : 1);
      if (count >= want) continue;
      // pick a column outside the view
      const tx = x0 + Math.floor(Math.random() * SPAWN.zone);
      if (tx > view.x0 - 2 && tx < view.x1 + 2) continue;
      this.spawnAt(tx);
    }
  }

  spawnAt(tx) {
    const g = this.game, world = g.world;
    const danger = world.danger(tx);
    const biomeId = world.biome[tx];
    const table = Spawner.table(biomeId, danger, g.isNight);
    if (!table.length) return null;
    const surf = world.surface[tx];
    const water = surf > WATER_LEVEL;
    const choices = table.filter((e) => !!e.def.spawn.water === water);
    if (!choices.length) return null;
    let r = Math.random() * choices.reduce((s, e) => s + e.weight, 0);
    let pick = choices[0];
    for (const e of choices) { r -= e.weight; if (r <= 0) { pick = e; break; } }
    const def = pick.def;
    const hostile = def.ai === 'hostile' || def.ai === 'aquatic';
    if (hostile && Math.abs(tx - world.spawn.tx) < SPAWN.safeRadius) return null;
    if (hostile && g.isSafe(tx * TILE)) return null;
    const [gmin, gmax] = def.spawn.group;
    const n = gmin + Math.floor(Math.random() * (gmax - gmin + 1));
    const made = [];
    for (let i = 0; i < n; i++) {
      const x = (tx + i * 2) * TILE + TILE / 2;
      const col = Math.floor(x / TILE);
      const feet = water ? (WATER_LEVEL + 2) * TILE : world.surface[col] * TILE;
      if (water && world.surface[col] <= WATER_LEVEL + 2) continue;
      const c = new Creature(def, x, feet);
      g.creatures.push(c);
      made.push(c);
    }
    return made;
  }
}
