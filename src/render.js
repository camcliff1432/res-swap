// The compositor: draws the world as one picture when parts of it are in different modes (see zones.js).
//
// Each frame the 8-bit picture and the low-res picture are each drawn in full to their own off-screen canvas, and
// the screen is the 8-bit picture with the low-res picture copied over every low-res tile area; a thing drawn in one
// mode that straddles an edge is cut there. Then come the frames of the zones, the flash of crushing tiles, the player
// (in the look of the mode at his centre) and the screen-space extras. A mode that has no tile in the view is not drawn
// at all; with no zones (or a view wholly in one mode) the base renderer draws straight onto the canvas, exactly as it
// did before zones existed.
//
//   render(ctx, world, player, cam, opts)       opts: { flashTiles: [{x, y}], hidePlayer: true, look }
//
// A slider level (slider.js) at step 4 or 2, or easing between steps, is drawn by renderSlider.js instead (its whole picture in
// coarse blocks); `look` (sliderLook.js createLook) says where the easing is. At rest on step 8 or 1 the classic renderers draw.
//
// A world with areas at their own step (stage 4: world.res and zones; see renderStepped) is drawn from up to four whole-room
// pictures, one per step on screen, each copied over the runs of tiles at its step, as the two pictures are above. The tiles
// that follow the room's step get the room's picture (easing, during the slider's move); an area holds its own step's.
import { VIEW_W, VIEW_H, PX8, PLAYER_W, PLAYER_H } from './constants.js';
import { render8, drawPlayer8, drawOverlays8 } from './render8.js';
import { renderLow, drawPlayerLow } from './renderLow.js';
import { hasZones, ensureModes, modeOfBox, baseStep, maskOfStep, zoneStep } from './zones.js';
import { dyingReport, deathOffset } from './sim.js';
import { drawGrenades } from './grenadeDraw.js';
import { lookView, renderSlider, drawPlayerCrisp } from './renderSlider.js';
import { gridOrigin } from './sliderLook.js';
import { easeSprite } from './easeSprite.js';
import { bandPlan, drawBands } from './edgeBands.js';

const W = VIEW_W * PX8, H = VIEW_H * PX8;
const WAVE_LINE = '#A4FCFC';
const FRAME = '#FCFCFC', FLASH_OUTER = '#FCFCFC', FLASH_INNER = '#F83800';
const px = (v) => Math.round(v * PX8);

let layers = null;           // the two off-screen pictures, made when first needed
function layer(i) {
  layers ??= [null, null];
  if (!layers[i]) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    layers[i] = { canvas: c, ctx: c.getContext('2d') };
  }
  return layers[i];
}

// What the view holds: does it show any 8-bit tile, any low-res tile, and where the low-res runs are (per tile row).
function survey(world, ox, oy) {
  const tx0 = Math.max(0, Math.floor(ox / PX8)), tx1 = Math.min(world.width - 1, Math.floor((ox + W - 1) / PX8));
  const ty0 = Math.max(0, Math.floor(oy / PX8)), ty1 = Math.min(world.height - 1, Math.floor((oy + H - 1) / PX8));
  let any8 = false, anyLow = false;
  const runs = [];            // { x, y, w } in screen pixels
  for (let ty = ty0; ty <= ty1; ty++) {
    let start = -1;
    for (let tx = tx0; tx <= tx1 + 1; tx++) {
      const low = tx <= tx1 && world.tmode[ty * world.width + tx] === 1;
      if (tx <= tx1) { if (low) anyLow = true; else any8 = true; }
      if (low && start < 0) start = tx;
      else if (!low && start >= 0) { runs.push({ x: start * PX8 - ox, y: ty * PX8 - oy, w: (tx - start) * PX8 }); start = -1; }
    }
  }
  // Level pixels outside the level are drawn by neither picture; show the base mode's picture there (nothing but sky).
  if (ox < 0 || oy < 0 || ox + W > world.width * PX8 || oy + H > world.height * PX8) { if (world.mode === 'low') anyLow = true; else any8 = true; }
  return { any8, anyLow, runs };
}

