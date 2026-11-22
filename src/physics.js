import { PLAYER_W, PLAYER_H, CLIMB_SPEED, CRATE_SIZE, BALL_SIZE, RUN_SPEED, GRAVITY, JUMP_SPEED, MAX_FALL, PUSH_COOLDOWN, PX8, ICE_ACCEL, ICE_SLOPE_ACCEL, BALL_MAX_SPEED, STEP_UP } from './constants.js';
import { moveBody } from './motion.js';
import { boxHitsSolid, iceActive, iceUnder } from './world.js';
import { thingMode } from './zones.js';
import { tryPush, tryPushBall, crateToPush, isSmooth, cratesOf, isSmallCrate, pushSmallCrate, ballUnderfoot, runOnBall } from './objects.js';
import { openKeyDoor } from './props/keydoor.js';
import { ladderFor } from './props/ladder.js';

export function createPlayer(start) {
  return { x: start.x, y: start.y, vx: 0, vy: 0, onGround: false, onLadder: false, pushTimer: 0, facing: 1 };
}

// A crate resting on top of another crate (the top of a stack). Small crates too, with their own boxes.
const wOf = (c) => (isSmallCrate(c) ? c.w : CRATE_SIZE), hOf = (c) => (isSmallCrate(c) ? c.h : CRATE_SIZE);
function onACrate(world, c) {
  return cratesOf(world).some((d) => d !== c && Math.abs(d.y - (c.y + hOf(c))) < 2 / PX8 && d.x < c.x + wOf(c) && d.x + wOf(d) > c.x);
}

// In the air the player can push only the top crate of a stack (jump up and shove it off) or a crate that is itself in
// the air (knock it sideways: it keeps that speed in flight).
function pushCrateInAir(world, player, dir) {
  const bx = player.x + dir * (1.5 / PX8);
  for (const c of cratesOf(world)) {
    if ((c.onGround && !onACrate(world, c)) || (c.tilt || 0) !== 0) continue;   // a stack's top, or a crate in the air
    if (bx < c.x + wOf(c) && bx + PLAYER_W > c.x && player.y < c.y + hOf(c) && player.y + PLAYER_H > c.y) {
      if (tryPush(world, c, dir, player)) return thingMode(world, c) === 'low' && !isSmooth(world, c) ? 'low' : 'body';
    }
  }
  return false;
}

// Push the crate in the way: 'body' for a crate that lives in 8-bit (it is told the player is pushing and moves smoothly,
// see stepCrates), 'low' for one in low-res (a tile at a time), false when nothing moved.
function pushCrate(world, player, dir) {
  const body = crateToPush(world, player, dir);          // the pixels of 8-bit crates
  if (body) return tryPush(world, body, dir, player) ? 'body' : false;
  const bx = player.x + dir * 0.05;
  for (const c of world.crates) {
    if (thingMode(world, c) !== 'low') continue;
    if (bx < c.x + CRATE_SIZE && bx + PLAYER_W > c.x && player.y < c.y + CRATE_SIZE && player.y + PLAYER_H > c.y) {
      return tryPush(world, c, dir, player) ? (isSmooth(world, c) ? 'body' : 'low') : false;
    }
  }
  return pushSmallCrate(world, player, dir);              // a small crate: pushed as a crate (objects.js)
}

// inAir: the player is in the air. A ball in the air is knocked sideways; so is one resting on something, exactly as a player
// standing beside it would push it (changed 2026-11-20: before, only a ball in the air could be pushed from the air), unless the
// player only catches its top: feet no more than STEP_UP below it is landing on the ball (or brushing its top), not a push.
function pushBall(world, player, dir, inAir = false) {
  const bx = player.x + dir * 0.05;
  for (const b of world.balls) {
    if (inAir && b.onGround && player.y + PLAYER_H - b.y <= STEP_UP + 1e-9) continue;
    if (bx < b.x + BALL_SIZE && bx + PLAYER_W > b.x && player.y < b.y + BALL_SIZE && player.y + PLAYER_H > b.y) {
      return tryPushBall(world, b, dir, player) ? b : null;
    }
  }
  return null;
}

