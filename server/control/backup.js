'use strict';

// Backup and restore.
//
// THE CONTRACT IS RESTORE, NOT BACKUP
//
// A command that copies files is not a backup. The thing that has to be true is
// that customer data can be lost from the primary storage and come back correct
// from a copy made independently of it. So nothing here reports success for a
// backup it has not been able to read back, and the acceptance test in
// `audit/release-audit.js` destroys the primary copy before it believes any of
// it. A backup nobody has restored is a hope with a filename.
//
// WHAT IS AUTHORITATIVE AND WHAT IS DERIVED
//
// Authoritative, and therefore backed up:
//
//   - every row of the database: accounts and their password hashes, the files
//     table, folders, the ownership hierarchy, packages, limits, assignments,
//     overrides and the audit trail
//   - the bytes of every file, copied individually, hashed individually
//   - which of the two directories each file's bytes were in, because that
//     is what decides whether a file is private or public. There is no column
//     for it. Restoring a file into the wrong directory publishes somebody's
//     private document, so the place travels in the manifest as its own field
//     and is rebuilt from that rather than from a stored path string.
//   - `deleted_at`, which is the whole of the Trash. A restore that quietly
//     un-deleted everything in the Trash would be a restore that changed what
//     the customer had.
//
// Derived, and therefore deliberately not treated as authoritative:
//
//   - storage usage. There is no cached usage number in this product: the quota
//     gate sums the rows and the entitlements engine reads the same rows through
//     `quota.subtreeUsageReader`. So there is nothing stale to carry across, and
//     the acceptance test proves it by running `quota.reconcile` after the
//     restore and requiring the rows and the disk to agree.
//   - sessions. These are cleared, in the backup artifact itself rather than at
//     restore time, so a stolen token that was revoked before the disaster does
//     not come back to life with the data, and so the artifact does not sit on a
//     disk carrying live session identifiers. Everybody signs in again after a
//     restore, which is the correct outcome and also proves the password hashes
//     survived.
//   - `entitlement_overages`, which is a projection the admission check rewrites.
//     The rows travel with the database because they are cheap and they are
//     history, but nothing depends on them being current.
//
// CONSISTENCY
//
// The database and the filesystem are two stores and this product cannot freeze
// both at one instant. Pretending otherwise, by copying them in whatever order
// and calling the result a snapshot, is how a backup ends up internally
// inconsistent in a way nobody discovers until the restore.
//
// So the order is deliberate and the residue is reported rather than hidden:
//
//   1. The database is snapshotted first, through SQLite's own online backup, so
//      it is a consistent point in time even under concurrent writes.
//   2. The file bytes are then copied from the list of rows in that snapshot.
//
// A file uploaded after step 1 is not in the snapshot and is not copied: the
// backup is a slightly older state, which is coherent. A file whose bytes were
// removed between the two steps — Empty Trash is the only thing in the product
// that unlinks — is a row in the snapshot with nothing behind it, and that is
// named in the manifest and drops the backup's status to `incomplete`. An
// incomplete backup will not restore without an explicit override, because the
// dangerous failure here is not refusing to restore, it is restoring something
// that is missing a customer's file and saying nothing.
//
// WHERE IT LIVES
//
// Outside the customer storage tree, always. Every customer-facing path in this
// product resolves inside `uploads/<user id>/`, including the orphan sweeper,
// which is the one thing that deletes files it did not just create. A backup
// inside that tree could be destroyed by an ordinary customer operation, and a
// copy that the thing it protects can delete is not a copy. `server.js` refuses
// to start if the two directories are nested either way round.
//
// This gives local recoverability: the box can lose its database, its uploads
// directory, or both, and be put back. On its own it is **not** disaster
// recovery — the backup is on the same disk as the thing it protects, so a dead
// disk takes both — and the two must not be described as though they were the
// same thing.
//
// Getting the artifact off the machine is `control/offsite.js`, which ships a
// directory written here to an S3-compatible bucket and holds the same line: it
// reads every object back out of the bucket and compares it against the hashes
// recorded below before it will call anything shipped. Nothing here knows about
// it, deliberately — a backup that could not be taken without a network is a
// backup that stops being taken the week the bucket credentials expire.
//
// THE ARTIFACT IS A SECRET
//
// It contains bcrypt password hashes, every private file byte, email addresses
// and the audit trail. Directories are 0700 and files are 0600, no route serves
// anything out of the backup directory, and there is no route that takes a path.
//
// AND IT IS HOSTILE INPUT ON THE WAY BACK IN
//
// A restore writes files where a manifest tells it to, which is exactly the shape
// of an archive path-traversal bug. So the destination is never taken from the
// backup: it is rebuilt from three validated components — account id, place,
// base name — each of which must be a plain name with no separator, no `..` and
// no NUL, and the assembled path is then checked to be inside the uploads root
// before anything is written.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const storageRoots = require('./storageRoots');

