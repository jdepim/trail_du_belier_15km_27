// Dev tool: flight-feel report. Flies the real simulation headless (the unit-test game context,
// tests/unit/helpers.mjs) with scripted sticks and prints the numbers the tuning is judged on:
// time to cruise, brake stop, inertia-assist coast, fuel spent cruising, belt crossings at several
// speeds, and a shielded approach to the Hélios observatory.
// Usage: node tools/feel.mjs [seed]
import { fakeGame, tick, cachedGen } from '../tests/unit/helpers.mjs';
import { CENTER, ZONE_ID, PLAYER, POI_BY_KEY } from '../src/config.js';

const seed = Number(process.argv[2] || 12345);
const gen = cachedGen(seed);
const DT = 1 / 60;
const f1 = (v) => v.toFixed(1);

// ---- straight-line handling in open space (south-east of the Albatros, nothing around)
{
  const g = fakeGame({ gen }), p = g.player;
  p.teleport(CENTER + 900, CENTER + 900);
  g.input.stick(1, 0);
  let t = 0;
  while (p.speed < PLAYER.cruiseSpeed - 1 && t < 5) { tick(g, 1); t += DT; }
  const f0 = p.fuel;
  tick(g, 120);
  console.log(`thrust: 0 → ${f1(p.speed)} px/s in ${t.toFixed(2)} s; fuel over 2 s held at cruise: ${p.fuel >= f0 ? '+' : ''}${f1(p.fuel - f0)} u`);
  g.input.stick(0, 0); g.input.hold('brake');
  let x0 = p.x; t = 0;
  while (p.speed > 0.5 && t < 5) { tick(g, 1); t += DT; }
  g.input.hold('brake', false);
  console.log(`brake: stop from cruise in ${t.toFixed(2)} s over ${(p.x - x0).toFixed(0)} px`);
  g.input.stick(1, 0); tick(g, 90); g.input.stick(0, 0);
  x0 = p.x; t = 0;
  while (p.speed > 5 && t < 30) { tick(g, 1); t += DT; }
  console.log(`assist: coast from cruise to 5 px/s in ${f1(t)} s over ${(p.x - x0).toFixed(0)} px`);
  const d = (k) => Math.hypot(POI_BY_KEY[k].rx, POI_BY_KEY[k].ry);
  console.log(`O2 ${PLAYER.o2Max} s; at cruise: Colibri ${f1(d('colibri') / PLAYER.cruiseSpeed)} s, Orion ${f1(d('orion') / PLAYER.cruiseSpeed)} s away`);
}

// ---- belt crossings: radial lines through the ring, 24 headings × 2 lives
function cross(angle, speed, lifeSeed) {
  const g = fakeGame({ gen, lifeSeed }), p = g.player;
  const r0 = 1650, r1 = 2600;
  p.teleport(CENTER + Math.cos(angle) * r0, CENTER + Math.sin(angle) * r0);
  p.vx = Math.cos(angle) * speed; p.vy = Math.sin(angle) * speed;
  const h0 = p.hull;
  for (let i = 0; i < Math.ceil(((r1 - r0) / speed) * 60 * 1.6) && !p.dead; i++) {
    const s = Math.hypot(p.vx, p.vy);
    g.input.stick(s < speed ? Math.cos(angle) * 0.7 : 0, s < speed ? Math.sin(angle) * 0.7 : 0);
    tick(g, 1);
    if (Math.hypot(p.x - CENTER, p.y - CENTER) > r1) break;
  }
  return { dmg: p.dead ? h0 : h0 - p.hull, through: Math.hypot(p.x - CENTER, p.y - CENTER) > r1 };
}
for (const speed of [80, 140, 250]) {
  let sum = 0, max = 0, clean = 0, blocked = 0, n = 0;
  for (let i = 0; i < 24; i++) for (const ls of [1, 7]) {
    const r = cross((i / 24) * Math.PI * 2, speed, ls);
    n++; sum += r.dmg; max = Math.max(max, r.dmg);
    if (r.dmg === 0) clean++;
    if (!r.through) blocked++;
  }
  console.log(`belt @ ${speed} px/s: mean ${f1(sum / n)} hull, worst ${max.toFixed(0)}, unhurt ${clean}/${n}, stopped by a static rock ${blocked}/${n} (no steering)`);
}

// ---- shielded approach to Hélios from the north: cruise, then brake at y = brakeAt, then settle
function helios(brakeAt) {
  const g = fakeGame({ gen }), p = g.player;
  g.save.items.heatshield = true;
  const hy = POI_BY_KEY.helios.ry;
  p.teleport(CENTER + POI_BY_KEY.helios.rx, CENTER + hy - 730);
  let t = 0, phase = 0;
  while (t < 20 && !p.dead) {
    const y = p.y - CENTER;
    g.input.hold('brake', false); g.input.stick(0, 0);
    if (phase === 0) { g.input.stick(0, 1); if (y >= brakeAt) phase = 1; }
    else if (phase === 1) { g.input.hold('brake'); if (p.speed < 5) phase = 2; }
    else {
      const dy = hy - y;
      g.input.stick(0, Math.max(-1, Math.min(1, dy / 30)));
      if (Math.abs(dy) < 6 && p.speed < 20) g.input.hold('brake');
      if (Math.abs(dy) < 10 && p.speed < 10) break;
    }
    tick(g, 1); t += DT;
  }
  return p.dead ? 'dead' : `${Math.round(p.hull)} hull${g.world.zoneAt(p.x, p.y) === ZONE_ID.helios ? '' : ' (outside)'}`;
}
const pts = [3180, 3200, 3220, 3240, 3260];
console.log('Hélios, shielded, braking at y = ' + pts.map((b) => `${b}: ${helios(b)}`).join(' · '));
