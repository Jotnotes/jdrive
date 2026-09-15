// The desktop surface: the wallpaper, what is left lying on it, and the only
// crossings a drag is allowed to perform.
//
// Three rules hold this file together.
//
// A place is derived from where the bytes are. Dropping something on a place
// therefore never *files* it there — it performs an act. Trash deletes, which is
// reversible and universally understood. Public asks the publish question and
// publishes nothing on its own. Shared refuses, because sharing needs a role and
// an expiry that a gesture cannot express, and My Files refuses because it is a
// view of everything private rather than a destination. A refusal says why.
//
// A shortcut is a handle, not a copy and not a fifth place. Putting one on the
// desktop moves nothing and changes no reach. It is also not a drag source for
// file operations: dragging a shortcut only moves the shortcut, so there is no
// gesture whose meaning depends on whether you grabbed the file or the handle.
//
// Where a thing was left is remembered per browser, in localStorage. It is a view
// arrangement, not product data — a second machine starts tidy rather than wrong,
// and nothing on the box needs to know this file exists.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import { Icon, PLACES } from './ui.jsx';
import { carriesFiles, draggedFiles, fromOutside } from './drag.js';
import { canPicture, thumbnailFor } from './thumbs.js';

const CELL = { w: 92, h: 98 };
const ORIGIN = { x: 16, y: 12 };
const ICON = { w: 84, h: 88 };
const MOVE_THRESHOLD = 4;
// Neutral, like `files.session` beside it. A white-label box must not carry our
// own product name anywhere a customer can read it, and a localStorage key is
// somewhere a customer can read it — G2.5 fails the build over exactly this.
const STORE = 'files.desktop';

// What a drag onto a place means. Shared by the desktop icons and the dock so
// the two can never drift into disagreeing about it.
export function dropRuleFor(place) {
  switch (place) {
    case 'trash':
      return { accepts: true, verb: 'Delete', reason: null };
    case 'public':
      return { accepts: true, verb: 'Publish', reason: null };
    case 'shared':
      return { accepts: false, verb: null, reason: 'Sharing is an act with a role and an expiry. Use Share.' };
    default:
      return { accepts: false, verb: null, reason: 'My Files is every private file, not a folder. Drop into a folder instead.' };
  }
}

const rowsIn = height => Math.max(1, Math.floor((height - ORIGIN.y) / CELL.h));
const snap = (x, y, room) => {
  const col = Math.max(0, Math.round((x - ORIGIN.x) / CELL.w));
  const row = Math.max(0, Math.round((y - ORIGIN.y) / CELL.h));
  return {
    x: Math.min(Math.max(ORIGIN.x, ORIGIN.x + col * CELL.w), Math.max(ORIGIN.x, room.w - ICON.w - 8)),
    y: Math.min(Math.max(ORIGIN.y, ORIGIN.y + row * CELL.h), Math.max(ORIGIN.y, room.h - ICON.h - 8)),
  };
};
const sameSlot = (a, b) => Math.abs(a.x - b.x) < 4 && Math.abs(a.y - b.y) < 4;

// The first slot nobody is standing in, reading down the first column and then
// across. Used both for icons that have never been placed and for a drop that
// lands on top of something.
function freeSlot(taken, room, from = 0) {
  const rows = rowsIn(room.h);
  for (let n = from; n < rows * 40; n += 1) {
    const spot = { x: ORIGIN.x + Math.floor(n / rows) * CELL.w, y: ORIGIN.y + (n % rows) * CELL.h };
    if (spot.x + ICON.w > room.w) break;
    if (!taken.some(other => sameSlot(other, spot))) return spot;
  }
  return { x: ORIGIN.x, y: ORIGIN.y };
}

function loadLayout(key) {
  try {
    const raw = window.localStorage.getItem(`${STORE}.${key}`);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return { pos: {}, pins: [] };
    return { pos: parsed.pos && typeof parsed.pos === 'object' ? parsed.pos : {}, pins: Array.isArray(parsed.pins) ? parsed.pins : [] };
  } catch {
    // A browser with storage switched off gets a tidy desktop every time, which
    // is a worse desktop but a working one.
    return { pos: {}, pins: [] };
  }
}

function saveLayout(key, layout) {
  try { window.localStorage.setItem(`${STORE}.${key}`, JSON.stringify(layout)); } catch { /* nothing to do about it */ }
}

