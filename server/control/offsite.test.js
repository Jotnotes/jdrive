'use strict';

// The offsite target, in the parts that can be proved without a bucket.
//
// The signing is checked against AWS's own published test vectors rather than
// against itself. That distinction is the whole value of this file: a signature
// function tested by asking it what it thinks the signature is will agree with
// itself for ever, including on the day it is wrong. Two vectors are used, and
// they are independent of each other — one covers the entire chain end to end,
// the other covers only the key derivation buried in the middle of it.
//
// What is *not* here is the round trip, because that needs an endpoint. It is in
// the release audit, against a real object store on the loopback, and the honest
// limit of even that is written down beside it.

const assert = require('assert');
const crypto = require('crypto');
const offsite = require('./offsite');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

const EMPTY = crypto.createHash('sha256').update('').digest('hex');

// aws-sig-v4-test-suite, `get-vanilla`. AKIDEXAMPLE and its secret are AWS's own
// published non-credentials, used in their documentation for exactly this.
check('the signature matches the published AWS test vector, end to end', () => {
  const signed = offsite.signRequest({
    method: 'GET',
    host: 'example.amazonaws.com',
    pathname: '/',
    query: '',
    payloadHash: EMPTY,
    at: new Date('2015-08-30T12:36:00Z'),
    region: 'us-east-1',
    service: 'service',
    accessKey: 'AKIDEXAMPLE',
    secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  });
  assert.strictEqual(signed.canonicalRequest,
    `GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\n${EMPTY}`);
  assert.strictEqual(signed.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, '
    + 'SignedHeaders=host;x-amz-date, '
    + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
});

// The derivation example from the AWS documentation, on a different date, a
// different service and a different scope from the one above. It reaches the
// four nested HMACs without going through the canonical request at all, so an
// error in the canonicalisation cannot hide an error in the key or the reverse.
check('the signing key derivation matches the published AWS example', () => {
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
  const derived = hmac(hmac(hmac(hmac('AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215'), 'us-east-1'), 'iam'), 'aws4_request');
  assert.strictEqual(derived.toString('hex'), 'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
  // And the module derives the same one, reached through the only door it has.
  const signed = offsite.signRequest({
    method: 'GET', host: 'iam.amazonaws.com', pathname: '/', payloadHash: EMPTY,
    at: new Date('2012-02-15T00:00:00Z'), region: 'us-east-1', service: 'iam',
    accessKey: 'AKIDEXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  });
  const expected = crypto.createHmac('sha256', derived).update(signed.stringToSign, 'utf8').digest('hex');
  assert.strictEqual(signed.signature, expected);
});

// `encodeURIComponent` leaves these five alone and AWS does not. A path
// containing one would be signed one way and sent another, and the endpoint
// would answer `SignatureDoesNotMatch` with nothing in it about the cause.
check('the path encoding is RFC 3986 and not encodeURIComponent', () => {
  assert.strictEqual(offsite.uriEncode("!'()*", false), '%21%27%28%29%2A');
  assert.strictEqual(offsite.uriEncode('AZaz09-_.~', false), 'AZaz09-_.~');
  assert.strictEqual(offsite.uriEncode('a/b', true), 'a/b');
  assert.strictEqual(offsite.uriEncode('a/b', false), 'a%2Fb');
  assert.strictEqual(offsite.uriEncode(' ', false), '%20');
  // Multi-byte, per byte and in upper case.
  assert.strictEqual(offsite.uriEncode('é', false), '%C3%A9');
});

const configured = (over = {}) => offsite.createOffsite({
  log: { log() {}, warn() {} },
  env: {
    OFFSITE_S3_ENDPOINT: 'https://s3.example.com',
    OFFSITE_S3_BUCKET: 'jdrive-backups',
    OFFSITE_S3_REGION: 'eu-west-2',
    OFFSITE_S3_KEY: 'AKIDEXAMPLE',
    OFFSITE_S3_SECRET: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    ...over,
  },
});

check('a box with nothing configured has no target, and says which setting is missing', () => {
  const none = offsite.createOffsite({ env: {}, log: { log() {}, warn() {} } });
  assert.strictEqual(none.mode, 'off');
  for (const name of ['OFFSITE_S3_ENDPOINT', 'OFFSITE_S3_BUCKET', 'OFFSITE_S3_KEY', 'OFFSITE_S3_SECRET']) {
    assert.ok(none.why.includes(name), `${name} is not named in: ${none.why}`);
  }
});

// Four settings out of five is the dangerous state: an operator who believes
// their backups are leaving the box and whose backups are not.
check('a half-configured target is off rather than nearly on', () => {
  const half = configured({ OFFSITE_S3_SECRET: '' });
  assert.strictEqual(half.mode, 'off');
  assert.ok(half.why.includes('OFFSITE_S3_SECRET'));
});

check('the region has a default and the other four do not', () => {
  const target = configured({ OFFSITE_S3_REGION: '' });
  assert.strictEqual(target.mode, 's3');
  assert.strictEqual(target.describe().region, 'us-east-1');
});

// The request carries a signature derived from the secret and the body is every
// private file on the box.
check('plaintext to another machine is refused, and to the loopback is not', () => {
  const remote = configured({ OFFSITE_S3_ENDPOINT: 'http://backups.example.com' });
  assert.strictEqual(remote.mode, 'off');
  assert.ok(/clear|https/i.test(remote.why), remote.why);

  for (const host of ['http://127.0.0.1:9000', 'http://localhost:9000', 'http://[::1]:9000']) {
    assert.strictEqual(configured({ OFFSITE_S3_ENDPOINT: host }).mode, 's3', host);
  }
  // And a name that merely begins like the loopback is not the loopback.
  assert.strictEqual(configured({ OFFSITE_S3_ENDPOINT: 'http://localhost.attacker.example' }).mode, 'off');
  assert.strictEqual(configured({ OFFSITE_S3_ENDPOINT: 'http://127.0.0.1.attacker.example' }).mode, 'off');
});

check('an endpoint with no scheme is assumed to be https, not plaintext', () => {
  const target = configured({ OFFSITE_S3_ENDPOINT: 's3.example.com' });
  assert.strictEqual(target.mode, 's3');
  assert.strictEqual(target.describe().endpoint, 'https://s3.example.com');
});

// The operator may know where their backups go. Nothing may hand back what
// opens the bucket: a route that returned it would put it in a log, a
// screenshot and a support ticket inside a week.
check('what the operator can see never contains the key or the secret', () => {
  const shown = JSON.stringify(configured().describe());
  assert.ok(!shown.includes('AKIDEXAMPLE'), shown);
  assert.ok(!shown.includes('wJalrXUtnFEMI'), shown);
  assert.ok(shown.includes('jdrive-backups'));
  assert.ok(shown.includes('eu-west-2'));
});

// S3 answers `SignatureDoesNotMatch` by quoting the access key back, and some
// endpoints quote the whole string that was signed.
check('an error from the endpoint cannot carry the credential out with it', () => {
  const target = configured();
  const said = target.scrub('SignatureDoesNotMatch for AKIDEXAMPLE using wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY');
  assert.ok(!said.includes('AKIDEXAMPLE'), said);
  assert.ok(!said.includes('wJalrXUtnFEMI'), said);
  assert.ok(said.includes('[redacted]'));
});

check('shipping from a box with no target refuses rather than reporting nothing to do', async () => {
  const none = offsite.createOffsite({ env: {}, log: { log() {}, warn() {} } });
  let refused = null;
  await none.ship({ from: '/nowhere' }).catch(error => { refused = error; });
  assert.ok(refused, 'an unconfigured ship resolved instead of throwing');
  assert.strictEqual(refused.unconfigured, true);
});

// The check above is async and `check` is not, so the process would exit before
// a rejection could be seen. This is the guard for that.
process.on('unhandledRejection', error => { console.error(error); process.exit(1); });

setTimeout(() => console.log(`\n${passed} checks passed`), 50);
