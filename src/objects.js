import {
  PX8, PLAYER_W, PLAYER_H, CRATE_SIZE, DOOR_W, DOOR_H, DETAIL_H, BALL_SIZE, GRAVITY, MAX_FALL, RUN_SPEED, BALL_SLOPE_ACCEL,
  BALL_FRICTION, BALL_MAX_SPEED, ICE_SLOPE_ACCEL, CRATE_PUSH_SPEED, EDGE_GLIDE_SPEED, CRATE_FRICTION, CRATE_TILT_EASE, CRATE_DRIFT, ICE_IN_LOW,
  SPRING_SPEED, PUSH_COOLDOWN,
} from './constants.js';
import { boxHitsSolid, iceActive, iceUnder, solidBoxes, settleMove, snapForced } from './world.js';
import { rasterSquare, rasterRect, cratePose, stampCrate, unstampCrate, syncDyn, dynOwnerInBox, CRATE_HALF } from './dyn.js';
import { moveBody } from './motion.js';
import { heldByChain } from './props/chain.js';
import { modeAt, modeOfBox, hasZones, zoned, thingMode, ensureModes, gridCell } from './zones.js';
import { middleStep, keepsShape, rowsClass, tileClass, rollReach } from './slider.js';
import { SPIKES } from './sprites8.js';

const EPS = 0.001;

function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Small crates (props/smallcrate.js) are crates of their own size (changed 2026-11-20: before, a prop with simpler rules of its own).
// Every rule below that pushes, carries, stacks or drops a crate takes the small crates too, with their own box: half a tile wide
// and one tall (a whole-tile block in low-res, where two in a tile merge; world.js). In 8-bit a small crate is a body moved by
// stepCrate like a crate, but it never turns, it is not in the pixel layer (others meet its box, which is kept on the pixel grid:
// its exact place is hidden in ex, ey, see poseOf), and it is never locked or held by a chain.
export const isSmallCrate = (t) => t.type === 'smallcrate';
// The crates, then the small crates. (A world without small crates: the crate list itself, so nothing else changes.)
export function cratesOf(world) {
  let smalls = null;
  for (const p of world.props) if (isSmallCrate(p)) (smalls || (smalls = [])).push(p);
  return smalls ? [...world.crates, ...smalls] : world.crates;
}
const wOf = (c) => (isSmallCrate(c) ? c.w : CRATE_SIZE);
const hOf = (c) => (isSmallCrate(c) ? c.h : CRATE_SIZE);
const boxW = (b) => (b.w === undefined ? CRATE_SIZE : b.w);       // a crate's place ({ x, y }) or a small crate's ({ x, y, w })

const playerBox = (p) => ({ x: p.x, y: p.y, w: PLAYER_W, h: PLAYER_H });
const ballBox = (b, dx = 0, dy = 0) => ({ x: b.x + dx, y: b.y + dy, w: BALL_SIZE, h: BALL_SIZE });
const crateBox = (c, dx = 0, dy = 0) => ({ x: c.x + dx, y: c.y + dy, w: wOf(c), h: hOf(c) });
const isBall = (world, t) => world.balls.includes(t);
const dimsOfT = (world, t) => (isBall(world, t) ? [BALL_SIZE, BALL_SIZE] : [wOf(t), hOf(t)]);
const canMoveT = (world, t, dx, dy, player) => (isBall(world, t) ? ballCanMove(world, t, dx, dy, player) : crateCanMove(world, t, dx, dy, player));

// A crate that does not move: locked, or hanging from a chain (while it lives in 8-bit; a turned crate is never held).
export function isPinned(world, crate) {
  if (isSmallCrate(crate)) return false;
  return thingMode(world, crate) === '8bit' && (Boolean(crate.locked) || (!crate.tilt && heldByChain(world, crate, CRATE_SIZE)));
}

// An 8-bit crate's pose { cx, cy, tilt } in level pixels (dyn.js cratePose). A small crate's: its hidden exact centre while its box is
// still where that put it (ex, ey; exX, exY), else the centre of its box; it never turns.
const SMALL_TIE = 1e-7;
export function poseOf(c) {
  if (!isSmallCrate(c)) return cratePose(c);
  if (c.ex !== undefined && c.exX === c.x && c.exY === c.y) return { cx: c.ex, cy: c.ey, tilt: 0 };
  return { cx: (c.x + c.w / 2) * PX8, cy: (c.y + c.h / 2) * PX8, tilt: 0 };
}
// Put a small crate at the exact centre (cx, cy) (pixels): its box goes to the pixels it covers (the ones rasterRect gives it).
function placeSmall(c, cx, cy) {
  c.ex = cx; c.ey = cy;
  c.x = Math.ceil(cx - (c.w * PX8) / 2 - 0.5 - SMALL_TIE) / PX8 + 0;     // (never -0)
  c.y = Math.ceil(cy - (c.h * PX8) / 2 - 0.5 - SMALL_TIE) / PX8 + 0;
  c.exX = c.x; c.exY = c.y;
}

// A thing the things grenade made low-res for good (forceLow) is a rigid low-res-sized box wherever it is; what decides how it MOVES is
// the space it is in (the mode of the tile holding its centre, ignoring forceLow): in low-res space whole tiles and stepLow momentum;
// in 8-bit space smooth motion as an untilted box (stepSmooth). A forced thing in low-res space that is not on whole tiles (it has just
// come in and could not snap yet) also moves smoothly until it can. Only crates and balls are hybrid.
export const spaceMode = (world, t) => { const [w, h] = dimsOfT(world, t); return modeOfBox(world, t.x, t.y, w, h); };
const whole = (v) => Number.isInteger(v);
export function isSmooth(world, t) {
  if (!t.forceLow || !(world.crates.includes(t) || world.balls.includes(t) || isSmallCrate(t))) return false;
  return spaceMode(world, t) === '8bit' || !(whole(t.x) && whole(t.y));
}

function crateCanMove(world, crate, dx, dy, player) {
  const b = crateBox(crate, dx, dy);
  if (boxHitsSolid(world, b.x, b.y, b.w, b.h, world.mode, crate)) return false;
  return !overlaps(b, playerBox(player));
}

// Low-res stacks: what rests directly on a low-res crate's top (crates, then balls) and overlaps it sideways, level by level
// upward. Pinned crates and things held by a chain are never carried. A list of levels: [[things], [things], ...], each
// thing { t, ball } with its position at the time of the call.
const sitsOn = (t, w, h, base) => Math.abs(t.y + h - base.y) < EPS && t.x < base.x + boxW(base) - EPS && t.x + w > base.x + EPS;
function lowStackAbove(world, crate) {
  const levels = [], seen = new Set([crate]);
  let bases = [{ x: crate.x, y: crate.y, w: wOf(crate) }];
  while (bases.length) {
    const level = [];
    for (const c of cratesOf(world)) {
      if (seen.has(c) || thingMode(world, c) !== 'low' || isPinned(world, c)) continue;
      const w = wOf(c), h = hOf(c);
      if (bases.some((b) => sitsOn(c, w, h, b))) { seen.add(c); level.push({ t: c, ball: false, x: c.x, y: c.y, w, h }); }
    }
    for (const b of world.balls) {
      if (seen.has(b) || thingMode(world, b) !== 'low' || heldByChain(world, b, BALL_SIZE)) continue;
      if (bases.some((base) => sitsOn(b, BALL_SIZE, BALL_SIZE, base))) { seen.add(b); level.push({ t: b, ball: true, x: b.x, y: b.y, w: BALL_SIZE, h: BALL_SIZE }); }
    }
    if (level.length) levels.push(level);
    bases = level.filter((e) => !e.ball).map((e) => ({ x: e.x, y: e.y, w: e.w }));
  }
  return levels;
}

// The pushed low-res crate has moved one cell (a tile; half a tile at the slider's step 2, zones.js gridCell) in direction
// dir (-1 or 1): what rested on it moves the same cell, bottom level first and, within a
// level, the one furthest in the push direction first (so neighbours do not block each other). One that cannot move (a
// wall) stays, and so does everything resting only on it; it falls as usual afterwards. Zone-edge rules apply to each.
function carryLowStack(world, player, crate, prev, levels, dir) {
  const cell = gridCell(world, crate), step = dir * cell;
  glideRiders(world, player, prev, dir);
  const moved = new Set([crate]);
  const movedBoxes = [{ x: prev.x, y: prev.y, w: wOf(crate) }];
  for (const level of levels) {
    const next = [];
    const mine = level.filter((e) => movedBoxes.some((b) => sitsOn(e, e.w, e.h, b)));
    mine.sort((a, b) => dir * (b.x - a.x));
    for (const e of mine) {
      if (gridCell(world, e.t) !== cell) continue;             // on another grid (an area of another step): it is not carried
      const ok = e.ball ? ballCanMove(world, e.t, step, 0, player) : crateCanMove(world, e.t, step, 0, player);
      if (!ok) continue;
      const before = { ...e.t };
      e.t.x += step;
      if (!settleMove(world, player, e.t, before)) continue;
      moved.add(e.t);
      if (!e.ball) { next.push({ x: e.x, y: e.y, w: e.w }); glideRiders(world, player, { x: e.x, y: e.y, w: e.w }, dir); }
    }
    movedBoxes.push(...next);
  }
}

