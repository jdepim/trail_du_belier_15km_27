// DÉRIVE — boot, resize, fixed 60 Hz loop with interpolation and hit-stop, state machine
// (TITLE / PLAYING / PAUSED / MAP / SHOP / LOG / DEAD / VICTORY) and the game-level hooks the
// simulation calls (DESIGN.md §13, NOTES.md "Simulation" → "Hooks called").
//
// The game context (window.__derive.game in tests) holds every system; main.js only wires them:
//   hooks: hitStop, toast, banner, onPlayerDeath, onItem, onSatellite, onLog, deposit, persist,
//          reveal, explosion, tileBroken, victory, setState, respawn
//   shell actions (ui.js / debug.js call them): startGame, requestPause, recall, buy, setMuted,
//          toggleMute, toggleAssist, toggleShake, toggleTips, importSave, eraseSave, startLife,
//          newWorld, fixedStep
// Each life: meta.createRun → applyUpgrades → hazards / entities reset → player.reset at the
// Albatros; the world (opened doors, blasted rubble) is never regenerated on death.
import { FIXED_DT, MAX_FRAME_DT, TILE, CENTER, ZONES, BELT, BOUNDARY, FOG } from './config.js';
import { TILES } from './tiles.js';
import { generateWorld } from './worldgen.js';
import { Player } from './player.js';
import { Hazards } from './hazards.js';
import { Entities } from './entities.js';
import {
  loadSaveEx, saveGame, storageAvailable, clearSave, exportSave, importSave, applyUpgrades, buyUpgrade,
  createRun, depositSalvage, settleDeath, flushRunStats, recordVictory, decodeFog, encodeFog, fogReveal,
  fogExplored, poiDiscovered, ITEMS, LOGS,
} from './meta.js';
import { createInput } from './input.js';
import { createAudio } from './audio.js';
import { Particles } from './particles.js';
import { Camera, Renderer } from './render.js';
import { Hud } from './hud.js';
import { loadSprites, makeIcon } from './sprites.js';
import { createUI } from './ui.js';
import { Coach } from './tips.js';
import { parseFlags, installDebug, applyStartFlags } from './debug.js';

/** Shell timings (s) and polling periods (ticks). */
const SHELL = {
  autosave: 20,          // periodic save while playing
  deathDelay: 1.8,       // the corpse drifts this long before the death overlay
  depositMerge: 1.0,     // salvage deposited within this window is announced as one toast
  fogEvery: 4,           // ticks between two fog reveals around the player
  placeEvery: 15,        // ticks between two place-name checks
  discoverEvery: 30,     // ticks between two "new place discovered" checks
};
const TOAST_INFO = { color: '#8fe3ff' };
const TOAST_GOOD = { color: '#9dffb0' };

const flags = parseFlags(location.search);

// ------------------------------------------------------------------ game context
const game = {
  flags,
  state: 'TITLE',
  time: 0,
  fps: 60,
  frozen: false,             // tests: stop the real-time loop, advance with fixedStep()
  world: null, gen: null, player: null, camera: null, input: null, audio: null, particles: null,
  renderer: null, hud: null, ui: null, hazards: null, entities: null, coach: null,
  save: null, run: null, fog: null,
  view: { w: 320, h: 180, scale: 1 },
  safe: { l: 0, r: 0, t: 0, b: 0 },   // safe-area insets in internal pixels
  hitStopTicks: 0,
  deathT: -1,                // > 0: death drift before the overlay
  deathInfo: null,           // meta.settleDeath() summary (death overlay)
  victoryInfo: null,         // meta.recordVictory() summary (victory overlay)
  logKey: null,              // log shown by the LOG state
  mapReturn: 'PLAYING',      // state restored when the map closes
  lifeStarted: false,        // "Jouer" was pressed this session (the title then says "Continuer")
  saveStatus: 'ok',
  storageWarned: false,
};

// per-session shell state (no allocation in the tick)
let autosaveT = 0, depositT = 0, depositAcc = 0, tick = 0;
let placeIdx = -1, lastShownName = '';
let discovered = new Uint8Array(0);
const FX = { vx: 0, vy: 0, nx: 0, ny: 0, count: 1, power: 1, r: 0, material: '', color: '' };

