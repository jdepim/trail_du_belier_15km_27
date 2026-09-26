// Dev tool: render a generated sector to a PNG (no browser) for eyeballing worldgen and level design.
// Usage: node tools/mapdump.mjs [seed] [out.png] [poiKey] [radiusPx]
//   whole sector at 1 px per tile, or a crop around a POI (e.g. orion 400) at SCALE px per tile
//   (env SCALE, default 1 for the sector, 3 for a crop). Records are marked on top of the tiles:
//   key items magenta, crates gold, terminals cyan, satellites blue, doors red, turrets orange,
//   lasers red lines, vents yellow, pickups white dots, spawn / capsule green.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generateWorld } from '../src/worldgen.js';
import { TILES } from '../src/tiles.js';
import { TILE, POI_BY_KEY } from '../src/config.js';

const seed = Number(process.argv[2] ?? 12345);
const out = process.argv[3] ?? 'sector.png';
const poi = process.argv[4] ? POI_BY_KEY[process.argv[4]] : null;
if (process.argv[4] && !poi) { console.error('unknown POI key:', process.argv[4]); process.exit(1); }
const radius = Number(process.argv[5] ?? 400);
const SCALE = Number(process.env.SCALE || (poi ? 3 : 1));

const gen = generateWorld(seed);
const { world } = gen;
const tx0 = poi ? Math.max(0, Math.floor((poi.x - radius) / TILE)) : 0;
const ty0 = poi ? Math.max(0, Math.floor((poi.y - radius) / TILE)) : 0;
const tx1 = poi ? Math.min(world.w - 1, Math.floor((poi.x + radius) / TILE)) : world.w - 1;
const ty1 = poi ? Math.min(world.h - 1, Math.floor((poi.y + radius) / TILE)) : world.h - 1;
const W = (tx1 - tx0 + 1) * SCALE, H = (ty1 - ty0 + 1) * SCALE;
const px = new Uint8Array(W * H * 3);
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const tileRgb = TILES.map((t) => hex(t.colors[2]));

function putTile(tx, ty, c) {
  if (tx < tx0 || ty < ty0 || tx > tx1 || ty > ty1) return;
  for (let j = 0; j < SCALE; j++) for (let i = 0; i < SCALE; i++) {
    const o = (((ty - ty0) * SCALE + j) * W + (tx - tx0) * SCALE + i) * 3;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
  }
}
const mark = (x, y, c, r = 1) => {
  const cx = Math.floor(x / TILE), cy = Math.floor(y / TILE);
  for (let dy = -r + 1; dy < r; dy++) for (let dx = -r + 1; dx < r; dx++) putTile(cx + dx, cy + dy, c);
};

for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
  const id = world.get(tx, ty);
  if (id) putTile(tx, ty, tileRgb[id]);
}
for (const l of gen.lasers || []) {
  const n = Math.ceil(Math.hypot(l.x1 - l.x0, l.y1 - l.y0) / TILE);
  for (let k = 0; k <= n; k++) mark(l.x0 + ((l.x1 - l.x0) * k) / n, l.y0 + ((l.y1 - l.y0) * k) / n, [255, 60, 50]);
}
for (const p of gen.pickups || []) mark(p.x, p.y, [230, 230, 230]);
for (const c of gen.crates || []) mark(c.x, c.y, [255, 200, 40], 2);
for (const t of gen.terminals || []) mark(t.x, t.y, [80, 230, 255], 2);
for (const s of gen.satellites || []) mark(s.x, s.y, [90, 130, 255], 2);
for (const d of gen.doors || []) mark(d.x, d.y, [255, 40, 40], 2);
for (const t of gen.turrets || []) mark(t.x, t.y, [255, 140, 20], 2);
for (const v of gen.vents || []) mark(v.x, v.y, [240, 230, 80], 2);
for (const i of gen.items || []) mark(i.x, i.y, [255, 60, 255], 3);
mark(gen.spawn.x, gen.spawn.y, [60, 255, 120], 2);
if (gen.capsule) mark(gen.capsule.x, gen.capsule.y, [60, 255, 120], 2);

// ---- minimal PNG writer (RGB, no filter)
const CRC = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log(`${out}: ${W}×${H}, seed ${seed}`);
