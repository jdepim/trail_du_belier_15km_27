// The player: platforming, pickaxe strikes / digging, damage, animation state.
// Movement feel follows DESIGN.md §4 (accel/friction, variable jump, coyote time,
// jump buffer, ceiling corner correction). Rope physics live in grapple.js.
import { PLAYER, GRAPPLE, TILE, SURFACE_Y, HIT_STOP } from './config.js';
import { moveAndCollide } from './physics.js';
import { TILES } from './tiles.js';
import { Grapple } from './grapple.js';

function approach(v, target, step) {
  if (v < target) return Math.min(v + step, target);
  if (v > target) return Math.max(v - step, target);
  return v;
}

/** Base stats; meta.applyUpgrades(player, save) modifies a copy of these. */
export function baseStats() {
  return {
    maxHp: PLAYER.maxHp,
    maxSpeed: PLAYER.maxSpeed,
    jumpVel: PLAYER.jumpVel,
    attackCooldown: PLAYER.attackCooldown,
    pickDamage: PLAYER.pickDamage,     // mining damage per strike (tile hp units)
    pickTier: PLAYER.pickTier,
    attackDamage: 10,                  // damage dealt to enemies per strike
    armor: PLAYER.armor,
    grappleRange: GRAPPLE.range,
    reelSpeed: GRAPPLE.reelSpeed,
    lanternRadius: PLAYER.lanternRadius,
    bagCapacity: PLAYER.bagCapacity,
    hookSpeed: GRAPPLE.hookSpeed,
    insurance: 0,                      // Bourse de secours: share of the loot kept on death
    // run relics (meta.RELICS) tweak these
    airJumps: 0,                       // Double saut
    glide: false,                      // Plume: hold jump to fall slowly
    killHeal: 0,                       // Vampirisme: HP healed per kill
    magnetMul: 1,                      // Aimant: pickup magnet radius multiplier
    oreMul: 1, goldMul: 1,             // Avarice
    regen: 0,                          // Cœur de troll: HP per second
    firePick: false,                   // Pioche ardente (visual embers on strikes)
  };
}

export const ANIMS = {
  idle: { frames: 4, fps: 5 },
  run: { frames: 6, fps: 12 },
  jump: { frames: 2, fps: 0 },
  fall: { frames: 2, fps: 8 },
  strike_side: { frames: 3, fps: 0 },
  strike_up: { frames: 3, fps: 0 },
  strike_down: { frames: 3, fps: 0 },
  grapple: { frames: 2, fps: 0 },
  hurt: { frames: 1, fps: 0 },
  dead: { frames: 1, fps: 0 },
};

export class Player {
  constructor(game) {
    this.game = game;
    this.w = PLAYER.w;
    this.h = PLAYER.h;
    this.cornerCorrection = PLAYER.cornerCorrection;
    this.stats = baseStats();
    this.grapple = new Grapple(game, this);
    this._res = { onGround: false, hitCeiling: false, hitLeft: false, hitRight: false };
    this._targets = [];
    this.reset(0, 0);
  }

  /** Place the player with its feet centred at (cx, feetY) and restore state. */
  reset(cx, feetY) {
    this.x = cx - this.w / 2; this.y = feetY - this.h;
    this.prevX = this.x; this.prevY = this.y;
    this.vx = 0; this.vy = 0;
    this.hp = this.stats.maxHp;
    this.facing = 1;
    this.onGround = false;
    this.coyoteT = 0; this.jumpBufferT = 0; this.jumping = false;
    this.attackCd = 0; this.attackBufferT = 0; this.strikeT = 0; this.strikeDir = 'side';
    this.iframes = 0; this.hurtT = 0;
    this.digAssistT = 0;
    this.tooHardCd = 0;
    this.airTime = 0;
    this.airJumpsLeft = 0; this.gliding = false; this.regenAcc = 0;
    this.dead = false; this.deadT = 0;
    this.anim = 'idle'; this.animT = 0; this.animFrame = 0;
    this.landSquash = 0;
    this.grapple.reset();
  }

