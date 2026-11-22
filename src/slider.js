// The resolution slider. A level with `slider: true` has four steps, named by how many blocks fit across a tile:
// 8 (today's 8-bit), 4, 2 and 1 (today's low-res). Step 8 and step 1 are the two modes as they are: step 1 is reached
// through trySwap (world.js), unchanged. At steps 4 and 2 the 8-bit picture is re-voted into blocks of 2 x 2 (step 4) or
// 4 x 4 (step 2) pixels (a block is solid when MORE than half of it is filled: a tie loses, so thin things vanish and never swell; vote.js), and
// the game then runs its ordinary 8-bit rules against that mask (stage 1). The things (ladders, ropes, chains, the laser
// beam, keys, the keyhole, springs, spikes, big spikes, buttons) follow their own pictures voted the same way (stage 2,
// the second part of this file). The movers (crates, balls, small crates, platforms, blades) are bodies at steps 8 and 4 and
// live on a grid at steps 2 and 1: half a tile at step 2, a whole tile at step 1, moving the low-res way (stage 3: zones.js
// gridCell, objects.js). Every notch moves them between the steps by one planner (planNotch, the third part of this file).
//
// The vote is always taken from the ORIGINAL picture (`state.base`), never from the step before (a cascade would let thin
// lines grow at every step). `world.mask` is what terrain collision and the 8-bit renderer read; it holds the voted mask
// at steps 4 and 2 and the original picture at steps 8 and 1. A world without `world.slider` never comes here.
//
//   world.slider = { step, base, voted }    step 8 | 4 | 2 | 1; base: the original mask; voted: { 4: mask, 2: mask } (made on use)
//   trySlide(world, player, 'down' | 'up')  -> 'done' | 'refused' | 'none' (already at the end of the slider)
// World mode: '8bit' at steps 8, 4 and 2 (the terrain is world.mask), 'low' at step 1 (world.low), as the swap leaves it.
import { PX8, PLAYER_W, PLAYER_H, CRATE_SIZE, BALL_SIZE, DOOR_W, DOOR_H } from './constants.js';
import { terrainHitsBox } from './world.js';
import { wins } from './vote.js';
import { rasterSquare, syncDyn, CRATE_HALF } from './dyn.js';
import { platformBoxAtStep } from './props/platform.js';
import { bladeAtStep } from './props/blade.js';
import { STEPS, BLOCK, CELL, voteMask, stepAt, baseStep, rebuildModes, hasZones, thingStep, markStep, zoned } from './zones.js';

// The steps, the block sizes and the vote live with the tile map (zones.js), which stage 4 made a map of steps.
export { STEPS, BLOCK, voteMask };

// One notch: plan where everything goes at the next step (every check first), then do it, or change nothing at all.
// `setup`: the room being put at its starting step (sim.js): not a change the player made, so nothing counts it (a cactus).
export function trySlide(world, player, direction, setup = false) {
  const s = world.slider;
  const from = STEPS.indexOf(s.step);
  const to = from + (direction === 'down' ? 1 : -1);
  if (to < 0 || to >= STEPS.length) return 'none';
  const plan = planNotch(world, player, s.step, STEPS[to], setup);
  if (!plan) return 'refused';
  applyNotch(world, player, plan, STEPS[to]);
  return 'done';
}

// The HUD label of a slider level, in the place the mode label shows today.
export const stepLabel = (world) => `RES ${world.slider.step}`;

