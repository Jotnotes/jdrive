'use strict';

// JotNotes JDrive.
//
// Files, sold through hosting companies and the resellers under them. The thing
// it competes with is Dropbox, and the thing Dropbox cannot do is let somebody
// else sell it under their own name at their own price. That is the whole
// business, and it is why the entitlements engine is here on day one rather than
// bolted on when the first reseller asks.
//
// This is its own product. Some of the code came out of Arca, which is a
// separate thing, and the two do not share a line at runtime. Nothing here knows
// what a website, a mailbox or a control panel is.
//
// WHAT A PERSON SEES
//
//   My Files   private, everything lands here, nobody but them
//   Public     anyone with the address can open it
//   Shared     a link they gave somebody, with a role and an expiry
//   Trash      deleted, until they empty it
//
// Which place a file is in is decided by which directory the bytes are in, never
// by a column. `control/workspaceFiles.js` explains why at length: a stored place
// can disagree with the disk, and when it does, the disagreement is silent and it
// is somebody's private file on the open internet.

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const storageRoots = require('./control/storageRoots');
const quota = require('./control/quota');
const backup = require('./control/backup');
const accountArchive = require('./control/accountArchive');
const workspaceFiles = require('./control/workspaceFiles');
const auditTrail = require('./control/auditTrail');
const { createOwnershipService, HIERARCHY } = require('./control/ownership');
const { createEntitlementsService } = require('./control/entitlements');
const { createMailer } = require('./control/mail');
const { createOffsite } = require('./control/offsite');
const folders = require('./control/folders');
const tagRules = require('./control/tags');
const exif = require('./control/exif');
const branding = require('./control/brand');
const migrations = require('./control/migrations');
const build = require('./control/build');
const { createUpdateService } = require('./control/updates');
const search = require('./control/search');
const edition = require('./edition');

// ── Configuration ───────────────────────────────────────────────────────────

// A secret that is absent is a secret that gets defaulted, and a default secret
// is every installation signing tokens with the same key. So it stops.
const JWT_SECRET = process.env.JWT_SECRET || (() => {
  // Three ways to arrive here and the message names all three, because the
  // container case reads this too and has no .env to edit.
  throw new Error('JWT_SECRET not set. The install script generates one in '
    + '/etc/jdrive/jdrive.env; in a container pass it with -e JWT_SECRET=...; '
    + 'from a checkout put it in server/.env. It signs every session, so keep whichever you make.');
})();
const PORT = parseInt(process.env.PORT || '9990', 10);
// What the box listens on, and it stays loopback unless somebody says otherwise.
//
// On metal that is the whole security posture: the box does not terminate TLS,
// so it must not be reachable until a reverse proxy is in front of it, and a
// default of 0.0.0.0 would put an un-proxied box on the internet the moment it
// started. Nothing that exists today changes behaviour, because the default is
// what was hardcoded before.
//
// A container is the case that needs it. Loopback inside a container is the
// container's own, so a published port reaches nothing and the box cannot be run
// that way at all — which is why this exists rather than because wider binding
// is ever wanted on a host. Setting it is a deliberate act by whoever runs the
// container, and the container's network is then the boundary the proxy was.
//
// The bootstrap port is not covered by this and never will be. See its listener.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const MAX_UPLOAD = parseInt(process.env.MAX_UPLOAD_MB || '2048', 10) * 1024 * 1024;
// Where a public file's address lives. Behind a proxy the box knows its own name
// better than a request header does, so a configured value wins and the request
// is only the fallback.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || null;

// The sites allowed to show this box inside a page of their own — a hosting
// company's client area, a school's intranet. Nobody by default: a page that can
// frame the box can lay its own buttons over it and have somebody click through
// to a delete they never saw. Named in the environment rather than in the
// console, so a stolen console session cannot add a site of its own. Each one is
// a whole https origin; anything else is refused and said so at start.
const EMBED_ASKED = String(process.env.EMBED_ORIGINS || '').split(',').map(one => one.trim()).filter(Boolean);
const EMBED_ORIGINS = EMBED_ASKED.filter(one => /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i.test(one)).map(one => one.toLowerCase());
const EMBED_REFUSED = EMBED_ASKED.filter(one => !EMBED_ORIGINS.includes(one.toLowerCase()));
// Where backups go, and the one rule about it that matters: not inside the thing
// they protect. Every customer-facing path in this product resolves inside
// `uploads/<user id>/`, and the orphan sweeper deletes inside there, so a backup
// under that tree is a copy the original can destroy. Kept out of `data/` too,
// because a restore renames that directory aside wholesale.
const BACKUPS_DIR = process.env.BACKUPS_DIR || path.join(__dirname, 'backups');

