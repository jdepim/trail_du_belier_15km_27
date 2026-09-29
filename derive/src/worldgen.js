// Sector generation (DESIGN.md §3, §13). Deterministic for a given seed; the macro layout (POIs,
// structures, suns, black holes, moon) is fixed, the seed only decides the filling (belt clusters,
// crater texture, crate / cache values).
//
// generateWorld(seed) -> gen = {
//   seed, world (World, finalized, no mods),
//   spawn { x, y },                       dock { x0, y0, x1, y1 } (px rectangle inside the Albatros),
//   pois [{ key, name, kind, icon, x, y, radar, always, label }] (absolute px; tycho = gallery mouth),
//   structures { key: { x0, y0, x1, y1, zone } } (px bounds of each stamped plan),
//   suns [{ key, name, x, y, coreR, heatR, heatMax, heatExp, mu, influence, cause }],
//   blackHoles [{ key, name, x, y, horizon, mu, influence, diskR, cause }],
//   moon { x, y, r, mu, influence }, belt { x, y, rInner, rOuter },
//   gravitySources [{ key, x, y, mu, rSoft, influence, bh }] (physics.gravityAt input),
//   satellites [{ id, name, x, y }],
//   items [{ id, key, x, y, tx, ty }]            key = keycard | explosives | heatshield | anchor
//   doors [{ id, tiles: [tileIndex], x, y, tx0, ty0, tx1, ty1, vertical }]
//   terminals [{ id, log, x, y }], crates [{ id, x, y, value }], caches [{ id, x, y, value }],
//   pickups [{ id, kind: 'o2' | 'fuel' | 'repair', x, y }] (respawn every life),
//   refills [{ id, x, y }], lockers [{ id, x, y }], workbench { x, y }, capsule { x, y },
//   turrets [{ id, x, y }],
//   lasers [{ id, x0, y0, x1, y1, vertical, phase }]   beam segment between the emitter faces
//   vents [{ id, x, y, dirX, dirY, length, halfWidth, phase }]   (x, y) = middle of the vent mouth
//   debrisFields [{ poi, x, y, rMin, rMax, count }]
//   rubble { tiles: [tileIndex], x, y, x0, y0, x1, y1 } (the Tycho plug, px bounds)
// }
// Record ids are stable: '<structure>:<kind><n>' in plan reading order, 'sat1'..'sat6'. They are
// saved (crates, caches, satellites), so never renumber a plan without a save migration.
import {
  TILE, WORLD_TILES, CENTER, POIS, POI_BY_KEY, ZONE_ID, SUNS, BLACK_HOLES, MOON, BELT, HAZARDS,
  ECONOMY, PICKUPS,
} from './config.js';
import { createRng, createNoise2D, fbm2D, normalizeSeed } from './rng.js';
import { World } from './world.js';
import { TILE_ID as T, SOLID } from './tiles.js';
import { STRUCTURES, planSize, planChar, planAnchor } from './structures.js';

const N = WORLD_TILES;

/** Plan character -> tile id written (undefined = untouched). */
const CHAR_TILE = {
  '~': T.SPACE, '.': T.FLOOR, ':': T.GRATE, '_': T.PLATING, '!': T.HAZARD_FLOOR, '#': T.HULL,
  H: T.HULL_DARK, '=': T.WINDOW, W: T.WRECK, S: T.SHUTTLE, O: T.SOLAR_PANEL, D: T.DOOR_LOCKED,
  E: T.EMITTER, l: T.HAZARD_FLOOR, U: T.FLOOR, P: T.PAD, T: T.PANEL, C: T.FLOOR, R: T.PANEL,
  L: T.PANEL, B: T.PANEL, K: T.GRATE, X: T.GRATE, A: T.PLATING, '*': T.LIGHT, '%': T.PANEL,
  o: T.FLOOR, f: T.FLOOR, '+': T.FLOOR, $: T.FLOOR, m: T.MOON_ROCK, ',': T.MOON_FLOOR,
  r: T.RUBBLE, V: T.VENT,
};
const PICKUP_KIND = { o: 'o2', f: 'fuel', '+': 'repair' };

