// Zones: which mode (8-bit or low-res) each tile of the world is in. The world has a base mode (`world.mode`, what
// the player's swap or the timer flips) and a list of zones, rectangles in whole tiles { x, y, w, h, mode }, later
// ones winning where they overlap; inside a zone the zone's mode holds whatever the base mode is. A window is a zone
// that stays put; the wave (a later stage) is one that travels. Imports only constants: no props, objects or physics.
//
// The map is `world.tmode` (Uint8Array(width * height), 0 = 8-bit, 1 = low-res) for the base mode as it is now, and
// `world.tmodeAlt` for the base mode the swap would give (the swap checks ask "what will the terrain be after?").
// Both are rebuilt by rebuildModes; setZones replaces the zone list and rebuilds. A world without zones never reads
// the maps: every question is answered by the base mode alone, exactly as before zones existed.
//
// Steps (the resolution slider's stage 4: areas with a step value). A zone may carry a `step` (8, 4, 2 or 1: how many blocks
// fit across a tile, see slider.js); one without a step is in its mode (8-bit is step 8, low-res step 1), as ever. A world
// whose level has the slider, or any area at a middle step (4 or 2), is STEPPED: it keeps `world.res = { base, voted }` (the
// original picture and its re-votes, made on use) and every tile holds a step, `world.tstep` (Uint8Array, the step values):
// the room's own step (the slider's, or 8 / 1 by the base mode) and inside each zone the zone's step, later zones winning.
// `world.tstepAlt` is the map after a swap (a two-mode room). Blocks never cross a tile line, so each tile is voted on its own
// at its own step: `world.mask` is then the picture voted tile by tile at each tile's step (the original picture where the
// step is 8 or 1; a step-1 tile is read through the low-res grid, `tmode` 1, as ever). tmode is still 0 / 1: a tile at step
// 8, 4 or 2 has 8-bit rules on its (voted) pixels, a tile at step 1 is low-res. A world that is not stepped never has
// `world.res` and never comes near any of this.
import { PX8 } from './constants.js';
import { wins } from './vote.js';

const otherMode = (m) => (m === '8bit' ? 'low' : '8bit');

export const hasZones = (world) => Array.isArray(world.zones) && world.zones.length > 0;

// ---- steps ------------------------------------------------------------------------------------------------------
export const STEPS = [8, 4, 2, 1];
export const BLOCK = { 8: 1, 4: 2, 2: 4, 1: 8 };    // level pixels per block at each step
export const fineStep = (step) => step >= 4;      // steps 8 and 4 move things as bodies; 2 and 1 on a grid (slider.js)
export const CELL = { 2: 0.5, 1: 1 };              // the grid of a grid step, in tiles
// The step a zone holds: its own, or its mode's.
// An `opposite` zone (a window set to Opposite) is always at the other end from the room: low-res in an 8-bit room, 8-bit in a
// low-res one; on the slider 8 <-> 1 and 4 <-> 2. `room` is the room's step (needed only for such a zone).
export const OPPOSITE = { 8: 1, 4: 2, 2: 4, 1: 8 };
export const zoneStep = (z, room) => (z.opposite ? OPPOSITE[room] ?? 1 : z.step ?? (z.mode === 'low' ? 1 : 8));
// The room's own step: the slider's, else the base mode's.
export const baseStep = (world) => (world.slider ? world.slider.step : world.mode === 'low' ? 1 : 8);

// The mask re-voted into blocks of `block` pixels, at the full size of the mask (a block is solid when more than half of
// it is filled; a tie loses: vote.js). Block 1 is the picture itself.
export function voteMask(mask, maskW, maskH, block) {
  if (block === 1) return mask;
  const out = new Uint8Array(mask.length);
  for (let by = 0; by < maskH; by += block) {
    for (let bx = 0; bx < maskW; bx += block) {
      let n = 0;
      for (let y = by; y < by + block; y++) for (let x = bx; x < bx + block; x++) n += mask[y * maskW + x];
      if (!wins(n, block * block)) continue;
      for (let y = by; y < by + block; y++) out.fill(1, y * maskW + bx, y * maskW + bx + block);
    }
  }
  return out;
}

