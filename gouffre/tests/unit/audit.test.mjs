// Regressions for the final audit round: camp layout (trapdoor, locked ground), climbing
// with the grapple, ledge assist, the stuck detector + "Corde de secours", onboarding tips,
// save transfer, economy fixes (chests, Abyss ore), and the renderer / lighting optimisations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TILE_ID, TILES } from '../../src/tiles.js';
import { TILE, SURFACE_Y, WORLDGEN, GRAPPLE, PLAYER, ECONOMY, CHUNK, LAYERS } from '../../src/config.js';
import { World, DIRTY_LOG } from '../../src/world.js';
import { generateWorld } from '../../src/worldgen.js';
import {
  defaultSave, migrateSave, forfeitLoot, exportSave, importSave, upgradeCost, UPGRADE_KEYS,
} from '../../src/meta.js';
import { Coach, TIPS, TIP_KEYS, STUCK } from '../../src/tips.js';
import { Lighting } from '../../src/lighting.js';
import { worldFrom, boxWorld, fakeGame, tick, standOn } from './helpers.mjs';

const T = TILE;
const gens = [12345, 7, 424242].map((s) => generateWorld(s));

// ---------------------------------------------------------------- camp

test('camp: a trapdoor covers the shaft, the camp ground and the headframe beam cannot be mined', () => {
  for (const { world, camp } of gens) {
    const td = camp.trapdoor;
    assert.equal(td.y, SURFACE_Y);
    for (let x = td.x0; x <= td.x1; x++) {
      assert.equal(world.get(x, td.y), TILE_ID.TRAPDOOR, `plank ${x}`);
      assert.equal(world.isLocked(x, td.y), false, 'planks break');
      assert.equal(world.damageTile(x, td.y, 0, 0).tooHard, false);
    }
    // the open shaft is under the planks
    assert.equal(camp.shaft.y0, SURFACE_Y + 1);
    for (let x = WORLDGEN.campFlatX0; x <= WORLDGEN.campFlatX1; x++) {
      if (x >= td.x0 && x <= td.x1) continue;
      assert.equal(world.isLocked(x, SURFACE_Y), true, `camp ground ${x} locked`);
      const r = world.damageTile(x, SURFACE_Y, 999, 99);
      assert.equal(r.tooHard, true); assert.equal(r.locked, true);
      assert.ok(world.isSolid(x, SURFACE_Y), 'still there');
    }
    for (let x = camp.beam.x0; x <= camp.beam.x1; x++) assert.equal(world.damageTile(x, camp.beam.y, 999, 99).locked, true, 'beam locked');
    // the Forge stays reachable: the ground under the blacksmith is locked
    const npcCol = Math.floor(camp.forge.npcX / T);
    for (let x = npcCol - 2; x <= npcCol + 2; x++) assert.equal(world.isLocked(x, SURFACE_Y), true);
    // the row below the camp ground is ordinary rock (the mine starts there)
    assert.equal(world.isLocked(30, SURFACE_Y + 1), false);
  }
});

test('camp: the spawn is on solid ground left of the trapdoor and walking right crosses it', () => {
  const { world, camp } = gens[0];
  const game = fakeGame(world);
  const p = game.player;
  p.reset(camp.spawnX, camp.spawnY);
  tick(game, 5);
  game.input.inject({ x: 1, y: 0 });
  tick(game, 90); // 1.5 s of running right: well past the shaft
  game.input.clearInjected();
  assert.ok(p.cx > (camp.trapdoor.x1 + 1) * T, `crossed the trapdoor (cx ${p.cx.toFixed(0)})`);
  assert.ok(p.feetY <= SURFACE_Y * T + 0.5, 'never fell into the shaft');
});

test('the Forge button logic: a locked camp row means the smith can never be dug out', () => {
  const { world, camp } = generateWorld(99);
  const game = fakeGame(world);
  const p = game.player;
  standOn(game, Math.floor(camp.forge.npcX / T), SURFACE_Y);
  game.input.inject({ x: 0, y: 1, attack: true });
  tick(game, 120);
  game.input.clearInjected();
  assert.ok(p.feetY <= SURFACE_Y * T + 0.5, 'still standing at the Forge');
  assert.ok(game.events.toasts.includes('Impossible ici'), 'says why');
});

// ---------------------------------------------------------------- climbing

