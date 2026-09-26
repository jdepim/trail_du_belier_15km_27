// Meta-progression, save and story (DESIGN.md §5, §7).
//
//   Save (localStorage key SAVE_KEY = 'derive.save.v1', versioned inside):
//     defaultSave(seed?), migrateSave(raw), loadSave(storage?), loadSaveEx(storage?) -> { save, status },
//     saveGame(save, storage?) -> bool, clearSave(storage?, seed?), storageAvailable(storage?)
//     exportSave(save) -> 'DERIVE1:<base64>', importSave(text) -> save | null
//   Equipment: ITEMS[key] { key, name, desc, icon }, ITEM_KEYS
//   Workbench: UPGRADES[key] { key, name, icon, desc, max, costs[], requires, apply(stats, lv), effect(lv) },
//     UPGRADE_KEYS, upgradeCost(key, level), canBuy(save, key) -> { ok, reason, cost },
//     buyUpgrade(save, key) -> { ok, reason: 'max'|'salvage'|'locked'|null, cost, level },
//     applyUpgrades(player, save) -> stats
//   Run: createRun(save, prev?), lifeSeedFor(save), depositSalvage(save, run) -> { amount, total },
//     settleDeath(save, run, cause) -> summary, flushRunStats(save, run), recordVictory(save, run, explored)
//   Story: LOGS[key] { key, title, text }, LOG_KEYS, DEATH_CAUSES, causeText(cause), POI_NAMES
//   Fog of war (FOG.size² cells of FOG.cell px, 1 bit each): createFog(), fogReveal(fog, x, y, r) -> newly
//     revealed cells, fogRevealed(fog, x, y), fogCellRevealed(fog, cx, cy), encodeFog(fog), decodeFog(str),
//     fogExplored(fog) -> % of the sector disc explored, poiDiscovered(fog, poi)
import { SAVE_KEY, PLAYER, FOG, CENTER, BOUNDARY, POIS } from './config.js';
import { baseStats } from './player.js';

export const SAVE_VERSION = 1;

// ------------------------------------------------------------------ equipment

export const ITEMS = {
  keycard: { name: "Carte d'accès", icon: 'item_keycard', desc: "La carte d'accès ouvre les portes de la station Orion." },
  explosives: { name: 'Charges explosives', icon: 'item_explosives', desc: 'Bouton Charge : elles brisent éboulis, petits astéroïdes et tourelles.' },
  heatshield: { name: 'Bouclier thermique', icon: 'item_heatshield', desc: 'Le bouclier divise par dix la chaleur des soleils.' },
  anchor: { name: 'Ancre gravitationnelle', icon: 'item_anchor', desc: "L'ancre divise par quatre l'attraction des trous noirs." },
};
export const ITEM_KEYS = Object.keys(ITEMS);
for (const k of ITEM_KEYS) ITEMS[k].key = k;

// ------------------------------------------------------------------ workbench upgrades

const RADAR = [900, 1500, 2200, 3000];   // px
const MAGNET = [PLAYER.magnetR, 48, 80];  // px
const metres = (px) => Math.round(px / 8) + ' m';

