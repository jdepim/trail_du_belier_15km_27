// Every danger of the sector (DESIGN.md §6): suns (heat, flares), black holes, moon gravity,
// moving asteroids (belt orbit + Maelström spiral, pooled around the player), turrets and their
// bolts, laser barriers, gas vents, the ion storm, explosive charges and explosions.
// No drawing: the renderer reads the public state documented in NOTES.md "Simulation".
//
//   new Hazards(game)
//     reset(gen, lifeSeed)            new life: bodies from gen, pools emptied, cycles restarted
//     update(dt)                      after player.update (see DESIGN §13 fixed-step order)
//     gravityAt(x, y, out)            physics.gravityAt over gen.gravitySources, black holes × BLACK_HOLES.anchorMul
//                                     when the Ancre is owned -> out { ax, ay, mag, bh }
//     heatAt(x, y, shielded?)         hull/s at a point (shelter inside insulated zones; × SUNS.shieldMul when
//                                     shielded, default = the Bouclier is owned)
//     sunRechargeAt(x, y) -> bool     within SUNS.rechargeRMul × heatR of a sun (fuel recharge × 3)
//     dropCharge(x, y, vx, vy) -> bool
//     spawnAsteroid(mode, x, y, vx, vy, size) -> asteroid | null   (ASTEROID_MODE, size 0 S / 1 M / 2 L)
//     explode(x, y, r, power, cause) -> number of broken tiles
//   Pure helper: heatField(world, suns, x, y) -> unshielded hull/s including the zone shelter.
//   Public state: suns, blackHoles, moon, asteroids (pool), bolts (pool), turrets, lasers, vents,
//     charges (pool), explosions (FX pool), heatAtPlayer, heatLevel, nearSun, gravCritical,
//     bhProximity, stormIntensity, inStorm, time.
import {
  PLAYER, SUNS, BLACK_HOLES, BELT, ASTEROIDS, BOUNDARY, HAZARDS, CENTER, ZONES, HIT_STOP, ECONOMY,
} from './config.js';
import { moveCircle, gravityAt as physGravityAt, heatAt as physHeatAt, raycast, collideCircles, distToSegment } from './physics.js';
import { mulberry32 } from './rng.js';

// 64 points spread over the unit disc (golden spiral): Monte-Carlo estimate of how much of the
// asteroid window overlaps the belt annulus, without allocation.
const DISC_N = 64;
const DISC = new Float32Array(DISC_N * 2);
for (let i = 0; i < DISC_N; i++) {
  const r = Math.sqrt((i + 0.5) / DISC_N), a = i * 2.399963229728653;
  DISC[i * 2] = Math.cos(a) * r; DISC[i * 2 + 1] = Math.sin(a) * r;
}
const SHELTER = new Float32Array(256).fill(1);
for (const z of ZONES) SHELTER[z.id] = z.sheltered ? SUNS.shelteredMul : 1;

/** asteroid.mode values: belt orbit, Maelström spiral, free fragment (real gravity). */
export const ASTEROID_MODE = { BELT: 1, SPIRAL: 2, FREE: 3 };
const MODE_BELT = 1, MODE_SPIRAL = 2, MODE_FREE = 3;
const LASER_PERIOD = HAZARDS.laser.off + HAZARDS.laser.warn + HAZARDS.laser.on;
const VENT_PERIOD = HAZARDS.vent.off + HAZARDS.vent.warn + HAZARDS.vent.on;

/** Unshielded heat (hull/s) at a point, including the insulation of sheltered zones. */
export function heatField(world, suns, x, y) {
  const h = physHeatAt(x, y, suns);
  return h > 0 ? h * SHELTER[world.zoneAt(x, y)] : 0;
}

function angleTo(a, target, step) {
  let d = target - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return Math.abs(d) <= step ? target : a + Math.sign(d) * step;
}

function cyclePhase(t, off, warn) {
  return t < off ? 'off' : t < off + warn ? 'warn' : 'on';
}

