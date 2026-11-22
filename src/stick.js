// Floating touch stick: the first finger down in the zone is the stick's origin; how far the finger
// has moved from it holds left / right / up / down. Nothing is drawn until a finger is down.
export const DEAD_X = 12;      // px of sideways drag before left/right engages
export const DEAD_Y = 24;      // px of vertical drag before up/down engages (so a wobbly sideways drag does not climb or drop)
export const RING_R = 48;      // ring radius: 96 px across
export const FOLLOW_R = 56;    // beyond this distance the origin follows the finger
const NAMES = ['left', 'right', 'up', 'down'];

export function stickState(dx, dy, { deadX = DEAD_X, deadY = DEAD_Y } = {}) {
  return { left: dx < -deadX, right: dx > deadX, up: dy < -deadY, down: dy > deadY };
}

export function attachStick(zone, actions, { signal } = {}) {
  const doc = zone.ownerDocument;
  const mk = (css) => {
    const d = doc.createElement('div');
    d.style.cssText = `position:absolute;display:none;pointer-events:none;box-sizing:border-box;border-radius:50%;${css}`;
    zone.appendChild(d);
    return d;
  };
  const ring = mk(`width:${RING_R * 2}px;height:${RING_R * 2}px;border:2px solid rgba(255,255,255,0.3);background:rgba(255,255,255,0.07);`);
  const knob = mk('width:44px;height:44px;background:rgba(255,255,255,0.35);border:2px solid rgba(255,255,255,0.5);');

  let id = null, ox = 0, oy = 0;
  const local = (e) => { const r = zone.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const place = (el, x, y, half) => { el.style.left = `${x - half}px`; el.style.top = `${y - half}px`; };

  function apply(s) { for (const n of NAMES) { if (s[n]) actions.press(n, 'stick'); else actions.release(n, 'stick'); } }
  function end() {
    id = null;
    apply({ left: false, right: false, up: false, down: false });
    ring.style.display = knob.style.display = 'none';
  }
  function draw(x, y) {
    const dx = x - ox, dy = y - oy, d = Math.hypot(dx, dy) || 1, k = Math.min(d, RING_R) / d;
    place(ring, ox, oy, RING_R);
    place(knob, ox + dx * k, oy + dy * k, 22);
  }

  function down(e) {
    if (id !== null || (e.pointerType !== 'touch' && e.pointerType !== 'pen')) return;
    e.preventDefault();
    id = e.pointerId;
    [ox, oy] = local(e);
    try { zone.setPointerCapture(id); } catch { /* pointer already gone */ }
    ring.style.display = knob.style.display = 'block';
    draw(ox, oy);
    apply(stickState(0, 0));
  }
  function move(e) {
    if (e.pointerId !== id) return;
    const [x, y] = local(e);
    const dx = x - ox, dy = y - oy, d = Math.hypot(dx, dy);
    if (d > FOLLOW_R) { ox += dx * (d - FOLLOW_R) / d; oy += dy * (d - FOLLOW_R) / d; }
    draw(x, y);
    apply(stickState(x - ox, y - oy));
  }
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
    ring.remove(); knob.remove();
  }
  signal?.addEventListener('abort', detach, { once: true });
  return detach;
}
