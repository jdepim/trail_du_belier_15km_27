// DÉRIVE — central tuning constants (DESIGN.md is the contract, this file is the source of truth
// for every number). Units: world pixels, px/s, px/s², seconds. Positions of the macro layout are
// given relative to the sector centre (rx, ry) and also as absolute world pixels (x, y).
//
// Exports: FIXED_DT, MAX_FRAME_DT, TILE, WORLD_TILES, WORLD_PX, CENTER, CHUNK, VIEW, CAMERA, TOUCH,
//   HIT_STOP, SAVE_KEY, ZONES, ZONE_ID, POIS, POI_BY_KEY, PLAYER, GRAVITY, SUNS, BLACK_HOLES, MOON,
//   BELT, ASTEROIDS, BOUNDARY, HAZARDS, PICKUPS, ECONOMY, FOG, INTERACT
// Upgrade costs / effects live in meta.js (like Gouffre).

// ---------------------------------------------------------------- loop
export const FIXED_DT = 1 / 60;
export const MAX_FRAME_DT = 0.25;

// ---------------------------------------------------------------- world grid (§3.1)
export const TILE = 8;                       // px
export const WORLD_TILES = 1280;             // tiles per side
export const WORLD_PX = TILE * WORLD_TILES;  // 10240 px
export const CENTER = WORLD_PX / 2;          // 5120: sector centre, both axes
export const CHUNK = 32;                     // render cache chunk size (tiles)

// ---------------------------------------------------------------- presentation tuning
export const VIEW = { targetHeight: 250 };   // integer scale = max(1, floor(deviceH / 250))
export const CAMERA = {
  lookAhead: 70,          // px, max offset in the direction of the velocity
  lookAheadVel: 0.45,     // offset = velocity × this (s), clamped to lookAhead
  lookAheadRate: 2.5,     // 1/s easing of the look-ahead offset
  smoothing: 7,           // 1/s exponential follow rate
};
export const TOUCH = {
  stickRadius: 48,        // CSS px
  deadZone: 0.18,         // stick fraction ignored
  fullTilt: 0.85,         // stick fraction that gives full thrust
  buttonSize: 64,         // CSS px diameter
  buttonHitPad: 12,       // extra CSS px around buttons for hit testing
};
/** Hit-stop durations (s) the simulation requests through game.hitStop(s). */
export const HIT_STOP = { impact: 0.05, explosion: 0.06, death: 0.1 };
export const SAVE_KEY = 'derive.save.v1';

// ---------------------------------------------------------------- zones (world.interior values)
// sheltered: the hull insulates against sun heat (SUNS.shelteredMul); dark: interior darkness layer.
export const ZONES = [
  { key: 'space', name: '', sheltered: false, dark: false },
  { key: 'albatros', name: "Épave de l'Albatros", sheltered: true, dark: true },
  { key: 'colibri', name: 'Navette Colibri', sheltered: true, dark: true },
  { key: 'orion', name: 'Station Orion', sheltered: true, dark: true },
  { key: 'helios', name: 'Observatoire Hélios', sheltered: true, dark: true },
  { key: 'ulysse', name: 'Plateforme Ulysse', sheltered: false, dark: false },
  { key: 'mistral', name: 'Cargo Mistral', sheltered: true, dark: true },
  { key: 'tycho', name: 'Base Tycho', sheltered: true, dark: true },
];
export const ZONE_ID = {};
ZONES.forEach((z, i) => { z.id = i; ZONE_ID[z.key] = i; });