function shaftWorld(depth = 10, width = 1) {
  // a closed room: a vertical shaft `width` wide and `depth` deep opening onto a ledge row
  const W = 20, H = depth + 8;
  const rows = [];
  const x0 = 9, x1 = x0 + width - 1;
  for (let y = 0; y < H; y++) {
    let r = '';
    for (let x = 0; x < W; x++) {
      const border = x === 0 || x === W - 1 || y === 0 || y === H - 1;
      const air = (y >= 1 && y <= 4) || (y > 4 && y <= 4 + depth && x >= x0 && x <= x1);
      r += border ? '#' : air ? '.' : '#';
    }
    rows.push(r);
  }
  return { world: worldFrom(rows), x0, floorRow: 5 + depth, topFeet: 5 * T };
}

/** Mash Grappin (every 20 ticks) with the stick at (x, y); returns ticks until the hero stands on top. */
function mashClimb(game, stick, maxTicks = 60 * 30, topFeet = 5 * T) {
  const p = game.player;
  for (let t = 0; t < maxTicks; t++) {
    if (t % 20 === 5) game.input.tap('grapple');
    game.input.inject(typeof stick === 'function' ? stick(p) : stick);
    tick(game, 1);
    if (p.onGround && p.feetY <= topFeet + 0.5) return t;
  }
  return -1;
}

test('climbing: mashing Grappin in a deep 1-wide hole climbs out (no hidden Saut chain needed)', () => {
  for (const stick of [{ x: 0, y: -1 }, { x: 0, y: 0 }]) {
    const { world, x0, floorRow, topFeet } = shaftWorld(10, 1);
    const game = fakeGame(world);
    const p = game.player;
    p.reset(x0 * T + 8, floorRow * T);
    tick(game, 10);
    // at the top, push toward the ledge (ledge assist lands the hero)
    const t = mashClimb(game, (pl) => (pl.feetY < topFeet + 20 ? { x: 1, y: stick.y } : stick), 60 * 30, topFeet);
    assert.ok(t > 0, `climbed out (stick ${stick.x},${stick.y}); stuck at y ${p.feetY.toFixed(0)}`);
    assert.ok(t < 60 * 15, `in ${(t / 60).toFixed(1)} s`);
  }
});

test('climbing: a Grappin press while attached climbs when hanging, lets go during a real swing', () => {
  const rows = [];
  for (let y = 0; y < 24; y++) { let r = ''; for (let x = 0; x < 40; x++) r += x === 0 || x === 39 || y === 0 || y === 23 ? '#' : '.'; rows.push(r); }
  // hanging still on a short rope -> climb (hop + re-fire at the top of the hop)
  let game = fakeGame(worldFrom(rows));
  let p = game.player;
  p.reset(20 * T, 3 * T);
  game.input.inject({ x: 0, y: -1 });
  game.input.tap('grapple');
  for (let i = 0; i < 40 && p.grapple.state !== 'attached'; i++) tick(game, 1);
  tick(game, 40);
  game.input.clearInjected();
  assert.equal(p.grapple.state, 'attached');
  assert.ok(p.grapple.wantsClimb());
  game.input.tap('grapple');
  tick(game, 1);
  assert.ok(p.grapple.state === 'retracting' || p.grapple.state === 'idle', `hopped off (${p.grapple.state})`);
  assert.ok(p.vy < -150, 'with the Saut boost');
  assert.ok(p.grapple.refireT > 0, 're-fire pending');
  for (let i = 0; i < 40 && (p.grapple.state === 'retracting' || p.grapple.state === 'idle'); i++) tick(game, 1);
  assert.ok(p.grapple.state === 'flying' || p.grapple.state === 'attached', 're-fired near the top of the hop');

  // a fast swing on a long rope -> plain release
  game = fakeGame(worldFrom(rows));
  p = game.player;
  p.stats.grappleRange = 200;
  p.reset(20 * T, 14 * T);
  game.input.inject({ x: 0, y: -1 });
  game.input.tap('grapple');
  for (let i = 0; i < 40 && p.grapple.state !== 'attached'; i++) tick(game, 1);
  game.input.inject({ x: 1, y: 0 });
  tick(game, 45);
  assert.equal(p.grapple.state, 'attached');
  assert.ok(p.grapple.length > GRAPPLE.climbMaxLength);
  assert.ok(Math.hypot(p.vx, p.vy) >= GRAPPLE.climbStillSpeed, 'swinging');
  game.input.inject({ x: 0, y: 0 });
  game.input.tap('grapple');
  tick(game, 1);
  assert.equal(p.grapple.state, 'retracting');
  assert.equal(p.grapple.refireT, 0, 'no re-fire: it was a release');
});

