import { PX8, CRATE_SIZE, DOOR_W, DOOR_H, MIN_W, MIN_H, MAX_W, MAX_H } from './constants.js';
import { PROPS } from './props/index.js';
import { checkWave } from './wave.js';

// Pixel (cx, cy) in 0..7 of a tile, per terrain character.
export const SHAPES = {
  '#': () => true,
  '/': (cx, cy) => cy >= 7 - cx,
  '\\': (cx, cy) => cy >= cx,
  '~': (cx, cy) => cy < 4,
  '=': (cx, cy) => cy < 2,
  '|': (cx) => cx === 3 || cx === 4,
  // thin ramps: the top two pixels of the matching ramp's diagonal
  z: (cx, cy) => cy === 7 - cx || cy === 8 - cx,
  s: (cx, cy) => cy === cx || cy === cx + 1,
  // thin edges (two pixels thick) and corners
  _: (cx, cy) => cy >= 6,
  '[': (cx) => cx < 2,
  ']': (cx) => cx >= 6,
  r: (cx, cy) => cy < 2 || cx < 2,
  7: (cx, cy) => cy < 2 || cx >= 6,
  L: (cx, cy) => cy >= 6 || cx < 2,
  J: (cx, cy) => cy >= 6 || cx >= 6,
  // half-tile shapes: they fill at least half a tile, so low-res rounds them up to a full block
  '(': (cx) => cx < 4,
  ')': (cx) => cx >= 4,
  '-': (cx, cy) => cy >= 4,
  // the grating: two thin walls with studs on their inner faces (40 of 64 pixels; pixels 3 and 4, where a laser beam runs, stay
  // clear). Voted in blocks of 2 the studs go (two plain thin walls); in blocks of 4 every block has more than half, and
  // low-res has more than half: a full block. It only ever fills in: it never vanishes and comes back.
  g: (cx, cy) => cx < 2 || cx >= 6 || ((cx === 2 || cx === 5) && cy % 2 === 0),
  // vented pieces: half a tile thick with slots inside (3 of every 4 pixels, 24 of the tile's 64). Their faces are whole, so in
  // 8-bit they are a half-thick wall or floor; voted in blocks of 2 or 4 (the slider's steps 4 and 2) every block has more than
  // half, so they are a plain half-thick piece; low-res (and the slider's step 1) has less than half a tile: gone. The only
  // pieces that last down to step 2 and vanish at step 1.
  '{': (cx, cy) => cx < 4 && !((cx === 1 || cx === 2) && cy % 2 === 0),
  '}': (cx, cy) => cx >= 4 && !((cx === 5 || cx === 6) && cy % 2 === 0),
  n: (cx, cy) => cy < 4 && !((cy === 1 || cy === 2) && cx % 2 === 0),
  u: (cx, cy) => cy >= 4 && !((cy === 5 || cy === 6) && cx % 2 === 0),
  // big spikes: a stalactite hangs point down, a stalagmite stands point up (deadly in 8-bit)
  W: (cx, cy) => { const k = Math.floor(cy / 2); return cx >= k && cx <= 7 - k; },
  M: (cx, cy) => { const k = Math.floor((7 - cy) / 2); return cx >= k && cx <= 7 - k; },
};
// Every terrain character, in palette order.
export const TERRAIN_CHARS = '#/\\~=|zs_[]r7LJ()-gWM{}nu';

// Box of each object type in tiles: [w, h], measured from the tile (x, y). Start and exit occupy
// their tile and the one above.
const BOX = {
  start: [1, 2, -1], exit: [1, 2, -1], spikes: [1, 1, 0], crate: [CRATE_SIZE, CRATE_SIZE, 0],
  ball: [1, 1, 0], button: [1, 1, 0], door: [DOOR_W, DOOR_H, 0],
};

// The old text grid -> level data. Rows are all the same length; P, E, ^, c, l, o, 1-4 and A-D are objects.
export function gridToData(text) {
  const rows = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l !== '');
  const width = rows.length ? rows[0].length : 0;
  rows.forEach((row, r) => {
    if (row.length !== width) throw new Error(`terrain row ${r + 1} has ${row.length} characters, expected ${width}`);
  });
  const terrain = [], objects = [];
  rows.forEach((row, y) => {
    let line = '';
    for (let x = 0; x < width; x++) {
      const ch = row[x];
      line += ch in SHAPES ? ch : '.';
      if (ch in SHAPES || ch === '.') continue;
      if (ch === 'P') objects.push({ type: 'start', x, y });
      else if (ch === 'E') objects.push({ type: 'exit', x, y });
      else if (ch === 'o') objects.push({ type: 'ball', x, y });
      else if (ch === '^') objects.push({ type: 'spikes', x, y });
      else if (ch === 'c' || ch === 'l') objects.push({ type: 'crate', x, y, locked: ch === 'l' });
      else if (ch >= '1' && ch <= '4') objects.push({ type: 'button', x, y, id: ch });
      else if (ch >= 'A' && ch <= 'D') objects.push({ type: 'door', x, y, button: String(ch.charCodeAt(0) - 64) });
      else throw new Error(`unknown character "${ch}" at column ${x + 1}, row ${y + 1}`);
    }
    terrain.push(line);
  });
  return { name: '', width, height: rows.length, terrain, objects };
}

