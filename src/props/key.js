// Key: collected by touching it in 8-bit; the count is shown at the picture's top right. On the resolution slider a key is
// there while its picture, voted at the step, keeps its detail (slider.js): at steps 4 and 2 (at 2 a blob, still a key).
import { PLAYER_W, PLAYER_H, PX8, VIEW_W } from '../constants.js';
import { px, overlaps } from './common.js';
import { modeOfBox, hasZones } from '../zones.js';
import { drawnKeepsDetail } from '../slider.js';

const GOLD = '#F8B800', GOLD_DARK = '#AC7C00';

// An 8 x 8 key at level pixels (x, y).
function paintKey(ctx, x, y) {
  ctx.fillStyle = GOLD_DARK;
  ctx.fillRect(x + 1, y + 1, 4, 4);   // bow outline
  ctx.fillRect(x + 4, y + 4, 1, 4);   // shaft shadow
  ctx.fillStyle = GOLD;
  ctx.fillRect(x + 2, y + 2, 2, 2);   // bow
  ctx.fillRect(x + 3, y + 3, 1, 5);   // shaft
  ctx.fillRect(x + 4, y + 6, 2, 1);   // teeth
  ctx.fillRect(x + 4, y + 4, 1, 1);
}

function drawKey(ctx, inst) {
  if (inst.taken) return;
  paintKey(ctx, px(inst.x), px(inst.y));
}

export default {
  type: 'key',
  label: 'Key',
  defaults: {},
  fields: [],
  size: () => [1, 1],
  check: () => null,
  solid: false,
  followsPicture: true,
  draw8: drawKey,
  overlay8(ctx, world) {
    const n = Math.min(world.keys || 0, 12);
    for (let i = 0; i < n; i++) paintKey(ctx, VIEW_W * PX8 - PX8 - 1 - i * (PX8 + 1), 1);
  },
  step(world, player) {
    if (world.mode !== '8bit' && !hasZones(world)) return;
    const pb = { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H };
    for (const p of world.props) {
      if (p.type !== 'key' || p.taken || modeOfBox(world, p.x, p.y, p.w, p.h) !== '8bit') continue;
      if (!drawnKeepsDetail(world, p, drawKey)) continue;
      if (overlaps(pb, p)) { p.taken = true; world.keys++; }
    }
  },
};
