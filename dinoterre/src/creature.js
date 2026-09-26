// Wild creatures and tamed allies. Behaviour is chosen by `def.ai` (data/creatures.js) or by the pack role for allies.
import { PHYS, TILE, PACK } from './config.js';
import { moveBody, waterState, overlap, dist2 } from './physics.js';
import { allyStats } from './data/creatures.js';
import { approach, clamp } from './rng.js';

const jumpV = (tiles) => Math.sqrt(2 * PHYS.gravity * tiles * TILE) * 1.05;

export class Creature {
  constructor(def, x, feetY, { ally = false } = {}) {
    this.def = def;
    this.kind = 'creature';
    this.ally = ally;
    this.stats = ally ? allyStats(def) : def;
    this.w = def.size.w; this.h = def.size.h;
    this.x = x - this.w / 2; this.y = feetY - this.h;
    this.vx = 0; this.vy = 0; this.facing = Math.random() < 0.5 ? -1 : 1;
    this.onGround = false;
    this.hp = this.stats.hp;
    this.alive = true;
    this.target = null;       // entity being chased
    this.angryT = 0;          // neutral/passive: seconds of retaliation or fleeing left
    this.attackT = 0; this.attackCd = 0;
    this.hurtT = 0;
    this.wanderT = Math.random() * 2; this.wanderDir = 0;
    this.anim = Math.random() * 10;
    this.inWater = false; this.submerged = false;
    this.carrying = null;     // gatherer ally: bundle being brought back
    this.harvestT = 0;
    this.stuckT = 0; this.lastX = this.x;
  }

  get cx() { return this.x + this.w / 2; }
  get cy() { return this.y + this.h / 2; }
  get aquatic() { return this.def.ai === 'aquatic'; }
  get tamable() { return !!this.def.tame && !this.ally && this.alive; }
  /** Hostile toward the player right now (drives ally hunting and HUD markers). */
  get aggressive() { return !this.ally && (this.def.ai === 'hostile' || this.def.ai === 'aquatic' || (this.def.ai === 'neutral' && this.angryT > 0)); }

  update(dt, game) {
    this.anim += dt;
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.angryT = Math.max(0, this.angryT - dt);
    const ws = waterState(game.world, this);
    this.inWater = ws.inWater; this.submerged = ws.submerged;

    let intent = { dir: 0, jump: false, swimY: 0 };
    if (this.ally) intent = this.thinkAlly(dt, game);
    else intent = this.thinkWild(dt, game);
    this.updateAttack(dt, game);
    this.move(dt, game, intent);
  }

  // ---------------------------------------------------------------- wild behaviours
  thinkWild(dt, game) {
    const s = this.stats, p = game.player;
    const aggroPx = s.aggro * TILE * (game.isNight ? 1.3 : 1);
    const near = p.alive && dist2(this, p) < aggroPx * aggroPx;

    switch (this.def.ai) {
      case 'passive': {
        if (this.angryT > 0 || (this.def.skittish && near && !this.def.tame)) return this.flee(p);
        if (this.def.tame && near && dist2(this, p) < (3 * TILE) ** 2 && Math.abs(p.vx) > 40) return this.flee(p);
        return this.wander(dt, game);
      }
      case 'neutral': {
        if (this.angryT > 0 && this.target?.alive !== false) return this.chase(this.target, game);
        return this.wander(dt, game);
      }
      case 'hostile':
      case 'aquatic': {
        if (!this.validTarget(this.target, game, aggroPx * 1.8)) this.target = this.pickPrey(game, aggroPx);
        if (this.target) return this.chase(this.target, game);
        return this.aquatic ? this.drift(dt, game) : this.wander(dt, game);
      }
      default:
        return this.wander(dt, game);
    }
  }

  validTarget(t, game, range) {
    if (!t || !(t.alive ?? true) || (t === game.player && !t.alive)) return false;
    if (dist2(this, t) > range * range) return false;
    if (game.isSafe(t.cx)) return false;
    if (this.aquatic && !t.inWater) return false;
    return true;
  }

  pickPrey(game, range) {
    let best = null, bd = range * range;
    const consider = (t) => {
      if (!this.validTarget(t, game, range)) return;
      const d = dist2(this, t);
      if (d < bd) { bd = d; best = t; }
    };
    consider(game.player);
    for (const a of game.allies) consider(a);
    return best;
  }

