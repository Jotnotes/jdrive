'use strict';

// Schema changes that are ordered, applied once, and refuse to run backwards.
//
// WHAT WAS HERE BEFORE, AND WHY IT WAS NOT ENOUGH
//
// Every schema change on this box has been a guarded `ALTER TABLE` applied at
// start: ask whether the column is there, add it if not. Those blocks are
// correct and they are idempotent, and while every change only ever *adds* a
// column they are also sufficient. They are still in `server.js` and this file
// does not touch them — rewriting working migrations that have already run on
// live boxes buys nothing and risks everything.
//
// What they cannot do is anything else. There is no version number, so nothing
// knows what shape a database is in. There is no ordering, so two changes that
// depend on each other are applied in whatever order somebody wrote them down.
// There is no record, so a change that must happen exactly once — backfilling a
// column, splitting a table, correcting bad rows — has nowhere to record that it
// did. And nothing stops an older build opening a newer database, which is the
// case that loses data rather than merely failing.
//
// That is fine until the first change that is not purely additive, and that
// change will land on a box with a customer's files on it. Small now, an
// emergency later.
//
// THE BASELINE
//
// Migration 1 is a marker, not work. Every box reaching this file — new or
// running for months — already has the shape those guarded blocks produce,
// because they ran a few lines earlier in `server.js`. So the baseline is
// recorded rather than performed, and real migrations start at 2. An existing
// box with customers on it is adopted silently and correctly; a fresh box gets
// the same stamp for the same reason.
//
// A FAILED MIGRATION MUST LEAVE NO TRACE
//
// Each one runs inside a transaction, and that — not the order of the statements
// inside it — is what makes a failure safe: the work and the record of the work
// roll back together, so the next start finds the migration still pending and
// tries again. Recording after performing reads better and buys nothing, which
// is worth knowing before somebody 'fixes' the transaction away as redundant.
//
// GOING BACKWARDS IS REFUSED, LOUDLY
//
// A database carrying a migration this build has never heard of was written by a
// newer build. Opening it anyway is how an upgrade that gets rolled back takes
// the data with it: the old code does not know about the new column, writes rows
// without it, and the new code finds them broken when it comes back. There is no
// safe way to guess, so this refuses to start and says what to do.

const search = require('./search');

const BASELINE = 1;

// Ordered, and the order is the id. Each entry runs exactly once, inside a
// transaction, and is recorded with the time it ran.
//
//   { id, name, up(db) }
//
// `up` may assume every lower-numbered migration has been applied. Adding one is
// the whole ceremony: append it with the next id, never renumber, and never edit
// one that has shipped — a box that already ran it will not run it again, so an
// edit only changes what *new* boxes get, which is how two boxes end up with
// different schemas under the same version number.
const MIGRATIONS = [
  {
    id: BASELINE,
    name: 'baseline: the schema the guarded ALTER TABLEs produce',
    up: () => {},
  },
  {
    // The first real one, and the case this runner was built for: it is not a
    // column being added, it is a derived table that has to be *filled* from
    // what is already on the box. A guarded `ALTER TABLE` has nowhere to record
    // that a backfill has happened, so it would either run on every start or
    // never run again after somebody made it conditional on the table existing.
    //
    // It reads `files`, `folders` and `tags`, which the guarded blocks in
    // `server.js` create a few lines before this runner is called. That ordering
    // is the one thing here that is not written down anywhere else.
    id: 2,
    name: 'search: the name index, its triggers, and a backfill of what is already here',
    up: db => { search.reindex(db); },
  },
];

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

// The highest id this build knows about. What a database reports against this is
// the whole of the compatibility question.
function known() {
  return MIGRATIONS.reduce((high, m) => (m.id > high ? m.id : high), 0);
}

function applied(db) {
  ensureTable(db);
  return db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map(row => row.id);
}

// What the database says about itself, without changing it. `ahead` is the case
// that matters: ids this build has never heard of.
function state(db) {
  const have = applied(db);
  const ahead = have.filter(id => !MIGRATIONS.some(m => m.id === id));
  const pending = MIGRATIONS.filter(m => !have.includes(m.id)).map(m => m.id);
  return { applied: have, pending, ahead, version: have.length ? Math.max(...have) : 0, known: known() };
}

function run({ db, log = () => {} } = {}) {
  if (!db) throw new Error('the migration runner needs a database');
  ensureTable(db);

  const before = state(db);
  if (before.ahead.length) {
    throw new Error(
      `This database has been migrated by a newer build of JotNotes JDrive: it carries `
      + `migration(s) ${before.ahead.join(', ')} and this build only knows up to ${before.known}. `
      + `Refusing to start, because writing to it with older code loses the rows the newer columns hold. `
      + `Put the newer build back, or restore the backup taken before the upgrade.`);
  }

  const pending = MIGRATIONS.filter(m => !before.applied.includes(m.id));
  if (!pending.length) return { applied: [], version: before.version, adopted: false };

  // A box that has never been stamped already has the baseline shape, whether it
  // was created a minute ago or has been selling storage for a year — the
  // guarded blocks in server.js produced it either way. Recorded, not performed.
  const adopting = !before.applied.length;

  const done = [];
  for (const migration of pending) {
    const perform = db.transaction(() => {
      if (!(adopting && migration.id === BASELINE)) migration.up(db);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)')
        .run(migration.id, migration.name, new Date().toISOString());
    });
    perform();
    done.push(migration.id);
    log(adopting && migration.id === BASELINE
      ? `[jdrive] schema baseline recorded at migration ${migration.id}`
      : `[jdrive] applied migration ${migration.id}: ${migration.name}`);
  }
  return { applied: done, version: Math.max(...applied(db)), adopted: adopting };
}

module.exports = { run, state, known, MIGRATIONS, BASELINE };
