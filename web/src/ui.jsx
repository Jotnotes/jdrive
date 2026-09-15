// The visible design system. Colour values live in tokens.css; this file owns
// the semantic vocabulary, icon geometry, and reusable controls. Keeping those
// decisions together prevents one screen from quietly inventing a fifth place
// or a second interaction language.

import { brand } from './brand.js';

export const T = {
  ink: 'var(--ink)',
  ink2: 'var(--ink-2)',
  ink3: 'var(--ink-3)',
  line: 'var(--line)',
  lineSoft: 'var(--line)',
  surface: 'var(--surface)',
  surface2: 'var(--surface-muted)',
  surface3: 'var(--surface-sunken)',
  accent: 'var(--accent)',
  accentSoft: 'var(--accent-soft)',
  danger: 'var(--danger)',
  radius: 'var(--radius-3)',
  shadow: 'var(--shadow-elevated)',
  shadowSoft: 'none',
  font: 'var(--font-sans)',
};

// A place always arrives as a word, a hue and a glyph. The glyphs are a single
// 24px, 1.75-stroke family; no colour is ever asked to carry meaning alone.
export const PLACES = {
  private: {
    key: 'private', label: 'My Files', hint: 'Only you', detail: 'Private to this account',
    tone: 'var(--private)', strong: 'var(--private-strong)', wash: 'var(--private-soft)', icon: 'private',
  },
  shared: {
    key: 'shared', label: 'Shared', hint: 'People with a link', detail: 'A role and an expiry',
    tone: 'var(--shared)', strong: 'var(--shared-strong)', wash: 'var(--shared-soft)', icon: 'shared',
  },
  public: {
    key: 'public', label: 'Public', hint: 'Open internet', detail: 'Anyone with the address',
    tone: 'var(--public)', strong: 'var(--public-strong)', wash: 'var(--public-soft)', icon: 'public',
  },
  trash: {
    key: 'trash', label: 'Trash', hint: 'Recoverable', detail: 'Until retention or Empty Trash',
    tone: 'var(--trash)', strong: 'var(--trash-strong)', wash: 'var(--trash-soft)', icon: 'trash',
  },
};
export const PLACE_ORDER = ['private', 'shared', 'public', 'trash'];