  /** Teleport keeping state (debug / respawn); resets interpolation. */
  teleport(cx, feetY) {
    this.x = cx - this.w / 2; this.y = feetY - this.h;
    this.prevX = this.x; this.prevY = this.y;
    this.vx = 0; this.vy = 0;
    this.grapple.reset();
  }

  get cx() { return this.x + this.w / 2; }
  get cy() { return this.y + this.h / 2; }
  get feetY() { return this.y + this.h; }
  get tileX() { return Math.floor(this.cx / TILE); }
  get tileY() { return Math.floor((this.y + this.h - 1) / TILE); }
  get depth() { return Math.max(0, this.tileY - SURFACE_Y); }
  get invulnerable() { return this.iframes > 0 || this.dead || !!(this.game.flags && this.game.flags.god); }

  // ------------------------------------------------------------------ update
  update(dt) {
    const g = this.game;
    const inp = g.input;
    const world = g.world;
    const grapple = this.grapple;
    this.prevX = this.x; this.prevY = this.y;

    if (this.dead) {
      this.deadT += dt;
      this.vx = approach(this.vx, 0, 600 * dt);
      this.vy = Math.min(PLAYER.maxFall, this.vy + PLAYER.gravity * dt);
      moveAndCollide(this, dt, world, this._res);
      grapple.update(dt); // let the hook finish retracting to the corpse
      this._updateAnim(dt);
      return;
    }

    // timers
    this.coyoteT -= dt; this.jumpBufferT -= dt; this.attackCd -= dt; this.strikeT -= dt; this.attackBufferT -= dt;
    this.iframes -= dt; this.hurtT -= dt; this.digAssistT -= dt; this.tooHardCd -= dt;
    this.landSquash = Math.max(0, this.landSquash - dt);

    if (this.onGround) this.airJumpsLeft = this.stats.airJumps; // Double saut refills on the ground
    const stunned = this.hurtT > PLAYER.hurtStun * 0.5;
    const moveX = stunned ? 0 : inp.moveX;
    if (moveX !== 0 && this.strikeT <= 0.05) this.facing = moveX > 0 ? 1 : -1;

    // grapple button: fire / release / cancel
    if (inp.pressed('grapple') && !stunned) grapple.onPress();

    // jump (buffered)
    if (inp.pressed('jump')) this.jumpBufferT = PLAYER.jumpBuffer;
    let jumpUsed = false;
    if (grapple.attached && this.jumpBufferT > 0) {
      if (!this.onGround) {
        jumpUsed = true;
        grapple.release(true);
        this.jumpBufferT = 0;
        this.jumping = false;
        g.audio.play('jump', { pitch: 1.15 });
      } else {
        grapple.release(false); // on the ground: normal jump below
      }
    }

    // horizontal control
    const st = this.stats;
    const swinging = grapple.attached && !this.onGround && grapple.isTaut();
    if (!swinging) {
      const target = moveX * st.maxSpeed;
      const reversing = this.vx !== 0 && moveX !== 0 && Math.sign(this.vx) !== Math.sign(moveX);
      if (this.onGround) {
        if (moveX !== 0) this.vx = approach(this.vx, target, PLAYER.accelGround * (reversing ? PLAYER.turnBoost : 1) * dt);
        else this.vx = approach(this.vx, 0, PLAYER.frictionGround * dt);
      } else if (moveX !== 0) {
        if (Math.abs(this.vx) > st.maxSpeed && !reversing) this.vx = approach(this.vx, target, PLAYER.overspeedDrag * dt);
        else this.vx = approach(this.vx, target, PLAYER.accelAir * (reversing ? PLAYER.turnBoost : 1) * dt);
      } else {
        const drag = Math.abs(this.vx) > st.maxSpeed ? PLAYER.overspeedDrag : PLAYER.dragAir;
        this.vx = approach(this.vx, 0, drag * dt);
      }
    }

    // gravity with gentle apex
    let grav = PLAYER.gravity;
    if (!this.onGround && inp.held('jump') && Math.abs(this.vy) < PLAYER.apexThreshold && !grapple.attached) grav *= PLAYER.apexGravityMul;
    this.vy = Math.min(PLAYER.maxFall, this.vy + grav * dt);

    // jump launch
    if (this.jumpBufferT > 0 && (this.onGround || this.coyoteT > 0) && !grapple.attached && !stunned) {
      this.vy = -st.jumpVel;
      this.jumpBufferT = 0; this.coyoteT = 0;
      this.jumping = true; this.onGround = false;
      g.audio.play('jump');
      g.particles.spawn('dust', this.cx, this.feetY, { count: 4 });
    }
    // Double saut (relic): a fresh press in mid-air, after the coyote window
    else if (inp.pressed('jump') && !jumpUsed && this.airJumpsLeft > 0 && !this.onGround && this.coyoteT <= 0 && !grapple.attached && !stunned) {
      this.airJumpsLeft--;
      this.vy = -st.jumpVel * PLAYER.airJumpMul;
      this.jumpBufferT = 0;
      this.jumping = true;
      g.audio.play('jump', { pitch: 1.35 });
      g.particles.spawn('poof', this.cx, this.feetY, { count: 6, color: '#d8cdb0' });
    }
    // variable jump height
    if (this.jumping && this.vy < 0 && !inp.held('jump')) { this.vy *= PLAYER.jumpCut; this.jumping = false; }
    if (this.vy >= 0) this.jumping = false;
    // Plume (relic): holding jump while falling glides
    this.gliding = st.glide && !this.onGround && this.vy > 0 && inp.held('jump') && !grapple.attached && !stunned;
    if (this.gliding && this.vy > PLAYER.glideFall) this.vy = Math.max(PLAYER.glideFall, this.vy - PLAYER.gravity * 3 * dt);

    // rope velocity stage, move, rope position stage
    grapple.preMove(this, dt);
    const fallSpeed = this.vy;
    const res = moveAndCollide(this, dt, world, this._res);
    grapple.postMove(this, dt);

    const wasOnGround = this.onGround;
    this.onGround = res.onGround;
    if (res.hitCeiling) this.jumping = false;
    if (this.onGround) {
      if (!wasOnGround && this.airTime > 0.12) this._land(fallSpeed);
      this.coyoteT = PLAYER.coyoteTime;
      this.airTime = 0;
      this.airJumpsLeft = st.airJumps;
    } else {
      this.airTime += dt;
    }
    if (grapple.attached) this.airJumpsLeft = st.airJumps; // swinging refills the double jump
    // Cœur de troll (relic): slow regeneration
    if (st.regen > 0 && this.hp < st.maxHp) {
      this.regenAcc += st.regen * dt;
      if (this.regenAcc >= 1) { this.regenAcc -= 1; this.heal(1); }
    } else this.regenAcc = 0;

    this._holeAssist(dt, moveX);
    this._hazards();

    // pickaxe: press strikes immediately (a tap during the cooldown is buffered),
    // holding the button auto-repeats at the attack cadence
    if (inp.pressed('attack')) this.attackBufferT = PLAYER.attackBuffer;
    if (!stunned && this.attackCd <= 0 && (this.attackBufferT > 0 || inp.held('attack'))) { this.attackBufferT = 0; this.strike(); }

    grapple.update(dt);
    grapple.predict();
    this._updateAnim(dt);
  }