// ------------------------------------------------------------------ juice hooks

// Hit-stop counts whole fixed ticks (at least one): comparing float seconds froze a tick too many.
game.hitStop = (s) => {
  if (!(s > 0)) return;
  game.hitStopTicks = Math.max(game.hitStopTicks, Math.max(1, Math.round(s / FIXED_DT)));
};
game.toast = (text, opts) => game.hud.toast(text, opts);
game.banner = (title, sub) => game.hud.banner(title, sub);
game.explosion = (x, y, r, power, cause) => game.hazards.explode(x, y, r, power, cause);

/** Hook: a fragile tile was destroyed by an explosion. */
game.tileBroken = (tx, ty, id) => {
  const def = TILES[id];
  FX.vx = 0; FX.vy = 0; FX.nx = 0; FX.ny = 0; FX.count = 5; FX.power = 1; FX.r = TILE / 2;
  FX.material = def.sound || 'rock'; FX.color = def.colors[2];
  game.particles.spawn('rock', tx * TILE + TILE / 2, ty * TILE + TILE / 2, FX);
  game.coach.onTileBroken(def.key);
};

// ------------------------------------------------------------------ save

/**
 * Write the live state into the save (world mods, fog, run time / distance) and store it. The
 * first failure (storage blocked or full) tells the player once that progress will not be kept.
 */
game.persist = () => {
  const save = game.save;
  if (!save) return false;
  if (game.world) save.world.mods = game.world.exportMods();
  if (game.fog) save.fog = encodeFog(game.fog);
  if (game.run) flushRunStats(save, game.run);
  const ok = saveGame(save);
  if (!ok && !game.storageWarned) {
    game.storageWarned = true;
    if (game.ui) game.ui.notice('Stockage indisponible : la progression ne sera pas conservée.', 7);
  }
  autosaveT = 0;
  return ok;
};

/** Hook (satellites): lift the fog in a radius. */
game.reveal = (x, y, r) => { fogReveal(game.fog, x, y, r); };

/** Hook: carried salvage enters the dock. Announced once per trip (merged toast + "cha-ching"). */
game.deposit = () => {
  const r = depositSalvage(game.save, game.run);
  game.persist();
  if (r.amount <= 0) return r;
  depositAcc += r.amount;
  depositT = SHELL.depositMerge;
  return r;
};

function flushDepositToast() {
  game.audio.play('deposit', {});
  game.toast(`Ferraille déposée : +${depositAcc} (total ${game.save.salvage})`, TOAST_GOOD);
  depositAcc = 0;
  game.coach.onDeposit();
}

// ------------------------------------------------------------------ story / progression hooks

game.onItem = (key) => {
  const it = ITEMS[key];
  game.banner(it.name.toUpperCase(), it.desc);
  if (key === 'explosives') game.input.setButtonVisible('charge', true);
  game.coach.onItem(key);
};

game.onSatellite = () => {
  game.toast('Satellite activé : la carte se dévoile', TOAST_INFO);
  game.coach.onSatellite();
};

game.onLog = (key) => {
  if (!LOGS[key]) return;
  game.logKey = key;
  game.setState('LOG');
};

/** Hook: the player died. Carried salvage lost, save written, overlay after the drift. */
game.onPlayerDeath = (cause) => {
  if (!game.run) return;
  game.deathInfo = settleDeath(game.save, game.run, cause);
  depositT = 0; depositAcc = 0;
  game.persist();
  game.deathT = SHELL.deathDelay;
};

/** Hook: Embarquer with the anchor. The carried salvage comes home too; stats; cinematic. */
game.victory = () => {
  if (game.state !== 'PLAYING' || game.player.dead) return;
  const save = game.save;
  depositSalvage(save, game.run);
  game.victoryInfo = recordVictory(save, game.run, fogExplored(game.fog));
  game.victoryInfo.salvage = save.salvage;
  game.persist();
  game.lifeStarted = false;
  game.audio.play('victory', {});
  game.setState('VICTORY');
};

// ------------------------------------------------------------------ workbench & settings

/** Établi purchase (ui.showShop calls it) → meta.buyUpgrade result. */
game.buy = (key) => {
  const r = buyUpgrade(game.save, key);
  if (!r.ok) { game.audio.play('deny', {}); return r; }
  game.persist();
  applyUpgrades(game.player, game.save);
  game.audio.play('buy', {});
  return r;
};

