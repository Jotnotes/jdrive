'use strict';

// Finding a file by typing part of its name, the name of the folder it is in,
// or a word its owner put on it.
//
// Not content search. Nothing here opens a file or reads a byte of one: the
// index holds names — of files, of folders, of tags — and nothing else. Reading
// inside documents needs an extractor per format and is a later decision, and
// pretending otherwise here would put the customer's contents into a table that
// the rest of this file's rules were not written for.
//
// WHY AN INDEX AT ALL, WHEN `LIKE` EXISTS
//
// `name LIKE '%invoice%'` is one line and finds nothing a person expects.
// It cannot match `Invoice` against `invoices`, cannot fold `café` onto `cafe`,
// cannot rank, and scans every row of every account on the box for every
// keystroke. FTS5 is already compiled into better-sqlite3, so the index costs
// nothing to obtain and answers the question people actually ask.
//
// SCOPE IS THE WHOLE OF THE SECURITY QUESTION
//
// An index is a table that deliberately holds every account's words in one
// place, which makes it the one structure on this box where a missing `WHERE`
// crosses an account boundary silently and with good performance. So the scope
// is written twice, on purpose:
//
//   1. every match is filtered by `owner` in the SQL, and
//   2. every id that comes back is looked up again in `files`, `folders` or
//      `tags` with `user_id` named, and anything that does not come back is
//      dropped rather than reported.
//
// The second is not belt and braces for its own sake — it is also what turns an
// id into a truthful row, because a place is derived from where the bytes are
// and the index has no opinion about that. But it is written so that either one
// alone still holds the boundary. `audit/selftest.js` removes both together,
// because removing one and finding the account still protected would be
// reported as an unguarded behaviour when the truth is the opposite.
//
// THE INDEX IS DERIVED, AND IS MAINTAINED BY THE DATABASE
//
// Every row in here is a copy of a name that is true somewhere else, so the
// index can always be thrown away and rebuilt — `reindex` does exactly that.
// What it must not do is drift, and the way a derived table drifts is that
// somebody adds a seventh route that writes a name and does not know this file
// exists. So it is maintained by triggers rather than by the routes: they run
// inside the same transaction as the write, and no code path can forget them.
//
// The triggers are on `files`, `folders` and `tags`. There is deliberately none
// on `file_tags`: a tag is indexed as itself, once, and a file wearing it is
// found by expanding the tag to the files that carry it at query time. The
// alternative — writing every file's tags into that file's index row — means a
// tag rename rewrites a row per file and a join table that has to fire triggers
// of its own, to hold a copy of something the database already knows.

// The tokenizer. `remove_diacritics 2` is the correct one rather than the
// default: it folds `café` onto `cafe` without also mangling the codepoints that
// are letters in their own right in the languages that use them.
const TOKENIZER = "unicode61 remove_diacritics 2";

// What can be found. A file, a folder, or a word somebody chose.
const FILE = 'file';
const FOLDER = 'folder';
const TAG = 'tag';
const KINDS = [FILE, FOLDER, TAG];

// How many rows a single search may return. A cap rather than paging, because
// the answer to "four thousand things match" is a better search box and not a
// second page: nobody reads to result 300.
const LIMIT = 200;
// The longest thing anybody may type at it. A search box is an unauthenticated
// person's favourite way to hand a database a megabyte.
const MAX_QUERY = 200;

// ── The index ───────────────────────────────────────────────────────────────
//
// Two tables and not one. An ordinary table holds the mapping and an
// external-content FTS5 index sits over it, keyed by its integer rowid.
//
// The obvious shape — one standalone FTS5 table carrying `item_id` as an
// unindexed column — works and is a trap. Removing a row from it means
// `DELETE FROM index WHERE item_id=?`, and an unindexed column has no index, so
// every single delete scans the entire table. Emptying a Trash of ten thousand
// files is then ten thousand full scans of every name on the box. This shape
// deletes through a unique index instead.
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS search_items (
    rowid    INTEGER PRIMARY KEY,
    item_id  TEXT NOT NULL,
    owner    TEXT NOT NULL,
    kind     TEXT NOT NULL,
    text     TEXT NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_search_items_item ON search_items(kind, item_id);
  CREATE INDEX IF NOT EXISTS idx_search_items_owner ON search_items(owner);

  CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    text,
    content='search_items',
    content_rowid='rowid',
    tokenize='${TOKENIZER}'
  );
`;

// Keeping the FTS index in step with the mapping table. This is the pattern the
// SQLite documentation prescribes for an external-content table, and the delete
// form is the part that is easy to get wrong: an external-content index cannot
// read a row that has already gone, so the old text has to be handed to it.
const CONTENT_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS search_items_ai AFTER INSERT ON search_items BEGIN
    INSERT INTO search_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS search_items_ad AFTER DELETE ON search_items BEGIN
    INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS search_items_au AFTER UPDATE ON search_items BEGIN
    INSERT INTO search_fts(search_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO search_fts(rowid, text) VALUES (new.rowid, new.text);
  END;
`;

