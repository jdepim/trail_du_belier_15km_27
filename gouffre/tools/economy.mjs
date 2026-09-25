// Economy simulation: estimates gold per trip by depth from the real world
// generator (ore counts and values per layer), enemy coin drops and chest gold,
// then runs a Monte-Carlo progression with a simple "reasonable player" buying
// policy against the upgrade costs of src/meta.js.
//
//   node tools/economy.mjs            full report
//   node tools/economy.mjs --seeds 12 --players 600
//
// It is a model, not a replay: travel speeds, search times and death risk are
// estimates tuned against playtests of the real game (see TRIP below). What it
// grounds in the code: ore tiles and values per layer, bag capacities, pickaxe
// tiers / mining damage, coin values, chest counts and values, upgrade costs.
// Balance targets (task brief): first upgrade after 1 short trip, pickaxe tier 1
// after ~3 trips, tier 2 after ~10, tier 3 after ~20, the Guardian reachable
// after ~2-4 hours of play.
import { generateWorld } from '../src/worldgen.js';
import { TILES } from '../src/tiles.js';
import { LAYERS, SURFACE_Y, ENEMY_STATS, DROPS, ECONOMY, PLAYER, layerAtDepth } from '../src/config.js';
import { UPGRADES, UPGRADE_KEYS, upgradeCost, applyUpgrades } from '../src/meta.js';
import { mulberry32 } from '../src/rng.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? Number(args[i + 1]) : d; };
const SEEDS = opt('seeds', 8);
const PLAYERS = opt('players', 400);
const QUIET = args.includes('--quiet');

// ------------------------------------------------------------------ 1. what the mine holds

function surveyMines() {
  const layers = [0, 1, 2, 3].map(() => ({ tiles: 0, value: 0, hpSum: 0, chests: 0, goldChests: 0 }));
  for (let s = 0; s < SEEDS; s++) {
    const gen = generateWorld(1000 + s * 7919);
    const w = gen.world;
    for (let ty = 0; ty < w.h; ty++) for (let tx = 0; tx < w.w; tx++) {
      const def = TILES[w.types[ty * w.w + tx]];
      if (!def.ore) continue;
      const L = layerAtDepth(Math.max(0, ty - SURFACE_Y)).index;
      if (L > 3) continue;
      layers[L].tiles++; layers[L].value += def.value; layers[L].hpSum += def.hp;
    }
    for (const c of gen.chests) if (c.layer <= 3) { layers[c.layer].chests++; if (c.kind === 'gold') layers[c.layer].goldChests++; }
  }
  for (const L of layers) {
    L.tiles /= SEEDS; L.value /= SEEDS; L.chests /= SEEDS; L.goldChests /= SEEDS;
    L.avgValue = L.value / L.tiles; L.avgHp = L.hpSum / SEEDS / L.tiles;
  }
  return layers;
}

/** Average coin value of one kill at depth d (layer enemy mix). */
function coinPerKill(d) {
  const L = layerAtDepth(d);
  let s = 0, w = 0;
  for (const [k, wt] of Object.entries(L.enemies)) { s += wt * ENEMY_STATS[k].gold; w += wt; }
  return (s / w) * (1 + d * DROPS.goldPerM);
}

const chestGold = (d) => ECONOMY.chestGoldBase * (1 + d * ECONOMY.chestGoldPerM);

// ------------------------------------------------------------------ 2. trip model

