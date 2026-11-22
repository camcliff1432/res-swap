// Cactus (an experiment): a solid plant one tile wide that grows one tile taller with every notch of the resolution slider,
// whichever way the slider moves, up to its tallest height. It is the one thing whose change does not come from its picture:
// it counts the changes. The growing is planned with the notch (slider.js planOn): it grows only into a free tile (no
// terrain, door, crate, ball or other thing), and a player standing on its top goes up with it. It is not deadly. In a level
// without the slider it never grows.
import { NES } from '../sprites8.js';
import { px } from './common.js';

export const TALLEST_MIN = 1, TALLEST_MAX = 32;
const valid = (n) => Number.isInteger(n) && n >= TALLEST_MIN && n <= TALLEST_MAX;

export default {
  type: 'cactus',
  label: 'Cactus',
  defaults: { max: 5 },
  fields: [{ key: 'max', label: 'Tallest', kind: 'int', min: TALLEST_MIN, max: TALLEST_MAX }],
  size: () => [1, 1],
  check: (o) => (valid(o.max) ? null : `max must be a whole number from ${TALLEST_MIN} to ${TALLEST_MAX}`),
  solid: true,
  // Every tile is filled edge to edge (its picture is its box at every step): dark skin, a lighter core, pale spines.
  draw8(ctx, inst) {
    const x = px(inst.x), y = px(inst.y), h = px(inst.h);
    ctx.fillStyle = NES.exitDark;
    ctx.fillRect(x, y, 8, h);
    ctx.fillStyle = NES.exitMid;
    ctx.fillRect(x + 2, y, 4, h);
    ctx.fillRect(x + 1, y, 6, 1);                       // the rounded top
    ctx.fillStyle = NES.exitLight;
    for (let r = 2; r < h; r += 4) {
      ctx.fillRect(x, y + r, 1, 1);
      ctx.fillRect(x + 7, y + Math.min(r + 2, h - 1), 1, 1);
      ctx.fillRect(x + 3 + ((r >> 2) & 1), y + r + 1, 1, 1);
    }
  },
  drawLow(ctx, inst) {
    ctx.fillStyle = NES.exitMid;
    ctx.fillRect(px(inst.x), px(inst.y), px(inst.w), px(inst.h));
  },
};
