import { PX8, LOW_SCALE, PLAYER_W, PLAYER_H, CRATE_SIZE, DOOR_W, DOOR_H, BALL_SIZE, ICE_IN_LOW } from './constants.js';
import { initDyn, syncDyn, rasterSquare, unstampCrate, CRATE_HALF } from './dyn.js';
import {
  zonesFromProps, rebuildModes, ensureModes, modeAt, modeOfBox, hasZones, zoned, thingMode, eachMover, zonedTerrainHits,
  middle, markStep, thingStep, stepOfBox, stepIn, baseStep, CELL,
} from './zones.js';

// Vote the pixel mask down to big pixels: solid when half or more of the pixels are solid.
export function buildLow(mask, maskW, maskH, scale = LOW_SCALE) {
  const cols = maskW / scale, rows = maskH / scale;
  const cells = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let count = 0;
      for (let y = 0; y < scale; y++) {
        const base = (cy * scale + y) * maskW + cx * scale;
        for (let x = 0; x < scale; x++) count += mask[base + x];
      }
      cells[cy * cols + cx] = 2 * count >= scale * scale ? 1 : 0;
    }
  }
  return { scale, cols, rows, cells };
}

// The shape of the things in the world's lists. createWorld and the spawner prop both build them here.
export const newBall = (x, y, vx = 0, vy = 0) => ({ x, y, vx, vy, onGround: false });
export const newCrate = (x, y, locked, cid, vx = 0, vy = 0) => ({ x, y, locked, tilt: 0, vx, vy, onGround: false, cid });

export function createWorld(level) {
  const world = {
    mode: '8bit',
    name: level.name,
    width: level.width,
    height: level.height,
    maskW: level.maskW,
    maskH: level.maskH,
    mask: level.mask,
    low: buildLow(level.mask, level.maskW, level.maskH),
    shapes: level.shapes,
    ice: level.ice,
    exit: { ...level.exit },
    spikes: level.spikes.map((s) => ({ ...s })),
    // A crate: x, y = top-left of its flat 2 x 2 box (whole tiles in low-res); in 8-bit also tilt (radians),
    // vx, vy (tiles/s), onGround, and cid, its number in the dynamic pixel layer (see dyn.js).
    crates: level.crates.map((c, i) => newCrate(c.x, c.y, c.locked, i + 1)),
    buttons: level.buttons.map((b) => ({ id: b.id, x: b.x, y: b.y, pressed: false })),
    doors: level.doors.map((d) => ({ id: d.id, x: d.x, y: d.y, open: false })),
    balls: (level.balls || []).map((b) => newBall(b.x, b.y)),
    props: (level.props || []).map((p) => ({ ...p })),
    keys: 0,
    // The resolution grenade (grenade.js): held in pickup order, in flight, the zones they made, and the throw cooldown (steps).
    held: [], flying: [], gzones: [], throwCool: 0,
    blasts: [],                  // "things" grenade zones just applied, for pixelateThings (grenade.js, sim.js)
  };
  // A stepped world (zones.js): the slider's, or one with an area at a middle step (a window, the wave, a grenade). It keeps the
  // original picture and its re-votes; world.mask is then each tile's picture at its own step. Old levels have none of it.
  if (level.slider === true || hasMiddleAreas(level)) world.res = { base: level.mask, voted: {} };
  if (level.slider === true) world.slider = { step: 8, base: level.mask, voted: world.res.voted };   // the resolution slider (slider.js)
  world.zones = zonesFromProps(world.props);   // the windows (see zones.js); later stages add the wave
  rebuildModes(world);
  initDyn(world);
  world.dynNext = world.crates.length + 1;
  // Each mover remembers the mode it lives in. The world starts in 8-bit; a thing that starts inside a low-res window
  // (or any zone) changes over now, by the same procedure as later (reconcileModes).
  if (hasZones(world)) eachMover(world, (t) => (world.res ? markStep(t, 8) : (t.mode = '8bit')));   // (a world without zones does not keep them)
  syncDyn(world);
  if (hasZones(world)) { world.zonedThings = true; reconcileModes(world, null); }
  return world;
}

// Does the level have an area at a middle step (4 or 2): a window, the wave, or a grenade pickup whose area is one?
export function hasMiddleAreas(level) {
  if (level.wave && middle(level.wave.step)) return true;
  return (level.props || []).some((p) => (p.type === 'window' || p.type === 'grenade') && middle(p.step));
}

// Is ice slippery right now? In 8-bit always; in low-res only when ICE_IN_LOW says so (a world may override it
// with its own `iceInLow` flag, which the tests use). With zones: wherever some tile is 8-bit (iceUnder, asked per
// tile, then says which ice counts).
export function iceActive(world) {
  if (world.mode === '8bit' || (world.iceInLow ?? ICE_IN_LOW) === true) return true;
  if (!hasZones(world)) return false;
  ensureModes(world);
  return world.has8;
}

// Is any tile directly under the box's feet icy terrain? The row of tiles touching the bottom edge, across the width.
// `zoned`: only ice whose own tile is 8-bit counts (the player; things not yet converted follow the base mode).
export function iceUnder(world, x, y, w, h, zoned = false) {
  const ice = world.ice;
  if (!ice) return false;
  const row = Math.floor(Math.round((y + h) * PX8) / PX8);
  if (row < 0 || row >= world.height) return false;
  const x0 = Math.max(0, Math.floor(x + 1e-6)), x1 = Math.min(world.width - 1, Math.ceil(x + w - 1e-6) - 1);
  const per = zoned && hasZones(world) && (world.iceInLow ?? ICE_IN_LOW) !== true;
  for (let tx = x0; tx <= x1; tx++) if (ice[row * world.width + tx] === 1 && (!per || modeAt(world, tx, row) === '8bit')) return true;
  return false;
}

