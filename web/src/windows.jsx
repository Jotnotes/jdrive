// Real windows: moved, stacked, resized, minimised and maximised. The desktop
// engine remains presentation-only; every file operation stays in FilesApp.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';

const MIN_W = 360;
const MIN_H = 260;
// Wallpaper a window may not cover. The left gutter clears the icon column; the
// rest is what stops the product reading as one window with a left-hand nav,
// which is the shape of every web app ever made. Fill the desktop is still a
// button on the title bar — it just is not what you get on opening.
const GUTTER = { left: 128, right: 40, top: 12, bottom: 32 };
const desktopRoom = () => ({ w: window.innerWidth, h: Math.max(300, window.innerHeight - 136) });
const fitTo = (want, room) => ({
  w: Math.max(MIN_W, Math.min(want.w, room.w - GUTTER.left - GUTTER.right)),
  h: Math.max(MIN_H, Math.min(want.h, room.h - GUTTER.top - GUTTER.bottom)),
});

// Where a window goes when nobody has said otherwise: past the icon column, and
// sitting in the middle of the height rather than pinned under the menu bar,
// which is what made the first version look like a panel stuck to the top of a
// page. `slot` staggers the second and third window off the first.
const placeIn = (size, room, slot) => ({
  x: Math.max(8, Math.min(GUTTER.left + slot * 26, room.w - size.w - 8)),
  y: Math.max(8, Math.min(Math.round((room.h - size.h) / 2) + slot * 22, room.h - size.h - 8)),
});

export function useWindows() {
  const [wins, setWins] = useState([]);
  const [top, setTop] = useState(10);

  const open = useCallback((id, opts = {}) => {
    setTop(z => {
      const next = z + 1;
      setWins(prev => {
        const already = prev.find(w => w.id === id);
        if (already) return prev.map(w => (w.id === id ? { ...w, minimized: false, z: next, ...opts } : w));
        const room = desktopRoom();
        const want = { w: opts.w || 1040, h: opts.h || 680 };
        const size = fitTo(want, room);
        const slot = prev.length % 5;
        return [...prev, {
          id,
          title: opts.title || id,
          ...opts,
          ...placeIn(size, room, slot),
          ...size,
          want,
          slot,
          // Set the moment somebody drags or resizes it. Until then the window
          // belongs to the layout and a viewport change re-places it; after it,
          // it belongs to whoever put it there and nothing moves it but them.
          placed: false,
          minimized: false,
          maximized: false,
          z: next,
        }];
      });
      return next;
    });
  }, []);

  const focus = useCallback(id => {
    setTop(z => {
      const next = z + 1;
      setWins(prev => prev.map(w => (w.id === id ? { ...w, z: next } : w)));
      return next;
    });
  }, []);

  const close = useCallback(id => setWins(prev => prev.filter(w => w.id !== id)), []);
  const minimize = useCallback(id => setWins(prev => prev.map(w => (w.id === id ? { ...w, minimized: true } : w))), []);
  const maximize = useCallback(id => setWins(prev => prev.map(w => {
    if (w.id !== id) return w;
    return w.maximized
      ? { ...w, maximized: false, ...(w.before || {}) }
      : { ...w, maximized: true, before: { x: w.x, y: w.y, w: w.w, h: w.h } };
  })), []);
  const move = useCallback((id, x, y) => setWins(prev => prev.map(w => (w.id === id
    ? { ...w, placed: true, x: Math.max(0, Math.min(x, window.innerWidth - 120)), y: Math.max(0, Math.min(y, window.innerHeight - 60)) }
    : w))), []);
  const resize = useCallback((id, width, height) => setWins(prev => prev.map(w => (w.id === id
    ? {
      ...w,
      placed: true,
      w: Math.max(MIN_W, width),
      h: Math.max(MIN_H, height),
      want: { w: Math.max(MIN_W, width), h: Math.max(MIN_H, height) },
    }
    : w))), []);

  useEffect(() => {
    const fit = () => {
      const room = desktopRoom();
      setWins(prev => prev.map(win => {
        const want = win.want || { w: win.w, h: win.h };
        const size = fitTo(want, room);
        // A window nobody has moved goes back where the layout would put it —
        // otherwise a window opened on a narrow screen keeps the cramped corner
        // it was given and sits on top of the icon column for the rest of the
        // session. One that has been placed by hand only gets pulled back on
        // screen, never rearranged.
        if (!win.placed) return { ...win, ...size, ...placeIn(size, room, win.slot || 0) };
        return {
          ...win,
          ...size,
          x: Math.max(8, Math.min(win.x, room.w - size.w - 8)),
          y: Math.max(8, Math.min(win.y, room.h - size.h - 8)),
        };
      }));
    };
    window.addEventListener('resize', fit);
    const settle = setTimeout(fit, 250);
    return () => { window.removeEventListener('resize', fit); clearTimeout(settle); };
  }, []);

  const toggle = useCallback(id => {
    setWins(prev => {
      const win = prev.find(item => item.id === id);
      if (!win) return prev;
      return prev.map(item => (item.id === id ? { ...item, minimized: !win.minimized } : item));
    });
    focus(id);
  }, [focus]);

  return { wins, open, close, focus, minimize, maximize, move, resize, toggle };
}