// The product was renamed on 2026-09-10, and these two strings are the only
// parts of the old name that were ever written *into* an artifact rather than
// shown on a screen. New backups carry the new name; anything already on a disk
// still reads. A backup that stopped restoring because the product was renamed
// would not be a backup any more, and the rename is not worth that.
const FORMAT = 'jdrive-backup/1';
const LEGACY_FORMATS = { 'jdrive-backup/1': 'pocketdrive-backup/1',
  'jdrive-account-archive/1': 'pocketdrive-account-archive/1' };
const DB_FILE = 'jdrive.db';
const LEGACY_DB_FILE = 'pocketdrive.db';

// What a format label is allowed to say, given what this build expects.
function formatMatches(actual, expected) {
  return actual === expected || actual === LEGACY_FORMATS[expected];
}

// The database inside a backup directory, under whichever name it was written.
function dbFileIn(dir) {
  if (fs.existsSync(path.join(dir, DB_FILE))) return DB_FILE;
  if (fs.existsSync(path.join(dir, LEGACY_DB_FILE))) return LEGACY_DB_FILE;
  return DB_FILE;
}
const MANIFEST = 'MANIFEST.json';
const SEAL = 'MANIFEST.sha256';
const FILES = 'files';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const id16 = () => crypto.randomBytes(8).toString('hex');

// ── Small, sharp helpers ────────────────────────────────────────────────────

function sha256OfFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

const sha256OfText = text => crypto.createHash('sha256').update(text).digest('hex');

// One path component, and nothing that could be read as more than one. This is
// the whole of the traversal defence and it is deliberately not clever: anything
// that is not a plain name is refused rather than sanitised, because sanitising
// invents a filename and a restore that invents filenames is a restore that
// quietly renames somebody's data.
function safeComponent(value, what) {
  const s = String(value == null ? '' : value);
  if (!s || s === '.' || s === '..' || s.includes('/') || s.includes('\\') || s.includes('\0')) {
    throw new Error(`refusing a backup entry whose ${what} is not a plain name: ${JSON.stringify(s.slice(0, 80))}`);
  }
  return s;
}

function placeOfDiskPath(uploadsDir, userId, diskPath) {
  if (!diskPath) return null;
  const roots = storageRoots.rootsFor(uploadsDir, userId);
  if (storageRoots.isInside(roots.published, diskPath)) return storageRoots.PUBLISHED;
  if (storageRoots.isInside(roots.private, diskPath)) return storageRoots.PRIVATE;
  if (storageRoots.isInside(roots.versions, diskPath)) return storageRoots.VERSIONS;
  return null;
}

// Where a place lands on the disk. One answer, used by the copy out and the
// restore back, so the two cannot disagree about where versions live.
function rootForPlace(roots, place) {
  if (place === storageRoots.PUBLISHED) return roots.published;
  if (place === storageRoots.VERSIONS) return roots.versions;
  return roots.private;
}

function mkdirSecure(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { fs.chmodSync(dir, DIR_MODE); } catch { /* a filesystem that will not take a mode is not a reason to abort */ }
  return dir;
}

