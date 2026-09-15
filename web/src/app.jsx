// The desktop is deliberately quiet: a work surface with things lying on it, one
// file window that does not cover it, and previews that can sit beside it. The
// memorable movement happens inside the product when reach changes, not in
// wallpaper decoration.
//
// This file owns what the desktop *is*; `desktop.jsx` owns what is on it and the
// rules a drag has to obey to cross a place.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, saveFile, session, whenSignedOut } from './api.js';
import { AuthScreen } from './auth.jsx';
import { FilesApp, PublishSheet } from './files.jsx';
import { DesktopSurface, dropRuleFor } from './desktop.jsx';
import { carriesFiles, draggedFiles } from './drag.js';
import { Preview } from './preview.jsx';
import { SharedFileScreen } from './share-recipient.jsx';
import { Console } from './console.jsx';
import { brand, named } from './brand.js';
import { BrandMark, Icon, PLACES, PLACE_ORDER } from './ui.jsx';
import { WindowFrame, useWindows } from './windows.jsx';
import { hosting } from './edition.js';
import { planCapabilities } from './fileview.js';

export default function App() {
  const shared = window.location.pathname.match(/^\/share\/([^/]+)$/);
  if (shared) return <SharedFileScreen token={shared[1]} />;
  return <AccountApp />;
}

function AccountApp() {
  const path = window.location.pathname;
  const token = new URLSearchParams(window.location.search).get('token');
  const [me, setMe] = useState(null);
  const [checked, setChecked] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    whenSignedOut(() => setMe(null));
    (async () => {
      // A one-time link from a hosting company's portal is spent before anything
      // else asks who is signed in, so the account it opens is the one that loads.
      if (hosting && hosting.signInFromLink) {
        const outcome = await hosting.signInFromLink();
        if (outcome && outcome.error) setNotice(outcome.error);
      }
      if (!session.token) { setChecked(true); return; }
      api.me().then(setMe).catch(() => session.set(null)).finally(() => setChecked(true));
    })();
  }, []);

  const signOut = () => { api.signOut().catch(() => {}); session.set(null); setMe(null); };

  if (path === '/password-reset' && token) return <AuthScreen mode="reset" token={token} />;
  if (path === '/verify-email' && token) return <AuthScreen mode="confirm" token={token} />;
  if (!checked) return <div className="app-loading" aria-label="Opening your files"><span /></div>;
  // Who you are is asked of the box, never read off the sign-in reply. That
  // reply carries a name and an address and no role, so adopting it signed a
  // hosting company in as somebody with no console — they landed on a file
  // manager with no route to the thing they had bought until they reloaded.
  // One producer of identity, so there is nothing for a second one to contradict.
  if (!me) return <AuthScreen mode="signin" notice={notice} onSignedIn={() => api.me().then(setMe).catch(() => session.set(null))} />;
  // The console belongs to whoever sells this. An end user who types the address
  // gets their own files instead: there is nothing there for them, and a refusal
  // would only tell them something exists.
  // A borrowed session must never be able to pass for an ordinary one. The
  // banner is drawn above every screen — the desktop and the console both —
  // because the failure this guards against is somebody forgetting whose files
  // they are looking at and typing as if they were their own.
  const borrowed = me.impersonated_by ? (
    <Borrowed me={me} onEnded={() => {
      // Back to their own account if it is still there, and to the sign-in screen
      // if it is not, rather than to a console that would answer 401 to everything.
      window.location.href = session.resume() ? '/console' : '/';
    }} />
  ) : null;

  if (path === '/console' && me.role && me.role !== 'end_user') {
    return <>{borrowed}<Console me={me} onLeave={() => { window.location.href = '/'; }} onSignOut={signOut} /></>;
  }
  return <>{borrowed}<Desktop me={me} onSignOut={signOut} /></>;
}

