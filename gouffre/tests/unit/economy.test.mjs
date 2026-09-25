// Rogue-lite economy & meta loop (DESIGN.md §2, §4, §7): save / migration, upgrades,
// banking & insurance math, backpack, chests, relic effects, economy balance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSave, migrateSave, loadSave, loadSaveEx, saveGame, clearSave, storageAvailable,
  UPGRADES, UPGRADE_KEYS, upgradeCost, canBuy, buyUpgrade, applyUpgrades,
  RELICS, RELIC_KEYS, rollRelic, bagValue, bankLoot, settleDeath, clearLoot,
} from '../../src/meta.js';
import { PLAYER, GRAPPLE, DROPS, ECONOMY, SAVE_KEY, MUTE_KEY, TILE, SURFACE_Y } from '../../src/config.js';
import { TILE_ID, TILE_BY_KEY } from '../../src/tiles.js';
import { EntityManager } from '../../src/entities.js';
import { EnemyManager } from '../../src/enemies.js';
import { mulberry32 } from '../../src/rng.js';
import { runEconomy } from '../../tools/economy.mjs';
import { boxWorld, worldFrom, fakeGame, standOn, tick } from './helpers.mjs';

const DT = 1 / 60;

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

function newRun() {
  return { gold: 0, bag: {}, bagCount: 0, bagValue: 0, relics: [], bestDepth: 0, kills: 0, banked: 0, ore: 0, chests: 0, time: 0, ngPlus: 0 };
}

/** Fake game with real EntityManager (+ EnemyManager) and a run. */
function lootGame(world, save = defaultSave()) {
  const game = fakeGame(world);
  game.camera = { x: 0, y: 0, viewW: 480, viewH: 216, shake() { game.events.shakes++; } };
  game.lighting = { addLight() {} };
  game.hud = { toast() {}, banner() {}, flashDamage() {}, flash() {} };
  game.save = save;
  game.run = newRun();
  game.gen = { seed: 3, arena: null };
  game.refreshStats = () => applyUpgrades(game.player, game.save, game.run.relics);
  game.entities = new EntityManager(game);
  game.enemies = new EnemyManager(game);
  game.refreshStats();
  return game;
}

function runLoot(game, seconds) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) { game.entities.update(DT); game.time += DT; }
}

// ------------------------------------------------------------------ save

test('save: v1 (step 1 stub) migrates to v2 (NG+ level, new stats and settings)', () => {
  const v1 = { version: 1, gold: 77, upgrades: { pick: 1, bag: 2 }, stats: { bestDepth: 40, deaths: 3, totalGold: 120, victories: 1, runs: 5 }, settings: { muted: true }, ngPlus: true };
  const m = migrateSave(v1);
  assert.equal(m.version, 2);
  assert.equal(m.gold, 77);
  assert.equal(m.ngPlus, 1, 'boolean NG+ becomes level 1');
  assert.equal(m.upgrades.pick, 1); assert.equal(m.upgrades.bag, 2); assert.equal(m.upgrades.insurance, 0);
  assert.equal(m.stats.deaths, 3); assert.equal(m.stats.trips, 0); assert.equal(m.stats.playTime, 0);
  assert.equal(m.settings.muted, true); assert.equal(m.settings.shake, true);
  assert.equal(migrateSave({ ngPlus: false }).ngPlus, 0);
  assert.equal(migrateSave({ ngPlus: 3 }).ngPlus, 3);
});

test('save: garbage values are sanitised, unknown upgrades dropped', () => {
  assert.deepEqual(migrateSave([1, 2]), defaultSave());
  assert.deepEqual(migrateSave('nope'), defaultSave());
  const m = migrateSave({ gold: -40, upgrades: 'x', stats: null, settings: [], ngPlus: 'abc', extra: 1 });
  assert.equal(m.gold, 0);
  assert.deepEqual(m.upgrades, defaultSave().upgrades);
  assert.equal(m.stats.deaths, 0);
  assert.equal(m.ngPlus, 0);
  const n = migrateSave({ upgrades: { pick: 2.7, laser: 4 }, stats: { deaths: '5', kills: NaN } });
  assert.equal(n.upgrades.pick, 2);
  assert.equal(n.upgrades.laser, undefined);
  assert.equal(n.stats.deaths, 5); assert.equal(n.stats.kills, 0);
});

