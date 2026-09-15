// Pieces both halves of the console use: the account list and sheet in the core,
// and the Hosting edition's screens. Kept apart so neither imports the other.

import { bytes } from './ui.jsx';

export const ROLE_WORDS = { hosting_company: 'This box', reseller: 'Reseller', end_user: 'Customer' };

export const GIGABYTE = 1024 * 1024 * 1024;

// The metrics a person types in gigabytes and the box stores in bytes. One set,
// consulted by the field, its unit label and the conversion, so those three
// cannot drift into disagreeing about what a typed number meant.
export const BY_GIGABYTE = new Set(['storage_bytes', 'egress_bytes']);

// A percentage that never disappears. A box holding a few megabytes against a
// two-terabyte ceiling is a bar 0.002% wide, which draws as nothing at all and
// reads as a broken component rather than as an empty box, so anything above
// zero keeps a visible sliver.
export function bar(fraction) {
  const percent = Math.max(0, Math.min(1, Number(fraction) || 0)) * 100;
  return percent > 0 && percent < 1.2 ? 1.2 : percent;
}

// The registry's own keys, said the way a person selling this would say them.
// Anything not named here is shown as it comes, so a metric added tomorrow
// appears rather than disappearing.
export const WORDS = {
  storage_bytes: 'Storage',
  files_public: 'Publishing to the internet',
  files_share_links: 'Share links',
  files_trash_days: 'Trash kept for',
  // Every metric the registry sells needs a word here, or the console shows the
  // key with its underscores taken out. This one was missing and read as
  // "files version days" on the entitlements list of every account.
  files_version_days: 'Earlier versions kept for',
  // Added with the metric on 2026-09-07 — and it was still missed on the first
  // build, which showed "egress bytes" in the plan builder. The warning above
  // was written after `files_version_days` did exactly this and did not stop it
  // happening again, so: a metric and its word ship in the same commit.
  egress_bytes: 'Transfer',
};

export const label = key => WORDS[key] || String(key).replace(/_/g, ' ');

export function limitWords(limit) {
  if (limit.maximum_is_unlimited) return 'No limit';
  const value = Number(limit.maximum_value);
  if (limit.metric_key === 'storage_bytes' || limit.metric_key === 'egress_bytes') return bytes(value);
  if (limit.metric_key === 'files_trash_days') return `${value} day${value === 1 ? '' : 's'}`;
  return value > 0 ? 'Included' : 'Not included';
}

// The engine's own report, read as it is written rather than as a console might
// wish it were: `maximum_allowed` carries the limit, `missing_assignment` says
// nobody has priced this at all, and neither of those is the same as zero. The
// first version of this read fields that do not exist and told a hosting company
// their customer had nothing, which is the most expensive kind of wrong a
// console can be.
export function entitlementWords(metric) {
  const key = metric.metric;
  const allowed = metric.maximum_allowed || {};
  const used = (metric.actually_used || {}).subtree;
  if (metric.missing_assignment) return 'Whatever this box gives away';
  // Both byte metrics read the same way. Left as a bare `storage_bytes` check,
  // an account's entitlements list showed transfer as "Included" or "Not
  // included" — a capability answer to a capacity question, which is how a
  // 50GB allowance reads as a yes/no.
  const inBytes = key === 'storage_bytes' || key === 'egress_bytes';
  if (allowed.unlimited) return inBytes && Number.isFinite(used) ? `${bytes(used)} of no limit` : 'No limit';
  const value = Number(allowed.value) || 0;
  if (inBytes) return `${bytes(used || 0)} of ${bytes(value)}`;
  if (metric.unit === 'days') return `${value} day${value === 1 ? '' : 's'}`;
  return value > 0 ? 'Included' : 'Not included';
}

// The engine speaks in metric keys and bytes, because that is what it enforces.
// Whoever is selling storage reads gigabytes and the name they chose, so a
// refusal is translated on its way to the screen rather than quoted at somebody.
export function plainly(message) {
  return String(message)
    .replace(/(\d{4,})\s*storage_bytes/g, (_, n) => bytes(Number(n)))
    // "This account" is the seller, read on the customer's sheet it named the
    // wrong one. Whoever assigns a plan is the seller it is measured against.
    .replace(/the (\d{4,}) this account holds/g, (_, n) => `the ${bytes(Number(n))} you hold`)
    .replace(/storage_bytes/g, 'storage');
}

// A person types 25 and means gigabytes. The box counts bytes, and the
// conversion happens once, here, rather than in three places that can disagree.
export function toStored(metric, typed) {
  const number = Math.max(0, Number(typed) || 0);
  // Transfer is typed in gigabytes for the same reason storage is: nobody sells
  // either by the byte, and a form that offered "100" as a number of bytes would
  // let a hosting company sell a hundred-byte allowance by accident.
  return BY_GIGABYTE.has(metric.metric) ? Math.round(number * GIGABYTE) : Math.round(number);
}
