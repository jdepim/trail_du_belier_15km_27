// GOUFFRE — boot, resize, fixed 60 Hz loop, state machine and game-level hooks.
// States: TITLE / PLAYING / PAUSED / SHOP / DEAD / VICTORY.
import { FIXED_DT, MAX_FRAME_DT, TILE, layerAtDepth } from './config.js';
import { TILES, TILE_ID, SOLID } from './tiles.js';
import { generateWorld } from './worldgen.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { Particles } from './particles.js';
import { Camera, Renderer } from './render.js';
import { Lighting } from './lighting.js';
import { Hud } from './hud.js';
import { Player } from './player.js';
import { EnemyManager } from './enemies.js';
import { EntityManager } from './entities.js';
import { loadSave, saveGame, applyUpgrades } from './meta.js';
import { createUI } from './ui.js';
import { loadSprites, makeIcon } from './sprites.js';
import { parseFlags, installDebug } from './debug.js';

const flags = parseFlags(location.search);

// ------------------------------------------------------------------ game context
const game = {
  flags,
  state: 'TITLE',
  time: 0,
  fps: 60,
  frozen: false,
  world: null,
  gen: null,
  run: null,
  save: null,
  safe: { l: 0, r: 0, t: 0, b: 0 },
  hitStopTicks: 0,
  deathT: -1,
};

// Hit-stop is counted in whole fixed ticks (at least one): comparing float
// seconds froze one tick more than asked (0.05 - 3/60 > 0).
game.hitStop = (s) => {
  if (!(s > 0)) return;
  game.hitStopTicks = Math.max(game.hitStopTicks, Math.max(1, Math.round(s / FIXED_DT)));
};
game.toast = (text, opts) => game.hud.toast(text, opts);

/** Hook: a tile was destroyed (by the player or anything else). */
game.tileBroken = (tx, ty, id, cause) => {
  const def = TILES[id];
  const x = tx * TILE + TILE / 2, y = ty * TILE + TILE / 2;
  game.particles.spawn('debris', x, y, { tileId: id, count: def.ore ? 12 : 9 });
  game.particles.spawn('dust', x, y + 4, { count: 3 });
  if (def.ore || def.light > 0) game.particles.spawn('glint', x, y, { color: def.colors[3] });
  game.audio.play('break', { material: def.sound });
  game.entities.onTileBroken(tx, ty, id, cause);
  // roots / stalactites / stalagmites... that hung from or stood on it crumble
  game.world.clearDetachedDeco(tx, ty, onDecoDetached);
};

function onDecoDetached(tx, ty, id) {
  const x = tx * TILE + TILE / 2, y = ty * TILE + TILE / 2;
  game.particles.spawn('debris', x, y, { tileId: id, count: 4 });
  game.particles.spawn('dust', x, y, { count: 2 });
}

/** Hook: the player died. Step 2 implements the full death flow (bag loss...). */
game.onPlayerDeath = () => {
  game.deathT = 1.4;
  game.save.stats.deaths++;
  saveGame(game.save);
};

game.setState = (s) => {
  const prev = game.state;
  game.state = s;
  game.input.setControlsVisible(s === 'PLAYING');
  if (s !== 'PLAYING') game.input.setContextAction(null);
  const ui = game.ui;
  switch (s) {
    case 'TITLE': ui.showTitle({ onPlay: () => game.startGame() }); break;
    case 'PLAYING': ui.hide(); break;
    case 'PAUSED':
      ui.showPause({
        onResume: () => game.setState('PLAYING'),
        onRestart: () => game.newRun(),
        onToggleMute: () => game.audio.toggleMute(),
      });
      break;
    case 'SHOP': ui.showShop({ onClose: () => game.setState('PLAYING') }); break;
    case 'DEAD': ui.showDeath({ depth: game.run ? game.run.bestDepth : 0 }, { onRestart: () => game.newRun() }); break;
    case 'VICTORY': ui.showVictory({}, { onContinue: () => game.setState('PLAYING') }); break;
    default: break;
  }
  if (prev === 'PLAYING' && s !== 'PLAYING') game.input.resetAll();
};

