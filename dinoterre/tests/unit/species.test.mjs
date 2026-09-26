import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPECIES, SPECIES_ORDER } from '../../src/data/species.js';
import { TILE, SURVIVAL } from '../../src/config.js';
import { flatWorld, gameIn, run } from './helpers.mjs';

const { costaud, agile, robuste } = SPECIES;

test('three playable species with the required stat fields', () => {
  assert.deepEqual(SPECIES_ORDER, ['costaud', 'agile', 'robuste']);
  const fields = ['hp', 'walkSpeed', 'jumpHeight', 'climbSpeed', 'climbDrain', 'swimSpeed', 'breath', 'attack', 'attackRate', 'resist', 'size', 'look'];
  for (const s of Object.values(SPECIES)) for (const f of fields) assert.ok(s[f] !== undefined, `${s.id}.${f}`);
});

test('costaud jumps highest, agile lowest; robuste in between', () => {
  assert.ok(costaud.jumpHeight > robuste.jumpHeight && robuste.jumpHeight > agile.jumpHeight);
});

test('agile climbs fastest and longest, costaud slowest and shortest; robuste in between', () => {
  const reach = (s) => (SURVIVAL.staminaMax / s.climbDrain) * s.climbSpeed; // px climbed on a full stamina bar
  assert.ok(agile.climbSpeed > robuste.climbSpeed && robuste.climbSpeed > costaud.climbSpeed);
  assert.ok(reach(agile) > reach(robuste) && reach(robuste) > reach(costaud));
});

test('robuste is the best fighter and average elsewhere', () => {
  for (const other of [costaud, agile]) {
    assert.ok(robuste.attack > other.attack, 'attack');
    assert.ok(robuste.resist > other.resist, 'resist');
    assert.ok(robuste.hp > other.hp, 'hp');
    assert.ok(robuste.attack / robuste.attackRate > other.attack / other.attackRate, 'dps');
  }
  const mid = (k) => {
    const v = [costaud[k], agile[k], robuste[k]].sort((a, b) => a - b);
    return robuste[k] === v[1];
  };
  for (const k of ['jumpHeight', 'climbSpeed', 'swimSpeed']) assert.ok(mid(k), `${k} is the median`);
});

for (const id of SPECIES_ORDER) {
  test(`${id}: measured jump height matches its stat`, () => {
    const g = gameIn(flatWorld(), id, 10);
    const p = g.player;
    run(g, 0.3);
    const y0 = p.y;
    let top = p.y;
    g.input.press('jump');
    run(g, 1.5, () => { top = Math.min(top, p.y); });
    const tiles = (y0 - top) / TILE;
    assert.ok(Math.abs(tiles - SPECIES[id].jumpHeight) < 0.35, `${tiles.toFixed(2)} vs ${SPECIES[id].jumpHeight}`);
    assert.ok(p.onGround, 'lands again');
  });
}

test('only the costaud clears a 6-tile wall with a plain jump', () => {
  for (const id of SPECIES_ORDER) {
    const g = gameIn(flatWorld({ wallX: 14, wallH: 6 }), id, 8);
    const p = g.player;
    g.input.setAxis({ x: 1, y: 0 });
    run(g, 0.4);
    g.input.press('jump');
    run(g, 2.5);
    const over = p.x > 15 * TILE;
    assert.equal(over, id === 'costaud', `${id} over=${over}`);
  }
});
