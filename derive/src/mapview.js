// Full-screen sector map (state MAP, DESIGN §10): terrain overview hidden under the fog of war, the
// storm boundary, known hazards (suns, black holes, belt), discovered places with icons and names,
// the astronaut and its heading, and a legend (equipment owned, satellites, logs, % explored).
//
//   drawMap(ctx, game, w, h)   draws everything (reads game.world, gen, fog, save, player, entities)
//   invalidateMap()            forget the cached terrain / fog canvases (new world)
//   mapLayout(w, h, safe?) -> { x, y, size, k, wx0, wy0, legendX, legendW }   (pure, unit-tested)
//   worldToMap(layout, x, y, out) -> out { x, y }                             (pure, unit-tested)
// The terrain canvas (MAP_VIEW.terrainPx², 1 px = 4 tiles) is rebuilt only when the world changes
// (world.version); the fog canvas (FOG.size², 1 px = 1 cell) only when the revealed-cell count changes.
import { TILE, WORLD_TILES, CENTER, BOUNDARY, BELT, FOG, POI_BY_KEY } from './config.js';
import { TILES, SOLID } from './tiles.js';
import { drawSprite } from './sprites.js';
import { drawText, measureText, TextMemo } from './hud.js';
import { ITEMS, ITEM_KEYS, LOG_KEYS, fogExplored, poiDiscovered } from './meta.js';
import { MAP_VIEW } from './render-config.js';

const TAU = Math.PI * 2;
const R_VIEW = BOUNDARY.r + 160;               // world px shown around the centre
const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) { let n = 0, v = i; while (v) { n += v & 1; v >>= 1; } POPCOUNT[i] = n; }
/** Vertical label placement for places that sit close to another one (px, + = below). */
const LABEL_DY = { maelstrom: -9, ulysse: 8, selene: -10, tycho: 8, twins: -12, helios: 9 };
const O = { outline: '#03050a' };
const O_R = { outline: '#03050a', align: 'right' };
const O_C = { outline: '#03050a', align: 'center' };
const DASH = [3, 4];
const NO_DASH = [];

let terrain = null, terrainWorld = null, terrainVersion = -1;
let fogCanvas = null, fogImg = null, fogCount = -1, fogRef = null;
let beltKnown = false;
const memo = {
  explored: new TextMemo((a) => `EXPLORÉ ${a} %`),
  sats: new TextMemo((a, b) => `SATELLITES ${a}/${b}`),
  logs: new TextMemo((a, b) => `JOURNAUX ${a}/${b}`),
};
let exploredPct = 0;
const layout = { x: 0, y: 0, size: 0, k: 1, wx0: 0, wy0: 0, legendX: 0, legendW: 0 };
const pt = { x: 0, y: 0 };

export function invalidateMap() { terrain = null; terrainWorld = null; fogCanvas = null; fogCount = -1; fogRef = null; }

/** Where the map square and the legend go for a w × h internal screen. */
export function mapLayout(w, h, safe, out = layout) {
  const m = MAP_VIEW.margin;
  const l = Math.max(m, (safe && safe.l) || 0), r = Math.max(m, (safe && safe.r) || 0);
  let size = h - 2 * m;
  const legendMin = 150;
  if (w - l - r - size - m < legendMin) size = Math.max(80, w - l - r - m - legendMin);
  out.size = size;
  out.x = l + Math.max(0, Math.floor((w - l - r - size - m - legendMin) * 0.25));
  out.y = Math.floor((h - size) / 2);
  out.k = size / (R_VIEW * 2);
  out.wx0 = CENTER - R_VIEW; out.wy0 = CENTER - R_VIEW;
  out.legendX = out.x + size + m + 6;
  out.legendW = w - r - out.legendX;
  return out;
}

export function worldToMap(L, x, y, out = pt) {
  out.x = L.x + (x - L.wx0) * L.k;
  out.y = L.y + (y - L.wy0) * L.k;
  return out;
}

function buildTerrain(world) {
  const N = MAP_VIEW.terrainPx, step = WORLD_TILES / N;
  if (!terrain) { terrain = document.createElement('canvas'); terrain.width = N; terrain.height = N; }
  const g = terrain.getContext('2d');
  const img = g.createImageData(N, N);
  const d = img.data;
  const rgbOf = TILES.map((t) => { const c = t.colors[2]; return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; });
  const floorRgb = [58, 66, 84];
  for (let my = 0; my < N; my++) for (let mx = 0; mx < N; mx++) {
    let solidId = -1, solidN = 0, floorN = 0;
    for (let j = 0; j < step; j++) for (let i = 0; i < step; i++) {
      const id = world.types[(my * step + j) * world.w + mx * step + i];
      if (!id) continue;
      if (SOLID[id]) { solidN++; solidId = id; } else floorN++;
    }
    const o = (my * N + mx) * 4;
    if (solidN) { const c = rgbOf[solidId]; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; }
    else if (floorN) { d[o] = floorRgb[0]; d[o + 1] = floorRgb[1]; d[o + 2] = floorRgb[2]; d[o + 3] = 255; }
  }
  g.putImageData(img, 0, 0);
  terrainWorld = world; terrainVersion = world.version;
}

