// Tile type registry (DESIGN.md §3.3).
// Each type: { id, key, name, solid, fragile, floor, door, window, breaksTo, light, lightColor,
//              sound, colors, deco }
//   solid    : blocks the player, asteroids, bolts, charges and flares (raycasts)
//   fragile  : destroyed by explosions (world.blast); becomes TILE_ID[breaksTo.toUpperCase()]
//   floor    : non-solid interior floor drawn under the player (inside a zone)
//   door     : 'keycard' for a locked door, 'open' for an opened one
//   window   : solid but see-through (the renderer shows space behind it)
//   light    : emitted light 0..1 for the interior darkness layer, lightColor [r, g, b]
//   sound    : impact material for audio ('metal' | 'rock' | 'ice' | 'glass')
//   colors   : 4-colour ramp [darkest, dark, mid, light] used by textures and particles
//   deco     : non-solid decoration drawn over a floor (panels, lights)
// Lookup tables for hot loops: SOLID, FRAGILE, FLOOR, LIGHT (Uint8Array / Float32Array(256)).
// API: TILES[id], TILE_ID.KEY, TILE_BY_KEY[key], tileDef(id), isSolidId(id), TILE_COUNT.

const DEFS = [
  // key            name                       solid  extra
  ['space',        'Vide',                    false, { colors: ['#000000', '#000000', '#000000', '#000000'] }],
  ['hull',         'Coque',                   true,  { colors: ['#1c2330', '#3a4658', '#5d6d84', '#8fa0b8'], sound: 'metal' }],
  ['hull_dark',    'Coque sombre',            true,  { colors: ['#10141c', '#232a36', '#384254', '#56627a'], sound: 'metal' }],
  ['window',       'Hublot',                  true,  { colors: ['#0e2433', '#1f5670', '#4fa3c4', '#b8ecff'], sound: 'glass', window: true }],
  ['floor',        'Plancher',                false, { colors: ['#161a22', '#222834', '#2e3544', '#3c4556'], floor: true }],
  ['grate',        'Caillebotis',             false, { colors: ['#12151b', '#1f242e', '#2c3340', '#46505f'], floor: true }],
  ['wreck',        'Coque tordue',            true,  { colors: ['#1d1512', '#44302a', '#6e4d3f', '#9c7a62'], sound: 'metal' }],
  ['shuttle',      'Coque de navette',        true,  { colors: ['#3a3f48', '#8a929e', '#c6ccd4', '#f1f3f6'], sound: 'metal' }],
  ['moon_rock',    'Roche lunaire',           true,  { colors: ['#1f1e24', '#3b3a42', '#5a5862', '#807d88'], sound: 'rock' }],
  ['moon_crater',  'Cratère',                 true,  { colors: ['#17161b', '#2c2b32', '#44424b', '#66636d'], sound: 'rock' }],
  ['moon_dust',    'Régolithe',               true,  { colors: ['#2b2a30', '#4d4b54', '#75727d', '#a3a0aa'], sound: 'rock' }],
  ['moon_floor',   'Sol de galerie',          false, { colors: ['#121116', '#1c1b21', '#26252c', '#33313a'], floor: true }],
  ['rubble',       'Éboulis',                 true,  { colors: ['#2a241f', '#4f463d', '#76695a', '#a39280'], sound: 'rock', fragile: true, breaksTo: 'moon_floor' }],
  ['asteroid',     'Astéroïde',               true,  { colors: ['#1d1814', '#3d332a', '#5e4f41', '#86725e'], sound: 'rock' }],
  ['asteroid_small', 'Petit astéroïde',       true,  { colors: ['#221c17', '#473b30', '#6b5a49', '#937d66'], sound: 'rock', fragile: true, breaksTo: 'space' }],
  ['ice',          'Glace',                   true,  { colors: ['#15303f', '#2f6c8a', '#6fb6d6', '#d4f3ff'], sound: 'ice' }],
  ['door_locked',  'Porte verrouillée',       true,  { colors: ['#2a1a10', '#7a4a12', '#d08a1c', '#ffd36a'], sound: 'metal', door: 'keycard', light: 0.25, lightColor: [255, 170, 60] }],
  ['door_open',    'Porte ouverte',           false, { colors: ['#10141c', '#1f2a36', '#2e5a44', '#5fd08a'], floor: true, door: 'open', light: 0.2, lightColor: [90, 230, 140] }],
  ['pad',          "Socle d'équipement",      false, { colors: ['#10202a', '#1d4050', '#2f7a90', '#7fe6ff'], floor: true, light: 0.45, lightColor: [110, 220, 255] }],
  ['panel',        'Console',                 false, { colors: ['#0c1a1a', '#1a3b3b', '#2f7070', '#7fe0d0'], floor: true, deco: true, light: 0.3, lightColor: [90, 230, 210] }],
  ['light',        'Plafonnier',              false, { colors: ['#2a2a1a', '#6a6a3a', '#d8d890', '#fffff0'], floor: true, deco: true, light: 0.8, lightColor: [255, 240, 200] }],
  ['solar_panel',  'Panneau solaire',         true,  { colors: ['#0d1330', '#1e2f6e', '#3656b8', '#8fb0ff'], sound: 'glass' }],
  ['plating',      'Plateforme',              false, { colors: ['#1a1d22', '#2c3139', '#434a55', '#6b7482'], floor: true }],
  ['emitter',      'Émetteur laser',          true,  { colors: ['#1a0c0c', '#4a1616', '#a02828', '#ff6a5a'], sound: 'metal', light: 0.35, lightColor: [255, 70, 60] }],
  ['vent',         'Évent de gaz',            true,  { colors: ['#1a1a12', '#3a3a24', '#6a6a3c', '#b8b870'], sound: 'rock' }],
  ['hazard_floor', 'Plancher balisé',         false, { colors: ['#1a1608', '#3a300c', '#8a6e10', '#f0c030'], floor: true }],
];

/** TILES[id] -> definition */
export const TILES = [];
/** TILE_ID.KEY -> id (keys upper-cased: TILE_ID.HULL, TILE_ID.DOOR_LOCKED...) */
export const TILE_ID = {};
/** key -> definition */
export const TILE_BY_KEY = {};

DEFS.forEach(([key, name, solid, extra], id) => {
  const def = {
    id, key, name, solid,
    fragile: false, floor: false, door: null, window: false, breaksTo: null,
    light: 0, lightColor: [255, 220, 170], sound: 'metal', deco: false,
    ...extra,
  };
  TILES[id] = def;
  TILE_ID[key.toUpperCase()] = id;
  TILE_BY_KEY[key] = def;
});
for (const def of TILES) def.breaksToId = def.breaksTo ? TILE_ID[def.breaksTo.toUpperCase()] : 0;

export const TILE_COUNT = TILES.length;

// Flat lookup tables for hot loops (physics, raycasts, rendering).
export const SOLID = new Uint8Array(256);
export const FRAGILE = new Uint8Array(256);
export const FLOOR = new Uint8Array(256);
export const LIGHT = new Float32Array(256);
for (const def of TILES) {
  SOLID[def.id] = def.solid ? 1 : 0;
  FRAGILE[def.id] = def.fragile ? 1 : 0;
  FLOOR[def.id] = def.floor ? 1 : 0;
  LIGHT[def.id] = def.light;
}
// Out-of-range ids behave like hull (never happens with a valid world).
for (let i = TILE_COUNT; i < 256; i++) SOLID[i] = 1;

export function tileDef(id) { return TILES[id] || TILES[TILE_ID.HULL]; }
export function isSolidId(id) { return SOLID[id] === 1; }
