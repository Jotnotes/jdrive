'use strict';

// A tag is a word somebody chose for their own files.
//
// It is not a folder and not a place: a file has exactly one folder and exactly
// one place, and any number of tags. Nothing about a tag changes who can reach
// a file, which is the same rule folders live under and for the same reason.
//
// These are the customer's own words, so the rules are about being a usable
// label rather than about taste: something you can type, see and search for.
// Auto-tagging is a separate thing that lives behind the AI entitlement, and
// nothing in here knows anything about it.

const MAX_NAME = 40;

function cleanTagName(raw) {
  const name = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, reason: 'A tag needs a word.' };
  if (name.length > MAX_NAME) return { ok: false, reason: `A tag stops at ${MAX_NAME} characters.` };
  // Commas are out because a list of tags is written with commas everywhere a
  // person will ever see one, and a tag containing a comma is a tag that turns
  // into two the first time somebody pastes it somewhere.
  if (name.includes(',')) return { ok: false, reason: 'A tag cannot contain a comma.' };
  if (/[\u0000-\u001f\u007f]/.test(name)) return { ok: false, reason: 'That tag is not all characters.' };
  return { ok: true, name };
}

module.exports = { cleanTagName, MAX_NAME };