// Whose account this is, said plainly and impossible to miss.
//
// It names the customer rather than the person borrowing the account, because
// that is the fact that matters at the moment somebody is about to act: not "you
// are Steve" but "everything you do here happens to Iris". It also says what the
// session cannot do, so a refusal further in reads as the design rather than as
// the product being broken.
function Borrowed({ me, onEnded }) {
  const [ending, setEnding] = useState(false);
  const end = async () => {
    setEnding(true);
    // Only a Hosting box lends a session, and a Community box refuses one that
    // outlived its Hosting edition before this screen is ever drawn.
    try { if (hosting) await hosting.endImpersonation(); } catch { /* the session is going either way */ }
    onEnded();
  };
  return (
    <div className="borrowed" role="status">
      <span className="borrowed__mark" aria-hidden="true" />
      <p className="borrowed__what">
        You are signed in as <strong>{me.name || me.email}</strong>. Anything you do happens to their
        account. Their files stay theirs: you cannot open, publish or link to one.
      </p>
      <button type="button" className="borrowed__end" onClick={end} disabled={ending}>
        {ending ? 'Ending…' : 'Back to my own account'}
      </button>
    </div>
  );
}

function Desktop({ me, onSignOut }) {
  const { wins, open, close, focus, minimize, maximize, move, resize, toggle } = useWindows();
  const [place, setPlace] = useState('private');
  const [refresh, setRefresh] = useState(0);
  const [publishing, setPublishing] = useState(null);
  const [status, setStatus] = useState({ counts: null, usage: null });
  const [capabilities, setCapabilities] = useState(null);
  const changed = useCallback(() => setRefresh(n => n + 1), []);

  useEffect(() => {
    let alive = true;
    setCapabilities(null);
    api.entitlements(me.id)
      .then(report => { if (alive) setCapabilities(planCapabilities(report && report.metrics)); })
      .catch(() => { /* An unknown allowance is not presented as an available action. */ });
    return () => { alive = false; };
  }, [me.id]);

  // Opened at a size that leaves wallpaper on every side. A window that fills the
  // screen is a web app with a left-hand nav; the desktop has to be visible for
  // anything on it to be discovered. It got smaller again when the place rail
  // came out, because the window no longer has to carry a navigation. Fill is
  // still one click away.
  useEffect(() => { open('files', { title: 'My Files', w: 940, h: 620, kind: 'files' }); }, [open]);

  const openFile = useCallback(file => {
    open(`file:${file.id}`, { title: file.name, w: 780, h: 580, file, kind: 'preview' });
  }, [open]);

  const trashFiles = useCallback(ids => {
    // Several files can be refused for different reasons; the Trash is
    // reversible either way, so the list is settled and the view catches up.
    Promise.allSettled(ids.map(id => api.trash(id))).then(changed);
  }, [changed]);

  // The sheet names the files it is about, so the drop asks the box which ones
  // they were. Only when somebody actually drops on Public: nothing is fetched
  // to keep a list warm for a gesture most people never make.
  const publishIds = useCallback(ids => {
    if (!capabilities || !capabilities.publicFiles) return;
    api.files()
      .then(rows => rows.filter(file => ids.includes(file.id) && file.place !== 'public'))
      .then(rows => { if (rows.length) setPublishing(rows); })
      .catch(() => {});
  }, [capabilities]);

  // Hands back what arrived, so the desktop can put an icon for it where it was
  // dropped. It used to be thrown away, and a file dropped on the desktop went to
  // My Files with nothing to show on the desktop it was dropped on.
  const uploadHere = useCallback(list => api.upload(list, undefined, 'root')
    .then(rows => { changed(); return Array.isArray(rows) ? rows : []; })
    .catch(() => []), [changed]);

  const goPlace = useCallback(nextPlace => {
    setPlace(nextPlace);
    open('files', { title: PLACES[nextPlace].label, kind: 'files' });
  }, [open]);

  return (
    <div className="desktop">
      <TopBar
        me={me}
        onSignOut={onSignOut}
        usage={status.usage}
        onOpenFiles={() => open('files', { title: PLACES[place].label, kind: 'files' })}
      />

      <div className="desktop__stage">
        <DesktopSurface
          accountKey={String(me.id || me.email || 'account')}
          refreshToken={refresh}
          onOpenFile={openFile}
          onUpload={uploadHere}
        />

        {wins.map(win => (
          <WindowFrame
            key={win.id}
            win={win}
            active={win.z === Math.max(...wins.filter(item => !item.minimized).map(item => item.z))}
            tone={win.id === 'files' ? PLACES[place].tone : 'var(--accent)'}
            onFocus={() => focus(win.id)}
            onClose={() => close(win.id)}
            onMinimize={() => minimize(win.id)}
            onMaximize={() => maximize(win.id)}
            onMove={(x, y) => move(win.id, x, y)}
            onResize={(w, h) => resize(win.id, w, h)}
          >
            {win.id === 'files' ? (
              <FilesApp
                place={place}
                borrowed={!!me.impersonated_by}
                capabilities={capabilities}
                refreshToken={refresh}
                onChanged={changed}
                onOpen={openFile}
                onStatus={setStatus}
              />
            ) : win.file ? (
              <Preview file={win.file} onDownload={() => saveFile(win.file).catch(() => {})} />
            ) : null}
          </WindowFrame>
        ))}
      </div>

      <Dock
        place={place}
        onPlace={goPlace}
        open={wins.some(w => w.id === 'files' && !w.minimized)}
        onToggle={() => {
          const filesWindow = wins.find(win => win.id === 'files');
          if (filesWindow) toggle('files');
          else open('files', { title: PLACES[place].label, kind: 'files' });
        }}
        onTrashFiles={trashFiles}
        onPublishFiles={publishIds}
        counts={status.counts}
        minimized={wins.filter(win => win.minimized)}
        onRestore={id => toggle(id)}
      />

      {/* A file dropped on Public has asked a question, not answered one. This
          is the same sheet the Publish button opens, and it is the sheet that
          says publishing is a reach change rather than a move into a folder. */}
      {publishing && publishing.length > 0 && (
        <PublishSheet
          files={publishing}
          onClose={() => setPublishing(null)}
          onPublish={remove => {
            const targets = publishing;
            setPublishing(null);
            return Promise.allSettled(targets.map(file => api.publish(file.id, {
              exif: remove.exif.includes(file.id), xmp: remove.xmp.includes(file.id),
            }))).then(changed);
          }}
        />
      )}
    </div>
  );
}

