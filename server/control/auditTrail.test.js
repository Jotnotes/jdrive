'use strict';

// Who may read what out of the audit log. Short, because the rule is short — but
// the direction of the rule is the whole point, so that is what is tested.

const assert = require('assert');
const trail = require('./auditTrail');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

check('a hosting company sees what happened to the account', () => {
  for (const action of ['account_created', 'account_suspended', 'account_restored',
    'package_assigned', 'login', 'login_failed', 'password_reset_sent', 'verification_sent']) {
    assert.strictEqual(trail.isAccountLevel(action), true, action);
  }
});

// The details column carries filenames — "holiday.jpg is now trip.jpg" — so
// these are not a category, they are a disclosure.
check('and never what the customer did with their files', () => {
  for (const action of ['upload', 'trashed', 'restored', 'file_renamed', 'file_replaced',
    'file_filed', 'file_tagged', 'file_made_public', 'file_made_private',
    'folder_created', 'folder_renamed', 'folder_moved',
    'share_created', 'shares_revoked', 'version_restored']) {
    assert.strictEqual(trail.isAccountLevel(action), false, action);
  }
});

// The reason this is an allowlist. A file action invented next year is private
// because nobody added it, rather than exposed because nobody excluded it.
check('an action nobody has classified is the customer\'s own', () => {
  assert.strictEqual(trail.isAccountLevel('file_something_invented_next_year'), false);
  assert.strictEqual(trail.isAccountLevel(''), false);
  assert.strictEqual(trail.isAccountLevel(null), false);
  assert.strictEqual(trail.isAccountLevel(undefined), false);
});

check('the machine\'s own events belong to no customer', () => {
  for (const action of ['backup_taken', 'backup_verified', 'backup_failed', 'brand_set',
    'backup_shipped', 'backup_ship_failed']) {
    assert.strictEqual(trail.isMachineLevel(action), true, action);
    assert.strictEqual(trail.isAccountLevel(action), false, action);
  }
});

console.log(`\n${passed} checks passed`);