test('save: corrupted JSON keeps a backup and starts fresh; storage unavailable is tolerated', () => {
  const st = memStorage({ [SAVE_KEY]: '{"gold": 12,,' });
  const r = loadSaveEx(st);
  assert.equal(r.status, 'corrupt');
  assert.deepEqual(r.save, defaultSave());
  assert.equal(st.getItem(SAVE_KEY + '.corrupt'), '{"gold": 12,,', 'raw text kept for recovery');
  assert.equal(loadSaveEx(memStorage()).status, 'new');
  const good = memStorage();
  const s = defaultSave(); s.gold = 5;
  saveGame(s, good);
  assert.equal(loadSaveEx(good).status, 'ok');
  const denied = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); } };
  assert.equal(loadSaveEx(denied).status, 'unavailable');
  assert.equal(storageAvailable(denied), false);
  assert.equal(storageAvailable(memStorage()), true);
  assert.equal(saveGame(s, denied), false);
  assert.deepEqual(clearSave(denied), defaultSave(), 'erasing never throws');
});

test('save: the legacy mute key is honoured on a first launch; clearSave erases', () => {
  const st = memStorage({ [MUTE_KEY]: '1' });
  assert.equal(loadSave(st).settings.muted, true);
  const s = defaultSave(); s.gold = 99;
  saveGame(s, st);
  assert.equal(loadSave(st).gold, 99);
  clearSave(st);
  assert.equal(st.getItem(SAVE_KEY), null);
});

// ------------------------------------------------------------------ upgrades

test('upgrades: 8 upgrades, strictly increasing costs, Infinity when maxed', () => {
  assert.deepEqual(UPGRADE_KEYS, ['pick', 'vitality', 'armor', 'grapple', 'bag', 'lantern', 'boots', 'insurance']);
  for (const k of UPGRADE_KEYS) {
    const u = UPGRADES[k];
    assert.equal(u.costs.length, u.max, `${k}: one cost per level`);
    for (let lv = 1; lv < u.max; lv++) assert.ok(upgradeCost(k, lv) > upgradeCost(k, lv - 1), `${k} cost grows`);
    assert.equal(upgradeCost(k, u.max), Infinity);
    for (let lv = 0; lv <= u.max; lv++) assert.equal(typeof u.effect(lv), 'string');
  }
  assert.equal(UPGRADES.insurance.max, 2);
  // the cheapest first level is affordable after one short trip (~25 gold)
  assert.ok(Math.min(...UPGRADE_KEYS.map((k) => upgradeCost(k, 0))) <= 15);
});

test('upgrades: every level changes the right stat, in the right direction', () => {
  const game = fakeGame(boxWorld(8, 8));
  const at = (k, lv) => { const s = defaultSave(); s.upgrades[k] = lv; return applyUpgrades(game.player, s); };
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((lv) => at('pick', lv).pickTier), [0, 1, 2, 2, 3, 3], 'pick tiers');
  for (let lv = 1; lv <= 5; lv++) {
    assert.ok(at('pick', lv).pickDamage > at('pick', lv - 1).pickDamage);
    assert.equal(at('pick', lv).attackDamage, 10 + 4 * lv, 'enemy balance assumes 10 + 4 per level');
    assert.ok(at('vitality', lv).maxHp > at('vitality', lv - 1).maxHp);
    assert.ok(at('armor', lv).armor > at('armor', lv - 1).armor);
    assert.ok(at('bag', lv).bagCapacity > at('bag', lv - 1).bagCapacity);
  }
  for (let lv = 1; lv <= 4; lv++) {
    assert.ok(at('grapple', lv).grappleRange > at('grapple', lv - 1).grappleRange);
    assert.ok(at('grapple', lv).reelSpeed > at('grapple', lv - 1).reelSpeed);
    assert.ok(at('lantern', lv).lanternRadius > at('lantern', lv - 1).lanternRadius);
  }
  assert.equal(at('grapple', 4).grappleRange, GRAPPLE.maxRange);
  for (let lv = 1; lv <= 3; lv++) {
    assert.ok(at('boots', lv).maxSpeed > at('boots', lv - 1).maxSpeed);
    assert.ok(at('boots', lv).jumpVel > at('boots', lv - 1).jumpVel);
  }
  assert.deepEqual([0, 1, 2].map((lv) => at('insurance', lv).insurance), [0, 0.25, 0.5]);
  assert.equal(at('bag', 0).bagCapacity, PLAYER.bagCapacity);
  assert.equal(at('vitality', 0).maxHp, PLAYER.maxHp);
});