export function generateWorld(seedInput) {
  const seed = normalizeSeed(seedInput);
  const rng = createRng(seed);
  const world = new World(N, N);
  const protect = new Uint8Array(N * N); // 1 = structure / moon footprint: belt rocks keep away
  const gen = {
    seed, world,
    spawn: null, dock: null, pois: [], structures: {},
    suns: [], blackHoles: [], moon: null, belt: null, gravitySources: [],
    satellites: [], items: [], doors: [], terminals: [], crates: [], caches: [], pickups: [],
    refills: [], lockers: [], workbench: null, capsule: null, turrets: [], lasers: [], vents: [],
    debrisFields: [], rubble: null,
  };
  const crateRng = rng.fork('crates');

  buildBodies(gen);
  rasterizeMoon(world, protect, gen.moon, rng.fork('moon'), seed);
  for (const key of ['albatros', 'colibri', 'orion', 'helios', 'ulysse', 'mistral']) {
    const p = POI_BY_KEY[key];
    stamp(gen, protect, crateRng, key, key, p.x, p.y);
  }
  stamp(gen, protect, crateRng, 'tycho', 'tycho', gen.moon.x, gen.moon.y);
  for (let i = 1; i <= 6; i++) {
    const p = POI_BY_KEY['sat' + i];
    stamp(gen, protect, crateRng, 'satellite', 'sat' + i, p.x, p.y);
    gen.satellites.push({ id: 'sat' + i, name: p.name, x: p.x, y: p.y });
  }
  buildBelt(gen, protect, rng.fork('belt'), seed);
  buildShelterRocks(gen, protect, rng.fork('shelter'), seed);
  for (const f of PICKUPS.debrisFields) {
    const p = POI_BY_KEY[f.poi];
    gen.debrisFields.push({ poi: f.poi, x: p.x, y: p.y, rMin: f.rMin, rMax: f.rMax, count: f.count });
  }
  buildPois(gen);
  world.finalize();
  return gen;
}

// ------------------------------------------------------------------ bodies

function buildBodies(gen) {
  for (const s of SUNS.list) {
    gen.suns.push({
      key: s.key, name: s.name, x: CENTER + s.rx, y: CENTER + s.ry, cause: s.cause,
      coreR: SUNS.coreR, heatR: SUNS.heatR, heatMax: SUNS.heatMax, heatExp: SUNS.heatExp,
      mu: SUNS.mu, influence: SUNS.influence,
    });
  }
  for (const b of BLACK_HOLES.list) {
    gen.blackHoles.push({
      key: b.key, name: b.name, x: CENTER + b.rx, y: CENTER + b.ry, horizon: b.horizon,
      mu: b.mu, influence: b.influence, diskR: b.diskR, cause: b.cause,
    });
  }
  gen.moon = { x: CENTER + MOON.rx, y: CENTER + MOON.ry, r: MOON.r, mu: MOON.mu, influence: MOON.influence };
  gen.belt = { x: CENTER, y: CENTER, rInner: BELT.rInner, rOuter: BELT.rOuter };
  for (const s of gen.suns) gen.gravitySources.push({ key: s.key, x: s.x, y: s.y, mu: s.mu, rSoft: s.coreR, influence: s.influence, bh: false });
  for (const b of gen.blackHoles) gen.gravitySources.push({ key: b.key, x: b.x, y: b.y, mu: b.mu, rSoft: b.horizon, influence: b.influence, bh: true });
  const m = gen.moon;
  gen.gravitySources.push({ key: 'selene', x: m.x, y: m.y, mu: m.mu, rSoft: m.r, influence: m.influence, bh: false });
}

// ------------------------------------------------------------------ moon

function rasterizeMoon(world, protect, moon, rnd, seed) {
  const noise = createNoise2D(seed ^ 0x5e1e7e);
  const cx = moon.x / TILE, cy = moon.y / TILE;
  const R = moon.r / TILE;
  const reach = Math.ceil(R + MOON.edgeBump + 2);
  // craters: bright rim ring (moon_dust) around a dark floor (moon_crater)
  const craters = [];
  for (let i = 0; i < 16; i++) {
    const a = rnd.float(0, Math.PI * 2), d = Math.sqrt(rnd.next()) * (R - 8);
    craters.push({ x: cx + Math.cos(a) * d, y: cy + Math.sin(a) * d, r: rnd.float(2.5, 7.5) });
  }
  for (let ty = Math.floor(cy - reach); ty <= Math.ceil(cy + reach); ty++) {
    for (let tx = Math.floor(cx - reach); tx <= Math.ceil(cx + reach); tx++) {
      const dx = tx + 0.5 - cx, dy = ty + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const rim = R + (fbm2D(noise, Math.cos(a) * 2.2 + 7, Math.sin(a) * 2.2 + 7, 3) - 0.5) * 2 * MOON.edgeBump;
      if (d >= rim) continue;
      let id = T.MOON_ROCK;
      if (d > rim - MOON.dustDepth) id = T.MOON_DUST;
      else if (fbm2D(noise, tx * MOON.craterScale, ty * MOON.craterScale, 2) > MOON.craterThreshold) id = T.MOON_CRATER;
      for (const c of craters) {
        const cd = Math.hypot(tx + 0.5 - c.x, ty + 0.5 - c.y);
        if (cd < c.r - 1.2) { id = T.MOON_CRATER; break; }
        if (cd < c.r) { id = T.MOON_DUST; break; }
      }
      world.setRaw(tx, ty, id);
      protect[ty * N + tx] = 1;
    }
  }
}