// Does the box overlap terrain in the given mode? Left, right and top of the level are solid; below the bottom is open.
// In 8-bit the crates' pixels (world.dyn) are solid too, except those owned by crate number `ignore`
// (the body being moved).
export function terrainHitsBox(world, x, y, w, h, mode = world.mode, ignore = 0) {
  if (x < 0 || x + w > world.width || y < 0) return true;
  if (hasZones(world)) return zonedTerrainHits(world, x, y, w, h, mode, ignore);
  let cols, rows, grid, per; // grid cells per tile = PX8 / size
  if (mode === 'low') { cols = world.low.cols; rows = world.low.rows; grid = world.low.cells; per = PX8 / world.low.scale; }
  else { cols = world.maskW; rows = world.maskH; grid = world.mask; per = PX8; }
  const x0 = Math.floor(x * per), x1 = Math.ceil((x + w) * per) - 1;
  const y0 = Math.floor(y * per), y1 = Math.min(Math.ceil((y + h) * per) - 1, rows - 1);
  const dyn = mode === 'low' ? null : world.dyn;
  const skip = ignore instanceof Set ? (v) => ignore.has(v) : (v) => v === ignore;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const i = cy * cols + cx;
      if (grid[i] === 1) return true;
      if (dyn && dyn[i] !== 0 && !skip(dyn[i])) return true;
    }
  }
  return false;
}

// With `useAlt` (swap checks only): a prop that carries an `alt` box is seen where it will be after the swap,
// i.e. at its alt box when that is solid, and not at all otherwise.
// `useAlt` is true (every prop with an alt box is seen at it) or a function saying which props are.
export function solidBoxes(world, useAlt = false) {
  const boxes = [];
  // A crate that lives in 8-bit is pixels in world.dyn (see dyn.js), not a box; one in low-res is a box on whole tiles.
  for (const c of world.crates) if (thingMode(world, c) === 'low') boxes.push({ x: c.x, y: c.y, w: CRATE_SIZE, h: CRATE_SIZE, ref: c });
  for (const d of world.doors) if (!d.open) boxes.push({ x: d.x, y: d.y, w: DOOR_W, h: DOOR_H, ref: d });
  for (const b of world.balls) boxes.push({ x: b.x, y: b.y, w: BALL_SIZE, h: BALL_SIZE, ref: b });
  for (const p of world.props) {
    if (useAlt && p.alt && (useAlt === true || useAlt(p))) { if (p.alt.solid && !p.open) boxes.push({ x: p.alt.x, y: p.alt.y, w: p.alt.w, h: p.alt.h, ref: p }); continue; }
    if (p.solid && !p.open) boxes.push({ x: p.x, y: p.y, w: p.w, h: p.h, ref: p });
  }
  return boxes;
}

// `ignore`: the thing being moved, or a Set of things (a platform and what rides it) that do not count.
export function boxHitsSolid(world, x, y, w, h, mode = world.mode, ignore = null, useAlt = false) {
  const many = ignore instanceof Set;
  const cids = many ? new Set([...ignore].map((t) => t.cid).filter(Boolean)) : ignore && ignore.cid ? ignore.cid : 0;
  if (terrainHitsBox(world, x, y, w, h, mode, cids)) return true;
  for (const b of solidBoxes(world, useAlt)) {
    if (many ? ignore.has(b.ref) : b.ref === ignore) continue;
    if (x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y) return true;
  }
  return false;
}

const overlap = (x, y, w, h, b) => x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y;

const isSmall = (p) => p.type === 'smallcrate';
const otherMode = (m) => (m === '8bit' ? 'low' : '8bit');

// ---------------------------------------------------------------------------------------------------------------
// The mode of a mover (a ball, a crate, a small crate, a prop with an `alt` box) is the mode of the tile holding its
// centre. Each remembers the mode it lives in (`.mode`). A change of mode is planned and applied by the same two
// functions whether it is the whole-world swap (trySwap: everything that changes does so, all checks before any
// change) or one thing at a time (reconcileModes, settleMove: a thing crossed a zone's edge, or a zone moved over it).
// ---------------------------------------------------------------------------------------------------------------
const kindOf = (world, t) => (world.crates.includes(t) ? 'crate' : world.balls.includes(t) ? 'ball' : isSmall(t) ? 'small' : 'alt');
const sizeOf = (kind, t) => (kind === 'crate' ? [CRATE_SIZE, CRATE_SIZE] : kind === 'ball' ? [BALL_SIZE, BALL_SIZE] : [t.w, t.h]);

// The mode of the tile holding the thing's centre now (what it should live in).
export function wantedMode(world, t) {
  if (t.forceLow) return 'low';
  const [w, h] = sizeOf(kindOf(world, t), t);
  return modeOfBox(world, t.x, t.y, w, h);
}

// The mode of tile (tx, ty) in the map for base mode `base` (the map after a swap when `base` is the other mode).
function modeIn(world, base, tx, ty) {
  if (!hasZones(world) || tx < 0 || ty < 0 || tx >= world.width || ty >= world.height) return base;
  ensureModes(world);
  return (base === world.mode ? world.tmode : world.tmodeAlt)[ty * world.width + tx] === 1 ? 'low' : '8bit';
}

// A player standing on a prop that carries riders (`carries`, with an `alt` box) that is about to change mode is moved
// with it: where they will stand on the platform's other-mode top, the same sideways offset. null when nobody rides.
function riderPlace(world, player, changing) {
  for (const p of world.props) {
    if (!changing.has(p) || !p.carries || !p.alt || !p.alt.solid || p.open) continue;
    if (Math.abs(player.y + PLAYER_H - p.y) > 0.001) continue;
    if (!(player.x < p.x + p.w && player.x + PLAYER_W > p.x)) continue;
    return { x: player.x + (p.alt.x - p.x), y: p.alt.y - PLAYER_H };
  }
  return null;
}

// Where the changing small crates land in low-res: one block per occupied tile, `count` = how many were in it. The tile is the one
// holding the crate's centre across (a small crate pushed smoothly may be anywhere; on half tiles that is the tile it is in), and
// the row its top is in.
const smallTileX = (c) => Math.floor(c.x + c.w / 2 + 1e-9);
function smallBlocks(smalls) {
  const blocks = [];
  for (const c of smalls) {
    const x = smallTileX(c), y = Math.floor(c.y);
    const hit = blocks.find((b) => b.x === x && b.y === y);
    if (hit) { hit.count += c.count || 1; hit.members.push(c); } else blocks.push({ x, y, w: 1, h: 1, count: c.count || 1, members: [c] });
  }
  return blocks;
}

// The places a thing at (x, y) may snap to: the nearest whole tile, or one up; where zones make the nearest tile's
// centre land in the wrong mode, the other tile across as well. Without zones the first two, as ever.
function* snapSpots(x, y, zonedWorld) {
  const rx = Math.round(x), ry = Math.round(y);
  const xs = [rx];
  if (zonedWorld && x !== rx) xs.push(rx === Math.floor(x) ? Math.ceil(x) : Math.floor(x));
  for (const sx of xs) { yield { x: sx, y: ry }; yield { x: sx, y: ry - 1 }; }
}

