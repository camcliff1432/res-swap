// The soft edge of a zone, for the things that cross it (a level with zones, without the slider): a crate, a ball, a small crate, a
// platform, a blade or the player is not cut hard where 8-bit meets low-res. In the low-res tile right at the edge its picture goes
// down by steps as it goes in:
//   the half tile at the edge    its 8-bit picture in blocks of 2 x 2 pixels
//   the other half               in blocks of 4 x 4
//   the tiles behind             its low-res look, as ever (blocks of 8 x 8)
// So only the part of a thing that is going in changes, and it changes with how far in it is, not with time: a thing that stops
// half way stays as it is. On the 8-bit side nothing changes. The blocks lie on the level's grid, and a block is drawn where the
// thing fills more than half of it, in the average of the thing's own colours there (the slider's look at steps 4 and 2, crisp.js).
// Drawn with plain rectangles. Picture only: no rule reads this.
//
//   const plan = bandPlan(world, player, opts)      before the pictures are drawn: which things are at an edge (null: none)
//   drawBands(ctx, world, player, cam, plan)        after them: repaints those things' edge tiles
// While plan.player is true the caller leaves the player out of its own drawing: drawBands draws all of him.
import { PX8, PLAYER_W, PLAYER_H, CRATE_SIZE, BALL_SIZE, VIEW_W, VIEW_H } from './constants.js';
import { hasZones, ensureModes, eachMover, looksIn } from './zones.js';
import { drawCrate, drawBall8, drawPlayer8 } from './render8.js';
import { renderLow, drawPlayerLow } from './renderLow.js';
import { PROPS } from './props/index.js';
import { createRecorder, reduceBlocks, hexOf, tinyPlayer } from './crisp.js';
import { updateFacing } from './render8.js';

const W = VIEW_W * PX8, H = VIEW_H * PX8;
const px = (v) => Math.round(v * PX8);
const L = 1, R = 2, U = 4, D = 8;
const SIZE = 12 * PX8;                           // the recording square: room for the widest thing and a margin

// For every tile: on which sides a low-res tile has an OPEN 8-bit tile next to it, one a thing can come through (0: none, or not a
// low-res tile). A side on solid ground does not count: the floor under a window is no edge to cross. Kept with the world until its
// mode map changes.
const maps = new WeakMap();
export function edgeSides(world) {
  ensureModes(world);
  const kept = maps.get(world);
  if (kept && kept.tmode === world.tmode) return kept.sides;
  const { width: w, height: h, tmode } = world, sides = new Uint8Array(w * h);
  const fine = (x, y) => x >= 0 && y >= 0 && x < w && y < h && tmode[y * w + x] === 0 && (world.shapes?.[y]?.[x] ?? '.') === '.';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (tmode[y * w + x] === 1) sides[y * w + x] = (fine(x - 1, y) ? L : 0) | (fine(x + 1, y) ? R : 0) | (fine(x, y - 1) ? U : 0) | (fine(x, y + 1) ? D : 0);
    }
  }
  maps.set(world, { tmode, sides });
  return sides;
}

// The edge tiles a pixel box covers, as [tx, ty] pairs.
function edgeTiles(world, sides, x0, y0, x1, y1) {
  const out = [];
  const tx0 = Math.max(0, Math.floor(x0 / PX8)), tx1 = Math.min(world.width - 1, Math.floor((x1 - 1) / PX8));
  const ty0 = Math.max(0, Math.floor(y0 / PX8)), ty1 = Math.min(world.height - 1, Math.floor((y1 - 1) / PX8));
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (sides[ty * world.width + tx] !== 0) out.push([tx, ty]);
  return out;
}

// A mover's 8-bit look as { box: [x0, y0, x1, y1] in level pixels, draw(ctx, ox, oy) }, or null when it has none.
function fineLook(world, t) {
  const looks = looksIn(world, t, '8bit');
  if (looks.length === 0) return null;
  const isCrate = world.crates.includes(t), isBall = world.balls.includes(t);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of looks) {
    const w = isCrate ? CRATE_SIZE : isBall ? BALL_SIZE : q.w, h = isCrate ? CRATE_SIZE : isBall ? BALL_SIZE : q.h;
    const m = isCrate && q.tilt ? 4 : 0;                       // a leaning crate reaches out of its box
    x0 = Math.min(x0, px(q.x) - m); y0 = Math.min(y0, px(q.y) - m); x1 = Math.max(x1, px(q.x) + px(w) + m); y1 = Math.max(y1, px(q.y) + px(h) + m);
  }
  const draw = (ctx, ox, oy) => {
    for (const q of looks) {
      if (isCrate) drawCrate(ctx, q, ox, oy);
      else if (isBall) drawBall8(ctx, q, ox, oy);
      else if (PROPS[q.type] && PROPS[q.type].draw8) { ctx.save(); ctx.translate(-ox, -oy); PROPS[q.type].draw8(ctx, q, world); ctx.restore(); }
    }
  };
  return { box: [x0, y0, x1, y1], draw };
}