  wander(dt, game) {
    this.wanderT -= dt;
    if (this.wanderT <= 0) {
      this.wanderDir = Math.random() < 0.4 ? 0 : (Math.random() < 0.5 ? -1 : 1);
      this.wanderT = 1 + Math.random() * 2.5;
    }
    if (this.wanderDir && this.onGround && this.dangerAhead(game.world, this.wanderDir)) this.wanderDir = -this.wanderDir;
    return { dir: this.wanderDir, speed: 0.45, jump: false };
  }

  drift(dt, game) {
    const w = this.wander(dt, game);
    return { ...w, swimY: Math.sin(this.anim * 0.7) * 0.3 };
  }

  flee(from) {
    const dir = this.cx < from.cx ? -1 : 1;
    return { dir, speed: 1, jump: this.hitWallX !== 0 };
  }

  chase(t, game) {
    const dx = t.cx - this.cx;
    const dir = Math.abs(dx) < 3 ? 0 : Math.sign(dx);
    if (dir) this.facing = dir;
    const above = t.y + t.h < this.y - 6 && Math.abs(dx) < 40;
    if (this.inReach(t)) {
      if (this.attackCd <= 0 && this.attackT <= 0) this.attackT = 0.32;
      return { dir: 0, speed: 1, swimY: this.aquatic ? Math.sign(t.cy - this.cy) : 0 };
    }
    return { dir, speed: 1, jump: this.hitWallX !== 0 || (above && Math.random() < 0.05), swimY: clamp((t.cy - this.cy) / 12, -1, 1) };
  }

  /** Drop of more than 3 tiles or water right ahead. */
  dangerAhead(world, dir) {
    const tx = Math.floor((dir > 0 ? this.x + this.w + 2 : this.x - 2) / TILE);
    const ty = Math.floor((this.y + this.h + 1) / TILE);
    for (let d = 0; d < 4; d++) {
      if (world.isWater(tx, ty + d) && !this.aquatic) return true;
      if (world.isSolid(tx, ty + d) || world.isOneway(tx, ty + d)) return false;
    }
    return true;
  }

  inReach(t) {
    const r = this.stats.reach;
    if (!r) return false;
    const box = { x: this.facing > 0 ? this.x + this.w - 2 : this.x - r + 2, y: this.y - 2, w: r, h: this.h + 4 };
    return overlap(box, t);
  }

  // ---------------------------------------------------------------- ally behaviours
  thinkAlly(dt, game) {
    const p = game.player;
    if (!p.alive) return { dir: 0 };
    const far = dist2(this, p) > PACK.teleportDist ** 2;
    if (far || this.stuckT > 4) { game.pack.teleportNear(this); return { dir: 0 }; }

    // defend: anything attacking the ally or the player, then (hunters) any aggressive creature close by
    if (this.target && (!this.target.alive || dist2(this.target, p) > (PACK.huntRange * 1.6) ** 2)) this.target = null;
    if (!this.target && (game.pack.role === 'hunt' || this.angryT > 0)) this.target = game.pack.findEnemy(this);
    if (this.target && !this.carrying) return this.chase(this.target, game);

    if (game.pack.role === 'gather') {
      if (this.carrying) {
        if (dist2(this, p) < 18 * 18) { game.pack.deliver(this); return { dir: 0 }; }
        return this.goTo(p, 1);
      }
      const loot = game.pack.claimLoot(this);
      if (loot) {
        if (Math.abs(loot.x + loot.w / 2 - this.cx) < loot.w / 2 + 4 && Math.abs(loot.y + loot.h - (this.y + this.h)) < 14) {
          this.harvestT += dt;
          if (this.harvestT > 1.4) { this.harvestT = 0; game.pack.harvest(this, loot); }
          return { dir: 0 };
        }
        this.harvestT = 0;
        return this.goTo(loot, 1);
      }
    }
    // follow the player, each ally a little further behind
    const idx = game.allies.indexOf(this);
    const slot = p.cx - p.facing * (PACK.followDist + idx * 10);
    const dx = slot - this.cx;
    const dir = Math.abs(dx) < 6 ? 0 : Math.sign(dx);
    if (dir) this.facing = dir; else this.facing = p.cx > this.cx ? 1 : -1;
    const wantUp = p.y + p.h < this.y - 10 && Math.abs(p.cx - this.cx) < 48;
    return { dir, speed: Math.abs(dx) > 60 ? 1.1 : 0.9, jump: (this.hitWallX !== 0 && dir !== 0) || (wantUp && this.onGround), swimY: -1 };
  }

