// Presentation modules: pure helpers and browser-free behaviour (no DOM at import time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOUND_NAMES, LOOP_NAMES, ZONE_KEYS, createAudio } from '../../src/audio.js';
import { Particles } from '../../src/particles.js';
import { measureText, hasGlyphs, distLabel, edgePoint, TextMemo, Hud } from '../../src/hud.js';
import { TIPS } from '../../src/tips.js';
import { ITEMS, POI_NAMES } from '../../src/meta.js';
import { mapLayout, worldToMap } from '../../src/mapview.js';
import { getSprite, makeIcon } from '../../src/sprites.js';
import { Camera } from '../../src/render.js';
import { CENTER, BOUNDARY, POIS, ZONES } from '../../src/config.js';
import { PARTICLES, HUD_LAYOUT } from '../../src/render-config.js';

// Every sound the simulation emits (NOTES.md "Simulation") plus the shell / UI ones.
const SIM_SOUNDS = ['boost', 'brake', 'deny', 'fuel_empty', 'bump', 'impact', 'hurt', 'death', 'pickup_salvage',
  'pickup_o2', 'pickup_fuel', 'pickup_repair', 'item', 'dock', 'door', 'crate', 'terminal', 'satellite', 'refill',
  'capsule', 'charge_drop', 'charge_beep', 'charge_bounce', 'explosion', 'rock_break', 'laser_on', 'vent',
  'turret_lock', 'turret_fire', 'bolt_hit', 'turret_destroyed', 'flare_warn', 'flare'];
const SHELL_SOUNDS = ['deposit', 'buy', 'ui', 'ui_back', 'map', 'pause', 'respawn', 'victory', 'tip', 'warning'];
const SIM_PARTICLES = ['exhaust', 'brake', 'boost', 'spark', 'death', 'pickup', 'item', 'door', 'crate', 'satellite',
  'gas', 'gas_warn', 'shelter', 'muzzle', 'debris', 'rock', 'explosion'];
const EXTRA_PARTICLES = ['tile', 'smoke', 'embers', 'dust', 'shards', 'glint', 'flash', 'ring'];

test('audio: every emitted sound, loop and ambience zone exists', () => {
  for (const n of [...SIM_SOUNDS, ...SHELL_SOUNDS]) assert.ok(SOUND_NAMES.includes(n), `missing sound ${n}`);
  assert.deepEqual(LOOP_NAMES.slice().sort(), ['alarm', 'brake', 'heat', 'rumble', 'storm', 'thrust']);
  for (const z of ['space', 'interior', 'selene', 'twins', 'maelstrom', 'storm']) assert.ok(ZONE_KEYS.includes(z), `missing zone ${z}`);
});

test('audio: safe without an AudioContext (Node, before the first gesture)', () => {
  const a = createAudio();
  assert.equal(a.muted, false);
  a.play('explosion', { volume: 1, pitch: 1, material: '' });
  a.play('nope');
  a.setLoop('thrust', 0.5);
  a.setLoop('unknown', 1);
  a.setZone('maelstrom');
  a.tick(); a.suspend(); a.resume(); a.unlock();
  assert.equal(a.levels.thrust, 0.5);
  assert.equal(a.levels.unknown, undefined);
  assert.equal(a.zone, 'maelstrom');
  assert.equal(a.toggleMute(), true);
  assert.equal(a.muted, true);
  a.setMuted(false);
  assert.equal(a.muted, false);
});

test('particles: every kind spawns, opts are read synchronously, the pool is bounded', () => {
  const p = new Particles();
  const opts = { vx: 10, vy: 0, nx: 1, ny: 0, count: 4, power: 1, r: 20, material: 'rock', color: 'white' };
  for (const k of [...SIM_PARTICLES, ...EXTRA_PARTICLES]) {
    p.clear();
    p.spawn(k, 100, 100, opts);
    p.update(1e-4);
    assert.ok(p.alive > 0, `kind ${k} spawned nothing`);
  }
  // the buffer is reused by the simulation: mutating it after spawn must not change live particles
  p.clear();
  p.spawn('spark', 0, 0, opts);
  const x0 = Array.from(p.x.slice(0, 8));
  opts.nx = -1; opts.count = 99;
  p.update(0);
  assert.deepEqual(Array.from(p.x.slice(0, 8)), x0);
  for (let i = 0; i < 2000; i++) p.spawn('explosion', 0, 0, { r: 40, count: 30 });
  p.update(1e-4);
  assert.ok(p.alive <= PARTICLES.max);
  p.update(10);
  assert.equal(p.alive, 0);
  p.spawn('unknown-kind', 0, 0);
  p.update(1e-4);
  assert.equal(p.alive, 0);
});