/** costs[i] = price of level i + 1 (salvage). apply(stats, lv) mutates a fresh baseStats(). */
export const UPGRADES = {
  o2: {
    name: "Réservoir d'O2", icon: 'up_o2', max: 4, costs: [20, 45, 90, 160],
    desc: "Plus d'autonomie en oxygène à chaque sortie.",
    apply(s, lv) { s.o2Max = PLAYER.o2Max + 45 * lv; },
    effect(lv) { return `Autonomie ${PLAYER.o2Max + 45 * lv} s`; },
  },
  fuel: {
    name: 'Réservoir de carburant', icon: 'up_fuel', max: 3, costs: [15, 40, 90],
    desc: 'Capacité et recharge solaire du carburant.',
    apply(s, lv) { s.fuelMax = PLAYER.fuelMax * (1 + 0.25 * lv); s.rechargeRate = PLAYER.rechargeRate * (1 + 0.25 * lv); },
    effect(lv) { return `${Math.round(PLAYER.fuelMax * (1 + 0.25 * lv))} u`; },
  },
  thrust: {
    name: 'Propulseurs', icon: 'up_thrust', max: 4, costs: [25, 60, 120, 200],
    desc: 'Poussée et vitesse de croisière.',
    apply(s, lv) { s.thrustAccel = PLAYER.thrustAccel * (1 + 0.15 * lv); s.cruiseSpeed = PLAYER.cruiseSpeed * (1 + 0.12 * lv); },
    effect(lv) { return lv ? `+${15 * lv} % poussée` : 'Poussée de série'; },
  },
  hull: {
    name: 'Blindage', icon: 'up_hull', max: 4, costs: [20, 50, 100, 170],
    desc: 'Coque renforcée : plus de points de coque.',
    apply(s, lv) { s.maxHull = PLAYER.maxHull + 25 * lv; },
    effect(lv) { return `Coque ${PLAYER.maxHull + 25 * lv}`; },
  },
  radar: {
    name: 'Radar', icon: 'up_radar', max: 3, costs: [15, 50, 110],
    desc: 'Portée de détection des lieux.',
    apply(s, lv) { s.radarRange = RADAR[lv]; },
    effect(lv) { return `Portée ${metres(RADAR[lv])}`; },
  },
  magnet: {
    name: 'Aimant', icon: 'up_magnet', max: 2, costs: [15, 40],
    desc: 'Attire la ferraille et les recharges de plus loin.',
    apply(s, lv) { s.magnetR = MAGNET[lv]; },
    effect(lv) { return `Rayon ${metres(MAGNET[lv])}`; },
  },
  charges: {
    name: 'Soute à charges', icon: 'up_charges', max: 2, costs: [40, 90], requires: 'explosives',
    desc: 'Une charge explosive de plus par sortie.',
    apply(s, lv) { s.maxCharges = PLAYER.maxCharges + lv; },
    effect(lv) { return `${PLAYER.maxCharges + lv} charges`; },
  },
};
export const UPGRADE_KEYS = Object.keys(UPGRADES);
for (const k of UPGRADE_KEYS) { UPGRADES[k].key = k; if (!UPGRADES[k].requires) UPGRADES[k].requires = null; }

/** Price of the next level (level = current level), Infinity when maxed / unknown. */
export function upgradeCost(key, level) {
  const u = UPGRADES[key];
  if (!u || level >= u.max || level < 0) return Infinity;
  return u.costs[level];
}

/** { ok, reason: 'max' | 'salvage' | 'locked' | null, cost } for the next level of `key`. */
export function canBuy(save, key) {
  const u = UPGRADES[key];
  const lv = (save.upgrades && save.upgrades[key]) || 0;
  const cost = upgradeCost(key, lv);
  if (!u || cost === Infinity) return { ok: false, reason: 'max', cost };
  if (u.requires && !(save.items && save.items[u.requires])) return { ok: false, reason: 'locked', cost };
  if (save.salvage < cost) return { ok: false, reason: 'salvage', cost };
  return { ok: true, reason: null, cost };
}

/** Spend deposited salvage on the next level (mutates the save; the caller persists + applies). */
export function buyUpgrade(save, key) {
  const c = canBuy(save, key);
  if (!c.ok) return { ...c, level: (save.upgrades && save.upgrades[key]) || 0 };
  save.salvage -= c.cost;
  save.upgrades[key] = (save.upgrades[key] || 0) + 1;
  return { ...c, level: save.upgrades[key] };
}

/** Rebuild player.stats from baseStats() + every upgrade level; clamps current resources. */
export function applyUpgrades(player, save) {
  const s = baseStats();
  for (const k of UPGRADE_KEYS) {
    const lv = Math.max(0, Math.min(UPGRADES[k].max, (save && save.upgrades && save.upgrades[k]) || 0));
    UPGRADES[k].apply(s, lv);
  }
  player.stats = s;
  if (player.hull > s.maxHull) player.hull = s.maxHull;
  if (player.o2 > s.o2Max) player.o2 = s.o2Max;
  if (player.fuel > s.fuelMax) player.fuel = s.fuelMax;
  if (player.charges > s.maxCharges) player.charges = s.maxCharges;
  return s;
}

