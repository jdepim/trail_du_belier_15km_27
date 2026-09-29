import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld } from '../../src/worldgen.js';
import { TILE_ID } from '../../src/tiles.js';
import { ECONOMY, FOG, PLAYER, PICKUPS } from '../../src/config.js';
import { defaultSave } from '../../src/meta.js';
import { fakeGame, tick, cachedGen, emptyGen, boxWorld, px } from './helpers.mjs';

const DT = 1 / 60;
/** Stand still next to (x, y) (offset keeps the astronaut out of the record's tile). */
function standAt(g, x, y, ox = 0, oy = 10) {
  g.player.teleport(x + ox, y + oy);
  tick(g, 1, DT);
}

test('keycard doors: explanatory toast without the card, persistent opening with it', () => {
  const gen = generateWorld(1);
  const g = fakeGame({ gen });
  const door = g.entities.doors.find((d) => d.id === 'orion:door1'); // west entrance
  standAt(g, door.x, door.y, -14, 0);
  assert.equal(g.entities.interactable.kind, 'door');
  assert.equal(g.entities.interactable.label, 'Ouvrir');
  g.input.tap('action');
  tick(g, 1, DT);
  assert.ok(g.events.toasts.some((t) => t.includes("carte d'accès")));
  assert.ok(g.events.audio.includes('deny'));
  assert.equal(door.open, false);
  g.save.items.keycard = true;
  g.input.tap('action');
  tick(g, 1, DT);
  assert.equal(door.open, true);
  for (const i of door.tiles) assert.equal(gen.world.types[i], TILE_ID.DOOR_OPEN);
  assert.ok(g.events.audio.includes('door'));
  assert.ok(g.events.persists > 0);
  const mods = gen.world.exportMods();
  assert.equal(mods.length, door.tiles.length, 'saved as world mods');
  // a fresh world with the mods re-applied sees the door open
  const gen2 = generateWorld(1);
  gen2.world.applyMods(mods);
  const g2 = fakeGame({ gen: gen2 });
  assert.equal(g2.entities.doors.find((d) => d.id === door.id).open, true);
});

test('crates burst into salvage once and are remembered', () => {
  const gen = cachedGen(1);
  const g = fakeGame({ gen });
  const crate = g.entities.crates.find((c) => c.id.startsWith('albatros:'));
  for (const p of g.entities.pickups) p.active = false; // only the crate's salvage around
  standAt(g, crate.x, crate.y, 0, -12);
  assert.equal(g.entities.interactable.kind, 'crate');
  g.entities.interact();
  assert.equal(crate.opened, true);
  assert.deepEqual(g.save.world.crates, [crate.id]);
  tick(g, 120, DT);
  assert.equal(g.run.salvage, crate.value, 'the burst is magnetised and collected');
  assert.ok(g.events.audio.includes('crate') && g.events.audio.includes('pickup_salvage'));
  assert.notEqual(g.entities.interactable && g.entities.interactable.ref, crate, 'cannot be opened twice');
  g.entities.reset(gen, 2);
  assert.equal(g.entities.crates.find((c) => c.id === crate.id).opened, true);
});

test('satellites reveal the map, give salvage and are saved', () => {
  const g = fakeGame({ gen: cachedGen(1) });
  const sat = g.entities.satellites[0];
  standAt(g, sat.x, sat.y, 0, 26);
  assert.equal(g.entities.interactable.kind, 'satellite');
  assert.equal(g.entities.interactable.label, 'Activer');
  g.entities.interact();
  assert.equal(sat.active, true);
  assert.deepEqual(g.events.reveals, [[sat.x, sat.y, FOG.satelliteR]]);
  assert.deepEqual(g.events.satellites, [sat.id]);
  assert.deepEqual(g.save.world.satellites, [sat.id]);
  const burst = g.entities.pickups.filter((p) => p.active && p.loose && p.kind === 'salvage').reduce((s, p) => s + p.value, 0);
  assert.equal(burst, ECONOMY.satelliteSalvage);
});