// ------------------------------------------------------------------ structures

function stamp(gen, protect, crateRng, key, idPrefix, px, py) {
  const s = STRUCTURES[key];
  const world = gen.world;
  const { w, h } = planSize(key);
  const [ax, ay] = planAnchor(key);
  const ox = Math.floor(px / TILE) - ax, oy = Math.floor(py / TILE) - ay;
  const zone = s.zone ? ZONE_ID[s.zone] : 0;
  const cell = (c, r) => ({ x: (ox + c + 0.5) * TILE, y: (oy + r + 0.5) * TILE, tx: ox + c, ty: oy + r });
  const counters = {};
  const nextId = (kind) => { counters[kind] = (counters[kind] || 0) + 1; return `${idPrefix}:${kind}${counters[kind] - 1}`; };
  let itemIdx = 0, logIdx = 0;
  let dockMin = null, dockMax = null;
  const rubble = [];
  const crateRange = ECONOMY[s.crateValue];

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const ch = planChar(key, c, r);
      const tx = ox + c, ty = oy + r;
      if (ch === ' ') continue;
      const id = CHAR_TILE[ch];
      if (id === undefined) throw new Error(`structures.${key}: unknown plan char '${ch}' at ${c},${r}`);
      if (ch === ',') {
        // gallery floor: only carved inside the moon rock (the mouth stays open space)
        if (!SOLID[world.types[ty * N + tx]]) continue;
      }
      world.setRaw(tx, ty, id);
      world.setZoneRaw(tx, ty, ch === '~' ? 0 : zone);
      if (ch !== '~') protect[ty * N + tx] = 1;
      const p = cell(c, r);
      switch (ch) {
        case 'P': gen.items.push({ id: nextId('item'), key: s.items[itemIdx++], x: p.x, y: p.y, tx, ty }); break;
        case 'T': gen.terminals.push({ id: nextId('terminal'), log: s.logs[logIdx++], x: p.x, y: p.y }); break;
        case 'C': gen.crates.push({ id: nextId('crate'), x: p.x, y: p.y, value: crateRng.int(crateRange[0], crateRange[1]) }); break;
        case '$': gen.caches.push({ id: nextId('cache'), x: p.x, y: p.y, value: crateRng.int(ECONOMY.cacheValue[0], ECONOMY.cacheValue[1]) }); break;
        case 'R': gen.refills.push({ id: nextId('refill'), x: p.x, y: p.y }); break;
        case 'L': gen.lockers.push({ id: nextId('locker'), x: p.x, y: p.y }); break;
        case 'B': gen.workbench = { x: p.x, y: p.y }; break;
        case 'A': gen.capsule = { x: p.x, y: p.y }; break;
        case 'r': rubble.push(ty * N + tx); break;
        case 'U': gen.turrets.push({ id: nextId('turret'), x: p.x, y: p.y }); break;
        case 'o': case 'f': case '+': gen.pickups.push({ id: nextId('pickup'), kind: PICKUP_KIND[ch], x: p.x, y: p.y }); break;
        case 'X': gen.spawn = { x: p.x, y: p.y }; // falls through: the spawn is part of the dock
        case 'K':
          dockMin = dockMin || { tx, ty }; dockMax = dockMax || { tx, ty };
          dockMin.tx = Math.min(dockMin.tx, tx); dockMin.ty = Math.min(dockMin.ty, ty);
          dockMax.tx = Math.max(dockMax.tx, tx); dockMax.ty = Math.max(dockMax.ty, ty);
          break;
        default: break;
      }
    }
  }
  if (rubble.length) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const i of rubble) { const tx = i % N, ty = Math.floor(i / N); x0 = Math.min(x0, tx); x1 = Math.max(x1, tx); y0 = Math.min(y0, ty); y1 = Math.max(y1, ty); }
    gen.rubble = { tiles: rubble, x: (x0 + x1 + 1) / 2 * TILE, y: (y0 + y1 + 1) / 2 * TILE, x0: x0 * TILE, y0: y0 * TILE, x1: (x1 + 1) * TILE, y1: (y1 + 1) * TILE };
  }
  if (dockMin) gen.dock = { x0: dockMin.tx * TILE, y0: dockMin.ty * TILE, x1: (dockMax.tx + 1) * TILE, y1: (dockMax.ty + 1) * TILE };
  gen.structures[idPrefix] = { x0: ox * TILE, y0: oy * TILE, x1: (ox + w) * TILE, y1: (oy + h) * TILE, zone };
  collectDoors(gen, key, idPrefix, ox, oy, w, h);
  collectLasers(gen, key, idPrefix, ox, oy, w, h);
  collectVents(gen, key, idPrefix, ox, oy, w, h);
}

