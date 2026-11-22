import { PX8, STEP_UP } from './constants.js';
import { boxHitsSolid } from './world.js';

const PX = 1 / PX8;

function overlapsBox(x, y, w, h, b) {
  return x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y;
}

// Move one body (x, y, vx, vy, onGround) through the world for dt seconds.
// Returns { blockedX }: -1 or 1 when horizontal motion was stopped, else 0.
export function moveBody(world, body, w, h, dt, opts = {}) {
  const { ignore = null, blockers = [], noStep = false } = opts;   // noStep: no step-up and no following a ramp down (a rigid box)
  const wasOnGround = opts.wasOnGround ?? body.onGround;
  const solid = (x, y) => boxHitsSolid(world, x, y, w, h, world.mode, ignore)
    || blockers.some((b) => overlapsBox(x, y, w, h, b));
  let blockedX = 0;

  // 1. X, with step-up of 1 then 2 pixels when walking
  if (body.vx !== 0) {
    const nx = body.x + body.vx * dt;
    let placed = false;
    if (!solid(nx, body.y)) {
      body.x = nx; placed = true;
    } else if (wasOnGround && !noStep) {
      for (let k = 1; k <= STEP_UP * PX8; k++) {
        const ry = body.y - k * PX;
        if (!solid(nx, ry)) { body.x = nx; body.y = ry; placed = true; break; }
      }
    }
    if (!placed) {
      const dir = body.vx > 0 ? 1 : -1;
      const sx = dir > 0 ? Math.floor((nx + w) * PX8) / PX8 - w : Math.ceil(nx * PX8) / PX8;
      if (!solid(sx, body.y)) body.x = sx;
      body.vx = 0;
      blockedX = dir;
    }
  }

  // 2. Y, snapped to the pixel grid
  const ny = body.y + body.vy * dt;
  body.onGround = false;
  if (!solid(body.x, ny)) {
    body.y = ny;
  } else {
    let sy;
    if (body.vy > 0) {
      sy = Math.floor((ny + h) * PX8) / PX8 - h;
      for (let i = 0; i < 3 && solid(body.x, sy); i++) sy -= PX;
      if (!solid(body.x, sy)) { body.y = sy; body.onGround = true; }
    } else {
      sy = Math.ceil(ny * PX8) / PX8;
      for (let i = 0; i < 3 && solid(body.x, sy); i++) sy += PX;
      if (!solid(body.x, sy)) body.y = sy;
    }
    body.vy = 0;
  }

  // 3. Stay on the ground over a drop of up to 2 pixels (ramps down)
  if (wasOnGround && !noStep && body.vy >= 0 && !body.onGround) {
    const base = Math.floor((body.y + h) * PX8) / PX8 - h;
    if (!solid(body.x, base)) {
      for (let k = 1; k <= STEP_UP * PX8 + 1; k++) {
        if (solid(body.x, base + k * PX)) {
          body.y = base + (k - 1) * PX;
          body.onGround = true;
          body.vy = 0;
          break;
        }
      }
    }
  }

  body.x += 0; body.y += 0; // never -0
  return { blockedX };
}