test('upgrades: armour reduces the damage taken by player.takeDamage', () => {
  const game = fakeGame(boxWorld(12, 8));
  standOn(game, 5, 7);
  const s = defaultSave();
  const hit = (lv) => {
    s.upgrades.armor = lv;
    applyUpgrades(game.player, s);
    const p = game.player;
    p.hp = p.stats.maxHp; p.iframes = 0;
    p.takeDamage(40, null, { knockback: false });
    return p.stats.maxHp - p.hp;
  };
  assert.equal(hit(0), 40);
  assert.equal(hit(5), Math.round(40 * (1 - 0.35)));
});

test('buyUpgrade spends banked gold, refuses when poor or maxed', () => {
  const s = defaultSave();
  s.gold = upgradeCost('bag', 0) - 1;
  assert.deepEqual(canBuy(s, 'bag'), { ok: false, reason: 'gold', cost: upgradeCost('bag', 0) });
  assert.equal(buyUpgrade(s, 'bag').ok, false);
  s.gold += 1;
  const r = buyUpgrade(s, 'bag');
  assert.equal(r.ok, true); assert.equal(r.level, 1); assert.equal(s.gold, 0);
  assert.equal(s.upgrades.bag, 1);
  assert.equal(s.stats.spent, upgradeCost('bag', 0));
  s.upgrades.insurance = 2; s.gold = 1e6;
  assert.equal(buyUpgrade(s, 'insurance').reason, 'max');
  assert.equal(s.gold, 1e6);
});

// ------------------------------------------------------------------ banking & death

test('banking: bag value (× Avarice) + run gold become banked gold; stats and run updated', () => {
  const s = defaultSave(); s.gold = 10;
  const run = newRun();
  run.bag = { coal: 3, silver: 2 }; run.bagCount = 5; run.gold = 13; run.bestDepth = 62;
  assert.equal(bagValue(run.bag), 3 * 1 + 2 * 7);
  const r = bankLoot(s, run, { oreMul: 1 });
  assert.equal(r.oreValue, 17); assert.equal(r.gold, 13); assert.equal(r.total, 30);
  assert.equal(r.items[0].key, 'silver', 'most valuable first');
  assert.equal(s.gold, 40); assert.equal(s.stats.totalGold, 30); assert.equal(s.stats.trips, 1);
  assert.equal(s.stats.bestDepth, 62); assert.equal(s.stats.bestTrip, 30);
  assert.deepEqual(run.bag, {}); assert.equal(run.bagCount, 0); assert.equal(run.gold, 0);
  assert.equal(run.banked, 30); assert.equal(run.ore, 5);
  // Avarice relic: ore × 1.3 (rounded once)
  run.bag = { ruby: 3 }; run.bagCount = 3;
  assert.equal(bankLoot(s, run, { oreMul: 1.3 }).oreValue, Math.round(90 * 1.3));
  // an empty bank is not a trip
  const trips = s.stats.trips;
  assert.equal(bankLoot(s, run, {}).total, 0);
  assert.equal(s.stats.trips, trips);
});

test('death: loot lost except the Bourse de secours share, which is banked', () => {
  for (const [ins, kept] of [[0, 0], [0.25, 12], [0.5, 25]]) {
    const s = defaultSave(); s.gold = 100;
    const run = newRun();
    run.bag = { iron: 10 }; run.bagCount = 10; run.gold = 10; run.bestDepth = 88; run.relics = ['magnet'];
    const d = settleDeath(s, run, { insurance: ins }, { depth: 80, cause: 'skeleton' });
    assert.equal(d.kept, kept, `insurance ${ins}`);
    assert.equal(d.oreValue, 40); assert.equal(d.gold, 10);
    assert.equal(d.lostValue, 50 - kept);
    assert.equal(s.gold, 100 + kept);
    assert.equal(s.stats.deaths, 1); assert.equal(s.stats.bestDepth, 88);
    assert.equal(d.depth, 80); assert.equal(d.cause, 'skeleton');
    assert.deepEqual(d.relics, ['magnet'], 'relics listed as lost');
    assert.equal(d.bankGold, s.gold);
  }
  const run = newRun(); run.bag = { coal: 1 }; run.bagCount = 1; run.bagValue = 1; run.gold = 4;
  clearLoot(run);
  assert.deepEqual([run.bag, run.bagCount, run.gold], [{}, 0, 0]);
});

// ------------------------------------------------------------------ backpack

