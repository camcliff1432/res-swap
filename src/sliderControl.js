// The logic of the on-screen resolution slider (the control that replaced the RES + / RES - buttons). No DOM here: sliderView.js
// draws it and feeds it pointer positions; the game loop asks it, once per sim step, whether to issue a notch.
//
// A position is in STOP UNITS: 0 is the top stop (step 8), 3 the bottom one (step 1); the four stops are evenly spaced.
// This is a control that issues notches, not a rule: the sim still moves one notch per press (slider.js trySlide) and may refuse
// it. The handle's resting place is always the step the game REALLY is on, so after any refusal, key press, restart, death or
// level jump it settles on `real`, whatever the finger did.
//
//   createSliderControl() -> c
//   c.pos                     the handle's place, 0..3 (follows the finger while dragging, else eases toward the real stop)
//   c.press(pos)              a pointer went down at `pos`: on the handle it grabs it (drag), elsewhere it is a tap on a stop
//   c.move(pos)               the pointer moved (a drag only)
//   c.release() / c.cancel()  the pointer lifted / was cancelled (cancel also drops any notches still to come)
//   c.notch()                 once per sim step, before it: 'down' | 'up' | null = the notch to issue now (at most one)
//   c.settle(step, {issued, refused})  once per sim step, after it, with the step the game is on now and what became of the notch
//   c.frame(dt, step)         once per drawn frame: sync with the game's step and ease the handle (dt in seconds)
import { STEPS } from './slider.js';

export const LAST = STEPS.length - 1;                          // index of the last stop (3)
export const GRAB = 0.45;                                      // a press this close to the handle (stop units) grabs it
export const stepIndex = (step) => STEPS.indexOf(step);
export const clampPos = (pos) => Math.max(0, Math.min(LAST, pos));
export const nearestStop = (pos) => Math.round(clampPos(pos));
// A pointer's place along a track as a fraction (0 top .. 1 bottom) -> stop units.
export const posOfFraction = (f) => clampPos(f * LAST);
export const EASE = 18;                                        // how fast the handle settles (per second)

export function createSliderControl() {
  const c = {
    pos: 0,                                // the handle, in stop units
    real: 0,                               // the stop of the step the game is on (index into STEPS)
    drag: null,                            // { offset, locked } while a finger holds the handle
    target: null,                          // the stop the finger or a tap is asking for (null: nothing wanted)
    blocked: null,                         // 'down' | 'up': a notch that way was refused and the target has not changed since
    dragging: false,
    refusedCount: 0,                       // how many refusals this control has seen (the view flashes on a change)
  };
  const dir = () => (c.target === null || c.target === c.real ? null : c.target > c.real ? 'down' : 'up');
  let pending = null;                      // the notch handed out by notch() that settle() has not yet resolved

  function setTarget(t) {
    if (t !== c.target) c.blocked = null;  // the finger moved to a new stop: a refused way may be tried again
    c.target = t;
  }

  c.press = (pos) => {
    pos = clampPos(pos);
    if (Math.abs(pos - c.pos) <= GRAB) {   // the handle: drag it, keeping the grab point under the finger
      c.drag = { offset: c.pos - pos, locked: false };
      c.dragging = true;
      c.blocked = null;
      setTarget(nearestStop(c.pos));
    } else {                               // a stop: walk there one notch at a time (the handle follows the real step)
      c.drag = null; c.dragging = false;
      c.blocked = null;
      c.target = nearestStop(pos);
    }
  };

  c.move = (pos) => {
    if (!c.drag) return;
    c.pos = clampPos(pos + c.drag.offset);
    if (!c.drag.locked) setTarget(nearestStop(c.pos));
  };

  // Let go: a notch the finger already passed is still carried out (at most a couple, one per step); a refused way is dropped.
  c.release = () => {
    c.drag = null; c.dragging = false;
    if (c.blocked !== null && dir() === c.blocked) c.target = null;
  };
  c.cancel = () => {
    c.drag = null; c.dragging = false; c.target = null; c.blocked = null;
  };

  c.notch = () => {
    const d = dir();
    if (d === null || d === c.blocked || (c.drag && c.drag.locked)) return null;
    pending = d;
    return d;
  };

  // The game's step is `step` now. A change nobody here asked for (key, restart, death, level jump) drops the walk, and a
  // drag stops issuing notches until the finger is lifted and put down again.
  c.settle = (step, { issued = pending, refused = false } = {}) => {
    pending = null;
    const idx = stepIndex(step);
    if (idx < 0) return;
    const was = c.real;
    c.real = idx;
    if (issued && (refused || idx === was)) {            // refused: no more notches that way until the target changes
      c.blocked = issued;
      c.refusedCount++;
      if (!c.drag) c.target = null;                      // a tap's walk stops at the refusal
      return;
    }
    if (idx === was + (issued ? (issued === 'down' ? 1 : -1) : 0)) {   // what was asked for (or nothing changed)
      if (!c.drag && c.target === idx) c.target = null;
      return;
    }
    c.blocked = null;                                    // moved some other way
    if (c.drag) c.drag.locked = true;
    c.target = null;
  };

  c.frame = (dt, step) => {
    c.settle(step, { issued: null });                    // an outside change between steps (a paused game, a menu jump)
    if (c.drag) return;
    const k = 1 - Math.exp(-EASE * Math.max(0, dt));
    c.pos += (c.real - c.pos) * k;
    if (Math.abs(c.real - c.pos) < 0.004) c.pos = c.real;
  };

  c.reset = (step) => {                                // a new room: no memory of any gesture, the handle on the step
    c.drag = null; c.dragging = false; c.target = null; c.blocked = null; pending = null;
    const idx = stepIndex(step);
    if (idx >= 0) { c.real = idx; c.pos = idx; }
  };
  return c;
}