// ---------------------------------------------------------------- macro layout (§3.2, fixed)
// kind drives the radar / map icon (icon = sprite name the presentation draws).
// radar: shown by the edge-of-screen radar once discovered or in radar range.
const P = (key, name, kind, rx, ry, icon, extra = {}) => ({ key, name, kind, rx, ry, x: CENTER + rx, y: CENTER + ry, icon, radar: true, ...extra });
export const POIS = [
  P('albatros', "Épave de l'Albatros", 'base', 0, 0, 'poi_home', { always: true, label: '⌂' }),
  P('colibri', 'Navette Colibri', 'shuttle', 1450, -950, 'poi_shuttle'),
  P('orion', 'Station Orion', 'station', 3000, 1100, 'poi_station'),
  P('selene', 'Lune Séléné', 'moon', -2900, 500, 'poi_moon'),
  P('tycho', 'Base Tycho', 'gallery', -2460, 500, 'poi_gallery', { radar: false }),
  P('twins', 'Les Jumelles', 'suns', 400, 3350, 'poi_sun', { radar: false }),
  P('helios', 'Observatoire Hélios', 'observatory', 400, 3350, 'poi_observatory'),
  P('maelstrom', 'Le Maelström', 'blackhole', -300, -3500, 'poi_blackhole'),
  P('charybde', 'Charybde', 'blackhole', 1000, -3950, 'poi_blackhole'),
  P('ulysse', 'Module Ulysse', 'capsule', -300, -3164, 'poi_capsule'),
  P('mistral', 'Cargo Mistral', 'wreck', -3300, -2600, 'poi_wreck'),
  P('sat1', 'Satellite relais 1', 'satellite', -1500, -1700, 'poi_satellite'),
  P('sat2', 'Satellite relais 2', 'satellite', 2300, -2200, 'poi_satellite'),
  P('sat3', 'Satellite relais 3', 'satellite', 3900, -300, 'poi_satellite'),
  P('sat4', 'Satellite relais 4', 'satellite', 2200, 2800, 'poi_satellite'),
  P('sat5', 'Satellite relais 5', 'satellite', -2100, 2600, 'poi_satellite'),
  P('sat6', 'Satellite relais 6', 'satellite', -3600, -1500, 'poi_satellite'),
];
export const POI_BY_KEY = {};
for (const p of POIS) POI_BY_KEY[p.key] = p;

// ---------------------------------------------------------------- player (§4)
export const PLAYER = {
  radius: 5,
  thrustAccel: 170,       // px/s² at full stick (base, before Propulseurs)
  cruiseSpeed: 140,       // thrust cannot push the speed above this (base)
  hardMaxSpeed: 420,      // absolute cap (gravity / boost / explosions)
  turnRate: 12,           // rad/s toward the thrust direction
  thrustMin: 0.05,        // stick norm below this = no thrust
  cruiseFlame: 0.25,      // throttle shown (flame, sound) while the cruise rule absorbs the thrust
  assistDrag: 0.35,       // 1/s damping with Assistance inertielle, no stick, no brake
  brakeDecel: 260,        // px/s² opposed to the velocity
  boostImpulse: 170,      // px/s added in the stick (or facing) direction
  boostCooldown: 1.2,
  boostFuel: 22,
  fuelThrust: 6,          // u/s at full stick
  fuelBrake: 12,          // u/s
  rechargeDelay: 1.5,     // s without thrust / brake before the solar recharge starts
  rechargeRate: 3,        // u/s (base, × Réservoir de carburant)
  sunRechargeMul: 3,      // near a sun (SUNS.rechargeRMul × heatR)
  maxHull: 100,
  o2Max: 150,             // seconds of autonomy
  fuelMax: 100,
  asphyxiaDamage: 12,     // hull/s once the O2 is empty
  o2LowFrac: 0.25,        // HUD alarm below this fraction
  restitution: 0.35,      // bounce on tiles
  friction: 0.12,         // tangential speed fraction lost per tile impact
  impactSafeSpeed: 95,    // normal speed above which an impact hurts
  impactDamage: 0.3,      // hull per px/s above the safe speed
  impactShake: 140,       // impacts faster than this shake the camera + hit-stop
  iframes: 0.6,
  hurtFlash: 0.25,        // s of player.hurtT after a hit (sprite flash)
  magnetR: 24,            // base pickup attraction radius
  maxCharges: 3,
  deathDrift: 0.6,        // 1/s damping of the drifting corpse
};

// ---------------------------------------------------------------- gravity (§6.1)
// a = mu / max(r, rSoft)² toward the source (mu = G·M); inside rSoft the pull falls
// linearly to 0 at the centre (uniform sphere). Each source only acts within its
// influence radius, faded smoothly from fadeStart × influence to influence.
export const GRAVITY = {
  fadeStart: 0.75,
};

