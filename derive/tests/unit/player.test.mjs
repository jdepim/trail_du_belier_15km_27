import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER, BOUNDARY, CENTER, SUNS, TILE } from '../../src/config.js';
import { fakeGame, boxWorld, tick, cachedGen, px, ORIGIN } from './helpers.mjs';

const DT = 1 / 60;
const open = (opts = {}) => fakeGame({ world: boxWorld(120, 120), ...opts });
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

test('thrust accelerates at thrustAccel and burns fuel', () => {
  const g = open();
  const p = g.player;
  p.reset(px(60), px(60));
  g.input.stick(1, 0);
  tick(g, 30, DT, { only: 'player' });
  near(p.vx, PLAYER.thrustAccel * 0.5, 0.5, 'vx after 0.5 s');
  near(p.vy, 0, 1e-9, 'vy');
  near(p.fuel, PLAYER.fuelMax - PLAYER.fuelThrust * 0.5, 1e-6, 'fuel');
  assert.ok(p.thrust === 1 && p.thrustX === 1);
  // half stick = half thrust
  const g2 = open();
  g2.player.reset(px(60), px(60));
  g2.input.stick(0, 0.5);
  tick(g2, 30, DT, { only: 'player' });
  near(g2.player.vy, PLAYER.thrustAccel * 0.25, 0.5, 'analogue thrust');
});

test('cruise rule: thrust alone never exceeds the cruise speed, but can brake / steer above it', () => {
  const g = open();
  const p = g.player;
  p.reset(px(10), px(60));
  g.input.stick(1, 0);
  tick(g, 60 * 3, DT, { only: 'player' });
  assert.ok(p.speed <= PLAYER.cruiseSpeed + 1e-6, `speed ${p.speed}`);
  assert.ok(p.speed > PLAYER.cruiseSpeed - 1, 'reaches cruise');
  // above cruise (e.g. after a boost): pushing forward adds nothing
  p.teleport(px(10), px(60));
  p.vx = 300;
  tick(g, 20, DT, { only: 'player' });
  assert.ok(p.vx <= 300 + 1e-6 && p.vx > 299, `no speed gain above cruise (${p.vx})`);
  // steering sideways keeps the speed but turns the velocity
  g.input.stick(0, 1);
  tick(g, 20, DT, { only: 'player' });
  assert.ok(p.speed <= 300 + 1e-6);
  assert.ok(p.vy > 50, 'velocity rotates');
  // thrusting backwards slows down
  g.input.stick(-1, 0);
  const before = p.vx;
  tick(g, 10, DT, { only: 'player' });
  assert.ok(p.vx < before - 20);
});

test('holding the stick at cruise keeps a pilot flame but burns no fuel (the tank recharges)', () => {
  const g = open();
  const p = g.player;
  p.reset(px(10), px(60));
  p.vx = PLAYER.cruiseSpeed;
  p.fuel = 50;
  g.input.stick(1, 0);
  tick(g, 60 * 3, DT, { only: 'player' });
  near(p.speed, PLAYER.cruiseSpeed, 1e-6, 'cruise kept');
  assert.ok(p.fuel > 50, `solar recharge while cruising (${p.fuel})`);
  near(p.thrust, PLAYER.cruiseFlame, 1e-9, 'pilot flame');
  // steering at cruise pays for the turn
  g.input.stick(0, 1);
  const f0 = p.fuel;
  tick(g, 20, DT, { only: 'player' });
  assert.ok(p.fuel < f0, 'turning burns fuel');
});

test('hard max speed caps everything', () => {
  const g = open();
  g.player.impulse(1000, 0);
  near(g.player.vx, PLAYER.hardMaxSpeed, 1e-6, 'impulse capped');
});

test('brake stops the astronaut and burns fuel', () => {
  const g = open();
  const p = g.player;
  p.reset(px(60), px(60));
  p.vx = 140; p.vy = 0;
  g.input.hold('brake');
  const ticks = Math.ceil((140 / PLAYER.brakeDecel) / DT) + 1;
  tick(g, ticks, DT, { only: 'player' });
  near(p.speed, 0, 1e-6, 'stopped');
  assert.ok(p.fuel < PLAYER.fuelMax - PLAYER.fuelBrake * 0.5 && p.fuel > PLAYER.fuelMax - PLAYER.fuelBrake * 0.6, `fuel ${p.fuel}`);
  assert.ok(g.events.audio.includes('brake'));
  tick(g, 10, DT, { only: 'player' });
  assert.equal(p.braking, false, 'no brake flame once still');
});