function drawFrames(ctx, world, ox, oy) {
  for (const z of world.zones) {
    if (!z.frame) continue;
    const x = z.x * PX8 - ox, y = z.y * PX8 - oy, w = z.w * PX8, h = z.h * PX8;
    if (x + w <= 0 || x >= W || y + h <= 0 || y >= H) continue;
    ctx.fillStyle = FRAME;
    ctx.fillRect(x, y, w, 1);
    ctx.fillRect(x, y + h - 1, w, 1);
    ctx.fillRect(x, y + 1, 1, h - 2);
    ctx.fillRect(x + w - 1, y + 1, 1, h - 2);
  }
}

// The wave's two edges: a bright one-pixel vertical line at each side of the band, the full height of the view (a band cut
// at the level's own side while it wraps has no line there). Nothing is drawn when the base mode is low-res: the band
// changes nothing visible there. In a world with areas at their own steps (`stepped`) the same: no lines while the band is at the
// room's own step.
function drawWaveEdges(ctx, world, ox, stepped = false) {
  if (!stepped && world.mode === 'low') return;
  for (const z of world.zones) {
    if (z.kind !== 'wave' || (stepped && zoneStep(z) === baseStep(world))) continue;
    ctx.fillStyle = WAVE_LINE;
    if (z.lineL) { const x = z.x * PX8 - ox; if (x >= 0 && x < W) ctx.fillRect(x, 0, 1, H); }
    if (z.lineR) { const x = (z.x + z.w) * PX8 - 1 - ox; if (x >= 0 && x < W) ctx.fillRect(x, 0, 1, H); }
  }
}

// A bright outline round each tile (the blocks that crushed the player).
function drawFlash(ctx, tiles, ox, oy) {
  for (const t of tiles) {
    const x = t.x * PX8 - ox, y = t.y * PX8 - oy;
    if (x + PX8 <= 0 || x >= W || y + PX8 <= 0 || y >= H) continue;
    ctx.fillStyle = FLASH_OUTER;
    ctx.fillRect(x, y, PX8, 1); ctx.fillRect(x, y + PX8 - 1, PX8, 1);
    ctx.fillRect(x, y + 1, 1, PX8 - 2); ctx.fillRect(x + PX8 - 1, y + 1, 1, PX8 - 2);
    ctx.fillStyle = FLASH_INNER;
    ctx.fillRect(x + 1, y + 1, PX8 - 2, 1); ctx.fillRect(x + 1, y + PX8 - 2, PX8 - 2, 1);
    ctx.fillRect(x + 1, y + 2, 1, PX8 - 4); ctx.fillRect(x + PX8 - 2, y + 2, 1, PX8 - 4);
  }
}

// ---- the swap's picture (a level without the slider, no zones) -------------------------------------------------------------
// When the whole room swaps, the picture does not cut: for a moment (sliderLook.js swapView, p from 0 = 8-bit to 1 = low-res) the
// 8-bit picture is seen in blocks of 2 x 2 pixels, then 4 x 4, then 8 x 8 (each block the average of its pixels, as the slider's
// move blurs), each fading into the next, and the last fades into the low-res picture. Back to 8-bit it plays backwards. The
// blocks are locked to the level's grid. The rules have changed already: both pictures are of the world as it is now.
let swapSet = null;
const M = PX8;                // the eased pictures are drawn from a tile edge, a tile bigger each way
function swapPics() {
  const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return { canvas: c, ctx: c.getContext('2d') }; };
  return (swapSet ??= { pics: [mk(W + M, H + M), mk((W + M) / 2, (H + M) / 2), mk((W + M) / 4, (H + M) / 4), mk((W + M) / 8, (H + M) / 8)], low: mk(W, H), base: mk(W + M, H + M) });
}
// The 8-bit picture an easing starts from (or ends at) is of a room that is 8-bit everywhere: things that only show in 8-bit (a laser's
// beam, a ladder) are in it, so they blur away with the rest instead of being gone at once. For the drawing the world answers
// "8-bit" for every tile; nothing else about it changes.
let zeroModes = null;
function as8bit(world, fn) {
  const keep = { mode: world.mode, tmode: world.tmode, base: world.tmodeBase, has8: world.has8 };
  world.mode = '8bit';
  if (keep.tmode) {
    if (!zeroModes || zeroModes.length !== keep.tmode.length) zeroModes = new Uint8Array(keep.tmode.length);
    world.tmode = zeroModes; world.tmodeBase = '8bit'; world.has8 = true;
  }
  try { fn(); } finally { world.mode = keep.mode; world.tmode = keep.tmode; world.tmodeBase = keep.base; world.has8 = keep.has8; }
}
function halveInto(from, to) {                                 // a 2 x 2 average of the picture before
  to.ctx.imageSmoothingEnabled = true;
  to.ctx.imageSmoothingQuality = 'low';
  to.ctx.drawImage(from.canvas, 0, 0, from.canvas.width, from.canvas.height, 0, 0, to.canvas.width, to.canvas.height);
}

