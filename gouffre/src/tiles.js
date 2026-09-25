// Tile type registry (DESIGN.md §3).
// Each type: { id, key, name, solid, hp, tier, value, light, hazard, drop, colors, ... }
//   hp     : mining points (Infinity = indestructible)
//   tier   : minimum pickaxe tier, otherwise "Trop dur !" and no damage
//   value  : gold value of the ore dropped (0 for plain rock)
//   light  : emitted light intensity 0..1 (0 = none)
//   hazard : damage dealt on contact (lava)
//   drop   : what breaking it releases: null | 'ore:<key>' | 'heal'
//   colors : 4-colour ramp [darkest, dark, mid, light] (particles + textures)
// Extra fields used by the engine:
//   deco   : non-solid decorative tile drawn over the back wall
//   liquid : animated liquid (lava)
//   sound  : impact material for audio ('soft'|'stone'|'metal'|'crystal'|'bone'|'wood')
//   base   : tile key whose texture is used underneath (ores)
//   host   : tile key whose hp/tier an ore derives from (hp = host.hp + 1)

const DEFS = [
  // key            name                    solid  hp   tier value light  extra
  ['air',          'Air',                   false, 0,   0,  0,  0,    { colors: ['#000', '#000', '#000', '#000'] }],
  ['bedrock',      'Roche-mère',            true,  Infinity, 99, 0, 0, { colors: ['#050407', '#141219', '#1f1c26', '#2d2936'], sound: 'metal' }],
  ['dirt',         'Terre',                 true,  1,   0,  0,  0,    { colors: ['#2a1a12', '#46301f', '#5e4029', '#7a5536'], sound: 'soft' }],
  ['grass',        'Terre herbeuse',        true,  1,   0,  0,  0,    { colors: ['#15251a', '#2b4a2d', '#3f6a3a', '#5f8c4a'], sound: 'soft' }],
  ['clay',         'Argile',                true,  2,   0,  0,  0,    { colors: ['#3a1e17', '#6b3525', '#8a4a30', '#a8643f'], sound: 'soft' }],
  ['stone',        'Pierre',                true,  4,   0,  0,  0,    { colors: ['#1e1f28', '#3a3c4a', '#525566', '#6f7386'], sound: 'stone' }],
  ['brick',        'Briques',               true,  5,   1,  0,  0,    { colors: ['#1b1419', '#43363f', '#5c4b56', '#78646e'], sound: 'stone' }],
  ['bone',         'Ossements',             true,  3,   0,  0,  0,    { colors: ['#2a221c', '#8f8470', '#c2b89c', '#e8e0c8'], sound: 'bone' }],
  ['granite',      'Granit',                true,  8,   2,  0,  0,    { colors: ['#231c22', '#4e4049', '#6c5a62', '#8f7a80'], sound: 'stone' }],
  ['crystal_rock', 'Roche cristalline',     true,  9,   2,  0,  0,    { colors: ['#0f1a26', '#243b52', '#355a78', '#5f8fb0'], sound: 'crystal' }],
  ['basalt',       'Basalte',               true,  12,  3,  0,  0,    { colors: ['#120e0f', '#2a2324', '#3b3031', '#54403c'], sound: 'stone' }],
  ['obsidian',     'Obsidienne',            true,  16,  3,  0,  0,    { colors: ['#07050b', '#160f22', '#2a1c40', '#4d3570'], sound: 'crystal' }],
  ['arena',        'Briques du Cœur',       true,  40,  3,  0,  0,    { colors: ['#0c070e', '#23172a', '#34233c', '#4a3454'], sound: 'stone' }],
  ['beam',         'Poutre',                true,  4,   0,  0,  0,    { colors: ['#24150c', '#4f3019', '#6e4424', '#8f5c32'], sound: 'wood' }],
  ['lava',         'Lave',                  false, 0,   0,  0,  1.0,  { colors: ['#5a1405', '#c2410c', '#f97316', '#fde047'], liquid: true, hazard: 14, lightColor: [255, 120, 30] }],
  // ores: hp = host.hp + 1, tier = host.tier (computed below)
  ['coal',         'Charbon',               true,  0,   0,  1,  0,    { colors: ['#0b0b0e', '#1f1f26', '#3a3a45', '#8a8a99'], ore: true, host: 'dirt', base: 'dirt', sound: 'soft' }],
  ['copper',       'Cuivre',                true,  0,   0,  2,  0,    { colors: ['#3d1c0e', '#9a4a22', '#d0773d', '#f4b27a'], ore: true, host: 'stone', base: 'stone', sound: 'metal' }],
  ['iron',         'Fer',                   true,  0,   0,  4,  0,    { colors: ['#3a2a22', '#8a6d5a', '#bfa28c', '#e8d6c4'], ore: true, host: 'stone', base: 'stone', sound: 'metal' }],
  ['silver',       'Argent',                true,  0,   0,  7,  0.08, { colors: ['#3a3f4a', '#8c96a8', '#c8d0de', '#ffffff'], ore: true, host: 'brick', base: 'stone', sound: 'metal', lightColor: [200, 215, 255] }],
  ['gold',         'Or',                    true,  0,   0,  12, 0.12, { colors: ['#4a2e05', '#b8860b', '#eab308', '#fff3a3'], ore: true, host: 'granite', base: 'granite', sound: 'metal', lightColor: [255, 210, 80] }],
  ['amethyst',     'Améthyste',             true,  0,   0,  18, 0.4,  { colors: ['#2a0f45', '#6b2fb0', '#a45ee8', '#e3c4ff'], ore: true, host: 'crystal_rock', base: 'crystal_rock', sound: 'crystal', lightColor: [170, 90, 255] }],
  ['ruby',         'Rubis',                 true,  0,   0,  36, 0.35, { colors: ['#3d0610', '#9e1530', '#e0304e', '#ffa0b0'], ore: true, host: 'basalt', base: 'basalt', sound: 'crystal', lightColor: [255, 50, 80] }],
  ['mithril',      'Mithril',               true,  0,   0,  60, 0.45, { colors: ['#0a3a44', '#2aa3b8', '#6ee7f5', '#e0ffff'], ore: true, host: 'obsidian', base: 'obsidian', sound: 'metal', lightColor: [90, 230, 255] }],
  // specials
  ['crystal',      'Cristal',               true,  4,   2,  0,  0.75, { colors: ['#0a2a3a', '#1e7fa0', '#5fd3f0', '#d8f8ff'], sound: 'crystal', base: 'crystal_rock', lightColor: [80, 200, 255] }],
  ['life_crystal', 'Cristal de vie',        true,  3,   0,  0,  0.6,  { colors: ['#3a0a1a', '#b0204a', '#ff5a7a', '#ffd0dc'], sound: 'crystal', drop: 'heal', base: 'stone', lightColor: [255, 70, 110] }],
  // non-solid decorations (drawn over the back wall)
  ['torch',        'Torche',                false, 0,   0,  0,  0.9,  { colors: ['#3a1a08', '#c2410c', '#fb923c', '#fef08a'], deco: true, animated: true, lightColor: [255, 150, 60] }],
  ['bones_deco',   'Crâne',                 false, 0,   0,  0,  0,    { colors: ['#2a221c', '#8f8470', '#c2b89c', '#e8e0c8'], deco: true }],
  ['cobweb',       'Toile',                 false, 0,   0,  0,  0,    { colors: ['#555', '#888', '#bbb', '#ddd'], deco: true }],
  ['stalactite',   'Stalactite',            false, 0,   0,  0,  0,    { colors: ['#1e1f28', '#3a3c4a', '#525566', '#6f7386'], deco: true }],
  ['stalagmite',   'Stalagmite',            false, 0,   0,  0,  0,    { colors: ['#1e1f28', '#3a3c4a', '#525566', '#6f7386'], deco: true }],
  ['roots',        'Racines',               false, 0,   0,  0,  0,    { colors: ['#1a100a', '#3b2616', '#5a3c22', '#7a5532'], deco: true }],
  ['mushroom',     'Champignon luisant',    false, 0,   0,  0,  0.35, { colors: ['#0a2a2a', '#1a6a6a', '#3fd0c0', '#b8fff4'], deco: true, lightColor: [60, 230, 200] }],
  ['post',         'Poteau',                false, 0,   0,  0,  0,    { colors: ['#24150c', '#4f3019', '#6e4424', '#8f5c32'], deco: true }],
  // boss arena portcullis: seals the Heart's entrance while the Guardian fights
  ['gate',         'Herse du Cœur',         true,  Infinity, 99, 0, 0, { colors: ['#0c0a10', '#2c2a36', '#555868', '#9aa0b4'], sound: 'metal' }],
  // planks over the camp shaft: one strike opens the whole trapdoor, it closes again
  // behind the hero once they are back on the camp ground (main.js campTrapdoor)
  ['trapdoor',     'Trappe du puits',       true,  1,   0,  0,  0,    { colors: ['#24150c', '#5a3a1e', '#7a5028', '#a06a36'], sound: 'wood' }],
];

