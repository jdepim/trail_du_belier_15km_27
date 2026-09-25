// Grappling hook (DESIGN.md §5): travelling hook, aim assist, rope pendulum.
//
// States: 'idle' -> 'flying' -> 'attached' | 'retracting' -> 'idle'.
// The rope is a distance constraint |origin - anchor| <= length solved by
//   1. velocity projection before the move (drop the outward radial component,
//      add reel-in pull, add tangential swing push), then
//   2. a collision-aware positional correction after the move.
// Both steps go through moveAndCollide so the rope can never pull the player
// through a wall; if a wall blocks the correction the rope pays out instead of
// accumulating tension (no jitter, no snapping).
import { GRAPPLE } from './config.js';
import { moveAndCollide, raycast } from './physics.js';

const DEG = Math.PI / 180;

// ------------------------------------------------------------------ pure helpers (unit tested)

/**
 * Remove the outward radial velocity of a point at (px,py) tied to (ax,ay) by a
 * rope of length len. Returns the new velocity in `out`.
 */
export function ropeConstrainVelocity(vx, vy, px, py, ax, ay, len, out = { vx: 0, vy: 0 }) {
  out.vx = vx; out.vy = vy;
  const rx = px - ax, ry = py - ay;
  const dist = Math.hypot(rx, ry);
  if (dist < 1e-6 || dist < len - 0.5) return out;
  const nx = rx / dist, ny = ry / dist;
  const radial = vx * nx + vy * ny;
  if (radial > 0) { out.vx = vx - radial * nx; out.vy = vy - radial * ny; }
  return out;
}

/** Displacement that brings (px,py) back within len of (ax,ay); zero if slack. */
export function ropeCorrection(px, py, ax, ay, len, out = { dx: 0, dy: 0 }) {
  const rx = px - ax, ry = py - ay;
  const dist = Math.hypot(rx, ry);
  out.dx = 0; out.dy = 0;
  if (dist <= len || dist < 1e-6) return out;
  const k = (dist - len) / dist;
  out.dx = -rx * k; out.dy = -ry * k;
  return out;
}

/**
 * Cast the grapple ray at `angle` (radians, screen space: y down). If it misses,
 * try the assist offsets and keep the hit closest to the wanted angle.
 * @returns {{angle:number, hit:object|null}}
 */
export function aimAssist(world, ox, oy, angle, range, offsetsDeg = GRAPPLE.assistOffsetsDeg) {
  const direct = raycast(world, ox, oy, Math.cos(angle), Math.sin(angle), range);
  if (direct) return { angle, hit: direct };
  let best = null, bestAngle = angle, bestOff = Infinity;
  for (const off of offsetsDeg) {
    const a = angle + off * DEG;
    const hit = raycast(world, ox, oy, Math.cos(a), Math.sin(a), range);
    if (!hit) continue;
    const ao = Math.abs(off);
    if (ao < bestOff || (ao === bestOff && hit.dist < best.dist)) { best = hit; bestAngle = a; bestOff = ao; }
  }
  return { angle: bestAngle, hit: best };
}

// ------------------------------------------------------------------ Grapple

export class Grapple {
  constructor(game, player) {
    this.game = game;
    this.player = player;
    this._tmpBody = { x: 0, y: 0, w: 0, h: 0, vx: 0, vy: 0 };
    this._res = { onGround: false, hitCeiling: false, hitLeft: false, hitRight: false };
    this._corr = { dx: 0, dy: 0 };
    this.reset();
  }

  reset() {
    this.state = 'idle';
    this.hookX = 0; this.hookY = 0; this.prevHookX = 0; this.prevHookY = 0;
    this.dirX = 0; this.dirY = -1;
    this.travelled = 0;
    this.anchorX = 0; this.anchorY = 0; this.anchorTx = 0; this.anchorTy = 0;
    this.length = 0;
    this.maxLength = 0;
    this.predicted = null;
    this.predictedAngle = 0;
    this.attachTime = 0;
    this.refireT = 0;      // > 0: a climb hop is under way, the hook re-fires at its top
    this.attaches = 0;     // hooks that caught something (onboarding / stuck detection)
  }

  get attached() { return this.state === 'attached'; }
  get range() { return this.player.stats.grappleRange; }

  /** Rope attachment point on the player (upper body). */
  originX(p = this.player) { return p.x + p.w / 2; }
  originY(p = this.player) { return p.y + GRAPPLE.originOffsetY; }

  /** Wanted aim angle from the stick; neutral = ~70° up, toward facing. */
  aimAngle() {
    const inp = this.game.input;
    if (inp.aimActive && (inp.aimX !== 0 || inp.aimY !== 0)) return Math.atan2(inp.aimY, inp.aimX);
    const a = GRAPPLE.neutralAngleDeg * DEG;
    return Math.atan2(-Math.sin(a), this.player.facing * Math.cos(a));
  }

