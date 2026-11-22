// Window: a resolution window. A zone (see zones.js) at its position: inside it the world is in the window's mode
// (default low-res) whatever the base mode is; or, set to `opposite`, always in the other mode from the room's. It is not solid and nothing collides with its frame. The frame is
// drawn by the compositor (src/render.js), as part of the screen; the definition draws only the palette icon.
// Stage 4 of the resolution slider: a window may carry a `step` (8, 4, 2 or 1, see zones.js); inside it the world is at that
// step whatever the room's step or mode is. Without a step it is in its mode, as it always was (8 is the same as 8-bit, 1 as
// low-res). Allowed in every level: two-mode rooms too (the study's "in-between moments").
import { NES } from '../sprites8.js';
import { stepField, checkStep } from './common.js';

const W_MIN = 1, W_MAX = 32, H_MIN = 1, H_MAX = 18;
const MODES = ['low', '8bit', 'opposite'];      // opposite: always the other one from the room (it flips with every swap)
const fit = (n, lo, hi, fallback) => (Number.isInteger(n) && n >= lo && n <= hi ? n : fallback);

export default {
  type: 'window',
  label: 'Window',
  defaults: { width: 6, height: 4, mode: 'low' },
  fields: [
    { key: 'width', label: 'Width', kind: 'int', min: W_MIN, max: W_MAX },
    { key: 'height', label: 'Height', kind: 'int', min: H_MIN, max: H_MAX },
    { key: 'mode', label: 'Mode', kind: 'choice', options: MODES },
    stepField('Its Mode (as today)'),
  ],
  size: (o) => [fit(o.width, W_MIN, W_MAX, 6), fit(o.height, H_MIN, H_MAX, 4)],
  check(o) {
    if (!Number.isInteger(o.width) || o.width < W_MIN || o.width > W_MAX) return `width must be a whole number from ${W_MIN} to ${W_MAX}`;
    if (!Number.isInteger(o.height) || o.height < H_MIN || o.height > H_MAX) return `height must be a whole number from ${H_MIN} to ${H_MAX}`;
    if (!MODES.includes(o.mode)) return `mode must be one of ${MODES.join(', ')}`;
    return checkStep(o.step);
  },
  solid: false,
  zone: true,
  // Only the palette icon (no world): a bright frame round a coarse picture. In the world the compositor draws it.
  draw8(ctx, inst, world) {
    if (world) return;
    const w = inst.w * 8, h = inst.h * 8;
    ctx.fillStyle = NES.hullDark;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = NES.hullGrey;
    for (let y = 2; y < h - 2; y += 8) for (let x = 2; x < w - 2; x += 8) if (((x + y) >> 3) % 2 === 0) ctx.fillRect(x, y, 4, 4);
    ctx.fillStyle = '#FCFCFC';
    ctx.fillRect(0, 0, w, 1); ctx.fillRect(0, h - 1, w, 1); ctx.fillRect(0, 0, 1, h); ctx.fillRect(w - 1, 0, 1, h);
  },
};
