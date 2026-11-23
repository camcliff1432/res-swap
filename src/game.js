import { STEP } from './constants.js';
import { parseLevel } from './level.js';
import { createSim, stepSim, countdownOf, canSwapNow, CRUSH_FLASH } from './sim.js';
import { createActions } from './actions.js';
import { createStepper } from './loop.js';
import { attachInput } from './input.js';
import { render, dyingView } from './render.js';
import { cameraFor } from './camera.js';
import { stepLabel } from './slider.js';
import { attachSlider } from './sliderView.js';
import { createLook } from './sliderLook.js';
import { menuRows, jumpToRoom, folderIntro, gameIndex } from './menu.js';
import { createMenu } from './menuView.js';

const view = document.getElementById('view');
const picture = document.getElementById('picture');
const modeLabel = document.getElementById('mode');
const barEl = document.getElementById('bar');
const barFill = barEl.firstElementChild;
const timerEl = document.getElementById('timer');
const timerN = document.getElementById('timer-n'), timerWord = document.getElementById('timer-word'), timerFill = document.querySelector('#timer-bar i');
const swapsEl = document.getElementById('swaps');
const swapsN = document.getElementById('swaps-n'), swapsPips = document.getElementById('swaps-pips'), swapsWord = document.getElementById('swaps-word');
const MAX_PIPS = 12;                             // a level with more swaps than this shows the number only

// The limited-swaps counter: redrawn only when the count changes; it jumps when a swap has just been spent.
let swapsShown = null;
function showSwaps(left, limit) {
  const key = left === null ? null : `${left}/${limit}`;
  if (key === swapsShown) return;
  const spent = swapsShown !== null && key !== null && Number(swapsShown.split('/')[1]) === limit && left < Number(swapsShown.split('/')[0]);
  swapsShown = key;
  swapsEl.style.display = left === null ? 'none' : 'flex';
  if (left === null) return;
  swapsN.textContent = String(left);
  swapsWord.textContent = left === 0 ? 'NO SWAPS LEFT' : left === 1 ? 'SWAP LEFT' : 'SWAPS LEFT';
  swapsPips.textContent = '';
  if (limit <= MAX_PIPS) for (let i = 0; i < limit; i++) { const pip = document.createElement('i'); if (i >= left) pip.className = 'used'; swapsPips.appendChild(pip); }
  swapsEl.classList.toggle('empty', left === 0);
  swapsEl.classList.remove('pop');
  if (spent) { void swapsEl.offsetWidth; swapsEl.classList.add('pop'); }   // (reading the width restarts the animation)
}
const swapButton = document.getElementById('btn-swap');
const throwButton = document.getElementById('btn-throw');
const flashEl = document.getElementById('flash');
const message = document.getElementById('message');
const ctx = view.getContext('2d');

function showMessage(text) {
  picture.style.display = 'none';
  message.style.display = 'block';
  message.textContent = text;
  for (const el of document.querySelectorAll('.touch, #btn-menu, #slider')) el.style.display = 'none';
}

async function fetchJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`could not load ${path} (HTTP ${res.status})`);
  try { return await res.json(); } catch { throw new Error(`${path} is not valid JSON`); }
}

// levels/index.json lists the level ids in play order; each is levels/<id>.json. Returns the index too (the menu groups by its tree).
async function loadLevels() {
  const index = gameIndex(await fetchJson('levels/index.json'));   // (without the folders kept out of the game)
  if (!index || !Array.isArray(index.levels) || index.levels.length === 0) throw new Error('levels/index.json has no levels');
  const levels = [];
  for (const id of index.levels) levels.push(parseLevel(await fetchJson(`levels/${id}.json`), id));
  return { index, levels };
}

let audio = null;
function beep() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = 110;
    gain.gain.value = 0.08;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.09);
  } catch { /* audio unavailable */ }
}

// A short, quiet, high tick for the last three seconds of a countdown.
function tick() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.value = 0.03;
    osc.connect(gain).connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.04);
  } catch { /* audio unavailable */ }
}

// A short low "pop" when a grenade goes off.
function pop() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    gain.gain.setValueAtTime(0.07, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.14);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.15);
  } catch { /* audio unavailable */ }
}

// The falling tone of a death: a square wave sliding down, after `delay` seconds (a crush shows the tiles first).
function fallTone(delay = 0) {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
    const t = audio.currentTime + delay;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(520, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.55);
    gain.gain.setValueAtTime(0.06, t);
    gain.gain.linearRampToValueAtTime(0, t + 0.6);
    osc.connect(gain).connect(audio.destination);
    osc.start(t);
    osc.stop(t + 0.62);
  } catch { /* audio unavailable */ }
}

const LABELS = { '8bit': '8-BIT', low: 'LOW-RES' };

