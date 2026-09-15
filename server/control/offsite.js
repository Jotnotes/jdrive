'use strict';

// Getting the backup artifact off the box.
//
// THE CONTRACT IS STILL RESTORE, NOT COPY
//
// `control/backup.js` opens by saying that a command which copies files is not a
// backup, and that nothing there reports success for a copy it has not read
// back. Shipping is the same rule pointed at a network instead of a disk, and it
// is the easier place to break it: a PUT that answers `200 OK` has proved that
// something accepted a request, which is not the same as an object existing, and
// is a very long way from the object being the bytes we sent. Proxies truncate,
// endpoints silently drop what they consider a duplicate, a bucket policy
// rewrites storage class and mangles the body, a half-written multipart lands as
// a short object with a cheerful status.
//
// So a ship is not finished when the upload returns. Every object is read back
// out of the bucket over the wire, hashed as it arrives, and compared against
// the hash the manifest already carries for it. Anything that does not match is
// a failed ship, named object by object. There is deliberately no flag to skip
// the read-back: the read-back is the feature, and the upload is the part that
// merely has to happen first.
//
// WHY THE MANIFEST'S HASHES AND NOT FRESH ONES
//
// Hashing the local file again and comparing that to the download would prove
// the round trip and nothing else — both sides could be corrupt in the same way
// and agree. The manifest's hashes were computed when the backup was taken, from
// the bytes as they landed, and the seal protects the manifest from being edited
// afterwards. So the comparison is against the recorded truth rather than
// against whatever is on the disk this morning.
//
// And because that only holds if the local copy still matches its own manifest,
// a ship runs `backup.inspect` first and refuses outright if it does not pass.
// Shipping a backup that has already rotted is worse than not shipping: it
// replaces the operator's doubt with a receipt.
//
// THE CREDENTIALS ARE NOT IN THE DATABASE, DELIBERATELY
//
// Every other configurable thing a hosting company owns — their name, their
// mark, their colour, their plans — lives in the database, because it is theirs
// and it changes without a restart. These do not, and the reason is circular in
// a way that only shows up on the worst day: the backup artifact contains the
// database. Credentials stored there would be copied into every artifact, and
// the artifact would then be a set of working keys to the bucket holding every
// other artifact. One leaked backup would cost the operator all of them.
//
// So the target is configured entirely by environment, it is read once at boot,
// and there is no route that sets it and no route that reads it back. What the
// operator can see is where their backups are going — endpoint, bucket, region,
// prefix — and never what opens the door.
//
// WHY THERE IS NO SDK HERE
//
// SigV4 is a hash, four nested HMACs and a header, and it is written out below.
// The alternative is a transitive dependency tree in a process that holds every
// customer's bytes and every password hash, for an algorithm that has not
// changed since 2012. This codebase already declines that trade for SMTP.
//
// The addressing is path style — `https://endpoint/bucket/key` — because the
// endpoint is a hosting company's own, and every S3-compatible service a hoster
// would actually reach for takes path style. Virtual-host style would mean
// rewriting the host out of the configured endpoint, which is this module
// second-guessing an operator about their own infrastructure.
//
// PLAINTEXT GOES NOWHERE BUT THE LOOPBACK
//
// The request carries a signature derived from the secret, and the body is every
// private byte on the box. Over plain `http` to another machine that is a wire
// anybody on the path can read. It is refused. Loopback is allowed, because a
// sidecar object store on 127.0.0.1 cannot be intercepted off the box, and it is
// how this gets exercised without a real bucket.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
// A single PUT tops out at 5 GiB at every S3-compatible service there is;
// past that the protocol is multipart, which is a different piece of work.
// Refused loudly rather than attempted and failed halfway, because a ship that
// dies at 5 GiB into a 6 GiB database is the failure that looks like a network
// problem for a week.
const MAX_SINGLE_PUT = 5 * 1024 * 1024 * 1024;

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const sha256Hex = data => crypto.createHash('sha256').update(data, 'utf8').digest('hex');

// RFC 3986, which is not what `encodeURIComponent` implements: it leaves `!`,
// `'`, `(`, `)` and `*` alone and AWS does not. A signature computed over a
// differently-encoded path is a signature the endpoint will not agree with, and
// the error it returns says nothing about why.
function uriEncode(value, keepSlashes) {
  let out = '';
  for (const ch of String(value)) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === '/' && keepSlashes) out += ch;
    else for (const byte of Buffer.from(ch, 'utf8')) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

