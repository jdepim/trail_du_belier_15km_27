// The astronaut and its MMU (DESIGN.md §4): absolute twin-stick thrust with a cruise-speed rule,
// brake, boost, inertia assist, gravity, tile bounces with impact damage, O2 / fuel / hull, solar
// recharge, death causes, charges and the Action button. Never draws: it only emits juice hooks.
//
//   baseStats() -> { maxHull, o2Max, fuelMax, rechargeRate, thrustAccel, cruiseSpeed, radarRange, magnetR, maxCharges }
//   new Player(game)
//     reset(x, y)            full resources, still, facing north (charges full if the Explosives are owned)
//     teleport(x, y)         keep resources, stop, reset interpolation
//     update(dt)             one fixed tick (reads game.input, game.hazards, game.entities, game.save)
//     damage(amount, cause, opts?) -> bool   opts.continuous: heat / asphyxia / storm (ignores and
//                            does not grant i-frames, no hurt sound); otherwise i-frames apply
//     heal(n), refill(dt?)   refill() = everything full at once; refill(dt) = dock rates (ECONOMY.dock)
//     impulse(ix, iy)        add velocity (explosions, lasers), capped at hardMaxSpeed
//     die(cause, opts?)      opts.force ignores ?god (the Balise de rappel)
//     hasItem(key)           game.save.items[key]
//   State read by the renderer / HUD (see NOTES.md "Simulation"):
//     x y prevX prevY vx vy r speed angle dir16 thrust thrustX thrustY braking boostT boostCd
//     hull o2 fuel charges stats iframes hurtT dead deadT deathCause gravX gravY gravMag inDock
//     fuelEmpty o2Low
import { PLAYER, ECONOMY, HIT_STOP } from './config.js';
import { moveCircle } from './physics.js';
import { TILES } from './tiles.js';

const TAU = Math.PI * 2;

/** Base stats; meta.applyUpgrades(player, save) rebuilds player.stats from a copy of these. */
export function baseStats() {
  return {
    maxHull: PLAYER.maxHull,
    o2Max: PLAYER.o2Max,
    fuelMax: PLAYER.fuelMax,
    rechargeRate: PLAYER.rechargeRate,
    thrustAccel: PLAYER.thrustAccel,
    cruiseSpeed: PLAYER.cruiseSpeed,
    radarRange: 900,
    magnetR: PLAYER.magnetR,
    maxCharges: PLAYER.maxCharges,
  };
}

function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

export class Player {
  constructor(game) {
    this.game = game;
    this.r = PLAYER.radius;
    this.m = 1;
    this.restitution = PLAYER.restitution;
    this.friction = PLAYER.friction;
    this.stats = baseStats();
    this._res = { hit: false, nx: 0, ny: 0, impact: 0, tile: 0 };
    this._g = { ax: 0, ay: 0, mag: 0, bh: 0 };
    this._fx = { vx: 0, vy: 0, nx: 0, ny: 0, count: 1, power: 1, r: 0, material: '', color: '' };
    this._snd = { volume: 1, pitch: 1, material: '' };
    this._exhaustAcc = 0;
    this._tick = 0;
    this.hull = 0; this.o2 = 0; this.fuel = 0; this.charges = 0;
    this.reset(0, 0);
  }

  hasItem(key) {
    const s = this.game.save;
    return !!(s && s.items && s.items[key]);
  }

  /** Respawn state: still, full resources, facing north. */
  reset(x, y) {
    this.x = x; this.y = y; this.prevX = x; this.prevY = y;
    this.vx = 0; this.vy = 0; this.speed = 0;
    this.angle = -Math.PI / 2; this.dir16 = 12;
    this.thrust = 0; this.thrustX = 0; this.thrustY = -1;
    this.braking = false; this.boostT = 0; this.boostCd = 0;
    this.idleT = PLAYER.rechargeDelay;
    this.iframes = 0; this.hurtT = 0;
    this.dead = false; this.deadT = 0; this.deathCause = null;
    this.gravX = 0; this.gravY = 0; this.gravMag = 0;
    this.inDock = false;
    this.fuelEmpty = false; this.o2Low = false;
    this.hull = this.stats.maxHull;
    this.o2 = this.stats.o2Max;
    this.fuel = this.stats.fuelMax;
    this.charges = this.hasItem('explosives') ? this.stats.maxCharges : 0;
  }