// An 8-bit crate resting on the top of a box (a low-res crate's place, `box`: { x, y } in tiles): within a pixel and a half
// of it vertically, overlapping it sideways.
const restsOnBox = (d, box) => Math.abs((d.y + hOf(d) - box.y) * PX8) <= 1.5 && d.x < box.x + boxW(box) - EPS && d.x + wOf(d) > box.x + EPS;

// A low-res crate has just moved a tile in direction dir (from `box`): the 8-bit crates resting on it are not shoved; each
// that can move at all is given the smooth one-tile glide in that direction (stepCrate), the rest are left behind.
function glideRiders(world, player, box, dir) {
  for (const d of cratesOf(world)) {
    if (thingMode(world, d) !== '8bit' || d.tilt || d.glide || isPinned(world, d) || !restsOnBox(d, box)) continue;
    if (crateCanMove(world, d, dir / PX8, 0, player)) d.glide = { dir, left: 1 };
  }
}

// One low-res crate a cell in direction dir, with its low-res stack (the normal rules); false when it cannot.
function moveLowTile(world, player, c, dir) {
  const step = dir * gridCell(world, c);
  if (!crateCanMove(world, c, step, 0, player)) return false;
  const above = lowStackAbove(world, c);
  const prev = { ...c };
  c.x += step;
  if (!settleMove(world, player, c, prev)) return false;
  carryLowStack(world, player, c, prev, above, dir);
  return true;
}

// The low-res crates touching the front of crate c (within a pixel and a half, overlapping it in height as rowFrom judges).
function lowAhead(world, c, dir) {
  const cw = wOf(c), ch = hOf(c);
  return [...cratesOf(world), ...world.balls].filter((d) => {
    if (d === c || thingMode(world, d) !== 'low' || isSmooth(world, d)) return false;
    const [dw, dh] = dimsOfT(world, d);
    const gap = dir > 0 ? d.x - (c.x + cw) : c.x - (d.x + dw);
    if (gap < -1 / PX8 || gap > 1.5 / PX8) return false;
    return !(d.y + dh - 2 / PX8 <= c.y || d.y >= c.y + ch - 2 / PX8);
  });
}

// An 8-bit crate moving sideways is blocked with low-res crates touching its front: each is pushed as a player would push it
// (pushLowRow: its row moves a tile, stacks are carried, 8-bit crates in front of it glide). A crate that has already moved
// in this call (it was in another one's row or stack) is not pushed again. True when there was something and every push
// worked; the crate then carries on (at once if the room is free now, else next step).
function pushLowAhead(world, player, c, dir) {
  const ahead = lowAhead(world, c, dir);
  if (!ahead.length) return false;
  const x0 = new Map(ahead.map((z) => [z, z.x]));
  ahead.sort((a, b) => (b.y - a.y) || (a.cid || 0) - (b.cid || 0));
  let ok = true;
  for (const z of ahead) {
    if (z.x !== x0.get(z)) continue;
    if (!pushLowRow(world, z, dir, player)) ok = false;
  }
  return ok;
}

// The player, blocked sideways in direction dir, pushes the crate. A crate in low-res: one tile (true if it moved; if that
// takes it across a zone's edge into 8-bit it changes over, and if it cannot the push is refused).
// A crate in 8-bit: the crate is a body; this only tells it the player is pushing (stepCrates then moves it, smoothly),
// and is true unless the crate is pinned. Low-res crates never slide, even when ice is switched on in low-res
// (world.iceInLow): they always move a tile at a time and stop.
export function tryPush(world, crate, dir, player) {
  if (isPinned(world, crate)) return false;
  if (isSmooth(world, crate)) { crate.pushDir = dir; return true; }      // a forced crate in 8-bit space: smooth, like an 8-bit body
  if (thingMode(world, crate) === 'low') return pushLowRow(world, crate, dir, player);
  crate.pushDir = dir;
  return true;
}

// The crates side by side with this one in direction dir, and theirs in turn (a row, which may branch): every crate
// whose side touches the one before it and overlaps it in height. `near` is the gap allowed, in tiles.
// In low-res a ball in the way is part of the row (it moves its tile with it, or nothing moves); the seed may be a ball.
// mode 'glide': the crates that move as 8-bit bodies, which a low-res push makes glide (startEdgeGlide): 8-bit crates and
// smooth forced crates (a forced crate in 8-bit space).
const bodyLike = (world, d) => thingMode(world, d) === '8bit' || isSmooth(world, d);
function rowFrom(world, crate, dir, mode, near) {
  const row = [crate];
  const pool = mode === 'low' ? [...cratesOf(world), ...world.balls] : cratesOf(world);
  // (A stepped world: a low-res row is the things on the seed's own grid; one on another grid is in the way, not in the row.)
  const cell = mode === 'low' && world.res ? gridCell(world, crate) : 0;
  const takes = mode === 'glide' ? (d) => bodyLike(world, d) : (d) => thingMode(world, d) === mode && !isSmooth(world, d) && (!cell || gridCell(world, d) === cell);
  for (let i = 0; i < row.length; i++) {
    const c = row[i], [cw, ch] = dimsOfT(world, c);
    for (const d of pool) {
      if (row.includes(d) || !takes(d)) continue;
      const [dw, dh] = dimsOfT(world, d);
      const gap = dir > 0 ? d.x - (c.x + cw) : c.x - (d.x + dw);
      if (gap < -1 / PX8 || gap > near) continue;
      if (d.y + dh - 2 / PX8 <= c.y || d.y >= c.y + ch - 2 / PX8) continue;
      row.push(d);
    }
  }
  return row;
}

// 8-bit crates touching the front of a low-res row (within a pixel and a half), and those touching them in turn: when a
// low-res row is pushed against them they are not shoved a tile at once; each is given a glide (stepCrate): one whole tile in
// the push direction at EDGE_GLIDE_SPEED, as a normal 8-bit body (pixel collision, stack carried, zone edges). A forced crate
// in 8-bit space (isSmooth) moves as an 8-bit body too and glides the same way (stepSmooth; entering low-res space it snaps
// to tiles and the glide ends there). The low-res
// crates do not move on that push; they follow by themselves when the glide they caused has ended (endGlide: the same row
// move, one tile, if the room is free by then; a glider that stopped part-way leaves no room, so they stay). Returns true
// when a glide runs or was started (the push then counts, with its cooldown), false when there is none or it cannot start
// (a pinned or tilted crate in the way, or not even a pixel of room ahead of the front one): nothing happens then.
function startEdgeGlide(world, row, dir, player, seed) {
  const found = [];
  for (const c of row) for (const d of rowFrom(world, c, dir, 'glide', 1.5 / PX8)) if (!row.includes(d) && !found.includes(d)) found.push(d);
  if (!found.length) return false;
  if (found.some((c) => c.tilt || isPinned(world, c))) return false;
  found.sort((a, b) => dir * (b.x - a.x));
  if (!crateCanMove(world, found[0], dir / PX8, 0, player)) return false;
  const fresh = found.filter((c) => !c.glide);
  const rec = fresh.length ? { seed, dir, pending: fresh.length } : null;
  for (const c of fresh) c.glide = { dir, left: 1, rec };
  return true;
}

// A glide has ended (the crate moved its tile, or was stopped): when it was the last of those one push started, the
// low-res row that caused it follows (queued; stepCrates resolves it once everything has stepped).
function endGlide(world, c) {
  const rec = c.glide && c.glide.rec;
  delete c.glide;
  if (!rec) return;
  rec.pending--;
  if (rec.pending === 0) (world.glideDone || (world.glideDone = [])).push(rec);
}

function followGlides(world, player) {
  const done = world.glideDone;
  if (!done || !done.length) return;
  world.glideDone = [];
  for (const rec of done) {
    if (world.crates.includes(rec.seed) || world.balls.includes(rec.seed) || world.props.includes(rec.seed)) {
      if (thingMode(world, rec.seed) === 'low') pushLowRow(world, rec.seed, rec.dir, player, true);
    }
  }
}

// Low-res: the pushed crate (or ball) and every crate or ball in a row in front of it move one cell (a tile; half a tile at
// the slider's step 2) together, or none move (a wall or a pinned crate at the front stops the row). Each one's stack moves with it (carryLowStack). follow: the
// move that comes after a glide: no new glide is started (a crate still touching the front just blocks it).
function pushLowRow(world, seed, dir, player, follow = false) {
  const row = rowFrom(world, seed, dir, 'low', 0);       // a ball pushes the row in front of it like a crate
  if (row.some((c) => (isBall(world, c) ? heldByChain(world, c, BALL_SIZE) : isPinned(world, c)))) return false;
  if (!follow && startEdgeGlide(world, row, dir, player, seed)) return true;   // an 8-bit crate in front: it glides a tile first
  row.sort((a, b) => dir * (b.x - a.x));               // the front first, so each makes room for the one behind
  const above = row.map((c) => (isBall(world, c) ? [] : lowStackAbove(world, c).map((lv) => lv.filter((e) => !row.includes(e.t))).filter((lv) => lv.length)));
  const prevs = row.map((c) => ({ ...c }));
  const step = dir * gridCell(world, seed);
  for (let i = 0; i < row.length; i++) {
    if (!canMoveT(world, row[i], step, 0, player)) {
      for (let j = 0; j < i; j++) row[j].x = prevs[j].x;
      return false;
    }
    row[i].x += step;
  }
  for (let i = 0; i < row.length; i++) {
    if (!settleMove(world, player, row[i], prevs[i])) {    // a zone edge it cannot cross: it and those behind it stay
      for (let j = i + 1; j < row.length; j++) row[j].x = prevs[j].x;
      return i > 0;
    }
  }
  row.forEach((c, i) => { if (!isBall(world, c)) carryLowStack(world, player, c, prevs[i], above[i], dir); });
  return true;
}