// ---- stage 2: the things follow their own picture -------------------------------------------------------------------
// At steps 4 and 2 each thing's 8-bit picture is voted exactly like the terrain (blocks of 2 or 4 pixels on the tile grid,
// a block is solid when more than half of it is filled, always from the picture as drawn) and what is left of it, tile by
// tile, says what the thing does there:
//   'gone'    nothing is left
//   'full'    the whole tile is filled: a plain box
//   'flat'    a plain rectangle, not the whole tile: no point and no shape are left (a slab, or a blob)
//   'detail'  anything else: the picture still shows its shape
// Two rules read that (the study's "detail rule" and its recommendations):
//   keepsDetail  ladders, ropes, chains, keys, springs, the keyhole: the thing works while something other than a plain
//                full box is left. Gone: it is absent. A full box: a plain block (a spring stops bouncing).
//   keepsShape   spikes, big spikes (W, M) and buttons, whose job IS their shape (a point; a cap standing proud of its base):
//                they work only while the picture is not a plain rectangle. A slab of spikes is harmless (and not there),
//                a blunt stalactite is just rock, a flat button is frozen.
// Outside steps 4 and 2 (step 8, step 1, and every world without the slider) nothing here changes anything: the class is
// 'detail' and the two-mode rules decide, as they always have.
// Stage 4: a stepped world's areas hold steps of their own, so the step is asked per tile: middleStep(world, tx, ty) is the tile's
// step when it is 4 or 2, else 0. Without a tile it is the room's own step (the picture of a whole step, renderSlider.js).
export function middleStep(world, tx, ty) {
  if (!world.res) return 0;
  const s = tx === undefined ? (world.viewStep || world.slider?.step || 0) : stepAt(world, tx, ty);
  return s === 4 || s === 2 ? s : 0;
}

export const keepsDetail = (cls) => cls === 'detail' || cls === 'flat';
export const keepsShape = (cls) => cls === 'detail';

// The class of one tile's picture voted in blocks of `block` pixels. `at(x, y)` (0..7) is 1 where the picture is drawn.
export function tileClass(at, block) {
  let n = 0, x0 = 8, y0 = 8, x1 = -1, y1 = -1;
  for (let by = 0; by < 8; by += block) {
    for (let bx = 0; bx < 8; bx += block) {
      let c = 0;
      for (let y = by; y < by + block; y++) for (let x = bx; x < bx + block; x++) c += at(x, y) ? 1 : 0;
      if (!wins(c, block * block)) continue;
      n += block * block;
      x0 = Math.min(x0, bx); y0 = Math.min(y0, by); x1 = Math.max(x1, bx + block - 1); y1 = Math.max(y1, by + block - 1);
    }
  }
  if (n === 0) return 'gone';
  if (n === 64) return 'full';
  return n === (x1 - x0 + 1) * (y1 - y0 + 1) ? 'flat' : 'detail';
}

// The class of a picture given as rows of 8 characters ('.' empty), standing on the bottom of tile (tx, ty), at its step.
const rowsCache = new Map();
export function rowsClass(world, rows, tx, ty) {
  const step = middleStep(world, tx, ty);
  if (!step) return 'detail';
  const key = `${step}:${rows.join('/')}`;
  if (!rowsCache.has(key)) {
    const top = 8 - rows.length;
    rowsCache.set(key, tileClass((x, y) => y >= top && rows[y - top][x] !== '.', BLOCK[step]));
  }
  return rowsCache.get(key);
}

// A prop's picture as its own draw function paints it (every pixel it fills, whatever the colour), recorded once per prop
// on the tiles its box covers. `draw(ctx, inst, world)` is the prop's draw8; it is shown the prop as placed (a key not yet
// taken, a door not yet open), because the picture that is voted is the thing's own, not its state.
const drawnCache = new WeakMap();       // prop -> Map(draw function -> picture)
function drawnPicture(world, inst, draw) {
  if (!drawnCache.has(inst)) drawnCache.set(inst, new Map());
  const mine = drawnCache.get(inst);
  let pic = mine.get(draw);
  if (pic) return pic;
  const tx = Math.floor(inst.x), ty = Math.floor(inst.y);
  const w = (Math.ceil(inst.x + inst.w) - tx) * 8, h = (Math.ceil(inst.y + inst.h) - ty) * 8;
  const px = new Uint8Array(w * h);
  const paint = {
    fillRect(x, y, rw, rh) {
      for (let yy = Math.max(0, y - ty * 8); yy < Math.min(h, y + rh - ty * 8); yy++) {
        for (let xx = Math.max(0, x - tx * 8); xx < Math.min(w, x + rw - tx * 8); xx++) px[yy * w + xx] = 1;
      }
    },
  };
  const ctx = new Proxy(paint, { get: (t, k) => (k in t ? t[k] : () => {}), set: () => true });   // colours and the rest: ignored
  draw(ctx, { ...inst, taken: false, open: false }, world);
  pic = { tx, ty, w, px, classes: new Map() };
  mine.set(draw, pic);
  return pic;
}

