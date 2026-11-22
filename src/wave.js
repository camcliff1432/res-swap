// The wave: a band of low-res, the full height of the level, that travels sideways a whole column at a time. Pure rules
// and no state: the level field (`wave: { width, dir, speed, edge }`), where the band is after n columns, and the zones
// it makes (zones.js). The sim (sim.js) keeps the count and hands the zones to setZones. Imports only constants.
import { STEP } from './constants.js';
import { STEPS, withStep } from './zones.js';

export const WAVE_MIN_WIDTH = 1, WAVE_MAX_WIDTH = 16;
export const WAVE_MIN_SPEED = 0.5, WAVE_MAX_SPEED = 8;
export const WAVE_DIRS = ['left', 'right'];
export const WAVE_EDGES = ['wrap', 'bounce'];
export const WAVE_DEFAULTS = { width: 4, dir: 'right', speed: 1, edge: 'wrap' };
const KEYS = ['width', 'dir', 'speed', 'edge', 'step'];   // step: optional (stage 4 of the slider), the band's resolution step

// null when `w` is a usable wave setting, else the sentence the level parser reports.
export function checkWave(w) {
  if (w === null || typeof w !== 'object' || Array.isArray(w)) return 'wave must be an object with width, dir, speed and edge';
  for (const k of Object.keys(w)) if (!KEYS.includes(k)) return `wave has an unknown setting "${k}"`;
  if (!Number.isInteger(w.width) || w.width < WAVE_MIN_WIDTH || w.width > WAVE_MAX_WIDTH) return `wave width must be a whole number from ${WAVE_MIN_WIDTH} to ${WAVE_MAX_WIDTH}`;
  if (!WAVE_DIRS.includes(w.dir)) return 'wave dir must be left or right';
  if (typeof w.speed !== 'number' || !Number.isFinite(w.speed) || w.speed < WAVE_MIN_SPEED || w.speed > WAVE_MAX_SPEED || !Number.isInteger(w.speed * 2)) {
    return `wave speed must be a number from ${WAVE_MIN_SPEED} to ${WAVE_MAX_SPEED} in steps of 0.5`;
  }
  if (!WAVE_EDGES.includes(w.edge)) return 'wave edge must be wrap or bounce';
  if (w.step !== undefined && !STEPS.includes(w.step)) return 'wave step must be 8, 4, 2 or 1 (or left out)';
  return null;
}

// How many columns the band has advanced after `tick` sim steps (whole numbers only, so it never drifts).
const STEPS_PER_TWO_SECONDS = Math.round(2 / STEP);   // (speed * 2 is a whole number)
export const waveSteps = (wave, tick) => Math.floor((tick * Math.round(wave.speed * 2)) / STEPS_PER_TWO_SECONDS);

// The band's width in this level and its left column after n advances. It starts with its trailing edge at the side it
// moves away from. `wrap` runs on round the level; `bounce` turns at each side.
export const waveWidthIn = (wave, levelW) => Math.min(wave.width, levelW);
export function waveLeft(wave, levelW, n) {
  const w = waveWidthIn(wave, levelW), right = wave.dir === 'right';
  if (wave.edge === 'wrap') return right ? n % levelW : (((levelW - w - n) % levelW) + levelW) % levelW;
  const span = levelW - w;
  if (span === 0) return 0;
  const m = n % (2 * span), tri = m <= span ? m : 2 * span - m;
  return right ? tri : span - tri;
}

// The columns (a Set of tile numbers) the band covers after n advances.
export function waveColumns(wave, levelW, n) {
  const w = waveWidthIn(wave, levelW), left = waveLeft(wave, levelW, n), cols = new Set();
  for (let i = 0; i < w; i++) cols.add((left + i) % levelW);
  return cols;
}

// The zones of the band: one, or two while it crosses the edge in wrap mode. `lineL` / `lineR` mark the real edges of the
// band (the compositor draws a bright line there; the cut at the level's own edge gets none).
export function waveZones(wave, levelW, levelH, n) {
  const w = waveWidthIn(wave, levelW), left = waveLeft(wave, levelW, n);
  // A band with a step (stage 4 of the slider) is at that step instead of low-res (zones.js withStep).
  const make = (x, width, lineL, lineR) => {
    const z = { x, y: 0, w: width, h: levelH, mode: 'low', kind: 'wave', lineL, lineR };
    return wave.step === undefined ? z : withStep(z, wave.step);
  };
  if (left + w <= levelW) return [make(left, w, true, true)];
  const first = levelW - left;
  return [make(left, first, true, false), make(0, w - first, false, true)];
}
