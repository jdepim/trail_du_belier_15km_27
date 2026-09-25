// GOUFFRE — boot, resize, fixed 60 Hz loop, state machine and game-level hooks.
// States: TITLE / PLAYING / PAUSED / SHOP / DEAD / VICTORY.
import { FIXED_DT, MAX_FRAME_DT, TILE, ECONOMY, layerAtDepth } from './config.js';
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
import { loadSaveEx, saveGame, applyUpgrades, bankLoot, settleDeath, forfeitLoot, clearSave, buyUpgrade, storageAvailable, exportSave, importSave } from './meta.js';
import { Coach } from './tips.js';
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
  victoryT: -1,
  runActive: false,     // an expedition is under way (the title offers "Continuer")
  deathInfo: null,      // summary of the last death (death screen)
  victoryInfo: null,    // summary of the last victory (victory screen)
  saveStatus: 'ok',     // 'ok' | 'new' | 'corrupt' | 'unavailable'
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
  if (id === TILE_ID.TRAPDOOR) openTrapdoor(tx, ty);
  if (cause === 'player' && game.player.strikeDir === 'down') game.coach.onDigDown();
  game.particles.spawn('debris', x, y, { tileId: id, count: def.ore ? 12 : 9 });
  game.particles.spawn('dust', x, y + 4, { count: 3 });
  if (def.ore || def.light > 0) game.particles.spawn('glint', x, y, { color: def.colors[3] });
  game.audio.play('break', { material: def.sound });
  game.entities.onTileBroken(tx, ty, id, cause);
  // roots / stalactites / stalagmites... that hung from or stood on it crumble
  game.world.clearDetachedDeco(tx, ty, onDecoDetached);
};

/** One strike on the camp trapdoor opens all of it (the other planks swing away). */
function openTrapdoor(tx, ty) {
  const w = game.world;
  for (const dir of [-1, 1]) {
    for (let x = tx + dir; w.get(x, ty) === TILE_ID.TRAPDOOR; x += dir) {
      w.set(x, ty, TILE_ID.AIR);
      game.particles.spawn('debris', x * TILE + TILE / 2, ty * TILE + TILE / 2, { tileId: TILE_ID.TRAPDOOR, count: 6 });
    }
  }
  game.trapdoorT = 0;
}

/**
 * The trapdoor closes again once the hero is back on the camp ground, a tile or more
 * away from the shaft, for TRAPDOOR_CLOSE seconds: the camp stays walkable from the
 * Forge to the far side, and every trip down starts by opening it (one strike).
 */
const TRAPDOOR_CLOSE = 1.0;
function campTrapdoor(inCamp, dt) {
  const g = game, p = g.player, td = g.gen.camp.trapdoor, w = g.world;
  if (!td) return;
  let open = false;
  for (let x = td.x0; x <= td.x1; x++) if (w.get(x, td.y) === TILE_ID.AIR) { open = true; break; }
  const x0 = td.x0 * TILE, x1 = (td.x1 + 1) * TILE;
  const away = p.x + p.w < x0 - TILE || p.x > x1 + TILE;
  if (!open || !inCamp || !p.onGround || !away) { g.trapdoorT = 0; return; }
  g.trapdoorT = (g.trapdoorT || 0) + dt;
  if (g.trapdoorT < TRAPDOOR_CLOSE) return;
  // never close on something: a pickup or an enemy in the plank row waits
  const y0 = td.y * TILE, y1 = y0 + TILE;
  for (const q of g.entities.pickups) if (q.active && q.x < x1 && q.x + q.w > x0 && q.y < y1 && q.y + q.h > y0) return;
  for (const e of g.enemies.list) if (e.alive && e.x < x1 && e.x + e.w > x0 && e.y < y1 && e.y + e.h > y0) return;
  for (let x = td.x0; x <= td.x1; x++) {
    if (w.get(x, td.y) !== TILE_ID.AIR) continue;
    w.set(x, td.y, TILE_ID.TRAPDOOR);
    g.particles.spawn('dust', x * TILE + TILE / 2, y0 + 2, { count: 3 });
  }
  g.audio.play('hit', { material: 'wood', pitch: 0.7 });
  g.trapdoorT = 0;
}

