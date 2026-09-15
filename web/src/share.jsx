// Sharing is a deliberate reach change with a role and a clock. The link is
// shown once because the box keeps only its hash; the screen makes that cost
// visible exactly when the person can still act on it.

import { useEffect, useId, useRef, useState } from 'react';
import { api } from './api.js';
import { Button, Field, Icon, Note, PLACES, StateCrossing, day, when } from './ui.jsx';

const WINDOWS = [
  ['1d', 'A day'],
  ['7d', 'A week'],
  ['30d', 'A month'],
  ['90d', 'Three months'],
];

function recipientLink(raw) {
  try {
    const upstream = new URL(raw, window.location.origin);
    const token = upstream.pathname.match(/^\/s\/([^/]+)$/)?.[1];
    return token ? new URL(`/share/${token}`, window.location.origin).toString() : raw;
  } catch {
    return raw;
  }
}

export function ShareSheet({ file, canCreate = true, unavailable = null, onClose, onChanged }) {
  const [role, setRole] = useState('view');
  const [expires, setExpires] = useState('7d');
  const [password, setPassword] = useState('');
  const [link, setLink] = useState(null);
  const [existing, setExisting] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = () => api.shares(file.id).then(setExisting).catch(() => setExisting([]));
  useEffect(() => { load(); /* the file id is the boundary */ }, [file.id]);

  const make = async () => {
    setBusy(true); setError(null);
    try {
      const out = await api.share(file.id, {
        role,
        expires_in: expires,
        ...(password ? { password } : {}),
      });
      setLink(recipientLink(out.url));
      setPassword('');
      await load();
      onChanged && onChanged();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const revokeAll = async () => {
    setBusy(true); setError(null);
    try {
      await api.unshare(file.id);
      setLink(null);
      await load();
      onChanged && onChanged();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    // Said out loud. It failed silently, and a person who pressed Copy and pasted
    // nothing is a person who thinks the link was never made.
    catch { setError('Your browser would not copy it. Select the address above and copy it yourself.'); }
  };

  const live = existing.filter(share => share.live);

  return (
    <Sheet title={`Give somebody a link`} eyebrow={file.name} onClose={onClose} tone={PLACES.shared.tone}>
      {error ? <Note tone="bad">{error}</Note> : null}

      {link ? (
        <div className="share-created">
          <Note tone="good">
            Here is the link. <strong>Copy it now</strong> — the box stores only a fingerprint of it, so this is the one time it can be shown. You can always make another.
          </Note>
          <div className="copy-field">
            <input readOnly value={link} aria-label="Share link" onFocus={event => event.target.select()} />
            <Button kind="solid" tone={PLACES.shared.tone} icon={copied ? 'check' : 'copy'} onClick={copy}>{copied ? 'Copied' : 'Copy link'}</Button>
          </div>
          <Button onClick={() => setLink(null)}>Make another</Button>
        </div>
      ) : canCreate ? (
        <>
          <StateCrossing from="private" to="shared">
            This makes a controlled way in. The file does not move into a Shared folder.
          </StateCrossing>

          <div className="share-section">
            <span className="control-label">What they can do</span>
            <div className="segmented" role="group" aria-label="Share role">
              {[['view', 'Look at it', 'eye'], ['download', 'Download it', 'download']].map(([value, label, icon]) => (
                <button key={value} type="button" aria-pressed={role === value} onClick={() => setRole(value)}>
                  <Icon name={icon} size={16} />{label}
                </button>
              ))}
            </div>
          </div>

          <div className="share-section">
            <span className="control-label">How long it works</span>
            <div className="segmented segmented--four" role="group" aria-label="Share expiry">
              {WINDOWS.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={expires === value} onClick={() => setExpires(value)}>{label}</button>
              ))}
            </div>
          </div>

          <Field
            label="Password (optional)"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={event => setPassword(event.target.value)}
            hint="Six characters or more. Ask for it in a different message than the link."
          />

          <Button kind="solid" tone={PLACES.shared.tone} icon="shared" onClick={make} disabled={busy || (password && password.length < 6)}>
            {busy ? 'Making the link…' : 'Make the link'}
          </Button>
        </>
      ) : (
        <p className="sheet-copy">{unavailable || 'Share links are not included in your plan; ask your provider about changing it.'}</p>
      )}

      {existing.length > 0 && (
        <section className="share-history">
          <div className="share-history__heading">
            <div><strong>{live.length} link{live.length === 1 ? '' : 's'} working</strong><span>{existing.length} made in total</span></div>
            {live.length > 0 && <Button kind="danger" onClick={revokeAll} disabled={busy}>Stop them all</Button>}
          </div>
          <div className="share-history__list">
            {existing.slice(0, 8).map(share => (
              <div key={share.id} className="share-row" data-live={share.live}>
                <span className="share-row__state"><Icon name={share.live ? 'check' : 'close'} size={13} /></span>
                <div>
                  <strong>{share.role === 'download' ? 'Download' : 'View'}{share.password_protected ? ' · password' : ''}</strong>
                  <span>{share.live ? `Works until ${day(share.expires_at)}` : share.revoked ? 'Stopped' : 'Expired'} · made {when(share.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </Sheet>
  );
}

// Sheets trap focus and return it to the control that opened them. That is as
// much part of the modal as its background: without it, keyboard focus remains
// active on controls behind a question the person has not answered yet.
export function Sheet({ title, eyebrow, tone, onClose, children, size = 'regular' }) {
  const dialog = useRef(null);
  const restore = useRef(null);
  const close = useRef(onClose);
  const titleId = useId();
  close.current = onClose;

  useEffect(() => {
    restore.current = document.activeElement;
    const box = dialog.current;
    const focusable = () => Array.from(box.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter(item => !item.hidden);
    const first = focusable()[0];
    first && first.focus();
    const keys = event => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) { event.preventDefault(); return; }
      const start = items[0];
      const end = items[items.length - 1];
      if (event.shiftKey && document.activeElement === start) { event.preventDefault(); end.focus(); }
      else if (!event.shiftKey && document.activeElement === end) { event.preventDefault(); start.focus(); }
    };
    window.addEventListener('keydown', keys);
    return () => {
      window.removeEventListener('keydown', keys);
      if (restore.current && document.contains(restore.current)) restore.current.focus();
    };
  }, []);

  return (
    <div className="sheet-backdrop" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <section
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`sheet sheet--${size}`}
        style={{ '--sheet-tone': tone || 'var(--accent)' }}
      >
        <header className="sheet__header">
          <div>{eyebrow ? <span>{eyebrow}</span> : null}<h2 id={titleId}>{title}</h2></div>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Close"><Icon name="close" size={17} /></button>
        </header>
        <div className="sheet__body">{children}</div>
      </section>
    </div>
  );
}