game.setMuted = (m) => {
  game.audio.setMuted(!!m);
  game.save.settings.muted = !!m;
  game.persist();
  return game.audio.muted;
};
game.toggleMute = () => game.setMuted(!game.audio.muted);
game.toggleAssist = () => { const s = game.save.settings; s.assist = s.assist === false; game.persist(); return s.assist; };
game.toggleShake = () => { const s = game.save.settings; s.shake = s.shake === false; game.persist(); return s.shake; };
/** Astuces: off hides them; back on shows every tip again. */
game.toggleTips = () => {
  const s = game.save.settings;
  s.tips = s.tips === false;
  if (s.tips) game.save.tips = {};
  else game.coach.hide();
  game.persist();
  return s.tips;
};

/**
 * Réglages → Transférer: replace the progress with a code from the other copy of the game (the
 * Safari tab and the home-screen app keep separate storage). This device's settings are kept.
 * Returns false for an invalid code.
 */
game.importSave = (text) => {
  const next = importSave(text);
  if (!next) return false;
  next.settings = { ...game.save.settings };
  game.save = next;
  game.newWorld();
  game.persist();
  return true;
};

/** Réglages → Effacer la sauvegarde (confirmed): fresh save and sector, settings kept. */
game.eraseSave = () => {
  const settings = { ...game.save.settings };
  game.save = clearSave();
  game.save.settings = settings;
  game.newWorld();
  game.persist();
};

// ------------------------------------------------------------------ world & lives

/** (Re)build the sector from the save: generation, saved tile mods, fog; then a new life. */
game.newWorld = () => {
  const gen = generateWorld(game.save.seed);
  game.gen = gen;
  game.world = gen.world;
  game.world.applyMods(game.save.world.mods);
  game.fog = decodeFog(game.save.fog);
  if (flags.reveal) fogReveal(game.fog, CENTER, CENTER, CENTER * 1.5);
  discovered = new Uint8Array(gen.pois.length);
  for (let i = 0; i < gen.pois.length; i++) discovered[i] = poiDiscovered(game.fog, gen.pois[i]) ? 1 : 0;
  game.renderer.invalidateAll();
  game.lifeStarted = false;
  game.startLife();
};

/** A new life at the Albatros (boot, respawn, after the victory). */
game.startLife = () => {
  const save = game.save, gen = game.gen;
  game.run = createRun(save, game.run);
  applyUpgrades(game.player, save);
  game.hazards.reset(gen, game.run.lifeSeed);
  game.entities.reset(gen, game.run.lifeSeed);
  game.player.reset(gen.spawn.x, gen.spawn.y);
  game.particles.clear();
  game.hud.reset();
  game.coach.reset();
  game.input.setButtonVisible('charge', !!save.items.explosives);
  game.camera.snap();
  game.deathT = -1;
  game.hitStopTicks = 0;
  depositT = 0; depositAcc = 0; autosaveT = 0;
  placeIdx = -1; lastShownName = '';
};

/** Death overlay "Repartir": the Balise de rappel brings the astronaut back to the Albatros. */
game.respawn = () => {
  game.startLife();
  game.setState('PLAYING');
  game.audio.play('respawn', {});
  game.banner('BALISE DE RAPPEL', "Retour à l'épave de l'Albatros");
};

/** Title "Jouer" / "Continuer". */
game.startGame = () => {
  game.audio.unlock();
  const first = !game.lifeStarted;
  game.lifeStarted = true;
  game.setState('PLAYING');
  if (!first) return;
  const fresh = game.save.stats.deaths === 0 && game.save.salvage === 0 && !game.save.items.keycard;
  if (fresh) game.banner("ÉPAVE DE L'ALBATROS", 'Rejoins le Module de retour Ulysse, tout au nord');
  else game.banner("ÉPAVE DE L'ALBATROS", 'Ton équipement t’attend');
  applyStartFlags(game);
};

/**
 * Pause request (Pause button / Échap, app hidden, portrait). During the death drift the life is
 * already settled: go straight to the death overlay.
 */