for (const dir of [DATA_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
const updates = createUpdateService({
  version: build.VERSION,
  stateFile: path.join(DATA_DIR, 'update-check.json'),
});
// Checked at boot rather than at backup time. A box that would write its backups
// into customer storage is misconfigured now, not in six months when somebody
// finds out during a recovery.
for (const [name, other] of [['the uploads directory', UPLOADS_DIR], ['the data directory', DATA_DIR]]) {
  const resolvedOther = path.resolve(other);
  const resolvedBackups = path.resolve(BACKUPS_DIR);
  if (resolvedOther === resolvedBackups
    || storageRoots.isInside(resolvedOther, resolvedBackups)
    || storageRoots.isInside(resolvedBackups, resolvedOther)) {
    console.error(`[jdrive] refusing to start: BACKUPS_DIR and ${name} are nested (${resolvedBackups} / ${resolvedOther}).`);
    console.error('[jdrive] a backup the original can reach is not a backup.');
    process.exit(1);
  }
}
fs.mkdirSync(BACKUPS_DIR, { recursive: true, mode: 0o700 });

// Archives of terminated accounts. Kept out of the customer tree for the reason
// backups are — the orphan sweeper deletes inside `uploads/` and a restore
// renames `data/` aside — and out of the backups directory as well, because the
// two are listed and destroyed by different rules and a whole-box backup that
// swept up every terminated customer's archive would be one artifact nobody
// could safely hand to anybody.
const ARCHIVES_DIR = process.env.ARCHIVES_DIR || path.join(__dirname, 'archives');
for (const [name, other] of [['the uploads directory', UPLOADS_DIR], ['the data directory', DATA_DIR], ['BACKUPS_DIR', BACKUPS_DIR]]) {
  const resolvedOther = path.resolve(other);
  const resolvedArchives = path.resolve(ARCHIVES_DIR);
  if (resolvedOther === resolvedArchives
    || storageRoots.isInside(resolvedOther, resolvedArchives)
    || storageRoots.isInside(resolvedArchives, resolvedOther)) {
    console.error(`[jdrive] refusing to start: ARCHIVES_DIR and ${name} are nested (${resolvedArchives} / ${resolvedOther}).`);
    console.error('[jdrive] a terminated account\'s archive is the only copy of it that exists.');
    process.exit(1);
  }
}
fs.mkdirSync(ARCHIVES_DIR, { recursive: true, mode: 0o700 });

// Where a message goes when there is no mail server to send it through, and the
// address the links inside one point at. A confirmation link that points at
// 127.0.0.1 works for the person installing the box and for nobody else, so a
// deployment sets APP_BASE_URL and the fallback exists to make a fresh install
// usable rather than to be correct in production.
const MAIL_SPOOL_DIR = process.env.MAIL_SPOOL_DIR || path.join(DATA_DIR, 'mail-spool');
// The desktop, built. A box with no build still works and is still the whole
// product over HTTP — that is how the audit drives it — so this is a thing that
// may or may not be there rather than a thing to fail on.
const WEB_DIST = process.env.WEB_DIST || path.join(__dirname, '..', 'web', 'dist');
const WEB_INDEX = path.join(WEB_DIST, 'index.html');
const hasShell = () => fs.existsSync(WEB_INDEX);
const APP_BASE_URL = String(process.env.APP_BASE_URL || PUBLIC_BASE_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');

// ── Database ────────────────────────────────────────────────────────────────

// The product was renamed on 2026-09-10 and the database was renamed with it.
// A box installed before that has `pocketdrive.db` sitting here, and opening a
// path that does not exist would create an empty one: the box would come up
// looking like a working box that had lost every customer on it. So this stops
// instead, and names the one command that fixes it. `install.sh` does the move
// itself, so this only ever fires for a box run straight from the source.
const DB_PATH = path.join(DATA_DIR, 'jdrive.db');
const LEGACY_DB_PATH = path.join(DATA_DIR, 'pocketdrive.db');
if (!fs.existsSync(DB_PATH) && fs.existsSync(LEGACY_DB_PATH)) {
  console.error(`[jdrive] refusing to start: this box has ${LEGACY_DB_PATH} and no ${path.basename(DB_PATH)}.`);
  console.error('[jdrive] the product was renamed, and starting would create an empty database beside your data.');
  console.error(`[jdrive] move it once, then start again:  mv ${JSON.stringify(LEGACY_DB_PATH)} ${JSON.stringify(DB_PATH)}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password      TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now')),
    suspended_at  TEXT,
    -- Null until the person behind the address proves they read mail sent to it.
    -- Until then the account exists and does nothing, because an account created
    -- under somebody else's address is impersonation and a box that will create
    -- one on request is a spam machine with a login page.
    verified_at   TEXT
  );

  -- One row per file. There is deliberately no column saying which place it is
  -- in: the disk_path says that already, and a second answer is a second answer
  -- that can be wrong.
  CREATE TABLE IF NOT EXISTS files (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    name        TEXT NOT NULL,
    size        INTEGER DEFAULT 0,
    mime        TEXT,
    folder      TEXT DEFAULT 'root',
    disk_path   TEXT,
    added_at    TEXT DEFAULT (datetime('now')),
    deleted_at  TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id);

  -- A signed token says who you are and cannot be taken back, which is fine
  -- until one is stolen. So a token names a session, and the session is a row
  -- that can be revoked. The cost is one indexed lookup per request; the thing
  -- it buys is that signing out means something and a compromise has an end.
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now')),
    last_seen   TEXT,
    user_agent  TEXT,
    ip          TEXT,
    revoked_at  TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  -- Confirming an address and resetting a password are the same shape: a secret
  -- that arrives by mail, works once, and then does not. Only a hash of it is
  -- stored, so a stolen copy of this database is not a set of working links into
  -- other people's accounts, which is exactly what a table of raw tokens is.
  CREATE TABLE IF NOT EXISTS email_tokens (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    purpose     TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TEXT DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    used_at     TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, purpose);

  -- Somewhere to put things. A folder is organisation and never location: the
  -- bytes do not move when a file is filed, and no folder decides who can see
  -- anything. The unique index is over the parent as well as the owner, so two
  -- folders can be called Invoices as long as they are not side by side, and the
  -- name collates without case because nobody means two different things by
  -- Invoices and invoices.
  --
  -- The parent is the string 'root' at the top rather than null, because SQLite treats
  -- nulls in a unique index as all different from each other, and that would
  -- have allowed any number of identically named folders at the top.
  CREATE TABLE IF NOT EXISTS folders (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    parent_id   TEXT NOT NULL DEFAULT 'root',
    name        TEXT NOT NULL COLLATE NOCASE,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_folders_user ON folders(user_id, parent_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_name ON folders(user_id, parent_id, name);

  -- A small picture of a file, so a page of them is a page of pictures rather
  -- than a page of icons. Held in the database on purpose: it is derived data
  -- rather than the customer's bytes, so it must not appear in the uploads tree
  -- where the storage meter counts and the orphan sweeper deletes. In here it is
  -- covered by the backup, it disappears with the file it belongs to, and it
  -- costs the customer nothing against their allowance.
  CREATE TABLE IF NOT EXISTS thumbnails (
    file_id  TEXT PRIMARY KEY,
    user_id  TEXT NOT NULL,
    mime     TEXT NOT NULL,
    bytes    BLOB NOT NULL,
    width    INTEGER,
    height   INTEGER,
    made_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- What a file used to be.
  --
  -- Customer recovery, and nothing to do with the operator's backup: this is the
  -- thing beside the Trash that answers "I saved over it". The bytes live in the
  -- account's own versions directory, so the meter counts them, the
  -- reconciliation walks them and the backup carries them — a version is the
  -- customer's storage and is paid for like the rest of it.
  --
  -- The row hangs off the file, so emptying the Trash takes the history with the
  -- file it belonged to.
  CREATE TABLE IF NOT EXISTS file_versions (
    id         TEXT PRIMARY KEY,
    file_id    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    mime       TEXT,
    disk_path  TEXT NOT NULL,
    made_at    TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_versions_file ON file_versions(file_id, made_at);
  CREATE INDEX IF NOT EXISTS idx_versions_user ON file_versions(user_id);

  -- What a photograph says about itself. Read from the file's own bytes at
  -- upload, or the first time anybody asks about an older one, and kept here
  -- rather than re-read every time: the answer cannot change unless the file
  -- does, and the file cannot change.
  --
  -- The found column is the difference between "there is nothing to say" and "nobody has
  -- looked yet", which is what stops a text file being opened and parsed on
  -- every request for ever.
  CREATE TABLE IF NOT EXISTS file_metadata (
    file_id          TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    found            INTEGER NOT NULL DEFAULT 0,
    read_at          TEXT DEFAULT (datetime('now')),
    camera_make      TEXT,
    camera_model     TEXT,
    lens             TEXT,
    software         TEXT,
    taken_at         TEXT,
    orientation      INTEGER,
    width            INTEGER,
    height           INTEGER,
    iso              INTEGER,
    f_number         REAL,
    exposure_seconds REAL,
    focal_length_mm  REAL,
    gps_lat          REAL,
    gps_lon          REAL,
    gps_altitude_m   REAL,
    -- What the XMP packet is, kept apart from the camera block because the two
    -- are removed by separate decisions. xmp_read is NULL until somebody has
    -- looked, which is what lets a row written before any of this existed be
    -- read again rather than reported as having no packet.
    xmp_read         INTEGER,
    xmp              INTEGER,
    xmp_readable     INTEGER,
    xmp_location     INTEGER,
    xmp_credit       INTEGER,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- The customer's own words for their own files. A tag belongs to an account
  -- rather than to a file, so the same word means the same thing across
  -- everything they own, and two files can share it without agreeing about
  -- anything else. Names collate without case: nobody means two different
  -- things by Invoices and invoices.
  CREATE TABLE IF NOT EXISTS tags (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    name       TEXT NOT NULL COLLATE NOCASE,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name ON tags(user_id, name);

  -- The owner is carried on the join as well as on both sides of it. It is
  -- redundant and it is deliberate: every query that reads this can be written
  -- to name the account, so a mistake in one of them cannot reach across into
  -- somebody else's files.
  CREATE TABLE IF NOT EXISTS file_tags (
    file_id  TEXT NOT NULL,
    tag_id   TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    added_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (file_id, tag_id),
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(user_id, tag_id);

  -- A share is a key somebody was handed to something private. It is a row
  -- rather than a clever path, so it can be taken back: a link whose only
  -- protection is being hard to guess cannot be revoked, and the customer who
  -- sent one to the wrong person has no way back.
  --
  -- Only the hash of the token is here, which means the link cannot be shown
  -- again once it is made. That is deliberate and it is a real trade: a stolen
  -- database yields no working links, and the cost is that re-copying a link
  -- means issuing a new one and retiring the old. Whether the shell should be
  -- able to show it again is an open product question, not one this file gets to
  -- settle.
  CREATE TABLE IF NOT EXISTS shares (
    id          TEXT PRIMARY KEY,
    file_id     TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    token_hash  TEXT NOT NULL UNIQUE,
    role        TEXT NOT NULL DEFAULT 'view',
    password    TEXT,
    label       TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL,
    revoked_at  TEXT,
    FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_shares_file ON shares(file_id);
  CREATE INDEX IF NOT EXISTS idx_shares_user ON shares(user_id);

  -- Whose product this is.
  --
  -- One brand, per box. The hosting company owns the box, so the brand is
  -- theirs, and a reseller sells one level down under the same name: a brand of
  -- the reseller's own is deliberately not built, because it is a second product
  -- to support rather than a feature.
  --
  -- The bytes are in here beside the thumbnails and for the same reason. They
  -- are not the customer's storage, so they must not sit in the uploads tree
  -- where the meter counts them and the orphan sweeper deletes them. In here
  -- they are also carried by the whole-database backup, which matters more than
  -- it sounds: a recovery that brings back every file and loses whose product it
  -- is has restored the data and not the business.
  CREATE TABLE IF NOT EXISTS brand (
    id             TEXT PRIMARY KEY,
    name           TEXT,
    tagline        TEXT,
    accent         TEXT,
    support_url    TEXT,
    support_email  TEXT,
    logo_mime      TEXT,
    logo_bytes     BLOB,
    icon_mime      TEXT,
    icon_bytes     BLOB,
    wallpaper_mime TEXT,
    wallpaper_bytes BLOB,
    updated_at     TEXT DEFAULT (datetime('now')),
    updated_by     TEXT
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   TEXT,
    action    TEXT NOT NULL,
    ip        TEXT,
    details   TEXT,
    at        TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, at);
`);

// The column above is new, and on a box that has been running it arrives at a
// table full of accounts that were created before the rule existed. They are
// marked confirmed as it lands. An upgrade that locks out every existing
// customer at once is a worse fault than the one being fixed, and their
// addresses were never in doubt: somebody sold to them. Everything created from
// here starts unconfirmed.
if (!db.prepare('PRAGMA table_info(users)').all().some(c => c.name === 'verified_at')) {
  db.exec('ALTER TABLE users ADD COLUMN verified_at TEXT');
  const carried = db.prepare("UPDATE users SET verified_at=datetime('now') WHERE verified_at IS NULL").run().changes;
  if (carried) console.log(`[jdrive] ${carried} account(s) predate address confirmation and were marked confirmed.`);
}

// Existing boxes gain the same database-backed asset storage as new boxes.
for (const [column, type] of [['wallpaper_mime', 'TEXT'], ['wallpaper_bytes', 'BLOB']]) {
  if (!db.prepare('PRAGMA table_info(brand)').all().some(c => c.name === column)) {
    db.exec(`ALTER TABLE brand ADD COLUMN ${column} ${type}`);
  }
}

// What a file's XMP packet says, which is a separate question from what its
// camera block says and gets a separate answer from the customer. Existing rows
// leave xmp_read NULL, so the next request reads the packet rather than
// reporting confidently that there is not one.
for (const column of ['xmp_read', 'xmp', 'xmp_readable', 'xmp_location', 'xmp_credit']) {
  if (!db.prepare('PRAGMA table_info(file_metadata)').all().some(c => c.name === column)) {
    db.exec(`ALTER TABLE file_metadata ADD COLUMN ${column} INTEGER`);
  }
}

// Which sessions are somebody signing in as somebody else. A column rather than
// a claim in the token: what a session is allowed to do must never be decided by
// a value the holder of the token supplies. Existing sessions are nobody's but
// their owner's, which NULL already says.
if (!db.prepare('PRAGMA table_info(sessions)').all().some(c => c.name === 'impersonated_by')) {
  db.exec('ALTER TABLE sessions ADD COLUMN impersonated_by TEXT');
}

// Everything above this line is the guarded, idempotent shape every box already
// has. Everything after it is ordered, applied once and recorded — see
// `control/migrations.js` for why the two halves are kept apart rather than one
// being rewritten into the other.
//
// This runs before the services below are built, because a service that opens a
// table a migration is about to change is a race nobody can debug. A database
// written by a newer build throws here, which stops the box: that is the point.
{
  const result = migrations.run({ db, log: line => console.log(line) });
  if (result.applied.length && !result.adopted) {
    console.log(`[jdrive] schema now at migration ${result.version}`);
  }
}

const ownership = createOwnershipService({
  db,
  // The live subtree, which `withinReach` is written to consult and was never
  // given. Without it that function collapses to "your own organization, or you
  // run the box", so a reseller reached nothing but themselves and every caller
  // relying on it quietly under-reached. An active link is the whole condition,
  // which is what makes ending one end the reach in the same breath.
  administersOrg: (parentOrgId, childOrgId) => !!db.prepare(
    `SELECT 1 FROM organization_accounts WHERE parent_org_id=? AND child_org_id=? AND status='active'`,
  ).get(parentOrgId, childOrgId),
});
// Who a seller sells to directly: the one level down that the account list shows.
// One query for it, because the account list and the overview both answer this
// question and two copies of a scoping query are two places for it to go wrong.
const sellsToDirectly = orgId => db.prepare(`SELECT child_org_id FROM organization_accounts
    WHERE parent_org_id=? AND status='active'`).all(orgId).map(row => row.child_org_id);

// No privileged jobs here. In Arca this reads a customer's disk usage by running
// `du` as root over a website's directory. JotNotes JDrive's files are all in one
// tree this process owns, so the reader below measures them directly and there is
// nothing to escalate for.

// The Hosting edition, when this box has it. Loaded here and registered after the
// core routes, near the end of this file; null on a Community box. See edition.js.
const HostingEdition = edition.load();
const hosting = HostingEdition ? HostingEdition.create({ db, audit, ownership }) : null;

// Asked before anything is parsed, so a refused upload never touches the disk.
// Community has nothing to ask. The Hosting edition asks its licence, and says what
// to answer when the licence refuses.
function gate(action) {
  return (req, res, next) => {
    const refused = hosting ? hosting.refuses(action, req) : null;
    if (!refused) return next();
    res.status(refused.status).json(refused.body);
  };
}

const entitlements = createEntitlementsService({
  db,
  // What this product sells. Declared here rather than defaulted in the engine,
  // because a default list is one a product inherits by accident.
  //
  // [key, unit, period, supportsReservation, enabled, displayOrder]
  // One capacity metric, because this product sells one thing by quantity:
  // storage. Seats were declared here briefly and removed: whether the unit is a
  // seat or an account is an open product question, nothing measures seats, and
  // the boot check below refused to start rather than let a metric be sold that
  // could not be enforced. Add a metric when there is something to measure it
  // with, not before.
  metrics: [
    ['storage_bytes', 'bytes', 'current', 1, 1, 1],
    // Transfer, when the Hosting edition is here to measure it.
    ...(hosting ? hosting.metrics : []),
  ],
  // On and free unless a company selling this decides to charge. They set the
  // tiers, not us, and one who configures nothing ships the whole product.
  //
  // Every key here gates something. Six more were registered before the code
  // behind them existed — share links, version history, watermarking, viewer
  // analytics, file requests, spot storage — and a hosting company could build a
  // plan that switched any of them off, charge to switch it back on, and the
  // product behaved identically either way. That is selling nothing for money,
  // and it is the same defect this product has now had three times: a name in a
  // registry standing in for a feature. They came out. Each one comes back in
  // the commit that makes it do something, and not before — which is why
  // `files_share_links` is here again: share links exist, and creating one asks
  // this before it does anything.
  features: [
    ['files_public', 'items', 3],
    ['files_share_links', 'items', 4],
    // How long the Trash holds on before it empties itself, in days. A hoster
    // who prices nothing gets the box default; one who wants to sell ninety days
    // of undo puts it in a package. Unlimited means exactly that, and it is a
    // thing a hoster is allowed to sell.
    ['files_trash_days', 'days', 5],
    // And how long a file's earlier versions are kept. Same shape, same rule, and
    // here for the same reason the others are: the sweep below reads it, so it
    // gates something. It was deliberately absent until today.
    ['files_version_days', 'days', 6],
  ],
  // How much of each metric an organization is using. A metric with no reader
  // here is UNKNOWN to the engine, and unknown refuses rather than passing, so a
  // metric can never be sold and then silently not enforced.
  usageReaders: {
    storage_bytes: quota.subtreeUsageReader({ db, uploadsDir: UPLOADS_DIR }),
    ...(hosting ? hosting.usageReaders : {}),
  },
});

// A metric this deployment sells and cannot measure is a limit that cannot be
// enforced, so it stops the box rather than being discovered on an invoice.
const unmetered = entitlements.unmeteredMetrics();
if (unmetered.length) {
  console.error(`[jdrive] refusing to start: no usage reader for ${unmetered.join(', ')}.`);
  console.error('[jdrive] a metric that is sold and not measured is a limit that does not exist.');
  process.exit(1);
}

const uid = () => crypto.randomBytes(8).toString('hex');

function audit(userId, action, req, details = '') {
  const headers = (req && req.headers) || {};
  const ip = headers['x-real-ip'] || headers['x-forwarded-for'] || (req && req.ip) || 'this machine';
  try {
    db.prepare('INSERT INTO audit_log (user_id,action,ip,details) VALUES (?,?,?,?)')
      .run(userId || null, action, ip, String(details).slice(0, 2000));
  } catch { /* the trail must never be the reason a request fails */ }
}

// ── Mail, and the two things that ride on it ────────────────────────────────

const mailer = createMailer({ spoolDir: MAIL_SPOOL_DIR });

// ── Where the artifact goes when it leaves ──────────────────────────────────
//
// Read from the environment once, at boot, and never from the database. The
// backup contains the database, so a bucket credential stored there would be
// copied into every artifact and the artifact would become a working key to the
// bucket holding all the others. See `control/offsite.js`.
const offsite = createOffsite({ env: process.env });

// ── Whose product this is ───────────────────────────────────────────────────
//
// Read from the database each time rather than held in a module variable. A
// hosting company who changes their logo and has to restart the box to see it
// has not been sold a white-label product, and this is one row by primary key.
//
// Nothing below decides anything. Branding is presentation and stays
// presentation: no authorization, quota or entitlement path reads a field of it,
// which is what `DELIVERY_CONTRACTS.md` G4 promises and what G4.1-G4.4 prove.
const BRAND_ID = 'box';

function brandRow() {
  return db.prepare(`SELECT name, tagline, accent, support_url, support_email,
      logo_mime, LENGTH(logo_bytes) AS logo_len,
      icon_mime, LENGTH(icon_bytes) AS icon_len,
      LENGTH(wallpaper_bytes) AS wallpaper_len, updated_at
    FROM brand WHERE id=?`).get(BRAND_ID) || null;
}

const brandShown = () => branding.shown(brandRow());

// A message from a hosting company, not from us. Their name is on the envelope,
// in the subject and at the foot of it, and where they have set none the message
// names no product at all rather than naming ours.
//
// This is also the last place a brand field can do damage: a name with a newline
// in it is a second mail header, which is how a confirmation message acquires a
// Bcc. `control/brand.js` takes control characters out on the way in and the
// display name is quoted here, so both ends hold.
function brandedMessage({ to, subject, text }) {
  const brand = brandShown();
  const help = brand.supportUrl || (brand.supportEmail ? `mailto:${brand.supportEmail}` : '');
  const footer = [brand.name, help ? `Need help? ${help.replace(/^mailto:/, '')}` : ''].filter(Boolean);
  return {
    to,
    from: brand.name ? `"${brand.name.replace(/["\\]/g, '')}" <${mailer.from}>` : mailer.from,
    subject: brand.name ? `${subject} \u00b7 ${brand.name}` : subject,
    text: footer.length ? `${text}\n-- \n${footer.join('\n')}\n` : text,
  };
}

// How long a link lives, in minutes. A confirmation link is followed whenever
// somebody next opens their mail, so it is generous. A reset link is a live key
// to an account and is not.
const TOKEN_MINUTES = { verify: 7 * 24 * 60, reset: 60 };

const hashToken = raw => crypto.createHash('sha256').update(String(raw)).digest('hex');

// Issuing one retires whatever was outstanding for the same purpose. Asking for
// a second reset link must kill the first, or a mail account somebody lost
// access to last week is still holding a working key to this one.
function issueEmailToken(userId, purpose) {
  db.prepare("UPDATE email_tokens SET used_at=datetime('now') WHERE user_id=? AND purpose=? AND used_at IS NULL")
    .run(userId, purpose);
  const raw = crypto.randomBytes(32).toString('base64url');
  db.prepare(`INSERT INTO email_tokens (id,user_id,purpose,token_hash,expires_at)
    VALUES (?,?,?,?, datetime('now', ?))`)
    .run(uid() + uid(), userId, purpose, hashToken(raw), `+${TOKEN_MINUTES[purpose]} minutes`);
  return raw;
}

// Used, expired and never-existed all answer the same way: nothing. And the row
// is claimed with a conditional update whose `changes` count is the decision, so
// two requests arriving with the same token cannot both be told yes.
function consumeEmailToken(raw, purpose) {
  if (!raw || typeof raw !== 'string') return null;
  const row = db.prepare(`SELECT id,user_id FROM email_tokens
    WHERE token_hash=? AND purpose=? AND used_at IS NULL AND expires_at > datetime('now')`)
    .get(hashToken(raw), purpose);
  if (!row) return null;
  const claimed = db.prepare("UPDATE email_tokens SET used_at=datetime('now') WHERE id=? AND used_at IS NULL")
    .run(row.id).changes;
  return claimed === 1 ? row : null;
}

// `opening` is the first line and nothing else. The same link, the same rules,
// but a person whose address was just corrected is not being told an account was
// created for them, because it was not, and a message that describes the wrong
// event is a message that gets ignored the next time it is right.
async function sendVerification(user, req, opening = 'An account was created for this address.') {
  const raw = issueEmailToken(user.id, 'verify');
  const link = `${APP_BASE_URL}/verify-email?token=${raw}`;
  const sent = await mailer.send(brandedMessage({
    to: user.email,
    subject: 'Confirm your address',
    text: `${opening}\n\nConfirm it here:\n${link}\n\n`
      + `The link works once and expires in seven days. If you were not expecting this, ignore it: `
      + `the account cannot be used until somebody follows the link.\n`,
  }));
  // A confirmation that was never sent is a customer who cannot get in and a
  // support ticket nobody can explain, so the failure is written down at the
  // moment it happens rather than discovered later.
  audit(user.id, sent.ok ? 'verification_sent' : 'verification_send_failed', req,
    sent.ok ? `${sent.mode} ${sent.id || ''}` : sent.error);
  return sent;
}

function verifyWithToken(raw, req) {
  const row = consumeEmailToken(raw, 'verify');
  if (!row) return false;
  db.prepare("UPDATE users SET verified_at=datetime('now') WHERE id=? AND verified_at IS NULL").run(row.user_id);
  audit(row.user_id, 'email_verified', req);
  announce('account.confirmed', row.user_id);
  return true;
}

// ── App ─────────────────────────────────────────────────────────────────────

const app = express();
app.set('trust proxy', 1);
app.use(helmet({
  crossOriginResourcePolicy: false,
  // A preview is fetched with the token and drawn from a blob URL, because the
  // <img> tag cannot carry an Authorization header. The default policy allows
  // 'self' and data: and would block exactly that, so the picture of your own
  // file would silently not appear.
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      // A preview is the customer's own file, fetched with their token and held
      // as a blob, because an <img>, a <video> or a <frame> cannot carry an
      // Authorization header. So blob: is allowed for the three things that
      // display bytes, and for nothing else.
      //
      // What this does not do is let a file become script. Nothing widens
      // script-src, object-src stays 'none', and every blob this page makes is
      // built with a type this code chose rather than one the file claimed —
      // a browser does not sniff a blob URL, so a PDF frame renders a PDF or
      // renders nothing.
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:'],
      'frame-src': ["'self'", 'blob:'],
      // Who may put this box in a frame. Only itself, unless EMBED_ORIGINS names
      // somebody else.
      'frame-ancestors': ["'self'", ...EMBED_ORIGINS],
    },
  },
  // X-Frame-Options cannot name another site, so with a site named it has to go
  // and frame-ancestors above carries the rule; without one it stays for the
  // browsers that read it.
  xFrameOptions: EMBED_ORIGINS.length ? false : { action: 'sameorigin' },
}));
app.use(cors({ origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
  next();
};

// ── Auth ────────────────────────────────────────────────────────────────────

// Two limits on sign-in, because one is always wrong. Per address and machine
// is the one that stops password guessing. Per machine alone is the one that
// stops somebody working through a list of addresses — but on its own it also
// locks out an office of thirty people behind one NAT address, all signing in on
// Monday morning, which is a support call the hoster gets and cannot explain.
// So the strict count is keyed on both, and the loose one on the address alone.
const loginKey = req => `${req.ip}|${String((req.body && req.body.email) || '').trim().toLowerCase()}`;
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyGenerator: loginKey, standardHeaders: true, legacyHeaders: false });
const loginIpLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
// Anything that makes this box send mail to an address a stranger chose. Loose
// enough that a person clicking resend twice never sees it, tight enough that
// the box cannot be turned into somebody's mail cannon. The stronger guard is
// that a new link retires the last one, so the flood is at most one live token.
const mailLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// ── The machine credential ──────────────────────────────────────────────────
//
// A billing system's way in, on a box with the Hosting edition.
// Mounted here, before any route, because it has to see a request first. A Community
// box has no machine credential, so a request carrying one reaches the human path
// and is refused there like any other token that is not a session.
if (hosting) hosting.beforeRoutes({ app, ownership, entitlements, quota, mailer, brandedMessage });

// Telling a seller's own systems that one of their accounts changed. Only the
// Hosting edition has anywhere to send it; on a Community box this does nothing.
const announce = (type, userId, extra) => (hosting && hosting.announce ? hosting.announce(type, userId, extra) : null);

function auth(req, res, next) {
  // A machine credential already proved itself above, and the allowlist already
  // decided this route is one it may reach. What is left is the half of this
  // function that belongs to the *account* rather than to the session: does it
  // still exist, is it suspended, is it confirmed. Sharing that rather than
  // copying it is why suspending a reseller stops their billing key at the same
  // instant, with no second rule to keep in step.
  if (req.machineUserId) {
    const holder = db.prepare('SELECT id,name,email,suspended_at,verified_at FROM users WHERE id=?').get(req.machineUserId);
    if (!holder) return res.status(401).json({ error: 'That key is not valid.' });
    if (holder.suspended_at) return res.status(403).json({ error: 'This account is suspended.' });
    if (!holder.verified_at) return res.status(403).json({ error: 'Confirm your address before using this account.' });
    req.user = holder;
    return next();
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sign in first.' });
  try {
    const claims = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id,name,email,suspended_at,verified_at FROM users WHERE id=?').get(claims.sub);
    if (!user) return res.status(401).json({ error: 'Sign in first.' });
    // The token is valid. The question this asks is whether it is still wanted.
    // A token with no session at all is refused rather than trusted: that is
    // every token issued before sessions existed, and treating those as valid
    // would mean the fix does not apply to the tokens most likely to be loose.
    const session = claims.sid ? db.prepare('SELECT id,revoked_at,impersonated_by FROM sessions WHERE id=? AND user_id=?').get(claims.sid, user.id) : null;
    if (!session || session.revoked_at) return res.status(401).json({ error: 'Sign in again.' });
    db.prepare("UPDATE sessions SET last_seen=datetime('now') WHERE id=?").run(session.id);
    req.session = session;
    // Read off the session row, never off the token. A claim in a JWT is a value
    // the holder carries, and a holder who can drop a field is a holder who can
    // turn an impersonated session into an ordinary one and walk through every
    // gate below. The row is the box's own record and the token cannot touch it.
    req.impersonator = session.impersonated_by
      ? db.prepare('SELECT id,name,email FROM users WHERE id=?').get(session.impersonated_by) || { id: session.impersonated_by }
      : null;
    // A borrowed session is only borrowed for as long as the policy still allows
    // it. Checked here, on every request, for the same reason suspension is: a
    // hosting company who switches support access off and is told "it stops in
    // an hour" has not switched it off. The route that writes the setting revokes
    // these sessions itself; this is the layer that holds when the setting is
    // written some other way — a restore, a second route, a hand edit — and it
    // reads the policy of the account being sat in, never of whoever is sitting
    // in it.
    // A Community box has no support access, so a borrowed session there — left
    // over from a box that once had the Hosting edition — is never allowed.
    if (req.impersonator && !(hosting && hosting.supportAllows(user.id))) {
      db.prepare("UPDATE sessions SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL").run(session.id);
      return res.status(401).json({ error: 'Sign in again.' });
    }
    // A suspended account keeps its files and loses its access. Checked on every
    // request rather than at sign-in, so suspending somebody takes effect now and
    // not whenever their token happens to expire.
    if (user.suspended_at) return res.status(403).json({ error: 'This account is suspended.' });
    // Checked here as well as at sign-in, because sign-in is one way tokens get
    // issued and the rule belongs to the account rather than to the route.
    if (!user.verified_at) return res.status(403).json({ error: 'Confirm your address before using this account.' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Sign in first.' });
  }
}

app.post('/api/login', loginIpLimiter, loginLimiter,
  [body('email').isEmail().normalizeEmail(), body('password').isLength({ min: 1 })], validate,
  (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(req.body.email);
    // The same answer and the same shape whether the address is unknown or the
    // password is wrong, because telling them apart is a way to enumerate who has
    // an account here.
    if (!user || !bcrypt.compareSync(req.body.password, user.password)) {
      audit(user ? user.id : null, 'login_failed', req, req.body.email);
      return res.status(401).json({ error: 'That email and password do not match.' });
    }
    if (user.suspended_at) return res.status(403).json({ error: 'This account is suspended.' });
    // Told plainly, and only to somebody who already had the password. There is
    // nothing to learn here that they did not just prove they knew.
    if (!user.verified_at) {
      audit(user.id, 'login_unverified', req);
      return res.status(403).json({ error: 'Confirm your address first. The link was mailed when the account was created.' });
    }
    const sid = uid() + uid();
    db.prepare('INSERT INTO sessions (id,user_id,user_agent,ip,last_seen) VALUES (?,?,?,?,datetime(\'now\'))')
      .run(sid, user.id, String(req.headers['user-agent'] || '').slice(0, 300),
        req.headers['x-real-ip'] || req.ip || '');
    const token = jwt.sign({ sub: user.id, sid }, JWT_SECRET, { expiresIn: '30d' });
    audit(user.id, 'login', req);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  });

// Signing out, and the version of it that matters: ending every session at once,
// which is what somebody does when they think a device or a password is gone.
app.post('/api/logout', auth, (req, res) => {
  db.prepare("UPDATE sessions SET revoked_at=datetime('now') WHERE id=? AND revoked_at IS NULL").run(req.session.id);
  audit(req.user.id, 'logout', req, `session ${req.session.id.slice(0, 8)}`);
  res.json({ ok: true });
});

app.post('/api/logout-all', auth, (req, res) => {
  const n = db.prepare("UPDATE sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL")
    .run(req.user.id).changes;
  audit(req.user.id, 'logout_all', req, `${n} session(s)`);
  res.json({ ok: true, revoked: n });
});

// What is signed in, so somebody can see a session they do not recognise and end
// it. The id is shown truncated: enough to tell two apart, useless to a thief.
app.get('/api/sessions', auth, (req, res) => {
  const rows = db.prepare(`SELECT id,created_at,last_seen,user_agent,ip,revoked_at FROM sessions
    WHERE user_id=? ORDER BY created_at DESC LIMIT 50`).all(req.user.id);
  res.json(rows.map(r => ({
    id: r.id.slice(0, 8), created_at: r.created_at, last_seen: r.last_seen,
    user_agent: r.user_agent, ip: r.ip, revoked: !!r.revoked_at,
    current: r.id === req.session.id,
  })));
});

// Suspending somebody must also end their sessions, or they keep the tab they
// already have open. Kept next to the session code rather than in the suspend
// route so the two cannot drift apart.
function revokeAllSessions(userId) {
  return db.prepare("UPDATE sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL")
    .run(userId).changes;
}

app.get('/api/me', auth, (req, res) => {
  const membership = ownership.getMembership(req.user.id);
  res.json({
    ...req.user,
    role: membership ? membership.role : null,
    org_id: membership ? membership.orgId : null,
    // Said by the box rather than worked out by the shell. A borrowed session
    // that looks exactly like an ordinary one is how somebody forgets whose
    // account they are typing in, and the banner has to come from the same place
    // the refusals do or the two can disagree.
    impersonated_by: req.impersonator ? { id: req.impersonator.id, name: req.impersonator.name, email: req.impersonator.email } : null,
  });
});

// ── Accounts ────────────────────────────────────────────────────────────────
//
// There is no public sign-up. Somebody sells this to you, and that somebody is a
// hosting company or one of their resellers, so accounts are created by the tier
// above. That is not a limitation to work around later, it is the business.
//
// The first account is the exception, and it is the only one: on a brand new box
// there is nobody to ask, so the installer creates the operator over a loopback
// listener that is not reachable from the network. After that the door is shut
// and every account comes from the tier above.

const BOOTSTRAP_PORT = parseInt(process.env.BOOTSTRAP_PORT || '9991', 10);

// `verified` is a decision this file makes, never a field off a request. It is
// spelled out at both call sites for that reason: the moment it can arrive in a
// body, confirming an address is optional for anybody who reads the API.
function createAccount({ name, email, password, createdBy = null, verified = false }) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) throw new Error('A real email address is required.');
  if (String(password || '').length < 12) throw new Error('A password of at least 12 characters is required.');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(clean)) throw new Error('There is already an account with that address.');
  const id = uid();
  db.prepare(`INSERT INTO users (id,name,email,password,verified_at)
    VALUES (?,?,?,?, CASE WHEN ? THEN datetime('now') ELSE NULL END)`)
    .run(id, String(name || '').trim() || clean, clean, bcrypt.hashSync(String(password), 12), verified ? 1 : 0);
  // An organization of their own immediately rather than at the next restart. In
  // Arca this was a real bug: a freshly installed box had a user with no
  // membership, so the only account on the machine could not do anything and it
  // was invisible until something unrelated created the membership by accident.
  try { ownership.ensureMembership(id); } catch (error) { audit(id, 'membership_not_created', null, error.message); }
  // And hung under whoever created them. Without this the new account has an
  // organization of its own that belongs to nobody, so the hosting company that
  // just sold them a plan cannot assign it: the entitlements engine refuses,
  // correctly, because the customer is not a child of theirs.
  //
  // This was missed on the first pass and it is the whole pricing model. Nothing
  // failed at the time, because creating the account worked and the gap only
  // appears later, at the moment somebody tries to sell something.
  if (createdBy) {
    try {
      const parent = ownership.getMembership(createdBy);
      const child = ownership.getMembership(id);
      if (parent && child) entitlements.linkOrganizations(parent.orgId, child.orgId, createdBy);
    } catch (error) {
      audit(id, 'account_not_linked_to_creator', null, error.message);
    }
  }
  return id;
}

// The operator's organization holds the machine. Everything a reseller or a
// customer is given is allocated downward from it, and there is nobody above it
// to allocate from, so it is the root. Marked at every start and on every
// bootstrap, and it can only ever name the same organization because a box has
// exactly one hosting_company membership.
function ensureEntitlementRoot() {
  const operator = db.prepare(`SELECT org_id FROM memberships WHERE role='hosting_company'
    ORDER BY created_at ASC, identity_id ASC LIMIT 1`).get();
  if (!operator) return null;
  if (entitlements.isRoot(operator.org_id)) return { orgId: operator.org_id, created: false };
  entitlements.markRoot(operator.org_id, 'bootstrap');
  return { orgId: operator.org_id, created: true };
}
ensureEntitlementRoot();

// Creating a customer. Reserved to an account that outranks an end user, so a
// customer cannot mint customers, and refused outright otherwise.
app.post('/api/accounts', auth, gate('new_account'),
  [body('email').isEmail().normalizeEmail(), body('password').isLength({ min: 12 }),
    body('name').trim().isLength({ min: 1 }), body('role').optional().isIn(['end_user', 'reseller'])], validate,
  async (req, res) => {
    const membership = ownership.getMembership(req.user.id);
    if (!membership || membership.rank <= HIERARCHY.end_user) {
      return res.status(403).json({ error: 'Only a hosting company or a reseller can create accounts.' });
    }
    // A seller can only make somebody who ranks below them: a hosting company
    // can make a reseller, a reseller cannot, and nobody can make a peer. The
    // rank comparison is the whole rule, so a third level cannot appear by
    // somebody passing a string.
    const wanted = req.body.role === 'reseller' ? 'reseller' : 'end_user';
    // Resellers are the Hosting edition's. Refused by name rather than quietly
    // made into a customer, because an account created as the wrong thing is a
    // mistake nobody notices until it cannot sell.
    if (wanted === 'reseller' && !hosting) {
      return res.status(403).json({ error: 'Resellers are part of JDrive for Hosting. This box can add people, not sellers.' });
    }
    if (HIERARCHY[wanted] >= membership.rank) {
      return res.status(403).json({ error: 'You can only create an account below your own.' });
    }
    try {
      const email = String(req.body.email).toLowerCase();
      const id = createAccount({ name: req.body.name, email, password: req.body.password, createdBy: req.user.id });
      if (wanted === 'reseller') hosting.makeReseller({ id, email, req });
      audit(req.user.id, 'account_created', req, `${email} created by ${req.user.email}`);
      announce('account.created', id);
      // The seller is told whether the message went, because they are the one
      // the customer will phone when it did not.
      const sent = await sendVerification({ id, email }, req);
      res.json({ ok: true, userId: id, email, confirmation: sent.ok ? sent.mode : 'not sent', error: sent.ok ? undefined : sent.error });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

// ── Confirming an address, and getting back in ──────────────────────────────
//
// Both flows are the same three steps: a secret goes to the address, the address
// sends it back, the secret dies. Neither one will tell an anonymous caller
// whether an address is on this box, because a product whose reset form answers
// differently for a real customer is a customer list with a search box.

// The link a person clicks in their mail client. A GET that changes something is
// usually wrong; here the token is the whole authorization and a mail client
// offers a link, not a form. The shell will own a page for this later. Until
// then the reply is plain text and it is honest about what happened.
app.get('/verify-email', mailLimiter, (req, res) => {
  // With a shell built, the link opens the product: the page confirms through
  // the API and puts a sign-in in front of the person while they are still
  // holding the thought. Without one — an API-only box — the plain answer below
  // is the whole interface, and it still works with script switched off.
  if (sendShell(res)) return;
  const done = verifyWithToken(req.query.token, req);
  res.status(done ? 200 : 400).type('text/plain').send(done
    ? 'Address confirmed. You can sign in now.\n'
    : 'That link has expired or has already been used. Ask for another one.\n');
});

app.post('/api/verify-email', mailLimiter,
  [body('token').isString().isLength({ min: 20 })], validate,
  (req, res) => {
    if (!verifyWithToken(req.body.token, req)) {
      return res.status(400).json({ error: 'That link has expired or has already been used.' });
    }
    res.json({ ok: true });
  });

// Another link, for the one that went to spam. The same answer whatever the
// address is, including addresses that are already confirmed: telling somebody
// which is which is telling them who has an account here.
app.post('/api/verify-email/resend', mailLimiter,
  [body('email').isEmail().normalizeEmail()], validate,
  async (req, res) => {
    const user = db.prepare('SELECT id,email,verified_at,suspended_at FROM users WHERE email=?').get(req.body.email);
    if (user && !user.verified_at && !user.suspended_at) await sendVerification(user, req);
    res.json({ ok: true });
  });

// A forgotten password. Nothing about the answer changes with the address: same
// status, same body, same work whether or not anybody is there.
app.post('/api/password-reset', mailLimiter,
  [body('email').isEmail().normalizeEmail()], validate,
  async (req, res) => {
    const user = db.prepare('SELECT id,email,suspended_at FROM users WHERE email=?').get(req.body.email);
    // A suspended account is not a locked-out customer, it is a customer the
    // seller switched off, and letting them reset their way back in would make
    // suspension advisory.
    if (user && !user.suspended_at) {
      const raw = issueEmailToken(user.id, 'reset');
      const link = `${APP_BASE_URL}/password-reset?token=${raw}`;
      const sent = await mailer.send(brandedMessage({
        to: user.email,
        subject: 'Reset your password',
        text: `Somebody asked to reset the password on this address.\n\n${link}\n\n`
          + `The link works once and expires in an hour. If it was not you, nothing has changed `
          + `and you can ignore this.\n`,
      }));
      audit(user.id, sent.ok ? 'password_reset_sent' : 'password_reset_send_failed', req,
        sent.ok ? `${sent.mode} ${sent.id || ''}` : sent.error);
    }
    res.json({ ok: true });
  });

app.post('/api/password-reset/confirm', mailLimiter,
  [body('token').isString().isLength({ min: 20 }), body('password').isLength({ min: 12 })], validate,
  (req, res) => {
    const row = consumeEmailToken(req.body.token, 'reset');
    if (!row) return res.status(400).json({ error: 'That reset link has expired or has already been used.' });
    // Reading mail at the address is the same proof confirmation asks for, so a
    // completed reset confirms the address too. Otherwise somebody who never got
    // the first message is stuck behind two locks with one key.
    db.prepare(`UPDATE users SET password=?, verified_at=COALESCE(verified_at, datetime('now')) WHERE id=?`)
      .run(bcrypt.hashSync(String(req.body.password), 12), row.user_id);
    // Whoever knew the old password is signed out. A reset is what somebody does
    // when they think the account is not only theirs any more.
    const ended = revokeAllSessions(row.user_id);
    audit(row.user_id, 'password_reset', req, `${ended} session(s) ended`);
    res.json({ ok: true });
  });

// Who this account sells to. One level down and no further, which is the same
// boundary every other commercial route draws: assigning a plan, reading
// entitlements and reconciling storage all stop at the direct customer. A
// reseller's customers are the reseller's business, so what a hosting company
// sees of them is that they exist and how many there are.
app.get('/api/accounts', auth, (req, res) => {
  const membership = sellerOrRefuse(req, res);
  if (!membership) return;
  const children = sellsToDirectly(membership.orgId);
  if (!children.length) return res.json([]);

  const holders = db.prepare(`SELECT m.identity_id, m.org_id, m.role,
      u.name, u.email, u.created_at, u.suspended_at, u.verified_at
    FROM memberships m JOIN users u ON u.id = m.identity_id
    WHERE m.org_id IN (${children.map(() => '?').join(',')})
    ORDER BY u.created_at`).all(...children);

  res.json(holders.map(row => {
    const assignment = db.prepare(`SELECT p.id, p.name FROM account_package_assignments a
      JOIN packages p ON p.id = a.package_id
      WHERE a.target_org_id=? AND a.status='active'`).get(row.org_id) || null;
    const below = db.prepare(`SELECT COUNT(*) AS n FROM organization_accounts
      WHERE parent_org_id=? AND status='active'`).get(row.org_id).n;
    return {
      id: row.identity_id,
      org_id: row.org_id,
      name: row.name,
      email: row.email,
      role: row.role,
      created_at: row.created_at,
      suspended: !!row.suspended_at,
      confirmed: !!row.verified_at,
      package: assignment,
      // What they are using against what they were sold. The same numbers the
      // customer sees on their own screen, so a support call about a full
      // account is two people reading one figure.
      usage: quota.report({ db, entitlements, ownership, userId: row.identity_id }),
      // The other half of what an account costs. Storage is what they bought;
      // transfer is what they spend, and a seller looking at one without the
      // other is looking at half a bill.
      transfer: hosting ? hosting.transferReport(row.identity_id) : null,
      customers: below,
      // Whether support may enter this particular account, resolved from its own
      // chain. Sent with the row so the console can grey the button and say who
      // decided, rather than offering an action the box is going to refuse — the
      // same rule the borrowed session's own interface follows.
      support: hosting ? hosting.supportFor(row.identity_id) : null,
    };
  }));
});

// What this box sells, taken from the engine's own registry rather than a list
// kept beside it. A console that hardcodes its own list is a console that offers
// something the box cannot enforce the day somebody adds a metric.
// What this box is. Behind auth and seller-only on purpose: /health stays a
// bare up-or-down for whatever load balancer is in front, because naming the
// exact build to an unauthenticated caller is a free gift to anyone scanning
// for a version with a known hole. The people who need it are the people who
// run the box and the people who sell from it, and both are signed in.
app.get('/api/box', auth, (req, res) => {
  const membership = sellerOrRefuse(req, res);
  if (!membership) return;
  const described = build.describe(migrations.state(db));
  // A reseller may name the build they sell from, but update notices belong to
  // the person who can replace the whole box. In Community the first account is
  // still the hosting_company role: it is the box administrator, not a reseller.
  if (membership.role === 'hosting_company') described.update = updates.current();
  res.json(described);
});

app.get('/api/metrics', auth, (req, res) => {
  if (!sellerOrRefuse(req, res)) return;
  res.json(entitlements.enabledMetrics().map(metric => ({
    metric: metric.metric_key,
    kind: metric.kind,
    unit: metric.unit,
    period: metric.period,
    default_value: metric.default_value,
    default_unlimited: !!metric.default_unlimited,
  })));
});

// Suspending somebody, and letting them back in. It was possible before this
// only by editing the database by hand, which means in practice it was not
// possible: nobody suspends a customer at 2am over SSH.
//
// Suspension takes nothing away. The files stay exactly where they are, and the
// account gets them back the moment it is lifted, because suspension is usually
// about an unpaid invoice and destroying somebody's data over an unpaid invoice
// is not a thing this product will do.
function suspension(on) {
  return (req, res) => {
    const membership = ownership.getMembership(req.user.id);
    if (!membership || membership.rank <= HIERARCHY.end_user) {
      return res.status(403).json({ error: 'Only a hosting company or a reseller can do that.' });
    }
    const target = db.prepare('SELECT id,email,suspended_at FROM users WHERE id=?').get(req.params.id);
    if (!target) return res.status(404).json({ error: 'Not found' });
    // Being a seller is not the same as being *this account's* seller. Without
    // this, any hosting company or reseller on the box could suspend any account
    // by id — another seller's customer, or the hosting company above them — and
    // suspension ends every session, so it was a way to lock somebody else's
    // customer out of their own files. Every other account route already asked
    // this question; this one did its own lookup and never did.
    //
    // 404 rather than 403, like the file and folder routes: an account you do
    // not sell to should not confirm that it exists.
    const targetMembership = ownership.getMembership(target.id);
    if (!targetMembership || !ownership.withinReach(membership, targetMembership.orgId)) {
      return res.status(404).json({ error: 'Not found' });
    }
    // Nobody suspends themselves, because the account that runs the box locking
    // itself out is a support call nobody can answer.
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot suspend your own account.' });

    // Suspension locks out the account it names and nobody else.
    //
    // Settled by Steve on 2026-09-08, the way his last hosting company did it. A
    // suspended reseller loses their console — no onboarding, no managing, no
    // selling — and their customers keep working, because those customers did
    // nothing wrong, are still paying somebody, and are the asset in this
    // situation rather than the leverage.
    //
    // The answer to a reseller who never pays is therefore not to stop fifty
    // accounts that did nothing: it is to take those customers over, which is
    // what the move route further down is for. B11.1 holds this, so the next
    // person to notice that a suspended reseller's customers still work finds
    // the decision rather than filing it as a bug.
    let ended = 0;
    if (on) {
      db.prepare('UPDATE users SET suspended_at=? WHERE id=?').run(new Date().toISOString(), target.id);
      ended = revokeAllSessions(target.id);
    } else {
      db.prepare('UPDATE users SET suspended_at=NULL WHERE id=?').run(target.id);
    }

    audit(req.user.id, on ? 'account_suspended' : 'account_restored', req,
      `${target.email} by ${req.user.email}${on ? `, ${ended} session(s) ended` : ''}`);
    announce(on ? 'account.suspended' : 'account.restored', target.id);
    res.json({ ok: true, suspended: on });
  };
}

app.post('/api/accounts/:id/suspend', auth, suspension(true));
app.post('/api/accounts/:id/restore', auth, suspension(false));

// ── The account record ──────────────────────────────────────────────────────
//
// The clerical half of a control panel: fix a typo, follow somebody who changed
// address, get a locked-out customer back in, send the confirmation again. None
// of it is interesting and all of it is missing from a panel that does not have
// it, which is why "a typo at creation is permanent" was true of this product
// until now.
//
// One helper rather than four copies of the same three questions. Being a seller
// is not the same as being *this account's* seller, and that distinction is the
// one this codebase learned the expensive way: suspension asked only the first
// half, so any reseller on the box could switch off any account by id. Reach
// rather than direct parentage, because the account record is the same family as
// suspension and the trail — a hosting company reaches the accounts beneath a
// reseller of theirs. 404 rather than 403, so an account somebody does not sell
// to never confirms that it exists.
function accountInReach(req, res) {
  const membership = sellerOrRefuse(req, res);
  if (!membership) return null;
  const target = db.prepare('SELECT id,name,email,verified_at,suspended_at FROM users WHERE id=?').get(req.params.id);
  if (!target) { res.status(404).json({ error: 'Not found' }); return null; }
  const targetMembership = ownership.getMembership(target.id);
  if (!targetMembership || !ownership.withinReach(membership, targetMembership.orgId)) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return { membership, target, targetMembership };
}

// Changing a name or an address.
//
// The name is clerical. The address is not: it is the account's one recovery
// route, so whoever can change it can point the reset at themselves and take the
// account, files and all. That is inherent to being the party who sold it —
// every panel in this category has the same property — and the honest answer is
// not to pretend otherwise but to make it impossible to do quietly:
//
//   - the new address is unconfirmed until somebody follows a link sent to it,
//     and `auth` refuses an unconfirmed account on every request, so the account
//     stops working the instant the address changes and does not start again
//     until the new address has been proved
//   - the address that is losing the account is told, at the address it is
//     losing it from, naming both. That message is the tripwire: a customer who
//     did not ask for this finds out while it is still their account
//   - both halves are written to the trail, against the customer, so it is in
//     the record their own history shows them and not only in the seller's
//
// Sessions are deliberately left alone. The confirmation gate already makes
// every one of them inert, so revoking them would add nothing except a customer
// who has to sign in again after correcting their own typo.
app.post('/api/accounts/:id/edit', auth,
  [body('name').optional().trim().isLength({ min: 1, max: 200 }),
    body('email').optional().isEmail().normalizeEmail()], validate,
  async (req, res) => {
    const found = accountInReach(req, res);
    if (!found) return;
    const { target } = found;
    const wantedName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const wantedEmail = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const renaming = !!wantedName && wantedName !== target.name;
    const readdressing = !!wantedEmail && wantedEmail !== target.email;
    if (!renaming && !readdressing) return res.status(400).json({ error: 'Nothing to change.' });

    if (readdressing) {
      // The same reason nobody suspends themselves. Changing an address makes it
      // unconfirmed, and an unconfirmed account is refused on every request, so
      // the account that runs this box could lock itself out of it with one
      // typo and there would be nobody left to fix it.
      if (target.id === req.user.id) {
        return res.status(400).json({ error: 'You cannot change the address on your own account here. It would lock you out until the new one was confirmed, and there is nobody above you to let you back in.' });
      }
      if (db.prepare('SELECT 1 FROM users WHERE email=? AND id<>?').get(wantedEmail, target.id)) {
        return res.status(400).json({ error: 'There is already an account with that address.' });
      }
    }

    const before = { name: target.name, email: target.email };
    db.transaction(() => {
      if (renaming) db.prepare('UPDATE users SET name=? WHERE id=?').run(wantedName, target.id);
      if (readdressing) db.prepare('UPDATE users SET email=?, verified_at=NULL WHERE id=?').run(wantedEmail, target.id);
    })();

    if (renaming) audit(target.id, 'account_renamed', req, `${before.name} is now ${wantedName}, by ${req.user.email}`);

    let confirmation = null;
    if (readdressing) {
      audit(target.id, 'account_email_changed', req, `${before.email} is now ${wantedEmail}, by ${req.user.email}`);
      // To the old address, first, and whatever happens next. A notice that is
      // only sent when the rest of the work succeeds is a notice that is missing
      // exactly when somebody wanted it missing.
      const told = await mailer.send(brandedMessage({
        to: before.email,
        subject: 'The address on your account was changed',
        text: `The address on your account was changed from ${before.email} to ${wantedEmail}.\n\n`
          + `The account cannot be used until the new address is confirmed.\n\n`
          + `If you did not ask for this, reply to this message or contact whoever sells you this `
          + `account, now: whoever holds the new address can reset the password on it.\n`,
      }));
      audit(target.id, told.ok ? 'account_email_change_notified' : 'account_email_change_notice_failed', req,
        told.ok ? `${before.email}, ${told.mode}` : told.error);
      const sent = await sendVerification({ id: target.id, email: wantedEmail }, req,
        `The address on an account was changed to this one, from ${before.email}.`);
      confirmation = sent.ok ? sent.mode : 'not sent';
    }

    res.json({ ok: true, name: renaming ? wantedName : before.name, email: readdressing ? wantedEmail : before.email,
      confirmed: readdressing ? false : !!target.verified_at, confirmation });
  });

// A hoster starting a password reset for somebody who cannot start their own.
//
// The link goes to the customer's address and nowhere else, and nothing about
// the token comes back in this response. That is the whole design: a seller can
// begin a reset and still cannot complete one, so an account's files stay behind
// a secret the seller does not hold. The alternative — a panel that sets a
// temporary password and shows it — hands every hosting company a key to every
// customer's storage, which would quietly undo the boundary the rest of this
// product is built around.
//
// It is not a way past a lost mailbox on its own. Somebody who has lost the
// address changes the address first, which is a separate act with its own notice
// to the old one, and that is the intended path rather than an oversight.
app.post('/api/accounts/:id/password-reset', auth, mailLimiter, async (req, res) => {
  const found = accountInReach(req, res);
  if (!found) return;
  const { target } = found;
  // The same rule the self-serve flow has: a suspended account is not a
  // locked-out customer, it is a customer somebody switched off, and a reset
  // that walked past that would make suspension advisory.
  if (target.suspended_at) return res.status(409).json({ error: 'That account is suspended. Let them back in first.' });
  const raw = issueEmailToken(target.id, 'reset');
  const sent = await mailer.send(brandedMessage({
    to: target.email,
    subject: 'Reset your password',
    text: `A password reset was started on your account by whoever provides it.\n\n`
      + `${APP_BASE_URL}/password-reset?token=${raw}\n\n`
      + `The link works once and expires in an hour. If you were not expecting this, `
      + `contact them before following it.\n`,
  }));
  audit(target.id, sent.ok ? 'password_reset_sent' : 'password_reset_send_failed', req,
    sent.ok ? `started by ${req.user.email}, ${sent.mode}` : sent.error);
  res.json({ ok: sent.ok, sent_to: target.email, delivery: sent.ok ? sent.mode : 'not sent',
    error: sent.ok ? undefined : sent.error });
});

// The confirmation again, from the console.
//
// The self-serve route beside this one answers the same way whatever address it
// is given, because an anonymous caller learning which addresses exist here is a
// customer list with a search box. This one is allowed to be honest: the caller
// is already looking at the account in their own list, so there is nothing left
// to disclose, and a button that cannot say whether it worked is a button that
// generates the support call it was meant to end.
app.post('/api/accounts/:id/verify-email/resend', auth, mailLimiter, async (req, res) => {
  const found = accountInReach(req, res);
  if (!found) return;
  const { target } = found;
  if (target.verified_at) return res.status(409).json({ error: 'That address is already confirmed.' });
  if (target.suspended_at) return res.status(409).json({ error: 'That account is suspended. Let them back in first.' });
  const sent = await sendVerification(target, req);
  res.json({ ok: sent.ok, sent_to: target.email, delivery: sent.ok ? sent.mode : 'not sent',
    error: sent.ok ? undefined : sent.error });
});

// ── One account's limits, without a package for it ──────────────────────────
//
// Every panel in this category can give one account a number of its own, and
// this one could not: limits came from packages, so "give her another twenty
// gigabytes until Friday" meant inventing a package with one customer on it.
//
// The engine already had all of this — `setOverride` bounds the number by what
// the seller themselves holds, refuses to be changed by anybody but the setter
// or an ancestor of theirs, and refuses a value that is neither a number nor
// unlimited. What was missing was a way in, so this is a way in and not a second
// copy of the rules.
//
// Direct parent rather than reach, matching plan assignment: an override edits
// an assignment, and the assignment is the direct seller's. A reseller's
// customer's numbers are the reseller's business, exactly as their plan is.
function assignmentSellerOrRefuse(req, res) {
  const membership = sellerOrRefuse(req, res);
  if (!membership) return null;
  const target = db.prepare('SELECT id,email FROM users WHERE id=?').get(req.params.id);
  if (!target) { res.status(404).json({ error: 'Not found' }); return null; }
  const targetMembership = ownership.getMembership(target.id);
  if (!targetMembership || entitlements.getDirectParent(targetMembership.orgId) !== membership.orgId) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return { membership, target, targetMembership };
}

// A metric this box does not enforce is not a limit, it is a row that looks like
// one. The engine keys overrides by string and would take `storage_byte`
// without complaint, answer 200, and change nothing — the same failure the
// registry rule exists to stop, arriving through a typo instead of through a
// sellable name. So the key is checked against the engine's own list.
function knownMetricOrRefuse(res, metricKey) {
  const known = entitlements.enabledMetrics().some(metric => metric.metric_key === metricKey);
  if (!known) {
    res.status(400).json({ error: `${metricKey} is not something this box meters.` });
    return false;
  }
  return true;
}

// A Community box has no plans, and the engine keeps an account's number of its
// own on a plan assignment, because an override is a change to what a plan gave.
// So the first time an admin there gives somebody a number, that person is put on
// the one plan the box keeps for everybody: unlimited storage and every capability
// on, which is exactly what they had with no plan at all. The engine then bounds
// and records the override as it does anywhere else; there is no second path.
const EVERYONE_PLAN = 'Everyone';
function onEveryonePlan({ membership, targetMembership, actorIdentityId }) {
  if (hosting) return;
  const active = db.prepare(`SELECT 1 FROM account_package_assignments WHERE target_org_id=? AND status='active'`)
    .get(targetMembership.orgId);
  if (active) return;
  let plan = db.prepare(`SELECT id FROM packages WHERE owner_org_id=? AND name=? AND status='active'`)
    .get(membership.orgId, EVERYONE_PLAN);
  if (!plan) {
    plan = entitlements.createPackage({
      ownerOrgId: membership.orgId,
      name: EVERYONE_PLAN,
      description: 'Everybody on this box, before anybody is given a number of their own.',
      limits: entitlements.enabledMetrics().filter(m => m.kind !== 'feature')
        .map(m => ({ metric: m.metric_key, unlimited: true, value: null })),
      actorIdentityId,
    });
  }
  entitlements.assignPackage({
    parentOrgId: membership.orgId, targetOrgId: targetMembership.orgId, packageId: plan.id, actorIdentityId,
  });
}

// The reason is required, because the table says it is: `reason TEXT NOT NULL`.
// That is the schema's opinion and it is the right one — an account carrying a
// number nobody can account for is the thing a hosting company finds a year
// later and cannot undo, because nobody remembers whether it was a favour, a
// mistake or part of a deal. Left optional, this route answered 400 with a
// SQLite constraint message, which is a leak and an unusable error at once.
app.put('/api/accounts/:id/limits/:metric', auth,
  [body('unlimited').optional().isBoolean(),
    body('reason').trim().isLength({ min: 1, max: 200 })
      .withMessage('Say why this account has a number of its own. It is on the record and somebody will ask.')], validate,
  (req, res) => {
    const found = assignmentSellerOrRefuse(req, res);
    if (!found) return;
    if (!knownMetricOrRefuse(res, req.params.metric)) return;
    const unlimited = req.body.unlimited === true;
    try {
      onEveryonePlan({ membership: found.membership, targetMembership: found.targetMembership, actorIdentityId: req.user.id });
      const effective = entitlements.setOverride({
        targetOrgId: found.targetMembership.orgId,
        metricKey: req.params.metric,
        fields: { maximum: unlimited ? { unlimited: true } : { value: Math.max(0, Math.floor(Number(req.body.value))) } },
        reason: String(req.body.reason).trim().slice(0, 200),
        actorOrgId: found.membership.orgId,
        actorIdentityId: req.user.id,
      });
      audit(found.target.id, 'limit_overridden', req,
        `${req.params.metric} set to ${unlimited ? 'unlimited' : effective.maxValue} for ${found.target.email} by ${req.user.email}`);
      announce('account.limits_changed', found.target.id);
      res.json({ ok: true, metric: req.params.metric, effective });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

app.delete('/api/accounts/:id/limits/:metric', auth, (req, res) => {
  const found = assignmentSellerOrRefuse(req, res);
  if (!found) return;
  if (!knownMetricOrRefuse(res, req.params.metric)) return;
  try {
    const effective = entitlements.clearOverride({
      targetOrgId: found.targetMembership.orgId,
      metricKey: req.params.metric,
      actorOrgId: found.membership.orgId,
    });
    audit(found.target.id, 'limit_override_cleared', req,
      `${req.params.metric} back to the plan for ${found.target.email}, by ${req.user.email}`);
    announce('account.limits_changed', found.target.id);
    res.json({ ok: true, metric: req.params.metric, effective: effective || null });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


// ── Terminating an account ──────────────────────────────────────────────────
//
// Suspend and restore existed; nothing ended an account, so a billing lifecycle
// had no cancel. Settled by Steve on 2026-09-07, and it is a product rather than
// a disposal rule: terminating archives the customer's files rather than
// deleting them, "because people come back and ask, and it's a separate service
// charge to unarchive and send it."
//
// So the order here is the whole safety property. The archive is written, then
// proved hash for hash, and only then is anything removed. An archive that does
// not verify is thrown away and the account is left exactly as it was — because
// the failure mode worth designing against is not "the archive was bad", it is
// "the archive was bad and the account is gone anyway".
//
// `control/accountArchive.js` holds the format and the reasoning. See
// `docs/NEXT.md` item 0d #3.
// How much of the hoster's disk the archives are using, which is at once their
// cost and the thing they are selling back. Asked of the manifests rather than
// of a counter, because a counter is a number that can be wrong.
function archiveTotals() {
  const all = accountArchive.list({ from: ARCHIVES_DIR });
  // Counted separately rather than folded in. An unreadable archive contributes
  // nothing to the size — its bytes cannot be known — so a total that did not
  // say how many of those there are would quietly understate the disk, and a
  // number that silently disagrees with the disk is one nobody bills from.
  const unreadable = all.filter(one => one.status === 'unreadable').length;
  return {
    count: all.length,
    bytes: all.reduce((sum, one) => sum + (Number(one.bytes) || 0), 0),
    unreadable,
  };
}

// Removing an account's rows and its bytes, once and only once the archive of
// them has been read back and proved.
//
// Everything keyed by the user goes. The organization rows stay, because they
// carry the commercial history — who sold to whom, on which plan, with which
// override — and that is the hoster's record rather than the customer's data.
//
// But the *link* is ended, and that is not bookkeeping. Capacity is allocated
// down the tree by the live children of an organization, so an account left
// linked after it is gone goes on consuming its seller's allowance for ever: the
// reseller who terminates a customer to free up space would find they had freed
// nothing, and the arithmetic that refuses an over-allocation would keep
// counting a customer nobody can sign in as. Ending the link is what makes
// termination mean something commercially as well as on the disk.
function eraseAccount(userId, orgId, actorIdentityId) {
  if (orgId) {
    try { entitlements.endOrganizationLink(orgId, actorIdentityId); }
    catch (error) { audit(actorIdentityId, 'account_link_not_ended', null, `${orgId}: ${error.message}`); }
    // The package assignment is deliberately not touched. Allocation is counted
    // from the live children in `organization_accounts`, so ending the link is
    // what frees the capacity; writing a status onto the assignment as well
    // would be a second place to keep correct, in a vocabulary the engine does
    // not use ('ended' where it says 'superseded'), for no effect.
  }
  // What the account spent on transfer becomes the box's own, rather than
  // disappearing from a report the hoster holds against their bandwidth bill.
  // The meter's daily rows are not keyed by `user_id` and so are not in the erase
  // list below; they are a scope, and the answer for them is to reattribute rather
  // than to delete. A Community box meters no transfer, so has nothing to move.
  let transferRetired = { bytes: 0, days: 0 };
  try { if (hosting) transferRetired = hosting.retireTransfer(userId); }
  catch (error) { audit(actorIdentityId, 'account_transfer_not_retired', null, `${userId}: ${error.message}`); }

  const removed = {};
  const erase = db.transaction(() => {
    // The Hosting edition names its own tables keyed by an account, before `users`
    // because they point at it.
    for (const table of ['audit_log', 'shares', 'thumbnails', 'file_tags', 'tags',
      'file_metadata', 'file_versions', 'files', 'folders', 'email_tokens', 'sessions',
      ...(hosting ? hosting.accountTables : []), 'users']) {
      const column = table === 'users' ? 'id' : 'user_id';
      try { removed[table] = db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(userId).changes; }
      catch { removed[table] = 0; }
    }
  });
  erase();
  let bytes = 0;
  let files = 0;
  for (const [, root] of storageRoots.allRoots(UPLOADS_DIR, userId)) {
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of names) {
      if (!entry.isFile()) continue;
      try { bytes += fs.statSync(path.join(root, entry.name)).size; files += 1; } catch { /* counted best effort */ }
    }
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* reported by the reconcile, not fatal here */ }
  }
  return { rows: removed, files, bytes, transfer: transferRetired };
}

app.post('/api/accounts/:id/terminate', auth,
  [body('keepDays').optional().isInt({ min: 1, max: 3650 }),
    body('confirm').equals('terminate').withMessage('Terminating needs to be meant, so it is confirmed in the body.')], validate,
  (req, res) => {
    const found = accountInReach(req, res);
    if (!found) return;
    const { target, targetMembership } = found;
    // Nobody terminates themselves, for the same reason nobody suspends
    // themselves, only permanently.
    if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot terminate your own account.' });
    // An account that sells to other accounts is not this route's to end.
    // Terminating a reseller would either orphan their customers or quietly end
    // them, and both are decisions this route is not entitled to make on its
    // own — fifty paying accounts thrown away to collect one debt. So it says so
    // and stops, and the way past it is to move those customers: the console
    // lists them on the reseller's own screen, and the move route re-parents
    // them one at a time.
    const below = db.prepare(`SELECT COUNT(*) AS n FROM organization_accounts
      WHERE parent_org_id=? AND status='active'`).get(targetMembership.orgId).n;
    if (below > 0) {
      return res.status(409).json({
        error: `That account sells to ${below} other${below === 1 ? '' : 's'}. Move or terminate them first — this box will not decide what happens to somebody else's customers.`,
      });
    }

    let sealed = null;
    try {
      sealed = accountArchive.take({
        db, uploadsDir: UPLOADS_DIR, into: ARCHIVES_DIR, userId: target.id,
        keepDays: req.body.keepDays ? Number(req.body.keepDays) : null,
        label: `${target.email}, terminated by ${req.user.email}`,
      });
    } catch (error) {
      audit(req.user.id, 'account_terminate_failed', req, `${target.email}: ${error.message}`);
      return res.status(500).json({ error: `Nothing was removed. The archive could not be written: ${error.message}` });
    }

    // Proved before anything is lost. This is the line the whole feature turns
    // on: an archive nobody has read back is a hope with a filename, and this
    // one is about to be the only copy.
    const proved = accountArchive.inspect({ from: sealed.dir });
    if (!proved.ok || sealed.status !== 'ok') {
      try { accountArchive.destroy({ from: sealed.dir }); } catch { /* nothing was removed either way */ }
      audit(req.user.id, 'account_terminate_failed', req,
        `${target.email}: ${(proved.problems || []).join('; ') || 'the archive was incomplete'}`);
      return res.status(500).json({
        error: 'Nothing was removed. The archive did not verify, so the account is exactly as it was.',
        problems: [...(proved.problems || []), ...(sealed.manifest.problems || []).map(p => `${p.name}: ${p.why}`)],
      });
    }

    // Announced before the erase, because afterwards there is no account left to
    // describe or seller to find. The archive has already been proved, which is
    // the point past which this termination happens.
    announce('account.terminated', target.id, {
      data: { archive: { id: sealed.id, keep_until: sealed.manifest.keep_until || null } } });
    const gone = eraseAccount(target.id, targetMembership.orgId, req.user.id);
    // Written against the actor and not the account, because the account's own
    // trail has just been archived and deleted with it. The record of a
    // termination has to outlive the thing terminated or there is no record.
    audit(req.user.id, 'account_terminated', req,
      `${target.email} archived as ${sealed.id}: ${proved.checked} file(s), ${sealed.manifest.counts.bytes} bytes, `
      + `${gone.transfer.bytes} byte(s) of transfer moved to the box's own line, `
      + `keep until ${sealed.manifest.keep_until || 'nobody has said'}`);
    res.json({
      ok: true,
      archive: { id: sealed.id, files: proved.checked, bytes: sealed.manifest.counts.bytes, keep_until: sealed.manifest.keep_until },
      removed: { files: gone.files, bytes: gone.bytes },
      transfer_retired: gone.transfer,
      archives: archiveTotals(),
    });
  });

// ── The archives ────────────────────────────────────────────────────────────
//
// The operator's, because they sit on the operator's disk and hold former
// customers' files. A reseller who terminates their own customer creates one and
// does not hold it: whose disk it occupies is whose it is to see, keep and
// destroy. That is the same rule the whole-box backup already follows.
//
// Sealed rather than browsable. Nothing here returns a file list, so a hoster
// restores an archive or sends it and does not read it, which is the boundary
// the audit trail already draws between the account record and the customer's
// own business.
app.get('/api/archives', auth, (req, res) => {
  if (!operatorOrRefuse(req, res)) return;
  const all = accountArchive.list({ from: ARCHIVES_DIR });
  res.json({
    ...archiveTotals(),
    // A keep-until that has passed is the whole point of having one, so it is
    // said here rather than left for somebody to work out from two dates.
    archives: all.map(one => ({ ...one, keep_expired: !!one.keep_until && one.keep_until < new Date().toISOString() })),
  });
});

app.post('/api/archives/:id/verify', auth, (req, res) => {
  if (!operatorOrRefuse(req, res)) return;
  // Looked up rather than joined onto a path, like the backup route: an
  // identifier from a URL that becomes a directory name is the oldest traversal
  // there is.
  const known = accountArchive.list({ from: ARCHIVES_DIR }).find(one => one.id === req.params.id);
  if (!known) return res.status(404).json({ error: 'Not found' });
  const found = accountArchive.inspect({ from: path.join(ARCHIVES_DIR, known.directory) });
  audit(req.user.id, 'archive_verified', req, `${known.id}: ${found.ok ? 'intact' : found.problems.join('; ')}`);
  res.json({ id: known.id, ok: found.ok, files_checked: found.checked, problems: found.problems });
});

// Handing it back, which is the half a hosting company charges for. This box
// performs it and does not price it.
//
// The account comes back under whoever restores it, exactly as a newly created
// one hangs under its creator — so an archive can also be handed to a different
// seller, and the account's own id and files are untouched by that.
app.post('/api/archives/:id/restore', auth, (req, res) => {
  const membership = operatorOrRefuse(req, res);
  if (!membership) return;
  const known = accountArchive.list({ from: ARCHIVES_DIR }).find(one => one.id === req.params.id);
  if (!known) return res.status(404).json({ error: 'Not found' });
  try {
    const back = accountArchive.restore({ db, uploadsDir: UPLOADS_DIR, from: path.join(ARCHIVES_DIR, known.directory) });
    // An account with no organization can do nothing and nobody can sell to it,
    // which is the bug `createAccount` documents at length. A restore has to
    // close it the same way.
    try {
      ownership.ensureMembership(back.account.id);
      const child = ownership.getMembership(back.account.id);
      if (child) entitlements.linkOrganizations(membership.orgId, child.orgId, req.user.id);
    } catch (error) {
      audit(back.account.id, 'account_not_linked_to_creator', req, error.message);
    }
    audit(req.user.id, 'archive_restored', req,
      `${known.id} back as ${back.account.email}: ${back.files} file(s), ${back.bytes} bytes, under ${req.user.email}`);
    res.json({ ok: true, account: back.account, files: back.files, bytes: back.bytes });
  } catch (error) {
    audit(req.user.id, 'archive_restore_failed', req, `${known.id}: ${error.message}`);
    res.status(409).json({ error: error.message });
  }
});

// The deliberate permanent deletion, which is the other half of having a
// keep-until at all. Holding a terminated customer's data with no end is a legal
// position rather than a technical one, and so is deleting it early, so this
// asks to be meant and writes down who meant it.
app.delete('/api/archives/:id', auth,
  [body('confirm').equals('delete for ever').withMessage('A permanent deletion is confirmed in the body, in words.')], validate,
  (req, res) => {
    if (!operatorOrRefuse(req, res)) return;
    const known = accountArchive.list({ from: ARCHIVES_DIR }).find(one => one.id === req.params.id);
    if (!known) return res.status(404).json({ error: 'Not found' });
    const dead = accountArchive.destroy({ from: path.join(ARCHIVES_DIR, known.directory) });
    audit(req.user.id, 'archive_destroyed', req,
      `${dead.id} (${(dead.account || {}).email || 'unknown account'}), ${known.bytes} bytes, by ${req.user.email}`);
    res.json({ ok: true, id: dead.id, archives: archiveTotals() });
  });


// The gate the forbidden routes carry. A middleware rather than a line repeated
// in six handlers, because the lesson this codebase keeps relearning is that a
// rule written out once per route is a rule missing from the seventh.
function notWhileImpersonating(what) {
  return (req, res, next) => {
    if (!req.impersonator) return next();
    audit(req.user.id, 'impersonation_refused', req, `${req.impersonator.email || req.impersonator.id} tried to ${what}`);
    return res.status(403).json({
      error: `You are signed in as ${req.user.email}. Their files are still theirs, so you cannot ${what}.`,
    });
  };
}


// ── Resellers ───────────────────────────────────────────────────────────────
//
// Who a reseller sells to, and moving a customer between sellers, are the Hosting
// edition's. A Community box has one level, the people
// its admin adds.

// ── Reading the trail ───────────────────────────────────────────────────────
//
// The box has written to `audit_log` in fifty-nine places since the beginning
// and nothing has ever read it back, so the expensive half of an audit trail was
// built and the useful half was not. A hosting company answering "who deleted
// this, and when" had a complete record and no way to open it.
//
// Two readings, because there are two different questions. Your own trail is
// yours in full. A customer's trail, read by whoever sells to them, is the
// account-level part only — `auditTrail` owns that split and defaults to
// private, so nothing here has to remember which actions name a file.
const PAGE = { fallback: 50, cap: 200 };

function trailPage(req, userId, actions) {
  const limit = Math.min(PAGE.cap, Math.max(1, Number(req.query.limit) || PAGE.fallback));
  const before = Number(req.query.before);
  const where = ['user_id = ?'];
  const args = [userId];
  if (actions) {
    where.push(`action IN (${actions.map(() => '?').join(',')})`);
    args.push(...actions);
  }
  if (Number.isFinite(before) && before > 0) { where.push('id < ?'); args.push(before); }
  const rows = db.prepare(`SELECT id, action, ip, details, at FROM audit_log
    WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...args, limit + 1);
  const page = rows.slice(0, limit);
  return { entries: page, more: rows.length > limit ? page[page.length - 1].id : null };
}

app.get('/api/audit', auth, (req, res) => {
  res.json(trailPage(req, req.user.id, null));
});

app.get('/api/accounts/:id/audit', auth, (req, res) => {
  const membership = sellerOrRefuse(req, res);
  if (!membership) return;
  const target = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const targetMembership = ownership.getMembership(target.id);
  if (!targetMembership || !ownership.withinReach(membership, targetMembership.orgId)) {
    return res.status(404).json({ error: 'Not found' });
  }
  // The list is passed in rather than filtered afterwards, so a row a hosting
  // company may not read is never selected in the first place.
  res.json(trailPage(req, target.id, [...auditTrail.ACCOUNT_LEVEL]));
});

// ── Who may sell ────────────────────────────────────────────────────────────
//
// An account that outranks an end user. Plans themselves are the Hosting
// edition's.

function sellerOrRefuse(req, res) {
  const membership = ownership.getMembership(req.user.id);
  if (!membership || membership.rank <= HIERARCHY.end_user) {
    res.status(403).json({ error: 'Only a hosting company or a reseller can do that.' });
    return null;
  }
  return membership;
}

// What an account is entitled to, and what it is using. A seller may ask about a
// customer of theirs; anybody may ask about themselves.
app.get('/api/accounts/:id/entitlements', auth, async (req, res) => {
  const membership = ownership.getMembership(req.user.id);
  const target = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const targetMembership = ownership.getMembership(target.id);
  if (!targetMembership) return res.status(400).json({ error: 'That account has no organization yet.' });
  const isSelf = target.id === req.user.id;
  const isTheirSeller = membership && entitlements.getDirectParent(targetMembership.orgId) === membership.orgId;
  if (!isSelf && !isTheirSeller) return res.status(403).json({ error: 'That is not your account to look at.' });
  res.json({ org_id: targetMembership.orgId, metrics: await entitlements.usageReport(targetMembership.orgId) });
});

// ── Files ───────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  // Everything lands private. There is no way to upload straight into Public,
  // deliberately: making something public is a separate act with its own audit
  // row, and an upload that could skip it is a way to make that act optional.
  destination: (req, file, cb) => {
    try { cb(null, storageRoots.ensureRoot(UPLOADS_DIR, req.user.id, storageRoots.PRIVATE)); }
    catch (error) { cb(error); }
  },
  filename: (req, file, cb) => cb(null, `${uid()}${path.extname(file.originalname).slice(0, 20)}`),
});
// UTF-8 filenames. Browsers send the name in the multipart header as raw UTF-8,
// and the parser underneath multer reads header parameters as latin1 unless told
// otherwise, so "Résumé.pdf" was stored as "RÃ©sumÃ©.pdf" and a Japanese filename
// as noise — on every box, since the first upload, and invisible to a suite that
// only ever uploaded ASCII names. multer 1.x had no way to say this; 2.x does.
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD }, defParamCharset: 'utf8' });

function publicBase(req) {
  return (PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}

const FILE_COLUMNS = 'id,name,size,mime,folder,added_at,disk_path,deleted_at';

// One indexed lookup per file, asked here rather than passed in, because a place
// that depends on what a caller remembered to count is a place that will be
// wrong in whichever route somebody adds next.
function liveShareCount(fileId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM shares
    WHERE file_id=? AND revoked_at IS NULL AND expires_at > datetime('now')`).get(fileId).n;
}

const hasThumbnail = fileId => !!db.prepare('SELECT 1 AS n FROM thumbnails WHERE file_id=?').get(fileId);

// How many earlier versions this file has, and when it last changed. A file that
// has never been replaced says zero and nothing else, so the interface has no
// history to show and does not pretend to.
function historyOn(fileId, userId) {
  const row = db.prepare(`SELECT COUNT(*) AS n, MAX(made_at) AS latest
    FROM file_versions WHERE file_id=? AND user_id=?`).get(fileId, userId);
  return { versions: Number(row.n) || 0, changed_at: row.latest || null };
}

// The words the owner put on this file. One indexed lookup per row, asked here
// for the same reason the share count is: a listing that depends on what a
// caller remembered to join is a listing that will be wrong somewhere else.
const tagsOn = (fileId, userId) => db.prepare(`SELECT t.id, t.name FROM file_tags ft
  JOIN tags t ON t.id = ft.tag_id
  WHERE ft.file_id=? AND ft.user_id=? ORDER BY t.name`).all(fileId, userId);

function fileRow(req, row) {
  const activeShares = liveShareCount(row.id);
  const place = workspaceFiles.placeFor(UPLOADS_DIR, { ...row, user_id: req.user.id }, { activeShares });
  return {
    id: row.id, name: row.name, size: row.size, mime: row.mime,
    folder: row.folder, added_at: row.added_at,
    place,
    shares: activeShares,
    thumbnail: hasThumbnail(row.id),
    tags: tagsOn(row.id, req.user.id),
    ...historyOn(row.id, req.user.id),
    reach: workspaceFiles.reachability(place),
    public_url: place === workspaceFiles.PUBLIC
      ? workspaceFiles.publicUrlFor(publicBase(req), req.user.id, row) : null,
    deleted_at: row.deleted_at || null,
  };
}

function ownedFile(req) {
  const row = db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE id=? AND user_id=?`)
    .get(req.params.id, req.user.id);
  return row ? { ...row, user_id: req.user.id } : null;
}

app.get('/api/files', auth, (req, res) => {
  const rows = db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE user_id=?`).all(req.user.id);
  const shown = rows.map(row => fileRow(req, row));
  // A place in the query is a filter and never an instruction. Each row still
  // reports where it actually is, so a screen asking for Public and being handed
  // something else shows the truth rather than what it asked for.
  const wanted = String(req.query.place || '').trim();
  const byPlace = wanted ? shown.filter(f => f.place === wanted) : shown;
  // And a tag is a filter over the account's own tags. An id belonging to
  // somebody else matches nothing rather than erroring, because the answer to
  // "show me another customer's tag" is an empty page, not a hint that it
  // exists.
  const tag = String(req.query.tag || '').trim();
  res.json(tag ? byPlace.filter(f => f.tags.some(t => t.id === tag)) : byPlace);
});

// How much space this account is using, and what it is allowed. Always
// answerable: a usage figure that fails to load reads as a broken product.
app.get('/api/usage', auth, (req, res) => {
  res.json({
    ...quota.report({ db, entitlements, ownership, userId: req.user.id }),
    transfer: hosting ? hosting.transferReport(req.user.id) : null,
  });
});

// The quota gate. It runs before multer writes anything, using the size the
// browser declares, and then again after the write against what actually landed,
// because a declared size is a client-declared value and a gate built on one is a
// gate the client can switch off.
function quotaGate(req, res, next) {
  const declared = Number(req.headers['content-length']) || 0;
  const verdict = quota.mayAccept({ db, entitlements, ownership, userId: req.user.id, incomingBytes: declared });
  if (!verdict.allowed) {
    audit(req.user.id, 'upload_refused_quota', req, `${verdict.used} of ${verdict.limit} bytes used`);
    announce('account.storage_full', req.user.id);
    return res.status(413).json({ error: verdict.reason, used: verdict.used, limit: verdict.limit });
  }
  next();
}

app.post('/api/files', auth, uploadLimiter, gate('new_upload'), quotaGate, upload.array('files'), (req, res) => {
  // A folder arriving in a request is a claim, not a fact. One that is not this
  // account's own reads as the top rather than as an error: the upload has
  // already landed on the disk by now, and refusing it here would mean deleting
  // somebody's file over a mistyped field.
  const folder = ownFolder(req.user.id, req.body.folder);
  // What actually landed, which is the number that counts. A browser that
  // understated its Content-Length got past the gate above; this catches it and
  // removes the files rather than keeping bytes nobody is entitled to.
  const landed = (req.files || []).reduce((sum, f) => sum + (f.size || 0), 0);
  const after = quota.mayAccept({ db, entitlements, ownership, userId: req.user.id, incomingBytes: landed });
  if (!after.allowed) {
    for (const f of req.files || []) { try { fs.unlinkSync(f.path); } catch {} }
    audit(req.user.id, 'upload_refused_quota_after_write', req, `${landed} bytes arrived past a declared size`);
    return res.status(413).json({ error: after.reason, used: after.used, limit: after.limit });
  }
  const inserted = [];
  for (const f of req.files || []) {
    const id = uid();
    db.prepare('INSERT INTO files (id,user_id,name,size,mime,folder,disk_path) VALUES (?,?,?,?,?,?,?)')
      .run(id, req.user.id, f.originalname, f.size, f.mimetype, folder, f.path);
    const landedRow = {
      id, name: f.originalname, size: f.size, mime: f.mimetype,
      folder, added_at: new Date().toISOString(), disk_path: f.path, deleted_at: null,
    };
    // Read here, while the file is warm and the customer is already waiting for
    // an answer, rather than the first time somebody opens the details panel.
    rememberMetadata(landedRow, req.user.id);
    inserted.push(fileRow(req, landedRow));
  }
  audit(req.user.id, 'upload', req, `${inserted.length} file(s)`);
  res.json(inserted);
});

app.get('/api/files/:id/download', auth, notWhileImpersonating('open or download their files'), (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  // The row says where the file is; this asks whether that path is inside this
  // account's own tree before sending it. Two answers to one question, because
  // the row is data and an edited row must not become an arbitrary file read.
  const roots = storageRoots.rootsFor(UPLOADS_DIR, req.user.id);
  const resolved = path.resolve(row.disk_path || '');
  if (!storageRoots.isInside(roots.private, resolved) && !storageRoots.isInside(roots.published, resolved)) {
    audit(req.user.id, 'download_refused', req, `${row.name}: location outside this account`);
    return res.status(404).json({ error: 'Not found' });
  }
  // Their own bytes, leaving the box. Counted like any other exit: the host
  // pays for this transfer exactly as they pay for a public fetch.
  res.locals.egress = { userId: req.user.id, exit: 'owner' };
  res.download(resolved, row.name);
});

// ── Making something public, and taking it back ─────────────────────────────

// Whether this plan may put files on the open internet. The public-files flag is a
// feature metric, so it is on unless a hoster has decided to charge for it, and a
// hoster who has configured nothing ships the whole product.
function mayMakePublic(userId) {
  let entitlement = null;
  let registered = false;
  try {
    registered = workspaceFiles.entitlementInForce(entitlements.enabledMetrics(), workspaceFiles.ENTITLEMENTS.makePublic);
    const membership = ownership.getMembership(userId);
    if (registered && membership) {
      entitlement = entitlements.effectiveEntitlement(membership.orgId, workspaceFiles.ENTITLEMENTS.makePublic);
    }
  } catch { entitlement = null; }
  return workspaceFiles.mayMakePublic(entitlement, { registered });
}

function moveFile(req, res, to) {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'Not found' });

  if (to === workspaceFiles.PUBLIC) {
    const verdict = mayMakePublic(req.user.id);
    if (!verdict.allowed) {
      audit(req.user.id, 'make_public_refused', req, `${row.name}: ${verdict.reason}`);
      return res.status(403).json({ error: verdict.reason });
    }
  }

  let plan;
  try { plan = workspaceFiles.planMove({ uploadsDir: UPLOADS_DIR, userId: req.user.id, row, to }); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (!plan.ok) {
    audit(req.user.id, 'move_refused', req, `${row.name}: ${plan.reason}`);
    return res.status(plan.status).json({ error: plan.reason });
  }
  const removing = { exif: req.body.stripExif === true, xmp: req.body.stripXmp === true };
  if (to === workspaceFiles.PUBLIC && (removing.exif || removing.xmp)) {
    try { stripForPublishing(row, req, removing); }
    catch (error) { return res.status(error.status || 500).json({ error: error.message }); }
  }
  if (plan.noop) return res.json({ ok: true, file: fileRow(req, row) });

  // The bytes move first and the row follows. The other order means a move that
  // fails leaves a row saying private while the file sits in the served
  // directory, and that is a private file on the open internet.
  try {
    storageRoots.ensureRoot(UPLOADS_DIR, req.user.id,
      to === workspaceFiles.PUBLIC ? storageRoots.PUBLISHED : storageRoots.PRIVATE);
    fs.renameSync(plan.move.from, plan.move.to);
  } catch {
    // Across filesystems a rename fails, so copy, check the size, then unlink.
    try {
      fs.copyFileSync(plan.move.from, plan.move.to);
      if (fs.statSync(plan.move.to).size !== fs.statSync(plan.move.from).size) {
        throw new Error('the copy did not read back at the size it was written');
      }
      fs.unlinkSync(plan.move.from);
    } catch (fallback) {
      try { if (fs.existsSync(plan.move.to)) fs.unlinkSync(plan.move.to); } catch {}
      audit(req.user.id, 'move_failed', req, `${row.name}: ${fallback.message}`);
      return res.status(500).json({ error: 'That file could not be moved. Nothing has changed.' });
    }
  }
  db.prepare('UPDATE files SET disk_path=? WHERE id=? AND user_id=?').run(plan.move.to, row.id, req.user.id);
  audit(req.user.id, plan.audit.action, req, plan.audit.details);
  res.json({ ok: true, file: fileRow(req, { ...row, disk_path: plan.move.to }) });
}

// ── What the file says about itself ─────────────────────────────────────────
//
// EXIF, read from the file's own bytes. This is core and it is not AI: no model
// is involved, nothing is inferred, and every value here was written into the
// file by the camera that took the picture. It works with the AI entitlement off
// because it has nothing to do with it.
//
// The reading is bounded and it never decodes an image — see control/exif.js for
// why that distinction is the whole point.

const EXIF_FIELDS = ['camera_make', 'camera_model', 'lens', 'software', 'taken_at', 'orientation',
  'width', 'height', 'iso', 'f_number', 'exposure_seconds', 'focal_length_mm',
  'gps_lat', 'gps_lon', 'gps_altitude_m'];
const XMP_FIELDS = ['xmp_read', 'xmp', 'xmp_readable', 'xmp_location', 'xmp_credit'];

// Read once and remember, including remembering that there was nothing to find.
// Without that second half, a picture with no EXIF is opened and parsed again on
// every request for as long as it exists.
function rememberMetadata(row, userId) {
  const blank = { found: 0 };
  let values = null;
  let packet = null;
  try {
    const at = storageRoots.sharedPathFor(UPLOADS_DIR, userId, row.disk_path);
    if (!at) return blank;
    const handle = fs.openSync(at, 'r');
    try {
      // Twelve bytes decide whether the rest is worth reading. Asking the row's
      // mime instead would be asking the client that uploaded the file whether
      // its own photograph counts as one, and an API upload that declares
      // nothing would keep its GPS all the way onto the open internet.
      const head = Buffer.alloc(12);
      if (!exif.containerOf(head.subarray(0, fs.readSync(handle, head, 0, 12, 0)))) return blank;
      const buffer = Buffer.alloc(exif.READ_BYTES);
      const read = fs.readSync(handle, buffer, 0, exif.READ_BYTES, 0);
      const window = buffer.slice(0, read);
      values = exif.readExif(window);
      // Bounded the same way, and honest about the same limit: an XMP packet a
      // very large PNG writes past this window is not found here. Removal still
      // takes it, because that reads the whole file — but the offer to remove
      // it is only made about a packet somebody has actually seen.
      packet = exif.readXmp(window);
    } finally { fs.closeSync(handle); }
  } catch {
    // A file that cannot be read right now is not a reason to fail whatever the
    // customer was actually doing.
    return blank;
  }
  const record = { found: values ? 1 : 0 };
  for (const field of EXIF_FIELDS) record[field] = values ? (values[field] ?? null) : null;
  record.xmp_read = 1;
  record.xmp = packet ? 1 : 0;
  record.xmp_readable = packet && packet.readable ? 1 : 0;
  record.xmp_location = packet && packet.location ? 1 : 0;
  record.xmp_credit = packet && packet.credit ? 1 : 0;
  try {
    const columns = [...EXIF_FIELDS, ...XMP_FIELDS];
    db.prepare(`INSERT INTO file_metadata (file_id,user_id,found,${columns.join(',')})
      VALUES (@file_id,@user_id,@found,${columns.map(f => `@${f}`).join(',')})
      ON CONFLICT(file_id) DO UPDATE SET found=excluded.found, read_at=datetime('now'),
        ${columns.map(f => `${f}=excluded.${f}`).join(', ')}`)
      .run({ file_id: row.id, user_id: userId, ...record });
  } catch { /* the metadata is a nicety; losing it must not lose the upload */ }
  return record;
}

// Only the fields that actually said something. A panel of fifteen dashes is
// worse than a short list.
function exifShape(record) {
  if (!record || !record.found) return null;
  const out = {};
  for (const field of EXIF_FIELDS) if (record[field] !== null && record[field] !== undefined) out[field] = record[field];
  return Object.keys(out).length ? out : null;
}

// Present, and what is in it — never the packet itself. The two answers pull in
// opposite directions: a location is a reason to remove it, a credit line is a
// reason to keep it, and which of those matters more is the customer's to say.
function xmpShape(record) {
  if (!record || !record.xmp) return null;
  return {
    readable: !!record.xmp_readable,
    location: !!record.xmp_location,
    credit: !!record.xmp_credit,
  };
}

app.get('/api/files/:id/metadata', auth, notWhileImpersonating('read what a camera recorded about their photographs'), (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'No such file.' });
  let record = db.prepare('SELECT * FROM file_metadata WHERE file_id=? AND user_id=?').get(row.id, req.user.id);
  // Nobody has looked at this one yet — an upload from before any of this
  // existed, or one that arrived through a route that did not read it. A row
  // whose xmp_read is NULL was read before the packet was a question, and is
  // read again rather than answered from a column nobody ever filled in.
  // Looking costs one bounded read.
  if (!record || record.xmp_read === null) record = rememberMetadata(row, req.user.id);
  res.json({ file: fileRow(req, row), exif: exifShape(record), xmp: xmpShape(record) });
});

// ── Tags ────────────────────────────────────────────────────────────────────
//
// The customer's own words. Manual, typed by them, and nothing else writes here:
// auto-tagging is an AI capability that does not exist yet and will be gated by
// the AI entitlement when it does.

// A tag belongs to an account. Ten tags on one file is organisation; a thousand
// is a script, and the count is here so it is a refusal rather than a table
// nobody can draw.
const MAX_TAGS_PER_FILE = 24;
const MAX_TAGS_PER_ACCOUNT = 500;

app.get('/api/tags', auth, (req, res) => {
  res.json(db.prepare(`SELECT t.id, t.name, t.created_at,
      COUNT(f.id) AS files
    FROM tags t
    LEFT JOIN file_tags ft ON ft.tag_id = t.id AND ft.user_id = t.user_id
    LEFT JOIN files f ON f.id = ft.file_id AND f.deleted_at IS NULL
    WHERE t.user_id=?
    GROUP BY t.id ORDER BY t.name`).all(req.user.id));
});

app.post('/api/files/:id/tags', auth, [body('name').isString()], validate, (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'No such file.' });
  const clean = tagRules.cleanTagName(req.body.name);
  if (!clean.ok) return res.status(400).json({ error: clean.reason });

  const already = db.prepare('SELECT COUNT(*) AS n FROM file_tags WHERE file_id=? AND user_id=?')
    .get(row.id, req.user.id).n;
  if (already >= MAX_TAGS_PER_FILE) {
    return res.status(409).json({ error: `A file stops at ${MAX_TAGS_PER_FILE} tags.` });
  }

  let tag = db.prepare('SELECT id, name FROM tags WHERE user_id=? AND name=?').get(req.user.id, clean.name);
  if (!tag) {
    const mine = db.prepare('SELECT COUNT(*) AS n FROM tags WHERE user_id=?').get(req.user.id).n;
    if (mine >= MAX_TAGS_PER_ACCOUNT) {
      return res.status(409).json({ error: `An account stops at ${MAX_TAGS_PER_ACCOUNT} tags.` });
    }
    const id = uid();
    try {
      db.prepare('INSERT INTO tags (id,user_id,name) VALUES (?,?,?)').run(id, req.user.id, clean.name);
    } catch (error) {
      // Two requests inventing the same word at the same moment. The index is
      // what decides; this just picks up whichever row won.
      if (!String(error.message).includes('UNIQUE')) throw error;
    }
    tag = db.prepare('SELECT id, name FROM tags WHERE user_id=? AND name=?').get(req.user.id, clean.name);
  }

  db.prepare('INSERT OR IGNORE INTO file_tags (file_id,tag_id,user_id) VALUES (?,?,?)')
    .run(row.id, tag.id, req.user.id);
  audit(req.user.id, 'file_tagged', req, `${row.name} tagged ${tag.name}`);
  res.json({ ok: true, tag, file: fileRow(req, row) });
});

app.delete('/api/files/:id/tags/:tagId', auth, (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'No such file.' });
  const removed = db.prepare('DELETE FROM file_tags WHERE file_id=? AND tag_id=? AND user_id=?')
    .run(row.id, req.params.tagId, req.user.id).changes;
  if (!removed) return res.status(404).json({ error: 'That tag is not on this file.' });
  audit(req.user.id, 'file_untagged', req, `${row.name}`);
  res.json({ ok: true, file: fileRow(req, row) });
});

