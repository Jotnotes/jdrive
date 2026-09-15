'use strict';

// What counts as a tag. Short, because the rule is short: what a tag does to a
// file is proved over HTTP in the release audit.

const assert = require('assert');
const tags = require('./tags');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

check('a tag is tidied rather than taken literally', () => {
  assert.strictEqual(tags.cleanTagName('  client   work ').name, 'client work');
  assert.strictEqual(tags.cleanTagName('Invoices').name, 'Invoices');
});

check('nothing, and too much, are both refused', () => {
  assert.strictEqual(tags.cleanTagName('').ok, false);
  assert.strictEqual(tags.cleanTagName('   ').ok, false);
  assert.strictEqual(tags.cleanTagName(null).ok, false);
  assert.strictEqual(tags.cleanTagName('x'.repeat(tags.MAX_NAME + 1)).ok, false);
});

// A list of tags is written with commas in every place a person will see one,
// so a tag with a comma in it becomes two tags the first time it is pasted.
check('a comma is not part of a tag', () => {
  assert.strictEqual(tags.cleanTagName('urgent, client').ok, false);
});

check('a tag made of control characters is refused', () => {
  assert.strictEqual(tags.cleanTagName(`bad${String.fromCharCode(7)}tag`).ok, false);
});

console.log(`\n${passed} checks passed`);