// The class of the tile (tx, ty) of a prop's drawn picture at that tile's step ('detail' outside steps 4 and 2).
export function drawnClass(world, inst, draw, tx, ty) {
  const step = middleStep(world, tx, ty);
  if (!step) return 'detail';
  const pic = drawnPicture(world, inst, draw);
  const key = `${step},${tx},${ty}`;
  if (!pic.classes.has(key)) {
    const ox = (tx - pic.tx) * 8, oy = (ty - pic.ty) * 8;
    pic.classes.set(key, tileClass((x, y) => pic.px[(oy + y) * pic.w + ox + x] === 1, BLOCK[step]));
  }
  return pic.classes.get(key);
}

// Does any tile of the prop's picture keep its detail at its step? (Always true outside steps 4 and 2: a tile at another step is
// 'detail'.)
export function drawnKeepsDetail(world, inst, draw) {
  if (!world.res) return true;
  for (let ty = Math.floor(inst.y); ty < Math.ceil(inst.y + inst.h); ty++) {
    for (let tx = Math.floor(inst.x); tx < Math.ceil(inst.x + inst.w); tx++) if (keepsDetail(drawnClass(world, inst, draw, tx, ty))) return true;
  }
  return false;
}

// The band a line `thick` pixels thick, starting `from` pixels into its tile, covers once voted at the step of tile (tx, ty):
// [from, thick] in pixels, or null when it is gone. (The laser beam: 2 pixels at step 8, gone from step 4 down: it straddles two blocks.)
export function votedBand(world, from, thick, tx, ty) {
  const step = middleStep(world, tx, ty);
  if (!step) return [from, thick];
  const b = BLOCK[step];
  let lo = 8, hi = -1;
  for (let s = 0; s < 8; s += b) {
    const inside = Math.max(0, Math.min(s + b, from + thick) - Math.max(s, from));
    if (wins(inside, b)) { lo = Math.min(lo, s); hi = Math.max(hi, s + b); }
  }
  return hi < 0 ? null : [lo, hi - lo];
}

// How far a ball looks to find downhill, in level pixels: one block at the fine steps. At step 4 the voted ramps are stairs
// of 2 pixels, and a 1-pixel look sees no way down (study section 4); at step 8 it is one pixel, as ever. At step 2 balls
// are boxes on the half-tile grid (stage 3) and do not roll at all.
// (Stage 4: the step the ball lives at.)
export const rollReach = (world, ball) => (world.res && (ball ? thingStep(world, ball) : baseStep(world)) === 4 ? BLOCK[4] : 1);

