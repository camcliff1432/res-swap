// 8-bit renderer: 256 x 144 picture, 8 x 8 tiles. Draws everything that exists in 8-bit:
// sky, stars, planet, terrain in its true shapes (hull tiles for '#', pixel by pixel from the
// mask for ramps, thin floors, thin walls and overhangs), spikes, buttons with wires, doors
// with lights, crates (padlocked when locked), balls, the exit and the astronaut.
// Also exports drawSky (the layer without terrain, which the low-res view samples) and the
// shared facing state.
import { VIEW_W, VIEW_H, PX8 } from './constants.js';
import {
  NES, HULL_INNER, HULL_TOP, ASTRONAUT_FRAMES, crateColour, DOOR_CLOSED, DOOR_OPEN, EXIT, PLANET,
  BALL, SPIKES, PADLOCK,
} from './sprites8.js';
import { PROPS } from './props/index.js';
import { rasterSquare, cratePose, CRATE_HALF } from './dyn.js';
import { looksIn } from './zones.js';

const W = VIEW_W * PX8, H = VIEW_H * PX8; // the screen, in pixels
const BIG_STARS = [0.3, 0.1];                // 2 x 2 and 4 x 4 stars, as shares of the small ones' count
const STAR_COUNT = 46;                      // stars per screen; a bigger level gets the same density

const makeCanvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

// Paint a sprite's rows onto ctx at (ox, oy); flip mirrors it left-right.
function paint(ctx, sprite, ox, oy, flip = false) {
  const w = sprite.rows[0].length;
  sprite.rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const colour = sprite.palette[row[x]];
      if (!colour) continue;
      ctx.fillStyle = colour;
      ctx.fillRect(ox + (flip ? w - 1 - x : x), oy + y, 1, 1);
    }
  });
}

// Sprites are baked once into small canvases, then blitted each frame.
const baked = new Map();
function bake(key, sprite, flip = false) {
  let c = baked.get(key);
  if (!c) {
    c = makeCanvas(sprite.rows[0].length, sprite.rows.length);
    paint(c.getContext('2d'), sprite, 0, 0, flip);
    c.sprite = sprite;                                   // what the slider look (crisp.js) reads when a picture is reduced to blocks
    c.flip = flip;
    baked.set(key, c);
  }
  return c;
}

