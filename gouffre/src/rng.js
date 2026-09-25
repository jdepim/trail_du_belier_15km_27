// Seeded randomness: mulberry32 PRNG, integer hashing and 2D value noise.
// Everything procedural (worldgen, tile variants, art) must go through here so a
// given seed always produces the exact same result.

/** mulberry32: tiny, fast, good-enough 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string to an unsigned 32-bit integer. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stateless integer hash of (x, y, seed) -> uint32. */
export function hash2(x, y, seed = 0) {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Normalise any seed input (number or string) to a uint32. */
export function normalizeSeed(seed) {
  if (typeof seed === 'string') {
    const n = Number(seed);
    return Number.isFinite(n) && seed.trim() !== '' ? (n >>> 0) : hashString(seed);
  }
  if (!Number.isFinite(seed)) return 0;
  return Math.floor(seed) >>> 0;
}

/** Convenience RNG object around mulberry32. */
export function createRng(seed) {
  const s = normalizeSeed(seed);
  const next = mulberry32(s);
  const rng = {
    seed: s,
    next,
    /** float in [a, b) */
    float(a = 0, b = 1) { return a + (b - a) * next(); },
    /** integer in [a, b] inclusive */
    int(a, b) { return a + Math.floor(next() * (b - a + 1)); },
    chance(p) { return next() < p; },
    pick(arr) { return arr[Math.floor(next() * arr.length)]; },
    sign() { return next() < 0.5 ? -1 : 1; },
    /** pick a key from a { key: weight } map */
    weighted(map) {
      let total = 0;
      for (const k in map) total += map[k];
      let r = next() * total;
      for (const k in map) {
        r -= map[k];
        if (r < 0) return k;
      }
      return Object.keys(map)[0];
    },
    shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    },
    /** derive an independent child RNG (stable for a given label) */
    fork(label) { return createRng((s ^ hashString(String(label))) >>> 0); },
  };
  return rng;
}

/**
 * 2D value noise in [0, 1): random values on an integer lattice, smoothly
 * interpolated (smootherstep). Deterministic for a given seed.
 */
export function createNoise2D(seed) {
  const s = normalizeSeed(seed);
  const lattice = (ix, iy) => hash2(ix, iy, s) / 4294967296;
  return function noise(x, y) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = lattice(x0, y0), b = lattice(x0 + 1, y0);
    const c = lattice(x0, y0 + 1), d = lattice(x0 + 1, y0 + 1);
    const top = a + (b - a) * u;
    const bot = c + (d - c) * u;
    return top + (bot - top) * v;
  };
}

/** Fractal sum of value noise, normalised back to [0, 1). */
export function fbm2D(noise, x, y, octaves = 3, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise(x * freq, y * freq) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