const paths = {
  private: <><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v2"/></>,
  shared: <><path d="M9.5 14.5 14.5 9.5"/><path d="M7.6 17.4 5.2 19.8a3.5 3.5 0 0 1-5-5l3.4-3.4a3.5 3.5 0 0 1 5 0" transform="translate(3 -1)"/><path d="m16.4 6.6 2.4-2.4a3.5 3.5 0 1 1 5 5l-3.4 3.4a3.5 3.5 0 0 1-5 0" transform="translate(-3 1)"/></>,
  public: <><circle cx="12" cy="12" r="9"/><path d="M3.5 12h17M12 3c2.4 2.5 3.4 5.5 3.4 9S14.4 18.5 12 21c-2.4-2.5-3.4-5.5-3.4-9S9.6 5.5 12 3Z"/></>,
  trash: <><path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7"/></>,
  folder: <><path d="M3 7.5h7l2 2h9v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M3 9.5V6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v1.5"/></>,
  file: <><path d="M6 2.5h8l4 4V21H6Z"/><path d="M14 2.5v5h4M9 12h6M9 16h5"/></>,
  add: <><path d="M12 5v14M5 12h14"/></>,
  newFolder: <><path d="M3 8h7l2 2h9v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><path d="M16 3v6M13 6h6"/></>,
  compact: <><rect x="3" y="4" width="7" height="6" rx="1"/><rect x="14" y="4" width="7" height="6" rx="1"/><rect x="3" y="14" width="7" height="6" rx="1"/><rect x="14" y="14" width="7" height="6" rx="1"/></>,
  gallery: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="1.5"/><path d="m4 18 5-5 3 3 3-4 5 6"/></>,
  open: <><path d="M7 17 17 7M9 7h8v8"/><path d="M18 14v5H5V6h5"/></>,
  download: <><path d="M12 3v12M7 10l5 5 5-5M5 20h14"/></>,
  publish: <><path d="M12 20V6M7 11l5-5 5 5"/><path d="M5 20h14"/></>,
  unpublish: <><path d="M12 4v14M7 9l5-5 5 5"/><path d="M5 18h14"/></>,
  move: <><path d="M4 7h7l2 2h7v10H4Z"/><path d="m11 13 2-2 2 2M13 11v5"/></>,
  restore: <><path d="M5 8v5h5M6.2 11A7 7 0 1 0 8 6"/></>,
  rename: <><path d="m4 20 4.2-1 10.6-10.6a2 2 0 0 0-2.8-2.8L5.4 16.2ZM14.5 7.1l2.8 2.8"/></>,
  copy: <><rect x="8" y="8" width="11" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h3"/></>,
  // A key needs its own glyph. `Icon` falls back silently on an unknown name,
  // so a heading with no icon of its own quietly wears somebody else's — which
  // is how three headings ended up with the wrong mark on 2026-09-07.
  key: <><circle cx="8" cy="12" r="4"/><path d="M12 12h9M18 12v4M15.5 12v3"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  close: <><path d="m6 6 12 12M18 6 6 18"/></>,
  minus: <path d="M5 12h14"/>,
  maximize: <rect x="4" y="4" width="16" height="16" rx="2"/>,
  restoreWindow: <><rect x="7" y="7" width="13" height="13" rx="2"/><path d="M7 17H4V4h13v3"/></>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  back: <path d="m15 5-7 7 7 7"/>,
  list: <><path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></>,
  warning: <><path d="M12 3 2.8 20h18.4Z"/><path d="M12 9v5M12 17.5h.01"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  eye: <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
  arrow: <path d="M5 12h14M14 7l5 5-5 5"/>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/></>,
  search: <><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></>,
};

export function Icon({ name, size = 18, className = '', ...rest }) {
  return (
    <svg
      aria-hidden="true"
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {paths[name] || paths.file}
    </svg>
  );
}

// The built-in mark: the JotNotes house mark (docs/brand/jotnotes-jn-mark.svg),
// letters drawn as a path. It is what an unbranded box shows. The file's label is
// left out on purpose: the shell must not carry the product's name (audit G2.5),
// and the mark is decorative, with the box's name beside it as text.
export function Mark({ size = 34 }) {
  return (
    <span className="brand-mark" style={{ '--mark-size': `${size}px` }} aria-hidden="true">
      <svg width={size} height={size} viewBox="-100 -76 690 690">
        <path fill="currentColor" d="M82 92H236V132H220V328C220 407 178 446 120 446C67 446 38 416 38 365H91C91 391 102 405 123 405C151 405 167 386 167 330V144H82ZM194 92H246L394 324V92H452V446H401L252 215V446H194Z"/>
      </svg>
    </span>
  );
}

// The hosting company's logo where they have set one, the built-in mark where
// they have not. Every surface that shows a mark uses this, so a half-configured
// box cannot end up branded on one screen and generic on the next.
//
// The image is decorative: the company's name is beside it as text on every
// surface that uses this, so an alt string here would be the same words twice to
// a screen reader.
export function BrandMark({ size = 34 }) {
  if (!brand.logo) return <Mark size={size} />;
  return (
    <span className="brand-mark brand-mark--logo" style={{ '--mark-size': `${size}px` }}>
      <img src={brand.logo} alt="" width={size} height={size} />
    </span>
  );
}