// 8-bit: the crate whose pixels the player is pressing against when blocked sideways in direction dir.
export function crateToPush(world, player, dir) {
  const id = dynOwnerInBox(world, player.x + (dir * 1.5) / PX8, player.y, PLAYER_W, PLAYER_H);
  return id ? world.crates.find((c) => c.cid === id) || null : null;
}

// The player, blocked sideways in direction dir, pushes the small crate in the way exactly as a crate (tryPush): 'body' when it is
// an 8-bit body (or a smooth forced one) told it is pushed, 'low' when it moved a cell on its grid, false when nothing moved. The
// player's box is reached within a pixel and a half in 8-bit (its box is on the pixel grid, the player's stops at a whole pixel),
// within 0.05 of a tile in low-res, as for crates.
export function pushSmallCrate(world, player, dir) {
  let best = null;
  for (const p of world.props) {
    if (!isSmallCrate(p)) continue;
    const grid = thingMode(world, p) === 'low' && !isSmooth(world, p);
    const bx = player.x + dir * (grid ? 0.05 : 1.5 / PX8);
    if (!(bx < p.x + p.w && bx + PLAYER_W > p.x && player.y < p.y + p.h && player.y + PLAYER_H > p.y)) continue;
    if (!best || (dir > 0 ? p.x < best.x : p.x > best.x)) best = p;
  }
  if (!best) return false;
  if (!tryPush(world, best, dir, player)) return false;
  return thingMode(world, best) === 'low' && !isSmooth(world, best) ? 'low' : 'body';
}

function ballCanMove(world, ball, dx, dy, player) {
  const b = ballBox(ball, dx, dy);
  if (boxHitsSolid(world, b.x, b.y, b.w, b.h, world.mode, ball)) return false;
  return !overlaps(b, playerBox(player));
}

// Can the ball move one pixel sideways, or sideways and up 1 or 2 pixels (the mover's step-up onto a ramp)?
function ballFreeToRoll(world, ball, dir) {
  return [0, 1, 2].some((up) => {
    const b = ballBox(ball, dir / PX8, -up / PX8);
    return !boxHitsSolid(world, b.x, b.y, b.w, b.h, world.mode, ball);
  });
}

// Low-res: one tile, like a crate. 8-bit: set it rolling at the player's speed.
export function tryPushBall(world, ball, dir, player) {
  if (heldByChain(world, ball, BALL_SIZE)) return false;
  if (isSmooth(world, ball)) { ball.pushDir = dir; return true; }
  if (thingMode(world, ball) === 'low') return pushLowRow(world, ball, dir, player);   // one tile; an 8-bit crate in front glides first
  if (!ballFreeToRoll(world, ball, dir)) return false;
  ball.vx = dir * RUN_SPEED;
  return true;
}

// Running on a ball (added 2026-11-20): the ball the player stands on (feet on its top; nothing else under him) while it is a smooth
// rolling body (8-bit, the slider's steps 8 and 4, a pixelated ball in 8-bit space; not a box on a grid). null when there is none.
export function ballUnderfoot(world, player) {
  const feet = player.y + PLAYER_H;
  for (const b of world.balls) {
    if (Math.abs(feet - b.y) > 1e-6 || !(player.x < b.x + BALL_SIZE && player.x + PLAYER_W > b.x)) continue;
    // His middle over its top: a player only caught on its edge (room 06: standing at the ball's edge over the ramp) is not running on it.
    const mid = player.x + PLAYER_W / 2;
    if (mid < b.x || mid > b.x + BALL_SIZE) return null;
    if (!(thingMode(world, b) === '8bit' || isSmooth(world, b)) || b.onGround !== true || heldByChain(world, b, BALL_SIZE)) return null;
    // A foot on something else too (the floor beside it, a crate): it is not the ball alone that holds him up.
    if (boxHitsSolid(world, player.x, player.y + 1 / PX8, PLAYER_W, PLAYER_H, world.mode, b)) return null;
    return b;
  }
  return null;
}

// The player ran in direction dir standing on ball b: his feet push its top backward, so it rolls the other way at half the run
// speed (rolling without slipping its top then moves as fast as his feet). A ball already rolling that way faster keeps its speed;
// one that cannot roll that way (a wall, a crate behind it) does not move. A smooth (pixelated) ball is moved the same way. A ball
// on a slope (stepBalls: it rolls downhill by itself there) is left to the slope, exactly as before.
export function runOnBall(world, b, dir) {
  const back = -dir;
  if (!ballFreeToRoll(world, b, back)) return;
  const d = rollReach(world, b);
  const fits = (dx) => !boxHitsSolid(world, b.x + dx / PX8, b.y + d / PX8, BALL_SIZE, BALL_SIZE, world.mode, b);
  if (fits(d) !== fits(-d)) return;
  if (back * (b.vx || 0) < RUN_SPEED / 2) b.vx = back * (RUN_SPEED / 2);
}

