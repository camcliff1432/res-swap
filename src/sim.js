import { STEP } from './constants.js';
import { trySlide } from './slider.js';
import { createWorld, trySwap, reconcileModes, playerBuried, buriedTiles, pixelateThings } from './world.js';
import { setZones } from './zones.js';
import { waveSteps, waveColumns, waveZones } from './wave.js';
import { throwGrenade, stepGrenades, advanceGrenadeZones, appliedGrenadeZones } from './grenade.js';
import { createPlayer, stepPlayer, fellOut, atExit } from './physics.js';
import { stepBalls, stepCrates, stepLow, updateDoors, touchesSpikes, touchesBigSpikes } from './objects.js';
import { stepProps, propsKiller } from './props/index.js';
import { kioskInReach } from './props/kiosk.js';

export function createSim(levels) {
  const sim = { levels, index: 0, world: null, player: null, tick: 0, cleared: false, dying: null };
  loadRoom(sim, 0);
  return sim;
}

export function loadRoom(sim, index) {
  sim.index = index;
  sim.world = createWorld(sim.levels[index]);
  sim.player = createPlayer(sim.levels[index].start);
  sim.tick = 0;
  sim.dying = null;
  // "Swapping: Off" (shown as "Kiosks only"): no timer; the swap input counts only at a kiosk (canSwapNow).
  sim.noSwap = sim.levels[index].noSwap === true;
  // "Swapping: Slider": the resolution slider (slider.js) takes the place of the swap; the room always starts at step 8.
  sim.slider = sim.levels[index].slider === true;
  // The resolution the room starts at (level.startStep, 8 unless the level says otherwise): a slider room is walked down to its
  // step, another room is swapped to low-res. Not the player's doing: it costs no swap and grows no cactus. (Where the change
  // would bury the start, it is refused and the room starts as far as it got.)
  const startStep = sim.levels[index].startStep ?? 8;
  if (sim.slider) { while (sim.world.slider.step > startStep && trySlide(sim.world, sim.player, 'down', true) === 'done'); }
  else if (startStep === 1) trySwap(sim.world, sim.player);
  // A timed level counts steps (whole numbers, so it never drifts) down to its next automatic swap.
  const every = sim.noSwap ? null : sim.levels[index].autoSwap;
  sim.swapLeft = every ? Math.round(every / STEP) : null;
  sim.swapBlocked = false;
  // "Swapping: Limited": a fixed number of player swaps from anywhere, full again whenever the room (re)loads. A swap made
  // while a kiosk is in reach is free. null on every other level.
  sim.swapLimit = sim.levels[index].swapLimit ?? null;
  sim.swapsLeft = sim.swapLimit;
  // Such a level has a counter at the top middle of the picture (the countdown, or the swaps left): a sign's text is shown
  // below it (props/sign.js).
  sim.world.counter = sim.swapLeft !== null || sim.swapLimit !== null;
  // The rolling wave (wave.js): the static zones (the level's windows) are kept, and the band's zone(s) are appended LAST,
  // so the wave wins over a window where they overlap. The wave's state lives here, so it restarts with the room.
  const wave = sim.levels[index].wave;
  sim.staticZones = sim.world.zones.map((z) => ({ ...z }));
  sim.wave = wave ? { cfg: wave, n: 0 } : null;
  if (wave) setZones(sim.world, zonesOf(sim));
}

// Every zone there is, in the order setZones wants (later ones win where they overlap): the level's windows, then the
// wave's band, then the grenades' areas (all low-res, so their order among themselves does not matter).
function zonesOf(sim) {
  const { world } = sim;
  const band = sim.wave ? waveZones(sim.wave.cfg, world.width, world.height, sim.wave.n) : [];
  return [...sim.staticZones, ...band, ...appliedGrenadeZones(world)];
}

// Move the wave on a column when it is time (one step decides: n columns after `tick` steps). Returns null when it did not
// move, else the Set of tile columns that changed mode (the ones it entered and the ones it left).
function advanceWave(sim) {
  const w = sim.wave;
  if (!w) return null;
  const n = waveSteps(w.cfg, sim.tick);
  if (n === w.n) return null;
  const { world } = sim;
  const before = waveColumns(w.cfg, world.width, w.n), after = waveColumns(w.cfg, world.width, n);
  w.n = n;
  const changed = new Set([...before].filter((c) => !after.has(c)).concat([...after].filter((c) => !before.has(c))));
  if (changed.size === 0) return null;
  setZones(world, zonesOf(sim));
  return changed;
}