  teleport(x, y) {
    this.x = x; this.y = y; this.prevX = x; this.prevY = y;
    this.vx = 0; this.vy = 0; this.speed = 0;
  }

  refill(dt) {
    const s = this.stats;
    if (dt === undefined) {
      this.hull = s.maxHull; this.o2 = s.o2Max; this.fuel = s.fuelMax;
    } else {
      this.hull = Math.min(s.maxHull, this.hull + ECONOMY.dock.hull * dt);
      this.o2 = Math.min(s.o2Max, this.o2 + ECONOMY.dock.o2 * dt);
      this.fuel = Math.min(s.fuelMax, this.fuel + ECONOMY.dock.fuel * dt);
    }
    if (this.hasItem('explosives')) this.charges = s.maxCharges;
    this.fuelEmpty = this.fuel <= 0;
  }

  heal(n) { if (!this.dead) this.hull = Math.min(this.stats.maxHull, this.hull + n); }

  impulse(ix, iy) {
    this.vx += ix; this.vy += iy;
    this._capSpeed();
  }

  _capSpeed() {
    const s = Math.hypot(this.vx, this.vy);
    if (s > PLAYER.hardMaxSpeed) { const k = PLAYER.hardMaxSpeed / s; this.vx *= k; this.vy *= k; }
  }

  _sound(name, volume = 1, pitch = 1, material = '') {
    const a = this.game.audio;
    if (!a) return;
    const o = this._snd;
    o.volume = volume; o.pitch = pitch; o.material = material;
    a.play(name, o);
  }

  _particles(kind, x, y, vx = 0, vy = 0, count = 1, power = 1) {
    const p = this.game.particles;
    if (!p) return;
    const o = this._fx;
    o.vx = vx; o.vy = vy; o.nx = 0; o.ny = 0; o.count = count; o.power = power; o.r = 0; o.material = ''; o.color = '';
    p.spawn(kind, x, y, o);
  }

  update(dt) {
    const g = this.game;
    const st = this.stats;
    this.prevX = this.x; this.prevY = this.y;
    if (this.dead) {
      this.deadT += dt;
      const k = Math.exp(-PLAYER.deathDrift * dt);
      this.vx *= k; this.vy *= k;
      moveCircle(this, dt, g.world, this._res);
      this.speed = Math.hypot(this.vx, this.vy);
      return;
    }
    this.iframes -= dt; this.hurtT -= dt; this.boostCd -= dt; this.boostT -= dt;
    this._tick = (this._tick + 1) | 0;

    // ---- stick: absolute thrust direction in the world
    const inp = g.input;
    let mx = inp ? inp.moveX : 0, my = inp ? inp.moveY : 0;
    let m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; m = 1; }
    const stick = m > PLAYER.thrustMin;
    const ux = stick ? mx / m : 0, uy = stick ? my / m : 0;
    if (stick) {
      const target = Math.atan2(uy, ux);
      const diff = wrapAngle(target - this.angle);
      const step = PLAYER.turnRate * dt;
      this.angle = wrapAngle(Math.abs(diff) <= step ? target : this.angle + Math.sign(diff) * step);
    }
    this.dir16 = ((Math.round(this.angle / (TAU / 16)) % 16) + 16) % 16;