// ---------------------------------------------------------------- suns (§6.2)
// Heat (hull/s, per sun): heatMax × ((heatR − d) / (heatR − coreR))^heatExp for coreR < d < heatR.
// The two suns add up. × shieldMul with the Bouclier thermique, × shelteredMul inside an
// insulated structure (ZONES[].sheltered). Tuned against the thermal criterion of §6.4
// (tests/unit/progression.test.mjs, tools/solver.mjs).
export const SUNS = {
  list: [
    { key: 'helios_a', name: 'Hélios A', rx: 100, ry: 3350, cause: 'sun_a' },
    { key: 'helios_b', name: 'Hélios B', rx: 700, ry: 3350, cause: 'sun_b' },
  ],
  coreR: 70,
  heatR: 650,
  mu: 5.4e6,              // 60 px/s² at 300 px
  influence: 1000,
  heatMax: 840,
  heatExp: 2,
  shieldMul: 0.06,        // DESIGN target × 0.1: × 0.06 keeps a cruise-speed shielded approach to Hélios near 40 hull
  shelteredMul: 0.01,
  rechargeRMul: 1.15,     // fuel recharge × PLAYER.sunRechargeMul within this × heatR
  flare: {
    intervalMin: 12, intervalMax: 20,
    firstDelayMin: 4, firstDelayMax: 12,
    warn: 1.5,            // s of pulsing before the ring leaves the core
    speed: 500,           // px/s ring expansion
    maxRMul: 1.5,         // ring dies at maxRMul × heatR
    halfWidth: 12,        // px, ring thickness / 2 for the hit test
    damage: 25,
    shieldMul: 0.2,
  },
};

// ---------------------------------------------------------------- black holes (§6.1)
export const BLACK_HOLES = {
  list: [
    // mu: 175 px/s² at 600 px (≈ base thrust); 545 px/s² at the capsule hatch (340 px), more than
    // the fully upgraded thrust (272) + brake (260). With the Ancre (× anchorMul): 136 < 170.
    { key: 'maelstrom', name: 'Le Maelström', rx: -300, ry: -3500, horizon: 40, mu: 63e6, influence: 1600, diskR: 130, cause: 'bh_maelstrom' },
    { key: 'charybde', name: 'Charybde', rx: 1000, ry: -3950, horizon: 24, mu: 21e6, influence: 950, diskR: 75, cause: 'bh_charybde' },
  ],
  anchorMul: 0.25,
  proximityR: 900,        // hazards.bhProximity ramps 0 → 1 from here to the horizon (rumble)
};

// ---------------------------------------------------------------- moon (§3.2)
export const MOON = {
  key: 'selene', name: 'Séléné', rx: -2900, ry: 500,
  r: 440,
  mu: 4.84e6,             // 25 px/s² at the surface
  influence: 1300,
  edgeBump: 2.6,          // tiles of noise on the rim
  dustDepth: 2,           // rim tiles drawn as moon_dust
  craterScale: 0.09,      // noise frequency (1/tile) of the crater texture
  craterThreshold: 0.7,
};

// ---------------------------------------------------------------- belt (§3.2)
export const BELT = {
  rInner: 1900, rOuter: 2350,
  clusters: 26,
  clusterR: [3, 9],       // tiles
  iceChance: 0.25,
  smallChance: 0.35,      // chance a cluster is made of fragile asteroid_small
  keepOut: 220,           // px of clearance around structures / satellites
  orbitSpeed: 30,         // px/s tangential (counter-clockwise on screen)
  density: 1 / 60000,     // moving asteroids per px² of belt inside the window
};