/** 4-connected groups of 'D' cells -> one door record each (reading order of the first cell). */
function collectDoors(gen, key, idPrefix, ox, oy, w, h) {
  const seen = new Uint8Array(w * h);
  let n = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (planChar(key, c, r) !== 'D' || seen[r * w + c]) continue;
      const tiles = [];
      const stack = [c, r];
      seen[r * w + c] = 1;
      let c0 = c, c1 = c, r0 = r, r1 = r;
      while (stack.length) {
        const y = stack.pop(), x = stack.pop();
        tiles.push((oy + y) * N + ox + x);
        c0 = Math.min(c0, x); c1 = Math.max(c1, x); r0 = Math.min(r0, y); r1 = Math.max(r1, y);
        for (let k = 0; k < 4; k++) {
          const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h || seen[ny * w + nx] || planChar(key, nx, ny) !== 'D') continue;
          seen[ny * w + nx] = 1;
          stack.push(nx, ny);
        }
      }
      tiles.sort((a, b) => a - b);
      gen.doors.push({
        id: `${idPrefix}:door${n++}`, tiles,
        x: (ox + (c0 + c1 + 1) / 2) * TILE, y: (oy + (r0 + r1 + 1) / 2) * TILE,
        tx0: ox + c0, ty0: oy + r0, tx1: ox + c1, ty1: oy + r1, vertical: r1 - r0 > c1 - c0,
      });
    }
  }
}

/** A straight run of 'l' between two 'E' emitters -> one laser barrier. */
function collectLasers(gen, key, idPrefix, ox, oy, w, h) {
  const L = HAZARDS.laser;
  const period = L.off + L.warn + L.on;
  let n = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (planChar(key, c, r) !== 'E') continue;
      for (const [dx, dy] of [[1, 0], [0, 1]]) {
        let k = 1;
        while (planChar(key, c + dx * k, r + dy * k) === 'l') k++;
        if (k === 1 || planChar(key, c + dx * k, r + dy * k) !== 'E') continue;
        const vertical = dy === 1;
        const x0 = (ox + c + (vertical ? 0.5 : 1)) * TILE, y0 = (oy + r + (vertical ? 1 : 0.5)) * TILE;
        const x1 = (ox + c + dx * k + (vertical ? 0.5 : 0)) * TILE, y1 = (oy + r + dy * k + (vertical ? 0 : 0.5)) * TILE;
        gen.lasers.push({ id: `${idPrefix}:laser${n}`, x0, y0, x1, y1, vertical, phase: (n * period) / 3 });
        n++;
      }
    }
  }
}

/** 'V' vents blow toward their open 4-neighbour. */
function collectVents(gen, key, idPrefix, ox, oy, w, h) {
  const V = HAZARDS.vent;
  const period = V.off + V.warn + V.on;
  const open = (c, r) => { const ch = planChar(key, c, r); return ch === ',' || ch === '.' || ch === 'o' || ch === 'f' || ch === '+'; };
  let n = 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      if (planChar(key, c, r) !== 'V') continue;
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      let dir = null;
      for (const d of dirs) if (open(c + d[0], r + d[1])) { dir = d; break; }
      if (!dir) throw new Error(`structures.${key}: vent at ${c},${r} has no open side`);
      gen.vents.push({
        id: `${idPrefix}:vent${n}`,
        x: (ox + c + 0.5 + dir[0] * 0.5) * TILE, y: (oy + r + 0.5 + dir[1] * 0.5) * TILE,
        dirX: dir[0], dirY: dir[1], length: V.length, halfWidth: V.halfWidth,
        phase: (n * period * 0.37) % period,
      });
      n++;
    }
  }
}

// ------------------------------------------------------------------ belt & rocks

