'use strict';

// My Files, Public, Shared and Trash: the four places a file can be, and the
// fact that which one it is in is decided by the disk rather than by a column.
//
// This is the files product and the comparison is Dropbox. Nothing here knows
// what a website, a domain or a mailbox is, and nothing should learn.
//
// WHERE THE FOUR PLACES ACTUALLY ARE
//
//   My Files   uploads/<user>/private/     never served, by any route, ever
//   Public     uploads/<user>/published/   served by the panel, as bytes
//   Shared     still in private/, with a signed link against it
//   Trash      still where it was, with deleted_at set on the row
//
// `storageRoots` already owns the first two and has since before this product
// was scoped: `rootsFor` gives both directories, `crossesIntoPublic` answers
// whether a move reaches the open web, and `servedPathFor` is the gate the
// serving route asks so that "private files are never served" is a property of
// the layout rather than of one SQL query staying correct forever. Making a file
// public is moving it between those two directories. That is the whole feature.
//
// WHY THE STATE IS NOT A COLUMN
//
// Same reason as the storage model: a stored state can disagree with the disk,
// and the disagreement is silent and permanent. A move that half failed would
// leave a row saying private and a file being served to anybody who asks. So `placeOf` reads the disk path and answers from that, and a caller
// declaring a state is ignored.
//
// NOTHING IN PUBLIC EXECUTES
//
// Worth stating because it is the one place this is better than the hosting
// version rather than merely different. The server streams bytes: the route reads
// a row, asks `servedPathFor` whether the path is inside the published root, and
// pipes the file. There is no interpreter anywhere near it, so a .php or a .cgi
// in Public is a file that people can download and not a program that runs.

const path = require('path');
const fs = require('fs');

const storageRoots = require('./storageRoots');

const MY_FILES = 'private';
const PUBLIC = 'public';
const SHARED = 'shared';
const TRASH = 'trash';
const PLACES = [MY_FILES, PUBLIC, SHARED, TRASH];

// The entitlement keys this model actually asks about. Two more were named here
// for features that did not exist yet, on the reasoning that naming them early
// saves renaming them later. It does not: a key with nothing behind it reads as
// a working feature to everybody who greps for it, and one of them was already
// registered as sellable. A key arrives with its feature.
const ENTITLEMENTS = {
  storageBytes: 'storage_bytes',
  makePublic: 'files_public',
  shareLinks: 'files_share_links',
};

// ── Which place a file is in ────────────────────────────────────────────────

// Derived, never accepted. Trash wins over everything because a deleted file is
// in Trash whatever else was true of it, and public beats shared because bytes
// in the published directory are reachable by anyone whether or not a link also
// exists. A row nobody can make sense of reads as My Files, which is the
// conservative answer: it is the place that shows the file to nobody.
function placeOf(row, { activeShares = 0 } = {}) {
  if (!row) return MY_FILES;
  if (row.deleted_at) return TRASH;
  if (isPublicPath(row.uploadsDir || row._uploadsDir, row.user_id, row.disk_path)) return PUBLIC;
  if (activeShares > 0) return SHARED;
  return MY_FILES;
}

// Asked of the resolved paths through `storageRoots`, which already gets the
// separator right. `startsWith` alone says yes to `/a/published-other` for the
// root `/a/published`, which is the usual way this is got wrong.
function isPublicPath(uploadsDir, userId, diskPath) {
  if (!uploadsDir || !userId || !diskPath) return false;
  const { published } = storageRoots.rootsFor(uploadsDir, userId);
  return storageRoots.isInside(published, diskPath);
}

// The state as the API reports it, which needs the uploads directory to answer
// and therefore takes it rather than reading a global.
function placeFor(uploadsDir, row, options = {}) {
  return placeOf({ ...row, _uploadsDir: uploadsDir }, options);
}