// The same easing tile by tile, in a level with zones (sliderLook.js tileView: how far each tile's picture is): a column the wave
// has just taken, the tiles of a burst, a window that has just swapped. The picture is the compositor's (the 8-bit picture with
// the low-res one over the low-res tiles), and every tile on its way is drawn over it from the block pictures, as renderSwap fades.
function renderEasing(ctx, world, player, cam, opts, tiles, flash) {
  ensureModes(world);
  const { pics, low, base } = swapPics();
  const ox = px(cam.x), oy = px(cam.y);
  const gx = gridOrigin(ox, PX8), gy = gridOrigin(oy, PX8);
  const inner = { player: false, overlays: false };
  const cam8 = { x: gx.origin / PX8, y: gy.origin / PX8 };
  render8(base.ctx, world, player, cam8, { ...inner, extra: M });              // the room as it is: under everything
  as8bit(world, () => render8(pics[0].ctx, world, player, cam8, { ...inner, extra: M }));   // and all 8-bit: what the easing tiles blur from
  for (let k = 1; k <= 3; k++) halveInto(pics[k - 1], pics[k]);
  low.ctx.clearRect(0, 0, W, H);
  renderLow(low.ctx, world, player, cam, inner);
  const keep = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(base.canvas, -gx.offset, -gy.offset);
  for (const r of survey(world, ox, oy).runs) ctx.drawImage(low.canvas, r.x, r.y, r.w, PX8, r.x, r.y, r.w, PX8);
  const tx0 = Math.max(0, Math.floor(ox / PX8)), tx1 = Math.min(world.width - 1, Math.floor((ox + W - 1) / PX8));
  const ty0 = Math.max(0, Math.floor(oy / PX8)), ty1 = Math.min(world.height - 1, Math.floor((oy + H - 1) / PX8));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const p = tiles[ty * world.width + tx];
      if (p <= 0 || p >= 1) continue;
      const s = Math.min(3.999, p * 4), i = Math.floor(s), f = s - i;
      const x = tx * PX8 - ox, y = ty * PX8 - oy, sx = tx * PX8 - gx.origin, sy = ty * PX8 - gy.origin;
      for (const [k, alpha] of [[i, 1], [i + 1, f]]) {
        if (alpha <= 0) continue;
        ctx.globalAlpha = alpha;
        if (k === 4) ctx.drawImage(low.canvas, x, y, PX8, PX8, x, y, PX8, PX8);
        else { const b = 1 << k; ctx.drawImage(pics[k].canvas, sx / b, sy / b, PX8 / b, PX8 / b, x, y, PX8, PX8); }
      }
    }
  }
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = keep;
  drawFrames(ctx, world, ox, oy);
  drawWaveEdges(ctx, world, ox);
  if (flash) drawFlash(ctx, flash, ox, oy);
  if (!opts.hidePlayer) {
    const look = hasZones(world) ? modeOfBox(world, player.x, player.y, PLAYER_W, PLAYER_H) : world.mode;
    (look === '8bit' ? drawPlayer8 : drawPlayerLow)(ctx, player, cam);
  }
  if (world.has8) drawOverlays8(ctx, world, player);
}

// A picture drawn with the movable things as a snapshot has them (sliderLook.js swapView's `snap`), for the time it takes to draw.
function withThings(world, snap, fn) {
  const keep = { crates: world.crates, balls: world.balls, props: world.props };
  Object.assign(world, snap);
  try { fn(); } finally { Object.assign(world, keep); }
}
function asLow(world, fn) {
  const keep = world.mode;
  world.mode = 'low';
  try { fn(); } finally { world.mode = keep; }
}

