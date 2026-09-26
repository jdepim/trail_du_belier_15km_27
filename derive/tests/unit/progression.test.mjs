// DESIGN §6.4: the progression graph, proved by tools/solver.mjs on two seeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveProgression, MAX_HULL, reachable } from '../../tools/solver.mjs';
import { PLAYER } from '../../src/config.js';
import { cachedGen } from './helpers.mjs';

for (const seed of [1, 424242]) {
  test(`progression graph holds (seed ${seed})`, () => {
    const rep = solveProgression(cachedGen(seed));
    for (const r of rep.rules) assert.ok(r.ok, `${r.name} — ${r.detail}`);
    assert.ok(rep.ok);
    // thermal criterion, stated explicitly
    assert.ok(rep.thermal.unshielded >= 1.5 * MAX_HULL, `unshielded ${rep.thermal.unshielded}`);
    assert.ok(rep.thermal.shielded <= 0.4 * PLAYER.maxHull, `shielded ${rep.thermal.shielded}`);
  });
}

test('the loose grid really is permissive: it reaches every item once all locks are open', () => {
  const gen = cachedGen(1);
  const all = { keycard: true, explosives: true, heatshield: true, anchor: true };
  for (const it of gen.items) assert.ok(reachable(gen, all, 'loose', it.x, it.y), `${it.key} (loose, every item)`);
  assert.ok(MAX_HULL > PLAYER.maxHull);
});
