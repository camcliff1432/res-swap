// Laser: a solid emitter that fires a 2 px beam in 8-bit; the beam kills on touch. No beam in low-res.
// `reaches: true` because the beam is drawn outside the emitter's own box (the renderer then does
// not skip it when the emitter is off screen).
import { NES } from '../sprites8.js';
import { PX8, PLAYER_W, PLAYER_H } from '../constants.js';
import { solidBoxes } from '../world.js';
import { hasZones, ensureModes, modeAt } from '../zones.js';
import { syncDyn } from '../dyn.js';
import { px, overlaps } from './common.js';
import { votedBand } from '../slider.js';

const DIRS = ['left', 'right', 'up', 'down'];
const THICK = 2 / PX8, OFFSET = 3 / PX8;   // beam: pixels 3 and 4 of the emitter's row or column
const BEAM_RED = '#FF2A2A', BEAM_HOT = '#FFB0B0';

// The beam, tile by tile: a list of segments {x, y, w, h} in tiles, nearest the emitter first. The beam is stopped by
// terrain according to each tile's own mode (the mask's pixels in an 8-bit tile, the low-res grid in a low-res one), by
// the pixels of crates living in 8-bit and by the boxes of everything else; it exists (is drawn, kills) only on 8-bit
// tiles, so it is absent inside a low-res zone and goes on beyond it. A world wholly in low-res has no beam at all.
// On the resolution slider the beam is its own picture voted at the step (slider.js votedBand): 2 pixels at step 8; at step 4
// its 2 pixels straddle two blocks, a tie in both, and a tie loses: no beam from step 4 down (step 4 switches lasers off).
export function beamSegments(world, laser) {
  if (modeAt(world, laser.x, laser.y) !== '8bit') return [];   // an emitter on a low-res tile fires nothing (a whole low-res world included)
  if (world.res && hasZones(world)) return steppedBeam(world, laser);
  const band = votedBand(world, OFFSET * PX8, THICK * PX8, laser.x, laser.y);   // [first pixel, pixels] across the beam: [3, 2] but on the slider
  if (!band) return [];
  const thick = band[1] / PX8;
  syncDyn(world);                      // the crates' pixels are what cut the beam: make sure they are where the crates are
  const dir = DIRS.includes(laser.dir) ? laser.dir : 'right';
  const horiz = dir === 'left' || dir === 'right';
  const fwd = dir === 'right' || dir === 'down';
  const cross0 = (horiz ? laser.y : laser.x) + band[0] / PX8;     // tiles, start of the band
  const crossPx = Math.round(cross0 * PX8);                       // pixel row/column of the band
  const lineEnd = horiz ? world.width : world.height;             // tiles
  const start = fwd ? (horiz ? laser.x : laser.y) + 1 : (horiz ? laser.x : laser.y);
  // `end` is where the beam stops, measured along its direction in tiles from the level origin.
  let end = fwd ? lineEnd : 0;
  if (fwd ? start >= end : start <= end) return [];

  // Terrain and crates: first solid pixel (by its tile's mode), or crate pixel (8-bit crates are in world.dyn), on any line of the band.
  const mw = world.maskW, mh = world.maskH, { low } = world;
  const zonedWorld = hasZones(world);
  if (zonedWorld) ensureModes(world);
  const solidAt = (mx, my) => {
    if (zonedWorld && world.tmode[(my >> 3) * world.width + (mx >> 3)] === 1) {
      return low.cells[Math.floor(my / low.scale) * low.cols + Math.floor(mx / low.scale)] === 1;
    }
    return world.mask[my * mw + mx] === 1;
  };
  const a = fwd ? Math.round(start * PX8) : Math.round(start * PX8) - 1;
  const last = fwd ? (horiz ? mw : mh) - 1 : 0;
  for (let i = a; fwd ? i <= last : i >= last; i += fwd ? 1 : -1) {
    let hit = false;
    for (let c = crossPx; c < crossPx + band[1] && !hit; c++) {
      const mx = horiz ? i : c, my = horiz ? c : i;
      if (mx < 0 || my < 0 || mx >= mw || my >= mh) continue;
      if (solidAt(mx, my) || (world.dyn && world.dyn[my * mw + mx] !== 0)) hit = true;
    }
    if (hit) { end = fwd ? i / PX8 : (i + 1) / PX8; break; }
  }

  // Boxes (balls, doors, other props, crates living in low-res); not its own emitter.
  for (const b of solidBoxes(world)) {
    if (b.ref === laser) continue;
    const bLo = horiz ? b.x : b.y, bHi = bLo + (horiz ? b.w : b.h);
    const cLo = horiz ? b.y : b.x, cHi = cLo + (horiz ? b.h : b.w);
    if (!(cLo < cross0 + thick && cHi > cross0)) continue;
    if (fwd) { if (bHi > start && bLo < end) end = Math.max(start, bLo); }
    else if (bLo < start && bHi > end) end = Math.min(start, bHi);
  }

  const len = fwd ? end - start : start - end;
  if (!(len > 0)) return [];
  const lo = fwd ? start : end, hi = fwd ? end : start;
  // Keep the stretches that lie on 8-bit tiles, merged where they touch.
  const across = Math.floor(cross0);
  const runs = [];
  for (let k = Math.floor(lo); k < hi; k++) {
    if (modeAt(world, horiz ? k : across, horiz ? across : k) !== '8bit') continue;
    const a0 = Math.max(lo, k), a1 = Math.min(hi, k + 1);
    if (runs.length && runs[runs.length - 1][1] === a0) runs[runs.length - 1][1] = a1;
    else runs.push([a0, a1]);
  }
  if (!fwd) runs.reverse();
  return runs.map(([r0, r1]) => (horiz ? { x: r0, y: cross0, w: r1 - r0, h: thick } : { x: cross0, y: r0, w: thick, h: r1 - r0 }));
}