export function Button({ kind = 'quiet', tone, icon, children, className = '', style, ...rest }) {
  return (
    <button
      {...rest}
      className={`button button--${kind} ${className}`}
      style={{ ...(tone ? { '--button-tone': tone } : {}), ...style }}
    >
      {icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ label, icon, pressed, className = '', ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      className={`icon-button ${className}`}
      {...rest}
    >
      <Icon name={icon} size={17} />
    </button>
  );
}

export function Field({ label, hint, className = '', ...rest }) {
  return (
    <label className={`field ${className}`}>
      <span className="field__label">{label}</span>
      <input {...rest} className="field__input" />
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function Note({ tone = 'quiet', children, className = '' }) {
  if (!children) return null;
  const icon = tone === 'bad' ? 'warning' : tone === 'good' ? 'check' : 'info';
  return (
    <div className={`note note--${tone} ${className}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon name={icon} size={17} />
      <div>{children}</div>
    </div>
  );
}

export function PlaceMark({ place, compact = false }) {
  const p = typeof place === 'string' ? PLACES[place] : place;
  return (
    <span className={`place-mark ${compact ? 'place-mark--compact' : ''}`} style={{ '--place': p.tone, '--place-soft': p.wash }}>
      <Icon name={p.icon} size={compact ? 13 : 16} />
      <span>{p.label}</span>
    </span>
  );
}

export function StateCrossing({ from = 'private', to, children }) {
  const a = PLACES[from];
  const b = PLACES[to];
  return (
    <div className="state-crossing" style={{ '--from': a.tone, '--from-soft': a.wash, '--to': b.tone, '--to-soft': b.wash }}>
      <div className="state-crossing__route" aria-label={`${a.label} to ${b.label}`}>
        <PlaceMark place={a} />
        <span className="state-crossing__line"><Icon name="arrow" size={16} /></span>
        <PlaceMark place={b} />
      </div>
      {children ? <div className="state-crossing__copy">{children}</div> : null}
    </div>
  );
}

// A long base is the expendable part. The extension always remains visible,
// producing invoice-2026-…-v2.pdf rather than invoice-2026-03-acme-final…
export function FileName({ name, className = '' }) {
  const text = String(name || '');
  const at = text.lastIndexOf('.');
  const hasExtension = at > 0 && at < text.length - 1;
  const base = hasExtension ? text.slice(0, at) : text;
  const extension = hasExtension ? text.slice(at) : '';
  return (
    <span className={`file-name ${className}`} title={text}>
      <span className="file-name__base">{base}</span>
      {extension ? <span className="file-name__extension">{extension}</span> : null}
    </span>
  );
}

export function makeDragImage(event, label, count = 1, icon = 'file') {
  const badge = document.createElement('div');
  badge.className = 'drag-badge';
  badge.textContent = count > 1 ? `${count} files` : label;
  badge.dataset.kind = icon;
  document.body.appendChild(badge);
  event.dataTransfer.setDragImage(badge, 18, 18);
  setTimeout(() => badge.remove(), 0);
}

export const bytes = n => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(0)} KB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
  if (v < 1024 ** 4) return `${(v / 1024 ** 3).toFixed(2)} GB`;
  return `${(v / 1024 ** 4).toFixed(2)} TB`;
};

const asDate = iso => {
  const text = String(iso || '');
  return new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
};

export const day = iso => {
  const t = asDate(iso);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

// The same question asked of a list where several entries share a day. `when`
// answers "today" for all of them, which is the right answer for a file that was
// added once and the wrong one for a history somebody is reading in order to
// pick the state from before lunch. Time, and the date too once it is not today.
export const moment = iso => {
  if (!iso) return '';
  const t = asDate(iso);
  if (Number.isNaN(t.getTime())) return '';
  const clock = t.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const days = Math.round((Date.now() - t.getTime()) / 86400000);
  if (days === 0) return `today at ${clock}`;
  if (days === 1) return `yesterday at ${clock}`;
  return `${day(iso)} at ${clock}`;
};

export const when = iso => {
  if (!iso) return '';
  const t = asDate(iso);
  if (Number.isNaN(t.getTime())) return '';
  const days = Math.round((Date.now() - t.getTime()) / 86400000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days === -1) return 'tomorrow';
  if (days > 1 && days < 30) return `${days} days ago`;
  if (days < -1 && days > -30) return `in ${Math.abs(days)} days`;
  return day(iso);
};
