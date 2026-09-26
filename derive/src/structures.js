// Hand-authored level design: ASCII plans of every structure (DESIGN.md §3.2, §13).
// worldgen.js stamps them at their POI positions (plan cell `anchor` on the POI; default = the
// plan centre). One character = one 8 px tile. Rows shorter than the widest row are padded with ' '.
//
// Exports: LEGEND (char -> meaning, documentation + tests), STRUCTURES[key] =
//   { key, zone, anchor: [col, row] | null, rows: string[], items: [itemKey...] (the 'P' pads in
//     reading order), logs: [logKey...] (the 'T' terminals in reading order), crateValue: the
//     config.ECONOMY key of the crate value range [min, max] }
// planSize(key) -> { w, h }, planChar(key, col, row), planCells(key, ch) -> [[col, row]...],
// planAnchor(key) -> [col, row].
//
// Rules the plans follow (checked by tests/unit/worldgen.test.mjs):
//   - corridors and openings at least 3 tiles (24 px) wide: the player is 10 px wide and drifts;
//   - Orion is closed: its only openings are keycard doors 'D';
//   - the Tycho gallery is closed: its only opening is the rubble plug 'r' on the east face;
//   - every pad, terminal, crate and station sits on a non-solid tile reachable from an entrance.

/** Plan legend. `tile` = tile key written, `record` = worldgen record created there. */
export const LEGEND = {
  ' ': { what: 'untouched (open space, or moon rock inside the moon disk)' },
  '~': { what: 'forced open space (torn hull openings, cleared areas)', tile: 'space' },
  '.': { what: 'floor', tile: 'floor' },
  ':': { what: 'grate floor', tile: 'grate' },
  '_': { what: 'platform plating', tile: 'plating' },
  '!': { what: 'hazard-striped floor', tile: 'hazard_floor' },
  '#': { what: 'hull', tile: 'hull' },
  'H': { what: 'dark hull', tile: 'hull_dark' },
  '=': { what: 'window (solid, see-through)', tile: 'window' },
  'W': { what: 'twisted wreck hull (Albatros, Mistral)', tile: 'wreck' },
  'S': { what: 'white shuttle hull (Colibri)', tile: 'shuttle' },
  'O': { what: 'solar panel (solid)', tile: 'solar_panel' },
  'D': { what: 'keycard door; 4-connected D cells form one door record', tile: 'door_locked', record: 'doors' },
  'E': { what: 'laser emitter (solid); a straight run of l between two E is one barrier', tile: 'emitter' },
  'l': { what: 'laser beam path (floor)', tile: 'hazard_floor', record: 'lasers' },
  'U': { what: 'turret (floor + turret record)', tile: 'floor', record: 'turrets' },
  'P': { what: 'equipment pad (plan.items in reading order)', tile: 'pad', record: 'items' },
  'T': { what: 'terminal (plan.logs in reading order)', tile: 'panel', record: 'terminals' },
  'C': { what: 'salvage crate', tile: 'floor', record: 'crates' },
  'R': { what: 'refill station (O2 + fuel)', tile: 'panel', record: 'refills' },
  'L': { what: 'supply locker (explosive charges)', tile: 'panel', record: 'lockers' },
  'B': { what: 'workbench (Établi)', tile: 'panel', record: 'workbench' },
  'K': { what: 'dock floor (dock rectangle = bounding box of K and X)', tile: 'grate' },
  'X': { what: 'spawn point (inside the dock)', tile: 'grate', record: 'spawn' },
  'A': { what: 'capsule hatch (Embarquer)', tile: 'plating', record: 'capsule' },
  '*': { what: 'ceiling light', tile: 'light' },
  '%': { what: 'console (decor)', tile: 'panel' },
  'o': { what: 'O2 canister (respawns every life)', tile: 'floor', record: 'pickups' },
  'f': { what: 'fuel cell (respawns every life)', tile: 'floor', record: 'pickups' },
  '+': { what: 'repair kit (respawns every life)', tile: 'floor', record: 'pickups' },
  '$': { what: 'salvage cache (one-time, saved in save.world.taken)', tile: 'floor', record: 'caches' },
  'm': { what: 'moon rock (gallery walls)', tile: 'moon_rock' },
  ',': { what: 'gallery floor (stays open space outside the moon disk)', tile: 'moon_floor' },
  'r': { what: 'rubble plug (fragile: explosives)', tile: 'rubble' },
  'V': { what: 'gas vent (solid), blows toward its open neighbour', tile: 'vent', record: 'vents' },
};