// Plan the change of mode of `things` ([{ t, kind, to }]) in the map for base mode `base` (the base mode after a swap,
// the current one for a single thing). All checks, nothing changed: returns the plan, or null when the place is taken.
// `swap`: the player is checked at the end (they may ride a platform that changes); otherwise the player is an obstacle
// everything must keep clear of (`player` may be null: a world being built).
function planChanges(world, player, things, base, swap) {
  const changing = new Set(things.map((th) => th.t));
  const pick = (kind, to) => things.filter((th) => th.kind === kind && th.to === to).map((th) => th.t);
  const lowCrates = pick('crate', 'low'), lowBalls = pick('ball', 'low'), lowSmalls = pick('small', 'low');
  const crates8 = pick('crate', '8bit'), balls8 = pick('ball', '8bit'), smalls8 = pick('small', '8bit');
  const alts = things.filter((th) => th.kind === 'alt').map((th) => th.t);
  const zonedWorld = zoned(world);
  const forced = new Set(things.filter((th) => th.force).map((th) => th.t));     // pixelated for good: the tile's mode does not matter
  // The pixels of the crates that leave 8-bit vanish; the others (still 8-bit) stay solid.
  const skipDyn = zonedWorld ? new Set(lowCrates.map((c) => c.cid)) : 0;
  const ign = (self) => (zonedWorld ? (self && self.cid ? new Set([...skipDyn, self.cid]) : skipDyn) : (self && self.cid ? self.cid : 0));

  const ride = player ? riderPlace(world, player, changing) : null;
  const pos = ride || player;                 // where the player will be after the change
  const guard = !swap && pos ? [{ x: pos.x, y: pos.y, w: PLAYER_W, h: PLAYER_H }] : [];
  // What is solid after the change, apart from the things placed below: boxes, props at their alt boxes if they change;
  // the balls and small crates that change to low-res are replaced by their new places.
  const skip = new Set([...lowBalls, ...lowSmalls, ...lowCrates]);   // (a forced crate is already a low-res box where it stands)
  const statics = solidBoxes(world, (p) => changing.has(p)).filter((b) => !skip.has(b.ref));
  const hits = (x, y, w, h, extra, self = null) => terrainHitsBox(world, x, y, w, h, base, ign(self))
    || statics.some((b) => b.ref !== self && overlap(x, y, w, h, b)) || extra.some((b) => overlap(x, y, w, h, b));
  const centreOk = (t, w, h, to) => !zonedWorld || modeIn(world, base, Math.floor(t.x + w / 2), Math.floor(t.y + h / 2)) === to;
  const place = (thing, size, extra) => {
    for (const t of snapSpots(thing.x, thing.y, zonedWorld)) {
      if ((forced.has(thing) || centreOk(t, size, size, 'low')) && !hits(t.x, t.y, size, size, extra)) return t;
    }
    return null;
  };

  const blocks = smallBlocks(lowSmalls);
  const crateBoxes = [];                       // crates first; balls and the player then avoid them
  for (const c of lowCrates) {
    const t = place(c, CRATE_SIZE, [...guard, ...blocks, ...crateBoxes]);
    if (!t) return null;
    crateBoxes.push({ x: t.x, y: t.y, w: CRATE_SIZE, h: CRATE_SIZE });
  }
  const ballBoxes = [];
  for (const b of lowBalls) {
    const t = place(b, BALL_SIZE, [...guard, ...blocks, ...crateBoxes, ...ballBoxes]);
    if (!t) return null;
    ballBoxes.push({ x: t.x, y: t.y, w: BALL_SIZE, h: BALL_SIZE });
  }
  const placed = [...crateBoxes, ...ballBoxes];
  if (swap && pos && hits(pos.x, pos.y, PLAYER_W, PLAYER_H, [...blocks, ...placed])) return null;
  for (const b of blocks) if (hits(b.x, b.y, 1, 1, [...guard, ...placed])) return null;
  // Changing to 8-bit: the box stays where it is; it must be free in the 8-bit terrain there.
  for (const c of crates8) if (hits(c.x, c.y, CRATE_SIZE, CRATE_SIZE, [...guard, ...placed], c)) return null;
  for (const b of balls8) if (hits(b.x, b.y, BALL_SIZE, BALL_SIZE, [...guard, ...placed], b)) return null;
  // Low-res blocks split back into half-tile crates: two fill the tile, one takes the left half.
  const splits = [];
  for (const c of smalls8) {
    const x = Math.floor(c.x), n = c.count === 2 ? 2 : 1;
    for (let i = 0; i < n; i++) splits.push({ from: c, x: x + i * 0.5, side: i === 0 ? 'left' : 'right' });
  }
  // The tile may hold 8-bit terrain the vote rounded away: refuse rather than bury a crate.
  if (splits.some((s) => terrainHitsBox(world, s.x, s.from.y, 0.5, 1, base, skipDyn))) return null;
  // Props that exchange their boxes: the other-mode box must be free of terrain and of everything that does not change.
  const extra = [...guard, ...blocks, ...splits.map((s) => ({ x: s.x, y: s.from.y, w: 0.5, h: 1 }))];
  const altSet = new Set(alts);          // (things that change look after themselves, but two alt boxes can meet)
  for (const p of alts) {
    if (!p.alt.solid || p.open) continue;
    const a = p.alt;
    if (terrainHitsBox(world, a.x, a.y, a.w, a.h, base, skipDyn)) return null;
    if (statics.some((b) => b.ref !== p && (altSet.has(b.ref) || !changing.has(b.ref)) && overlap(a.x, a.y, a.w, a.h, b))) return null;
    if (extra.some((b) => overlap(a.x, a.y, a.w, a.h, b))) return null;
  }
  return { things, lowCrates, crateBoxes, lowBalls, ballBoxes, blocks, crates8, balls8, splits, alts, ride };
}

// The exact position of a thing that has just snapped to tile `tile` stays within the tile (so it rounds to it, and a snap that
// went the other way round does not walk straight back).
const within = (exact, tile) => Math.max(tile - 0.49, Math.min(tile + 0.49, exact));

