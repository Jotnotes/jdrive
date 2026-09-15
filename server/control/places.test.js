'use strict';

// The four places, driven over HTTP against a real server on a real database.
//
// The unit tests next door prove the rules. This proves the product: that a file
// somebody uploads is private, that making it public gives it an address a
// stranger can open, that taking it back kills that address, and that no account
// can reach another's anything.
//
// It runs the actual `server.js` rather than a test double, because every bug
// worth catching here has lived in the wiring rather than in the rules.

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jdrive-'));
process.env.JWT_SECRET = 'a-test-secret-that-is-not-a-real-one';
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.PUBLIC_BASE_URL = '';

const { app, db, ownership, entitlements } = require('../server');

let passed = 0;
const ok = (name, condition, extra = '') => {
  assert.ok(condition, `${name}${extra ? ` — ${extra}` : ''}`);
  passed++; console.log(`ok  ${name}${extra ? ` — ${extra}` : ''}`);
};

let base;
function request(method, url, { body = null, token = null, multipart = null } = {}) {
  return new Promise(resolve => {
    const target = new URL(url.startsWith('http') ? url : base + url);
    let payload = null;
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (multipart) {
      const boundary = '----jdrive' + Math.random().toString(36).slice(2);
      payload = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${multipart.name}"\r\n`
        + `Content-Type: ${multipart.type}\r\n\r\n${multipart.content}\r\n--${boundary}--\r\n`);
      headers['Content-Type'] = `multipart/form-data; boundary=${boundary}`;
      headers['Content-Length'] = payload.length;
    } else if (body) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = http.request({ hostname: target.hostname, port: target.port, path: target.pathname + target.search, method, headers },
      response => {
        const chunks = [];
        response.on('data', c => chunks.push(c));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let json = null; try { json = JSON.parse(text); } catch { /* not json, fine */ }
          resolve({ status: response.statusCode, body: json, text, headers: response.headers });
        });
      });
    req.on('error', error => resolve({ status: 0, text: error.message }));
    if (payload) req.write(payload);
    req.end();
  });
}

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // The hosting company, made the way the installer makes it, then two customers
  // made the way the hosting company makes them.
  const bcrypt = require('bcryptjs');
  const mk = (name, email) => {
    const id = require('crypto').randomBytes(8).toString('hex');
    // Confirmed on the way in. These stand for accounts that were sold and
    // confirmed some time ago; the confirmation flow itself is proved end to end
    // in the release audit, which follows the real link out of a real message.
    db.prepare("INSERT INTO users (id,name,email,password,verified_at) VALUES (?,?,?,?,datetime('now'))")
      .run(id, name, email, bcrypt.hashSync('a-long-enough-password', 4));
    ownership.ensureMembership(id);
    return id;
  };
  const hosterId = mk('Hoster', 'hoster@example.com');
  const rootOrg = ownership.getMembership(hosterId).orgId;
  entitlements.markRoot(rootOrg, 'test');
  const aliceId = mk('Alice', 'alice@example.com');
  const bobId = mk('Bob', 'bob@example.com');

  const signIn = async email => (await request('POST', '/api/login',
    { body: { email, password: 'a-long-enough-password' } })).body.token;
  const alice = await signIn('alice@example.com');
  const bob = await signIn('bob@example.com');
  ok('two customers sign in', !!alice && !!bob);

  const wrong = await request('POST', '/api/login', { body: { email: 'alice@example.com', password: 'not-the-password' } });
  ok('a wrong password is refused', wrong.status === 401, `HTTP ${wrong.status}`);

  // ── Everything lands private ──────────────────────────────────────────────

  const up = await request('POST', '/api/files',
    { token: alice, multipart: { name: 'holiday.txt', type: 'text/plain', content: 'ALICE PRIVATE' } });
  const file = up.body && up.body[0];
  ok('an upload lands in My Files', file && file.place === 'private', file && file.place);
  ok('and it has no address', file && file.public_url === null);
  ok('and nothing on the internet can reach it', file && file.reach.internet === false);

  const bobUp = await request('POST', '/api/files',
    { token: bob, multipart: { name: 'bob.txt', type: 'text/plain', content: 'BOB PRIVATE' } });
  const bobFile = bobUp.body[0];

  // ── One account cannot touch another's ────────────────────────────────────

  for (const [what, call] of [
    ['see', () => request('GET', '/api/files', { token: bob })],
    ['make public', () => request('POST', `/api/files/${file.id}/public`, { token: bob })],
    ['download', () => request('GET', `/api/files/${file.id}/download`, { token: bob })],
    ['delete', () => request('DELETE', `/api/files/${file.id}`, { token: bob })],
  ]) {
    const r = await call();
    const refused = what === 'see'
      ? Array.isArray(r.body) && r.body.length === 1 && r.body[0].id === bobFile.id
      : r.status === 404;
    ok(`Bob cannot ${what} Alice's file`, refused, what === 'see' ? `${r.body.length} rows` : `HTTP ${r.status}`);
  }

  // The one that matters most: knowing the exact address of a private file is
  // not a way to read it.
  const guessed = await request('GET', `/p/${aliceId}/${file.id}/holiday.txt`);
  ok("a private file is not served even at its exact address", guessed.status === 404, `HTTP ${guessed.status}`);

  // ── Public, and back ──────────────────────────────────────────────────────

  const made = await request('POST', `/api/files/${file.id}/public`, { token: alice });
  ok('Alice can make her own file public', made.status === 200, `HTTP ${made.status} ${(made.body && made.body.error) || ''}`);
  const address = made.body.file.public_url;
  ok('and it comes back with an address', !!address, address);

  const fetched = await request('GET', address);
  ok('a stranger with no credentials can open it', fetched.status === 200 && fetched.text === 'ALICE PRIVATE', `HTTP ${fetched.status}`);
  ok('and it is served with script and origin switched off',
    /default-src 'none'/.test(fetched.headers['content-security-policy'] || ''),
    fetched.headers['content-security-policy']);
  ok('and the browser is told not to guess its type',
    fetched.headers['x-content-type-options'] === 'nosniff');

  const wrongOwner = await request('GET', `/p/${bobId}/${file.id}/holiday.txt`);
  ok("it is not reachable under another account's id", wrongOwner.status === 404, `HTTP ${wrongOwner.status}`);

  const refusedTrash = await request('DELETE', `/api/files/${file.id}`, { token: alice });
  ok('a public file refuses the Trash and says the order', refusedTrash.status === 409,
    (refusedTrash.body && refusedTrash.body.error || '').slice(0, 48));

  const back = await request('POST', `/api/files/${file.id}/private`, { token: alice });
  ok('it can be made private again', back.status === 200);
  const dead = await request('GET', address);
  ok('and the address stops working immediately', dead.status === 404, `HTTP ${dead.status}`);

  // ── Trash ─────────────────────────────────────────────────────────────────

  const trashed = await request('DELETE', `/api/files/${file.id}`, { token: alice });
  ok('deleting puts it in the Trash and removes nothing', trashed.body.file.place === 'trash');
  const inTrash = await request('GET', '/api/files?place=trash', { token: alice });
  ok('and the Trash lists it', inTrash.body.length === 1);
  const restored = await request('POST', `/api/files/${file.id}/restore`, { token: alice });
  ok('restoring takes it back out', restored.body.file.place === 'private');

  await request('DELETE', `/api/files/${file.id}`, { token: alice });
  const emptied = await request('POST', '/api/files/trash/empty', { token: alice });
  ok('emptying the Trash removes it for real', emptied.body.removed === 1, `removed ${emptied.body.removed}`);
  const gone = await request('GET', '/api/files', { token: alice });
  ok('and it is gone from the listing', gone.body.length === 0);

  const bobStill = await request('GET', '/api/files', { token: bob });
  ok("and Bob's file is untouched by Alice emptying hers", bobStill.body.length === 1);

  // ── Accounts are sold, not signed up for ──────────────────────────────────

  const customerMaking = await request('POST', '/api/accounts',
    { token: alice, body: { name: 'Sneaky', email: 'sneaky@example.com', password: 'a-long-enough-password' } });
  ok('a customer cannot create accounts', customerMaking.status === 403, `HTTP ${customerMaking.status}`);

  const hoster = await signIn('hoster@example.com');
  const hosterMaking = await request('POST', '/api/accounts',
    { token: hoster, body: { name: 'Real', email: 'real@example.com', password: 'a-long-enough-password' } });
  ok('the hosting company can', hosterMaking.status === 200, `HTTP ${hosterMaking.status} ${(hosterMaking.body && hosterMaking.body.error) || ''}`);

  const shortPassword = await request('POST', '/api/accounts',
    { token: hoster, body: { name: 'Weak', email: 'weak@example.com', password: 'short' } });
  ok('and a weak password is refused even from them', shortPassword.status === 400);

  // ── Features are on unless a hoster charges for them ──────────────────────

  const workspaceFiles = require('./workspaceFiles');
  ok('making files public is on by default, because no hoster has priced it',
    entitlements.effectiveEntitlement(ownership.getMembership(aliceId).orgId,
      workspaceFiles.ENTITLEMENTS.makePublic).maxUnlimited === true);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch(error => {
  console.error(error);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
