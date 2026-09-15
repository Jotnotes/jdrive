'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const auth = require('./release-auth');
const verifier = require('./verify-release');
const { verifyRelease } = verifier;

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jdrive-release-test-'));
const tarball = path.join(directory, 'jdrive-1.2.3.tgz');
const keys = crypto.generateKeyPairSync('ed25519');
const wrong = crypto.generateKeyPairSync('ed25519');
const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const wrongKey = wrong.publicKey.export({ type: 'spki', format: 'pem' });
const commit = '0123456789abcdef0123456789abcdef01234567';

assert.strictEqual(verifier.PUBLIC_KEY, auth.PUBLIC_KEY, 'standalone and shared release public keys differ');
console.log('ok  the standalone verifier carries the shared public key');

fs.writeFileSync(tarball, 'the release bytes');
const sha = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
const statement = auth.releaseStatement(path.basename(tarball), sha, commit);
fs.writeFileSync(`${tarball}.sig.txt`, statement);
fs.writeFileSync(`${tarball}.sig`, `${auth.sign(statement, privateKey)}\n`);

assert.strictEqual(verifyRelease(tarball, publicKey), true, 'a signed tarball did not verify');
console.log('ok  a signature over a tarball verifies');

fs.appendFileSync(tarball, 'changed');
assert.strictEqual(verifyRelease(tarball, publicKey), false, 'changed release bytes verified');
console.log('ok  a changed byte fails verification');
fs.writeFileSync(tarball, 'the release bytes');

assert.strictEqual(verifyRelease(tarball, wrongKey), false, 'a signature verified with the wrong key');
console.log('ok  the wrong key fails verification');

fs.rmSync(directory, { recursive: true, force: true });
console.log('\n4 checks passed');