// One pair of statements per source table, written out rather than generated,
// because a generated trigger is a trigger nobody reads before changing a
// column name.
//
// A file that is deleted to the Trash is an UPDATE and not a DELETE, so it stays
// in the index and stays findable. That is deliberate: something you threw away
// this morning is exactly the thing you search for this afternoon. What must not
// happen is that it comes back looking live, and that is decided at query time
// where the place is known, not here.
function sourceTriggers(table, kind, ownerColumn, nameColumn) {
  const write = ref => `
    DELETE FROM search_items WHERE kind='${kind}' AND item_id=${ref}.id;
    INSERT INTO search_items(item_id, owner, kind, text)
      VALUES (${ref}.id, ${ref}.${ownerColumn}, '${kind}', ${ref}.${nameColumn});`;
  return `
    CREATE TRIGGER IF NOT EXISTS search_${kind}_ai AFTER INSERT ON ${table} BEGIN${write('new')}
    END;
    CREATE TRIGGER IF NOT EXISTS search_${kind}_au AFTER UPDATE OF ${nameColumn} ON ${table} BEGIN${write('new')}
    END;
    CREATE TRIGGER IF NOT EXISTS search_${kind}_ad AFTER DELETE ON ${table} BEGIN
      DELETE FROM search_items WHERE kind='${kind}' AND item_id=old.id;
    END;`;
}

const SOURCE_TRIGGERS = [
  sourceTriggers('files', FILE, 'user_id', 'name'),
  sourceTriggers('folders', FOLDER, 'user_id', 'name'),
  sourceTriggers('tags', TAG, 'user_id', 'name'),
].join('\n');

// Build the index from nothing, out of what is true right now. Used by the
// migration that introduces it, and the repair if it is ever suspected of
// having drifted. Rebuilding is cheap and idempotent, which is the whole reason
// derived data is allowed to exist here at all.
function reindex(db) {
  db.exec(SCHEMA);
  db.exec(CONTENT_TRIGGERS);
  db.exec(SOURCE_TRIGGERS);
  db.exec(`DELETE FROM search_items;`);
  // The FTS index is emptied through its own command rather than by deleting
  // rows: with the content table already empty there is nothing left for a
  // delete to read the old text out of.
  db.exec(`INSERT INTO search_fts(search_fts) VALUES ('delete-all');`);
  const counts = {};
  for (const [table, kind] of [['files', FILE], ['folders', FOLDER], ['tags', TAG]]) {
    const done = db.prepare(`INSERT INTO search_items(item_id, owner, kind, text)
      SELECT id, user_id, '${kind}', name FROM ${table}`).run();
    counts[kind] = done.changes;
  }
  return counts;
}

// ── What somebody typed ─────────────────────────────────────────────────────

// A search box is a place where a person types words, and FTS5 MATCH is a place
// that reads a query language. Handing one straight to the other is how typing
// an apostrophe or the word `NEAR` produces a database error on the screen, and
// how `"` lets somebody write a query nobody meant.
//
// So nothing is escaped and passed through. The words are extracted and a query
// is built from them, which means the only thing that can reach MATCH is a list
// of quoted words. Anything else a person typed is punctuation and is dropped.
//
// Every word is a prefix. `inv 20` finds `Invoice 2024.pdf`, which is how a file
// search is expected to behave — matching only whole words would mean typing a
// filename exactly to find it, and somebody who can do that does not need this.
function parse(raw) {
  const text = String(raw == null ? '' : raw).slice(0, MAX_QUERY);
  // Letters, numbers and marks in any script. `\p{M}` keeps a combining accent
  // attached to the letter it belongs to rather than splitting a word in half.
  const words = text.match(/[\p{L}\p{N}\p{M}_]+/gu) || [];
  if (!words.length) return { ok: false, words: [], match: null };
  // A double quote cannot survive the character class above, so this is belt
  // and braces on a closed door — and it stays, because the day somebody widens
  // that class to admit a hyphen is the day it becomes the only thing standing
  // between a search box and the query parser.
  const match = words.map(word => `"${word.replace(/"/g, '')}"*`).join(' AND ');
  return { ok: true, words, match };
}

// ── Asking ──────────────────────────────────────────────────────────────────

// The matching rows, scoped to one account, as ids and nothing more.
//
// It returns ids rather than rows on purpose. Whoever calls this has to go back
// to the real tables to find out what these things are, which is the second half
// of the scope rule and also the only way to learn a file's place — the index
// holds a name, and a place is derived from where the bytes are.
function matches(db, { owner, query, limit = LIMIT }) {
  const parsed = parse(query);
  if (!parsed.ok) return { ok: false, words: [], hits: [] };
  if (!owner) throw new Error('a search without an account is not a search');
  const rows = db.prepare(`
    SELECT i.item_id AS id, i.kind AS kind, i.text AS text, bm25(search_fts) AS score
      FROM search_fts
      JOIN search_items i ON i.rowid = search_fts.rowid
     WHERE search_fts MATCH ?
       AND i.owner = ?
     ORDER BY score
     LIMIT ?`).all(parsed.match, owner, Math.min(Number(limit) || LIMIT, LIMIT));
  return { ok: true, words: parsed.words, hits: rows };
}

module.exports = {
  FILE, FOLDER, TAG, KINDS, LIMIT, MAX_QUERY, TOKENIZER,
  SCHEMA, CONTENT_TRIGGERS, SOURCE_TRIGGERS,
  reindex, parse, matches,
};