test('boost: impulse toward the stick or the facing, cooldown, fuel cost', () => {
  const g = open();
  const p = g.player;
  p.reset(px(60), px(60));
  g.input.tap('boost');
  tick(g, 1, DT, { only: 'player' });
  near(p.vy, -PLAYER.boostImpulse * Math.exp(-PLAYER.assistDrag * DT), 1e-6, 'neutral stick boosts where the astronaut faces (north)');
  near(p.fuel, PLAYER.fuelMax - PLAYER.boostFuel, 1e-6, 'boost fuel');
  g.input.tap('boost');
  tick(g, 1, DT, { only: 'player' });
  near(p.vy, -PLAYER.boostImpulse * Math.exp(-PLAYER.assistDrag * DT * 2), 1e-6, 'cooldown: no second boost');
  assert.ok(g.events.audio.includes('deny'));
  tick(g, Math.ceil(PLAYER.boostCooldown / DT), DT, { only: 'player' });
  const vy = p.vy;
  g.input.stick(1, 0);
  g.input.tap('boost');
  tick(g, 1, DT, { only: 'player' });
  assert.ok(p.vx > PLAYER.boostImpulse - 1, 'boost follows the stick');
  assert.ok(Math.abs(p.vy - vy) < 1);
  assert.ok(g.events.audio.filter((a) => a === 'boost').length === 2);
});

test('empty tank: no thrust, no brake; the solar recharge restarts after the delay', () => {
  const g = open();
  const p = g.player;
  p.reset(px(60), px(60));
  p.fuel = 0.01;
  g.input.stick(1, 0);
  tick(g, 2, DT, { only: 'player' });
  assert.equal(p.fuel, 0);
  assert.ok(p.fuelEmpty);
  assert.ok(g.events.audio.includes('fuel_empty'));
  const vx = p.vx;
  tick(g, 30, DT, { only: 'player' });
  assert.equal(p.vx, vx, 'no thrust without fuel');
  g.input.stick(0, 0);
  g.input.hold('brake');
  tick(g, 10, DT, { only: 'player' });
  assert.ok(p.speed > 0 && !p.braking, 'no brake without fuel');
  g.input.hold('brake', false);
  // 1.5 s without burning, then rechargeRate u/s
  const g2 = open();
  const q = g2.player;
  q.reset(px(60), px(60));
  q.fuel = 0.01;
  g2.input.stick(1, 0);
  tick(g2, 1, DT, { only: 'player' }); // burns the last drop: the delay restarts
  g2.input.stick(0, 0);
  tick(g2, Math.round(PLAYER.rechargeDelay / DT) - 2, DT, { only: 'player' });
  assert.ok(q.fuel < 0.2, `still empty during the delay (${q.fuel})`);
  tick(g2, 62, DT, { only: 'player' });
  near(q.fuel, PLAYER.rechargeRate, 0.25, 'recharge after 1 s');
});

test('solar recharge is × 3 near a sun', () => {
  const gen = cachedGen(1);
  const g = fakeGame({ gen });
  const p = g.player;
  const s = gen.suns[0];
  p.reset(s.x - (SUNS.heatR + 90), s.y); // west of Hélios A, away from B; the pull drifts it ~40 px
  p.fuel = 0;
  tick(g, Math.round(PLAYER.rechargeDelay / DT) + 60, DT);
  assert.equal(g.hazards.heatAtPlayer, 0, 'outside the heat');
  assert.ok(p.fuel > PLAYER.rechargeRate * PLAYER.sunRechargeMul * 0.9, `fuel ${p.fuel}`);
});

test('O2 drains outside the dock; asphyxia burns the hull and kills', () => {
  const g = open();
  const p = g.player;
  p.reset(px(60), px(60));
  tick(g, 600, DT, { only: 'player' });
  near(p.o2, PLAYER.o2Max - 10, 0.05, 'o2 after 10 s');
  p.o2 = 0; p.hull = 50;
  tick(g, 60, DT, { only: 'player' });
  near(p.hull, 50 - PLAYER.asphyxiaDamage, 0.1, 'asphyxia damage per second');
  p.hull = 1;
  tick(g, 10, DT, { only: 'player' });
  assert.equal(p.dead, true);
  assert.equal(p.deathCause, 'asphyxia');
  assert.deepEqual(g.events.deaths, ['asphyxia']);
  assert.ok(g.events.audio.includes('death'));
});

test('inertia assist: damping when on, pure Newton when off', () => {
  const g = open();
  g.player.reset(px(60), px(60));
  g.player.vx = 100;
  tick(g, 120, DT, { only: 'player' });
  near(g.player.vx, 100 * Math.exp(-PLAYER.assistDrag * 2), 0.5, 'assist on');
  const g2 = open();
  g2.save.settings.assist = false;
  g2.player.reset(px(60), px(60));
  g2.player.vx = 100;
  tick(g2, 120, DT, { only: 'player' });
  near(g2.player.vx, 100, 1e-9, 'assist off');
});

test('facing turns toward the stick at turnRate, quantised to 16 directions', () => {
  const g = open();
  const p = g.player;
  p.reset(px(60), px(60));
  g.input.stick(0, 1);
  tick(g, 1, DT, { only: 'player' });
  near(Math.abs(p.angle + Math.PI / 2), PLAYER.turnRate * DT, 1e-9, 'one tick of turn');
  tick(g, 30, DT, { only: 'player' });
  near(p.angle, Math.PI / 2, 1e-9, 'faces south');
  assert.equal(p.dir16, 4);
});