// ------------------------------------------------------------------ Albatros (centre, base)
// Broken ship: the dock room (spawn, refill, deposit) with the workbench, the captain's terminal,
// a torn cargo room to the south-east holding a cache, three torn hull openings (W, E, S).
const ALBATROS = [
  '            WWWWWWWWWWWW',
  '        WWWWW....*.....WWWWW',
  '      WWW..%...T....%......WWW',
  '     WW.........................WW',
  '    WW...........................~~~',
  '   WW.....KKKKKKKKKKK.............~~~',
  '  ~~......KKKKKKKKKKK..........B...~~~',
  '  ~~......KKKKKKKKKKK..............~~',
  '  ~~......KKKKKXKKKKK..............W',
  '  ~~......KKKKKKKKKKK..............W',
  '   W......KKKKKKKKKKK.....WWWWWWWWWWW',
  '   WW.........................:.....WW',
  '    WW....*..........o........:....$.W',
  '     WW.......................:......W',
  '      WWW........WWWWWWWWW....W..C...W',
  '        WWWW~~~~WW       WWWWWW~~~~WWW',
  '            ~~~~              ~~~~',
];

// ------------------------------------------------------------------ Colibri (shuttle, keycard)
// Open airlock at the stern (west), cargo bay with crates, crew cabin (north), galley with the
// terminal (south), cockpit in the nose (east) holding the keycard pad behind its windows.
const COLIBRI = [
  '          SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS',
  '        SSS............SS.................SSSS',
  '      SSS....C.....C...SS.......o.........SSSSSS',
  '     SS................SS.................S....SS',
  '    SS.................SSSSSSS.....SSSSSSSS.....SS',
  '  SSS...........C..........................%.....=SS',
  ' ~~~.............................................==S',
  ' ~~~...........................................P..=S',
  ' ~~~.............................................==S',
  '  SSS...........C..........................%.....=SS',
  '    SS.................SSSSSSS.....SSSSSSSS.....SS',
  '     SS................SS.................S....SS',
  '      SSS....C.........SS....T......f.....SSSSSS',
  '        SSS............SS.....*...........SSSS',
  '          SSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS',
];

