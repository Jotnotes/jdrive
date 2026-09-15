'use strict';

// Folders, and the rules about them that are worth reading in one place.
//
// A folder is organisation, not location. The bytes do not move when a file is
// filed: which place a file is in is still decided by the directory on disk, and
// which folder it is in is a fact about how its owner likes to think. Keeping
// those two apart is deliberate — the moment a folder decides who can see
// something, "put it in the shared folder" becomes a way to publish a file by
// accident, and this product has a Public for that, on purpose, with a button.
//
// Folders live in My Files. Public, Shared and Trash are what is true about a
// file right now, and being true is not somewhere you can file something.

const TOP = 'root';
const MAX_NAME = 80;
// Deep enough for anybody organising real work, shallow enough that a loop or a
// runaway script cannot build a tree nothing can draw.
const MAX_DEPTH = 12;

// A name a person typed. Slashes are out because a name that looks like a path
// is a name somebody will eventually treat as one.
function cleanName(raw) {
  const name = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, reason: 'A folder needs a name.' };
  if (name.length > MAX_NAME) return { ok: false, reason: `A folder name stops at ${MAX_NAME} characters.` };
  if (name.includes('/') || name.includes('\\')) return { ok: false, reason: 'A folder name cannot contain a slash.' };
  if (name === '.' || name === '..') return { ok: false, reason: 'That is not a name.' };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: 'That name is not all characters.' };
  return { ok: true, name };
}

// How far down a folder sits. The top is zero. An id nothing knows about is
// treated as the top rather than as an error: a file whose folder was deleted
// has to appear somewhere, and the top is where somebody will look for it.
function depthOf(folders, id) {
  let depth = 0;
  let at = id;
  const seen = new Set();
  while (at && at !== TOP) {
    if (seen.has(at)) return MAX_DEPTH + 1; // a loop that should not exist; refuse rather than spin
    seen.add(at);
    const row = folders.find(f => f.id === at);
    if (!row) return depth;
    at = row.parent_id;
    depth += 1;
  }
  return depth;
}

// Would moving `id` under `parent` put it inside itself. Walking up from the
// proposed parent is the whole check, and without it a folder dragged into its
// own child takes everything below it out of the tree, where nothing can reach
// it and nothing knows it is gone.
function isInside(folders, id, parent) {
  let at = parent;
  const seen = new Set();
  while (at && at !== TOP) {
    if (at === id) return true;
    if (seen.has(at)) return false;
    seen.add(at);
    const row = folders.find(f => f.id === at);
    if (!row) return false;
    at = row.parent_id;
  }
  return false;
}

// Top-down, for saying where something went in a sentence a person can read.
function pathTo(folders, id) {
  const out = [];
  let at = id;
  const seen = new Set();
  while (at && at !== TOP && !seen.has(at)) {
    seen.add(at);
    const row = folders.find(f => f.id === at);
    if (!row) break;
    out.unshift({ id: row.id, name: row.name });
    at = row.parent_id;
  }
  return out;
}

module.exports = { TOP, MAX_NAME, MAX_DEPTH, cleanName, depthOf, isInside, pathTo };