// Copy, then hash what actually landed rather than what was read. Hashing the
// source would prove the source was readable; hashing the destination is the
// only version of this that catches a copy that did not happen.
function copyThenHash(from, to) {
  mkdirSecure(path.dirname(to));
  fs.copyFileSync(from, to);
  try { fs.chmodSync(to, FILE_MODE); } catch { /* as above */ }
  const stat = fs.statSync(to);
  return { bytes: stat.size, sha256: sha256OfFile(to) };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Every file directly under an account's two roots. The product only ever writes
// files at that one level, so this is the whole tree it owns.
function filesUnderRoots(uploadsDir, userId) {
  const out = [];
  for (const [place, root] of storageRoots.allRoots(uploadsDir, userId)) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      out.push({ place, full: path.join(root, entry.name), basename: entry.name });
    }
  }
  return out;
}

// ── Taking a backup ─────────────────────────────────────────────────────────

// `db` is the live, open database. `uploadsDir` is the live customer tree.
// `into` is the backup directory, which must not be inside `uploadsDir`; the
// server refuses to start if it is, and this refuses too, because a helper that
// trusts its caller to have checked is a helper that is called from somewhere
// else next year.
async function take({ db, uploadsDir, into, label = null, at = new Date() }) {
  if (!db) throw new Error('a backup needs the live database');
  if (!uploadsDir || !into) throw new Error('a backup needs an uploads directory and a destination');
  if (storageRoots.isInside(path.resolve(uploadsDir), path.resolve(into))) {
    throw new Error('refusing to write a backup inside the customer storage it is protecting');
  }

  const runId = id16();
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  // Named for what it is and never for us. The folder name travels: onto the
  // hosting company's own disk and, shipped offsite, into their own bucket, where a
  // live test on 2026-09-13 showed Backblaze listing `pocketdrive-…` — the old name
  // of the product, in a white-labelled box's storage. Folders written before this
  // keep their names and still list and restore, because nothing reads the prefix.
  const dir = path.join(path.resolve(into), `backup-${stamp}-${runId}`);
  mkdirSecure(dir);

  // 1. The database, through SQLite's own online backup, so it is consistent
  //    even if somebody is uploading while this runs.
  const dbCopy = path.join(dir, DB_FILE);
  await db.backup(dbCopy);
  try { fs.chmodSync(dbCopy, FILE_MODE); } catch { /* as above */ }

  // Sessions are stripped from the artifact itself. Doing it here rather than at
  // restore time means the file on disk never carries a live session id, so a
  // leaked backup is not also a set of working tokens.
  const snapshot = new Database(dbCopy);
  let sessionsCleared = 0;
  try {
    snapshot.pragma('journal_mode = DELETE');
    sessionsCleared = snapshot.prepare('DELETE FROM sessions').run().changes;
  } catch { /* a database from before sessions existed has no such table */ }

  const users = snapshot.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const rows = snapshot.prepare('SELECT id,user_id,name,size,mime,folder,disk_path,added_at,deleted_at FROM files').all();
  // Every account, not only the ones with rows: an account whose directory holds
  // nothing but unclaimed bytes is exactly the case worth noticing.
  const accountIds = snapshot.prepare('SELECT id FROM users').all().map(r => r.id);
  snapshot.close();

  // 2. The bytes, from the list of rows in that snapshot.
  const entries = [];
  const problems = [];
  const claimed = new Set();
  let bytes = 0;

  for (const row of rows) {
    const place = placeOfDiskPath(uploadsDir, row.user_id, row.disk_path);
    if (!place) {
      problems.push({ file_id: row.id, name: row.name, why: 'the row points nowhere inside the account storage' });
      continue;
    }
    const basename = path.basename(path.resolve(row.disk_path));
    const source = path.resolve(row.disk_path);
    claimed.add(source);
    if (!fs.existsSync(source)) {
      // The row is in the snapshot and the bytes are not on the disk. This is the
      // interleaving case (an Empty Trash between step 1 and step 2) and it is
      // also what a corrupted primary looks like. Either way it is named.
      problems.push({ file_id: row.id, name: row.name, why: 'the database has this file and the disk does not' });
      continue;
    }
    const target = path.join(dir, FILES, safeComponent(row.user_id, 'account id'),
      safeComponent(place, 'place'), safeComponent(basename, 'file name'));
    const written = copyThenHash(source, target);
    bytes += written.bytes;
    entries.push({
      file_id: row.id,
      user_id: row.user_id,
      place,
      basename,
      name: row.name,
      folder: row.folder,
      mime: row.mime,
      recorded_size: Number(row.size) || 0,
      bytes: written.bytes,
      sha256: written.sha256,
      trashed: !!row.deleted_at,
    });
  }

  // What those files used to be. Copied for the same reason the files are: they
  // are the customer's bytes, they are counted against the customer's allowance,
  // and a restore that brought back a file without its history would have
  // quietly deleted the history while reporting success.
  const versionRows = db.prepare('SELECT * FROM file_versions ORDER BY user_id, made_at').all();
  for (const row of versionRows) {
    const place = placeOfDiskPath(uploadsDir, row.user_id, row.disk_path);
    if (place !== storageRoots.VERSIONS) {
      problems.push({ file_id: row.file_id, name: row.name, why: 'an earlier version points outside the versions directory' });
      continue;
    }
    const basename = path.basename(path.resolve(row.disk_path));
    const source = path.resolve(row.disk_path);
    claimed.add(source);
    if (!fs.existsSync(source)) {
      problems.push({ file_id: row.file_id, name: row.name, why: 'the database has an earlier version and the disk does not' });
      continue;
    }
    const target = path.join(dir, FILES, safeComponent(row.user_id, 'account id'),
      safeComponent(place, 'place'), safeComponent(basename, 'file name'));
    const written = copyThenHash(source, target);
    bytes += written.bytes;
    entries.push({
      version_id: row.id,
      file_id: row.file_id,
      user_id: row.user_id,
      place,
      basename,
      name: row.name,
      mime: row.mime,
      recorded_size: Number(row.size) || 0,
      bytes: written.bytes,
      sha256: written.sha256,
      made_at: row.made_at,
    });
  }

  // The other direction: bytes on the disk that no row claims. Not copied — they
  // are not customer data as far as the product is concerned, and a backup that
  // preserved them would be preserving the mess `quota.reconcile` exists to find.
  // Counted and reported, because silently ignoring an unexpected file is how a
  // backup gets described as complete when it is a subset.
  const unclaimed = [];
  for (const userId of accountIds) {
    for (const found of filesUnderRoots(uploadsDir, userId)) {
      if (claimed.has(path.resolve(found.full))) continue;
      unclaimed.push({ user_id: userId, place: found.place, basename: found.basename });
    }
  }

  const status = problems.length ? 'incomplete' : 'ok';
  const manifest = {
    format: FORMAT,
    run_id: runId,
    label,
    created_at: at.toISOString(),
    status,
    database: { file: DB_FILE, sha256: sha256OfFile(dbCopy), bytes: fs.statSync(dbCopy).size },
    counts: {
      users,
      file_rows: rows.length,
      version_rows: versionRows.length,
      files_copied: entries.length,
      bytes,
      problems: problems.length,
      unclaimed_on_disk: unclaimed.length,
      sessions_cleared: sessionsCleared,
    },
    // Named so a reader of the artifact knows what this backup does and does not
    // promise, without having to find this file.
    excluded: ['sessions (deliberately cleared: a revoked token must not come back with the data)'],
    derived_after_restore: ['storage usage, recomputed from the restored rows and disk'],
    problems,
    unclaimed,
    entries,
  };

  const manifestText = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(dir, MANIFEST), manifestText, { mode: FILE_MODE });
  // The seal covers the index itself. Without it, an attacker or a bad disk can
  // edit the manifest to match tampered bytes and every per-file hash still
  // agrees, because they were all rewritten together.
  fs.writeFileSync(path.join(dir, SEAL), sha256OfText(manifestText) + '\n', { mode: FILE_MODE });

  return { id: runId, dir, status, manifest };
}

