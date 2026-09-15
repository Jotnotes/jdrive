'use strict';

// Which edition this box is running. See docs/EDITIONS.md.
//
// JDrive Community is everything under server/ except server/hoster/. JDrive for
// Hosting is the same, with that folder present. So the edition is decided by what
// is on disk and by nothing else: there is no setting, no environment variable and
// nothing a request can say, which means there is nothing to flip.
//
// Returns the Hosting edition's module, or null on a Community box.
//
// Only a missing `./hoster` means Community. Anything else that goes wrong while
// loading it — a file inside it that is missing, a syntax error — is thrown, because
// a paid box that quietly starts as Community has lost its licence, its resellers
// and its brand without anybody being told why.
function load() {
  try {
    return require('./hoster');
  } catch (error) {
    const first = String(error && error.message || '').split('\n')[0];
    if (error && error.code === 'MODULE_NOT_FOUND' && first === "Cannot find module './hoster'") return null;
    throw error;
  }
}

module.exports = { load };