// Retiring a word entirely. The files keep everything else about themselves;
// what goes is the label and every place it was used.
app.delete('/api/tags/:id', auth, (req, res) => {
  const tag = db.prepare('SELECT id, name FROM tags WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!tag) return res.status(404).json({ error: 'No such tag.' });
  const uses = db.prepare('DELETE FROM file_tags WHERE tag_id=? AND user_id=?').run(tag.id, req.user.id).changes;
  db.prepare('DELETE FROM tags WHERE id=? AND user_id=?').run(tag.id, req.user.id);
  audit(req.user.id, 'tag_deleted', req, `${tag.name}, from ${uses} file(s)`);
  res.json({ ok: true, removedFrom: uses });
});

// ── A picture of the file ───────────────────────────────────────────────────
//
// The box does not decode images. It stores a small picture the shell made from
// a file the shell already had, which keeps a native image library and its
// decoders — historically the most reliable way to be exploited by a file
// somebody uploaded — off the machine entirely.
//
// What arrives is therefore untrusted, and it is treated that way: a size cap, a
// short list of types, stored as bytes, and served back with the same headers as
// anything else a stranger could have influenced. It is never trusted to say
// anything about the file it belongs to.
const THUMBNAIL_MAX = 150 * 1024;
const THUMBNAIL_TYPES = ['image/jpeg', 'image/webp', 'image/png'];

app.put('/api/files/:id/thumbnail', auth,
  express.raw({ type: THUMBNAIL_TYPES, limit: THUMBNAIL_MAX + 4096 }),
  (req, res) => {
    const row = ownedFile(req);
    if (!row) return res.status(404).json({ error: 'No such file.' });
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!THUMBNAIL_TYPES.includes(mime)) return res.status(415).json({ error: 'A picture, and one of jpeg, webp or png.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'There was no picture in that.' });
    if (req.body.length > THUMBNAIL_MAX) return res.status(413).json({ error: 'That picture is too big to be a thumbnail.' });
    db.prepare(`INSERT INTO thumbnails (file_id,user_id,mime,bytes,width,height)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(file_id) DO UPDATE SET mime=excluded.mime, bytes=excluded.bytes,
        width=excluded.width, height=excluded.height, made_at=datetime('now')`)
      .run(row.id, req.user.id, mime, req.body,
        Math.max(0, parseInt(req.query.w, 10) || 0) || null,
        Math.max(0, parseInt(req.query.h, 10) || 0) || null);
    res.json({ ok: true });
  });

app.get('/api/files/:id/thumbnail', auth, notWhileImpersonating('see a picture of their files'), (req, res) => {
  const row = db.prepare('SELECT mime, bytes FROM thumbnails WHERE file_id=? AND user_id=?')
    .get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'No picture for that file.' });
  res.setHeader('Content-Type', row.mime);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.send(row.bytes);
});

