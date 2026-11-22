// Grenade: a pickup. Walking over it (in either mode) takes `count` grenades of its kind, size and duration into the
// player's queue (world.held, in pickup order); it then stays gone until the room restarts. Throwing, flight and the
// low-res zone it makes live in src/grenade.js. Not solid. Drawn in 8-bit as a small round grenade with a coloured band
// (timed: cyan, permanent: magenta, things: yellow-orange) and in low-res as a flat block in that colour. The area is a circle
// of `radius` tiles round where it goes off. A `things` grenade also makes its area permanently low-res, and the movable things
// in it (crates, balls, small crates, platforms, blades) stay low-res for good (world.js pixelateThings).
// Stage 4 of the resolution slider: a timed or permanent grenade may carry a `step` (8, 4, 2 or 1); its area is then at that
// step instead of low-res (8 makes a sharp area in a low-res room). A things grenade has none: its things go low-res for good.
import { PLAYER_W, PLAYER_H } from '../constants.js';
import { px, overlaps, stepField, checkStep } from './common.js';

export const KINDS = ['timed', 'permanent', 'things'];     // things: "Things (permanent)"
export const GRENADE_COLOURS = { timed: '#4CE8FC', permanent: '#FC48FC', things: '#FCA800' };
export const GRENADE_COLOURS_NEAR = { timed: '#B8F8FC', permanent: '#FCB8FC', things: '#FCE0A8' };
const COUNT_MIN = 1, COUNT_MAX = 9, SECONDS_MIN = 1, SECONDS_MAX = 30, RADIUS_MIN = 1, RADIUS_MAX = 8;
const whole = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
const BODY = '#3C6C2C', BODY_LIGHT = '#78B838', BODY_DARK = '#1C3C14', PIN = '#BCBCBC';

// An 8 x 8 grenade at level pixels (x, y): a round body, a band in the kind's colour, a pin on top.
export function paintGrenade(ctx, x, y, kind) {
  ctx.fillStyle = BODY_DARK;
  ctx.fillRect(x + 1, y + 3, 6, 5);
  ctx.fillRect(x + 2, y + 2, 4, 6);
  ctx.fillStyle = BODY;
  ctx.fillRect(x + 2, y + 3, 4, 4);
  ctx.fillRect(x + 1, y + 4, 6, 3);
  ctx.fillStyle = BODY_LIGHT;
  ctx.fillRect(x + 2, y + 3, 2, 1);
  ctx.fillRect(x + 2, y + 4, 1, 1);
  ctx.fillStyle = GRENADE_COLOURS[kind] || GRENADE_COLOURS.timed;
  ctx.fillRect(x + 1, y + 5, 6, 1);
  ctx.fillStyle = PIN;
  ctx.fillRect(x + 3, y + 1, 2, 1);
  ctx.fillRect(x + 4, y, 2, 1);
  ctx.fillRect(x + 3, y + 2, 2, 1);
}

export default {
  type: 'grenade',
  label: 'Grenade',
  defaults: { kind: 'timed', count: 1, seconds: 5, radius: 3 },
  fields: [
    { key: 'kind', label: 'Kind', kind: 'choice', options: KINDS },
    { key: 'count', label: 'Count', kind: 'int', min: COUNT_MIN, max: COUNT_MAX },
    { key: 'seconds', label: 'Seconds (timed only)', kind: 'int', min: SECONDS_MIN, max: SECONDS_MAX },
    { key: 'radius', label: 'Radius (tiles)', kind: 'int', min: RADIUS_MIN, max: RADIUS_MAX },
    stepField('Low-res (as today)'),
  ],
  // Older levels have `width` and `height` of a rectangle: the radius is half the larger. (Used by the parser and the server.)
  migrate(o) {
    if (o.radius !== undefined || (o.width === undefined && o.height === undefined)) return o;
    const { width, height, ...rest } = o;
    return { ...rest, radius: Math.max(RADIUS_MIN, Math.min(RADIUS_MAX, Math.round(Math.max(width || 0, height || 0) / 2))) };
  },
  size: () => [1, 1],
  check(o) {
    if (!KINDS.includes(o.kind)) return `kind must be one of ${KINDS.join(', ')}`;
    if (!whole(o.count, COUNT_MIN, COUNT_MAX)) return `count must be a whole number from ${COUNT_MIN} to ${COUNT_MAX}`;
    if (!whole(o.seconds, SECONDS_MIN, SECONDS_MAX)) return `seconds must be a whole number from ${SECONDS_MIN} to ${SECONDS_MAX}`;
    if (!whole(o.radius, RADIUS_MIN, RADIUS_MAX)) return `radius must be a whole number from ${RADIUS_MIN} to ${RADIUS_MAX}`;
    if (o.kind === 'things' && o.step !== undefined) return 'a things grenade has no resolution step (its things go low-res for good)';
    return checkStep(o.step);
  },
  solid: false,
  draw8(ctx, inst) {
    if (inst.taken) return;
    paintGrenade(ctx, px(inst.x), px(inst.y), inst.kind);
  },
  drawLow(ctx, inst) {
    if (inst.taken) return;
    ctx.fillStyle = GRENADE_COLOURS[inst.kind] || GRENADE_COLOURS.timed;
    ctx.fillRect(px(inst.x), px(inst.y), px(inst.w), px(inst.h));
  },
  // Collected by touching it, in either mode: `count` grenades join the end of the player's queue.
  step(world, player) {
    const pb = { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H };
    for (const p of world.props) {
      if (p.type !== 'grenade' || p.taken || !overlaps(pb, p)) continue;
      p.taken = true;
      for (let i = 0; i < p.count; i++) world.held.push({ kind: p.kind, seconds: p.seconds, radius: p.radius, ...(p.step === undefined ? {} : { step: p.step }) });
    }
  },
};