// Who can reach a file in each place, said once so a route, a test and a screen
// ask the same question rather than each carrying its own idea of the answer.
const REACH = {
  [MY_FILES]: { owner: true, linkHolder: false, internet: false },
  [SHARED]: { owner: true, linkHolder: true, internet: false },
  [PUBLIC]: { owner: true, linkHolder: true, internet: true },
  [TRASH]: { owner: true, linkHolder: false, internet: false },
};

function reachability(place) {
  return REACH[place] || REACH[MY_FILES];
}

// ── The address a public file has ───────────────────────────────────────────

// Said once, here, so the row that links to it and the record that mentions it
// are the same string. Two places assembling a URL from parts is two places that
// can disagree about a slash, and the one that disagrees is the one the customer
// sends to somebody else.
//
// The id is in the path deliberately. Keying a public address on the filename
// alone means two files called `invoice.pdf` collide, and the loser is whichever
// one the query happened to order second, which is a customer's file quietly
// serving somebody else's content.
function publicUrlFor(baseUrl, userId, file) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const name = encodeURIComponent(String(file.name || 'file'));
  return `${base}/p/${encodeURIComponent(String(userId))}/${encodeURIComponent(String(file.id))}/${name}`;
}

// And the address a share has. The token is the whole authorization, so it is
// long, random, and stored only as a hash: what is in the database cannot be
// turned back into a working link.
function shareUrlFor(baseUrl, token) {
  return `${String(baseUrl).replace(/\/+$/, '')}/s/${token}`;
}

// ── Moving between My Files and Public ──────────────────────────────────────

// Resolve and refuse, before anything is moved.
//
// The target name is the file's own basename and never anything a caller sent.
// There is no path in this product: a file dropped into Public keeps its name,
// so there is nothing for a caller to put a `..` into. That is worth saying out
// loud because it is the reason this is short: the traversal question does not
// arise when there is no path to traverse.
function planMove({ uploadsDir, userId, row, to }) {
  if (!row) throw new Error('There is no such file.');
  if (!PLACES.includes(to)) throw new Error(`${to} is not a place`);
  if (to !== MY_FILES && to !== PUBLIC) throw new Error(`${to} is not somewhere a file can be moved to`);

  const from = placeFor(uploadsDir, row);
  if (from === TRASH) {
    return { ok: false, status: 409, reason: 'This file is in the Trash. Take it out first.' };
  }
  if ((from === PUBLIC && to === PUBLIC) || (from !== PUBLIC && to === MY_FILES)) {
    return { ok: true, status: 200, noop: true, from, to: from };
  }

  const roots = storageRoots.rootsFor(uploadsDir, userId);
  const targetDir = to === PUBLIC ? roots.published : roots.private;
  // The basename of what is on disk, not of what the row calls itself. A row's
  // display name is renameable and a rename does not move the file, so building
  // the destination from the display name would move the bytes to a path the
  // row's own `disk_path` never pointed at.
  const base = path.basename(String(row.disk_path || ''));
  if (!base) return { ok: false, status: 400, reason: 'That file has no location on disk.' };

  const target = path.join(targetDir, base);
  // Both sides are checked against the root they are supposed to be under, so a
  // row carrying a path from before the split, or one somebody has edited,
  // cannot be used to move a file somewhere neither directory contains.
  if (!storageRoots.isInside(targetDir, target)) {
    return { ok: false, status: 400, reason: 'That file cannot be moved there.' };
  }

  return {
    ok: true,
    status: 200,
    noop: false,
    from,
    to,
    move: { from: path.resolve(row.disk_path), to: target },
    // The fact the panel says out loud, because the difference between two
    // directories is invisible once a file is sitting in a list.
    crossesIntoPublic: to === PUBLIC,
    audit: {
      action: to === PUBLIC ? 'file_made_public' : 'file_made_private',
      details: to === PUBLIC
        ? `${row.name} is now public`
        : `${row.name} is private again`,
    },
  };
}

// ── The entitlement ─────────────────────────────────────────────────────────