// A menu bar, not a product header. The brand sits where the Apple menu sits and
// the right-hand end carries status: where the bytes are, how full the account
// is, the time, and who is signed in. The clock is doing more work than it looks
// — it is the single strongest signal that this bar belongs to a machine rather
// than to a web page.
function TopBar({ me, onSignOut, onOpenFiles, usage }) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;
    const close = event => { if (!menuRef.current || !menuRef.current.contains(event.target)) setMenu(false); };
    const esc = event => { if (event.key === 'Escape') setMenu(false); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', esc); };
  }, [menu]);

  return (
    <header className="top-bar">
      <button type="button" className="top-bar__brand" onClick={onOpenFiles} aria-label="Open Files" title="Open Files">
        <BrandMark size={24} /><span>{named('Files')}</span>
      </button>
      <div className="top-bar__status"><span className="status-dot" />Stored on this box</div>
      <div className="top-bar__spacer" />
      <StorageStatus usage={usage} />
      <Clock />
      <div className="account-menu" ref={menuRef}>
        <button
          type="button"
          className="account-menu__trigger"
          onClick={() => setMenu(v => !v)}
          aria-haspopup="menu"
          aria-expanded={menu}
        >
          <span className="account-menu__avatar" aria-hidden="true">{String(me.name || me.email || '?').slice(0, 1).toUpperCase()}</span>
          <span className="account-menu__name">{me.name || me.email}</span>
          <Icon name="chevron" size={13} />
        </button>
        {menu && (
          <div className="account-menu__panel" role="menu">
            <div className="account-menu__identity">
              <strong>{me.name || 'Account'}</strong>
              <span>{me.email}</span>
              {me.role ? <span>{String(me.role).replace(/_/g, ' ')}</span> : null}
            </div>
            {me.role && me.role !== 'end_user' && (
              <a role="menuitem" href="/console">Console</a>
            )}
            {/* Support is the hosting company's, never ours. A customer with a
                problem goes to whoever sold them this, which is the same rule as
                billing, mail and everything else on this box. */}
            {brand.support && (
              <a role="menuitem" href={brand.support} rel="noreferrer">Get help</a>
            )}
            <button type="button" role="menuitem" onClick={onSignOut}>Sign out</button>
          </div>
        )}
      </div>
    </header>
  );
}