test('ledge assist: a ledge top a few px above the feet is climbed, a higher one is not', () => {
  const rows = [
    '##########',
    '#........#',
    '#........#',
    '#........#',
    '#....#####',
    '#....#####',
    '##########',
  ];
  for (const [below, expect] of [[6, true], [PLAYER.ledgeAssist + 6, false]]) {
    const game = fakeGame(worldFrom(rows));
    const p = game.player;
    // airborne beside the wall of column 5, feet `below` px under its top (y = 4 * 16), falling slowly
    p.reset(5 * T - p.w / 2 - 0.5, 4 * T + below);
    p.vy = 20; p.onGround = false;
    game.input.inject({ x: 1, y: 0 });
    tick(game, 30);
    const onLedge = p.onGround && Math.abs(p.feetY - 4 * T) < 0.6 && p.cx > 5 * T;
    assert.equal(onLedge, expect, `feet ${below} px below the ledge top -> ${onLedge ? 'on it' : 'not on it'}`);
  }
});

// ---------------------------------------------------------------- stuck detector + rescue

function coachGame(world) {
  const game = fakeGame(world);
  game.save = defaultSave();
  game.run = { over: false, bag: {}, bagCount: 0, bagValue: 0, gold: 0, relics: [], bestDepth: 0 };
  game.gen = { camp: { bankY: 2 * T, trapdoor: { x0: 30, x1: 32, y: 2 } } };
  game.enemies = { damageInBox: () => 0, gatesSealed: false };
  const tips = [];
  game.hud = { tip: (a, b, o) => tips.push(o.key), cancelTip() {} };
  game.persist = () => true;
  game.coach = new Coach(game);
  return { game, tips };
}

test('stuck detector: no net climb for 45 s despite jumps offers the "Corde de secours"; climbing resets it', () => {
  // a sealed pit 5 m under the "surface" (SURFACE_Y rows of rock above)
  const rows = [];
  for (let y = 0; y < SURFACE_Y + 12; y++) { let r = ''; for (let x = 0; x < 12; x++) r += y >= SURFACE_Y + 4 && y <= SURFACE_Y + 6 && x >= 4 && x <= 7 ? '.' : 'X'; rows.push(r); }
  const { game, tips } = coachGame(worldFrom(rows));
  game.save.settings.tips = true;
  for (const k of TIP_KEYS) game.save.tips[k] = 1; // only the stuck messages can show
  const p = game.player;
  standOn(game, 5, SURFACE_Y + 7);
  assert.ok(p.depth >= STUCK.minDepth);
  const step = (sec, jumpEvery = 1.5) => {
    for (let i = 0; i < sec * 60; i++) {
      if (i % Math.round(jumpEvery * 60) === 0) game.input.tap('jump');
      game.input.beginTick(); p.update(1 / 60); game.coach.update(1 / 60); game.input.endTick();
    }
  };
  step(STUCK.hintAfter + 1);
  assert.ok(tips.includes('unstuck'), 'climbing reminder after 20 s');
  assert.equal(game.coach.canRescue, false);
  step(STUCK.rescueAfter - STUCK.hintAfter);
  assert.equal(game.coach.canRescue, true, 'rescue offered');
  assert.ok(tips.includes('rescue'));
  // climbing out (teleported 3 tiles up) is progress: the offer goes away
  p.teleport(p.cx, p.feetY - 3 * T);
  game.coach.update(1 / 60);
  assert.equal(game.coach.canRescue, false);
});

test('"Corde de secours" costs the unbanked loot (minus insurance), keeps relics, counts no death', () => {
  const save = defaultSave();
  save.gold = 100;
  const run = { bag: { copper: 3, iron: 2 }, bagCount: 5, bagValue: 14, gold: 20, relics: ['magnet'], bestDepth: 30, banked: 0 };
  const s = forfeitLoot(save, run, { oreMul: 1, insurance: 0.25 });
  assert.equal(s.oreValue, 14); assert.equal(s.gold, 20);
  assert.equal(s.kept, Math.floor(34 * 0.25));
  assert.equal(s.lostValue, 34 - s.kept);
  assert.equal(save.gold, 100 + s.kept);
  assert.equal(save.stats.deaths, 0);
  assert.equal(save.stats.rescues, 1);
  assert.equal(run.bagCount, 0); assert.equal(run.gold, 0); assert.deepEqual(run.bag, {});
  assert.deepEqual(run.relics, ['magnet'], 'relics kept');
});