// ---- stage 3: the movers on a notch ----------------------------------------------------------------------------------
// Every mover has a place at every step. Steps 8 and 4 are fine (bodies: a crate at its pixel pose, which may be turned);
// steps 2 and 1 are grids of CELL tiles (rigid boxes moving the low-res way).
//
// The anchor. A crate or ball remembers the exact place it had before a notch moved it (`home.anchor`: x, y, tilt, and whether
// it rested) and where the last notch put it (`home.at`). While it is still there, at rest, it has not moved by itself, and
// every notch places it from its anchor: the same step always shows it in the same place, whichever way the slider went (no
// path dependence: the discoveries' "notch path", where 8, 4, 2, 1 and one direct snap to step 1 put a crate a tile apart,
// cannot happen). Once it moves by itself (pushed, falling, carried) where it is becomes its anchor.
//   Going coarser (4 -> 2, 2 -> 1; 8 -> 4 moves nothing): the nearest place on the new grid to the anchor, or one cell up when
//     that is taken (the swap's rule, with the grid of the step). Neither free: the notch is refused.
//   Going finer (1 -> 2, 2 -> 4, 4 -> 8): back to the place that step gives the anchor (the anchor itself at 8 and 4) when it is
//     free, else it stays where it is (a place on a coarser grid is a place on the finer one too). A thing that is moving stays
//     where it is, as in a swap to 8-bit.
// Speed is kept across every notch (a push or a glide in progress gives none), as across a swap. A crate straightens on a
// grid; back at a fine step at its anchor it lies as it lay there.
// Small crates keep their half-tile places (only their height snaps, at 4 -> 2: nearest half tile or one up), merge into
// whole-tile blocks at step 1 by the swap's rule (the tile their halves are in, the height rounded, or one up), and a block that
// has not moved since splits back into the very halves it was made of (`halves`: their anchor), else as the swap splits one.
// Platforms and blades need no anchor: their clock says where they are, so each step has its own box for them
// (platformBoxAtStep, bladeAtStep).
// Refusal (the study's question 7, "refuse"): a notch is refused when terrain would land inside the player or a thing, when a
// thing has no free place, or when a thing's place would be inside the player (the player is not nudged aside). A refused
// notch changes nothing.
const fine = (step) => step >= 4;
const GRAZE = 4;                                  // of a crate's 256 pixels
const onGrid = (v, cell) => Math.round(v / cell) * cell;
const same = (a, b) => Math.abs(a - b) < 1e-6;
const isSmall = (p) => p.type === 'smallcrate';
const boxHit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
// A thing that has just snapped keeps its hidden exact place (objects.js stepLowThing) within its cell, so it rounds to it.
const within = (exact, at, cell) => Math.max(at - 0.49 * cell, Math.min(at + 0.49 * cell, exact));

// Is the thing still where the last notch put it, at rest? Then its anchor holds. Else its anchor is where it is now (on a
// grid: its hidden exact place).
function anchorOf(t, gridNow) {
  const h = t.home;
  if (h && same(t.x, h.at.x) && same(t.y, h.at.y) && same(t.tilt || 0, h.at.tilt) && !t.vx && !t.vy) return { anchor: h.anchor, still: true };
  const exact = (v, f, l) => (gridNow && f !== undefined && l === v ? f : v);
  return { anchor: { x: exact(t.x, t.fx, t.lx), y: exact(t.y, t.fy, t.ly), tilt: t.tilt || 0, onGround: t.onGround === true }, still: false };
}

// The places to try for a crate or ball, best first: { x, y, tilt, restored }.
function placesFor(t, from, to, anchor, still) {
  const cur = { x: t.x, y: t.y, tilt: fine(from) ? t.tilt || 0 : 0 };
  if (fine(to)) {
    const back = { x: anchor.x, y: anchor.y, tilt: anchor.tilt, restored: true };
    // (terrain that grows into it at the finer step, a tooth it leans on, lifts it: a pixel at a time, up to half a tile)
    const lifts = [1, 2, 3, 4].map((n) => ({ ...cur, y: cur.y - n / PX8 }));
    return still && !(same(back.x, cur.x) && same(back.y, cur.y) && same(back.tilt, cur.tilt)) ? [back, cur, ...lifts] : [cur, ...lifts];
  }
  // Onto a grid: the nearest place, or one cell up (a floor that swelled under it); then the same on the other side across (two
  // crates that touch between grid lines would else round into each other).
  const cell = CELL[to];
  const snap = { x: onGrid(anchor.x, cell), y: onGrid(anchor.y, cell), tilt: 0 };
  const ups = (pl) => [pl, { ...pl, y: pl.y - cell }];
  const across = same(snap.x, anchor.x) ? [] : ups({ ...snap, x: snap.x + (anchor.x > snap.x ? cell : -cell) });
  if (to < from) return [...ups(snap), ...across];
  const here = { ...cur, tilt: 0 };
  return still && !(same(snap.x, cur.x) && same(snap.y, cur.y)) ? [...ups(snap), here, ...ups(here).slice(1)] : ups(here);
}