function buildFog(fog, count) {
  const N = FOG.size;
  if (!fogCanvas) {
    fogCanvas = document.createElement('canvas'); fogCanvas.width = N; fogCanvas.height = N;
    fogImg = fogCanvas.getContext('2d').createImageData(N, N);
  }
  const d = fogImg.data;
  const rin2 = (BELT.rInner / FOG.cell) ** 2, rout2 = (BELT.rOuter / FOG.cell) ** 2, c0 = CENTER / FOG.cell;
  beltKnown = false;
  for (let i = 0; i < N * N; i++) {
    const on = (fog[i >> 3] & (1 << (i & 7))) !== 0;
    const o = i * 4;
    const cx = i % N, cy = (i / N) | 0;
    d[o] = 6; d[o + 1] = 10; d[o + 2] = 22; d[o + 3] = on ? 0 : ((cx + cy) & 1 ? 250 : 236);
    if (on && !beltKnown) { const dd = (cx + 0.5 - c0) ** 2 + (cy + 0.5 - c0) ** 2; if (dd > rin2 && dd < rout2) beltKnown = true; }
  }
  fogCanvas.getContext('2d').putImageData(fogImg, 0, 0);
  fogCount = count; fogRef = fog;
  exploredPct = Math.round(fogExplored(fog));
}

function revealedCount(fog) {
  let n = 0;
  for (let i = 0; i < fog.length; i++) n += POPCOUNT[fog[i]];
  return n;
}