// Balls that live in 8-bit roll. One that moves across a zone's edge changes mode there (it snaps to a tile entering
// low-res); if it cannot, the edge is a wall for it that step.
export function stepBalls(world, player, dt) {
  const blockers = [playerBox(player)];
  const zonedWorld = zoned(world);
  for (const ball of world.balls) {
    if (thingMode(world, ball) !== '8bit') continue;
    const prev = zonedWorld ? { ...ball } : null;
    if (heldByChain(world, ball, BALL_SIZE)) { ball.vx = 0; ball.vy = 0; continue; }
    const wasOnGround = ball.onGround;
    ball.vy = Math.min(ball.vy + GRAVITY * dt, MAX_FALL);
    if (wasOnGround) {
      // Downhill is the side where the ball fits one pixel across and one down (one block of the voted picture at the
      // slider's step 4, where a ramp is 2-pixel stairs: slider.js rollReach).
      const d = rollReach(world, ball);
      const free = (dx) => !boxHitsSolid(world, ball.x + dx / PX8, ball.y + d / PX8, BALL_SIZE, BALL_SIZE, world.mode, ball);
      const right = free(d), left = free(-d);
      if (right !== left) ball.vx += (right ? 1 : -1) * BALL_SLOPE_ACCEL * dt;
      else if (!iceUnder(world, ball.x, ball.y, BALL_SIZE, BALL_SIZE, true)) { // on ice there is no friction
        const drop = BALL_FRICTION * dt;
        ball.vx = Math.abs(ball.vx) <= drop ? 0 : ball.vx - Math.sign(ball.vx) * drop;
      }
    }
    ball.vx = Math.max(-BALL_MAX_SPEED, Math.min(BALL_MAX_SPEED, ball.vx));
    moveBody(world, ball, BALL_SIZE, BALL_SIZE, dt, { ignore: ball, blockers, wasOnGround });
    if (prev && !settleMove(world, player, ball, prev)) { ball.vx = 0; ball.vy = 0; }
  }
  for (let i = world.balls.length - 1; i >= 0; i--) {
    if (world.balls[i].y > world.height && thingMode(world, world.balls[i]) === '8bit') world.balls.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Crates in 8-bit: bodies with a pose (centre, tilt) and a velocity. Everything below works in level pixels.
//
// Each step (stepCrates): the velocity comes from the player's push (CRATE_PUSH_SPEED), friction, an icy slope
// or a slide off an edge; the crate moves sideways; then its pose is settled. Settling: the ground under its
// width is sampled (groundTilt) to find the slope it should lie along, the tilt eases toward that (never more
// than CRATE_TILT_EASE degrees a step), and the crate is put at the lowest free height for that tilt, rising at
// most about two pixels (the rise the player and the balls climb) and dropping at most three to stay on a ramp
// down. A pose is only ever accepted when none of its pixels is solid, so a crate never overlaps terrain,
// another crate, a prop, a ball or the player. With no ground within reach it falls. Over a ledge it stays flat
// while its centre is over support; once the centre passes the edge it slides off and drops upright.
// ---------------------------------------------------------------------------------------------------------------
const TILT_MAX = Math.PI / 4;
const EASE = (CRATE_TILT_EASE * Math.PI) / 180;
const WINDOW_UP = 12, WINDOW_DOWN = 8;     // ground sampled from this many pixels above to below the flat bottom
const FIT_TOLERANCE = 2.5;                 // pixels: the ground under a crate must lie this close to one line to tilt it
const MAX_DROP = 3;                        // pixels a crate on the ground still follows down (a ramp down)
const OVERLAP_E = 1e-6;

// What a crate cannot move into: terrain and the level edge, other crates' pixels, solid props, doors, balls, the player.
function crateContext(world, c, player) {
  const { maskW: W, maskH: H, mask, dyn } = world;
  const id = c.cid;
  // Terrain pixel (in range): where the tile is low-res the big pixel's vote decides, else the mask (see zones.js).
  let tmap = null;
  if (hasZones(world)) { ensureModes(world); tmap = world.tmode; }
  const terrain = (x, y) => (tmap !== null && tmap[(y >> 3) * world.width + (x >> 3)] === 1
    ? world.low.cells[(y >> 3) * world.low.cols + (x >> 3)] === 1
    : mask[y * W + x] === 1);
  const cell = (b) => ({ x0: b.x * PX8, y0: b.y * PX8, x1: (b.x + b.w) * PX8, y1: (b.y + b.h) * PX8 });
  const boxes = [];
  for (const b of solidBoxes(world)) if (b.ref !== c) boxes.push({ ...cell(b), ball: world.balls.includes(b.ref), ref: b.ref });
  boxes.push({ ...cell({ x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H }), ball: false, ref: player });
  // The crate's shape: a square that may turn, or a small crate's upright box (flat: it never turns).
  const small = isSmallCrate(c), hw = small ? (c.w * PX8) / 2 : CRATE_HALF, hh = small ? (c.h * PX8) / 2 : CRATE_HALF;
  const raster = small ? (cx, cy, tilt, fn) => rasterRect(cx, cy, hw, hh, fn) : (cx, cy, tilt, fn) => rasterSquare(cx, cy, CRATE_HALF, tilt, fn);
  const ctx = { skipBalls: false, skipRef: null, boxes, solidAt: null, groundAt: null, raster, hw, hh, flat: small };
  // What counts as ground for the slope fit: terrain and other crates' pixels (and 8-bit small crates' boxes, their pixels), not
  // boxes (balls, props, the player).
  const smallGround = boxes.filter((b) => b.ref && isSmallCrate(b.ref) && thingMode(world, b.ref) === '8bit');
  const inBox = (x, y, b) => x < b.x1 - OVERLAP_E && x + 1 > b.x0 + OVERLAP_E && y < b.y1 - OVERLAP_E && y + 1 > b.y0 + OVERLAP_E;
  ctx.groundAt = (x, y) => {
    if (x < 0 || x >= W || y < 0) return true;
    if (y >= H) return false;
    const i = y * W + x;
    return terrain(x, y) || (dyn[i] !== 0 && dyn[i] !== id) || (smallGround.length > 0 && smallGround.some((b) => inBox(x, y, b)));
  };
  ctx.solidAt = (x, y) => {
    if (x < 0 || x >= W || y < 0) return true;
    if (y >= H) return false;
    const i = y * W + x;
    if (terrain(x, y)) return true;
    if (dyn[i] !== 0 && dyn[i] !== id) return true;
    for (const b of boxes) {
      if (ctx.skipBalls && b.ball) continue;
      if (ctx.skipRef && b.ref === ctx.skipRef) continue;
      if (x < b.x1 - OVERLAP_E && x + 1 > b.x0 + OVERLAP_E && y < b.y1 - OVERLAP_E && y + 1 > b.y0 + OVERLAP_E) return true;
    }
    return false;
  };
  return ctx;
}

const free = (ctx, cx, cy, tilt) => !ctx.raster(cx, cy, tilt, (x, y) => ctx.solidAt(x, y));

// The tilt the ground under the crate asks for, in radians: the line the ground's top lies along across the
// crate's width. Ground more than WINDOW_DOWN below the flat bottom (a ledge's drop) is not "under" it. Ground
// that is not close to a single line (a step, a lip) asks for a flat crate.
function groundTilt(ctx, cx, cy) {
  const yb = Math.round(cy + ctx.hh);
  const i0 = Math.floor(cx - ctx.hw), i1 = Math.ceil(cx + ctx.hw) - 1;
  const pts = [];
  for (let i = i0; i <= i1; i++) {
    if (ctx.groundAt(i, yb - WINDOW_UP)) continue;          // a wall or ceiling, not ground
    for (let y = yb - WINDOW_UP + 1; y <= yb + WINDOW_DOWN; y++) {
      if (ctx.groundAt(i, y)) { pts.push([i, y]); break; }
    }
  }
  if (pts.length < 4) return 0;
  let mi = 0, mg = 0;
  for (const [i, g] of pts) { mi += i; mg += g; }
  mi /= pts.length; mg /= pts.length;
  let sxx = 0, sxy = 0;
  for (const [i, g] of pts) { sxx += (i - mi) * (i - mi); sxy += (i - mi) * (g - mg); }
  const m = sxy / sxx;
  for (const [i, g] of pts) if (Math.abs(g - (mg + m * (i - mi))) > FIT_TOLERANCE) return 0;
  return Math.max(-TILT_MAX, Math.min(TILT_MAX, Math.atan(m)));
}

// What the crate touches below it: the span of its pixels with something solid directly under them, and whether
// any of that is icy terrain.
function contact(ctx, world, cx, cy, tilt) {
  const info = { any: false, min: Infinity, max: -Infinity, ice: false };
  ctx.raster(cx, cy, tilt, (x, y) => {
    if (!ctx.solidAt(x, y + 1)) return false;
    info.any = true;
    if (x < info.min) info.min = x;
    if (x > info.max) info.max = x;
    if (world.ice && y + 1 < world.maskH && world.mask[(y + 1) * world.maskW + x] === 1
      && world.ice[((y + 1) >> 3) * world.width + (x >> 3)] === 1 && modeAt(world, x >> 3, (y + 1) >> 3) === '8bit') info.ice = true;
    return false;
  });
  return info;
}

// A flat crate is held up when what it touches spans its centre (one pixel of slack): resting on a ledge it stays
// until its centre passes the edge; across a gap narrower than itself it stays.
function supported(info, cx) {
  return info.any && info.min <= cx + 1 && info.max + 1 >= cx - 1;
}

const easeTo = (tilt, target) => (Math.abs(target - tilt) <= EASE ? target : tilt + Math.sign(target - tilt) * EASE);

// Lowest free height for the pose: start from cy0 (or up to `rise` pixels higher when that is blocked), then go
// down while free for at most `drop` pixels. null when nothing is free; touching says whether it rests on something.
function rest(ctx, cx, cy0, tilt, rise, drop) {
  let cy = cy0;
  if (!free(ctx, cx, cy, tilt)) {
    let found = false;
    for (let k = 1; k <= rise; k++) if (free(ctx, cx, cy0 - k, tilt)) { cy = cy0 - k; found = true; break; }
    if (!found) return null;
  }
  for (let d = 0; d < drop && free(ctx, cx, cy + 1, tilt); d++) cy++;
  return { cy, touching: !free(ctx, cx, cy + 1, tilt) };
}

// The pose at centre x `nx`: on the ground it follows the slope; in the air it falls and straightens.
function solvePose(ctx, nx, cy, tilt, onGround, vy, dt) {
  if (onGround) {
    const t1 = easeTo(tilt, ctx.flat ? 0 : groundTilt(ctx, nx, cy));
    for (const t of t1 === tilt ? [tilt] : [t1, tilt]) {
      const r = rest(ctx, nx, cy, t, 2 + 12 * Math.abs(t - tilt), MAX_DROP);
      if (r) return { cx: nx, cy: r.cy, tilt: t, touching: r.touching };
    }
    return null;
  }
  const t1 = easeTo(tilt, 0);
  for (const t of t1 === tilt ? [tilt] : [t1, tilt]) {
    if (!free(ctx, nx, cy, t)) continue;
    if (vy >= 0 && Number.isInteger(cy) && !free(ctx, nx, cy + 1, t)) return { cx: nx, cy, tilt: t, touching: true };   // already resting
    if (vy < 0) {                                          // rising: stops at a ceiling
      let y = cy, left = -vy * dt * PX8;
      while (left > 1e-9) {
        const inc = Math.min(1, left);
        if (!free(ctx, nx, y - inc, t)) return { cx: nx, cy: y, tilt: t, touching: false, ceiling: true };
        y -= inc; left -= inc;
      }
      return { cx: nx, cy: y, tilt: t, touching: false };
    }
    let y = cy, left = vy * dt * PX8, hit = false;
    while (left > 1e-9) {
      const inc = Math.min(1, left);
      if (!free(ctx, nx, y + inc, t)) { hit = true; break; }
      y += inc; left -= inc;
    }
    if (!hit) return { cx: nx, cy: y, tilt: t, touching: false };
    const r = rest(ctx, nx, Math.floor(y + 1e-9), t, 1, 1) || { cy: y, touching: true };   // land on the pixel grid
    return { cx: nx, cy: r.cy, tilt: t, touching: true };
  }
  return null;
}

// Balls (only) in the way of the pose.
function ballsInPose(world, ctx, pose) {
  const hit = new Set();
  ctx.raster(pose.cx, pose.cy, pose.tilt, (x, y) => {
    for (const b of ctx.boxes) {
      if (b.ball && x < b.x1 - OVERLAP_E && x + 1 > b.x0 + OVERLAP_E && y < b.y1 - OVERLAP_E && y + 1 > b.y0 + OVERLAP_E) hit.add(b.ref);
    }
    return false;
  });
  return [...hit];
}

const UP_MAX = Math.max(BALL_MAX_SPEED, SPRING_SPEED);   // fastest upward speed of a crate (a spring can launch it)
const SLOPE_TILT = 0.6;     // radians: turned at least this far it is lying along a slope (45 degrees), not tipping over a corner
function stepCrate(world, c, player, dt) {
  let ctx = crateContext(world, c, player);
  const small = isSmallCrate(c);
  const { cx, cy, tilt } = poseOf(c);
  const g = c.glide, dir = g ? g.dir : c.pushDir || 0, drift = c.drift || 0;
  delete c.pushDir; delete c.drift;
  const wasOnGround = c.onGround === true;
  const info = wasOnGround ? contact(ctx, world, cx, cy, tilt) : null;
  const onIce = wasOnGround && iceActive(world) && info.ice;

  const mom = c.mom || 0; delete c.mom;                              // the speed it had from riding a platform it has just left
  let vx = c.vx || 0;
  if (g) vx = dir * Math.min(EDGE_GLIDE_SPEED, g.left / dt);           // a glide: steady speed, the last step cut short
  else if (dir) vx = dir * CRATE_PUSH_SPEED;
  else if (drift) vx = drift * CRATE_DRIFT;
  else if (wasOnGround && !onIce) {                               // friction (none on ice, none in the air)
    const drop = CRATE_FRICTION * dt;
    vx = Math.abs(vx) <= drop ? 0 : vx - Math.sign(vx) * drop;
  }
  vx += mom;
  if (onIce && !dir && !drift && tilt !== 0) vx += Math.sign(tilt) * ICE_SLOPE_ACCEL * dt;   // slides down an icy slope
  vx = Math.max(-BALL_MAX_SPEED, Math.min(BALL_MAX_SPEED, vx));
  // In the air a crate is a projectile: gravity acts on vy (either sign), vx is kept.
  const vy = wasOnGround ? 0 : Math.max(-UP_MAX, Math.min((c.vy || 0) + GRAVITY * dt, MAX_FALL));

  let pose = null;
  if (vx !== 0) {
    const nx = cx + vx * dt * PX8;
    pose = solvePose(ctx, nx, cy, tilt, wasOnGround, vy, dt);
    if (!pose) {
      // Blocked. If only balls are in the way and each can roll on, they are set rolling at the crate's speed
      // (the crate waits a step); otherwise it stops.
      ctx.skipBalls = true;
      const through = solvePose(ctx, nx, cy, tilt, wasOnGround, vy, dt);
      ctx.skipBalls = false;
      const balls = through ? ballsInPose(world, ctx, through) : [];
      const dirX = Math.sign(vx);
      if (balls.length && balls.every((b) => ballFreeToRoll(world, b, dirX))) {
        for (const b of balls) b.vx = dirX * Math.max(Math.abs(vx), Math.abs(b.vx));
      } else if (pushLowAhead(world, player, c, dirX)) {
        // A low-res crate in front jumped a tile (or its row, or the crates in front of it, are on their way): carry on,
        // at once if the room is there now.
        ctx = crateContext(world, c, player);
        pose = solvePose(ctx, nx, cy, tilt, wasOnGround, vy, dt);
      } else vx = 0;
    }
  }
  if (!pose) pose = solvePose(ctx, cx, cy, tilt, wasOnGround, vy, dt);
  if (!pose) pose = { cx, cy, tilt, touching: wasOnGround };   // boxed in where it stands: stay

  const x0 = c.x;
  if (small) placeSmall(c, pose.cx, pose.cy);
  else {
    c.x = pose.cx / PX8 - CRATE_SIZE / 2;
    c.y = pose.cy / PX8 - CRATE_SIZE / 2;
    c.tilt = pose.tilt;
  }
  c.vx = vx;
  if (pose.touching) {
    c.vy = 0;
    c.onGround = true;
    // Going along a slope it moves up or down as well as sideways: remember that speed, so leaving the slope's end it
    // keeps going the way it was going (diagonally) instead of starting from level flight. Flat ground forgets it.
    if (pose.tilt === 0) delete c.slopeVy;
    else if (Math.abs(pose.tilt) > SLOPE_TILT) c.slopeVy = vx * Math.tan(pose.tilt);
    const after = contact(ctx, world, pose.cx, pose.cy, pose.tilt);
    // Lying flat, held by one side only with its centre in the air: slide off away from what holds it.
    // (A turned crate is on a slope, resting along it; it is not judged this way.)
    if (pose.tilt === 0 && after.any && !supported(after, pose.cx, 0)) c.drift = pose.cx > (after.min + after.max + 1) / 2 ? 1 : -1;
    else if (pose.tilt === 0 && after.any) {
      // Held up only by the player's head (nothing else under it): it slides off toward the side where more of it hangs past the
      // player's centre (a tie: away from the way the player is going, else right), the same slide as off a ledge.
      ctx.skipRef = player;
      const rest = contact(ctx, world, pose.cx, pose.cy, 0);
      ctx.skipRef = null;
      if (!rest.any) {
        const pcx = (player.x + PLAYER_W / 2) * PX8;
        c.drift = Math.abs(pose.cx - pcx) >= 0.5 ? Math.sign(pose.cx - pcx) : (player.vx > 0 ? -1 : 1);
      }
    }
  } else {
    c.vy = pose.ceiling ? 0 : vy;
    if (wasOnGround && !dir && !drift && !pose.ceiling && c.slopeVy) c.vy = Math.max(-BALL_MAX_SPEED, Math.min(c.slopeVy, MAX_FALL));
    delete c.slopeVy;
    c.onGround = false;
    if (wasOnGround && (dir || drift)) c.vx = mom;   // pushed or slid off an edge: drops straight down (with what it rode in on)
  }
  if (g) {                                                // the glide ends after one tile, or where the crate was stopped
    g.left -= small ? Math.abs(pose.cx - cx) / PX8 : Math.abs(c.x - x0);
    if (g.left < 1e-6 || vx === 0) { endGlide(world, c); c.vx = 0; }
  }
  if (!small) stampCrate(world, c);
}

// A crate resting flat on another crate (8-bit) is carried by the sideways distance that one moved this step, when the
// place is free (else it is left behind, as a platform's rider is). Lowest crates step first, so the one below has already
// moved; a taller stack is carried level by level, each by its supporter's whole move. `start`: positions before the step.
const CARRY_MIN = 1e-9;
function carryOnCrate(world, c, player, start) {
  if (!c.onGround || c.tilt) return;
  const s = start.get(c);
  let dx = 0;
  for (const d of cratesOf(world)) {
    if (d === c || d.tilt || thingMode(world, d) !== '8bit') continue;
    const ds = start.get(d);
    if (Math.abs((s.y + hOf(c) - ds.y) * PX8) > 1.5 || !(s.x < ds.x + wOf(d) && s.x + wOf(c) > ds.x)) continue;
    const moved = d.x - ds.x;
    if (Math.abs(moved) > CARRY_MIN && Math.abs(moved) > Math.abs(dx)) dx = moved;
  }
  if (dx === 0) return;
  const ctx = crateContext(world, c, player);
  const { cx, cy, tilt } = poseOf(c);
  if (!free(ctx, cx + dx * PX8, cy, tilt)) return;
  if (isSmallCrate(c) && thingMode(world, c) === '8bit') { placeSmall(c, cx + dx * PX8, cy); return; }
  c.x += dx;
  if (thingMode(world, c) === '8bit') stampCrate(world, c);
}

// A low-res crate resting on an 8-bit crate that moves follows it in whole tiles: at the first move the offset from the
// bottom is recorded (c.carry), and each step the top goes to bottom.x + offset rounded in the direction of motion (so it
// jumps a tile at once and again for every whole tile the bottom has gone), a tile at a time with its own stack, when the
// place is free; else it stays and is left behind. It keeps following while it still rests on that crate.
function carryLowTops(world, player, start) {
  const tops = cratesOf(world).filter((c) => thingMode(world, c) === 'low' && !isPinned(world, c) && !isSmooth(world, c)).sort((a, b) => b.y - a.y);
  const moveOf = (d) => (start.has(d) ? d.x - start.get(d).x : 0);
  for (const c of tops) {
    let cur = c.carry;
    const below = cratesOf(world).filter((d) => d !== c && !d.tilt && thingMode(world, d) === '8bit' && restsOnBox(c, d));
    if (cur && !below.includes(cur.base)) { delete c.carry; cur = null; }
    let base = cur ? cur.base : null, moved = base ? moveOf(base) : 0;
    if (!base || Math.abs(moved) <= CARRY_MIN) {
      for (const d of below) { const m = moveOf(d); if (Math.abs(m) > Math.abs(moved)) { moved = m; base = d; } }
    }
    if (!base || Math.abs(moved) <= CARRY_MIN) continue;
    const dir = Math.sign(moved), cell = gridCell(world, c);
    if (!cur || cur.base !== base || cur.x !== c.x) cur = c.carry = { base, off: c.x - start.get(base).x, x: c.x };
    const want = (dir > 0 ? Math.ceil((base.x + cur.off) / cell - 1e-9) : Math.floor((base.x + cur.off) / cell + 1e-9)) * cell;
    for (let n = Math.round(dir * (want - c.x) / cell); n > 0; n--) if (!moveLowTile(world, player, c, dir)) break;
    if (thingMode(world, c) !== 'low') delete c.carry; else cur.x = c.x;
  }
}

// The crates that live in 8-bit: step every one that is not pinned, lowest first so a stack moves together. One that
// moves across a zone's edge changes mode there (snapping to a tile entering low-res); if it cannot, the edge is a wall
// for it that step and it stays where it was.
export function stepCrates(world, player, dt) {
  const zonedWorld = zoned(world);
  const all = cratesOf(world);
  // A pushed crate pushes the crates in a row in front of it (touching, within a pixel and a half); the front one is
  // stepped first so each makes room for the one behind.
  for (const c of all.filter((q) => q.pushDir && thingMode(world, q) === '8bit')) {
    for (const d of rowFrom(world, c, c.pushDir, '8bit', 1.5 / PX8)) if (d !== c && !isPinned(world, d) && !d.pushDir) d.pushDir = c.pushDir;
  }
  const front = (c) => (c.glide ? c.glide.dir * c.x : c.pushDir ? c.pushDir * c.x : 0);
  for (const c of all) if (c.glide && !bodyLike(world, c)) endGlide(world, c);   // (a smooth one glides in stepSmooth)
  // Crates rising together (a spring launched a stack) step first and the upper one first, so each leaves room for the one below.
  const rising = (c) => (c.vy < 0 && !c.onGround ? 0 : 1);
  const key = (c) => (isSmallCrate(c) ? 1e9 + world.props.indexOf(c) : c.cid);       // (small crates after the crates, in prop order)
  const order = all.filter((c) => thingMode(world, c) === '8bit' && !isPinned(world, c)).sort((a, b) => (rising(a) - rising(b)) || (rising(a) === 0 ? a.y - b.y : b.y - a.y) || (front(b) - front(a)) || (key(a) - key(b)));
  const start = new Map(all.map((c) => [c, { x: c.x, y: c.y }]));     // where everything was before this step
  for (const c of order) {
    const prev = zonedWorld ? { ...c } : null;
    carryOnCrate(world, c, player, start);
    stepCrate(world, c, player, dt);
    if (prev && !settleMove(world, player, c, prev)) { c.vx = 0; delete c.pushDir; delete c.drift; endGlide(world, c); if (!isSmallCrate(c)) stampCrate(world, c); }
  }
  // A smooth forced crate resting on an 8-bit crate is carried like an 8-bit one (lowest first).
  for (const c of all.filter((q) => isSmooth(world, q)).sort((a, b) => b.y - a.y)) carryOnCrate(world, c, player, start);
  carryLowTops(world, player, start);
  followGlides(world, player);
  for (let i = world.crates.length - 1; i >= 0; i--) {
    const c = world.crates[i];
    if (c.y >= world.height && thingMode(world, c) === '8bit') { unstampCrate(world, c); world.crates.splice(i, 1); }
  }
  for (let i = world.props.length - 1; i >= 0; i--) {
    const p = world.props[i];
    if (isSmallCrate(p) && p.y >= world.height && thingMode(world, p) === '8bit') world.props.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Crates and balls in low-res have momentum too. A low-res thing keeps a velocity (vx, vy, tiles/s) and a hidden exact
// position (fx, fy) and moves as an 8-bit crate body would: gravity (GRAVITY, MAX_FALL), crate friction when resting on
// something (a ball is a box here: no rolling, no slope pull), no ice unless the world says iceInLow. What shows (and
// collides) is always whole tiles: each step it goes tile by tile toward the rounded exact position, each tile tested with
// the low-res collision (crateCanMove / ballCanMove: terrain, other things, the player, the pixels of 8-bit crates, so a
// thing moving into touching 8-bit crates is simply blocked). A tile blocked in an axis zeroes that velocity and puts the
// exact position back on the tile. A sideways move carries the stack resting on a crate; one that crosses a zone's edge
// changes mode (settleMove) with its velocity. (lx, ly: the tile the exact position was last matched to; a push, a carry
// or a change of mode that moved the tile makes the exact position start again from it.)
// Entering low-res (world.js applyPlan) keeps vx, vy and starts the exact position at the thing's 8-bit place; leaving it
// the 8-bit body starts with them. The player's push moves a tile and gives no velocity.
// The grid is a whole tile, or half a tile at the resolution slider's step 2 (zones.js gridCell): every "tile" above is then
// a cell of that grid (pushes, rows, stacks, falls, the rounding of the exact position), and the terrain is the step's own
// (world.mask voted in 4 x 4 pixel blocks, read through world.mode '8bit'). With a whole-tile cell the arithmetic is exactly
// the old one (v / 1 and dir * 1 are exact), so every world without the slider moves as it always has.
// ---------------------------------------------------------------------------------------------------------------
// A forced-low crate or ball in 8-bit space (or not yet snapped in low-res space): a rigid untilted box with smooth motion in exact
// units: gravity and MAX_FALL, crate friction when resting, momentum, CRATE_PUSH_SPEED while the player pushes (t.pushDir, set by
// tryPush); terrain by each tile's own mode, other solids, crate pixels and the player through moveBody without step-up (a ramp is just
// pixels it bumps into). If its centre has moved into a low-res tile it snaps to whole tiles (momentum kept); if it cannot, the edge is
// a wall for it that step. Things resting on it (8-bit crates, smooth crates, level by level) are carried sideways when the place is free.
function carrySmoothRiders(world, player, base, size, bx, by, dx, seen) {
  const riders = cratesOf(world).filter((c) => c !== base && !seen.has(c) && !c.tilt && c.onGround === true && !isPinned(world, c)
    && (thingMode(world, c) === '8bit' || isSmooth(world, c))
    && Math.abs((c.y + hOf(c) - by) * PX8) <= 1.5 && c.x < bx + size - EPS && c.x + wOf(c) > bx + EPS);
  riders.sort((a, b) => dx * (b.x - a.x));
  for (const c of riders) {
    seen.add(c);
    const ox = c.x, oy = c.y;
    let ok;
    if (thingMode(world, c) === '8bit') {
      const ctx = crateContext(world, c, player), { cx, cy, tilt } = poseOf(c);
      ok = free(ctx, cx + dx * PX8, cy, tilt);
      if (ok && isSmallCrate(c)) placeSmall(c, cx + dx * PX8, cy);
      else if (ok) { c.x += dx; stampCrate(world, c); }
    } else { ok = canMoveT(world, c, dx, 0, player); if (ok) c.x += dx; }
    if (ok) carrySmoothRiders(world, player, c, wOf(c), ox, oy, dx, seen);
  }
}

// A glide (startEdgeGlide: a low-res push against it) moves it one tile at EDGE_GLIDE_SPEED, as stepCrate does an 8-bit crate's.
function stepSmooth(world, player, t, dt) {
  const [size, height] = dimsOfT(world, t);
  const g = t.glide, dir = g ? g.dir : t.pushDir || 0; delete t.pushDir;
  if (g && g.to === undefined) g.to = t.x + g.dir;                    // where a whole tile takes it (the end is put there exactly)
  const prev = { x: t.x, y: t.y, vx: t.vx, vy: t.vy, onGround: t.onGround };
  const wasLow = spaceMode(world, t) === 'low';
  if (!Number.isFinite(t.vx)) t.vx = 0;
  if (!Number.isFinite(t.vy)) t.vy = 0;
  const wasOn = t.onGround === true;
  if (g) t.vx = dir * Math.min(EDGE_GLIDE_SPEED, g.left / dt);
  else if (dir) t.vx = dir * CRATE_PUSH_SPEED;
  else if (wasOn && t.vx !== 0) {
    const drop = CRATE_FRICTION * dt;
    t.vx = Math.abs(t.vx) <= drop ? 0 : t.vx - Math.sign(t.vx) * drop;
  }
  t.vx = Math.max(-BALL_MAX_SPEED, Math.min(BALL_MAX_SPEED, t.vx));
  t.vy = Math.max(-BALL_MAX_SPEED, Math.min(t.vy + GRAVITY * dt, MAX_FALL));
  const x0 = t.x, y0 = t.y;
  moveBody(world, t, size, height, dt, { ignore: t, blockers: [playerBox(player)], wasOnGround: wasOn, noStep: true });
  t.tilt = 0;
  if (spaceMode(world, t) === 'low' && !(whole(t.x) && whole(t.y)) && !snapForced(world, player, t)) {
    if (!wasLow) { Object.assign(t, prev); t.vx = 0; t.vy = 0; }       // it came in from 8-bit space and cannot snap: the edge is a wall
  }
  const dx = t.x - x0;
  if (dx !== 0 && !isBall(world, t) && Math.abs(dx) < 1) carrySmoothRiders(world, player, t, size, x0, y0, dx, new Set([t]));
  if (g) {                                                // the glide ends after one tile, where it was stopped, or on snapping to tiles
    g.left -= Math.abs(dx);
    if (g.left < 1e-6 && Math.abs(t.x - g.to) < 1e-6) t.x = g.to;         // no float dust: the low-res row that follows needs the room exactly
    if (g.left < 1e-6 || dx === 0 || !isSmooth(world, t)) { endGlide(world, t); t.vx = 0; }
  }
  t.lx = t.x; t.ly = t.y; t.fx = t.x; t.fy = t.y;
}

const LOW_TILES_MAX = 3;      // a thing never needs more than a tile or two per step; the cap only guards against a runaway

// One cell: (dx, dy) is the move in tiles, a whole cell along one axis.
function lowTile(world, player, t, dx, dy) {
  if (!canMoveT(world, t, dx, dy, player)) return false;
  const above = dx !== 0 && !isBall(world, t) ? lowStackAbove(world, t) : null;
  const prev = { ...t };
  t.x += dx; t.y += dy;
  if (!settleMove(world, player, t, prev)) return false;
  if (above) carryLowStack(world, player, t, prev, above, Math.sign(dx));
  return true;
}

// The nearest place on a grid of `cell` tiles (exactly Math.round when the cell is a whole tile).
const onGrid = (v, cell) => Math.round(v / cell) * cell;

function stepLowThing(world, player, t, dt) {
  const [size, height] = dimsOfT(world, t);
  if (t.lx !== t.x || t.fx === undefined) t.fx = t.x;
  if (t.ly !== t.y || t.fy === undefined) t.fy = t.y;
  if (!Number.isFinite(t.vx)) t.vx = 0;
  if (!Number.isFinite(t.vy)) t.vy = 0;
  const cell = gridCell(world, t);
  const grounded = !canMoveT(world, t, 0, cell, player);
  if (grounded && t.vy >= 0) {
    t.vy = 0; t.fy = t.y;
    const slippery = (world.iceInLow ?? ICE_IN_LOW) === true && iceUnder(world, t.x, t.y, size, height);
    if (!slippery && t.vx !== 0) {
      const drop = CRATE_FRICTION * dt;
      t.vx = Math.abs(t.vx) <= drop ? 0 : t.vx - Math.sign(t.vx) * drop;
    }
  } else t.vy = Math.max(-BALL_MAX_SPEED, Math.min(t.vy + GRAVITY * dt, MAX_FALL));
  t.vx = Math.max(-BALL_MAX_SPEED, Math.min(BALL_MAX_SPEED, t.vx));
  if (t.vx === 0) t.fx = t.x;
  t.fx += t.vx * dt; t.fy += t.vy * dt;
  for (let n = 0; n < LOW_TILES_MAX && t.x !== onGrid(t.fx, cell); n++) {
    const dir = Math.sign(onGrid(t.fx, cell) - t.x);
    if (!lowTile(world, player, t, dir * cell, 0)) { t.vx = 0; t.fx = t.x; break; }
    if (thingMode(world, t) !== 'low') return;                // it crossed into an 8-bit tile and is a body now
  }
  for (let n = 0; n < LOW_TILES_MAX && t.y !== onGrid(t.fy, cell); n++) {
    const dir = Math.sign(onGrid(t.fy, cell) - t.y);
    if (!lowTile(world, player, t, 0, dir * cell)) { t.vy = 0; t.fy = t.y; break; }
    if (thingMode(world, t) !== 'low') return;
  }
  slideOffHead(world, player, t, size, height, cell);
  t.lx = t.x; t.ly = t.y;
  t.onGround = !canMoveT(world, t, 0, cell, player);
}

// A low-res crate whose only support is the player's head steps a tile sideways (every few steps) toward the side where more
// of it hangs past the player's centre (a tie: away from the way the player is going, else right), the other side if that one
// is blocked; if neither is free it stays. Once clear of the player it falls as usual.
const HEAD_WAIT = 6;
function slideOffHead(world, player, t, size, height, cell) {
  if (isBall(world, t)) return;
  // (The player's head is a half tile up, so a low-res crate may stop up to half a tile above it: it counts as resting on him.)
  const onHead = !canMoveT(world, t, 0, cell, player) && !boxHitsSolid(world, t.x, t.y + cell, size, height, world.mode, t) && t.vy >= 0
    && t.x < player.x + PLAYER_W - EPS && t.x + size > player.x + EPS;
  if (!onHead) { delete t.headWait; return; }
  t.headWait = (t.headWait || 0) + 1;
  if (t.headWait < HEAD_WAIT) return;
  t.headWait = 0;
  const pcx = player.x + PLAYER_W / 2, d = t.x + size / 2 - pcx;
  const first = Math.abs(d) > 1e-6 ? Math.sign(d) : (player.vx > 0 ? -1 : 1);
  for (const dir of [first, -first]) {
    if (lowTile(world, player, t, dir * cell, 0)) { t.fx = t.x; t.vx = 0; return; }
  }
}

// A forced ball moving smoothly (isSmooth) that the player is pushing (pushDir, set by tryPushBall) and that rests on something
// pushes the forced crate touching its front (within a pixel and a half, overlapping it in height as rowFrom judges) exactly as
// the player pushes it (tryPush): a smooth one is told it is pushed (pushDir, then CRATE_PUSH_SPEED in stepSmooth with the same
// walls, ledges, pits and snapping to tiles entering low-res space); one on tiles in low-res space (it has just snapped there)
// moves a tile with its row (pushLowRow), then the ball waits PUSH_COOLDOWN as the player does. Only grenade-pixelated things:
// an 8-bit ball never pushes a crate, a forced ball pushes no 8-bit crate, and a ball sliding on its own (nobody pushing it)
// pushes nothing. Returns [crate, ball] pairs: the crate steps before the ball, so the ball moves into the room it made.
function smoothBallPushes(world, player, dt) {
  const pairs = [];
  for (const b of world.balls) {
    if (b.pushWait > 0) b.pushWait -= dt;
    const dir = b.pushDir;
    if (!dir || b.onGround !== true || !isSmooth(world, b) || b.pushWait > 0) continue;
    const c = cratesOf(world).find((d) => {
      if (!d.forceLow || thingMode(world, d) !== 'low') return false;
      const gap = dir > 0 ? d.x - (b.x + BALL_SIZE) : b.x - (d.x + wOf(d));
      if (gap < -1 / PX8 || gap > 1.5 / PX8) return false;
      return !(d.y + hOf(d) - 2 / PX8 <= b.y || d.y >= b.y + BALL_SIZE - 2 / PX8);
    });
    if (!c) continue;
    const smooth = isSmooth(world, c);
    if (!tryPush(world, c, dir, player)) continue;
    if (smooth) pairs.push([c, b]); else b.pushWait = PUSH_COOLDOWN;
  }
  return pairs;
}

// Step every crate and ball that lives in low-res (lowest first, so a stack falls from the bottom), then take away what has
// left the level. (8-bit crates are bodies, see stepCrates; 8-bit balls, stepBalls.)
export function stepLow(world, player, dt) {
  const items = [];
  for (const c of cratesOf(world)) if (thingMode(world, c) === 'low' && !isPinned(world, c)) items.push({ obj: c, size: hOf(c) });
  for (const b of world.balls) if (thingMode(world, b) === 'low') items.push({ obj: b, size: BALL_SIZE });
  const rising = (it) => ((it.obj.vy || 0) < 0 ? 0 : 1);      // things rising together (a spring's stack): the upper one first
  items.sort((p, q) => (rising(p) - rising(q)) || (rising(p) === 0 ? (p.obj.y + p.size) - (q.obj.y + q.size) : (q.obj.y + q.size) - (p.obj.y + p.size)));
  for (const [c, b] of smoothBallPushes(world, player, dt)) {     // a crate a smooth ball pushes steps just before that ball
    const ic = items.findIndex((it) => it.obj === c), ib = items.findIndex((it) => it.obj === b);
    if (ic > ib) items.splice(ib, 0, ...items.splice(ic, 1));
  }
  for (const it of items) {
    const t = it.obj;
    if (thingMode(world, t) !== 'low') continue;
    if (t.forceLow) {
      if (spaceMode(world, t) === 'low' && !(whole(t.x) && whole(t.y))) snapForced(world, player, t);   // a zone appeared over it, or the world swapped
      if (isSmooth(world, t)) { stepSmooth(world, player, t, dt); continue; }
    }
    stepLowThing(world, player, t, dt);
  }
  for (let i = world.crates.length - 1; i >= 0; i--) {
    if (world.crates[i].y >= world.height && thingMode(world, world.crates[i]) === 'low') { unstampCrate(world, world.crates[i]); world.crates.splice(i, 1); }
  }
  for (let i = world.balls.length - 1; i >= 0; i--) {
    if (world.balls[i].y >= world.height && thingMode(world, world.balls[i]) === 'low') world.balls.splice(i, 1);
  }
  for (let i = world.props.length - 1; i >= 0; i--) {
    const p = world.props[i];
    if (isSmallCrate(p) && p.y >= world.height && thingMode(world, p) === 'low') world.props.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Platforms carry crates (props/platform.js). A crate resting on a platform's top (8-bit: within a pixel and a half, and
// on the ground; low-res, on a low-res platform: directly on its top row) moves with it each step by the same amount when
// the place is free, else it is left behind (as the player rider is). What rests on such a crate rides rigidly too, level
// by level. A ball in low-res is a box and is carried; a ball in 8-bit is not (it stays where it is and the platform
// slides away under it). While carried a thing keeps t.ride = { p, vx, vy }, the platform's velocity: its own vx is then
// relative to the platform, and when it is no longer on it the platform's velocity is added (conservation of momentum;
// releaseRiders) and friction stops it.
// ---------------------------------------------------------------------------------------------------------------
// The things riding platform p now: [{ t, ball, onPlatform, under }] bottom level first (under: the rider it rests on).
export function platformRiders(world, p) {
  const riders = [];
  const seen = new Set();
  let bases = [{ x: p.x, w: p.w, y: p.y, mode: thingMode(world, p), platform: true, rider: null }];
  while (bases.length) {
    const next = [];
    for (const t of [...cratesOf(world), ...world.balls]) {
      if (seen.has(t)) continue;
      const ball = isBall(world, t), mode = thingMode(world, t);
      if (ball ? mode !== 'low' : (t.tilt || isPinned(world, t) || t.onGround !== true)) continue;
      const [size, height] = dimsOfT(world, t);
      const base = bases.find((b) => {
        if (!(t.x < b.x + b.w - EPS && t.x + size > b.x + EPS)) return false;
        const gap = t.y + height - b.y;
        if (mode === '8bit') return Math.abs(gap * PX8) <= 1.5 && (b.platform || b.mode === '8bit');
        return Math.abs(gap) < EPS && b.mode === 'low';
      });
      if (!base) continue;
      seen.add(t);
      const r = { t, ball, onPlatform: base.platform, under: base.rider };
      riders.push(r);
      if (!ball) next.push({ x: t.x, w: size, y: t.y, mode, platform: false, rider: r });
    }
    bases = next;
  }
  return riders;
}

// Things that rode platform p and no longer do take its velocity with them.
export function releaseRiders(world, p, riders) {
  for (const t of [...cratesOf(world), ...world.balls]) {
    if (!t.ride || t.ride.p !== p || riders.some((r) => r.t === t)) continue;
    if ((world.crates.includes(t) || isSmallCrate(t)) && thingMode(world, t) === '8bit') t.mom = (t.mom || 0) + t.ride.vx; else t.vx = (t.vx || 0) + t.ride.vx;
    t.vy = (t.vy || 0) + t.ride.vy;
    delete t.ride;
  }
}

// Record that the riders (the carried ones, or all when carried is null) go with p at velocity (vx, vy); the others do not.
export function holdRiders(riders, carried, p, vx, vy) {
  for (const r of riders) {
    if (!carried || carried.has(r.t)) r.t.ride = { p, vx, vy }; else delete r.t.ride;
  }
}

// An 8-bit crate moved by (dx, dy) tiles with its platform (already at its new place): onto its top if it fits, else by the
// same amount. False when neither place is free.
function carryCrate8(world, player, t, dx, dy, plat) {
  const ctx = crateContext(world, t, player);
  const { cx, cy, tilt } = poseOf(t);
  const nx = cx + dx * PX8;
  const tries = [];
  if (plat) {
    const top = plat.y * PX8;
    tries.push(Math.min(top, Math.floor(top + 1e-9) + 0.5) - ctx.hh);     // bottom edge on the top (a pixel row the slab covers only partly is left to it)
  }
  tries.push(cy + dy * PX8);
  for (const ny of tries) {
    if (!free(ctx, nx, ny, tilt)) continue;
    if (isSmallCrate(t)) { placeSmall(t, nx, ny); return true; }
    t.x = nx / PX8 - CRATE_SIZE / 2; t.y = ny / PX8 - CRATE_SIZE / 2;
    stampCrate(world, t);
    return true;
  }
  return false;
}

// Move the riders (and what rests on them) by (dx, dy) with platform p, which is already at its new place. Returns the set of
// the ones carried and undo(), which puts every moved one back. (dx = dy = 0 moves nothing.)
export function carryRiders(world, player, p, riders, dx, dy) {
  let moved = [];                                           // { t, before }
  const put = ({ t, before }) => Object.assign(t, before);
  if (dx !== 0 || dy !== 0) {
    const order = riders.slice().sort((a, b) => (dx * b.t.x + dy * b.t.y) - (dx * a.t.x + dy * a.t.y));   // the front first, so each makes room for the next
    for (const r of order) {
      const t = r.t, before = { ...t };
      let ok;
      if (thingMode(world, t) === 'low') {
        ok = canMoveT(world, t, dx, dy, player);
        if (ok) { t.x += dx; t.y += dy; }
      } else ok = carryCrate8(world, player, t, dx, dy, r.onPlatform ? p : null);
      if (ok && zoned(world) && !settleMove(world, player, t, before)) ok = false;
      if (ok) moved.push({ t, before });
    }
    // what rests on one that stayed stays too
    for (let again = true; again;) {
      again = false;
      for (const r of riders) {
        if (r.under && !moved.some((m) => m.t === r.under.t) && moved.some((m) => m.t === r.t)) {
          put(moved.find((m) => m.t === r.t));
          moved = moved.filter((m) => m.t !== r.t);
          again = true;
        }
      }
    }
    syncDyn(world);
  }
  const carried = dx === 0 && dy === 0 ? new Set(riders.map((r) => r.t)) : new Set(moved.map((m) => m.t));
  return { carried, undo: () => { for (const m of moved.slice().reverse()) put(m); syncDyn(world); } };
}

function restsOver(box, button) {
  return Math.abs(box.y + box.h - (button.y + 1)) <= EPS
    && box.x < button.x + 1 && box.x + box.w > button.x;
}

// Is any crate pixel inside the box (8-bit) or any crate box overlapping it (low-res), or any small crate's box?
const crateIn = (world, box) => dynOwnerInBox(world, box.x, box.y, box.w, box.h) !== 0
  || world.crates.some((c) => thingMode(world, c) === 'low' && overlaps(crateBox(c), box))
  || world.props.some((p) => isSmallCrate(p) && overlaps(p, box));

// The button's picture as render8 draws it, not pressed (a red cap standing proud of its base, each 2 pixels high), standing on the bottom
// of its tile. On the resolution slider this is the picture that is voted.
export const BUTTON_ROWS = ['.######.', '.######.', '########', '########'];
// Does the button work at the slider's step (its own tile's step)? While its voted picture keeps its shape (slider.js
// keepsShape): at steps 4 and 8; at step 2 it is a flat slab and frozen, as in low-res.
export const buttonWorks = (world, btn) => !middleStep(world, btn.x, btn.y) || keepsShape(rowsClass(world, BUTTON_ROWS, btn.x, btn.y));

// A button works where its own tile is 8-bit; a door follows its button only then (a button in a low-res tile
// keeps the state it had, as the whole world does in low-res). The same for a button frozen by the slider's step 2.
export function updateDoors(world, player) {
  if (world.mode !== '8bit' && !hasZones(world)) return;
  const pb = playerBox(player);
  const live = (btn) => modeAt(world, btn.x, btn.y) === '8bit' && buttonWorks(world, btn);
  for (const btn of world.buttons) {
    if (!live(btn)) continue;
    // A crate presses a button only lying flat on it.
    btn.pressed = (player.onGround === true && restsOver(pb, btn))
      || world.crates.some((c) => Math.abs(c.tilt || 0) < 1e-9 && restsOver(crateBox(c), btn))
      || world.balls.some((b) => restsOver(ballBox(b), btn))
      || world.props.some((p) => p.type === 'smallcrate' && restsOver(p, btn));
  }
  for (const door of world.doors) {
    if (!world.buttons.some((b) => b.id === door.id && live(b))) continue;
    const pressed = world.buttons.some((b) => b.id === door.id && b.pressed);
    if (pressed) { door.open = true; continue; }
    if (!door.open) continue;
    const db = { x: door.x, y: door.y, w: DOOR_W, h: DOOR_H };
    if (!overlaps(pb, db) && !crateIn(world, db)
      && !world.balls.some((b) => overlaps(ballBox(b), db))) door.open = false;
  }
}

// 8-bit only: stalactites (W) and stalagmites (M) kill when any of their solid pixels lies inside
// the player's box grown by one pixel on every side. Low-res: plain blocks. On the resolution slider the pixels are the
// voted terrain at the step, and a tooth is deadly only while it has a point (slider.js keepsShape): stubby but pointed
// at step 4, a blunt slab of rock (harmless) at step 2.
export function touchesBigSpikes(world, player) {
  if (world.mode !== '8bit' && !hasZones(world)) return false;
  const zoned = hasZones(world);
  const r = (v) => Math.round(v * PX8 * 1e6) / 1e6; // level pixels, immune to float dust
  const left = r(player.x) - 1, right = r(player.x + PLAYER_W) + 1;
  const top = r(player.y) - 1, bottom = r(player.y + PLAYER_H) + 1;
  const x0 = Math.max(0, Math.floor(left)), x1 = Math.min(world.maskW - 1, Math.ceil(right) - 1);
  const y0 = Math.max(0, Math.floor(top)), y1 = Math.min(world.maskH - 1, Math.ceil(bottom) - 1);
  const { mask } = world;
  const pointed = world.res ? (tx, ty) => !middleStep(world, tx, ty) || keepsShape(tileClass((x, y) => mask[(ty * PX8 + y) * world.maskW + tx * PX8 + x] === 1, 1)) : () => true;
  for (let y = y0; y <= y1; y++) {
    const row = world.shapes[Math.floor(y / PX8)];
    if (!row) continue;
    for (let x = x0; x <= x1; x++) {
      const ch = row[Math.floor(x / PX8)];
      if ((ch === 'W' || ch === 'M') && mask[y * world.maskW + x] === 1 && (!zoned || modeAt(world, x >> 3, y >> 3) === '8bit') && pointed(x >> 3, y >> 3)) return true;
    }
  }
  return false;
}

// Do spikes work at the slider's step (their own tile's step)? While their voted picture keeps its points (slider.js
// keepsShape): at steps 4 and 8. At step 2 it is a flat slab: harmless, and not there (the study's recommendation).
export const spikesWork = (world, s) => !middleStep(world, s.x, s.y) || keepsShape(rowsClass(world, SPIKES.rows, s.x, s.y));

export function touchesSpikes(world, player) {
  if (world.mode !== '8bit' && !hasZones(world)) return false;
  const pb = playerBox(player);
  return world.spikes.some((s) => modeAt(world, s.x, s.y) === '8bit' && spikesWork(world, s) && overlaps(pb, { x: s.x, y: s.y + 1 - DETAIL_H, w: 1, h: DETAIL_H }));
}
