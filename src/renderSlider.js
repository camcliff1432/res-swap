// The picture of a slider level at steps 4 and 2, and while the step eases from one to the next (the timing is
// sliderLook.js; the rules are slider.js). The whole picture gets coarser together: sky, things and the player are drawn in
// blocks of 2 x 2 level pixels (step 4) or 4 x 4 (step 2), and the terrain shows exactly what is solid in the voted mask of that
// step.
//
// AT REST A STEP IS CRISP. Each thing is a picture a character was drawn in at that resolution: a block of it is drawn when the
// thing fills more than half of that block (the same vote that decides what is solid, so the picture and the rules tell one
// story), and the block's colour is the average of the thing's OWN pixels inside it (what blurring it would give, with none of
// the sky or of what is behind it mixed in). Every block is opaque. How it is worked out is crisp.js (pure); here it is drawn:
//   - the render8 picture of the things is drawn onto a recording context, one thing at a time (render8's lens.group), and each
//     thing is reduced to its blocks. Things that sit still (ladders, keys, doors, springs, buttons, lasers, the exit ...) have
//     their blocks on the LEVEL's grid, so they slide with the world as the view scrolls; things that move (the player, crates,
//     small crates, balls, platforms) have their blocks hanging from their OWN corner, at their true place, so a mover glides and
//     never hops from one world block to the next. Tilted crates are reduced from the pixels they cover as they lean, frame by
//     frame. The blocks are drawn with plain fillRects, never from a small canvas (that made the player blink on a tablet);
//   - the sky is a layer per level and step (the colour most of each block's pixels have, as step 1 votes its tiles), one blit;
//   - the terrain is painted from the voted mask (cached per level and step, one blit a frame), under the things.
// Whatever is drawn is cheap: a few blits and some fillRects; no pixels are ever read back while playing.
//
// THE MOVE STAYS BLURRY. When the step changes the picture eases (sliderLook.js): the finer picture is seen sharp, smears into the
// coarse blocks (the 8-bit picture is drawn to an off-screen canvas, reduced by halving, a 2 x 2 average each time, and drawn
// back up with smoothing off: here a block IS the average of its pixels, sky and all, because that is what blurring is), each
// terrain block shows how full it is, and then it firms up into the crisp coarse picture while the loose blocks fade. The last
// frame of a move is the rest picture, call for call.
//
// Stage 4 (areas with a step, render.js renderStepped): in a world with areas this draws one WHOLE-ROOM picture of one step (or
// of the room's own move), for the compositor to show in that step's tiles. The world is put at that step for the drawing
// (world.viewStep: every tile answers that step), so the inside of an area looks exactly like the whole room at its step.
//
// The picture is honest about the rules (props/index.js existsAtStep / worksAtStep, slider.js drawnClass): a thing the rules say
// is gone at that step is not in it at all, a spring that is a plain block is a plain block, a button the step froze is a flat
// slab, and a thing that follows its picture is cut where its tile voted to nothing and is a plain block where its tile voted to
// a full box. When a thing the rules keep wins no block at all, its best covered blocks are drawn (it is never invisible).
import { VIEW_W, VIEW_H, PX8 } from './constants.js';
import { NES } from './sprites8.js';
import { render8, drawPlayer8, drawOverlays8, drawSky, paintTerrain, updateFacing, ICE_TOP, spikeBlockColour } from './render8.js';
import { renderLow } from './renderLow.js';
import { BLOCK, drawnClass, tileClass, keepsShape } from './slider.js';
import { PROPS, existsAtStep, worksAtStep } from './props/index.js';
import { thingMode, hasZones, maskOfStep } from './zones.js';
import { blockCounts, blockSolid, fillAlpha, gridOrigin, restView } from './sliderLook.js';
import { createRecorder, createRaster, dominantBlocks, reduceBlocks, runsOf, tinyPlayer, parseColour, hexOf } from './crisp.js';