    const hadFuel = this.fuel > 0;
    let burning = false;
    // ---- thrust with the cruise rule: thrust never raises the speed above max(cruise, current)
    this.thrust = 0;
    if (stick && hadFuel) {
      const a = st.thrustAccel * m;
      const s0 = Math.hypot(this.vx, this.vy);
      let nvx = this.vx + ux * a * dt, nvy = this.vy + uy * a * dt;
      const s1 = Math.hypot(nvx, nvy);
      const lim = Math.max(st.cruiseSpeed, s0);
      if (s1 > lim) { nvx *= lim / s1; nvy *= lim / s1; }
      this.vx = nvx; this.vy = nvy;
      this.fuel -= PLAYER.fuelThrust * m * dt;
      this.thrust = m; this.thrustX = ux; this.thrustY = uy;
      burning = true;
      this._exhaustAcc += m * dt * 40;
      if (this._exhaustAcc >= 1) {
        this._exhaustAcc -= 1;
        this._particles('exhaust', this.x - ux * this.r, this.y - uy * this.r, this.vx - ux * 90, this.vy - uy * 90, 1, m);
      }
    }
    // ---- brake: retro-rockets opposed to the velocity until the stop
    const wantBrake = inp ? inp.held('brake') : false;
    const s = Math.hypot(this.vx, this.vy);
    this.braking = wantBrake && hadFuel && s > 0.5;
    if (this.braking) {
      const dv = Math.min(s, PLAYER.brakeDecel * dt);
      this.vx -= (this.vx / s) * dv; this.vy -= (this.vy / s) * dv;
      this.fuel -= PLAYER.fuelBrake * dt;
      burning = true;
      if (inp.pressed('brake')) this._sound('brake');
      if (this._tick % 3 === 0) this._particles('brake', this.x + (this.vx / s) * this.r, this.y + (this.vy / s) * this.r, this.vx + (this.vx / s) * 60, this.vy + (this.vy / s) * 60, 1, 1);
    }
    // ---- boost
    if (inp && inp.pressed('boost')) {
      if (this.boostCd <= 0 && this.fuel >= PLAYER.boostFuel) {
        const bx = stick ? ux : Math.cos(this.angle), by = stick ? uy : Math.sin(this.angle);
        this.vx += bx * PLAYER.boostImpulse; this.vy += by * PLAYER.boostImpulse;
        this.fuel -= PLAYER.boostFuel;
        this.boostCd = PLAYER.boostCooldown; this.boostT = 0.3;
        burning = true;
        this._sound('boost');
        this._particles('boost', this.x - bx * this.r, this.y - by * this.r, this.vx - bx * 160, this.vy - by * 160, 10, 1);
        if (g.camera) g.camera.shake(1.5, 0.12);
      } else {
        this._sound('deny', 0.6);
      }
    }
    if (this.fuel <= 0) {
      this.fuel = 0;
      if (hadFuel) this._sound('fuel_empty');
    }
    this.fuelEmpty = this.fuel <= 0;
    // ---- Assistance inertielle: free gentle damping without stick or brake
    const assist = !(g.save && g.save.settings && g.save.settings.assist === false);
    if (assist && !stick && !this.braking) {
      const k = Math.exp(-PLAYER.assistDrag * dt);
      this.vx *= k; this.vy *= k;
    }
    // ---- gravity (suns, black holes × Ancre, moon)
    if (g.hazards) {
      const gv = g.hazards.gravityAt(this.x, this.y, this._g);
      this.vx += gv.ax * dt; this.vy += gv.ay * dt;
      this.gravX = gv.ax; this.gravY = gv.ay; this.gravMag = gv.mag;
    }
    this._capSpeed();
    // ---- move + tile bounces
    const ox = this.x, oy = this.y;
    const res = moveCircle(this, dt, g.world, this._res);
    if (res.impact > 0) this._onImpact(res);
    const step = Math.hypot(this.x - ox, this.y - oy);
    this.speed = Math.hypot(this.vx, this.vy);
    if (g.run) { g.run.time += dt; g.run.distance += step; }

