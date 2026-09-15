'use strict';

// How much space an account is using, and whether it may use more.
//
// This is the product. It is sold by the gigabyte, so a limit that does not
// actually stop an upload is not a limit, it is a number on a pricing page.
//
// THE RULE THAT MATTERS MOST
//
// Freeing space is never blocked. An account that is over its limit has to be
// able to delete its way back under, or the limit is a trap that needs support to
// get out of. So this gates uploads and nothing else: not deletes, not emptying
// the Trash, not making something private.
//
// WHAT COUNTS
//
// Everything the account has on disk, including the Trash. Deleted-but-not-emptied
// files still occupy the disk, and a quota that ignored them would be a quota
// somebody could sail past by deleting nothing. That is also the honest answer to
// give a customer who is confused about why they are full: their Trash is in it.
//
// MEASURED, NOT COUNTED
//
// The size of a file is a fact the row holds, but the sum of them is a fact that
// drifts: an upload that failed halfway, a file removed outside the product, a
// restore. So usage is summed from the rows for speed, and `measureOnDisk` exists
// to reconcile against reality. The row sum is what gates an upload, because a
// gate has to answer in milliseconds; the disk is what settles an argument.

const fs = require('fs');
const path = require('path');

const storageRoots = require('./storageRoots');

const METRIC = 'storage_bytes';

// Bytes this account is using, from the rows. Includes the Trash, deliberately,
// and includes previous versions for the same reason: they are on the customer's
// disk because the customer's file used to be that, and an allowance that does
// not count them is an allowance the customer can exceed by saving twice.
function usedBytes(db, userId) {
  const row = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS files FROM files WHERE user_id=?').get(userId);
  const old = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS versions FROM file_versions WHERE user_id=?').get(userId);
  return {
    bytes: (Number(row.bytes) || 0) + (Number(old.bytes) || 0),
    files: Number(row.files) || 0,
    versions: Number(old.versions) || 0,
    version_bytes: Number(old.bytes) || 0,
  };
}

// The same question asked of the disk. Slower, and it is the one that is true.
function measureOnDisk(uploadsDir, userId) {
  let bytes = 0;
  for (const [, root] of storageRoots.allRoots(uploadsDir, userId)) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try { bytes += fs.statSync(path.join(root, entry.name)).size; } catch { /* gone between the two calls */ }
    }
  }
  return bytes;
}