// ── Folders ─────────────────────────────────────────────────────────────────
//
// Organisation, and only organisation. Filing something changes nothing about
// who can reach it, which is why the four places are elsewhere and why none of
// this touches a path on the disk.

// The one question every route below asks first: is this one of yours. A folder
// id from a request that is not this account's own reads as the top.
function ownFolder(userId, wanted) {
  const id = String(wanted || folders.TOP);
  if (id === folders.TOP) return folders.TOP;
  const row = db.prepare('SELECT id FROM folders WHERE id=? AND user_id=?').get(id, userId);
  return row ? row.id : folders.TOP;
}

const foldersOf = userId => db.prepare('SELECT id,parent_id,name,created_at FROM folders WHERE user_id=? ORDER BY name')
  .all(userId);

const folderPath = (userId, id) => folders.pathTo(foldersOf(userId), id).map(f => f.name).join(' / ') || 'the top';

app.get('/api/folders', auth, (req, res) => {
  const rows = foldersOf(req.user.id);
  // The count is of what is in the folder now, so an empty one can be told from
  // a full one without the shell fetching every file to work it out.
  const counts = db.prepare(`SELECT folder, COUNT(*) AS n FROM files
    WHERE user_id=? AND deleted_at IS NULL GROUP BY folder`).all(req.user.id);
  const byFolder = Object.fromEntries(counts.map(c => [c.folder, c.n]));
  res.json(rows.map(f => ({ ...f, files: byFolder[f.id] || 0 })));
});

