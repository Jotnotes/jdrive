'use strict';

// The folder rules, on their own. What a folder does to a file is proved over
// HTTP in the release audit; this is the arithmetic underneath it — how deep a
// thing is, whether a move would swallow a tree, and what counts as a name.

const assert = require('assert');
const folders = require('./folders');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

const TREE = [
  { id: 'a', parent_id: 'root', name: 'Invoices' },
  { id: 'b', parent_id: 'a', name: '2026' },
  { id: 'c', parent_id: 'b', name: 'March' },
  { id: 'x', parent_id: 'root', name: 'Photos' },
];

check('the top is zero deep and everything else counts from it', () => {
  assert.strictEqual(folders.depthOf(TREE, 'root'), 0);
  assert.strictEqual(folders.depthOf(TREE, 'a'), 1);
  assert.strictEqual(folders.depthOf(TREE, 'c'), 3);
});

// A file whose folder was deleted has to appear somewhere, and the top is where
// somebody will look for it. Reading it as an error instead would mean a listing
// that throws rather than a file that is merely somewhere else.
check('a folder nobody has heard of reads as the top rather than as an error', () => {
  assert.strictEqual(folders.depthOf(TREE, 'gone'), 0);
  assert.deepStrictEqual(folders.pathTo(TREE, 'gone'), []);
});

check('a loop is refused rather than walked forever', () => {
  const loop = [{ id: 'p', parent_id: 'q', name: 'P' }, { id: 'q', parent_id: 'p', name: 'Q' }];
  assert.ok(folders.depthOf(loop, 'p') > folders.MAX_DEPTH);
  assert.strictEqual(folders.isInside(loop, 'zz', 'p'), false);
});

// The one that matters: without it, a folder dragged into its own child takes
// everything under it out of the tree, where nothing can reach it.
check('a folder is inside its own descendants, and not inside its siblings', () => {
  assert.strictEqual(folders.isInside(TREE, 'a', 'c'), true);
  assert.strictEqual(folders.isInside(TREE, 'a', 'b'), true);
  assert.strictEqual(folders.isInside(TREE, 'a', 'x'), false);
  assert.strictEqual(folders.isInside(TREE, 'a', 'root'), false);
});

check('a path reads from the top down', () => {
  assert.deepStrictEqual(folders.pathTo(TREE, 'c').map(f => f.name), ['Invoices', '2026', 'March']);
  assert.deepStrictEqual(folders.pathTo(TREE, 'root'), []);
});

check('a name is tidied, and the ones that are not names are refused', () => {
  assert.strictEqual(folders.cleanName('  Invoices   2026 ').name, 'Invoices 2026');
  assert.strictEqual(folders.cleanName('').ok, false);
  assert.strictEqual(folders.cleanName('   ').ok, false);
  assert.strictEqual(folders.cleanName('..').ok, false);
  assert.strictEqual(folders.cleanName('a'.repeat(folders.MAX_NAME + 1)).ok, false);
});

// A name that looks like a path is a name somebody will eventually treat as one,
// and the code that treats it as one will be somewhere else entirely.
check('a slash is not part of a name, in either direction', () => {
  assert.strictEqual(folders.cleanName('Invoices/2026').ok, false);
  assert.strictEqual(folders.cleanName('Invoices\\2026').ok, false);
});

check('a name made of control characters is refused', () => {
  assert.strictEqual(folders.cleanName(`bad${String.fromCharCode(7)}name`).ok, false);
});

console.log(`\n${passed} checks passed`);