  /** Update the predicted anchor (for the on-screen reticle). */
  predict() {
    if (this.state !== 'idle') { this.predicted = null; return; }
    const r = aimAssist(this.game.world, this.originX(), this.originY(), this.aimAngle(), this.range);
    this.predicted = r.hit;
    this.predictedAngle = r.angle;
  }

  /**
   * Grapple button pressed: fire, climb, let go or cancel. A press while the hook is
   * still retracting re-fires at once (the old hook snaps back), so mashing Grappin
   * right after a jump-release never loses the press. While attached the press climbs
   * (hop off with the Saut boost, re-fire at the top of the hop: see wantsClimb) or,
   * during a real swing, lets go.
   */
  onPress() {
    if (this.state === 'idle' || this.state === 'retracting') { this.refireT = 0; this.fire(); }
    else if (this.state === 'attached') {
      if (this.wantsClimb()) this.climb();
      else this.release(false);
    } else if (this.state === 'flying') this.state = 'retracting';
  }

  /**
   * Does a Grappin press while attached mean "higher" rather than "let go"? Yes when
   * standing, on a short rope, holding up, or hanging almost still; a real swing (a long
   * rope with some speed) lets go, so pendulum releases work as before.
   */
  wantsClimb() {
    const p = this.player;
    if (p.onGround || this.length <= GRAPPLE.climbMaxLength || this.game.input.moveY < -0.5) return true;
    return Math.hypot(p.vx, p.vy) < GRAPPLE.climbStillSpeed;
  }

  /** Haul up: hop off the short rope (Saut boost) and re-fire the hook at the top of the hop. */
  climb() {
    if (this.state !== 'attached') return;
    const p = this.player;
    this.release(true);
    p.jumping = false;
    this.refireT = GRAPPLE.climbRefireMax;
    this.game.audio.play('jump', { pitch: 1.15 });
  }

  fire() {
    const g = this.game;
    const ox = this.originX(), oy = this.originY();
    const { angle } = aimAssist(g.world, ox, oy, this.aimAngle(), this.range);
    this.dirX = Math.cos(angle); this.dirY = Math.sin(angle);
    this.hookX = this.prevHookX = ox; this.hookY = this.prevHookY = oy;
    this.travelled = 0;
    this.state = 'flying';
    if (Math.abs(this.dirX) > 0.2) this.player.facing = this.dirX > 0 ? 1 : -1;
    g.audio.play('grapple_fire');
  }

  _attach(hit) {
    const g = this.game;
    this.state = 'attached';
    // anchor sits a hair outside the tile face so it's always in open space
    this.anchorX = hit.x - this.dirX * 0.5;
    this.anchorY = hit.y - this.dirY * 0.5;
    this.anchorTx = hit.tx; this.anchorTy = hit.ty;
    this.hookX = this.anchorX; this.hookY = this.anchorY;
    // The rope takes the real distance: the player kept moving (usually falling)
    // while the hook flew, so d can exceed the range. Clamping it here would yank
    // the player by the difference in one tick. The rope may never grow past
    // this attach length or the normal pay-out limit, whichever is larger.
    const d = Math.hypot(this.originX() - this.anchorX, this.originY() - this.anchorY);
    this.length = Math.max(GRAPPLE.minLength, d);
    this.maxLength = Math.max(this.range * GRAPPLE.payOutMul, this.length);
    this.attachTime = g.time;
    this.attaches++;
    if (g.onGrappleAttach) g.onGrappleAttach();
    g.audio.play('grapple_attach');
    g.particles.spawn('spark', this.anchorX, this.anchorY, { count: 6 });
    g.camera.shake(1.2, 0.08);
  }

  /** Let go. jump=true gives the release boost (DESIGN §5 "Saut = lâcher avec impulsion"). */
  release(jump) {
    if (this.state !== 'attached') return;
    const p = this.player;
    if (jump) {
      p.vy = Math.max(-GRAPPLE.releaseMaxUp, Math.min(p.vy, 0) - GRAPPLE.releaseBoost);
      p.vx = Math.max(-GRAPPLE.releaseMaxVx, Math.min(GRAPPLE.releaseMaxVx, p.vx * GRAPPLE.releaseVxMul));
      this.game.particles.spawn('dust', p.x + p.w / 2, p.y + p.h, { count: 3 });
    }
    this.state = 'retracting';
    this.game.audio.play('grapple_release');
  }