  _land(speed) {
    const g = this.game;
    if (speed > PLAYER.landDustSpeed) {
      g.particles.spawn('land', this.cx, this.feetY, { count: Math.min(10, 3 + Math.round(speed / 60)) });
      g.audio.play('land', { volume: Math.min(1, speed / 380) });
      this.landSquash = 0.1;
      if (speed > 340) g.camera.shake(1.5, 0.1);
    }
  }

  /**
   * Slide into a 1-wide hole when idle, but only if the hole is under the body
   * centre (more than half over it) or was just dug. Merely overlapping the rim
   * must not drag the player in (standing next to a shaft, landing on its rim).
   */
  _holeAssist(dt, moveX) {
    if (!this.onGround || moveX !== 0 || this.grapple.attached) return;
    const world = this.game.world;
    const below = Math.floor((this.feetY + 1) / TILE);
    const cCol = Math.floor(this.cx / TILE);
    const l = Math.floor(this.x / TILE), r = Math.floor((this.x + this.w - 0.01) / TILE);
    if (l === r) return;
    // hole column = the non-solid one of the two columns under the body
    const holeCol = !world.isSolid(l, below) ? l : !world.isSolid(r, below) ? r : -1;
    if (holeCol < 0) return;
    const oneWide = world.isSolid(holeCol - 1, below) && world.isSolid(holeCol + 1, below);
    const justDug = this.digAssistT > 0;
    const assist = oneWide ? (holeCol === cCol || justDug) : (holeCol === cCol && justDug);
    if (!assist) return;
    const targetX = holeCol * TILE + TILE / 2 - this.w / 2;
    const step = PLAYER.holeAssistSpeed * dt;
    const dx = Math.max(-step, Math.min(step, targetX - this.x));
    if (!world.rectSolid(this.x + dx, this.y, this.w, this.h)) this.x += dx;
  }