app.post('/api/folders', auth,
  [body('name').isString(), body('parent').optional().isString()], validate,
  (req, res) => {
    const clean = folders.cleanName(req.body.name);
    if (!clean.ok) return res.status(400).json({ error: clean.reason });
    const parent = ownFolder(req.user.id, req.body.parent);
    if (folders.depthOf(foldersOf(req.user.id), parent) + 1 > folders.MAX_DEPTH) {
      return res.status(400).json({ error: `Folders stop at ${folders.MAX_DEPTH} deep.` });
    }
    const id = uid();
    try {
      db.prepare('INSERT INTO folders (id,user_id,parent_id,name) VALUES (?,?,?,?)')
        .run(id, req.user.id, parent, clean.name);
    } catch (error) {
      // The unique index is the thing that actually decides, rather than a
      // count taken a moment earlier that two requests can both pass.
      if (String(error.message).includes('UNIQUE')) {
        return res.status(409).json({ error: 'There is already a folder with that name here.' });
      }
      throw error;
    }
    audit(req.user.id, 'folder_created', req, `${clean.name} in ${folderPath(req.user.id, parent)}`);
    res.json({ ok: true, folder: { id, parent_id: parent, name: clean.name, files: 0 } });
  });

app.post('/api/folders/:id/rename', auth, [body('name').isString()], validate, (req, res) => {
  const mine = db.prepare('SELECT * FROM folders WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!mine) return res.status(404).json({ error: 'No such folder.' });
  const clean = folders.cleanName(req.body.name);
  if (!clean.ok) return res.status(400).json({ error: clean.reason });
  try {
    db.prepare('UPDATE folders SET name=? WHERE id=? AND user_id=?').run(clean.name, mine.id, req.user.id);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'There is already a folder with that name here.' });
    }
    throw error;
  }
  audit(req.user.id, 'folder_renamed', req, `${mine.name} is now ${clean.name}`);
  res.json({ ok: true });
});