const whole = (n) => Number.isInteger(n);

export function parseLevel(input, name) {
  const fail = (problem) => { throw new Error(`${name}: ${problem}`); };
  let data = input;
  if (typeof input === 'string') {
    try { data = gridToData(input); } catch (err) { fail(err.message); }
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) fail('not a level object');

  const { width, height, terrain, objects } = data;
  if (!whole(width) || width < MIN_W || width > MAX_W) fail(`width must be a whole number from ${MIN_W} to ${MAX_W}`);
  if (!whole(height) || height < MIN_H || height > MAX_H) fail(`height must be a whole number from ${MIN_H} to ${MAX_H}`);
  if (!Array.isArray(terrain) || terrain.length !== height) {
    fail(`terrain must have ${height} rows, found ${Array.isArray(terrain) ? terrain.length : 0}`);
  }
  terrain.forEach((row, r) => {
    const n = typeof row === 'string' ? row.length : 0;
    if (n !== width) fail(`terrain row ${r + 1} has ${n} characters, expected ${width}`);
  });
  terrain.forEach((row, y) => {
    for (let x = 0; x < width; x++) {
      if (!(row[x] in SHAPES) && row[x] !== '.') fail(`unknown terrain character "${row[x]}" at column ${x + 1}, row ${y + 1}`);
    }
  });

  if (!Array.isArray(objects)) fail('objects must be a list');
  const spikes = [], crates = [], buttons = [], doors = [], balls = [];
  const starts = [], exits = [], props = [], propButtons = [];
  objects.forEach((o, i) => {
    const n = i + 1;
    if (o === null || typeof o !== 'object' || typeof o.type !== 'string' || o.type === '') fail(`object ${n} has no type`);
    if (Object.hasOwn(PROPS, o.type)) {
      const def = PROPS[o.type];
      const settings = { ...def.defaults };
      const src = def.migrate ? def.migrate(o) : o;
      for (const f of def.fields) if (src[f.key] !== undefined) settings[f.key] = src[f.key];
      const problem = def.check(settings);
      if (problem) fail(`object ${n} (${o.type}): ${problem}`);
      const [pw, ph] = def.size(settings);
      if (!whole(o.x) || !whole(o.y) || o.x < 0 || o.y < 0 || o.x + pw > width || o.y + ph > height) {
        fail(`object ${n} (${o.type}) is outside the level`);
      }
      const inst = { type: o.type, x: o.x, y: o.y, w: pw, h: ph, solid: def.solid === true, ...settings };
      def.place?.(inst);
      props.push(inst);
      for (const f of def.fields) if (f.kind === 'button') propButtons.push({ n, type: o.type, id: settings[f.key] });
      return;
    }
    if (!Object.hasOwn(BOX, o.type)) fail(`object ${n} has unknown type "${o.type}"`);
    const [w, h, up] = BOX[o.type];
    const top = o.y + up;
    if (!whole(o.x) || !whole(o.y) || o.x < 0 || top < 0 || o.x + w > width || top + h > height) {
      fail(`object ${n} (${o.type}) is outside the level`);
    }
    const { x, y } = o;
    if (o.type === 'start') starts.push({ x, y: y - 0.5 });
    else if (o.type === 'exit') exits.push({ x, y: y - 0.5 });
    else if (o.type === 'spikes') spikes.push({ x, y });
    else if (o.type === 'crate') crates.push({ x, y, locked: o.locked === true });
    else if (o.type === 'ball') balls.push({ x, y });
    else if (o.type === 'button') buttons.push({ id: o.id, x, y });
    else doors.push({ id: o.button, x, y });
  });

  if (starts.length !== 1) fail('needs exactly one start');
  if (exits.length !== 1) fail('needs exactly one exit');
  const validId = (id) => typeof id === 'string' && id !== '';
  buttons.forEach((b, i) => { if (!validId(b.id)) fail(`button ${i + 1} has no id`); });
  for (const b of buttons) if (buttons.filter((o) => o.id === b.id).length > 1) fail(`more than one button "${b.id}"`);
  doors.forEach((d, i) => { if (!validId(d.id)) fail(`door ${i + 1} has no button`); });
  doors.forEach((d, i) => {
    if (!buttons.some((b) => b.id === d.id)) fail(`door ${i + 1} names button "${d.id}", which does not exist`);
  });

  for (const p of propButtons) {
    if (!buttons.some((b) => b.id === p.id)) fail(`object ${p.n} (${p.type}) names button "${p.id}", which does not exist`);
  }

  // Optional ice layer: rows of i (icy) and . (not). A tile is icy only when it is also terrain.
  const hasIceField = data.ice !== undefined;
  if (hasIceField) {
    const rowsOfIce = Array.isArray(data.ice) ? data.ice : null;
    if (!rowsOfIce || rowsOfIce.length !== height) fail(`ice must have ${height} rows, found ${rowsOfIce ? rowsOfIce.length : 0}`);
    rowsOfIce.forEach((row, r) => {
      const n = typeof row === 'string' ? row.length : 0;
      if (n !== width) fail(`ice row ${r + 1} has ${n} characters, expected ${width}`);
    });
    rowsOfIce.forEach((row, y) => {
      for (let x = 0; x < width; x++) {
        if (row[x] !== 'i' && row[x] !== '.') fail(`unknown ice character "${row[x]}" at column ${x + 1}, row ${y + 1}`);
      }
    });
  }
  const ice = new Uint8Array(width * height);
  if (hasIceField) {
    data.ice.forEach((row, y) => {
      for (let x = 0; x < width; x++) if (row[x] === 'i' && terrain[y][x] !== '.') ice[y * width + x] = 1;
    });
  }

  // Optional timed swapping: seconds between automatic swaps, 1 to 60 in steps of 0.5. Absent means manual.
  let autoSwap = null;
  if (data.autoSwap !== undefined) {
    const s = data.autoSwap;
    if (typeof s !== 'number' || !Number.isFinite(s) || s < 1 || s > 60 || !Number.isInteger(s * 2)) {
      fail('autoSwap must be a number of seconds from 1 to 60 in steps of 0.5');
    }
    autoSwap = s;
  }

  // Optional "Swapping: Off": no player swap and no timer. Cannot be combined with a timer.
  let noSwap = false;
  if (data.noSwap !== undefined) {
    if (typeof data.noSwap !== 'boolean') fail('noSwap must be true or false');
    noSwap = data.noSwap;
    if (noSwap && autoSwap !== null) fail('a level cannot have both autoSwap and noSwap');
  }

  // Optional "Swapping: Limited": a fixed number of player swaps (1 to 99) usable from anywhere; a kiosk swap is free.
  // Excludes the timer and Off.
  let swapLimit = null;
  if (data.swapLimit !== undefined) {
    const n = data.swapLimit;
    if (!whole(n) || n < 1 || n > 99) fail('swapLimit must be a whole number of swaps from 1 to 99');
    if (autoSwap !== null) fail('a level cannot have both autoSwap and swapLimit');
    if (noSwap) fail('a level cannot have both noSwap and swapLimit');
    swapLimit = n;
  }

  // Optional rolling wave: a band of low-res that travels sideways (wave.js). Absent means none.
  let wave = null;
  if (data.wave !== undefined) {
    const problem = checkWave(data.wave);
    if (problem) fail(problem);
    wave = { width: data.wave.width, dir: data.wave.dir, speed: data.wave.speed, edge: data.wave.edge };
    if (data.wave.step !== undefined) wave.step = data.wave.step;          // stage 4 of the slider: the band's own step
  }

  // Optional resolution slider (slider.js): four steps (8, 4, 2, 1) instead of two modes, the player's own control. It is the
  // level's whole swapping scheme, so it cannot be combined with the other ones. Areas (windows) hold their own step or mode
  // whatever the slider does (stage 4, zones.js), and so do the wave's band and timed and permanent grenades' areas. Still not
  // allowed: kiosks (a kiosk is a swap) and things grenades (their things go low-res for good: a mode, not a step).
  let slider = false;
  if (data.slider !== undefined) {
    if (typeof data.slider !== 'boolean') fail('slider must be true or false');
    slider = data.slider;
    if (slider) {
      if (autoSwap !== null) fail('a level cannot have both slider and autoSwap');
      if (noSwap) fail('a level cannot have both slider and noSwap');
      if (swapLimit !== null) fail('a level cannot have both slider and swapLimit');
      const clash = props.find((p) => p.type === 'kiosk' || (p.type === 'grenade' && p.kind === 'things'));
      if (clash) fail(`a slider level cannot have a ${clash.type === 'grenade' ? 'things grenade' : clash.type}`);
    }
  }

  // Optional resolution the room starts at (and restarts at): 8 (the default: 8-bit) or 1 (low-res); in a slider level also 4 or 2.
  let startStep = 8;
  if (data.startStep !== undefined) {
    if (![8, 4, 2, 1].includes(data.startStep)) fail('startStep must be 8, 4, 2 or 1');
    if (!slider && (data.startStep === 4 || data.startStep === 2)) fail('startStep 4 and 2 need the slider (without it a level starts at 8 or 1)');
    startStep = data.startStep;
  }

  const maskW = width * PX8, maskH = height * PX8;
  const shapes = terrain.slice();
  const mask = new Uint8Array(maskW * maskH);
  shapes.forEach((row, ty) => {
    for (let tx = 0; tx < width; tx++) {
      const shape = SHAPES[row[tx]];
      if (!shape) continue;
      for (let cy = 0; cy < PX8; cy++) {
        for (let cx = 0; cx < PX8; cx++) {
          if (shape(cx, cy)) mask[(ty * PX8 + cy) * maskW + tx * PX8 + cx] = 1;
        }
      }
    }
  });

  return {
    name: typeof data.name === 'string' ? data.name : '', width, height, shapes, mask, maskW, maskH, ice, autoSwap, noSwap, swapLimit, wave, slider, startStep,
    start: starts[0], exit: exits[0], spikes, crates, buttons, doors, balls, props,
  };
}