// Seconds until the next automatic swap; null on a manual level.
export const countdownOf = (sim) => (sim.swapLeft === null ? null : sim.swapLeft * STEP);

// Would the player's swap input be accepted right now? Manual: always. Timed: never (the timer swaps). Off ("Kiosks
// only"): only while a kiosk is in reach. Limited: while swaps are left, or at a kiosk. Never during the death sequence
// or after the last room.
export function canSwapNow(sim) {
  if (sim.dying || sim.cleared || sim.swapLeft !== null || sim.slider) return false;
  if (sim.swapsLeft !== null) return sim.swapsLeft > 0 || kioskInReach(sim.world, sim.player) !== null;
  return !sim.noSwap || kioskInReach(sim.world, sim.player) !== null;
}

// ---- dying visibly ------------------------------------------------------------------------------------------------
// A death does not restart the room at once. The world stops (nothing moves, input is ignored except Restart, which
// skips straight to the restart) while the pages show the cause: for a crush the tiles that crushed the player flash
// for CRUSH_FLASH seconds; then, for every cause but falling out of the level, the player's sprite hops and falls off
// the bottom of the screen (DEATH_HOP seconds); falling out of the level only pauses (FELL_PAUSE seconds).
export const CRUSH_FLASH = 0.5, DEATH_HOP = 0.7, FELL_PAUSE = 0.4;
const secondsToSteps = (s) => Math.round(s / STEP);

// Begin the death sequence. `cause` is one of crush, spikes, bigspikes, laser, blade, fell (other prop types name
// themselves); `tiles` is the list of { x, y } tiles that crushed the player (crush only).
export function startDeath(sim, cause, tiles = []) {
  const flash = cause === 'crush' ? secondsToSteps(CRUSH_FLASH) : 0;
  const rest = cause === 'fell' ? secondsToSteps(FELL_PAUSE) : secondsToSteps(DEATH_HOP);
  sim.dying = { cause, tiles: tiles.map((t) => ({ x: t.x, y: t.y })), steps: 0, flashSteps: flash, totalSteps: flash + rest };
}

// What stepSim reports and the pages draw from: { cause, elapsed (s), tiles, flash (s of tile flashing), total (s) }.
export function dyingReport(sim) {
  const d = sim.dying;
  return d ? { cause: d.cause, elapsed: d.steps * STEP, tiles: d.tiles, flash: d.flashSteps * STEP, total: d.totalSteps * STEP } : null;
}

// Where the player's sprite is during the sequence, as a vertical offset in tiles from where they died (negative is
// up): still while the tiles flash, then a hop of about one tile and a fall off the bottom of the screen. null when
// the player is gone (fell out of the level).
const HOP_SPEED = 16, HOP_GRAVITY = 140;       // tiles/s and tiles/s^2: peak about 0.9 tile, off a screen in 0.7 s
export function deathOffset(dying) {
  if (!dying || dying.cause === 'fell') return null;
  const t = Math.max(0, dying.elapsed - dying.flash);
  return -HOP_SPEED * t + 0.5 * HOP_GRAVITY * t * t;
}

// Why the player dies right now, or null. (The crush, a later stage, starts its own death with the tiles.)
function deathCause(world, player) {
  if (fellOut(world, player)) return 'fell';
  if (touchesSpikes(world, player)) return 'spikes';
  if (touchesBigSpikes(world, player)) return 'bigspikes';
  return propsKiller(world, player);
}

