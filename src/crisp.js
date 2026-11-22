// Crisp low-resolution art for the slider's steps 4 and 2 at rest. Pure: no canvas, no world (renderSlider.js draws what this works out).
//
// At rest a step is not a blur: it is a picture made in blocks of that step's size (2 x 2 level pixels at step 4, 4 x 4 at step 2).
// A thing gets a block where it fills more than half of that block (the vote the terrain and the rules take: a tie loses), and the
// block's colour is the average of the thing's OWN pixels inside it: what blurring would make of the thing, with nothing of the
// sky or of what lies behind it mixed in. Every block is opaque.
//
//   createRecorder(box)      a drawing context that records the pixels a draw function fills (colour per pixel), for one thing at a time
//   reduceBlocks(...)        a recorded thing -> its blocks on a grid (kept ones, or the best covered when none wins)
//   runsOf(blocks, size)     the blocks as rectangles, runs of one colour in a row merged
//   createRaster(w, h)       the same recording into a plain array (the sky of a whole level)
//   dominantBlocks(...)      the sky: the colour most of a block's pixels have (as step 1 votes its tiles)
//   tinyPlayer(...)          the astronaut drawn by hand for step 2 (2 x 3 blocks)
import { ASTRONAUT_PALETTE } from './sprites8.js';
import { wins } from './vote.js';

const colours = new Map();
export function parseColour(s) {
  let c = colours.get(s);
  if (c !== undefined) return c;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (m) {
    const h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    c = parseInt(h, 16);
  } else {
    const r = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
    c = r ? (Number(r[1]) << 16) | (Number(r[2]) << 8) | Number(r[3]) : 0;
  }
  colours.set(s, c);
  return c;
}
const hexes = new Map();
export function hexOf(n) {
  let h = hexes.get(n);
  if (h === undefined) hexes.set(n, h = `#${n.toString(16).padStart(6, '0').toUpperCase()}`);
  return h;
}

// A drawing context that keeps pixels instead of painting. It does what the draw functions use: fillStyle, fillRect, save, restore,
// translate, and drawImage of a baked sprite (a canvas that carries its `sprite` and `flip`; any other image is not a thing).
// `sink(x, y, colour)` receives every pixel (later pixels replace earlier ones).
function recorderContext(box, sink) {
  let colour = 0, tx = 0, ty = 0;
  const stack = [];
  const fillRect = (x, y, w, h) => {
    const xa = Math.max(box.x0, x + tx), xb = Math.min(box.x1, x + tx + w);
    const ya = Math.max(box.y0, y + ty), yb = Math.min(box.y1, y + ty + h);
    for (let yy = ya; yy < yb; yy++) for (let xx = xa; xx < xb; xx++) sink(xx, yy, colour);
  };
  return {
    set fillStyle(v) { colour = parseColour(v); },
    get fillStyle() { return hexOf(colour); },
    fillRect,
    save() { stack.push([tx, ty]); },
    restore() { [tx, ty] = stack.pop() || [0, 0]; },
    translate(x, y) { tx += x; ty += y; },
    beginPath() {}, rect() {}, clip() {},
    drawImage(img, x, y) {
      const sprite = img && img.sprite;
      if (!sprite || typeof x !== 'number') return;
      const w = sprite.rows[0].length;
      sprite.rows.forEach((row, yy) => {
        for (let xx = 0; xx < w; xx++) {
          const col = sprite.palette[row[xx]];
          if (!col) continue;
          colour = parseColour(col);
          fillRect(x + (img.flip ? w - 1 - xx : xx), y + yy, 1, 1);
        }
      });
    },
  };
}

// Pixels of one thing at a time: { ctx, take() -> { idx, col, box } } (idx: where each pixel is in the box, row by row, col: its colour,
// in the order they were first drawn). `box` { x0, y0, x1, y1 } clips what is kept (the picture and a margin). The scratch grid is
// reused: taking a thing's pixels clears exactly the cells it touched.
export function createRecorder(box) {
  const w = box.x1 - box.x0, grid = new Int32Array(w * (box.y1 - box.y0)).fill(-1);
  let touched = [];
  const ctx = recorderContext(box, (x, y, c) => {
    const i = (y - box.y0) * w + (x - box.x0);
    if (grid[i] < 0) touched.push(i);
    grid[i] = c;
  });
  return {
    ctx,
    take() {
      const idx = touched, col = new Array(idx.length);
      for (let k = 0; k < idx.length; k++) { col[k] = grid[idx[k]]; grid[idx[k]] = -1; }
      touched = [];
      return { idx, col, box };
    },
  };
}