/** TILES[id] -> definition */
export const TILES = [];
/** TILE_ID.KEY -> id (keys upper-cased: TILE_ID.STONE, TILE_ID.LIFE_CRYSTAL...) */
export const TILE_ID = {};
/** key -> definition */
export const TILE_BY_KEY = {};

DEFS.forEach(([key, name, solid, hp, tier, value, light, extra], id) => {
  const def = {
    id, key, name, solid, hp, tier, value, light,
    hazard: 0, drop: null, colors: extra.colors,
    deco: false, liquid: false, animated: false, ore: false,
    sound: 'stone', base: null, host: null, lightColor: [255, 190, 120],
    ...extra,
  };
  if (def.liquid) def.animated = true;
  TILES[id] = def;
  TILE_ID[key.toUpperCase()] = id;
  TILE_BY_KEY[key] = def;
});

// Ores derive hp/tier from their host rock and drop themselves.
for (const def of TILES) {
  if (!def.ore) continue;
  const host = TILE_BY_KEY[def.host];
  def.hp = host.hp + 1;
  def.tier = host.tier;
  def.drop = 'ore:' + def.key;
}

export const TILE_COUNT = TILES.length;

// Flat lookup tables for hot loops (physics, lighting, rendering).
export const SOLID = new Uint8Array(256);
export const EMIT = new Float32Array(256);
export const DECO = new Uint8Array(256);
export const OPAQUE_BACK = new Uint8Array(256); // solid tiles hide the back wall
for (const def of TILES) {
  SOLID[def.id] = def.solid ? 1 : 0;
  EMIT[def.id] = def.light;
  DECO[def.id] = def.deco ? 1 : 0;
  OPAQUE_BACK[def.id] = def.solid ? 1 : 0;
}
// Out-of-range ids behave like bedrock.
for (let i = TILE_COUNT; i < 256; i++) SOLID[i] = 1;

export function tileDef(id) { return TILES[id] || TILES[TILE_ID.BEDROCK]; }
export function isSolidId(id) { return SOLID[id] === 1; }

/** All ore keys in depth order. */
export const ORE_KEYS = TILES.filter((t) => t.ore).map((t) => t.key);

/** Back-wall styles (world.back values). 0 = none (sky shows through). */
export const BACK = {
  NONE: 0, SOIL: 1, STONE: 2, BRICK: 3, GRANITE: 4, CRYSTAL: 5, BASALT: 6, ARENA: 7,
};
export const BACK_COUNT = 8;