export function stepSim(sim, held, pressed) {
  const out = { refused: false, blocked: false, restarted: false, advanced: false, countdown: null, swapsLeft: null, dying: null, canSwap: false, grenades: [] };
  if (pressed.restart) {
    if (sim.cleared) { sim.cleared = false; loadRoom(sim, 0); } else loadRoom(sim, sim.index);
    out.restarted = true;
    out.countdown = countdownOf(sim);
    out.swapsLeft = sim.swapsLeft;
    out.canSwap = canSwapNow(sim);
    return out;
  }
  out.countdown = countdownOf(sim);
  out.swapsLeft = sim.swapsLeft;
  if (sim.cleared) return out;

  if (sim.dying) {                                // the world is stopped; only the clock of the sequence runs
    sim.dying.steps++;
    if (sim.dying.steps >= sim.dying.totalSteps) {
      loadRoom(sim, sim.index);
      out.restarted = true;
      out.countdown = countdownOf(sim);
      out.swapsLeft = sim.swapsLeft;
      out.canSwap = canSwapNow(sim);
    } else out.dying = dyingReport(sim);
    return out;
  }

  const { world, player } = sim;
  // The wave moves first. If the player is now inside solid ground the room has crushed them: the world is left exactly
  // as it is, so the block that formed on them is what the pages show (the tiles flash, then they fall).
  let moved = advanceWave(sim);
  const gone = advanceGrenadeZones(world);       // a grenade's area appeared or ran out: the same kind of change
  if (gone) {
    setZones(world, zonesOf(sim));
    moved = moved ? new Set([...moved, ...gone]) : gone;
  }
  if (moved && playerBuried(world, player)) {
    let tiles = buriedTiles(world, player, moved);
    if (tiles.length === 0) tiles = buriedTiles(world, player);
    startDeath(sim, 'crush', tiles);
    out.dying = dyingReport(sim);
    out.canSwap = false;
    return out;
  }
  for (const z of world.blasts.splice(0)) pixelateThings(world, player, z);      // a "things" grenade's area came into force
  if (sim.slider) {                              // one notch per press: down toward 1, up toward 8; a notch that would bury something is refused
    if (pressed.resDown && trySlide(world, player, 'down') === 'refused') out.refused = true;
    if (pressed.resUp && trySlide(world, player, 'up') === 'refused') out.refused = true;
  }
  if (sim.swapLeft === null) {
    if (pressed.swap && canSwapNow(sim)) {
      const free = sim.swapsLeft === null || kioskInReach(world, player) !== null;   // a kiosk swap costs nothing
      if (!trySwap(world, player)) out.refused = true;
      else if (!free) sim.swapsLeft--;
    }
  } else {
    // Timed level: the player's swap input is ignored. At zero the room swaps, whatever it does to the player.
    if (sim.swapLeft > 0) sim.swapLeft--;
    if (sim.swapLeft === 0) {
      if (trySwap(world, player)) {
        sim.swapLeft = Math.round(sim.levels[sim.index].autoSwap / STEP);
        sim.swapBlocked = false;
      } else if (trySwap(world, null)) {
        // The swap would bury the player (or put a thing where they stand): the timer does not wait for them. The room swaps as
        // if they were not there and they are crushed: the tiles that formed on them flash, then they fall (as under the wave).
        sim.swapLeft = Math.round(sim.levels[sim.index].autoSwap / STEP);
        sim.swapBlocked = false;
        let tiles = buriedTiles(world, player);
        if (tiles.length === 0) tiles = [{ x: Math.floor(player.x + 0.5), y: Math.floor(player.y + 0.75) }];
        startDeath(sim, 'crush', tiles);
        out.dying = dyingReport(sim);
        out.countdown = countdownOf(sim);
        out.canSwap = false;
        return out;
      } else {
        // (Not the player's doing: a crate or a ball has no free place in the other mode. The swap waits for one.)
        out.blocked = true;
        if (!sim.swapBlocked) out.refused = true;
        sim.swapBlocked = true;
      }
    }
  }
  reconcileModes(world, player);     // a zone may have moved over something since the last step (zones.js)
  stepBalls(world, player, STEP);
  stepPlayer(world, player, held, STEP);
  stepCrates(world, player, STEP);
  stepLow(world, player, STEP);          // crates and balls in low-res: momentum on whole tiles
  updateDoors(world, player);
  stepProps(world, player, held, STEP);
  out.grenades = stepGrenades(world, STEP);
  if (pressed.throw && throwGrenade(world, player, held)) out.grenades.push({ type: 'throw' });

  sim.tick++;

  const cause = deathCause(world, player);
  if (cause) {
    startDeath(sim, cause);
    out.dying = dyingReport(sim);
  } else if (atExit(player, world.exit)) {
    if (sim.index + 1 < sim.levels.length) { loadRoom(sim, sim.index + 1); out.advanced = true; }
    else sim.cleared = true;
  }
  out.countdown = countdownOf(sim);
  out.swapsLeft = sim.swapsLeft;
  out.canSwap = canSwapNow(sim);          // for the next step: the player has moved, a kiosk may now be in reach
  return out;
}
