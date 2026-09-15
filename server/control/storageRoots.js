'use strict';

// Where a customer's private files live, and where the files they publish live,
// and the fact that those are two different places on the disk.
//
// They were one place. Both `POST /api/files` and `POST /api/pub/files` used
// the same multer storage, so a private document and a page meant for the
// internet landed side by side in `uploads/<user id>/`, and the only thing that
// decided which was which was the table the row went into. Nothing about a file
// on disk said whether it was private. The web route did read only `pub_files`,
// so private files were not in fact reachable, but that is a property of one SQL
// query rather than of the layout, and one query is a thin place to keep a
// promise about somebody's private files.
//
// So the layout answers it now:
//
//   uploads/<user id>/private/     never served to the internet
//   uploads/<user id>/published/   what this process serves at /p/:userId/...
//   uploads/<user id>/versions/    what a file used to be, before it was replaced
//
// The third root holds previous versions. They are the customer's own bytes and
// they are paid for like any other: the meter counts this directory, the
// reconciliation walks it, and the backup carries it. What no route does is
// serve from it — a version has one way out, an authenticated download by its
// owner, and neither the public route nor a share link can reach one.
//
// One route reaches into `private/` and exactly one: a share link, through
// `sharedPathFor` below, and only after a live share row has been found for the
// token in the address. That is what Shared is — the owner handed one person a
// key to something private — and it is why the row is checked first and the path
// second. The internet gets `published/` and nothing else.
//
// and `servedPathFor` is the gate the serving route asks. It resolves the path
// off the row and refuses anything that is not inside that user's published
// directory, so a bad row, a row from before this split, a `..` that survived
// somewhere, or a future bug that reads the wrong table cannot produce a
// private file. The check is on the resolved real path rather than on the
// string, because `published/../private/x` is a perfectly ordinary-looking
// string.
//
// There is no web server in front of these directories. This process is what
// serves a published file, and the check below is the whole boundary: there is no
// second rule underneath it doing the same job. That is worth knowing, because
// the panel this file came from did have one, and a reader who assumes it is
// still there will assume this check is belt and braces when it is the belt.

const path = require('path');
const fs = require('fs');

const PRIVATE = 'private';
const PUBLISHED = 'published';
const VERSIONS = 'versions';

function rootsFor(uploadsDir, userId) {
  const base = path.resolve(uploadsDir, String(userId));
  return {
    base,
    private: path.join(base, PRIVATE),
    published: path.join(base, PUBLISHED),
    versions: path.join(base, VERSIONS),
  };
}

// The three directories an account's bytes can be in. Everything that counts,
// reconciles or copies an account's storage walks this rather than a list of its
// own, so a fourth root added here is not a fourth root somebody has to remember
// in four other files.
function allRoots(uploadsDir, userId) {
  const roots = rootsFor(uploadsDir, userId);
  return [[PRIVATE, roots.private], [PUBLISHED, roots.published], [VERSIONS, roots.versions]];
}

function ensureRoot(uploadsDir, userId, which) {
  const roots = rootsFor(uploadsDir, userId);
  const dir = which === PUBLISHED ? roots.published : which === VERSIONS ? roots.versions : roots.private;
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  return dir;
}

// Is `candidate` inside `root`, asked of the resolved paths rather than of the
// strings. `startsWith` on its own says yes to `/a/published-other` for the root
// `/a/published`, which is how this kind of check is usually got wrong, so the
// separator is part of the comparison.
function isInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved === resolvedRoot) return false;
  return resolved.startsWith(resolvedRoot + path.sep);
}

// Resolve `diskPath` and prove it is really inside `root`, symlinks and all.
// Both sides get resolved, and the root's are resolved too. Following only the
// file's was a real bug rather than a test artefact: on any box where the uploads
// directory is reached through a link, and macOS is one because /var is a link to
// /private/var, the file resolves to a path the unresolved root is not a prefix
// of and every published file 404s. The link that matters is still caught,
// because a link inside the published directory pointing into the private one
// resolves outside the resolved root just the same.
function realFileInside(root, diskPath) {
  if (!diskPath || typeof diskPath !== 'string') return null;
  if (!isInside(root, diskPath)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(path.resolve(diskPath));
    if (!isInside(realRoot, real)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

// The one question the serving route asks. Returns the absolute path to send,
// or null, and null means send a 404 rather than an explanation: a caller
// probing for private files should not learn the difference between "no such
// file" and "that one is private".
function servedPathFor(uploadsDir, userId, diskPath) {
  return realFileInside(rootsFor(uploadsDir, userId).published, diskPath);
}

// Where a previous version lives. Scoped to the versions root and nothing else,
// so the route that hands a customer their old file cannot be talked into
// handing them a current one — or anybody else's anything.
function versionPathFor(uploadsDir, userId, diskPath) {
  return realFileInside(rootsFor(uploadsDir, userId).versions, diskPath);
}

// The same question for a share link, and the only thing in this file that will
// answer with a path inside `private/`. Its one caller has already found a live,
// unrevoked, unexpired share row for the token in the address; without that row
// this must never be reached. The boundary it still holds is ownership: the path
// has to be inside *this* account's tree, so a row naming another customer's file
// resolves to nothing.
function sharedPathFor(uploadsDir, userId, diskPath) {
  return realFileInside(rootsFor(uploadsDir, userId).base, diskPath);
}

// Whether a private file is about to be put where the internet can read it.
// Not a refusal: making a file public is a thing people do on
// purpose all day. It is the fact that the panel has to say out loud first,
// because the difference between the two directories is invisible once the file
// is sitting in a list.
function crossesIntoPublic(uploadsDir, userId, fromPath, toPath) {
  const roots = rootsFor(uploadsDir, userId);
  return isInside(roots.private, fromPath) && isInside(roots.published, toPath);
}

// Boxes that carry files from before the split have them directly under
// `uploads/<user id>/`. Each row is moved into the directory its own table
// implies and the row is updated in the same transaction, so a move that
// happens without the row following it cannot leave a file the panel has lost
// track of. Anything already in the right place is left alone, which is what
// makes this safe to run at every start.
function planRelocation({ uploadsDir, rows }) {
  const plan = [];
  for (const row of rows) {
    if (!row || !row.disk_path) continue;
    const which = row.published ? PUBLISHED : PRIVATE;
    const roots = rootsFor(uploadsDir, row.user_id);
    const target = which === PUBLISHED ? roots.published : roots.private;
    if (isInside(target, row.disk_path)) continue;
    // Only files the panel put there itself, directly under the account's own
    // directory. Anything else is somebody's own arrangement and is left alone
    // rather than moved by a migration that cannot know what it is.
    if (path.dirname(path.resolve(row.disk_path)) !== roots.base) continue;
    plan.push({
      id: row.id,
      table: row.published ? 'pub_files' : 'files',
      from: path.resolve(row.disk_path),
      to: path.join(target, path.basename(row.disk_path)),
    });
  }
  return plan;
}

module.exports = { rootsFor, allRoots, ensureRoot, isInside, servedPathFor, sharedPathFor, versionPathFor, crossesIntoPublic, planRelocation, PRIVATE, PUBLISHED, VERSIONS };
