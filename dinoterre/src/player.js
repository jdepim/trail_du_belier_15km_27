// The player-controlled dinosaur: walk, jump, climb, swim, bite, eat. All numbers come from its species.
import { PHYS, SURVIVAL, TILE } from './config.js';
import { moveBody, waterState, wallBeside, onClimbable, overlap } from './physics.js';
import { jumpVelocity } from './data/species.js';
import { RESOURCES } from './data/resources.js';
import { approach, clamp } from './rng.js';

export class Player {
  constructor(species, x, y) {
    this.species = species;
    this.w = species.size.w;
    this.h = species.size.h;
    this.x = x - this.w / 2;
    this.y = y - this.h;
    this.vx = 0; this.vy = 0;
    this.facing = 1;
    this.onGround = false;
    this.hp = species.hp;
    this.hunger = SURVIVAL.hungerMax;
    this.stamina = SURVIVAL.staminaMax;
    this.breath = species.breath;
    this.state = 'normal';           // normal | climb | swim | dead
    this.exhausted = false;          // stamina ran out on a wall: no grip until it recovers
    this.coyote = 0; this.jumpBuf = 0; this.jumping = false; this.dropT = 0;
    this.attackT = 0; this.attackCd = 0; this.hitSet = null;
    this.hurtT = 0; this.deadT = 0;
    this.anim = 0;                   // animation clock
    this.inWater = false; this.submerged = false;
    this.jumpV = jumpVelocity(species, PHYS.gravity, TILE) * 1.03; // a hair of margin to clear exact heights
    this.resting = false;
  }

  get cx() { return this.x + this.w / 2; }
  get cy() { return this.y + this.h / 2; }
  get alive() { return this.state !== 'dead'; }

  update(dt, game) {
    const input = game.input;
    this.anim += dt;
    if (this.state === 'dead') {
      this.deadT -= dt;
      this.vy = Math.min(this.vy + PHYS.gravity * dt, PHYS.maxFall);
      this.vx = approach(this.vx, 0, 400 * dt);
      moveBody(game.world, this, dt);
      if (this.deadT <= 0) game.respawn();
      return;
    }
    this.hurtT = Math.max(0, this.hurtT - dt);
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.dropT = Math.max(0, this.dropT - dt);
    if (input.pressed('jump')) this.jumpBuf = PHYS.jumpBuffer; else this.jumpBuf = Math.max(0, this.jumpBuf - dt);

    const ws = waterState(game.world, this);
    this.inWater = ws.inWater;
    this.submerged = ws.submerged;

    if (this.state === 'climb') this.updateClimb(dt, game);
    else if (this.inWater) { this.state = 'swim'; this.updateSwim(dt, game); }
    else { this.state = 'normal'; this.updateNormal(dt, game); }

    this.updateAttack(dt, game);
    this.updateSurvival(dt, game);
  }

  // ------------------------------------------------------------------ ground & air
  updateNormal(dt, game) {
    const { input, world } = game;
    const sp = this.species;
    const ax = input.axis.x;
    if (ax) this.facing = ax > 0 ? 1 : -1;
    const target = ax * sp.walkSpeed;
    const accel = this.onGround ? PHYS.groundAccel : PHYS.airAccel;
    this.vx = approach(this.vx, target, (ax ? accel : PHYS.groundFriction * (this.onGround ? 1 : 0.3)) * dt);

    this.coyote = this.onGround ? PHYS.coyote : Math.max(0, this.coyote - dt);
    if (this.jumpBuf > 0 && this.coyote > 0) {
      if (input.axis.y > 0.6 && this.standingOnPlatform(world)) {
        this.dropT = 0.25;                            // down + jump: drop through a platform
      } else {
        this.vy = -this.jumpV;
        this.jumping = true;
        game.audio.play('jump');
        game.particles.spawn('dust', this.cx, this.y + this.h, { n: 4 });
      }
      this.jumpBuf = 0; this.coyote = 0;
    }
    if (this.jumping && !input.held('jump') && this.vy < 0) { this.vy *= PHYS.jumpCut; this.jumping = false; }
    if (this.vy >= 0) this.jumping = false;

    this.vy = Math.min(this.vy + PHYS.gravity * dt, PHYS.maxFall);
    const landed = this.onGround;
    const fallSpeed = this.vy;
    moveBody(world, this, dt, { dropThrough: this.dropT > 0, stepUp: this.onGround ? PHYS.stepUp : 0 });
    if (!landed && this.onGround && fallSpeed > 250) game.particles.spawn('dust', this.cx, this.y + this.h, { n: 6 });

    // grab a wall or a trunk
    if (input.held('climb') && this.canGrip()) {
      if (ax) this.facing = ax > 0 ? 1 : -1;
      if (wallBeside(world, this, this.facing) || onClimbable(world, this)) this.startClimb(game);
    }
  }

