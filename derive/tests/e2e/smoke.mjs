// End-to-end smoke test (DESIGN.md §14): iPhone 13 landscape (touch), real browser, real game loop.
// Run: node tests/e2e/smoke.mjs   (Playwright is resolved from the global npm root; nothing is
// downloaded). Screenshots go to tests/e2e/screenshots/ (ignored by git).
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { startServer } from './server.mjs';

const require = createRequire(import.meta.url);
const pw = require(require.resolve('playwright', { paths: [execSync('npm root -g').toString().trim()] }));
const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(HERE, 'screenshots');
mkdirSync(SHOTS, { recursive: true });

const SAVE_KEY = 'derive.save.v1';
const results = [];
let failed = 0;

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`ok   - ${name} (${Date.now() - t0} ms)`);
    console.log(`ok   - ${name}`);
  } catch (e) {
    failed++;
    results.push(`FAIL - ${name}: ${e.message}`);
    console.log(`FAIL - ${name}\n       ${e.stack.split('\n').slice(0, 4).join('\n       ')}`);
  }
}

const { server, url } = await startServer();
const browser = await pw.chromium.launch();
const context = await browser.newContext({ ...pw.devices['iPhone 13 landscape'] });
const page = await context.newPage();
const consoleErrors = [], pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));

const G = (fn, arg) => page.evaluate(fn, arg);
const player = () => G(() => window.__derive.player());
const state = () => G(() => window.__derive.state());
const save = () => G(() => window.__derive.save());
const ents = () => G(() => window.__derive.entities());
const layout = () => G(() => window.__derive.input.layout());
const shot = (name) => page.screenshot({ path: resolve(SHOTS, name) });
async function waitFor(fn, timeout = 3000, every = 30) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting for condition');
    await page.waitForTimeout(every);
  }
}
const settle = (ms = 400) => page.waitForTimeout(ms);
const waitState = (s, timeout = 3000) => waitFor(async () => (await state()) === s, timeout);