// What this account is allowed, resolved from the plan.
//
// A limit nobody has set is no limit. That is the right default here and it is
// the opposite of the default for a capability: an unset capability is a hoster
// who has not decided, and an unset quota is a hoster who has not sold a quota,
// and refusing every upload on a box whose ladder is half filled in would break
// the product rather than protect it. The hoster sets a number when they want one.
function limitFor(entitlements, ownership, userId) {
  try {
    const membership = ownership.getMembership(userId);
    if (!membership) return { unlimited: true, bytes: null, source: 'no-organization' };
    const eff = entitlements.effectiveEntitlement(membership.orgId, METRIC);
    if (!eff || eff.missing || eff.maxUnlimited) return { unlimited: true, bytes: null, source: eff ? eff.source : 'missing' };
    const bytes = Number(eff.maxValue);
    if (!Number.isFinite(bytes) || bytes < 0) return { unlimited: true, bytes: null, source: 'unreadable' };
    return { unlimited: false, bytes, source: eff.source };
  } catch {
    return { unlimited: true, bytes: null, source: 'unavailable' };
  }
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return 'unlimited';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`;
}

// Whether an upload of `incoming` bytes may proceed.
//
// The incoming size is counted before the write rather than after, because a
// check that runs after the bytes are on the disk has described the overage
// rather than prevented it.
function mayAccept({ db, entitlements, ownership, userId, incomingBytes = 0 }) {
  const limit = limitFor(entitlements, ownership, userId);
  const used = usedBytes(db, userId);
  if (limit.unlimited) {
    return { allowed: true, used: used.bytes, limit: null, remaining: null, reason: null };
  }
  const after = used.bytes + Math.max(0, Number(incomingBytes) || 0);
  if (after > limit.bytes) {
    // The sentence carries the numbers, because "you are out of space" without
    // them is the beginning of a support conversation rather than the end of one.
    // It names the Trash because that is the most common reason somebody is full
    // and cannot see why.
    return {
      allowed: false,
      used: used.bytes,
      limit: limit.bytes,
      remaining: Math.max(0, limit.bytes - used.bytes),
      reason: `That would put you over your ${humanBytes(limit.bytes)} of storage. You are using ${humanBytes(used.bytes)}, and emptying your Trash may free some of it.`,
    };
  }
  return { allowed: true, used: used.bytes, limit: limit.bytes, remaining: limit.bytes - after, reason: null };
}

// What to show a customer. Always answerable, never an error, because a usage
// figure that fails to load reads as the product being broken.
function report({ db, entitlements, ownership, userId }) {
  const limit = limitFor(entitlements, ownership, userId);
  const used = usedBytes(db, userId);
  const trash = db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM files WHERE user_id=? AND deleted_at IS NOT NULL').get(userId);
  return {
    used_bytes: used.bytes,
    used_human: humanBytes(used.bytes),
    files: used.files,
    // Broken out because it is the number that answers "why am I full".
    trash_bytes: Number(trash.bytes) || 0,
    trash_human: humanBytes(Number(trash.bytes) || 0),
    limit_bytes: limit.unlimited ? null : limit.bytes,
    limit_human: limit.unlimited ? 'unlimited' : humanBytes(limit.bytes),
    unlimited: limit.unlimited,
    percent_used: limit.unlimited || !limit.bytes ? null : Math.min(100, Math.round((used.bytes / limit.bytes) * 100)),
    source: limit.source,
  };
}

// ── Reconciliation ──────────────────────────────────────────────────────────
//
// The meter is the invoice, so it has to be checked against the thing it claims
// to measure. The row sum is fast and is what gates an upload; the disk is what
// is true. They can diverge, and every way they can is a real event rather than
// a hypothetical:
//
//   - a crash between multer writing the file and the row being inserted, which
//     leaves bytes on disk that nothing counts and nothing will ever delete
//   - Empty Trash unlinking best-effort and deleting the row regardless, same
//     result
//   - a move that copied and failed before the unlink, leaving two copies
//   - anything at all done to the directory from outside the product
//
// Divergence in one direction costs the hoster disk they are not paid for.
// Divergence in the other overcharges a customer. Neither self-corrects, and
// nothing here noticed until this existed.

// Compare what the database believes against what is on the disk, for one
// account. Reports rather than repairs, because the repair depends on which way
// it diverged and that is a decision, not a cleanup.
function reconcile({ db, uploadsDir, userId }) {
  const rows = db.prepare('SELECT id,name,size,disk_path,deleted_at FROM files WHERE user_id=?').all(userId);
  // A previous version is a row with bytes behind it exactly like a file, so it
  // is reconciled exactly like one. Left out, every version on the disk would be
  // reported as an orphan and then swept away by the thing that removes orphans,
  // which is a customer's own history being deleted by a tidying job.
  const versions = db.prepare('SELECT id,name,size,disk_path FROM file_versions WHERE user_id=?').all(userId);
  const known = new Map();
  const missing = [];
  let recordedBytes = 0;
  let actualBytes = 0;

  for (const row of [...rows, ...versions.map(v => ({ ...v, isVersion: true }))]) {
    recordedBytes += Number(row.size) || 0;
    const resolved = row.disk_path ? path.resolve(row.disk_path) : null;
    const what = row.isVersion ? `an earlier ${row.name}` : row.name;
    if (!resolved) { missing.push({ id: row.id, name: what, why: 'the row has no location' }); continue; }
    known.set(resolved, row);
    let stat = null;
    try { stat = fs.statSync(resolved); } catch { /* gone */ }
    if (!stat) { missing.push({ id: row.id, name: what, why: 'the file is not on the disk' }); continue; }
    actualBytes += stat.size;
    if (stat.size !== (Number(row.size) || 0)) {
      missing.push({ id: row.id, name: what, why: `the row says ${row.size} bytes and the disk says ${stat.size}` });
    }
  }

  // The other direction: bytes on the disk that no row claims. These are the
  // expensive ones, because nothing will ever look at them again.
  const orphans = [];
  for (const [, root] of storageRoots.allRoots(uploadsDir, userId)) {
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(root, entry.name);
      if (known.has(full)) continue;
      let size = 0;
      try { size = fs.statSync(full).size; } catch { continue; }
      orphans.push({ path: full, bytes: size });
    }
  }
  const orphanBytes = orphans.reduce((n, o) => n + o.bytes, 0);

  return {
    recorded_bytes: recordedBytes,
    actual_bytes: actualBytes + orphanBytes,
    counted_on_disk_bytes: actualBytes,
    orphan_bytes: orphanBytes,
    orphans,
    problems: missing,
    // The single question a caller cares about.
    agrees: missing.length === 0 && orphans.length === 0 && recordedBytes === actualBytes,
  };
}

// Remove bytes on disk that no row claims. Separate from `reconcile` on purpose:
// looking is safe and deleting is not, so nothing deletes as a side effect of a
// report. Only ever touches files inside this account's own roots, and only ones
// no row points at — and a previous version is a row, so this cannot reach one.
function sweepOrphans({ db, uploadsDir, userId }) {
  const found = reconcile({ db, uploadsDir, userId });
  let removed = 0;
  let bytes = 0;
  for (const orphan of found.orphans) {
    const inside = storageRoots.allRoots(uploadsDir, userId)
      .some(([, root]) => storageRoots.isInside(root, orphan.path));
    if (!inside) continue; // cannot happen by construction; checked anyway
    try { fs.unlinkSync(orphan.path); removed++; bytes += orphan.bytes; } catch { /* leave it and report */ }
  }
  return { removed, bytes };
}

// The reader the entitlements engine uses to answer "how much storage is this
// subtree using". Sums the accounts in those organizations from the same rows
// the quota gate reads, so the two APIs cannot disagree: before this existed the
// engine had no reader for storage at all and reported zero for every account,
// for ever, on a product sold by storage.
function subtreeUsageReader({ db, uploadsDir }) {
  return orgIds => {
    if (!Array.isArray(orgIds) || !orgIds.length) return 0;
    const placeholders = orgIds.map(() => '?').join(',');
    const row = db.prepare(`SELECT COALESCE(SUM(f.size),0) AS bytes FROM files f
      JOIN memberships m ON m.identity_id = f.user_id
      WHERE m.org_id IN (${placeholders})`).get(...orgIds);
    return Number(row.bytes) || 0;
  };
}

module.exports = {
  METRIC, usedBytes, measureOnDisk, limitFor, mayAccept, report, humanBytes,
  reconcile, sweepOrphans, subtreeUsageReader,
};
