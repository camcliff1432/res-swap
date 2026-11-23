// Painting for the resolution grenade (rules: grenade.js; the pickup: props/grenade.js). Draws onto a ctx in the
// picture's own pixels: the dashed frame (and countdown) of each area, the grenades in flight, and the one held next.
// Called by the compositor (render.js) after the world is drawn; it touches no page.
import { VIEW_W, VIEW_H, PX8, STEP } from './constants.js';
import { drawText, textWidth, GLYPH_H } from './font.js';
import { modeOfBox } from './zones.js';
import { paintGrenade, GRENADE_COLOURS } from './props/grenade.js';
import { GRENADE_SIZE } from './grenade.js';
import { NES } from './sprites8.js';
import { PROPS } from './props/index.js';
import { CRATE_SIZE, BALL_SIZE } from './constants.js';
import { eachMover } from './zones.js';
import { drawCrate, drawBall8 } from './render8.js';
import { easeSprite } from './easeSprite.js';

const W = VIEW_W * PX8, H = VIEW_H * PX8;
const px = (v) => Math.round(v * PX8);
const BACK = '#000000';

// The outline of a circle (a mask over the box): a stepped one-pixel ring along the boundary of its tiles.
function ring(ctx, z, x0, y0) {
  const inside = (tx, ty) => tx >= 0 && ty >= 0 && tx < z.w && ty < z.h && z.mask[ty * z.w + tx] === 1;
  for (let ty = 0; ty < z.h; ty++) {
    for (let tx = 0; tx < z.w; tx++) {
      if (!inside(tx, ty)) continue;
      const x = x0 + tx * PX8, y = y0 + ty * PX8;
      if (!inside(tx, ty - 1)) ctx.fillRect(x, y, PX8, 1);
      if (!inside(tx, ty + 1)) ctx.fillRect(x, y + PX8 - 1, PX8, 1);
      if (!inside(tx - 1, ty)) ctx.fillRect(x, y, 1, PX8);
      if (!inside(tx + 1, ty)) ctx.fillRect(x + PX8 - 1, y, 1, PX8);
    }
  }
}

// The ring of one area (level pixels shifted by the view's top-left), and for a timed one the time left near the top of the
// circle: a bar that shrinks to nothing and the whole seconds left as a number below it.
function drawArea(ctx, z, ox, oy) {
  const x = z.x * PX8 - ox, y = z.y * PX8 - oy, w = z.w * PX8, h = z.h * PX8;
  if (x + w <= 0 || x >= W || y + h <= 0 || y >= H) return;
  const colour = GRENADE_COLOURS[z.gkind];
  ctx.fillStyle = colour;
  ring(ctx, z, x, y);
  if (z.gkind !== 'timed' || z.left === null || !(z.seconds > 0)) return;
  const frac = Math.max(0, Math.min(1, z.left * STEP / z.seconds));
  let run = 0;
  for (let tx = 0; tx < z.w; tx++) run += z.mask[tx];               // the top row's width: where the bar fits
  const full = Math.max(4, run * PX8 - 2), mid = Math.round(z.cx * PX8 - ox);
  const bx = mid - Math.floor(full / 2), by = y + 1;
  ctx.fillStyle = BACK;
  ctx.fillRect(bx, by, full, 2);
  ctx.fillStyle = colour;
  ctx.fillRect(bx, by, Math.round(full * frac), 2);
  const text = String(Math.max(1, Math.ceil(z.left * STEP)));
  const tw = textWidth(text);
  ctx.fillStyle = BACK;
  ctx.fillRect(mid - Math.floor(tw / 2) - 1, by + 3, tw + 2, GLYPH_H + 2);
  drawText(ctx, text, mid - Math.floor(tw / 2), by + 4, colour);
}