function onDecoDetached(tx, ty, id) {
  const x = tx * TILE + TILE / 2, y = ty * TILE + TILE / 2;
  game.particles.spawn('debris', x, y, { tileId: id, count: 4 });
  game.particles.spawn('dust', x, y, { count: 2 });
}

// ------------------------------------------------------------------ meta hooks (step 2b)

/**
 * Write the save now (banking, purchase, death, victory, settings). The first failure
 * (storage blocked or full) tells the player once that progress will not be kept.
 */
game.persist = () => {
  const ok = saveGame(game.save);
  if (!ok && !game.storageWarned) {
    game.storageWarned = true;
    if (game.ui) game.ui.notice('Stockage indisponible : la progression ne sera pas conservée.', 7);
  }
  return ok;
};

/** Recompute player stats: base -> Forge upgrades -> run relics (a bigger max HP also heals the gain). */
game.refreshStats = () => {
  const p = game.player;
  const oldMax = p.stats.maxHp;
  applyUpgrades(p, game.save, game.run ? game.run.relics : null);
  if (!p.dead && p.stats.maxHp > oldMax) p.hp = Math.min(p.stats.maxHp, p.hp + p.stats.maxHp - oldMax);
};

game.setMuted = (m) => {
  game.audio.setMuted(m);
  game.save.settings.muted = !!m;
  game.persist();
  return game.audio.muted;
};
game.toggleMute = () => game.setMuted(!game.audio.muted);

/** Forge purchase (the shop UI calls it). Returns meta.buyUpgrade's result. */
game.buy = (key) => {
  const r = buyUpgrade(game.save, key);
  if (!r.ok) { game.audio.play('clink', { pitch: 0.8 }); return r; }
  game.persist();
  game.refreshStats();
  game.audio.play('buy');
  const f = game.gen.camp.forge, gy = game.gen.camp.surfaceY * TILE;
  game.particles.spawn('spark', f.npcX + 10, gy - 10, { count: 14 });
  game.particles.spawn('ember', f.npcX + 10, gy - 12, { count: 8, spread: 8 });
  return r;
};

/**
 * Banking: back in the camp zone, the backpack + run gold become banked gold.
 * newTrip = false for loot that arrives while the player is still in the camp after a
 * bank (magnetised coins still flying): same trip, and the tally on screen adds it up.
 */
game.bank = (newTrip = true) => {
  const run = game.run, p = game.player;
  const s = bankLoot(game.save, run, p.stats, { newTrip });
  game.persist();
  if (s.total > 0) game.coach.onBank();
  game.hud.tally(s); // counts up with coin ticks, then the "cha-ching" (audio 'bank'); merges into a tally on screen
  game.audio.play('coin', { pitch: 1.2 });
  game.particles.spawn('glint', p.cx, p.y - 4, { color: '#ffe08a' });
  game.particles.spawn('spark', p.cx, p.y, { count: 10 });
  return s;
};

/** Stats that accumulate when a run ends (death, abandon, victory). */
function closeRun() {
  const run = game.run, st = game.save.stats;
  run.over = true;
  game.runActive = false;
  st.kills += run.kills || 0;
  st.playTime += Math.round(run.time || 0);
  st.bestDepth = Math.max(st.bestDepth, run.bestDepth || 0);
}

/** Hook: the player died. Loot lost (minus insurance), stats saved, summary after the death animation. */
game.onPlayerDeath = (cause) => {
  const run = game.run, p = game.player;
  if (!run || run.over) return;
  game.deathInfo = settleDeath(game.save, run, p.stats, { depth: p.depth, cause });
  closeRun();
  game.persist();
  game.victoryT = -1; // dying in the Guardian's last breath: the death wins
  game.deathT = ECONOMY.deathDelay;
};

/**
 * Pause request (pause button / Échap, app hidden, portrait). During the death animation
 * the run is already settled: go straight to the death summary instead of a pause menu.
 */