    // ---- resources
    this.inDock = !!(g.entities && g.entities.inDock);
    if (!this.inDock) {
      this.o2 -= dt;
      if (this.o2 <= 0) {
        this.o2 = 0;
        this.damage(PLAYER.asphyxiaDamage * dt, 'asphyxia', CONTINUOUS);
      }
    }
    this.o2Low = this.o2 < st.o2Max * PLAYER.o2LowFrac;
    this.idleT = burning ? 0 : this.idleT + dt;
    if (this.idleT >= PLAYER.rechargeDelay && this.fuel < st.fuelMax && !this.dead) {
      const near = g.hazards ? g.hazards.sunRechargeAt(this.x, this.y) : false;
      this.fuel = Math.min(st.fuelMax, this.fuel + st.rechargeRate * (near ? PLAYER.sunRechargeMul : 1) * dt);
      this.fuelEmpty = this.fuel <= 0;
    }
    if (this.dead) return;

    // ---- buttons
    if (inp && inp.pressed('action') && g.entities) g.entities.interact();
    if (inp && inp.pressed('charge')) this._dropCharge();
  }

  _dropCharge() {
    const g = this.game;
    if (!this.hasItem('explosives')) return;
    if (this.charges <= 0) {
      this._sound('deny');
      if (g.toast) g.toast("Plus de charges : recharge-les au dock ou au casier d'Orion.", TOAST_WARN);
      return;
    }
    // dropped just behind the astronaut, drifting with its velocity
    const bx = Math.cos(this.angle), by = Math.sin(this.angle);
    const d = this.r + 4;
    if (g.hazards && g.hazards.dropCharge(this.x - bx * d, this.y - by * d, this.vx, this.vy)) this.charges--;
  }

  _onImpact(res) {
    const g = this.game;
    const n = res.impact;
    const cx = this.x - res.nx * this.r, cy = this.y - res.ny * this.r;
    const mat = TILES[res.tile] ? TILES[res.tile].sound : 'metal';
    if (n > PLAYER.impactSafeSpeed) {
      this._sound('impact', Math.min(1, n / 300), 1, mat);
      const p = g.particles;
      if (p) {
        const o = this._fx;
        o.vx = 0; o.vy = 0; o.nx = res.nx; o.ny = res.ny; o.count = Math.min(14, 4 + (n / 30 | 0)); o.power = n / 200; o.r = 0; o.material = mat; o.color = '';
        p.spawn('spark', cx, cy, o);
      }
      this.damage((n - PLAYER.impactSafeSpeed) * PLAYER.impactDamage, 'impact');
      if (n > PLAYER.impactShake) {
        if (g.camera) g.camera.shake(Math.min(6, n / 60), 0.25);
        if (g.hitStop) g.hitStop(HIT_STOP.impact);
      }
    } else if (n > 25) {
      this._sound('bump', Math.min(1, n / PLAYER.impactSafeSpeed), 1, mat);
    }
  }

  damage(amount, cause, opts) {
    const g = this.game;
    if (this.dead || !(amount > 0)) return false;
    if (g.flags && g.flags.god) return false;
    const continuous = !!(opts && opts.continuous);
    if (!continuous && this.iframes > 0) return false;
    this.hull -= amount;
    if (!continuous) {
      this.iframes = PLAYER.iframes;
      this.hurtT = PLAYER.hurtFlash;
      this._sound('hurt', Math.min(1, 0.4 + amount / 40));
    }
    if (this.hull <= 0) { this.hull = 0; this.die(cause); }
    return true;
  }

  die(cause, opts) {
    const g = this.game;
    if (this.dead) return;
    if (g.flags && g.flags.god && !(opts && opts.force)) return;
    this.dead = true;
    this.deathCause = cause;
    this.deadT = 0;
    this.hull = 0;
    this.thrust = 0; this.braking = false;
    this._sound('death');
    this._particles('death', this.x, this.y, this.vx, this.vy, 24, 1);
    if (g.camera) g.camera.shake(6, 0.5);
    if (g.hitStop) g.hitStop(HIT_STOP.death);
    if (g.onPlayerDeath) g.onPlayerDeath(cause);
  }
}

const CONTINUOUS = { continuous: true };
const TOAST_WARN = { color: '#ffb347' };