// A grenade in flight: round and green with its coloured band where its tile is 8-bit, a flat block of its colour where low-res.
function drawFlying(ctx, world, g, ox, oy) {
  const size = px(GRENADE_SIZE), x = px(g.x) - ox, y = px(g.y) - oy;
  if (x + size <= 0 || x >= W || y + size <= 0 || y >= H) return;
  const kind = GRENADE_COLOURS[g.info.kind] ? g.info.kind : 'timed';
  if (modeOfBox(world, g.x, g.y, GRENADE_SIZE, GRENADE_SIZE) === 'low') {
    ctx.fillStyle = GRENADE_COLOURS[kind];
    ctx.fillRect(x, y, size, size);
    return;
  }
  ctx.fillStyle = '#1C3C14';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#78B838';
  ctx.fillRect(x + 1, y + 1, size - 2, size - 2);
  ctx.fillStyle = GRENADE_COLOURS[kind];
  ctx.fillRect(x, y + 2, size, 1);
}

// The next grenade to throw, top middle of the picture: its icon and the number held ("x3").
function drawHeld(ctx, world) {
  const n = world.held.length;
  if (n === 0) return;
  const text = `X${n}`;
  const w = 8 + 2 + textWidth(text), x = Math.floor((W - w) / 2), y = 1;
  ctx.fillStyle = BACK;
  ctx.fillRect(x - 2, y - 1, w + 4, 10);
  paintGrenade(ctx, x, y, world.held[0].kind);
  drawText(ctx, text, x + 10, y + 2, '#FCFCFC');
}

// Things a "things" grenade made low-res for good: the pictures do not draw them (zones.js), so they are drawn here, on top,
// always in their plain low-res look (a flat block), exactly like any low-res thing: no marking (the user's choice; only the
// grenade's circle gets a coloured ring).
function drawForcedLow(ctx, world, ox, oy, look) {
  eachMover(world, (t) => {
    const p = look && look.thingEase ? look.thingEase(world, t) : null;
    if (!t.forceLow && p === null) return;                    // (a thing that is not forced is drawn here only while it eases)
    const isCrate = world.crates.includes(t), isBall = world.balls.includes(t);
    const w = isCrate ? CRATE_SIZE : isBall ? BALL_SIZE : t.w, h = isCrate ? CRATE_SIZE : isBall ? BALL_SIZE : t.h;
    const x = px(t.x), y = px(t.y), pw = px(w), ph = px(h);
    if (x + pw <= ox || x >= ox + W || y + ph <= oy || y >= oy + H) return;
    const def = isCrate || isBall ? null : PROPS[t.type];
    const low = () => {
      ctx.save();
      ctx.translate(-ox, -oy);
      if (isCrate || isBall) {
        ctx.fillStyle = isCrate ? NES.crateMid : NES.ballMid;
        ctx.fillRect(x, y, pw, ph);
      } else if (def && def.drawLow) def.drawLow(ctx, t, world);
      ctx.restore();
    };
    // Just pixelated: its picture eases from its 8-bit look to the block (sliderLook.js thingEase, easeSprite.js).
    if (p === null) { low(); return; }
    const size = Math.ceil((Math.max(pw, ph) + 2 * PX8) / PX8) * PX8, sx = x - PX8, sy = y - PX8;
    easeSprite(ctx, p, sx - ox, sy - oy, size, (s) => {
      if (isCrate) drawCrate(s, { ...t, tilt: 0 }, sx, sy);
      else if (isBall) drawBall8(s, t, sx, sy);
      else if (def && def.draw8) { s.save(); s.translate(-sx, -sy); def.draw8(s, t, world); s.restore(); }
    }, low);
  });
}

export function drawGrenades(ctx, world, cam = { x: 0, y: 0 }, look = null) {
  const ox = px(cam.x), oy = px(cam.y);
  drawForcedLow(ctx, world, ox, oy, look);
  for (const z of world.gzones || []) if (z.applied) drawArea(ctx, z, ox, oy);
  for (const g of world.flying || []) drawFlying(ctx, world, g, ox, oy);
  if (world.held) drawHeld(ctx, world);
}