// Estimates (seconds). Travel is per metre of target depth, down and back up; the
// way up depends on the grapple (range) and boots. Search time per ore depends on
// the ore density of the layer (layer 3 geodes are rich) and the lantern radius.
const TRIP = {
  targetDepth: [22, 68, 138, 215],   // where a player works in each layer
  overhead: 45,                      // camp, shop, first dig, detours
  downPerM: 0.75,
  upPerM: 1.7,                       // base grapple + boots; / (1 + 0.22 grapple lv + 0.1 boots lv)
  reuse: 0.7,                        // later trips in the same (still alive) mine reuse tunnels
  searchPerOre: [6, 9, 6, 10],       // s to find the next ore with the base lantern (6.5 tiles)
  strikeTime: PLAYER.attackCooldown,
  reachable: 0.6,                    // share of a layer's ore a player finds in one mine
  miningBudget: 150,                 // s of mining per trip at most (then go home)
  killsBase: 2, killsPerMin: 1.1,
  chestFind: 0.3,                    // chance per trip to open a remaining chest of the layer
  risk: [0.08, 0.16, 0.22, 0.28],    // death chance per trip in each layer, before upgrades
  riskCut: 0.028,                    // per vitality / armor level
  riskMin: 0.03,
  rerollBelow: 0.5,                  // reroll the mine when less than half a bag of ore is left
  rerollTime: 20,
  tierNeeded: [0, 1, 2, 3],          // pickaxe tier to work a layer
};

function tripPlan(save, mine, reuse) {
  const player = { hp: 0, stats: null };
  const st = applyUpgrades(player, save);
  const up = save.upgrades;
  let L = 0;
  for (let i = 3; i >= 0; i--) if (st.pickTier >= TRIP.tierNeeded[i]) { L = i; break; }
  // survival gate: nobody sane goes to the abyss with 60 HP
  if (L >= 2 && up.vitality < 1) L = 1;
  if (L >= 3 && (up.vitality < 2 || up.armor < 1)) L = 2;
  const d = TRIP.targetDepth[L];
  const layer = mine.layers[L];
  const travel = d * (TRIP.downPerM + TRIP.upPerM / (1 + 0.22 * up.grapple + 0.1 * up.boots)) * (reuse ? TRIP.reuse : 1);
  const hits = Math.ceil(layer.avgHp / st.pickDamage);
  const perOre = TRIP.searchPerOre[L] * Math.sqrt(PLAYER.lanternRadius / st.lanternRadius) + hits * TRIP.strikeTime;
  const avail = Math.max(0, mine.remaining[L]);
  const n = Math.max(0, Math.min(st.bagCapacity, Math.floor(avail), Math.floor(TRIP.miningBudget / perOre)));
  const mining = n * perOre;
  const time = TRIP.overhead + travel + mining;
  const kills = TRIP.killsBase + (time / 60) * TRIP.killsPerMin;
  const coins = kills * coinPerKill(d);
  const oreGold = n * layer.avgValue;
  const risk = Math.max(TRIP.riskMin, TRIP.risk[L] - TRIP.riskCut * (up.vitality + up.armor));
  return { L, d, n, oreGold, coins, time, risk, bag: st.bagCapacity, insurance: st.insurance };
}

// ------------------------------------------------------------------ 3. buying policy

const WEIGHT = { bag: 1.6, vitality: 1.2, grapple: 1.1, armor: 1.0, lantern: 0.9, boots: 0.7, insurance: 0.6 };

function shop(save, log) {
  for (let guard = 0; guard < 50; guard++) {
    const pickCost = upgradeCost('pick', save.upgrades.pick);
    if (pickCost <= save.gold) { buy(save, 'pick', log); continue; }
    let best = null, bestScore = Infinity;
    for (const k of UPGRADE_KEYS) {
      if (k === 'pick') continue;
      const c = upgradeCost(k, save.upgrades[k]);
      if (c > save.gold) continue;
      // keep saving for the pickaxe: small buys only (or when rich enough)
      if (pickCost !== Infinity && c > 0.4 * pickCost && save.gold - c < pickCost) continue;
      const score = c / WEIGHT[k];
      if (score < bestScore) { bestScore = score; best = k; }
    }
    if (!best) return;
    buy(save, best, log);
  }
}

function buy(save, k, log) {
  const c = upgradeCost(k, save.upgrades[k]);
  save.gold -= c;
  save.upgrades[k]++;
  if (log) log.push(`${UPGRADES[k].name} ${save.upgrades[k]} (${c})`);
}