// Checked before the move, because a cap checked afterwards has described
// something rather than prevented it.
//
// Two different questions, and conflating them shipped the feature dead once
// already. A two-account run on a clean box found it: nobody could make anything
// public anywhere, for ever, and nothing failed or logged.
//
//   Is the public-files metric one this box's plan ladder carries at all?
//     No  → the workspace entitlement is not in force yet. Publishing is allowed,
//           and storage is still capped by `storage_bytes` like
//           everything else. This is the state every box is in today, because
//           the workspace rows are step 5 of the build order and are not built.
//     Yes → the ladder has an opinion, so honour it, and:
//
//   Has this organization been assigned a value for it?
//     No, or zero → off. Missing means off, and that is the direction that
//                   matters: a hoster who has added the metric and not filled it
//                   in has not thereby put every customer's files on the web.
//
// The alternative, refusing whenever the metric is absent, is defensible right
// up until you notice it refuses on every box in existence, at which point the
// next person to look at it removes the gate entirely rather than narrowing it,
// and then it refuses nobody ever again. A gate that is wrong in the safe
// direction still gets deleted.
// A capability is a switch. Not registered on this box at all means nobody has
// priced it, and an unpriced capability is on: a hoster who configures nothing
// ships the whole product. Registered and not granted means somebody did price
// it and this plan does not include it.
function mayUse(entitlement, { registered = true, refusal = 'That is not part of your plan.' } = {}) {
  if (!registered) return { allowed: true, reason: null, inForce: false };
  if (!entitlement || entitlement.missing) return { allowed: false, reason: refusal, inForce: true };
  if (entitlement.maxUnlimited) return { allowed: true, reason: null, inForce: true };
  const value = Number(entitlement.maxValue);
  if (!Number.isFinite(value) || value <= 0) return { allowed: false, reason: refusal, inForce: true };
  return { allowed: true, reason: null, inForce: true };
}

function mayMakePublic(entitlement, options = {}) {
  return mayUse(entitlement, { ...options, refusal: 'Making files public is not part of your plan.' });
}

function mayShare(entitlement, options = {}) {
  return mayUse(entitlement, { ...options, refusal: 'Share links are not part of your plan.' });
}

// Whether this box's plan ladder carries the metric at all, asked of the
// entitlements service's own registry rather than of a list kept here, so the
// day the row is added this starts being enforced with nothing to remember.
function entitlementInForce(metrics, key) {
  return Array.isArray(metrics) && metrics.some(m => m && m.metric_key === key);
}

// ── Trash ───────────────────────────────────────────────────────────────────

// Deleting is a move to Trash and nothing is removed. Emptying is the removal,
// and it is the only thing in this product that cannot be undone, which is why
// it is the only thing that asks.
//
// A public file cannot go to the Trash while it is public. Deleting it would
// leave the bytes in the published directory with no row pointing at them, which
// is a file on the open internet that the customer believes is gone. Not a
// permission problem, so not a 403: it is an ordering problem, and the sentence
// says the order.
function refusalForTrash(place) {
  if (place !== PUBLIC) return null;
  return 'This file is public. Make it private first, then delete it, otherwise it would stay reachable with nothing pointing at it.';
}

// What Empty Trash is allowed to remove: rows this account owns that are in the
// Trash, and whose bytes are inside this account's own directories. The second
// half is the one that matters. A row carrying a path from before the split, or
// one somebody has edited, must not turn Empty Trash into an arbitrary unlink,
// so a row that fails the check is kept rather than removed and is reported.
function planEmptyTrash({ uploadsDir, userId, rows = [] }) {
  const roots = storageRoots.rootsFor(uploadsDir, userId);
  const remove = [];
  const kept = [];
  for (const row of rows) {
    if (!row || !row.deleted_at) continue;
    const resolved = row.disk_path ? path.resolve(row.disk_path) : null;
    const inside = resolved
      && (storageRoots.isInside(roots.private, resolved) || storageRoots.isInside(roots.published, resolved));
    if (!inside) { kept.push({ id: row.id, why: 'its location is outside this account' }); continue; }
    remove.push({ id: row.id, path: resolved, name: row.name });
  }
  return { remove, kept };
}