// The storage meter used to be a panel in the corner of the Files window. It is
// true of the account rather than of that window, so it belongs on the bar that
// is always there — and a menu bar with a meter in it is a machine, where a
// panel inside a window is a dashboard.
function StorageStatus({ usage }) {
  if (!usage) return null;
  const percent = usage.unlimited ? 0 : Math.min(100, Number(usage.percent_used || 0));
  const label = usage.unlimited
    ? `${usage.used_human} used, no limit`
    : `${usage.used_human} of ${usage.limit_human} used${usage.trash_bytes > 0 ? `, ${usage.trash_human} of it in the Trash` : ''}`;
  return (
    <div className="top-status" title={label} aria-label={label}>
      <span className="top-status__bar" aria-hidden="true" data-full={percent >= 90 ? 'true' : undefined}>
        <span style={{ width: `${usage.unlimited ? 0 : percent}%` }} />
      </span>
      <span className="top-status__text">{usage.used_human}{usage.unlimited ? '' : ` of ${usage.limit_human}`}</span>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    // On the minute, not every thirty seconds into it. A clock that changes at
    // an arbitrary moment is a clock somebody wrote in a hurry.
    let timer = null;
    const tick = () => {
      setNow(new Date());
      timer = setTimeout(tick, 60000 - (Date.now() % 60000));
    };
    timer = setTimeout(tick, 60000 - (Date.now() % 60000));
    return () => clearTimeout(timer);
  }, []);
  const day = now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return <time className="top-clock" dateTime={now.toISOString()}>{day}  {time}</time>;
}

// The dock: the utility belt, and the only navigation that is never covered up.
// It sits above every window; the wallpaper sits under them. That is why the four
// places live here and not on the desktop — navigation you can hide behind a
// window is not navigation, and having both was the same four icons twice.
//
// It is not a set of folders. The two drops it takes perform an act rather than
// filing anything: the Trash deletes, and Public asks the publish question.
// Shared and My Files refuse and say why. `dropRuleFor` is the one place that
// decides.
//
// Telescopic by default, lockable from the dock's own context menu. The
// magnification is computed from the un-magnified geometry, anchored on the
// dock's centre: measuring from the live layout would feed the scale back into
// the positions it was derived from and the whole belt would shiver.
const DOCK_BASE = 54;
const DOCK_GAP = 2;
// A magnification you have to look for is not a magnification. The cell nearest
// the pointer reaches twice its resting size, and the reach is wide enough that
// two neighbours move with it — one icon growing on its own reads as a hover
// state, and three moving together reads as a belt.
const DOCK_AMP = 1;
const DOCK_REACH = 140;
const DOCK_PREFS = 'files.dock';

const readDockPrefs = () => {
  try {
    const raw = window.localStorage.getItem(DOCK_PREFS);
    const parsed = raw ? JSON.parse(raw) : null;
    return { magnify: !parsed || parsed.magnify !== false };
  } catch { return { magnify: true }; }
};

