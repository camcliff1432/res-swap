// The look of the resolution slider (the picture only; the rules are slider.js). Pure: no canvas, no world edits.
//
// Two jobs. First, the block grid: at step 4 the picture is drawn in blocks of 2 x 2 level pixels, at step 2 in blocks of
// 4 x 4, at step 1 in blocks of 8 x 8, and the blocks are locked to the LEVEL's grid, not the screen's (the camera scrolls in
// whole pixels, so the blocks must slide with the world). Second, the transition: when the step changes the picture eases
// for a moment instead of cutting. Going down (8 -> 4 -> 2 -> 1) it goes in two phases:
//   blur   the picture crossfades to the coarser one, and each terrain block shows how full it is, a shade between empty
//          and solid in proportion to its fill (the honest downsample of the finer picture);
//   firm   the blocks that are half full or more firm up to solid and the others fade out to the background.
// Going up plays the same thing backwards. The rules change at once; only the picture eases. At rest the picture is crisp.
//
//   const look = createLook();
//   look.update(world, dt)    each drawn frame (dt in seconds): follows world.slider.step, starts / advances transitions
//   look.view(world)          what to draw now: { step } at rest, { fine, coarse, p, blur, firm } during a move, null (no slider)
import { STEPS } from './slider.js';
import { wins } from './vote.js';

export const TOTAL = 0.34;          // seconds for one notch
export const BLUR_SHARE = 0.5;      // the share of a notch spent blurring; the rest is firming up
export const MAX_DT = 0.05;         // a frame later than this (a hidden tab) counts as this much
export const CATCH_UP = 2;          // each notch waiting behind the one playing speeds it up by this much

// Where the blocks of `size` pixels fall for a view whose top-left is at level pixel `o` on one axis: the level pixel of the
// first block edge at or before the view, and how many pixels of that block are cut off the left (or top) of the screen.
export function gridOrigin(o, size) {
  const origin = Math.floor(o / size) * size;
  return { origin, offset: o - origin };
}

// How many pixels of each block of `size` are set in a mask: { cols, rows, counts } (counts: a Uint8Array cols x rows, up to size * size).
export function blockCounts(mask, maskW, maskH, size) {
  const cols = Math.floor(maskW / size), rows = Math.floor(maskH / size);
  const out = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let n = 0;
      for (let y = 0; y < size; y++) {
        const base = (cy * size + y) * maskW + cx * size;
        for (let x = 0; x < size; x++) n += mask[base + x];
      }
      out[cy * cols + cx] = n;
    }
  }
  return { cols, rows, counts: out };
}

// A block is solid when more than half of it is filled (a tie loses): the same vote as slider.js (vote.js).
export const blockSolid = (count, size) => wins(count, size * size);
// How strongly a block shows in the blur phase: its fill, linearly (a quarter full is a quarter of the way to solid).
export const fillAlpha = (count, size) => count / (size * size);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v) => v * v * (3 - 2 * v);

// The two phases at progress p (0 = the finer picture at rest, 1 = the coarser one at rest).
export function phases(p) {
  return { blur: smooth(clamp01(p / BLUR_SHARE)), firm: smooth(clamp01((p - BLUR_SHARE) / (1 - BLUR_SHARE))) };
}

const idx = (step) => STEPS.indexOf(step);

export function createLook() {
  let world = null, target = null, cur = null, queue = [];
  // cur: { from, to, t } a notch in progress, t 0..1 along it; queue: the steps still to come after it (each one notch on)

  function snap(w) {
    world = w;
    target = w && w.slider ? w.slider.step : null;
    cur = null;
    queue = [];
  }

  function push(next) {
    if (cur && queue.length === 0 && cur.from === next && cur.to === target) {   // straight back: reverse where it is
      cur = { from: cur.to, to: cur.from, t: 1 - cur.t };
    } else if (!cur) cur = { from: target, to: next, t: 0 };
    else queue.push(next);
    target = next;
  }

  function update(w, dt = 0) {
    if (w !== world) snap(w);                                  // a new room, a restart: no transition
    if (!w || !w.slider) return;
    const step = w.slider.step;
    if (step !== target) {                                     // the rules moved: walk the picture there one notch at a time
      let i = idx(target);
      const to = idx(step), dir = to > i ? 1 : -1;
      while (i !== to) { i += dir; push(STEPS[i]); }
    }
    let left = Math.min(Math.max(dt, 0), MAX_DT);
    while (cur && left > 0) {
      const rate = (1 + CATCH_UP * queue.length) / TOTAL;
      const need = (1 - cur.t) / rate;
      if (left < need) { cur.t += left * rate; left = 0; }
      else {
        left -= need;
        cur = queue.length ? { from: cur.to, to: queue.shift(), t: 0 } : null;
      }
    }
  }

  function view(w = world) {
    if (!w || !w.slider) return null;
    if (w !== world) return { step: w.slider.step };           // not followed yet (update was not called for this world)
    if (!cur) return { step: target };
    const down = cur.to < cur.from;                            // down: 8 -> 4 ... the picture gets coarser
    const fine = Math.max(cur.from, cur.to), coarse = Math.min(cur.from, cur.to);
    const p = down ? cur.t : 1 - cur.t;
    return { fine, coarse, p, ...phases(p) };
  }

  return { update, view, get busy() { return cur !== null; }, get pending() { return queue.length; } };
}

// The view of a slider world with no look kept (nobody passed one): at rest on its step.
export const restView = (world) => ({ step: world.slider.step });
