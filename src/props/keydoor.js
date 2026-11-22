// Key door: solid in both modes until opened. In 8-bit, running into it with a key opens it for good. On the resolution
// slider it opens while its keyhole (2 pixels wide), voted at the step, is still there (slider.js): at step 4, not at
// step 2.
import { DOOR_W, DOOR_H, PLAYER_W, PLAYER_H, PX8 } from '../constants.js';
import { NES } from '../sprites8.js';
import { px, EPS } from './common.js';
import { modeOfBox } from '../zones.js';
import { drawnKeepsDetail } from '../slider.js';

const LOW_COLOUR = NES.crateMid;      // the colour family of its picture (a crate's gold and brown); it was a purple (#A800A8)

// The keyhole, a pixel left of the middle of the door: 2 x 4 pixels.
function drawKeyhole(ctx, inst) {
  const x = px(inst.x), y = px(inst.y), w = px(inst.w), h = px(inst.h);
  ctx.fillStyle = NES.crateDark;
  ctx.fillRect(x + w / 2 - 2, y + h / 2 - 2, 2, 4);   // on the 2-pixel grid, so it is whole at step 4
}
const keyholeWorks = (world, d) => drawnKeepsDetail(world, d, drawKeyhole);   // (true wherever its tiles are not at step 4 or 2)

export default {
  type: 'keydoor',
  label: 'Key door',
  defaults: {},
  fields: [],
  size: () => [DOOR_W, DOOR_H],
  check: () => null,
  solid: true,
  worksAt: keyholeWorks,
  draw8(ctx, inst, world) {
    if (inst.open) return;
    const x = px(inst.x), y = px(inst.y), w = px(inst.w), h = px(inst.h);
    ctx.fillStyle = NES.crateDark;
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = NES.crateLight;
    ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
    ctx.fillStyle = NES.crateDark;
    ctx.fillRect(x + 1, y + 8, w - 2, 1);
    ctx.fillRect(x + 1, y + 16, w - 2, 1);
    if (!world || keyholeWorks(world, inst)) drawKeyhole(ctx, inst);   // the slider's step 2 has lost the keyhole: so has the picture
  },
  drawLow(ctx, inst) {
    if (inst.open) return;
    ctx.fillStyle = LOW_COLOUR;
    ctx.fillRect(px(inst.x), px(inst.y), px(inst.w), px(inst.h));
  },
};

// If a key is held and a closed key door is directly beside the player on side `dir` (-1 or 1),
// open it, use up the key and return true. 8-bit only (and, on the slider, only while the keyhole is there).
export function openKeyDoor(world, player, dir) {
  if (!(world.keys > 0)) return false;
  const gap = 1 / PX8 + EPS;
  for (const d of world.props) {
    if (d.type !== 'keydoor' || d.open || modeOfBox(world, d.x, d.y, d.w, d.h) !== '8bit' || !keyholeWorks(world, d)) continue;
    if (!(player.y < d.y + d.h && player.y + PLAYER_H > d.y)) continue;
    const dx = dir > 0 ? d.x - (player.x + PLAYER_W) : player.x - (d.x + d.w);
    if (dx < -EPS || dx > gap) continue;
    d.open = true;
    world.keys--;
    return true;
  }
  return false;
}
