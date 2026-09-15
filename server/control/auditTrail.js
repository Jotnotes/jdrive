'use strict';

// Who may read what out of the audit log.
//
// One table records two different kinds of thing: what happened *to* an account,
// and what its owner did with their files. A hosting company needs the first to
// run a business — when somebody signed in, when a plan changed, when a quota
// refused a write, when storage stopped matching the disk. The second is the
// customer's own business, and it is not abstract: the details column carries
// filenames, because "holiday.jpg is now trip.jpg" is what makes a trail worth
// reading. A console that hands a hosting company their customers' filenames
// breaks the promise the rest of this product spends its whole design keeping.
//
// So the split is by action, and it is an allowlist rather than a blocklist.
// Anything not named below is the customer's alone. A file action added next
// year is therefore private by omission rather than exposed by omission, which
// is the only direction this list is safe to be wrong in.
//
// The customer reads their own trail in full. Nothing here narrows that.

const ACCOUNT_LEVEL = new Set([
  // The account existing at all
  'bootstrap_owner_created', 'account_created', 'account_not_linked_to_creator',
  'membership_not_created', 'email_verified',
  // Who it belongs to and what it may do
  'account_suspended', 'account_restored',
  // Changing hands. It belongs in the record both sellers read — the one who
  // lost the account and the one who gained it — and in the customer's own
  // history, because being handed to a different company is a fact about their
  // account rather than about their files.
  'account_moved', 'account_moved_by_you',
  'account_move_notified', 'account_move_notice_failed',
  // Somebody signing in as this account. It belongs in the record both people
  // read: the customer's own history, which is theirs in full, and the account
  // trail their seller reads. A support session nobody can see afterwards is the
  // whole objection to the feature, so the trail is the feature.
  'impersonation_started', 'impersonation_started_by_you',
  'impersonation_ended', 'impersonation_refused',
  // And the policy that decides whether any of it may happen. A hosting company
  // reading a reseller's account trail should see that the reseller switched
  // support access off, because it is a material fact about the account they
  // sell to and it carries no filename. The refusal is on the customer's trail
  // for the same reason the file refusals are: somebody tried the door.
  'support_access_set',
  'impersonation_refused_by_policy', 'impersonation_refused_by_policy_for_you',
  'impersonation_ended_by_policy',
  // Whether the customer was pushed the fact, as opposed to being able to find
  // it. Both outcomes, because a notice that silently failed to send is the one
  // worth seeing.
  'support_session_notified', 'support_session_notice_failed',
  // The clerical half of the record: a name corrected, an address followed, a
  // number given to one account without a package for it. All of it is already
  // visible to whoever sells the account — it is their own list and their own
  // arithmetic — and none of it carries a filename.
  'account_renamed', 'account_email_changed',
  'account_email_change_notified', 'account_email_change_notice_failed',
  'limit_overridden', 'limit_override_cleared',
  'package_assigned', 'package_created', 'package_archived',
  'reseller_created', 'reseller_role_not_granted',
  // The machine credential. Issuing one, revoking one, and each write a key
  // performed — all of it about the account rather than about its files, and
  // none of it carrying a filename, because a key cannot reach a file at all.
  // "Which key did this" is the first question anybody asks after one leaks,
  // and the party who sold the account is who asks it.
  'api_key_issued', 'api_key_revoked', 'api_key_used',
  'sign_in_link_made', 'sign_in_link_refused', 'login_from_portal',
  // Transfer. All of it is about the account and its bill — how much moved,
  // when the window was reset, when a public address was refused — and none of
  // it names a file, because the meter counts bytes and never looks at them.
  'egress_warned', 'egress_refused', 'egress_window_reset',
  // Getting in and out. Every panel in this category shows a last sign-in, and
  // none of it says anything about what is stored.
  // `password_reset_sent` and `verification_sent` are the names the box actually
  // writes. An earlier version of this list was built by reading the source for
  // `audit(...)` calls and got both wrong, which the allowlist then hid as
  // "private" rather than as "broken" — so the list is reconciled against the
  // distinct actions in the table, not against a pattern match.
  'login', 'login_failed', 'login_unverified', 'logout', 'logout_all',
  'password_reset', 'password_reset_sent', 'verification_sent',
  // Limits doing their job. The details are byte counts, never names.
  'upload_refused_quota', 'upload_refused_quota_after_write', 'replace_refused_quota',
  // The box's own housekeeping against this account
  'storage_swept', 'storage_divergence',
]);

// Operator-level events that belong to the machine rather than to any customer.
// They are never part of an account's trail, whoever asks.
const MACHINE_LEVEL = new Set([
  'backup_taken', 'backup_verified', 'backup_failed',
  // Shipping the artifact off the box. Machine-level for the same reason the
  // rest is: the artifact is every account at once, so it belongs to none of
  // them. The details name the bucket and never the credential — `offsite.scrub`
  // is between the endpoint's error and this line, because S3 answers
  // `SignatureDoesNotMatch` by quoting the access key back.
  'backup_shipped', 'backup_ship_failed',
  'brand_set', 'brand_asset_set', 'brand_asset_cleared',
  'egress_policy_set',
  // A key presented and refused belongs to nobody: the whole point is that the
  // box could not tell whose it was. It is the machine's own record of being
  // knocked on, and it is never part of any account's trail.
  'api_key_refused',
]);

const isAccountLevel = action => ACCOUNT_LEVEL.has(String(action == null ? '' : action));
const isMachineLevel = action => MACHINE_LEVEL.has(String(action == null ? '' : action));

module.exports = { ACCOUNT_LEVEL, MACHINE_LEVEL, isAccountLevel, isMachineLevel };
