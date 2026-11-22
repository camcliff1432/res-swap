// Moving platform: travels `distance` tiles in `dir` at PLATFORM_SPEED, then back, forever.
// 8-bit: smooth, a half-tile slab. Low-res: a one-tile block at the rounded position, and its clock stops: every platform stands
// still in low-res (the owner's choice, for consistency; it used to hop on unless it was `geared`). At the resolution slider's
// step 2 it lives in low-res on the half-tile grid (zones.js gridCell): a half-tile slab, standing still.
// `geared` now only draws the small gear (room 20). Riders are carried; see step(). Crates (and, in low-res, balls) resting
// on it are carried too, with what is stacked on them (objects.js carryRiders); in 8-bit a ball is not (it stays, the slab slides under it).
// State on each instance: ox, oy (where it was placed), t (clock, seconds), carries, alt (the other-mode box).
import { PX8, PLAYER_W, PLAYER_H, PLATFORM_SPEED } from '../constants.js';
import { boxHitsSolid, stepBoxes } from '../world.js';
import { platformRiders, releaseRiders, holdRiders, carryRiders } from '../objects.js';
import { thingMode, zoned, modeOfBox, gridCell, thingStep, stepOfBox, markStep } from '../zones.js';
import { px, EPS, overlaps } from './common.js';

const DIRS = ['right', 'left', 'up', 'down'];
const VEC = { right: [1, 0], left: [-1, 0], up: [0, -1], down: [0, 1] };
const DIST_MIN = 1, DIST_MAX = 32, WIDTH_MIN = 1, WIDTH_MAX = 4;
const THIN = 0.5;                       // 8-bit thickness, tiles
const PIXEL = 1 / PX8;

const SLAB = '#BCBCBC', SLAB_LIGHT = '#FCFCFC', SLAB_DARK = '#7C7C7C', RAIL = '#7C7C7C', GEAR = '#3C3C3C';
const LOW_COLOUR = '#AFAFAF';      // what its picture averages to (a grey slab); it was a light blue (#A4E4FC)

const okInt = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const dirOf = (o) => (DIRS.includes(o.dir) ? o.dir : 'right');
const widthOf = (o) => (okInt(o.width, WIDTH_MIN, WIDTH_MAX) ? o.width : 2);
const distOf = (o) => (okInt(o.distance, DIST_MIN, DIST_MAX) ? o.distance : 4);

// Distance along the path (0..distance) at clock t: out and back.
function pathS(p, t) {
  const L = 2 * p.distance;
  const u = (t * PLATFORM_SPEED) % L;
  return u <= p.distance ? u : L - u;
}

// The platform's box when it is `s` tiles along its path, in the given mode; in low-res on a grid of `cell` tiles (a whole
// tile, or half a tile at the slider's step 2: then it is as thick as the 8-bit slab).
function boxAt(p, s, mode, cell = 1) {
  const [dx, dy] = VEC[p.dir];
  const k = mode === 'low' ? Math.round(s / cell) * cell : Math.round(s * 1e9) / 1e9;     // (no float dust: the top can sit exactly on a pixel row)
  return { x: p.ox + dx * k, y: p.oy + dy * k, w: p.width, h: mode === 'low' ? cell : THIN };
}

// The box the platform has at a step of the resolution slider (slider.js): its 8-bit slab at steps 8 and 4, on the half-tile
// grid at step 2, a block on whole tiles at step 1. Where it is on its path is its clock's to say, so every step has its own box.
const boxAtStep = (p, s, step) => boxAt(p, s, step <= 2 ? 'low' : '8bit', step === 2 ? 0.5 : 1);
export const platformBoxAtStep = (p, step) => boxAtStep(p, pathS(p, p.t), step);
// (Stage 4: a stepped world changes a platform's step across a seam with the box its clock gives there, world.js.)
stepBoxes.platform = (p, step) => ({ box: { ...platformBoxAtStep(p, step), solid: true } });

// Keep the other-mode box current. (A stepped world: the box the other picture shows it at, low-res or 8-bit.)
function refreshAlt(world, p) {
  const b = world.res ? boxAtStep(p, pathS(p, p.t), thingStep(world, p) === 1 ? 8 : 1)
    : boxAt(p, pathS(p, p.t), thingMode(world, p) === '8bit' ? 'low' : '8bit', gridCell(world));
  p.alt = { x: b.x, y: b.y, w: b.w, h: b.h, solid: true };
}

// Heads back from where it is: mirror the clock within the out-and-back cycle.
function reverse(p) {
  const L = 2 * p.distance;
  const u = (p.t * PLATFORM_SPEED) % L;
  p.t = ((L - u) % L) / PLATFORM_SPEED;
}