function applyPlan(world, player, pl) {
  // A world that is not zoned does not keep the modes of its things (they all follow the base mode).
  const mark = zoned(world) ? (t, m) => { t.mode = m; } : () => {};
  pl.lowCrates.forEach((c, i) => {
    // The velocity is kept; the hidden exact position starts where the crate was (objects.js stepLow). A
    // glide or a push in progress gives no speed: it must not turn into a slide.
    c.fx = c.x; c.fy = c.y;
    c.x = pl.crateBoxes[i].x; c.y = pl.crateBoxes[i].y; c.lx = c.x; c.ly = c.y;
    c.fx = within(c.fx, c.x); c.fy = within(c.fy, c.y);
    if (c.glide || c.pushDir) c.vx = 0;
    c.tilt = 0; c.onGround = false; delete c.pushDir; delete c.drift;
    mark(c, 'low');
  });
  for (const b of pl.blocks) {
    const [keep, ...rest] = b.members;
    if (keep.glide || keep.pushDir) keep.vx = 0;           // as a crate: a push in progress gives no speed; contact is found at once
    Object.assign(keep, { x: b.x, y: b.y, w: 1, h: 1, count: b.count, onGround: false });
    delete keep.pushDir; delete keep.drift;
    mark(keep, 'low');
    for (const r of rest) world.props.splice(world.props.indexOf(r), 1);
  }
  pl.lowBalls.forEach((ball, i) => {
    ball.fx = ball.x; ball.fy = ball.y;
    ball.x = pl.ballBoxes[i].x; ball.y = pl.ballBoxes[i].y; ball.lx = ball.x; ball.ly = ball.y;
    ball.fx = within(ball.fx, ball.x); ball.fy = within(ball.fy, ball.y);
    ball.onGround = false; mark(ball, 'low');
  });
  for (const c of pl.crates8) { c.onGround = false; mark(c, '8bit'); }   // it starts upright, with the speed it had; contact is found at once
  for (const b of pl.balls8) mark(b, '8bit');            // the velocity it had in low-res carries on
  for (const s of pl.splits) {
    if (s.from.x === s.x && s.from.w === 0.5) { mark(s.from, '8bit'); continue; }
    if (s.from.w === 1 && s.side === 'left') { Object.assign(s.from, { x: s.x, w: 0.5, count: 1, side: 'left', onGround: false }); mark(s.from, '8bit'); continue; }
    world.props.push({ ...s.from, x: s.x, w: 0.5, count: 1, side: s.side, onGround: false });
    mark(world.props[world.props.length - 1], '8bit');
  }
  for (const p of pl.alts) {                   // each prop with an alt box trades it with its current one
    const cur = { x: p.x, y: p.y, w: p.w, h: p.h, solid: p.solid };
    Object.assign(p, p.alt);
    p.alt = cur;
    mark(p, pl.things.find((th) => th.t === p).to);
  }
  if (pl.ride) { player.x = pl.ride.x; player.y = pl.ride.y; }
}

export function trySwap(world, player) {
  if (world.res) return trySwapStepped(world, player);
  const target = otherMode(world.mode);
  const things = [];
  eachMover(world, (t) => {
    const kind = kindOf(world, t), [w, h] = sizeOf(kind, t);
    const to = t.forceLow ? 'low' : modeIn(world, target, Math.floor(t.x + w / 2), Math.floor(t.y + h / 2));
    if (to !== thingMode(world, t)) things.push({ t, kind, to });
  });
  const plan = planChanges(world, player, things, target, true);
  if (!plan) return false;
  applyPlan(world, player, plan);
  world.mode = target;
  syncDyn(world);           // the crates in 8-bit get their pixels (upright, at rest); the others are boxes
  return true;
}

// Try to change one thing (a small crate with the others sharing its tile) to mode `to`, in the current map. The
// player is an obstacle. True when it changed.
// (A forced small crate is a whole-tile block already, moving smoothly in 8-bit space: entering low-res space it snaps to the grid
// as a ball does, a one-tile box.)
const asBlock = (t, kind, to) => (kind === 'small' && t.forceLow && t.w === 1 && (to === 'low' || to === 1) ? 'ball' : kind);
function tryChange(world, player, t, to, force = false) {
  if (world.res) return tryStepChange(world, player, t, to === 'low' ? 1 : to === '8bit' ? 8 : to, force);
  const kind = asBlock(t, kindOf(world, t), to);
  let things = [{ t, kind, to, force }];
  if (kind === 'small' && to === 'low') {
    const mates = world.props.filter((p) => isSmall(p) && thingMode(world, p) !== 'low' && Math.floor(p.x) === Math.floor(t.x) && Math.floor(p.y) === Math.floor(t.y));
    things = mates.map((p) => ({ t: p, kind, to, force }));
  }
  const plan = planChanges(world, player, things, world.mode, false);
  if (!plan) return false;
  applyPlan(world, player, plan);
  syncDyn(world);
  return things;
}

// A forced-low crate or ball that is smooth (objects.js isSmooth) and whose centre is in low-res space snaps to whole tiles (the same
// change as entering low-res: nearest tile or one up, momentum kept). True when it did.
export function snapForced(world, player, t) {
  return Boolean(tryChange(world, player, t, 'low', false));
}

// A "things" grenade's zone has just come into force (`area`: { cx, cy, r }, the circle): every mover (crate, locked or not, ball,
// small crate, platform, blade) whose centre is within r tiles of (cx, cy) becomes low-res for good (`forceLow`, see zones.js thingMode): the same
// change as entering low-res (snapped to whole tiles or one tile up, small crates grow, platforms and blades trade their boxes,
// momentum kept), but whatever the mode of its tile. All together first; if the places are not free, one by one, and a thing
// that still cannot is left as it is (nothing is overlapped or crushed). The player is never affected. Returns the things done.
export function pixelateThings(world, player, area) {
  const inside = [];
  eachMover(world, (t) => {
    if (t.forceLow) return;
    const [w, h] = sizeOf(kindOf(world, t), t);
    if (Math.hypot(t.x + w / 2 - area.cx, t.y + h / 2 - area.cy) <= area.r) inside.push(t);
  });
  if (inside.length === 0) return [];
  if (!zoned(world)) eachMover(world, (t) => (world.res ? markStep(t, thingStep(world, t)) : (t.mode = world.mode)));   // from now on the things keep their own modes
  world.zonedThings = true;
  const done = [];
  const flag = (t) => { t.forceLow = true; done.push(t); };
  const need = [];
  for (const t of inside) (thingMode(world, t) === 'low' ? flag : (x) => need.push(x))(t);
  if (need.length > 0) {
    const things = need.map((t) => ({ t, kind: kindOf(world, t), to: 'low', force: true }));
    if (world.res) for (const th of things) Object.assign(th, { from: thingStep(world, th.t), to: 1 });
    const plan = world.res ? planStepChanges(world, player, things, world.mode, false) : planChanges(world, player, things, world.mode, false);
    if (plan) { (world.res ? applyStepPlan : applyPlan)(world, player, plan); for (const th of things) flag(th.t); }
    else {
      for (const t of need) {
        if (isSmall(t) && !world.props.includes(t)) continue;           // merged into a block by one of its tile's mates
        const changed = tryChange(world, player, t, 'low', true);
        if (changed) for (const th of changed) flag(th.t);
      }
    }
  }
  syncDyn(world);
  return done;
}

