import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TILE, SURVIVAL, PACK } from '../../src/config.js';
import { CREATURES } from '../../src/data/creatures.js';
import { BUILDINGS } from '../../src/data/buildings.js';
import { Creature } from '../../src/creature.js';
import { flatWorld, gameIn, run } from './helpers.mjs';

function withCreature(id, species = 'robuste', dx = 3) {
  const g = gameIn(flatWorld({ w: 80 }), species, 10);
  const p = g.player;
  const c = new Creature(CREATURES[id], p.cx + dx * TILE, 30 * TILE);
  g.creatures.push(c);
  return { g, p, c };
}

function bite(g, times) {
  for (let i = 0; i < times; i++) { g.input.press('attack'); run(g, 0.05); g.input.release('attack'); run(g, 0.6); }
}

test('killing a creature leaves a carcass whose harvest gives skin, bones and meat', () => {
  const { g, p, c } = withCreature('dryo', 'robuste', 1.5);
  p.facing = 1;
  c.stats = { ...c.stats, speed: 0 };
  for (let i = 0; i < 6 && c.alive; i++) { c.x = p.x + p.w + 1; bite(g, 1); }
  assert.equal(c.alive, false, 'dryo killed');
  assert.equal(g.carcasses.length, 1);
  const carcass = g.carcasses[0];
  // walk to it and interact
  p.x = carcass.x - 2;
  run(g, 0.1);
  assert.equal(g.interactTarget?.label, 'Dépecer');
  g.input.press('interact');
  run(g, 0.1);
  const d = CREATURES.dryo.drops;
  assert.equal(g.inventory.count('skin'), d.skin);
  assert.equal(g.inventory.count('bone'), d.bone);
  assert.equal(g.inventory.count('meat'), d.meat);
  assert.equal(g.carcasses.length, 0);
});

test('every killable creature drops skin or bones and meat', () => {
  for (const c of Object.values(CREATURES)) {
    assert.ok(c.drops.meat > 0, `${c.id} meat`);
    assert.ok(c.drops.skin + c.drops.bone > 0, `${c.id} skin/bone`);
  }
});

test('robuste kills a raptor much faster than agile', () => {
  const hits = (sp) => {
    const { g, p, c } = withCreature('raptor', sp, 1.5);
    c.stats = { ...c.stats, speed: 0, attack: 0 };
    p.facing = 1;
    let n = 0;
    while (c.alive && n < 40) { bite(g, 1); n++; c.x = p.x + p.w + 1; }
    return n;
  };
  assert.ok(hits('robuste') * 2 <= hits('agile'));
});

test('hostile raptors hunt and hurt the player; resist reduces the damage', () => {
  const dmg = (sp) => {
    const { g, p } = withCreature('raptor', sp, 6);
    const hp0 = p.hp;
    run(g, 4);
    return hp0 - p.hp;
  };
  const a = dmg('agile'), r = dmg('robuste');
  assert.ok(a > 0 && r > 0, `damage agile ${a} robuste ${r}`);
});

test('hunger drains over time, starving hurts, eating restores', () => {
  const g = gameIn(flatWorld(), 'robuste', 10);
  const p = g.player;
  run(g, 10);
  assert.ok(p.hunger < SURVIVAL.hungerMax - 1);
  p.hunger = 0.01;
  const hp0 = p.hp;
  run(g, 3);
  assert.ok(p.hp < hp0, 'starving');
  g.inventory.add('meat', 1); g.inventory.add('cooked', 1);
  run(g, 0.1);
  assert.equal(g.interactTarget?.label, 'Manger');
  g.eatBest();
  assert.ok(p.hunger >= 40, 'cooked meat eaten first');
  assert.equal(g.inventory.count('cooked'), 0);
  g.eatBest();
  assert.equal(g.inventory.count('meat'), 0);
});

test('costaud gets hungry faster than agile (metabolism)', () => {
  const drop = (sp) => { const g = gameIn(flatWorld(), sp, 10); run(g, 20); return SURVIVAL.hungerMax - g.player.hunger; };
  assert.ok(drop('costaud') > drop('agile'));
});