// Standing on it: on the ground, feet level with its top (within a pixel, since the player's own
// movement snaps to pixels), overlapping it sideways.
function rides(p, player) {
  if (!player.onGround || player.onLadder || player.vy < 0) return false;
  const gap = p.y - (player.y + PLAYER_H);
  if (gap < -EPS || gap > PIXEL + EPS) return false;
  return player.x < p.x + p.w - EPS && player.x + PLAYER_W > p.x + EPS;
}

function stepPlatform(world, player, p, dt) {
  const mode = thingMode(world, p);
  const rider = rides(p, player);
  const settle = () => {
    // A rider the platform did not move still ends up exactly on its top, on the ground.
    if (!rider) return;
    const y = p.y - PLAYER_H;
    if (Math.abs(player.y - y) > 1e-9 && !boxHitsSolid(world, player.x, y, PLAYER_W, PLAYER_H, world.mode, p)) player.y = y;
    player.onGround = true;
    player.vy = 0;
  };
  const done = () => { refreshAlt(world, p); };
  // Crates and balls resting on it now; those that rode it last step and no longer do leave with its velocity.
  const riders = platformRiders(world, p);
  releaseRiders(world, p, riders);
  // The platform's velocity this step along its path (tiles/s), also in low-res where it hops.
  const velocity = () => {
    const [ux, uy] = VEC[p.dir], v = (pathS(p, p.t + dt) - pathS(p, p.t)) / dt;
    return [ux * v, uy * v];
  };
  // A step in which it does not move (blocked, waiting, frozen): the riders stay and keep its velocity.
  const still = (frozen = false) => {
    settle();
    const [vx, vy] = frozen ? [0, 0] : velocity();
    holdRiders(riders, null, p, vx, vy);
    done();
  };

  if (mode === 'low') { still(true); return; }             // low-res: it stands still, its clock stopped

  const t2 = p.t + dt;
  let nb = boxAt(p, pathS(p, t2), mode, gridCell(world, p));
  // With zones: a platform whose next box is centred in a tile of the other mode changes over as it moves there (a slab
  // becomes a block or back). A move that is not possible is blocked like any other: it turns round. (A stepped world: of
  // another step, with the box its clock gives at that step.)
  let nbMode = mode;
  const step = world.res ? thingStep(world, p) : 0;
  let nbStep = step;
  if (world.res && zoned(world) && !p.forceLow) {
    const want = stepOfBox(world, nb.x, nb.y, nb.w, nb.h);
    if (want !== step) {
      const alt = boxAtStep(p, pathS(p, t2), want);
      if (stepOfBox(world, alt.x, alt.y, alt.w, alt.h) === want) { nb = alt; nbStep = want; nbMode = want <= 2 ? 'low' : '8bit'; }
    }
  } else if (zoned(world) && !p.forceLow) {
    const want = modeOfBox(world, nb.x, nb.y, nb.w, nb.h);
    if (want !== mode) {
      const alt = boxAt(p, pathS(p, t2), want, gridCell(world));
      if (modeOfBox(world, alt.x, alt.y, alt.w, alt.h) === want) { nb = alt; nbMode = want; }
    }
  }
  if (nbMode === mode && nbStep === step && nb.x === p.x && nb.y === p.y) { const [vx, vy] = velocity(); p.t = t2; settle(); holdRiders(riders, null, p, vx, vy); done(); return; }

  // Terrain, crates, balls, doors, other solid props, the level edge: turn round instead. (What rides it does not count:
  // it is carried; one that cannot be carried is found out below.)
  const ignore = new Set([p, ...riders.map((r) => r.t)]);
  if (nb.y + nb.h > world.height || boxHitsSolid(world, nb.x, nb.y, nb.w, nb.h, world.mode, ignore)) {
    reverse(p); still(); return;
  }

  const dx = nb.x - p.x, dy = nb.y - p.y;
  const pb = { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H };
  let carryTo = null;
  if (rider) {
    const c = { x: player.x + dx, y: nb.y - PLAYER_H };
    if (!boxHitsSolid(world, c.x, c.y, PLAYER_W, PLAYER_H, world.mode, p)) carryTo = c;
  }
  let push = null;
  if (!carryTo && overlaps(pb, nb)) {
    // In the way. Sideways: push along if there is room; otherwise (and vertically) wait.
    if (dy !== 0 || dx === 0) { still(); return; }
    const x = dx > 0 ? nb.x + nb.w : nb.x - PLAYER_W;
    if (boxHitsSolid(world, x, player.y, PLAYER_W, PLAYER_H, world.mode, p)) { still(); return; }
    push = x;
  }

  const was = { x: p.x, y: p.y, w: p.w, h: p.h, mode: p.mode, ...(world.res ? { step: p.step } : {}) }, playerWas = { x: player.x, y: player.y, onGround: player.onGround, vy: player.vy };
  const [vx, vy] = velocity();
  p.x = nb.x; p.y = nb.y; p.w = nb.w; p.h = nb.h;
  if (world.res) { if (nbStep !== step) markStep(p, nbStep); } else if (nbMode !== mode) p.mode = nbMode;
  if (carryTo) {
    player.x = carryTo.x; player.y = carryTo.y; player.onGround = true; player.vy = 0;
  } else if (push !== null) {
    player.x = push;
  }
  const carried = carryRiders(world, player, p, riders, dx, dy);
  // A rider left behind in the way (a crate under a low ceiling, as the platform comes up): it blocks the platform as it always did.
  if (riders.length && boxHitsSolid(world, p.x, p.y, p.w, p.h, world.mode, p)) {
    carried.undo();
    Object.assign(p, was);
    Object.assign(player, playerWas);
    reverse(p); still(); return;
  }
  p.t = t2;
  holdRiders(riders, carried.carried, p, vx, vy);
  done();
}