// Each step, before anything moves: every mover whose centre tile is in another mode than the one it lives in tries
// to change (a zone moved over it, or the base mode was set by hand). A thing that cannot (its place is taken) keeps
// its old mode and tries again next step; nothing is ever left overlapping terrain, a solid thing or the player.
export function reconcileModes(world, player) {
  if (!zoned(world)) return;
  if (world.res) { reconcileSteps(world, player); return; }
  ensureModes(world);
  const movers = [];
  eachMover(world, (t) => movers.push(t));
  for (const t of movers) {
    if (!world.crates.includes(t) && !world.balls.includes(t) && !world.props.includes(t)) continue;   // merged into a block
    const want = wantedMode(world, t);
    if (want !== thingMode(world, t)) tryChange(world, player, t, want);
  }
  if (world.zonesMoved) { world.zonesMoved = false; rescueMovers(world, player); }
  syncDyn(world);
  if (!hasZones(world)) {
    let home = true;
    eachMover(world, (t) => { if ((t.mode ?? world.mode) !== world.mode || t.forceLow) home = false; });
    if (home) world.zonedThings = false;
  }
}

// A zone has moved (setZones). A ball, crate or small crate that could not change mode (its new place was taken) or whose
// edge reaches into a tile that has changed may now overlap solid terrain under the new map. None is ever left so: it is
// lifted to the nearest free whole-tile place straight above (the search goes up to the top of the level), or, when there
// is none, removed from the world. (Platforms and blades keep their own rules: they turn round or wait.)
function overlapsTerrain(world, t, kind) {
  const [w, h] = sizeOf(kind, t);
  if (kind === 'crate' && thingMode(world, t) === '8bit') {        // a pose that may be turned: its pixels, one by one
    const pose = { cx: (t.x + CRATE_SIZE / 2) * PX8, cy: (t.y + CRATE_SIZE / 2) * PX8, tilt: t.tilt || 0 };
    return rasterSquare(pose.cx, pose.cy, CRATE_HALF, pose.tilt, (x, y) => terrainHitsBox(world, x / PX8, y / PX8, 1 / PX8, 1 / PX8, world.mode, t.cid));
  }
  return terrainHitsBox(world, t.x, t.y, w, h, world.mode, t.cid || 0);
}

function rescueMovers(world, player) {
  const things = [];
  for (const c of world.crates) things.push([c, 'crate']);
  for (const b of world.balls) things.push([b, 'ball']);
  for (const p of world.props) if (isSmall(p)) things.push([p, 'small']);
  const pb = player ? { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H } : null;
  for (const [t, kind] of things) {
    if (!overlapsTerrain(world, t, kind)) continue;
    const [w, h] = sizeOf(kind, t);
    const x = kind === 'small' ? t.x : Math.round(t.x);
    let placed = false;
    for (let y = Math.floor(t.y + 1e-9); y >= 0 && !placed; y--) {
      if (boxHitsSolid(world, x, y, w, h, world.mode, t) || (pb && overlap(x, y, w, h, pb))) continue;
      Object.assign(t, { x, y });
      if (kind === 'crate') { Object.assign(t, { tilt: 0, vx: 0, vy: 0, onGround: false }); delete t.pushDir; delete t.drift; }
      else if (kind === 'ball') Object.assign(t, { vx: 0, vy: 0, onGround: false });
      placed = true;
    }
    if (placed) continue;
    if (kind === 'crate') { unstampCrate(world, t); world.crates.splice(world.crates.indexOf(t), 1); }
    else if (kind === 'ball') world.balls.splice(world.balls.indexOf(t), 1);
    else world.props.splice(world.props.indexOf(t), 1);
  }
}

// A thing has just moved under its own motion (`prev`: a copy of its fields from before). If its centre is now in
// another mode it tries to change; if it cannot, the edge acts as a wall for it that step and it is put back as it was
// (false). A thing that was not at home before the move (a zone moved over it) keeps its mode and just retries.
export function settleMove(world, player, t, prev) {
  if (!zoned(world)) return true;
  if (world.res) return settleStep(world, player, t, prev);
  const mode = thingMode(world, t);
  const want = wantedMode(world, t);
  if (want === mode) return true;
  if (tryChange(world, player, t, want)) return true;
  const kind = kindOf(world, t), [w, h] = sizeOf(kind, prev);
  if (modeOfBox(world, prev.x, prev.y, w, h) !== mode) return true;
  Object.assign(t, prev);
  return false;
}

// Change the thing to the mode of where it is now, if it can (used by props that move themselves). True if it changed.
export function changeToWanted(world, player, t) {
  if (!zoned(world)) return false;
  if (world.res) {
    const want = wantedStep(world, t);
    return want !== thingStep(world, t) && Boolean(tryStepChange(world, player, t, want));
  }
  const want = wantedMode(world, t);
  return want !== thingMode(world, t) && Boolean(tryChange(world, player, t, want));
}

// Is the player's box inside solid terrain in the current modes? (A zone that moved over them: the crush.)
export const playerBuried = (world, player) => terrainHitsBox(world, player.x, player.y, PLAYER_W, PLAYER_H, world.mode);