// The whole room's terrain voted at a step (the original picture at 8 and 1), made once per step and kept.
export function maskOfStep(world, step) {
  const r = world.res;
  if (step === 8 || step === 1) return r.base;
  return (r.voted[step] ??= voteMask(r.base, world.maskW, world.maskH, BLOCK[step]));
}

// The tile map of steps for a room step and a zone list.
export function buildStepMap(width, height, base, zones, room = base) {
  const map = new Uint8Array(width * height).fill(base);
  for (const z of zones) {
    const v = zoneStep(z, room);
    const x0 = Math.max(0, Math.floor(z.x)), x1 = Math.min(width, Math.ceil(z.x + z.w));
    const y0 = Math.max(0, Math.floor(z.y)), y1 = Math.min(height, Math.ceil(z.y + z.h));
    for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) if (!z.mask || z.mask[(ty - z.y) * z.w + (tx - z.x)] === 1) map[ty * width + tx] = v;
  }
  return map;
}

// The picture each tile is voted at (world.mask): the whole room's voted picture when every tile is at one step (the very same
// array, as stage 1 had it), else a copy made tile by tile.
function composeMask(world) {
  const map = world.tstep, first = map[0];
  if (map.every((s) => s === first)) { world.mask = maskOfStep(world, first); return; }
  const { maskW } = world;
  const out = (world.res.mask ??= new Uint8Array(world.res.base.length));
  for (let ty = 0; ty < world.height; ty++) {
    for (let tx = 0; tx < world.width; tx++) {
      const src = maskOfStep(world, map[ty * world.width + tx]);
      for (let y = ty * PX8; y < ty * PX8 + PX8; y++) {
        const i = y * maskW + tx * PX8;
        out.set(src.subarray(i, i + PX8), i);
      }
    }
  }
  world.mask = out;
}

function rebuildSteps(world) {
  const zones = world.zones || [];
  const base = baseStep(world), alt = world.slider ? base : base === 1 ? 8 : 1;
  world.tstep = buildStepMap(world.width, world.height, base, zones);
  world.tarea = buildStepMap(world.width, world.height, 0, zones, base);   // an area's own step, 0 where the tile follows the room
  world.tstepAlt = alt === base ? world.tstep : buildStepMap(world.width, world.height, alt, zones);
  world.tmode = world.tstep.map((s) => (s === 1 ? 1 : 0));
  world.tmodeAlt = world.tstepAlt.map((s) => (s === 1 ? 1 : 0));
  world.tmodeBase = world.mode;
  world.tstepBase = base;
  world.has8 = world.tmode.includes(0);
  composeMask(world);
}

// The step of tile (tx, ty). Outside the level: the room's step. `world.viewStep` (set only while a picture of one step is
// drawn, renderSlider.js) answers for every tile. A world that is not stepped: 8 or 1 by the tile's mode, or the slider's.
export function stepAt(world, tx, ty) {
  if (world.viewStep) return world.viewStep;
  if (!world.res) return modeAt(world, tx, ty) === 'low' ? 1 : 8;
  if (tx < 0 || ty < 0 || tx >= world.width || ty >= world.height || !hasZones(world)) return baseStep(world);
  ensureModes(world);
  return world.tstep[ty * world.width + tx];
}

// The step of the tile holding the centre of a box (tiles).
export const stepOfBox = (world, x, y, w, h) => stepAt(world, Math.floor(x + w / 2), Math.floor(y + h / 2));

// The step of tile (tx, ty) in the map for base mode `base` (the map after a swap when `base` is not the world's mode).
export function stepIn(world, base, tx, ty) {
  if (!hasZones(world) || tx < 0 || ty < 0 || tx >= world.width || ty >= world.height) return base === world.mode ? baseStep(world) : base === 'low' ? 1 : 8;
  ensureModes(world);
  return (base === world.mode ? world.tstep : world.tstepAlt)[ty * world.width + tx];
}