game.requestPause = () => {
  if (game.state !== 'PLAYING') return;
  if (game.player.dead || game.deathT > 0) { game.deathT = -1; game.setState('DEAD'); return; }
  game.setState('PAUSED');
};

/**
 * Pause menu "Corde de secours" (offered only once the stuck detector fired, tips.js):
 * the hero is hauled back to the camp alive. The unbanked loot stays at the bottom
 * (minus the Bourse de secours share), relics and the mine are kept, no death counted.
 */
game.rescue = () => {
  const run = game.run, p = game.player;
  if (!run || run.over || p.dead || !game.coach.canRescue) return null;
  const s = forfeitLoot(game.save, run, p.stats);
  game.persist();
  const camp = game.gen.camp;
  p.teleport(camp.spawnX, camp.spawnY);
  p.facing = 1;
  p.iframes = Math.max(p.iframes, 1);
  run.awayFromCamp = false;
  game.coach.resetStuck();
  game.camera.snap();
  game.setState('PLAYING');
  game.audio.play('grapple_attach');
  game.particles.spawn('dust', p.cx, p.feetY, { count: 8 });
  game.toast('Corde de secours', {
    color: '#ffe6a0', life: 3.2,
    sub: s.lostValue > 0 ? `Hissé au camp · butin perdu : ${s.lostValue} or${s.kept ? ` (${s.kept} sauvés)` : ''}` : 'Hissé au camp',
  });
  return s;
};

/** Pause menu "Recommencer l'expédition": abandon = a death (loot lost, insurance applies). */
game.abandonRun = () => {
  const run = game.run, p = game.player;
  if (!run || run.over) { if (game.deathInfo && game.state === 'PAUSED') game.setState('DEAD'); return; }
  game.deathInfo = settleDeath(game.save, run, p.stats, { depth: p.depth, cause: 'abandon' });
  closeRun();
  game.persist();
  game.setState('DEAD');
};

/** Hook: the Guardian's death sequence has finished (enemies.js). Victory screen after a short beat. */
game.onBossDefeated = () => {
  // a death during the Guardian's last breath wins: no banner, no victory
  if (!game.run || game.run.over || game.player.dead) return;
  game.run.bossDefeated = true;
  game.hud.banner('VICTOIRE !', 'Le Gardien de l’Abysse est vaincu');
  game.toast('LE CŒUR EST LIBÉRÉ', { color: '#ffe08a', sub: 'Son trésor est à toi', life: 3 });
  game.victoryT = ECONOMY.victoryDelay;
};

/** Victory: the Guardian's treasure and the whole loot are banked, stats saved, victory screen. */
game.finishVictory = () => {
  const run = game.run, p = game.player, save = game.save;
  game.victoryT = -1;
  game.entities.collectAllCoins();
  const s = p.dead ? { total: 0 } : bankLoot(save, run, p.stats);
  save.stats.victories++;
  closeRun();
  game.victoryInfo = {
    time: run.time || 0, kills: run.kills || 0, banked: run.banked || 0, finalBank: s.total,
    deaths: save.stats.deaths, victories: save.stats.victories, ngPlus: run.ngPlus || 0,
    bestDepth: save.stats.bestDepth, relics: run.relics.slice(), bankGold: save.gold,
  };
  game.persist();
  game.setState('VICTORY');
};

/** Victory screen "Continuer (NG+)": raise the NG+ level and start a new, harder mine. */
game.continueNgPlus = () => {
  game.save.ngPlus = (game.run ? game.run.ngPlus || 0 : game.save.ngPlus) + 1;
  game.persist();
  game.newRun();
};

/** Back to the title screen. A finished run is replaced by a fresh mine. */
game.toTitle = () => {
  if (game.run && !game.run.over) {
    game.save.stats.bestDepth = Math.max(game.save.stats.bestDepth, game.run.bestDepth || 0);
    game.persist();
  } else {
    game.newWorld(randomSeed());
  }
  game.setState('TITLE');
};

