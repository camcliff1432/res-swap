// The touch d-pad: a cross of four arrows at the bottom left of its zone, always shown. A finger on it holds the direction it is
// over (left / right / up / down), two at once on a diagonal, and may slide from one arrow to the next without lifting. Once
// down, the finger still counts when it slides off the pad.
export const PAD = 144;        // px across: three cells of 48
export const REACH = 24;       // px round the pad where a finger still lands on it
export const DEAD = 12;        // px from the middle before anything is held
export const LEAN = 0.5;       // a direction is held while the finger is at least this far along it, as a share of the other axis
const CELL = PAD / 3;
const NAMES = ['left', 'right', 'up', 'down'];

// What a finger at (dx, dy) px from the pad's middle holds.
export function dpadState(dx, dy) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  const h = ax > DEAD && ax >= ay * LEAN, v = ay > DEAD && ay >= ax * LEAN;
  return { left: h && dx < 0, right: h && dx > 0, up: v && dy < 0, down: v && dy > 0 };
}

export function attachDpad(zone, actions, { signal } = {}) {
  const doc = zone.ownerDocument;
  const pad = doc.createElement('div');
  pad.style.cssText = `position:absolute;left:calc(12px + env(safe-area-inset-left, 0px));bottom:calc(12px + env(safe-area-inset-bottom, 0px));width:${PAD}px;height:${PAD}px;pointer-events:none;`;
  const OFF = 'rgba(255,255,255,0.18)', ON = 'rgba(255,255,255,0.5)';
  const arms = {};
  const arm = (name, col, row, glyph, radius) => {
    const d = doc.createElement('div');
    d.textContent = glyph;
    d.style.cssText = `position:absolute;left:${col * CELL}px;top:${row * CELL}px;width:${CELL}px;height:${CELL}px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;`
      + `background:${OFF};border:2px solid rgba(255,255,255,0.4);border-radius:${radius};color:#fff;font:bold 18px monospace;user-select:none;-webkit-user-select:none;`;
    pad.appendChild(d);
    if (name) arms[name] = d;
    return d;
  };
  arm('up', 1, 0, '▲', '12px 12px 0 0').style.borderBottom = 'none';
  arm('left', 0, 1, '◀', '12px 0 0 12px').style.borderRight = 'none';
  arm('right', 2, 1, '▶', '0 12px 12px 0').style.borderLeft = 'none';
  arm('down', 1, 2, '▼', '0 0 12px 12px').style.borderTop = 'none';
  arm(null, 1, 1, '', '0').style.border = 'none';
  zone.appendChild(pad);

  let id = null;
  const from = (e) => { const r = pad.getBoundingClientRect(); return [e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)]; };

  function apply(s) {
    for (const n of NAMES) {
      if (s[n]) actions.press(n, 'stick'); else actions.release(n, 'stick');
      arms[n].style.background = s[n] ? ON : OFF;
    }
  }
  function end() { id = null; apply({ left: false, right: false, up: false, down: false }); }

  function down(e) {
    if (id !== null || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) return;
    const [dx, dy] = from(e);
    if (Math.abs(dx) > PAD / 2 + REACH || Math.abs(dy) > PAD / 2 + REACH) return;   // not on the pad
    e.preventDefault();
    id = e.pointerId;
    try { zone.setPointerCapture(id); } catch { /* pointer already gone */ }
    apply(dpadState(dx, dy));
  }
  function move(e) { if (e.pointerId === id) apply(dpadState(...from(e))); }
  function up(e) { if (e.pointerId === id) end(); }

  const opts = signal ? { signal } : undefined;
  zone.addEventListener('pointerdown', down, opts);
  zone.addEventListener('pointermove', move, opts);
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) zone.addEventListener(t, up, opts);

  function detach() {
    zone.removeEventListener('pointerdown', down);
    zone.removeEventListener('pointermove', move);
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) zone.removeEventListener(t, up);
    end();
    pad.remove();
  }
  signal?.addEventListener('abort', detach, { once: true });
  return detach;
}
