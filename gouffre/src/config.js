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

// Base stats before depth scaling (hp × (1 + d/60), dmg × (1 + d/80), × 1.5 in NG+).
// w/h = hitbox px; gold = base coin value (× (1 + d × DROPS.goldPerM));
// kbResist 0..1 = fraction of the strike knockback ignored; projDmg = base projectile damage.
// Layer 1 is tuned for a new player (60 HP, 10 strike damage): bats die in one hit,
// slimes in two or three, and each hit taken costs about a tenth of the HP bar.
export const ENEMY_STATS = {
  slime: { hp: 16, dmg: 5, speed: 68, w: 12, h: 10, gold: 2, kbResist: 0 },
  bat: { hp: 8, dmg: 4, speed: 58, w: 12, h: 9, gold: 2, kbResist: 0 },
  skeleton: { hp: 22, dmg: 7, speed: 26, w: 10, h: 24, gold: 4, kbResist: 0.25, projDmg: 6 },
  spider: { hp: 18, dmg: 8, speed: 92, w: 14, h: 9, gold: 5, kbResist: 0.1 },
  ghost: { hp: 20, dmg: 7, speed: 34, w: 14, h: 18, gold: 6, kbResist: 0 },
  imp: { hp: 20, dmg: 6, speed: 64, w: 12, h: 14, gold: 7, kbResist: 0.1, projDmg: 7 },
  golem: { hp: 60, dmg: 10, speed: 20, w: 22, h: 28, gold: 12, kbResist: 0.85 },
  guardian: { hp: 150, dmg: 5, speed: 34, w: 34, h: 46, gold: 150, kbResist: 1, projDmg: 6 },
};

// Behaviour tuning (ranges in px, times in s, speeds in px/s).
export const ENEMY_AI = {
  gravity: 900,
  maxFall: 380,
  knockbackX: 170,          // strike knockback (× (1 - kbResist))
  knockbackY: 120,
  hitStun: 0.28,            // no steering / no contact damage after being struck
  killHitStop: 0.07,
  contactShrink: 2,         // px trimmed from each side of an enemy box for contact damage
  slime: { aggroX: 120, aggroY: 64, hopVx: 72, hopVy: 235, hopEvery: [0.75, 1.3], squash: 0.24 },
  bat: { wake: 76, flee: 0.55, bob: 22, bobFreq: 5.5, giveUp: 240 },
  skeleton: { sight: 150, sightY: 72, windup: 0.55, cooldown: [1.9, 2.6], boneTime: 0.95, boneGrav: 420, boneMaxV: 260 },
  spider: { hang: 6, triggerX: 18, triggerY: 150, shake: 0.28, pause: [0.35, 0.8], run: [0.9, 1.6] },
  ghost: { aggro: 170, drift: 0.9, alpha: 0.62 },
  imp: { aggro: 190, keepDist: 72, hover: 34, windup: 0.65, cooldown: [2.1, 2.9], fireSpeed: 118 },
  golem: { sightX: 150, sightY: 14, windup: 0.75, chargeSpeed: 150, chargeTime: 1.5, stun: 1.1, chargeDmgMul: 1.5 },
  projLife: 4,
};

// Off-screen respawn around the player (by the layer of the spawn tile).
export const ENEMY_SPAWNING = {
  interval: [9, 8, 7, 6],   // s between attempts, per layer of the player
  localCap: [4, 5, 6, 6],   // max non-boss enemies in the active zone, per layer
  globalCap: 72,            // live enemies in the whole mine
  minDistTiles: 9,          // never closer than this to the player
  maxDistTiles: 22,
  tries: 28,
  despawnScreens: 3.5,      // respawned enemies farther than this (view widths) are recycled
};

// Enemies update only near the camera: |dx| < rangeX × viewW, |dy| < rangeY × viewH
// from the camera centre (≈ 1.5 screens around it). Farther ones sleep.
export const ENEMY_ACTIVE = { rangeX: 1.25, rangeY: 1.5 };

// Drops (pickups are pooled, bounce and are magnetised to the player).
export const DROPS = {
  goldPerM: 1 / 60,         // coin value multiplier per metre of depth
  coinsMax: 6,              // coins per regular enemy (value split between them)
  heartChance: 0.08,
  heartChanceLow: 0.25,     // when the player is below 35 % HP
  heartHeal: 15,
  crystalHeal: 20,          // life crystal heart
  magnetRadius: 46,
  magnetDelay: 0.32,        // s before a fresh drop can be pulled
  magnetAccel: 1100,
  magnetMaxSpeed: 280,
  gravity: 720,
  bounce: 0.45,
  life: 40,                 // s before an uncollected pickup vanishes (blinks the last 3 s)
  maxPickups: 96,
};

// Le Gardien de l'Abysse (boss, DESIGN §6). Damage values are base values (depth-scaled).
export const BOSS = {
  phase2: 0.66, phase3: 0.33,   // hp fractions
  intro: 2.2,                   // s of roar before the fight (invulnerable)
  phaseTime: 1.6,               // s of transition roar (invulnerable)
  walkSpeed: [30, 40, 52],      // per phase
  attackGap: [1.5, 1.15, 0.85], // s of walking between attacks
  slamWindup: [0.9, 0.8, 0.7],
  slamRecover: 0.8,
  shockSpeed: 150,
  shockDmgMul: 1.2,
  swipeRange: 64,
  swipeWindup: 0.5,
  swipeDmgMul: 1.5,
  summonWindup: 1.0,
  maxMinions: 4,
  rainWindup: 0.9,
  rainWarn: 0.85,
  rainSpacing: 60,              // px between meteors (gaps to stand in)
  chargeWindup: 0.75,
  chargeSpeed: 230,
  chargeStun: 1.4,
  chargeDmgMul: 1.6,
  deathTime: 3.0,
  coins: 24,                    // coins dropped on death
};

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