const W = VIEW_W * PX8, H = VIEW_H * PX8;
const M = PX8;                                   // the off-screen picture is a tile bigger each way (the blocks cut by the view's edge)
const px = (v) => Math.round(v * PX8);

// What to draw for a world now: null when it is at rest on step 8 or 1 (the classic renderers draw those), else the view
// ({ step } at rest on 4 or 2, or a move in progress, see sliderLook.js).
export function lookView(world, opts = {}) {
  const v = opts.look ? opts.look.view(world) : restView(world);
  if (!v || (v.step !== undefined && (v.step === 8 || v.step === 1))) return null;
  return v;
}

const make = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { canvas: c, ctx: c.getContext('2d') };
};
const sets = [];                                 // the full picture and its two halvings: one set, a second only during a move
const setOf = (i) => (sets[i] ??= { a: make(W + M, H + M), h1: make((W + M) / 2, (H + M) / 2), h2: make((W + M) / 4, (H + M) / 4) });
let low = null;                                  // the low-res picture
const lowLayer = () => (low ??= make(W, H));
function halve(from, to) {
  to.ctx.imageSmoothingEnabled = true;
  to.ctx.imageSmoothingQuality = 'low';          // plain bilinear: at exactly half size that is the 2 x 2 average
  to.ctx.drawImage(from.canvas, 0, 0, from.canvas.width, from.canvas.height, 0, 0, to.canvas.width, to.canvas.height);
}

const rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const HULL = rgb(NES.hullGrey), HULL_LIGHT = rgb(NES.hullLight), HULL_DARK = rgb(NES.hullDark), BRIGHT = rgb(NES.starBright);
// At step 2 the highlights are half as strong (light top, mid-dark underside, no light left edge): they thin out toward the flat
// low-res picture, so the edge does not jump at the last step.
const MID_DARK = rgb('#5C5C5C');
const ICE = rgb(ICE_TOP);

// ---- the terrain, cached per world --------------------------------------------------------------------------------
const caches = new WeakMap();                    // world -> { fine, steps: { 4: {...}, 2: {...}, 1: {...} }, skies: { 4: canvas, 2: canvas } }
const cacheOf = (world) => { let c = caches.get(world); if (!c) caches.set(world, c = { fine: null, steps: {}, skies: {} }); return c; };

// The original picture: the slider's (the same array as world.res.base), or a stepped world's without the slider.
const baseOf = (world) => (world.slider ? world.slider.base : world.res.base);

// The true 8-bit terrain (from the original picture) on a transparent level-sized canvas: what step 8 shows.
function fineTerrain(world) {
  const cache = cacheOf(world);
  if (!cache.fine) {
    const { canvas, ctx } = make(world.maskW, world.maskH);
    const keep = world.mask;
    world.mask = baseOf(world);
    try { paintTerrain(ctx, world); } finally { world.mask = keep; }
    cache.fine = canvas;
  }
  return cache.fine;
}

