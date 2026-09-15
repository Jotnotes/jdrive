'use strict';

// The runner on its own, against real SQLite in memory.
//
// Three things decide whether this is worth having: it applies each migration
// exactly once, it adopts a box that already has the shape without re-running
// anything, and it refuses a database written by a newer build rather than
// quietly writing to it.

const assert = require('assert');
const Database = require('better-sqlite3');
const migrations = require('./migrations');

let checks = 0;
const ok = (name, fn) => { fn(); checks += 1; console.log(`ok  ${name}`); };
// A box, not a bare database. Migration 2 builds the search index out of what
// is already on the box, so it needs the tables `server.js` creates before this
// runner is ever called. A test whose database has no files in it would prove
// the runner against a shape no real box has.
const fresh = () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files   (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE folders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE tags    (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL);
  `);
  return db;
};
const everyId = () => migrations.MIGRATIONS.map(m => m.id);

ok('a box with no record is stamped at the baseline rather than migrated', () => {
  const db = fresh();
  const out = migrations.run({ db });
  assert.strictEqual(out.adopted, true);
  // Everything this build knows is recorded, and the baseline among them is
  // recorded rather than performed — the guarded blocks in server.js already
  // produced that shape, whether this box is a minute or a year old.
  assert.deepStrictEqual(out.applied, everyId());
  assert.strictEqual(out.version, migrations.known());
});

ok('and running again does nothing, because nothing is pending', () => {
  const db = fresh();
  migrations.run({ db });
  const again = migrations.run({ db });
  assert.deepStrictEqual(again.applied, []);
  assert.strictEqual(again.version, migrations.known());
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, migrations.MIGRATIONS.length);
});

ok('a migration runs exactly once, however many times the box starts', () => {
  const db = fresh();
  let ran = 0;
  const extra = { id: 9001, name: 'counts itself', up: () => { ran += 1; } };
  migrations.MIGRATIONS.push(extra);
  try {
    migrations.run({ db });
    migrations.run({ db });
    migrations.run({ db });
    assert.strictEqual(ran, 1, 'the migration ran more than once');
  } finally {
    migrations.MIGRATIONS.pop();
  }
});

ok('a new migration on an already-adopted box is performed, not just stamped', () => {
  const db = fresh();
  migrations.run({ db });                       // adopted at the baseline
  let ran = 0;
  const extra = { id: 9002, name: 'real work', up: d => { ran += 1; d.exec('CREATE TABLE later (x TEXT)'); } };
  migrations.MIGRATIONS.push(extra);
  try {
    const out = migrations.run({ db });
    assert.strictEqual(ran, 1);
    assert.deepStrictEqual(out.applied, [9002]);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='later'").get(),
      'the migration was recorded without being performed');
  } finally {
    migrations.MIGRATIONS.pop();
  }
});

ok('a database written by a newer build is refused, not opened', () => {
  const db = fresh();
  migrations.run({ db });
  db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)')
    .run(99999, 'from the future', new Date().toISOString());
  assert.throws(() => migrations.run({ db }), /newer build/,
    'an older build opened a newer database, which is how a rollback eats the rows the new columns hold');
});

ok('and the refusal names the migration it does not understand', () => {
  const db = fresh();
  migrations.run({ db });
  db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)')
    .run(4242, 'from the future', new Date().toISOString());
  try { migrations.run({ db }); assert.fail('it should have refused'); }
  catch (error) { assert.ok(/4242/.test(error.message), `the refusal did not say which: ${error.message}`); }
});

ok('a failed migration leaves no record of itself, so it is retried', () => {
  const db = fresh();
  migrations.run({ db });
  const bad = { id: 9003, name: 'throws', up: () => { throw new Error('halfway'); } };
  migrations.MIGRATIONS.push(bad);
  try {
    assert.throws(() => migrations.run({ db }), /halfway/);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE id=9003').get().n, 0,
      'a migration that threw was recorded as applied, so it would never run again');
  } finally {
    migrations.MIGRATIONS.pop();
  }
});

ok('the state of a box can be read without changing it', () => {
  const db = fresh();
  const before = migrations.state(db);
  assert.strictEqual(before.version, 0);
  assert.deepStrictEqual(before.pending, everyId());
  assert.strictEqual(migrations.state(db).version, 0, 'reading the state migrated the box');
});

ok('ids are unique and ordered, so two migrations cannot share a number', () => {
  const ids = migrations.MIGRATIONS.map(m => m.id);
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a - b), 'the list is not in id order');
  assert.strictEqual(new Set(ids).size, ids.length, 'two migrations share an id');
});

console.log(`\n${checks} checks passed`);
