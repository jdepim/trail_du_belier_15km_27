// Meta-progression & save (DESIGN.md §2, §7).
//
//   Save (localStorage key SAVE_KEY = 'gouffre.save.v1', versioned inside):
//     defaultSave(), migrateSave(raw), loadSave(storage?), loadSaveEx(storage?) -> { save, status },
//     saveGame(save, storage?) -> bool, clearSave(storage?), storageAvailable(storage?)
//   Forge upgrades:
//     UPGRADES[key] { key, name, icon, desc, max, costs[], apply(stats, lv), effect(lv) }, UPGRADE_KEYS,
//     upgradeCost(key, level), canBuy(save, key), buyUpgrade(save, key) -> { ok, reason, cost, level }
//   Run relics (chests, lost on death):
//     RELICS[key] { key, name, desc, icon, rarity, apply(stats) }, RELIC_KEYS, rollRelic(rnd, layer, owned)
//   Stats:
//     applyUpgrades(player, save, relics?) -> stats (base stats -> upgrades -> relics)
//   Loot (pure helpers, the game calls them):
//     bagValue(bag, mul), bankLoot(save, run, stats) -> summary, settleDeath(save, run, stats, info) -> summary
//
// Numbers were balanced with `node tools/economy.mjs` (curve documented in NOTES-core.md).
import { SAVE_KEY, MUTE_KEY, GRAPPLE, PLAYER, ECONOMY } from './config.js';
import { TILE_BY_KEY } from './tiles.js';
import { baseStats } from './player.js';

export const SAVE_VERSION = 2;

// ------------------------------------------------------------------ upgrades

const PICK = [
  // tier = hardest rock breakable, dig = mining damage per strike, atk = combat damage
  { tier: 0, dig: 1, atk: 10 },
  { tier: 1, dig: 1.5, atk: 14 },
  { tier: 2, dig: 2, atk: 18 },
  { tier: 2, dig: 2.75, atk: 22 },
  { tier: 3, dig: 3.5, atk: 26 },
  { tier: 3, dig: 4.5, atk: 30 },
];
/** What each pickaxe tier unlocks (Forge text). */
export const TIER_NAMES = ['Terre, pierre', 'Briques', 'Granit, cristal', 'Basalte, obsidienne'];
const VITALITY = [0, 15, 35, 60, 90, 125];            // + max HP
const ARMOR = [0, 0.07, 0.14, 0.21, 0.28, 0.35];      // damage reduction
const GRAPPLE_RANGE = [96, 128, 160, 192, 220];       // px (base = GRAPPLE.range)
const GRAPPLE_REEL = [130, 160, 190, 220, 255];       // px/s
const BAG = [10, 16, 24, 34, 46, 60];                 // ore units
const LANTERN = [6.5, 8, 9.5, 11, 12.5];              // tiles
const BOOTS_SPEED = [1, 1.08, 1.16, 1.25];
const BOOTS_JUMP = [1, 1.04, 1.08, 1.12];
const INSURANCE = [0, 0.25, 0.5];

const pct = (v) => Math.round(v * 100) + ' %';
const metres = (px) => (px / 16).toFixed(1).replace('.', ',') + ' m';
const num = (v) => String(v).replace('.', ',');

/**
 * Forge upgrades. costs[i] = price of level i + 1. apply(stats, lv) mutates a
 * fresh base-stats object; effect(lv) = short French text for the Forge.
 */
