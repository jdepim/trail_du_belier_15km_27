// GOUFFRE — central tuning constants.
// Every gameplay / balance number lives here so it can be tweaked in one place.
// Units: pixels, pixels per second, seconds (see DESIGN.md §1).

// ---------------------------------------------------------------- world grid
export const TILE = 16;
export const WORLD_W = 72;
export const WORLD_H = 300;
export const SURFACE_Y = 14;          // first ground row; rows above are sky
export const CHUNK = 16;              // render cache chunk size in tiles
export const BEDROCK_COLS = 2;        // columns 0-1 and W-2..W-1
export const BEDROCK_ROWS = 12;       // rows H-12..H-1
export const DEEPEST_ROW = WORLD_H - BEDROCK_ROWS - 1; // 287, last diggable row
export const TILE_REGEN_DELAY = 3;    // s before unfinished tile damage heals

// ---------------------------------------------------------------- loop
export const FIXED_DT = 1 / 60;
export const MAX_FRAME_DT = 0.25;

// ---------------------------------------------------------------- rendering
export const BASE_VIEW_H = 216;       // target internal height in pixels (§9)

// ---------------------------------------------------------------- layers
// d = depth in metres = tileY - SURFACE_Y. The table in DESIGN.md lists the Heart as
// d 260-287, but bedrock starts at row 288 (d = 274), so the Heart is d 260-273.
export const LAYERS = [
  {
    index: 0, key: 'soil', name: 'Terre meuble', title: 'LA TERRE MEUBLE',
    d0: 0, d1: 39, ores: ['coal', 'copper'],
    enemies: { slime: 0.6, bat: 0.4 }, spawnCount: 11, chestCount: 2,
    caveAir: 0.40, ambientTint: '#0b0806',
  },
  {
    index: 1, key: 'catacombs', name: 'Catacombes', title: 'LES CATACOMBES',
    d0: 40, d1: 99, ores: ['iron', 'silver'],
    enemies: { skeleton: 0.45, bat: 0.3, slime: 0.25 }, spawnCount: 16, chestCount: 2,
    caveAir: 0.42, ambientTint: '#07060a',
  },
  {
    index: 2, key: 'crystal', name: 'Grottes cristallines', title: 'LES GROTTES CRISTALLINES',
    d0: 100, d1: 179, ores: ['gold', 'amethyst'],
    enemies: { spider: 0.4, ghost: 0.3, bat: 0.3 }, spawnCount: 18, chestCount: 3,
    caveAir: 0.455, ambientTint: '#04070b',
  },
  {
    index: 3, key: 'abyss', name: 'Abysse ardente', title: "L'ABYSSE ARDENTE",
    d0: 180, d1: 259, ores: ['ruby', 'mithril'],
    enemies: { imp: 0.4, golem: 0.3, ghost: 0.3 }, spawnCount: 18, chestCount: 3,
    caveAir: 0.47, ambientTint: '#0b0403',
  },
  {
    index: 4, key: 'heart', name: 'Le Cœur', title: 'LE CŒUR',
    d0: 260, d1: DEEPEST_ROW - SURFACE_Y, ores: [],
    enemies: { guardian: 1 }, spawnCount: 1, chestCount: 0,
    caveAir: 0.0, ambientTint: '#0a0306',
  },
];

/** Layer object for a depth in metres (clamped). */
export function layerAtDepth(d) {
  if (d < LAYERS[1].d0) return LAYERS[0];
  if (d < LAYERS[2].d0) return LAYERS[1];
  if (d < LAYERS[3].d0) return LAYERS[2];
  if (d < LAYERS[4].d0) return LAYERS[3];
  return LAYERS[4];
}

export function depthOfRow(ty) { return Math.max(0, ty - SURFACE_Y); }

// ---------------------------------------------------------------- player (§4)
export const PLAYER = {
  w: 10, h: 22,
  maxHp: 60,
  maxSpeed: 95,
  accelGround: 1150,       // px/s² toward target speed while input held
  frictionGround: 1500,    // px/s² braking with no input
  turnBoost: 1.6,          // accel multiplier when reversing direction
  accelAir: 760,
  dragAir: 260,            // air braking with no input
  overspeedDrag: 170,      // air decay of speed above maxSpeed (keeps swing momentum)
  gravity: 950,
  maxFall: 380,
  jumpHeightTiles: 3.2,
  jumpCut: 0.45,           // vy multiplier when jump is released early
  apexGravityMul: 0.62,    // gentler gravity near apex while jump held
  apexThreshold: 45,       // |vy| below which apex gravity applies
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  cornerCorrection: 4,     // px of ceiling corner slide
  // pickaxe
  attackCooldown: 0.28,
  attackBuffer: 0.15,      // a tap during the cooldown fires when it ends
  strikeAnim: 0.22,
  pickDamage: 1,
  pickTier: 0,
  reachSide: 10,           // px beyond the hitbox edge
  reachUp: 8,
  reachDown: 6,
  // damage
  iframes: 1.0,
  hurtStun: 0.22,
  knockbackX: 150,
  knockbackY: 170,
  armor: 0,                // flat % damage reduction (0..0.8)
  // lava
  lavaDamage: 14,
  lavaBounce: 300,
  // misc
  lanternRadius: 6.5,      // tiles
  bagCapacity: 10,
  holeAssistSpeed: 70,     // px/s slide toward a 1-wide hole under the feet
  landDustSpeed: 230,
};

// Jump launch speed derived from the requested height: v = sqrt(2 g h)
PLAYER.jumpVel = Math.sqrt(2 * PLAYER.gravity * PLAYER.jumpHeightTiles * TILE);