  /** Velocity stage of the rope constraint (called by the player before moving). */
  preMove(p, dt) {
    if (this.state !== 'attached') return;
    const inp = this.game.input;
    const reel = p.stats.reelSpeed;
    const reeling = inp.moveY < -0.5;
    if (reeling) this.length = Math.max(GRAPPLE.minLength, this.length - reel * dt);
    else if (inp.moveY > 0.5) this.length = Math.min(this.maxLength, this.length + reel * dt);

    const rx = this.originX(p) - this.anchorX, ry = this.originY(p) - this.anchorY;
    const dist = Math.hypot(rx, ry);
    if (dist < 1e-3 || dist < this.length - 0.5) return; // slack rope: free movement
    const nx = rx / dist, ny = ry / dist;
    let radial = p.vx * nx + p.vy * ny;
    if (radial > 0) { p.vx -= radial * nx; p.vy -= radial * ny; radial = 0; }
    const excess = dist - this.length;
    if (excess > 0 && reeling) {
      // reel-in: move inward at up to ~reel speed (only while reeling, so a
      // fresh catch or a tiny leftover never launches the player)
      const pull = Math.min(excess / dt, reel * 1.6);
      if (radial > -pull) { p.vx -= (radial + pull) * nx; p.vy -= (radial + pull) * ny; }
    }
    if (!p.onGround) {
      if (inp.moveX !== 0) {
        const tx = -ny, ty = nx;
        const along = inp.moveX * GRAPPLE.swingAccel * tx;
        p.vx += along * tx * dt;
        p.vy += along * ty * dt;
      }
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > GRAPPLE.maxSwingSpeed) { const k = GRAPPLE.maxSwingSpeed / sp; p.vx *= k; p.vy *= k; }
      p.vx *= 1 - GRAPPLE.damping; p.vy *= 1 - GRAPPLE.damping;
    }
  }

  /** Positional stage (called by the player after moving). */
  postMove(p, dt) {
    if (this.state !== 'attached') return;
    const ox = this.originX(p), oy = this.originY(p);
    const c = ropeCorrection(ox, oy, this.anchorX, this.anchorY, this.length, this._corr);
    if (c.dx === 0 && c.dy === 0) return;
    // never teleport: cap the per-tick correction, the rope pays out the rest below
    const cm = Math.hypot(c.dx, c.dy);
    if (cm > GRAPPLE.maxCorrection) { const k = GRAPPLE.maxCorrection / cm; c.dx *= k; c.dy *= k; }
    const b = this._tmpBody;
    b.x = p.x; b.y = p.y; b.w = p.w; b.h = p.h; b.vx = c.dx / dt; b.vy = c.dy / dt;
    const res = moveAndCollide(b, dt, this.game.world, this._res);
    p.x = b.x; p.y = b.y;
    if (res.onGround && p.vy > 0) p.vy = 0;
    // blocked by geometry: pay out rope rather than building tension
    const d2 = Math.hypot(this.originX(p) - this.anchorX, this.originY(p) - this.anchorY);
    if (d2 > this.length + 0.75) this.length = Math.min(d2, this.maxLength);
  }

  /** Hook flight, retraction and anchor validity. */
  update(dt) {
    const g = this.game;
    this.prevHookX = this.hookX; this.prevHookY = this.hookY;
    if (this.refireT > 0) {
      // climb hop: re-fire near its apex (or when it was cut short: ceiling, landing, hurt)
      const p = this.player;
      this.refireT -= dt;
      if (p.dead || p.hurtT > 0) this.refireT = 0;
      else if (this.state === 'attached' || this.state === 'flying') this.refireT = 0;
      else if (p.vy >= GRAPPLE.climbApexVy || this.refireT <= 0) { this.refireT = 0; this.fire(); }
    }
    if (this.state === 'attached') {
      if (!g.world.isSolid(this.anchorTx, this.anchorTy)) {
        this.state = 'retracting';
        g.audio.play('grapple_release');
      }
      return;
    }
    if (this.state === 'flying') {
      const step = (this.player.stats.hookSpeed || GRAPPLE.hookSpeed) * dt;
      const remaining = this.range - this.travelled;
      const hit = raycast(g.world, this.hookX, this.hookY, this.dirX, this.dirY, Math.min(step, remaining));
      if (hit) { this._attach(hit); return; }
      const s = Math.min(step, remaining);
      this.hookX += this.dirX * s; this.hookY += this.dirY * s;
      this.travelled += s;
      if (this.travelled >= this.range - 1e-6) this.state = 'retracting';
      return;
    }
    if (this.state === 'retracting') {
      const ox = this.originX(), oy = this.originY();
      const dx = ox - this.hookX, dy = oy - this.hookY;
      const d = Math.hypot(dx, dy);
      const step = GRAPPLE.retractSpeed * dt;
      if (d <= step + 2) { this.state = 'idle'; this.hookX = ox; this.hookY = oy; return; }
      this.hookX += (dx / d) * step; this.hookY += (dy / d) * step;
    }
  }

  /** Is the rope currently taut (used by the player for swing vs walk control)? */
  isTaut(p = this.player) {
    if (this.state !== 'attached') return false;
    const d = Math.hypot(this.originX(p) - this.anchorX, this.originY(p) - this.anchorY);
    return d >= this.length - 1;
  }
}