// On an icy slope: which way is downhill (-1 left, 1 right, 0 none)? Found like the balls do it: shift the
// body one pixel down and one pixel sideways; the side that is free is downhill.
function downhill(world, player) {
  const free = (dx) => !boxHitsSolid(world, player.x + dx / PX8, player.y + 1 / PX8, PLAYER_W, PLAYER_H, world.mode);
  const right = free(1), left = free(-1);
  return right === left ? 0 : right ? 1 : -1;
}

// Sideways speed on ice: it moves toward the wanted speed by at most ICE_ACCEL * dt, and an icy slope pulls downhill.
function iceSpeed(world, player, wanted, dt) {
  const gap = wanted - player.vx, d = ICE_ACCEL * dt;
  let vx = Math.abs(gap) <= d ? wanted : player.vx + Math.sign(gap) * d;
  vx += downhill(world, player) * ICE_SLOPE_ACCEL * dt;
  return Math.max(-BALL_MAX_SPEED, Math.min(BALL_MAX_SPEED, vx));
}

export function stepPlayer(world, player, held, dt) {
  const lad = ladderFor(world, player);
  const sideways = held.left || held.right;
  const wasOn = player.onLadder === true;
  // A player whose ladder vanished (swap, or walked clear) no longer counts the climb as ground.
  const wasOnGround = player.onGround && !(wasOn && !lad);
  const on = !!lad && !sideways && (wasOn || !wasOnGround || held.jump || held.up || held.down);
  player.onLadder = on;

  if (on) {
    player.vx = 0;
    player.vy = (held.down ? 1 : 0) * CLIMB_SPEED - ((held.jump || held.up) ? 1 : 0) * CLIMB_SPEED;
    // Feet never rise above the ladder's top.
    const top = lad.y - PLAYER_H;
    if (player.vy < 0) player.vy = Math.max(player.vy, (top - player.y) / dt);
    moveBody(world, player, PLAYER_W, PLAYER_H, dt, { wasOnGround: true });
    if (player.y < top) player.y = top;
    player.onGround = true;
    player.pushTimer -= dt;
    return;
  }

  const wanted = ((held.right ? 1 : 0) - (held.left ? 1 : 0)) * RUN_SPEED;
  if (wanted !== 0) player.facing = wanted > 0 ? 1 : -1;       // the way they face (a throw goes that way, the picture shows it)
  const onIce = wasOnGround && iceActive(world) && iceUnder(world, player.x, player.y, PLAYER_W, PLAYER_H, true);
  player.vx = onIce ? iceSpeed(world, player, wanted, dt) : wanted;
  // Running on a ball drives it the other way (objects.js runOnBall); found where he stands before he moves.
  const underfoot = wasOnGround && wanted !== 0 ? ballUnderfoot(world, player) : null;
  if (underfoot) runOnBall(world, underfoot, Math.sign(wanted));
  if (held.jump && wasOnGround) player.vy = -JUMP_SPEED;
  player.vy = Math.min(player.vy + GRAVITY * dt, MAX_FALL);

  const { blockedX } = moveBody(world, player, PLAYER_W, PLAYER_H, dt, { wasOnGround });
  if (blockedX !== 0) openKeyDoor(world, player, blockedX);
  if (blockedX !== 0 && wasOnGround && player.pushTimer <= 0) {
    const crate = pushCrate(world, player, blockedX);
    if (crate) { if (crate === 'low') player.pushTimer = PUSH_COOLDOWN; }
    else {
      const ball = pushBall(world, player, blockedX);
      if (ball && thingMode(world, ball) === 'low' && !isSmooth(world, ball)) player.pushTimer = PUSH_COOLDOWN;
    }
  } else if (blockedX !== 0 && !wasOnGround && player.pushTimer <= 0) {
    const crate = pushCrateInAir(world, player, blockedX);
    if (crate === 'low') player.pushTimer = PUSH_COOLDOWN;
    else if (!crate) {
      const ball = pushBall(world, player, blockedX, true);
      if (ball && thingMode(world, ball) === 'low' && !isSmooth(world, ball)) player.pushTimer = PUSH_COOLDOWN;
    }
  }

  player.pushTimer -= dt;
}

export function fellOut(world, player) {
  return player.y > world.height;
}

export function atExit(player, exit) {
  return player.x < exit.x + PLAYER_W && player.x + PLAYER_W > exit.x
    && player.y < exit.y + PLAYER_H && player.y + PLAYER_H > exit.y;
}