// The tiles (a list of { x, y }) whose solid ground overlaps the player's box under the current map: what crushed them.
// `columns` (a Set of tile columns) limits the list to those columns; null for all.
export function buriedTiles(world, player, columns = null) {
  const tiles = [];
  const x0 = Math.max(0, Math.floor(player.x)), x1 = Math.min(world.width - 1, Math.ceil(player.x + PLAYER_W) - 1);
  const y0 = Math.max(0, Math.floor(player.y)), y1 = Math.min(world.height - 1, Math.ceil(player.y + PLAYER_H) - 1);
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      if (columns && !columns.has(tx)) continue;
      const ax = Math.max(player.x, tx), bx = Math.min(player.x + PLAYER_W, tx + 1);
      const ay = Math.max(player.y, ty), by = Math.min(player.y + PLAYER_H, ty + 1);
      if (bx > ax && by > ay && terrainHitsBox(world, ax, ay, bx - ax, by - ay, world.mode)) tiles.push({ x: tx, y: ty });
    }
  }
  return tiles;
}

// ---------------------------------------------------------------------------------------------------------------
// Stage 4 of the resolution slider: a stepped world (zones.js) whose areas hold steps of their own. A mover lives at the STEP of
// the tile holding its centre (zones.js thingStep, `.step`); steps 8 and 4 are fine (bodies), 2 and 1 are grids of half a tile
// and a whole tile (slider.js). Crossing a seam, or an area arriving over it, it changes step by the rules the notch uses, one
// thing at a time (the planner below is the swap's planner with steps for modes):
//   onto a grid, or onto a coarser one (fine -> 2 or 1, 2 -> 1): it snaps to the nearest place on the new grid from its exact
//     place (its hidden exact place when it is on a grid already: no path dependence), or one cell up; where the nearest place
//     would put its centre in a tile of another step, the place across as well. Its speed is kept.
//   off a grid (2 or 1 -> fine): a body where it is, with its speed; that place must be free.
//   1 -> 2, and 8 <-> 4: nothing moves (a whole tile is a place on the half grid; a body stays a body).
//   small crates: halves merge into whole-tile blocks entering step 1 and split back leaving it; entering step 2 from a fine
//     step their height snaps to the half grid (nearest or one up).
//   platforms and blades: the box their clock gives at the new step (props register it, `stepBoxes`).
// When it cannot (no free place), the seam is a wall for it that step (settleStep) or it keeps its step and tries again
// (reconcileSteps); refusals stay refusals. Steps 8 and 1 alone (a room with no area at 4 or 2) are the two modes as ever.
// ---------------------------------------------------------------------------------------------------------------
// The box a platform or a blade has at a step: (p, step, solid(tile)) -> { box: { x, y, w, h, solid }, lowTile } (registered by
// props/platform.js and props/blade.js, which import this file).
export const stepBoxes = {};

const isGridStep = (s) => s <= 2;
const onGridOf = (v, cell) => Math.round(v / cell) * cell;
const withinCell = (exact, at, cell) => Math.max(at - 0.49 * cell, Math.min(at + 0.49 * cell, exact));

// The step of the tile holding the thing's centre now (what it should live at). A forced-low thing: step 1 for good.
export function wantedStep(world, t) {
  if (t.forceLow) return 1;
  const [w, h] = sizeOf(kindOf(world, t), t);
  return stepOfBox(world, t.x, t.y, w, h);
}

// The places on a grid of `cell` tiles a thing at (x, y) may snap to: the nearest, or one cell up; also the place across (the
// nearest may put its centre in a tile of another step). With a whole-tile cell exactly snapSpots in a zoned world.
function* gridSpots(x, y, cell) {
  const rx = onGridOf(x, cell), ry = onGridOf(y, cell);
  const xs = [rx];
  if (Math.abs(x - rx) > 1e-9) xs.push(rx < x ? rx + cell : rx - cell);
  for (const sx of xs) { yield { x: sx, y: ry }; yield { x: sx, y: ry - cell }; }
}

// The exact place a thing snaps from: on a grid, its hidden exact place (while it still matches the cell it shows).
const exactOf = (t) => ({ x: t.fx !== undefined && t.lx === t.x ? t.fx : t.x, y: t.fy !== undefined && t.ly === t.y ? t.fy : t.y });
const sameAt = (a, b) => Math.abs(a - b) < 1e-6;
// The place a thing was taken from when its step last changed (stage 3's remembered place, slider.js anchorOf): kept while it is
// still exactly where that change put it, at rest. A crate snapped onto a grid when an area arrived goes back there when the
// area leaves (if it is free), as it does when the slider notches back.
function stillHome(t) {
  const h = t.home;
  return h && sameAt(t.x, h.at.x) && sameAt(t.y, h.at.y) && sameAt(t.tilt || 0, h.at.tilt) && !t.vx && !t.vy ? h.anchor : null;
}