export class Hazards {
  constructor(game) {
    this.game = game;
    this.suns = []; this.blackHoles = []; this.moon = null; this.sources = [];
    this.turrets = []; this.lasers = []; this.vents = [];
    this.asteroids = [];
    for (let i = 0; i < ASTEROIDS.pool; i++) {
      this.asteroids.push({ active: false, x: 0, y: 0, prevX: 0, prevY: 0, vx: 0, vy: 0, r: 0, m: 1, size: 0, angle: 0, spin: 0, mode: 0, variant: 0, hitCd: 0, speedMul: 1, blast: 0, restitution: ASTEROIDS.restitution, friction: 0.05 });
    }
    this.bolts = [];
    for (let i = 0; i < HAZARDS.bolts; i++) this.bolts.push({ active: false, x: 0, y: 0, prevX: 0, prevY: 0, vx: 0, vy: 0, angle: 0, life: 0 });
    this.charges = [];
    for (let i = 0; i < HAZARDS.charge.pool; i++) {
      this.charges.push({ active: false, x: 0, y: 0, prevX: 0, prevY: 0, vx: 0, vy: 0, r: HAZARDS.charge.r, m: 0.3, fuse: 0, fuseMax: HAZARDS.charge.fuse, beepT: 0, restitution: HAZARDS.charge.restitution, friction: 0.2 });
    }
    this.explosions = [];
    for (let i = 0; i < HAZARDS.explosions; i++) this.explosions.push({ active: false, x: 0, y: 0, r: 0, power: 0, t: 0, life: HAZARDS.explosionLife });
    this.heatAtPlayer = 0; this.heatLevel = 0; this.nearSun = false;
    this.gravCritical = false; this.bhProximity = 0;
    this.stormIntensity = 0; this.inStorm = false;
    this.time = 0;
    this.beltTarget = 0; this.spiralTarget = 0;
    this._rnd = mulberry32(1);
    this._g = { ax: 0, ay: 0, mag: 0, bh: 0 };
    this._res = { hit: false, nx: 0, ny: 0, impact: 0, tile: 0 };
    this._ray = { x: 0, y: 0, tx: 0, ty: 0, t: 0 };
    this._fx = { vx: 0, vy: 0, nx: 0, ny: 0, count: 1, power: 1, r: 0, material: '', color: '' };
    this._snd = { volume: 1, pitch: 1, material: '' };
    this._tick = 0;
    this._blastSeq = 0;
  }

  // ------------------------------------------------------------------ setup

  reset(gen, lifeSeed = 1) {
    this._rnd = mulberry32((lifeSeed ^ 0x4a5d) >>> 0);
    const rnd = this._rnd;
    this.time = 0;
    this.sources = gen.gravitySources;
    this.moon = gen.moon;
    this.suns = gen.suns.map((s) => ({
      key: s.key, name: s.name, x: s.x, y: s.y, coreR: s.coreR, heatR: s.heatR, heatMax: s.heatMax, heatExp: s.heatExp, cause: s.cause,
      flareState: 'idle', flareT: 0,
      nextFlare: SUNS.flare.firstDelayMin + rnd() * (SUNS.flare.firstDelayMax - SUNS.flare.firstDelayMin),
      ringR: 0, ringMaxR: s.heatR * SUNS.flare.maxRMul, ringHit: false,
    }));
    this.blackHoles = gen.blackHoles.map((b) => ({ key: b.key, name: b.name, x: b.x, y: b.y, horizon: b.horizon, diskR: b.diskR, cause: b.cause }));
    this.turrets = gen.turrets.map((t) => ({
      id: t.id, x: t.x, y: t.y, r: HAZARDS.turret.bodyR, m: Infinity, vx: 0, vy: 0,
      alive: true, deadT: 0, angle: rnd() * Math.PI * 2, scanDir: rnd() < 0.5 ? -1 : 1,
      state: 'scan', stateT: 0, telegraph: 0, cooldown: rnd() * HAZARDS.turret.cooldown, sees: false, losT: 0,
    }));
    this.lasers = gen.lasers.map((l) => ({ id: l.id, x0: l.x0, y0: l.y0, x1: l.x1, y1: l.y1, vertical: l.vertical, phase: l.phase, state: 'off', stateT: 0, t: 0 }));
    this.vents = gen.vents.map((v) => ({ id: v.id, x: v.x, y: v.y, dirX: v.dirX, dirY: v.dirY, length: v.length, halfWidth: v.halfWidth, phase: v.phase, state: 'off', stateT: 0, t: 0 }));
    for (const a of this.asteroids) a.active = false;
    for (const b of this.bolts) b.active = false;
    for (const c of this.charges) c.active = false;
    for (const e of this.explosions) e.active = false;
    this.heatAtPlayer = 0; this.heatLevel = 0; this.nearSun = false;
    this.gravCritical = false; this.bhProximity = 0; this.stormIntensity = 0; this.inStorm = false;
    this.beltTarget = 0; this.spiralTarget = 0;
    this._updateCycles(true);
  }