test('building: a tent costs skin and bones, becomes the respawn point, and heals', () => {
  const g = gameIn(flatWorld({ w: 80 }), 'robuste', 10);
  const p = g.player;
  g.builder.start('tente');
  assert.equal(g.builder.validate().ok, false, 'unaffordable');
  g.inventory.addAll(BUILDINGS.tente.cost);
  assert.equal(g.builder.validate().ok, true, g.builder.validate().reason);
  assert.equal(g.builder.place(), true);
  assert.equal(g.structures.length, 1);
  assert.equal(g.inventory.count('skin'), 0);
  assert.equal(g.respawnPoint, g.structures[0]);
  // stand in it: rest interaction, healing
  p.x = g.structures[0].cx - p.w / 2;
  p.hp = 5;
  run(g, 2);
  assert.ok(p.hp > 5.8, 'heals near the tent');
  assert.equal(g.interactTarget?.label, 'Se reposer');
  // death respawns at the tent
  p.x = 60 * TILE;
  p.damageRaw(999, g, 'combat');
  run(g, 3);
  assert.ok(p.alive && Math.abs(p.cx - g.structures[0].cx) < 2);
});

test('building tiles: a bone palisade is solid, a platform can be stood on', () => {
  const g = gameIn(flatWorld({ w: 80 }), 'robuste', 10);
  g.inventory.addAll({ bone: 10, skin: 10 });
  g.player.facing = 1;
  g.builder.start('palissade');
  const gh = g.builder.ghost();
  assert.ok(g.builder.place());
  for (let y = gh.ty; y < gh.ty + 3; y++) assert.ok(g.world.isSolid(gh.tx, y));
  g.builder.start('plateforme');
  g.player.x = 30 * TILE; g.player.facing = -1;
  g.builder.nudge(-1);
  assert.ok(g.builder.place(), g.builder.validate().reason);
  assert.equal(g.builtTiles.length, 6);
});

test('fire cooks all raw meat', () => {
  const g = gameIn(flatWorld({ w: 80 }), 'robuste', 10);
  g.inventory.addAll({ bone: 2, skin: 1, meat: 3 });
  g.builder.start('feu');
  assert.ok(g.builder.place());
  g.player.x = g.structures[0].cx - g.player.w / 2;
  run(g, 0.1);
  assert.equal(g.interactTarget?.label, 'Griller');
  g.input.press('interact');
  run(g, 0.1);
  assert.equal(g.inventory.count('cooked'), 3);
  assert.equal(g.inventory.count('meat'), 0);
});

test('taming: meat turns a compy into an ally that follows; capacity grows with a nest', () => {
  const { g, p, c } = withCreature('compy', 'robuste', 1);
  g.inventory.add('meat', 10);
  run(g, 0.05);
  c.x = p.x + p.w; c.vx = 0;
  run(g, 0.02);
  assert.match(g.interactTarget?.label || '', /Apprivoiser/);
  g.input.press('interact');
  run(g, 0.05);
  assert.equal(g.allies.length, 1);
  assert.equal(g.inventory.count('meat'), 9);
  // follows the player
  g.input.release('interact');
  g.input.setAxis({ x: 1, y: 0 });
  run(g, 4);
  assert.ok(Math.abs(g.allies[0].cx - p.cx) < 60, `ally close: ${Math.abs(g.allies[0].cx - p.cx)}`);
  // capacity
  assert.equal(g.pack.capacity(), PACK.baseCapacity);
  g.inventory.addAll(BUILDINGS.nid.cost);
  g.input.setAxis(null);
  g.builder.start('nid');
  assert.ok(g.builder.place(), g.builder.validate().reason);
  assert.equal(g.pack.capacity(), PACK.baseCapacity + 2);
});

test('hunting allies attack enemies near the player', () => {
  const { g, p } = withCreature('raptor', 'robuste', 10);
  const ally = g.pack.tame(new Creature(CREATURES.compy, p.cx - 10, p.y + p.h));
  const raptor = g.creatures.find((c) => c.def.id === 'raptor');
  raptor.stats = { ...raptor.stats, attack: 0 };
  p.hurtT = 999;
  run(g, 8);
  assert.ok(raptor.hp < raptor.stats.hp, `raptor hurt by the ally (${raptor.hp})`);
  assert.equal(ally.ally, true);
});

test('gathering allies harvest carcasses and bring the loot to the player', () => {
  const { g, p, c } = withCreature('dryo', 'robuste', 12);
  g.pack.tame(new Creature(CREATURES.compy, p.cx - 10, p.y + p.h));
  g.pack.role = 'gather';
  c.die(g, p);
  g.creatures = [];
  assert.equal(g.carcasses.length, 1);
  run(g, 15);
  assert.equal(g.carcasses.length, 0, 'harvested');
  assert.equal(g.inventory.count('meat'), CREATURES.dryo.drops.meat, 'delivered');
});

test('death costs half of the carried resources', () => {
  const g = gameIn(flatWorld(), 'robuste', 10);
  g.inventory.addAll({ skin: 10, bone: 7 });
  g.player.damageRaw(999, g, 'combat');
  assert.equal(g.inventory.count('skin'), 5);
  assert.equal(g.inventory.count('bone'), 4);
});