// A file gets the same right a folder already had. The row's label changes and
// nothing else does: `disk_path` is untouched, so no name a customer types has
// any way to reach the filesystem, and the extension is preserved so a rename
// cannot change how a published file is served.
app.post('/api/files/:id/rename', auth, [body('name').isString()], validate, (req, res) => {
  const mine = db.prepare('SELECT * FROM files WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!mine) return res.status(404).json({ error: 'No such file.' });
  if (mine.deleted_at) return res.status(409).json({ error: 'That file is in the Trash. Restore it first, then rename it.' });
  const clean = workspaceFiles.renameTo(req.body.name, mine.name);
  if (!clean.ok) return res.status(400).json({ error: clean.reason });
  db.prepare('UPDATE files SET name=? WHERE id=? AND user_id=?').run(clean.name, mine.id, req.user.id);
  audit(req.user.id, 'file_renamed', req, `${mine.name} is now ${clean.name}`);
  res.json({ ok: true, name: clean.name });
});

app.post('/api/folders/:id/move', auth, [body('parent').optional().isString()], validate, (req, res) => {
  const mine = db.prepare('SELECT * FROM folders WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!mine) return res.status(404).json({ error: 'No such folder.' });
  const parent = ownFolder(req.user.id, req.body.parent);
  const all = foldersOf(req.user.id);
  // Into itself, or into something already inside it. Without this the folder
  // and everything under it leaves the tree, and nothing is left holding it.
  if (parent === mine.id || folders.isInside(all, mine.id, parent)) {
    return res.status(400).json({ error: 'A folder cannot go inside itself.' });
  }
  if (folders.depthOf(all, parent) + 1 > folders.MAX_DEPTH) {
    return res.status(400).json({ error: `Folders stop at ${folders.MAX_DEPTH} deep.` });
  }
  try {
    db.prepare('UPDATE folders SET parent_id=? WHERE id=? AND user_id=?').run(parent, mine.id, req.user.id);
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'There is already a folder with that name there.' });
    }
    throw error;
  }
  audit(req.user.id, 'folder_moved', req, `${mine.name} into ${folderPath(req.user.id, parent)}`);
  res.json({ ok: true });
});

// Only an empty one goes. Deleting a full folder either destroys files or hides
// them somewhere the customer did not put them, and both are worse than being
// told to empty it first.
//
// Files in the Trash are not counted as full: they are already on their way out,
// and one restored later comes back to the top with its folder gone.
app.delete('/api/folders/:id', auth, (req, res) => {
  const mine = db.prepare('SELECT * FROM folders WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!mine) return res.status(404).json({ error: 'No such folder.' });
  const kids = db.prepare('SELECT COUNT(*) AS n FROM folders WHERE user_id=? AND parent_id=?')
    .get(req.user.id, mine.id).n;
  const held = db.prepare('SELECT COUNT(*) AS n FROM files WHERE user_id=? AND folder=? AND deleted_at IS NULL')
    .get(req.user.id, mine.id).n;
  if (kids || held) {
    return res.status(409).json({
      error: `${mine.name} still has ${[held ? `${held} file${held === 1 ? '' : 's'}` : null,
        kids ? `${kids} folder${kids === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ')} in it.`,
    });
  }
  db.prepare('DELETE FROM folders WHERE id=? AND user_id=?').run(mine.id, req.user.id);
  audit(req.user.id, 'folder_deleted', req, mine.name);
  res.json({ ok: true });
});

// Filing a file. The bytes do not move: this is a fact about how its owner
// thinks, not about where it lives or who can see it.
app.post('/api/files/:id/folder', auth, [body('folder').optional().isString()], validate, (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'No such file.' });
  const folder = ownFolder(req.user.id, req.body.folder);
  db.prepare('UPDATE files SET folder=? WHERE id=? AND user_id=?').run(folder, row.id, req.user.id);
  audit(req.user.id, 'file_filed', req, `${row.name} into ${folderPath(req.user.id, folder)}`);
  res.json({ ok: true, file: fileRow(req, { ...row, folder }) });
});

// ── Finding something ───────────────────────────────────────────────────────
//
// One box, one search, over names: files, the folders they are in, and the
// words their owner put on them. `control/search.js` holds the index and the
// reasoning; this is what it looks like over HTTP.
//
// WHY THIS IS NOT BEHIND THE SUPPORT-ACCESS GATE
//
// Six routes refuse a borrowed session because they turn a file into bytes
// somebody can fetch. This one cannot: it answers with names, sizes and places,
// which is precisely the listing `SUPPORT_ACCESS.md` puts on the allowed side —
// a search is a filter over `/api/files` and discloses nothing the listing on
// the screen behind it does not already show. Gating it would be a stricter rule
// than the thing it filters, which reads as a bug rather than as a boundary.
//
// WHY THE TRASH IS NOT IN THE ANSWER BY DEFAULT
//
// A place is derived from where the bytes are, so a deleted file that appeared
// among live results would be an invitation to work on something that is on its
// way to being swept. It stays indexed and stays findable — the thing you threw
// away this morning is what you search for this afternoon — but you have to ask
// for the Trash to be shown it, and every row says which place it is in either
// way.
const searchLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false });

app.get('/api/search', auth, searchLimiter, (req, res) => {
  const asked = String(req.query.q || '');
  const found = search.matches(db, { owner: req.user.id, query: asked });
  const empty = { query: asked, words: [], files: [], folders: [], tags: [], limit: search.LIMIT, truncated: false };
  // Nothing typable in what was typed. An empty answer rather than an error:
  // a person who has typed one bracket so far has not made a mistake.
  if (!found.ok) return res.json(empty);

  // A place in the query is a filter and never an instruction, exactly as it is
  // on the listing. Asking for the Trash is asking for the Trash; asking for
  // nothing in particular leaves it out.
  const wanted = String(req.query.place || '').trim();
  const includeTrash = wanted === workspaceFiles.TRASH
    || ['1', 'true', 'yes'].includes(String(req.query.include_trash || '').toLowerCase());

  // The second half of the scope rule. Every id the index handed back is looked
  // up again in the real table with this account named, and one that does not
  // come back is dropped rather than reported. It is also the only way to learn
  // what these things actually are: the index holds a name, and a place is
  // derived from where the bytes are.
  const fileById = id => db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE id=? AND user_id=?`).get(id, req.user.id);
  const folderById = id => db.prepare('SELECT id,parent_id,name,created_at FROM folders WHERE id=? AND user_id=?').get(id, req.user.id);
  const tagById = id => db.prepare('SELECT id,name FROM tags WHERE id=? AND user_id=?').get(id, req.user.id);

  const tree = foldersOf(req.user.id);
  const hitFolders = [];
  const hitTags = [];
  // Why a file is in the answer. A file whose name has nothing to do with what
  // was typed, sitting in the results because it wears a matching tag, reads as
  // a broken search until it says so.
  const why = new Map();
  const order = [];

  // Names first, then folders, then the words. Two passes over one list rather
  // than one, and the order is the whole point: a file's own name is the better
  // answer to "why is this here", and a single pass in score order labelled
  // `harbour-at-dusk.jpg` as *Tagged harbour* whenever a tag of the same name
  // happened to score higher. The name matched. Saying otherwise is a small lie
  // on a screen whose whole job is explaining an answer.
  for (const hit of found.hits) {
    if (hit.kind !== search.FILE) continue;
    if (!why.has(hit.id)) { why.set(hit.id, { how: 'name' }); order.push(hit.id); }
  }
  for (const hit of found.hits) {
    if (hit.kind === search.FOLDER) {
      const row = folderById(hit.id);
      if (row) hitFolders.push({ ...row, path: folders.pathTo(tree, row.parent_id) });
      continue;
    }
    if (hit.kind !== search.TAG) continue;
    const tag = tagById(hit.id);
    if (!tag) continue;
    hitTags.push(tag);
    // Expanding a word to the files wearing it. Scoped on the join as well as
    // on the tag, because the owner is carried on `file_tags` for exactly this
    // kind of query and a lookup that names the account cannot reach past it.
    const wearing = db.prepare('SELECT file_id FROM file_tags WHERE tag_id=? AND user_id=?').all(tag.id, req.user.id);
    for (const { file_id: id } of wearing) {
      if (why.has(id)) continue;
      why.set(id, { how: 'tag', tag: { id: tag.id, name: tag.name } });
      order.push(id);
    }
  }

  const hitFiles = [];
  for (const id of order) {
    const row = fileById(id);
    if (!row) continue;
    const file = fileRow(req, row);
    if (wanted ? file.place !== wanted : (!includeTrash && file.place === workspaceFiles.TRASH)) continue;
    hitFiles.push({ ...file, matched: why.get(id) });
  }

  res.json({
    query: asked,
    words: found.words,
    files: hitFiles,
    folders: hitFolders,
    tags: hitTags,
    limit: search.LIMIT,
    // Said out loud, because a capped answer that looks complete is a person
    // concluding their file is gone.
    truncated: found.hits.length >= search.LIMIT,
  });
});

// ── What a file used to be ──────────────────────────────────────────────────
//
// Replacing a file keeps what was there. This is customer recovery and it sits
// beside the Trash, not beside the operator's backup: one is a person undoing
// their own afternoon, the other is a machine being rebuilt after a disaster,
// and conflating them is how a customer ends up asking an operator to restore a
// spreadsheet.
//
// The bytes move rather than being copied. The file keeps its row, its id, its
// name, its folder, its tags and its links; what changes is what is behind it.
// Keeping the same path on disk is deliberate — a published address and a share
// link both resolve through the row, so replacing the bytes under a public file
// updates what the world sees without breaking the address it sees it at.

// A file with a thousand versions is a script rather than a person. The bytes
// are the customer's own and counted against them, so this is not about disk: it
// is about a list nobody can read and a history nobody chose.
const MAX_VERSIONS = 25;
// How long history is kept when nobody has priced it. Thirty days is what the
// Trash does, and having the two answer differently by default would be a thing
// to explain rather than a thing to know.
const VERSION_DAYS = Math.max(1, parseInt(process.env.VERSION_RETENTION_DAYS || '30', 10) || 30);

function versionDaysFor(userId) {
  try {
    if (!workspaceFiles.entitlementInForce(entitlements.enabledMetrics(), 'files_version_days')) return VERSION_DAYS;
    const membership = ownership.getMembership(userId);
    if (!membership) return VERSION_DAYS;
    const entitlement = entitlements.effectiveEntitlement(membership.orgId, 'files_version_days');
    if (!entitlement || entitlement.missing) return VERSION_DAYS;
    // The same rule the Trash window follows: only a plan somebody actually
    // wrote counts as unlimited, and a number that makes no sense reads as the
    // box default rather than as "throw it away now".
    const priced = entitlement.source === 'package' || entitlement.source === 'override';
    if (!priced) return VERSION_DAYS;
    if (entitlement.maxUnlimited) return null;
    const days = Number(entitlement.maxValue);
    return Number.isFinite(days) && days >= 1 ? days : VERSION_DAYS;
  } catch {
    return VERSION_DAYS;
  }
}

const versionShape = row => ({
  id: row.id, name: row.name, size: row.size, mime: row.mime, made_at: row.made_at,
});

const versionsOf = (fileId, userId) => db.prepare(
  'SELECT * FROM file_versions WHERE file_id=? AND user_id=? ORDER BY made_at DESC, rowid DESC',
).all(fileId, userId);

// Set aside the bytes a file has now, and return the row that remembers them.
// The file is left pointing at a path with nothing behind it: every caller puts
// something there immediately, and doing it in this order means the old bytes
// are never the thing that gets lost if the write after it fails.
function keepCurrentAsVersion(row, userId, req) {
  const from = storageRoots.sharedPathFor(UPLOADS_DIR, userId, row.disk_path);
  if (!from) throw new Error('The bytes of that file are not where the record says they are.');
  const into = storageRoots.ensureRoot(UPLOADS_DIR, userId, storageRoots.VERSIONS);
  const id = uid() + uid();
  const kept = path.join(into, `${id}${path.extname(row.disk_path).slice(0, 20)}`);
  fs.renameSync(from, kept);
  try {
    db.prepare(`INSERT INTO file_versions (id,file_id,user_id,name,size,mime,disk_path)
      VALUES (?,?,?,?,?,?,?)`).run(id, row.id, userId, row.name, Number(row.size) || 0, row.mime, kept);
  } catch (error) {
    fs.renameSync(kept, from);
    throw error;
  }

  // Oldest first, once there are more than anybody would read.
  const spare = versionsOf(row.id, userId).slice(MAX_VERSIONS);
  for (const old of spare) removeVersion(old, userId, req, 'version_trimmed');
  return id;
}

function removeVersion(version, userId, req, action = 'version_removed') {
  const at = storageRoots.versionPathFor(UPLOADS_DIR, userId, version.disk_path);
  if (at) {
    try {
      fs.unlinkSync(at);
    } catch (error) {
      // The same rule Empty Trash follows: the row goes only if the bytes did,
      // because a row deleted over bytes that survived is storage nobody can see
      // and nobody is charged for.
      if (fs.existsSync(at)) { audit(userId, 'version_not_removed', req, error.message); return false; }
    }
  }
  db.prepare('DELETE FROM file_versions WHERE id=? AND user_id=?').run(version.id, userId);
  audit(userId, action, req, `${version.name}, ${version.size} bytes`);
  return true;
}

// Every version of every file this account is throwing away. Used by Empty Trash
// and by the retention sweep, so the bytes never outlive the row.
function dropVersionsFor(fileIds, userId, req) {
  if (!fileIds.length) return 0;
  const rows = db.prepare(`SELECT * FROM file_versions WHERE user_id=? AND file_id IN (${fileIds.map(() => '?').join(',')})`)
    .all(userId, ...fileIds);
  let gone = 0;
  for (const row of rows) if (removeVersion(row, userId, req, 'version_removed_with_file')) gone += 1;
  return gone;
}

app.get('/api/files/:id/versions', auth, (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'No such file.' });
  const days = versionDaysFor(req.user.id);
  res.json({
    kept_days: days,
    versions: versionsOf(row.id, req.user.id).map(versionShape),
  });
});

app.post('/api/files/:id/replace', auth, uploadLimiter, gate('new_upload'), quotaGate, upload.array('files', 1), (req, res) => {
  const incoming = (req.files || [])[0];
  const clean = () => { if (incoming) { try { fs.unlinkSync(incoming.path); } catch { /* already gone */ } } };
  const row = ownedFile(req);
  if (!row) { clean(); return res.status(404).json({ error: 'No such file.' }); }
  if (!incoming) return res.status(400).json({ error: 'There was no file in that.' });
  if (row.deleted_at) { clean(); return res.status(409).json({ error: 'That file is in the Trash. Take it out first, then replace it.' }); }

  // What actually landed, checked against the allowance with the version that is
  // about to be kept still counted, because it is: the old bytes stay.
  const after = quota.mayAccept({ db, entitlements, ownership, userId: req.user.id, incomingBytes: incoming.size });
  if (!after.allowed) {
    clean();
    audit(req.user.id, 'replace_refused_quota', req, `${incoming.size} bytes for ${row.name}`);
    return res.status(413).json({ error: after.reason, used: after.used, limit: after.limit });
  }

  try {
    const target = path.resolve(row.disk_path);
    keepCurrentAsVersion(row, req.user.id, req);
    fs.renameSync(incoming.path, target);
    db.prepare('UPDATE files SET size=?, mime=? WHERE id=? AND user_id=?')
      .run(incoming.size, incoming.mimetype, row.id, req.user.id);
    // The picture and the camera data described the bytes that are now history.
    db.prepare('DELETE FROM thumbnails WHERE file_id=? AND user_id=?').run(row.id, req.user.id);
    db.prepare('DELETE FROM file_metadata WHERE file_id=? AND user_id=?').run(row.id, req.user.id);
    const fresh = db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE id=? AND user_id=?`).get(row.id, req.user.id);
    rememberMetadata({ ...fresh, user_id: req.user.id }, req.user.id);
    audit(req.user.id, 'file_replaced', req, `${row.name}, ${row.size} bytes kept as a version`);
    res.json({ ok: true, file: fileRow(req, { ...fresh, user_id: req.user.id }) });
  } catch (error) {
    clean();
    res.status(500).json({ error: 'That file could not be replaced, and nothing was changed.' });
    audit(req.user.id, 'replace_failed', req, error.message);
  }
});