function randomSeed() { return (Math.random() * 4294967296) >>> 0; }

/** Generate a fresh mine and put the player at the camp. */
game.newWorld = (seed) => {
  const gen = generateWorld(seed);
  game.gen = gen;
  game.world = gen.world;
  game.renderer.invalidateAll();
  game.enemies.reset(gen.spawns);
  game.entities.reset(gen);
  game.particles.clear();
  applyUpgrades(game.player, game.save);
  game.player.reset(gen.camp.spawnX, gen.camp.spawnY);
  game.player.facing = 1;
  game.camera.snap();
  // camp lights: furnace, window, lamps
  const L = game.lighting;
  L.clearStatics();
  L.clearDynamic();
  const f = gen.camp.forge, gy = gen.camp.surfaceY * TILE;
  L.addStatic(f.x - 18, gy - 8, 0.95, [255, 140, 50]);
  L.addStatic(f.x - 3, gy - 28, 0.55, [255, 200, 110]);
  for (const p of gen.camp.props) if (p.kind === 'lamp') L.addStatic(p.x, gy - 18, 0.7, [255, 190, 100]);
  game.run = {
    seed: gen.seed, gold: 0, bag: [], bagCount: 0, relics: [], bestDepth: 0, maxLayer: 0, kills: 0, startTime: game.time,
  };
  game.deathT = -1;
  game.hitStopTicks = 0;
  game.currentLayer = 0;
};

/** New run after death / abandon: regenerate the mine, full HP, back to camp. */
game.newRun = (seed) => {
  game.save.stats.runs++;
  saveGame(game.save);
  game.newWorld(seed ?? randomSeed());
  game.setState('PLAYING');
  game.audio.setLayer(0);
};

/** From the title screen. */
game.startGame = (seed) => {
  game.audio.unlock();
  if (seed !== undefined && seed !== null) game.newWorld(seed);
  game.setState('PLAYING');
  game.audio.setLayer(0);
  game.hud.banner('LE CAMP', 'La mine s’ouvre sous tes pieds');
  if (flags.depth) window.__gouffre.teleportDepth(flags.depth);
  if (flags.gold && game.run) game.run.gold = flags.gold;
};

// ------------------------------------------------------------------ fixed update

let emberT = 0, glintT = 0, smokeT = 0;
const visLava = [], visOre = [];

function ambientEffects(dt) {
  const g = game;
  const cam = g.camera;
  smokeT -= dt;
  if (smokeT <= 0 && g.gen) {
    smokeT = 0.28;
    const f = g.gen.camp.forge, gy = g.gen.camp.surfaceY * TILE;
    g.particles.spawn('smoke', f.x - 40 + 60, gy - 60, { count: 1 });
  }
  emberT -= dt; glintT -= dt;
  if (emberT <= 0 || glintT <= 0) {
    // rescan visible special tiles a few times per second
    visLava.length = 0; visOre.length = 0;
    const w = g.world;
    const tx0 = Math.max(0, Math.floor(cam.x / TILE)), tx1 = Math.min(w.w - 1, Math.floor((cam.x + cam.viewW) / TILE));
    const ty0 = Math.max(0, Math.floor(cam.y / TILE)), ty1 = Math.min(w.h - 1, Math.floor((cam.y + cam.viewH) / TILE));
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const id = w.types[ty * w.w + tx];
      if (id === TILE_ID.LAVA && !SOLID[w.get(tx, ty - 1)] && w.get(tx, ty - 1) !== TILE_ID.LAVA) visLava.push(tx, ty);
      else if ((TILES[id].ore || id === TILE_ID.CRYSTAL) && !SOLID[w.get(tx, ty - 1)]) visOre.push(tx, ty);
    }
    if (emberT <= 0) {
      emberT = 0.09;
      if (visLava.length) {
        const k = (Math.floor(Math.random() * visLava.length / 2)) * 2;
        g.particles.spawn('ember', visLava[k] * TILE + 8, visLava[k + 1] * TILE + 2, { count: 1, spread: 14 });
      }
    }
    if (glintT <= 0) {
      glintT = 0.35;
      if (visOre.length) {
        const k = (Math.floor(Math.random() * visOre.length / 2)) * 2;
        const def = TILES[w.get(visOre[k], visOre[k + 1])];
        g.particles.spawn('glint', visOre[k] * TILE + 3 + Math.random() * 10, visOre[k + 1] * TILE + 3 + Math.random() * 10, { color: def.colors[3] });
      }
    }
  }
}

