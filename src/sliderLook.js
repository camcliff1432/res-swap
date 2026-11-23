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
import { hasZones, ensureModes, eachMover, modeOfBox } from './zones.js';
import { PLAYER_W, PLAYER_H } from './constants.js';

export const TOTAL = 0.34;          // seconds for one notch
export const BLUR_SHARE = 0.5;      // the share of a notch spent blurring; the rest is firming up
export const MAX_DT = 0.05;         // a frame later than this (a hidden tab) counts as this much
export const SWAP_TOTAL = 0.42;     // seconds for the picture of a swap (8-bit <-> low-res, a level without the slider) to ease
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
  // A level with zones (windows, the wave, grenade areas): how far each tile's picture is, 0 = 8-bit to 1 = low-res, and how many are on their way.
  let tiles = null, moving = 0;
  // Single figures: the things a "things" grenade made low-res for good, and the player it caught: { m, p },
  // m the look it is going to (0 = 8-bit, 1 = low-res), p how far its picture is.
  let things = new WeakMap(), pl = null;
  // The movable things as they were on the last frame before a swap ({ crates, balls, props }, copies): the swap moves some at once (a crate
  // snaps to the grid, a platform goes to its low-res place), and the picture it eases FROM must show them where they were.
  let last = null;
  let mode = null, swap = null;       // a level without the slider: the mode the picture follows, and { p } while a swap eases (0 = 8-bit, 1 = low-res)
  // cur: { from, to, t } a notch in progress, t 0..1 along it; queue: the steps still to come after it (each one notch on)

  function snap(w) {
    world = w;
    target = w && w.slider ? w.slider.step : null;
    cur = null;
    queue = [];
    mode = w && !w.slider ? w.mode : null;
    swap = null;
    tiles = null; moving = 0;
    things = new WeakMap(); pl = null;
    last = null;
  }

  const copyThings = (w) => ({ crates: w.crates.map((c) => ({ ...c })), balls: w.balls.map((b) => ({ ...b })), props: w.props.map((p) => (p.alt ? { ...p, alt: { ...p.alt } } : { ...p })) });

  // The single figures follow their looks (a level without the slider or stepped areas).
  function follow(w, dt, player) {
    if (!Array.isArray(w.crates)) return;                     // (not a whole world: nothing to follow)
    const d = Math.min(Math.max(dt, 0), MAX_DT) / SWAP_TOTAL;
    const move = (rec, m) => {
      rec.m = m;
      if (rec.p !== m) rec.p = m > rec.p ? Math.min(1, rec.p + d) : Math.max(0, rec.p - d);
      return rec;
    };
    const base = w.mode === 'low' ? 1 : 0;
    eachMover(w, (t) => {
      if (t.forceLow) things.set(t, move(things.get(t) ?? { m: 1, p: base }, 1));
    });
    // The player an orange grenade caught looks low-res for good (world.js pixelateThings): his figure eases there from the look he had.
    // (Crossing a zone's edge is not eased in time: edgeBands.js changes the part of him that is going in.)
    if (!player || !player.pixelated) { pl = null; return; }
    pl ??= { m: 1, p: (hasZones(w) ? modeOfBox(w, player.x, player.y, PLAYER_W, PLAYER_H) : w.mode) === 'low' ? 1 : 0 };
    move(pl, 1);
  }

  function push(next) {
    if (cur && queue.length === 0 && cur.from === next && cur.to === target) {   // straight back: reverse where it is
      cur = { from: cur.to, to: cur.from, t: 1 - cur.t };
    } else if (!cur) cur = { from: target, to: next, t: 0 };
    else queue.push(next);
    target = next;
  }

  function update(w, dt = 0, player = null) {
    if (w !== world) snap(w);                                  // a new room, a restart: no transition
    if (!w) return;
    if (!w.slider && !w.res && (hasZones(w) || tiles)) {       // zones: every tile's picture eases to its own mode (the wave's columns, a burst)
      const zoned = hasZones(w);
      if (zoned) ensureModes(w);
      const n = w.width * w.height, base = w.mode === 'low' ? 1 : 0;
      if (!tiles || tiles.length !== n) { tiles = new Float32Array(n); for (let i = 0; i < n; i++) tiles[i] = zoned ? w.tmode[i] : base; }
      const d = Math.min(Math.max(dt, 0), MAX_DT) / SWAP_TOTAL;
      moving = 0;
      for (let i = 0; i < n; i++) {
        const to = zoned ? w.tmode[i] : base, v = tiles[i];
        if (v === to) continue;
        tiles[i] = to > v ? Math.min(1, v + d) : Math.max(0, v - d);
        if (tiles[i] !== to) moving++;
      }
      if (!zoned && moving === 0) tiles = null;                // the last zone is gone and its tiles are back: the plain room again
      mode = w.mode; swap = null;
      follow(w, dt, player);
      return;
    }
    if (!w.slider) {                                           // the swap: the picture eases to the new mode (straight back: from where it is)
      if (w.mode !== mode) { mode = w.mode; swap ??= { p: mode === 'low' ? 0 : 1, from: mode === 'low' ? '8bit' : 'low', snap: last }; }
      if (swap) {
        const d = Math.min(Math.max(dt, 0), MAX_DT) / SWAP_TOTAL;
        swap.p += mode === 'low' ? d : -d;
        if (mode === 'low' ? swap.p >= 1 : swap.p <= 0) swap = null;
      }
      if (!w.res) follow(w, dt, player);
      if (!swap && Array.isArray(w.crates) && Array.isArray(w.balls) && Array.isArray(w.props)) last = copyThings(w);
      return;
    }
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

  // A level without the slider, while its picture eases after a swap: { p } (0 = the 8-bit picture, 1 = the low-res one); else null.
  // `from` is the mode the room swapped out of and `snap` its movable things as they were then (null when not known).
  const swapView = (w = world) => (w && w === world && swap ? { p: swap.p, from: swap.from, snap: swap.snap ?? null } : null);

  // A level with zones while some tiles' pictures ease: the Float32Array of every tile (0 = 8-bit ... 1 = low-res); else null.
  const tileView = (w = world) => (w && w === world && tiles && moving > 0 ? tiles : null);

  // One figure while its picture eases: how far it is (0 = 8-bit ... 1 = low-res), else null.
  const part = (w, rec) => (w && w === world && rec && rec.p > 0 && rec.p < 1 ? rec.p : null);
  const thingEase = (w, t) => part(w, things.get(t));
  const playerEase = (w = world) => part(w, pl);

  return { update, view, swapView, tileView, thingEase, playerEase, get busy() { return cur !== null; }, get pending() { return queue.length; } };
}

// The view of a slider world with no look kept (nobody passed one): at rest on its step.
export const restView = (world) => ({ step: world.slider.step });