function renderSwap(ctx, world, player, cam, opts, view) {
  const p = view.p;
  // The picture of the mode the room left shows the things where they were just before the swap.
  const old = (mode, fn) => (view.snap && view.from === mode ? withThings(world, view.snap, fn) : fn());
  const { pics, low } = swapPics();
  const gx = gridOrigin(px(cam.x), PX8), gy = gridOrigin(px(cam.y), PX8);
  const inner = { player: !opts.hidePlayer, overlays: false };
  const s = Math.min(3.999, Math.max(0, p * 4)), i = Math.floor(s), f = s - i;      // four fades: 1 > 2 > 4 > 8 > low-res
  old('8bit', () => as8bit(world, () => render8(pics[0].ctx, world, player, { x: gx.origin / PX8, y: gy.origin / PX8 }, { ...inner, extra: M })));
  for (let k = 1; k <= Math.min(3, i + 1); k++) halveInto(pics[k - 1], pics[k]);   // the halvings needed
  if (i === 3) old('low', () => asLow(world, () => renderLow(low.ctx, world, player, cam, inner)));
  const keep = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  const put = (k, alpha) => {
    if (alpha <= 0) return;
    ctx.globalAlpha = alpha;
    if (k === 4) ctx.drawImage(low.canvas, 0, 0);
    else ctx.drawImage(pics[k].canvas, 0, 0, pics[k].canvas.width, pics[k].canvas.height, -gx.offset, -gy.offset, W + M, H + M);
  };
  put(i, 1);
  put(i + 1, f);
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = keep;
}

// The world as the player sees it, then the grenades' extras on top: the areas' dashed frames, the grenades in flight and
// the held count (grenadeDraw.js).
export function render(ctx, world, player, cam = { x: 0, y: 0 }, opts = {}) {
  // A player an orange grenade caught is drawn in his low-res look wherever he is (world.js pixelateThings), here, on top; his figure
  // eases there from the look he had (sliderLook.js playerEase).
  const lowLook = !opts.hidePlayer && player.pixelated === true && !world.slider && !world.res;
  const pe = lowLook && opts.look && opts.look.playerEase ? opts.look.playerEase(world) : null;
  // The things at a zone's edge (edgeBands.js): the part of each on the low-res side goes down by steps as it goes in.
  const bands = bandPlan(world, player, opts);
  renderWorld(ctx, world, player, cam, lowLook || (bands && bands.player) ? { ...opts, hidePlayer: true } : opts);
  if (bands) {
    drawBands(ctx, world, player, cam, bands);
    drawFrames(ctx, world, px(cam.x), px(cam.y));              // (the frames and the wave's lines again, over the repainted tiles)
    drawWaveEdges(ctx, world, px(cam.x));
  }
  if (pe === null && lowLook) drawPlayerLow(ctx, player, cam);
  if (pe !== null) {
    const x = px(player.x) - PX8, y = px(player.y) - PX8;      // the scratch square: a tile round him
    easeSprite(ctx, pe, x - px(cam.x), y - px(cam.y), 4 * PX8, (s) => drawPlayer8(s, player, { x: x / PX8, y: y / PX8 }), () => drawPlayerLow(ctx, player, cam));
  }
  drawGrenades(ctx, world, cam, opts.look);
}