function updatePlaying(dt) {
  const g = game;
  g.time += dt;
  if (g.input.pressed('pause')) { g.setState('PAUSED'); return; }
  // dynamic lights are rebuilt every tick (any system may addLight during it)
  // and persist across render frames without a tick, hit-stop and pause
  g.lighting.clearDynamic();
  g.world.update(dt);
  g.player.update(dt);
  g.enemies.update(dt);
  g.entities.update(dt);
  g.particles.update(dt);
  g.camera.update(dt);
  g.hud.update(dt);
  ambientEffects(dt);
  g.enemies.addLights(g.lighting);

  const p = g.player;
  const run = g.run;
  // layers: banner on first entry, ambience follows the current layer
  const layer = layerAtDepth(p.depth);
  if (p.depth > run.bestDepth) run.bestDepth = p.depth;
  if (layer.index > run.maxLayer) {
    run.maxLayer = layer.index;
    g.hud.banner(layer.title, `Couche ${layer.index + 1} · −${layer.d0} m`);
  }
  if (layer.index !== g.currentLayer) { g.currentLayer = layer.index; g.audio.setLayer(layer.index); }

  // Forge: contextual interact near the blacksmith
  const f = g.gen.camp.forge;
  const nearForge = !p.dead && p.feetY <= g.gen.camp.surfaceY * TILE + 1 && Math.abs(p.cx - f.npcX) < f.interactRadius;
  const inter = nearForge ? { label: 'Forge' } : g.entities.interactionAt(p);
  g.input.setContextAction(inter ? inter.label : null);
  g.hud.setHint(inter ? `E : ${inter.label.toUpperCase()}` : null);
  if (inter && g.input.pressed('interact')) {
    if (nearForge) { g.setState('SHOP'); return; }
    if (inter.use) inter.use();
  }
  // TODO step 2: banking when the player is back in the camp zone (p.feetY <= camp.bankY)

  if (g.deathT > 0) {
    g.deathT -= dt;
    if (g.deathT <= 0) {
      g.save.stats.bestDepth = Math.max(g.save.stats.bestDepth, run.bestDepth);
      saveGame(g.save);
      g.setState('DEAD');
    }
  }
}

/** One fixed tick. Hit-stop freezes gameplay but keeps input edges latched. */
game.fixedStep = (dt) => {
  if (game.state !== 'PLAYING') return;
  if (game.hitStopTicks > 0) { game.hitStopTicks--; return; }
  game.input.beginTick();
  updatePlaying(dt);
  game.input.endTick();
};

// ------------------------------------------------------------------ frame loop

let last = 0, acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dt = last ? Math.min(MAX_FRAME_DT, Math.max(0, (now - last) / 1000)) : FIXED_DT;
  last = now;
  if (dt > 0) game.fps += (1 / dt - game.fps) * 0.05;
  game.input.poll();
  if (!game.frozen) {
    if (game.state === 'PLAYING') {
      acc += dt;
      let n = 0;
      while (acc >= FIXED_DT && n < 20) { acc -= FIXED_DT; game.fixedStep(FIXED_DT); n++; }
    } else {
      acc = 0;
      game.time += dt;
      // keyboard / gamepad navigation of the overlays
      const inp = game.input;
      inp.beginTick();
      const confirm = inp.pressed('jump') || inp.pressed('interact');
      if (game.state === 'TITLE' && confirm) game.startGame();
      else if ((game.state === 'PAUSED' || game.state === 'SHOP') && (inp.pressed('pause') || (confirm && game.state === 'SHOP'))) game.setState('PLAYING');
      else if (game.state === 'DEAD' && confirm) game.newRun();
      inp.endTick();
      if (game.state === 'TITLE') { ambientEffects(dt); game.particles.update(dt); game.player._updateAnim(dt); }
    }
  }
  const alpha = game.state === 'PLAYING' && !game.frozen ? Math.min(1, acc / FIXED_DT) : 1;
  game.renderer.render(alpha);
  game.audio.update();
}

