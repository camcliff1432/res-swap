// The camera: where the 32 x 18 tile view sits in a level. Pure; no canvas.
import { VIEW_W, VIEW_H, PX8 } from './constants.js';

// Top-left of the view in tiles: centred on the player's centre, kept inside the level, then
// rounded down to one picture pixel (1/8 tile) in both modes, so the view glides in low-res too: the big pixels
// slide across the screen with the level instead of the view jumping a whole tile at a time (the owner's choice).
export function cameraFor(world, player) {
  const grid = 1 / PX8;
  const axis = (centre, size, view) => {
    const v = Math.min(Math.max(centre - view / 2, 0), Math.max(size - view, 0));
    return Math.floor(v / grid) * grid + 0; // + 0 turns -0 into 0
  };
  return { x: axis(player.x + 0.5, world.width, VIEW_W), y: axis(player.y + 0.75, world.height, VIEW_H) };
}