export const UPGRADES = {
  pick: {
    name: 'Pioche', icon: 'up_pick', max: 5,
    desc: 'Dégâts de minage et de combat. Chaque dureté débloque une roche.',
    costs: [45, 300, 750, 1700, 3600],
    apply(s, lv) { const p = PICK[lv]; s.pickTier = p.tier; s.pickDamage = p.dig; s.attackDamage = p.atk; },
    effect(lv) { const p = PICK[lv]; return `Dureté ${p.tier} · ${p.atk} dég.`; },
    unlock(lv) { return lv > 0 && PICK[lv].tier > PICK[lv - 1].tier ? TIER_NAMES[PICK[lv].tier] : null; },
  },
  vitality: {
    name: 'Vitalité', icon: 'up_vitality', max: 5, desc: 'Points de vie maximum.',
    costs: [20, 80, 240, 560, 1200],
    apply(s, lv) { s.maxHp = PLAYER.maxHp + VITALITY[lv]; },
    effect(lv) { return `${PLAYER.maxHp + VITALITY[lv]} PV`; },
  },
  armor: {
    name: 'Armure', icon: 'up_armor', max: 5, desc: 'Réduit les dégâts subis.',
    costs: [35, 130, 360, 800, 1600],
    apply(s, lv) { s.armor = ARMOR[lv]; },
    effect(lv) { return lv ? `−${pct(ARMOR[lv])} dégâts` : 'Aucune'; },
  },
  grapple: {
    name: 'Grappin', icon: 'up_grapple', max: 4, desc: 'Portée du crochet et vitesse d’enroulement.',
    costs: [25, 100, 300, 700],
    apply(s, lv) { s.grappleRange = Math.min(GRAPPLE.maxRange, GRAPPLE_RANGE[lv]); s.reelSpeed = GRAPPLE_REEL[lv]; },
    effect(lv) { return `Portée ${metres(GRAPPLE_RANGE[lv])}`; },
  },
  bag: {
    name: 'Sac', icon: 'up_bag', max: 5, desc: 'Minerais transportés par expédition.',
    costs: [15, 60, 200, 520, 1100],
    apply(s, lv) { s.bagCapacity = BAG[lv]; },
    effect(lv) { return `${BAG[lv]} minerais`; },
  },
  lantern: {
    name: 'Lanterne', icon: 'up_lantern', max: 4, desc: 'Rayon de lumière dans les profondeurs.',
    costs: [12, 50, 170, 450],
    apply(s, lv) { s.lanternRadius = LANTERN[lv]; },
    effect(lv) { return `Rayon ${num(LANTERN[lv])} m`; },
  },
  boots: {
    name: 'Bottes', icon: 'up_boots', max: 3, desc: 'Vitesse de course et hauteur de saut.',
    costs: [30, 180, 550],
    apply(s, lv) { s.maxSpeed = PLAYER.maxSpeed * BOOTS_SPEED[lv]; s.jumpVel = PLAYER.jumpVel * BOOTS_JUMP[lv]; },
    effect(lv) { return lv ? `+${pct(BOOTS_SPEED[lv] - 1)} vitesse` : 'Usées'; },
  },
  insurance: {
    name: 'Bourse de secours', icon: 'up_insurance', max: 2,
    desc: 'Part du butin non banqué conservée à la mort.',
    costs: [90, 650],
    apply(s, lv) { s.insurance = INSURANCE[lv]; },
    effect(lv) { return `${pct(INSURANCE[lv])} conservé`; },
  },
};
export const UPGRADE_KEYS = Object.keys(UPGRADES);
for (const k of UPGRADE_KEYS) UPGRADES[k].key = k;

/** Price of the next level (level = current level), Infinity when maxed. */
export function upgradeCost(key, level) {
  const u = UPGRADES[key];
  if (!u || level >= u.max || level < 0) return Infinity;
  return u.costs[level];
}

/** { ok, reason: 'max'|'gold'|null, cost } for buying the next level of `key`. */
export function canBuy(save, key) {
  const lv = (save.upgrades && save.upgrades[key]) || 0;
  const cost = upgradeCost(key, lv);
  if (cost === Infinity) return { ok: false, reason: 'max', cost };
  if (save.gold < cost) return { ok: false, reason: 'gold', cost };
  return { ok: true, reason: null, cost };
}

/** Spend banked gold on the next level (mutates the save; the caller saves + applies). */
export function buyUpgrade(save, key) {
  const c = canBuy(save, key);
  if (!c.ok) return { ...c, level: (save.upgrades && save.upgrades[key]) || 0 };
  save.gold -= c.cost;
  save.upgrades[key] = (save.upgrades[key] || 0) + 1;
  save.stats.spent = (save.stats.spent || 0) + c.cost;
  return { ...c, level: save.upgrades[key] };
}

