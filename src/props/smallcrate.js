// Small crate: half a tile wide and one tall in 8-bit. Since 2026-11-20 it is pushed, carried and dropped exactly as a crate is
// (objects.js: the crate rules take small crates too, with their own box): in 8-bit a body that slides when pushed (by the player, a
// ball's row or another crate's), comes to rest by the crate friction and falls with gravity, but never turns; in low-res (and at
// the resolution slider's steps 2 and 1) it moves on the grid as a crate does, on its own grid (half a tile at step 2).
// Low-res rounds it up to a whole tile (two in one tile merge into one block; swapping back splits them). The swap snapping lives in
// world.js (trySwap, keyed on this type); the slider's own snapping (merging at step 1, splitting back) is in slider.js.
import { NES } from '../sprites8.js';
import { px } from './common.js';

const SIDES = ['left', 'right'];

export default {
  type: 'smallcrate',
  label: 'Small crate',
  defaults: { side: 'left' },
  fields: [{ key: 'side', label: 'Side', kind: 'choice', options: SIDES }],
  size: () => [1, 1],
  check: (o) => (SIDES.includes(o.side) ? null : 'side must be "left" or "right"'),
  solid: true,
  // Called by the level parser on each new instance: which half of the tile it starts in.
  place(inst) {
    if (inst.side === 'right') inst.x += 0.5;
    inst.w = 0.5;
    inst.h = 1;
    inst.count = 1;
  },
  draw8(ctx, inst, world) {
    const x = px(inst.x), y = px(inst.y), w = world ? px(inst.w) : 4, h = px(inst.h);
    ctx.fillStyle = NES.crateDark;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = NES.crateLight;
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = NES.crateDark;
    ctx.fillRect(x + 1, y + h / 2, w - 2, 1);
  },
  drawLow(ctx, inst) {
    const x = px(inst.x), y = px(inst.y), w = px(inst.w), h = px(inst.h);
    ctx.fillStyle = NES.crateMid;
    ctx.fillRect(x, y, w, h);
    if (inst.count === 2) { ctx.fillStyle = NES.crateDark; ctx.fillRect(x + w / 2 - 0.5, y, 1, h); }
  },
};

// (The player's push: objects.js pushSmallCrate, the crate's own push.)
export { pushSmallCrate } from '../objects.js';
