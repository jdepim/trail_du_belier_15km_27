// Debug flags and the window.__derive handle driven by the end-to-end tests (DESIGN.md §13).
//
//   parseFlags(search) -> { debug, god, seed, at, x, y, items, salvage, bank, reveal, autostart, mute, nosw }
//     ?debug (G = god mode, R = reveal the map)  ?god  ?seed=<n|text>  ?at=<POI key or record id>
//     ?x=&y= (px relative to the sector centre)  ?items=all | keycard,explosives,…  ?salvage=<carried>
//     ?bank=<deposited>  ?reveal (whole map)  ?autostart  ?mute  ?nosw (no service worker)
//   applyStartFlags(game)   ?at / ?x&y / ?salvage, applied when "Jouer" starts the first life (true = teleported)
//   installDebug(game)      window.__derive = {
//     game, errors, state(), start(), pause(), resume(), freeze(b), step(nTicks),
//     player(), setPlayer(fields), teleport(x, y) (absolute px), teleportTo(target) (POI key, item key,
//     'dock' | 'workbench' | 'capsule' | 'rubble', or a record id such as 'orion:door0' / 'sat3';
//     a black hole puts you at a safe stand-off toward the centre),
//     spotNear(x, y, dirX, dirY), give(item), setSalvage(n), setBank(n), hazards(), entities(),
//     save(), gen(), world: { get(tx, ty) }, ui(), info(), die(cause), input: { set, clear, tap, layout, state }
//   }
import { FIXED_DT, TILE, CENTER, POI_BY_KEY, PLAYER } from './config.js';
import { TILES, SOLID } from './tiles.js';
import { normalizeSeed } from './rng.js';
import { ITEM_KEYS, fogReveal } from './meta.js';

export function parseFlags(search) {
  const q = new URLSearchParams(search || '');
  const has = (k) => q.has(k) && q.get(k) !== '0' && q.get(k) !== 'false';
  const num = (k) => (q.has(k) && q.get(k) !== '' && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
  let items = null;
  if (q.has('items')) {
    const v = q.get('items');
    items = v === 'all' ? ITEM_KEYS.slice() : v.split(',').map((s) => s.trim()).filter((k) => ITEM_KEYS.includes(k));
  }
  return {
    debug: has('debug'),
    god: has('god'),
    seed: q.has('seed') && q.get('seed') !== '' ? normalizeSeed(q.get('seed')) : null,
    at: q.get('at') || null,
    x: num('x'),
    y: num('y'),
    items,
    salvage: num('salvage'),
    bank: num('bank'),
    reveal: has('reveal'),
    autostart: has('autostart'),
    mute: has('mute'),
    nosw: has('nosw') || has('debug'),
  };
}

/** Is a circle of radius r at (x, y) a safe place to stand (no tile, no core, no horizon)? */
function freeSpot(game, x, y, r) {
  if (game.world.circleSolid(x, y, r)) return false;
  for (const s of game.hazards.suns) if (Math.hypot(x - s.x, y - s.y) < s.coreR + 40) return false;
  for (const b of game.hazards.blackHoles) if (Math.hypot(x - b.x, y - b.y) < b.horizon + 40) return false;
  return true;
}

/**
 * Nearest free spot around (x, y), trying the preferred direction (dirX, dirY) first (e.g. out of
 * a structure through a door), then rings of growing radius.
 */
export function spotNear(game, x, y, dirX = 0, dirY = 0) {
  const r = game.player.r + 2;
  if (dirX || dirY) {
    const m = Math.hypot(dirX, dirY);
    for (let d = TILE; d <= TILE * 8; d += 2) {
      const px = x + (dirX / m) * d, py = y + (dirY / m) * d;
      if (freeSpot(game, px, py, r)) return { x: px, y: py };
    }
  }
  if (freeSpot(game, x, y, r)) return { x, y };
  for (let d = 4; d <= 600; d += 4) {
    const n = Math.max(8, Math.round(d / 3));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const px = x + Math.cos(a) * d, py = y + Math.sin(a) * d;
      if (freeSpot(game, px, py, r)) return { x: px, y: py };
    }
  }
  return { x, y };
}