// The beam in a stepped world with areas (stage 4): each tile has its own step, so each tile has its own band (votedBand: 2
// pixels at step 8, none at steps 4, 2 and 1). The emitter fires when its own tile has a band. Along the beam, the
// beam is stopped by the terrain of each tile in that tile's band rows (in a tile where it has no band, it is absent there, as
// in a low-res tile, and is stopped by what lies in the emitter's band rows, as a low-res tile stops it today); by crate
// pixels the same way; by a box that overlaps the band of the tile where the beam meets it. It is drawn and kills only where
// its tile has a band and is 8-bit: one segment per run of tiles with the same band.
function steppedBeam(world, laser) {
  const own = votedBand(world, OFFSET * PX8, THICK * PX8, laser.x, laser.y);
  if (!own) return [];
  syncDyn(world);
  const dir = DIRS.includes(laser.dir) ? laser.dir : 'right';
  const horiz = dir === 'left' || dir === 'right';
  const fwd = dir === 'right' || dir === 'down';
  const across = horiz ? laser.y : laser.x;                       // the tile row (or column) the beam runs along
  const lineEnd = horiz ? world.width : world.height;
  const start = fwd ? (horiz ? laser.x : laser.y) + 1 : (horiz ? laser.x : laser.y);
  let end = fwd ? lineEnd : 0;
  if (fwd ? start >= end : start <= end) return [];
  const tileOf = (k) => (horiz ? [k, across] : [across, k]);
  const bandAt = (k) => votedBand(world, OFFSET * PX8, THICK * PX8, ...tileOf(k));   // null: no beam in that tile
  const rowsAt = (k) => bandAt(k) || own;                        // the rows that stop it there
  const mw = world.maskW, mh = world.maskH, { low } = world;
  ensureModes(world);
  const solidAt = (mx, my) => (world.tmode[(my >> 3) * world.width + (mx >> 3)] === 1
    ? low.cells[Math.floor(my / low.scale) * low.cols + Math.floor(mx / low.scale)] === 1
    : world.mask[my * mw + mx] === 1);
  const a = fwd ? Math.round(start * PX8) : Math.round(start * PX8) - 1;
  const last = fwd ? (horiz ? mw : mh) - 1 : 0;
  for (let i = a; fwd ? i <= last : i >= last; i += fwd ? 1 : -1) {
    const [b0, bn] = rowsAt(i >> 3), c0 = across * PX8 + b0;
    let hit = false;
    for (let c = c0; c < c0 + bn && !hit; c++) {
      const mx = horiz ? i : c, my = horiz ? c : i;
      if (mx < 0 || my < 0 || mx >= mw || my >= mh) continue;
      if (solidAt(mx, my) || (world.dyn && world.dyn[my * mw + mx] !== 0)) hit = true;
    }
    if (hit) { end = fwd ? i / PX8 : (i + 1) / PX8; break; }
  }
  for (const b of solidBoxes(world)) {
    if (b.ref === laser) continue;
    const bLo = horiz ? b.x : b.y, bHi = bLo + (horiz ? b.w : b.h);
    const cLo = horiz ? b.y : b.x, cHi = cLo + (horiz ? b.h : b.w);
    const meet = fwd ? Math.max(start, bLo) : Math.min(start, bHi) - 1e-9;   // where the beam would reach its face
    const [r0, rn] = rowsAt(Math.floor(meet));
    if (!(cLo < across + (r0 + rn) / PX8 && cHi > across + r0 / PX8)) continue;
    if (fwd) { if (bHi > start && bLo < end) end = Math.max(start, bLo); }
    else if (bLo < start && bHi > end) end = Math.min(start, bHi);
  }
  const lo = fwd ? start : end, hi = fwd ? end : start;
  if (!(hi > lo)) return [];
  const segs = [];
  for (let k = Math.floor(lo); k < hi; k++) {
    const band = bandAt(k);
    if (!band || modeAt(world, ...tileOf(k)) !== '8bit') continue;
    const a0 = Math.max(lo, k), a1 = Math.min(hi, k + 1), last = segs[segs.length - 1];
    if (last && last.a1 === a0 && last.band[0] === band[0] && last.band[1] === band[1]) last.a1 = a1;
    else segs.push({ a0, a1, band });
  }
  if (!fwd) segs.reverse();
  return segs.map(({ a0, a1, band }) => {
    const c = across + band[0] / PX8, t = band[1] / PX8;
    return horiz ? { x: a0, y: c, w: a1 - a0, h: t } : { x: c, y: a0, w: t, h: a1 - a0 };
  });
}

