// Whose product this is.
//
// A hosting company sells this under their own name, so every word and every
// mark on a customer-facing surface is theirs rather than ours. The box hands
// the shell its brand before this bundle runs, in `window.__BRAND__`
// — a small script the server writes from the database, so changing a logo does
// not mean rebuilding anything.
//
// This file is the only reader of that global. It existed in two places before,
// with two different sets of field names and two different fallbacks, which is
// how a half-branded product ends up saying one thing on the login screen and
// another on the share page.
//
// Everything here is treated as untrusted. The box validates on the way in and
// is the real guard; this validates again on the way out, because the render
// site is the one place a bad value actually becomes a link somebody clicks or
// a colour that hides the interface. Neither layer is allowed to be the only
// one.

const NAME_LIMIT = 80;
const TAGLINE_LIMIT = 120;
// A support address is rendered as an anchor. http, https and mailto are the
// three schemes that mean "somewhere to get help"; `javascript:` is script and
// `data:` is a page somebody else wrote, and both would run on this origin
// where the session token lives.
const SAFE_SCHEME = /^(https?:|mailto:)/i;

function text(value, limit) {
  if (typeof value !== 'string') return '';
  // Control characters never render as anything and are how a single-line field
  // is used to fake a second line.
  const clean = value.replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  return clean.slice(0, limit);
}

function assetPath(value) {
  // A path on this box, or nothing. Not a URL: a logo fetched from somewhere
  // else tells that somebody the address of everyone who opens the sign-in
  // screen, and this product is sold to companies who would have to answer for
  // that.
  return typeof value === 'string' && /^\/brand\/(logo|icon|wallpaper)(\?[\w=.-]*)?$/.test(value) ? value : null;
}

function read() {
  const given = (typeof window !== 'undefined' && window.__BRAND__) || {};
  const name = text(given.name || given.label || given.brandName, NAME_LIMIT);
  const accent = typeof given.accent === 'string' ? given.accent.trim().slice(0, 40) : '';
  const supportUrl = text(given.supportUrl, 300);
  const supportEmail = text(given.supportEmail, 254);
  return {
    name,
    tagline: text(given.tagline, TAGLINE_LIMIT),
    accent,
    support: SAFE_SCHEME.test(supportUrl) ? supportUrl
      : supportEmail && supportEmail.includes('@') ? `mailto:${supportEmail}`
        : '',
    supportLabel: SAFE_SCHEME.test(supportUrl) ? (supportEmail || 'Get help') : supportEmail,
    logo: assetPath(given.logo),
    icon: assetPath(given.icon),
    wallpaper: assetPath(given.wallpaper),
    // Configured means a customer would see a difference. A box with only a
    // support address set is still, to the person looking at it, unbranded.
    configured: !!(name || assetPath(given.logo)),
  };
}

export const brand = read();

// Every neutral fallback in the product goes through here, so the answer to
// "what does an unbranded box say" is one list rather than a string typed into
// each screen. The words are plain and true on any box: this is a file product
// and the files are on this machine.
export const named = fallback => brand.name || fallback;

// The relative luminance of a hex colour, by the WCAG definition. Used for one
// decision and one only: whether text sitting on the accent should be white or
// near-black.
function luminance(hex) {
  const value = String(hex).replace('#', '');
  const full = value.length === 3 ? value.split('').map(c => c + c).join('') : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const channel = at => {
    const n = parseInt(full.slice(at, at + 2), 16) / 255;
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

const contrastRatio = (l1, l2) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

// Ink and its inverse, from tokens.css. Named here rather than read back out of
// the computed style because this runs before the first paint.
const INK = { hex: '#20231f', lum: luminance('#20231f') };
const PAPER = { hex: '#ffffff', lum: 1 };
// The canvas, which is the strictest light background in the product: every
// other one is nearer white, and dark text has an easier time the lighter the
// ground. Clear 4.5:1 here and the accent is legible as text everywhere.
const CANVAS = { hex: '#f5f3ed', lum: luminance('#f5f3ed') };

const darken = (hex, amount) => {
  const value = String(hex).replace('#', '');
  const full = value.length === 3 ? value.split('').map(c => c + c).join('') : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const channel = at => Math.round(parseInt(full.slice(at, at + 2), 16) * (1 - amount));
  return `#${[channel(0), channel(2), channel(4)].map(n => n.toString(16).padStart(2, '0')).join('')}`;
};

// The accent taken down in 5% steps until it is readable as text, and stopped at
// the first step that is — so a hosting company keeps as much of their own
// colour as the eye allows. --accent-strong was tried for this and only reaches
// 2.1:1 on a pale accent, because a fixed 76% toward black is a guess about a
// colour nobody has seen yet.
function inkOn(hex, backgroundLum) {
  for (let step = 0; step <= 20; step += 1) {
    const shade = darken(hex, step * 0.05);
    if (!shade) return null;
    const lum = luminance(shade);
    if (lum !== null && contrastRatio(lum, backgroundLum) >= 4.5) return shade;
  }
  return INK.hex;
}

const readAccent = root => {
  try { return String(getComputedStyle(root).getPropertyValue('--accent') || '').trim(); }
  catch { return ''; }
};

// Only a colour, and only one the browser agrees is a colour, is allowed to
// enter the design tokens. Anything else and the accent stays as it is, which
// is legible, rather than becoming a declaration that ends the rule early.
//
// And one value is derived rather than chosen: what colour text on the accent
// has to be. `--accent-contrast` was white, which is correct for the dark red
// this shipped with and wrong for any pale colour — a hoster who picks yellow
// gets white text on yellow, which is every primary button in the product
// unreadable. That is not a second theming system: the hosting company still
// sets one value, and this is the design system keeping the promise written at
// the top of tokens.css that everything stays legible around whatever they
// choose.
export function applyAccent(root = document.documentElement) {
  if (brand.wallpaper) root.style.setProperty('--wallpaper-image', `url("${brand.wallpaper}")`);
  else root.style.removeProperty('--wallpaper-image');
  // A white upload must still leave white desktop labels readable.
  root.style.setProperty('--wallpaper-scrim', brand.wallpaper ? 'rgba(0, 0, 0, 0.68)' : 'transparent');
  const usable = brand.accent && typeof CSS !== 'undefined' && CSS.supports && CSS.supports('color', brand.accent);
  if (usable) root.style.setProperty('--accent', brand.accent);

  // Both derived values come off whatever the accent actually turned out to be —
  // the hosting company's, the proof switch's, or the one this ships with —
  // rather than off the brand alone. An unbranded box has an accent too, and it
  // has to be legible for the same reason.
  const accent = usable ? brand.accent : readAccent(root);
  const lum = luminance(accent);
  if (lum !== null) {
    root.style.setProperty('--accent-contrast', contrastRatio(lum, INK.lum) >= contrastRatio(lum, PAPER.lum) ? INK.hex : PAPER.hex);
    const ink = inkOn(accent, CANVAS.lum);
    if (ink) root.style.setProperty('--accent-ink', ink);
  }
  return !!usable;
}