// How long something sits in the Trash before it goes on its own. The retention
// window is a plan value and is not decided here; this is the shape the caller
// fills in, and null means it stays until somebody empties it.
function trashExpiry(deletedAt, days) {
  if (!deletedAt || !days) return null;
  const at = new Date(asUtc(deletedAt)).getTime();
  if (!Number.isFinite(at)) return null;
  return new Date(at + Number(days) * 86400000).toISOString();
}

// SQLite writes `2026-09-01 13:04:22` for datetime('now'), which is UTC with
// nothing saying so, and JavaScript reads a bare string like that as local time.
// On any box not set to UTC that is an error the size of the offset, in the code
// that decides when somebody's deleted file is destroyed. Anything already
// carrying a zone is left exactly as it is.
function asUtc(text) {
  const value = String(text || '');
  return /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
}

// Which rows in the Trash are past the window. Pure: it reads no disk and
// deletes nothing, because what to do about an expired file is the caller's
// business and this is only the rule.
//
// No window means nothing expires. A hoster who sells unlimited retention has
// sold exactly that, and this is not the place to second-guess it.
function sweepTrash({ rows = [], days = null, now = new Date() } = {}) {
  const at = now instanceof Date ? now : new Date(now);
  const expired = [];
  const keeping = [];
  for (const row of rows) {
    if (!row || !row.deleted_at) continue;
    const due = trashExpiry(row.deleted_at, days);
    if (!due) { keeping.push(row); continue; }
    (new Date(due) <= at ? expired : keeping).push(row);
  }
  return { expired, keeping };
}

// Renaming a file changes the row's label and nothing else. It never touches
// `disk_path`, so no name a customer types can reach the filesystem — that is
// why there is no path handling in here, only refusal of the characters that
// would make a name a lie.
//
// The extension is preserved, always. Two reasons, and the second is the one
// that matters: a rename should not quietly break what a file opens with, and a
// published file is served from its bytes with a type this box decided at
// upload — letting a rename turn `notes.txt` into `notes.html` would hand a
// customer a way to change how the open internet is told to treat their file.
// So the extension is part of what a file *is*, not what it is called.
const MAX_FILE_NAME = 180;

const extensionOf = name => {
  const text = String(name || '');
  const at = text.lastIndexOf('.');
  return at > 0 && at < text.length - 1 ? text.slice(at) : '';
};

function renameTo(raw, currentName) {
  const asked = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!asked) return { ok: false, reason: 'A file needs a name.' };
  if (asked.includes('/') || asked.includes('\\')) return { ok: false, reason: 'A file name cannot contain a slash.' };
  if (asked === '.' || asked === '..') return { ok: false, reason: 'That is not a name.' };
  if (/[\u0000-\u001f\u007f]/.test(asked)) return { ok: false, reason: 'That name is not all characters.' };
  const keep = extensionOf(currentName);
  const already = keep && asked.toLowerCase().endsWith(keep.toLowerCase());
  const name = already ? asked : asked + keep;
  if (already && asked.length === keep.length) return { ok: false, reason: 'A file needs a name in front of the extension.' };
  if (name.length > MAX_FILE_NAME) return { ok: false, reason: `A file name stops at ${MAX_FILE_NAME} characters.` };
  return { ok: true, name };
}

module.exports = {
  MAX_FILE_NAME,
  renameTo,
  MY_FILES, PUBLIC, SHARED, TRASH, PLACES, ENTITLEMENTS,
  placeOf, placeFor, isPublicPath, reachability,
  publicUrlFor, shareUrlFor, planMove, mayUse, mayMakePublic, mayShare,
  refusalForTrash, planEmptyTrash, trashExpiry, sweepTrash, asUtc, entitlementInForce,
};