test('hud font: accents measured like their base glyph, spaces 3 px', () => {
  assert.equal(measureText('É'), measureText('E'));
  assert.equal(measureText('gravité'), measureText('GRAVITE'));
  assert.equal(measureText('A B'), measureText('A') + 3 + 1 + measureText('B'));
  assert.equal(measureText(''), 0);
});

test('hud font: every place name, banner, tip and toast the HUD draws has glyphs', () => {
  const strings = [
    ...POIS.map((p) => p.name), ...ZONES.map((z) => z.name), ...Object.values(POI_NAMES),
    ...Object.values(ITEMS).flatMap((it) => [it.name, it.desc]),
    ...Object.values(TIPS).flatMap((t) => Object.values(t).flat()),
    'Le Maelström', 'Charybde', 'Les Jumelles', 'Lune Séléné', 'Ceinture de Charon', 'Tempête ionique',
    "Porte verrouillée : il te faut une carte d'accès.", 'Oxygène et carburant au maximum.',
    'Charges explosives rechargées.', "Trop de gravité pour s'arrimer : il te faut l'Ancre gravitationnelle.",
    "Plus de charges : recharge-les au dock ou au casier d'Orion.", 'Ferraille déposée : +12 (total 140)',
    'BALISE DE RAPPEL', "Retour à l'épave de l'Albatros", 'O2 BAS SURCHAUFFE GRAVITÉ CRITIQUE CARBURANT VIDE TEMPÊTE IONIQUE',
  ];
  for (const s of strings) assert.ok(hasGlyphs(s), `missing glyph in « ${s} »`);
});

test('hud: distance labels in metres (1 m = 8 px), rounded and cached', () => {
  assert.equal(distLabel(0), '0 m');
  assert.equal(distLabel(800), '100 m');
  assert.equal(distLabel(8 * 102), '100 m');
  assert.equal(distLabel(8 * 103), '105 m');
  assert.equal(distLabel(1e9), distLabel(2e9));
  assert.equal(distLabel(800), distLabel(800)); // same string instance, no per-frame building
});

test('hud: TextMemo rebuilds its string only when a value changes', () => {
  let calls = 0;
  const m = new TextMemo((a, b) => { calls++; return `${a}/${b}`; });
  const s1 = m.get(3, 4);
  assert.equal(m.get(3, 4), s1);
  assert.equal(calls, 1);
  assert.equal(m.get(5, 4), '5/4');
  assert.equal(calls, 2);
});

test('hud: radar arrows stay on the border, out of the message column and the reserved corners', () => {
  const lim = { x0: 10, y0: 10, x1: 590, y1: 270, topMin: 140, topMax: 500, topGap0: 234, topGap1: 366,
    botMin: 130, botMax: 400, leftMin: 60, leftMax: 180, rightMin: 60, rightMax: 150 };
  const out = { x: 0, y: 0, edge: -1 };
  edgePoint(300, 140, 1, 0, lim, out);
  assert.deepEqual([out.x, out.y, out.edge], [590, 140, 1]);
  edgePoint(300, 140, 0, -1, lim, out);                    // straight up: pushed out of the column
  assert.equal(out.edge, 0);
  assert.ok(out.x <= lim.topGap0 || out.x >= lim.topGap1);
  edgePoint(300, 140, 1, 1, lim, out);                     // down-right: slides out of the thumb corner
  assert.ok(out.edge === 1 ? out.y <= lim.rightMax : out.x <= lim.botMax);
  edgePoint(300, 140, -1, 0.9, lim, out);
  assert.ok(out.edge === 3 ? out.y <= lim.leftMax : out.x >= lim.botMin);
  edgePoint(300, 140, 0, 0, lim, out);                     // degenerate direction: still a border point
  assert.ok([0, 1, 2, 3].includes(out.edge));
  assert.ok(HUD_LAYOUT.topGapHalf > measureText('GRAVITÉ CRITIQUE') / 2);
});

