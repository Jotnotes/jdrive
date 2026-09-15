'use strict';

// Which edition a box starts as. See edition.js.
//
// Run from a scratch copy, because the three answers depend on what is on disk
// beside edition.js and this repository always has the Hosting edition in it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`ok  ${name}`); };

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jdrive-edition-'));
const copy = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'edition.js'), path.join(dir, 'edition.js'));
  return dir;
};

try {
  check('with no hoster folder the box is Community', () => {
    const dir = copy(path.join(scratch, 'community'));
    assert.strictEqual(require(path.join(dir, 'edition.js')).load(), null);
  });

  check('with a hoster folder the box is Hosting', () => {
    const dir = copy(path.join(scratch, 'hosting'));
    fs.mkdirSync(path.join(dir, 'hoster'));
    fs.writeFileSync(path.join(dir, 'hoster', 'index.js'), "module.exports = { register: () => ({ name: 'test' }) };");
    const loaded = require(path.join(dir, 'edition.js')).load();
    assert.ok(loaded && typeof loaded.register === 'function');
  });

  check('a hoster folder missing a file of its own refuses to start rather than starting as Community', () => {
    const dir = copy(path.join(scratch, 'broken'));
    fs.mkdirSync(path.join(dir, 'hoster'));
    fs.writeFileSync(path.join(dir, 'hoster', 'index.js'), "require('./licence');");
    assert.throws(() => require(path.join(dir, 'edition.js')).load(), /Cannot find module '\.\/licence'/);
  });

  check('a hoster folder that does not parse refuses to start', () => {
    const dir = copy(path.join(scratch, 'unparsed'));
    fs.mkdirSync(path.join(dir, 'hoster'));
    fs.writeFileSync(path.join(dir, 'hoster', 'index.js'), 'module.exports = {');
    assert.throws(() => require(path.join(dir, 'edition.js')).load(), SyntaxError);
  });
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log(`\n${passed} checks passed`);