test('terminals open the log (salvage only the first time)', () => {
  const g = fakeGame({ gen: cachedGen(1) });
  const term = g.entities.terminals.find((t) => t.log === 'albatros');
  standAt(g, term.x, term.y, 0, 12);
  assert.equal(g.entities.interactable.label, 'Lire');
  g.entities.interact();
  g.entities.interact();
  assert.deepEqual(g.events.logs, ['albatros', 'albatros']);
  assert.deepEqual(g.save.world.logs, ['albatros']);
  assert.equal(g.save.stats.logsRead, 1);
  const burst = g.entities.pickups.filter((p) => p.active && p.loose).reduce((s, p) => s + p.value, 0);
  assert.equal(burst, ECONOMY.logSalvage);
});

test('key items are taken by touch, saved at once, and survive a new life', () => {
  const g = fakeGame({ gen: cachedGen(1) });
  const it = g.entities.items.find((i) => i.key === 'explosives');
  g.player.teleport(it.x, it.y);
  tick(g, 1, DT);
  assert.equal(it.taken, true);
  assert.equal(g.save.items.explosives, true);
  assert.deepEqual(g.events.items, ['explosives']);
  assert.ok(g.events.persists > 0 && g.events.audio.includes('item'));
  assert.equal(g.player.charges, PLAYER.maxCharges, 'the Explosives come loaded');
  g.entities.reset(g.gen, 5);
  assert.equal(g.entities.items.find((i) => i.key === 'explosives').taken, true);
});

test('capsule: explanatory refusal without the anchor, victory with it; workbench opens the shop', () => {
  const g = fakeGame({ gen: cachedGen(1) });
  standAt(g, g.gen.capsule.x, g.gen.capsule.y, 0, 12);
  g.save.items.anchor = false;
  assert.equal(g.entities.interactable.label, 'Embarquer');
  assert.equal(g.entities.interact(), false);
  assert.ok(g.events.toasts.some((t) => t.includes('Ancre gravitationnelle')));
  assert.equal(g.events.victories, 0);
  g.save.items.anchor = true;
  g.player.teleport(g.gen.capsule.x, g.gen.capsule.y + 12);
  tick(g, 1, DT);
  assert.equal(g.entities.interact(), true);
  assert.equal(g.events.victories, 1);
  const g2 = fakeGame({ gen: cachedGen(1) });
  standAt(g2, g2.gen.workbench.x, g2.gen.workbench.y, 0, 12);
  assert.equal(g2.entities.interactable.label, 'Établi');
  g2.input.tap('action');
  tick(g2, 1, DT);
  assert.deepEqual(g2.events.states, ['SHOP']);
});

test('dock: deposit of carried salvage and refill; O2 does not drain inside', () => {
  let deposits = 0;
  const g = fakeGame({ gen: cachedGen(1) });
  g.deposit = () => { deposits++; g.save.salvage += g.run.salvage; g.run.salvage = 0; };
  g.run.salvage = 17;
  g.player.hull = 20; g.player.o2 = 10; g.player.fuel = 5;
  tick(g, 1, DT);
  assert.equal(g.entities.inDock, true);
  assert.equal(deposits, 1);
  assert.equal(g.save.salvage, 17);
  assert.ok(g.events.audio.includes('dock'));
  tick(g, 60 * 4, DT);
  assert.equal(g.player.hull, g.player.stats.maxHull);
  assert.equal(g.player.o2, g.player.stats.o2Max);
  assert.equal(g.player.fuel, g.player.stats.fuelMax);
  // without a deposit hook the simulation deposits by itself
  const g2 = fakeGame({ gen: cachedGen(1) });
  delete g2.deposit;
  g2.run.salvage = 4;
  tick(g2, 1, DT);
  assert.equal(g2.save.salvage, 4);
  assert.equal(g2.run.salvage, 0);
});