test('impact damage above the safe speed, i-frames, death cause "impact"', () => {
  const g = fakeGame({ world: boxWorld(30, 10) });
  g.save.settings.assist = false; // exact speeds
  const p = g.player;
  p.reset(px(20), px(5));
  p.vx = 90;
  tick(g, 70, DT, { only: 'player' });
  assert.equal(p.hull, PLAYER.maxHull, 'slow bump is harmless');
  assert.ok(g.events.audio.includes('bump'));
  p.teleport(px(20), px(5));
  p.vx = 300;
  tick(g, 20, DT, { only: 'player' });
  near(p.hull, PLAYER.maxHull - (300 - PLAYER.impactSafeSpeed) * PLAYER.impactDamage, 1e-6, 'impact damage');
  assert.ok(g.events.audio.includes('impact') && g.events.particles.includes('spark'));
  assert.ok(g.events.shakes > 0 && g.events.hitStops > 0);
  // i-frames: a second hit right away is ignored, continuous damage is not
  assert.ok(p.iframes > 0, 'the impact granted i-frames');
  p.iframes = 0;
  const hull = p.hull;
  assert.equal(p.damage(5, 'impact'), true);
  assert.equal(p.damage(5, 'impact'), false);
  assert.equal(p.damage(1, 'heat', { continuous: true }), true);
  near(p.hull, hull - 6, 1e-9, 'one i-framed hit + continuous');
  p.iframes = 0; p.hull = 3;
  p.teleport(px(20), px(5));
  p.vx = 400;
  tick(g, 30, DT, { only: 'player' });
  assert.equal(p.deathCause, 'impact');
});

test('death causes: heat, sun core, black hole horizon, ion storm', () => {
  const gen = cachedGen(1);
  const s = gen.suns[0];
  let g = fakeGame({ gen });
  g.player.reset(s.x, s.y - 200);
  tick(g, 120, DT);
  assert.equal(g.player.deathCause, 'heat', 'burnt alive in the heat');
  g = fakeGame({ gen });
  g.player.reset(s.x + s.coreR - 2, s.y);
  tick(g, 1, DT);
  assert.equal(g.player.deathCause, s.cause, 'touching the core');
  const m = gen.blackHoles[0];
  g = fakeGame({ gen });
  g.player.reset(m.x + m.horizon - 1, m.y);
  tick(g, 1, DT);
  assert.equal(g.player.deathCause, 'bh_maelstrom');
  g = fakeGame({ gen });
  g.player.reset(CENTER + BOUNDARY.r + 50, CENTER);
  g.player.hull = 1;
  tick(g, 30, DT);
  assert.equal(g.player.deathCause, 'storm');
});

test('god flag blocks damage and deaths except the forced recall', () => {
  const g = open();
  g.flags.god = true;
  const p = g.player;
  assert.equal(p.damage(500, 'impact'), false);
  p.die('heat');
  assert.equal(p.dead, false);
  p.die('recall', { force: true });
  assert.equal(p.dead, true);
  assert.equal(p.deathCause, 'recall');
});

test('dead astronauts drift and stop reacting to input', () => {
  const g = open();
  const p = g.player;
  p.reset(px(60), px(60));
  p.vx = 50;
  p.die('impact');
  g.input.stick(1, 0);
  g.input.tap('boost');
  tick(g, 60, DT, { only: 'player' });
  assert.ok(p.vx < 50 && p.vx > 0, 'drifts and slows');
  assert.equal(p.fuel, PLAYER.fuelMax);
  assert.ok(p.deadT > 0.9);
});

test('Action calls entities.interact(); Charge drops an explosive only with the Explosives', () => {
  const g = open();
  const p = g.player;
  p.reset(px(60), px(60));
  let calls = 0;
  g.entities.interact = () => { calls++; return true; };
  g.input.tap('action');
  tick(g, 1, DT, { only: 'player' });
  assert.equal(calls, 1);
  g.input.tap('charge');
  tick(g, 1, DT, { only: 'player' });
  assert.equal(g.hazards.charges.filter((c) => c.active).length, 0, 'no explosives yet');
  g.save.items.explosives = true;
  p.reset(px(60), px(60));
  assert.equal(p.charges, PLAYER.maxCharges);
  p.vx = 40;
  g.input.tap('charge');
  tick(g, 1, DT, { only: 'player' });
  const c = g.hazards.charges.find((q) => q.active);
  assert.ok(c, 'charge dropped');
  assert.equal(p.charges, PLAYER.maxCharges - 1);
  near(c.vx, p.vx, 1, 'the charge drifts with the astronaut');
  p.charges = 0;
  g.input.tap('charge');
  tick(g, 1, DT, { only: 'player' });
  assert.ok(g.events.toasts.some((t) => t.includes('Plus de charges')));
});

test('run time and distance accumulate', () => {
  const g = open();
  g.player.reset(px(60), px(60));
  g.player.vx = 60;
  tick(g, 60, DT, { only: 'player' });
  near(g.run.time, 1, 1e-9, 'time');
  assert.ok(g.run.distance > 40 && g.run.distance < 61, `distance ${g.run.distance}`);
  assert.ok((ORIGIN + 60) * TILE > 0);
});