  standingOnPlatform(world) {
    const ty = Math.floor((this.y + this.h + 1) / TILE);
    const a = Math.floor(this.x / TILE), b = Math.floor((this.x + this.w - 0.01) / TILE);
    let plat = false;
    for (let tx = a; tx <= b; tx++) { if (world.isSolid(tx, ty)) return false; if (world.isOneway(tx, ty)) plat = true; }
    return plat;
  }

  canGrip() { return !this.exhausted && this.stamina > 0; }

  startClimb(game) {
    this.state = 'climb';
    this.vx = 0; this.vy = 0;
    this.jumping = false;
    this.attackT = 0;
    game.audio.play('grip');
  }

  // ------------------------------------------------------------------ climbing
  updateClimb(dt, game) {
    const { input, world } = game;
    const sp = this.species;
    const onTree = onClimbable(world, this);
    const hasWall = wallBeside(world, this, this.facing);

    if (this.jumpBuf > 0) {                          // wall jump (or hop off a trunk)
      this.jumpBuf = 0;
      this.state = 'normal';
      if (hasWall) { this.facing = -this.facing; this.vx = this.facing * sp.walkSpeed * 1.1; }
      this.vy = -this.jumpV * 0.75;
      this.jumping = true;
      game.audio.play('jump');
      return;
    }
    if (!input.held('climb') || this.inWater && !hasWall) { this.state = 'normal'; return; }
    if (!hasWall && !onTree) {
      // reached the top of the wall: hop onto the ledge
      this.state = 'normal';
      this.vy = -Math.max(130, this.jumpV * 0.5);
      this.vx = this.facing * sp.walkSpeed * 0.9;
      return;
    }

    const down = input.axis.y > 0.5;
    this.vy = down ? sp.climbSpeed * 1.5 : -sp.climbSpeed;
    this.vx = hasWall ? this.facing * 8 : 0;           // stay pressed against the wall
    this.stamina -= sp.climbDrain * dt * (down ? 0.4 : 1);
    if (this.stamina <= 0) {
      this.stamina = 0;
      this.exhausted = true;
      this.state = 'normal';
      game.toast('Épuisé ! Tu lâches prise.');
      game.audio.play('slip');
      return;
    }
    moveBody(world, this, dt, { stepUp: 0 });
    if (this.onGround && down) this.state = 'normal';
  }

  // ------------------------------------------------------------------ swimming
  updateSwim(dt, game) {
    const { input, world } = game;
    const sp = this.species;
    const ax = input.axis.x, ay = input.axis.y;
    if (ax) this.facing = ax > 0 ? 1 : -1;
    let ty;
    if (input.held('swim')) ty = -sp.swimSpeed;
    else if (Math.abs(ay) > 0.3) ty = ay * sp.swimSpeed;
    else ty = (0.5 - sp.buoyancy) * 60;                  // heavy species sink, light ones bob up
    this.vx = approach(this.vx, ax * sp.swimSpeed, 380 * dt);
    this.vy = approach(this.vy, ty, 420 * dt);

    // leap out at the surface
    if (!this.submerged && this.jumpBuf > 0) {
      this.jumpBuf = 0;
      this.vy = -this.jumpV * 0.85;
      this.jumping = true;
      game.audio.play('splash');
      game.particles.spawn('splash', this.cx, this.y + this.h * 0.5, { n: 6 });
    }
    moveBody(world, this, dt, { stepUp: 0 });
    if (input.held('climb') && this.canGrip() && wallBeside(world, this, this.facing)) this.startClimb(game);
    if (Math.abs(this.vx) + Math.abs(this.vy) > 20 && Math.random() < dt * 3) game.particles.spawn('bubble', this.cx + this.facing * this.w / 2, this.y + 2, { n: 1 });
  }