export function WindowFrame({ win, active, tone, onFocus, onClose, onMinimize, onMaximize, onMove, onResize, children }) {
  const drag = useRef(null);
  const size = useRef(null);

  const startDrag = event => {
    if (win.maximized || event.button === 2 || event.target.closest('button')) return;
    event.preventDefault();
    onFocus();
    drag.current = { dx: event.clientX - win.x, dy: event.clientY - win.y };
    const movePointer = next => drag.current && onMove(next.clientX - drag.current.dx, next.clientY - drag.current.dy);
    const end = () => {
      drag.current = null;
      window.removeEventListener('pointermove', movePointer);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', movePointer);
    window.addEventListener('pointerup', end);
  };

  const startResize = event => {
    event.preventDefault();
    event.stopPropagation();
    size.current = { x: event.clientX, y: event.clientY, w: win.w, h: win.h };
    const movePointer = next => size.current && onResize(
      size.current.w + next.clientX - size.current.x,
      size.current.h + next.clientY - size.current.y,
    );
    const end = () => {
      size.current = null;
      window.removeEventListener('pointermove', movePointer);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', movePointer);
    window.addEventListener('pointerup', end);
  };

  if (win.minimized) return null;

  const box = win.maximized
    ? { left: 8, top: 8, width: 'calc(100% - 16px)', height: 'calc(100% - 8px)' }
    : { left: win.x, top: win.y, width: win.w, height: win.h };

  return (
    <section
      className="window-frame"
      data-active={active ? 'true' : 'false'}
      data-kind={win.kind || 'window'}
      onPointerDown={onFocus}
      aria-label={win.title}
      style={{ ...box, zIndex: win.z, '--window-tone': tone }}
    >
      <header className="window-chrome" onPointerDown={startDrag} onDoubleClick={onMaximize}>
        <span className="window-chrome__place" />
        <span className="window-chrome__title" title={win.title}>{win.title}</span>
        <div className="window-chrome__controls">
          <WinButton label="Minimise" onClick={onMinimize} icon="minus" />
          <WinButton label={win.maximized ? 'Restore' : 'Fill the desktop'} onClick={onMaximize} icon={win.maximized ? 'restoreWindow' : 'maximize'} />
          <WinButton label="Close" onClick={onClose} icon="close" danger />
        </div>
      </header>

      <div className="window-frame__content">{children}</div>

      {!win.maximized && <div className="window-resize" onPointerDown={startResize} aria-hidden="true" />}
    </section>
  );
}

function WinButton({ label, onClick, icon, danger }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onPointerDown={event => event.stopPropagation()}
      onClick={onClick}
      className={`window-button ${danger ? 'window-button--danger' : ''}`}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}