  goTo(t, speed) {
    const dx = t.x + t.w / 2 - this.cx;
    const dir = Math.abs(dx) < 3 ? 0 : Math.sign(dx);
    if (dir) this.facing = dir;
    const up = t.y + t.h < this.y - 8 && Math.abs(dx) < 40;
    return { dir, speed, jump: (this.hitWallX !== 0 && dir !== 0) || (up && this.onGround), swimY: -1 };
  }

  // ---------------------------------------------------------------- attack & damage
  updateAttack(dt, game) {
    if (this.attackT <= 0) return;
    this.attackT -= dt;
    if (this.attackT > 0) return;
    this.attackCd = this.stats.attackRate;
    const t = this.target ?? (this.ally ? null : game.player);
    if (t && this.inReach(t)) game.combat.hit(this, t, this.stats.attack, this.facing * 160);
  }

  takeHit(amount, kx, attacker, game) {
    if (!this.alive) return 0;
    const dmg = Math.max(0.3, amount * (1 - (this.stats.resist || 0)));
    this.hp -= dmg;
    this.hurtT = 0.18;
    const mass = clamp(this.w * this.h / 150, 1.4, 4);
    this.vx = kx / mass;
    if (!this.inWater) this.vy = -110 / Math.sqrt(mass);
    this.attackT = 0;
    if (attacker && attacker !== this) {
      this.angryT = 8;
      if (this.def.ai !== 'passive' || this.ally) this.target = attacker;
    }
    if (this.hp <= 0) this.die(game, attacker);
    return dmg;
  }

  die(game, killer) {
    this.alive = false;
    this.hp = 0;
    game.onCreatureDeath(this, killer);
  }

  // ---------------------------------------------------------------- movement
  move(dt, game, intent) {
    const s = this.stats;
    const world = game.world;
    const spd = s.speed * (intent.speed ?? 1) * (this.inWater && !this.aquatic ? 0.55 : 1);
    if (intent.dir) this.facing = intent.dir;
    if (this.hurtT <= 0) this.vx = approach(this.vx, (intent.dir || 0) * spd, (this.onGround || this.inWater ? 700 : 300) * dt);

    if (this.aquatic && this.inWater) {
      this.vy = approach(this.vy, (intent.swimY || 0) * spd * 0.8, 300 * dt);
      // never leave the water: stop at the surface
      const headTy = Math.floor((this.y + this.vy * dt) / TILE);
      if (!world.isWater(Math.floor(this.cx / TILE), headTy) && this.vy < 0) this.vy = 0;
      const aheadTx = Math.floor((this.facing > 0 ? this.x + this.w + 1 : this.x - 1) / TILE);
      if (!world.isWater(aheadTx, Math.floor(this.cy / TILE)) && Math.sign(this.vx) === this.facing) this.vx = 0;
    } else if (this.inWater) {
      // land creature swimming: paddle toward the surface (or target)
      this.vy = approach(this.vy, (intent.swimY ?? -1) < 0 ? -40 : 30, 260 * dt);
      if (intent.jump && !this.submerged) this.vy = -jumpV(Math.max(1.5, s.jump || 1)) * 0.8;
    } else {
      if (intent.jump && this.onGround && s.jump > 0) this.vy = -jumpV(s.jump);
      this.vy = Math.min(this.vy + PHYS.gravity * dt, PHYS.maxFall);
    }
    moveBody(world, this, dt, { stepUp: this.onGround ? PHYS.stepUp : 0 });

    // stuck detection (allies teleport when stuck)
    if (intent.dir && Math.abs(this.x - this.lastX) < 0.2) this.stuckT += dt; else this.stuckT = Math.max(0, this.stuckT - dt * 2);
    this.lastX = this.x;
  }
}