// ---------------------------------------------------------------- grapple (§5)
export const GRAPPLE = {
  range: 96,               // base max range in px (upgradable to ~220)
  maxRange: 220,
  hookSpeed: 650,
  retractSpeed: 950,
  reelSpeed: 130,          // px/s (upgradable)
  minLength: 14,
  neutralAngleDeg: 70,     // neutral aim: up and slightly forward
  assistOffsetsDeg: [12, -12, 24, -24],
  swingAccel: 430,         // px/s² tangential push from left/right
  maxSwingSpeed: 360,
  releaseBoost: 210,       // extra upward speed on jump-release
  releaseMaxUp: 430,
  releaseVxMul: 1.12,
  releaseMaxVx: 300,
  originOffsetY: 7,        // rope attaches this far below the hitbox top
  payOutMul: 1.15,         // max rope length = range × this (or the attach length if longer)
  maxCorrection: 6,        // px: largest positional rope correction per tick (no teleports)
  damping: 0.0015,         // per-tick velocity damping while swinging
};

// ---------------------------------------------------------------- camera
export const CAMERA = {
  lookAheadX: 26,
  lookAheadRate: 3.2,      // 1/s for lookahead easing
  lookVelX: 0.12,
  lookDownMax: 56,
  lookUpMax: 30,
  lookVelY: 0.2,
  offsetY: 10,             // keep a bit more view below the player
  followX: 7.5,
  followY: 6.5,
  followYFast: 12,
  anchorLook: 0.45,        // fraction of the player->anchor distance to look toward
  anchorLookMax: 64,
};

// ---------------------------------------------------------------- lighting
export const LIGHT = {
  margin: 7,               // tiles computed beyond view (off-screen sources)
  skyLight: 0.92,
  emitFalloff: 1 / 6.5,    // per tile for emissive/sky light
  solidFalloff: 0.42,      // per tile when leaving a solid tile
  surfaceAmbient: 0.9,
  undergroundAmbient: 0.14,// ambient right below the surface, fades with depth
  ambientFade: 0.022,      // per metre
  minDark: 0.80,           // max darkness right below surface
  maxDark: 0.955,          // max darkness at the bottom
  darkColor: [5, 3, 11],
  glowAlpha: 0.42,
  lanternFlicker: 0.25,
};

// ---------------------------------------------------------------- touch (§8)
export const TOUCH = {
  stickRadius: 44,         // CSS px
  deadZone: 0.22,
  fullTilt: 0.6,           // stick fraction that gives full speed
  buttonSize: 66,          // CSS px diameter
  buttonHitPad: 12,        // extra CSS px around buttons for hit testing
};

// ---------------------------------------------------------------- enemies (§6)
export const ENEMY_SCALING = { hpPerM: 1 / 60, dmgPerM: 1 / 80, ngPlusMul: 1.5 };

// Spawn placement rules (tile footprint + anchoring) used by worldgen.
export const ENEMY_SPAWN_RULES = {
  slime: { anchor: 'floor', w: 1, h: 1 },
  bat: { anchor: 'ceiling', w: 1, h: 1 },
  skeleton: { anchor: 'floor', w: 1, h: 2 },
  spider: { anchor: 'ceiling', w: 1, h: 1 },
  ghost: { anchor: 'air', w: 2, h: 2 },
  imp: { anchor: 'air', w: 2, h: 2 },
  golem: { anchor: 'floor', w: 2, h: 2 },
  guardian: { anchor: 'floor', w: 4, h: 4 },
};

// ---------------------------------------------------------------- world generation
export const WORLDGEN = {
  campFlatX0: 15, campFlatX1: 56,        // flat, cave-free camp ground
  shaftX0: 35, shaftX1: 37, shaftDepth: 7, // pre-dug entry shaft (tile columns / rows)
  forgeX0: 22, forgeX1: 29,              // Forge building footprint (tile columns)
  spawnTx: 32,
  beamY: SURFACE_Y - 5, beamX0: 34, beamX1: 38, // headframe crossbeam above the shaft
  caveStartDepth: 7,
  campCaveFreeDepth: 12,
  caIterations: 5,
  caveNoiseAmp: 0.28,
  wormsPerLayer: [3, 3, 4, 4],
  rooms: { min: 5, max: 7, wMin: 9, wMax: 16, hMin: 5, hMax: 7 },
  geodes: { min: 4, max: 6 },
  lavaLakes: { min: 5, max: 8 },
  lavaPoolChance: 0.04,
  lavaPoolMax: 40,
  lifeCrystals: 6,
  ores: {
    coal: { d0: 2, d1: 39, veins: 18, size: [3, 6] },
    copper: { d0: 10, d1: 39, veins: 11, size: [2, 5] },
    iron: { d0: 40, d1: 99, veins: 14, size: [3, 5] },
    silver: { d0: 58, d1: 99, veins: 8, size: [2, 4] },
    gold: { d0: 100, d1: 179, veins: 13, size: [2, 5] },
    amethyst: { d0: 115, d1: 179, veins: 8, size: [2, 4] },
    ruby: { d0: 180, d1: 259, veins: 11, size: [2, 4] },
    mithril: { d0: 205, d1: 259, veins: 7, size: [1, 3] },
  },
  minOreTiles: 8,
  spawnSpacing: 5,
  chestSpacing: 9,
  minSpawnDepth: 9,
  relicChestChance: 0.35,
  // Boss arena (outer box incl. 2-thick walls/ceiling); interior is x0+2..x1-2, y0+2..y1-1
  arena: { x0: 4, x1: 67, y0: SURFACE_Y + 260, y1: DEEPEST_ROW },
};

// ---------------------------------------------------------------- misc
export const PARTICLE_MAX = 800;
export const HIT_STOP = { enemy: 0.05, tile: 0.018, hurt: 0.07 };
export const SAVE_KEY = 'gouffre.save.v1';
export const MUTE_KEY = 'gouffre.muted';