const bossReady = (u) => u.pick >= 4 && u.vitality >= 4 && u.armor >= 3 && u.grapple >= 2;

// ------------------------------------------------------------------ 4. one player

function newMine(survey) {
  return { layers: survey, remaining: survey.map((L) => L.tiles * TRIP.reachable), chests: survey.map((L) => L.chests), trips: 0 };
}

function simulate(survey, rnd, keepLog) {
  const save = { gold: 0, upgrades: Object.fromEntries(UPGRADE_KEYS.map((k) => [k, 0])) };
  let mine = newMine(survey);
  let time = 0;
  const ms = {};
  const rows = [];
  for (let trip = 1; trip <= 120; trip++) {
    let plan = tripPlan(save, mine, mine.trips > 0);
    // a depleted mine is rerolled: "Recommencer l'expédition" at the camp (counts as a
    // death, but nothing is lost with an empty bag) regenerates it with a new seed
    if (mine.remaining[plan.L] < plan.bag * TRIP.rerollBelow) {
      mine = newMine(survey);
      time += TRIP.rerollTime;
      plan = tripPlan(save, mine, false);
    }
    let chest = 0;
    if (mine.chests[plan.L] > 0.5 && rnd() < TRIP.chestFind) {
      mine.chests[plan.L]--;
      chest = rnd() < 0.65 ? chestGold(plan.d) : 0; // relic chests give no gold
    }
    const loot = plan.oreGold + plan.coins + chest;
    const died = rnd() < plan.risk;
    let gained;
    if (died) {
      time += plan.time * 0.7;
      gained = Math.floor(loot * plan.insurance);
      mine = newMine(survey);           // death regenerates the mine
    } else {
      time += plan.time;
      gained = Math.round(loot);
      mine.remaining[plan.L] -= plan.n;
      mine.trips++;
    }
    save.gold += gained;
    const log = keepLog ? [] : null;
    const before = { ...save.upgrades };
    shop(save, log);
    if (ms.first === undefined && UPGRADE_KEYS.some((k) => save.upgrades[k] > before[k])) ms.first = { trip, time };
    for (const [lv, key] of [[1, 'pick1'], [2, 'pick2'], [4, 'pick4']]) if (ms[key] === undefined && save.upgrades.pick >= lv) ms[key] = { trip, time };
    if (ms.boss === undefined && bossReady(save.upgrades)) ms.boss = { trip, time: time + 420 }; // final descent + fight
    if (ms.maxed === undefined && UPGRADE_KEYS.every((k) => save.upgrades[k] >= UPGRADES[k].max)) ms.maxed = { trip, time };
    if (keepLog) rows.push({ trip, time, layer: plan.L, n: plan.n, bag: plan.bag, loot: Math.round(loot), died, gained, bank: save.gold, log });
    if (ms.boss && ms.maxed) break;
  }
  return { ms, rows };
}

// ------------------------------------------------------------------ 5. report

