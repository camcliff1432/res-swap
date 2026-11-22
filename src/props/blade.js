// Swinging blade. The instance's x, y in the level file is the PIVOT tile; place() keeps it in px, py.
// `x, y, w, h, solid` are the blade's box in the CURRENT mode and `alt` its box in the other mode (see world.js):
//   8-bit: a one-tile box centred on the end of the arm at its exact position; not solid, only kills.
//   low-res: a solid one-tile block at the position rounded to whole tiles. The swing stops while the blade
//   is in low-res (its clock is held), so the block stays put; back in 8-bit it swings on from the same angle.
//   It never sits inside low-res terrain (it keeps its last valid tile). If it ever has to move while in
//   low-res, it waits in its old tile when the new one holds the player, a crate, a ball or another solid thing.
//   At the resolution slider's step 2 it lives in low-res on the half-tile grid (zones.js gridCell): stopped, a solid
//   harmless block at the position rounded to half tiles, against the step's own terrain.
// `reaches: true`: the arm and blade are drawn outside the pivot tile.
import { NES } from '../sprites8.js';
import { PX8, PLAYER_W, PLAYER_H, BLADE_SWING, BLADE_PERIOD } from '../constants.js';
import { terrainHitsBox, boxHitsSolid, changeToWanted, stepBoxes } from '../world.js';
import { thingMode, zoned, gridCell, gridTerrainMode, thingStep, maskOfStep } from '../zones.js';
import { px, overlaps } from './common.js';

const LEN_MIN = 2, LEN_MAX = 8, LEN_DEFAULT = 4;
const SHRINK = 1 / PX8;                       // the kill test shrinks the blade box by a pixel each side
const RED = '#FF2A2A', ARM = '#BCBCBC', LOW_COLOUR = '#A96060';   // LOW_COLOUR: what its picture averages to (grey arm, red blade); it was a bluish grey (#9C9CB4)
const validLen = (n) => Number.isInteger(n) && n >= LEN_MIN && n <= LEN_MAX;

// Angle from straight down, radians: far left at t = 0, straight down at a quarter period, far right at half.
export const bladeAngle = (t) => -BLADE_SWING * (Math.PI / 180) * Math.cos((2 * Math.PI * t) / BLADE_PERIOD);

// The 8-bit blade box {x, y, w, h} (tiles) at time t, for a pivot tile (pxTile, pyTile) and arm length.
export function bladeBox(pxTile, pyTile, length, t) {
  const a = bladeAngle(t);
  const cx = pxTile + 0.5 + length * Math.sin(a), cy = pyTile + 0.5 + length * Math.cos(a);
  return { x: cx - 0.5, y: cy - 0.5, w: 1, h: 1 };
}

const pivotOf = (inst) => [inst.px ?? inst.x, inst.py ?? inst.y];
const lengthOf = (inst) => (validLen(inst.length) ? inst.length : LEN_DEFAULT);
const roundTile = (b, cell = 1) => ({ x: Math.round(b.x / cell) * cell, y: Math.round(b.y / cell) * cell });
// Would the tile be solid if it were low-res? (The low-res grid says, whatever mode the tile is in now; at the slider's step 2,
// the step's own terrain.)
function lowTerrain(world, tile, p) {
  if (world.res && zoned(world)) return gridTerrain(world, tile, gridStepOf(world, p));
  if (!zoned(world)) return terrainHitsBox(world, tile.x, tile.y, 1, 1, gridTerrainMode(world));
  if (tile.x < 0 || tile.x + 1 > world.width || tile.y < 0) return true;
  if (tile.y >= world.low.rows) return false;
  return world.low.cells[tile.y * world.low.cols + tile.x] === 1;
}

// Stage 4, a stepped world with areas: the grid a blade keeps its place on is its own when it lives on one (step 2 or 1), else
// the whole-tile grid of low-res; the place is solid when that step's terrain is (the room's picture voted at the step, or the
// low-res grid), wherever the tile is.
const gridStepOf = (world, p) => (thingStep(world, p) === 2 ? 2 : 1);
function gridTerrain(world, tile, step) {
  if (tile.x < 0 || tile.x + 1 > world.width || tile.y < 0) return true;
  if (step === 1) return tile.y < world.low.rows && world.low.cells[tile.y * world.low.cols + tile.x] === 1;
  const m = maskOfStep(world, step), W = world.maskW;
  for (let y = Math.round(tile.y * PX8); y < Math.min(world.maskH, Math.round((tile.y + 1) * PX8)); y++) {
    for (let x = Math.round(tile.x * PX8); x < Math.round((tile.x + 1) * PX8); x++) if (m[y * W + x] === 1) return true;
  }
  return false;
}

// First low-res tile (a place on the grid of `cell` tiles) along the swing (from the blade's clock on, over one period) for
// which `solid` (default: the low-res terrain) says no.
function firstValidTile(world, p, cell = 1, solid = (tile) => lowTerrain(world, tile, p)) {
  const [qx, qy] = pivotOf(p);
  for (let t = p.t; t <= p.t + BLADE_PERIOD; t += 1 / 60) {
    const tile = roundTile(bladeBox(qx, qy, lengthOf(p), t), cell);
    if (!solid(tile)) return tile;
  }
  return null;
}

