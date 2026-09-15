'use strict';

// A one-way release notice. The request identifies the product version and
// nothing about the machine, its operator, its licence or what it stores.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { verify } = require('../tools/release-auth');

const DEFAULT_URL = 'https://jdrive.jotnotes.com/releases/latest.json';
const DAY = 24 * 60 * 60 * 1000;
const EMPTY = Object.freeze({ available: false, version: null, security: false, notes: null, checked_at: null });

function newer(candidate, installed) {
  const parse = value => {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value));
    return match ? match.slice(1).map(Number) : null;
  };
  const a = parse(candidate); const b = parse(installed);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function fetchBytes(url, options = {}) {
  return new Promise((resolve, reject) => {
    const client = String(url).startsWith('https:') ? https : http;
    const request = client.get(url, options, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 64 * 1024) request.destroy(new Error('response is too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) reject(new Error(`HTTP ${response.statusCode}`));
        else resolve(Buffer.concat(chunks));
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('request timed out')));
    request.on('error', reject);
  });
}

function createUpdateService({
  version,
  url = process.env.JDRIVE_UPDATES_URL || DEFAULT_URL,
  stateFile,
  fetch = fetchBytes,
  publicKey,
  now = () => new Date(),
  log = message => console.warn(`[jdrive] ${message}`),
} = {}) {
  const disabled = String(url).toLowerCase() === 'off';
  let state = { ...EMPTY };
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (saved && typeof saved.checked_at === 'string') state = { ...EMPTY, ...saved };
  } catch { /* A first check has no state file. */ }
  if (disabled) state = { ...EMPTY };

  function current() { return { ...state }; }

  function save(next) {
    state = next;
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, stateFile);
    } catch (error) {
      log(`Update check could not save its result: ${error.message}`);
    }
  }

  async function check({ force = false } = {}) {
    if (disabled) return current();
    const at = now();
    if (!force && state.checked_at && at.getTime() - Date.parse(state.checked_at) < DAY) return current();
    const checkedAt = at.toISOString();
    try {
      const options = { headers: { 'User-Agent': `JDrive/${version}` } };
      const [document, signature] = await Promise.all([
        fetch(url, options),
        fetch(`${url}.sig`, options),
      ]);
      if (!verify(document, signature.toString('utf8'), publicKey)) throw new Error('release notice signature did not verify');
      const notice = JSON.parse(document.toString('utf8'));
      if (!notice || typeof notice.version !== 'string' || typeof notice.published !== 'string'
        || typeof notice.security !== 'boolean' || typeof notice.notes !== 'string'
        || !/^https:\/\//.test(notice.notes) || !/^[0-9a-f]{64}$/.test(notice.sha256 || '')) {
        throw new Error('release notice has the wrong shape');
      }
      const available = newer(notice.version, version);
      save({
        available,
        version: available ? notice.version : null,
        security: available ? notice.security : false,
        notes: available ? notice.notes : null,
        checked_at: checkedAt,
      });
    } catch (error) {
      save({ ...state, checked_at: checkedAt });
      log(`Update check ignored: ${error.message}`);
    }
    return current();
  }

  function start() {
    if (disabled) return null;
    check();
    const timer = setInterval(() => check(), DAY);
    if (timer.unref) timer.unref();
    return timer;
  }

  return { current, check, start };
}

module.exports = { createUpdateService, newer, DEFAULT_URL, DAY, EMPTY };