test('ore tiles pop ore chunks that fill the backpack up to its capacity', () => {
  const game = lootGame(boxWorld(30, 12));
  const p = game.player;
  standOn(game, 10, 11);
  game.entities.onTileBroken(11, 10, TILE_ID.COPPER);
  const chunk = game.entities.pickups.find((q) => q.active);
  assert.ok(chunk && chunk.ore === 'copper' && chunk.value === TILE_BY_KEY.copper.value);
  runLoot(game, 1.5);
  assert.deepEqual(game.run.bag, { copper: 1 });
  assert.equal(game.run.bagCount, 1);
  assert.equal(game.run.bagValue, 2);
  assert.ok(game.events.audio.includes('pickup'));
  // fill it
  const cap = p.stats.bagCapacity;
  for (let i = 1; i < cap; i++) game.entities.spawnOre(p.cx + 8, p.cy, 'coal');
  runLoot(game, 2);
  assert.equal(game.run.bagCount, cap);
  assert.ok(game.events.toasts.includes('Sac plein !'), 'full toast when the last slot fills');
  // one more: stays on the ground, never magnetised, toast throttled
  const n0 = game.events.toasts.filter((t) => t === 'Sac plein !').length;
  const extra = game.entities.spawnOre(p.cx + 40, p.cy, 'ruby');
  runLoot(game, 1.2);
  assert.equal(extra.active, true, 'left on the ground');
  assert.equal(extra.magnet, false);
  assert.equal(game.run.bagCount, cap);
  p.x = extra.x - p.w / 2; // walk onto it
  runLoot(game, 0.5);
  assert.equal(extra.active, true);
  assert.equal(game.events.toasts.filter((t) => t === 'Sac plein !').length, n0 + 1, 'touching it says "Sac plein !"');
  runLoot(game, 0.5);
  assert.equal(game.events.toasts.filter((t) => t === 'Sac plein !').length, n0 + 1, 'throttled');
  // a bigger bag (upgrade) takes it
  game.save.upgrades.bag = 1; game.refreshStats();
  runLoot(game, 1);
  assert.equal(extra.active, false);
  assert.equal(game.run.bag.ruby, 1);
});

test('ore chunks outlive coins, far pickups sleep', () => {
  const game = lootGame(boxWorld(200, 12));
  standOn(game, 3, 11);
  const ore = game.entities.spawnOre(150 * TILE, 5 * TILE, 'gold');
  game.entities.spawnCoins(150 * TILE, 5 * TILE, 1, { count: 1 });
  const coin = game.entities.pickups.find((q) => q.active && q.kind === 1);
  runLoot(game, 2);
  assert.equal(ore.t, 0, 'far from the camera: asleep');
  game.camera.x = 150 * TILE - 240;
  runLoot(game, DROPS.life + 1);
  assert.equal(coin.active, false);
  assert.equal(ore.active, true, 'ore waits for the player (bag full -> come back later)');
  assert.ok(DROPS.oreLife > DROPS.life);
});

// ------------------------------------------------------------------ chests & relics

function chestGame(kind, layer = 1) {
  const game = lootGame(boxWorld(30, 12));
  standOn(game, 10, 11);
  game.entities.reset({ seed: 11, chests: [{ tx: 12, ty: 10, x: 12 * TILE + 8, y: 11 * TILE, kind, layer, depth: 60, opened: false }] });
  return game;
}

test('chests: "Ouvrir" near a closed chest; a relic chest grants a relic and refreshes stats', () => {
  const game = chestGame('relic', 3);
  const p = game.player;
  assert.equal(game.entities.interactionAt(p), null, 'too far');
  p.x = 12 * TILE + 8 - 12 - p.w / 2;
  const inter = game.entities.interactionAt(p);
  assert.equal(inter && inter.label, 'Ouvrir');
  inter.use();
  assert.equal(game.entities.chests[0].opened, true);
  assert.equal(game.run.relics.length, 1);
  assert.ok(RELICS[game.run.relics[0]]);
  assert.equal(game.run.chests, 1);
  assert.ok(game.events.audio.includes('chest'));
  assert.ok(game.events.toasts.some((t) => t.startsWith('Relique : ')));
  assert.equal(game.entities.interactionAt(p), null, 'opened chests are no longer interactable');
});

