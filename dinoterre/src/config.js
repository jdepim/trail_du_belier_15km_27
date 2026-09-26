// Global tuning constants. Anything species-, creature- or building-specific lives in src/data/.

export const TILE = 8;                 // pixels per tile (internal resolution)
export const WORLD_W = 1400;           // tiles
export const WORLD_H = 110;            // tiles
export const SURFACE_BASE = 62;        // average ground row in the plains
export const WATER_LEVEL = 66;         // every air cell at or below this row fills with water
export const SPAWN_TX = Math.floor(WORLD_W / 2);

export const VIEW_H = 190;             // target internal height in pixels (the canvas is upscaled)
export const STEP = 1 / 60;            // fixed simulation step (s)
export const MAX_STEPS = 5;

export const PHYS = {
  gravity: 900,          // px/s²
  maxFall: 420,
  waterGravity: 0.18,    // gravity multiplier in water
  waterDrag: 4.5,        // velocity damping per second in water
  groundAccel: 900,
  airAccel: 520,
  groundFriction: 1100,
  coyote: 0.1,
  jumpBuffer: 0.12,
  jumpCut: 0.45,         // vy multiplier when jump is released early
  stepUp: TILE,          // auto step-up height on flat ground (1 tile)
};

export const SURVIVAL = {
  hungerMax: 100,
  hungerDrain: 100 / 420,  // per second before species metabolism (≈7 min from full)
  starveDamage: 1 / 3,     // hp per second when starving
  regenHunger: 50,         // above this hunger, hp regenerates
  regenRate: 1 / 4,        // hp per second
  staminaMax: 100,
  staminaRegen: 30,        // per second when not climbing
  staminaRegrip: 20,       // stamina needed to grab a wall again after exhaustion
  drownDamage: 1,          // hp per second without breath
  breathRefill: 4,         // breath seconds regained per second at the surface
  deathLoss: 0.5,          // share of carried resources lost on death
};

export const DAY = {
  length: 360,             // seconds for a full day/night cycle
  nightStart: 0.62,        // fraction of the cycle where night begins
  nightEnd: 0.95,
};

export const PACK = {
  baseCapacity: 3,          // allies without nests
  followDist: 22,           // px behind the player
  teleportDist: 26 * TILE,  // ally teleports back if further than this
  huntRange: 11 * TILE,     // hunters engage enemies within this radius of the player
  gatherRange: 22 * TILE,   // gatherers look for loot within this radius of the player
};

export const SPAWN = {
  zone: 32,                // tiles per spawn zone
  radiusZones: 2,          // active zones on each side of the player
  despawnZones: 4,
  interval: 1.5,           // seconds between spawner passes
  carcassLife: 120,        // seconds before an unharvested carcass rots away
  safeRadius: 18,          // tiles around the world spawn with no hostile spawns
};

export const SAVE_KEY = 'dinoterre.save.v1';
export const AUTOSAVE = 20; // seconds