/** Settings "Effacer la sauvegarde": fresh save (settings kept), fresh mine. */
game.eraseSave = () => {
  const settings = { ...game.save.settings };
  game.save = clearSave();
  game.save.settings = settings;
  game.persist();
  game.newWorld(randomSeed());
};

/** Running in a Safari tab (not the home-screen app) on a touch device? */
function inSafariTab() {
  if (!game.input.touchEnabled) return false;
  const standalone = window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches);
  return !standalone;
}

function showTitle() {
  game.ui.showTitle({
    runActive: game.runActive && game.run && !game.run.over,
    runDepth: game.run ? game.player.depth : 0,
    touch: game.input.touchEnabled,
    installHint: inSafariTab(),
    onPlay: () => game.startGame(),
    onSettings: showSettings,
  });
}

function showSettings() {
  game.ui.showSettings({
    storage: game.saveStatus === 'unavailable' ? false : storageAvailable(),
    onToggleMute: () => game.toggleMute(),
    onToggleShake: () => { game.save.settings.shake = !game.save.settings.shake; game.persist(); return game.save.settings.shake; },
    onToggleTips: () => game.toggleTips(),
    onExport: () => exportSave(game.save),
    onImport: (text) => game.importSave(text),
    onErase: () => game.eraseSave(),
    onBack: showTitle,
  });
}

/** Réglages "Astuces": off hides the tips; turning them back on shows every tip again. */
game.toggleTips = () => {
  const st = game.save.settings;
  st.tips = st.tips === false;
  if (st.tips) game.save.tips = {};
  game.persist();
  return st.tips;
};

/**
 * Réglages "Transférer" → paste a code from the other copy of the game (Safari tab /
 * home-screen app keep separate storage). Replaces the progress, keeps this device's
 * settings, starts a fresh mine. Returns false for an invalid code.
 */
game.importSave = (text) => {
  const next = importSave(text);
  if (!next) return false;
  next.settings = { ...game.save.settings };
  game.save = next;
  game.persist();
  game.newWorld(randomSeed());
  return true;
};

