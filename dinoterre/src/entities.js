// Non-creature world objects: carcasses (loot of killed creatures), fossil bone piles, placed structures.
// Each exposes an optional interaction(game) → {label, priority, run()} used by the Interagir button.
import { PHYS, TILE, SPAWN } from './config.js';
import { moveBody, waterState } from './physics.js';
import { approach } from './rng.js';

export class Carcass {
  constructor(creature) {
    this.kind = 'carcass';
    this.def = creature.def;
    this.w = creature.w; this.h = Math.max(4, Math.round(creature.h * 0.6));
    this.x = creature.x; this.y = creature.y + creature.h - this.h;
    this.vx = creature.vx * 0.5; this.vy = -60;
    this.facing = creature.facing;
    this.drops = { ...creature.def.drops };
    this.life = SPAWN.carcassLife;
    this.claimedBy = null;
    this.onGround = false;
  }

  get alive() { return this.life > 0; }
  get cx() { return this.x + this.w / 2; }

  update(dt, game) {
    this.life -= dt;
    const ws = waterState(game.world, this);
    if (ws.inWater) this.vy = approach(this.vy, -18, 300 * dt);     // floats
    else this.vy = Math.min(this.vy + PHYS.gravity * dt, PHYS.maxFall);
    this.vx = approach(this.vx, 0, 300 * dt);
    moveBody(game.world, this, dt, { stepUp: 0 });
  }

  /** Takes every resource. Returns the bundle. */
  harvest() {
    const b = this.drops;
    this.drops = {};
    this.life = 0;
    return b;
  }

  interaction(game) {
    return {
      label: 'Dépecer', priority: 5,
      run: () => game.collect(this.harvest(), this.cx, this.y, 'harvest'),
    };
  }
}

export class BonePile {
  constructor(tx, ty) {
    this.kind = 'bones';
    this.w = 10; this.h = 5;
    this.x = tx * TILE + TILE / 2 - this.w / 2; this.y = (ty + 1) * TILE - this.h;
    this.tx = tx; this.ty = ty;
    this.regrowT = 0;
    this.claimedBy = null;
  }

  get ready() { return this.regrowT <= 0; }
  get alive() { return this.ready; }
  get cx() { return this.x + this.w / 2; }

  update(dt) { if (this.regrowT > 0) this.regrowT -= dt; }

  harvest() {
    this.regrowT = 240;
    this.claimedBy = null;
    return { bone: 2 };
  }

  interaction(game) {
    if (!this.ready) return null;
    return { label: 'Ramasser', priority: 5, run: () => game.collect(this.harvest(), this.cx, this.y, 'harvest') };
  }
}

export class Structure {
  constructor(def, tx, ty) {
    this.kind = 'structure';
    this.def = def;
    this.tx = tx; this.ty = ty;              // top-left tile
    this.x = tx * TILE; this.y = ty * TILE;
    this.w = def.w * TILE; this.h = def.h * TILE;
    this.anim = Math.random() * 10;
  }

  get cx() { return this.x + this.w / 2; }
  get alive() { return true; }

  update(dt) { this.anim += dt; }

  interaction(game) {
    const act = STRUCTURE_ACTIONS[this.def.interact];
    return act ? act(this, game) : null;
  }

  toJSON() { return { id: this.def.id, tx: this.tx, ty: this.ty }; }
}

// Interaction handlers for structures, keyed by BUILDINGS[*].interact.
export const STRUCTURE_ACTIONS = {
  rest(s, game) {
    return {
      label: 'Se reposer', priority: 2,
      run: () => game.restAt(s),
    };
  },
  cook(s, game) {
    if (game.inventory.count('meat') <= 0) return null;
    return {
      label: 'Griller', priority: 3,
      run: () => {
        const n = game.inventory.count('meat');
        game.inventory.take('meat', n);
        game.inventory.add('cooked', n);
        game.audio.play('cook');
        game.particles.spawn('smoke', s.cx, s.y, { n: 8 });
        game.float(`${n} viande${n > 1 ? 's' : ''} grillée${n > 1 ? 's' : ''}`, s.cx, s.y - 6, '#ffcf6a');
      },
    };
  },
};
