// Kiosk: a terminal you go to when you want to swap the resolution. Not solid in either mode (the player, crates and
// balls pass in front of it). On a level whose Swapping is Off ("Kiosks only") the player's swap input is accepted only
// while a kiosk is in reach (sim.js asks kioskInReach); on Manual levels it changes nothing and on Timed levels it is
// decoration. Drawn in both modes, like the exit: low-res needs it so the player can swap back.
import { PLAYER_W, PLAYER_H } from '../constants.js';
import { px, overlaps } from './common.js';

const BODY = '#3C3C3C', BODY_NEAR = '#BCBCBC', EDGE = '#7C7C7C', LEG = '#7C7C7C';
const SCREEN = '#0000BC', SCREEN_NEAR = '#0078F8', ICON = '#3CBCFC', ICON_NEAR = '#FCFCFC';
// What its picture averages to, away and near (a dark grey body, a blue screen); they were orange (#FC9838, #FCD8A8).
const LOW_COLOUR = '#3B4280', LOW_NEAR = '#759AC1';

// The kiosk the player's box overlaps (its 1 x 2 box), or null.
export function kioskInReach(world, player) {
  const pb = { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H };
  for (const p of world.props) if (p.type === 'kiosk' && overlaps(pb, p)) return p;
  return null;
}

export default {
  type: 'kiosk',
  label: 'Kiosk',
  defaults: {},
  fields: [],
  size: () => [1, 2],
  check: () => null,
  solid: false,
  // 8 x 16 pixels at the kiosk's top-left: a terminal on a post. Its screen shows the mode a swap would go TO:
  // coarse 2 x 2 blocks for 8-bit ("pixelated"), a thin diagonal line for low-res ("fine").
  draw8(ctx, inst, world) {
    const x = px(inst.x), y = px(inst.y), near = inst.near === true;
    const toLow = !world || world.mode === '8bit';
    ctx.fillStyle = near ? BODY_NEAR : BODY;
    ctx.fillRect(x, y + 1, 8, 10);                 // terminal
    ctx.fillStyle = EDGE;
    ctx.fillRect(x, y + 1, 8, 1);
    ctx.fillStyle = near ? SCREEN_NEAR : SCREEN;
    ctx.fillRect(x + 1, y + 3, 6, 6);              // screen
    ctx.fillStyle = near ? ICON_NEAR : ICON;
    if (toLow) {
      for (let i = 0; i < 6; i++) ctx.fillRect(x + 1 + i, y + 8 - i, 1, 1);   // fine: one-pixel line
    } else {
      for (const [bx, by] of [[0, 0], [2, 2], [4, 0], [0, 4], [4, 4]]) ctx.fillRect(x + 1 + bx, y + 3 + by, 2, 2);   // pixelated
    }
    ctx.fillStyle = LEG;
    ctx.fillRect(x + 3, y + 11, 2, 3);             // post
    ctx.fillRect(x + 1, y + 14, 6, 2);             // base
    ctx.fillStyle = EDGE;
    ctx.fillRect(x + 1, y + 14, 6, 1);
  },
  drawLow(ctx, inst) {
    ctx.fillStyle = inst.near === true ? LOW_NEAR : LOW_COLOUR;
    ctx.fillRect(px(inst.x), px(inst.y), px(inst.w), px(inst.h));
  },
  // Remember who is in reach so the picture can light up.
  step(world, player) {
    const pb = { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H };
    for (const p of world.props) if (p.type === 'kiosk') p.near = overlaps(pb, p);
  },
};