  _hazards() {
    const g = this.game;
    const hz = g.world.rectHazard(this.x + 1, this.y + 3, this.w - 2, this.h - 3);
    if (hz > 0) {
      if (this.takeDamage(PLAYER.lavaDamage, null, { lava: true })) {
        this.vy = -PLAYER.lavaBounce;
        this.grapple.release(false);
        g.particles.spawn('ember', this.cx, this.feetY, { count: 14 });
        g.audio.play('lava');
      } else if (this.vy > -120) {
        this.vy = -PLAYER.lavaBounce * 0.7; // keep popping out while invulnerable
      }
    }
  }

  // ------------------------------------------------------------------ pickaxe

  /** Direction from the aim stick: 'up' | 'down' | 'side'. */
  strikeDirection() {
    const inp = this.game.input;
    if (inp.aimY < -0.55) return 'up';
    if (inp.aimY > 0.55) return 'down';
    return 'side';
  }

  /** Tiles targeted by a strike in `dir` (DESIGN §4). */
  strikeTiles(dir) {
    const world = this.game.world;
    const out = this._targets;
    out.length = 0;
    if (dir === 'side') {
      const col = this.facing > 0 ? Math.floor((this.x + this.w - 0.01) / TILE) + 1 : Math.floor((this.x + 0.01) / TILE) - 1;
      const head = Math.floor((this.y + 3) / TILE), feet = Math.floor((this.y + this.h - 3) / TILE);
      out.push(col, head);
      if (feet !== head) out.push(col, feet);
    } else if (dir === 'up') {
      const row = Math.floor((this.y + 0.01) / TILE) - 1;
      let col = Math.floor(this.cx / TILE);
      if (!world.isSolid(col, row)) {
        const l = Math.floor(this.x / TILE), r = Math.floor((this.x + this.w - 0.01) / TILE);
        const other = col === l ? r : l;
        if (other !== col && world.isSolid(other, row)) col = other;
      }
      out.push(col, row);
    } else {
      const row = Math.floor((this.y + this.h - 0.01) / TILE) + 1;
      let col = Math.floor(this.cx / TILE);
      if (!world.isSolid(col, row)) {
        const l = Math.floor(this.x / TILE), r = Math.floor((this.x + this.w - 0.01) / TILE);
        const other = col === l ? r : l;
        if (other !== col && world.isSolid(other, row)) col = other;
      }
      out.push(col, row);
    }
    return out;
  }

