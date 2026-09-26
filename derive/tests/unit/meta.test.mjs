import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultSave, migrateSave, loadSaveEx, saveGame, clearSave, storageAvailable, exportSave, importSave,
  ITEMS, ITEM_KEYS, UPGRADES, UPGRADE_KEYS, upgradeCost, canBuy, buyUpgrade, applyUpgrades,
  createRun, lifeSeedFor, depositSalvage, settleDeath, flushRunStats, recordVictory,
  LOGS, LOG_KEYS, DEATH_CAUSES, causeText, POI_NAMES,
  createFog, fogReveal, fogRevealed, encodeFog, decodeFog, fogExplored, poiDiscovered,
} from '../../src/meta.js';
import { SAVE_KEY, PLAYER, FOG, CENTER, POIS } from '../../src/config.js';
import { Player } from '../../src/player.js';

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m,
  };
}

test('workbench costs follow the DESIGN §7 table', () => {
  const expect = { o2: [20, 45, 90, 160], fuel: [15, 40, 90], thrust: [25, 60, 120, 200], hull: [20, 50, 100, 170], radar: [15, 50, 110], magnet: [15, 40], charges: [40, 90] };
  assert.deepEqual(UPGRADE_KEYS, Object.keys(expect));
  for (const k of UPGRADE_KEYS) {
    assert.deepEqual(UPGRADES[k].costs, expect[k], k);
    assert.equal(UPGRADES[k].max, expect[k].length);
    for (let lv = 0; lv <= UPGRADES[k].max; lv++) assert.equal(typeof UPGRADES[k].effect(lv), 'string');
  }
  assert.equal(upgradeCost('o2', 0), 20);
  assert.equal(upgradeCost('o2', 4), Infinity);
  assert.equal(upgradeCost('nope', 0), Infinity);
});

test('buying: salvage, max level and the Explosives lock', () => {
  const s = defaultSave(1);
  assert.deepEqual(canBuy(s, 'hull'), { ok: false, reason: 'salvage', cost: 20 });
  s.salvage = 1000;
  const r = buyUpgrade(s, 'hull');
  assert.equal(r.ok, true); assert.equal(r.level, 1); assert.equal(s.salvage, 980);
  assert.equal(canBuy(s, 'charges').reason, 'locked', 'Soute à charges needs the Explosives');
  s.items.explosives = true;
  assert.equal(buyUpgrade(s, 'charges').ok, true);
  buyUpgrade(s, 'magnet'); buyUpgrade(s, 'magnet');
  const r3 = buyUpgrade(s, 'magnet');
  assert.equal(r3.ok, false); assert.equal(r3.reason, 'max'); assert.equal(r3.level, 2);
});

test('applyUpgrades rebuilds the stats from the save', () => {
  const p = new Player({ save: defaultSave(1), flags: {} });
  const s = defaultSave(1);
  s.upgrades = { o2: 2, fuel: 3, thrust: 4, hull: 4, radar: 3, magnet: 2, charges: 2 };
  const st = applyUpgrades(p, s);
  assert.equal(st.o2Max, PLAYER.o2Max + 90);
  assert.equal(st.fuelMax, PLAYER.fuelMax * 1.75);
  assert.ok(Math.abs(st.rechargeRate - PLAYER.rechargeRate * 1.75) < 1e-9);
  assert.ok(Math.abs(st.thrustAccel - PLAYER.thrustAccel * 1.6) < 1e-9);
  assert.ok(Math.abs(st.cruiseSpeed - PLAYER.cruiseSpeed * 1.48) < 1e-9);
  assert.equal(st.maxHull, 200);
  assert.equal(st.radarRange, 3000);
  assert.equal(st.magnetR, 80);
  assert.equal(st.maxCharges, 5);
  p.hull = 500;
  applyUpgrades(p, defaultSave(1));
  assert.equal(p.hull, PLAYER.maxHull, 'current hull clamped to the new max');
});

test('deposit and death settlement', () => {
  const s = defaultSave(9);
  const run = createRun(s);
  run.salvage = 37;
  assert.deepEqual(depositSalvage(s, run), { amount: 37, total: 37 });
  assert.equal(run.salvage, 0);
  assert.equal(s.stats.salvageTotal, 37);
  run.salvage = 12; run.time = 30; run.distance = 900;
  const seed0 = lifeSeedFor(s);
  const d = settleDeath(s, run, 'heat');
  assert.equal(d.lost, 12, 'carried salvage is lost');
  assert.equal(s.salvage, 37, 'deposited salvage is kept');
  assert.equal(d.causeText, 'Brûlé vif');
  assert.equal(s.stats.deaths, 1);
  assert.equal(s.stats.time, 30);
  assert.equal(s.stats.distance, 900);
  assert.equal(run.salvage, 0);
  assert.notEqual(lifeSeedFor(s), seed0, 'a new life re-rolls the asteroids and debris');
  const run2 = createRun(s, run);
  assert.equal(run2.deathsThisSession, 1);
  assert.equal(run2.lifeSeed, lifeSeedFor(s));
  // flushing twice never double-counts
  run2.time = 10; flushRunStats(s, run2); flushRunStats(s, run2);
  assert.equal(s.stats.time, 40);
  const v = recordVictory(s, run2, 42.5);
  assert.equal(v.victories, 1); assert.equal(s.stats.bestTime, 40); assert.equal(v.explored, 42.5);
  assert.equal(v.logsTotal, LOG_KEYS.length);
});

