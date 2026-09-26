// Top-down zero-g physics: swept circle vs the tile grid, point gravity, sun heat, grid
// raycasts and circle-circle collisions. Pure functions, no allocation in the hot paths.
//
//   moveCircle(body, dt, world, out?) -> out { hit, nx, ny, impact, tile }
//       body = { x, y, vx, vy, r, restitution?, friction? } (x, y = centre). Moves by v·dt in
//       sub-steps of at most MAX_STEP px (no tunnelling, even at PLAYER.hardMaxSpeed), pushes the
//       circle out of solid tiles, bounces (restitution) and damps the tangential speed (friction).
//       impact = largest normal speed at an impact this call (px/s, 0 if none), (nx, ny) = its
//       surface normal, tile = the tile id that was hit.
//   gravityAt(x, y, sources, out, mulBH = 1) -> out { ax, ay, mag, bh }
//       sources = [{ x, y, mu, rSoft, influence, bh }]: a = mu / max(r, rSoft)² toward the source
//       (linear inside rSoft), faded to 0 between GRAVITY.fadeStart × influence and influence.
//       Black-hole sources (bh: true) are multiplied by mulBH (Ancre gravitationnelle).
//       out.bh = magnitude of the black-hole part alone.
//   heatAt(x, y, suns) -> hull/s: Σ heatMax × ((heatR − d)/(heatR − coreR))^heatExp (d clamped to coreR)
//   raycast(world, x0, y0, x1, y1, out?) -> true when a solid tile lies on the segment
//       (out = { x, y, tx, ty, t } first hit, t in 0..1 along the segment). Amanatides & Woo DDA.
//   collideCircles(a, b, restitution) -> relative normal speed at impact (≥ 0) or -1 without overlap
//       bodies { x, y, vx, vy, r, m } (m = mass, Infinity = immovable).
//   distToSegment(px, py, x0, y0, x1, y1) -> px
import { TILE, GRAVITY } from './config.js';
import { SOLID } from './tiles.js';

export const MAX_STEP = 3;            // px per sub-step (< player radius, < TILE)
const MAX_PASSES = 4;

/** Push the circle out of overlapping solid tiles; reflect the velocity. Returns true on contact. */
function resolve(body, world, res, e, friction) {
  let touched = false;
  const r = body.r;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const x = body.x, y = body.y;
    const x0 = Math.floor((x - r) / TILE), x1 = Math.floor((x + r) / TILE);
    const y0 = Math.floor((y - r) / TILE), y1 = Math.floor((y + r) / TILE);
    let best = 0, bnx = 0, bny = 0, btile = 0;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const id = world.get(tx, ty);
        if (!SOLID[id]) continue;
        const lx = tx * TILE, hx = lx + TILE, ly = ty * TILE, hy = ly + TILE;
        const cx = x < lx ? lx : x > hx ? hx : x;
        const cy = y < ly ? ly : y > hy ? hy : y;
        let dx = x - cx, dy = y - cy;
        const d2 = dx * dx + dy * dy;
        let pen, nx, ny;
        if (d2 > 0) {
          if (d2 >= r * r) continue;
          const d = Math.sqrt(d2);
          pen = r - d; nx = dx / d; ny = dy / d;
        } else {
          // centre inside the tile: leave along the axis of least penetration
          const pl = x - lx, pr = hx - x, pt = y - ly, pb = hy - y;
          const m = Math.min(pl, pr, pt, pb);
          if (m === pl) { nx = -1; ny = 0; } else if (m === pr) { nx = 1; ny = 0; } else if (m === pt) { nx = 0; ny = -1; } else { nx = 0; ny = 1; }
          pen = m + r;
        }
        if (pen > best) { best = pen; bnx = nx; bny = ny; btile = id; }
      }
    }
    if (best <= 0) break;
    touched = true;
    body.x += bnx * (best + 1e-3);
    body.y += bny * (best + 1e-3);
    const vn = body.vx * bnx + body.vy * bny;
    if (vn < 0) {
      if (-vn > res.impact) { res.impact = -vn; res.nx = bnx; res.ny = bny; res.tile = btile; }
      else if (res.tile === 0) { res.nx = bnx; res.ny = bny; res.tile = btile; }
      const tvx = body.vx - vn * bnx, tvy = body.vy - vn * bny;
      body.vx = tvx * (1 - friction) - e * vn * bnx;
      body.vy = tvy * (1 - friction) - e * vn * bny;
    } else if (res.tile === 0) {
      res.nx = bnx; res.ny = bny; res.tile = btile;
    }
  }
  return touched;
}

