import { loadRoom } from './sim.js';

// The level-select menu's logic, with no page in it (menuView.js draws it).

// The rows of the menu, in index order. `index` is levels/index.json ({ levels: [ids], tree?: [...] }), `levels` the loaded,
// parsed levels in the same order as index.levels. A row is { type: 'folder', name } (a heading) or
// { type: 'level', room, id, name }, where `room` is the level's place in play order (what loadRoom takes) and `name` its
// own name (its id when it has none). Without a tree the levels are one flat list. A tree id that is not loaded is skipped
// (and a folder left empty by that has no heading); a loaded level the tree leaves out comes last, loose; a repeat shows once.
export function menuRows(index, levels) {
  const ids = Array.isArray(index?.levels) ? index.levels : [];
  const room = new Map();
  ids.forEach((id, i) => { if (i < levels.length && !room.has(id)) room.set(id, i); });
  const seen = new Set();
  const rowOf = (id) => {
    if (typeof id !== 'string' || !room.has(id) || seen.has(id)) return null;
    seen.add(id);
    const i = room.get(id);
    return { type: 'level', room: i, id, name: levels[i]?.name || id };
  };
  const rows = [];
  for (const item of Array.isArray(index?.tree) ? index.tree : []) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const inside = (Array.isArray(item.levels) ? item.levels : []).map(rowOf).filter(Boolean);
      if (inside.length > 0) rows.push({ type: 'folder', name: String(item.folder ?? '') }, ...inside);
    } else {
      const row = rowOf(item);
      if (row) rows.push(row);
    }
  }
  for (const id of room.keys()) { const row = rowOf(id); if (row) rows.push(row); }
  return rows;
}

// The index as the game plays it: without the levels of the folders kept out of the game (a folder with `hidden: true`), and
// without those folders. An index without a tree is as it is.
export function gameIndex(index) {
  if (!Array.isArray(index?.tree) || !Array.isArray(index?.levels)) return index;
  const isFolder = (item) => item !== null && typeof item === 'object' && !Array.isArray(item);
  const out = new Set(index.tree.filter((item) => isFolder(item) && item.hidden === true).flatMap((f) => (Array.isArray(f.levels) ? f.levels : [])));
  return { ...index, levels: index.levels.filter((id) => !out.has(id)), tree: index.tree.filter((item) => !(isFolder(item) && item.hidden === true)) };
}

// The story text to show before room `room`: the `intro` of the folder whose first loaded level it is, else null.
export function folderIntro(index, room) {
  const ids = Array.isArray(index?.levels) ? index.levels : [];
  const id = ids[room];
  if (id === undefined) return null;
  for (const item of Array.isArray(index?.tree) ? index.tree : []) {
    if (item === null || typeof item !== 'object' || Array.isArray(item) || !Array.isArray(item.levels)) continue;
    const first = item.levels.find((l) => ids.includes(l));
    if (first === id) return typeof item.intro === 'string' && item.intro.trim() !== '' ? item.intro.trim() : null;
  }
  return null;
}

// Start room `room` fresh, as a restart of that room would: clears "All rooms clear", and loadRoom drops a death sequence in
// progress and sets the timed countdown, swaps and wave back to the room's start. False (nothing changed) for a bad room.
export function jumpToRoom(sim, room) {
  if (!Number.isInteger(room) || room < 0 || room >= sim.levels.length) return false;
  sim.cleared = false;
  loadRoom(sim, room);
  return true;
}