// A whole picture, dense: { ctx, data: Int32Array (-1 where nothing was drawn), w, h }.
export function createRaster(w, h) {
  const data = new Int32Array(w * h).fill(-1);
  return { ctx: recorderContext({ x0: 0, y0: 0, x1: w, y1: h }, (x, y, c) => { data[y * w + x] = c; }), data, w, h };
}

// The blocks of `size` pixels, on a grid whose block edges fall on (ox, oy) and every `size` pixels from there, that a recorded thing
// reaches: [{ x, y, n, colour }] (x, y the block's top-left, n its pixels of the thing, colour the average of those pixels), in rows.
// Kept: more than half of the block is the thing (the vote of the terrain and of slider.js, vote.js). When no block keeps and `best` is set,
// the best covered blocks are kept instead (a thing the rules say still exists is never invisible).
export function reduceBlocks({ idx, col, box }, size, ox, oy, best = false) {
  const w = box.x1 - box.x0;
  const at = new Map(), bx = [], by = [], n = [], r = [], g = [], bl = [];
  let lastKey = -1, j = 0;
  for (let k = 0; k < idx.length; k++) {
    const x = (idx[k] % w) + box.x0, y = Math.floor(idx[k] / w) + box.y0, c = col[k];
    const cx = Math.floor((x - ox) / size), cy = Math.floor((y - oy) / size), key = (cy + 2048) * 8192 + (cx + 2048);
    if (key !== lastKey) {
      j = at.get(key);
      if (j === undefined) { j = n.length; at.set(key, j); bx.push(cx); by.push(cy); n.push(0); r.push(0); g.push(0); bl.push(0); }
      lastKey = key;
    }
    n[j]++; r[j] += c >> 16; g[j] += (c >> 8) & 255; bl[j] += c & 255;
  }
  let list = n.map((_, i) => i);
  const kept = list.filter((i) => wins(n[i], size * size));
  if (kept.length === 0 && best && list.length > 0) {
    const top = Math.max(...n);
    list = list.filter((i) => n[i] === top);
  } else list = kept;
  list.sort((a, b) => by[a] - by[b] || bx[a] - bx[b]);
  return list.map((i) => ({ x: ox + bx[i] * size, y: oy + by[i] * size, n: n[i], colour: (Math.round(r[i] / n[i]) << 16) | (Math.round(g[i] / n[i]) << 8) | Math.round(bl[i] / n[i]) }));
}

// Blocks as rectangles [x, y, w, h, colour]: neighbours in a row with one colour become one rectangle.
export function runsOf(blocks, size) {
  const out = [];
  let last = null;
  for (const b of blocks) {
    if (last && last[1] === b.y && last[0] + last[2] === b.x && last[4] === b.colour) last[2] += size;
    else out.push(last = [b.x, b.y, size, size, b.colour]);
  }
  return out;
}

// The colour most of each block's pixels have, per block of `size` on the pixel grid of `data` (a raster's): an Int32Array
// cols x rows (the first colour to reach the top count wins a tie, as the low-res backdrop does).
export function dominantBlocks(data, w, h, size) {
  const cols = Math.floor(w / size), rows = Math.floor(h / size), out = new Int32Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const counts = new Map();
      let best = data[cy * size * w + cx * size], top = 0;
      for (let y = cy * size; y < cy * size + size; y++) {
        for (let x = cx * size; x < cx * size + size; x++) {
          const v = data[y * w + x], n = (counts.get(v) || 0) + 1;
          counts.set(v, n);
          if (n > top) { best = v; top = n; }
        }
      }
      out[cy * cols + cx] = best;
    }
  }
  return { cols, rows, colours: out };
}

// The astronaut by hand at step 2 (his 8 x 12 pixels are 2 x 3 blocks of 4): the figure facing right, one character a block ('.' empty).
// A head with the visor toward where he faces, a torso, legs; the second walking frame lifts the rear leg. Mirrored when he faces left.
const TINY = { W: ASTRONAUT_PALETTE.W, B: ASTRONAUT_PALETTE.B, G: ASTRONAUT_PALETTE.G };
const TINY_ROWS = [['WB', 'WW', 'GG'], ['WB', 'WW', '.G']];
// -> [[x, y, w, h, colour]] relative to the figure's own top-left, 4 x 4 blocks.
export function tinyPlayer(frame, left, size = 4) {
  const rows = TINY_ROWS[frame & 1], out = [];
  rows.forEach((row, by) => {
    for (let i = 0; i < row.length; i++) {
      const ch = row[left ? row.length - 1 - i : i];
      if (ch !== '.') out.push([i * size, by * size, size, size, parseColour(TINY[ch])]);
    }
  });
  return out;
}