// ------------------------------------------------------------------ relics

/**
 * Run relics (chests). rarity 1 = common, 2 = uncommon, 3 = rare (weights per layer:
 * ECONOMY.relicWeights, deeper chests favour rare ones). apply(stats) runs after the
 * upgrades. Player / enemy / pickup code reads the resulting stats:
 * airJumps, glide, killHeal, magnetMul, oreMul, goldMul, regen, hookSpeed...
 */
export const RELICS = {
  double_jump: {
    name: 'Double saut', icon: 'relic_wing', rarity: 3, desc: 'Saute une seconde fois en plein vol.',
    apply(s) { s.airJumps += 1; },
  },
  magnet: {
    name: 'Aimant', icon: 'relic_magnet', rarity: 1, desc: 'Attire le butin de bien plus loin.',
    apply(s) { s.magnetMul *= 2.4; },
  },
  vampire: {
    name: 'Vampirisme', icon: 'relic_fang', rarity: 3, desc: 'Chaque ennemi vaincu te rend des PV.',
    apply(s) { s.killHeal += ECONOMY.vampireHeal[0] + Math.round(s.maxHp * ECONOMY.vampireHeal[1]); },
  },
  fire_pick: {
    name: 'Pioche ardente', icon: 'relic_flame', rarity: 2, desc: '+40 % de dégâts de minage et de combat.',
    apply(s) { s.pickDamage *= 1.4; s.attackDamage = Math.round(s.attackDamage * 1.4); s.firePick = true; },
  },
  stone_skin: {
    name: 'Peau de pierre', icon: 'relic_stone', rarity: 1, desc: 'Réduit les dégâts subis de 15 %.',
    apply(s) { s.armor = Math.min(0.8, s.armor + 0.15); },
  },
  feather: {
    name: 'Plume', icon: 'relic_feather', rarity: 2, desc: 'Maintiens Saut en tombant pour planer.',
    apply(s) { s.glide = true; },
  },
  quick_hook: {
    name: 'Crochet éclair', icon: 'relic_bolt', rarity: 2, desc: 'Grappin plus rapide, plus long, enroulement vif.',
    apply(s) { s.hookSpeed *= 1.7; s.grappleRange += 40; s.reelSpeed *= 1.4; },
  },
  spectral_lantern: {
    name: 'Lanterne spectrale', icon: 'relic_lantern', rarity: 1, desc: 'Ta lanterne perce bien plus loin les ténèbres.',
    apply(s) { s.lanternRadius += 4; },
  },
  frenzy: {
    name: 'Frénésie', icon: 'relic_frenzy', rarity: 2, desc: 'Frappes 25 % plus rapides.',
    apply(s) { s.attackCooldown *= 0.75; },
  },
  greed: {
    name: 'Avarice', icon: 'relic_greed', rarity: 1, desc: '+30 % d’or : minerais et pièces.',
    apply(s) { s.oreMul *= 1.3; s.goldMul *= 1.3; },
  },
  troll_heart: {
    name: 'Cœur de troll', icon: 'relic_heart', rarity: 3, desc: 'Régénère lentement tes PV (1 PV / 2 s).',
    apply(s) { s.regen += 0.5; },
  },
};
export const RELIC_KEYS = Object.keys(RELICS);
for (const k of RELIC_KEYS) RELICS[k].key = k;

/**
 * Weighted random relic for a chest of `layer` (0..3), never one already owned.
 * rnd() -> [0, 1). Returns a key or null when every relic is owned.
 */
export function rollRelic(rnd, layer, owned = []) {
  const w = ECONOMY.relicWeights[Math.max(0, Math.min(ECONOMY.relicWeights.length - 1, layer | 0))];
  let total = 0;
  for (const k of RELIC_KEYS) if (!owned.includes(k)) total += w[RELICS[k].rarity - 1];
  if (total <= 0) return null;
  let r = rnd() * total;
  for (const k of RELIC_KEYS) {
    if (owned.includes(k)) continue;
    r -= w[RELICS[k].rarity - 1];
    if (r < 0) return k;
  }
  for (let i = RELIC_KEYS.length - 1; i >= 0; i--) if (!owned.includes(RELIC_KEYS[i])) return RELIC_KEYS[i];
  return null;
}

