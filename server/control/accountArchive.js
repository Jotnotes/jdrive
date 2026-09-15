'use strict';

// Terminating an account, which is not deleting it.
//
// WHY THIS IS A PRODUCT AND NOT A DISPOSAL RULE
//
// Settled by Steve on 2026-09-07: "people come back and ask, and it's a separate
// service charge to unarchive and send it. It's a rev generator for hosting
// companies." So terminating never destroys the customer's files. It seals them,
// proves the seal, and only then takes the account off the box.
//
// Four consequences follow, and they are the shape of this file:
//
//   1. The archive outlives the account. It cannot hang off a user row that no
//      longer exists, so everything needed to identify it — who it was, what
//      address, how much, when — travels inside the manifest rather than being
//      looked up later.
//   2. It leaves the customer's meter and lands on the hoster's. Nobody is
//      paying a quota for it, and it is still occupying somebody's disk, so a
//      hosting company has to be able to see archives as a count and a size:
//      simultaneously their cost and the thing they are selling back.
//   3. Restoring is the hoster's to charge for and this box's to perform. The
//      box holds it, proves it is intact and hands it back when told. What that
//      costs is between the hoster and whoever is asking; this box does not bill.
//   4. It needs a keep-until and a real delete. Holding a terminated customer's
//      data with no end is a legal position rather than a technical one.
//
// WHY IT IS THE BACKUP FORMAT AND NOT A SECOND ONE
//
// `backup.js` already writes a verified artifact — per-file hashes, a manifest,
// and a seal over the manifest so tampered bytes cannot be made to agree by
// rewriting the index. An account archive is a scoped backup with a name on it.
// Inventing a second format would mean two things that both have to stay correct
// for ever, so this borrows the layout exactly: `MANIFEST.json`, its seal, a
// database file, and `files/<account>/<place>/<name>`. `backup.inspect` reads one
// of these unchanged, which is the point — the proving code is the code that is
// already proven.
//
// The database inside is a real SQLite file holding only this account's rows,
// with the schema copied from the live box. That is what makes an archive
// restorable on its own terms rather than a directory of loose bytes, and it is
// what keeps `inspect` working with no special case.
//
// SEALED, NOT BROWSABLE
//
// It holds a former customer's files. The hoster restores it or sends it; they
// do not open it and read it. That is the same boundary the audit trail draws
// between what happened to an account and what its owner did with their files,
// and it is why nothing here returns a file list to a caller.
//
// WHAT IS DELIBERATELY LEFT OUT
//
//   - sessions, cleared for the same reason `backup.js` clears them: a leaked
//     archive must not also be a set of working tokens
//   - email tokens, which are live keys to an account that is being ended
//   - the password hash is kept, because a restored account whose owner cannot
//     sign in is not a restored account. It is the one secret worth carrying,
//     and it is a hash
//   - share links come back revoked. Restoring an account should not silently
//     republish links to the internet that its owner may have forgotten

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const storageRoots = require('./storageRoots');
const backup = require('./backup');

// Renamed with the product on 2026-09-10. Archives written before that still
// read: see the note on FORMAT in backup.js.
const FORMAT = 'jdrive-account-archive/1';
const DB_FILE = backup.DB_FILE;
const MANIFEST = backup.MANIFEST;
const SEAL = backup.SEAL;
const FILES = backup.FILES;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// Everything an account owns, in the order a restore has to write it: a row that
// points at another row cannot be inserted first. `users` leads because every
// one of the rest carries its id.
const ACCOUNT_TABLES = [
  'users', 'folders', 'files', 'file_versions', 'file_metadata',
  'tags', 'file_tags', 'thumbnails', 'shares', 'audit_log',
];

const id16 = () => crypto.randomBytes(8).toString('hex');
const sha256OfText = text => crypto.createHash('sha256').update(text).digest('hex');

function mkdirSecure(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try { fs.chmodSync(dir, DIR_MODE); } catch { /* a filesystem that will not take a mode is not a reason to abort */ }
  return dir;
}

function copyThenHash(from, to) {
  mkdirSecure(path.dirname(to));
  fs.copyFileSync(from, to);
  try { fs.chmodSync(to, FILE_MODE); } catch { /* as above */ }
  const stat = fs.statSync(to);
  return { bytes: stat.size, sha256: backup.sha256OfFile(to) };
}