game.requestPause = () => {
  if (game.state !== 'PLAYING') return;
  if (game.player.dead) { game.deathT = -1; game.setState('DEAD'); return; }
  game.setState('PAUSED');
};

/** Pause → Balise de rappel (confirmed): a voluntary death, the carried salvage is lost. */
game.recall = () => {
  if (game.player.dead) { game.setState('DEAD'); return; }
  game.setState('PLAYING');
  game.player.die('recall', { force: true });
};

// ------------------------------------------------------------------ states

function inSafariTab() {
  if (!game.input.touchEnabled) return false;
  const standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches);
  return !standalone;
}

function settingsArgs(onBack) {
  return {
    storage: game.saveStatus === 'unavailable' ? false : storageAvailable(),
    onToggleMute: () => game.toggleMute(),
    onToggleAssist: () => game.toggleAssist(),
    onToggleShake: () => game.toggleShake(),
    onToggleTips: () => game.toggleTips(),
    onExport: () => { game.persist(); return exportSave(game.save); },
    onImport: (text) => {
      if (!game.importSave(text)) return false;
      game.setState('TITLE');
      game.ui.notice('Progression importée.');
      return true;
    },
    onErase: () => {
      game.eraseSave();
      game.setState('TITLE');
      game.ui.notice('Sauvegarde effacée.');
    },
    onBack,
  };
}

function showTitle() {
  game.ui.showTitle({
    resume: game.lifeStarted,
    touch: game.input.touchEnabled,
    installHint: inSafariTab(),
    onPlay: () => game.startGame(),
    onSettings: () => game.ui.showSettings(settingsArgs(showTitle)),
  });
}

function showPause() {
  game.ui.showPause({
    onResume: () => game.setState('PLAYING'),
    onMap: () => { game.mapReturn = 'PAUSED'; game.setState('MAP'); },
    onLogs: () => showLogs(),
    onControls: () => game.ui.showControls(showPause),
    onSettings: () => game.ui.showSettings(settingsArgs(showPause)),
    onRecall: () => game.recall(),
  });
}

function showLogs() {
  game.ui.showLogs({
    onOpen: (key) => game.ui.showLog(key, { onClose: showLogs }),
    onBack: showPause,
  });
}

game.setState = (s) => {
  const prev = game.state;
  game.state = s;
  game.input.setControlsVisible(s === 'PLAYING');
  if (s !== 'PLAYING') game.input.setContextAction(null);
  const ui = game.ui;
  switch (s) {
    case 'TITLE': showTitle(); break;
    case 'PLAYING': ui.hide(); break;
    case 'PAUSED': showPause(); break;
    case 'MAP': ui.showMap({ onClose: () => game.setState(game.mapReturn) }); break;
    case 'SHOP': ui.showShop({ onBuy: (key) => game.buy(key), onClose: () => game.setState('PLAYING') }); break;
    case 'LOG': ui.showLog(game.logKey, { onClose: () => game.setState('PLAYING') }); break;
    case 'DEAD': ui.showDeath(game.deathInfo, { onRespawn: () => game.respawn() }); break;
    case 'VICTORY':
      ui.showVictory(game.victoryInfo, {
        onContinue: () => { game.startLife(); game.lifeStarted = true; game.setState('PLAYING'); game.banner("ÉPAVE DE L'ALBATROS", 'Le secteur a encore des secrets'); },
        onTitle: () => { game.startLife(); game.setState('TITLE'); },
      });
      break;
    default: break;
  }
  if (prev === 'PLAYING' && s !== 'PLAYING') {
    game.input.resetAll();
    if (s === 'PAUSED' || s === 'MAP') game.audio.play(s === 'MAP' ? 'map' : 'pause', {});
  }
};

// ------------------------------------------------------------------ place names & discoveries

// Place names: interior zones (ZONE_PLACE0 + zone id) are announced by the HUD itself; the
// open-space regions before them are named here on entry.
const PLACE_NONE = 0;
const PLACES = ['', 'Le Maelström', 'Charybde', 'Les Jumelles', 'Lune Séléné', 'Ceinture de Charon', 'Tempête ionique'];
const ZONE_PLACE0 = PLACES.length;
for (const z of ZONES) PLACES.push(z.name);