// Plan the change of step of `things` ([{ t, kind, from, to, force }]) in the map for base mode `base`. All checks, nothing
// changed: the plan, or null. `swap`: the player is checked at the end (they may ride a platform that changes); otherwise the
// player is an obstacle.
function planStepChanges(world, player, things, base, swap) {
  const forced = new Set(things.filter((th) => th.force).map((th) => th.t));
  const snaps = [], stays = [], marks = [], merges = [], splits = [], heights = [], alts = [];
  for (const th of things) {
    const { kind, from, to } = th;
    if (kind === 'alt') alts.push(th);
    else if (kind === 'small') (to === 1 && from !== 1 ? merges : from === 1 && to !== 1 ? splits : to === 2 && from > 2 ? heights : marks).push(th);
    else if (isGridStep(to) && (!isGridStep(from) || CELL[to] > CELL[from])) snaps.push(th);
    else if (!isGridStep(to) && isGridStep(from)) stays.push(th);
    else marks.push(th);
  }
  // The pixels of the crates that leave the fine steps vanish; the other crates' pixels stay solid.
  const skipDyn = new Set(snaps.filter((th) => th.kind === 'crate' && !isGridStep(th.from)).map((th) => th.t.cid));
  const ign = (self) => (self && self.cid ? new Set([...skipDyn, self.cid]) : skipDyn);
  const solidOf = (tile) => terrainHitsBox(world, tile.x, tile.y, 1, 1, base, skipDyn);
  // Platforms and blades: their box at the new step.
  const altBox = new Map();
  for (const th of alts) {
    const make = stepBoxes[th.t.type];
    altBox.set(th.t, make ? make(th.t, th.to, solidOf) : { box: { x: th.t.x, y: th.t.y, w: th.t.w, h: th.t.h, solid: th.t.solid } });
  }
  // The player on a platform that changes goes with it (same sideways offset, on its new top).
  let ride = null;
  if (player) {
    for (const [p, { box }] of altBox) {
      if (!p.carries || !box.solid || p.open || Math.abs(player.y + PLAYER_H - p.y) > 0.001) continue;
      if (!(player.x < p.x + p.w && player.x + PLAYER_W > p.x)) continue;
      ride = { x: player.x + (box.x - p.x), y: box.y - PLAYER_H };
      break;
    }
  }
  const pos = ride || player;
  const guard = !swap && pos ? [{ x: pos.x, y: pos.y, w: PLAYER_W, h: PLAYER_H }] : [];
  // What is solid after the change, apart from what is placed below: the boxes there are, platforms and blades that change at
  // their new boxes; the crates, balls and small crates that snap or merge are replaced by their new places.
  const replaced = new Set([...snaps, ...merges, ...heights].map((th) => th.t));
  const statics = [];
  for (const b of solidBoxes(world)) if (!replaced.has(b.ref) && !altBox.has(b.ref)) statics.push(b);
  for (const [p, { box }] of altBox) if (box.solid && !p.open) statics.push({ ...box, ref: p });
  const hits = (x, y, w, h, extra, self = null) => terrainHitsBox(world, x, y, w, h, base, ign(self))
    || statics.some((b) => b.ref !== self && overlap(x, y, w, h, b)) || extra.some((b) => overlap(x, y, w, h, b));
  const centreOk = (q, w, h, to) => stepIn(world, base, Math.floor(q.x + w / 2), Math.floor(q.y + h / 2)) === to;

  const placed = [];
  const spots = new Map();
  for (const kind of ['crate', 'ball']) {                      // crates first; balls, small crates and the player then avoid them
    for (const th of snaps.filter((q) => q.kind === kind)) {
      const size = kind === 'crate' ? CRATE_SIZE : BALL_SIZE, cell = CELL[th.to];
      const ex = isGridStep(th.from) ? exactOf(th.t) : { x: th.t.x, y: th.t.y };
      let got = null;
      for (const q of gridSpots(ex.x, ex.y, cell)) {
        if ((forced.has(th.t) || centreOk(q, size, size, th.to)) && !hits(q.x, q.y, size, size, [...guard, ...placed])) { got = q; break; }
      }
      if (!got) return null;
      placed.push({ x: got.x, y: got.y, w: size, h: size });
      spots.set(th.t, { ...got, ex });
    }
  }
  // Small crates entering step 1: one block per tile (the tile their halves are in, the height rounded, or one up).
  const blocks = [];
  for (const th of merges) {
    const c = th.t, x = smallTileX(c), y = onGridOf(c.y, 1);
    const hit = blocks.find((b) => b.x === x && b.from === y);
    if (hit) { hit.count += c.count || 1; hit.members.push(c); } else blocks.push({ x, y, w: 1, h: 1, from: y, count: c.count || 1, members: [c] });
  }
  for (const b of blocks) {
    if (hits(b.x, b.y, 1, 1, [...guard, ...placed])) b.y -= 1;
    if (hits(b.x, b.y, 1, 1, [...guard, ...placed])) return null;
    placed.push({ x: b.x, y: b.y, w: 1, h: 1 });
  }
  // Small crates entering step 2 from a fine step: onto the half grid (the nearest place, or one up; the place across too, as for
  // the crates' snap: a small crate pushed smoothly may be between half tiles).
  const lifts = [];
  for (const th of heights) {
    const c = th.t;
    let got = null;
    for (const q of gridSpots(c.x, c.y, 0.5)) if (!hits(q.x, q.y, c.w, c.h, [...guard, ...placed], c)) { got = q; break; }
    if (!got) return null;
    placed.push({ x: got.x, y: got.y, w: c.w, h: c.h });
    lifts.push({ c, x: got.x, y: got.y });
  }
  if (swap && pos && hits(pos.x, pos.y, PLAYER_W, PLAYER_H, placed)) return null;
  // Off a grid: back at the place it was taken from if it has not moved since (and that place is free, at the new step), else
  // the box stays where it is; it must be free there. So must a thing that keeps its place on a grid (1 -> 2).
  const back = new Map();
  for (const th of stays) {
    const t = th.t, size = th.kind === 'crate' ? CRATE_SIZE : BALL_SIZE, home = stillHome(t);
    if (home && !(sameAt(home.x, t.x) && sameAt(home.y, t.y)) && centreOk(home, size, size, th.to)
      && !hits(home.x, home.y, size, size, [...guard, ...placed], t)) {
      placed.push({ x: home.x, y: home.y, w: size, h: size });
      back.set(t, home);
      continue;
    }
    if (hits(t.x, t.y, size, size, [...guard, ...placed], t)) return null;
  }
  for (const th of marks) {
    if (th.kind === 'crate' && !isGridStep(th.to)) continue;           // a body stays a body (its pixels collide as they move)
    const [w, h] = sizeOf(th.kind, th.t);
    if (hits(th.t.x, th.t.y, w, h, [...guard, ...placed], th.t)) return null;
  }
  // Blocks leaving step 1 split back into half-tile crates: two fill the tile, one takes the left half. The tile may hold
  // terrain the vote rounded away: refuse rather than bury a crate.
  const halves = [];
  for (const th of splits) {
    const c = th.t, x = Math.floor(c.x + 1e-9), n = c.count === 2 ? 2 : 1;
    for (let i = 0; i < n; i++) halves.push({ th, x: x + i * 0.5, side: i === 0 ? 'left' : 'right' });
  }
  if (halves.some((q) => terrainHitsBox(world, q.x, q.th.t.y, 0.5, 1, base, skipDyn))) return null;
  // Platforms and blades at their new boxes: free of terrain and of everything else.
  const extra = [...guard, ...placed, ...halves.map((q) => ({ x: q.x, y: q.th.t.y, w: 0.5, h: 1 }))];
  for (const [p, { box }] of altBox) {
    if (!box.solid || p.open) continue;
    if (terrainHitsBox(world, box.x, box.y, box.w, box.h, base, skipDyn)) return null;
    if (statics.some((b) => b.ref !== p && overlap(box.x, box.y, box.w, box.h, b))) return null;
    if (extra.some((b) => overlap(box.x, box.y, box.w, box.h, b))) return null;
  }
  return { things, snaps, spots, stays, back, marks, blocks, lifts, halves, alts, altBox, ride };
}