test('hud: messages queue, deduplicate and expire (no DOM needed until draw)', () => {
  const game = { player: null, save: null, run: null, state: 'PLAYING' };
  const hud = new Hud(game);
  for (let i = 0; i < 5; i++) hud.toast('Message ' + i);
  hud.toast('Message 0');
  assert.equal(hud.toasts.length, 3);
  assert.equal(hud.queue.length, 2);
  hud.tip('Ligne 1', 'Ligne 2', { key: 'a' });
  hud.tip('Autre', '', { key: 'b' });
  assert.equal(hud.tipActive, true);
  hud.cancelTip('a');
  assert.equal(hud.tipData.key, 'b');
  for (let i = 0; i < 60 * 12; i++) hud.update(1 / 60);
  assert.equal(hud.toasts.length, 0);
  assert.equal(hud.tipActive, false);
  hud.banner('Titre', 'Sous-titre');
  assert.ok(hud.bannerT > 0);
  hud.reset();
  assert.equal(hud.bannerT, 0);
});

test('map: layout fits the screen with a legend, the sector centre maps to the square centre', () => {
  for (const [w, h] of [[633, 292], [562, 256], [844, 390], [480, 270]]) {
    const L = mapLayout(w, h, { l: 0, r: 0, t: 0, b: 0 }, {});
    assert.ok(L.x >= 0 && L.y >= 0 && L.x + L.size <= w && L.y + L.size <= h, `${w}×${h}`);
    assert.ok(L.legendW >= 100, `${w}×${h} legend ${L.legendW}`);
    const c = worldToMap(L, CENTER, CENTER, {});
    assert.ok(Math.abs(c.x - (L.x + L.size / 2)) < 1e-6 && Math.abs(c.y - (L.y + L.size / 2)) < 1e-6);
    const e = worldToMap(L, CENTER + BOUNDARY.r, CENTER, {});
    assert.ok(e.x < L.x + L.size);
  }
  const safe = mapLayout(633, 292, { l: 40, r: 40, t: 0, b: 0 }, {});
  assert.ok(safe.x >= 40 && safe.legendX + safe.legendW <= 633 - 40);
});

test('sprites: importable without a DOM; nothing rasterised before loadSprites()', () => {
  assert.equal(getSprite('astro'), null);
  assert.equal(makeIcon('boost', 28), null);
});

test('camera: follows with look-ahead (≤ CAMERA.lookAhead), snaps, pixel-snaps on the anchor, shakes decay', () => {
  const player = { x: 1000, y: 1000, vx: 0, vy: 0 };
  const game = { player, view: { w: 633, h: 292 } };
  const cam = new Camera(game);
  cam.snap();
  assert.equal(cam.x, 1000);
  player.vx = 400;
  for (let i = 0; i < 600; i++) { player.x += player.vx / 60; cam.update(1 / 60); }
  const lead = cam.x - player.x;
  assert.ok(lead > 0 && lead <= 71, `lead ${lead}`);
  const out = { x: 0, y: 0 };
  cam.renderPos(0.5, out, player.x + 0.3, player.y);
  assert.ok(Number.isInteger(out.x) && Number.isInteger(out.y));
  // the anchor lands on a whole screen pixel: round(anchor) - cam is an integer offset
  assert.equal(Math.round(player.x + 0.3) - out.x, Math.round(player.x + 0.3 - (cam.prevX + (cam.x - cam.prevX) * 0.5 - 633 / 2)));
  cam.shake(6, 0.3);
  cam.update(1 / 60);
  assert.ok(Math.hypot(cam.shakeX, cam.shakeY) > 0);
  cam.shake(1, 0.1);                                       // weaker shake does not override
  assert.equal(cam.shakeMag, 6);
  for (let i = 0; i < 30; i++) cam.update(1 / 60);
  assert.equal(cam.shakeX, 0);
});