function Dock({ place, onPlace, open, onToggle, onTrashFiles, onPublishFiles, counts, minimized, onRestore }) {
  const belt = useRef(null);
  const [over, setOver] = useState(null);
  const [at, setAt] = useState(null);
  const [menu, setMenu] = useState(null);
  const [prefs, setPrefs] = useState(readDockPrefs);
  const refusal = over && !over.ok ? dropRuleFor(over.key).reason : null;

  useEffect(() => {
    try { window.localStorage.setItem(DOCK_PREFS, JSON.stringify(prefs)); } catch { /* storage off */ }
  }, [prefs]);

  // The same guard the desktop icons carry: whatever the browser does with
  // dragleave, the end of a drag takes the refusal off the screen.
  useEffect(() => {
    if (!over) return undefined;
    const clear = () => setOver(null);
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => { window.removeEventListener('dragend', clear); window.removeEventListener('drop', clear); };
  }, [over]);

  useEffect(() => {
    if (!menu) return undefined;
    const away = event => { if (!event.target.closest('.dock-menu')) setMenu(null); };
    const esc = event => { if (event.key === 'Escape') setMenu(null); };
    window.addEventListener('pointerdown', away);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', esc); };
  }, [menu]);

  const items = [
    ...PLACE_ORDER.map(key => ({ kind: 'place', key, place: PLACES[key] })),
    ...(minimized.length ? [{ kind: 'divider', key: 'divider' }] : []),
    ...minimized.map(win => ({ kind: 'window', key: win.id, win })),
  ];

  // Somebody who has asked for less movement gets none of this.
  const still = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const live = prefs.magnify && !still && at !== null;

  const scaleOf = index => {
    if (!live) return 1;
    const cells = items.filter(item => item.kind !== 'divider').length;
    const width = cells * DOCK_BASE + (items.length - 1) * DOCK_GAP;
    const seat = items.slice(0, index).filter(item => item.kind !== 'divider').length;
    const centre = at.mid - width / 2 + seat * (DOCK_BASE + DOCK_GAP) + DOCK_BASE / 2;
    const near = Math.max(0, 1 - Math.abs(at.x - centre) / DOCK_REACH);
    return 1 + DOCK_AMP * near * near;
  };

  const track = event => {
    if (!prefs.magnify || still) return;
    const box = belt.current.getBoundingClientRect();
    setAt({ x: event.clientX, mid: box.left + box.width / 2 });
  };

  return (
    <nav
      className="dock"
      aria-label="Dock"
      ref={belt}
      data-magnifying={live ? 'true' : undefined}
      onPointerMove={track}
      onPointerLeave={() => setAt(null)}
      onContextMenu={event => { event.preventDefault(); setMenu(true); }}
    >
      {refusal && <p className="dock__refusal" role="status">{refusal}</p>}

      {menu && (
        <div className="dock-menu" role="menu" aria-label="Dock settings">
          <button type="button" role="menuitemradio" aria-checked={prefs.magnify}
            onClick={() => { setPrefs({ magnify: true }); setMenu(null); }}>
            {prefs.magnify && <Icon name="check" size={12} />}<span>Telescopic</span>
          </button>
          <button type="button" role="menuitemradio" aria-checked={!prefs.magnify}
            onClick={() => { setPrefs({ magnify: false }); setAt(null); setMenu(null); }}>
            {!prefs.magnify && <Icon name="check" size={12} />}<span>Locked</span>
          </button>
        </div>
      )}

      {items.map((item, index) => {
        if (item.kind === 'divider') return <span key={item.key} className="dock__divider" aria-hidden="true" />;
        const scale = scaleOf(index);
        const style = { width: Math.round(DOCK_BASE * scale), '--s': scale };

        if (item.kind === 'window') {
          return (
            <button
              type="button"
              key={item.key}
              className="dock__item dock__item--window"
              data-label={item.win.title}
              aria-label={`Restore ${item.win.title}`}
              style={style}
              onClick={() => onRestore(item.win.id)}
            >
              <span className="dock__icon"><Icon name={item.win.kind === 'files' ? 'folder' : 'file'} size={22} /></span>
              <span className="dock__indicator" data-parked="true" />
            </button>
          );
        }

        const { key } = item;
        const p = item.place;
        const on = key === place && open;
        const rule = dropRuleFor(key);
        return (
          <button
            type="button"
            key={key}
            aria-label={`${p.label} — ${p.hint}`}
            aria-current={on ? 'page' : undefined}
            onClick={() => (key === place && open ? onToggle() : onPlace(key))}
            className="dock__item"
            data-label={`${p.label} — ${p.hint}`}
            data-over={over && over.key === key ? (over.ok ? 'yes' : 'no') : undefined}
            style={{ ...style, '--place': p.tone, '--place-soft': p.wash }}
            onDragOver={event => {
              if (!carriesFiles(event)) return;
              if (rule.accepts) event.preventDefault();
              setOver({ key, ok: rule.accepts });
            }}
            onDragLeave={() => setOver(current => (current && current.key === key ? null : current))}
            onDrop={event => {
              setOver(null);
              if (!rule.accepts || !carriesFiles(event)) return;
              event.preventDefault();
              const ids = draggedFiles(event);
              if (!ids.length) return;
              if (key === 'trash') onTrashFiles(ids); else onPublishFiles(ids);
            }}
          >
            <span className="dock__icon"><Icon name={p.icon} size={22} /></span>
            {/* Printed only where the dock has to be the whole navigation, which
                is any screen too small for a desktop. Above that the name is a
                hover bubble, because docks do not label themselves. */}
            <span className="dock__label">{p.label}</span>
            {counts && counts[key] > 0 && <span className="dock__count">{counts[key]}</span>}
            <span className="dock__indicator" />
          </button>
        );
      })}
    </nav>
  );
}