// Plan the notch from step `from` to step `to`: every check, nothing changed. The plan, or null when it is refused.
// Stage 4: the notch moves the ROOM's step. Areas (windows) keep theirs, and so do the things living in them: each mover goes from
// the step it lives at to the step of its centre's tile after the notch, and one whose step does not change stays exactly as it
// is (it is in the way of the others, like a door). Without areas every mover goes from `from` to `to`, as stage 3 had it.
function planNotch(world, player, from, to, setup = false) {
  const s = world.slider, zonedWorld = zoned(world);
  const steps = new Map();                                 // mover -> { from, to }
  const movers = [...world.crates, ...world.balls, ...world.props.filter((p) => isSmall(p) || p.alt)];
  for (const t of movers) steps.set(t, { from: zonedWorld ? thingStep(world, t) : from });
  const keep = { dyn: world.dyn, mode: world.mode };
  s.step = to; world.mode = to === 1 ? 'low' : '8bit';    // the room at the new step: its terrain, the map of steps
  rebuildModes(world);
  world.dyn = null;                                       // the crates are placed below, not read from pixels
  try {
    for (const t of movers) steps.get(t).to = !zonedWorld ? to : t.forceLow ? 1 : stepOfThing(world, t);
    return planOn(world, player, steps, world.mode, setup);
  } finally {
    s.step = from; world.mode = keep.mode;
    rebuildModes(world);
    world.dyn = keep.dyn;
  }
}

// The step of the tile holding a mover's centre (the map as it is now).
function stepOfThing(world, t) {
  const size = world.crates.includes(t) ? CRATE_SIZE : world.balls.includes(t) ? BALL_SIZE : 0;
  const [w, h] = size ? [size, size] : [t.w, t.h];
  return stepAt(world, Math.floor(t.x + w / 2), Math.floor(t.y + h / 2));
}