test('migration accepts garbage, partial and hand-edited saves', () => {
  for (const raw of [null, 42, 'x', [], undefined]) {
    const s = migrateSave(raw);
    assert.equal(s.salvage, 0);
    assert.equal(s.settings.assist, true);
  }
  const s = migrateSave({
    seed: 77, salvage: '12.9', items: { keycard: true, anchor: 'yes', bogus: true },
    upgrades: { o2: 99, thrust: -3, laser: 2 }, fog: '!!notbase64',
    world: { mods: [[5, 1], ['a', 2], [3], [7, 300]], crates: ['a', 'a', 5, 'b'], logs: ['helios', 'nope'] },
    stats: { deaths: -4, time: 'NaN' }, settings: { assist: false, muted: 1 }, tips: { first_thrust: 1, 'Bad Key!': 1 },
  });
  assert.equal(s.seed, 77);
  assert.equal(s.salvage, 12);
  assert.equal(s.items.keycard, true);
  assert.equal(s.items.anchor, false, 'only true counts');
  assert.ok(!('bogus' in s.items));
  assert.equal(s.upgrades.o2, UPGRADES.o2.max);
  assert.equal(s.upgrades.thrust, 0);
  assert.ok(!('laser' in s.upgrades));
  assert.equal(s.fog, '');
  assert.deepEqual(s.world.mods, [[5, 1]]);
  assert.deepEqual(s.world.crates, ['a', 'b']);
  assert.deepEqual(s.world.logs, ['helios']);
  assert.equal(s.stats.logsRead, 1);
  assert.equal(s.stats.deaths, 0);
  assert.equal(s.stats.time, 0);
  assert.equal(s.settings.assist, false);
  assert.equal(s.settings.muted, false, 'only true mutes');
  assert.deepEqual(s.tips, { first_thrust: 1 });
});

test('load / save: new, ok, corrupt (kept aside) and unavailable storage', () => {
  const st = memStorage();
  assert.equal(loadSaveEx(st).status, 'new');
  const s = defaultSave(5);
  s.salvage = 99;
  assert.equal(saveGame(s, st), true);
  const { save, status } = loadSaveEx(st);
  assert.equal(status, 'ok');
  assert.equal(save.salvage, 99);
  assert.equal(save.seed, 5);
  st.setItem(SAVE_KEY, '{oops');
  const bad = loadSaveEx(st);
  assert.equal(bad.status, 'corrupt');
  assert.equal(st.getItem(SAVE_KEY + '.corrupt'), '{oops');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(loadSaveEx(broken).status, 'unavailable');
  assert.equal(saveGame(s, broken), false);
  assert.equal(storageAvailable(broken), false);
  assert.equal(storageAvailable(st), true);
  const fresh = clearSave(st, 3);
  assert.equal(st.getItem(SAVE_KEY), null);
  assert.equal(fresh.seed, 3);
});

test('transfer code round-trip; foreign codes are rejected', () => {
  const s = defaultSave(123);
  s.items.keycard = true; s.salvage = 55; s.world.mods.push([10, 2]); s.world.logs.push('colibri');
  s.settings.muted = true;
  const code = exportSave(s);
  assert.ok(code.startsWith('DERIVE1:'));
  const back = importSave('  ' + code.slice(0, 20) + '\n' + code.slice(20) + ' ');
  assert.deepEqual(back, migrateSave(s));
  assert.equal(importSave('GOUFFRE1:abcd'), null);
  assert.equal(importSave('DERIVE1:%%%'), null);
  assert.equal(importSave('DERIVE1:' + btoa('[1,2]')), null);
  assert.equal(importSave(null), null);
});

test('fog of war: reveal, encode / decode, explored %, POI discovery', () => {
  const fog = createFog();
  assert.equal(fog.length, FOG.size * FOG.size / 8);
  assert.equal(fogExplored(fog), 0);
  const n = fogReveal(fog, CENTER, CENTER, FOG.revealR);
  assert.ok(n > 40, `${n} cells`);
  assert.equal(fogReveal(fog, CENTER, CENTER, FOG.revealR), 0, 'nothing new the second time');
  assert.equal(fogRevealed(fog, CENTER, CENTER), true);
  assert.equal(fogRevealed(fog, CENTER + 1000, CENTER), false);
  const albatros = POIS.find((p) => p.key === 'albatros'), orion = POIS.find((p) => p.key === 'orion');
  assert.equal(poiDiscovered(fog, albatros), true);
  assert.equal(poiDiscovered(fog, orion), false);
  const back = decodeFog(encodeFog(fog));
  assert.deepEqual(back, fog);
  assert.deepEqual(decodeFog('***'), createFog(), 'corrupt fog starts unexplored');
  fogReveal(fog, CENTER, CENTER, 99999);
  assert.ok(Math.abs(fogExplored(fog) - 100) < 1e-9);
});

test('story and texts', () => {
  assert.equal(LOG_KEYS.length, 9);
  for (const k of LOG_KEYS) {
    const sentences = LOGS[k].text.split(/[.!?…]+(?:\s|$)/).filter((x) => x.trim().length > 0);
    assert.ok(sentences.length >= 2 && sentences.length <= 5, `${k}: ${sentences.length} sentences`);
    assert.ok(LOGS[k].title.length > 5);
  }
  for (const k of ITEM_KEYS) assert.ok(ITEMS[k].name && ITEMS[k].desc && ITEMS[k].icon);
  for (const c of ['asphyxia', 'sun_a', 'sun_b', 'heat', 'bh_maelstrom', 'bh_charybde', 'impact', 'laser', 'turret', 'self', 'storm', 'recall']) {
    assert.ok(DEATH_CAUSES[c], c);
  }
  assert.equal(causeText('unknown'), DEATH_CAUSES.impact);
  assert.equal(POI_NAMES.orion, 'Station Orion');
});
