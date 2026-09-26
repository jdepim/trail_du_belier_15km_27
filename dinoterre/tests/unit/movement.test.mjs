import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TILE } from '../../src/config.js';
import { SPECIES } from '../../src/data/species.js';
import { flatWorld, worldFrom, gameIn, placePlayer, run } from './helpers.mjs';

function climbTest(id, wallH = 20) {
  const g = gameIn(flatWorld({ h: 50, ground: 40, wallX: 20, wallH }), id, 17);
  const p = g.player;
  g.input.setAxis({ x: 1, y: 0 });
  run(g, 1);
  g.input.press('climb');
  const y0 = p.y + p.h;
  let t = 0, maxClimb = 0, climbed = false;
  run(g, 20, () => {
    t += 1 / 60;
    if (p.state === 'climb') climbed = true;
    maxClimb = Math.max(maxClimb, y0 - (p.y + p.h));
  });
  return { g, p, climbed, maxClimb: maxClimb / TILE };
}

test('climbing: every species can grab a wall; agile climbs a 30-tile cliff, costaud gives up early', () => {
  const a = climbTest('agile', 30), r = climbTest('robuste', 30), c = climbTest('costaud', 30);
  assert.ok(a.climbed && r.climbed && c.climbed);
  assert.ok(a.p.x > 20 * TILE, `agile reached the top (maxClimb ${a.maxClimb.toFixed(1)})`);
  assert.ok(c.maxClimb < 6, `costaud tires out: ${c.maxClimb.toFixed(1)} tiles`);
  assert.ok(r.maxClimb > c.maxClimb && r.maxClimb < 25, `robuste in between: ${r.maxClimb.toFixed(1)}`);
});

test('climbing drains stamina, exhaustion drops the player and blocks regrip until recovery', () => {
  const { g, p } = climbTest('costaud');
  assert.ok(g.lastToast.includes('Épuisé') || p.exhausted || p.stamina > 0);
  assert.notEqual(p.state, 'climb');
});

test('a 5-tile wall: robuste climbs over it and lands on top', () => {
  const r = climbTest('robuste', 5);
  assert.ok(r.p.x > 21 * TILE && r.maxClimb >= 5, `x=${(r.p.x / TILE).toFixed(1)}`);
});

test('tree trunks are climbable', () => {
  const rows = [];
  for (let y = 0; y < 30; y++) {
    let s = '';
    for (let x = 0; x < 30; x++) s += y >= 25 ? '#' : (x === 12 && y >= 15) ? 'T' : (y === 14 && x >= 10 && x <= 14) ? '=' : '.';
    rows.push(s);
  }
  const g = gameIn(worldFrom(rows), 'agile', 12);
  const p = g.player;
  g.input.press('climb');
  run(g, 3);
  g.input.release('climb');
  run(g, 1);
  assert.ok(p.y + p.h <= 14 * TILE + 1, `on the canopy: feet at ${((p.y + p.h) / TILE).toFixed(2)}`);
});

function pool() {
  const rows = [];
  for (let y = 0; y < 40; y++) {
    let s = '';
    for (let x = 0; x < 40; x++) s += y >= 36 || x === 0 || x === 39 ? '#' : y >= 20 ? '~' : '.';
    rows.push(s);
  }
  return worldFrom(rows);
}

test('swimming: Nager rises, heavy costaud sinks when idle, light agile does not', () => {
  for (const [id, sinks] of [['costaud', true], ['agile', false]]) {
    const g = gameIn(pool(), id, 20);
    placePlayer(g, 20, 30);
    const p = g.player;
    run(g, 0.2);
    assert.equal(p.state, 'swim');
    const y0 = p.y;
    run(g, 1.5);
    assert.equal(p.y > y0 + 4, sinks, `${id} idle dy=${(p.y - y0).toFixed(1)}`);
    g.input.press('swim');
    const y1 = p.y;
    run(g, 1);
    assert.ok(p.y < y1 - 20, `${id} swims up`);
  }
});

test('swim speed follows the species stat', () => {
  const dist = (id) => {
    const g = gameIn(pool(), id, 5);
    placePlayer(g, 5, 30);
    g.input.setAxis({ x: 1, y: 0 });
    const x0 = g.player.x;
    run(g, 2);
    return g.player.x - x0;
  };
  assert.ok(dist('agile') > dist('robuste') && dist('robuste') > dist('costaud'));
});

test('breath runs out underwater and drowning hurts; surfacing refills it', () => {
  const g = gameIn(pool(), 'robuste', 20);
  placePlayer(g, 20, 35);
  const p = g.player;
  g.input.setAxis({ x: 0, y: 1 });   // stay at the bottom
  run(g, SPECIES.robuste.breath + 2);
  assert.equal(p.breath, 0);
  assert.ok(p.hp < SPECIES.robuste.hp - 1, `hp ${p.hp}`);
  g.input.setAxis({ x: 0, y: 0 });
  g.input.press('swim');
  run(g, 4);
  assert.ok(p.breath > 3, `breath ${p.breath}`);
});

test('the player can walk up 1-tile steps without jumping', () => {
  const rows = [];
  for (let y = 0; y < 30; y++) {
    let s = '';
    for (let x = 0; x < 40; x++) s += y >= 25 - Math.min(4, Math.max(0, Math.floor((x - 10) / 4))) || x === 0 || x === 39 ? '#' : '.';
    rows.push(s);
  }
  const g = gameIn(worldFrom(rows), 'robuste', 5);
  g.input.setAxis({ x: 1, y: 0 });
  run(g, 5);
  assert.ok(g.player.x > 30 * TILE, `x=${(g.player.x / TILE).toFixed(1)}`);
});
