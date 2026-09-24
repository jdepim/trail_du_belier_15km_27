// Meta-progression & save (DESIGN.md §7) — STUB for step 1.
// Final API: defaultSave, migrateSave, loadSave, saveGame, UPGRADES, upgradeCost,
// applyUpgrades, RELICS. Numbers are placeholders to be balanced in step 2.
import { SAVE_KEY, GRAPPLE, PLAYER } from './config.js';
import { baseStats } from './player.js';

export const SAVE_VERSION = 1;

/** Upgrade definitions. apply(stats, level) mutates a fresh base-stats object. */
export const UPGRADES = {
  pick: {
    name: 'Pioche', max: 5, baseCost: 40, costMul: 2.2,
    desc: 'Dégâts de minage et dureté',
    apply(s, lv) { s.pickDamage = 1 + lv * 0.5; s.attackDamage = 10 + lv * 4; s.pickTier = Math.min(3, [0, 1, 2, 2, 3, 3][lv]); },
  },
  vitality: { name: 'Vitalité', max: 5, baseCost: 30, costMul: 1.9, desc: 'PV max', apply(s, lv) { s.maxHp = PLAYER.maxHp + lv * 15; } },
  armor: { name: 'Armure', max: 4, baseCost: 50, costMul: 2.1, desc: 'Réduction des dégâts', apply(s, lv) { s.armor = lv * 0.1; } },
  grapple: {
    name: 'Grappin', max: 4, baseCost: 35, costMul: 2.0, desc: 'Portée et enroulement',
    apply(s, lv) { s.grappleRange = Math.min(GRAPPLE.maxRange, GRAPPLE.range + lv * 31); s.reelSpeed = GRAPPLE.reelSpeed + lv * 25; },
  },
  bag: { name: 'Sac', max: 5, baseCost: 25, costMul: 1.8, desc: 'Capacité du sac', apply(s, lv) { s.bagCapacity = PLAYER.bagCapacity + lv * 5; } },
  lantern: { name: 'Lanterne', max: 4, baseCost: 20, costMul: 1.9, desc: 'Rayon de lumière', apply(s, lv) { s.lanternRadius = PLAYER.lanternRadius + lv * 1.5; } },
  boots: {
    name: 'Bottes', max: 3, baseCost: 45, costMul: 2.2, desc: 'Vitesse et saut',
    apply(s, lv) { s.maxSpeed = PLAYER.maxSpeed * (1 + lv * 0.08); s.jumpVel = PLAYER.jumpVel * (1 + lv * 0.05); },
  },
  insurance: { name: 'Bourse de secours', max: 2, baseCost: 80, costMul: 2.5, desc: '% du sac conservé à la mort', apply(s, lv) { s.insurance = [0, 0.25, 0.5][lv]; } },
};

/** Run relics (found in chests, lost on death). Effects implemented in step 2. */
export const RELICS = [
  { key: 'double_jump', name: 'Double saut', icon: 'relic_wing' },
  { key: 'magnet', name: 'Aimant', icon: 'relic_magnet' },
  { key: 'vampire', name: 'Vampirisme', icon: 'relic_fang' },
  { key: 'fire_pick', name: 'Pioche ardente', icon: 'relic_flame' },
  { key: 'stone_skin', name: 'Peau de pierre', icon: 'relic_stone' },
  { key: 'feather', name: 'Plume', icon: 'relic_feather' },
  { key: 'quick_hook', name: 'Crochet éclair', icon: 'relic_bolt' },
];

export function defaultSave() {
  const upgrades = {};
  for (const k of Object.keys(UPGRADES)) upgrades[k] = 0;
  return {
    version: SAVE_VERSION,
    gold: 0,
    upgrades,
    stats: { bestDepth: 0, deaths: 0, totalGold: 0, victories: 0, runs: 0 },
    settings: { muted: false },
    ngPlus: false,
  };
}

/** Bring any older / partial save up to the current shape. */
export function migrateSave(raw) {
  const base = defaultSave();
  if (!raw || typeof raw !== 'object') return base;
  const out = { ...base, ...raw, version: SAVE_VERSION };
  out.upgrades = { ...base.upgrades, ...(raw.upgrades || {}) };
  out.stats = { ...base.stats, ...(raw.stats || {}) };
  out.settings = { ...base.settings, ...(raw.settings || {}) };
  for (const k of Object.keys(UPGRADES)) {
    out.upgrades[k] = Math.max(0, Math.min(UPGRADES[k].max, Math.floor(Number(out.upgrades[k]) || 0)));
  }
  out.gold = Math.max(0, Math.floor(Number(out.gold) || 0));
  return out;
}

function getStorage(storage) {
  if (storage) return storage;
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

export function loadSave(storage) {
  const st = getStorage(storage);
  try {
    const txt = st && st.getItem(SAVE_KEY);
    return migrateSave(txt ? JSON.parse(txt) : null);
  } catch {
    return defaultSave();
  }
}

export function saveGame(save, storage) {
  const st = getStorage(storage);
  try { if (st) st.setItem(SAVE_KEY, JSON.stringify(save)); return true; } catch { return false; }
}

export function upgradeCost(key, level) {
  const u = UPGRADES[key];
  if (!u || level >= u.max) return Infinity;
  return Math.round(u.baseCost * Math.pow(u.costMul, level));
}

/** Reset player.stats to base and apply every upgrade level from the save. */
export function applyUpgrades(player, save) {
  const s = baseStats();
  s.insurance = 0;
  for (const k of Object.keys(UPGRADES)) UPGRADES[k].apply(s, (save && save.upgrades && save.upgrades[k]) || 0);
  player.stats = s;
  if (player.hp > s.maxHp) player.hp = s.maxHp;
  return s;
}