  _has(key) {
    const s = this.game.save;
    return !!(s && s.items && s.items[key]);
  }

  gravityAt(x, y, out) {
    return physGravityAt(x, y, this.sources, out, this._has('anchor') ? BLACK_HOLES.anchorMul : 1);
  }

  heatAt(x, y, shielded = this._has('heatshield')) {
    const h = heatField(this.game.world, this.suns, x, y);
    return shielded ? h * SUNS.shieldMul : h;
  }

  sunRechargeAt(x, y) {
    for (const s of this.suns) {
      const r = s.heatR * SUNS.rechargeRMul;
      const dx = x - s.x, dy = y - s.y;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }

  _sound(name, volume = 1, pitch = 1, material = '') {
    const a = this.game.audio;
    if (!a) return;
    const o = this._snd;
    o.volume = volume; o.pitch = pitch; o.material = material;
    a.play(name, o);
  }

  _particles(kind, x, y, vx, vy, count, power, r = 0, nx = 0, ny = 0) {
    const p = this.game.particles;
    if (!p) return;
    const o = this._fx;
    o.vx = vx; o.vy = vy; o.nx = nx; o.ny = ny; o.count = count; o.power = power; o.r = r; o.material = ''; o.color = '';
    p.spawn(kind, x, y, o);
  }

  /** Sound volume by distance to the player (0 beyond `range`). */
  _near(x, y, range) {
    const p = this.game.player;
    if (!p) return 1;
    const d = Math.hypot(p.x - x, p.y - y);
    return d >= range ? 0 : 1 - d / range;
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    this.time += dt;
    this._tick = (this._tick + 1) | 0;
    const p = this.game.player;
    this._updateSuns(dt, p);
    this._updateBlackHoles(p);
    this._updateStorm(dt, p);
    this._updateCycles();
    this._applyLasersVents(dt, p);
    this._updateTurrets(dt, p);
    this._updateBolts(dt, p);
    this._manageAsteroids(p);
    this._updateAsteroids(dt, p);
    this._updateCharges(dt);
    for (const e of this.explosions) if (e.active && (e.t += dt) >= e.life) e.active = false;
    this.gravCritical = !!(p && !p.dead && p.gravMag > p.stats.thrustAccel);
  }

  _updateSuns(dt, p) {
    const F = SUNS.flare;
    const alive = p && !p.dead;
    const shield = this._has('heatshield');
    // heat on the player
    this.heatAtPlayer = alive ? this.heatAt(p.x, p.y, shield) : 0;
    this.heatLevel = Math.min(1, this.heatAtPlayer / 30);
    this.nearSun = alive ? this.sunRechargeAt(p.x, p.y) : false;
    if (this.heatAtPlayer > 0) p.damage(this.heatAtPlayer * dt, 'heat', CONTINUOUS);
    for (const s of this.suns) {
      if (alive) {
        const d = Math.hypot(p.x - s.x, p.y - s.y);
        if (d < s.coreR + p.r) p.die(s.cause);
      }
      if (s.flareState === 'idle') {
        s.nextFlare -= dt;
        if (s.nextFlare <= 0) {
          s.flareState = 'warn'; s.flareT = 0;
          const v = this._near(s.x, s.y, s.heatR * 1.8);
          if (v > 0) this._sound('flare_warn', v);
        }
      } else if (s.flareState === 'warn') {
        s.flareT += dt;
        if (s.flareT >= F.warn) {
          s.flareState = 'ring'; s.flareT = 0; s.ringR = s.coreR; s.ringHit = false;
          const v = this._near(s.x, s.y, s.ringMaxR);
          if (v > 0) this._sound('flare', v);
        }
      } else {
        s.flareT += dt;
        const prev = s.ringR;
        s.ringR += F.speed * dt;
        if (alive && !s.ringHit && !p.dead) {
          const d = Math.hypot(p.x - s.x, p.y - s.y);
          if (d >= prev - F.halfWidth - p.r && d <= s.ringR + F.halfWidth + p.r) {
            s.ringHit = true;
            if (!raycast(this.game.world, s.x, s.y, p.x, p.y, this._ray)) {
              p.damage(F.damage * (shield ? F.shieldMul : 1), s.cause);
              if (this.game.camera) this.game.camera.shake(3, 0.3);
            } else {
              this._particles('shelter', this._ray.x, this._ray.y, 0, 0, 8, 1, 0, (s.x - p.x) / d, (s.y - p.y) / d);
            }
          }
        }
        if (s.ringR >= s.ringMaxR) {
          s.flareState = 'idle'; s.flareT = 0; s.ringR = 0;
          s.nextFlare = F.intervalMin + this._rnd() * (F.intervalMax - F.intervalMin);
        }
      }
    }
  }

  _updateBlackHoles(p) {
    let prox = 0;
    for (const b of this.blackHoles) {
      if (!p) break;
      const d = Math.hypot(p.x - b.x, p.y - b.y);
      if (!p.dead && d < b.horizon + p.r * 0.5) p.die(b.cause);
      const k = 1 - (d - b.horizon) / (BLACK_HOLES.proximityR - b.horizon);
      if (k > prox) prox = Math.min(1, k);
    }
    this.bhProximity = prox;
  }

  _updateStorm(dt, p) {
    if (!p) { this.stormIntensity = 0; this.inStorm = false; return; }
    const dx = p.x - CENTER, dy = p.y - CENTER;
    const d = Math.hypot(dx, dy);
    this.stormIntensity = Math.max(0, Math.min(1, (d - (BOUNDARY.r - BOUNDARY.band)) / (2 * BOUNDARY.band)));
    this.inStorm = d > BOUNDARY.r;
    if (this.inStorm && !p.dead) {
      p.damage(BOUNDARY.damage * dt, 'storm', CONTINUOUS);
      p.vx -= (dx / d) * BOUNDARY.push * dt;
      p.vy -= (dy / d) * BOUNDARY.push * dt;
    }
  }

  _updateCycles(silent = false) {
    const L = HAZARDS.laser, V = HAZARDS.vent;
    for (const l of this.lasers) {
      const t = (this.time + l.phase) % LASER_PERIOD;
      const st = cyclePhase(t, L.off, L.warn);
      if (st === 'on' && l.state !== 'on' && !silent) {
        const v = this._near((l.x0 + l.x1) / 2, (l.y0 + l.y1) / 2, 260);
        if (v > 0) this._sound('laser_on', v);
      }
      l.state = st; l.t = t;
      l.stateT = st === 'off' ? t / L.off : st === 'warn' ? (t - L.off) / L.warn : (t - L.off - L.warn) / L.on;
    }
    for (const v of this.vents) {
      const t = (this.time + v.phase) % VENT_PERIOD;
      const st = cyclePhase(t, V.off, V.warn);
      if (st === 'on' && v.state !== 'on' && !silent) {
        const vol = this._near(v.x, v.y, 300);
        if (vol > 0) this._sound('vent', vol);
      }
      v.state = st; v.t = t;
      v.stateT = st === 'off' ? t / V.off : st === 'warn' ? (t - V.off) / V.warn : (t - V.off - V.warn) / V.on;
    }
  }

  /** Is (x, y) inside the jet of vent v (with a margin)? */
  _inJet(v, x, y, margin) {
    const rx = x - v.x, ry = y - v.y;
    const along = rx * v.dirX + ry * v.dirY;
    const across = Math.abs(rx * v.dirY - ry * v.dirX);
    return along >= -margin && along <= v.length && across <= v.halfWidth + margin;
  }

  _applyLasersVents(dt, p) {
    const L = HAZARDS.laser, V = HAZARDS.vent;
    for (const v of this.vents) {
      if (v.state === 'on') {
        if ((this._tick & 1) === 0) this._particles('gas', v.x, v.y, v.dirX * 180, v.dirY * 180, 2, 1, v.halfWidth, v.dirX, v.dirY);
        if (p && !p.dead && this._inJet(v, p.x, p.y, p.r)) { p.vx += v.dirX * V.force * dt; p.vy += v.dirY * V.force * dt; }
        for (const c of this.charges) {
          if (c.active && this._inJet(v, c.x, c.y, c.r)) { c.vx += v.dirX * V.force * dt; c.vy += v.dirY * V.force * dt; }
        }
      } else if (v.state === 'warn' && (this._tick % 6) === 0) {
        this._particles('gas_warn', v.x, v.y, v.dirX * 40, v.dirY * 40, 1, 0.4, v.halfWidth, v.dirX, v.dirY);
      }
    }
    if (!p || p.dead) return;
    for (const l of this.lasers) {
      if (l.state !== 'on') continue;
      const d = distToSegment(p.x, p.y, l.x0, l.y0, l.x1, l.y1);
      if (d > L.halfWidth + p.r) continue;
      if (p.damage(L.damage, 'laser')) {
        // push out of the beam, perpendicular to it
        const s = l.vertical ? Math.sign(p.x - l.x0) || 1 : Math.sign(p.y - l.y0) || 1;
        if (l.vertical) { p.vx = 0; p.impulse(s * L.push, 0); } else { p.vy = 0; p.impulse(0, s * L.push); }
        this._particles('spark', p.x, p.y, 0, 0, 10, 1, 0, l.vertical ? s : 0, l.vertical ? 0 : s);
      }
    }
  }

  _updateTurrets(dt, p) {
    const T = HAZARDS.turret;
    const world = this.game.world;
    const alive = p && !p.dead;
    for (const t of this.turrets) {
      if (!t.alive) { t.deadT += dt; continue; }
      if (alive) collideCircles(p, t, PLAYER.restitution); // the turret body is solid
      t.cooldown -= dt; t.stateT += dt;
      if (--t.losT <= 0) {
        t.losT = T.losEvery;
        t.sees = false;
        if (alive) {
          const d = Math.hypot(p.x - t.x, p.y - t.y);
          t.sees = d < T.range && !raycast(world, t.x, t.y, p.x, p.y);
        }
      }
      if (t.sees && alive) {
        const target = Math.atan2(p.y - t.y, p.x - t.x);
        t.angle = angleTo(t.angle, target, T.turnRate * dt);
        let diff = target - t.angle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        if (t.state === 'scan' && t.cooldown <= 0 && Math.abs(diff) < T.aimTolerance) {
          t.state = 'aim'; t.stateT = 0;
          this._sound('turret_lock', this._near(t.x, t.y, T.range * 1.5));
        }
      } else {
        t.angle += T.scanSpeed * t.scanDir * dt;
        if (t.state === 'aim') { t.state = 'scan'; t.stateT = 0; }
      }
      t.telegraph = t.state === 'aim' ? Math.min(1, t.stateT / T.telegraph) : 0;
      if (t.state === 'aim' && t.stateT >= T.telegraph) {
        this._fireBolt(t);
        t.state = 'scan'; t.stateT = 0; t.cooldown = T.cooldown;
      }
    }
  }

  _fireBolt(t) {
    const T = HAZARDS.turret;
    for (const b of this.bolts) {
      if (b.active) continue;
      const cx = Math.cos(t.angle), cy = Math.sin(t.angle);
      b.active = true;
      b.x = t.x + cx * (T.bodyR + 2); b.y = t.y + cy * (T.bodyR + 2);
      b.prevX = b.x; b.prevY = b.y;
      b.vx = cx * T.boltSpeed; b.vy = cy * T.boltSpeed;
      b.angle = t.angle; b.life = T.boltLife;
      this._sound('turret_fire', this._near(t.x, t.y, T.range * 1.6));
      this._particles('muzzle', b.x, b.y, b.vx, b.vy, 3, 1);
      return;
    }
  }

  _updateBolts(dt, p) {
    const T = HAZARDS.turret;
    const world = this.game.world;
    for (const b of this.bolts) {
      if (!b.active) continue;
      b.prevX = b.x; b.prevY = b.y;
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.life -= dt;
      if (b.life <= 0) { b.active = false; continue; }
      if (world.isSolidAt(b.x, b.y)) {
        b.active = false;
        this._particles('spark', b.prevX, b.prevY, 0, 0, 5, 0.6, 0, -b.vx / T.boltSpeed, -b.vy / T.boltSpeed);
        continue;
      }
      if (p && !p.dead) {
        const dx = p.x - b.x, dy = p.y - b.y, rr = p.r + T.boltR;
        if (dx * dx + dy * dy < rr * rr) {
          b.active = false;
          if (p.damage(T.boltDamage, 'turret')) p.impulse(b.vx * 0.4, b.vy * 0.4);
          this._sound('bolt_hit');
          this._particles('spark', b.x, b.y, 0, 0, 8, 1, 0, -b.vx / T.boltSpeed, -b.vy / T.boltSpeed);
        }
      }
    }
  }

  // ------------------------------------------------------------------ asteroids

  spawnAsteroid(mode, x, y, vx, vy, size) {
    for (const a of this.asteroids) {
      if (a.active) continue;
      a.active = true; a.mode = mode;
      a.x = x; a.y = y; a.prevX = x; a.prevY = y; a.vx = vx; a.vy = vy;
      a.size = size; a.r = ASTEROIDS.radius[size]; a.m = ASTEROIDS.mass[size];
      a.angle = this._rnd() * Math.PI * 2;
      a.spin = (this._rnd() * 2 - 1) * ASTEROIDS.spin * (1.3 - size * 0.3);
      a.variant = (this._rnd() * 4) | 0;
      a.hitCd = 0;
      a.blast = 0;
      a.speedMul = 0.75 + this._rnd() * 0.5;
      return a;
    }
    return null;
  }

  _rollSize() {
    const w = ASTEROIDS.sizeWeights;
    const r = this._rnd();
    return r < w[0] ? 0 : r < w[0] + w[1] ? 1 : 2;
  }

  /** Keep the belt / spiral populated around the player, recycle far asteroids. */
  _manageAsteroids(p) {
    if (!p) return;
    const A = ASTEROIDS;
    let belt = 0, spiral = 0;
    for (const a of this.asteroids) {
      if (!a.active) continue;
      const d2 = (a.x - p.x) * (a.x - p.x) + (a.y - p.y) * (a.y - p.y);
      if (d2 > A.recycleDist * A.recycleDist) { a.active = false; continue; }
      if (a.mode === MODE_BELT) belt++; else if (a.mode === MODE_SPIRAL) spiral++;
    }
    // belt target: density × window area × fraction of the window inside the annulus (every 30 ticks)
    if (this._tick % 30 === 1) {
      let inside = 0;
      const rin2 = BELT.rInner * BELT.rInner, rout2 = BELT.rOuter * BELT.rOuter;
      for (let i = 0; i < DISC_N; i++) {
        const x = p.x + DISC[i * 2] * A.windowR - CENTER, y = p.y + DISC[i * 2 + 1] * A.windowR - CENTER;
        const d2 = x * x + y * y;
        if (d2 >= rin2 && d2 <= rout2) inside++;
      }
      this.beltTarget = Math.round(BELT.density * Math.PI * A.windowR * A.windowR * (inside / DISC_N));
      const m = this.blackHoles[0];
      this.spiralTarget = m && Math.hypot(p.x - m.x, p.y - m.y) < A.spiral.windowR ? A.spiral.count : 0;
    }
    if (belt < this.beltTarget) this._trySpawnBelt(p);
    if (spiral < this.spiralTarget) this._trySpawnSpiral(p);
  }

  _trySpawnBelt(p) {
    const A = ASTEROIDS;
    for (let k = 0; k < 6; k++) {
      const a = this._rnd() * Math.PI * 2;
      const d = A.spawnMinDist + this._rnd() * (A.windowR - A.spawnMinDist);
      const x = p.x + Math.cos(a) * d, y = p.y + Math.sin(a) * d;
      const dx = x - CENTER, dy = y - CENTER;
      const r = Math.hypot(dx, dy);
      if (r < BELT.rInner || r > BELT.rOuter) continue;
      const size = this._rollSize();
      if (this.game.world.circleSolid(x, y, A.radius[size] + 2)) continue;
      const sp = BELT.orbitSpeed;
      this.spawnAsteroid(MODE_BELT, x, y, (dy / r) * sp, (-dx / r) * sp, size);
      return;
    }
  }

  _trySpawnSpiral(p) {
    const A = ASTEROIDS, S = A.spiral;
    const m = this.blackHoles[0];
    for (let k = 0; k < 6; k++) {
      const a = this._rnd() * Math.PI * 2;
      const r = S.rMin + this._rnd() * (S.rMax - S.rMin);
      const x = m.x + Math.cos(a) * r, y = m.y + Math.sin(a) * r;
      if (Math.hypot(x - p.x, y - p.y) < A.spawnMinDist) continue;
      const size = this._rollSize();
      if (this.game.world.circleSolid(x, y, A.radius[size] + 2)) continue;
      this.spawnAsteroid(MODE_SPIRAL, x, y, 0, 0, size);
      return;
    }
  }

  _updateAsteroids(dt, p) {
    const A = ASTEROIDS;
    const world = this.game.world;
    const steer = 1 - Math.exp(-A.steer * dt);
    const m = this.blackHoles[0];
    for (const a of this.asteroids) {
      if (!a.active) continue;
      a.prevX = a.x; a.prevY = a.y;
      a.hitCd -= dt;
      a.angle += a.spin * dt;
      if (a.mode === MODE_BELT) {
        const dx = a.x - CENTER, dy = a.y - CENTER;
        const r = Math.hypot(dx, dy) || 1;
        const sp = BELT.orbitSpeed * a.speedMul;
        let tvx = (dy / r) * sp, tvy = (-dx / r) * sp;
        const radial = r < BELT.rInner + 40 ? 12 : r > BELT.rOuter - 40 ? -12 : 0;
        tvx += (dx / r) * radial; tvy += (dy / r) * radial;
        a.vx += (tvx - a.vx) * steer; a.vy += (tvy - a.vy) * steer;
      } else if (a.mode === MODE_SPIRAL && m) {
        const dx = a.x - m.x, dy = a.y - m.y;
        const r = Math.hypot(dx, dy) || 1;
        if (r < m.horizon + a.r) { a.active = false; continue; }
        const tan = A.spiral.tangential * a.speedMul * Math.min(2, 400 / r);
        const tvx = (dy / r) * tan - (dx / r) * A.spiral.inward;
        const tvy = (-dx / r) * tan - (dy / r) * A.spiral.inward;
        a.vx += (tvx - a.vx) * steer; a.vy += (tvy - a.vy) * steer;
      } else {
        // free fragments feel real gravity (and fall into black holes)
        const gv = this.gravityAt(a.x, a.y, this._g);
        a.vx += gv.ax * dt; a.vy += gv.ay * dt;
        for (const b of this.blackHoles) if (Math.hypot(a.x - b.x, a.y - b.y) < b.horizon + a.r) a.active = false;
        if (!a.active) continue;
      }
      moveCircle(a, dt, world, this._res);
      if (p && !p.dead) {
        const n = collideCircles(p, a, A.restitution);
        if (n > 0 && a.hitCd <= 0) {
          a.hitCd = A.hitCooldown;
          const nx = (a.x - p.x) / (p.r + a.r), ny = (a.y - p.y) / (p.r + a.r);
          if (n > PLAYER.impactSafeSpeed) {
            p.damage((n - PLAYER.impactSafeSpeed) * PLAYER.impactDamage * A.damageMul, 'impact');
            this._sound('impact', Math.min(1, n / 300), 1, 'rock');
            this._particles('spark', p.x + nx * p.r, p.y + ny * p.r, 0, 0, 8, n / 200, 0, -nx, -ny);
            if (n > PLAYER.impactShake) {
              if (this.game.camera) this.game.camera.shake(Math.min(6, n / 60), 0.25);
              if (this.game.hitStop) this.game.hitStop(HIT_STOP.impact);
            }
          } else if (n > 25) {
            this._sound('bump', Math.min(1, n / PLAYER.impactSafeSpeed), 1, 'rock');
          }
        }
      }
      for (const c of this.charges) if (c.active) collideCircles(c, a, 0.5);
    }
  }

  /** Split an asteroid hit by an explosion at (ex, ey): L -> 2 M, M -> 2 S, S -> salvage. */
  _split(a, ex, ey, blastId) {
    const A = ASTEROIDS;
    const x = a.x, y = a.y, vx = a.vx, vy = a.vy, size = a.size;
    a.active = false;
    this._particles('rock', x, y, vx, vy, 6 + size * 5, 1, a.r);
    this._sound('rock_break', this._near(x, y, 400), 1.2 - size * 0.2, 'rock');
    if (size === 0) {
      const ent = this.game.entities;
      const v = ECONOMY.asteroidSalvage;
      if (ent) ent.spawnSalvage(x, y, v[0] + ((this._rnd() * (v[1] - v[0] + 1)) | 0));
      return;
    }
    let dx = x - ex, dy = y - ey;
    const d = Math.hypot(dx, dy) || 1;
    dx /= d; dy /= d;
    const px = -dy, py = dx;
    const off = A.radius[size - 1] + 1;
    for (let s = -1; s <= 1; s += 2) {
      const c = this.spawnAsteroid(MODE_FREE, x + px * off * s, y + py * off * s,
        vx + (px * s + dx * 0.6) * A.splitSpeed, vy + (py * s + dy * 0.6) * A.splitSpeed, size - 1);
      if (c) c.blast = blastId; // the blast that split the parent spares its halves
    }
  }

  // ------------------------------------------------------------------ charges & explosions

  dropCharge(x, y, vx, vy) {
    for (const c of this.charges) {
      if (c.active) continue;
      c.active = true;
      c.x = x; c.y = y; c.prevX = x; c.prevY = y; c.vx = vx; c.vy = vy;
      c.fuse = HAZARDS.charge.fuse; c.fuseMax = HAZARDS.charge.fuse; c.beepT = 0;
      this._sound('charge_drop');
      return true;
    }
    return false;
  }

  _updateCharges(dt) {
    const C = HAZARDS.charge;
    const world = this.game.world;
    for (const c of this.charges) {
      if (!c.active) continue;
      c.prevX = c.x; c.prevY = c.y;
      const gv = this.gravityAt(c.x, c.y, this._g);
      c.vx += gv.ax * dt; c.vy += gv.ay * dt;
      moveCircle(c, dt, world, this._res);
      if (this._res.impact > 40) this._sound('charge_bounce', Math.min(1, this._res.impact / 200));
      c.fuse -= dt;
      c.beepT -= dt;
      if (c.beepT <= 0) {
        c.beepT = c.fuse < 1 ? C.beepEvery / 2 : C.beepEvery;
        this._sound('charge_beep', this._near(c.x, c.y, 500), c.fuse < 1 ? 1.4 : 1);
      }
      if (c.fuse <= 0) {
        c.active = false;
        this.explode(c.x, c.y, C.blastR, C.power, 'self');
      }
    }
  }

  explode(x, y, r, power, cause) {
    const g = this.game;
    const C = HAZARDS.charge;
    const broken = g.world.blast(x, y, r);
    if (g.tileBroken) for (const b of broken) g.tileBroken(b.tx, b.ty, b.id, cause);
    const p = g.player;
    if (p && !p.dead) {
      const dx = p.x - x, dy = p.y - y;
      const d = Math.hypot(dx, dy);
      if (d < r + p.r) p.damage(power * (1 - d / (r + p.r)), cause);
      const pushR = C.pushR * (r / C.blastR);
      if (d < pushR) {
        const k = C.push * (1 - d / pushR);
        const nx = d > 0 ? dx / d : 0, ny = d > 0 ? dy / d : -1;
        p.impulse(nx * k, ny * k);
      }
    }
    for (const t of this.turrets) {
      if (!t.alive) continue;
      if (Math.hypot(t.x - x, t.y - y) < r + t.r) {
        t.alive = false; t.deadT = 0; t.state = 'scan'; t.telegraph = 0;
        this._sound('turret_destroyed');
        this._particles('debris', t.x, t.y, 0, 0, 14, 1, t.r);
      }
    }
    const blastId = ++this._blastSeq;
    for (const a of this.asteroids) {
      if (a.active && a.blast !== blastId && Math.hypot(a.x - x, a.y - y) < r + a.r) this._split(a, x, y, blastId);
    }
    for (const c of this.charges) {
      if (c.active && Math.hypot(c.x - x, c.y - y) < r) c.fuse = Math.min(c.fuse, 0.12);
    }
    if (g.entities) g.entities.blastPush(x, y, r * 1.6, C.push * 0.6);
    let slot = this.explosions[0];
    for (const e of this.explosions) { if (!e.active) { slot = e; break; } if (e.t > slot.t) slot = e; }
    slot.active = true; slot.x = x; slot.y = y; slot.r = r; slot.power = power; slot.t = 0; slot.life = HAZARDS.explosionLife;
    this._sound('explosion', Math.max(0.25, this._near(x, y, 700)));
    this._particles('explosion', x, y, 0, 0, 30, power / C.power, r);
    if (g.camera) g.camera.shake(7 * Math.max(0.3, this._near(x, y, 500)), 0.4);
    if (g.hitStop && this._near(x, y, 300) > 0) g.hitStop(HIT_STOP.explosion);
    return broken.length;
  }
}

const CONTINUOUS = { continuous: true };