// ------------------------------------------------------------------ story

export const LOGS = {
  albatros: {
    title: 'Albatros — journal de bord',
    text: "Jour 41 dans le secteur de Charon. Orion ne répond plus depuis trois semaines et la compagnie nous a envoyés constater les dégâts. Ce matin, tous les instruments ont décroché d'un coup, comme si quelque chose, au nord, tirait sur les ondes elles-mêmes. Si le réacteur lâche, la balise de rappel ramènera les combinaisons ici. Le reste, il faudra le trouver seul.",
  },
  colibri: {
    title: 'Navette Colibri — note du pilote',
    text: "J'ai pris la carte d'accès du chef de la sécurité sur son bureau, à côté d'un café encore tiède. Les portes d'Orion ne s'ouvriront pour personne d'autre, et je n'y retournerai pas. Cap sur le Module Ulysse… mais la jauge d'oxygène dit que je ne passerai pas la ceinture. À qui trouvera la navette : la carte est restée sur le socle du cockpit.",
  },
  orion_command: {
    title: "Station Orion — ordre d'évacuation",
    text: "Ordre du commandant Ferrand : évacuation totale. Le Maelström a doublé de masse en quarante jours et notre orbite se resserre. Les tourelles restent en verrouillage et les barrières de l'armurerie restent actives : personne ne pillera nos explosifs. Rendez-vous au Module Ulysse.",
  },
  orion_crew: {
    title: "Station Orion — quartiers de l'équipage",
    text: "Tout le monde se bat pour une place dans les navettes, alors je laisse la mienne à Inès. Les ingénieurs d'Hélios disent qu'on ne s'arrime pas au Module sans leur ancre gravitationnelle, et leur observatoire cuit entre les deux soleils. Il faudrait le bouclier thermique des mineurs de Tycho. On raconte qu'ils l'ont emmuré avec leur galerie, sur Séléné.",
  },
  tycho_miners: {
    title: 'Base Tycho — relevé des mineurs',
    text: "Troisième fuite cette semaine : les évents crachent sans prévenir, et Karim s'est cassé le bras contre la paroi. Compte les secondes entre deux jets avant de passer. La chaleur remonte du cœur de Séléné, on creuse en combinaison lourde. Si la cheffe tient tant à son bouclier, qu'elle vienne l'essayer elle-même.",
  },
  tycho_chief: {
    title: 'Base Tycho — la cheffe de chantier',
    text: "J'ai fait sauter l'entrée de la galerie derrière le dernier convoi. Le prototype de bouclier thermique filtre neuf dixièmes de la chaleur d'une étoile : de quoi approcher les Jumelles. Si tu es arrivé jusqu'ici, c'est que tu avais des explosifs. Alors prends-le, et va plus loin que nous.",
  },
  helios: {
    title: "Observatoire Hélios — cahier d'observation",
    text: "Hélios A et Hélios B crachent leurs éruptions à tour de rôle ; derrière une coque ou un rocher, on ne sent que le souffle. Nos calculs sont formels : sans compensation, rien ne tient à moins de soixante-quinze mètres du Maelström. L'ancre gravitationnelle divise son attraction par quatre. Nous la laissons ici, pour qui pourra la porter jusqu'au Module Ulysse.",
  },
  mistral: {
    title: 'Cargo Mistral — journal du capitaine',
    text: "Nous avons tenté l'arrimage au Module Ulysse sans ancre : le Maelström nous a arraché la poupe comme une feuille de papier. Nous avons dérivé neuf jours avant de nous échouer ici, loin de tout. Il reste la cargaison : de la ferraille, des pièces, de quoi rafistoler une combinaison. Servez-vous, nous n'en aurons plus besoin.",
  },
  ulysse: {
    title: 'Module Ulysse — procédure de retour',
    text: "Module de retour Ulysse, une place. Arrimage autorisé sous compensation gravitationnelle uniquement. Trajectoire de rentrée calculée pour la Terre, durée estimée : neuf jours. Installe-toi : le Module t'attendait.",
  },
};
export const LOG_KEYS = Object.keys(LOGS);
for (const k of LOG_KEYS) LOGS[k].key = k;