// Going back. The bytes that are current become a version of their own first, so
// this is reversible: restoring an old version never destroys the newer one it
// replaced, which is the difference between recovery and a second mistake.
app.post('/api/files/:id/versions/:versionId/restore', auth, (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'No such file.' });
  if (row.deleted_at) return res.status(409).json({ error: 'That file is in the Trash. Take it out first.' });
  const version = db.prepare('SELECT * FROM file_versions WHERE id=? AND file_id=? AND user_id=?')
    .get(req.params.versionId, row.id, req.user.id);
  if (!version) return res.status(404).json({ error: 'No such version.' });
  const from = storageRoots.versionPathFor(UPLOADS_DIR, req.user.id, version.disk_path);
  if (!from) return res.status(410).json({ error: 'The bytes of that version are no longer here.' });

  try {
    const target = path.resolve(row.disk_path);
    keepCurrentAsVersion(row, req.user.id, req);
    fs.renameSync(from, target);
    db.prepare('UPDATE files SET size=?, mime=? WHERE id=? AND user_id=?')
      .run(Number(version.size) || 0, version.mime, row.id, req.user.id);
    db.prepare('DELETE FROM file_versions WHERE id=? AND user_id=?').run(version.id, req.user.id);
    db.prepare('DELETE FROM thumbnails WHERE file_id=? AND user_id=?').run(row.id, req.user.id);
    db.prepare('DELETE FROM file_metadata WHERE file_id=? AND user_id=?').run(row.id, req.user.id);
    const fresh = db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE id=? AND user_id=?`).get(row.id, req.user.id);
    rememberMetadata({ ...fresh, user_id: req.user.id }, req.user.id);
    audit(req.user.id, 'version_restored', req, `${row.name} back to ${version.made_at}`);
    res.json({ ok: true, file: fileRow(req, { ...fresh, user_id: req.user.id }) });
  } catch (error) {
    audit(req.user.id, 'version_restore_failed', req, error.message);
    res.status(500).json({ error: 'That version could not be restored.' });
  }
});

// Looking at one without going back to it. Authenticated, owner only, and served
// out of the versions directory alone — the public route and a share link cannot
// reach in here.
app.get('/api/files/:id/versions/:versionId/download', auth, notWhileImpersonating('open what a file used to be'), (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'No such file.' });
  const version = db.prepare('SELECT * FROM file_versions WHERE id=? AND file_id=? AND user_id=?')
    .get(req.params.versionId, row.id, req.user.id);
  if (!version) return res.status(404).json({ error: 'No such version.' });
  const at = storageRoots.versionPathFor(UPLOADS_DIR, req.user.id, version.disk_path);
  if (!at) return res.status(404).json({ error: 'No such version.' });
  res.setHeader('Content-Type', version.mime || 'application/octet-stream');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', contentDisposition('attachment', version.name));
  res.locals.egress = { userId: req.user.id, exit: 'version' };
  res.sendFile(at);
});

// History has a window, the same way the Trash does, and for the same reason: a
// hosting company otherwise stores every draft anybody ever saved, for ever.
function runVersionSweep(req = null) {
  const owners = db.prepare('SELECT DISTINCT user_id FROM file_versions').all();
  let removed = 0;
  let accounts = 0;
  for (const owner of owners) {
    const days = versionDaysFor(owner.user_id);
    if (!days) continue;
    const rows = db.prepare('SELECT * FROM file_versions WHERE user_id=?').all(owner.user_id);
    const expired = workspaceFiles.sweepTrash({
      rows: rows.map(row => ({ ...row, deleted_at: row.made_at })),
      days,
    }).expired;
    if (!expired.length) continue;
    for (const version of expired) if (removeVersion(version, owner.user_id, req, 'version_expired')) removed += 1;
    accounts += 1;
  }
  return { accounts, removed };
}

app.post('/api/versions/sweep', auth, (req, res) => {
  if (!operatorOrRefuse(req, res)) return;
  res.json({ ok: true, ...runVersionSweep(req) });
});

// Stage the new bytes before moving the original into owner-only history.
function stripForPublishing(row, req, removing) {
  const target = storageRoots.sharedPathFor(UPLOADS_DIR, req.user.id, row.disk_path);
  if (!target) throw new Error('The file could not be read.');
  const original = fs.readFileSync(target);
  const stripped = exif.strip(original, removing);
  if (stripped.equals(original)) return;
  const allowance = quota.mayAccept({ db, entitlements, ownership, userId: req.user.id, incomingBytes: stripped.length });
  if (!allowance.allowed) throw Object.assign(new Error(allowance.reason), { status: 413 });
  const staged = target + '.' + uid() + '.strip';
  // Refuse before creating history if its limit would destroy an older version.
  if (versionsOf(row.id, req.user.id).length >= MAX_VERSIONS) {
    throw Object.assign(new Error('Remove a previous version before stripping this file.'), { status: 409 });
  }
  let version;
  try {
    fs.writeFileSync(staged, stripped, { flag: 'wx' });

    // Read back what was actually written, and check it before anything is
    // committed. A removal reported from the buffer we meant to write is a
    // report about an intention; the promise is about the bytes that will be
    // served. If they still carry what the customer asked to have taken out,
    // the publish fails here rather than succeeding quietly onto the internet.
    const written = fs.readFileSync(staged);
    const left = exif.carries(written);
    for (const kind of ['exif', 'xmp']) {
      if (removing[kind] && left[kind]) {
        throw Object.assign(new Error('That file could not be cleaned, so it has not been published.'), { status: 500 });
      }
    }

    db.transaction(() => {
      version = keepCurrentAsVersion(row, req.user.id, req);
      fs.renameSync(staged, target);
      db.prepare('UPDATE files SET size=? WHERE id=? AND user_id=?').run(stripped.length, row.id, req.user.id);
      db.prepare('DELETE FROM file_metadata WHERE file_id=? AND user_id=?').run(row.id, req.user.id);
      db.prepare('DELETE FROM thumbnails WHERE file_id=? AND user_id=?').run(row.id, req.user.id);
    })();
  } catch (error) {
    if (version) {
      const kept = path.join(storageRoots.ensureRoot(UPLOADS_DIR, req.user.id, storageRoots.VERSIONS), `${version}${path.extname(row.disk_path).slice(0, 20)}`);
      if (fs.existsSync(kept)) fs.renameSync(kept, target);
    }
    throw error;
  } finally {
    if (fs.existsSync(staged)) fs.unlinkSync(staged);
  }
  row.size = stripped.length;
  const kinds = [removing.exif && 'camera data', removing.xmp && 'XMP'].filter(Boolean).join(' and ');
  // A packet kept on purpose may still name where they stood. The trail says so
  // rather than reading as though everything went.
  const keptPacket = !removing.xmp && exif.readXmp(stripped);
  const alsoLeft = keptPacket && keptPacket.location ? '; XMP kept at their choice, and it names a location' : '';
  audit(req.user.id, 'metadata_stripped', req,
    `${row.name}: ${kinds} removed and read back clean, ${original.length} to ${stripped.length} bytes; original kept as ${version}${alsoLeft}`);
}

app.post('/api/files/:id/public', auth, notWhileImpersonating('publish their files, which would be a way to read them'),
  (req, res) => moveFile(req, res, workspaceFiles.PUBLIC));
app.post('/api/files/:id/private', auth, (req, res) => moveFile(req, res, workspaceFiles.MY_FILES));

// ── Shared ──────────────────────────────────────────────────────────────────
//
// The fourth place, and the only one that was in the model with nothing behind
// it. A share is a key to something private, handed to one person, with a role
// and a clock on it.
//
// It is a row, not a clever address. A link whose only protection is being hard
// to guess cannot be taken back, and taking it back is the whole point: somebody
// sends a link to the wrong person about twice a year and needs the link dead,
// not a lecture about entropy.

const SHARE_ROLES = ['view', 'download'];
const SHARE_WINDOW = /^(\d{1,5})\s*(s|m|h|d)$/;
const SHARE_UNITS = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' };
const MAX_SHARE_DAYS = 365;

// Every link ends. A share that never expires is a public file with extra steps,
// and this product has a Public for that. Refused rather than guessed at, because
// a link that silently outlives what the customer meant is the failure this whole
// section exists to prevent.
function shareWindow(text) {
  const parts = SHARE_WINDOW.exec(String(text == null || text === '' ? '7d' : text).trim().toLowerCase());
  if (!parts) return null;
  const n = parseInt(parts[1], 10);
  if (!n) return null;
  const days = n / { s: 86400, m: 1440, h: 24, d: 1 }[parts[2]];
  if (days > MAX_SHARE_DAYS) return null;
  return `+${n} ${SHARE_UNITS[parts[2]]}`;
}

function mayShare(userId) {
  let entitlement = null;
  let registered = false;
  try {
    registered = workspaceFiles.entitlementInForce(entitlements.enabledMetrics(), workspaceFiles.ENTITLEMENTS.shareLinks);
    const membership = ownership.getMembership(userId);
    if (registered && membership) {
      entitlement = entitlements.effectiveEntitlement(membership.orgId, workspaceFiles.ENTITLEMENTS.shareLinks);
    }
  } catch { entitlement = null; }
  return workspaceFiles.mayShare(entitlement, { registered });
}

const shareShape = row => ({
  id: row.id, file_id: row.file_id, role: row.role, label: row.label,
  created_at: row.created_at, expires_at: row.expires_at,
  password_protected: !!row.password,
  revoked: !!row.revoked_at,
  live: !row.revoked_at && new Date(workspaceFiles.asUtc(row.expires_at)) > new Date(),
});

app.post('/api/files/:id/share', auth, notWhileImpersonating('make a link to their files, which would be a way to read them'),
  [body('role').optional().isIn(SHARE_ROLES), body('password').optional().isLength({ min: 6 }),
    body('label').optional().isLength({ max: 120 })], validate,
  (req, res) => {
    const verdict = mayShare(req.user.id);
    if (!verdict.allowed) return res.status(403).json({ error: verdict.reason });
    const row = ownedFile(req);
    if (!row) return res.status(404).json({ error: 'No such file.' });
    if (row.deleted_at) return res.status(400).json({ error: 'That file is in the Trash. Take it out first, then share it.' });
    const window = shareWindow(req.body.expires_in);
    if (!window) {
      return res.status(400).json({ error: `An expiry like 7d, 24h or 30m, and no longer than ${MAX_SHARE_DAYS} days.` });
    }
    // Returned once and never again: only the hash is kept. Issuing another is
    // one call, and it retires nothing on its own — an old link stays live until
    // somebody revokes it, because two people can hold two different keys.
    const token = crypto.randomBytes(32).toString('base64url');
    const id = uid() + uid();
    db.prepare(`INSERT INTO shares (id,file_id,user_id,token_hash,role,password,label,expires_at)
      VALUES (?,?,?,?,?,?,?, datetime('now', ?))`)
      .run(id, row.id, req.user.id, hashToken(token), req.body.role || 'view',
        req.body.password ? bcrypt.hashSync(String(req.body.password), 12) : null,
        String(req.body.label || '').slice(0, 120) || null, window);
    const created = db.prepare('SELECT * FROM shares WHERE id=?').get(id);
    audit(req.user.id, 'share_created', req, `${row.name} as ${created.role} until ${created.expires_at}`);
    res.json({ ok: true, share: shareShape(created), url: workspaceFiles.shareUrlFor(publicBase(req), token) });
  });

app.get('/api/files/:id/shares', auth, (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'No such file.' });
  res.json(db.prepare('SELECT * FROM shares WHERE file_id=? AND user_id=? ORDER BY created_at DESC')
    .all(row.id, req.user.id).map(shareShape));
});

// Taking it back, which has to be immediate rather than eventual: the serving
// route reads the row on every request and there is no cache in front of it.
app.post('/api/files/:id/unshare', auth, (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'No such file.' });
  const revoked = db.prepare("UPDATE shares SET revoked_at=datetime('now') WHERE file_id=? AND user_id=? AND revoked_at IS NULL")
    .run(row.id, req.user.id).changes;
  audit(req.user.id, 'shares_revoked', req, `${revoked} link(s) on ${row.name}`);
  res.json({ ok: true, revoked });
});

app.post('/api/shares/:id/revoke', auth, (req, res) => {
  const revoked = db.prepare("UPDATE shares SET revoked_at=datetime('now') WHERE id=? AND user_id=? AND revoked_at IS NULL")
    .run(req.params.id, req.user.id).changes;
  if (!revoked) return res.status(404).json({ error: 'No such link.' });
  audit(req.user.id, 'share_revoked', req, req.params.id);
  res.json({ ok: true, revoked });
});

// ── Trash ───────────────────────────────────────────────────────────────────

app.delete('/api/files/:id', auth, (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  const place = workspaceFiles.placeFor(UPLOADS_DIR, row);
  // Deleting a public file would leave the bytes served with nothing pointing at
  // them: a file on the internet its owner believes is gone. An ordering problem
  // rather than a permission one, so the sentence says the order.
  const refusal = workspaceFiles.refusalForTrash(place);
  if (refusal) {
    audit(req.user.id, 'trash_refused', req, `${row.name} is public`);
    return res.status(409).json({ error: refusal });
  }
  if (row.deleted_at) return res.json({ ok: true, file: fileRow(req, row) });
  const at = new Date().toISOString();
  db.prepare('UPDATE files SET deleted_at=? WHERE id=? AND user_id=?').run(at, row.id, req.user.id);
  audit(req.user.id, 'trashed', req, row.name);
  res.json({ ok: true, file: fileRow(req, { ...row, deleted_at: at }) });
});

app.post('/api/files/:id/restore', auth, (req, res) => {
  const row = ownedFile(req);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (!row.deleted_at) return res.json({ ok: true, file: fileRow(req, row) });
  db.prepare('UPDATE files SET deleted_at=NULL WHERE id=? AND user_id=?').run(row.id, req.user.id);
  audit(req.user.id, 'restored', req, row.name);
  res.json({ ok: true, file: fileRow(req, { ...row, deleted_at: null }) });
});

// The only thing here that cannot be undone, which is why it is the only thing
// the screen asks about first.
// Emptying, done once. The customer's Empty Trash and the retention sweep are
// the same act on different rows, and two code paths that delete files are two
// chances to get the stuck-file rule below wrong in only one of them.
function emptyTrash({ userId, rows, req, action }) {
  const plan = workspaceFiles.planEmptyTrash({ uploadsDir: UPLOADS_DIR, userId, rows });
  let removed = 0;
  let versionsGone = 0;
  const stuck = [];
  for (const item of plan.remove) {
    // The row is deleted only if the bytes actually went. Unlinking best-effort
    // and deleting the row regardless leaves bytes on disk that no row claims,
    // which nothing will ever look at again and nobody is charged for. That is a
    // permanent leak on the hoster's disk, one file at a time, and it is
    // invisible because both the API and the customer agree the file is gone.
    try {
      fs.unlinkSync(item.path);
    } catch (error) {
      if (fs.existsSync(item.path)) { stuck.push({ id: item.id, name: item.name, why: error.message }); continue; }
    }
    // Before the row goes, because the row is what points at the version bytes.
    // Deleting the file first lets the foreign key take the version rows with it
    // and leaves their bytes on the disk with nothing claiming them — storage
    // nobody can see and nobody is charged for.
    versionsGone += dropVersionsFor([item.id], userId, req);
    db.prepare('DELETE FROM files WHERE id=? AND user_id=?').run(item.id, userId);
    removed++;
  }
  audit(userId, action, req,
    `${removed} removed${versionsGone ? `, with ${versionsGone} earlier version(s)` : ''}`
    + `${plan.kept.length ? `, ${plan.kept.length} kept: location outside this account` : ''}`
    + `${stuck.length ? `, ${stuck.length} could not be removed and were left in the Trash` : ''}`);
  return { removed, kept: plan.kept.length, stuck: stuck.length, versions: versionsGone };
}

app.post('/api/files/trash/empty', auth, (req, res) => {
  const rows = db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE user_id=? AND deleted_at IS NOT NULL`)
    .all(req.user.id);
  res.json({ ok: true, ...emptyTrash({ userId: req.user.id, rows, req, action: 'trash_emptied' }) });
});

// ── The Trash empties itself ────────────────────────────────────────────────
//
// Otherwise the hosting company stores deleted files for ever, for free, and the
// customer believes they are gone. Both halves of that are wrong.

// The box's own window, when nobody has priced one. Thirty days is what the
// customer expects from every product like this, and it is deliberately a number
// an operator can change rather than one buried in the code.
const TRASH_DAYS = Math.max(1, parseInt(process.env.TRASH_RETENTION_DAYS || '30', 10) || 30);

// How long this account's Trash holds. A plan can lengthen it, shorten it, or
// make it unlimited. Everything that goes wrong on the way to an answer lands on
// the box default, and a plan naming zero or nonsense is read as the default
// too: a bad number in a package must never be read as "destroy it today".
function trashDaysFor(userId) {
  try {
    if (!workspaceFiles.entitlementInForce(entitlements.enabledMetrics(), 'files_trash_days')) return TRASH_DAYS;
    const membership = ownership.getMembership(userId);
    if (!membership) return TRASH_DAYS;
    const entitlement = entitlements.effectiveEntitlement(membership.orgId, 'files_trash_days');
    if (!entitlement || entitlement.missing) return TRASH_DAYS;
    // Only a plan somebody actually wrote counts. A capability nobody priced
    // comes back from the engine as on and unlimited, which is right for a
    // switch and wrong for a window: read literally it would mean every box
    // where no hoster has configured anything keeps deleted files for ever,
    // which is the exact thing this sweep exists to stop. Unlimited retention is
    // real, and it is something a hoster has to have sold on purpose.
    const priced = entitlement.source === 'package' || entitlement.source === 'override';
    if (!priced) return TRASH_DAYS;
    if (entitlement.maxUnlimited) return null;
    const days = Number(entitlement.maxValue);
    return Number.isFinite(days) && days >= 1 ? days : TRASH_DAYS;
  } catch {
    return TRASH_DAYS;
  }
}

function runTrashSweep(req = null) {
  const owners = db.prepare(`SELECT DISTINCT user_id FROM files WHERE deleted_at IS NOT NULL`).all();
  let removed = 0;
  let stuck = 0;
  let accounts = 0;
  for (const owner of owners) {
    const days = trashDaysFor(owner.user_id);
    if (!days) continue;
    const rows = db.prepare(`SELECT ${FILE_COLUMNS} FROM files WHERE user_id=? AND deleted_at IS NOT NULL`)
      .all(owner.user_id);
    const { expired } = workspaceFiles.sweepTrash({ rows, days });
    if (!expired.length) continue;
    const result = emptyTrash({ userId: owner.user_id, rows: expired, req, action: 'trash_expired' });
    removed += result.removed;
    stuck += result.stuck;
    accounts++;
  }
  return { accounts, removed, stuck };
}

// The operator can run it now, which is also how it is proved: a sweep nobody can
// trigger is a sweep nobody can watch work.
app.post('/api/trash/sweep', auth, (req, res) => {
  if (!operatorOrRefuse(req, res)) return;
  res.json({ ok: true, ...runTrashSweep(req) });
});