const fmtT = (s) => `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
const median = (a) => { const b = a.filter((x) => x !== undefined).sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : NaN; };
const pctl = (a, p) => { const b = a.filter((x) => x !== undefined).sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(b.length * p))] : NaN; };

export function runEconomy({ quiet = false } = {}) {
  const survey = surveyMines();
  const out = [];
  const print = (s = '') => { if (!quiet) console.log(s); out.push(s); };

  print(`# GOUFFRE economy (${SEEDS} seeds, ${PLAYERS} simulated players)\n`);
  print('## Ore per mine (worldgen average)');
  print('layer                     ore tiles  avg value  total gold  avg hp  chests (gold)');
  survey.forEach((L, i) => print(`${LAYERS[i].name.padEnd(24)} ${L.tiles.toFixed(0).padStart(9)} ${L.avgValue.toFixed(1).padStart(10)} ${L.value.toFixed(0).padStart(11)} ${L.avgHp.toFixed(1).padStart(7)}  ${L.chests.toFixed(1)} (${L.goldChests.toFixed(1)})`));

  print('\n## Gold per trip by depth (typical loadout for that stage, fresh mine, no death)');
  print('depth   loadout                         ores  ore gold  coins  total  minutes  gold/min');
  const stages = [
    ['start', {}],
    ['sac 1, pioche 1', { bag: 1, pick: 1, lantern: 1 }],
    ['sac 2, pioche 2, vita 1', { bag: 2, pick: 2, vitality: 1, grapple: 1, lantern: 1 }],
    ['sac 3, pioche 4, vita 2, arm 1', { bag: 3, pick: 4, vitality: 2, armor: 1, grapple: 2, lantern: 2 }],
  ];
  for (const [label, ups] of stages) {
    const save = { gold: 0, upgrades: Object.fromEntries(UPGRADE_KEYS.map((k) => [k, ups[k] || 0])) };
    const p = tripPlan(save, newMine(survey), false);
    const tot = p.oreGold + p.coins;
    print(`-${String(p.d).padEnd(5)} ${label.padEnd(31)} ${String(p.n).padStart(4)} ${p.oreGold.toFixed(0).padStart(9)} ${p.coins.toFixed(0).padStart(6)} ${tot.toFixed(0).padStart(6)} ${(p.time / 60).toFixed(1).padStart(8)} ${(tot / (p.time / 60)).toFixed(0).padStart(9)}`);
  }

  print('\n## Forge costs (src/meta.js)');
  let total = 0;
  for (const k of UPGRADE_KEYS) { const c = UPGRADES[k].costs; total += c.reduce((a, b) => a + b, 0); print(`${UPGRADES[k].name.padEnd(18)} ${c.join(' / ')}`); }
  print(`everything: ${total} gold`);

  // Monte Carlo
  const rnd = mulberry32(0xec0);
  const all = [];
  for (let i = 0; i < PLAYERS; i++) all.push(simulate(survey, rnd, false).ms);
  const col = (k, f) => all.map((m) => (m[k] ? m[k][f] : undefined));
  print('\n## Progression (median [10th-90th percentile])');
  const targets = { first: [1, 1], pick1: [2, 4], pick2: [8, 13], pick4: [17, 24] };
  const rowsOut = [];
  for (const [k, label] of [['first', 'first upgrade'], ['pick1', 'pickaxe tier 1'], ['pick2', 'pickaxe tier 2'], ['pick4', 'pickaxe tier 3'], ['boss', 'Guardian reachable'], ['maxed', 'everything maxed']]) {
    const tr = col(k, 'trip'), tm = col(k, 'time');
    const mt = median(tr), t = median(tm);
    let ok = '';
    if (targets[k]) ok = mt >= targets[k][0] && mt <= targets[k][1] ? '  ok' : `  (target ${targets[k][0]}-${targets[k][1]} trips)`;
    if (k === 'boss') ok = t >= 7200 && t <= 14400 ? '  ok' : '  (target 2h-4h)';
    const line = `${label.padEnd(20)} trip ${String(mt).padStart(3)} [${pctl(tr, 0.1)}-${pctl(tr, 0.9)}]   ${fmtT(t)} [${fmtT(pctl(tm, 0.1))}-${fmtT(pctl(tm, 0.9))}]${ok}`;
    print(line);
    rowsOut.push({ k, trip: mt, time: t });
  }

  if (!quiet) {
    print('\n## One sample player');
    const { rows } = simulate(survey, mulberry32(7), true);
    for (const r of rows.slice(0, 40)) {
      print(`trip ${String(r.trip).padStart(2)} ${fmtT(r.time)}  L${r.layer + 1} ${String(r.n).padStart(2)}/${String(r.bag).padEnd(2)} loot ${String(r.loot).padStart(4)}${r.died ? ' DIED -> ' + r.gained : ''}  bank ${String(r.bank).padStart(5)}  ${r.log.join(', ')}`);
    }
  }
  return { survey, milestones: rowsOut, lines: out };
}

if (import.meta.url === `file://${process.argv[1]}`) runEconomy({ quiet: QUIET });