function renderWorld(ctx, world, player, cam, opts) {
  const flash = opts.flashTiles && opts.flashTiles.length > 0 ? opts.flashTiles : null;
  const zoned = hasZones(world);
  if (world.res && zoned) { renderStepped(ctx, world, player, cam, opts, flash); return; }
  if (world.slider && !zoned) {
    const view = lookView(world, opts);
    if (view) {
      renderSlider(ctx, world, player, cam, opts, view);
      if (flash) drawFlash(ctx, flash, px(cam.x), px(cam.y));
      return;
    }
  }
  const easing = !world.slider && !world.res && opts.look && opts.look.tileView ? opts.look.tileView(world) : null;
  if (easing) { renderEasing(ctx, world, player, cam, opts, easing, flash); return; }   // zones: some tiles' pictures are on their way
  const swap = !world.slider && !zoned && opts.look && opts.look.swapView ? opts.look.swapView(world) : null;
  if (swap) {                                          // the room has just swapped: its picture eases (renderSwap)
    renderSwap(ctx, world, player, cam, opts, swap);
    if (flash) drawFlash(ctx, flash, px(cam.x), px(cam.y));
    if (world.mode === '8bit') drawOverlays8(ctx, world, player);
    return;
  }
  if (!zoned && !flash && !opts.hidePlayer) {          // the old game: one picture, straight onto the canvas
    (world.mode === '8bit' ? render8 : renderLow)(ctx, world, player, cam);
    return;
  }
  const ox = px(cam.x), oy = px(cam.y);
  const inner = { player: false, overlays: false };
  let has8;
  if (!zoned) {
    (world.mode === '8bit' ? render8 : renderLow)(ctx, world, player, cam, inner);
    has8 = world.mode === '8bit';
  } else {
    ensureModes(world);
    const { any8, anyLow, runs } = survey(world, ox, oy);
    has8 = world.has8;
    if (!anyLow) render8(ctx, world, player, cam, inner);
    else if (!any8) renderLow(ctx, world, player, cam, inner);
    else {
      const a = layer(0), b = layer(1);
      a.ctx.clearRect(0, 0, W, H);
      b.ctx.clearRect(0, 0, W, H);
      render8(a.ctx, world, player, cam, inner);
      renderLow(b.ctx, world, player, cam, inner);
      ctx.drawImage(a.canvas, 0, 0);
      for (const r of runs) ctx.drawImage(b.canvas, r.x, r.y, r.w, PX8, r.x, r.y, r.w, PX8);
    }
    drawFrames(ctx, world, ox, oy);
    drawWaveEdges(ctx, world, ox);
  }
  if (flash) drawFlash(ctx, flash, ox, oy);
  if (!opts.hidePlayer) {
    const look = zoned ? modeOfBox(world, player.x, player.y, PLAYER_W, PLAYER_H) : world.mode;
    (look === '8bit' ? drawPlayer8 : drawPlayerLow)(ctx, player, cam);
  }
  if (has8) drawOverlays8(ctx, world, player);
}

// ---- a world with areas at their own steps (stage 4) -----------------------------------------------------------------
// Each tile's picture: ROOM for a tile that follows the room while the slider eases between steps, else the step it shows.
const ROOM = 0;
let stepLayers = null;       // the off-screen pictures of the stepped compositor, made when first needed (one per step on screen)
function stepLayer(i) {
  stepLayers ??= [];
  if (!stepLayers[i]) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    stepLayers[i] = { canvas: c, ctx: c.getContext('2d') };
  }
  return stepLayers[i];
}

// The pictures the view needs and, for each, its runs of tiles (per tile row, in screen pixels). Outside the level: the room's.
function surveySteps(world, ox, oy, moving) {
  const room = moving ? ROOM : baseStep(world);
  const keyAt = (tx, ty) => { const a = world.tarea[ty * world.width + tx]; return a !== 0 ? a : room; };
  const tx0 = Math.max(0, Math.floor(ox / PX8)), tx1 = Math.min(world.width - 1, Math.floor((ox + W - 1) / PX8));
  const ty0 = Math.max(0, Math.floor(oy / PX8)), ty1 = Math.min(world.height - 1, Math.floor((oy + H - 1) / PX8));
  const runs = new Map();     // key -> [{ x, y, w }]
  const add = (key, r) => { if (!runs.has(key)) runs.set(key, []); if (r) runs.get(key).push(r); };
  for (let ty = ty0; ty <= ty1; ty++) {
    let start = tx0, key = keyAt(tx0, ty);
    for (let tx = tx0 + 1; tx <= tx1 + 1; tx++) {
      const k = tx <= tx1 ? keyAt(tx, ty) : -1;
      if (k === key) continue;
      add(key, { x: start * PX8 - ox, y: ty * PX8 - oy, w: (tx - start) * PX8 });
      start = tx; key = k;
    }
  }
  if (ox < 0 || oy < 0 || ox + W > world.width * PX8 || oy + H > world.height * PX8) add(room, null);
  return { room, runs };
}