// ------------------------------------------------------------------ stats

/** Reset player.stats to base, apply every upgrade level of the save, then the run relics. */
export function applyUpgrades(player, save, relics = null) {
  const s = baseStats();
  for (const k of UPGRADE_KEYS) {
    const lv = Math.max(0, Math.min(UPGRADES[k].max, (save && save.upgrades && save.upgrades[k]) || 0));
    UPGRADES[k].apply(s, lv);
  }
  if (relics) for (const r of relics) if (RELICS[r]) RELICS[r].apply(s);
  player.stats = s;
  if (player.hp > s.maxHp) player.hp = s.maxHp;
  return s;
}

// ------------------------------------------------------------------ save

export function defaultSave() {
  const upgrades = {};
  for (const k of UPGRADE_KEYS) upgrades[k] = 0;
  return {
    version: SAVE_VERSION,
    gold: 0,                 // banked gold (the Forge currency)
    upgrades,
    stats: {
      bestDepth: 0, deaths: 0, totalGold: 0, victories: 0, runs: 0,
      trips: 0,              // successful returns to the camp with loot
      kills: 0, spent: 0, playTime: 0, bestTrip: 0,
    },
    settings: { muted: false, shake: true },
    ngPlus: 0,               // NG+ level: enemies × (1 + 0.5 × level)
  };
}

const int = (v, min = 0) => Math.max(min, Math.floor(Number(v) || 0));

/**
 * Bring any older / partial / hand-edited save up to the current shape.
 * v1 (step 1 stub): `ngPlus` was a boolean; no trips / kills / playTime / shake.
 */
export function migrateSave(raw) {
  const base = defaultSave();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const out = { ...base, ...raw, version: SAVE_VERSION };
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  out.upgrades = { ...base.upgrades, ...obj(raw.upgrades) };
  out.stats = { ...base.stats, ...obj(raw.stats) };
  out.settings = { ...base.settings, ...obj(raw.settings) };
  for (const k of Object.keys(out.upgrades)) if (!UPGRADES[k]) delete out.upgrades[k];
  for (const k of UPGRADE_KEYS) out.upgrades[k] = Math.min(UPGRADES[k].max, int(out.upgrades[k]));
  for (const k of Object.keys(base.stats)) out.stats[k] = int(out.stats[k]);
  out.gold = int(out.gold);
  // v1 -> v2: boolean NG+ flag becomes a level
  out.ngPlus = raw.ngPlus === true ? 1 : Math.min(99, int(raw.ngPlus));
  out.settings.muted = !!out.settings.muted;
  out.settings.shake = out.settings.shake !== false;
  return out;
}

