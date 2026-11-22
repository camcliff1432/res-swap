// Spawner: a wall hatch that makes a ball, crate or small crate in its own tile each time its button is
// pressed (8-bit only). Balls and crates are launched at `angle` (0 = right, 90 = up) and `speed` (tiles/s);
// a small crate just appears and falls. `limit` caps how many of its objects exist at once.
import { PLAYER_W, PLAYER_H, BALL_SIZE, CRATE_SIZE } from '../constants.js';
import { boxHitsSolid, newBall, newCrate } from '../world.js';
import { syncDyn } from '../dyn.js';
import { modeAt, modeOfBox, zoned } from '../zones.js';
import { px, overlaps } from './common.js';
import smallcrate from './smallcrate.js';

export const SPAWNS = ['ball', 'crate', 'smallcrate'];
const ANGLE_MAX = 359, SPEED_MAX = 14, LIMIT_MAX = 8;
const whole = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;

const FRAME = '#3C3C3C', INNER = '#1C1C1C', RIM = '#7C7C7C', ARROW = '#F8B800';

export default {
  type: 'spawner',
  label: 'Spawner',
  defaults: { button: '', spawns: 'ball', angle: 0, speed: 6, limit: 1 },
  fields: [
    { key: 'button', label: 'Triggered by button', kind: 'button' },
    { key: 'spawns', label: 'Spawns', kind: 'choice', options: SPAWNS },
    { key: 'angle', label: 'Angle (0 right, 90 up)', kind: 'int', min: 0, max: ANGLE_MAX },
    { key: 'speed', label: 'Speed (tiles/s)', kind: 'int', min: 0, max: SPEED_MAX },
    { key: 'limit', label: 'Limit at once', kind: 'int', min: 1, max: LIMIT_MAX },
  ],
  size: () => [1, 1],
  check(o) {
    if (!SPAWNS.includes(o.spawns)) return `spawns must be one of ${SPAWNS.join(', ')}`;
    if (!whole(o.angle, 0, ANGLE_MAX)) return `angle must be a whole number from 0 to ${ANGLE_MAX}`;
    if (!whole(o.speed, 0, SPEED_MAX)) return `speed must be a whole number from 0 to ${SPEED_MAX}`;
    if (!whole(o.limit, 1, LIMIT_MAX)) return `limit must be a whole number from 1 to ${LIMIT_MAX}`;
    return null;
  },
  solid: false,
  // A hatch in the wall with a small arrow along its angle.
  draw8(ctx, inst) {
    const x = px(inst.x), y = px(inst.y);
    ctx.fillStyle = FRAME;
    ctx.fillRect(x, y, 8, 8);
    ctx.fillStyle = RIM;
    ctx.fillRect(x + 1, y + 1, 6, 1);
    ctx.fillRect(x + 1, y + 6, 6, 1);
    ctx.fillStyle = INNER;
    ctx.fillRect(x + 1, y + 2, 6, 4);
    const a = (Number.isInteger(inst.angle) ? inst.angle : 0) * Math.PI / 180;
    ctx.fillStyle = ARROW;
    for (let t = 0; t <= 3; t++) ctx.fillRect(x + Math.round(3.5 + Math.cos(a) * t - 0.5), y + Math.round(3.5 - Math.sin(a) * t - 0.5), 1, 1);
  },
  // Rising edge of the button: one object, if the space is free and the limit is not reached.
  // (In low-res the stale `pressed` is just carried along, so a button held across a swap is not a new press.)
  step(world, player) {
    for (const s of world.props) {
      if (s.type !== 'spawner') continue;
      const btn = world.buttons.find((b) => b.id === s.button);
      const now = !!(btn && btn.pressed);
      const was = s.wasPressed === true;
      s.wasPressed = now;
      if (modeAt(world, s.x, s.y) === '8bit' && now && !was) trySpawn(world, player, s);   // acts only where its own tile is 8-bit
    }
  },
};

const mineOf = (s) => (o) => o.spawnedBy === s;

function trySpawn(world, player, s) {
  const mine = mineOf(s);
  if (world.balls.filter(mine).length + world.crates.filter(mine).length + world.props.filter(mine).length >= s.limit) return;
  const a = (s.angle * Math.PI) / 180;
  const clean = (v) => Math.round(v * 1e9) / 1e9;      // 6 * cos(90 degrees) is dust, not a speed
  const vx = clean(s.speed * Math.cos(a)), vy = clean(-s.speed * Math.sin(a));
  const free = (w, h) => !boxHitsSolid(world, s.x, s.y, w, h, world.mode, null)
    && !overlaps({ x: s.x, y: s.y, w, h }, { x: player.x, y: player.y, w: PLAYER_W, h: PLAYER_H });

  if (s.spawns === 'ball') {
    if (!free(BALL_SIZE, BALL_SIZE)) return;
    const ball = newBall(s.x, s.y, vx, vy);
    ball.spawnedBy = s;
    if (zoned(world)) ball.mode = modeOfBox(world, s.x, s.y, BALL_SIZE, BALL_SIZE);   // it starts in the mode of where it appears
    world.balls.push(ball);
  } else if (s.spawns === 'crate') {
    if (!free(CRATE_SIZE, CRATE_SIZE)) return;
    const crate = newCrate(s.x, s.y, false, world.dynNext++, vx, vy);
    crate.spawnedBy = s;
    if (zoned(world)) crate.mode = modeOfBox(world, s.x, s.y, CRATE_SIZE, CRATE_SIZE);
    world.crates.push(crate);
    syncDyn(world);                                  // its pixels go into the layer if it lives in 8-bit
  } else {
    const small = { type: 'smallcrate', x: s.x, y: s.y, w: 1, h: 1, solid: true, ...Object.fromEntries(smallcrate.fields.map((f) => [f.key, smallcrate.defaults[f.key]])) };
    smallcrate.place(small);
    if (!free(small.w, small.h)) return;
    small.spawnedBy = s;
    if (zoned(world)) small.mode = modeOfBox(world, s.x, s.y, small.w, small.h);
    world.props.push(small);
  }
}