// One whole-room picture: the room's own (easing or at rest), or one step's. Every tile is put at that step while it is drawn
// (world.viewStep), with the whole room's terrain voted at it; the overlays are drawn once, on top, by the caller.
function drawStepPicture(ctx, world, player, cam, opts, key, view) {
  const player8 = { player: !opts.hidePlayer, overlays: false };
  if (key === ROOM) { renderSlider(ctx, world, player, cam, { ...opts, overlays: false }, view); return; }
  if (key === 4 || key === 2) { renderSlider(ctx, world, player, cam, { ...opts, overlays: false }, { step: key }); return; }
  const keep = { view: world.viewStep, mask: world.mask };
  world.viewStep = key;
  world.mask = maskOfStep(world, key);
  try { (key === 8 ? render8 : renderLow)(ctx, world, player, cam, player8); } finally { world.viewStep = keep.view; world.mask = keep.mask; }
}

// The step he is drawn in when he stands across the seam of two areas of different steps (null when all of him is in one): the step
// under his centre. His blocks hang from his own corner, so a figure cut in two by a seam would be two grids; he is drawn whole.
function seamStep(world, player, room) {
  const keyAt = (tx, ty) => {
    const a = world.tarea[Math.min(world.height - 1, Math.max(0, ty)) * world.width + Math.min(world.width - 1, Math.max(0, tx))];
    return a !== 0 ? a : room;
  };
  const keys = new Set();
  for (let ty = Math.floor(player.y); ty < Math.ceil(player.y + PLAYER_H); ty++) {
    for (let tx = Math.floor(player.x); tx < Math.ceil(player.x + PLAYER_W); tx++) keys.add(keyAt(tx, ty));
  }
  return keys.size < 2 ? null : keyAt(Math.floor(player.x + PLAYER_W / 2), Math.floor(player.y + PLAYER_H / 2));
}

// The player is in every picture and is cut at a seam like any thing, so each part of him shows the look of the tile he is in
// (except while the room eases, see seamStep: otherwise he is drawn whole, on top, in the step under his centre).
function renderStepped(ctx, world, player, cam, opts, flash) {
  ensureModes(world);
  const ox = px(cam.x), oy = px(cam.y);
  const view = world.slider ? lookView(world, opts) : null;
  const moving = view !== null && view.step === undefined;
  const { room, runs } = surveySteps(world, ox, oy, moving);
  const keys = [...runs.keys()];
  const whole = !moving && !opts.hidePlayer && keys.length > 1 ? seamStep(world, player, room) : null;
  if (whole !== null) opts = { ...opts, hidePlayer: true };
  if (keys.length === 1) drawStepPicture(ctx, world, player, cam, opts, keys[0], view);
  else {
    const back = runs.has(room) ? room : keys[0];       // the picture under the others: the room's (it has the most tiles)
    drawStepPicture(ctx, world, player, cam, opts, back, view);
    keys.filter((k) => k !== back).forEach((k, i) => {
      const l = stepLayer(i);
      l.ctx.clearRect(0, 0, W, H);
      drawStepPicture(l.ctx, world, player, cam, opts, k, view);
      for (const r of runs.get(k)) ctx.drawImage(l.canvas, r.x, r.y, r.w, PX8, r.x, r.y, r.w, PX8);
    });
  }
  if (whole !== null) (whole === 8 ? drawPlayer8 : whole === 1 ? drawPlayerLow : (c, p, k) => drawPlayerCrisp(c, p, k, whole))(ctx, player, cam);
  drawFrames(ctx, world, ox, oy);
  drawWaveEdges(ctx, world, ox, true);
  if (flash) drawFlash(ctx, flash, ox, oy);
  if (keys.some((k) => k !== 1)) drawOverlays8(ctx, world, player);
}

// How the pages draw the player and the world during a death sequence (sim.dying): the player hops and falls
// (gone when they fell out of the level), and a crush flashes the tiles that crushed them (blinking) before the hop.
// -> { player, opts } to pass to render(ctx, world, player, cam, opts); the camera still follows sim.player.
export function dyingView(sim) {
  const dying = dyingReport(sim);
  if (!dying) return { player: sim.player, opts: {} };
  const off = deathOffset(dying);
  if (off === null) return { player: sim.player, opts: { hidePlayer: true } };
  const opts = {};
  if (dying.tiles.length > 0 && dying.elapsed < dying.flash && Math.floor(dying.elapsed / 0.08) % 2 === 0) opts.flashTiles = dying.tiles;
  return { player: { ...sim.player, y: sim.player.y + off, vx: 0, vy: 0, onGround: false }, opts };
}
