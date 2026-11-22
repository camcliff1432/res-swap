const HELD = ['left', 'right', 'jump', 'down', 'up'];
const ONE_SHOT = ['swap', 'restart', 'throw', 'resDown', 'resUp'];

export function createActions() {
  const held = { left: false, right: false, jump: false, down: false, up: false };
  const sources = {};
  for (const name of [...HELD, ...ONE_SHOT]) sources[name] = new Set();
  const queued = { swap: 0, restart: 0, throw: 0, resDown: 0, resUp: 0 };

  function press(name, source) {
    const set = sources[name];
    if (!set) return;
    const fresh = !set.has(source);
    set.add(source);
    if (name in held) held[name] = true;
    else if (fresh) queued[name]++;
  }

  function release(name, source) {
    const set = sources[name];
    if (!set) return;
    set.delete(source);
    if (name in held) held[name] = set.size > 0;
  }

  function releaseAll() {
    for (const name of Object.keys(sources)) sources[name].clear();
    for (const name of HELD) held[name] = false;
    for (const name of ONE_SHOT) queued[name] = 0;
  }

  function take(name) {
    if (!queued[name]) return false;
    queued[name]--;
    return true;
  }

  return { held, press, release, releaseAll, take };
}
