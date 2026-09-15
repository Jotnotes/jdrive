'use strict';

// Putting a backup back. Run on the box, with the server stopped.
//
//   npm run restore -- --list
//   npm run restore -- --verify <backup id>
//   npm run restore -- --from <backup id> [--force]
//
// There is no HTTP route for this on purpose. It overwrites every customer's
// files, and an operation that does that from a stolen token is worse than the
// outage it would shorten.
//
// It refuses to restore over a live installation unless told twice, it refuses a
// backup that does not verify, and what it displaces is renamed aside rather
// than deleted — during a recovery the old copy is usually the thing somebody is
// trying to save.

const path = require('path');
const fs = require('fs');

const backup = require('../control/backup');

const SERVER = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(SERVER, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(SERVER, 'uploads');
const BACKUPS_DIR = process.env.BACKUPS_DIR || path.join(SERVER, 'backups');

const args = process.argv.slice(2);
const flag = name => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const value = args[i + 1];
  return value && !value.startsWith('--') ? value : true;
};

function directoryFor(id) {
  const known = backup.list({ from: BACKUPS_DIR }).find(b => b.id === id || b.directory === id);
  if (!known) {
    console.error(`No backup here with id ${id}. Run with --list to see what there is.`);
    process.exit(2);
  }
  return path.join(BACKUPS_DIR, known.directory);
}

function human(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(n) || 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

(async () => {
  if (flag('list') || !args.length) {
    const all = backup.list({ from: BACKUPS_DIR });
    if (!all.length) {
      console.log(`No backups in ${BACKUPS_DIR}.`);
      console.log('Take one from the product as the box operator: POST /api/backups');
      process.exit(0);
    }
    console.log(`Backups in ${BACKUPS_DIR}:\n`);
    for (const b of all) {
      const c = b.counts || {};
      console.log(`  ${b.id}  ${b.created_at}  ${String(b.status).toUpperCase()}`);
      console.log(`      ${c.users || 0} account(s), ${c.files_copied || 0} file(s), ${human(c.bytes)}${b.label ? `  "${b.label}"` : ''}`);
      if (c.problems) console.log(`      ${c.problems} problem(s) recorded when it was taken`);
    }
    // Said as the command that works on an installed box. `npm run restore` from
    // the code directory has no environment file, so it looks for backups beside
    // the code, finds none, and says so — proved on a fresh Ubuntu 24.04 install,
    // where these two lines were the first thing an operator mid-recovery would copy.
    const again = process.env.DATA_DIR
      ? 'sudo -u jdrive node --env-file=/etc/jdrive/jdrive.env tools/restore.js'
      : 'npm run restore --';
    console.log(`\n  ${again} --verify <id>          read it back and check every hash`);
    console.log(`  ${again} --from <id> --force   put it back, with the server stopped`);
    process.exit(0);
  }

  const verify = flag('verify');
  if (verify && verify !== true) {
    const found = backup.inspect({ from: directoryFor(verify) });
    console.log(found.ok
      ? `Intact. ${found.checked} file(s) read back and every hash matched, and the manifest matches its seal.`
      : `NOT INTACT:\n  ${found.problems.join('\n  ')}`);
    process.exit(found.ok ? 0 : 1);
  }

  const from = flag('from');
  if (!from || from === true) {
    console.error('Say which backup: --from <id>');
    process.exit(2);
  }

  const source = directoryFor(from);
  const live = fs.existsSync(path.join(DATA_DIR, backup.DB_FILE));
  const force = !!flag('force');
  if (live && !force) {
    console.error(`There is already a database at ${path.join(DATA_DIR, backup.DB_FILE)}.`);
    console.error('Stop the server, then run again with --force if you mean to restore over it.');
    console.error('What is there now will be renamed aside, not deleted.');
    process.exit(2);
  }

  try {
    const done = await backup.restore({ from: source, dataDir: DATA_DIR, uploadsDir: UPLOADS_DIR, force });
    console.log(`Restored backup ${done.backup_id}.`);
    console.log(`  ${done.users} account(s), ${done.file_rows} file row(s), ${done.files_on_disk} file(s) on disk, ${human(done.bytes)}`);
    console.log(`  ${done.verified} file(s) verified by hash before writing, and again after.`);
    console.log(`  ${done.sessions_cleared} session(s) cleared: everybody signs in again, which is deliberate.`);
    for (const d of done.displaced) console.log(`  What was there is at ${d}`);
    console.log('\nStart the server, sign in, and reconcile storage before you tell anybody it is over:');
    console.log('  GET /api/accounts/<id>/storage/reconcile');
    process.exit(0);
  } catch (error) {
    console.error(`Restore refused: ${error.message}`);
    if (error.staging) console.error(`Nothing was moved into place. The partial work is at ${error.staging.data} and ${error.staging.uploads}.`);
    process.exit(1);
  }
})();