export function drawMap(ctx, game, w, h) {
  const world = game.world, gen = game.gen, fog = game.fog, save = game.save, p = game.player;
  ctx.fillStyle = '#03060d';
  ctx.fillRect(0, 0, w, h);
  if (!world || !gen) return;
  const L = mapLayout(w, h, game.safe);
  if (terrainWorld !== world || terrainVersion !== world.version || !terrain) buildTerrain(world);
  if (fog) { const c = revealedCount(fog); if (c !== fogCount || fogRef !== fog || !fogCanvas) buildFog(fog, c); }
  const clock = typeof performance !== 'undefined' ? performance.now() / 1000 : 0;
  const cx = L.x + L.size / 2, cy = L.y + L.size / 2, R = BOUNDARY.r * L.k;
  // panel frame
  ctx.fillStyle = '#071226'; ctx.fillRect(L.x - 2, L.y - 2, L.size + 4, L.size + 4);
  ctx.fillStyle = '#1f5a74';
  ctx.fillRect(L.x - 3, L.y - 3, L.size + 6, 1); ctx.fillRect(L.x - 3, L.y + L.size + 2, L.size + 6, 1);
  ctx.fillRect(L.x - 3, L.y - 3, 1, L.size + 6); ctx.fillRect(L.x + L.size + 2, L.y - 3, 1, L.size + 6);
  // terrain (whole sector square), then the fog over it
  const tk = MAP_VIEW.terrainPx / (WORLD_TILES * TILE);
  const sx = L.wx0 * tk, sw = R_VIEW * 2 * tk;
  ctx.drawImage(terrain, sx, sx, sw, sw, L.x, L.y, L.size, L.size);
  if (fogCanvas) {
    const fk = 1 / FOG.cell;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fogCanvas, L.wx0 * fk, L.wy0 * fk, R_VIEW * 2 * fk, R_VIEW * 2 * fk, L.x, L.y, L.size, L.size);
    ctx.imageSmoothingEnabled = false;
  }
  // grid (1000 px) + sector boundary (ion storm)
  ctx.globalAlpha = 0.1; ctx.fillStyle = '#6fe6ff';
  for (let v = -4000; v <= 4000; v += 1000) {
    const a = worldToMap(L, CENTER + v, CENTER + v);
    ctx.fillRect(Math.round(a.x), L.y, 1, L.size); ctx.fillRect(L.x, Math.round(a.y), L.size, 1);
  }
  ctx.globalAlpha = 0.55; ctx.strokeStyle = '#5fe8d0'; ctx.lineWidth = 1;
  ctx.setLineDash(DASH);
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.stroke();
  if (beltKnown) {
    ctx.strokeStyle = '#a3845e'; ctx.globalAlpha = 0.35;
    ctx.beginPath(); ctx.arc(cx, cy, ((BELT.rInner + BELT.rOuter) / 2) * L.k, 0, TAU); ctx.stroke();
  }
  ctx.setLineDash(NO_DASH);
  ctx.globalAlpha = 1;
  // known hazards
  const hz = game.hazards;
  const known = (key) => fog && poiDiscovered(fog, POI_BY_KEY[key]);
  if (hz) {
    if (known('twins')) for (const s of hz.suns) {
      const a = worldToMap(L, s.x, s.y);
      ctx.globalAlpha = 0.25; ctx.fillStyle = '#ff7a20';
      ctx.beginPath(); ctx.arc(a.x, a.y, s.heatR * L.k, 0, TAU); ctx.fill();
      ctx.globalAlpha = 1; ctx.fillStyle = '#ffd060';
      ctx.beginPath(); ctx.arc(a.x, a.y, Math.max(2, s.coreR * L.k * 1.6), 0, TAU); ctx.fill();
    }
    for (const b of hz.blackHoles) {
      if (!known(b.key)) continue;
      const a = worldToMap(L, b.x, b.y);
      ctx.globalAlpha = 0.5; ctx.strokeStyle = '#b07aff';
      ctx.beginPath(); ctx.arc(a.x, a.y, Math.max(3, b.diskR * L.k * 1.5), 0, TAU); ctx.stroke();
      ctx.globalAlpha = 1; ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(a.x, a.y, 2, 0, TAU); ctx.fill();
    }
  }
  // places
  const sats = game.entities ? game.entities.satellites : null;
  for (const poi of gen.pois) {
    if (!poi.always && !(fog && poiDiscovered(fog, poi))) continue;
    if (poi.kind === 'blackhole' || poi.key === 'twins') {
      // drawn as hazards: label only
    } else {
      const a = worldToMap(L, poi.x, poi.y);
      drawSprite(ctx, poi.icon, 0, a.x, a.y);
      if (poi.kind === 'satellite' && sats) {
        for (const s of sats) if (s.id === poi.key && s.active) { ctx.fillStyle = '#5fef8f'; ctx.fillRect(Math.round(a.x) + 3, Math.round(a.y) - 5, 2, 2); }
        continue; // satellites: no label (six of them)
      }
    }
    const a = worldToMap(L, poi.x, poi.y);
    const dy = LABEL_DY[poi.key] || 0;
    const right = a.x < cx + L.size * 0.1;
    const col = poi.kind === 'blackhole' ? '#d8b0ff' : poi.always ? '#bff4ff' : '#e8eef8';
    if (dy) drawText(ctx, poi.name, a.x, a.y + dy - (dy < 0 ? 4 : 0), col, O_C);
    else if (right) drawText(ctx, poi.name, a.x + 7, a.y - 3, col, O);
    else drawText(ctx, poi.name, a.x - 7, a.y - 3, col, O_R);
  }
  // the astronaut
  if (p) {
    const a = worldToMap(L, p.x, p.y);
    if (Math.floor(clock * MAP_VIEW.blink * 2) % 2 === 0 || p.dead) {
      ctx.fillStyle = '#ffffff';
      const c = Math.cos(p.angle), s = Math.sin(p.angle);
      for (let d = 4; d < 9; d++) ctx.fillRect(Math.round(a.x + c * d), Math.round(a.y + s * d), 1, 1);
      drawSprite(ctx, 'radar_arrow', p.dir16, a.x, a.y);
    }
  }
  // legend
  let y = L.y + 2;
  const x = L.legendX;
  drawText(ctx, 'CARTE DU SECTEUR', x, y, '#6fe6ff', O);
  y += 14;
  if (fog) drawText(ctx, memo.explored.get(exploredPct), x, y, '#e8eef8', O);
  y += 11;
  if (save) {
    const nSat = save.world.satellites.length;
    drawText(ctx, memo.sats.get(nSat, gen.satellites.length), x, y, '#e8eef8', O); y += 11;
    drawText(ctx, memo.logs.get(save.world.logs.length, LOG_KEYS.length), x, y, '#e8eef8', O); y += 16;
    drawText(ctx, 'ÉQUIPEMENTS', x, y, '#6fe6ff', O); y += 12;
    for (const key of ITEM_KEYS) {
      const own = !!save.items[key];
      ctx.globalAlpha = own ? 1 : 0.25;
      drawSprite(ctx, ITEMS[key].icon, 0, x + 6, y + 3);
      ctx.globalAlpha = 1;
      drawText(ctx, own ? ITEMS[key].name : '???', x + 16, y, own ? '#ffe9a8' : '#5a6478', O);
      y += 15;
    }
  }
  y += 4;
  // key
  const keyRow = (icon, label, col) => {
    if (y > L.y + L.size - 8) return;
    drawSprite(ctx, icon, 0, x + 6, y + 3);
    drawText(ctx, label, x + 16, y, col, O);
    y += 12;
  };
  keyRow('poi_home', 'ÉPAVE : DÉPÔT ET ÉTABLI', '#bff4ff');
  if (measureText('TEMPÊTE IONIQUE') + 16 < L.legendW) {
    ctx.globalAlpha = 0.8; ctx.fillStyle = '#5fe8d0'; ctx.fillRect(x + 2, y + 3, 8, 1); ctx.globalAlpha = 1;
    drawText(ctx, 'TEMPÊTE IONIQUE', x + 16, y, '#5fe8d0', O);
  }
}