// The tile map for a base mode and a zone list.
export function buildModeMap(width, height, base, zones) {
  const map = new Uint8Array(width * height);
  if (base === 'low') map.fill(1);
  for (const z of zones) {
    const v = z.opposite ? (base === 'low' ? 0 : 1) : z.mode === 'low' ? 1 : 0;
    const x0 = Math.max(0, Math.floor(z.x)), x1 = Math.min(width, Math.ceil(z.x + z.w));
    const y0 = Math.max(0, Math.floor(z.y)), y1 = Math.min(height, Math.ceil(z.y + z.h));
    // A zone with a `mask` (a grenade's circle: Uint8Array(w * h) over its box) covers only the tiles the mask sets.
    for (let ty = y0; ty < y1; ty++) for (let tx = x0; tx < x1; tx++) if (!z.mask || z.mask[(ty - z.y) * z.w + (tx - z.x)] === 1) map[ty * width + tx] = v;
  }
  return map;
}

// Rebuild both maps from world.mode and world.zones.
export function rebuildModes(world) {
  if (world.res) { rebuildSteps(world); return; }
  const zones = world.zones || [];
  world.tmode = buildModeMap(world.width, world.height, world.mode, zones);
  world.tmodeAlt = buildModeMap(world.width, world.height, otherMode(world.mode), zones);
  world.tmodeBase = world.mode;
  world.has8 = world.tmode.includes(0);
}

// Make sure the maps match the base mode (code that sets world.mode by hand is caught here).
export function ensureModes(world) {
  if (!world.tmode || world.tmodeBase !== world.mode || (world.res && world.tstepBase !== baseStep(world))) rebuildModes(world);
}

// Is the world in "per-thing" mode? True while there are zones, and after zones were ever set until every mover has
// come back to the base mode (world.zonedThings, kept by world.js reconcileModes). A world that is not zoned answers
// every question by the base mode alone, exactly as before zones existed.
export const zoned = (world) => hasZones(world) || world.zonedThings === true;

// The things that live in a mode of their own (balls, crates, small crates, props with an `alt` box: platform, blade).
// Each remembers the mode it lives in as `.mode`; a thing that has none (a test pushed it in by hand) follows the base.
export function eachMover(world, fn) {
  for (const c of world.crates) fn(c);
  for (const b of world.balls) fn(b);
  for (const p of world.props) if (p.type === 'smallcrate' || p.alt) fn(p);
}

// The mode a mover lives in: its own memory in a zoned world, the base mode otherwise.
// A thing a "things" grenade has gone off over (`forceLow`, world.js pixelateThings) lives in low-res for good, whatever the
// base mode, the zones, the wave or a swap say. At the resolution slider's step 2 (slider.js) every mover lives in low-res
// too, on a grid of half tiles, while the world itself (its terrain, the player, the things that do not move) is 8-bit.
const gridStep = (world) => world.slider !== undefined && world.slider.step === 2;
// In a stepped world a mover remembers the STEP it lives at (`.step`, kept with `.mode` beside it: 'low' at the grid steps 2
// and 1, '8bit' at the fine steps 8 and 4) while the world is zoned; otherwise it lives at the room's step.
export const thingStep = (world, t) => (t.forceLow ? 1 : !world.res ? (thingMode(world, t) === 'low' ? 1 : 8)
  : zoned(world) && t.step !== undefined ? t.step : baseStep(world));
export const thingMode = (world, t) => (world.res ? (thingStep(world, t) <= 2 ? 'low' : '8bit')
  : t.forceLow || gridStep(world) ? 'low' : zoned(world) ? (t.mode ?? world.mode) : world.mode);
