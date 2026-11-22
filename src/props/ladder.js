// Ladder and rope: one rule (see ladderFor and stepPlayer), two pictures. 8-bit only; on the resolution slider each tile of
// one is there while its own picture, voted at the step, keeps its detail (slider.js): a ladder through step 4, a rope
// only at step 8.
import { NES } from '../sprites8.js';
import { PLAYER_W, PLAYER_H } from '../constants.js';
import { EPS, px, lengthField, checkLength, columnSize, stackRuns, hasPieceBelow } from './common.js';
import { hasZones, modeAt } from '../zones.js';
import { middleStep, keepsDetail, drawnClass } from '../slider.js';

const isClimb = (p) => p.type === 'ladder' || p.type === 'rope';

const RAIL = NES.crateLight, RUNG = NES.crateMid;
// Voted in blocks of 2 pixels the rails are two clean 2-pixel posts (each 2 x 2 block of a rail holds 3 pixels) and the rungs
// are gone (2 of 4: a tie); in blocks of 4 every block holds exactly 8 of 16, a tie, so the whole ladder is gone. So a
// ladder works at steps 8 and 4 and a rope only at step 8.
function drawLadder(ctx, inst) {
  const x = px(inst.x), y = px(inst.y), h = px(inst.h);
  ctx.fillStyle = RAIL;
  ctx.fillRect(x, y, 1, h);
  ctx.fillRect(x + 7, y, 1, h);
  for (let r = 0; r < h; r += 2) { ctx.fillRect(x + 1, y + r, 1, 1); ctx.fillRect(x + 6, y + r, 1, 1); }   // the rails' inner studs
  ctx.fillStyle = RUNG;
  for (let r = 2; r < h; r += 4) ctx.fillRect(x + 2, y + r, 4, 1);
}

// The rope is a twisted cord one pixel thick: one pixel a row, swapping between two columns (light on the left, shadow
// on the right), so that no block of 2 x 2 pixels holds more than one of its pixels. That is what makes it go one notch
// before the ladder on the resolution slider: voted at step 4 it is gone, where the ladder's rails stay (3 pixels of
// every 2 x 2 block; slider.js). The lowest piece of a rope ends in a frayed tip, drawn the same way (the old 4 x 3 knot would have
// survived the vote as a blob). The rhythm is counted from the level's pixel rows, so it runs on across pieces.
const ROPE_FRAY = ['..#..#..', '.#....#.'];
function drawRope(ctx, inst, world) {
  const x = px(inst.x), y = px(inst.y), h = px(inst.h);
  const fray = !world || !hasPieceBelow(world.props.filter(isClimb), inst);
  const end = fray ? h - ROPE_FRAY.length : h;
  for (let r = 0; r < end; r++) {
    const left = (y + r) % 2 === 0;
    ctx.fillStyle = left ? NES.hullLight : NES.hullGrey;
    ctx.fillRect(x + (left ? 3 : 4), y + r, 1, 1);
  }
  if (!fray) return;
  ROPE_FRAY.forEach((row, i) => [...row].forEach((c, cx) => {
    if (c === '.') return;
    ctx.fillStyle = cx < 4 ? NES.hullLight : NES.hullGrey;
    ctx.fillRect(x + cx, y + end + i, 1, 1);
  }));
}

export default {
  type: 'ladder',
  label: 'Ladder',
  defaults: { length: 1 },
  fields: [lengthField],
  size: (o) => columnSize(o, 3),
  check: checkLength,
  solid: false,
  followsPicture: true,
  draw8: drawLadder,
};

export const rope = {
  type: 'rope',
  label: 'Rope',
  defaults: { length: 1 },
  fields: [lengthField],
  size: (o) => columnSize(o, 3),
  check: checkLength,
  solid: false,
  followsPicture: true,
  draw8: drawRope,
};

// Ladder and rope pieces in one column that touch or overlap act as one ladder: the merged runs.
export function ladderRuns(world) {
  return stackRuns(world.props.filter(isClimb));
}

// The climbable pieces: all of them in an 8-bit world; with zones, one-tile pieces, only where the tile is 8-bit; at the
// slider's steps 4 and 2, one-tile pieces, only where the piece's own picture keeps its detail at that step.
function climbPieces(world) {
  const all = world.props.filter(isClimb);
  const zonedWorld = hasZones(world);
  if (!zonedWorld) {
    if (world.mode !== '8bit') return [];
    if (!middleStep(world)) return all;      // (no zones: the room's own step)
  }
  const pieces = [];
  for (const p of all) {
    const draw = p.type === 'rope' ? drawRope : drawLadder;
    for (let ty = Math.floor(p.y); ty < Math.ceil(p.y + p.h - EPS); ty++) {
      const here = (!zonedWorld || modeAt(world, Math.floor(p.x), ty) === '8bit') && keepsDetail(drawnClass(world, p, draw, Math.floor(p.x), ty));
      if (here) pieces.push({ ...p, y: ty, h: 1 });
    }
  }
  return pieces;
}

// The ladder or rope the player may hold, as the whole merged run (x, y = top, w 1, h = height):
// 8-bit only, the player's centre within its tile, and the player's box overlapping it or the feet
// exactly level with its top. When two runs qualify (a gap between them) the lower one wins, so the
// player stops at the top of the lower run instead of climbing across the gap.
export function ladderFor(world, player) {
  const pieces = climbPieces(world);
  if (pieces.length === 0) return null;
  const cx = player.x + PLAYER_W / 2;
  const feet = player.y + PLAYER_H;
  const runs = stackRuns(pieces.filter((p) => cx >= p.x && cx < p.x + p.w));
  for (let i = runs.length - 1; i >= 0; i--) {
    const r = runs[i];
    const overlapping = player.y < r.y + r.h && feet > r.y;
    if (overlapping || Math.abs(feet - r.y) <= EPS) return r;
  }
  return null;
}
