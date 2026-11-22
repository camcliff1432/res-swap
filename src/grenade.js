// The resolution grenade: throwing, flight and the low-res zones it makes. Pure rules, no page. The pickup prop
// (src/props/grenade.js) fills the player's queue, `world.held` (each: { kind, seconds, radius }, in pickup
// order). A throw takes the first one and lobs it from the player's centre; in flight it is a small body under gravity
// (`world.flying`) that bounces off walls and ceilings and goes off on its first touch of the ground, after a fuse, or
// at once when it falls out of the level. Going off makes a low-res zone (`world.gzones`, kind 'grenade'): a circle of
// `radius` tiles round the grenade's centre (the tiles whose centres are that close; tiles outside the level are left out).
// A "things" grenade's zone is permanent and also turns the movable things in it low-res for good (world.js pixelateThings). The sim (sim.js) hands the zones to setZones with the windows and the wave
// and ends the timed ones. A grenade with a `step` (stage 4 of the slider) makes its area at that step instead (zones.js withStep).
import { STEP, PLAYER_W, PLAYER_H, GRAVITY, MAX_FALL } from './constants.js';
import { moveBody } from './motion.js';
import { withStep } from './zones.js';

export const GRENADE_SPEED_X = 8, GRENADE_SPEED_Y = -8;        // tiles/s: an ordinary lob, in the facing direction
export const GRENADE_HIGH_X = 5, GRENADE_HIGH_Y = -13;          // holding up: a higher lob
export const GRENADE_SIZE = 0.5;                                // tiles
export const GRENADE_BOUNCE = 0.6;                              // share of the speed kept when it bounces off a wall or ceiling
export const GRENADE_FUSE = 3;                                  // seconds in the air before it goes off by itself
export const THROW_COOLDOWN = 0.3;                              // seconds between throws
const FUSE_STEPS = Math.round(GRENADE_FUSE / STEP), COOLDOWN_STEPS = Math.round(THROW_COOLDOWN / STEP);

// Throw the next grenade, if one is held and the cooldown is over. `held`: the input (up or jump throws high, down
// drops it at the feet). The grenade starts at the player's centre, or at their feet for a drop. True when thrown.
export function throwGrenade(world, player, held) {
  if (world.held.length === 0 || world.throwCool > 0) return false;
  const info = world.held.shift();
  const dir = player.facing === -1 ? -1 : 1;
  let vx = dir * GRENADE_SPEED_X, vy = GRENADE_SPEED_Y, cy = player.y + PLAYER_H / 2;
  if (held.down) { vx = 0; vy = 0; cy = player.y + PLAYER_H - GRENADE_SIZE / 2; }
  else if (held.up || held.jump) { vx = dir * GRENADE_HIGH_X; vy = GRENADE_HIGH_Y; }
  const cx = player.x + PLAYER_W / 2;
  world.flying.push({ x: cx - GRENADE_SIZE / 2, y: cy - GRENADE_SIZE / 2, vx, vy, onGround: false, age: 0, info });
  world.throwCool = COOLDOWN_STEPS;
  return true;
}

// The zone a grenade makes when it goes off with its centre at (cx, cy) tiles: the tiles whose centre is within `radius` of
// it, as a box (cut to the level) and a mask over the box (zones.js). null when no tile of the level is in reach.
export function grenadeZone(world, info, cx, cy) {
  const r = info.radius ?? 3;
  const tiles = [];
  for (let ty = Math.max(0, Math.floor(cy - r)); ty <= Math.min(world.height - 1, Math.floor(cy + r)); ty++) {
    for (let tx = Math.max(0, Math.floor(cx - r)); tx <= Math.min(world.width - 1, Math.floor(cx + r)); tx++) {
      if (Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy) <= r + 1e-9) tiles.push([tx, ty]);
    }
  }
  if (tiles.length === 0) return null;
  const x = Math.min(...tiles.map((t) => t[0])), y = Math.min(...tiles.map((t) => t[1]));
  const w = Math.max(...tiles.map((t) => t[0])) - x + 1, h = Math.max(...tiles.map((t) => t[1])) - y + 1;
  const mask = new Uint8Array(w * h);
  for (const [tx, ty] of tiles) mask[(ty - y) * w + (tx - x)] = 1;
  const gkind = info.kind === 'permanent' || info.kind === 'things' ? info.kind : 'timed';
  const left = gkind === 'timed' ? Math.round(info.seconds / STEP) : null;
  const zone = { x, y, w, h, mask, cx, cy, r, mode: 'low', kind: 'grenade', gkind, seconds: gkind === 'timed' ? info.seconds : null, left, applied: false };
  return info.step === undefined ? zone : withStep(zone, info.step);
}

// Move every grenade a step. Returns the events: { type: 'pop', x, y } for each that went off (its zone is added to
// world.gzones, not yet applied: the sim applies it at the start of the next step).
export function stepGrenades(world, dt = STEP) {
  const events = [];
  if (world.throwCool > 0) world.throwCool--;
  const keep = [];
  for (const g of world.flying) {
    g.age++;
    g.vy = Math.min(g.vy + GRAVITY * dt, MAX_FALL);
    const vx0 = g.vx, vy0 = g.vy;
    const { blockedX } = moveBody(world, g, GRENADE_SIZE, GRENADE_SIZE, dt, { wasOnGround: false });
    let off = g.age >= FUSE_STEPS || g.y > world.height;
    if (blockedX !== 0) g.vx = -vx0 * GRENADE_BOUNCE;
    if (g.vy === 0 && vy0 !== 0) {
      if (vy0 > 0) off = true;                    // it touched the ground (or anything under it): it goes off
      else g.vy = -vy0 * GRENADE_BOUNCE;          // a ceiling: it bounces
    }
    if (!off) { keep.push(g); continue; }
    const cx = Math.min(world.width, Math.max(0, g.x + GRENADE_SIZE / 2)), cy = Math.min(world.height - 0.5, Math.max(0, g.y + GRENADE_SIZE / 2));
    const zone = grenadeZone(world, g.info, cx, cy);
    if (zone) world.gzones.push(zone);
    events.push({ type: 'pop', x: Math.min(world.width - 1, Math.floor(cx)), y: Math.floor(cy) });
  }
  world.flying = keep;
  return events;
}

// The zones the grenades hold now (those the sim has applied), for setZones, in the order they went off (a later one wins
// where two with different steps overlap; without steps they are all low-res and the order does not matter).
export const appliedGrenadeZones = (world) => world.gzones.filter((z) => z.applied)
  .map((z) => ({ x: z.x, y: z.y, w: z.w, h: z.h, mask: z.mask, mode: z.mode, kind: 'grenade', gkind: z.gkind, ...(z.step === undefined ? {} : { step: z.step }) }));

// Start of a step: apply the zones that appeared since the last one and count down the timed ones, removing those that
// ended. Returns null when no zone appeared or went, else the Set of tile columns the change touches (what could have
// become solid under the player); the caller then rebuilds the zone list.
export function advanceGrenadeZones(world) {
  let cols = null;
  const touch = (z) => { cols ??= new Set(); for (let c = z.x; c < z.x + z.w; c++) cols.add(c); };
  for (const z of world.gzones) {
    if (!z.applied) { z.applied = true; touch(z); if (z.gkind === 'things') world.blasts.push(z); }
    else if (z.left !== null && --z.left <= 0) { z.dead = true; touch(z); }
  }
  if (cols) world.gzones = world.gzones.filter((z) => !z.dead);
  return cols;
}