export function useDesktopLayout(accountKey) {
  // The layout carries the account it was read for. Without that, the one render
  // between an account changing and its layout loading would save the previous
  // person's desktop under the next person's name.
  const [layout, setLayout] = useState(() => ({ key: accountKey, ...loadLayout(accountKey) }));

  useEffect(() => {
    setLayout(prev => (prev.key === accountKey ? prev : { key: accountKey, ...loadLayout(accountKey) }));
  }, [accountKey]);

  useEffect(() => {
    if (layout.key === accountKey) saveLayout(accountKey, { pos: layout.pos, pins: layout.pins });
  }, [accountKey, layout]);

  const placeAt = useCallback((id, spot) => {
    setLayout(prev => ({ ...prev, pos: { ...prev.pos, [id]: spot } }));
  }, []);

  const pin = useCallback((ids, spots) => {
    setLayout(prev => {
      const pins = [...prev.pins];
      const pos = { ...prev.pos };
      ids.forEach((id, index) => {
        if (!pins.includes(id)) pins.push(id);
        if (spots[index]) pos[`file:${id}`] = spots[index];
      });
      return { ...prev, pins, pos };
    });
  }, []);

  const unpin = useCallback(ids => {
    const gone = new Set(ids);
    setLayout(prev => {
      if (!prev.pins.some(id => gone.has(id))) return prev;
      const pos = { ...prev.pos };
      gone.forEach(id => delete pos[`file:${id}`]);
      return { ...prev, pins: prev.pins.filter(id => !gone.has(id)), pos };
    });
  }, []);

  return { layout, placeAt, pin, unpin };
}