// ------------------------------------------------------------------ Orion (station, explosives)
// Every entrance is a keycard door (north, west, south). West corridor -> hub (turret) -> east
// corridor (vertical laser) -> laser shaft (2 barriers) -> armory in the north-east (explosives
// pad, crates, cache, turret facing the shaft). North-west: control room (terminal, turret,
// windows) and a server room. South-west: crew quarters (terminal, crates, O2). South-east: supply
// bay (refill station, locker, fuel, crates) and an east storage room (crates, cache).
const ORION = [
  '############====##############DDD##############==###############',
  '#.....................#HHH#.........#HHHH#.....................#',
  '#.....%...%...%.......#HHH#.........#HHHH#...!!!!!!!......C....#',
  '=.....................#HHH#.........#HHHH#...!.....!...........=',
  '=................U....#HHH#....*....#HHHH#...!..P..!.........$.=',
  '=.....................#HHH#.........#HHHH#...!.....!.......U...=',
  '#...T.................#HHH#.........#HHHH#...!!!!!!!...........#',
  '#.....................#HHH#.........#HHHH#.C..............C....#',
  '#.....................#HHH#.........#HHHH#.....................#',
  '#########...###########HHH##.......##HHHH#############...#######',
  '#HHHHHHH#...##########HHHHH#.......#HHHHHHHHHHHHHHHHH#...#HHHHH#',
  '#HHHHHHH#............#######.......########HHHHHHHHHHElllEHHHHH#',
  '#HHHHHHH#......%.%.C.#....................#HHHHHHHHHH#...#HHHHH#',
  '#HHHHHHH#............#...*............*...#HHHHHHHHHH#...#HHHHH#',
  '#HHHHHHH#...##########....................#HHHHHHHHHH#...#HHHHH#',
  '#########...##########....................#HHHHHHHHHHElllEHHHHH#',
  '#.........................................#####E######...#HHHHH#',
  'D..............................................l.........#HHHHH#',
  'D..............................................l.........#HHHHH#',
  'D..............................U...............l.........#HHHHH#',
  '#.........*...............................#####E################',
  '#.........................................##..................##',
  '#.........................................##..C...............##',
  '#########...##########....................##................$.##',
  '#HHHHHHH#...#HHHHHHHH#....................##............C.....##',
  '#HHHHHHH#...#HHHHHHHH#..+*............*...##..................##',
  '#HHHHHHH#...#HHHHHHHH#....................########...###########',
  '#########...################.......###############...###########',
  '#..*..................#HHHH#.......#HHHHH#.....................#',
  '#.....................#HHHH#.......#######..........R....L.....#',
  '#..o...........C......#HHHH#........................%....%.....#',
  '=.....C...............#HHHH#...................................=',
  '=.....................#HHHH#...................................=',
  '=.....................#HHHH#.......#######.....................=',
  '=.....................#HHHH#...*...#HHHHH#.....................=',
  '#...T.................#HHHH#.......#HHHHH#.......f.............#',
  '#.................C...#HHHH#.......#HHHHH#..C...............C..#',
  '#.....................#HHHH#.......#HHHHH#.....................#',
  '#.....................#HHHH#.......#HHHHH#.....................#',
  '############====##############DDD##############==###############',
];

// ------------------------------------------------------------------ Hélios (observatory, anchor)
// Small observatory between the twin suns: openings north and south (perpendicular to the sun
// axis, so the hull never faces a sun opening), telescope windows facing each sun, the anchor pad
// in the centre, the astronomers' terminal and two repair kits.
const HELIOS = [
  '       ###~~~~###',
  '     ###........###',
  '   ##...%......%...##',
  '  ##................##',
  ' #=.....+......+.....=#',
  ' #=..................=#',
  ' #=.......*P*........=#',
  ' #=..................=#',
  ' #=.....T......C.....=#',
  '  ##................##',
  '   ##...%......%...##',
  '     ###........###',
  '       ###~~~~###',
];

// ------------------------------------------------------------------ Ulysse (return capsule)
// Open platform in fixed orbit near the Maelström: the capsule (north, facing the hole) with its
// hatch on the deck, the module's terminal, railings; the deck is open to the south.
const ULYSSE = [
  '      HHHHHH',
  '    HH======HH',
  '    H########H',
  '    H########H',
  '    HHHH##HHHH',
  '  ###____A____###',
  '  #_____________#',
  '  #___T____%____#',
  '  #_____________#',
  '  ##___________##',
  '   ###       ###',
];