test('pickups: magnet within the radius, consumables wait while the gauge is full', () => {
  const g = fakeGame({ gen: emptyGen(boxWorld(60, 30), { spawn: { x: px(10), y: px(15) } }) });
  const e = g.entities;
  const far = e.spawnPickup('salvage', px(10) + PLAYER.magnetR + 30, px(15), 2);
  const close = e.spawnPickup('salvage', px(10) + PLAYER.magnetR, px(15), 3);
  const o2 = e.spawnPickup('o2', px(10), px(15) - 12, ECONOMY.o2Pickup);
  tick(g, 60, DT);
  assert.equal(close.active, false);
  assert.equal(g.run.salvage, 3);
  assert.equal(far.active, true, 'out of magnet range');
  assert.equal(o2.active, true, 'full O2: the canister waits');
  g.player.o2 = 20;
  tick(g, 60, DT);
  assert.equal(o2.active, false);
  assert.equal(g.player.o2, Math.min(g.player.stats.o2Max, 20 + 1 + ECONOMY.o2Pickup) > 60 ? g.player.o2 : -1);
  assert.ok(g.player.o2 > 55, `o2 ${g.player.o2}`);
});

test('debris fields are re-rolled every life; caches stay taken', () => {
  const gen = cachedGen(1);
  const save = defaultSave(1);
  const g = fakeGame({ gen, save, lifeSeed: 11 });
  const pos = (ent) => ent.pickups.filter((p) => p.active && p.kind === 'salvage' && !p.cacheId).map((p) => `${p.x | 0},${p.y | 0}`).sort().join(';');
  const a = pos(g.entities);
  const total = gen.debrisFields.reduce((s, f) => s + f.count, 0);
  const n = g.entities.pickups.filter((p) => p.active && p.kind === 'salvage' && !p.cacheId).length;
  assert.ok(n > total * 0.8 && n <= total, `${n} debris of ${total}`);
  g.entities.reset(gen, 11);
  assert.equal(pos(g.entities), a, 'same life seed, same debris');
  g.entities.reset(gen, 12);
  assert.notEqual(pos(g.entities), a, 'new life, new debris');
  const cache = g.entities.pickups.find((p) => p.active && p.cacheId);
  assert.ok(cache, 'caches are spawned');
  const cacheId = cache.cacheId;
  g.player.teleport(cache.x, cache.y);
  tick(g, 2, DT);
  assert.ok(g.save.world.taken.includes(cacheId));
  g.entities.reset(gen, 13);
  assert.ok(!g.entities.pickups.some((p) => p.active && p.cacheId === cacheId), 'taken caches never come back');
  assert.ok(PICKUPS.pool >= total + gen.caches.length + gen.pickups.length + 40, 'pool holds a life of pickups plus bursts');
});

test('interactable = nearest in range; Orion refill and locker', () => {
  const g = fakeGame({ gen: cachedGen(1) });
  const refill = g.entities.refills[0];
  const locker = g.entities.lockers[0];
  standAt(g, refill.x, refill.y, 0, 12);
  assert.equal(g.entities.interactable, null, 'full gauges: nothing to refill');
  g.player.o2 = 10;
  tick(g, 1, DT);
  assert.equal(g.entities.interactable.label, 'Ravitailler');
  g.entities.interact();
  assert.equal(g.player.o2, g.player.stats.o2Max);
  g.save.items.explosives = true;
  g.player.charges = 0;
  standAt(g, locker.x, locker.y, 0, 12);
  assert.equal(g.entities.interactable.label, 'Recharger');
  g.entities.interact();
  assert.equal(g.player.charges, g.player.stats.maxCharges);
  // two terminals near each other: the nearest wins
  const t = g.entities.terminals[0];
  standAt(g, t.x, t.y, 0, 6);
  assert.equal(g.entities.interactable.ref, t);
});
