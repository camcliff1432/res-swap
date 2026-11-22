// The list of props. Everything that cares about props (level parser, world, sim, renderers,
// builder, server) reads this. Palette order.
import ladder, { rope } from './ladder.js';
import laser from './laser.js';
import chain from './chain.js';
import key from './key.js';
import keydoor from './keydoor.js';
import sign from './sign.js';
import smallcrate from './smallcrate.js';
import spring from './spring.js';
import platform from './platform.js';
import blade from './blade.js';
import spawner from './spawner.js';
import windowProp from './window.js';
import kiosk from './kiosk.js';
import grenade from './grenade.js';
import cactus from './cactus.js';
import { middleStep, keepsDetail, drawnClass, drawnKeepsDetail } from '../slider.js';
import { spikesWork, buttonWorks } from '../objects.js';

export const PROPS = { ladder, rope, laser, chain, key, keydoor, sign, smallcrate, spring, platform, blade, spawner, window: windowProp, kiosk, grenade, cactus };

// Once per sim step, after the player moves.
export function stepProps(world, player, held, dt) {
  for (const def of Object.values(PROPS)) if (def.step) def.step(world, player, held, dt);
}

// The type of the first prop that wants the room restarted (the cause of death), else null.
export function propsKiller(world, player) {
  for (const [type, def] of Object.entries(PROPS)) if (def.kills && def.kills(world, player)) return type;
  return null;
}

// True when any prop wants the room restarted.
export function propsKill(world, player) {
  return Object.values(PROPS).some((def) => def.kills && def.kills(world, player));
}

// ---- the resolution slider's steps 4 and 2 (slider.js) ---------------------------------------------------------------
// For the look and anything else that must know what a thing is at the current step. `thing` is a prop, one of
// world.spikes or one of world.buttons. Outside steps 4 and 2 (step 8, step 1, every world without the slider) both
// answer true: the two-mode rules (and the renderers' own tests, such as a taken key) decide, exactly as before.
//
//   existsAtStep  is anything of it left to draw: false for a ladder, rope or chain whose picture voted to nothing, and
//                 for spikes once their picture is a flat slab (they are not there). A spring that is a plain block, a
//                 frozen button, a key door without its keyhole, a laser emitter: true.
//   worksAtStep   does it do its job: climb, hold, be collected, bounce, kill, press, open.
// A prop whose def has `followsPicture` works while some tile of its drawn picture keeps its detail (slider.js); one with
// `worksAt(world, inst)` says so itself (the key door: its keyhole); every other prop is untouched by the slider here.
export function existsAtStep(world, thing) {
  if (!world.res) return true;
  if (world.spikes.includes(thing)) return spikesWork(world, thing);
  const def = PROPS[thing.type];
  if (!def || !def.followsPicture) return true;
  for (let ty = Math.floor(thing.y); ty < Math.ceil(thing.y + thing.h); ty++) {
    for (let tx = Math.floor(thing.x); tx < Math.ceil(thing.x + thing.w); tx++) if (drawnClass(world, thing, def.draw8, tx, ty) !== 'gone') return true;
  }
  return false;
}

export function worksAtStep(world, thing) {
  if (!world.res) return true;
  if (world.spikes.includes(thing)) return spikesWork(world, thing);
  if (world.buttons.includes(thing)) return buttonWorks(world, thing);
  const def = PROPS[thing.type];
  if (!def) return true;
  if (def.worksAt) return def.worksAt(world, thing);
  return !def.followsPicture || drawnKeepsDetail(world, thing, def.draw8);
}

// One tile (tx, ty) of a prop that follows its picture (a piece of a tall ladder, rope or chain): does it work there?
export function pieceWorksAt(world, inst, tx, ty) {
  const def = PROPS[inst.type];
  if (!middleStep(world, tx, ty) || !def || !def.followsPicture) return true;
  return keepsDetail(drawnClass(world, inst, def.draw8, tx, ty));
}
