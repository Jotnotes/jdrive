'use strict';

// The index and the query parser, against a real SQLite database.
//
// What a search *means* over HTTP — whose files come back, which place they are
// in, whether the Trash shows — is proved in the release audit against the
// running box. This is the layer underneath: that the triggers keep the index
// true without any route helping them, and that what a person types cannot
// reach the FTS5 query parser as query language.

const assert = require('assert');
const Database = require('better-sqlite3');
const search = require('./search');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

// The three source tables, in the shape server.js creates them. Only the columns
// the index reads, because a test that restates the whole schema is a second
// schema to keep in step.
function box() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files   (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, deleted_at TEXT);
    CREATE TABLE folders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE tags    (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL);
  `);
  search.reindex(db);
  return db;
}
const addFile = (db, id, owner, name) =>
  db.prepare('INSERT INTO files (id,user_id,name) VALUES (?,?,?)').run(id, owner, name);
const found = (db, owner, query) =>
  search.matches(db, { owner, query }).hits.map(h => h.text).sort();

check('a name typed into a box finds a file without matching it exactly', () => {
  const db = box();
  addFile(db, 'f1', 'ann', 'Q3 Budget Draft.xlsx');
  assert.deepStrictEqual(found(db, 'ann', 'budget'), ['Q3 Budget Draft.xlsx']);
  assert.deepStrictEqual(found(db, 'ann', 'bud'), ['Q3 Budget Draft.xlsx']);
  assert.deepStrictEqual(found(db, 'ann', 'xlsx'), ['Q3 Budget Draft.xlsx']);
  // Every word has to match, so a second word narrows rather than widens.
  assert.deepStrictEqual(found(db, 'ann', 'budget q3'), ['Q3 Budget Draft.xlsx']);
  assert.deepStrictEqual(found(db, 'ann', 'budget q4'), []);
});

// Nobody types the accent when they are looking for the file, and the person who
// named it did. Both spellings have to find it or the folding is decoration.
check('an accent is not a different word', () => {
  const db = box();
  addFile(db, 'f1', 'ann', 'Café Résumé.pdf');
  assert.deepStrictEqual(found(db, 'ann', 'cafe'), ['Café Résumé.pdf']);
  assert.deepStrictEqual(found(db, 'ann', 'café'), ['Café Résumé.pdf']);
  assert.deepStrictEqual(found(db, 'ann', 'resume'), ['Café Résumé.pdf']);
});

// The whole of the security question. An index is the one table on this box that
// deliberately holds every account's words together.
check('a search never reaches another account', () => {
  const db = box();
  addFile(db, 'f1', 'ann', 'ann-secret-plan.txt');
  addFile(db, 'f2', 'bob', 'bob-secret-plan.txt');
  assert.deepStrictEqual(found(db, 'ann', 'secret'), ['ann-secret-plan.txt']);
  assert.deepStrictEqual(found(db, 'bob', 'secret'), ['bob-secret-plan.txt']);
  assert.deepStrictEqual(found(db, 'nobody', 'secret'), []);
});

check('a search with no account is refused rather than answered', () => {
  const db = box();
  addFile(db, 'f1', 'ann', 'anything.txt');
  assert.throws(() => search.matches(db, { owner: null, query: 'anything' }), /without an account/);
  assert.throws(() => search.matches(db, { owner: '', query: 'anything' }), /without an account/);
});

// The index is maintained by the database rather than by the routes, so this is
// what proves a route cannot forget it: nothing below calls into this module.
check('the index follows the truth without a route helping it', () => {
  const db = box();
  addFile(db, 'f1', 'ann', 'first-name.txt');
  assert.deepStrictEqual(found(db, 'ann', 'first'), ['first-name.txt']);

  db.prepare("UPDATE files SET name='second-name.txt' WHERE id='f1'").run();
  assert.deepStrictEqual(found(db, 'ann', 'first'), [], 'the old name is still findable');
  assert.deepStrictEqual(found(db, 'ann', 'second'), ['second-name.txt']);

  db.prepare("DELETE FROM files WHERE id='f1'").run();
  assert.deepStrictEqual(found(db, 'ann', 'second'), []);
});

// Deleting to the Trash is an UPDATE of one column, not a DELETE, and the thing
// somebody threw away this morning is what they search for this afternoon. What
// the index must not do is decide that: the place is settled where it is known.
check('a file in the Trash stays findable, and the index does not decide that', () => {
  const db = box();
  addFile(db, 'f1', 'ann', 'thrown-away.txt');
  db.prepare("UPDATE files SET deleted_at=datetime('now') WHERE id='f1'").run();
  assert.deepStrictEqual(found(db, 'ann', 'thrown'), ['thrown-away.txt']);
});

check('folders and tags are found alongside files, and say which they are', () => {
  const db = box();
  addFile(db, 'f1', 'ann', 'invoice-april.pdf');
  db.prepare("INSERT INTO folders (id,user_id,name) VALUES ('d1','ann','Invoices')").run();
  db.prepare("INSERT INTO tags (id,user_id,name) VALUES ('t1','ann','invoiced')").run();
  const kinds = search.matches(db, { owner: 'ann', query: 'invoic' }).hits
    .map(h => `${h.kind}:${h.id}`).sort();
  assert.deepStrictEqual(kinds, ['file:f1', 'folder:d1', 'tag:t1']);
});

// Rebuilding has to be safe to do twice, because the reason anybody runs it is
// that they are not sure what state the index is in.
check('rebuilding is idempotent and loses nothing', () => {
  const db = box();
  addFile(db, 'f1', 'ann', 'keep-me.txt');
  db.prepare("INSERT INTO folders (id,user_id,name) VALUES ('d1','ann','Keepers')").run();
  const counts = search.reindex(db);
  assert.deepStrictEqual(counts, { file: 1, folder: 1, tag: 0 });
  search.reindex(db);
  assert.deepStrictEqual(found(db, 'ann', 'keep').sort(), ['Keepers', 'keep-me.txt']);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM search_items').get().n, 2);
});

// ── What a person typed is never query language ─────────────────────────────

check('what reaches MATCH is a list of quoted words and nothing else', () => {
  assert.strictEqual(search.parse('budget').match, '"budget"*');
  assert.strictEqual(search.parse('q3 budget').match, '"q3"* AND "budget"*');
  // The operators of the query language are words here, not operators.
  assert.strictEqual(search.parse('a OR b').match, '"a"* AND "OR"* AND "b"*');
  assert.strictEqual(search.parse('x NEAR/3 y').match, '"x"* AND "NEAR"* AND "3"* AND "y"*');
  // And a quote cannot survive to close the one the parser puts around a word.
  assert.strictEqual(search.parse('say "hello"').match, '"say"* AND "hello"*');
  assert.strictEqual(search.parse('a" OR "b').match, '"a"* AND "OR"* AND "b"*');
});

check('nothing typable is an empty answer rather than an error', () => {
  for (const nothing of ['', '   ', null, undefined, '"', '***', '- / -']) {
    const parsed = search.parse(nothing);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.match, null);
  }
});

// A search box is an authenticated person's easiest way to hand a database a
// megabyte, and the cap is on what is read rather than on what is sent.
check('a very long query is cut rather than refused', () => {
  const parsed = search.parse('word '.repeat(5000));
  assert.strictEqual(parsed.ok, true);
  assert.ok(parsed.match.length < search.MAX_QUERY * 8);
});

check('a query that is only punctuation reaches no database at all', () => {
  const db = box();
  addFile(db, 'f1', 'ann', 'anything.txt');
  const answer = search.matches(db, { owner: 'ann', query: '***' });
  assert.strictEqual(answer.ok, false);
  assert.deepStrictEqual(answer.hits, []);
});

check('an answer is capped, and the cap is the one the caller is told about', () => {
  const db = box();
  for (let i = 0; i < search.LIMIT + 25; i++) addFile(db, `f${i}`, 'ann', `report-${i}.txt`);
  assert.strictEqual(search.matches(db, { owner: 'ann', query: 'report' }).hits.length, search.LIMIT);
  // And a caller cannot ask for more than the cap by saying so.
  assert.strictEqual(search.matches(db, { owner: 'ann', query: 'report', limit: 9999 }).hits.length, search.LIMIT);
});

console.log(`\n${passed} checks passed`);