game.setState = (s) => {
  const prev = game.state;
  game.state = s;
  game.input.setControlsVisible(s === 'PLAYING');
  if (s !== 'PLAYING') { game.input.setContextAction(null); game.hud.setHint(null); }
  const ui = game.ui;
  switch (s) {
    case 'TITLE': showTitle(); break;
    case 'PLAYING': ui.hide(); break;
    case 'PAUSED':
      ui.showPause({
        run: game.run, player: game.player,
        // no abandon once settled, nor while the beaten Guardian dies (the victory is due)
        canAbandon: !!game.run && !game.run.over && !game.run.bossDefeated && !game.enemies.truce,
        canRescue: game.coach.canRescue && !!game.run && !game.run.over && !game.player.dead,
        onResume: () => game.setState('PLAYING'),
        onAbandon: () => game.abandonRun(),
        onRescue: () => game.rescue(),
        onTitle: () => game.toTitle(),
        onToggleMute: () => game.toggleMute(),
      });
      break;
    case 'SHOP':
      ui.showShop({
        onBuy: (key) => game.buy(key),
        onClose: () => game.setState('PLAYING'),
      });
      break;
    case 'DEAD':
      ui.showDeath(game.deathInfo || { depth: 0 }, {
        onRestart: () => game.newRun(),
        onTitle: () => game.toTitle(),
      });
      break;
    case 'VICTORY':
      ui.showVictory(game.victoryInfo || {}, {
        onContinue: () => game.continueNgPlus(),
        onTitle: () => game.toTitle(),
      });
      break;
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
  // the run exists before the enemies so they can read run.ngPlus (depth scaling × 1.5)
  game.run = {
    seed: gen.seed, gold: 0, bag: {}, bagCount: 0, bagValue: 0, relics: [], bestDepth: 0, maxLayer: 0, kills: 0,
    startTime: game.time, time: 0, banked: 0, ore: 0, chests: 0,
    ngPlus: (game.save && game.save.ngPlus) || 0, bossDefeated: false, over: false,
  };
  game.runActive = false;
  game.enemies.reset(gen.spawns);
  game.entities.reset(gen);
  game.particles.clear();
  game.hud.reset();
  game.coach.reset();
  game.trapdoorT = 0;
  applyUpgrades(game.player, game.save, game.run.relics);
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
  game.deathT = -1;
  game.victoryT = -1;
  game.hitStopTicks = 0;
  game.currentLayer = 0;
};

/** New run after death / abandon / victory: regenerate the mine, full HP, back to camp. */
game.newRun = (seed) => {
  game.newWorld(seed ?? randomSeed());
  game.save.stats.runs++;
  game.persist();
  game.runActive = true;
  game.setState('PLAYING');
  game.audio.setLayer(0);
  game.hud.banner(game.run.ngPlus ? `NG+ ${game.run.ngPlus}` : 'LE CAMP', 'Une nouvelle mine s’ouvre sous tes pieds');
};

/** From the title screen: "Jouer" / "Continuer" (resumes an expedition under way). */
game.startGame = (seed) => {
  game.audio.unlock();
  if (seed !== undefined && seed !== null) game.newWorld(seed);
  const fresh = !game.runActive || game.run.over;
  if (fresh && game.run.over) game.newWorld(randomSeed());
  game.runActive = true;
  game.setState('PLAYING');
  game.audio.setLayer(layerAtDepth(game.player.depth).index);
  if (fresh) {
    game.save.stats.runs++;
    game.persist();
    game.hud.banner(game.run.ngPlus ? `NG+ ${game.run.ngPlus}` : 'LE CAMP', 'La mine s’ouvre sous tes pieds');
    if (flags.depth) window.__gouffre.teleportDepth(flags.depth);
    if (flags.gold && game.run) game.run.gold = flags.gold;
  }
};

// ------------------------------------------------------------------ fixed update

let emberT = 0, glintT = 0, smokeT = 0;
const FORGE_INTER = { label: 'Forge' };
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
  if (g.input.pressed('pause')) { g.requestPause(); return; }
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
  if (!p.dead) run.time += dt;
  // layers: banner on first entry, ambience follows the current layer
  const layer = layerAtDepth(p.depth);
  if (p.depth > run.bestDepth) run.bestDepth = p.depth;
  if (layer.index > run.maxLayer) {
    run.maxLayer = layer.index;
    if (!g.enemies.gatesSealed) g.hud.banner(layer.title, `Couche ${layer.index + 1} · −${layer.d0} m`); // the boss banner wins
  }
  if (layer.index !== g.currentLayer) { g.currentLayer = layer.index; g.audio.setLayer(layer.index); }

  // Forge: contextual interact near the blacksmith
  const f = g.gen.camp.forge;
  const nearForge = !p.dead && p.feetY <= g.gen.camp.surfaceY * TILE + 1 && Math.abs(p.cx - f.npcX) < f.interactRadius;
  const inter = nearForge ? FORGE_INTER : g.entities.interactionAt(p);
  g.input.setContextAction(inter ? inter.label : null);
  g.hud.setHint(inter ? `E : ${inter.label.toUpperCase()}` : null);
  if (inter && g.input.pressed('interact')) {
    if (nearForge) { g.setState('SHOP'); return; }
    if (inter.use) inter.use();
  }
  // banking: back in the camp zone (feet at or above the surface) with loot. Loot that
  // lands while the player is still in the camp (coins in flight) joins the same trip.
  const inCamp = !p.dead && !run.over && p.feetY <= g.gen.camp.bankY;
  if (!inCamp) run.awayFromCamp = true;
  else if (run.bagCount > 0 || run.gold > 0) { g.bank(run.awayFromCamp === true); run.awayFromCamp = false; }
  campRest(inCamp, dt);
  campTrapdoor(inCamp, dt);
  g.coach.update(dt); // onboarding tips + stuck detector

  if (g.victoryT > 0) {
    g.victoryT -= dt;
    if (g.victoryT <= 0) { g.finishVictory(); return; }
  }
  if (g.deathT > 0) {
    g.deathT -= dt;
    if (g.deathT <= 0) g.setState('DEAD');
  }
}

