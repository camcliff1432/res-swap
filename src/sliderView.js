// The on-screen resolution slider, drawn and wired (the logic is sliderControl.js). One module for the game and the builder's
// test-play: each page gives it an empty element to fill and an `actions` (actions.js); the page positions the element.
//
//   const slider = attachSlider({ el, actions, doc, isBlocked })
//   slider.beforeStep()             before each stepSim: issues the notch the control wants, as a resDown / resUp action
//   slider.afterStep(sim, out)      after it: tells the control what became of that notch
//   slider.frame(sim, dt)           each drawn frame (dt in seconds): shows or hides the control, moves the handle
//   slider.cancel()                 a menu opened or the game stopped: let go of any finger
//   slider.detach()
import { STEPS } from './slider.js';
import { createSliderControl, posOfFraction, stepIndex, LAST } from './sliderControl.js';

const PAD = 26;                                    // px from the track's ends to the first and last stop (half a handle plus a margin)
const CSS = `
.res-slider { box-sizing: border-box; user-select: none; -webkit-user-select: none; touch-action: none; font: bold 16px monospace; color: #fff;
  background: rgba(255, 255, 255, 0.1); border: 2px solid rgba(255, 255, 255, 0.4); border-radius: 14px; }
.res-slider .rs-track { position: absolute; left: 46px; top: ${PAD}px; bottom: ${PAD}px; width: 6px; margin-left: -3px;
  background: rgba(255, 255, 255, 0.35); border-radius: 3px; }
.res-slider .rs-stop { position: absolute; left: 0; right: 0; height: 0; }
.res-slider .rs-tick { position: absolute; left: 34px; width: 24px; height: 2px; margin-top: -1px; background: rgba(255, 255, 255, 0.55); }
.res-slider .rs-num { position: absolute; left: 4px; width: 22px; margin-top: -9px; text-align: center; line-height: 18px; opacity: 0.6; }
.res-slider .rs-stop.on .rs-num { opacity: 1; }
.res-slider .rs-handle { position: absolute; left: 22px; width: 48px; height: 44px; margin-top: -22px; box-sizing: border-box;
  background: rgba(255, 255, 255, 0.85); border: 2px solid #fff; border-radius: 10px; box-shadow: 0 2px 0 rgba(0, 0, 0, 0.5); }
.res-slider .rs-handle::before, .res-slider .rs-handle::after { content: ""; position: absolute; left: 10px; right: 10px; height: 2px; background: rgba(0, 0, 0, 0.55); }
.res-slider .rs-handle::before { top: 15px; }
.res-slider .rs-handle::after { top: 25px; }
.res-slider.nope .rs-handle { background: #f44; border-color: #f88; }
`;

export function attachSlider({ el, actions, doc = document, isBlocked = () => false }) {
  if (!doc.getElementById('res-slider-css')) {
    const style = doc.createElement('style');
    style.id = 'res-slider-css';
    style.textContent = CSS;
    doc.head.appendChild(style);
  }
  el.classList.add('res-slider');
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', 'Resolution');
  el.setAttribute('aria-orientation', 'vertical');
  el.innerHTML = '<div class="rs-track"></div>';
  const stops = STEPS.map((step, i) => {
    const s = doc.createElement('div');
    s.className = 'rs-stop';
    s.style.top = `calc(${PAD}px + (100% - ${2 * PAD}px) * ${i / LAST})`;
    s.innerHTML = `<div class="rs-tick"></div><div class="rs-num">${step}</div>`;
    el.appendChild(s);
    return s;
  });
  const handle = doc.createElement('div');
  handle.className = 'rs-handle';
  el.appendChild(handle);

  const ctrl = createSliderControl();
  let pointer = null, seen = 0, nopeTimer = 0, shown = false;

  // A pointer's place in stop units, from the element's own box (the track runs PAD in from each end).
  const posOf = (e) => {
    const r = el.getBoundingClientRect();
    const span = r.height - 2 * PAD;
    return posOfFraction(span > 0 ? (e.clientY - r.top - PAD) / span : 0);
  };
  el.addEventListener('pointerdown', (e) => {
    e.stopPropagation();                              // not a click on the picture (input.js: a mouse click swaps)
    e.preventDefault();
    if (pointer !== null || isBlocked() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pointer = e.pointerId;
    try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    ctrl.press(posOf(e));
  });
  el.addEventListener('pointermove', (e) => { if (e.pointerId === pointer) ctrl.move(posOf(e)); });
  const lift = (cancel) => (e) => {
    if (e.pointerId !== pointer) return;
    pointer = null;
    if (cancel) ctrl.cancel(); else ctrl.release();
  };
  el.addEventListener('pointerup', lift(false));
  el.addEventListener('pointercancel', lift(true));
  el.addEventListener('lostpointercapture', lift(true));

  function cancel() { pointer = null; ctrl.cancel(); }

  function beforeStep() {
    const d = ctrl.notch();
    if (!d) return null;
    const name = d === 'down' ? 'resDown' : 'resUp';
    actions.press(name, 'slider');                    // the one-shot action queue, as the keys and the old buttons used
    actions.release(name, 'slider');
    return d;
  }
  function afterStep(sim, out) {
    if (sim.slider) ctrl.settle(sim.world.slider.step, { refused: !!out.refused });
  }

  function frame(sim, dt = 0) {
    const on = sim.slider && !isBlocked();
    if (on !== shown) {
      shown = on;
      el.style.display = on ? '' : 'none';
      if (!on) cancel();
      else ctrl.reset(sim.world.slider.step);
    }
    if (!on) return;
    ctrl.frame(dt, sim.world.slider.step);
    handle.style.top = `calc(${PAD}px + (100% - ${2 * PAD}px) * ${ctrl.pos / LAST})`;
    const real = stepIndex(sim.world.slider.step);
    stops.forEach((s, i) => s.classList.toggle('on', i === real));
    el.setAttribute('aria-valuenow', String(sim.world.slider.step));
    if (ctrl.refusedCount !== seen) {                // a refusal: the handle flashes red for a moment
      seen = ctrl.refusedCount;
      el.classList.add('nope');
      clearTimeout(nopeTimer);
      nopeTimer = setTimeout(() => el.classList.remove('nope'), 260);
    }
  }

  function detach() { cancel(); clearTimeout(nopeTimer); el.style.display = 'none'; el.innerHTML = ''; }
  return { beforeStep, afterStep, frame, cancel, detach, control: ctrl };
}