function planOn(world, player, steps, mode, setup = false) {
  const { maskW: W, maskH: H, mask } = world;
  // A shape is { box } in tiles, or { px }: the level pixels of a crate's pose at a fine step. (A tile at step 1 is read through
  // the low-res grid: a stepped world's low-res areas.)
  const lowAt = (x, y) => hasZones(world) && world.tmode[(y >> 3) * world.width + (x >> 3)] === 1;
  const terrainPx = (x, y) => x < 0 || x >= W || y < 0
    || (y < H && (lowAt(x, y) ? world.low.cells[(y >> 3) * world.low.cols + (x >> 3)] === 1 : mask[y * W + x] === 1));
  const inTerrain = (sh) => (sh.box ? terrainHitsBox(world, sh.box.x, sh.box.y, sh.box.w, sh.box.h, mode) : sh.px.some(([x, y]) => terrainPx(x, y)));
  const E = 1e-6;
  const pxInBox = ([x, y], b) => x < (b.x + b.w) * PX8 - E && x + 1 > b.x * PX8 + E && y < (b.y + b.h) * PX8 - E && y + 1 > b.y * PX8 + E;
  const meets = (a, b) => {
    if (a.box && b.box) return boxHit(a.box, b.box);
    if (a.px && b.px) { const set = new Set(b.px.map(([x, y]) => y * W + x)); return a.px.some(([x, y]) => set.has(y * W + x)); }
    const [p, q] = a.px ? [a, b] : [b, a];
    return p.px.some((pt) => pxInBox(pt, q.box));
  };
  const crateShape = (pl, to) => {
    if (!fine(to)) return { box: { x: pl.x, y: pl.y, w: CRATE_SIZE, h: CRATE_SIZE } };
    const px = [];
    rasterSquare((pl.x + CRATE_SIZE / 2) * PX8, (pl.y + CRATE_SIZE / 2) * PX8, CRATE_HALF, pl.tilt, (x, y) => { px.push([x, y]); return false; });
    return { px };
  };

  // What does not move: closed doors and the solid props that are not movers. Terrain must not land in them either.
  const placed = [];
  for (const d of world.doors) if (!d.open) placed.push({ box: { x: d.x, y: d.y, w: DOOR_W, h: DOOR_H } });
  for (const p of world.props) if (p.solid && !p.open && !isSmall(p) && !p.alt) placed.push({ box: { x: p.x, y: p.y, w: p.w, h: p.h } });
  if (placed.some(inTerrain)) return null;
  const free = (sh) => !inTerrain(sh) && !placed.some((o) => meets(sh, o));
  const bite = (sh) => sh.px.filter(([x, y]) => terrainPx(x, y)).length;      // pixels of a crate's pose that are in terrain

  // Cacti (props/cactus.js): each grows one tile with the notch while the tile above its top is free (no terrain, nothing placed,
  // no crate, ball or small crate where it is now). A player in that tile stops it, unless they stand on its top: then they go up
  // with it (when there is room for them a tile higher).
  let ride = null;
  const grows = [];
  const moverBox = (t) => (world.crates.includes(t) ? { x: t.x, y: t.y, w: CRATE_SIZE, h: CRATE_SIZE }
    : world.balls.includes(t) ? { x: t.x, y: t.y, w: BALL_SIZE, h: BALL_SIZE } : { x: t.x, y: t.y, w: t.w, h: t.h });
  for (const p of world.props) {
    if (setup || p.type !== 'cactus' || p.h >= p.max) continue;
    const seg = { box: { x: p.x, y: p.y - 1, w: p.w, h: 1 } };
    if (!free(seg) || [...steps.keys()].some((t) => boxHit(moverBox(t), seg.box))) continue;
    const pb = { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H };
    if (boxHit(pb, seg.box)) {
      const onTop = Math.abs(player.y + PLAYER_H - p.y) <= 0.001;
      if (!onTop || ride || !free({ box: { ...pb, y: pb.y - 1 } })) continue;
      ride = { x: player.x, y: player.y - 1 };
    }
    placed.push(seg);
    grows.push(p);
  }

  // Platforms and blades: the box their clock gives at their new step (one whose step does not change keeps its box). A player
  // standing on a platform goes with it.
  const props = [];
  for (const p of world.props) {
    if (!p.alt) continue;
    const { from, to } = steps.get(p);
    let box, lowTile;
    if (from === to) box = { x: p.x, y: p.y, w: p.w, h: p.h, solid: Boolean(p.solid) };
    else if (p.type === 'platform') box = { ...platformBoxAtStep(p, to), solid: true };
    else if (p.type === 'blade') ({ box, lowTile } = bladeAtStep(p, to, (tile) => terrainHitsBox(world, tile.x, tile.y, 1, 1, mode)));
    else continue;
    if (box.solid) {
      const sh = { box };
      if (!free(sh)) return null;
      placed.push(sh);
    }
    if (p.type === 'platform' && Math.abs(player.y + PLAYER_H - p.y) <= 0.001 && player.x < p.x + p.w && player.x + PLAYER_W > p.x) {
      ride = { x: player.x + (box.x - p.x), y: box.y - PLAYER_H };
    }
    if (from !== to) props.push({ p, box, lowTile, to });
  }

  // Crates, then balls: the first free place of each.
  const things = [];
  for (const [list, size] of [[world.crates, CRATE_SIZE], [world.balls, BALL_SIZE]]) {
    for (const t of list) {
      const { from, to } = steps.get(t);
      const { anchor, still } = anchorOf(t, !fine(from));
      const tries = from === to ? [{ x: t.x, y: t.y, tilt: fine(from) ? t.tilt || 0 : 0 }] : placesFor(t, from, to, anchor, still);
      let got = null;
      for (const pl of tries) {
        const sh = size === CRATE_SIZE ? crateShape(pl, to) : { box: { x: pl.x, y: pl.y, w: size, h: size } };
        if (free(sh)) { got = { pl, sh }; break; }
      }
      // Between the two fine steps nothing moves, and the re-voted terrain may graze a crate that is wedged against it (pushed up
      // a tooth, under a ceiling): a few pixels of its edge. It stays as it is, wedged, and the notch goes through.
      if (!got && fine(from) && fine(to) && size === CRATE_SIZE) {
        const sh = crateShape(tries[0], to);
        if (bite(sh) <= GRAZE && !placed.some((o) => meets(sh, o))) got = { pl: tries[0], sh };
      }
      if (!got) return null;
      placed.push(got.sh);
      if (from !== to) things.push({ t, pl: got.pl, anchor, from, to });
    }
  }

  // Small crates.
  const smallMoves = [], merges = [], splits = [];
  const groups = new Map();
  for (const c of world.props.filter(isSmall)) {
    const { from, to } = steps.get(c);
    if (to === 1 && from !== 1) {                            // halves become whole-tile blocks; two in a tile merge
      const x = Math.floor(c.x + c.w / 2 + 1e-9), y = onGrid(c.y, 1), key = `${x},${y}`;     // (the tile holding its centre across)
      if (!groups.has(key)) groups.set(key, { x, y, members: [] });
      groups.get(key).members.push(c);
    } else if (from === 1 && to !== 1) {                     // blocks split back into the halves they were
      // A block that has not moved since it was made splits into the very halves it was made of; else as the swap splits one
      // (two fill the tile, one takes the left half).
      const h = c.halves, n = c.count === 2 ? 2 : 1;
      const tries = [(n === 2 ? [0, 0.5] : [0]).map((o) => ({ x: c.x + o, y: c.y }))];
      if (h && same(c.x, h.x) && same(c.y, h.y) && h.places.length === n) tries.unshift(h.places);
      const halves = tries.map((pl) => pl.map((q) => ({ box: { x: q.x, y: q.y, w: 0.5, h: 1 } }))).find((hs) => hs.every(free));
      if (!halves) return null;
      placed.push(...halves);
      splits.push({ c, places: halves.map((q) => q.box), to });
    } else {                                                 // entering step 2 from a fine step it snaps to the half grid
      // (the nearest half tile across, or the one across when that is taken: a small crate pushed smoothly may be between them;
      // one already on half tiles keeps its place across, as ever; its height: nearest half tile or one up)
      let tries = [{ x: c.x, y: c.y }];
      if (to === 2 && from > 2) {
        const cell = CELL[2], rx = onGrid(c.x, cell), ry = onGrid(c.y, cell);
        const xs = Math.abs(c.x - rx) > 1e-9 ? [rx, rx < c.x ? rx + cell : rx - cell] : [rx];
        tries = xs.flatMap((x) => [{ x, y: ry }, { x, y: ry - cell }]);
      }
      const at = tries.map((q) => ({ box: { x: q.x, y: q.y, w: c.w, h: c.h } })).find(free);
      if (!at) return null;
      placed.push(at);
      if (from !== to) smallMoves.push({ c, x: at.box.x, y: at.box.y, to });
    }
  }
  for (const g of groups.values()) {
    const at = [g.y, g.y - 1].map((y) => ({ box: { x: g.x, y, w: 1, h: 1 } })).find(free);
    if (!at) return null;
    placed.push(at);
    merges.push({ ...g, y: at.box.y });
  }

  // The player, where they will be: not inside terrain or anything placed.
  // A floor that swells under the player's feet (a thin floor going coarser, or coming back from step 1) lifts them onto it, as it
  // lifts a crate: the smallest rise, a pixel at a time up to half a tile, that leaves them clear. No such rise: refused.
  const pos = ride || player;
  const clear = (y) => { const pb = { box: { x: pos.x, y, w: PLAYER_W, h: PLAYER_H } }; return !inTerrain(pb) && !placed.some((o) => meets(pb, o)); };
  let lift = null;
  if (!clear(pos.y)) {
    for (let n = 1; n <= PX8 / 2 && lift === null; n++) if (clear(pos.y - n / PX8)) lift = pos.y - n / PX8;
    if (lift === null) return null;
  }
  return { mode, props, ride, lift, things, smallMoves, merges, splits, grows };
}