function placeAt(x, y) {
  const z = game.world.zoneAt(x, y);
  if (z > 0) return ZONE_PLACE0 + z;
  const h = game.hazards;
  for (let i = 0; i < h.blackHoles.length; i++) {
    const b = h.blackHoles[i];
    if (Math.hypot(x - b.x, y - b.y) < (b.key === 'maelstrom' ? 1100 : 600)) return b.key === 'maelstrom' ? 1 : 2;
  }
  if (h.suns.length === 2) {
    const mx = (h.suns[0].x + h.suns[1].x) / 2, my = (h.suns[0].y + h.suns[1].y) / 2;
    if (Math.hypot(x - mx, y - my) < h.suns[0].heatR + 350) return 3;
  }
  const m = h.moon;
  if (m && Math.hypot(x - m.x, y - m.y) < m.r + 350) return 4;
  const d = Math.hypot(x - CENTER, y - CENTER);
  if (d > BOUNDARY.r - 150) return 6;
  if (d > BELT.rInner - 80 && d < BELT.rOuter + 80) return 5;
  return PLACE_NONE;
}

function updatePlace() {
  const p = game.player;
  const i = placeAt(p.x, p.y);
  if (i === placeIdx) return;
  placeIdx = i;
  const name = PLACES[i];
  if (name && name !== lastShownName) {
    lastShownName = name;
    if (i < ZONE_PLACE0) game.hud.zoneName(name);
  }
}

function checkDiscoveries() {
  const pois = game.gen.pois;
  for (let i = 0; i < pois.length; i++) {
    if (discovered[i] || !poiDiscovered(game.fog, pois[i])) continue;
    discovered[i] = 1;
    if (!pois[i].always) game.toast(`Découvert : ${pois[i].name}`, TOAST_INFO);
  }
}

// ------------------------------------------------------------------ fixed update

function updatePlaying(dt) {
  const g = game, p = g.player, inp = g.input;
  g.time += dt;
  if (inp.pressed('pause')) { g.requestPause(); return; }
  if (inp.pressed('map') && !p.dead) { g.mapReturn = 'PLAYING'; g.setState('MAP'); return; }
  p.update(dt);
  g.hazards.update(dt);
  g.entities.update(dt);   // runs the dock (deposit via game.deposit, refill, charges)
  g.particles.update(dt);
  g.camera.update(dt);
  g.hud.update(dt);
  tick = (tick + 1) | 0;
  if (!p.dead) {
    if (tick % SHELL.fogEvery === 0) fogReveal(g.fog, p.x, p.y, FOG.revealR);
    if (tick % SHELL.placeEvery === 0) updatePlace();
    if (tick % SHELL.discoverEvery === 0) checkDiscoveries();
  }
  const it = g.entities.interactable;
  inp.setContextAction(it && g.state === 'PLAYING' ? it.label : null);
  g.coach.update(dt);
  if (depositT > 0 && (depositT -= dt) <= 0) flushDepositToast();
  if (!p.dead && (autosaveT += dt) >= SHELL.autosave) g.persist();
  if (g.deathT > 0 && (g.deathT -= dt) <= 0 && g.state === 'PLAYING') g.setState('DEAD');
}

/** One fixed tick. Hit-stop freezes the simulation but keeps the input edges latched. */
game.fixedStep = (dt) => {
  if (game.state !== 'PLAYING') return;
  if (game.hitStopTicks > 0) { game.hitStopTicks--; return; }
  game.input.beginTick();
  updatePlaying(dt);
  game.input.endTick();
};

// ------------------------------------------------------------------ frame loop

let last = 0, acc = 0;