// Small seeded generator (mulberry32) so the stars are the same every run.
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function drawPlanet(ctx) {
  const { cx, cy, r } = PLANET;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const lit = (-dx - dy) / (2 * r); // brighter towards the upper left
      ctx.fillStyle = lit > 0.3 ? NES.planetLight : lit > -0.15 ? NES.planetMid : NES.planetDark;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

// Sky, stars and planet over a whole level picture (w x h pixels); no terrain. The planet is
// drawn once, in the first screen. The low-res view samples this.
export function drawSky(ctx, w = W, h = H) {
  ctx.fillStyle = NES.sky;
  ctx.fillRect(0, 0, w, h);
  const rand = seeded(0x5EED);
  const count = Math.round(STAR_COUNT * (w * h) / (W * H));
  for (let i = 0; i < count; i++) {
    const x = Math.floor(rand() * w), y = Math.floor(rand() * h);
    ctx.fillStyle = rand() < 0.35 ? NES.starBright : NES.starDim;
    ctx.fillRect(x, y, 1, 1);
  }
  // Bigger stars, from their own generator (the small ones stay where they were). They sit on the block grid of their size, so
  // they last down the slider: a 2 x 2 star is still there at step 4, a 4 x 4 one at step 2.
  const big = seeded(0xB16);
  for (const [size, share] of [[2, BIG_STARS[0]], [4, BIG_STARS[1]]]) {
    for (let i = Math.round(count * share); i > 0; i--) {
      const x = Math.floor(big() * w / size) * size, y = Math.floor(big() * h / size) * size;
      ctx.fillStyle = big() < 0.5 ? NES.starBright : NES.starDim;
      ctx.fillRect(x, y, size, size);
    }
  }
  drawPlanet(ctx);
}

const hull = (world, tx, ty) => world.shapes[ty]?.[tx] === '#';
const shaped = (world, tx, ty) => {
  const ch = world.shapes[ty]?.[tx];
  return ch !== undefined && ch !== '.' && ch !== '#';
};

// A shaped tile, pixel by pixel from the mask: grey, bright where the pixel above is empty,
// dark where the pixel below is empty (bright wins).
function paintShaped(ctx, world, tx, ty) {
  const solid = (x, y) => x >= 0 && x < world.maskW && y >= 0 && y < world.maskH && world.mask[y * world.maskW + x] === 1;
  const ch = world.shapes[ty][tx];
  const deadly = ch === 'W' || ch === 'M'; // big spikes: warning red, not hull grey
  for (let y = ty * PX8; y < ty * PX8 + PX8; y++) {
    for (let x = tx * PX8; x < tx * PX8 + PX8; x++) {
      if (!solid(x, y)) continue;
      ctx.fillStyle = deadly
        ? (y > 0 && !solid(x, y - 1) ? NES.warnLight : !solid(x, y + 1) ? NES.warnDark : NES.warnMid)
        : y > 0 && !solid(x, y - 1) ? NES.starBright : !solid(x, y + 1) ? NES.hullDark : NES.hullGrey;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

// What a block of big spikes blurs to: the average of the 8-bit colours of its own solid pixels (`base`: the 8-bit mask), as
// [r, g, b]; null when the block holds none. Every coarser look of the spikes takes its colour from here, so the red only
// ever changes by what the block takes in.
const WARN_RGB = [NES.warnLight, NES.warnMid, NES.warnDark].map((h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)));
export function spikeBlockColour(base, maskW, maskH, x0, y0, size) {
  const solid = (x, y) => x >= 0 && x < maskW && y >= 0 && y < maskH && base[y * maskW + x] === 1;
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y0 + size; y++) {
    for (let x = x0; x < x0 + size; x++) {
      if (!solid(x, y)) continue;
      const c = WARN_RGB[y > 0 && !solid(x, y - 1) ? 0 : !solid(x, y + 1) ? 2 : 1];
      sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]; n++;
    }
  }
  return n ? sum.map((v) => Math.round(v / n)) : null;
}

// Ice: the top two pixel rows of an icy tile's solid surface in pale blue, a faint tint on the rest.
export const ICE_TOP = '#D8F8FC', ICE_SECOND = '#A4E4FC', ICE_TINT = 'rgba(96,176,255,0.22)';
function paintIce(ctx, world, tx, ty) {
  const solid = (x, y) => x >= 0 && x < world.maskW && y >= 0 && y < world.maskH && world.mask[y * world.maskW + x] === 1;
  for (let y = ty * PX8; y < ty * PX8 + PX8; y++) {
    for (let x = tx * PX8; x < tx * PX8 + PX8; x++) {
      if (!solid(x, y)) continue;
      if (!solid(x, y - 1)) { ctx.fillStyle = ICE_TOP; ctx.fillRect(x, y, 1, 1); }
      else if (!solid(x, y - 2)) { ctx.fillStyle = ICE_SECOND; ctx.fillRect(x, y, 1, 1); }
      else { ctx.fillStyle = ICE_TINT; ctx.fillRect(x, y, 1, 1); }
    }
  }
}

// The terrain of every tile, in its true shapes, onto ctx (level pixels).
export function paintTerrain(ctx, world) {
  for (let ty = 0; ty < world.height; ty++) {
    for (let tx = 0; tx < world.width; tx++) {
      if (hull(world, tx, ty)) paint(ctx, ty === 0 || hull(world, tx, ty - 1) ? HULL_INNER : HULL_TOP, tx * PX8, ty * PX8);
      else if (shaped(world, tx, ty)) paintShaped(ctx, world, tx, ty);
      if (world.ice && world.ice[ty * world.width + tx] === 1) paintIce(ctx, world, tx, ty);
    }
  }
}

function buildBackdrop(world, terrain = true) {
  const canvas = makeCanvas(world.maskW, world.maskH);
  const ctx = canvas.getContext('2d');
  drawSky(ctx, world.maskW, world.maskH);
  if (terrain) paintTerrain(ctx, world);
  return canvas;
}

let backdropFor = null, backdrop = null;
let skyFor = null, skyBackdrop = null;      // the sky alone (opts.terrain === false), for the slider look

// Facing is shared by both views: 1 right, -1 left; it only changes when the player moves sideways.
let facing = 1;
export function updateFacing(player) {
  if (player.facing === 1 || player.facing === -1) facing = player.facing;
  else if (player.vx !== 0) facing = player.vx > 0 ? 1 : -1;
  return facing;
}

const px = (v) => Math.round(v * PX8);

// Is a box (in level pixels) at least partly inside the view whose top-left is (ox, oy)?
const seen = (x, y, w, h, ox, oy, vw = W, vh = H) => x + w > ox && x < ox + vw && y + h > oy && y < oy + vh;

// Button: red cap 6 x 2 over a dark base 2 pixels high (so both are whole blocks at the slider's step 4); pressed, the cap sits
// one pixel lower, into the base.
function drawButton(ctx, b) {
  const x = px(b.x), floor = px(b.y) + PX8; // floor line is the bottom of the tile
  ctx.fillStyle = NES.buttonCap;
  ctx.fillRect(x + 1, floor - (b.pressed ? 3 : 4), 6, 2);
  ctx.fillStyle = NES.buttonBase;
  ctx.fillRect(x, floor - 2, PX8, 2);
}

// A button the slider has frozen at step 2: its voted picture is a flat slab on the bottom half of its tile, in the colour of the
// state it was left in (the red cap while up, the dark base while pressed).
function drawButtonSlab(ctx, b) {
  ctx.fillStyle = b.pressed ? NES.buttonBase : NES.buttonCap;
  ctx.fillRect(px(b.x), px(b.y) + PX8 / 2, PX8, PX8 / 2);
}

// One-pixel wire: down 2 below the button's floor line, across, then up or down to the door's base.
function drawWire(ctx, b, d) {
  const bx = px(b.x) + 3, floor = px(b.y) + PX8;
  const dx = px(d.x) + 7, base = px(d.y) + 24;
  const row = floor + 2;
  ctx.fillStyle = NES.wire;
  ctx.fillRect(bx, floor, 1, 3);
  ctx.fillRect(Math.min(bx, dx), row, Math.abs(dx - bx) + 1, 1);
  const y0 = Math.min(row, base), y1 = Math.max(row, base);
  ctx.fillRect(dx, y0, 1, y1 - y0 + 1);
}

// Wire from a button to a prop's tile: down from the button, across, then up or down to the prop's nearest edge.
function drawPropWire(ctx, b, p) {
  const bx = px(b.x) + 3, floor = px(b.y) + PX8;
  const dx = px(p.x) + Math.floor(px(p.w) / 2), row = floor + 2;
  const target = px(p.y) >= row ? px(p.y) : px(p.y + p.h) - 1;
  ctx.fillStyle = NES.wire;
  ctx.fillRect(bx, floor, 1, 3);
  ctx.fillRect(Math.min(bx, dx), row, Math.abs(dx - bx) + 1, 1);
  const y0 = Math.min(row, target), y1 = Math.max(row, target);
  ctx.fillRect(dx, y0, 1, y1 - y0 + 1);
}

// A crate, drawn from the very pixels that collide (dyn.js rasterSquare), shaded in its own frame. Level pixels, shifted by (ox, oy).
export function drawCrate(ctx, c, ox = 0, oy = 0) {
  const { cx, cy, tilt } = cratePose(c);
  rasterSquare(cx, cy, CRATE_HALF, tilt, (x, y, u, v) => {
    ctx.fillStyle = crateColour(Math.min(15, Math.floor(u + CRATE_HALF)), Math.min(15, Math.floor(v + CRATE_HALF)));
    ctx.fillRect(x - ox, y - oy, 1, 1);
  });
}

// One ball's 8-bit sprite, its top-left at level pixel (px(b.x), px(b.y)) less (ox, oy).
export function drawBall8(ctx, b, ox = 0, oy = 0) { paint(ctx, BALL, px(b.x) - ox, px(b.y) - oy); }

// `opts`: { player: false } leaves the astronaut out and { overlays: false } the screen-space extras (key count, sign
// text); the compositor (render.js) draws those itself, on top of the mixed picture. The slider look (renderSlider.js)
// also uses { terrain: false } (sky and things, no terrain) and { extra: n } (things up to n pixels beyond the right and
// bottom of the view are drawn too, for a canvas that is n pixels bigger), and { sky: false } (no backdrop at all: the slider look
// reduces the things on their own). { lens } (renderSlider.js) says what each thing looks like at a slider step: { spikes(s) ->
// drawn?, button(b) -> 'cap' | 'slab' | 'none', prop(ctx, p, q, world, draw) -> draws the prop its own way, or not at all,
// ball(b) -> 'sprite' | 'box', group(kind, thing, draw) -> runs draw, and notes that it is one thing's picture (the look reduces
// each thing on its own) }. With no lens every thing is drawn as it always was.
export function render8(ctx, world, player, cam = { x: 0, y: 0 }, opts = {}) {
  let back;
  if (opts.sky === false) back = null;
  else if (opts.terrain === false) {
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
  const vw = W + (opts.extra || 0), vh = H + (opts.extra || 0);
  const lens = opts.lens;
  if (back) ctx.drawImage(back, -ox, -oy);
  const group = lens && lens.group ? lens.group : (kind, thing, fn) => fn();   // one thing's picture (the slider look reduces it alone)

  // Sprites are painted pixel by pixel, not blitted from their baked canvases: on one tablet a blitted sprite did not always
  // show (first the walking figure, then the exit). The same picture, pixel for pixel.
  const draw = (img, x, y) => {
    if (seen(x, y, img.width, img.height, ox, oy, vw, vh)) paint(ctx, img.sprite, x - ox, y - oy, img.flip);
  };
  const spikes = bake('spikes', SPIKES);
  for (const s of world.spikes) {
    if (!lens || lens.spikes(s)) group('spikes', s, () => draw(spikes, px(s.x), px(s.y) + PX8 - SPIKES.rows.length));
  }

  // Wires and buttons are drawn in level space, shifted by the camera.
  ctx.save();
  ctx.translate(-ox, -oy);
  for (const b of world.buttons) {
    const door = world.doors.find((d) => d.id === b.id);
    if (door) group('wire', b, () => drawWire(ctx, b, door));
    // Props with a button field (spawners) are wired the same way, to the middle of their box.
    for (const p of world.props || []) {
      if (p.type in PROPS && p.button === b.id && PROPS[p.type].fields.some((f) => f.kind === 'button')) group('wire', b, () => drawPropWire(ctx, b, p));
    }
  }
  for (const b of world.buttons) {
    const form = lens ? lens.button(b) : 'cap';
    if (form === 'cap') group('button', b, () => drawButton(ctx, b));
    else if (form === 'slab') group('button', b, () => drawButtonSlab(ctx, b));
  }
  ctx.restore();

  for (const d of world.doors) {
    const x = px(d.x), y = px(d.y);
    group('door', d, () => {
      draw(bake(d.open ? 'door-open' : 'door', d.open ? DOOR_OPEN : DOOR_CLOSED), x, y);
      if (seen(x + 7, y - 2, 2, 2, ox, oy, vw, vh)) {
        ctx.fillStyle = d.open ? NES.lampOpen : NES.lampClosed;
        ctx.fillRect(x + 7 - ox, y - 2 - oy, 2, 2);
      }
    });
  }
  // Props (ladders, lasers, keys ...): each draws itself in level pixels; skipped when its box is off screen
  // (a prop that draws outside its box sets `reaches`).
  ctx.save();
  ctx.translate(-ox, -oy);
  for (const p of world.props || []) {
    if (!(p.type in PROPS)) continue;
    for (const q of looksIn(world, p, '8bit')) {
      if (!(PROPS[p.type].reaches || seen(px(q.x), px(q.y), px(q.w), px(q.h), ox, oy, vw, vh))) continue;
      if (lens) group('prop', q, () => lens.prop(ctx, p, q, world, () => PROPS[p.type].draw8(ctx, q, world)));
      else PROPS[p.type].draw8(ctx, q, world);
    }
  }
  ctx.restore();
  const padlock = bake('padlock', PADLOCK);
  for (const c0 of world.crates) {
    for (const c of looksIn(world, c0, '8bit')) {
      // A leaning crate reaches out of its flat 2 x 2 box by up to 3 pixels each way.
      group('crate', c, () => {
        if (seen(px(c.x) - 4, px(c.y) - 4, 2 * PX8 + 8, 2 * PX8 + 8, ox, oy, vw, vh)) drawCrate(ctx, c, ox, oy);
        if (c.locked) draw(padlock, px(c.x) + 5, px(c.y) + 5);
      });
    }
  }
  const ball = bake('ball', BALL);
  for (const b0 of world.balls) {
    for (const b of looksIn(world, b0, '8bit')) {
      if (lens && lens.ball(b0) === 'box') {                 // a ball on the slider's half-tile grid is a box, its colour
        if (seen(px(b.x), px(b.y), PX8, PX8, ox, oy, vw, vh)) group('ball', b, () => { ctx.fillStyle = NES.ballMid; ctx.fillRect(px(b.x) - ox, px(b.y) - oy, PX8, PX8); });
      } else group('ball', b, () => draw(ball, px(b.x), px(b.y)));
    }
  }
  group('exit', world.exit, () => draw(bake('exit', EXIT), px(world.exit.x), px(world.exit.y)));

  if (opts.player !== false) group('player', player, () => drawPlayer8(ctx, player, cam, opts.extra || 0));

  // Screen-space extras (key count, sign text), once per frame.
  if (opts.overlays !== false) drawOverlays8(ctx, world, player);
}

// The astronaut in his 8-bit look.
export function drawPlayer8(ctx, player, cam = { x: 0, y: 0 }, extra = 0) {
  const ox = px(cam.x), oy = px(cam.y);
  updateFacing(player);
  const x = px(player.x), y = px(player.y);
  const walking = player.vx !== 0 && player.onGround;
  const frame = walking ? Math.floor(x / 4) & 1 : 0;
  const left = facing < 0;
  // Painted pixel by pixel, not blitted from a baked canvas: on one tablet the blitted figure blinked while walking
  // (and only in 8-bit; the low-res figure, which is plain rectangles, did not).
  const sprite = ASTRONAUT_FRAMES[frame];
  if (seen(x, y, sprite.rows[0].length, sprite.rows.length, ox, oy, W + extra, H + extra)) paint(ctx, sprite, x - ox, y - oy, left);
}

// Screen-space extras: each prop's overlay8 (key count, sign text), in the picture's own pixels.
export function drawOverlays8(ctx, world, player) {
  for (const def of Object.values(PROPS)) if (def.overlay8) def.overlay8(ctx, world, player);
}