/** Target point + preferred exit direction for teleportTo(). */
function targetOf(game, key) {
  const e = game.entities, g = game.gen;
  const out = (x, y, cx, cy) => ({ x, y, dx: x - cx, dy: y - cy });
  const struct = (id) => {
    const s = g.structures[id.split(':')[0]];
    return s ? { cx: (s.x0 + s.x1) / 2, cy: (s.y0 + s.y1) / 2 } : { cx: CENTER, cy: CENTER };
  };
  if (key === 'dock') return out((g.dock.x0 + g.dock.x1) / 2, (g.dock.y0 + g.dock.y1) / 2, 0, 0);
  if (key === 'workbench') return { x: g.workbench.x, y: g.workbench.y, dx: 0, dy: 0 };
  if (key === 'capsule') return { x: g.capsule.x, y: g.capsule.y, dx: 0, dy: 0 };
  if (key === 'rubble') return out(g.rubble.x, g.rubble.y, g.moon.x, g.moon.y);
  const item = e.items.find((i) => i.key === key || i.id === key);
  if (item) return { x: item.x, y: item.y, dx: 0, dy: 0 };
  for (const list of [e.doors, e.crates, e.terminals, e.satellites, e.refills, e.lockers]) {
    const r = list.find((o) => o.id === key || o.log === key);
    if (!r) continue;
    const s = struct(r.id);
    return list === e.doors ? out(r.x, r.y, s.cx, s.cy) : { x: r.x, y: r.y, dx: 0, dy: 0 };
  }
  // a black hole: stand off toward the sector centre where its pull is half the base thrust
  const hole = g.blackHoles.find((b) => b.key === key);
  if (hole) {
    const d = Math.sqrt(hole.mu / (0.5 * PLAYER.thrustAccel));
    const ux = CENTER - hole.x, uy = CENTER - hole.y, m = Math.hypot(ux, uy) || 1;
    return { x: hole.x + (ux / m) * d, y: hole.y + (uy / m) * d, dx: 0, dy: 0 };
  }
  const poi = g.pois.find((p) => p.key === key) || POI_BY_KEY[key];
  if (poi) return { x: poi.x, y: poi.y, dx: 0, dy: 0 };
  return null;
}

/** ?at / ?x&y / ?salvage: applied when the first life of the session starts. True = teleported. */
export function applyStartFlags(game) {
  const f = game.flags, api = window.__derive;
  let moved = false;
  if (f.at) moved = !!api.teleportTo(f.at);
  else if (f.x !== null || f.y !== null) { api.teleport(CENTER + (f.x || 0), CENTER + (f.y || 0)); moved = true; }
  if (f.salvage !== null) game.run.salvage = f.salvage;
  return moved;
}