function blob(world, protect, noise, cx, cy, r, core, fringe) {
  const reach = Math.ceil(r + 2);
  for (let ty = Math.floor(cy - reach); ty <= Math.ceil(cy + reach); ty++) {
    for (let tx = Math.floor(cx - reach); tx <= Math.ceil(cx + reach); tx++) {
      if (tx < 0 || ty < 0 || tx >= N || ty >= N || protect[ty * N + tx]) continue;
      const d = Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy) / r + (noise(tx * 0.35, ty * 0.35) - 0.5) * 0.55;
      if (d >= 1) continue;
      world.setRaw(tx, ty, d > 0.72 ? fringe : core);
    }
  }
}

/** Distance (px) from (x, y) to the nearest structure footprint / satellite / body to keep clear. */
function clearance(gen, x, y) {
  let best = Infinity;
  for (const k in gen.structures) {
    const b = gen.structures[k];
    const dx = Math.max(b.x0 - x, 0, x - b.x1), dy = Math.max(b.y0 - y, 0, y - b.y1);
    best = Math.min(best, Math.hypot(dx, dy));
  }
  const m = gen.moon;
  best = Math.min(best, Math.hypot(x - m.x, y - m.y) - m.r);
  for (const s of gen.suns) best = Math.min(best, Math.hypot(x - s.x, y - s.y) - s.coreR * 2);
  for (const b of gen.blackHoles) best = Math.min(best, Math.hypot(x - b.x, y - b.y) - b.diskR * 2);
  return best;
}

function buildBelt(gen, protect, rnd, seed) {
  const noise = createNoise2D(seed ^ 0xbe17);
  let placed = 0;
  for (let tries = 0; tries < BELT.clusters * 20 && placed < BELT.clusters; tries++) {
    const a = rnd.float(0, Math.PI * 2);
    const rr = rnd.float(BELT.rInner + 80, BELT.rOuter - 80);
    const x = CENTER + Math.cos(a) * rr, y = CENTER + Math.sin(a) * rr;
    const size = rnd.float(BELT.clusterR[0], BELT.clusterR[1]);
    if (clearance(gen, x, y) < BELT.keepOut + size * TILE) continue;
    const small = rnd.chance(BELT.smallChance);
    const ice = !small && rnd.chance(BELT.iceChance);
    const core = small ? T.ASTEROID_SMALL : ice ? T.ICE : T.ASTEROID;
    blob(gen.world, protect, noise, x / TILE, y / TILE, size, core, T.ASTEROID_SMALL);
    // a few satellite rocks around the main body
    const extra = rnd.int(1, 3);
    for (let k = 0; k < extra; k++) {
      const ea = rnd.float(0, Math.PI * 2), ed = size + rnd.float(3, 7);
      const es = rnd.float(1.5, Math.max(2, size * 0.45));
      blob(gen.world, protect, noise, x / TILE + Math.cos(ea) * ed, y / TILE + Math.sin(ea) * ed, es, rnd.chance(0.5) ? T.ASTEROID_SMALL : core, T.ASTEROID_SMALL);
    }
    placed++;
  }
}

/** Static rocks around the twin suns: shade against flares (never on the observatory approach lanes). */
function buildShelterRocks(gen, protect, rnd, seed) {
  const noise = createNoise2D(seed ^ 0x5be1);
  const h = POI_BY_KEY.helios;
  let placed = 0;
  for (let tries = 0; tries < 200 && placed < 8; tries++) {
    // alternate the sides of the sun axis; keep the north / south approach lanes of the
    // observatory clear (±30° around them)
    const side = placed % 2 === 0 ? 0 : Math.PI;
    const a = side + rnd.float(-Math.PI / 3, Math.PI / 3);
    const d = rnd.float(520, 900);
    const x = h.x + Math.cos(a) * d, y = h.y + Math.sin(a) * d;
    let ok = true;
    for (const s of gen.suns) if (Math.hypot(x - s.x, y - s.y) < s.coreR + 150) ok = false;
    if (!ok || clearance(gen, x, y) < 90) continue;
    blob(gen.world, protect, noise, x / TILE, y / TILE, rnd.float(3, 5.5), T.ASTEROID, T.ASTEROID);
    placed++;
  }
}

// ------------------------------------------------------------------ POIs

function buildPois(gen) {
  for (const p of POIS) {
    const out = { key: p.key, name: p.name, kind: p.kind, icon: p.icon, x: p.x, y: p.y, radar: p.radar, always: !!p.always, label: p.label || null };
    if (p.key === 'tycho' && gen.rubble) { out.x = gen.rubble.x1; out.y = gen.rubble.y; }
    gen.pois.push(out);
  }
}
