// The dynamic pixel layer: in 8-bit each crate is a square (2 x 2 tiles = 16 x 16 level pixels) that may be
// turned, rasterised into `world.dyn`, a layer the size of the mask. A pixel holds 0 or the number (`cid`) of
// the crate that owns it. world.js reads it as solid (except pixels owned by the body being moved); nothing here
// depends on props or objects. In low-res the layer is empty and crates are plain boxes on whole tiles.
//
// A crate's pose: `x, y` is the top-left of its flat 2 x 2 box in tiles (so the centre is x + 1, y + 1);
// `tilt` is the turn about the centre in radians, clockwise on screen (a `\` ramp is positive, a `/` ramp negative).
import { PX8, CRATE_SIZE } from './constants.js';
import { zoned, thingMode } from './zones.js';

const TIE = 1e-7;   // pixel centres exactly on an edge (a 45 degree turn has many) are decided the same way every time
export const CRATE_HALF = (CRATE_SIZE * PX8) / 2;   // half the side, in level pixels

// Calls fn(px, py, u, v) for every level pixel whose centre lies inside the square of half-side `half` (pixels)
// centred at (cx, cy) (pixels) turned by `tilt`; (u, v) is the pixel centre in the square's own frame.
// A pixel on the left/top edge counts, one on the right/bottom edge does not, so an upright square always has
// exactly 2 * half pixels each way. If fn returns true the walk stops and rasterSquare returns true.
export function rasterSquare(cx, cy, half, tilt, fn) {
  const c = Math.cos(tilt), s = Math.sin(tilt);
  const r = half * (Math.abs(c) + Math.abs(s));
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const u = dx * c + dy * s, v = -dx * s + dy * c;
      if (u >= -half - TIE && u < half - TIE && v >= -half - TIE && v < half - TIE && fn(x, y, u, v) === true) return true;
    }
  }
  return false;
}

// The same for an upright box of half-sides `hw` x `hh` (pixels) centred at (cx, cy): a small crate's (objects.js), which never turns.
// Exactly the pixels rasterSquare gives an upright square, so a box always has 2 * hw by 2 * hh pixels.
export function rasterRect(cx, cy, hw, hh, fn) {
  const x0 = Math.floor(cx - hw), x1 = Math.ceil(cx + hw);
  const y0 = Math.floor(cy - hh), y1 = Math.ceil(cy + hh);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const u = x + 0.5 - cx, v = y + 0.5 - cy;
      if (u >= -hw - TIE && u < hw - TIE && v >= -hh - TIE && v < hh - TIE && fn(x, y, u, v) === true) return true;
    }
  }
  return false;
}

// A crate's centre in level pixels and its turn.
export const cratePose = (c) => ({ cx: (c.x + CRATE_SIZE / 2) * PX8, cy: (c.y + CRATE_SIZE / 2) * PX8, tilt: c.tilt || 0 });

export function initDyn(world) {
  world.dyn = new Uint16Array(world.maskW * world.maskH);
  world.dynStamped = new Map();   // crate -> the pose it is stamped at (so it can be wiped exactly)
  world.dynNext = 1;              // next crate number
}

function paint(world, pose, value, only) {
  const { maskW: w, maskH: h, dyn } = world;
  rasterSquare(pose.cx, pose.cy, CRATE_HALF, pose.tilt, (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    const i = y * w + x;
    if (only === 0 || dyn[i] === only) dyn[i] = value;
    return false;
  });
}

export function unstampCrate(world, c) {
  const pose = world.dynStamped && world.dynStamped.get(c);
  if (!pose) return;
  paint(world, pose, 0, c.cid);
  world.dynStamped.delete(c);
}

// Rasterise the crate at its current pose (wiping where it was stamped before).
export function stampCrate(world, c) {
  if (!world.dyn) initDyn(world);
  if (!c.cid) c.cid = world.dynNext++;
  unstampCrate(world, c);
  const pose = cratePose(c);
  paint(world, pose, c.cid, 0);
  world.dynStamped.set(c, pose);
}

// Make the layer match the world: a crate that lives in 8-bit is stamped (per crate: with zones some crates sit in a
// low-res window and are boxes instead); one in low-res, or removed, is not.
export function syncDyn(world) {
  if (!world.dyn) initDyn(world);
  const is8 = (c) => thingMode(world, c) === '8bit';
  for (const c of [...world.dynStamped.keys()]) if (!is8(c) || !world.crates.includes(c)) unstampCrate(world, c);
  for (const c of world.crates) {
    if (!is8(c)) continue;
    const p = world.dynStamped.get(c), q = cratePose(c);
    if (!p || p.cx !== q.cx || p.cy !== q.cy || p.tilt !== q.tilt) stampCrate(world, c);
  }
}

// The number of the crate owning a dyn pixel (0 for none).
export const dynAt = (world, x, y) => (world.dyn && x >= 0 && y >= 0 && x < world.maskW && y < world.maskH ? world.dyn[y * world.maskW + x] : 0);

// Number of the first crate other than `ignore` with a pixel inside the box (tiles); 0 for none.
export function dynOwnerInBox(world, x, y, w, h, ignore = 0) {
  const dyn = world.dyn;
  if (!dyn || (world.mode !== '8bit' && !zoned(world))) return 0;
  const x0 = Math.max(0, Math.floor(x * PX8)), x1 = Math.min(world.maskW - 1, Math.ceil((x + w) * PX8) - 1);
  const y0 = Math.max(0, Math.floor(y * PX8)), y1 = Math.min(world.maskH - 1, Math.ceil((y + h) * PX8) - 1);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const v = dyn[py * world.maskW + px];
      if (v !== 0 && v !== ignore) return v;
    }
  }
  return 0;
}