test('chests: a gold chest bursts into coins worth base × (1 + depth / 25); a strike opens it', () => {
  const game = chestGame('gold');
  const p = game.player;
  p.x = 12 * TILE + 8 - 16 - p.w / 2; p.facing = 1;
  const n = game.entities.hitChests(p.strikeBox('side'));
  assert.equal(n, 1);
  const coins = game.entities.pickups.filter((q) => q.active && q.kind === 1);
  const value = Math.round(ECONOMY.chestGoldBase * (1 + 60 * ECONOMY.chestGoldPerM));
  assert.equal(coins.reduce((s, q) => s + q.value, 0), value);
  assert.equal(game.run.relics.length, 0);
});

test('relics: weighted roll never gives a duplicate, deeper chests favour rare relics', () => {
  assert.ok(RELIC_KEYS.length >= 8);
  const rnd = mulberry32(99);
  const owned = [];
  for (let i = 0; i < RELIC_KEYS.length; i++) { const k = rollRelic(rnd, 2, owned); assert.ok(k && !owned.includes(k)); owned.push(k); }
  assert.equal(rollRelic(rnd, 2, owned), null, 'all owned -> gold instead');
  const rareShare = (layer) => { let n = 0; for (let i = 0; i < 4000; i++) if (RELICS[rollRelic(rnd, layer)].rarity === 3) n++; return n / 4000; };
  assert.ok(rareShare(3) > rareShare(0) * 2, 'rare relics much likelier in the abyss');
});

test('relics: stat effects stack on top of the Forge upgrades', () => {
  const game = fakeGame(boxWorld(8, 8));
  const s = defaultSave(); s.upgrades.pick = 1;
  const base = applyUpgrades(game.player, s);
  const w = (k) => applyUpgrades(game.player, s, [k]);
  assert.equal(w('double_jump').airJumps, 1);
  assert.ok(w('magnet').magnetMul > 2);
  assert.ok(w('vampire').killHeal >= 3);
  assert.equal(w('fire_pick').attackDamage, Math.round(base.attackDamage * 1.4));
  assert.ok(Math.abs(w('fire_pick').pickDamage - base.pickDamage * 1.4) < 1e-9);
  assert.ok(Math.abs(w('stone_skin').armor - (base.armor + 0.15)) < 1e-9);
  assert.equal(w('feather').glide, true);
  const q = w('quick_hook');
  assert.ok(q.hookSpeed > GRAPPLE.hookSpeed && q.grappleRange === base.grappleRange + 40 && q.reelSpeed > base.reelSpeed);
  assert.equal(w('spectral_lantern').lanternRadius, base.lanternRadius + 4);
  assert.ok(Math.abs(w('frenzy').attackCooldown - base.attackCooldown * 0.75) < 1e-9);
  assert.ok(w('greed').oreMul > 1 && w('greed').goldMul > 1);
  assert.ok(w('troll_heart').regen > 0);
  // unknown keys are ignored, and without relics nothing changes
  assert.deepEqual(applyUpgrades(game.player, s, ['nope']), base);
});

test('relic Double saut: a second jump in mid-air, refilled on landing', () => {
  const run = (relics) => {
    const game = fakeGame(boxWorld(12, 20));
    standOn(game, 5, 19);
    applyUpgrades(game.player, defaultSave(), relics);
    const p = game.player;
    game.input.inject({ jump: true }); tick(game, 31); // one press: rising, then falling
    game.input.inject({ jump: false }); tick(game, 1);
    const vyBefore = p.vy;
    game.input.tap('jump'); tick(game, 1);
    return { before: vyBefore, after: p.vy, left: p.airJumpsLeft };
  };
  const without = run([]);
  assert.ok(without.after > -50, 'no air jump without the relic');
  const withIt = run(['double_jump']);
  assert.ok(withIt.after < -PLAYER.jumpVel * 0.8, `air jump launched (vy ${withIt.after.toFixed(0)})`);
  assert.equal(withIt.left, 0);
});

test('relic Plume: holding jump while falling glides slowly', () => {
  const fall = (relics) => {
    const game = fakeGame(boxWorld(12, 40));
    applyUpgrades(game.player, defaultSave(), relics);
    game.player.reset(5 * TILE + 8, 6 * TILE);
    game.input.inject({ jump: true });
    tick(game, 60);
    return game.player.vy;
  };
  assert.ok(fall([]) > 300, 'normal fall');
  assert.ok(Math.abs(fall(['feather']) - PLAYER.glideFall) < 1, 'capped at the glide speed');
});