// ------------------------------------------------------------------ Mistral (cargo wreck)
// A long bulk carrier broken in two: bridge (west, terminal), three cargo holds full of crates,
// a torn gap in the middle, engine room (east) with a cache.
const MISTRAL = [
  '    WWWWWWWWWWWWWWWWWWWWW~~~~~WWWWWWWWWWWWWWWWWWWW',
  '  WWW.......W..........W~~~~~W.........W.........WW',
  ' WW=...%....W..C...C...W~~~~~W...C..C..W...%..$...W',
  ' W=.........W..........W     W.........W..........W',
  ' W=...T.....W..C...C...WW   WW...C..C..W..........W',
  ' W=........................~~~.....................~~',
  ' W=........................~~~.....................~~',
  ' W=........................~~~.....................~~',
  ' W=.........W..C...C...WW   WW...C..C..W..........W',
  ' W=.........W..........W     W.........W....f.....W',
  ' WW=...%....W..C...C...W~~~~~W...C.....W...%......W',
  '  WWW.......W..........W~~~~~W.........W.........WW',
  '    WWWWWWWWWWWWWWWWWWWWW~~~~~WWWWWWWWWWWWWWWWWWWW',
];

// ------------------------------------------------------------------ satellite (×6)
const SATELLITE = [
  'OO   OO',
  'OO#H#OO',
  'OOHHHOO',
  'OO#H#OO',
  'OO   OO',
];

// ------------------------------------------------------------------ Tycho (moon gallery, heat shield)
// Carved into Séléné's rock (' ' keeps the moon rock). Anchor = the moon centre. The entrance
// tunnel opens on the east face and is plugged by rubble; winding tunnels with four gas vents lead
// west to the central chamber (heat shield pad, terminal). A side gallery north holds the miners'
// second terminal and a cache; a south pocket holds O2, fuel and a repair kit. The central chamber
// sits on the moon centre (anchor [44, 41]); every carved cell stays within 47 tiles of it (the rim
// is at 55 ± 2.6 tiles), except the mouth tunnel.
const TYCHO = [
  '',
  '                                                  ,,,,,,,,,,,,,,,,,,,',
  '                                                  ,,,,,,,,,,,,,,,,,,,',
  '                                                  ,,,,,,,,,,,,,,,$,,,',
  '                                                  ,,,T,,,,,,,,,,,,,,,',
  '                                                  ,,,,,,,,,,,,,,,,,,,',
  '                                                  ,,o,,,,,,,,,,,,,,,,',
  '                                                  ,,,,,,,,,,,,,,,,,,,',
  '                                                          ,,,,',
  '                                                          ,,,,',
  '                                                          ,,,,',
  '                                                          ,,,,',
  '                                                          ,,,,',
  '                                                          ,,,,   V',
  '                                              ,,,,,,,,,,,,,,,,,,,,,,,,,,,,,',
  '                                              ,,,,,,,,,,,,,,,,,,,,,,,,,,,,,',
  '                                              ,,,,,,,,,,,,,,,,,,,,,,,,,,,,,',
  '                                              ,,,,,,,,,,,,,,,,,,,,,,,,,,,,,',
  '                                              ,,,,     V               ,,,,',
  '                                              ,,,,                     ,,,,',
  '                                              ,,,,                     ,,,,',
  '                                              ,,,,                     ,,,,',
  '                                              ,,,,                     ,,,,',
  '                                              ,,,,                     ,,,,',
  '                                              ,,,,                     ,,,,,,,,,,,,',
  '                                             V,,,,                     ,,,,,,,,,,,,',
  '                                              ,,,,                     ,,,,,,,,,,,,',
  '                                              ,,,,                     ,,,,,,,,,,,,',
  '                                              ,,,,                             ,,,,',
  '                                              ,,,,                             ,,,,',
  '                                              ,,,,                             ,,,,',
  '                                              ,,,,                            V,,,,',
  '                                              ,,,,                             ,,,,',
  '                                              ,,,,                             ,,,,',
  '                                     ,,,,,,,,,,,,,,,,,,,,,                     ,,,,',
  '                                    ,,,,,,,,,,,,,,,,,,,,,,,                    ,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,,,,,,,                  ,,,,,,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,,,,,,,                  ,,,,,,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,,,,,,,                  ,,,,,,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,,,,,,,                  ,,,,,,,,,,rrr,,,,,,,,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,,,,,,,                  ,,,,,,,,,,rrr,,,,,,,,,,,',
  '                                   ,,,,T,,,,,,,,,,,P,,,,,,,,                  ,,,,,,,,,,rrr,,,,,,,,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,,,,,,,                  ,,,,,,,,,,rrr,,,,,,,,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,,,,,,,                  ,,,,,,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,,,,,,,                  ,,,,,,f,,',
  '                                   ,,,,,,,,,,,,,,,,,,,,,,,,,                  ,,,,,,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,,,,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,,,,,,,',
  '                                    ,,,,,,,,,,,,,,,,,,,,,,,',
  '                                     ,,,,,,,,,,,,,,,,,,,,,',
  '                                          ,,,,',
  '                                          ,,,,',
  '                                          ,,,,',
  '                                          ,,,,',
  '                                          ,,,,',
  '                                          ,,,,',
  '                                          ,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,',
  '                                   ,,,o,,,,,,,,,,,f,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,',
  '                                   ,,,,,,,,,+,,,,,,,,,',
  '                                   ,,,,,,,,,,,,,,,,,,,',
];