// Set the step a mover lives at (and its mode with it).
export const markStep = (t, step) => { t.step = step; t.mode = step <= 2 ? 'low' : '8bit'; };

// The grid a low-res mover moves on, in tiles: a whole tile, or half a tile at the slider's step 2. (Every world without the
// slider: 1, and the low-res movement is then exactly what it always was.) Given the thing, its own grid (a stepped world's
// areas put things at different steps at once).
export const gridCell = (world, t) => (t !== undefined && world.res ? (thingStep(world, t) === 2 ? 0.5 : 1) : gridStep(world) ? 0.5 : 1);

// The terrain a low-res mover collides with, as a mode for terrainHitsBox: the low-res grid; at the slider's step 2 the
// world's own terrain (8-bit: the mask voted in blocks of 4 x 4 pixels, which are exactly the cells of that grid).
export const gridTerrainMode = (world) => (gridStep(world) ? world.mode : 'low');

// The picture a mover belongs to: the low-res picture at step 1, the 8-bit one (voted or not) at the other steps.
const pictureMode = (world, t) => (world.res ? (thingStep(world, t) === 1 ? 'low' : '8bit') : (t.mode ?? world.mode));

// Does the picture of `mode` draw this thing? A mover (crate, ball, small crate, platform, blade) is drawn only by the
// picture of the mode it lives in; static things are in both pictures (the compositor shows each only where its mode is).
// A forced-low thing is drawn by neither picture: the compositor draws it on top, in its low-res look (grenadeDraw.js).
export function drawnIn(world, t, mode) {
  if (t.forceLow || t.easeHide) return false;      // (easeHide: left out for one drawing, edgeBands.js)
  if (!zoned(world)) return true;
  if (t.type !== undefined && t.type !== 'smallcrate' && !t.alt) return true;
  return pictureMode(world, t) === mode;
}

// How the picture of `mode` draws a thing: a list of things to draw (empty: not drawn). A world with zones draws every
// mover in BOTH pictures, so the compositor can show each tile's part of a thing straddling a zone edge in that tile's mode:
// its own mode's picture gets the thing itself, the other picture its look in that mode (the box it would have there):
//   crate, ball in low-res: a block at the whole tile it would snap to; a low-res one in 8-bit: its sprite, untilted;
//   small crate in low-res: its whole tile (once for all that share it); a low-res block in 8-bit: its halves;
//   prop with an `alt` box (platform, blade): a shallow copy at its alt box. Never changes the real thing.
// Without zones this is exactly drawnIn: the thing, or nothing.
export function looksIn(world, t, mode) {
  if (t.forceLow || t.easeHide) return [];
  if (drawnIn(world, t, mode)) return [t];
  if (!hasZones(world)) return [];
  if (t.type === 'smallcrate') {
    if (mode === 'low') {
      const tileX = (p) => Math.floor(p.x + p.w / 2 + 1e-9);          // the tile holding its centre across (world.js smallBlocks)
      const x = tileX(t), y = Math.floor(t.y);
      const mates = world.props.filter((p) => p.type === 'smallcrate' && pictureMode(world, p) !== 'low' && tileX(p) === x && Math.floor(p.y) === y);
      if (mates[0] !== t) return [];
      return [{ ...t, x, y, w: 1, h: 1, count: mates.reduce((n, p) => n + (p.count || 1), 0) }];
    }
    const x = Math.floor(t.x), n = t.count === 2 ? 2 : 1;
    return Array.from({ length: n }, (_, i) => ({ ...t, x: x + i * 0.5, w: 0.5, count: 1 }));
  }
  if (t.alt) return [{ ...t, ...t.alt }];
  if (mode === 'low') return [{ ...t, x: Math.round(t.x), y: Math.round(t.y), tilt: 0 }];
  return [{ ...t, tilt: 0 }];
}