export function installDebug(game) {
  const api = {
    game,
    errors: [],
    state() { return game.state; },
    start() { game.startGame(); return game.state; },
    pause() { game.requestPause(); return game.state; },
    resume() { game.setState('PLAYING'); },
    /** Stop the real-time loop; step(n) then advances n fixed ticks synchronously. */
    freeze(b = true) { game.frozen = b; },
    step(n = 1) { for (let i = 0; i < n; i++) game.fixedStep(FIXED_DT); game.renderer.render(1); return api.player(); },
    input: {
      set(state) { game.input.inject(state); },
      clear() { game.input.clearInjected(); },
      tap(action) { game.input.tap(action); },
      layout() { return game.input.getLayout(); },
      state() { const i = game.input; return { moveX: i.moveX, moveY: i.moveY, raw: { ...i.raw }, touches: i.touches.size, context: i.contextLabel }; },
    },
    player() {
      const p = game.player;
      return {
        x: p.x, y: p.y, vx: p.vx, vy: p.vy, speed: p.speed, angle: p.angle, dir16: p.dir16, thrust: p.thrust,
        braking: p.braking, hull: p.hull, o2: p.o2, fuel: p.fuel, charges: p.charges, stats: { ...p.stats },
        dead: p.dead, deathCause: p.deathCause, iframes: p.iframes, inDock: p.inDock, gravMag: p.gravMag,
        zone: game.world.zoneAt(p.x, p.y),
      };
    },
    /** Overwrite player fields (x, y, vx, vy, hull, o2, fuel, charges, iframes…). */
    setPlayer(fields) {
      const p = game.player;
      Object.assign(p, fields);
      if ('x' in fields || 'y' in fields) { p.prevX = p.x; p.prevY = p.y; game.camera.snap(); }
      return api.player();
    },
    teleport(x, y) { game.player.teleport(x, y); game.camera.snap(); return api.player(); },
    spotNear(x, y, dx = 0, dy = 0) { return spotNear(game, x, y, dx, dy); },
    /** Put the astronaut on a free spot next to a POI / item / record (outside for doors, rubble). */
    teleportTo(key) {
      const t = targetOf(game, key);
      if (!t) return null;
      const s = spotNear(game, t.x, t.y, t.dx, t.dy);
      return api.teleport(s.x, s.y);
    },
    give(item) {
      const keys = item === 'all' ? ITEM_KEYS : [item];
      for (const k of keys) {
        if (!ITEM_KEYS.includes(k)) continue;
        game.save.items[k] = true;
        for (const it of game.entities.items) if (it.key === k) it.taken = true;
        if (k === 'explosives') { game.player.charges = game.player.stats.maxCharges; game.input.setButtonVisible('charge', true); }
      }
      game.persist();
      return { ...game.save.items };
    },
    /** Carried (not yet deposited) salvage. */
    setSalvage(n) { game.run.salvage = n; return n; },
    /** Deposited salvage (the workbench currency). */
    setBank(n) { game.save.salvage = n; game.persist(); game.ui.refresh(); return n; },
    die(cause = 'impact') { game.player.die(cause, { force: true }); return game.player.dead; },
    hazards() {
      const h = game.hazards;
      return {
        heatAtPlayer: h.heatAtPlayer, heatLevel: h.heatLevel, nearSun: h.nearSun, gravCritical: h.gravCritical,
        bhProximity: h.bhProximity, stormIntensity: h.stormIntensity, inStorm: h.inStorm,
        suns: h.suns.map((s) => ({ key: s.key, x: s.x, y: s.y, coreR: s.coreR, heatR: s.heatR, flareState: s.flareState })),
        blackHoles: h.blackHoles.map((b) => ({ key: b.key, x: b.x, y: b.y, horizon: b.horizon })),
        charges: h.charges.filter((c) => c.active).map((c) => ({ x: c.x, y: c.y, fuse: c.fuse })),
        asteroids: h.asteroids.filter((a) => a.active).length,
      };
    },
    entities() {
      const e = game.entities, it = e.interactable;
      return {
        interactable: it ? { kind: it.kind, label: it.label, x: it.x, y: it.y, id: it.ref && it.ref.id } : null,
        inDock: e.inDock,
        pickups: e.pickups.filter((p) => p.active).map((p) => ({ kind: p.kind, value: p.value, x: p.x, y: p.y })),
        items: e.items.map((i) => ({ id: i.id, key: i.key, x: i.x, y: i.y, taken: i.taken })),
        doors: e.doors.map((d) => ({ id: d.id, x: d.x, y: d.y, open: d.open })),
        terminals: e.terminals.map((t) => ({ id: t.id, log: t.log, x: t.x, y: t.y, read: t.read })),
        satellites: e.satellites.map((s) => ({ id: s.id, x: s.x, y: s.y, active: s.active })),
        crates: e.crates.map((c) => ({ id: c.id, x: c.x, y: c.y, opened: c.opened })),
      };
    },
    save() { return JSON.parse(JSON.stringify(game.save)); },
    run() { return { ...game.run }; },
    gen() {
      const g = game.gen;
      return {
        seed: g.seed, spawn: { ...g.spawn }, dock: { ...g.dock }, workbench: { ...g.workbench }, capsule: { ...g.capsule },
        moon: { x: g.moon.x, y: g.moon.y, r: g.moon.r },
        rubble: { x: g.rubble.x, y: g.rubble.y, x0: g.rubble.x0, y0: g.rubble.y0, x1: g.rubble.x1, y1: g.rubble.y1, tiles: g.rubble.tiles.slice() },
        pois: g.pois.map((p) => ({ key: p.key, name: p.name, x: p.x, y: p.y })),
        suns: g.suns.map((s) => ({ key: s.key, x: s.x, y: s.y, coreR: s.coreR, heatR: s.heatR })),
      };
    },
    world: {
      get(tx, ty) { const id = game.world.get(tx, ty); return { id, key: TILES[id].key, solid: !!SOLID[id] }; },
      at(x, y) { return api.world.get(Math.floor(x / TILE), Math.floor(y / TILE)); },
    },
    ui() { return game.ui.name; },
    info() {
      return { view: { ...game.view }, safe: { ...game.safe }, fps: game.fps, touch: game.input.touchEnabled, frozen: game.frozen };
    },
  };
  window.__derive = api;
  window.addEventListener('error', (e) => api.errors.push(String(e.message || e)));
  if (game.flags.debug) {
    game.input.onKey = (e) => {
      if (e.repeat) return;
      if (e.code === 'KeyG') { game.flags.god = !game.flags.god; game.toast(game.flags.god ? 'MODE DIEU' : 'MODE NORMAL'); }
      if (e.code === 'KeyR') { fogReveal(game.fog, CENTER, CENTER, CENTER * 1.5); game.toast('CARTE RÉVÉLÉE'); }
    };
  }
  return api;
}
