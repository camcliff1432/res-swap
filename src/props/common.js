// Small helpers shared by the prop definitions. No DOM.
import { PX8 } from '../constants.js';

export const EPS = 0.001;
export const px = (v) => Math.round(v * PX8);          // tiles -> level pixels
export const LENGTH_MIN = 1, LENGTH_MAX = 144;

export const lengthField = { key: 'length', label: 'Length', kind: 'int', min: LENGTH_MIN, max: LENGTH_MAX };
export const validLength = (n) => Number.isInteger(n) && n >= LENGTH_MIN && n <= LENGTH_MAX;
// null when the length is fine, else the problem text.
export const checkLength = (o) => (validLength(o.length) ? null : `length must be a whole number from ${LENGTH_MIN} to ${LENGTH_MAX}`);
// A tall one-tile-wide box whose length may be bad: fall back to `fallback` tiles.
export const columnSize = (o, fallback) => [1, validLength(o.length) ? o.length : fallback];

export function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Pieces that share a column and touch or overlap vertically act as one tall piece. `pieces` are
// one-tile-wide boxes; returns the merged runs { x, y (top), w: 1, h }, left to right then top down.
export function stackRuns(pieces) {
  const sorted = [...pieces].sort((a, b) => a.x - b.x || a.y - b.y);
  const runs = [];
  for (const p of sorted) {
    const last = runs[runs.length - 1];
    if (last && last.x === p.x && p.y <= last.y + last.h + EPS) last.h = Math.max(last.h, p.y + p.h - last.y);
    else runs.push({ x: p.x, y: p.y, w: 1, h: p.h });
  }
  return runs;
}

// True when another of `pieces` (same column) touches the bottom edge of `inst`, continuing below it.
export function hasPieceBelow(pieces, inst) {
  const bottom = inst.y + inst.h;
  return pieces.some((q) => q !== inst && q.x === inst.x && q.y <= bottom + EPS && q.y + q.h > bottom + EPS);
}

// The optional resolution step of an area (a window, a grenade's area; the wave has its own, wave.js): stage 4 of the slider.
// Absent: the area is what it always was. The builder shows it as a choice (editor/panels.js, kind 'step').
export const STEPS = [8, 4, 2, 1];
// `none` names the choice of no step (the builder's first option).
export const stepField = (none) => ({ key: 'step', label: 'Resolution step', kind: 'step', options: STEPS, none });
export const STEP_FIELD = stepField('As today');
export const checkStep = (step) => (step === undefined || STEPS.includes(step) ? null : 'step must be 8, 4, 2 or 1 (or left out)');
