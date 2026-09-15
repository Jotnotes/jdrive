#!/usr/bin/env node
'use strict';

// Safe to copy beside a download and run with Node 20 or newer. It has no npm
// dependencies, opens no archive and executes none of the bytes being checked.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Deliberately carried in this one file so it can verify a first download before
// any JDrive code is installed. The unit test compares it with licence.js.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA47BBf6JcRQmgxMF7hpRJiRKVBvagVUWNgGXVOOo06Ls=
-----END PUBLIC KEY-----
`;
const releaseStatement = (name, sha256, commit) =>
  `JDRIVE-RELEASE 1\nfile ${name}\nsha256 ${sha256}\ncommit ${commit}\n`;
const verify = (bytes, signature, publicKey = PUBLIC_KEY) => {
  try {
    return crypto.verify(null, Buffer.from(bytes), publicKey, Buffer.from(String(signature).trim(), 'base64'));
  } catch { return false; }
};

function verifyRelease(tarball, publicKey) {
  try {
    const signature = fs.readFileSync(`${tarball}.sig`, 'utf8');
    const signedText = fs.readFileSync(`${tarball}.sig.txt`, 'utf8');
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(tarball)).digest('hex');
    const lines = signedText.split('\n');
    const fields = Object.fromEntries(lines.slice(1).filter(Boolean).map(line => {
      const at = line.indexOf(' ');
      return at < 0 ? [line, ''] : [line.slice(0, at), line.slice(at + 1)];
    }));
    const canonical = lines[0] === 'JDRIVE-RELEASE 1'
      && fields.file === path.basename(tarball)
      && /^[0-9a-f]{40,64}$/.test(fields.commit || '')
      && signedText === releaseStatement(fields.file, fields.sha256, fields.commit);
    return !!canonical && fields.sha256 === sha256 && verify(signedText, signature, publicKey);
  } catch {
    return false;
  }
}

if (require.main === module) {
  const tarball = process.argv[2];
  if (!tarball) {
    console.error('Usage: verify-release.js <tarball>');
    process.exit(1);
  }
  if (verifyRelease(tarball)) console.log('JDrive release verified.');
  else {
    console.error('JDrive release verification failed.');
    process.exitCode = 1;
  }
}

module.exports = { verifyRelease, PUBLIC_KEY };