// The live schema, carried with the rows. Copied from `sqlite_master` rather
// than written out here, so an archive taken next year restores against the
// shape the box actually had rather than the shape this file remembered.
function schemaFor(db, tables) {
  return db.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND (
      (type='table' AND name IN (${tables.map(() => '?').join(',')}))
      OR (type='index' AND tbl_name IN (${tables.map(() => '?').join(',')})))`)
    .all(...tables, ...tables)
    .map(row => row.sql)
    .filter(sql => sql && !/^CREATE (UNIQUE )?INDEX sqlite_autoindex/i.test(sql));
}

// ── Sealing one account ─────────────────────────────────────────────────────

// `into` must not be inside the customer storage it is protecting, for the same
// reason a backup must not be: an archive that lives under `uploads/` is an
// archive that a sweep can eat and that counts against somebody's meter.
function take({ db, uploadsDir, into, userId, keepDays = null, label = null, at = new Date() }) {
  if (!db) throw new Error('an archive needs the live database');
  if (!uploadsDir || !into) throw new Error('an archive needs an uploads directory and a destination');
  if (storageRoots.isInside(path.resolve(uploadsDir), path.resolve(into))) {
    throw new Error('refusing to write an archive inside the customer storage it is protecting');
  }
  const account = db.prepare('SELECT id,name,email,created_at FROM users WHERE id=?').get(userId);
  if (!account) throw new Error('there is no such account to archive');

  const runId = id16();
  const stamp = at.toISOString().replace(/[:.]/g, '-');
  const dir = path.join(path.resolve(into), `account-${stamp}-${runId}`);
  mkdirSecure(dir);

  // 1. The rows, into a database of this account's own. Built rather than
  //    copied-and-deleted from, because a snapshot of the whole box with the
  //    other customers deleted out of it is still a file that once held them.
  const dbCopy = path.join(dir, DB_FILE);
  const scoped = new Database(dbCopy);
  const counts = {};
  try {
    scoped.pragma('journal_mode = DELETE');
    for (const sql of schemaFor(db, ACCOUNT_TABLES)) {
      try { scoped.exec(sql); } catch { /* an index over a table not carried here is not an error */ }
    }
    for (const table of ACCOUNT_TABLES) {
      const column = table === 'users' ? 'id' : 'user_id';
      const rows = db.prepare(`SELECT * FROM ${table} WHERE ${column}=?`).all(userId);
      counts[table] = rows.length;
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      const insert = scoped.prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
      const write = scoped.transaction(all => { for (const row of all) insert.run(...columns.map(c => row[c])); });
      write(rows);
    }
    // A share that comes back live is a link to the internet the owner may have
    // forgotten. Revoked in the artifact itself rather than at restore time, so
    // the file on the disk never carries a working one.
    try { scoped.prepare("UPDATE shares SET revoked_at=COALESCE(revoked_at, datetime('now'))").run(); } catch { /* no shares table on an older box */ }
  } finally {
    scoped.close();
  }
  try { fs.chmodSync(dbCopy, FILE_MODE); } catch { /* as above */ }

  // 2. The bytes, from the rows just written.
  const entries = [];
  const problems = [];
  const claimed = new Set();
  let bytes = 0;

  const copyOut = (row, kind) => {
    const place = backup.placeOfDiskPath(uploadsDir, userId, row.disk_path);
    if (!place) {
      problems.push({ file_id: row.file_id || row.id, name: row.name, why: 'the row points nowhere inside the account storage' });
      return;
    }
    const basename = path.basename(path.resolve(row.disk_path));
    const source = path.resolve(row.disk_path);
    claimed.add(source);
    if (!fs.existsSync(source)) {
      problems.push({ file_id: row.file_id || row.id, name: row.name, why: 'the database has this file and the disk does not' });
      return;
    }
    const target = path.join(dir, FILES, backup.safeComponent(userId, 'account id'),
      backup.safeComponent(place, 'place'), backup.safeComponent(basename, 'file name'));
    const written = copyThenHash(source, target);
    bytes += written.bytes;
    entries.push({
      kind,
      file_id: row.file_id || row.id,
      version_id: kind === 'version' ? row.id : undefined,
      user_id: userId,
      place,
      basename,
      name: row.name,
      mime: row.mime,
      recorded_size: Number(row.size) || 0,
      bytes: written.bytes,
      sha256: written.sha256,
      trashed: kind === 'file' ? !!row.deleted_at : undefined,
    });
  };

  for (const row of db.prepare('SELECT id,name,size,mime,disk_path,deleted_at FROM files WHERE user_id=?').all(userId)) copyOut(row, 'file');
  for (const row of db.prepare('SELECT id,file_id,name,size,mime,disk_path FROM file_versions WHERE user_id=?').all(userId)) copyOut(row, 'version');

  // Bytes on this account's disk that no row of theirs claims. Not copied — they
  // are the mess `quota.reconcile` exists to find — but counted, because
  // silently dropping an unexpected file is how an archive gets called complete
  // when it is a subset, and this one is the last copy there will ever be.
  const unclaimed = [];
  for (const found of (() => {
    const out = [];
    for (const [place, root] of storageRoots.allRoots(uploadsDir, userId)) {
      let names = [];
      try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const entry of names) if (entry.isFile()) out.push({ place, full: path.join(root, entry.name), basename: entry.name });
    }
    return out;
  })()) {
    if (claimed.has(path.resolve(found.full))) continue;
    unclaimed.push({ place: found.place, basename: found.basename });
  }

  const status = problems.length ? 'incomplete' : 'ok';
  const manifest = {
    format: FORMAT,
    run_id: runId,
    label,
    created_at: at.toISOString(),
    status,
    // Who this was. The account row is inside the database, but a hoster reading
    // a list of archives needs to know whose it is without opening one, and an
    // archive outlives the row it came from.
    account: { id: account.id, name: account.name, email: account.email, created_at: account.created_at },
    // When it may be destroyed. Null means nobody has said, which is a decision
    // somebody still has to make rather than a licence to keep it for ever.
    keep_until: keepDays ? new Date(at.getTime() + Number(keepDays) * 86400000).toISOString() : null,
    database: { file: DB_FILE, sha256: backup.sha256OfFile(dbCopy), bytes: fs.statSync(dbCopy).size },
    counts: { ...counts, files_copied: entries.length, bytes, problems: problems.length, unclaimed_on_disk: unclaimed.length },
    excluded: [
      'sessions (never carried: an archive must not also be a set of working tokens)',
      'email tokens (live keys to an account that is being ended)',
      'share links come back revoked, so a restore does not republish to the internet',
    ],
    problems,
    unclaimed,
    entries,
  };

  const manifestText = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(dir, MANIFEST), manifestText, { mode: FILE_MODE });
  fs.writeFileSync(path.join(dir, SEAL), `${sha256OfText(manifestText)}\n`, { mode: FILE_MODE });

  return { id: runId, dir, status, manifest };
}

// ── Reading one back ────────────────────────────────────────────────────────

// The same hash-for-hash check a backup gets, because it is the same check:
// `backup.inspect` walks `entries`, rehashes every file and verifies the seal
// over the manifest. The one thing added here is the format string, so a
// whole-box backup handed to an account restore is refused rather than half read.
function inspect({ from }) {
  const found = backup.inspect({ from, expect: FORMAT });
  if (found.manifest && !backup.formatMatches(found.manifest.format, FORMAT)) {
    return { ...found, ok: false, problems: [...found.problems, `this is ${found.manifest.format}, which is not an account archive`] };
  }
  return found;
}

// What a hosting company sees: whose it was, how big, when it may go. Cheap —
// reads manifests, hashes nothing — because this is drawn on a screen and the
// count and the size are the two numbers the business runs on.
function list({ from }) {
  const dir = path.resolve(from);
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(dir, entry.name, MANIFEST);
    let manifest;
    let unreadable = null;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    // Capitalised, because this string is shown as a sentence of its own under a
    // heading and a lowercase start reads as a typo rather than as a fact.
    catch (error) { unreadable = `Its manifest could not be read: ${error.code === 'ENOENT' ? 'it is not there' : error.message}.`; }
    if (!unreadable && !backup.formatMatches(manifest.format, FORMAT)) {
      unreadable = `It is in an unknown format (${JSON.stringify(manifest.format)}), so nothing here can read it.`;
    }
    // A directory this cannot read is *reported*, not skipped.
    //
    // Skipping was the original behaviour and it is the wrong failure mode for
    // this directory in particular: an archive is a former customer's only copy,
    // and one that quietly does not appear is indistinguishable from one that
    // was never made. It happened on 2026-09-07 — an archive sat on the disk for
    // an hour while the console said there were none — and the only reason
    // anybody noticed was a count that did not match `ls`.
    //
    // So a broken archive gets a row with nothing invented in it: no account, no
    // size, no date, because none of that can be known. What it carries is where
    // it is and what is wrong with it, which is what somebody needs to go and
    // look. A number that cannot be trusted is worse than an admission.
    if (unreadable) {
      out.push({
        id: null,
        directory: entry.name,
        label: null,
        created_at: null,
        status: 'unreadable',
        problem: unreadable,
        account: null,
        keep_until: null,
        files: 0,
        bytes: 0,
      });
      continue;
    }
    out.push({
      id: manifest.run_id,
      directory: entry.name,
      label: manifest.label || null,
      created_at: manifest.created_at,
      status: manifest.status,
      account: manifest.account || null,
      keep_until: manifest.keep_until || null,
      files: (manifest.counts || {}).files_copied || 0,
      bytes: (manifest.counts || {}).bytes || 0,
    });
  }
  // Unreadable ones first, whatever their date — they have no date, and they are
  // the only rows on this screen that need somebody to do something.
  return out.sort((a, b) => {
    if ((a.status === 'unreadable') !== (b.status === 'unreadable')) return a.status === 'unreadable' ? -1 : 1;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
}

// ── Handing it back ─────────────────────────────────────────────────────────

// Restoring is a write to the live box, so it is proved before it is trusted:
// nothing is inserted until every hash in the archive has been checked. The
// account comes back under its own id, because the bytes on the disk are keyed
// by it and a restore that renamed the account would be a restore that moved
// every file.
//
// It refuses rather than merges. An id or an address already in use means
// something else is on the box now, and quietly overwriting it — or quietly
// renaming the thing coming back — is how a restore turns into a second
// incident.
function restore({ db, uploadsDir, from }) {
  const proved = inspect({ from });
  if (!proved.ok) throw new Error(`refusing to restore an archive that does not verify: ${proved.problems.join('; ')}`);
  const dir = path.resolve(from);
  const manifest = proved.manifest;
  const account = manifest.account || {};

  if (db.prepare('SELECT 1 FROM users WHERE id=?').get(account.id)) {
    throw new Error('an account with that id is already on this box');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(account.email)) {
    throw new Error(`there is already an account at ${account.email}, so this one cannot come back to it`);
  }

  const scoped = new Database(path.join(dir, DB_FILE), { readonly: true });
  let written = 0;
  let restoredBytes = 0;
  try {
    // The bytes first. A row without its file is a customer looking at a listing
    // of things that will not open, which is worse than a restore that failed.
    const roots = storageRoots.rootsFor(uploadsDir, account.id);
    for (const entry of manifest.entries || []) {
      const source = path.join(dir, FILES, backup.safeComponent(entry.user_id, 'account id'),
        backup.safeComponent(entry.place, 'place'), backup.safeComponent(entry.basename, 'file name'));
      if (!storageRoots.isInside(path.join(dir, FILES), source)) throw new Error(`entry ${entry.file_id} resolves outside the archive`);
      const root = entry.place === storageRoots.PUBLISHED ? roots.published
        : entry.place === storageRoots.VERSIONS ? roots.versions : roots.private;
      mkdirSecure(root);
      const target = path.join(root, backup.safeComponent(entry.basename, 'file name'));
      if (!storageRoots.isInside(root, target)) throw new Error(`entry ${entry.file_id} resolves outside the account storage`);
      fs.copyFileSync(source, target);
      try { fs.chmodSync(target, FILE_MODE); } catch { /* as above */ }
      restoredBytes += fs.statSync(target).size;
      written += 1;
    }

    // Then the rows, in one transaction, so a box that falls over half way
    // through does not come up holding a third of an account.
    const put = db.transaction(() => {
      for (const table of ACCOUNT_TABLES) {
        let rows = [];
        try { rows = scoped.prepare(`SELECT * FROM ${table}`).all(); } catch { continue; }
        if (!rows.length) continue;
        // `audit_log` comes back without its ids. They are a box-wide
        // AUTOINCREMENT sequence rather than anything about this account, so
        // carrying them means a restore either collides with rows written since
        // — every one of them somebody else's — or, worse, is quietly told to
        // ignore the collision and drops the customer's history while reporting
        // success. The `at` column is what orders a trail; the id never was.
        const columns = Object.keys(rows[0]).filter(c => !(table === 'audit_log' && c === 'id'));
        // A plain INSERT, not INSERT OR IGNORE. Anything that collides here is
        // something this restore did not expect, and the transaction rolling
        // back with a loud error is the right answer: a half-restored account
        // reported as restored is the failure worth designing against.
        const insert = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
        for (const row of rows) insert.run(...columns.map(c => row[c]));
      }
    });
    put();
  } finally {
    scoped.close();
  }

  return { account: { id: account.id, email: account.email, name: account.name }, files: written, bytes: restoredBytes };
}

// ── Ending it for real ──────────────────────────────────────────────────────

// The deliberate permanent deletion. Named `destroy` rather than `remove`
// because it is the one operation in this file that loses data, and a caller
// reading it should feel that.
function destroy({ from }) {
  const dir = path.resolve(from);
  if (!fs.existsSync(path.join(dir, MANIFEST))) throw new Error('that is not an archive, so it will not be deleted from here');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
  if (!backup.formatMatches(manifest.format, FORMAT)) throw new Error('that is not an account archive');
  fs.rmSync(dir, { recursive: true, force: true });
  return { id: manifest.run_id, account: manifest.account || null };
}

module.exports = { FORMAT, ACCOUNT_TABLES, take, inspect, list, restore, destroy };
