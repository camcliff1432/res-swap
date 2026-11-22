// The level-select menu on the page: the MENU button, the overlay and its list. Pure logic is in menu.js.
const OPEN_GUARD_MS = 400;   // the touch or click that opened the menu must not also close it

export function createMenu({ doc, rows, getRoom, onPick, onOpen, onClose }) {
  const button = doc.getElementById('btn-menu');
  const backdrop = doc.getElementById('menu');
  const list = doc.getElementById('menu-list');
  const closeButton = doc.getElementById('menu-close');
  let open = false, openedAt = 0, current = null, cursor = -1;
  const items = [];                                     // the level rows' elements, in order

  for (const row of rows) {
    const el = doc.createElement(row.type === 'folder' ? 'div' : 'button');
    if (row.type === 'folder') { el.className = 'menu-folder'; el.textContent = row.name; }
    else {
      el.className = 'menu-level';
      el.tabIndex = -1;
      el.dataset.room = String(row.room);
      el.textContent = row.name;
      items.push({ el, room: row.room });
      el.addEventListener('click', () => pick(row.room));
    }
    list.appendChild(el);
  }

  function mark() {
    items.forEach((it, i) => {
      it.el.classList.toggle('current', it.room === current);
      it.el.classList.toggle('cursor', i === cursor);
    });
  }
  function setCursor(i) {
    cursor = Math.max(0, Math.min(items.length - 1, i));
    mark();
    items[cursor]?.el.scrollIntoView({ block: 'nearest' });
  }
  function show(room) {
    if (open) return;
    open = true; openedAt = performance.now(); current = room;
    backdrop.style.display = 'flex';
    onOpen();
    cursor = Math.max(0, items.findIndex((it) => it.room === room));
    mark();
    items[cursor]?.el.scrollIntoView({ block: 'center' });
  }
  function close() {
    if (!open) return;
    open = false;
    backdrop.style.display = 'none';
    onClose();
  }
  function pick(room) {
    close();
    onPick(room);
  }

  button.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); show(getRoom()); });
  closeButton.addEventListener('click', close);
  // A press on the dim area (not the panel) closes. Nothing under the overlay may see a press (a mouse press would swap).
  backdrop.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop && performance.now() - openedAt > OPEN_GUARD_MS) close(); });

  // Capture phase, so while the menu is open no key reaches the game's own handlers.
  doc.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!open) {
      if (e.code === 'Escape' || e.code === 'KeyM') { e.preventDefault(); e.stopImmediatePropagation(); if (!e.repeat) show(getRoom()); }
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    const page = Math.max(1, Math.floor(list.clientHeight / 48) - 1);
    switch (e.code) {
      case 'Escape': case 'KeyM': if (!e.repeat) close(); break;
      case 'ArrowDown': case 'KeyS': setCursor(cursor + 1); break;
      case 'ArrowUp': case 'KeyW': setCursor(cursor - 1); break;
      case 'PageDown': setCursor(cursor + page); break;
      case 'PageUp': setCursor(cursor - page); break;
      case 'Home': setCursor(0); break;
      case 'End': setCursor(items.length - 1); break;
      case 'Enter': case 'Space': if (!e.repeat && items[cursor]) pick(items[cursor].room); break;
      default: break;
    }
  }, true);
  doc.addEventListener('keyup', (e) => { if (open) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);

  return { isOpen: () => open, close, show };
}