  // ------------------------------------------------------------------ bite
  updateAttack(dt, game) {
    const sp = this.species;
    if (game.input.pressed('attack') && this.attackCd <= 0 && this.state !== 'climb') {
      this.attackT = 0.22;
      this.attackCd = sp.attackRate;
      this.hitSet = new Set();
      game.audio.play('bite');
    }
    if (this.attackT <= 0) return;
    const t = 0.22 - this.attackT;
    this.attackT -= dt;
    if (t < 0.04 || t > 0.18) return;
    const box = this.attackBox();
    for (const c of game.creatures) {
      if (!c.alive || c.ally || this.hitSet.has(c) || !overlap(box, c)) continue;
      this.hitSet.add(c);
      game.combat.hit(this, c, sp.attack, this.facing * sp.knockback);
    }
  }

  attackBox() {
    const r = this.species.attackReach;
    return { x: this.facing > 0 ? this.x + this.w - 2 : this.x - r + 2, y: this.y - 1, w: r, h: this.h + 2 };
  }

  // ------------------------------------------------------------------ survival
  updateSurvival(dt, game) {
    const sp = this.species;
    const drain = SURVIVAL.hungerDrain * sp.metabolism * (this.resting ? 0.5 : 1);
    this.hunger = Math.max(0, this.hunger - drain * dt);
    if (this.hunger <= 0) this.damageRaw(SURVIVAL.starveDamage * dt, game, 'faim');
    else if (this.hunger > SURVIVAL.regenHunger) this.heal(SURVIVAL.regenRate * dt);

    if (this.state !== 'climb') {
      this.stamina = Math.min(SURVIVAL.staminaMax, this.stamina + SURVIVAL.staminaRegen * dt * (this.onGround ? 1 : 0.35));
      if (this.exhausted && this.stamina >= SURVIVAL.staminaRegrip) this.exhausted = false;
    }
    if (this.submerged) {
      this.breath -= dt;
      if (this.breath <= 0) { this.breath = 0; this.damageRaw(SURVIVAL.drownDamage * dt, game, 'noyade'); }
    } else {
      this.breath = Math.min(sp.breath, this.breath + SURVIVAL.breathRefill * dt);
    }
  }

  heal(n) { this.hp = Math.min(this.species.hp, this.hp + n); }

  /** Eat one unit of a food resource from the inventory. Returns true if eaten. */
  eat(resId, game) {
    const food = RESOURCES[resId]?.food;
    if (!food || !game.inventory.take(resId, 1)) return false;
    this.hunger = Math.min(SURVIVAL.hungerMax, this.hunger + food.hunger);
    this.heal(food.heal);
    game.audio.play('eat');
    game.particles.spawn('crumb', this.cx + this.facing * this.w / 2, this.y + 3, { n: 5 });
    game.float(`+${food.hunger} faim`, this.cx, this.y - 4, '#ffcf6a');
    return true;
  }

  /** Damage from a creature: reduced by resist, gives invulnerability frames and knockback. */
  takeHit(amount, kx, game) {
    if (!this.alive || this.hurtT > 0) return false;
    const dmg = Math.max(0.5, amount * (1 - this.species.resist));
    this.hurtT = 0.7;
    this.vx = kx;
    if (this.state !== 'swim') this.vy = -140;
    if (this.state === 'climb') this.state = 'normal';
    game.camera.shake(3);
    game.audio.play('hurt');
    game.particles.spawn('blood', this.cx, this.cy, { n: 6 });
    game.float(`-${dmg.toFixed(dmg < 10 ? 1 : 0)}`, this.cx, this.y - 2, '#ff6060');
    this.damageRaw(dmg, game, 'combat');
    return true;
  }

  damageRaw(n, game, cause) {
    if (!this.alive) return;
    this.hp -= n;
    if (this.hp <= 0) {
      this.hp = 0;
      this.state = 'dead';
      this.deadT = 2.2;
      this.attackT = 0;
      game.onPlayerDeath(cause);
    }
  }

  /** Back to life at (x, feetY). */
  revive(x, feetY) {
    this.x = x - this.w / 2; this.y = feetY - this.h;
    this.vx = this.vy = 0;
    this.state = 'normal';
    this.hp = this.species.hp;
    this.hunger = Math.max(this.hunger, 60);
    this.stamina = SURVIVAL.staminaMax;
    this.breath = this.species.breath;
    this.hurtT = 1.5;
    this.exhausted = false;
  }

  /** Clamp inside the world after loading a save. */
  clampTo(world) {
    this.x = clamp(this.x, TILE, world.w * TILE - this.w - TILE);
    this.y = clamp(this.y, 0, world.h * TILE - this.h - TILE);
  }
}
