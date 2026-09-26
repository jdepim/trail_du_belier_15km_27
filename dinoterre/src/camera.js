// Smoothed follow camera with screen shake.
import { TILE } from './config.js';
import { clamp } from './rng.js';

export class Camera {
  constructor() { this.x = 0; this.y = 0; this.shakeT = 0; this.shakeA = 0; this.ox = 0; this.oy = 0; }
  shake(a) { this.shakeA = Math.max(this.shakeA, a); this.shakeT = 0.25; }
  follow(p, W, H, world, dt, snap = false) {
    const tx = p.cx + p.facing * 18 - W / 2;
    const ty = p.cy - H * 0.55;
    const k = snap ? 1 : 1 - Math.exp(-dt * 6);
    this.x += (tx - this.x) * k;
    this.y += (ty - this.y) * k;
    this.x = clamp(this.x, 0, world.w * TILE - W);
    this.y = clamp(this.y, 0, world.h * TILE - H);
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      this.ox = (Math.random() - 0.5) * 2 * this.shakeA; this.oy = (Math.random() - 0.5) * 2 * this.shakeA;
      if (this.shakeT <= 0) this.shakeA = 0;
    } else { this.ox = this.oy = 0; }
  }
}
