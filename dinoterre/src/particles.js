// Tiny pixel particles (dust, blood, splashes…) and floating texts.

const KINDS = {
  dust: { colors: ['#c8b08a', '#a08a6a'], life: 0.5, vx: 40, vy: [-50, -10], g: 120 },
  blood: { colors: ['#c0283a', '#8a1a28'], life: 0.6, vx: 70, vy: [-110, -30], g: 500 },
  splash: { colors: ['#d8f0ff', '#8ac8e8'], life: 0.6, vx: 50, vy: [-140, -60], g: 520 },
  bubble: { colors: ['#d8f0ff'], life: 1.2, vx: 6, vy: [-30, -18], g: -10 },
  crumb: { colors: ['#f07080', '#c8384a'], life: 0.5, vx: 30, vy: [-60, -20], g: 400 },
  smoke: { colors: ['#9a9aa4', '#c8c8d0'], life: 1.4, vx: 8, vy: [-26, -12], g: -4 },
  heart: { colors: ['#ff7aa8', '#ffb0c8'], life: 1.1, vx: 18, vy: [-40, -20], g: -20, size: 2 },
  spark: { colors: ['#ffe070', '#ffa030'], life: 0.7, vx: 12, vy: [-50, -20], g: -30 },
};

export class Particles {
  constructor() { this.list = []; this.floats = []; }

  spawn(kind, x, y, { n = 4 } = {}) {
    const k = KINDS[kind];
    if (!k) return;
    for (let i = 0; i < n && this.list.length < 400; i++) {
      this.list.push({
        x: x + (Math.random() - 0.5) * 4, y: y + (Math.random() - 0.5) * 3,
        vx: (Math.random() - 0.5) * 2 * k.vx, vy: k.vy[0] + Math.random() * (k.vy[1] - k.vy[0]),
        g: k.g, life: k.life * (0.6 + Math.random() * 0.6), max: k.life,
        color: k.colors[(Math.random() * k.colors.length) | 0], size: k.size || 1,
      });
    }
  }

  float(text, x, y, color = '#fff') {
    this.floats.push({ text, x, y, t: 0, color });
    if (this.floats.length > 24) this.floats.shift();
  }

  update(dt) {
    for (const p of this.list) {
      p.life -= dt;
      p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.list = this.list.filter((p) => p.life > 0);
    for (const f of this.floats) { f.t += dt; f.y -= 14 * dt; }
    this.floats = this.floats.filter((f) => f.t < 1.3);
  }
}
