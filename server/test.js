'use strict';

// Every unit test under server/, found rather than listed.
//
//   npm test
//
// Found, because the two editions have different tests: JDrive Community does not
// have the Hosting edition's folder, so a list naming that edition's tests would
// fail there on a file that is correctly absent. The count is printed so a test that stops being
// found is a number that went down, not a silence.
//
// The release audit is not a unit test and is not run here: `npm run audit`.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SKIP = new Set(['node_modules', 'audit', 'data', 'uploads', 'backups', 'archives']);

function find(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP.has(entry.name) && !entry.name.startsWith('.')) found.push(...find(path.join(dir, entry.name)));
    } else if (entry.name.endsWith('.test.js')) {
      found.push(path.join(dir, entry.name));
    }
  }
  return found;
}

const suites = find(__dirname).map(file => path.relative(__dirname, file)).sort();

for (const suite of suites) {
  console.log(`\n── ${suite}`);
  const run = spawnSync(process.execPath, [suite], { cwd: __dirname, stdio: 'inherit' });
  if (run.status !== 0) {
    console.error(`\n${suite} failed. ${suites.indexOf(suite)} of ${suites.length} suites passed before it.`);
    process.exit(run.status || 1);
  }
}

console.log(`\n${suites.length} suites passed`);