  /** Hit area for enemies (world px). */
  strikeBox(dir = this.strikeDir) {
    if (dir === 'up') return { x: this.cx - 11, y: this.y - 18, w: 22, h: 22 };
    if (dir === 'down') return { x: this.cx - 11, y: this.y + this.h - 6, w: 22, h: 20 };
    return this.facing > 0
      ? { x: this.x + this.w - 2, y: this.y - 3, w: 22, h: this.h + 6 }
      : { x: this.x - 20, y: this.y - 3, w: 22, h: this.h + 6 };
  }

  strike() {
    const g = this.game;
    const inp = g.input;
    const world = g.world;
    const st = this.stats;
    const dir = this.strikeDirection();
    if (dir === 'side' && inp.aimX !== 0) this.facing = inp.aimX > 0 ? 1 : -1;
    this.strikeDir = dir;
    this.strikeT = PLAYER.strikeAnim;
    this.attackCd = st.attackCooldown;
    g.audio.play('swing');

    // enemies first (the pickaxe is the weapon)
    const box = this.strikeBox(dir);
    const hits = g.enemies.damageInBox(box, st.attackDamage, this.cx, { dir, source: 'player' });
    if (hits > 0) {
      g.hitStop(HIT_STOP.enemy);
      g.camera.shake(2, 0.1);
      // pogo: a downward strike on an enemy while airborne bounces the player up
      if (dir === 'down' && !this.onGround && !this.grapple.attached) { this.vy = Math.min(this.vy, -PLAYER.pogoVel); this.jumping = false; }
    }

    // chests open with a strike too (or the contextual "Ouvrir" button)
    if (g.entities && g.entities.hitChests) g.entities.hitChests(box);

    // then tiles
    const t = this.strikeTiles(dir);
    let tooHard = false, hitAny = false, broke = false, hardId = 0;
    for (let i = 0; i < t.length; i += 2) {
      const tx = t[i], ty = t[i + 1];
      if (!world.isSolid(tx, ty)) continue;
      const r = world.damageTile(tx, ty, st.pickDamage, st.pickTier);
      const cx = tx * TILE + TILE / 2, cy = ty * TILE + TILE / 2;
      if (r.tooHard) { tooHard = true; hardId = r.tileId; continue; }
      if (!r.hit) continue;
      hitAny = true;
      if (r.broken) {
        broke = true;
        g.tileBroken(tx, ty, r.tileId, 'player');
      } else {
        g.particles.spawn('chip', cx - (dir === 'side' ? this.facing * 7 : 0), cy + (dir === 'up' ? 7 : dir === 'down' ? -7 : 0), { tileId: r.tileId, count: 3 });
        g.audio.play('hit', { material: TILES[r.tileId].sound, pitch: 0.9 + r.ratio * 0.3 });
      }
    }
    if (dir === 'down' && (hitAny || broke)) this.digAssistT = 0.6;
    if (st.firePick && (hitAny || hits > 0)) {
      const b = box;
      g.particles.spawn('ember', b.x + b.w / 2, b.y + b.h / 2, { count: 5, spread: 8 });
    }
    if (hitAny) { g.hitStop(HIT_STOP.tile); g.camera.shake(broke ? 1.6 : 0.8, 0.07); }
    if (tooHard && !hitAny) {
      const tx = t[0], ty = t[1];
      g.particles.spawn('spark', tx * TILE + TILE / 2 - (dir === 'side' ? this.facing * 8 : 0), ty * TILE + TILE / 2 + (dir === 'up' ? 8 : dir === 'down' ? -8 : 0), { count: 5 });
      g.audio.play('clink');
      g.camera.shake(1, 0.06);
      if (this.tooHardCd <= 0) {
        g.toast('Trop dur !', { color: '#ffb35c', sub: TILES[hardId].name + ' — pioche insuffisante' });
        this.tooHardCd = 0.9;
      }
    }
  }