export function DesktopSurface({ accountKey, refreshToken, onOpenFile, onUpload }) {
  const surface = useRef(null);
  const [room, setRoom] = useState({ w: 1200, h: 700 });
  const [hint, setHint] = useState(null);
  const [files, setFiles] = useState(null);
  const { layout, placeAt, pin, unpin } = useDesktopLayout(accountKey);
  const pinCount = layout.pins.length;

  // A shortcut needs to know its file's name, kind and place, and nothing else
  // on the desktop needs the list at all. So an empty desktop — which is every
  // desktop until somebody drags something onto it — costs no request, and the
  // Files window keeps being the only thing asking on a normal page load.
  useEffect(() => {
    if (!pinCount) { setFiles(null); return undefined; }
    let alive = true;
    api.files().then(rows => { if (alive) setFiles(rows); }).catch(() => {});
    return () => { alive = false; };
  }, [pinCount, refreshToken]);

  useEffect(() => {
    const measure = () => {
      const box = surface.current && surface.current.getBoundingClientRect();
      if (box && box.width) setRoom({ w: box.width, h: box.height });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // A shortcut to a file that has been deleted or emptied is a lie, so it goes.
  // Only once the list has actually loaded: an empty array on the first render
  // would otherwise sweep the desktop clean.
  useEffect(() => {
    if (!files) return;
    const live = new Set(files.filter(file => file.place !== 'trash').map(file => file.id));
    const stale = layout.pins.filter(id => !live.has(id));
    if (stale.length) unpin(stale);
  }, [files, layout.pins, unpin]);

  const byId = useMemo(() => new Map((files || []).map(file => [file.id, file])), [files]);

  // Only what somebody put here. The four places are the dock's job: the dock
  // sits above every window and the wallpaper sits under them, so navigation
  // that can be covered up is not navigation. Having both was the same four
  // icons in two places, which is what it looked like.
  const icons = useMemo(() => {
    const placed = [];
    return layout.pins.map((fileId, index) => {
      const file = byId.get(fileId);
      if (!file) return null;
      const remembered = layout.pos[`file:${fileId}`];
      const spot = remembered && Number.isFinite(remembered.x) && Number.isFinite(remembered.y)
        ? snap(remembered.x, remembered.y, room)
        : freeSlot(placed, room, index);
      placed.push(spot);
      const place = PLACES[file.place] || PLACES.private;
      return {
        id: `file:${fileId}`, kind: 'file', file, label: file.name, hint: place.label,
        tone: place.tone, wash: place.wash, spot,
      };
    }).filter(Boolean);
  }, [layout, room, byId]);

  const occupied = icons.map(item => item.spot);

  const dropOnWallpaper = event => {
    if (fromOutside(event)) {
      event.preventDefault();
      setHint(null);
      const list = event.dataTransfer.files;
      if (!list || !list.length) return;
      // Where it was dropped, read now: the event is gone by the time the upload
      // answers. The desktop says "Drag a file here to keep it", so a file dropped
      // here gets an icon here, not only a row in My Files.
      const box = surface.current.getBoundingClientRect();
      const first = snap(event.clientX - box.left - ICON.w / 2, event.clientY - box.top - ICON.h / 2, room);
      Promise.resolve(onUpload(list)).then(async rows => {
        const ids = (rows || []).map(row => row.id).filter(id => id && !layout.pins.includes(id));
        if (!ids.length) return;
        // The list first, then the pins, in one turn. Pinning against the old list
        // would let the stale-shortcut sweep above remove the new icon at once,
        // because the file it points at is not in a list fetched before it existed.
        const fresh = await api.files().catch(() => null);
        if (fresh) setFiles(fresh);
        const busy = [...occupied];
        const spots = ids.map((id, index) => {
          const spot = index === 0 && !busy.some(other => sameSlot(other, first)) ? first : freeSlot(busy, room);
          busy.push(spot);
          return spot;
        });
        pin(ids, spots);
      });
      return;
    }
    if (!carriesFiles(event)) return;
    event.preventDefault();
    setHint(null);
    const ids = draggedFiles(event).filter(id => !layout.pins.includes(id));
    if (!ids.length) return;
    const box = surface.current.getBoundingClientRect();
    const first = snap(event.clientX - box.left - ICON.w / 2, event.clientY - box.top - ICON.h / 2, room);
    const spots = [];
    const busy = [...occupied];
    ids.forEach((id, index) => {
      const spot = index === 0 && !busy.some(other => sameSlot(other, first))
        ? first
        : freeSlot(busy, room);
      busy.push(spot);
      spots.push(spot);
    });
    pin(ids, spots);
  };

  const overWallpaper = event => {
    if (fromOutside(event)) { event.preventDefault(); setHint('Drop to upload it and keep it here'); return; }
    if (carriesFiles(event)) { event.preventDefault(); setHint('Drop to keep a shortcut here'); }
  };

  return (
    <>
      <div
        ref={surface}
        className="desktop__wallpaper"
        data-hinting={hint ? 'true' : undefined}
        onDragOver={overWallpaper}
        onDragLeave={event => { if (event.currentTarget === event.target) setHint(null); }}
        onDrop={dropOnWallpaper}
      />
      <div className="desktop__icons">
        {icons.map(item => (
          <DesktopIcon
            key={item.id}
            item={item}
            room={room}
            occupied={occupied}
            onMoved={spot => placeAt(item.id, spot)}
            onOpen={() => onOpenFile(item.file)}
            onRemove={() => unpin([item.file.id])}
          />
        ))}
      </div>
      {/* An empty desktop is correct and says nothing, so it says one thing.
          It goes for good the moment there is anything on the wallpaper. */}
      {!icons.length && !hint && (
        <p className="desktop__invitation">Drag a file here to keep it</p>
      )}
      {hint && <p className="desktop__hint" role="status">{hint}</p>}
    </>
  );
}

function DesktopIcon({ item, room, occupied, onMoved, onOpen, onRemove }) {
  const [drag, setDrag] = useState(null);
  const [picked, setPicked] = useState(false);
  const grabbed = useRef(null);

  // Clicking the wallpaper puts everything down, the way a desktop does.
  useEffect(() => {
    if (!picked) return undefined;
    const drop = event => { if (!event.target.closest('.desktop-icon')) setPicked(false); };
    window.addEventListener('pointerdown', drop);
    return () => window.removeEventListener('pointerdown', drop);
  }, [picked]);

  const startMove = event => {
    if (event.button !== 0 || event.target.closest('button.desktop-icon__off')) return;
    event.preventDefault();
    setPicked(true);
    const origin = { x: event.clientX, y: event.clientY, at: item.spot, moved: false };
    grabbed.current = origin;
    const move = next => {
      if (!grabbed.current) return;
      const dx = next.clientX - origin.x;
      const dy = next.clientY - origin.y;
      if (!grabbed.current.moved && Math.abs(dx) + Math.abs(dy) < MOVE_THRESHOLD) return;
      grabbed.current.moved = true;
      setDrag({ x: origin.at.x + dx, y: origin.at.y + dy });
    };
    const end = next => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      grabbed.current = null;
      setDrag(null);
      // Judged on where the pointer came up, not on whether a move was seen on
      // the way. A quick flick can put the pointer down and up with nothing in
      // between, and that is still a drag.
      const far = Math.abs(next.clientX - origin.x) + Math.abs(next.clientY - origin.y) >= MOVE_THRESHOLD;
      if (!far) return;
      const landing = snap(origin.at.x + next.clientX - origin.x, origin.at.y + next.clientY - origin.y, room);
      const others = occupied.filter(spot => !sameSlot(spot, item.spot));
      onMoved(others.some(spot => sameSlot(spot, landing)) ? freeSlot(others, room) : landing);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  };

  const at = drag || item.spot;

  return (
    <div
      className="desktop-icon"
      data-dragging={drag ? 'true' : undefined}
      data-picked={picked ? 'true' : undefined}
      style={{ left: at.x, top: at.y, '--place': item.tone, '--place-soft': item.wash }}
    >
      <button
        type="button"
        className="desktop-icon__hit"
        draggable={false}
        title={`${item.label} — ${item.hint}`}
        aria-label={`${item.label}, shortcut`}
        onPointerDown={startMove}
        onDoubleClick={onOpen}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); } }}
      >
        <span className="desktop-icon__glyph"><Shortcut file={item.file} /></span>
        <span className="desktop-icon__label">{item.label}</span>
      </button>
      <button type="button" className="desktop-icon__off" title="Take off the desktop"
        aria-label={`Take ${item.label} off the desktop`} onClick={onRemove}>
        <Icon name="close" size={11} />
      </button>
    </div>
  );
}

// The same picture the Files window shows, from the same cache, so putting a
// photograph on the desktop costs nothing that has not already been paid.
function Shortcut({ file }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!canPicture(file)) return undefined;
    let alive = true;
    thumbnailFor(file).then(url => { if (alive) setSrc(url); }).catch(() => {});
    return () => { alive = false; };
  }, [file.id, file.thumbnail, file.mime]);
  if (src) return <img src={src} alt="" className="desktop-icon__thumb" draggable={false} />;
  return (
    <>
      <Icon name="file" size={26} />
      <strong>{(file.name.split('.').pop() || '').slice(0, 4).toUpperCase()}</strong>
    </>
  );
}
