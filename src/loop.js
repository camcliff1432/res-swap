import { STEP, MAX_STEPS_PER_FRAME } from './constants.js';

const STEP_MS = STEP * 1000;
const EPSILON = 1e-6;

export function createStepper() {
  let acc = 0;
  return function steps(elapsedMs) {
    acc += elapsedMs;
    const n = Math.floor((acc + EPSILON) / STEP_MS);
    if (n > MAX_STEPS_PER_FRAME) {
      acc = 0;
      return MAX_STEPS_PER_FRAME;
    }
    acc = Math.max(0, acc - n * STEP_MS);
    return n;
  };
}