/** Resting in the camp restores HP quickly (surviving a trip must beat dying for a heal). */
function campRest(inCamp, dt) {
  const g = game, p = g.player;
  if (!inCamp || p.hp >= p.stats.maxHp) {
    if (!inCamp) g.campResting = false;
    g.campHealAcc = 0;
    return;
  }
  if (!g.campResting) {
    g.campResting = true;
    g.toast('REPOS AU CAMP', { color: '#bfe3a0', sub: 'La chaleur de la forge referme tes plaies' });
  }
  g.campHealAcc = (g.campHealAcc || 0) + p.stats.maxHp * ECONOMY.campHealRate * dt;
  if (g.campHealAcc < 1) return;
  const n = Math.floor(g.campHealAcc);
  g.campHealAcc -= n;
  p.heal(n);
  if (Math.random() < 0.25) g.particles.spawn('glint', p.cx - 4 + Math.random() * 8, p.y + Math.random() * 10, { color: '#ffd0dc' });
  if (p.hp >= p.stats.maxHp) { g.audio.play('heal', {}); g.particles.spawn('blood', p.cx, p.cy, { count: 5, color: '#ff7a95' }); }
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
  if (game.state === 'PLAYING') { game.input.navX = 0; game.input.navY = 0; game.input.padBackEdge = false; } // menu-only pad edges
  if (!game.frozen) {
    if (game.state === 'PLAYING') {
      acc += dt;
      let n = 0;
      while (acc >= FIXED_DT && n < 20) { acc -= FIXED_DT; game.fixedStep(FIXED_DT); n++; }
    } else {
      acc = 0;
      game.time += dt;
      // overlays: the keyboard is handled by ui.js (focus navigation); gamepad / injected
      // presses confirm the focused button or go back
      const inp = game.input;
      inp.beginTick();
      if (inp.navX || inp.navY) game.ui.move(inp.navX, inp.navY); // pad stick / D-pad
      if (inp.pressed('pause') || inp.takePadBack()) game.ui.back();
      else if (inp.pressed('jump') || inp.pressed('interact')) game.ui.activate();
      inp.endTick();
      inp.navX = 0; inp.navY = 0;
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
  if (isPortrait() && game.input.touchEnabled && game.state === 'PLAYING') game.requestPause();
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
  game.audio.debug = flags.debug;
  game.particles = new Particles(game);
  game.camera = new Camera(game);
  game.lighting = new Lighting(game);
  game.hud = new Hud(game);
  game.player = new Player(game);
  game.enemies = new EnemyManager(game);
  game.entities = new EntityManager(game);
  game.renderer = new Renderer(game, canvas);
  game.coach = new Coach(game);
  game.onGrappleAttach = () => game.coach.onAttach();
  game.onOrePickup = () => game.coach.onOre();
  const loaded = loadSaveEx();
  game.save = loaded.save;
  game.saveStatus = loaded.status;
  if (flags.bank !== null && flags.bank !== undefined) game.save.gold = flags.bank;
  game.audio.setMuted(!!flags.mute || game.save.settings.muted);
  // "Secousses de l'écran" setting
  const rawShake = game.camera.shake.bind(game.camera);
  game.camera.shake = (px, s) => { if (game.save.settings.shake !== false) rawShake(px, s); };
  game.ui = createUI(game, document.getElementById('ui'));
  game.input.attach({
    layer: document.getElementById('touch'),
    controlsRoot: document.getElementById('controls'),
    iconFactory: (name, px) => makeIcon(name, px),
  });
  game.input.onAnyInput = () => game.audio.unlock();
  game.input.onKey = (e) => {
    if (e.code === 'KeyM' && !e.repeat) { const m = game.toggleMute(); game.toast(m ? 'SON COUPÉ' : 'SON ACTIVÉ'); game.ui.refresh(); }
    if (game.input.onKeyDebug) game.input.onKeyDebug(e);
  };

  resize();
  window.addEventListener('resize', queueResize);
  window.addEventListener('orientationchange', queueResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', queueResize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (game.state === 'PLAYING') game.requestPause();
      game.persist();
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