// CDP touch (real touchstart / touchmove / touchend). touchEnd with points releases those points;
// touchEnd with [] releases every finger still down.
const cdp = await context.newCDPSession(page);
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 8, radiusY: 8, force: 1 })) });
async function tapAt(p, id = 90, hold = 60) {
  await touch('touchStart', [{ ...p, id }]);
  await page.waitForTimeout(hold);
  await touch('touchEnd', []);
}
/** Teleport, then wait until the contextual Action button shows `label`; returns its position. */
async function goTo(target, label) {
  await G((t) => { window.__derive.teleportTo(t); window.__derive.setPlayer({ vx: 0, vy: 0 }); }, target);
  return waitFor(async () => {
    const l = await layout();
    const text = await G(() => document.querySelector('.tbtn-ctx span').textContent);
    return !l.action.hidden && text === label ? l.action : null;
  }, 2000);
}
const center = (sel) => G((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);

try {
  await step('loads without errors, title screen shown at the integer internal resolution', async () => {
    await page.goto(`${url}/index.html?seed=12345&mute`);
    await page.waitForSelector('button[data-act=play]', { timeout: 8000 });
    assert.equal(await state(), 'TITLE');
    const info = await G(() => ({ ...window.__derive.info(), dev: [innerWidth * devicePixelRatio, innerHeight * devicePixelRatio] }));
    assert.deepEqual(info.dev, [2250, 1026], 'iPhone 13 landscape in Safari: 750 × 342 CSS px at 3×');
    assert.equal(info.view.scale, 4, 'floor(1026 / 250) = 4');
    assert.deepEqual([info.view.w, info.view.h], [Math.floor(2250 / 4), Math.floor(1026 / 4)]);
    assert.equal(info.touch, true);
    assert.match(await G(() => document.querySelector('[data-act=play]').innerText), /Jouer/i);
    await settle(400);
    await shot('01-title.png');
  });

  await step('tap "Jouer" starts at the Albatros with touch controls (Charge hidden)', async () => {
    await page.tap('button[data-act=play]');
    await waitState('PLAYING');
    assert.equal(await G(() => getComputedStyle(document.getElementById('controls')).display), 'block');
    const l = await layout();
    assert.equal(l.charge.hidden, true, 'no Charge button before the Explosives');
    assert.equal(l.brake.hidden, false);
    assert.equal(l.boost.hidden, false);
    const p = await player();
    const g = await G(() => window.__derive.gen());
    assert.ok(Math.hypot(p.x - g.spawn.x, p.y - g.spawn.y) < 2, 'at the spawn');
    await settle(600);
    await shot('02-albatros.png');
  });

  await step('render: the canvas holds the internal image, CSS upscales it (pixelated)', async () => {
    const r = await G(() => {
      const c = document.getElementById('game'), v = window.__derive.info().view;
      return { w: c.width, h: c.height, cssW: parseFloat(c.style.width), cssH: parseFloat(c.style.height), v, dpr: devicePixelRatio, ir: getComputedStyle(c).imageRendering };
    });
    assert.deepEqual([r.w, r.h], [r.v.w, r.v.h], 'backing store = internal resolution');
    assert.ok(Math.abs(r.cssW - (r.v.w * r.v.scale) / r.dpr) < 0.01 && Math.abs(r.cssH - (r.v.h * r.v.scale) / r.dpr) < 0.01, 'CSS size = internal × scale');
    assert.match(r.ir, /pixelated|crisp-edges/);
  });

  await step('onboarding: the thrust tip appears on a fresh save and is remembered', async () => {
    await waitFor(async () => (await save()).tips.move === 1, 4000);
    assert.equal(await G(() => window.__derive.game.hud.tipActive), true);
    await settle(1200);
    await shot('03-tip-move.png');
  });

  await step('touch: the floating stick thrusts in 2D with analog strength (CDP touch events)', async () => {
    const l = await layout();
    const sx = l.stickGhost.x, sy = l.stickGhost.y;
    const p0 = await player();
    await touch('touchStart', [{ x: sx, y: sy, id: 1 }]);
    for (let i = 1; i <= 4; i++) { await touch('touchMove', [{ x: sx + i * 10, y: sy - i * 5, id: 1 }]); await page.waitForTimeout(16); }
    await settle(500);
    const st = await G(() => window.__derive.input.state());
    assert.ok(st.moveX > 0.6 && st.moveY < -0.2, `thrust vector (${st.moveX.toFixed(2)}, ${st.moveY.toFixed(2)})`);
    assert.ok(Math.hypot(st.moveX, st.moveY) <= 1.0001, 'norm ≤ 1');
    assert.equal(await G(() => getComputedStyle(document.querySelector('.stick-base')).display), 'block');
    const p1 = await player();
    assert.ok(p1.thrust > 0.5, `thrusting (${p1.thrust})`);
    assert.ok(p1.vx > 20 && p1.vy < 0, `moving north-east (${p1.vx.toFixed(0)}, ${p1.vy.toFixed(0)})`);
    await shot('04-thrust.png');
    // half tilt = weaker thrust
    await touch('touchMove', [{ x: sx + 16, y: sy, id: 1 }]);
    await settle(80);
    const half = await G(() => window.__derive.input.state());
    assert.ok(half.moveX > 0.1 && half.moveX < 0.5, `analog: half tilt gives ${half.moveX.toFixed(2)}`);
    await touch('touchEnd', []);
    await settle(100);
    assert.equal((await G(() => window.__derive.input.state())).moveX, 0, 'stick released');
    assert.ok(Math.hypot(p1.x - p0.x, p1.y - p0.y) > 5, 'moved');
  });

  await step('touch: Frein stops the drift, Boost kicks (fuel spent)', async () => {
    // open space south of the wreck, room to drift
    await G(() => { const d = window.__derive, s = d.gen().spawn, p = d.spotNear(s.x, s.y + 320); d.teleport(p.x, p.y); d.setPlayer({ vx: 120, vy: 0, fuel: 100 }); });
    const l = await layout();
    await touch('touchStart', [{ x: l.brake.x, y: l.brake.y, id: 2 }]);
    await settle(150);
    assert.equal(await G(() => document.querySelector('.tbtn-brake').classList.contains('down')), true, 'pressed state');
    assert.equal((await player()).braking, true);
    await settle(700);
    const p = await player();
    await touch('touchEnd', []);
    assert.ok(p.speed < 2, `stopped (${p.speed.toFixed(1)} px/s)`);
    assert.ok(p.fuel < 100, 'the brake burns fuel');
    await settle(100);
    const f0 = (await player()).fuel;
    await tapAt(l.boost, 3);
    await settle(120);
    const b = await player();
    assert.ok(b.speed > 120, `boost impulse (${b.speed.toFixed(0)} px/s)`);
    assert.ok(b.fuel < f0 - 15, 'boost fuel');
    await G(() => { const d = window.__derive, s = d.gen().spawn; d.teleport(s.x, s.y); });
  });

  await step('touch: sliding between Frein and Boost never leaves a button stuck', async () => {
    const l = await layout();
    const A = l.brake, B = l.boost;
    await touch('touchStart', [{ x: A.x, y: A.y, id: 11 }]);
    for (const t of [B, A, B]) {
      for (let k = 1; k <= 4; k++) await touch('touchMove', [{ x: A.x + (t.x - A.x) * k / 4, y: A.y + (t.y - A.y) * k / 4, id: 11 }]);
      await page.waitForTimeout(40);
    }
    await touch('touchEnd', []);
    await settle(120);
    const st = await G(() => ({ ...window.__derive.input.state(), down: document.querySelectorAll('.tbtn.down').length }));
    for (const [a, v] of Object.entries(st.raw)) assert.equal(v, false, `${a} released`);
    assert.equal(st.down, 0, 'no button left in the down state');
    assert.equal(st.touches, 0);
    await G(() => window.__derive.setPlayer({ vx: 0, vy: 0 }));
  });

  await step('keyboard: physical keys (WASD on QWERTY = ZQSD on AZERTY), arrows, Shift brake', async () => {
    await page.keyboard.down('KeyW');
    await settle(60);
    assert.ok((await G(() => window.__derive.input.state())).moveY < -0.99, 'KeyW = up');
    await page.keyboard.down('KeyA');
    await settle(60);
    const d = await G(() => window.__derive.input.state());
    assert.ok(Math.abs(Math.hypot(d.moveX, d.moveY) - 1) < 1e-6 && d.moveX < 0, 'diagonal normalised');
    await page.keyboard.up('KeyW'); await page.keyboard.up('KeyA');
    await page.keyboard.down('ArrowRight'); await settle(60);
    assert.ok((await G(() => window.__derive.input.state())).moveX > 0.99, 'arrow');
    await page.keyboard.up('ArrowRight');
    await page.keyboard.down('Shift'); await settle(60);
    assert.equal((await G(() => window.__derive.input.state())).raw.brake, true, 'Shift = brake');
    await page.keyboard.up('Shift');
    await G(() => window.__derive.setPlayer({ vx: 0, vy: 0 }));
  });

  await step('salvage: a piece is picked up (carried), the dock deposits it and saves', async () => {
    const e = await ents();
    const g = await G(() => window.__derive.gen());
    const piece = e.pickups.filter((p) => p.kind === 'salvage').sort((a, b) => Math.hypot(a.x - g.spawn.x, a.y - g.spawn.y) - Math.hypot(b.x - g.spawn.x, b.y - g.spawn.y))[0];
    assert.ok(piece, 'a debris piece exists');
    const s0 = (await save()).salvage;
    await G((p) => window.__derive.teleport(p.x - 14, p.y), piece);
    await waitFor(async () => (await G(() => window.__derive.run())).salvage > 0, 3000);
    const carried = (await G(() => window.__derive.run())).salvage;
    await shot('05-salvage.png');
    await G(() => window.__derive.teleportTo('dock'));
    await waitFor(async () => (await save()).salvage === s0 + carried, 3000);
    assert.equal((await G(() => window.__derive.run())).salvage, 0, 'nothing carried any more');
    const stored = await G((k) => JSON.parse(localStorage.getItem(k)).salvage, SAVE_KEY);
    assert.equal(stored, s0 + carried, 'deposit saved');
    await waitFor(() => G(() => (window.__derive.save().tips || {}).deposit === 1), 4000);
  });

  await step('Établi: the contextual button opens it, buying spends deposited salvage and applies at once', async () => {
    await G(() => window.__derive.setBank(100));
    const btn = await goTo('workbench', 'Établi');
    await tapAt(btn, 4);
    await waitState('SHOP');
    assert.equal(await G(() => document.querySelector('[data-up=charges]').style.display), 'none', 'Soute à charges hidden before the Explosives');
    await settle(200);
    await shot('06-etabli.png');
    const o2Max0 = (await player()).stats.o2Max;
    await page.tap('[data-buy=o2]');
    const sv = await save();
    assert.equal(sv.upgrades.o2, 1);
    assert.equal(sv.salvage, 80);
    assert.equal((await player()).stats.o2Max, o2Max0 + 45, 'applied at once');
    assert.match(await G(() => document.querySelector('.shop-foot').textContent), /niveau 1/);
    const fits = await G(() => { const g = document.querySelector('.shop-grid'); return g.scrollHeight <= g.clientHeight + 1; });
    assert.ok(fits, 'the Établi fits without scrolling');
    await page.tap('[data-act=close]');
    await waitState('PLAYING');
  });

  await step('Orion: the door stays shut without the keycard, opens with it (saved tile change)', async () => {
    const btn = await goTo('orion:door1', 'Ouvrir');
    await tapAt(btn, 5);
    await settle(200);
    let door = (await ents()).doors.find((d) => d.id === 'orion:door1');
    assert.equal(door.open, false, 'locked without the keycard');
    assert.equal((await save()).items.keycard, false);
    await shot('07-door-locked.png');
    await G(() => window.__derive.give('keycard'));
    await tapAt(btn, 6);
    await waitFor(async () => (await ents()).doors.find((d) => d.id === 'orion:door1').open, 1500);
    door = (await ents()).doors.find((d) => d.id === 'orion:door1');
    const t = await G((d) => window.__derive.world.at(d.x, d.y), door);
    assert.equal(t.key, 'door_open');
    const stored = await G((k) => JSON.parse(localStorage.getItem(k)).world.mods.length, SAVE_KEY);
    assert.ok(stored > 0, 'door saved in the world mods');
    await settle(300);
    await shot('08-door-open.png');
  });

  await step('Explosives: the Charge button appears; a charge blasts the Tycho rubble (saved)', async () => {
    await G(() => window.__derive.give('explosives'));
    await waitFor(async () => !(await layout()).charge.hidden, 1000);
    await G(() => { window.__derive.teleportTo('rubble'); window.__derive.setPlayer({ vx: 0, vy: 0, angle: 0 }); });
    const g = await G(() => window.__derive.gen());
    const rubble = () => G((tiles) => tiles.map((i) => window.__derive.world.get(i % 1280, Math.floor(i / 1280)).key), g.rubble.tiles);
    assert.ok((await rubble()).every((k) => k === 'rubble'), 'plug intact');
    const l = await layout();
    const c0 = (await player()).charges;
    await tapAt(l.charge, 7);
    await waitFor(async () => (await player()).charges === c0 - 1, 1000);
    // get clear of the blast
    await G(() => { const p = window.__derive.player(); window.__derive.teleport(p.x + 90, p.y); });
    await settle(300);
    await shot('09-charge.png');
    await waitFor(async () => (await rubble()).every((k) => k !== 'rubble'), 4000);
    const mods = await G((k) => JSON.parse(localStorage.getItem(k)).world.mods.length, SAVE_KEY);
    assert.ok(mods >= g.rubble.tiles.length + 1, 'blasted rubble saved');
    await settle(200);
    await shot('10-rubble-gone.png');
  });

  await step('death by a sun: overlay with the cause, carried salvage lost, equipment kept, respawn at the Albatros', async () => {
    const deaths0 = (await save()).stats.deaths;
    const bank0 = (await save()).salvage;
    await G(() => window.__derive.setSalvage(12));
    const sun = (await G(() => window.__derive.hazards())).suns[0];
    await G((s) => window.__derive.teleport(s.x + s.coreR + 2, s.y), sun);
    await waitFor(async () => (await player()).dead, 1500);
    await settle(300);
    await shot('11-death-drift.png');
    await waitState('DEAD', 4000);
    await settle(150);
    const txt = await G(() => document.querySelector('[data-ui=death]').innerText);
    assert.match(txt, /Carbonisé par Hélios A/);
    assert.match(txt, /Ferraille transportée : 12/i);
    assert.match(txt, /Balise de rappel activée/);
    const sv = await save();
    assert.equal(sv.stats.deaths, deaths0 + 1, 'death saved');
    assert.equal(sv.salvage, bank0, 'deposited salvage kept');
    await shot('12-death.png');
    await page.tap('[data-act=respawn]');
    await waitState('PLAYING');
    const p = await player();
    const g = await G(() => window.__derive.gen());
    assert.equal(p.dead, false);
    assert.equal(p.hull, p.stats.maxHull);
    assert.ok(Math.hypot(p.x - g.spawn.x, p.y - g.spawn.y) < 2, 'back at the Albatros');
    assert.equal((await G(() => window.__derive.run())).salvage, 0, 'carried salvage lost');
    const items = (await save()).items;
    assert.equal(items.keycard && items.explosives, true, 'equipment kept');
    assert.equal((await layout()).charge.hidden, false, 'Charge still available');
    const door = (await ents()).doors.find((d) => d.id === 'orion:door1');
    assert.equal(door.open, true, 'the opened door stays open');
  });

  await step('map: the Carte button opens the sector map, Fermer closes it', async () => {
    const l = await layout();
    await tapAt(l.map, 8);
    await waitState('MAP');
    await settle(300);
    await shot('13-map.png');
    await page.tap('[data-act=close]');
    await waitState('PLAYING');
    await page.keyboard.press('Tab');
    await waitState('MAP');
    await page.keyboard.press('Escape');
    await waitState('PLAYING');
  });

  await step('log: a terminal opens the typewriter reader, a tap completes it; Pause → Journaux lists it', async () => {
    const btn = await goTo('albatros:terminal0', 'Lire');
    await tapAt(btn, 9);
    await waitState('LOG');
    await settle(250);
    const partial = await G(() => document.querySelector('.term-text').textContent.length);
    assert.ok(partial > 0, 'typing');
    await shot('14-log-typing.png');
    await page.tap('.term-text');
    await settle(50);
    const full = await G(() => ({ len: document.querySelector('.term-text').textContent.length, done: document.querySelector('.term-text').classList.contains('done') }));
    assert.equal(full.done, true);
    assert.ok(full.len > partial);
    await shot('15-log.png');
    await page.tap('[data-act=close]');
    await waitState('PLAYING');
    assert.ok((await save()).world.logs.includes('albatros'), 'log saved');
    const l = await layout();
    await tapAt(l.pause, 10);
    await waitState('PAUSED');
    await page.tap('[data-act=logs]');
    await waitFor(() => G(() => window.__derive.ui() === 'logs'));
    assert.equal(await G(() => document.querySelectorAll('.log-item:not(.unread)').length), 1);
    await shot('16-logs.png');
    await page.tap('[data-log=albatros]');
    await waitFor(() => G(() => window.__derive.ui() === 'log'));
    await page.keyboard.press('Escape');
    await waitFor(() => G(() => window.__derive.ui() === 'logs'));
    await page.tap('[data-act=back]');
    await waitFor(() => G(() => window.__derive.ui() === 'pause'));
    await shot('17-pause.png');
    await page.tap('[data-act=resume]');
    await waitState('PLAYING');
  });

  await step('pause → Balise de rappel: armed confirmation, then a death (carried salvage lost)', async () => {
    await G(() => window.__derive.setSalvage(5));
    const deaths0 = (await save()).stats.deaths;
    await G(() => window.__derive.pause());
    const rc = await center('[data-act=recall]');
    // a double tap opens the confirmation but never confirms
    for (let i = 0; i < 2; i++) { await tapAt(rc, 20 + i, 30); await page.waitForTimeout(100); }
    await settle(150);
    assert.equal(await state(), 'PAUSED', 'still paused');
    const order = await G(() => [...document.querySelectorAll('.row.confirm button')].map((b) => b.dataset.act));
    assert.deepEqual(order, ['cancel', 'recall-confirm'], '"Annuler" comes first');
    await shot('18-recall-confirm.png');
    await settle(500);
    await page.tap('[data-act=recall-confirm]');
    await waitState('DEAD', 4000);
    assert.match(await G(() => document.querySelector('[data-ui=death]').innerText), /Balise de rappel activée/);
    assert.equal((await save()).stats.deaths, deaths0 + 1);
    await page.tap('[data-act=respawn]');
    await waitState('PLAYING');
  });

  await step('portrait shows "Tourne ton iPhone" and pauses; landscape restores', async () => {
    await page.setViewportSize({ width: 342, height: 750 });
    await settle(600);
    assert.equal(await G(() => getComputedStyle(document.getElementById('rotate')).display), 'flex');
    assert.equal(await state(), 'PAUSED');
    await shot('19-portrait.png');
    await page.setViewportSize({ width: 750, height: 342 });
    await settle(600);
    assert.equal(await G(() => getComputedStyle(document.getElementById('rotate')).display), 'none');
    await page.tap('[data-act=resume]');
    await waitState('PLAYING');
    assert.equal((await G(() => window.__derive.info())).view.scale, 4);
  });

  await step('hit-stop freezes exactly the requested number of ticks', async () => {
    await G(() => window.__derive.freeze(true));
    const r = await G(() => {
      const d = window.__derive, g = d.game;
      d.setPlayer({ vx: 60, vy: 0 });
      g.hitStop(0.05); // 3 ticks
      const xs = [];
      for (let i = 0; i < 5; i++) xs.push(d.step(1).x);
      return xs;
    });
    await G(() => { window.__derive.setPlayer({ vx: 0, vy: 0 }); window.__derive.freeze(false); });
    assert.equal(r[0], r[1]); assert.equal(r[1], r[2]);
    assert.ok(r[3] > r[2], 'moves again on the 4th tick');
  });

  await step('menus answer while a thumb rests on the stick; every menu button is ≥ 44 px tall', async () => {
    const l = await layout();
    const S = { x: l.stickGhost.x, y: l.stickGhost.y, id: 41 };
    await touch('touchStart', [S]);
    await touch('touchMove', [{ ...S, x: S.x + 25 }]);
    await touch('touchStart', [{ ...S, x: S.x + 25 }, { x: l.pause.x, y: l.pause.y, id: 42 }]);
    await touch('touchEnd', [{ x: l.pause.x, y: l.pause.y, id: 42 }]);
    await waitState('PAUSED');
    const small = await G(() => [...document.querySelectorAll('#ui button')].filter((b) => b.getBoundingClientRect().height < 44).map((b) => b.dataset.act));
    assert.deepEqual(small, [], 'pause menu targets');
    const r = await center('[data-act=resume]');
    await touch('touchStart', [{ ...S, x: S.x + 25 }, { x: r.x, y: r.y, id: 43 }]);
    await touch('touchEnd', [{ x: r.x, y: r.y, id: 43 }]); // the stick thumb stays down
    await waitState('PLAYING', 1000);
    await touch('touchEnd', []);
    await G(() => window.__derive.setPlayer({ vx: 0, vy: 0 }));
  });

  await step('gamepad: a button held through a state change never confirms the next menu; D-pad / B navigate', async () => {
    await G(() => {
      window.__pad = { connected: true, id: 'mock', index: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })), mapping: 'standard' };
      Object.defineProperty(navigator, 'getGamepads', { value: () => [window.__pad], configurable: true });
    });
    const btn = (i, v) => G(([i, v]) => { window.__pad.buttons[i].pressed = v; }, [i, v]);
    try {
      await settle(100);
      await btn(0, true);                          // A held (boost)
      await settle(100);
      await btn(9, true); await settle(120); await btn(9, false); // Start
      await settle(250);
      assert.equal(await state(), 'PAUSED', 'the held A did not press "Reprendre"');
      await btn(0, false);
      await settle(80);
      // first D-pad press focuses the default button (Reprendre), the second moves down
      for (let i = 0; i < 2; i++) { await btn(13, true); await settle(60); await btn(13, false); await settle(60); }
      assert.equal(await G(() => document.activeElement && document.activeElement.dataset.act), 'map', 'D-pad moved the focus');
      await btn(1, true); await settle(80); await btn(1, false); // B = back
      await waitState('PLAYING', 1000);
    } finally {
      await G(() => { delete navigator.getGamepads; if (window.__derive.state() !== 'PLAYING') window.__derive.resume(); window.__derive.setPlayer({ vx: 0, vy: 0 }); });
      await settle(100);
    }
  });

  await step('victory: Embarquer without the anchor is refused; with it, cinematic, stats, continue', async () => {
    await G(() => window.__derive.freeze(true));
    let r = await G(() => {
      const d = window.__derive;
      d.teleportTo('capsule'); d.step(1);
      const label = d.entities().interactable && d.entities().interactable.label;
      d.input.tap('action'); d.step(2);
      return { label, state: d.state() };
    });
    assert.equal(r.label, 'Embarquer');
    assert.equal(r.state, 'PLAYING', 'no anchor: refused');
    await G(() => window.__derive.give('anchor'));
    r = await G(() => {
      const d = window.__derive;
      d.teleportTo('capsule'); d.step(1);
      d.input.tap('action'); d.step(2);
      return { state: d.state() };
    });
    await G(() => window.__derive.freeze(false));
    assert.equal(r.state, 'VICTORY');
    assert.equal((await save()).stats.victories, 1, 'victory saved');
    await settle(1800);
    await shot('20-cinematic-escape.png');
    await settle(3000);
    await shot('21-cinematic-earth.png');
    await settle(3200);
    await shot('22-cinematic-reentry.png');
    await settle(2600);
    await shot('23-cinematic-ocean.png');
    await page.tap('[data-act=skip]');
    await page.waitForSelector('[data-act=continue]', { timeout: 2000 });
    const txt = await G(() => document.querySelector('.victory').innerText);
    assert.match(txt, /temps de jeu/i); assert.match(txt, /journaux\s*1\/9/i); assert.match(txt, /carte explorée/i);
    await settle(700);
    await shot('24-victory.png');
    await page.tap('[data-act=continue]');
    await waitState('PLAYING');
    const p = await player();
    const g = await G(() => window.__derive.gen());
    assert.ok(Math.hypot(p.x - g.spawn.x, p.y - g.spawn.y) < 2, 'back at the Albatros');
  });

  await step('settings: Commandes, toggles (assist / tips), Transférer round trip', async () => {
    await G(() => window.__derive.pause());
    await page.tap('[data-act=controls]');
    await waitFor(() => G(() => window.__derive.ui() === 'controls'));
    const txt = await G(() => document.querySelector('[data-ui=controls]').innerText);
    assert.match(txt, /Joystick/); assert.match(txt, /clavier/i); assert.match(txt, /manette/i); assert.match(txt, /ZQSD/);
    await shot('25-controls.png');
    await page.tap('[data-act=back]');
    await waitFor(() => G(() => window.__derive.ui() === 'pause'));
    await page.tap('[data-act=settings]');
    await waitFor(() => G(() => window.__derive.ui() === 'settings'));
    await shot('26-settings.png');
    await page.tap('[data-act=assist]');
    assert.equal((await save()).settings.assist, false);
    await page.tap('[data-act=assist]');
    assert.equal((await save()).settings.assist, true);
    await page.tap('[data-act=tips]');
    assert.equal((await save()).settings.tips, false);
    await page.tap('[data-act=tips]');
    const sv = await save();
    assert.equal(sv.settings.tips, true);
    assert.deepEqual(sv.tips, {}, 'turning tips back on shows them again');
    await page.tap('[data-act=transfer]');
    const code = await G(() => document.querySelector('textarea.code').value);
    assert.match(code, /^DERIVE1:/);
    await shot('27-transfer.png');
    const bank0 = (await save()).salvage;
    await G(() => window.__derive.setBank(3));
    await page.fill('textarea.code:not([readonly])', 'n’importe quoi');
    await page.tap('[data-act=import]');
    assert.match(await G(() => document.querySelector('[data-ui=transfer] .msg').textContent), /invalide/);
    await page.fill('textarea.code:not([readonly])', code);
    await page.tap('[data-act=import]');
    assert.equal((await save()).salvage, 3, 'asks before replacing');
    await page.tap('[data-act=import]');
    await waitState('TITLE');
    assert.equal((await save()).salvage, bank0, 'code imported');
    assert.match(await G(() => document.querySelector('.ui-notice').textContent), /importée/);
    assert.match(await G(() => document.querySelector('[data-act=play]').innerText), /continuer/i);
  });

  await step('reload keeps the save (equipment, upgrades, door, rubble, log, fog); erase needs a confirmation', async () => {
    const before = await save();
    await page.reload();
    await page.waitForSelector('button[data-act=play]', { timeout: 8000 });
    const sv = await save();
    assert.deepEqual(sv.items, before.items);
    assert.equal(sv.upgrades.o2, 1);
    assert.equal(sv.stats.victories, 1);
    assert.ok(sv.world.logs.includes('albatros'));
    assert.equal(sv.fog, before.fog, 'fog kept');
    assert.equal((await ents()).doors.find((d) => d.id === 'orion:door1').open, true, 'door still open');
    const g = await G(() => window.__derive.gen());
    assert.equal(await G((i) => window.__derive.world.get(i % 1280, Math.floor(i / 1280)).key, g.rubble.tiles[0]), 'moon_floor', 'rubble still gone');
    await page.tap('[data-act=settings]');
    const er = await center('[data-act=erase]');
    for (let i = 0; i < 3; i++) { await tapAt(er, 50 + i, 30); await page.waitForTimeout(110); }
    await settle(150);
    assert.equal((await save()).stats.victories, 1, 'nothing erased by a triple tap');
    const danger = await G(() => { const b = document.querySelector('[data-act=erase-confirm]').getBoundingClientRect(); return { top: b.top, bottom: b.bottom }; });
    assert.ok(er.y < danger.top - 16 || er.y > danger.bottom + 16, 'the red button is not under the finger');
    await shot('28-erase-confirm.png');
    await settle(500);
    await page.tap('[data-act=erase-confirm]');
    await waitState('TITLE');
    const after = await save();
    assert.deepEqual([after.salvage, after.upgrades.o2, after.stats.victories, after.items.keycard], [0, 0, 0, false]);
    assert.equal(after.settings.tips, true, 'settings kept');
    assert.equal((await G((k) => JSON.parse(localStorage.getItem(k)), SAVE_KEY)).stats.victories, 0);
    assert.match(await G(() => document.querySelector('[data-act=play]').innerText), /jouer/i);
    assert.equal((await ents()).doors.find((d) => d.id === 'orion:door1').open, false, 'a fresh sector');
  });

  await step('storage blocked (Safari "block all cookies"): a notice says progress will not be kept', async () => {
    const ctx3 = await browser.newContext({ ...pw.devices['iPhone 13 landscape'] });
    await ctx3.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); });
    const p3 = await ctx3.newPage();
    const errs = [];
    p3.on('pageerror', (e) => errs.push(e.message));
    await p3.goto(`${url}/index.html?seed=12345&mute`);
    await p3.waitForSelector('.ui-notice', { timeout: 8000 });
    assert.match(await p3.evaluate(() => document.querySelector('.ui-notice').textContent), /Stockage indisponible/);
    await p3.screenshot({ path: resolve(SHOTS, '29-storage-notice.png') });
    await ctx3.close();
    assert.deepEqual(errs, []);
  });

  await step('title logo follows the rotation after a portrait (home-screen) boot', async () => {
    const ctx2 = await browser.newContext({ ...pw.devices['iPhone 13'] });
    const p2 = await ctx2.newPage();
    const errs = [];
    p2.on('pageerror', (e) => errs.push(e.message));
    await p2.goto(`${url}/index.html?seed=12345&mute`);
    await p2.waitForSelector('.pixel-logo', { timeout: 8000 });
    const logoSize = () => p2.evaluate(() => document.querySelector('.pixel-logo').style.height);
    const portrait = await logoSize();
    await p2.setViewportSize({ width: 750, height: 342 });
    await p2.waitForTimeout(600);
    const rotated = await logoSize();
    await p2.screenshot({ path: resolve(SHOTS, '30-title-after-rotate.png') });
    await ctx2.close();
    assert.notEqual(rotated, portrait, 'logo resized on rotation');
    assert.deepEqual(errs, []);
  });

  await step('zero console errors and page errors', async () => {
    assert.deepEqual(pageErrors, [], 'page errors');
    assert.deepEqual(consoleErrors, [], 'console errors');
    assert.deepEqual(await G(() => window.__derive.errors), [], 'window errors');
  });
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + results.join('\n'));
console.log(`\n# e2e: ${results.length - failed} passed, ${failed} failed — screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