// ---------------------------------------------------------------- moving asteroids (§6.3)
export const ASTEROIDS = {
  pool: 64,
  radius: [6, 11, 18],    // S, M, L
  sizeWeights: [0.45, 0.35, 0.2],
  mass: [1.4, 5, 13],     // player mass = 1
  windowR: 1000,          // spawn window around the player
  spawnMinDist: 520,      // never spawn closer (off-screen)
  recycleDist: 1250,
  steer: 0.6,             // 1/s: velocity eased back toward the orbit / spiral flow
  spin: 1.6,              // rad/s max
  restitution: 0.6,
  hitCooldown: 0.4,       // s between two damaging hits of the same asteroid
  damageMul: 1,           // × PLAYER impact formula on the relative normal speed
  splitSpeed: 60,         // px/s given to the halves of a split asteroid
  spiral: {               // around the Maelström
    rMin: 260, rMax: 1150,
    tangential: 75,       // px/s
    inward: 16,           // px/s
    count: 14,
    windowR: 1600,        // active while the player is this close to the hole
  },
};

// ---------------------------------------------------------------- sector boundary (§3.1)
export const BOUNDARY = {
  r: 4900,
  damage: 8,              // hull/s beyond r
  push: 60,               // px/s² toward the centre beyond r
  band: 300,              // stormIntensity ramps over [r − band, r + band]
};

// ---------------------------------------------------------------- station / gallery hazards
export const HAZARDS = {
  turret: {
    range: 190, bodyR: 6, turnRate: 2.4, aimTolerance: 0.12, scanSpeed: 0.7,
    telegraph: 0.7, cooldown: 1.8, boltSpeed: 110, boltLife: 3.2, boltR: 3, boltDamage: 14,
    losEvery: 6,          // ticks between line-of-sight checks
  },
  bolts: 32,
  laser: { off: 1.6, warn: 0.6, on: 1.4, damage: 40, halfWidth: 2.5, push: 150 },
  vent: { off: 2.2, warn: 0.7, on: 1.6, force: 480, length: 88, halfWidth: 12 },
  charge: {
    pool: 6, fuse: 2.5, r: 3, restitution: 0.5, beepEvery: 0.5,
    blastR: 40, power: 45, pushR: 64, push: 300,
  },
  explosions: 8,          // FX records kept in hazards.explosions
  explosionLife: 0.6,
};

// ---------------------------------------------------------------- pickups
export const PICKUPS = {
  pool: 160,
  r: 3,
  magnetSpeed: 240,       // px/s once attracted
  magnetAccel: 900,
  collectR: 4,            // + player radius
  sleepDist: 1400,        // no update farther than this from the player
  burstSpeed: 70,
  burstMagnetR: 120,      // burst salvage homes in from this far once burstMagnetDelay has passed
  burstMagnetDelay: 0.45,
  drag: 1.2,              // 1/s on loose pickups
  debrisFields: [
    { poi: 'albatros', rMin: 180, rMax: 720, count: 30 },
    { poi: 'colibri', rMin: 150, rMax: 420, count: 18 },
    { poi: 'mistral', rMin: 190, rMax: 480, count: 24 },
    { poi: 'orion', rMin: 330, rMax: 560, count: 12 },
  ],
};

// ---------------------------------------------------------------- economy (§7)
export const ECONOMY = {
  debrisValue: [1, 3],
  crateValue: [8, 15],
  mistralCrateValue: [8, 12],   // 15 crates: ~150 salvage in the Mistral
  cacheValue: [6, 10],    // '$' salvage caches in the plans (one-time)
  satelliteSalvage: 15,
  logSalvage: 5,
  asteroidSalvage: [2, 6],
  o2Pickup: 40,           // s
  fuelPickup: 50,         // u
  repairPickup: 30,       // hull
  dock: { hull: 40, o2: 60, fuel: 80 }, // refill per second inside the dock
};

// ---------------------------------------------------------------- map fog (§7)
export const FOG = {
  cell: 64,               // px
  size: 160,              // cells per side (WORLD_PX / cell)
  revealR: 260,           // around the player
  satelliteR: 1600,
  poiRevealR: 64,         // a POI counts as discovered once the fog is lifted this close to it
};

// ---------------------------------------------------------------- interactions
export const INTERACT = {
  range: 24,              // px from the player centre to an interactable point
  doorRange: 30,
  satelliteRange: 30,
  itemRange: 12,          // key items are taken by touching their pad
};