// ---------------------------------------------------------------- onboarding tips

test('onboarding: tips show in order, once each (remembered in the save), and respect the setting', () => {
  const { world, camp } = gens[0];
  const { game, tips } = coachGame(world);
  game.gen = generateWorld(12345);
  game.world = game.gen.world;
  const p = game.player;
  p.reset(game.gen.camp.spawnX, game.gen.camp.spawnY);
  tick(game, 2);
  game.coach.update(1 / 60);
  assert.deepEqual(tips, ['move']);
  assert.equal(game.save.tips.move, 1);
  // standing on the trapdoor -> dig tip
  p.teleport((camp.trapdoor.x0 + 1) * T + 8, SURFACE_Y * T);
  tick(game, 2);
  game.coach.update(1 / 60);
  assert.deepEqual(tips, ['move', 'dig']);
  // first rope catch -> climb tip (and the grapple tip is no longer needed)
  game.coach.onAttach();
  assert.equal(tips.at(-1), 'climb');
  assert.equal(game.save.tips.grapple, 1);
  game.coach.onOre();
  assert.equal(tips.at(-1), 'bank');
  game.coach.onBank();
  for (let i = 0; i < 200; i++) game.coach.update(1 / 60);
  assert.equal(tips.at(-1), 'forge');
  const n = tips.length;
  // never again
  game.coach.onAttach(); game.coach.onOre(); game.coach.onBank();
  for (let i = 0; i < 200; i++) game.coach.update(1 / 60);
  assert.equal(tips.length, n);
  // a fresh save with tips turned off shows nothing
  const off = coachGame(world);
  off.game.save.settings.tips = false;
  off.game.gen = game.gen;
  off.game.player.reset(game.gen.camp.spawnX, game.gen.camp.spawnY);
  off.game.coach.update(1 / 60);
  assert.deepEqual(off.tips, []);
});

test('onboarding: every tip line fits the narrowest landscape view (iPhone SE: 378 internal px) with its panel padding', async () => {
  const { measureText } = await import('../../src/hud.js');
  for (const def of Object.values(TIPS)) {
    for (const lines of Object.values(def)) for (const l of lines) assert.ok(measureText(l) <= 378 - 12 - 16, `${measureText(l)} px: ${l}`);
  }
});

test('save: tips / rescues / the Astuces setting migrate; transfer codes round-trip and reject junk', () => {
  const m = migrateSave({ gold: 5, tips: { move: true, dig: 0, 'bad key!': 1 }, settings: { muted: true } });
  assert.deepEqual(m.tips, { move: 1 });
  assert.equal(m.settings.tips, true);
  assert.equal(m.stats.rescues, 0);
  assert.equal(migrateSave({ settings: { tips: false } }).settings.tips, false);
  const s = defaultSave();
  s.gold = 4321; s.upgrades.pick = 3; s.stats.deaths = 7; s.tips = { move: 1 };
  const code = exportSave(s);
  assert.match(code, /^GOUFFRE1:[A-Za-z0-9+/=]+$/);
  const back = importSave('  ' + code.slice(0, 20) + '\n' + code.slice(20) + ' ');
  assert.equal(back.gold, 4321); assert.equal(back.upgrades.pick, 3); assert.equal(back.stats.deaths, 7);
  for (const junk of ['', 'hello', 'GOUFFRE1:', 'GOUFFRE1:!!!', 'GOUFFRE1:' + btoa('[1,2]'), 'GOUFFRE1:' + btoa('{"a":1}'), null]) assert.equal(importSave(junk), null, String(junk));
});

// ---------------------------------------------------------------- economy fixes

test('economy: the first return can always buy something; chests are worth about a minute of digging', () => {
  const cheapest = Math.min(...UPGRADE_KEYS.map((k) => upgradeCost(k, 0)));
  assert.ok(cheapest <= 10, `cheapest first upgrade ${cheapest} <= a full starting bag of coal (10)`);
  // gold chests: a layer-2 chest (d 70) is worth ~20-30 gold (it was 61), a layer-4 one < 70
  const chest = (d) => Math.round(ECONOMY.chestGoldBase * (1 + d * ECONOMY.chestGoldPerM));
  assert.ok(chest(70) >= 18 && chest(70) <= 32, `d70 chest ${chest(70)}`);
  assert.ok(chest(220) < 70, `d220 chest ${chest(220)}`);
});

