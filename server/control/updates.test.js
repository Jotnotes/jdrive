'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { createUpdateService } = require('./updates');
const auth = require('../tools/release-auth');
const verifier = require('../tools/verify-release');

let checks = 0;
const ok = async (name, fn) => { await fn(); checks += 1; console.log(`ok  ${name}`); };
const pair = crypto.generateKeyPairSync('ed25519');
const publicKey = pair.publicKey.export({ type: 'spki', format: 'pem' });
const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });

// Generate fixtures against an injected verifier by loading the service with a
// public key option; this option is explicit and never supplied by server.js.
const make = ({ notice, signature = true, requests = [], logs = [] }) => {
  const bytes = Buffer.from(`${JSON.stringify(notice)}\n`);
  const fetch = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('.sig')) {
      if (signature === false) return Promise.reject(new Error('HTTP 404'));
      return signature === 'bad' ? Buffer.from('not a signature') : Buffer.from(`${auth.sign(bytes, privateKey)}\n`);
    }
    return bytes;
  };
  return createUpdateService({ version: '0.1.0', url: 'https://updates.example/latest.json', fetch,
    publicKey, now: () => new Date('2026-10-02T12:00:00Z'), log: message => logs.push(message) });
};

(async () => {
  await ok('the standalone verifier and the box use one public key', () => {
    assert.strictEqual(auth.PUBLIC_KEY, verifier.PUBLIC_KEY);
  });

  await ok('an unsigned update file is ignored and logged once', async () => {
    const logs = [];
    const service = make({ notice: { version: '0.1.1', published: '2026-10-01', security: false,
      notes: 'https://jdrive.jotnotes.com/releases/notes', sha256: 'd'.repeat(64) }, signature: false, logs });
    const out = await service.check({ force: true });
    assert.strictEqual(out.available, false);
    assert.strictEqual(logs.length, 1);
  });

  await ok('a signed newer version is accepted', async () => {
    const notice = { version: '0.1.1', published: '2026-10-01', security: true,
      notes: 'https://jdrive.jotnotes.com/releases/0.1.1', sha256: 'a'.repeat(64) };
    const service = make({ notice });
    const out = await service.check({ force: true });
    assert.deepStrictEqual(out, { available: true, version: '0.1.1', security: true,
      notes: notice.notes, checked_at: '2026-10-02T12:00:00.000Z' });
  });

  await ok('a badly signed newer version is ignored', async () => {
    const notice = { version: '0.1.1', published: '2026-10-01', security: false,
      notes: 'https://jdrive.jotnotes.com/releases/notes', sha256: 'e'.repeat(64) };
    assert.strictEqual((await make({ notice, signature: 'bad' }).check({ force: true })).available, false);
  });

  await ok('older and equal versions are ignored', async () => {
    for (const version of ['0.1.0', '0.0.9']) {
      const notice = { version, published: '2026-10-01', security: false,
        notes: 'https://jdrive.jotnotes.com/releases/notes', sha256: 'b'.repeat(64) };
      assert.strictEqual((await make({ notice }).check({ force: true })).available, false);
    }
  });

  await ok('requests identify only the JDrive version', async () => {
    const requests = [];
    const notice = { version: '0.1.1', published: '2026-10-01', security: false,
      notes: 'https://jdrive.jotnotes.com/releases/notes', sha256: 'c'.repeat(64) };
    await make({ notice, requests }).check({ force: true });
    assert.strictEqual(requests.length, 2);
    for (const request of requests) assert.deepStrictEqual(request.options, { headers: { 'User-Agent': 'JDrive/0.1.0' } });
  });

  await ok('the off setting makes no request', async () => {
    let requests = 0;
    const service = createUpdateService({ version: '0.1.0', url: 'off', fetch: async () => { requests += 1; } });
    assert.deepStrictEqual(await service.check({ force: true }), {
      available: false, version: null, security: false, notes: null, checked_at: null,
    });
    assert.strictEqual(requests, 0);
  });

  await ok('a successful check is not repeated during the same day', async () => {
    const requests = [];
    const notice = { version: '0.1.1', published: '2026-10-01', security: false,
      notes: 'https://jdrive.jotnotes.com/releases/notes', sha256: 'f'.repeat(64) };
    const service = make({ notice, requests });
    await service.check();
    await service.check();
    assert.strictEqual(requests.length, 2);
  });

  console.log(`\n${checks} checks passed`);
})().catch(error => { console.error(error); process.exitCode = 1; });