// ── SigV4 ───────────────────────────────────────────────────────────────────

// The whole of the signing, in one function, computed from values that are all
// passed in. Nothing here reads the environment or the clock, so it can be
// checked against AWS's own published test vectors — which is what
// `offsite.test.js` does, and it is the only honest way to know this is right
// without a bucket to try it against.
function signRequest({ method, host, pathname, query = '', payloadHash, at, region, service = SERVICE, accessKey, secretKey, headers = {} }) {
  const amzDate = at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  // `host` and `x-amz-date` are always signed and everything else is the
  // caller's. S3 also requires `x-amz-content-sha256`, and it is passed in
  // rather than added here so that this function signs exactly the headers it
  // is given — which is what makes it checkable against AWS's own test vectors,
  // none of which know anything about S3.
  const all = { ...headers, host, 'x-amz-date': amzDate };
  // Sorted by lowercased name, values trimmed and inner runs of spaces
  // collapsed. The canonical form is canonical because both ends compute it the
  // same way from whatever the other end happened to send.
  const names = Object.keys(all).map(n => n.toLowerCase()).sort();
  const canonicalHeaders = names.map(n => {
    const key = Object.keys(all).find(k => k.toLowerCase() === n);
    return `${n}:${String(all[key]).trim().replace(/\s+/g, ' ')}\n`;
  }).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method,
    uriEncode(pathname, true),
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signing = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signing).update(stringToSign, 'utf8').digest('hex');

  return {
    amzDate,
    signedHeaders,
    canonicalRequest,
    stringToSign,
    signature,
    authorization: `${ALGORITHM} Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// ── The configured target ───────────────────────────────────────────────────

function createOffsite({ env = process.env, now = () => new Date(), log = console } = {}) {
  const endpoint = String(env.OFFSITE_S3_ENDPOINT || '').trim();
  const bucket = String(env.OFFSITE_S3_BUCKET || '').trim();
  const region = String(env.OFFSITE_S3_REGION || '').trim() || 'us-east-1';
  const accessKey = String(env.OFFSITE_S3_KEY || '').trim();
  const secretKey = String(env.OFFSITE_S3_SECRET || '').trim();
  // Somewhere to put them inside the bucket, for an operator who keeps more than
  // one box's backups in one place. Leading and trailing slashes trimmed so the
  // key never comes out with an empty path segment in it.
  const prefix = String(env.OFFSITE_S3_PREFIX || '').trim().replace(/^\/+|\/+$/g, '');

  // Configured means all five of the things that make a request possible. Four
  // out of five is a box whose operator believes their backups are leaving and
  // whose backups are not, so it is `off` and it says which one is missing.
  const missing = [];
  if (!endpoint) missing.push('OFFSITE_S3_ENDPOINT');
  if (!bucket) missing.push('OFFSITE_S3_BUCKET');
  if (!accessKey) missing.push('OFFSITE_S3_KEY');
  if (!secretKey) missing.push('OFFSITE_S3_SECRET');

  let url = null;
  let refusal = null;
  if (!missing.length) {
    try {
      url = new URL(endpoint.includes('://') ? endpoint : `https://${endpoint}`);
    } catch {
      refusal = `OFFSITE_S3_ENDPOINT is not a URL: ${JSON.stringify(endpoint.slice(0, 60))}`;
    }
    if (url && url.protocol !== 'https:' && url.protocol !== 'http:') {
      refusal = `an offsite target has to be http or https, not ${url.protocol}`;
    }
    // The signature and every private byte on the box travel in this request.
    // Over plaintext to anywhere but this machine, that is a wire somebody else
    // is on.
    if (url && url.protocol === 'http:' && !isLoopback(url.hostname)) {
      refusal = `refusing to ship backups in the clear to ${url.hostname}: `
        + 'the request carries the credential and the body is every private file on this box. Use https.';
    }
  }

  const mode = missing.length || refusal ? 'off' : 's3';
  const why = missing.length
    ? `not configured: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`
    : refusal;

  // What an operator may be told. Where their backups go, never what opens it.
  // A route that returned the key would put it in a log, a screenshot and a
  // support ticket within a week.
  const describe = () => ({
    mode,
    endpoint: mode === 's3' ? `${url.protocol}//${url.host}` : null,
    bucket: mode === 's3' ? bucket : null,
    region: mode === 's3' ? region : null,
    prefix: mode === 's3' ? (prefix || null) : null,
    why: mode === 's3' ? null : why,
  });

  // Anything that looks like what we were given, gone — the same rule as the
  // mailer, and needed more here: an S3 endpoint answering `SignatureDoesNotMatch`
  // helpfully echoes the access key and the string it expected us to sign.
  function scrub(text) {
    let out = String(text == null ? '' : text);
    for (const secret of [secretKey, accessKey]) {
      if (secret && secret.length > 3) out = out.split(secret).join('[redacted]');
    }
    return out.slice(0, 300);
  }

  // One signed request. `body` is a file to stream from, or null for a GET.
  // `onData` receives the response body in chunks so the caller can hash a
  // multi-gigabyte object without ever holding it in memory.
  function send({ method, key, payloadHash, file, bytes = 0, onData = null }) {
    return new Promise((resolve, reject) => {
      const pathname = `/${uriEncode(bucket, false)}/${uriEncode(key, true)}`;
      const at = now();
      const signed = signRequest({
        method, host: url.host, pathname, payloadHash, at, region, accessKey, secretKey,
        headers: { 'x-amz-content-sha256': payloadHash },
      });
      const headers = {
        Host: url.host,
        'x-amz-date': signed.amzDate,
        'x-amz-content-sha256': payloadHash,
        Authorization: signed.authorization,
      };
      if (method === 'PUT') {
        headers['Content-Length'] = String(bytes);
        headers['Content-Type'] = 'application/octet-stream';
      }
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        method,
        path: pathname,
        headers,
      }, response => {
        const problem = [];
        response.on('data', chunk => {
          if (onData && response.statusCode >= 200 && response.statusCode < 300) onData(chunk);
          // Only an error body is collected, and only the first part of it. A
          // successful GET of a database is not something to accumulate.
          else if (problem.join('').length < 2000) problem.push(chunk.toString());
        });
        response.on('end', () => resolve({ status: response.statusCode, body: problem.join('') }));
        response.on('error', error => reject(error));
      });
      request.on('error', error => reject(error));
      if (method === 'PUT') {
        const stream = fs.createReadStream(file);
        stream.on('error', error => { request.destroy(); reject(error); });
        stream.pipe(request);
      } else {
        request.end();
      }
    });
  }

  // ── Shipping one backup ───────────────────────────────────────────────────

  // Every object in the backup directory, put and then read back and compared
  // against the hash the manifest carries for it.
  //
  // `expected` for the database and for every file comes straight out of the
  // manifest. The manifest itself is covered by the seal, which is exactly its
  // own sha256 — so the seal is what the manifest is checked against, and the
  // seal, being one line whose entire content is that hash, is checked against
  // itself. Nothing in this list is compared to a hash computed for the occasion.
  function planFrom(dir, manifest, seal, backupModule) {
    const objects = [
      { rel: backupModule.DB_FILE, expected: manifest.database.sha256 },
      { rel: backupModule.MANIFEST, expected: seal },
      { rel: backupModule.SEAL, expected: crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, backupModule.SEAL))).digest('hex') },
    ];
    for (const entry of manifest.entries || []) {
      // Rebuilt from validated components, for the same reason the restore does
      // it: a name out of a manifest that becomes a path is the oldest bug in
      // archive handling, and an object key is a path at the other end too.
      const rel = [
        backupModule.FILES,
        backupModule.safeComponent(entry.user_id, 'account id'),
        backupModule.safeComponent(entry.place, 'place'),
        backupModule.safeComponent(entry.basename, 'file name'),
      ].join('/');
      objects.push({ rel, expected: entry.sha256 });
    }
    return objects;
  }

  async function ship({ from, backup: backupModule = require('./backup') }) {
    if (mode !== 's3') {
      const error = new Error(`there is no offsite target on this box: ${why}`);
      error.unconfigured = true;
      throw error;
    }
    const dir = path.resolve(from);

    // The local copy has to still match its own manifest before its hashes are
    // worth comparing anything to. A backup that has rotted on the disk would
    // otherwise ship, read back byte-perfect, and be reported as verified —
    // a receipt for a copy of the corruption.
    const found = backupModule.inspect({ from: dir });
    if (!found.ok) {
      const error = new Error(`refusing to ship a backup that does not verify here first: ${found.problems.join('; ')}`);
      error.problems = found.problems;
      throw error;
    }
    const manifest = found.manifest;
    const seal = fs.readFileSync(path.join(dir, backupModule.SEAL), 'utf8').trim();
    const objects = planFrom(dir, manifest, seal, backupModule);

    const base = [prefix, path.basename(dir)].filter(Boolean).join('/');
    const problems = [];
    let shipped = 0;
    let verified = 0;
    let bytes = 0;

    for (const object of objects) {
      const local = path.join(dir, object.rel);
      const key = `${base}/${object.rel}`;
      let stat;
      try { stat = fs.statSync(local); } catch {
        problems.push(`${object.rel}: the backup does not contain this file`);
        continue;
      }
      if (stat.size > MAX_SINGLE_PUT) {
        problems.push(`${object.rel}: ${stat.size} bytes is past the ${MAX_SINGLE_PUT}-byte limit of a single upload, `
          + 'and multipart is not implemented, so this backup cannot be shipped whole');
        continue;
      }

      let put;
      try {
        put = await send({ method: 'PUT', key, payloadHash: object.expected, file: local, bytes: stat.size });
      } catch (error) {
        problems.push(`${object.rel}: the upload failed: ${scrub(error && error.message)}`);
        continue;
      }
      if (put.status < 200 || put.status >= 300) {
        problems.push(`${object.rel}: the endpoint refused the upload with HTTP ${put.status}: ${scrub(put.body)}`);
        continue;
      }
      shipped++;
      bytes += stat.size;

      // And now the only part that means anything. Read it back out of the
      // bucket, hash what arrives, and compare it to what the manifest recorded
      // when the backup was taken.
      const back = crypto.createHash('sha256');
      let got;
      try {
        got = await send({ method: 'GET', key, payloadHash: 'UNSIGNED-PAYLOAD', onData: chunk => back.update(chunk) });
      } catch (error) {
        problems.push(`${object.rel}: uploaded, and could not be read back: ${scrub(error && error.message)}`);
        continue;
      }
      if (got.status < 200 || got.status >= 300) {
        problems.push(`${object.rel}: uploaded, and reading it back gave HTTP ${got.status}: ${scrub(got.body)}`);
        continue;
      }
      const returned = back.digest('hex');
      if (returned !== object.expected) {
        problems.push(`${object.rel}: what came back out of the bucket is not what the manifest says it is `
          + `(${object.expected.slice(0, 12)}… recorded, ${returned.slice(0, 12)}… returned)`);
        continue;
      }
      verified++;
    }

    // Every object read back, or it is not a ship. There is no partial success
    // here on purpose: a backup missing one customer's file is not a backup that
    // is mostly fine, it is a restore that will fail in a year with no warning.
    const ok = problems.length === 0 && verified === objects.length;
    return {
      ok,
      backup_id: manifest.run_id,
      key_prefix: base,
      bucket,
      endpoint: `${url.protocol}//${url.host}`,
      objects: objects.length,
      shipped,
      verified,
      bytes,
      problems,
    };
  }

  return {
    mode,
    why,
    describe,
    ship,
    scrub,
    // The same shape the mailer uses: say it at boot, so that finding out is not
    // something somebody has to remember to do.
    warnIfUnconfigured() {
      if (mode === 's3') {
        log.log(`[jdrive] backups can be shipped to ${bucket} at ${url.host}${prefix ? `/${prefix}` : ''}`);
        return;
      }
      log.warn(`[jdrive] no offsite backup target: ${why}.`);
      log.warn('[jdrive] backups are on the same disk as the data they protect, so one dead disk loses both.');
      log.warn('[jdrive] set OFFSITE_S3_ENDPOINT, OFFSITE_S3_BUCKET, OFFSITE_S3_REGION, OFFSITE_S3_KEY and OFFSITE_S3_SECRET.');
    },
  };
}

// Anchored at both ends, because `127.` as a prefix is not the loopback: an
// attacker who controls `127.0.0.1.their-domain.example` owns a name that starts
// with it and resolves anywhere they like, and a plaintext exemption granted to
// that name is the credential and the artifact sent to them in the clear. Caught
// by `offsite.test.js` on the first run, which is the only reason it is written
// this way rather than the obvious way.
function isLoopback(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

module.exports = { createOffsite, signRequest, uriEncode, isLoopback, ALGORITHM, MAX_SINGLE_PUT };
