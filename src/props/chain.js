// Chain: stub until the chain task. Data, size, check and a placeholder picture.
import { NES } from '../sprites8.js';
import { CRATE_SIZE, BALL_SIZE } from '../constants.js';
import { modeAt, thingMode } from '../zones.js';
import { px, EPS, lengthField, checkLength, columnSize, stackRuns } from './common.js';
import { middleStep, keepsDetail, drawnClass } from '../slider.js';

// True when a chain's end holds this crate or ball: its top is exactly at the chain's bottom, and a crate overlaps
// the chain's column or a ball sits in it (within one pixel). A chain holds only while its bottom piece's tile is
// 8-bit, and only a thing that lives in 8-bit. On the resolution slider it holds only while the picture of that bottom
// tile, voted at the step, keeps its detail (slider.js): through step 4; at step 2 the chain is gone and the thing drops.
export function heldByChain(world, obj, size) {
  if (thingMode(world, obj) !== '8bit') return false;
  // Chain pieces in one column that touch act as one chain; only its lowest end holds anything.
  const chains = world.props.filter((p) => p.type === 'chain');
  for (const c of stackRuns(chains)) {
    if (Math.abs(c.y + c.h - obj.y) > EPS) continue;
    const tx = Math.floor(c.x), ty = Math.ceil(c.y + c.h - EPS) - 1;
    if (modeAt(world, tx, ty) !== '8bit') continue;
    if (middleStep(world, tx, ty) && !chainWorksAt(world, chains, tx, ty)) continue;
    if (size === CRATE_SIZE ? (obj.x < c.x + 1 && obj.x + size > c.x) : Math.abs(obj.x - c.x) <= 1 / 8 + EPS) return true;
  }
  return false;
}

// Does the chain piece covering tile (tx, ty) keep its detail at the slider's current step?
function chainWorksAt(world, chains, tx, ty) {
  const p = chains.find((q) => Math.floor(q.x) === tx && q.y <= ty + EPS && q.y + q.h > ty + EPS);
  return Boolean(p) && keepsDetail(drawnClass(world, p, drawChain, tx, ty));
}

function drawChain(ctx, inst) {
  const x = px(inst.x), y = px(inst.y), h = px(inst.h);
  for (let i = 0; i < h; i += 2) {
    const wide = (i / 2) % 2 === 0;
    ctx.fillStyle = wide ? NES.hullLight : NES.hullGrey;
    ctx.fillRect(x + (wide ? 2 : 3), y + i, wide ? 4 : 2, Math.min(2, h - i));
  }
}

export default {
  type: 'chain',
  label: 'Chain',
  defaults: { length: 1 },
  fields: [lengthField],
  size: (o) => columnSize(o, 2),
  check: checkLength,
  solid: false,
  followsPicture: true,
  draw8: drawChain,
};