// ── Storage reconciliation ──────────────────────────────────────────────────
//
// The meter is the invoice. It is summed from rows because a gate has to answer
// in milliseconds, and the disk is what is actually true, so the two have to be
// compared by something rather than assumed to agree.
//
// A customer may reconcile their own account; whoever sells to them may
// reconcile theirs. Reporting is safe and is separate from sweeping, because
// looking and deleting are different decisions.
app.get('/api/accounts/:id/storage/reconcile', auth, (req, res) => {
  const target = db.prepare('SELECT id FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const mine = target.id === req.user.id;
  const membership = ownership.getMembership(req.user.id);
  const targetMembership = ownership.getMembership(target.id);
  const theirSeller = membership && targetMembership
    && entitlements.getDirectParent(targetMembership.orgId) === membership.orgId;
  if (!mine && !theirSeller) return res.status(403).json({ error: 'That is not your account to look at.' });
  const found = quota.reconcile({ db, uploadsDir: UPLOADS_DIR, userId: target.id });
  if (!found.agrees) {
    audit(req.user.id, 'storage_divergence', req,
      `${target.id}: rows say ${found.recorded_bytes}, disk says ${found.actual_bytes}, `
      + `${found.orphans.length} orphan(s) worth ${found.orphan_bytes} bytes, ${found.problems.length} problem(s)`);
  }
  res.json(found);
});

// Removing bytes no row claims. Only the seller, because it deletes, and only
// ever inside the account's own two directories.
app.post('/api/accounts/:id/storage/sweep', auth, (req, res) => {
  const membership = sellerOrRefuse(req, res);
  if (!membership) return;
  const target = db.prepare('SELECT id,email FROM users WHERE id=?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'Not found' });
  const targetMembership = ownership.getMembership(target.id);
  if (!targetMembership || entitlements.getDirectParent(targetMembership.orgId) !== membership.orgId) {
    return res.status(403).json({ error: 'That is not your customer.' });
  }
  const swept = quota.sweepOrphans({ db, uploadsDir: UPLOADS_DIR, userId: target.id });
  audit(req.user.id, 'storage_swept', req, `${target.email}: ${swept.removed} orphan(s), ${swept.bytes} bytes`);
  res.json({ ok: true, ...swept });
});

// ── Backups ─────────────────────────────────────────────────────────────────
//
// Taking one, listing them, and verifying one without restoring it. Restore is
// deliberately absent from this file: it overwrites every customer's files, and
// an operation that does that from a stolen token is worse than the outage it
// would shorten. Restoring is `npm run restore`, run by somebody who is on the
// box with the server stopped. See `control/backup.js` for why the artifact is
// laid out the way it is.
//
// The box operator only. A reseller has customers of their own but a whole-box
// backup contains everybody's files, including their competitors', so this sits
// one rank above the plan routes rather than reusing `sellerOrRefuse`.
function operatorOrRefuse(req, res) {
  const membership = ownership.getMembership(req.user.id);
  if (!membership || membership.rank < HIERARCHY.hosting_company) {
    res.status(403).json({ error: 'Only the operator of this box can do that.' });
    return null;
  }
  return membership;
}

// Whether this box can actually send mail. The operator asks and nobody else
// does: /health stays silent about it, because somebody probing who learns that
// confirmation mail is going to a directory has learned something useful.
app.get('/api/mail/status', auth, (req, res) => {
  if (!operatorOrRefuse(req, res)) return;
  res.json({ mode: mailer.mode, from: mailer.from, spool: mailer.spoolDir });
});

app.post('/api/backups', auth, async (req, res) => {
  if (!operatorOrRefuse(req, res)) return;
  try {
    const taken = await backup.take({
      db,
      uploadsDir: UPLOADS_DIR,
      into: BACKUPS_DIR,
      label: req.body && req.body.label ? String(req.body.label).slice(0, 120) : null,
    });
    audit(req.user.id, 'backup_taken', req,
      `${taken.id} ${taken.status}: ${taken.manifest.counts.files_copied} file(s), `
      + `${taken.manifest.counts.bytes} bytes, ${taken.manifest.counts.users} account(s)`);
    // The directory is not returned. It is a path on the box and the operator
    // knows where their backups live; a path in an API response is a path
    // somebody eventually passes back in.
    res.json({ ok: true, id: taken.id, status: taken.status, counts: taken.manifest.counts, problems: taken.manifest.problems });
  } catch (error) {
    audit(req.user.id, 'backup_failed', req, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/backups', auth, (req, res) => {
  if (!operatorOrRefuse(req, res)) return;
  res.json(backup.list({ from: BACKUPS_DIR }));
});

// Reading a backup back and checking every hash, without writing anything. This
// is the difference between believing there are backups and knowing it, and it
// is cheap enough to run on a schedule.
app.post('/api/backups/:id/verify', auth, (req, res) => {
  if (!operatorOrRefuse(req, res)) return;
  // The id is looked up rather than joined onto a path. An identifier from a URL
  // that becomes a directory name is the oldest traversal there is.
  const known = backup.list({ from: BACKUPS_DIR }).find(b => b.id === req.params.id);
  if (!known) return res.status(404).json({ error: 'Not found' });
  const found = backup.inspect({ from: path.join(BACKUPS_DIR, known.directory) });
  audit(req.user.id, 'backup_verified', req, `${known.id}: ${found.ok ? 'intact' : found.problems.join('; ')}`);
  res.json({ id: known.id, ok: found.ok, files_checked: found.checked, problems: found.problems });
});

// ── Getting the artifact off the box ────────────────────────────────────────
//
// Until this existed, a backup was local recoverability and nothing more: it sat
// on the same disk as the thing it protected, so one dead disk took both. That
// was written down honestly in `control/backup.js` rather than glossed, and this
// is the part that was missing.
//
// The rule from that file carries over unchanged and is the reason this route is
// worth having at all: **nothing reports success for a copy it has not read
// back.** So a ship is an upload followed by a download of every object out of
// the bucket, hashed on the way in and compared against the hash the manifest
// recorded when the backup was taken. An endpoint that answers 200 to a PUT has
// proved that something accepted a request; only the read-back proves an object.
//
// Operator only, like every other backup route, and for the same reason: the
// artifact holds every account on the box including a reseller's competitors',
// and this one also names the bucket it goes to.

// Where backups go. Never what opens the door — `describe` cannot return the key
// or the secret, and there is no route that sets them, because they are
// environment and not database.
app.get('/api/backups/offsite', auth, (req, res) => {
  if (!operatorOrRefuse(req, res)) return;
  res.json(offsite.describe());
});

app.post('/api/backups/:id/ship', auth, async (req, res) => {
  if (!operatorOrRefuse(req, res)) return;
  // Looked up rather than joined onto a path, like the verify route above. An
  // identifier out of a URL that becomes a directory name is the oldest
  // traversal there is, and here it would also become an object key.
  const known = backup.list({ from: BACKUPS_DIR }).find(b => b.id === req.params.id);
  if (!known) return res.status(404).json({ error: 'Not found' });

  try {
    const shipped = await offsite.ship({ from: path.join(BACKUPS_DIR, known.directory) });
    if (shipped.ok) {
      audit(req.user.id, 'backup_shipped', req,
        `${known.id} to ${shipped.bucket} at ${shipped.endpoint}: `
        + `${shipped.verified} of ${shipped.objects} object(s) read back and matching, ${shipped.bytes} bytes`);
      return res.json(shipped);
    }
    // A ship that verified some of its objects and not others is a failure, not
    // a partial success. It is recorded as one and answered as one, because a
    // backup missing one customer's file is a restore that fails in a year.
    audit(req.user.id, 'backup_ship_failed', req,
      `${known.id}: ${shipped.verified} of ${shipped.objects} object(s) verified; ${shipped.problems.join('; ')}`);
    return res.status(502).json(shipped);
  } catch (error) {
    audit(req.user.id, 'backup_ship_failed', req, `${known.id}: ${offsite.scrub(error.message)}`);
    // A box with no target configured is not a broken box, it is one nobody has
    // finished setting up, and an operator reading a 500 goes looking in the
    // wrong place.
    return res.status(error.unconfigured ? 409 : 500).json({ error: offsite.scrub(error.message) });
  }
});

// ── A public file ───────────────────────────────────────────────────────────

// The id is in the address on purpose. Key a public file on its name alone and
// two files called `invoice.pdf` collide, with the loser being whichever the
// query happened to order second: one person's file serving another's content.
//
// The row finds the file and `servedPathFor` decides whether it may be sent. Two
// answers to one question, so that "files in My Files are never served" is a fact
// about the directory layout rather than about this query staying correct for
// ever. A 404 either way, because somebody probing should not learn the
// difference between a file that is not there and one that is private.
// Rate limited by address. A public file is a URL anybody can hit, so without
// this it is a free bandwidth tap pointed at somebody else's storage bill. Set
// high enough that a real page loading real assets never notices.
const publicLimiter = rateLimit({ windowMs: 60 * 1000, max: 240, standardHeaders: true, legacyHeaders: false });

app.get('/p/:userId/:fileId/:name', publicLimiter, (req, res) => {
  const { userId, fileId } = req.params;
  // A suspended account stops serving. This was missed the first time and it is
  // the difference between suspension meaning something and suspension meaning
  // the customer cannot sign in while their files carry on using the bandwidth
  // they are no longer paying for.
  const owner = db.prepare('SELECT suspended_at FROM users WHERE id=?').get(userId);
  if (!owner || owner.suspended_at) return res.status(404).send('Not found');
  const row = db.prepare('SELECT id,name,mime,disk_path,deleted_at FROM files WHERE id=? AND user_id=?')
    .get(fileId, userId);
  if (!row || row.deleted_at) return res.status(404).send('Not found');
  const served = storageRoots.servedPathFor(UPLOADS_DIR, userId, row.disk_path);
  if (!served) return res.status(404).send('Not found');
  // Somebody else's content on our address, so it gets no script, no origin and
  // no chance to touch a signed-in session. Nothing here executes: this streams
  // bytes and there is no interpreter anywhere near them.
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const stopped = hosting ? hosting.overTransfer(userId) : null;
  if (stopped) {
    // 509 rather than 404: the file is there and the address is right, and a
    // hosting company reading their own logs needs to see a bandwidth answer
    // rather than a missing one.
    audit(userId, 'egress_refused', req, `public ${row.name}, ${stopped.used} of ${stopped.limit} bytes`);
    announce('account.transfer_stopped', userId);
    return res.status(509).send('This file is over its transfer allowance for now.');
  }
  res.setHeader('Content-Disposition', contentDisposition('inline', row.name));
  res.locals.egress = { userId, exit: 'public' };
  res.sendFile(served);
});

// A share link, served next to the public route because these two are the only
// addresses somebody without an account can open, and they should be read
// together. `publicLimiter` covers both for the same reason: an address anybody
// can hit is a bandwidth tap pointed at somebody else's storage bill.
//
// The bytes usually come out of the private directory. That is what Shared is,
// and it is why the row is found first and the path second: `sharedPathFor` is
// only ever reached after a live, unrevoked, unexpired share has been matched to
// the token in the address, and it still refuses anything outside that account's
// own tree.
// A filename in a Content-Disposition header, as the person named it.
//
// The quoted form only carries ASCII safely, so it gets a stand-in with every other
// character replaced; the filename* form carries the real name, UTF-8 and percent-
// encoded, and every current browser prefers it. The public, share and version
// routes sent only the stand-in, so "Meeting notes.txt" arrived as
// "Meeting_notes.txt" and "Résumé.pdf" as "R_sum_.pdf" — found by opening a share
// link in a browser on a live box. The owner's own download already went through
// res.download and was right, which is why no test that downloaded as the owner saw it.
function contentDisposition(type, name) {
  const real = String(name || 'file');
  const fallback = real.replace(/[^A-Za-z0-9._ -]/g, '_').replace(/"/g, '_') || 'file';
  const encoded = encodeURIComponent(real).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function serveShare(req, res, { asAttachment }) {
  const share = db.prepare(`SELECT s.id, s.file_id, s.user_id, s.role, s.password,
      f.name, f.mime, f.disk_path, f.deleted_at, u.suspended_at
    FROM shares s
    JOIN files f ON f.id = s.file_id
    JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')`)
    .get(hashToken(req.params.token));
  // Revoked, expired, never existed, in the Trash, or the account is suspended:
  // one answer for all of them. Somebody holding a dead link does not get to
  // learn which kind of dead it is, and a suspended customer's links stop the
  // same way their public files do.
  if (!share || share.deleted_at || share.suspended_at) return res.status(404).send('Not found');
  if (share.password) {
    const given = req.headers['x-share-password'] || '';
    if (!given || !bcrypt.compareSync(String(given), share.password)) {
      // The shell will put a form in front of this. Until it does, the header is
      // the whole interface, and it is a header rather than a query string
      // because a password in a URL ends up in a log and a referrer.
      return res.status(401).send('This link needs a password.');
    }
  }
  // A view link does not hand over the original as an attachment. It is not DRM
  // and nothing here pretends it is — bytes somebody can see are bytes they can
  // keep — but the role the owner chose is honoured by the route that offers it.
  if (asAttachment && share.role !== 'download') return res.status(403).send('This link is view only.');
  const file = storageRoots.sharedPathFor(UPLOADS_DIR, share.user_id, share.disk_path);
  if (!file) return res.status(404).send('Not found');
  const stopped = hosting ? hosting.overTransfer(share.user_id) : null;
  if (stopped) {
    audit(share.user_id, 'egress_refused', req, `share ${share.name}, ${stopped.used} of ${stopped.limit} bytes`);
    announce('account.transfer_stopped', share.user_id);
    return res.status(509).send('This link is over its transfer allowance for now.');
  }
  res.locals.egress = { userId: share.user_id, exit: 'share' };
  res.setHeader('Content-Type', share.mime || 'application/octet-stream');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Private bytes on a public address: not indexed, not cached by anything in
  // the middle, because the link is meant for one person and expires.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Disposition', contentDisposition(asAttachment ? 'attachment' : 'inline', share.name));
  res.sendFile(file);
}

app.get('/s/:token', publicLimiter, (req, res) => serveShare(req, res, { asAttachment: false }));
app.get('/s/:token/download', publicLimiter, (req, res) => serveShare(req, res, { asAttachment: true }));

// The recipient shell is an explicit production route rather than an accident
// of the SPA fallback. It intentionally does not validate the token here: dead,
// expired and invented links all open the same neutral shell, which asks the
// byte route without disclosing why a link is unavailable.
app.get('/share/:token', (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  // The recipient's copy carries the same brand as everything else. This is the
  // surface that leaves the building — the one a customer forwards to somebody
  // who has never heard of them — so it is the last one that may be left generic.
  if (!sendShell(res)) return res.status(404).type('text/plain').send('Not found');
});

// ── The hosting company's own name on it ────────────────────────────────────
//
// This product is sold by hosting companies under their own brand, and the whole
// distribution wedge depends on a customer not being able to tell whose software
// they are using. So one brand belongs to the box, it is set from inside the
// product rather than by editing a file on the machine, and it reaches four
// surfaces: the shell, the sign-in screen, the page a share recipient opens, and
// the mail this box sends.
//
// Reading it needs no session. That is deliberate rather than an oversight: the
// sign-in screen and a shared link both have to know whose name is on them before
// there is anybody to authenticate, and everything these routes return is already
// printed on the page. Writing it is the box operator's, and nobody else's — a
// reseller inherits the brand of the company above them, which is the model in
// `DELIVERY_CONTRACTS.md` G1 and not a limitation waiting to be lifted.
//
// The brand routes carry their own budget rather than sharing the public file
// one. They are hit on every page load, and a shell that stops drawing its own
// logo because somebody is hammering a published file is one outage causing
// another.
const brandLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });

app.get('/api/brand', brandLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.json(brandShown());
});

// The same thing as a script, so the shell has the brand before its own bundle
// runs and nobody watches an unbranded product turn into a branded one. A file
// rather than an inline tag because the content security policy on this box
// refuses inline script, and that refusal is worth more than the request it costs.
app.get('/brand.js', brandLimiter, (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(branding.bootstrap(brandShown()));
});

// The built-in app icon: the glyph the shell draws when nobody has uploaded
// anything, in whatever colour the hoster chose. It is ours, it is a constant in
// this file, and it is the only SVG this route will ever answer with — an
// uploaded one is refused by `control/brand.js` on the way in, because an SVG is
// a document that can carry script and this origin is where the shell keeps its
// bearer token.
const defaultIcon = accent => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
  + `<rect width="32" height="32" rx="4" fill="${branding.escapeHtml(accent || '#a63f32')}"/>`
  + '<path d="M7 6.5h10v19H7z" fill="none" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/>'
  + '<path d="M13 16h12m-4-4 4 4-4 4" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'
  + '</svg>';

// One statement per asset rather than a column name built from the address. The
// name is checked against a fixed list first and would be safe either way, but a
// query assembled from a URL is a pattern somebody copies to a route where the
// check is missing.
const BRAND_ASSET_READ = {
  wallpaper: 'SELECT wallpaper_mime AS mime, wallpaper_bytes AS bytes FROM brand WHERE id=?',
  logo: 'SELECT logo_mime AS mime, logo_bytes AS bytes FROM brand WHERE id=?',
  icon: 'SELECT icon_mime AS mime, icon_bytes AS bytes FROM brand WHERE id=?',
};

app.get('/brand/:kind', brandLimiter, (req, res) => {
  const kind = String(req.params.kind);
  if (!branding.KINDS.includes(kind)) return res.status(404).type('text/plain').send('Not found');
  const row = db.prepare(BRAND_ASSET_READ[kind]).get(BRAND_ID);
  // Somebody else's picture on our address, served with the same headers as
  // every other byte on this box that a person could have influenced: the type
  // it was proved to be, no sniffing, and a policy under which nothing runs.
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=300');
  if (!row || !row.bytes) {
    if (kind !== 'icon') return res.status(404).type('text/plain').send('Not found');
    const row2 = db.prepare('SELECT accent FROM brand WHERE id=?').get(BRAND_ID);
    res.setHeader('Content-Type', 'image/svg+xml');
    return res.send(defaultIcon(row2 && row2.accent));
  }
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.send(row.bytes);
});

// Writing it is the Hosting edition's. A Community box shows
// the JotNotes brand and has no route that changes it.

// The shell, with the hosting company's name on it.
//
// index.html is the one file in the build without a content hash in its name,
// and it is already served with no-cache for that reason, which makes it the one
// place a brand can enter the page without rebuilding anything. Four things go
// in: a title, an icon, a theme colour and one script. Every value in them has
// been through `control/brand.js` first — a name that is not escaped here is not
// a name, it is markup on the origin that holds the session token.
//
// Held between page loads, keyed on the build and the brand together, because
// discovering that neither has changed is not worth a file read per request.
let shellCache = null;

function shellHtml() {
  // `hasShell()` said the file was there a moment ago. A build deletes the whole
  // output directory before writing it again, so on a machine somebody is
  // developing on there is a window where it is not, and a 500 on every page in
  // that window reads as the product being broken rather than as a build being
  // in progress.
  let stat;
  try { stat = fs.statSync(WEB_INDEX); }
  catch { return null; }
  const brand = brandShown();
  const key = `${stat.mtimeMs}:${stat.size}:${brand.version}`;
  if (shellCache && shellCache.key === key) return shellCache.html;
  const head = [
    `<link rel="icon" href="/brand/icon?v=${brand.version}">`,
    brand.accent ? `<meta name="theme-color" content="${branding.escapeHtml(brand.accent)}">` : '',
    `<script src="/brand.js?v=${brand.version}"></script>`,
  ].filter(Boolean).join('\n    ');
  let source;
  try { source = fs.readFileSync(WEB_INDEX, 'utf8'); }
  catch { return null; }
  const html = source
    .replace(/<title>[^<]*<\/title>/i, `<title>${branding.escapeHtml(brand.name || 'Files')}</title>`)
    .replace('</head>', `  ${head}\n  </head>`);
  shellCache = { key, html };
  return html;
}

// False when there is no build, which is a real state: a box with no shell is
// still the whole product over HTTP, and that is how the audit drives it.
function sendShell(res) {
  if (!hasShell()) return false;
  const html = shellHtml();
  if (html === null) return false;
  if (!res.getHeader('Cache-Control')) res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
  return true;
}

// Something for a load balancer to ask. Deliberately says nothing about the
// inside of the box: whether it is healthy is not a fact that needs an audience.
app.get('/health', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});

// ── The Hosting edition ─────────────────────────────────────────────────────
//
// Registered after every core route and before the desktop, so its routes are
// reachable and the desktop's catch-all cannot shadow them. What it is handed is
// the whole of what it may use from here.
if (hosting) {
  hosting.routes({ app, db, auth, validate, body, audit, ownership, entitlements, quota, UPLOADS_DIR,
    mailer, brandedMessage, jwt, JWT_SECRET, uid, express, branding, BRAND_ID, brandShown, HIERARCHY,
    sellerOrRefuse, operatorOrRefuse, accountInReach, sellsToDirectly, archiveTotals });
}

// ── The desktop ─────────────────────────────────────────────────────────────
//
// Served last, deliberately. Everything a route already answers — the API, a
// published file, a share link, health — is registered above this, so nothing
// here can shadow any of it. What is left over is the shell, and anything the
// shell does not know about is still the shell, because the paths it owns are
// decided in the browser.
if (hasShell()) {
  app.use(express.static(WEB_DIST, {
    index: false,
    // The build's own asset names carry a content hash, so they can be cached
    // hard. index.html cannot: it is what points at the current build, and a
    // cached one points at a build that is gone.
    setHeaders(res, file) {
      if (file.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    sendShell(res);
  });
}

// ── Start ───────────────────────────────────────────────────────────────────

// The first owner, and only the first. Loopback only, so it is not a door on the
// network: somebody has to already be on the machine, which on a box being
// installed is the installer. It refuses the moment an account exists, so it
// cannot be used a second time to mint a second operator.
const bootstrap = express();
bootstrap.use(express.json());
bootstrap.post('/bootstrap/owner', (req, res) => {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    return res.status(409).json({ error: 'This box already has an account. Accounts are created from inside.' });
  }
  try {
    // Confirmed on creation, and it is the only account that ever is. Whoever
    // calls this is on the machine's own loopback interface during an install,
    // which is a stronger proof than a mail round trip — and there is nowhere to
    // send one yet, because the operator has not configured mail on a box that
    // has existed for four minutes.
    const id = createAccount({ name: req.body.name, email: req.body.email, password: req.body.password, verified: true });
    const root = ensureEntitlementRoot();
    audit(id, 'bootstrap_owner_created', req, `${req.body.email} is the first account on this box`);
    res.json({ ok: true, userId: id, entitlementRoot: root ? root.orgId : null });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

if (require.main === module) {
  // The bootstrap port is hardcoded to loopback and is deliberately not
  // configurable. It mints the account that runs the box, and a box whose
  // operator can be created from the network is a box that can be taken over
  // before its owner has finished installing it. In a container that means the
  // container's own loopback, which is where the installer runs — so it is
  // reachable by whoever is doing the install and by nothing else, which is the
  // same property it has on metal. BIND_HOST below does not reach this line.
  bootstrap.listen(BOOTSTRAP_PORT, '127.0.0.1', () => {
    console.log(`[jdrive] bootstrap on 127.0.0.1:${BOOTSTRAP_PORT}, loopback only`);
  });
  app.listen(PORT, BIND_HOST, () => {
    // First line, before the ports and the paths. It is what an operator reads
    // when something is wrong, and what a hosting company is asked to quote.
    console.log(`[jdrive] ${build.line(migrations.state(db))}`);
    console.log(`[jdrive] listening on 127.0.0.1:${PORT}`);
    console.log(`[jdrive] files under ${UPLOADS_DIR}`);
    if (EMBED_ORIGINS.length) console.log(`[jdrive] may be shown inside: ${EMBED_ORIGINS.join(', ')}`);
    if (EMBED_REFUSED.length) console.warn(`[jdrive] EMBED_ORIGINS ignored ${EMBED_REFUSED.join(', ')}: each must be a whole https origin, like https://portal.example.com`);
    mailer.warnIfUnconfigured();
    offsite.warnIfUnconfigured();
    console.log(`[jdrive] ${hosting ? hosting.name : 'JDrive Community'}`);
    if (hosting) hosting.onListen();
    updates.start();
    // Hourly, and once at start. The window is measured in days, so the hour it
    // happens in does not matter; what matters is that it happens without anybody
    // remembering to ask, on a box nobody logs into.
    const sweep = () => {
      try {
        const done = runTrashSweep();
        if (done.removed || done.stuck) {
          console.log(`[jdrive] Trash sweep: ${done.removed} file(s) removed from ${done.accounts} account(s)`
            + `${done.stuck ? `, ${done.stuck} could not be removed` : ''}`);
        }
      } catch (error) {
        console.error(`[jdrive] Trash sweep failed: ${error.message}`);
      }
      try {
        const old = runVersionSweep();
        if (old.removed) {
          console.log(`[jdrive] Version sweep: ${old.removed} earlier version(s) removed from ${old.accounts} account(s)`);
        }
      } catch (error) {
        console.error(`[jdrive] Version sweep failed: ${error.message}`);
      }
    };
    sweep();
    setInterval(sweep, 60 * 60 * 1000).unref();
  });
}

// `limiters` is exported for the release audit alone. The audit drives hundreds
// of requests from one address in seconds, so by the later sections the public
// limiter is legitimately spent and a check written to prove something about a
// public address measures the limiter instead. Resetting between sections is
// test hygiene rather than a way in: nothing over HTTP can reach these.
module.exports = { app, bootstrapApp: bootstrap, db, ownership, entitlements, mailer, offsite,
  ...(hosting ? hosting.exports : {}),
  limiters: { public: publicLimiter, brand: brandLimiter, mail: mailLimiter, login: loginLimiter, loginIp: loginIpLimiter } };
