import { attachDpad } from './dpad.js';

const KEYS = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Space: 'jump',
  ArrowUp: 'up', KeyW: 'up',                    // up only climbs (ladders, ropes, chains); it does not jump
  ShiftLeft: 'swap', ShiftRight: 'swap', KeyX: 'swap', KeyE: 'swap',
  ArrowDown: 'down', KeyS: 'down',
  KeyR: 'restart',
  KeyG: 'throw', KeyF: 'throw',
  KeyZ: 'resDown', KeyC: 'resUp',               // the resolution slider (slider levels only: other levels never read them)
};

export function attachInput(actions, root) {
  const win = root.defaultView;

  root.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const name = KEYS[e.code];
    if (!name) return;
    e.preventDefault();
    if (!e.repeat) actions.press(name, `key:${e.code}`);
  });
  root.addEventListener('keyup', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const name = KEYS[e.code];
    if (!name) return;
    e.preventDefault();
    actions.release(name, `key:${e.code}`);
  });

  for (const el of root.querySelectorAll('[data-action]')) {
    const name = el.dataset.action;
    const source = (e) => `touch${e.pointerId}`;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      actions.press(name, source(e));
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      el.addEventListener(type, (e) => actions.release(name, source(e)));
    }
  }

  // A left mouse click anywhere that is not a control also swaps (mouse only, so a touch on the picture does nothing).
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    if (e.target.closest && e.target.closest('button, a, input, select, textarea')) return;
    actions.press('swap', 'mouse');
  });
  for (const type of ['pointerup', 'pointercancel']) root.addEventListener(type, (e) => { if (e.pointerType === 'mouse') actions.release('swap', 'mouse'); });

  const stickZone = root.getElementById ? root.getElementById('stick-zone') : null;
  if (stickZone) attachDpad(stickZone, actions);

  win.addEventListener('blur', () => actions.releaseAll());
  root.addEventListener('visibilitychange', () => {
    if (root.visibilityState === 'hidden') actions.releaseAll();
  });
}