// The one way to set or replace the zone list (a window never moves, but the wave does, between steps). Things keep
// the mode they live in; the next step (reconcileModes in world.js) moves them to the mode of where they now are.
export function setZones(world, zones) {
  if (!zoned(world)) {                    // not zoned until now: everything is in the base mode (a stepped world: at the room's step)
    if (world.res) eachMover(world, (t) => markStep(t, thingStep(world, t)));
    else eachMover(world, (t) => { t.mode = world.mode; });
  }
  world.zones = zones.map((z) => ({ ...z }));
  world.zonedThings = true;
  world.zonesMoved = true;      // reconcileModes then makes sure no thing is left in terrain (world.js)
  rebuildModes(world);
}

// The mode of tile (tx, ty): '8bit' or 'low'. Outside the level counts as the base mode.
export function modeAt(world, tx, ty) {
  if (!hasZones(world)) return world.mode;
  if (tx < 0 || ty < 0 || tx >= world.width || ty >= world.height) return world.mode;
  ensureModes(world);
  return world.tmode[ty * world.width + tx] === 1 ? 'low' : '8bit';
}

// The mode of a thing with a box (tiles): the mode of the tile holding its centre. A thing asks for its own mode here.
export function modeOfBox(world, x, y, w, h) {
  if (!hasZones(world)) return world.mode;
  return modeAt(world, Math.floor(x + w / 2), Math.floor(y + h / 2));
}

export const in8bit = (world, x, y, w, h) => modeOfBox(world, x, y, w, h) === '8bit';

// Zones that the world's props make: each window, in prop order. A window with a step carries it (a step of 8 or 1 is simply
// its mode; the zone then has no step, exactly as a window without one).
export function zonesFromProps(props) {
  const zones = [];
  for (const p of props || []) {
    if (p.type !== 'window') continue;
    const z = { x: p.x, y: p.y, w: p.w, h: p.h, mode: p.mode === '8bit' ? '8bit' : 'low', frame: true, kind: 'window' };
    if (p.mode === 'opposite') { zones.push({ ...z, opposite: true }); continue; }      // (it has no step of its own)
    zones.push(withStep(z, p.step));
  }
  return zones;
}

// A zone with an optional step: 8 and 1 set its mode, 4 and 2 are kept as its step (its mode is then the step's: 8-bit rules
// on a voted picture). No step: the zone as it was.
export function withStep(z, step) {
  if (step === 8 || step === 1) return { ...z, mode: step === 1 ? 'low' : '8bit' };
  if (step === 4 || step === 2) return { ...z, mode: '8bit', step };
  return z;
}
// Is this a middle step (an area that makes the world stepped)?
export const middle = (step) => step === 4 || step === 2;

// Terrain test through the map: the box (tiles) against the mask and the low-res grid, tile by tile, in the map for
// base mode `base`. Where a tile is 8-bit the pixel mask decides; where it is low-res the vote does. The crates'
// pixels (world.dyn: only the crates that live in 8-bit) are solid everywhere, except those owned by `ignore` (a crate
// number or a Set of them).
export function zonedTerrainHits(world, x, y, w, h, base, ignore) {
  const skip = ignore instanceof Set ? (v) => ignore.has(v) : (v) => v === ignore;
  ensureModes(world);
  const map = base === world.mode ? world.tmode : world.tmodeAlt;
  const { maskW: cols, maskH: rows, mask, low } = world;
  const x0 = Math.floor(x * PX8), x1 = Math.ceil((x + w) * PX8) - 1;
  const y0 = Math.floor(y * PX8), y1 = Math.min(Math.ceil((y + h) * PX8) - 1, rows - 1);
  const dyn = world.dyn;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const tx = cx >> 3, ty = cy >> 3;
      if (map[ty * world.width + tx] === 1) { if (low.cells[ty * low.cols + tx] === 1) return true; }
      else if (mask[cy * cols + cx] === 1) return true;
      if (dyn && dyn[cy * cols + cx] !== 0 && !skip(dyn[cy * cols + cx])) return true;
    }
  }
  return false;
}
