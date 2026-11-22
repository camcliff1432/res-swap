// Spring: a one-tile solid block. While the spring itself is in 8-bit, whatever rests on it is launched upward at
// SPRING_SPEED (the player standing on it, balls and crates, in 8-bit or low-res; a low-res thing then flies in whole-tile
// steps, see stepLow), whether or not Jump is held. Everything resting on a launched crate, level by level (crates, balls, the
// player standing on any of them), is launched with it, so a stack rises together. A spring that is itself in low-res is a
// plain block, nothing bounces. So is one on the resolution slider whose picture, voted at the step, is a plain full box
// (slider.js): it bounces at steps 8 and 4 (the coils still show) and is a plain block from step 2.
import { PLAYER_W, PLAYER_H, BALL_SIZE, CRATE_SIZE, SPRING_SPEED, PX8 } from '../constants.js';
import { px, EPS } from './common.js';
import { modeOfBox, hasZones, thingMode } from '../zones.js';
import { isPinned, cratesOf, isSmallCrate } from '../objects.js';
import { heldByChain } from './chain.js';
import { drawnKeepsDetail } from '../slider.js';

const BASE = '#3C3C3C', BASE_LIGHT = '#7C7C7C', COIL = '#FCFCFC', COIL_DARK = '#BCBCBC', CAP = '#F83800';
const LOW_COLOUR = '#B59388';      // what its picture averages to (white coils, grey base, a red cap); it was a pink (#FC74B4)

// Standing on the spring: feet level with its top and at least half a tile of overlap sideways.
function standsOn(spring, x, y, w, h) {
  if (Math.abs(y + h - spring.y) > EPS) return false;
  const overlap = Math.min(x + w, spring.x + spring.w) - Math.max(x, spring.x);
  return overlap >= 0.5 - EPS;
}

export default {
  type: 'spring',
  label: 'Spring',
  defaults: {},
  fields: [],
  size: () => [1, 1],
  check: () => null,
  solid: true,
  followsPicture: true,
  draw8: drawSpring,
  drawLow(ctx, inst) {
    ctx.fillStyle = LOW_COLOUR;
    ctx.fillRect(px(inst.x), px(inst.y), px(inst.w), px(inst.h));
  },
  step(world, player) {
    if (world.mode !== '8bit' && !hasZones(world)) return;
    const springs = world.props.filter((p) => p.type === 'spring' && modeOfBox(world, p.x, p.y, p.w, p.h) === '8bit'
      && drawnKeepsDetail(world, p, drawSpring));
    if (springs.length === 0) return;
    const done = new Set();
    for (const s of springs) launchStack(world, player, s, done);
  },
};

function drawSpring(ctx, inst) {
  const x = px(inst.x), y = px(inst.y);
  ctx.fillStyle = BASE;
  ctx.fillRect(x, y + 6, 8, 2);          // base plate
  ctx.fillStyle = BASE_LIGHT;
  ctx.fillRect(x, y + 6, 8, 1);
  ctx.fillStyle = COIL;
  for (const cy of [2, 4]) ctx.fillRect(x + 1, y + cy, 6, 1);   // coil turns
  ctx.fillStyle = COIL_DARK;
  for (const cy of [3, 5]) ctx.fillRect(x + 2, y + cy, 4, 1);
  ctx.fillStyle = CAP;
  ctx.fillRect(x, y + 1, 8, 1);          // top plate
}

const FLAT = 1 / PX8, SETTLED = 1.5 / PX8;

// What rests on the box `base` (its top at base.y, a spring or a crate; `low`: the base is a low-res crate, whole tiles).
// A thing in 8-bit rests when it is on the ground with its bottom within a pixel (a spring) or a pixel and a half (a crate)
// of the top; a thing in low-res when its bottom row is directly on the top row. Sideways it must overlap the base (a spring:
// by at least half a tile for 8-bit things, as the standing rule says). Returns { player, balls, crates }, each not yet in `seen`.
function ridersOn(world, player, base, spring, seen) {
  const out = { player: false, balls: [], crates: [] };
  const over = (x, w) => Math.min(x + w, base.x + base.w) - Math.max(x, base.x);
  const need = (low) => (spring && !low ? 0.5 - EPS : EPS);
  const gapOk = (bottom, low) => Math.abs(bottom - base.y) <= (low ? EPS : spring ? FLAT : SETTLED);
  if (!seen.has(player) && !player.onLadder && player.onGround && Math.abs(player.y + PLAYER_H - base.y) <= EPS && over(player.x, PLAYER_W) >= need(false)) out.player = true;
  for (const b of world.balls) {
    if (seen.has(b) || heldByChain(world, b, BALL_SIZE)) continue;
    const low = thingMode(world, b) === 'low';
    if (low ? (b.vy || 0) < 0 : !b.onGround) continue;
    if (Math.abs(b.y + BALL_SIZE - base.y) <= (low ? EPS : spring ? EPS : SETTLED) && over(b.x, BALL_SIZE) >= need(low)) out.balls.push(b);
  }
  for (const c of cratesOf(world)) {                       // (small crates too, with their own boxes)
    if (seen.has(c) || c === base.crate || c.locked || isPinned(world, c)) continue;
    const low = thingMode(world, c) === 'low';
    if (low ? (c.vy || 0) < 0 : (!c.onGround || c.tilt)) continue;
    const [w, h] = isSmallCrate(c) ? [c.w, c.h] : [CRATE_SIZE, CRATE_SIZE];
    if (gapOk(c.y + h, low) && over(c.x, w) >= need(low)) out.crates.push(c);
  }
  return out;
}

// Launch what rests on spring `s` and, recursively, what rests on each launched crate (or ball: the player standing on it).
function launchStack(world, player, s, seen) {
  const queue = [{ x: s.x, y: s.y, w: s.w, spring: true, crate: null }];
  while (queue.length) {
    const base = queue.shift();
    const r = ridersOn(world, player, base, base.spring, seen);
    if (r.player) { seen.add(player); player.vy = -SPRING_SPEED; player.onGround = false; }
    for (const b of r.balls) {
      seen.add(b);
      b.vy = -SPRING_SPEED; b.onGround = false;
      queue.push({ x: b.x, y: b.y, w: BALL_SIZE, spring: false, crate: null });
    }
    for (const c of r.crates) {
      seen.add(c);
      c.vy = -SPRING_SPEED; c.onGround = false;
      queue.push({ x: c.x, y: c.y, w: isSmallCrate(c) ? c.w : CRATE_SIZE, spring: false, crate: c });
    }
  }
}
