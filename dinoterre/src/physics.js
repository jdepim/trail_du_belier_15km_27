// Axis-separated AABB movement against the tile grid, shared by the player and creatures.
// A body is any object with {x, y, w, h, vx, vy} (x, y = top-left, px). The mover fills
// body.onGround / hitWallX / hitCeiling and supports one-way platforms and a 1-tile auto step-up.
import { TILE, PHYS } from './config.js';
import { SOLID, ONEWAY, WATER } from './tiles.js';

const EPS = 0.001;

function rowSolid(world, x0, x1, ty) {
  const a = Math.floor(x0 / TILE), b = Math.floor((x1 - EPS) / TILE);
  for (let tx = a; tx <= b; tx++) if (SOLID[world.get(tx, ty)]) return true;
  return false;
}
function colSolid(world, tx, y0, y1) {
  const a = Math.floor(y0 / TILE), b = Math.floor((y1 - EPS) / TILE);
  for (let ty = a; ty <= b; ty++) if (SOLID[world.get(tx, ty)]) return true;
  return false;
}
function rowOneway(world, x0, x1, ty) {
  const a = Math.floor(x0 / TILE), b = Math.floor((x1 - EPS) / TILE);
  for (let tx = a; tx <= b; tx++) if (ONEWAY[world.get(tx, ty)]) return true;
  return false;
}

/** True if the box overlaps any solid tile. */
export function boxSolid(world, x, y, w, h) {
  const a = Math.floor(x / TILE), b = Math.floor((x + w - EPS) / TILE);
  const c = Math.floor(y / TILE), d = Math.floor((y + h - EPS) / TILE);
  for (let ty = c; ty <= d; ty++) for (let tx = a; tx <= b; tx++) if (SOLID[world.get(tx, ty)]) return true;
  return false;
}

/**
 * Move `body` by its velocity over dt.
 * opts.dropThrough: ignore one-way platforms this step; opts.stepUp: allow auto step-up (on ground only).
 */
export function moveBody(world, body, dt, opts = {}) {
  body.hitWallX = 0;
  body.hitCeiling = false;
  const wasOnGround = body.onGround;
  body.onGround = false;

  // ---- X
  let dx = body.vx * dt;
  while (dx !== 0) {
    const step = Math.abs(dx) > TILE / 2 ? Math.sign(dx) * TILE / 2 : dx;
    const nx = body.x + step;
    const edge = step > 0 ? nx + body.w : nx;
    const tx = Math.floor((step > 0 ? edge - EPS : edge) / TILE);
    if (colSolid(world, tx, body.y, body.y + body.h)) {
      // auto step-up: 1 tile ledge, only on the ground and with room above
      const up = opts.stepUp ?? PHYS.stepUp;
      if (wasOnGround && up > 0) {
        const lift = body.y + body.h - Math.floor((body.y + body.h - EPS) / TILE) * TILE; // distance to the tile top
        const need = lift > EPS ? lift : TILE;
        if (need <= up + EPS && !boxSolid(world, nx, body.y - need, body.w, body.h)) {
          body.y -= need;
          body.x = nx;
          dx -= step;
          continue;
        }
      }
      body.x = step > 0 ? tx * TILE - body.w : (tx + 1) * TILE;
      body.hitWallX = Math.sign(step);
      body.vx = 0;
      break;
    }
    body.x = nx;
    dx -= step;
  }

  // ---- Y
  let dy = body.vy * dt;
  while (dy !== 0) {
    const step = Math.abs(dy) > TILE / 2 ? Math.sign(dy) * TILE / 2 : dy;
    const ny = body.y + step;
    if (step > 0) {
      const bottom = ny + body.h;
      const ty = Math.floor((bottom - EPS) / TILE);
      const prevBottom = body.y + body.h;
      const solid = rowSolid(world, body.x, body.x + body.w, ty);
      const plat = !opts.dropThrough && prevBottom <= ty * TILE + EPS && rowOneway(world, body.x, body.x + body.w, ty);
      if (solid || plat) {
        body.y = ty * TILE - body.h;
        body.vy = 0;
        body.onGround = true;
        break;
      }
    } else {
      const ty = Math.floor(ny / TILE);
      if (rowSolid(world, body.x, body.x + body.w, ty)) {
        body.y = (ty + 1) * TILE;
        body.vy = 0;
        body.hitCeiling = true;
        break;
      }
    }
    body.y = ny;
    dy -= step;
  }

  // resting exactly on the ground: still grounded
  if (!body.onGround && body.vy >= 0) {
    const ty = Math.floor((body.y + body.h + 0.5) / TILE);
    const onTop = Math.abs(ty * TILE - (body.y + body.h)) < 0.5;
    if (onTop && (rowSolid(world, body.x, body.x + body.w, ty) || (!opts.dropThrough && rowOneway(world, body.x, body.x + body.w, ty)))) {
      body.onGround = true;
    }
  }
}

/** Water state of a body: inWater (center submerged), submerged (head underwater), surface (y of the water line). */
export function waterState(world, body) {
  const cx = body.x + body.w / 2;
  const cy = body.y + body.h * 0.55;
  const inWater = WATER[world.get(Math.floor(cx / TILE), Math.floor(cy / TILE))] === 1;
  const submerged = WATER[world.get(Math.floor(cx / TILE), Math.floor((body.y + 1) / TILE))] === 1;
  return { inWater, submerged };
}

/** Is there a climbable wall right next to the body on side `dir` (±1)? Needs at least half the body height. */
export function wallBeside(world, body, dir) {
  const px = dir > 0 ? body.x + body.w + 1 : body.x - 1;
  const tx = Math.floor(px / TILE);
  const a = Math.floor(body.y / TILE), b = Math.floor((body.y + body.h - EPS) / TILE);
  let n = 0;
  for (let ty = a; ty <= b; ty++) if (SOLID[world.get(tx, ty)]) n++;
  return n > 0 && n * TILE >= Math.min(body.h * 0.5, TILE);
}

/** Does the body overlap a climbable non-solid tile (tree trunk)? */
export function onClimbable(world, body) {
  const tx = Math.floor((body.x + body.w / 2) / TILE);
  const a = Math.floor(body.y / TILE), b = Math.floor((body.y + body.h - EPS) / TILE);
  for (let ty = a; ty <= b; ty++) if (world.isClimbable(tx, ty)) return true;
  return false;
}

export function overlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function dist2(a, b) {
  const dx = a.x + a.w / 2 - (b.x + b.w / 2), dy = a.y + a.h / 2 - (b.y + b.h / 2);
  return dx * dx + dy * dy;
}