// ── Reading one back, without restoring it ──────────────────────────────────

// Everything a restore checks, done without writing anything. This is what makes
// "we have backups" a statement somebody can verify on a Tuesday rather than
// during an outage.
// `expect` is which format this directory is supposed to be. It defaults to a
// whole-box backup, so every existing caller is unchanged, and an account
// archive — the same layout, scoped to one customer — passes its own. Reading
// both with one verifier is the point: the code that rehashes every file and
// checks the seal is code that is already proven, and a second copy of it would
// be a second thing that has to stay right. Parameterised rather than relaxed:
// a backup still will not verify as an archive, or an archive as a backup.
function inspect({ from, expect = FORMAT }) {
  const dir = path.resolve(from);
  const problems = [];
  const manifestPath = path.join(dir, MANIFEST);
  const sealPath = path.join(dir, SEAL);

  if (!fs.existsSync(manifestPath)) return { ok: false, manifest: null, checked: 0, problems: ['there is no manifest, so this is not a backup'] };
  if (!fs.existsSync(sealPath)) return { ok: false, manifest: null, checked: 0, problems: ['the manifest is not sealed, so it cannot be trusted'] };

  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const seal = fs.readFileSync(sealPath, 'utf8').trim();
  if (sha256OfText(manifestText) !== seal) {
    return { ok: false, manifest: null, checked: 0, problems: ['the manifest does not match its seal; it has been changed since the backup was taken'] };
  }

  let manifest;
  try { manifest = JSON.parse(manifestText); } catch { return { ok: false, manifest: null, checked: 0, problems: ['the manifest is not readable'] }; }
  if (!formatMatches(manifest.format, expect)) problems.push(`this is ${manifest.format || 'an unlabelled format'} and this version reads ${expect}`);

  const dbCopy = path.join(dir, dbFileIn(dir));
  if (!fs.existsSync(dbCopy)) problems.push('the database snapshot is missing');
  else if (sha256OfFile(dbCopy) !== (manifest.database && manifest.database.sha256)) {
    problems.push('the database snapshot does not match its recorded hash');
  }

  let checked = 0;
  for (const entry of manifest.entries || []) {
    let rel;
    try {
      rel = path.join(FILES, safeComponent(entry.user_id, 'account id'),
        safeComponent(entry.place, 'place'), safeComponent(entry.basename, 'file name'));
    } catch (error) {
      problems.push(error.message);
      continue;
    }
    const file = path.join(dir, rel);
    // Belt as well as braces: the components were validated, and the assembled
    // path is checked to be inside the backup's own files directory anyway.
    if (!storageRoots.isInside(path.join(dir, FILES), file)) {
      problems.push(`entry ${entry.file_id} resolves outside the backup`);
      continue;
    }
    if (!fs.existsSync(file)) { problems.push(`${entry.name || entry.file_id}: the manifest lists this file and the backup does not contain it`); continue; }
    const stat = fs.statSync(file);
    if (stat.size !== entry.bytes) { problems.push(`${entry.name || entry.file_id}: ${entry.bytes} bytes recorded, ${stat.size} on disk`); continue; }
    if (sha256OfFile(file) !== entry.sha256) { problems.push(`${entry.name || entry.file_id}: the contents do not match the recorded hash`); continue; }
    checked++;
  }

  return { ok: problems.length === 0, manifest, checked, problems };
}