function applyStepPlan(world, player, pl) {
  for (const th of pl.snaps) {
    const t = th.t, q = pl.spots.get(t), cell = CELL[th.to];
    const anchor = stillHome(t) ?? { x: q.ex.x, y: q.ex.y, tilt: t.tilt || 0, onGround: t.onGround === true };
    if (!isGridStep(th.from) && (t.glide || t.pushDir)) t.vx = 0;     // a glide or a push in progress gives no speed
    t.x = q.x; t.y = q.y; t.lx = t.x; t.ly = t.y;
    t.fx = withinCell(q.ex.x, t.x, cell); t.fy = withinCell(q.ex.y, t.y, cell);
    if ('tilt' in t) t.tilt = 0;
    t.onGround = false; delete t.pushDir; delete t.drift;
    t.home = { anchor, at: { x: t.x, y: t.y, tilt: 0 } };
    markStep(t, th.to);
  }
  for (const th of pl.stays) {                     // a body again: back where it lay, as it lay; or where it is, with its speed
    const t = th.t, home = pl.back.get(t);
    if (home) {
      t.x = home.x; t.y = home.y;
      if ('tilt' in t) t.tilt = home.tilt;
      t.onGround = home.onGround;
      t.home = { anchor: home, at: { x: t.x, y: t.y, tilt: t.tilt || 0 } };
    } else t.onGround = false;
    markStep(t, th.to);
  }
  for (const th of pl.marks) markStep(th.t, th.to);
  for (const b of pl.blocks) {
    const [keep, ...rest] = b.members;
    Object.assign(keep, { x: b.x, y: b.y, w: 1, h: 1, count: b.count });
    markStep(keep, 1);
    for (const r of rest) world.props.splice(world.props.indexOf(r), 1);
  }
  for (const { c, x, y } of pl.lifts) { if (c.glide || c.pushDir) c.vx = 0; c.x = x; c.y = y; c.onGround = false; delete c.pushDir; delete c.drift; markStep(c, 2); }
  for (const q of pl.halves) {
    const c = q.th.t, to = q.th.to;
    if (q.side === 'left') { Object.assign(c, { x: q.x, w: 0.5, count: 1, side: 'left' }); markStep(c, to); continue; }
    const half = { ...c, x: q.x, w: 0.5, count: 1, side: 'right' };
    markStep(half, to);
    world.props.push(half);
  }
  for (const th of pl.alts) {
    const p = th.t, { box, lowTile } = pl.altBox.get(p);
    Object.assign(p, { x: box.x, y: box.y, w: box.w, h: box.h });
    if (p.type === 'blade') { p.solid = box.solid; if (isGridStep(th.to)) { p.lowTile = lowTile; p.started = true; } }
    markStep(p, th.to);
  }
  if (pl.ride) { player.x = pl.ride.x; player.y = pl.ride.y; }
}

// Try to change one thing to step `to` in the current map (a small crate entering step 1 with the others sharing its tile). The
// player is an obstacle. The things changed, or false.
function tryStepChange(world, player, t, to, force = false) {
  const kind = asBlock(t, kindOf(world, t), to);
  let things = [{ t, kind, from: thingStep(world, t), to, force }];
  if (kind === 'small' && to === 1) {
    const mates = world.props.filter((p) => isSmall(p) && thingStep(world, p) !== 1 && Math.floor(p.x + 1e-9) === Math.floor(t.x + 1e-9) && onGridOf(p.y, 1) === onGridOf(t.y, 1));
    things = mates.map((p) => ({ t: p, kind, from: thingStep(world, p), to, force }));
  }
  const plan = planStepChanges(world, player, things, world.mode, false);
  if (!plan) return false;
  applyStepPlan(world, player, plan);
  syncDyn(world);
  return things;
}

// The swap in a two-mode room with areas at middle steps: the room flips between steps 8 and 1; the areas keep their steps.
function trySwapStepped(world, player) {
  const target = otherMode(world.mode);
  const things = [];
  eachMover(world, (t) => {
    const kind = kindOf(world, t), [w, h] = sizeOf(kind, t);
    const to = t.forceLow ? 1 : stepIn(world, target, Math.floor(t.x + w / 2), Math.floor(t.y + h / 2));
    const from = thingStep(world, t);
    if (to !== from) things.push({ t, kind, from, to });
  });
  const plan = planStepChanges(world, player, things, target, true);
  if (!plan) return false;
  applyStepPlan(world, player, plan);
  world.mode = target;
  ensureModes(world);
  syncDyn(world);
  return true;
}

// Each step, before anything moves (reconcileModes with steps): every mover whose centre tile is at another step than the one
// it lives at tries to change; one that cannot keeps its step and tries again next step.
function reconcileSteps(world, player) {
  ensureModes(world);
  const movers = [];
  eachMover(world, (t) => movers.push(t));
  for (const t of movers) {
    if (!world.crates.includes(t) && !world.balls.includes(t) && !world.props.includes(t)) continue;   // merged into a block
    const want = wantedStep(world, t);
    if (want !== thingStep(world, t)) tryStepChange(world, player, t, want);
  }
  if (world.zonesMoved) { world.zonesMoved = false; rescueMovers(world, player); }
  syncDyn(world);
  if (!hasZones(world)) {
    let home = true;
    eachMover(world, (t) => { if (thingStep(world, t) !== baseStep(world) || t.forceLow) home = false; });
    if (home) world.zonedThings = false;
  }
}

// A thing has just moved under its own motion (`prev`: its fields from before): settleMove with steps. Into a tile of another
// step it changes; when it cannot, the seam is a wall for it this step and it is put back (false). A thing that was not at home
// before the move (an area arrived over it) keeps its step and just retries.
function settleStep(world, player, t, prev) {
  const step = thingStep(world, t), want = wantedStep(world, t);
  if (want === step) return true;
  if (tryStepChange(world, player, t, want)) return true;
  const [w, h] = sizeOf(kindOf(world, t), prev);
  if (stepOfBox(world, prev.x, prev.y, w, h) !== step) return true;
  Object.assign(t, prev);
  return false;
}
