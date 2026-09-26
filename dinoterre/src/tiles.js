// Tile types. `solid` blocks movement, `oneway` only blocks from above, `climb` lets bodies climb
// through a non-solid tile (tree trunks), `water` makes bodies swim. Colors feed sprites.js.

export const TILE_DEFS = [
  { key: 'air' },
  { key: 'dirt', solid: true, colors: ['#7a5234', '#654229', '#8c6240'] },
  { key: 'grass', solid: true, colors: ['#7a5234', '#654229', '#8c6240'], top: ['#5caa3c', '#3f8a2c', '#86cc52'] },
  { key: 'stone', solid: true, colors: ['#7c7c88', '#63636e', '#94949e'] },
  { key: 'sand', solid: true, colors: ['#d8b870', '#c4a05c', '#e8cc88'] },
  { key: 'mud', solid: true, colors: ['#5e4a34', '#4c3a28', '#6e5a40'], top: ['#6a8a3a', '#526e2a', '#80a048'] },
  { key: 'redrock', solid: true, colors: ['#b0603e', '#964e32', '#c4744e'] },
  { key: 'bedrock', solid: true, colors: ['#34303a', '#26222c', '#443e4a'] },
  { key: 'water', water: true },
  { key: 'trunk', climb: true, colors: ['#6a4428', '#50321c', '#845a36'] },
  { key: 'leaves', oneway: true, colors: ['#3e8a3a', '#2c6e2c', '#5aa84a'] },
  { key: 'bonewall', solid: true, built: true, colors: ['#e8dfc0', '#b8ac88', '#fff8e0'] },
  { key: 'hideplat', oneway: true, built: true, colors: ['#b07a48', '#7a5030', '#d09a60'] },
];

export const TILE_ID = Object.fromEntries(TILE_DEFS.map((d, i) => [d.key, i]));

// Flat lookup tables (hot path in physics).
export const SOLID = new Uint8Array(TILE_DEFS.length);
export const ONEWAY = new Uint8Array(TILE_DEFS.length);
export const WATER = new Uint8Array(TILE_DEFS.length);
export const CLIMB = new Uint8Array(TILE_DEFS.length);
TILE_DEFS.forEach((d, i) => {
  SOLID[i] = d.solid ? 1 : 0;
  ONEWAY[i] = d.oneway ? 1 : 0;
  WATER[i] = d.water ? 1 : 0;
  CLIMB[i] = d.climb ? 1 : 0;
});
