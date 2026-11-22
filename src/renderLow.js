// Low-res renderer: the same 256 x 144 canvas, drawn from world.low (any scale: a cell is
// world.low.scale pixels square). Solid cells are hull colour; empty cells take the most common
// colour of the 8-bit sky layer there. Crates, balls, closed doors, the exit and whichever props have a
// low-res picture (laser emitter, key door) are flat blocks;
// the player is a flat figure. Spikes, buttons, wires, padlocks, lights and open doors are not drawn.
import { VIEW_W, VIEW_H, PX8, CRATE_SIZE, DOOR_W, DOOR_H, BALL_SIZE, PLAYER_W, PLAYER_H, LOW_SCALE } from './constants.js';
import { NES, ASTRONAUT_PALETTE } from './sprites8.js';
import { drawSky, updateFacing, spikeBlockColour } from './render8.js';
import { PROPS } from './props/index.js';
import { looksIn } from './zones.js';

const W = VIEW_W * PX8, H = VIEW_H * PX8; // the screen, in pixels
const HULL = NES.hullGrey;

// Packed colours of the level-sized 8-bit sky layer, computed once per level.
function sky(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  drawSky(ctx, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const colours = new Uint32Array(w * h);
  for (let i = 0; i < w * h; i++) colours[i] = (d[i * 4] << 16) | (d[i * 4 + 1] << 8) | d[i * 4 + 2];
  return colours;
}

const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;

// Most common colour among the pixels of one cell (first seen wins ties).
function dominant(pixels, stride, x0, y0, size) {
  const counts = new Map();
  let best = pixels[y0 * stride + x0], bestCount = 0;
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      const v = pixels[y * stride + x];
      const n = (counts.get(v) || 0) + 1;
      counts.set(v, n);
      if (n > bestCount) { best = v; bestCount = n; }
    }
  }
  return best;
}

function buildBackdrop(world, terrain = true) {
  const { low } = world;
  const w = world.maskW, h = world.maskH;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const pixels = sky(w, h);
  const base = world.slider?.base || world.res?.base || world.mask;   // the 8-bit picture
  const s = low.scale;
  for (let cy = 0; cy < low.rows; cy++) {
    for (let cx = 0; cx < low.cols; cx++) {
      const ch = world.shapes?.[Math.floor(cy * s / PX8)]?.[Math.floor(cx * s / PX8)];
      // big spikes gone solid are still red: the average of the 8-bit reds the cell takes in
      const red = ch === 'W' || ch === 'M' ? spikeBlockColour(base, w, h, cx * s, cy * s, s) : null;
      const rock = red ? hex((red[0] << 16) | (red[1] << 8) | red[2]) : HULL;
      ctx.fillStyle = terrain && low.cells[cy * low.cols + cx] === 1 ? rock : hex(dominant(pixels, w, cx * s, cy * s, s));
      ctx.fillRect(cx * s, cy * s, s, s);
    }
  }
  return canvas;
}

let backdropFor = null, backdrop = null;
let skyFor = null, skyBackdrop = null;      // sky cells alone (opts.terrain === false), for the slider look
const px = (v) => Math.round(v * PX8);

// `opts`: { player: false } leaves the figure out (the compositor, render.js, draws it on top); { terrain: false } leaves
// the hull cells out (their cells show the sky, for the slider look, renderSlider.js, which draws the terrain itself).
export function renderLow(ctx, world, player, cam = { x: 0, y: 0 }, opts = {}) {
  let back;
  if (opts.terrain === false) {
    if (skyFor !== world) { skyBackdrop = buildBackdrop(world, false); skyFor = world; }
    back = skyBackdrop;
  } else {
    if (backdropFor !== world.mask) {
      backdrop = buildBackdrop(world);
      backdropFor = world.mask;
    }
    back = backdrop;
  }
  const ox = px(cam.x), oy = px(cam.y); // the view's top-left in level pixels
  ctx.drawImage(back, -ox, -oy);

  // A flat block at level pixels (x, y, w, h), skipped when it is outside the view.
  const block = (colour, x, y, w, h) => {
    if (x + w <= ox || x >= ox + W || y + h <= oy || y >= oy + H) return;
    ctx.fillStyle = colour;
    ctx.fillRect(x - ox, y - oy, w, h);
  };
  for (const d of world.doors) if (!d.open) block(NES.doorMid, px(d.x), px(d.y), DOOR_W * PX8, DOOR_H * PX8);
  ctx.save();
  ctx.translate(-ox, -oy);
  for (const p of world.props || []) {
    const def = PROPS[p.type];
    if (!def || !def.drawLow) continue;
    for (const q of looksIn(world, p, 'low')) {
      const off = px(q.x) + px(q.w) <= ox || px(q.x) >= ox + W || px(q.y) + px(q.h) <= oy || px(q.y) >= oy + H;
      if (def.reaches || !off) def.drawLow(ctx, q, world);
    }
  }
  ctx.restore();
  for (const c0 of world.crates) for (const c of looksIn(world, c0, 'low')) block(NES.crateMid, px(c.x), px(c.y), CRATE_SIZE * PX8, CRATE_SIZE * PX8);
  for (const b0 of world.balls) for (const b of looksIn(world, b0, 'low')) block(NES.ballMid, px(b.x), px(b.y), BALL_SIZE * PX8, BALL_SIZE * PX8);
  block(NES.exitMid, px(world.exit.x), px(world.exit.y), 1 * PX8, 1.5 * PX8);

  if (opts.player !== false) drawPlayerLow(ctx, player, cam);
}

export const SNAP_PLAYER_LOW = false;  // false: the figure is drawn exactly where he is, as before

// The astronaut in his low-res look: a flat figure with a visor.
export function drawPlayerLow(ctx, player, cam = { x: 0, y: 0 }) {
  const ox = px(cam.x), oy = px(cam.y);
  const block = (colour, x, y, w, h) => {
    if (x + w <= ox || x >= ox + W || y + h <= oy || y >= oy + H) return;
    ctx.fillStyle = colour;
    ctx.fillRect(x - ox, y - oy, w, h);
  };
  // A trial (the owner's): the figure is drawn on the big-pixel grid (his left edge and his feet land on whole big
  // pixels) while the view glides. Only the picture snaps; where he really is (the rules, the camera) is unchanged.
  const w = PLAYER_W * PX8, h = PLAYER_H * PX8;
  const snap = (v) => Math.round(v / LOW_SCALE) * LOW_SCALE;
  const x = SNAP_PLAYER_LOW ? snap(px(player.x)) : px(player.x);
  const y = SNAP_PLAYER_LOW ? snap(px(player.y) + h) - h : px(player.y);
  block(ASTRONAUT_PALETTE.W, x, y, w, h);
  block(ASTRONAUT_PALETTE.B, updateFacing(player) > 0 ? x + w - 4 : x, y + 2, 4, 4);
}