  // ------------------------------------------------------------------ damage

  /**
   * Hurt the player. Returns false if ignored (i-frames, dead, god mode).
   * opts: { knockback: true, lava: false, cause: string }
   */
  takeDamage(amount, sourceX = null, opts = {}) {
    if (this.invulnerable) return false;
    const g = this.game;
    const dmg = Math.max(1, Math.round(amount * (1 - Math.min(0.8, this.stats.armor))));
    this.hp = Math.max(0, this.hp - dmg);
    this.iframes = PLAYER.iframes;
    this.hurtT = PLAYER.hurtStun;
    if (opts.knockback !== false && !opts.lava) {
      const dir = sourceX == null ? -this.facing : (this.cx < sourceX ? -1 : 1);
      this.vx = dir * PLAYER.knockbackX;
      this.vy = -PLAYER.knockbackY;
      this.onGround = false;
    }
    g.audio.play('hurt');
    g.camera.shake(3, 0.22);
    g.hitStop(HIT_STOP.hurt);
    g.particles.spawn('blood', this.cx, this.cy, { count: 10 });
    if (g.hud) g.hud.flashDamage(dmg);
    if (this.hp <= 0) this.die(opts.cause || (opts.lava ? 'lava' : 'enemy'));
    return true;
  }

  heal(n) {
    const before = this.hp;
    this.hp = Math.min(this.stats.maxHp, this.hp + n);
    return this.hp - before;
  }

  die(cause) {
    if (this.dead) return;
    const g = this.game;
    this.dead = true;
    this.deadT = 0;
    this.hp = 0;
    const gr = this.grapple;
    if (gr.state === 'attached') gr.release(false);
    else if (gr.state === 'flying') gr.state = 'retracting';
    g.audio.play('death');
    g.camera.shake(5, 0.4);
    g.particles.spawn('blood', this.cx, this.cy, { count: 24 });
    if (g.onPlayerDeath) g.onPlayerDeath(cause);
  }

  // ------------------------------------------------------------------ animation

  _setAnim(name) {
    if (this.anim !== name) { this.anim = name; this.animT = 0; }
  }

  _updateAnim(dt) {
    const gr = this.grapple;
    if (this.dead) this._setAnim('dead');
    else if (this.hurtT > PLAYER.hurtStun * 0.4) this._setAnim('hurt');
    else if (this.strikeT > 0) this._setAnim('strike_' + this.strikeDir);
    else if (gr.attached && !this.onGround) this._setAnim('grapple');
    else if (!this.onGround) this._setAnim(this.vy < 0 ? 'jump' : 'fall');
    else if (Math.abs(this.vx) > 10) this._setAnim('run');
    else this._setAnim('idle');
    this.animT += dt;
    const a = ANIMS[this.anim];
    switch (this.anim) {
      case 'run': {
        // cadence follows speed so feet don't skate
        const speedK = Math.max(0.5, Math.abs(this.vx) / this.stats.maxSpeed);
        this.runPhase = ((this.runPhase || 0) + dt * a.fps * speedK) % a.frames;
        this.animFrame = Math.floor(this.runPhase);
        break;
      }
      case 'jump': this.animFrame = this.vy < -140 ? 0 : 1; break;
      case 'strike_side': case 'strike_up': case 'strike_down': {
        const p = 1 - Math.max(0, this.strikeT) / PLAYER.strikeAnim;
        this.animFrame = p < 0.25 ? 0 : p < 0.6 ? 1 : 2;
        break;
      }
      case 'grapple': this.animFrame = Math.abs(this.vx) > 60 ? 1 : 0; break;
      default:
        this.animFrame = a.fps > 0 ? Math.floor(this.animT * a.fps) % a.frames : 0;
    }
  }
}