// ------------------------------------------------------------------ resize / orientation / visibility

const safeProbe = document.getElementById('safe-probe');

function readSafeArea() {
  if (!safeProbe) return { l: 0, r: 0, t: 0, b: 0 };
  const cs = getComputedStyle(safeProbe);
  return { l: parseFloat(cs.paddingLeft) || 0, r: parseFloat(cs.paddingRight) || 0, t: parseFloat(cs.paddingTop) || 0, b: parseFloat(cs.paddingBottom) || 0 };
}

function isPortrait() { return window.innerHeight > window.innerWidth; }

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  game.renderer.resize(w, h, dpr);
  const css = readSafeArea();
  const k = game.renderer.cssToInternal;
  game.safe = { l: css.l * k, r: css.r * k, t: css.t * k, b: css.b * k };
  game.input.setSafeArea(css);
  if (game.ui) game.ui.relayout();
  if (game.world) game.camera.snap();
  if (isPortrait() && game.input.touchEnabled && game.state === 'PLAYING') game.setState('PAUSED');
}

let resizeQueued = false;
function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; resize(); });
  setTimeout(resize, 350); // iOS reports final sizes late after rotation
}

// ------------------------------------------------------------------ boot

function boot() {
  loadSprites();
  const canvas = document.getElementById('game');
  game.input = createInput();
  game.audio = createAudio();
  if (flags.mute) game.audio.setMuted(true);
  game.audio.debug = flags.debug;
  game.particles = new Particles(game);
  game.camera = new Camera(game);
  game.lighting = new Lighting(game);
  game.hud = new Hud(game);
  game.player = new Player(game);
  game.enemies = new EnemyManager(game);
  game.entities = new EntityManager(game);
  game.renderer = new Renderer(game, canvas);
  game.save = loadSave();
  game.ui = createUI(game, document.getElementById('ui'));
  game.input.attach({
    layer: document.getElementById('touch'),
    controlsRoot: document.getElementById('controls'),
    iconFactory: (name, px) => makeIcon(name, px),
  });
  game.input.onAnyInput = () => game.audio.unlock();
  game.input.onKey = (e) => {
    if (e.code === 'KeyM' && !e.repeat) { const m = game.audio.toggleMute(); game.toast(m ? 'SON COUPÉ' : 'SON ACTIVÉ'); }
    if (game.input.onKeyDebug) game.input.onKeyDebug(e);
  };

  resize();
  window.addEventListener('resize', queueResize);
  window.addEventListener('orientationchange', queueResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', queueResize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game.state === 'PLAYING') game.setState('PAUSED');
      game.audio.suspend();
    } else {
      game.audio.resume();
      last = 0;
    }
  });
  // iOS: no pinch / double-tap zoom, no rubber-band scrolling
  const prevent = (e) => e.preventDefault();
  document.addEventListener('gesturestart', prevent, { passive: false });
  document.addEventListener('dblclick', prevent, { passive: false });
  document.addEventListener('touchmove', (e) => { if (!e.target.closest || !e.target.closest('.ov')) e.preventDefault(); }, { passive: false });

  installDebug(game);
  game.newWorld(flags.seed ?? randomSeed());
  game.setState('TITLE');
  if (flags.autostart) game.startGame();
  requestAnimationFrame(frame);
  document.documentElement.classList.add('ready');
  // offline support (skipped in development so edits are never served stale)
  const local = ['localhost', '127.0.0.1', ''].includes(location.hostname);
  if ('serviceWorker' in navigator && !flags.nosw && !local && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