/** Death cause key -> French text (death screen). */
export const DEATH_CAUSES = {
  asphyxia: 'Asphyxie',
  sun_a: 'Carbonisé par Hélios A',
  sun_b: 'Carbonisé par Hélios B',
  heat: 'Brûlé vif',
  bh_maelstrom: 'Spaghettifié par le Maelström',
  bh_charybde: 'Spaghettifié par Charybde',
  impact: 'Coque percée (choc)',
  laser: 'Désintégré (laser)',
  turret: 'Abattu par une tourelle',
  self: 'Pris dans ta propre explosion',
  storm: 'Emporté par la tempête ionique',
  recall: 'Balise de rappel activée',
};
export function causeText(cause) { return DEATH_CAUSES[cause] || DEATH_CAUSES.impact; }

/** POI key -> display name. */
export const POI_NAMES = {};
for (const p of POIS) POI_NAMES[p.key] = p.name;

// ------------------------------------------------------------------ save

function randomSeed() { return (Math.random() * 4294967296) >>> 0; }

export function defaultSave(seed = randomSeed()) {
  const upgrades = {};
  for (const k of UPGRADE_KEYS) upgrades[k] = 0;
  const items = {};
  for (const k of ITEM_KEYS) items[k] = false;
  return {
    version: SAVE_VERSION,
    seed: seed >>> 0,
    items,
    upgrades,
    salvage: 0,              // deposited salvage (the workbench currency)
    world: { mods: [], crates: [], satellites: [], logs: [], taken: [] },
    fog: '',                 // encodeFog() of the explored map
    stats: { deaths: 0, time: 0, distance: 0, salvageTotal: 0, victories: 0, bestTime: 0, logsRead: 0 },
    settings: { muted: false, assist: true, shake: true, tips: true },
    tips: {},                // tips already shown: { key: 1 } (tips.js)
  };
}

const num = (v, min = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, n) : min; };
const int = (v, min = 0) => Math.floor(num(v, min));
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
const idList = (v) => {
  const out = [];
  if (!Array.isArray(v)) return out;
  for (const s of v) if (typeof s === 'string' && s.length > 0 && s.length <= 64 && !out.includes(s)) out.push(s);
  return out.slice(0, 512);
};

