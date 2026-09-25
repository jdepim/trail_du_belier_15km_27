// Tile-grid physics: axis-separated AABB collision and grid ray casting.
//
// A body is any object { x, y, w, h, vx, vy } where (x, y) is the TOP-LEFT of its
// hitbox in pixels. Optional: body.cornerCorrection (px) lets a rising body slide
// around ceiling corners instead of bonking (DESIGN.md §4).
import { TILE } from './config.js';

const EPS = 1e-4;
const MAX_STEP = 7; // px per sub-step; < TILE so a fast body can never skip a tile

/**
 * Move a body by its velocity for dt seconds, resolving collisions against solid
 * tiles one axis at a time. Velocity components are zeroed on impact.
 * Robust at any speed thanks to sub-stepping.
 * @returns {{onGround:boolean, hitCeiling:boolean, hitLeft:boolean, hitRight:boolean}}
 */
export function moveAndCollide(body, dt, world, out) {
  const res = out || { onGround: false, hitCeiling: false, hitLeft: false, hitRight: false };
  res.onGround = false; res.hitCeiling = false; res.hitLeft = false; res.hitRight = false;
  const dx = body.vx * dt, dy = body.vy * dt;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_STEP));
  const sx = dx / steps, sy = dy / steps;
  let blockX = false, blockY = false;
  for (let i = 0; i < steps; i++) {
    if (sx !== 0 && !blockX) blockX = stepX(body, sx, world, res);
    if (sy !== 0 && !blockY) blockY = stepY(body, sy, world, res);
    if ((blockX || sx === 0) && (blockY || sy === 0)) break;
  }
  // resting contact: standing still on the ground still counts as grounded
  if (!res.onGround && body.vy >= 0 && touchingBelow(body, world)) res.onGround = true;
  return res;
}

function stepX(body, sx, world, res) {
  body.x += sx;
  const top = Math.floor(body.y / TILE);
  const bot = Math.floor((body.y + body.h - EPS) / TILE);
  if (sx > 0) {
    const tx = Math.floor((body.x + body.w - EPS) / TILE);
    for (let ty = top; ty <= bot; ty++) {
      if (world.isSolid(tx, ty)) {
        body.x = tx * TILE - body.w;
        if (body.vx > 0) body.vx = 0;
        res.hitRight = true;
        return true;
      }
    }
  } else {
    const tx = Math.floor(body.x / TILE);
    for (let ty = top; ty <= bot; ty++) {
      if (world.isSolid(tx, ty)) {
        body.x = (tx + 1) * TILE;
        if (body.vx < 0) body.vx = 0;
        res.hitLeft = true;
        return true;
      }
    }
  }
  return false;
}

function rowBlocked(world, ty, x, w) {
  const l = Math.floor(x / TILE), r = Math.floor((x + w - EPS) / TILE);
  for (let tx = l; tx <= r; tx++) if (world.isSolid(tx, ty)) return true;
  return false;
}

function stepY(body, sy, world, res) {
  body.y += sy;
  const left = Math.floor(body.x / TILE);
  const right = Math.floor((body.x + body.w - EPS) / TILE);
  if (sy > 0) {
    const ty = Math.floor((body.y + body.h - EPS) / TILE);
    for (let tx = left; tx <= right; tx++) {
      if (world.isSolid(tx, ty)) {
        body.y = ty * TILE - body.h;
        if (body.vy > 0) body.vy = 0;
        res.onGround = true;
        return true;
      }
    }
    return false;
  }
  const ty = Math.floor(body.y / TILE);
  if (!rowBlocked(world, ty, body.x, body.w)) return false;
  // Ceiling corner correction: if only the outer few pixels clip a corner, slide past it.
  const cc = body.cornerCorrection || 0;
  if (cc > 0 && left !== right) {
    const leftSolid = world.isSolid(left, ty), rightSolid = world.isSolid(right, ty);
    if (leftSolid !== rightSolid) {
      const shift = leftSolid ? (left + 1) * TILE - body.x : right * TILE - (body.x + body.w);
      if (Math.abs(shift) <= cc && !world.rectSolid(body.x + shift, body.y, body.w, body.h)) {
        body.x += shift;
        return false;
      }
    }
  }
  body.y = (ty + 1) * TILE;
  if (body.vy < 0) body.vy = 0;
  res.hitCeiling = true;
  return true;
}

/** True when the body rests exactly on top of a solid tile. */
export function touchingBelow(body, world) {
  const bottom = body.y + body.h;
  const ty = Math.floor((bottom + 0.05) / TILE);
  if (Math.abs(ty * TILE - bottom) > 0.05) return false;
  return rowBlocked(world, ty, body.x, body.w);
}

/**
 * Grid ray cast (Amanatides & Woo DDA). Direction need not be normalised.
 * @returns {null | {x, y, tx, ty, dist, nx, ny}} first solid tile hit within maxDist:
 *   (x, y) = hit point on the tile boundary, (nx, ny) = surface normal.
 */
export function raycast(world, x0, y0, dirX, dirY, maxDist, isBlocking) {
  const len = Math.hypot(dirX, dirY);
  if (len === 0) return null;
  const dx = dirX / len, dy = dirY / len;
  let tx = Math.floor(x0 / TILE), ty = Math.floor(y0 / TILE);
  const blocking = isBlocking || ((a, b) => world.isSolid(a, b));
  if (blocking(tx, ty)) return { x: x0, y: y0, tx, ty, dist: 0, nx: -Math.sign(dx), ny: -Math.sign(dy) };
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(TILE / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(TILE / dy) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? (tx + 1) * TILE - x0 : x0 - tx * TILE) / Math.abs(dx)) : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? (ty + 1) * TILE - y0 : y0 - ty * TILE) / Math.abs(dy)) : Infinity;
  let t = 0, nx = 0, ny = 0;
  for (let guard = 0; guard < 512; guard++) {
    if (tMaxX < tMaxY) { t = tMaxX; tMaxX += tDeltaX; tx += stepX; nx = -stepX; ny = 0; }
    else { t = tMaxY; tMaxY += tDeltaY; ty += stepY; nx = 0; ny = -stepY; }
    if (t > maxDist) return null;
    if (blocking(tx, ty)) return { x: x0 + dx * t, y: y0 + dy * t, tx, ty, dist: t, nx, ny };
  }
  return null;
}
