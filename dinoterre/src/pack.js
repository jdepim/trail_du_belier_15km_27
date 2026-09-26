// The player's pack of tamed allies: taming, capacity, roles (hunt / gather), loot claims and delivery.
import { PACK, TILE } from './config.js';
import { dist2 } from './physics.js';
import { Creature } from './creature.js';
import { CREATURES } from './data/creatures.js';

export const ROLES = {
  hunt: { id: 'hunt', name: 'Chasse', desc: 'Les alliés attaquent les ennemis proches.' },
  gather: { id: 'gather', name: 'Récolte', desc: 'Les alliés dépècent les carcasses et ramassent les os pour toi.' },
};

export class Pack {
  constructor(game) {
    this.game = game;
    this.role = 'hunt';
  }

  capacity() {
    let c = PACK.baseCapacity;
    for (const s of this.game.structures) c += s.def.packBonus || 0;
    return c;
  }

  get full() { return this.game.allies.length >= this.capacity(); }

  toggleRole() {
    this.role = this.role === 'hunt' ? 'gather' : 'hunt';
    for (const a of this.game.allies) { a.target = null; }
    this.game.toast(`Meute : ${ROLES[this.role].name} — ${ROLES[this.role].desc}`);
    return this.role;
  }

  /** Interaction offered on a tamable wild creature. */
  tameInteraction(c) {
    const g = this.game;
    const cost = c.def.tame.cost;
    const costTxt = Object.entries(cost).map(([id, n]) => `${n} ${id === 'meat' ? 'viande' : id}`).join(', ');
    return {
      label: this.full ? 'Meute pleine' : `Apprivoiser (${costTxt})`, priority: 4,
      run: () => {
        if (this.full) { g.toast(`Ta meute est pleine (${this.capacity()}). Construis un Nid pour l'agrandir.`); return; }
        if (!g.inventory.canAfford(cost)) { g.toast('Il te faut de la viande crue pour l\'amadouer.'); return; }
        g.inventory.pay(cost);
        this.tame(c);
      },
    };
  }

  tame(c) {
    const g = this.game;
    const i = g.creatures.indexOf(c);
    if (i >= 0) g.creatures.splice(i, 1);
    const ally = new Creature(c.def, c.cx, c.y + c.h, { ally: true });
    ally.facing = c.facing;
    g.allies.push(ally);
    g.audio.play('tame');
    g.particles.spawn('heart', ally.cx, ally.y, { n: 5 });
    g.float('Nouvel allié !', ally.cx, ally.y - 6, '#7fe07f');
    g.stats.tamed++;
    return ally;
  }

  /** Recreate allies from a save. */
  restore(list, player) {
    for (const a of list) {
      const def = CREATURES[a.id];
      if (!def) continue;
      const c = new Creature(def, player.cx - 12, player.y + player.h, { ally: true });
      c.hp = Math.min(c.stats.hp, a.hp ?? c.stats.hp);
      this.game.allies.push(c);
    }
  }

  onPlayerAttack(target) {
    if (!target.alive) return;
    for (const a of this.game.allies) if (!a.target && !a.carrying) a.target = target;
  }

  findEnemy(ally) {
    const g = this.game;
    let best = null, bd = PACK.huntRange ** 2;
    for (const c of g.creatures) {
      if (!c.alive || !c.aggressive) continue;
      const d = dist2(c, g.player);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best && ally.angryT > 0) {
      for (const c of g.creatures) if (c.alive && c.target === ally) return c;
    }
    return best;
  }

  /** Nearest free loot (carcass or ready bone pile) near the player; claims it for this ally. */
  claimLoot(ally) {
    const g = this.game;
    for (const l of g.loot()) if (l.claimedBy === ally && l.alive) return l;
    let best = null, bd = PACK.gatherRange ** 2;
    for (const l of g.loot()) {
      if (!l.alive || (l.claimedBy && l.claimedBy !== ally && l.claimedBy.alive && g.allies.includes(l.claimedBy))) continue;
      if (Math.abs(l.y - g.player.y) > 12 * TILE) continue;
      const d = dist2(l, g.player);
      if (d < bd) { bd = d; best = l; }
    }
    if (best) best.claimedBy = ally;
    return best;
  }

  harvest(ally, loot) {
    ally.carrying = loot.harvest();
    loot.claimedBy = null;
    this.game.audio.play('harvest');
    this.game.particles.spawn('dust', loot.cx, loot.y + loot.h, { n: 4 });
  }

  deliver(ally) {
    const b = ally.carrying;
    ally.carrying = null;
    if (b) this.game.collect(b, ally.cx, ally.y, 'deliver');
  }

  teleportNear(ally) {
    const p = this.game.player;
    ally.x = p.cx - p.facing * 14 - ally.w / 2;
    ally.y = p.y + p.h - ally.h;
    ally.vx = ally.vy = 0;
    ally.stuckT = 0;
    ally.target = null;
    this.game.particles.spawn('dust', ally.cx, ally.y + ally.h, { n: 5 });
  }

  onAllyDeath(ally) {
    const g = this.game;
    const i = g.allies.indexOf(ally);
    if (i >= 0) g.allies.splice(i, 1);
    g.toast(`Ton ${ally.def.name} est tombé au combat…`);
  }

  toJSON() { return this.game.allies.map((a) => ({ id: a.def.id, hp: Math.round(a.hp) })); }
}