// The terrain of a step as three level-sized transparent canvases, one block grid each:
//   sol   the voted solid blocks, shaded like 8-bit terrain at block size (a bright top, a dark underside); flat at step 1
//   fs    the same blocks as a flat hull shade in proportion to how full they are (the honest downsample)
//   fe    the blocks that are not solid but not empty either: the same shade by fill (they fade out as the blocks firm up)
function stepTerrain(world, step) {
  const cache = cacheOf(world);
  if (cache.steps[step]) return cache.steps[step];
  const b = BLOCK[step], { maskW, maskH } = world;
  const { cols, rows, counts } = blockCounts(baseOf(world), maskW, maskH, b);
  const solidAt = (cx, cy) => (cx < 0 || cy < 0 || cx >= cols || cy >= rows ? true : blockSolid(counts[cy * cols + cx], b));
  const mk = () => { const l = make(maskW, maskH); l.img = l.ctx.createImageData(maskW, maskH); return l; };
  const sol = mk(), fs = mk(), fe = mk();
  const put = (l, cx, cy, [r, g, bl], a) => {
    for (let y = cy * b; y < cy * b + b; y++) {
      for (let x = cx * b, i = (y * maskW + x) * 4; x < cx * b + b; x++, i += 4) {
        l.img.data[i] = r; l.img.data[i + 1] = g; l.img.data[i + 2] = bl; l.img.data[i + 3] = a;
      }
    }
  };
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const n = counts[cy * cols + cx];
      if (n === 0) continue;
      const solid = blockSolid(n, b);
      put(solid ? fs : fe, cx, cy, HULL, Math.round(255 * fillAlpha(n, b)));
      if (!solid) continue;
      const tx = Math.floor(cx * b / PX8), ty = Math.floor(cy * b / PX8), ch = world.shapes[ty]?.[tx];
      const top = !solidAt(cx, cy - 1), under = !solidAt(cx, cy + 1), right = !solidAt(cx + 1, cy), left = !solidAt(cx - 1, cy);
      let c = HULL;
      // big spikes stay red at every step, blunt or not: each block the average of the 8-bit reds it takes in
      const spike = ch === 'W' || ch === 'M' ? spikeBlockColour(baseOf(world), maskW, maskH, cx * b, cy * b, b) : null;
      if (spike) c = spike;
      else if (step === 1) c = HULL;                                               // low-res: flat
      else if (top) c = world.ice && world.ice[ty * world.width + tx] === 1 ? ICE : step === 2 ? HULL_LIGHT : BRIGHT;
      else if (under || right) c = step === 2 ? MID_DARK : HULL_DARK;
      else if (left && step !== 2) c = HULL_LIGHT;
      put(sol, cx, cy, c, 255);
    }
  }
  for (const l of [sol, fs, fe]) l.ctx.putImageData(l.img, 0, 0);
  return (cache.steps[step] = { sol: sol.canvas, fs: fs.canvas, fe: fe.canvas });
}

// The terrain a step shows at rest (to fade it out into the blur): the true terrain at 8, the voted blocks below.
const restTerrain = (world, step) => (step === 8 ? fineTerrain(world) : stepTerrain(world, step).sol);

// How many halvings of the full picture a step's scene needs (8: none; 1 is drawn by renderLow, not from the picture).
const HALVINGS = { 8: 0, 4: 1, 2: 2, 1: 0 };

