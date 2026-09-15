'use strict';

// Whose product this is.
//
// JotNotes JDrive is sold by hosting companies under their own name. Nobody buys it
// from us, nobody has heard of us, and a customer who can work out whose software
// this is has been shown something their supplier did not want them to see. So
// this file holds the one brand a box carries, and everything that decides
// whether a value a hosting company typed is safe to put on a page, in a
// stylesheet, or in a mail header.
//
// ONE BRAND, PER BOX
//
// The hosting company owns the box, so the brand is theirs. A reseller sells one
// level down with the same machinery and under the same name; a brand of their
// own is deliberately not built, because it is a second product to support rather
// than a feature, and `DELIVERY_CONTRACTS.md` G1 says so.
//
// IT IS NOT SOLD
//
// There is no key for this in the sellable registry and there must never be one.
// Every other lever in the product is on and free until a hoster decides to
// charge for it; this one is not a lever at all. A hosting company who cannot put
// their own name on a white-label product has not bought one.
//
// EVERYTHING HERE IS UNTRUSTED
//
// The account that sets the brand is the most valuable one on the box, and it is
// still not trusted with the page. A brand is the only place in this product
// where text somebody typed reaches the page shell, the design tokens and a mail
// header, which is three injection surfaces in one feature. Each field is
// therefore narrowed to the smallest thing that can do its job:
//
//   a name       printable characters on one line, and escaped again on the way out
//   an accent    a hex colour, and nothing else, so it cannot end a declaration
//   a support
//   address      http, https or mailto, because `javascript:` is script and
//                `data:` is a page somebody else wrote, and both would run on the
//                origin where the session token lives
//   a logo       an image, decided by reading the first bytes rather than by
//                believing the Content-Type — and never an SVG, which is a
//                document with script in it wearing a picture's file extension
//
// None of it is a guess about what an attacker would try. Each one is the shape
// of a defect this codebase would otherwise have shipped.

const crypto = require('crypto');

const NAME_MAX = 80;
const TAGLINE_MAX = 120;
const URL_MAX = 300;
const EMAIL_MAX = 254;

// The three things a hoster uploads, and what each is for. A logo sits beside their
// name at up to about forty pixels tall; an app icon is a favicon. Neither needs
// to be large, and a cap is the difference between a brand and somewhere to park
// a file.
const KINDS = ['logo', 'icon', 'wallpaper'];
// A full desktop picture gets 100 times the logo budget: 25 MiB leaves room
// for a high-resolution background without turning branding into file storage.
const LIMITS = { logo: 256 * 1024, icon: 64 * 1024, wallpaper: 25 * 1024 * 1024 };