function menuInput() {
  const inp = game.input;
  inp.beginTick();
  if (inp.navX || inp.navY) game.ui.move(inp.navX, inp.navY);
  const back = inp.takePadBack();
  if (inp.pressed('pause') || back || (game.state === 'MAP' && inp.pressed('map'))) game.ui.back();
  else if (inp.pressed('boost') || inp.pressed('action')) game.ui.activate();
  inp.endTick();
  inp.navX = 0; inp.navY = 0;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = last ? Math.min(MAX_FRAME_DT, Math.max(0, (now - last) / 1000)) : FIXED_DT;
  last = now;
  if (dt > 0) game.fps += (1 / dt - game.fps) * 0.05;
  game.input.poll();
  if (!game.frozen) {
    if (game.state === 'PLAYING') {
      game.input.navX = 0; game.input.navY = 0; game.input.padBackEdge = false; // menu-only pad edges
      acc += dt;
      let n = 0;
      while (acc >= FIXED_DT && n < 20) { acc -= FIXED_DT; game.fixedStep(FIXED_DT); n++; }
    } else {
      acc = 0;
      game.time += dt;
      menuInput();
      game.ui.update(dt);
    }
  }
  const alpha = game.state === 'PLAYING' && !game.frozen ? Math.min(1, acc / FIXED_DT) : 1;
  game.renderer.render(alpha); // also drives the audio loops and the ambience zone
}

// ------------------------------------------------------------------ resize / orientation / visibility

const safeProbe = document.getElementById('safe-probe');

function readSafeArea() {
  const cs = getComputedStyle(safeProbe);
  return { l: parseFloat(cs.paddingLeft) || 0, r: parseFloat(cs.paddingRight) || 0, t: parseFloat(cs.paddingTop) || 0, b: parseFloat(cs.paddingBottom) || 0 };
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  game.renderer.resize(w, h, dpr);
  const css = readSafeArea();
  const k = dpr / game.view.scale; // CSS px → internal px
  game.safe = { l: css.l * k, r: css.r * k, t: css.t * k, b: css.b * k };
  game.input.setSafeArea(css);
  game.ui.relayout();
  if (game.world) game.camera.snap();
  if (window.innerHeight > window.innerWidth && game.input.touchEnabled) game.requestPause();
}

let resizeQueued = false;
function queueResize() {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; resize(); });
  setTimeout(resize, 350); // iOS reports the final size late after a rotation
}

// ------------------------------------------------------------------ boot

function boot() {
  loadSprites();
  const canvas = document.getElementById('game');
  game.input = createInput();
  game.audio = createAudio();
  game.particles = new Particles();
  game.camera = new Camera(game);
  game.hud = new Hud(game);
  game.player = new Player(game);
  game.hazards = new Hazards(game);
  game.entities = new Entities(game);
  game.renderer = new Renderer(game, canvas);
  game.coach = new Coach(game);
  const loaded = loadSaveEx();
  game.save = loaded.save;
  game.saveStatus = loaded.status;
  if (flags.seed !== null) game.save.seed = flags.seed;
  if (flags.bank !== null) game.save.salvage = flags.bank;
  if (flags.items) for (const k of flags.items) game.save.items[k] = true;
  game.audio.setMuted(flags.mute || game.save.settings.muted);
  // Réglages → Secousses
  const rawShake = game.camera.shake.bind(game.camera);
  game.camera.shake = (px, s) => { if (game.save.settings.shake !== false) rawShake(px, s); };
  game.ui = createUI(game, document.getElementById('ui'));
  game.input.attach({
    layer: document.getElementById('touch'),
    controlsRoot: document.getElementById('controls'),
    iconFactory: (name, px) => makeIcon(name, px),
  });
  game.input.onAnyInput = () => game.audio.unlock();

  resize();
  window.addEventListener('resize', queueResize);
  window.addEventListener('orientationchange', queueResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', queueResize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      game.requestPause();
      game.persist();
      game.audio.suspend();
    } else {
      game.audio.resume();
      last = 0;
    }
  });
  window.addEventListener('pagehide', () => game.persist());
  // iOS: no pinch / double-tap zoom, no rubber-band scrolling (overlays scroll on their own)
  const prevent = (e) => e.preventDefault();
  document.addEventListener('gesturestart', prevent, { passive: false });
  document.addEventListener('dblclick', prevent, { passive: false });
  document.addEventListener('touchmove', (e) => { if (!e.target.closest || !e.target.closest('.ov')) e.preventDefault(); }, { passive: false });

  installDebug(game);
  game.newWorld();
  game.setState('TITLE');
  if (game.saveStatus === 'corrupt') game.ui.notice('Sauvegarde illisible : une nouvelle a été créée.');
  else if (game.saveStatus === 'unavailable' || !storageAvailable()) {
    game.storageWarned = true;
    game.ui.notice('Stockage indisponible : la progression ne sera pas conservée.', 7);
  }
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