export default {
  type: 'platform',
  label: 'Platform',
  defaults: { dir: 'right', distance: 4, width: 2, geared: false },
  fields: [
    { key: 'dir', label: 'Direction', kind: 'choice', options: DIRS },
    { key: 'distance', label: 'Distance', kind: 'int', min: DIST_MIN, max: DIST_MAX },
    { key: 'width', label: 'Width', kind: 'int', min: WIDTH_MIN, max: WIDTH_MAX },
    { key: 'geared', label: 'Geared', kind: 'bool' },
  ],
  size: (o) => [widthOf(o), 1],
  check(o) {
    if (!DIRS.includes(o.dir)) return `dir must be one of ${DIRS.join(', ')}`;
    if (!okInt(o.distance, DIST_MIN, DIST_MAX)) return `distance must be a whole number from ${DIST_MIN} to ${DIST_MAX}`;
    if (!okInt(o.width, WIDTH_MIN, WIDTH_MAX)) return `width must be a whole number from ${WIDTH_MIN} to ${WIDTH_MAX}`;
    if (typeof o.geared !== 'boolean') return 'geared must be true or false';
    return null;
  },
  solid: true,
  reaches: true,
  // Called by the level parser on each new instance.
  place(inst) {
    inst.ox = inst.x;
    inst.oy = inst.y;
    inst.t = 0;
    inst.carries = true;
    inst.h = THIN;
    inst.alt = { x: inst.x, y: inst.y, w: inst.w, h: 1, solid: true };
  },
  draw8(ctx, inst) {
    const width = widthOf(inst), dist = distOf(inst), dir = dirOf(inst);
    const ox = inst.ox ?? inst.x, oy = inst.oy ?? inst.y;
    const [dx, dy] = VEC[dir];
    // Dotted rail along the path, behind the slab.
    ctx.fillStyle = RAIL;
    if (dx !== 0) {
      const y = px(oy) + 2;
      const x0 = px(Math.min(ox, ox + dx * dist)), x1 = px(Math.max(ox, ox + dx * dist) + width);
      for (let x = x0; x < x1; x += 2) ctx.fillRect(x, y, 1, 1);
    } else {
      const x = px(ox) + width * 4;
      const y0 = px(Math.min(oy, oy + dy * dist)), y1 = px(Math.max(oy, oy + dy * dist)) + 4;
      for (let y = y0; y < y1; y += 2) ctx.fillRect(x, y, 1, 1);
    }
    const x = px(inst.x), y = px(inst.y), w = width * PX8;
    ctx.fillStyle = SLAB_DARK;
    ctx.fillRect(x, y, w, 4);
    ctx.fillStyle = SLAB;
    ctx.fillRect(x, y, w, 3);
    ctx.fillStyle = SLAB_LIGHT;
    ctx.fillRect(x, y, w, 1);
    if (inst.geared) {
      ctx.fillStyle = GEAR;                       // a small gear at the left end
      ctx.fillRect(x, y + 1, 4, 2);
      ctx.fillRect(x + 1, y, 2, 4);
      ctx.fillStyle = SLAB_LIGHT;
      ctx.fillRect(x + 1, y + 1, 2, 2);
    }
  },
  drawLow(ctx, inst) {
    ctx.fillStyle = LOW_COLOUR;
    ctx.fillRect(px(inst.x), px(inst.y), px(inst.w), px(inst.h));
  },
  step(world, player, held, dt) {
    for (const p of world.props) if (p.type === 'platform') stepPlatform(world, player, p, dt);
  },
};