/** Bring any older / partial / hand-edited save up to the current shape (never throws). */
export function migrateSave(raw) {
  const r = obj(raw);
  const base = defaultSave(Number.isFinite(Number(r.seed)) && r.seed !== null && r.seed !== '' ? Number(r.seed) >>> 0 : undefined);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const out = base;
  const items = obj(r.items);
  for (const k of ITEM_KEYS) out.items[k] = items[k] === true;
  const up = obj(r.upgrades);
  for (const k of UPGRADE_KEYS) out.upgrades[k] = Math.min(UPGRADES[k].max, int(up[k]));
  out.salvage = int(r.salvage);
  const w = obj(r.world);
  if (Array.isArray(w.mods)) {
    for (const m of w.mods) {
      if (Array.isArray(m) && m.length >= 2 && Number.isInteger(m[0]) && Number.isInteger(m[1]) && m[0] >= 0 && m[1] >= 0 && m[1] < 256) out.world.mods.push([m[0], m[1]]);
    }
  }
  out.world.crates = idList(w.crates);
  out.world.satellites = idList(w.satellites);
  out.world.logs = idList(w.logs).filter((k) => LOGS[k]);
  out.world.taken = idList(w.taken);
  out.fog = typeof r.fog === 'string' && /^[A-Za-z0-9+/=]*$/.test(r.fog) ? r.fog : '';
  const st = obj(r.stats);
  out.stats.deaths = int(st.deaths);
  out.stats.time = num(st.time);
  out.stats.distance = num(st.distance);
  out.stats.salvageTotal = int(st.salvageTotal);
  out.stats.victories = int(st.victories);
  out.stats.bestTime = num(st.bestTime);
  out.stats.logsRead = Math.max(int(st.logsRead), out.world.logs.length);
  const se = obj(r.settings);
  out.settings.muted = se.muted === true;
  out.settings.assist = se.assist !== false;
  out.settings.shake = se.shake !== false;
  out.settings.tips = se.tips !== false;
  for (const [k, v] of Object.entries(obj(r.tips))) if (v && /^[a-z_]{1,24}$/.test(k)) out.tips[k] = 1;
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
 * Load + migrate. status: 'ok' | 'new' (nothing saved) | 'corrupt' (unparseable: the raw text is
 * kept under SAVE_KEY + '.corrupt' and a fresh save is returned) | 'unavailable'.
 */
export function loadSaveEx(storage) {
  const st = getStorage(storage);
  if (!st) return { save: defaultSave(), status: 'unavailable' };
  let txt;
  try { txt = st.getItem(SAVE_KEY); } catch { return { save: defaultSave(), status: 'unavailable' }; }
  if (!txt) return { save: defaultSave(), status: 'new' };
  try {
    const raw = JSON.parse(txt);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not a save');
    return { save: migrateSave(raw), status: 'ok' };
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

/** Erase the save; returns a fresh one (new seed unless given). */
export function clearSave(storage, seed) {
  const st = getStorage(storage);
  try { if (st && st.removeItem) st.removeItem(SAVE_KEY); } catch { /* ignore */ }
  return defaultSave(seed);
}

// ------------------------------------------------------------------ transfer

const EXPORT_TAG = 'DERIVE1:';

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function fromBase64(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Save -> text code (copy / paste between Safari and the home-screen app). */
export function exportSave(save) {
  return EXPORT_TAG + toBase64(new TextEncoder().encode(JSON.stringify(save)));
}

/** Text code -> migrated save, or null when the code is not a Dérive save. */
export function importSave(text) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\s+/g, '');
  if (!t.startsWith(EXPORT_TAG)) return null;
  try {
    const raw = JSON.parse(new TextDecoder().decode(fromBase64(t.slice(EXPORT_TAG.length))));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('items' in raw) || !('upgrades' in raw)) return null;
    return migrateSave(raw);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ run

/** Life seed: moving asteroids and debris salvage are re-rolled on every death (§3.2). */
export function lifeSeedFor(save) {
  return (save.seed ^ Math.imul(save.stats.deaths + 1, 0x9e3779b1)) >>> 0;
}

/** A fresh expedition (life). prev = the previous run of this session (keeps deathsThisSession). */
export function createRun(save, prev = null) {
  return {
    salvage: 0,                        // carried, not deposited
    lifeSeed: lifeSeedFor(save),
    time: 0,                           // s alive this life
    distance: 0,                       // px travelled this life
    startedAt: save.stats.time,
    deathsThisSession: prev ? prev.deathsThisSession : 0,
    flushedTime: 0, flushedDistance: 0,
  };
}

/** Move the run's time / distance since the last flush into save.stats (call before persisting). */
export function flushRunStats(save, run) {
  save.stats.time += run.time - run.flushedTime;
  save.stats.distance += run.distance - run.flushedDistance;
  run.flushedTime = run.time;
  run.flushedDistance = run.distance;
}

/** Dock: carried salvage becomes deposited salvage. Mutates save + run; the caller persists. */
export function depositSalvage(save, run) {
  const amount = Math.max(0, Math.floor(run.salvage || 0));
  save.salvage += amount;
  save.stats.salvageTotal += amount;
  run.salvage = 0;
  return { amount, total: save.salvage };
}

/**
 * Death: the carried salvage is lost, equipment / upgrades / deposited salvage / world progress
 * are kept. Mutates save (deaths, time, distance) and zeroes run.salvage; returns the summary
 * shown on the death screen.
 */
export function settleDeath(save, run, cause) {
  flushRunStats(save, run);
  const lost = Math.max(0, Math.floor(run.salvage || 0));
  run.salvage = 0;
  save.stats.deaths++;
  run.deathsThisSession = (run.deathsThisSession || 0) + 1;
  return {
    cause, causeText: causeText(cause), lost,
    time: run.time, distance: run.distance,
    deaths: save.stats.deaths, salvage: save.salvage,
  };
}

/** Victory: counts it, keeps the best total play time; returns the statistics screen data. */
export function recordVictory(save, run, explored = 0) {
  flushRunStats(save, run);
  save.stats.victories++;
  if (!save.stats.bestTime || save.stats.time < save.stats.bestTime) save.stats.bestTime = save.stats.time;
  return {
    time: save.stats.time, deaths: save.stats.deaths, explored,
    logs: save.world.logs.length, logsTotal: LOG_KEYS.length,
    salvageTotal: save.stats.salvageTotal + Math.floor(run.salvage || 0), victories: save.stats.victories,
  };
}

// ------------------------------------------------------------------ fog of war

const FOG_BYTES = (FOG.size * FOG.size) >> 3;
// cells whose centre lies inside the sector boundary: the denominator of fogExplored()
const FOG_MASK = new Uint8Array(FOG.size * FOG.size);
let FOG_MASK_COUNT = 0;
for (let cy = 0; cy < FOG.size; cy++) {
  for (let cx = 0; cx < FOG.size; cx++) {
    const dx = (cx + 0.5) * FOG.cell - CENTER, dy = (cy + 0.5) * FOG.cell - CENTER;
    if (dx * dx + dy * dy <= BOUNDARY.r * BOUNDARY.r) { FOG_MASK[cy * FOG.size + cx] = 1; FOG_MASK_COUNT++; }
  }
}

export function createFog() { return new Uint8Array(FOG_BYTES); }

export function fogCellRevealed(fog, cx, cy) {
  if (cx < 0 || cy < 0 || cx >= FOG.size || cy >= FOG.size) return false;
  const i = cy * FOG.size + cx;
  return (fog[i >> 3] & (1 << (i & 7))) !== 0;
}

export function fogRevealed(fog, x, y) { return fogCellRevealed(fog, Math.floor(x / FOG.cell), Math.floor(y / FOG.cell)); }

/** Reveal every cell whose centre is within r of (x, y); returns how many were new. */
export function fogReveal(fog, x, y, r) {
  const c = FOG.cell;
  const cx0 = Math.max(0, Math.floor((x - r) / c)), cx1 = Math.min(FOG.size - 1, Math.floor((x + r) / c));
  const cy0 = Math.max(0, Math.floor((y - r) / c)), cy1 = Math.min(FOG.size - 1, Math.floor((y + r) / c));
  const r2 = r * r;
  let n = 0;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const dx = (cx + 0.5) * c - x, dy = (cy + 0.5) * c - y;
      if (dx * dx + dy * dy > r2) continue;
      const i = cy * FOG.size + cx;
      const bit = 1 << (i & 7);
      if (fog[i >> 3] & bit) continue;
      fog[i >> 3] |= bit;
      n++;
    }
  }
  return n;
}

export function encodeFog(fog) { return toBase64(fog); }

export function decodeFog(str) {
  const fog = createFog();
  if (typeof str !== 'string' || !str) return fog;
  try {
    const bytes = fromBase64(str);
    fog.set(bytes.subarray(0, FOG_BYTES));
  } catch { /* corrupt: start unexplored */ }
  return fog;
}

/** Percentage (0..100) of the sector disc revealed. */
export function fogExplored(fog) {
  let n = 0;
  for (let i = 0; i < FOG_MASK.length; i++) if (FOG_MASK[i] && (fog[i >> 3] & (1 << (i & 7)))) n++;
  return (n / FOG_MASK_COUNT) * 100;
}

/** A POI counts as discovered once a revealed cell lies within FOG.poiRevealR of it. */
export function poiDiscovered(fog, poi) {
  const r = FOG.poiRevealR, c = FOG.cell;
  const cx0 = Math.floor((poi.x - r) / c), cx1 = Math.floor((poi.x + r) / c);
  const cy0 = Math.floor((poi.y - r) / c), cy1 = Math.floor((poi.y + r) / c);
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) if (fogCellRevealed(fog, cx, cy)) return true;
  return false;
}
