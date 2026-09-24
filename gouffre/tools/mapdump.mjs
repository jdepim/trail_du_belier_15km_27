// Dev tool: render a generated world to a PNG (1 tile = SCALE px) for eyeballing worldgen.
// Usage: node tools/mapdump.mjs [seed] [out.png]
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generateWorld } from '../src/worldgen.js';
import { TILES, BACK } from '../src/tiles.js';

const seed = process.argv[2] ?? 12345;
const out = process.argv[3] ?? 'map.png';
const SCALE = Number(process.env.SCALE || 3);
const Y0 = Number(process.env.Y0 || 0);
const Y1 = Number(process.env.Y1 || 299);

const { world, spawns, chests, camp } = generateWorld(seed);
const W = world.w * SCALE, H = (Y1 - Y0 + 1) * SCALE;
const px = new Uint8Array(W * H * 3);
const hex = (h) => {
  const s = h.length === 4 ? h.slice(1).split('').map((c) => c + c).join('') : h.slice(1);
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
};
const backCol = { [BACK.NONE]: [40, 50, 90], [BACK.BRICK]: [30, 22, 28], [BACK.CRYSTAL]: [12, 26, 38], [BACK.ARENA]: [30, 12, 30] };
function put(x, y, c) {
  y -= Y0;
  if (y < 0 || y > Y1 - Y0) return;
  for (let j = 0; j < SCALE; j++) for (let i = 0; i < SCALE; i++) {
    const o = ((y * SCALE + j) * W + x * SCALE + i) * 3;
    px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2];
  }
}
for (let ty = 0; ty < world.h; ty++) {
  for (let tx = 0; tx < world.w; tx++) {
    const def = TILES[world.get(tx, ty)];
    let c;
    if (def.key === 'air') c = backCol[world.getBack(tx, ty)] || [14, 12, 16];
    else if (def.deco) c = hex(def.colors[2]).map((v) => v >> 1);
    else c = hex(def.ore || def.light ? def.colors[2] : def.colors[1]);
    put(tx, ty, c);
  }
}
const mark = { slime: [80, 255, 80], bat: [200, 80, 255], skeleton: [255, 255, 255], spider: [255, 60, 60], ghost: [150, 255, 255], imp: [255, 150, 0], golem: [160, 120, 90], guardian: [255, 0, 255] };
for (const s of spawns) put(s.tx, s.ty, mark[s.key]);
for (const c of chests) put(c.tx, c.ty, [255, 215, 0]);

// --- minimal PNG writer
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(out, Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
const counts = {};
for (const s of spawns) counts[s.key] = (counts[s.key] || 0) + 1;
console.log(`seed ${seed}: ${spawns.length} spawns`, counts, `${chests.length} chests, spawn`, camp.spawnX, camp.spawnY, '->', out);
