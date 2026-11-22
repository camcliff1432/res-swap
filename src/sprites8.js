// 8-bit art as data: NES colours and sprites as arrays of strings.
// Each sprite is { rows, palette } where palette maps a character to a colour; '.' is transparent.
// No DOM here.

export const NES = {
  sky: '#000000',
  starBright: '#FCFCFC', starDim: '#7C7C7C',
  hullGrey: '#7C7C7C', hullLight: '#BCBCBC', hullDark: '#3C3C3C',
  crateDark: '#503000', crateMid: '#AC7C00', crateLight: '#F8B800',
  doorDark: '#004058', doorMid: '#008888', doorLight: '#00E8D8',
  exitDark: '#005800', exitMid: '#00A800', exitLight: '#B8F818',
  suitWhite: '#FCFCFC', suitBlue: '#3CBCFC', suitGrey: '#7C7C7C',
  planetDark: '#4428BC', planetMid: '#6844FC', planetLight: '#B8B8F8',
  ballDark: '#7C0800', ballMid: '#D82800', ballLight: '#FC7460',
  warnDark: '#7C0800', warnMid: '#F83800', warnLight: '#FC7460', // big spikes
  wire: '#00A8A8', lampClosed: '#F83800', lampOpen: '#00A800', buttonBase: '#3C3C3C', buttonCap: '#F83800',
};

const HULL_PALETTE = { L: NES.hullLight, G: NES.hullGrey, D: NES.hullDark, W: NES.starBright };

// Hull tile when the tile above is solid.
export const HULL_INNER = { palette: HULL_PALETTE, rows: ['LLLLLLLD', 'LGGGGGGD', 'LGLGGGGD', 'LGGGGGGD', 'LGGGGGGD', 'LGGGGGGD', 'LGGGGGGD', 'DDDDDDDD'] };
// Hull tile when the tile above is empty: bright top edge. Three colours only (W, G, D).
export const HULL_TOP = { palette: HULL_PALETTE, rows: ['WWWWWWWW', 'WWWWWWWD', 'WGWGGGGD', 'WGGGGGGD', 'WGGGGGGD', 'WGGGGGGD', 'WGGGGGGD', 'DDDDDDDD'] };

export const ASTRONAUT_PALETTE = { W: NES.suitWhite, B: NES.suitBlue, G: NES.suitGrey };
const SUIT_UPPER = ['..WWWW..', '.WWWWWW.', '.WBBBBW.', '.WBBBBB.', '.WWWWWW.', 'GWWWWWW.', 'GWWGWWW.', 'GWWWWWW.', '.WWWWWW.'];
export const ASTRONAUT_FRAMES = [
  { palette: ASTRONAUT_PALETTE, rows: [...SUIT_UPPER, '.WW..WW.', '.WW..WW.', '.GG..GG.'] },
  { palette: ASTRONAUT_PALETTE, rows: [...SUIT_UPPER, '.WWWWWW.', '..WWWW..', '..GGGG..'] },
];

// Build a w x h sprite from a function (x, y) -> character.
function build(w, h, fn) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) row += fn(x, y);
    rows.push(row);
  }
  return rows;
}
const onBorder = (x, y, w, h) => x === 0 || y === 0 || x === w - 1 || y === h - 1;

// Crate 16 x 16: dark border, brown fill, light second row, dark lines at rows 5 and 10, dark diagonal.
export const CRATE = {
  palette: { D: NES.crateDark, M: NES.crateMid, L: NES.crateLight },
  rows: build(16, 16, (x, y) => {
    if (onBorder(x, y, 16, 16)) return 'D';
    if (y === 1) return 'L';
    if (y === 5 || y === 10 || x === y) return 'D';
    return 'M';
  }),
};

// The colour of the crate pixel (i, j), 0..15 across and down in the crate's OWN frame (so a leaning crate is shaded
// the same way, turned). Same look as CRATE above, with a light top edge and dark sides and bottom.
export function crateColour(i, j) {
  if (j <= 1) return NES.crateLight;
  if (i === 0 || i === 15 || j === 15) return NES.crateDark;
  if (j === 5 || j === 10 || i === j) return NES.crateDark;
  return NES.crateMid;
}

// Door 16 x 24: dark border, teal fill, dark centre seam, light second row, two dark cross lines.
export const DOOR_CLOSED = {
  palette: { D: NES.doorDark, M: NES.doorMid, L: NES.doorLight },
  rows: build(16, 24, (x, y) => {
    if (onBorder(x, y, 16, 24)) return 'D';
    if (y === 1) return 'L';
    if (x === 7 || x === 8 || y === 8 || y === 16) return 'D';
    return 'M';
  }),
};
// An open door is its border only.
export const DOOR_OPEN = {
  palette: DOOR_CLOSED.palette,
  rows: build(16, 24, (x, y) => (onBorder(x, y, 16, 24) ? 'D' : '.')),
};

// Exit 8 x 12: dark border, green fill, light second row, dark centre seam.
export const EXIT = {
  palette: { D: NES.exitDark, M: NES.exitMid, L: NES.exitLight },
  rows: build(8, 12, (x, y) => {
    if (onBorder(x, y, 8, 12)) return 'D';
    if (y === 1) return 'L';
    if (x === 3 || x === 4) return 'D';
    return 'M';
  }),
};

// Ball 8 x 8: round, dark rim, red body, light highlight upper left.
export const BALL = {
  palette: { D: NES.ballDark, M: NES.ballMid, L: NES.ballLight },
  rows: ['..DDDD..', '.DMMMMD.', 'DMLLMMMD', 'DMLMMMMD', 'DMMMMMMD', 'DMMMMMMD', '.DMMMMD.', '..DDDD..'],
};

// Spikes 8 x 4 (the bottom half of the tile): two pointed teeth, white tips over a light grey body, on a red base row. Each
// tooth is 3 pixels wide at its foot, so that voted in blocks of 2 (the slider's step 4: more than half) the teeth still stand.
export const SPIKES = {
  palette: { W: NES.starBright, L: NES.hullLight, R: '#F83800' },
  rows: ['.W....W.', 'LWL..LWL', 'LLLLLLLL', 'RRRRRRRR'],
};

// Padlock 6 x 6 for a locked crate: dark shackle, yellow body with a dark keyhole.
export const PADLOCK = {
  palette: { D: NES.crateDark, L: NES.crateLight },
  rows: ['.DDDD.', '.D..D.', 'LLLLLL', 'LLDDLL', 'LLDDLL', 'LLLLLL'],
};

export const PLANET = { cx: 204, cy: 30, r: 13 };