// ---- the sky, one crisp layer per level and step -------------------------------------------------------------------------
// The sky (stars, planet) of the whole level voted in blocks of the step: each block is the colour most of its pixels have, the
// same vote step 1 takes of its tiles, so the sky reads as one sky from 8 down to 1. A star is one pixel: it never fills half
// of a 2 x 2 block, so stars are gone at steps 4 and 2 (and at step 1); the planet stays, in blocks of its own three shades.
function skyLayer(world, step) {
  const cache = cacheOf(world);
  if (cache.skies[step]) return cache.skies[step];
  const { maskW, maskH } = world, b = BLOCK[step];
  const raster = createRaster(maskW, maskH);
  drawSky(raster.ctx, maskW, maskH);
  const { cols, rows, colours } = dominantBlocks(raster.data, maskW, maskH, b);
  const { canvas, ctx } = make(maskW, maskH);
  const img = ctx.createImageData(maskW, maskH);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const c = colours[cy * cols + cx];
      for (let y = cy * b; y < cy * b + b; y++) {
        for (let x = cx * b, i = (y * maskW + x) * 4; x < cx * b + b; x++, i += 4) {
          img.data[i] = c >> 16; img.data[i + 1] = (c >> 8) & 255; img.data[i + 2] = c & 255; img.data[i + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return (cache.skies[step] = canvas);
}

// ---- the things, as the rules have them at a step -----------------------------------------------------------------------
// The helpers (props/index.js) answer for the world's own step, so for a picture of another step (the finer side of a move)
// the world is put at that step, with that step's terrain, for the time it takes to draw it.
// In a world with areas every tile is put at `step` (world.viewStep) with the whole room's terrain voted at it.
function atStep(world, step, fn) {
  if (hasZones(world)) {
    const keep = { view: world.viewStep, mask: world.mask };
    world.viewStep = step;
    world.mask = maskOfStep(world, step);
    try { return fn(); } finally { world.viewStep = keep.view; world.mask = keep.mask; }
  }
  const s = world.slider, keep = { step: s.step, mask: world.mask };
  s.step = step;
  const mask = step === 8 || step === 1 ? s.base : s.voted[step];
  if (mask) world.mask = mask;
  try { return fn(); } finally { s.step = keep.step; world.mask = keep.mask; }
}

// Things that move on their own, besides the player, crates and balls: their blocks hang from their own corner (so a thing glides
// over the world's blocks and keeps its shape), where everything else sits on the level's grid. At step 2 the rules put every
// thing on the half-tile grid, so the two grids are one there (the player is the exception: he walks pixel by pixel).
const MOVERS = new Set(['platform', 'smallcrate']);
const BLOCK_COLOUR = parseColour(NES.hullGrey);

// The astronaut at step 4 or 2 as rectangles in a picture whose top-left is level pixel (ox, oy): his 8-bit figure reduced to blocks
// hanging from his own corner (his true place, so he never hops from one world block to the next), or at step 2 the figure made by
// hand (crisp.js tinyPlayer: his sprite by the vote alone is a heap of mixed colours at 4 x 4 blocks, with no visor). Walking frames and
// the way he faces come from the 8-bit figure's own rules (render8 drawPlayer8).
function playerRects(rec, player, step, ox, oy) {
  const b = BLOCK[step], x = px(player.x), y = px(player.y);
  if (step === 2) {
    const left = updateFacing(player) < 0, walking = player.vx !== 0 && player.onGround;
    return tinyPlayer(walking ? Math.floor(x / 4) & 1 : 0, left, b).map(([rx, ry, w, h, c]) => [x - ox + rx, y - oy + ry, w, h, c]);
  }
  rec.take();
  drawPlayer8(rec.ctx, player, { x: ox / PX8, y: oy / PX8 });
  return runsOf(reduceBlocks(rec.take(), b, x - ox, y - oy, true), b);
}

// The astronaut alone, drawn straight onto ctx in the look of step 4 or 2 (render.js: a player who stands across the seam of two
// areas is drawn whole, on top, in the step under his centre).
let topRec = null;
export function drawPlayerCrisp(ctx, player, cam, step) {
  topRec ??= createRecorder({ x0: -2 * PX8, y0: -2 * PX8, x1: W + 2 * PX8, y1: H + 2 * PX8 });
  for (const [x, y, w, h, c] of playerRects(topRec, player, step, px(cam.x), px(cam.y))) { ctx.fillStyle = hexOf(c); ctx.fillRect(x, y, w, h); }
}

// What render8 asks of the lens (see its header); the world is at the step being drawn. Nothing here is a list of kinds of
// thing but the movers: the helpers say what exists, what works, and what each tile of a picture is after the vote.
//   spikes and anything else that is gone: not drawn                   (existsAtStep)
//   a button that no longer works: a flat slab                         (worksAtStep)
//   a blade at step 2: the stopped block; the player at step 2: a figure made by hand for 4 x 4 blocks
//   a prop that follows its picture: a tile that voted to nothing is cut, a tile that voted to a full box is a plain block
// and every thing's picture is recorded alone (group) and reduced to the blocks it wins by the vote, in its own colours.
function lensOf(world, step, rec, pic, gx, gy, player) {
  const b = BLOCK[step];
  let curProp = null;
  const origin = (kind, t) => (kind === 'player' || kind === 'crate' || kind === 'ball' || (kind === 'prop' && MOVERS.has(t.type))
    ? [px(t.x) - gx.origin, px(t.y) - gy.origin] : [0, 0]);
  const emit = (rects) => {
    for (const [x, y, w, h, c] of rects) { pic.fillStyle = hexOf(c); pic.fillRect(x, y, w, h); }
  };
  // The blocks of a tile-following prop after the rules' say: a tile that voted to nothing is empty, one that voted to a full box
  // is a plain block of hull.
  const byTile = (blocks, p) => {
    const def = PROPS[p.type], cls = new Map();
    const classOf = (tx, ty) => { const k = ty * 4096 + tx; if (!cls.has(k)) cls.set(k, drawnClass(world, p, def.draw8, tx, ty)); return cls.get(k); };
    const out = [], full = new Set();
    for (const k of blocks) {
      const tx = Math.floor((k.x + gx.origin) / PX8), ty = Math.floor((k.y + gy.origin) / PX8), c = classOf(tx, ty);
      if (c === 'gone') continue;
      if (c === 'full') { full.add(ty * 4096 + tx); continue; }
      out.push(k);
    }
    for (const key of full) {
      const tx = key % 4096, ty = Math.floor(key / 4096);
      for (let y = 0; y < PX8; y += b) for (let x = 0; x < PX8; x += b) out.push({ x: tx * PX8 - gx.origin + x, y: ty * PX8 - gy.origin + y, colour: BLOCK_COLOUR });
    }
    return out.sort((q, r) => q.y - r.y || q.x - r.x);
  };
  return {
    spikes: (s) => existsAtStep(world, s),
    button: (bt) => (!existsAtStep(world, bt) ? 'none' : worksAtStep(world, bt) ? 'cap' : 'slab'),
    ball: (bl) => (thingMode(world, bl) === 'low' ? 'box' : 'sprite'),     // at step 2 a ball is a box on the half-tile grid
    prop(ctx, p, q, w, draw) {
      if (!existsAtStep(world, p)) return;
      curProp = p;
      // A blade at step 2 is stopped, a solid harmless block where it really is (not the swing its clock would draw).
      if (p.type === 'blade' && thingMode(world, p) === 'low') { const def = PROPS.blade; if (def.drawLow) def.drawLow(ctx, p, world); return; }
      draw();
    },
    group(kind, thing, fn) {
      rec.take();                                              // (nothing is left over from the thing before)
      curProp = null;
      if (kind === 'player') { emit(playerRects(rec, player, step, gx.origin, gy.origin)); return; }
      fn();
      const got = rec.take();
      if (got.idx.length === 0) return;
      const [ox, oy] = origin(kind, thing);
      let blocks = reduceBlocks(got, b, ox, oy, kind !== 'wire');
      if (kind === 'prop' && curProp && PROPS[curProp.type].followsPicture) blocks = byTile(blocks, curProp);
      emit(runsOf(blocks, b));
    },
  };
}

// One crisp picture of a step on set.a at the level's pixel scale, drawn from a tile edge (gx, gy) so the blocks of the level's grid
// fall on the picture's: the sky, then the terrain when asked (once a move has firmed), then every thing as its blocks.
const recorders = new Map();
function crisp(set, world, player, gx, gy, step, opts, terrainToo) {
  const pic = set.a.ctx;
  pic.fillStyle = NES.sky;
  pic.fillRect(0, 0, W + M, H + M);
  pic.drawImage(skyLayer(world, step), -gx.origin, -gy.origin);
  if (terrainToo) pic.drawImage(stepTerrain(world, step).sol, -gx.origin, -gy.origin);
  let rec = recorders.get(set);
  if (!rec) recorders.set(set, rec = createRecorder({ x0: -2 * PX8, y0: -2 * PX8, x1: W + M + 2 * PX8, y1: H + M + 2 * PX8 }));
  const draw = () => render8(rec.ctx, world, player, { x: gx.origin / PX8, y: gy.origin / PX8 },
    { sky: false, terrain: false, extra: M, overlays: false, player: !opts.hidePlayer, lens: lensOf(world, step, rec, pic, gx, gy, player) });
  if (!hasZones(world) && step === world.slider.step) draw();
  else atStep(world, step, draw);
}

// ---- one frame ----------------------------------------------------------------------------------------------------
// `view`: from lookView. `opts`: { hidePlayer } as for render (the crush flash is drawn by the caller, on top); { overlays: false }
// leaves the key count and sign text out (the compositor draws them once, on top).
export function renderSlider(ctx, world, player, cam, opts, view) {
  const rest = view.step !== undefined;
  const coarse = rest ? view.step : view.coarse, fine = rest ? 8 : view.fine;
  const blur = rest ? 1 : view.blur, firm = rest ? 1 : view.firm;
  const ox = px(cam.x), oy = px(cam.y);
  const gx = gridOrigin(ox, PX8), gy = gridOrigin(oy, PX8);   // the picture is drawn from a tile edge, so every block size lines up
  const lowSide = coarse === 1;
  const t = stepTerrain(world, coarse);

  // The finer side of a move (seen sharp while blur < 1, and averaged into the coarse blocks until the firm phase is over) and
  // the coarser side (what is left once the firm phase is done: crisp). At rest they are the one picture of the step.
  const needFine = !rest && (blur < 1 || firm < 1), needCoarse = rest || firm > 0;
  const bake = firm >= 1 && !lowSide;                           // the terrain is part of the coarse picture once it has firmed
  const F = setOf(0), C = needFine && needCoarse ? setOf(1) : F;
  if (needFine) {
    if (fine === 8) {
      const a = F.a.ctx;
      a.fillStyle = NES.sky;
      a.fillRect(0, 0, W + M, H + M);
      const draw = () => render8(a, world, player, { x: gx.origin / PX8, y: gy.origin / PX8 }, { terrain: false, extra: M, overlays: false, player: !opts.hidePlayer });
      if (!hasZones(world) && fine === world.slider.step) draw();
      else atStep(world, fine, draw);
    } else crisp(F, world, player, gx, gy, fine, opts, false);
    if (!lowSide) {                                           // the blur: its 2 x 2 averages, once for step 4 blocks and twice for step 2
      halve(F.a, F.h1);
      if (HALVINGS[coarse] >= 2) halve(F.h1, F.h2);
    }
  }
  if (needCoarse && !lowSide) crisp(C, world, player, gx, gy, coarse, opts, bake);
  if (lowSide) renderLow(lowLayer().ctx, world, player, cam, { terrain: false, player: !opts.hidePlayer });

  const keep = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  const scene = (src, b, alpha) => {                          // a picture drawn from the grid, b level pixels to a picture pixel
    ctx.globalAlpha = alpha;
    if (src === low) ctx.drawImage(src.canvas, 0, 0);
    else ctx.drawImage(src.canvas, 0, 0, src.canvas.width, src.canvas.height, -gx.offset, -gy.offset, src.canvas.width * b, src.canvas.height * b);
  };
  const terrain = (canvas, alpha) => {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    ctx.drawImage(canvas, ox, oy, W, H, 0, 0, W, H);
  };

  if (blur < 1) scene(F.a, 1, 1);                              // the finer picture, as it was at rest
  if (lowSide) scene(lowLayer(), 1, blur < 1 ? blur : 1);
  else {
    if (!rest && firm < 1) scene(coarse === 4 ? F.h1 : F.h2, BLOCK[coarse], blur < 1 ? blur : 1);   // blurred into the coarse blocks
    if (needCoarse) scene(C.a, 1, firm < 1 ? firm : 1);        // then the crisp coarse one fades in over it: what is gone fades out
  }
  if (blur < 1) {                                              // blur: the finer terrain fades into the fill shades
    terrain(restTerrain(world, fine), 1 - blur);
    terrain(t.fs, blur);
    terrain(t.fe, blur);
  } else if (firm < 1) {                                       // firm: the solid blocks climb to full, the others fade out
    terrain(t.fs, 1);
    terrain(t.fe, 1 - firm);
  }
  if (blur >= 1 && !bake) terrain(t.sol, firm);
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = keep;
  if (!lowSide && opts.overlays !== false) drawOverlays8(ctx, world, player);   // key count, sign text: they stay readable, drawn crisp on top
}