test('relic Aimant pulls loot from farther; Avarice boosts coins', () => {
  const pull = (relics) => {
    const game = lootGame(boxWorld(40, 12));
    standOn(game, 10, 11);
    game.run.relics = relics; game.refreshStats();
    game.entities.spawnCoins(game.player.cx + 100, game.player.cy, 10, { count: 1 });
    runLoot(game, 3);
    return game.run.gold;
  };
  assert.equal(pull([]), 0, '100 px is beyond the base magnet');
  assert.equal(pull(['magnet']), 10);
  assert.equal(pull(['magnet', 'greed']), 13);
});

test('relic Vampirisme heals on kills; Cœur de troll regenerates', () => {
  const game = lootGame(worldFrom([
    '##############################',
    ...Array.from({ length: SURFACE_Y + 10 }, () => '#............................#'),
    '##############################',
  ]));
  const p = game.player;
  standOn(game, 10, SURFACE_Y + 11);
  game.camera.x = p.cx - 240; game.camera.y = p.cy - 108;
  game.run.relics = ['vampire', 'troll_heart']; game.refreshStats();
  p.hp = 20;
  const e = game.enemies.spawn('slime', p.cx + 16, p.feetY, { anchor: 'floor', depth: 12 });
  game.enemies.hurt(e, 999, p.cx, {});
  assert.equal(p.hp, 20 + p.stats.killHeal, 'healed on the kill');
  const hp0 = p.hp;
  tick(game, 60 * 4 + 6);
  assert.equal(p.hp, hp0 + 2, '1 HP every 2 s');
});

// ------------------------------------------------------------------ economy balance

test('economy: simulated progression meets the balance targets (tools/economy.mjs)', () => {
  const { milestones, survey } = runEconomy({ quiet: true });
  const m = Object.fromEntries(milestones.map((r) => [r.k, r]));
  assert.equal(m.first.trip, 1, 'first upgrade after one short trip');
  assert.ok(m.pick1.trip >= 2 && m.pick1.trip <= 4, `pickaxe tier 1 after ~3 trips (${m.pick1.trip})`);
  assert.ok(m.pick2.trip >= 8 && m.pick2.trip <= 13, `tier 2 after ~10 trips (${m.pick2.trip})`);
  assert.ok(m.pick4.trip >= 17 && m.pick4.trip <= 26, `tier 3 after ~20 trips (${m.pick4.trip})`);
  assert.ok(m.boss.time >= 2 * 3600 && m.boss.time <= 4 * 3600, `Guardian reachable in 2-4 h (${(m.boss.time / 3600).toFixed(2)} h)`);
  // deeper layers are worth more per ore
  for (let i = 1; i < 4; i++) assert.ok(survey[i].avgValue > survey[i - 1].avgValue);
});

// ------------------------------------------------------------------ HUD queue, NG+ levels

test('HUD toasts are queued (3 on screen, the rest wait) and the bank tally counts up', async () => {
  const { Hud } = await import('../../src/hud.js');
  const game = fakeGame(boxWorld(8, 8));
  game.save = defaultSave();
  game.enemies = { bossBar: null };
  const hud = new Hud(game);
  for (let i = 0; i < 5; i++) hud.toast('T' + i, { life: 1 });
  assert.equal(hud.toasts.length, 3);
  assert.equal(hud.queue.length, 2);
  hud.toast('T4', { life: 1 }); // duplicate: refreshed, not added
  assert.equal(hud.queue.length, 2);
  hud.update(1.01);
  assert.deepEqual(hud.toasts.map((t) => t.text), ['T3', 'T4']);
  game.save.gold = 250;
  hud.tally({ items: [{ key: 'iron', count: 5 }], oreValue: 20, gold: 30, total: 50 });
  assert.ok(hud.tallyActive);
  for (let i = 0; i < 60 * 4; i++) hud.update(DT);
  assert.equal(hud.tallyShown, 50);
  assert.ok(game.events.audio.includes('bank'), 'cha-ching at the end of the count');
  assert.equal(hud.tallyActive, false);
});

test('NG+ level scales enemies × (1 + 0.5 × level)', async () => {
  const { scaleStat } = await import('../../src/enemies.js');
  assert.equal(scaleStat(10, 0, 'hp', 0), 10);
  assert.equal(scaleStat(10, 0, 'hp', 1), 15);
  assert.equal(scaleStat(10, 0, 'hp', 2), 20);
  assert.equal(scaleStat(10, 0, 'hp', true), 15);
});