// The first segment of the beam (the one at the emitter), or null: the one box the beam used to be.
export function beamOf(world, laser) {
  return beamSegments(world, laser)[0] || null;
}

export default {
  type: 'laser',
  label: 'Laser',
  defaults: { dir: 'right' },
  fields: [{ key: 'dir', label: 'Direction', kind: 'choice', options: DIRS }],
  size: () => [1, 1],
  check: (o) => (DIRS.includes(o.dir) ? null : `dir must be one of ${DIRS.join(', ')}`),
  solid: true,
  reaches: true,
  draw8(ctx, inst, world) {
    const x = px(inst.x), y = px(inst.y);
    ctx.fillStyle = NES.hullDark;
    ctx.fillRect(x, y, PX8, PX8);
    ctx.fillStyle = NES.hullGrey;
    ctx.fillRect(x + 1, y + 1, PX8 - 2, PX8 - 2);
    // Lens on the side the beam leaves from.
    ctx.fillStyle = BEAM_RED;
    const dir = DIRS.includes(inst.dir) ? inst.dir : 'right';
    if (dir === 'right') ctx.fillRect(x + 5, y + 3, 3, 2);
    else if (dir === 'left') ctx.fillRect(x, y + 3, 3, 2);
    else if (dir === 'up') ctx.fillRect(x + 3, y, 2, 3);
    else ctx.fillRect(x + 3, y + 5, 2, 3);
    if (!world) return;
    for (const b of beamSegments(world, inst)) {
      ctx.fillStyle = BEAM_RED;
      ctx.fillRect(px(b.x), px(b.y), Math.max(1, px(b.w)), Math.max(1, px(b.h)));
      ctx.fillStyle = BEAM_HOT;
      if (b.w > b.h) ctx.fillRect(px(b.x), px(b.y), Math.max(1, px(b.w)), 1);
      else ctx.fillRect(px(b.x), px(b.y), 1, Math.max(1, px(b.h)));
    }
  },
  drawLow(ctx, inst) {
    ctx.fillStyle = NES.hullGrey;
    ctx.fillRect(px(inst.x), px(inst.y), PX8, PX8);
  },
  kills(world, player) {
    const pb = { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H };
    for (const p of world.props) {
      if (p.type !== 'laser') continue;
      if (beamSegments(world, p).some((b) => overlaps(pb, b))) return true;
    }
    return false;
  },
};