function getStorage(storage) {
  if (storage) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

/** True when the storage accepts a write (false in some private modes / blocked storage). */
export function storageAvailable(storage) {
  const st = getStorage(storage);
  if (!st) return false;
  try { st.setItem(SAVE_KEY + '.probe', '1'); if (st.removeItem) st.removeItem(SAVE_KEY + '.probe'); return true; } catch { return false; }
}

/**
 * Load + migrate. status: 'ok' | 'new' (nothing saved) | 'corrupt' (unparseable: the
 * raw text is kept under SAVE_KEY + '.corrupt' and a fresh save is returned) | 'unavailable'.
 */
export function loadSaveEx(storage) {
  const st = getStorage(storage);
  if (!st) return { save: defaultSave(), status: 'unavailable' };
  let txt;
  try { txt = st.getItem(SAVE_KEY); } catch { return { save: defaultSave(), status: 'unavailable' }; }
  if (!txt) {
    const save = defaultSave();
    // pre-save builds stored the mute flag on its own key
    try { if (st.getItem(MUTE_KEY) === '1') save.settings.muted = true; } catch { /* ignore */ }
    return { save, status: 'new' };
  }
  try {
    return { save: migrateSave(JSON.parse(txt)), status: 'ok' };
  } catch {
    try { st.setItem(SAVE_KEY + '.corrupt', String(txt)); } catch { /* ignore */ }
    return { save: defaultSave(), status: 'corrupt' };
  }
}

export function loadSave(storage) { return loadSaveEx(storage).save; }

export function saveGame(save, storage) {
  const st = getStorage(storage);
  try { if (st) { st.setItem(SAVE_KEY, JSON.stringify(save)); return true; } } catch { /* quota / blocked */ }
  return false;
}

/** Erase the save (settings are kept by the caller if wanted). Returns a fresh save. */
export function clearSave(storage) {
  const st = getStorage(storage);
  try { if (st && st.removeItem) st.removeItem(SAVE_KEY); } catch { /* ignore */ }
  return defaultSave();
}

// ------------------------------------------------------------------ loot

/** Gold value of a backpack ({ oreKey: count }) × multiplier (Avarice relic). */
export function bagValue(bag, mul = 1) {
  let v = 0;
  for (const k in bag) { const def = TILE_BY_KEY[k]; if (def) v += def.value * bag[k]; }
  return Math.round(v * mul);
}

function bagItems(bag) {
  const out = [];
  for (const k in bag) if (bag[k] > 0 && TILE_BY_KEY[k]) out.push({ key: k, name: TILE_BY_KEY[k].name, count: bag[k], value: TILE_BY_KEY[k].value });
  out.sort((a, b) => b.value - a.value);
  return out;
}

/** Empty the run's backpack and run gold (after banking / settling). */
export function clearLoot(run) {
  for (const k in run.bag) delete run.bag[k];
  run.bagCount = 0;
  run.gold = 0;
}

/**
 * Banking in the camp: the backpack (× stats.oreMul) and the run gold become banked
 * gold. Mutates save + run; returns { items, oreValue, gold, total }. The caller saves.
 */
export function bankLoot(save, run, stats = {}) {
  const items = bagItems(run.bag);
  const oreValue = bagValue(run.bag, stats.oreMul || 1);
  const gold = Math.max(0, Math.round(run.gold || 0));
  const total = oreValue + gold;
  save.gold += total;
  save.stats.totalGold += total;
  if (total > 0) save.stats.trips++;
  save.stats.bestTrip = Math.max(save.stats.bestTrip || 0, total);
  save.stats.bestDepth = Math.max(save.stats.bestDepth, run.bestDepth || 0);
  run.banked = (run.banked || 0) + total;
  run.ore = (run.ore || 0) + (run.bagCount || 0);
  clearLoot(run);
  return { items, oreValue, gold, total, count: items.reduce((n, i) => n + i.count, 0) };
}

/**
 * Death (or abandon): the backpack + run gold are lost except the Bourse de
 * secours share (stats.insurance), which is banked. Relics are lost with the run.
 * Mutates save (not the run); returns the summary shown on the death screen.
 */
export function settleDeath(save, run, stats = {}, info = {}) {
  const items = bagItems(run.bag);
  const oreValue = bagValue(run.bag, stats.oreMul || 1);
  const gold = Math.max(0, Math.round(run.gold || 0));
  const insurance = Math.max(0, Math.min(1, stats.insurance || 0));
  const kept = Math.floor((oreValue + gold) * insurance);
  save.gold += kept;
  save.stats.totalGold += kept;
  save.stats.deaths++;
  save.stats.bestDepth = Math.max(save.stats.bestDepth, run.bestDepth || 0);
  return {
    depth: info.depth ?? run.bestDepth ?? 0,
    cause: info.cause || 'enemy',
    items, oreValue, gold,
    lostValue: oreValue + gold - kept,
    kept, insurance,
    relics: (run.relics || []).slice(),
    bestDepth: run.bestDepth || 0,
    kills: run.kills || 0,
    banked: run.banked || 0,
    ore: (run.ore || 0) + (run.bagCount || 0),
    chests: run.chests || 0,
    time: run.time || 0,
    bankGold: save.gold,
  };
}