// The blade's box at a step of the resolution slider (slider.js), with `solid(tile)` saying whether a one-tile box there is
// terrain at that step: the swinging 8-bit blade (not solid) at steps 8 and 4; at steps 2 and 1 the stopped block, on the grid
// of the step, where its clock puts it or else the first place along the swing that is not terrain (lowTile, the place it keeps).
// (Stage 4: a stepped world changes a blade's step across a seam with this box, world.js.)
stepBoxes.blade = (p, step, solid) => bladeAtStep(p, step, solid);
export function bladeAtStep(p, step, solid) {
  const [qx, qy] = pivotOf(p);
  const blade = bladeBox(qx, qy, lengthOf(p), p.t);
  if (step > 2) return { box: { ...blade, solid: false }, lowTile: p.lowTile };
  const cell = step === 2 ? 0.5 : 1;
  const want = roundTile(blade, cell);
  const tile = solid(want) ? firstValidTile(null, p, cell, solid) : want;
  return { box: tile ? { ...tile, w: 1, h: 1, solid: true } : { ...want, w: 1, h: 1, solid: false }, lowTile: tile };
}

// Brings the current and other-mode boxes up to date for the clock p.t.
function refresh(world, player, p) {
  const [qx, qy] = pivotOf(p);
  const blade = bladeBox(qx, qy, lengthOf(p), p.t);
  const cell = world.res ? (gridStepOf(world, p) === 2 ? 0.5 : 1) : gridCell(world);
  const want = roundTile(blade, cell);
  if (!p.started) { p.started = true; p.lowTile = firstValidTile(world, p, cell); }
  const cur = p.lowTile;
  if (cur && (want.x !== cur.x || want.y !== cur.y) && !lowTerrain(world, want, p)) {
    let free = true;
    if (thingMode(world, p) === 'low') {
      free = !boxHitsSolid(world, want.x, want.y, 1, 1, gridTerrainMode(world), p)
        && !overlaps({ x: want.x, y: want.y, w: 1, h: 1 }, { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H });
    }
    if (free) p.lowTile = want;
  }
  const bladeBox8 = { ...blade, solid: false };
  const lowBox = p.lowTile ? { x: p.lowTile.x, y: p.lowTile.y, w: 1, h: 1, solid: true } : { x: want.x, y: want.y, w: 1, h: 1, solid: false };
  const [now, other] = thingMode(world, p) === 'low' ? [lowBox, bladeBox8] : [bladeBox8, lowBox];
  Object.assign(p, now);
  p.alt = other;
}

// A one-pixel line from (x0, y0) to (x1, y1) in level pixels.
function line(ctx, x0, y0, x1, y1) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= n; i++) ctx.fillRect(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), 1, 1);
}

export default {
  type: 'blade',
  label: 'Swinging blade',
  defaults: { length: LEN_DEFAULT },
  fields: [{ key: 'length', label: 'Length', kind: 'int', min: LEN_MIN, max: LEN_MAX }],
  size: () => [1, 1],
  check: (o) => (validLen(o.length) ? null : `length must be a whole number from ${LEN_MIN} to ${LEN_MAX}`),
  solid: false,
  reaches: true,
  // Called by the level parser on each new instance: keep the pivot, start as the 8-bit blade at t = 0.
  place(inst) {
    inst.px = inst.x; inst.py = inst.y;
    inst.t = 0;
    inst.started = false;
    inst.lowTile = null;
    const b = bladeBox(inst.px, inst.py, lengthOf(inst), 0);
    const tile = roundTile(b);
    Object.assign(inst, { ...b, solid: false });
    inst.alt = { x: tile.x, y: tile.y, w: 1, h: 1, solid: true };
  },
  draw8(ctx, inst, world) {
    const [qx, qy] = pivotOf(inst);
    const sx = px(qx) + 4, sy = px(qy) + 4;           // pivot centre, level pixels
    ctx.fillStyle = NES.hullDark;
    ctx.fillRect(sx - 1, sy - 1, 3, 3);
    ctx.fillStyle = ARM;
    ctx.fillRect(sx, sy, 1, 1);
    if (!world) {                                      // palette icon: stud and a hint of the blade
      ctx.fillStyle = RED;
      ctx.fillRect(px(qx) + 2, px(qy) + 5, 4, 3);
      return;
    }
    const b = bladeBox(qx, qy, lengthOf(inst), inst.t ?? 0);
    const bx = px(b.x), by = px(b.y);
    ctx.fillStyle = ARM;
    line(ctx, sx, sy, bx + 4, by + 4);
    ctx.fillStyle = RED;
    ctx.fillRect(bx, by, PX8, PX8);
    ctx.fillStyle = NES.hullGrey;
    ctx.fillRect(bx + 1, by + 1, PX8 - 2, PX8 - 2);
    ctx.fillStyle = NES.hullDark;
    ctx.fillRect(bx + 3, by + 3, 2, 2);
  },
  drawLow(ctx, inst) {
    if (inst.started && inst.lowTile === null) return;                // never had a valid tile: not drawn
    ctx.fillStyle = LOW_COLOUR;
    ctx.fillRect(px(inst.x), px(inst.y), PX8, PX8);
  },
  step(world, player, held, dt) {
    for (const p of world.props) {
      if (p.type !== 'blade') continue;
      // In low-res the swing stops: the block stays where the blade was, and it carries on from there in 8-bit.
      if (thingMode(world, p) !== 'low') p.t += dt;
      refresh(world, player, p);
      // Its centre may have moved into a tile of the other mode (a zone's edge): change over if the place is free.
      if (changeToWanted(world, player, p)) refresh(world, player, p);
    }
  },
  kills(world, player) {
    const pb = { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H };
    for (const p of world.props) {
      if (p.type !== 'blade' || thingMode(world, p) !== '8bit') continue;       // it kills while it lives in 8-bit
      const b = { x: p.x + SHRINK, y: p.y + SHRINK, w: p.w - 2 * SHRINK, h: p.h - 2 * SHRINK };
      if (overlaps(pb, b)) return true;
    }
    return false;
  },
};