// Written with charCodeAt rather than a character-class escape because the escape
// for a control character is the kind of thing that is wrong in a way nobody can
// see by reading it. A newline in a name is not a typo: it is how a single-line
// field becomes a second mail header.
function printable(value) {
  return String(value == null ? '' : value)
    .split('')
    .filter(ch => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('');
}

const line = (value, limit) => printable(value).trim().slice(0, limit);

// A colour, and only a colour. Hex is narrower than CSS allows on purpose: the
// value ends up in `--accent`, and the whole design system is built on the
// promise at the top of tokens.css that a white-label deployment changes that one
// token and nothing else. A value that can carry a semicolon can carry a second
// declaration.
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:'];

function safeUrl(value) {
  let parsed = null;
  try { parsed = new URL(value); } catch { return false; }
  return SAFE_PROTOCOLS.includes(parsed.protocol);
}

const EMAIL = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

// What a hosting company is allowed to say about themselves. Throws with a
// sentence a person can act on, because the person reading it is the customer of
// this product and a refusal they cannot understand is a support call.
function readable(input) {
  const given = input || {};
  const name = line(given.name, NAME_MAX);
  const tagline = line(given.tagline, TAGLINE_MAX);
  const accent = line(given.accent, 40);
  if (accent && !HEX.test(accent)) {
    throw new Error('An accent is a hex colour, like #2f6f4f. One colour, so the rest of the interface stays legible around it.');
  }
  const supportUrl = line(given.supportUrl, URL_MAX);
  if (supportUrl && !safeUrl(supportUrl)) {
    throw new Error('A support address is an http, https or mailto link. Anything else runs as script in your customer’s browser.');
  }
  const supportEmail = line(given.supportEmail, EMAIL_MAX);
  if (supportEmail && !EMAIL.test(supportEmail)) {
    throw new Error('That does not look like an email address.');
  }
  return { name, tagline, accent, supportUrl, supportEmail };
}

// What kind of image this actually is, read from its first bytes.
//
// The Content-Type is what the uploader said, which on this route is what the
// most privileged account on the box said, and it is still not evidence. SVG is
// absent from this list and that is the point: an SVG is a document that can
// carry script, it would be served from this origin, and this origin is where the
// shell keeps its bearer token.
const SIGNATURES = [
  { mime: 'image/png', of: b => b.length > 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' },
  { mime: 'image/jpeg', of: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', of: b => b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8' },
  { mime: 'image/webp', of: b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
  { mime: 'image/x-icon', of: b => b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0 },
];

function imageType(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) return null;
  const found = SIGNATURES.find(signature => signature.of(bytes));
  return found ? found.mime : null;
}

// A short fingerprint of the current brand, put on the end of the asset
// addresses. index.html is served with no-cache and the assets with a long one,
// so without this a hoster who replaces their logo sees the old one until their
// browser gives up on it, decides it did not work, and does it again.
function stamp(row) {
  const r = row || {};
  return crypto.createHash('sha1')
    .update(`${r.updated_at || ''}|${r.logo_len || 0}|${r.icon_len || 0}|${r.wallpaper_len || 0}|${r.name || ''}`)
    .digest('hex')
    .slice(0, 12);
}

// What the world may see. Public on purpose and public to everybody: the sign-in
// screen and a shared link both have to know whose name is on them before anybody
// has signed in, so there is nothing here that is not already printed on the page.
function shown(row) {
  const r = row || {};
  const version = stamp(r);
  return {
    name: r.name || '',
    tagline: r.tagline || '',
    accent: r.accent || '',
    supportUrl: r.support_url || '',
    supportEmail: r.support_email || '',
    logo: r.logo_len ? `/brand/logo?v=${version}` : null,
    icon: r.icon_len ? `/brand/icon?v=${version}` : null,
    wallpaper: r.wallpaper_len ? `/brand/wallpaper?v=${version}` : null,
    // Configured means a customer would see a difference. A box with only a
    // support address set is, to the person looking at it, still unbranded.
    configured: !!(r.name || r.logo_len),
    version,
  };
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

// The name goes into a <title> and the accent into a meta attribute, so both go
// through here first. Without it a name of `</title><script>` is not a name, it
// is a script tag on the origin that holds the session token.
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
}

// The brand, as a script the shell can be handed before its own bundle runs.
//
// A separate file rather than an inline script, because the content security
// policy on this box does not allow inline script and that is a defence worth
// more than the round trip it costs. JSON is already valid JavaScript here; the
// two line separators are escaped because they were legal in JSON and illegal in
// JavaScript strings until 2019, and the closing angle sequence because a
// serialiser that is safe only where it happens to be used stops being safe when
// somebody moves it.
function bootstrap(brand) {
  const json = JSON.stringify(brand)
    .split('')
    .map(ch => {
      const code = ch.charCodeAt(0);
      return code === 0x2028 || code === 0x2029
        ? '\\u' + code.toString(16)
        : ch;
    })
    .join('')
    .split('</')
    .join('<\\/');
  return `window.__BRAND__ = ${json};\n`;
}

module.exports = {
  KINDS, LIMITS, NAME_MAX, TAGLINE_MAX, URL_MAX, EMAIL_MAX,
  printable, line, readable, safeUrl, imageType, stamp, shown, escapeHtml, bootstrap,
};