export function moveCircle(body, dt, world, out) {
  const res = out || { hit: false, nx: 0, ny: 0, impact: 0, tile: 0 };
  res.hit = false; res.nx = 0; res.ny = 0; res.impact = 0; res.tile = 0;
  const e = body.restitution !== undefined ? body.restitution : 0.35;
  const friction = body.friction !== undefined ? body.friction : 0.12;
  const dist = Math.hypot(body.vx, body.vy) * dt;
  const steps = Math.max(1, Math.ceil(dist / MAX_STEP));
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    body.x += body.vx * h;
    body.y += body.vy * h;
    if (resolve(body, world, res, e, friction)) res.hit = true;
  }
  return res;
}

export function gravityAt(x, y, sources, out, mulBH = 1) {
  let ax = 0, ay = 0, bx = 0, by = 0;
  const fs = GRAVITY.fadeStart;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const dx = s.x - x, dy = s.y - y;
    const d2 = dx * dx + dy * dy;
    const R = s.influence;
    if (d2 >= R * R || d2 === 0) continue;
    const d = Math.sqrt(d2);
    let a = d > s.rSoft ? s.mu / d2 : s.mu * d / (s.rSoft * s.rSoft * s.rSoft);
    const f0 = fs * R;
    if (d > f0) { const t = (R - d) / (R - f0); a *= t * t * (3 - 2 * t); }
    if (s.bh) {
      a *= mulBH;
      bx += (dx / d) * a; by += (dy / d) * a;
    }
    ax += (dx / d) * a; ay += (dy / d) * a;
  }
  out.ax = ax; out.ay = ay;
  out.mag = Math.sqrt(ax * ax + ay * ay);
  out.bh = Math.sqrt(bx * bx + by * by);
  return out;
}

export function heatAt(x, y, suns) {
  let h = 0;
  for (let i = 0; i < suns.length; i++) {
    const s = suns[i];
    const dx = s.x - x, dy = s.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 >= s.heatR * s.heatR) continue;
    const d = Math.max(s.coreR, Math.sqrt(d2));
    h += s.heatMax * Math.pow((s.heatR - d) / (s.heatR - s.coreR), s.heatExp);
  }
  return h;
}

export function raycast(world, x0, y0, x1, y1, out) {
  let tx = Math.floor(x0 / TILE), ty = Math.floor(y0 / TILE);
  const ex = Math.floor(x1 / TILE), ey = Math.floor(y1 / TILE);
  const dx = x1 - x0, dy = y1 - y0;
  if (world.isSolid(tx, ty)) {
    if (out) { out.x = x0; out.y = y0; out.tx = tx; out.ty = ty; out.t = 0; }
    return true;
  }
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
  let tMaxX = dx !== 0 ? (dx > 0 ? (tx + 1) * TILE - x0 : x0 - tx * TILE) / Math.abs(dx) : Infinity;
  let tMaxY = dy !== 0 ? (dy > 0 ? (ty + 1) * TILE - y0 : y0 - ty * TILE) / Math.abs(dy) : Infinity;
  const n = Math.abs(ex - tx) + Math.abs(ey - ty);
  for (let i = 0; i < n; i++) {
    let t;
    if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; tx += stepX; } else { t = tMaxY; tMaxY += tDeltaY; ty += stepY; }
    if (t > 1) break;
    if (world.isSolid(tx, ty)) {
      if (out) { out.x = x0 + dx * t; out.y = y0 + dy * t; out.tx = tx; out.ty = ty; out.t = t; }
      return true;
    }
  }
  return false;
}

export function collideCircles(a, b, restitution) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const rr = a.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr) return -1;
  const d = Math.sqrt(d2) || 1e-6;
  const nx = d2 > 0 ? dx / d : 1, ny = d2 > 0 ? dy / d : 0;
  const ima = a.m === Infinity ? 0 : 1 / (a.m || 1);
  const imb = b.m === Infinity ? 0 : 1 / (b.m || 1);
  const isum = ima + imb;
  if (isum === 0) return -1;
  const pen = rr - d;
  a.x -= nx * pen * (ima / isum); a.y -= ny * pen * (ima / isum);
  b.x += nx * pen * (imb / isum); b.y += ny * pen * (imb / isum);
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn >= 0) return 0;
  const j = -(1 + restitution) * vn / isum;
  a.vx -= j * ima * nx; a.vy -= j * ima * ny;
  b.vx += j * imb * nx; b.vy += j * imb * ny;
  return -vn;
}

export function distToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = x0 + dx * t - px, cy = y0 + dy * t - py;
  return Math.sqrt(cx * cx + cy * cy);
}