/** Every structure. anchor = plan cell placed on the POI position (null = plan centre). */
export const STRUCTURES = {
  albatros: { key: 'albatros', zone: 'albatros', anchor: null, rows: ALBATROS, items: [], logs: ['albatros'], crateValue: 'crateValue' },
  colibri: { key: 'colibri', zone: 'colibri', anchor: null, rows: COLIBRI, items: ['keycard'], logs: ['colibri'], crateValue: 'crateValue' },
  orion: { key: 'orion', zone: 'orion', anchor: null, rows: ORION, items: ['explosives'], logs: ['orion_command', 'orion_crew'], crateValue: 'crateValue' },
  helios: { key: 'helios', zone: 'helios', anchor: null, rows: HELIOS, items: ['anchor'], logs: ['helios'], crateValue: 'crateValue' },
  ulysse: { key: 'ulysse', zone: 'ulysse', anchor: null, rows: ULYSSE, items: [], logs: ['ulysse'], crateValue: 'crateValue' },
  mistral: { key: 'mistral', zone: 'mistral', anchor: null, rows: MISTRAL, items: [], logs: ['mistral'], crateValue: 'mistralCrateValue' },
  satellite: { key: 'satellite', zone: null, anchor: null, rows: SATELLITE, items: [], logs: [], crateValue: 'crateValue' },
  tycho: { key: 'tycho', zone: 'tycho', anchor: [44, 41], rows: TYCHO, items: ['heatshield'], logs: ['tycho_miners', 'tycho_chief'], crateValue: 'crateValue' },
};

const SIZE_CACHE = {};

/** Plan size in tiles (rows padded to the widest). */
export function planSize(key) {
  if (SIZE_CACHE[key]) return SIZE_CACHE[key];
  const rows = STRUCTURES[key].rows;
  let w = 0;
  for (const r of rows) w = Math.max(w, r.length);
  SIZE_CACHE[key] = { w, h: rows.length };
  return SIZE_CACHE[key];
}

/** Plan character at (col, row), ' ' outside the drawn rows. */
export function planChar(key, col, row) {
  const rows = STRUCTURES[key].rows;
  if (row < 0 || row >= rows.length) return ' ';
  const r = rows[row];
  return col >= 0 && col < r.length ? r[col] : ' ';
}

/** Every [col, row] where the plan holds `ch` (reading order). */
export function planCells(key, ch) {
  const out = [];
  const rows = STRUCTURES[key].rows;
  for (let y = 0; y < rows.length; y++) for (let x = 0; x < rows[y].length; x++) if (rows[y][x] === ch) out.push([x, y]);
  return out;
}

/** Plan cell placed on the POI position. */
export function planAnchor(key) {
  const s = STRUCTURES[key];
  if (s.anchor) return s.anchor;
  const { w, h } = planSize(key);
  return [Math.floor(w / 2), Math.floor(h / 2)];
}
