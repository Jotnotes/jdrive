'use strict';

// The vendor verification key is shared by licences, release artifacts and the
// small update notice. Keeping it in one dependency-free module means those
// three trust decisions cannot quietly drift apart.
const crypto = require('crypto');

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA47BBf6JcRQmgxMF7hpRJiRKVBvagVUWNgGXVOOo06Ls=
-----END PUBLIC KEY-----
`;

function sign(bytes, privateKeyPem) {
  return crypto.sign(null, Buffer.from(bytes), privateKeyPem).toString('base64');
}

function verify(bytes, signature, publicKeyPem = PUBLIC_KEY) {
  try {
    const encoded = String(signature || '').trim();
    if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
    return crypto.verify(null, Buffer.from(bytes), publicKeyPem, Buffer.from(encoded, 'base64'));
  } catch {
    return false;
  }
}

function releaseStatement(name, sha256, commit) {
  return `JDRIVE-RELEASE 1\nfile ${name}\nsha256 ${sha256}\ncommit ${commit}\n`;
}

module.exports = { PUBLIC_KEY, sign, verify, releaseStatement };
