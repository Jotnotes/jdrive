'use strict';

// The four places, tested against the ways they quietly stop being true.
//
// The thing being protected is one sentence: a file the panel calls private is
// not reachable by anybody. Everything here is a way that sentence can become
// false without anything appearing to fail.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wf = require('./workspaceFiles');
const storageRoots = require('./storageRoots');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-wsfiles-'));
const uploads = path.join(tmp, 'uploads');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(uploads, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

const USER = 'u_files';
const priv = storageRoots.ensureRoot(uploads, USER, storageRoots.PRIVATE);
const pub = storageRoots.ensureRoot(uploads, USER, storageRoots.PUBLISHED);

const privateFile = path.join(priv, 'report.pdf');
const publicFile = path.join(pub, 'brochure.pdf');
fs.writeFileSync(privateFile, 'private bytes');
fs.writeFileSync(publicFile, 'public bytes');

const ROW = { id: 'f1', user_id: USER, name: 'report.pdf', disk_path: privateFile, deleted_at: null };
const PUBLIC_ROW = { id: 'f2', user_id: USER, name: 'brochure.pdf', disk_path: publicFile, deleted_at: null };
const UNLIMITED = { maxUnlimited: true, missing: false };

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const refuses = (name, plan, pattern, status) => {
  assert.strictEqual(plan.ok, false, `${name}: expected a refusal and it was allowed`);
  if (pattern) assert.match(plan.reason, pattern, `${name}: refused with "${plan.reason}"`);
  if (status) assert.strictEqual(plan.status, status, `${name}: answered ${plan.status}`);
  passed++; console.log(`ok  ${name} — refused ${plan.status}: ${plan.reason}`);
};

// ── Which place a file is in, decided by the disk ───────────────────────────

check('a file in the private root is in My Files', () => {
  assert.strictEqual(wf.placeFor(uploads, ROW), wf.MY_FILES);
});

check('a file in the published root is Public', () => {
  assert.strictEqual(wf.placeFor(uploads, PUBLIC_ROW), wf.PUBLIC);
});

check('a private file with a live link is Shared, and has not moved', () => {
  assert.strictEqual(wf.placeFor(uploads, ROW, { activeShares: 1 }), wf.SHARED);
});

check('a deleted file is in Trash whatever else was true of it', () => {
  const deleted = { ...PUBLIC_ROW, deleted_at: '2026-08-31T10:00:00Z' };
  assert.strictEqual(wf.placeFor(uploads, deleted), wf.TRASH);
  assert.strictEqual(wf.placeFor(uploads, { ...ROW, deleted_at: '2026-08-31T10:00:00Z' }, { activeShares: 3 }), wf.TRASH);
});

// The rule the whole product rests on. A caller declaring a state is a control
// built on a client-declared value, which is a control the client can turn off.
check('a caller naming its own state is ignored, and the disk decides', () => {
  assert.strictEqual(wf.placeFor(uploads, { ...ROW, state: 'public', place: 'public', published: true }), wf.MY_FILES);
});

check('a row nobody can make sense of reads as My Files, which shows it to nobody', () => {
  assert.strictEqual(wf.placeFor(uploads, { id: 'x', user_id: USER, disk_path: null }), wf.MY_FILES);
  assert.strictEqual(wf.placeFor(uploads, null), wf.MY_FILES);
});

// The usual way this check is got wrong. `startsWith` on its own says yes.
check('a sibling directory whose name starts the same is not the published root', () => {
  const decoy = path.join(uploads, USER, 'published-elsewhere', 'x.pdf');
  assert.strictEqual(wf.isPublicPath(uploads, USER, decoy), false);
});

check('one account cannot be made public by another account\'s directory', () => {
  assert.strictEqual(wf.isPublicPath(uploads, 'someone_else', publicFile), false);
});

check('reach says the internet only for Public', () => {
  assert.strictEqual(wf.reachability(wf.PUBLIC).internet, true);
  assert.strictEqual(wf.reachability(wf.MY_FILES).internet, false);
  assert.strictEqual(wf.reachability(wf.SHARED).internet, false);
  assert.strictEqual(wf.reachability(wf.TRASH).internet, false);
});

// ── The address ─────────────────────────────────────────────────────────────

check('the address carries the id, so two files with one name do not collide', () => {
  const a = wf.publicUrlFor('https://app.jotnotes.com', USER, { id: 'f1', name: 'invoice.pdf' });
  const b = wf.publicUrlFor('https://app.jotnotes.com', USER, { id: 'f2', name: 'invoice.pdf' });
  assert.notStrictEqual(a, b);
  assert.strictEqual(a, 'https://app.jotnotes.com/p/u_files/f1/invoice.pdf');
});

check('a name with a slash or a space in it cannot break out of the address', () => {
  const url = wf.publicUrlFor('https://app.jotnotes.com/', USER, { id: 'f1', name: '../../etc/passwd' });
  assert.ok(!url.includes('../'), `the name escaped: ${url}`);
  assert.match(url, /\/p\/u_files\/f1\//);
});

// ── Moving between My Files and Public ──────────────────────────────────────

check('making a file public moves it into the published root and nowhere else', () => {
  const plan = wf.planMove({ uploadsDir: uploads, userId: USER, row: ROW, to: wf.PUBLIC });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.move.from, privateFile);
  assert.strictEqual(plan.move.to, path.join(pub, 'report.pdf'));
  assert.strictEqual(plan.crossesIntoPublic, true);
  assert.strictEqual(plan.audit.action, 'file_made_public');
});

check('making it private again moves it back', () => {
  const plan = wf.planMove({ uploadsDir: uploads, userId: USER, row: PUBLIC_ROW, to: wf.MY_FILES });
  assert.strictEqual(plan.move.to, path.join(priv, 'brochure.pdf'));
  assert.strictEqual(plan.crossesIntoPublic, false);
  assert.strictEqual(plan.audit.action, 'file_made_private');
});

// The destination is built from the basename on disk, never from the display
// name, because a rename does not move the file and building from the display
// name would move the bytes to a path the row never pointed at.
check('a renamed row still moves the file that is actually on disk', () => {
  const renamed = { ...ROW, name: 'Something Else Entirely.pdf' };
  const plan = wf.planMove({ uploadsDir: uploads, userId: USER, row: renamed, to: wf.PUBLIC });
  assert.strictEqual(plan.move.to, path.join(pub, 'report.pdf'));
});

check('moving to where it already is is nothing to do, not an error', () => {
  const a = wf.planMove({ uploadsDir: uploads, userId: USER, row: PUBLIC_ROW, to: wf.PUBLIC });
  assert.strictEqual(a.noop, true);
  const b = wf.planMove({ uploadsDir: uploads, userId: USER, row: ROW, to: wf.MY_FILES });
  assert.strictEqual(b.noop, true);
});

refuses('a file in the Trash cannot be moved until it is taken out',
  wf.planMove({ uploadsDir: uploads, userId: USER, row: { ...ROW, deleted_at: 'now' }, to: wf.PUBLIC }),
  /in the Trash/, 409);

refuses('a row with no location on disk is refused rather than guessed at',
  wf.planMove({ uploadsDir: uploads, userId: USER, row: { ...ROW, disk_path: '' }, to: wf.PUBLIC }),
  /no location on disk/, 400);

check('there is no path for a caller to traverse, because the name comes off the disk', () => {
  // The whole traversal question does not arise in this product: a file dropped
  // into Public keeps its own name and no caller sends a path at all.
  const nasty = { ...ROW, disk_path: path.join(priv, 'ok.pdf'), name: '../../../etc/passwd' };
  const plan = wf.planMove({ uploadsDir: uploads, userId: USER, row: nasty, to: wf.PUBLIC });
  assert.strictEqual(plan.move.to, path.join(pub, 'ok.pdf'));
  assert.ok(storageRoots.isInside(pub, plan.move.to));
});

['trash', 'shared', 'somewhere-else'].forEach(place => {
  let threw = null;
  try { wf.planMove({ uploadsDir: uploads, userId: USER, row: ROW, to: place }); } catch (e) { threw = e; }
  assert.ok(threw, `moving to ${place} was allowed`);
  passed++; console.log(`ok  a file cannot be moved to ${place} — refused: ${threw.message}`);
});

// ── The entitlement ─────────────────────────────────────────────────────────

check('an account with the entitlement may make files public', () => {
  assert.strictEqual(wf.mayMakePublic(UNLIMITED).allowed, true);
  assert.strictEqual(wf.mayMakePublic({ maxValue: 1, missing: false }).allowed, true);
});

check('once the ladder carries the metric, missing means off rather than on', () => {
  // The direction that matters. On means a hoster who added the row and has not
  // filled it in has thereby put every customer's files on the web.
  assert.strictEqual(wf.mayMakePublic({ missing: true }).allowed, false);
  assert.strictEqual(wf.mayMakePublic(null).allowed, false);
  assert.strictEqual(wf.mayMakePublic({ maxValue: 0, missing: false }).allowed, false);
  assert.match(wf.mayMakePublic(null).reason, /not part of your plan/);
});

// The bug a two-account run on a clean box found. the public-files metric is not a
// metric the entitlements registry carries yet, because the workspace rows are
// step 5 and are not built, so it resolved to missing for every organization and
// the gate refused everybody on every box for ever while nothing failed or
// logged. "The ladder has no opinion" and "the ladder said no" are different
// questions and answering them the same way shipped the feature dead.
check('a metric the ladder does not carry at all is not in force, and allows', () => {
  const verdict = wf.mayMakePublic(null, { registered: false });
  assert.strictEqual(verdict.allowed, true, 'the feature is refused on every box that has not built step 5');
  assert.strictEqual(verdict.inForce, false);
});

check('and the day the row is added it starts being enforced with nothing to remember', () => {
  // Named through the constant rather than as a literal. Written as a literal it
  // silently stopped testing anything the day the metric was renamed, which is a
  // test that passes by not being about the product any more.
  const metrics = [{ metric_key: 'storage_bytes' }, { metric_key: 'seats' }];
  assert.strictEqual(wf.entitlementInForce(metrics, wf.ENTITLEMENTS.makePublic), false);
  assert.strictEqual(wf.entitlementInForce([...metrics, { metric_key: wf.ENTITLEMENTS.makePublic }], wf.ENTITLEMENTS.makePublic), true);
  assert.strictEqual(wf.entitlementInForce(null, wf.ENTITLEMENTS.makePublic), false);
});

check('the entitlement key is the one this product actually registers', () => {
  assert.strictEqual(wf.ENTITLEMENTS.makePublic, 'files_public');
  assert.strictEqual(wf.ENTITLEMENTS.storageBytes, 'storage_bytes');
});

// ── Trash ───────────────────────────────────────────────────────────────────

check('a public file cannot go to the Trash, and the sentence says the order', () => {
  const refusal = wf.refusalForTrash(wf.PUBLIC);
  assert.ok(refusal);
  assert.match(refusal, /Make it private first/);
  assert.strictEqual(wf.refusalForTrash(wf.MY_FILES), null);
  assert.strictEqual(wf.refusalForTrash(wf.SHARED), null);
});

check('emptying the Trash removes what is in it and only what is in it', () => {
  const rows = [
    { id: 'a', name: 'a.pdf', disk_path: path.join(priv, 'a.pdf'), deleted_at: 'now' },
    { id: 'b', name: 'b.pdf', disk_path: path.join(pub, 'b.pdf'), deleted_at: 'now' },
    { id: 'c', name: 'c.pdf', disk_path: path.join(priv, 'c.pdf'), deleted_at: null },
  ];
  const plan = wf.planEmptyTrash({ uploadsDir: uploads, userId: USER, rows });
  assert.deepStrictEqual(plan.remove.map(r => r.id), ['a', 'b']);
});

// The check that stops Empty Trash becoming an arbitrary unlink. A row carrying
// a path from before the storage split, or one somebody has edited, is kept and
// reported rather than obeyed.
check('a row pointing outside the account is kept rather than deleted', () => {
  const rows = [
    { id: 'evil', name: 'x', disk_path: path.join(outside, 'somebody-elses.pdf'), deleted_at: 'now' },
    { id: 'worse', name: 'y', disk_path: '/etc/passwd', deleted_at: 'now' },
    { id: 'sneaky', name: 'z', disk_path: path.join(priv, '..', '..', 'other', 'x.pdf'), deleted_at: 'now' },
  ];
  const plan = wf.planEmptyTrash({ uploadsDir: uploads, userId: USER, rows });
  assert.strictEqual(plan.remove.length, 0, 'Empty Trash was talked into deleting something outside the account');
  assert.strictEqual(plan.kept.length, 3);
});

check('a retention window is a date, and no window means it stays', () => {
  assert.strictEqual(wf.trashExpiry('2026-08-31T00:00:00.000Z', 30), '2026-09-30T00:00:00.000Z');
  assert.strictEqual(wf.trashExpiry('2026-08-31T00:00:00.000Z', null), null);
  assert.strictEqual(wf.trashExpiry(null, 30), null);
});

// ── The places agree with each other ────────────────────────────────────────

check('public then private returns the file to exactly where it started', () => {
  const out = wf.planMove({ uploadsDir: uploads, userId: USER, row: ROW, to: wf.PUBLIC });
  const nowPublic = { ...ROW, disk_path: out.move.to };
  assert.strictEqual(wf.placeFor(uploads, nowPublic), wf.PUBLIC);
  const back = wf.planMove({ uploadsDir: uploads, userId: USER, row: nowPublic, to: wf.MY_FILES });
  assert.strictEqual(back.move.to, privateFile);
  assert.strictEqual(wf.placeFor(uploads, { ...ROW, disk_path: back.move.to }), wf.MY_FILES);
});

// The promise, asked of the gate the serving route actually calls rather than of
// a comment in this file.
check('nothing in My Files is servable, asked of the serving gate itself', () => {
  assert.strictEqual(storageRoots.servedPathFor(uploads, USER, privateFile), null);
  assert.ok(storageRoots.servedPathFor(uploads, USER, publicFile), 'a public file was not servable');
});

check('a link in the published root pointing into the private one is not served', () => {
  const link = path.join(pub, 'sneaky.pdf');
  fs.symlinkSync(privateFile, link);
  try {
    assert.strictEqual(storageRoots.servedPathFor(uploads, USER, link), null,
      'a symlink out of the published root was served');
  } finally { fs.unlinkSync(link); }
});

// ── The Trash empties itself ────────────────────────────────────────────────

check('a file past the window is swept and one inside it is not', () => {
  const rows = [
    { id: 'old', deleted_at: '2026-07-01 09:00:00' },
    { id: 'recent', deleted_at: '2026-08-30 09:00:00' },
  ];
  const out = wf.sweepTrash({ rows, days: 30, now: new Date('2026-09-01T12:00:00Z') });
  assert.deepStrictEqual(out.expired.map(r => r.id), ['old']);
  assert.deepStrictEqual(out.keeping.map(r => r.id), ['recent']);
});

check('no window means nothing expires, because unlimited retention is a real thing to sell', () => {
  const rows = [{ id: 'ancient', deleted_at: '2020-01-01 00:00:00' }];
  assert.strictEqual(wf.sweepTrash({ rows, days: null }).expired.length, 0);
  assert.strictEqual(wf.sweepTrash({ rows, days: 0 }).expired.length, 0);
});

check('a file that is not in the Trash is never swept', () => {
  assert.strictEqual(wf.sweepTrash({ rows: [{ id: 'live' }], days: 1 }).expired.length, 0);
});

// The one that would be invisible: SQLite writes UTC with nothing saying so, and
// a bare string reads as local time. On a box an hour off UTC that is an hour of
// somebody's undo, in the code that destroys files.
check('a SQLite timestamp is read as UTC rather than as local time', () => {
  assert.strictEqual(wf.asUtc('2026-09-01 13:04:22'), '2026-09-01T13:04:22Z');
  assert.strictEqual(wf.asUtc('2026-09-01T13:04:22Z'), '2026-09-01T13:04:22Z');
  const due = wf.trashExpiry('2026-09-01 12:00:00', 1);
  assert.strictEqual(due, '2026-09-02T12:00:00.000Z');
});

// Renaming. The extension is the interesting half: it is preserved on purpose,
// because a published file is served with a type this box decided at upload and
// a rename that could change it would be a way to change how the open internet
// is told to treat somebody's bytes.
check('a rename keeps the extension the file arrived with', () => {
  assert.deepStrictEqual(wf.renameTo('trip', 'holiday.jpg'), { ok: true, name: 'trip.jpg' });
  assert.deepStrictEqual(wf.renameTo('trip.jpg', 'holiday.jpg'), { ok: true, name: 'trip.jpg' });
  assert.deepStrictEqual(wf.renameTo('trip.JPG', 'holiday.jpg'), { ok: true, name: 'trip.JPG' });
});

check('a rename cannot change what a file is', () => {
  // Not an error: the ask is honoured as a name and neutralised as a type, which
  // is visible in the result rather than silently discarded.
  assert.deepStrictEqual(wf.renameTo('notes.html', 'notes.txt'), { ok: true, name: 'notes.html.txt' });
});

check('a name is a label and can never reach the filesystem', () => {
  for (const bad of ['../../etc/passwd', 'a/b', 'a\\b', '.', '..', 'no\u0000pe']) {
    assert.strictEqual(wf.renameTo(bad, 'a.txt').ok, false, bad);
  }
});

check('a rename refuses what is not a name', () => {
  assert.strictEqual(wf.renameTo('   ', 'a.txt').ok, false);
  assert.strictEqual(wf.renameTo('.jpg', 'a.jpg').ok, false);
  assert.strictEqual(wf.renameTo('x'.repeat(wf.MAX_FILE_NAME + 1), 'a.txt').ok, false);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