function applyNotch(world, player, plan, to) {
  const s = world.slider;
  // A world with areas keeps each mover's step on the mover; one without them has every mover at the room's step.
  const mark = zoned(world) ? markStep : () => {};
  for (const { p, box, lowTile, to: pto } of plan.props) {
    Object.assign(p, { x: box.x, y: box.y, w: box.w, h: box.h });
    if (p.type === 'blade') { p.solid = box.solid; if (!fine(pto)) { p.lowTile = lowTile; p.started = true; } }
    mark(p, pto);
  }
  for (const p of plan.grows) { p.y -= 1; p.h += 1; }
  if (plan.ride) { player.x = plan.ride.x; player.y = plan.ride.y; }
  if (plan.lift !== null && plan.lift !== undefined) { player.y = plan.lift; if (player.vy > 0) player.vy = 0; }
  for (const { t, pl, anchor, from, to: tto } of plan.things) {
    t.x = pl.x; t.y = pl.y;
    if (!fine(tto)) {                                         // onto a grid: a box with a hidden exact place, its speed kept
      const cell = CELL[tto];
      t.fx = within(anchor.x, t.x, cell); t.fy = within(anchor.y, t.y, cell); t.lx = t.x; t.ly = t.y;
      if (fine(from)) { if (t.glide || t.pushDir) t.vx = 0; delete t.pushDir; delete t.drift; }
      if ('tilt' in t) t.tilt = 0;
      t.onGround = false;
    } else if (pl.restored) {                                 // back at its anchor: as it lay there
      if ('tilt' in t) t.tilt = anchor.tilt;
      t.onGround = anchor.onGround;
    } else if (!fine(from)) {                                 // a body again where it is, upright, with the speed it had
      t.onGround = false;
    }
    t.home = { anchor, at: { x: t.x, y: t.y, tilt: t.tilt || 0 } };
    mark(t, tto);
  }
  for (const { c, x, y, to: cto } of plan.smallMoves) {
    if (!fine(cto)) { if (c.glide || c.pushDir) c.vx = 0; delete c.pushDir; delete c.drift; c.onGround = false; }   // onto the grid, as a crate
    c.x = x; c.y = y; mark(c, cto);
  }
  for (const g of plan.merges) {
    const [first, ...rest] = g.members;
    const halves = { x: g.x, y: g.y, places: g.members.map((m) => ({ x: m.x, y: m.y })).sort((a, b) => a.x - b.x) };
    Object.assign(first, { x: g.x, y: g.y, w: 1, h: 1, count: g.members.reduce((n, m) => n + (m.count || 1), 0), halves });
    mark(first, 1);
    for (const r of rest) world.props.splice(world.props.indexOf(r), 1);
  }
  for (const { c, places, to: cto } of plan.splits) {
    delete c.halves;
    places.forEach((q, i) => {
      const half = { x: q.x, y: q.y, w: 0.5, count: 1, side: q.x - Math.floor(q.x + 1e-9) < 0.25 ? 'left' : 'right' };
      if (i === 0) { Object.assign(c, half); mark(c, cto); } else { const piece = { ...c, ...half }; mark(piece, cto); world.props.push(piece); }
    });
  }
  s.step = to;
  world.mode = plan.mode;
  rebuildModes(world);               // the room's terrain at the new step (its areas at theirs)
  syncDyn(world);                    // the crates that are bodies now get their pixels; those on a grid are boxes
}
