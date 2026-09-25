import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultSave, migrateSave, loadSave, saveGame, upgradeCost, applyUpgrades, UPGRADES } from '../../src/meta.js';
import { PLAYER, GRAPPLE } from '../../src/config.js';
import { fakeGame, boxWorld } from './helpers.mjs';

function memStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test('save round-trip and tolerant loading', () => {
  const st = memStorage();
  const s = defaultSave();
  s.gold = 123; s.upgrades.pick = 2;
  assert.equal(saveGame(s, st), true);
  const back = loadSave(st);
  assert.equal(back.gold, 123); assert.equal(back.upgrades.pick, 2);
  st.setItem('gouffre.save.v1', '{broken json');
  assert.deepEqual(loadSave(st), defaultSave());
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadSave(throwing), defaultSave());
  assert.equal(saveGame(s, throwing), false);
});

test('migration fills missing fields and clamps levels', () => {
  const m = migrateSave({ gold: '50', upgrades: { pick: 99, bag: -3 }, stats: { deaths: 4 } });
  assert.equal(m.gold, 50);
  assert.equal(m.upgrades.pick, UPGRADES.pick.max);
  assert.equal(m.upgrades.bag, 0);
  assert.equal(m.upgrades.lantern, 0);
  assert.equal(m.stats.deaths, 4);
  assert.equal(m.stats.victories, 0);
});

test('upgrade costs grow and applyUpgrades changes player stats', () => {
  for (const k of Object.keys(UPGRADES)) {
    assert.ok(upgradeCost(k, 1) > upgradeCost(k, 0));
    assert.equal(upgradeCost(k, UPGRADES[k].max), Infinity);
  }
  const game = fakeGame(boxWorld(8, 8));
  const s = defaultSave();
  applyUpgrades(game.player, s);
  assert.equal(game.player.stats.maxHp, PLAYER.maxHp);
  assert.equal(game.player.stats.pickTier, 0);
  s.upgrades.pick = 2; s.upgrades.grapple = 4; s.upgrades.vitality = 1;
  applyUpgrades(game.player, s);
  assert.equal(game.player.stats.pickTier, 2);
  assert.ok(game.player.stats.grappleRange > GRAPPLE.range && game.player.stats.grappleRange <= GRAPPLE.maxRange);
  assert.equal(game.player.stats.maxHp, PLAYER.maxHp + 15);
});