// What the operator sees in a list. Cheap: reads manifests, does not hash.
function list({ from }) {
  const dir = path.resolve(from);
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return []; }
  const out = [];
  for (const name of names) {
    try {
      const manifest = readJson(path.join(dir, name, MANIFEST));
      out.push({
        id: manifest.run_id,
        directory: name,
        created_at: manifest.created_at,
        status: manifest.status,
        label: manifest.label,
        counts: manifest.counts,
      });
    } catch { out.push({ id: null, directory: name, created_at: null, status: 'unreadable', label: null, counts: null }); }
  }
  // Newest first by when it was taken, not by folder name: old `pocketdrive-` folders
  // and new `backup-` ones sort apart alphabetically, which would put a year-old
  // backup at the top of the list. Unreadable ones go last.
  return out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))
    || String(b.directory).localeCompare(String(a.directory)));
}

// ── Restoring ───────────────────────────────────────────────────────────────

// Destructive recovery. Puts a backup back over a data directory and an uploads
// directory, and is deliberately not reachable over HTTP: it overwrites every
// customer's files, and an operation that does that from a stolen token is worse
// than any outage it shortens. It is `npm run restore`, run by somebody on the
// box, with the server stopped.
//
// Nothing is written into the live locations until the whole thing has been
// built and re-verified somewhere else. A restore that dies halfway leaves the
// staging directories behind and the originals untouched, which is the failure
// mode you want: no data, or the old data, never half of each.
//
// What is displaced is renamed aside rather than deleted. It is usually the very
// thing somebody is trying to recover from, and deleting it during a recovery is
// the one mistake with nothing after it.
async function restore({ from, dataDir, uploadsDir, force = false }) {
  const source = path.resolve(from);
  const found = inspect({ from: source });
  if (!found.ok) {
    const error = new Error(`refusing to restore: ${found.problems.join('; ')}`);
    error.problems = found.problems;
    throw error;
  }
  if (found.manifest.status !== 'ok' && !force) {
    throw new Error(`refusing to restore a backup recorded as ${found.manifest.status}: `
      + `${(found.manifest.problems || []).map(p => p.why).join('; ')}. Pass force to override.`);
  }

  const dataTarget = path.resolve(dataDir);
  const uploadsTarget = path.resolve(uploadsDir);
  const liveDb = dbFileIn(dataTarget);
  const occupied = fs.existsSync(path.join(dataTarget, liveDb));
  if (occupied && !force) {
    throw new Error(`${path.join(dataTarget, liveDb)} already exists. Restoring over a live installation `
      + 'is a decision, not a default. Pass force once you mean it.');
  }

  const runId = id16();
  const dataStage = `${dataTarget}.restoring-${runId}`;
  const uploadsStage = `${uploadsTarget}.restoring-${runId}`;
  mkdirSecure(dataStage);
  mkdirSecure(uploadsStage);

  let restoredFiles = 0;
  let restoredBytes = 0;

  try {
    // The database first, so that if anything below fails there is nothing
    // half-written in a live location.
    const dbStaged = path.join(dataStage, DB_FILE);
    fs.copyFileSync(path.join(source, dbFileIn(source)), dbStaged);
    fs.chmodSync(dbStaged, FILE_MODE);

    // A backup artifact should already have no sessions in it. Asserted rather
    // than assumed, because "should already" is how a revoked token comes back.
    const restoredDb = new Database(dbStaged);
    let sessionsCleared = 0;
    try {
      restoredDb.pragma('journal_mode = DELETE');
      sessionsCleared = restoredDb.prepare('DELETE FROM sessions').run().changes;
    } catch { /* no such table */ }
    const users = restoredDb.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const fileRows = restoredDb.prepare('SELECT COUNT(*) AS n FROM files').get().n;

    for (const entry of found.manifest.entries) {
      // Rebuilt from validated components. The manifest never supplies a path.
      const userId = safeComponent(entry.user_id, 'account id');
      const place = safeComponent(entry.place, 'place');
      const basename = safeComponent(entry.basename, 'file name');
      if (![storageRoots.PRIVATE, storageRoots.PUBLISHED, storageRoots.VERSIONS].includes(place)) {
        throw new Error(`refusing an entry whose place is not one this product writes to: ${JSON.stringify(place)}`);
      }
      const roots = storageRoots.rootsFor(uploadsStage, userId);
      const target = path.join(rootForPlace(roots, place), basename);
      if (!storageRoots.isInside(uploadsStage, target)) {
        throw new Error(`refusing to write ${entry.name || entry.file_id} outside the uploads root`);
      }
      mkdirSecure(path.dirname(target));
      fs.copyFileSync(path.join(source, FILES, userId, place, basename), target);
      fs.chmodSync(target, FILE_MODE);
      // Verified from what was written, so a restore cannot report success for a
      // file it did not actually put down.
      const written = fs.statSync(target);
      if (written.size !== entry.bytes || sha256OfFile(target) !== entry.sha256) {
        throw new Error(`${entry.name || entry.file_id} did not survive the restore intact`);
      }
      restoredFiles++;
      restoredBytes += written.size;
    }

    // The rows point at absolute paths from the machine the backup was taken on.
    // If the restore is going somewhere else, they have to be repointed or every
    // file is a row with nothing behind it. Done in one transaction against the
    // restored copy, before it goes live.
    const repoint = restoredDb.prepare('UPDATE files SET disk_path=? WHERE id=?');
    // A previous version is a row with a path in it too, in its own table, and a
    // restore that repoints one and not the other leaves a customer's history
    // pointing at the machine the backup came off.
    const repointVersion = restoredDb.prepare('UPDATE file_versions SET disk_path=? WHERE id=?');
    const repointAll = restoredDb.transaction(entries => {
      for (const entry of entries) {
        const roots = storageRoots.rootsFor(uploadsTarget, entry.user_id);
        const finalPath = path.join(rootForPlace(roots, entry.place), entry.basename);
        if (entry.version_id) repointVersion.run(finalPath, entry.version_id);
        else repoint.run(finalPath, entry.file_id);
      }
    });
    repointAll(found.manifest.entries);
    restoredDb.close();

    // Everything is built and checked. Now the swap, the two renames back to
    // back so the window where one is new and the other is old is as short as a
    // filesystem allows.
    const displaced = [];
    if (fs.existsSync(dataTarget)) { fs.renameSync(dataTarget, `${dataTarget}.superseded-${runId}`); displaced.push(`${dataTarget}.superseded-${runId}`); }
    if (fs.existsSync(uploadsTarget)) { fs.renameSync(uploadsTarget, `${uploadsTarget}.superseded-${runId}`); displaced.push(`${uploadsTarget}.superseded-${runId}`); }
    fs.renameSync(dataStage, dataTarget);
    fs.renameSync(uploadsStage, uploadsTarget);

    return {
      ok: true,
      from: source,
      backup_id: found.manifest.run_id,
      users,
      file_rows: fileRows,
      files_on_disk: restoredFiles,
      bytes: restoredBytes,
      sessions_cleared: sessionsCleared,
      displaced,
      verified: found.checked,
    };
  } catch (error) {
    // Leave the staging directories for somebody to look at. Removing the
    // evidence of a failed restore is not tidying up.
    error.staging = { data: dataStage, uploads: uploadsStage };
    throw error;
  }
}

// A restore into scratch space, for proving the backup is restorable without
// touching the live installation. This is the thing that turns "we take backups"
// into a fact, and it is what the release audit calls.
async function verifyRestore({ from, into }) {
  const where = path.resolve(into);
  mkdirSecure(where);
  const result = await restore({
    from,
    dataDir: path.join(where, 'data'),
    uploadsDir: path.join(where, 'uploads'),
    force: true,
  });
  return { ...result, dataDir: path.join(where, 'data'), uploadsDir: path.join(where, 'uploads') };
}

module.exports = {
  FORMAT, MANIFEST, SEAL, DB_FILE, FILES, formatMatches, dbFileIn,
  take, inspect, list, restore, verifyRestore,
  sha256OfFile, safeComponent, placeOfDiskPath,
};
