// What this box is, said once.
//
// A hosting company who cannot name their build cannot be supported, and this
// product has a migration runner, so "which schema is this box on" is a real
// support question rather than a curiosity. Three facts answer both: the
// version, the commit it was cut from, and where the database sits against the
// migrations this build knows.
//
// **One source, not three.** The version is `server/package.json` and nothing
// else. `server/tools/release.sh` already refuses to cut an archive when
// `web/package.json` disagrees, so the two cannot drift without the release
// failing first — which is the right place for that argument to happen.
//
// The commit cannot come from git. The archive excludes `.git` because the box
// builds from source and has no business carrying our history, so an installed
// box has no repository to ask. `release.sh` writes `build.json` beside this
// file instead, and a tree without one is a development tree and says so.
// Guessing "unknown" would be worse than saying `development`: one is a fact,
// the other is a shrug that looks like a fault.

const fs = require('fs');
const path = require('path');

const VERSION = require('../package.json').version;

function readStamp() {
  try {
    // Beside this file in a working tree (server/control/../build.json), and beside
    // the one compiled file in a release, where this module has been folded into
    // server/server.js and __dirname is server/ itself.
    const candidates = [path.join(__dirname, '..', 'build.json'), path.join(__dirname, 'build.json')];
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (!found) return { commit: null, built: null };
    const raw = fs.readFileSync(found, 'utf8');
    const stamp = JSON.parse(raw);
    return {
      commit: typeof stamp.commit === 'string' && stamp.commit ? stamp.commit : null,
      built: typeof stamp.built === 'string' && stamp.built ? stamp.built : null,
    };
  } catch {
    // No stamp is the ordinary case in a working tree, not an error.
    return { commit: null, built: null };
  }
}

// `schema` is passed in rather than read here, because the database belongs to
// the caller and this module opening its own would be a second connection to
// the one file the whole box serialises on.
function describe(schema = null) {
  const stamp = readStamp();
  return {
    product: 'JotNotes JDrive',
    version: VERSION,
    commit: stamp.commit,
    built: stamp.built,
    // A tree with no stamp is somebody's laptop. Said plainly so a screenshot
    // from a developer is never mistaken for a screenshot from a customer.
    channel: stamp.commit ? 'release' : 'development',
    schema: schema ? { version: schema.version, known: schema.known, pending: schema.pending.length } : null,
  };
}

// The one line the operator reads in `journalctl`, and the one a hoster is asked
// to paste into a support ticket. Same string in both places on purpose: two
// spellings of the same fact is how a support conversation gets confusing.
function line(schema = null) {
  const b = describe(schema);
  const build = b.commit ? `${b.version} (${b.commit.slice(0, 7)})` : `${b.version} (development)`;
  const s = b.schema ? `, schema ${b.schema.version} of ${b.schema.known}` : '';
  return `${b.product} ${build}${s}`;
}

module.exports = { describe, line, VERSION };