test('economy: the Abyss holds more ore gold than the crystal caves (deeper = richer)', () => {
  const per = [0, 0, 0, 0];
  for (const { world } of gens) {
    for (let ty = SURFACE_Y; ty < world.h; ty++) for (let tx = 0; tx < world.w; tx++) {
      const def = TILES[world.types[ty * world.w + tx]];
      if (!def.ore) continue;
      const d = ty - SURFACE_Y;
      const L = LAYERS.findIndex((l) => d >= l.d0 && d <= l.d1);
      if (L >= 0 && L < 4) per[L] += def.value;
    }
  }
  assert.ok(per[3] > per[2] * 1.5, `layer 4 ${per[3]} vs layer 3 ${per[2]}`);
  assert.ok(per[2] > per[1] && per[1] > per[0]);
});

// ---------------------------------------------------------------- renderer + lighting

/** Minimal canvas stub for the renderer's chunk cache (no DOM in node). */
function stubCanvas() {
  const ops = { clear: 0, draw: 0 };
  const ctx = {
    ops, imageSmoothingEnabled: false, fillStyle: '', globalAlpha: 1,
    clearRect() { ops.clear++; }, drawImage() { ops.draw++; }, fillRect() {}, save() {}, restore() {}, translate() {}, scale() {},
  };
  return { width: 0, height: 0, style: {}, getContext: () => ctx, ctx };
}

test('renderer: a broken tile patches its 3×3 cells in the cached chunks instead of rebuilding them', async () => {
  const prevDoc = globalThis.document;
  globalThis.document = { createElement: () => stubCanvas() };
  try {
    const { Renderer } = await import('../../src/render.js');
    const world = boxWorld(40, 40);
    for (let y = 5; y < 35; y++) for (let x = 5; x < 35; x++) world.setRaw(x, y, TILE_ID.STONE);
    world.finalize();
    const game = { world, flags: {}, camera: { viewW: 0, viewH: 0 } };
    const r = new Renderer(game, stubCanvas());
    r.frameNo = 1;
    r._syncDirty(world); // first frame of a world: remembers the log position
    for (let ky = 0; ky < 2; ky++) for (let kx = 0; kx < 2; kx++) r._chunk(kx, ky);
    assert.equal(r.chunkBuilds, 4);
    // two tiles in the middle of chunk (0,0), one on the corner shared by the four chunks
    world.damageTile(8, 8, 99, 0);
    world.damageTile(9, 8, 99, 0);
    world.damageTile(CHUNK, CHUNK, 99, 0);
    r._syncDirty(world);
    for (let ky = 0; ky < 2; ky++) for (let kx = 0; kx < 2; kx++) r._chunk(kx, ky);
    assert.equal(r.chunkBuilds, 4, 'no full rebuild');
    assert.equal(r.cellPatches, 2 + 4, 'one patch per middle tile, one per chunk around the corner');
    // log overflow: the touched chunks rebuild in full, still correct
    for (let i = 0; i <= DIRTY_LOG; i++) world.set(20, 20, i % 2 ? TILE_ID.STONE : TILE_ID.AIR); // every write changes the tile
    r._syncDirty(world);
    r._chunk(1, 1);
    assert.equal(r.chunkBuilds, 5, 'rebuilt after the log overflowed');
    // a new world never reuses the old one's cache
    r.invalidateAll();
    assert.equal(r.chunks.size, 0);
  } finally {
    if (prevDoc === undefined) delete globalThis.document; else globalThis.document = prevDoc;
  }
});

test('lighting: the precomputed splat kernel matches the old per-cell formula and tracks its box', () => {
  const game = fakeGame(boxWorld(30, 30));
  game.player.reset(15 * T, 15 * T);
  const L = new Lighting(game);
  L._ensure(20, 20);
  L.gr.fill(0); L.gg.fill(0); L.gb.fill(0);
  L.gx0 = 20; L.gy0 = 20; L.gx1 = -1; L.gy1 = -1;
  const c = [200, 100, 50], e = 0.8;
  L._splat(1, 10, e, c); // clipped on the left edge
  for (let dj = -3; dj <= 3; dj++) {
    for (let di = -3; di <= 3; di++) {
      const x = 1 + di, y = 10 + dj;
      if (x < 0) continue;
      const f = e * Math.max(0, 1 - Math.hypot(di, dj) / 3.5) * 0.32;
      assert.ok(Math.abs(L.gr[y * 20 + x] - c[0] * f) < 1e-3, `cell ${di},${dj}`);
    }
  }
  assert.deepEqual([L.gx0, L.gy0, L.gx1, L.gy1], [0, 7, 4, 13]);
});
