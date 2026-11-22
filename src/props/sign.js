// Sign: stub until the sign task. Data, size, check and a placeholder picture.
import { NES } from '../sprites8.js';
import { PLAYER_W, PLAYER_H, VIEW_W } from '../constants.js';
import { px, overlaps } from './common.js';
import { modeOfBox } from '../zones.js';
import { drawText, textWidth, GLYPH_H } from '../font.js';

const MAX_LINES = 2, MAX_COLS = 40;
export const SIGN_Y = 14, SIGN_Y_COUNTER = 27;   // the top of the text box, in picture pixels: as a rule, and under a counter

export default {
  type: 'sign',
  label: 'Sign',
  defaults: { text: '' },
  fields: [{ key: 'text', label: 'Text', kind: 'text', lines: MAX_LINES, cols: MAX_COLS }],
  size: () => [1, 1],
  check(o) {
    if (typeof o.text !== 'string') return 'text must be a string';
    const lines = o.text.split('\n');
    if (lines.length > MAX_LINES) return `text may have at most ${MAX_LINES} lines`;
    if (lines.some((l) => l.length > MAX_COLS)) return `each line may have at most ${MAX_COLS} characters`;
    if (!/^[\n\x20-\x7E]*$/.test(o.text)) return 'text may only use letters, digits, spaces and common punctuation';
    return null;
  },
  solid: false,
  draw8(ctx, inst) {
    const x = px(inst.x), y = px(inst.y);
    ctx.fillStyle = NES.crateDark;
    ctx.fillRect(x + 3, y + 4, 2, 4);          // post
    ctx.fillStyle = NES.crateMid;
    ctx.fillRect(x + 1, y + 1, 6, 4);          // board
    ctx.fillStyle = NES.crateLight;
    ctx.fillRect(x + 1, y + 1, 6, 1);
    ctx.fillStyle = NES.crateDark;
    ctx.fillRect(x + 2, y + 2, 4, 1);          // lines of writing
    ctx.fillRect(x + 2, y + 3, 3, 1);
  },
  overlay8(ctx, world, player) {
    const text = signText(world, player);
    if (!text) return;
    const lines = text.toUpperCase().split('\n');
    const w = Math.max(...lines.map(textWidth)) + 6, h = lines.length * (GLYPH_H + 1) - 1 + 6;
    // (below the counter of a timed or limited-swaps level: on a phone that box reaches down to about row 23 of the picture)
    const x = Math.floor((VIEW_W * 8 - w) / 2), y = world.counter ? SIGN_Y_COUNTER : SIGN_Y;
    ctx.fillStyle = '#FCFCFC';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#000000';
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    lines.forEach((line, i) => drawText(ctx, line, x + 3 + Math.floor((w - 6 - textWidth(line)) / 2), y + 3 + i * (GLYPH_H + 1), '#FCFCFC'));
  },
};

// The text of the first sign the player stands at, in 8-bit; else null.
export function signText(world, player) {
  const pb = { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H };
  for (const p of world.props) {
    if (p.type !== 'sign' || typeof p.text !== 'string' || p.text.trim() === '') continue;
    if (modeOfBox(world, p.x, p.y, p.w, p.h) === '8bit' && overlaps(pb, p)) return p.text;
  }
  return null;
}
