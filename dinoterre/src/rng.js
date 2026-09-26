// Seeded random numbers and 1D value noise (deterministic world generation).

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) { this.next = mulberry32(seed); }
  float(a = 0, b = 1) { return a + (b - a) * this.next(); }
  int(a, b) { return Math.floor(this.float(a, b + 1)); }       // inclusive
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[Math.floor(this.next() * arr.length)]; }
  /** Pick from [{weight, ...}] entries. */
  weighted(entries) {
    let total = 0;
    for (const e of entries) total += e.weight;
    let r = this.next() * total;
    for (const e of entries) { r -= e.weight; if (r <= 0) return e; }
    return entries[entries.length - 1];
  }
}

/** Hash two ints to [0,1). Stable, used for per-tile visual variation. */
export function hash2(x, y, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1D value noise, octave-summed; returns roughly [-1, 1]. */
export function makeNoise1D(seed) {
  const lattice = (i, o) => hash2(i, o * 7919, seed) * 2 - 1;
  const smooth = (t) => t * t * (3 - 2 * t);
  return function noise(x, octaves = 3) {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let o = 0; o < octaves; o++) {
      const xi = Math.floor(x * freq), t = smooth(x * freq - xi);
      sum += amp * (lattice(xi, o) * (1 - t) + lattice(xi + 1, o) * t);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
export const approach = (v, target, d) => (v < target ? Math.min(v + d, target) : Math.max(v - d, target));