export function bandPlan(world, player, opts = {}) {
  if (world.slider || world.res || !hasZones(world) || !Array.isArray(world.crates)) return null;
  const sides = edgeSides(world);
  const things = [];
  eachMover(world, (t) => {
    if (t.forceLow || t.easeHide) return;
    const look = fineLook(world, t);
    if (!look) return;
    const tiles = edgeTiles(world, sides, ...look.box);
    if (tiles.length > 0) things.push({ t, look, tiles });
  });
  let man = null;
  if (player && !opts.hidePlayer && !player.pixelated) {
    const box = [px(player.x), px(player.y), px(player.x) + px(PLAYER_W), px(player.y) + px(PLAYER_H)];
    const tiles = edgeTiles(world, sides, ...box);
    if (tiles.length > 0) man = { box, tiles };
  }
  return things.length > 0 || man ? { things, man, player: man !== null } : null;
}

// A thing's 8-bit picture as blocks of 2 x 2 and of 4 x 4 level pixels on the level's grid: { 2: [...], 4: [...] }, each block
// { x, y, colour } in level pixels.
let rec = null;
function blocksOf(box, draw) {
  rec ??= createRecorder({ x0: 0, y0: 0, x1: SIZE, y1: SIZE });
  const gx = Math.floor(box[0] / PX8) * PX8 - PX8, gy = Math.floor(box[1] / PX8) * PX8 - PX8;   // a tile corner, a tile clear of it
  rec.take();
  draw(rec.ctx, gx, gy);
  const got = rec.take(), out = {};
  for (const b of [2, 4]) out[b] = reduceBlocks(got, b, 0, 0, true).map((k) => ({ x: k.x + gx, y: k.y + gy, colour: hexOf(k.colour) }));
  return out;
}

// One edge tile of a thing: each quarter of the tile that touches the 8-bit side in blocks of 2, the others in blocks of 4.
function paintTile(ctx, sides, world, blocks, tx, ty, ox, oy) {
  const s = sides[ty * world.width + tx];
  for (let qy = 0; qy < 2; qy++) {
    for (let qx = 0; qx < 2; qx++) {
      const near = (qx === 0 && (s & L)) || (qx === 1 && (s & R)) || (qy === 0 && (s & U)) || (qy === 1 && (s & D));
      const b = near ? 2 : 4, x0 = tx * PX8 + qx * 4, y0 = ty * PX8 + qy * 4;
      for (const k of blocks[b]) {                              // each block, cut to this quarter
        const ax = Math.max(k.x, x0), ay = Math.max(k.y, y0), bx = Math.min(k.x + b, x0 + 4), by = Math.min(k.y + b, y0 + 4);
        if (ax >= bx || ay >= by) continue;
        ctx.fillStyle = k.colour;
        ctx.fillRect(ax - ox, ay - oy, bx - ax, by - ay);
      }
    }
  }
}

let bare = null;
export function drawBands(ctx, world, player, cam, plan) {
  if (!plan) return;
  const ox = px(cam.x), oy = px(cam.y);
  const sides = edgeSides(world);
  if (plan.things.length > 0) {
    // The low-res picture without these things: what is behind them in their edge tiles.
    if (!bare) { const c = document.createElement('canvas'); c.width = W; c.height = H; bare = { canvas: c, ctx: c.getContext('2d') }; }
    for (const { t } of plan.things) t.easeHide = true;
    try { renderLow(bare.ctx, world, player, cam, { player: false, overlays: false }); } finally { for (const { t } of plan.things) delete t.easeHide; }
    for (const { tiles } of plan.things) {
      for (const [tx, ty] of tiles) {
        const sx = tx * PX8 - ox, sy = ty * PX8 - oy;
        if (sx >= 0 && sy >= 0 && sx + PX8 <= W && sy + PX8 <= H) ctx.drawImage(bare.canvas, sx, sy, PX8, PX8, sx, sy, PX8, PX8);
      }
    }
    for (const { look, tiles } of plan.things) {
      const blocks = blocksOf(look.box, look.draw);
      for (const [tx, ty] of tiles) paintTile(ctx, sides, world, blocks, tx, ty, ox, oy);
    }
  }
  if (plan.man) {
    // The player, tile by tile: his 8-bit figure where the tile is 8-bit, his low-res figure in low-res, the steps in an edge tile.
    // (In blocks of 4 he is the figure made by hand for that size, hanging from his own corner: his sprite by the vote alone is a heap.)
    const blocks = blocksOf(plan.man.box, (s, gx, gy) => drawPlayer8(s, player, { x: gx / PX8, y: gy / PX8 }));
    const [x0, y0, x1, y1] = plan.man.box;
    const walking = player.vx !== 0 && player.onGround;
    blocks[4] = tinyPlayer(walking ? Math.floor(x0 / 4) & 1 : 0, updateFacing(player) < 0, 4).map(([x, y, , , c]) => ({ x: x0 + x, y: y0 + y, colour: hexOf(c) }));
    for (let ty = Math.floor(y0 / PX8); ty <= Math.floor((y1 - 1) / PX8); ty++) {
      for (let tx = Math.floor(x0 / PX8); tx <= Math.floor((x1 - 1) / PX8); tx++) {
        const inside = tx >= 0 && ty >= 0 && tx < world.width && ty < world.height;
        if (inside && sides[ty * world.width + tx] !== 0) { paintTile(ctx, sides, world, blocks, tx, ty, ox, oy); continue; }
        const low = inside ? world.tmode[ty * world.width + tx] === 1 : world.mode === 'low';
        ctx.save();
        ctx.beginPath();
        ctx.rect(tx * PX8 - ox, ty * PX8 - oy, PX8, PX8);
        ctx.clip();
        (low ? drawPlayerLow : drawPlayer8)(ctx, player, cam);
        ctx.restore();
      }
    }
  }
}