async function main() {
  let levels, index;
  try {
    ({ index, levels } = await loadLevels());
  } catch (err) {
    showMessage(err.message);
    return;
  }

  const actions = createActions();
  attachInput(actions, document);
  const stepper = createStepper();
  // The resolution slider (sliderView.js): on slider levels only, and not operable behind the level menu.
  const slider = attachSlider({ el: document.getElementById('slider'), actions, doc: document, isBlocked: () => menu.isOpen() });
  const sim = createSim(levels);
  const look = createLook();                      // how far the slider's picture has eased (sliderLook.js)
  let flash = 0, blocked = false, tickSecond = null, canSwap = !sim.slider;

  // The level menu: while it is open the game does not step (frame skips the stepper), and held inputs are let go.
  const menu = createMenu({
    doc: document, rows: menuRows(index, levels), getRoom: () => sim.index,
    onOpen: () => { actions.releaseAll(); slider.cancel(); },
    onClose: () => actions.releaseAll(),
    onPick: (room) => {
      jumpToRoom(sim, room);
      blocked = false; tickSecond = null; flash = 0;
      canSwap = canSwapNow(sim);
    },
  });

  // The story screens: before the first level of a folder that has a story text (levels/index.json: the folder's `intro`), the
  // game stops behind a screen with that text until a key or a tap. Shown whenever the room changes to such a level (the start
  // of the game, finishing the level before it, picking it in the menu), not when the room restarts.
  const storyEl = document.getElementById('story'), storyText = document.getElementById('story-text');
  let storyOpen = false, storyAt = 0, storyRoom = -1;
  // The text is made smaller, a pixel at a time, until the screen holds all of it and the "tap to continue" line (a phone held
  // sideways in a browser has little height). Done again when the screen changes size or is turned.
  const fitStory = () => {
    if (storyEl.style.display !== 'flex') return;
    storyText.style.fontSize = '';
    let size = parseFloat(getComputedStyle(storyText).fontSize);
    while (size > 8 && storyEl.scrollHeight > storyEl.clientHeight) storyText.style.fontSize = `${--size}px`;
  };
  window.addEventListener('resize', fitStory);
  const openStory = (room) => {
    const text = folderIntro(index, room);
    if (!text) return;
    storyText.textContent = text;
    storyEl.style.display = 'flex';
    storyOpen = true; storyAt = performance.now();
    fitStory();
    actions.releaseAll(); slider.cancel();
  };
  const closeStory = () => {
    if (!storyOpen || performance.now() - storyAt < 500) return;      // (a key still held from the level before does not skip it)
    storyOpen = false;
    storyEl.style.display = 'none';
    actions.releaseAll();
  };
  document.addEventListener('keydown', (e) => { if (storyOpen) { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) closeStory(); } }, true);
  for (const type of ['pointerdown', 'touchstart']) storyEl.addEventListener(type, (e) => { e.preventDefault(); e.stopPropagation(); closeStory(); });

  function present() {
    const view = dyingView(sim);
    render(ctx, sim.world, view.player, cameraFor(sim.world, sim.player), { ...view.opts, look });
    const left = countdownOf(sim);
    const timed = left !== null;
    const swaps = sim.swapsLeft;                                           // null unless the level is "Limited"
    modeLabel.textContent = sim.slider ? stepLabel(sim.world) : LABELS[sim.world.mode];
    // Timed swaps: the counter at the top middle (index.html #timer): seconds left, what comes next, a bar that empties.
    timerEl.style.display = timed ? 'flex' : 'none';
    if (timed) {
      const n = blocked ? '!' : String(Math.ceil(left));
      if (timerN.textContent !== n) timerN.textContent = n;
      const word = blocked ? 'SWAP HELD BACK' : `TO ${LABELS[sim.world.mode === 'low' ? '8bit' : 'low']}`;
      if (timerWord.textContent !== word) timerWord.textContent = word;
      timerFill.style.transform = `scaleX(${Math.max(0, Math.min(1, left / sim.levels[sim.index].autoSwap))})`;
      timerEl.classList.toggle('soon', !blocked && left <= 1);
      timerEl.classList.toggle('wait', blocked);
    }
    showSwaps(swaps, sim.swapLimit);                                       // the counter at the top middle (index.html #swaps)
    barEl.style.display = 'none';                                           // (the thin bar under the label: the counter has taken its place)
    throwButton.style.display = sim.world.held.length > 0 ? '' : 'none';   // shown only while holding grenades
    document.body.classList.toggle('has-slider', sim.slider);               // a PC keeps a strip free for the slider (index.html)
    const swapText = swaps !== null ? `SWAP
${swaps}` : 'SWAP';
    if (swapButton.textContent !== swapText) swapButton.textContent = swapText;   // the count shows on the button too
    swapButton.style.display = canSwap ? '' : 'none'; // shown only while a swap would be accepted (never on a timed level; on a kiosks-only level, at a kiosk)
    flashEl.style.opacity = String(flash);
    if (sim.cleared) {
      message.style.display = 'block';
      message.textContent = 'All rooms clear\nPress R or tap restart to play again';
    } else {
      message.style.display = 'none';
    }
  }

  let last = null;
  function frame(now) {
    let dt = last === null ? 0 : now - last;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    last = now;
    try {
      if (sim.index !== storyRoom && !menu.isOpen()) { storyRoom = sim.index; openStory(sim.index); }
      const n = menu.isOpen() || storyOpen ? 0 : stepper(dt);   // paused behind the menu or a story screen: no steps, so no clocks run
      for (let i = 0; i < n; i++) {
        slider.beforeStep();                       // the slider may issue one notch (resDown / resUp) this step
        const out = stepSim(sim, actions.held, { swap: actions.take('swap'), restart: actions.take('restart'), throw: actions.take('throw'), resDown: actions.take('resDown'), resUp: actions.take('resUp') });
        slider.afterStep(sim, out);
        if (out.refused) {
          flash = 0.5;
          beep();
          navigator.vibrate?.(60);
        }
        for (const g of out.grenades) if (g.type === 'pop') pop();
        if (out.dying && out.dying.elapsed === 0) fallTone(out.dying.cause === 'crush' ? CRUSH_FLASH : 0);
        flash = Math.max(0, flash - STEP * 2);
        blocked = out.blocked;
        canSwap = out.canSwap;
        const left = out.countdown;
        if (left === null || out.blocked) tickSecond = null;
        else if (Math.ceil(left) !== tickSecond) {
          tickSecond = Math.ceil(left);
          if (tickSecond <= 3 && !out.restarted) tick();
        }
      }
      look.update(sim.world, dt / 1000, sim.player);
      present();
      slider.frame(sim, dt / 1000);
    } finally {
      requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);
}

main();
