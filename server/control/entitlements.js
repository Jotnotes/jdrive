'use strict';

const crypto = require('crypto');

// Reseller packages and entitlements — the metering half of "may this
// organization do this," sitting beside ownership.js's "may this identity do
// this to this resource." Built from the spec in `docs/
// RESELLER_PACKAGES_SPEC.md` (produced by a design pass, not derived here),
// adapted where Arca's actual runtime made the spec's assumptions simpler to
// satisfy than to build literally. Two adaptations, both deliberate:
//
// - The spec assumes DB-level row locking (`entitlement_meter_locks`,
//   `SELECT ... FOR UPDATE`) because it doesn't assume a specific runtime.
//   Arca is one Node process talking to one SQLite file through
//   better-sqlite3, whose transactions are synchronous — so a single
//   in-process async mutex around admission checks gives the same real
//   guarantee (no two proposals can interleave their capacity check) without
//   needing lock rows a single-process app doesn't need. See `withLock`.
// The measured-storage freshness table and
// `entitlement_overages` (usage that is already above a ceiling) were deferred
// out of the first pass and are built now. The overage table is a projection of
// the admission check rather than a subsystem beside it: the numbers are
// written by the code that had already worked them out.
//
// This engine is product-neutral by construction. It owns the organization
// hierarchy, packages, limits, overrides, pending holds, allocation arithmetic
// and overage records, and it knows nothing about what any of those measure.
//
// A product supplies three things: the metrics it sells, the capability flags it
// may charge for, and a reader per metric that says how much is being used. It
// was not always like this. The engine came out of a hosting control panel and
// carried that panel's metrics as built-in defaults, along with meters that ran
// privileged jobs to count mailboxes and to `du` a website's directory. On a file
// product all of that was either meaningless or actively wrong.
//
const now = () => new Date();

function createEntitlementsService({ db, usageReaders = {}, metrics: metricsOverride = null, features: featuresOverride = null }) {
  if (!db) throw new Error('the entitlements service requires a database');

  db.exec(`
    CREATE TABLE IF NOT EXISTS organization_accounts (
      id                      TEXT PRIMARY KEY,
      parent_org_id           TEXT NOT NULL,
      child_org_id            TEXT NOT NULL,
      status                  TEXT NOT NULL,
      created_at              TEXT NOT NULL,
      created_by_identity_id  TEXT NOT NULL,
      ended_at                TEXT,
      ended_by_identity_id    TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_accounts_active_child
      ON organization_accounts(child_org_id) WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_org_accounts_parent ON organization_accounts(parent_org_id, status);

    CREATE TABLE IF NOT EXISTS entitlement_roots (
      org_id                  TEXT PRIMARY KEY,
      created_at              TEXT NOT NULL,
      created_by_identity_id  TEXT NOT NULL
    );

    -- The kind column splits two things that were one and should never have been.
    --
    -- A CAPACITY metric is a quantity that runs out: bytes of storage, seats.
    -- Every package must name every one of them,
    -- because a package that silently meant unlimited for anything you forgot is
    -- how somebody sells a plan they did not mean to sell.
    --
    -- A FEATURE metric is whether a capability is switched on: watermarking,
    -- viewer analytics, how many days of history. Forgetting one of those is not
    -- giving away the machine, it is declining to have an opinion, and the right
    -- answer to no opinion is the product's own default rather than a refusal.
    -- Requiring them would also mean every hoster's existing packages break the
    -- day a new capability ships, which is how a product stops shipping
    -- capabilities.
    --
    -- The point of the split is the business model rather than tidiness. These
    -- are the things a hoster or a reseller may decide to charge for, and the
    -- default is free and on, so a hoster who does nothing gives their customers
    -- everything and a hoster who wants a premium tier has the lever without us
    -- choosing the tiers for them.
    CREATE TABLE IF NOT EXISTS entitlement_metrics (
      metric_key            TEXT PRIMARY KEY,
      unit                  TEXT NOT NULL,
      period                TEXT NOT NULL,
      supports_reservation  INTEGER NOT NULL,
      enabled                INTEGER NOT NULL,
      display_order          INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS packages (
      id                      TEXT PRIMARY KEY,
      owner_org_id            TEXT NOT NULL,
      name                    TEXT NOT NULL,
      description             TEXT,
      status                  TEXT NOT NULL,
      created_at              TEXT NOT NULL,
      created_by_identity_id  TEXT NOT NULL,
      archived_at             TEXT,
      archived_by_identity_id TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_packages_owner_name
      ON packages(owner_org_id, name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS package_limits (
      package_id                    TEXT NOT NULL,
      metric_key                    TEXT NOT NULL,
      maximum_value                 INTEGER,
      maximum_is_unlimited          INTEGER NOT NULL,
      reserved_value                INTEGER,
      downstream_allocation_policy  TEXT NOT NULL,
      PRIMARY KEY (package_id, metric_key)
    );

    CREATE TABLE IF NOT EXISTS account_package_assignments (
      id                          TEXT PRIMARY KEY,
      parent_org_id                TEXT NOT NULL,
      target_org_id                 TEXT NOT NULL,
      package_id                    TEXT NOT NULL,
      status                        TEXT NOT NULL,
      assigned_at                   TEXT NOT NULL,
      assigned_by_identity_id       TEXT NOT NULL,
      superseded_at                 TEXT,
      superseded_by_assignment_id   TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_assignments_active_target
      ON account_package_assignments(target_org_id) WHERE status='active';
    CREATE INDEX IF NOT EXISTS idx_assignments_parent ON account_package_assignments(parent_org_id, status);

    CREATE TABLE IF NOT EXISTS account_limit_overrides (
      assignment_id                 TEXT NOT NULL,
      metric_key                    TEXT NOT NULL,
      maximum_override_value        INTEGER,
      maximum_override_is_unlimited INTEGER NOT NULL DEFAULT 0,
      reserved_override_value       INTEGER,
      downstream_policy_override    TEXT,
      reason                        TEXT NOT NULL,
      set_by_org_id                  TEXT NOT NULL,
      set_by_identity_id             TEXT NOT NULL,
      created_at                     TEXT NOT NULL,
      updated_at                     TEXT NOT NULL,
      PRIMARY KEY (assignment_id, metric_key)
    );

    CREATE TABLE IF NOT EXISTS entitlement_pending_holds (
      id            TEXT PRIMARY KEY,
      proposal_id   TEXT NOT NULL,
      target_org_id TEXT NOT NULL,
      metric_key    TEXT NOT NULL,
      period_key    TEXT NOT NULL,
      delta_value   INTEGER NOT NULL,
      state         TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      expires_at    TEXT NOT NULL,
      released_at   TEXT,
      release_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_proposal_metric
      ON entitlement_pending_holds(proposal_id, metric_key, period_key);
    CREATE INDEX IF NOT EXISTS idx_holds_target_active
      ON entitlement_pending_holds(target_org_id, metric_key, period_key, state);

    -- Usage that is already ABOVE a ceiling, which the normal path cannot
    -- produce: it happens when the ceiling comes down onto usage that was
    -- legitimate when it was created. An accepted downgrade, a correction to a
    -- measurement that was wrong, growth on the machine itself.
    --
    -- Two rules apply to an account in this state and they are not the same
    -- rule. Nothing already working is switched off, and nothing may be added.
    -- The row exists so the panel can say which one is biting rather than
    -- reporting "over your limit" and leaving the person to guess which. It is
    -- state and de-duplication; the meters stay
    -- the source of truth, which is why the numbers here are stamped with when
    -- they were observed rather than trusted afterwards.
    CREATE TABLE IF NOT EXISTS entitlement_overages (
      org_id                      TEXT NOT NULL,
      metric_key                  TEXT NOT NULL,
      period_key                  TEXT NOT NULL,
      status                      TEXT NOT NULL,
      first_detected_at           TEXT NOT NULL,
      last_observed_at            TEXT NOT NULL,
      used_value                  INTEGER NOT NULL,
      maximum_value_at_detection  INTEGER NOT NULL,
      resolved_at                 TEXT,
      PRIMARY KEY (org_id, metric_key, period_key)
    );
    CREATE INDEX IF NOT EXISTS idx_entitlement_overages_open ON entitlement_overages(status, org_id);
  `);

  addMetricColumns();
  seedMetrics();

  // ── In-process serialization ────────────────────────────────────
  // One global chain rather than per-key: this box is a single VPS control
  // panel, not a high-concurrency multi-tenant service, and correctness is
  // worth more here than parallelism. Every admission check and every
  // package/assignment/override write that touches capacity runs through
  // this, so two overlapping proposals can never both pass a check against
  // the same headroom.
  let chain = Promise.resolve();
  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  function id(prefix) { return `${prefix}_${crypto.randomBytes(8).toString('hex')}`; }

  // The period key for anything metered per calendar month, in UTC, so a box
  // and the people reading its bills never disagree about which month a spend
  // landed in because of where somebody was standing.
  function monthKey(when = now()) { return when.toISOString().slice(0, 7); }

  // Added rather than declared, so a box that already has the table gains them
  // on the next start without a migration step anybody has to remember to run.
  function addMetricColumns() {
    const have = new Set(db.prepare('PRAGMA table_info(entitlement_metrics)').all().map(c => c.name));
    if (!have.has('kind')) db.exec("ALTER TABLE entitlement_metrics ADD COLUMN kind TEXT NOT NULL DEFAULT 'capacity'");
    if (!have.has('default_value')) db.exec('ALTER TABLE entitlement_metrics ADD COLUMN default_value INTEGER');
    if (!have.has('default_unlimited')) db.exec('ALTER TABLE entitlement_metrics ADD COLUMN default_unlimited INTEGER NOT NULL DEFAULT 0');
  }

  function metricRow(metricKey) {
    return db.prepare('SELECT * FROM entitlement_metrics WHERE metric_key=?').get(metricKey) || null;
  }

  function isFeatureMetric(metricKey) {
    const m = metricRow(metricKey);
    return !!m && m.kind === 'feature';
  }

  // What a feature metric means when nothing has said otherwise. Free and on,
  // which is the product's position: the hoster opts in to charging rather than
  // the customer opting in to having a working product.
  function metricDefault(metricKey) {
    const m = metricRow(metricKey);
    if (!m || m.kind !== 'feature') return null;
    return {
      maxValue: m.default_value, maxUnlimited: !!m.default_unlimited,
      reservedValue: null, downstreamPolicy: 'strict', source: 'default',
    };
  }

  function seedMetrics() {
    // No product defaults. A product declares what it sells, because a default
    // list is a list somebody inherits by accident, and an inherited metric that
    // nothing measures reports zero usage against a real limit.
    //
    // Empty is the honest default: a deployment that declares nothing gets
    // nothing, and finds out at once rather than inheriting somebody else's list.
    const metrics = metricsOverride || [];
    // Feature flags default to empty for the same reason. A capability nobody
    // declared is a capability nobody sells.
    const features = featuresOverride || [    ];
    const insert = db.prepare(`INSERT OR IGNORE INTO entitlement_metrics
      (metric_key, unit, period, supports_reservation, enabled, display_order, kind, default_value, default_unlimited)
      VALUES (?,?,?,?,?,?,'capacity',NULL,0)`);
    for (const m of metrics) insert.run(...m);
    const insertFeature = db.prepare(`INSERT OR IGNORE INTO entitlement_metrics
      (metric_key, unit, period, supports_reservation, enabled, display_order, kind, default_value, default_unlimited)
      VALUES (?,?,'current',0,1,?,'feature',NULL,1)`);
    for (const [key, unit, order] of features) insertFeature.run(key, unit, order);
  }

  function enabledMetrics() {
    return db.prepare('SELECT * FROM entitlement_metrics WHERE enabled=1 ORDER BY display_order').all();
  }

  // ── Organization hierarchy ──────────────────────────────────────
  function markRoot(orgId, actorIdentityId) {
    db.prepare('INSERT OR IGNORE INTO entitlement_roots (org_id, created_at, created_by_identity_id) VALUES (?,?,?)')
      .run(orgId, now().toISOString(), actorIdentityId);
  }

  function isRoot(orgId) {
    return !!db.prepare('SELECT 1 FROM entitlement_roots WHERE org_id=?').get(orgId);
  }

  function getDirectParent(orgId) {
    const row = db.prepare(`SELECT parent_org_id FROM organization_accounts WHERE child_org_id=? AND status='active'`).get(orgId);
    return row ? row.parent_org_id : null;
  }

  // Every active descendant, orgId itself included — "subtree" throughout
  // this file means that inclusive set. Depth-bounded rather than trusting
  // the cycle guard alone, since a bug elsewhere should not become an
  // infinite loop here.
  function getSubtreeOrgIds(orgId) {
    const seen = new Set([orgId]);
    let frontier = [orgId];
    for (let depth = 0; depth < 50 && frontier.length; depth += 1) {
      const rows = db.prepare(`SELECT child_org_id FROM organization_accounts WHERE parent_org_id IN (${frontier.map(() => '?').join(',')}) AND status='active'`).all(...frontier);
      frontier = rows.map(r => r.child_org_id).filter(c => !seen.has(c));
      frontier.forEach(c => seen.add(c));
    }
    return [...seen];
  }

  // Every ancestor from the direct parent up to (and including) the root,
  // orgId itself NOT included — this is "who else has to have headroom."
  function getAncestorChain(orgId) {
    const chain = [];
    let current = getDirectParent(orgId);
    for (let depth = 0; depth < 50 && current; depth += 1) {
      chain.push(current);
      current = getDirectParent(current);
    }
    return chain;
  }

  function wouldCycle(parentOrgId, childOrgId) {
    if (parentOrgId === childOrgId) return true;
    return getAncestorChain(parentOrgId).includes(childOrgId);
  }

  function linkOrganizations(parentOrgId, childOrgId, actorIdentityId) {
    if (parentOrgId === childOrgId) throw entitlementError('An organization cannot be its own parent', 'ORG_LINK_SELF');
    const existingParent = getDirectParent(childOrgId);
    if (existingParent) throw entitlementError(`${childOrgId} already has an active parent`, 'TARGET_NOT_DIRECT_CHILD');
    if (wouldCycle(parentOrgId, childOrgId)) throw entitlementError('That link would create a cycle', 'ORG_LINK_CYCLE');
    db.prepare(`INSERT INTO organization_accounts (id, parent_org_id, child_org_id, status, created_at, created_by_identity_id) VALUES (?,?,?,?,?,?)`)
      .run(id('oa'), parentOrgId, childOrgId, 'active', now().toISOString(), actorIdentityId);
  }

  function endOrganizationLink(childOrgId, actorIdentityId) {
    db.prepare(`UPDATE organization_accounts SET status='ended', ended_at=?, ended_by_identity_id=? WHERE child_org_id=? AND status='active'`)
      .run(now().toISOString(), actorIdentityId, childOrgId);
  }

  // ── Packages ─────────────────────────────────────────────────────
  function createPackage({ ownerOrgId, name, description, limits, actorIdentityId }) {
    const clean = String(name || '').trim();
    if (!clean) throw entitlementError('A package needs a name', 'PACKAGE_NAME_REQUIRED');
    const byMetric = new Map((limits || []).map(l => [l.metric, l]));
    const metrics = enabledMetrics();
    // Capacity must be named, every time. Feature metrics may be left out, and
    // leaving one out means the product default rather than nothing, so a
    // hoster's existing packages keep working the day a new capability ships.
    const capacity = metrics.filter(m => m.kind !== 'feature');
    for (const m of capacity) if (!byMetric.has(m.metric_key)) throw entitlementError(`Missing a limit for ${m.metric_key}`, 'PACKAGE_LIMIT_MISSING');
    const named = metrics.filter(m => m.kind !== 'feature' || byMetric.has(m.metric_key));
    const pkgId = id('pkg');
    const insertPkg = db.prepare(`INSERT INTO packages (id, owner_org_id, name, description, status, created_at, created_by_identity_id) VALUES (?,?,?,?,?,?,?)`);
    const insertLimit = db.prepare(`INSERT INTO package_limits (package_id, metric_key, maximum_value, maximum_is_unlimited, reserved_value, downstream_allocation_policy) VALUES (?,?,?,?,?,?)`);
    const tx = db.transaction(() => {
      insertPkg.run(pkgId, ownerOrgId, clean, description || null, 'active', now().toISOString(), actorIdentityId);
      for (const m of named) {
        const l = byMetric.get(m.metric_key);
        const unlimited = !!l.unlimited;
        if (!unlimited && !(Number.isInteger(l.value) && l.value >= 0)) throw entitlementError(`${m.metric_key} needs a non-negative whole-number maximum`, 'PACKAGE_LIMIT_INVALID');
        const reserved = l.reserved ?? null;
        if (reserved != null && !m.supports_reservation) throw entitlementError(`${m.metric_key} does not support a reservation`, 'PACKAGE_LIMIT_INVALID');
        if (reserved != null && (!Number.isInteger(reserved) || reserved < 0 || (!unlimited && reserved > l.value))) throw entitlementError(`${m.metric_key} reservation is invalid`, 'PACKAGE_LIMIT_INVALID');
        const policy = l.downstreamPolicy || 'strict';
        insertLimit.run(pkgId, m.metric_key, unlimited ? null : l.value, unlimited ? 1 : 0, reserved, policy);
      }
    });
    tx();
    return getPackage(pkgId);
  }

  function getPackage(pkgId) {
    const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(pkgId);
    if (!pkg) return null;
    const limits = db.prepare('SELECT * FROM package_limits WHERE package_id=?').all(pkgId);
    return { ...pkg, limits };
  }

  // How many accounts are on a package right now. Used to prove that archiving
  // one left them exactly where they were, rather than trusting that it did.
  function countActiveAssignments(packageId) {
    return db.prepare(`SELECT COUNT(*) AS n FROM account_package_assignments WHERE package_id=? AND status='active'`).get(packageId).n;
  }

  function archivePackage(pkgId, actorIdentityId) {
    db.prepare(`UPDATE packages SET status='archived', archived_at=?, archived_by_identity_id=? WHERE id=? AND status='active'`)
      .run(now().toISOString(), actorIdentityId, pkgId);
  }

  // ── Effective entitlement resolution ────────────────────────────
  // Independent per field, per the spec: an override on `maximum` does not
  // imply anything about `reserved` or the downstream policy unless it also
  // set them.
  function effectiveEntitlement(orgId, metricKey) {
    if (isRoot(orgId)) {
      return { maxValue: null, maxUnlimited: true, reservedValue: null, downstreamPolicy: 'strict', source: 'root' };
    }
    const assignment = db.prepare(`SELECT * FROM account_package_assignments WHERE target_org_id=? AND status='active'`).get(orgId);
    // A feature nobody has priced is on. An account with no package at all still
    // gets the working product, because the alternative is that every customer on
    // a box whose ladder is half configured silently loses features nobody
    // decided to take away.
    const featureDefault = metricDefault(metricKey);
    if (!assignment) {
      return featureDefault
        || { maxValue: 0, maxUnlimited: false, reservedValue: null, downstreamPolicy: 'strict', source: 'missing', missing: true };
    }
    const limit = db.prepare('SELECT * FROM package_limits WHERE package_id=? AND metric_key=?').get(assignment.package_id, metricKey);
    // A package that does not mention this metric. Legitimate now that feature
    // metrics are optional, and previously a crash: every line below reads off
    // `limit` and nothing checked it was there.
    if (!limit) {
      return featureDefault
        ? { ...featureDefault, assignmentId: assignment.id, packageId: assignment.package_id }
        : { maxValue: 0, maxUnlimited: false, reservedValue: null, downstreamPolicy: 'strict', source: 'missing', missing: true };
    }
    const override = db.prepare('SELECT * FROM account_limit_overrides WHERE assignment_id=? AND metric_key=?').get(assignment.id, metricKey);

    let maxValue = limit.maximum_value, maxUnlimited = !!limit.maximum_is_unlimited, maxSource = 'package';
    if (override && (override.maximum_override_value != null || override.maximum_override_is_unlimited)) {
      maxValue = override.maximum_override_value; maxUnlimited = !!override.maximum_override_is_unlimited; maxSource = 'override';
    }
    let reservedValue = limit.reserved_value, reservedSource = 'package';
    if (override && override.reserved_override_value != null) { reservedValue = override.reserved_override_value; reservedSource = 'override'; }
    let downstreamPolicy = limit.downstream_allocation_policy, policySource = 'package';
    if (override && override.downstream_policy_override) { downstreamPolicy = override.downstream_policy_override; policySource = 'override'; }

    return {
      maxValue, maxUnlimited, reservedValue, downstreamPolicy,
      source: maxSource, reservedSource, policySource,
      assignmentId: assignment.id, packageId: assignment.package_id,
      packageMaxValue: limit.maximum_value, packageMaxUnlimited: !!limit.maximum_is_unlimited,
      overrideSetByOrgId: override ? override.set_by_org_id : null,
      overrideReason: override ? override.reason : null,
    };
  }

  // ── Meters ───────────────────────────────────────────────────────
  //
  // What an organization is using of a metric. The engine does not know how to
  // measure anything: the product supplies a reader per metric, because what a
  // byte of storage is depends on the product and a generic engine that guesses
  // will guess wrong.
  //
  // Returns a number, or null meaning NOT KNOWN. Null is not zero, and no caller
  // may treat it as zero. A metric with no reader used to fall through to a
  // literal `return 0`, so on a product sold by storage every account reported
  // zero bytes used, for ever, through a live API. A limit checked against that
  // is a limit that passes on no information and looks exactly like one that
  // works.
  async function meterUsage(metricKey, orgIds) {
    const reader = usageReaders[metricKey];
    if (typeof reader !== 'function') return null;
    const value = await reader(orgIds);
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  // Which metrics this deployment can actually measure. A product that registers
  // a metric and supplies no reader for it is misconfigured, and this is how that
  // becomes visible rather than becoming a zero.
  function unmeteredMetrics() {
    return enabledMetrics()
      .filter(m => m.kind !== 'feature' && typeof usageReaders[m.metric_key] !== 'function')
      .map(m => m.metric_key);
  }

  // ── Usage already above the ceiling ─────────────────────────────
  // Written from the places that have just measured, rather than by a pass of
  // its own: admission and the usage report both work out what an organization
  // is using and what it is allowed, and an overage is those two numbers in the
  // wrong order. A separate sweep would be a second opinion on a question that
  // has already been answered, and the two would disagree.
  //
  // Above, not at. An account using exactly its allowance is full, which the
  // ordinary limit already handles; this is for usage the ceiling has come down
  // onto, and calling a full account an overage would report the normal state of
  // every well-fitted package as a fault.
  function observeUsage(orgId, metricKey, periodKey, used, eff) {
    if (!orgId || eff.missing) return null;
    const at = now().toISOString();
    const existing = db.prepare('SELECT * FROM entitlement_overages WHERE org_id=? AND metric_key=? AND period_key=?')
      .get(orgId, metricKey, periodKey);
    // A ceiling that is lifted rather than met ends the overage just as much as
    // usage coming down does. Caught live: clearing the override that caused one
    // left the row open for ever, because the code returned early on an
    // unlimited entitlement and never reached the resolve. An account with no
    // limit cannot be above it.
    if (eff.maxUnlimited) {
      if (existing && existing.status === 'open') {
        db.prepare(`UPDATE entitlement_overages SET status='resolved', resolved_at=?, last_observed_at=?, used_value=?
                     WHERE org_id=? AND metric_key=? AND period_key=?`)
          .run(at, at, used, orgId, metricKey, periodKey);
      }
      return null;
    }
    if (used > eff.maxValue) {
      // `maximum_value_at_detection` keeps the ceiling that was in force when
      // this started, and is deliberately not refreshed while the row stays
      // open: it is what makes an overage readable afterwards as "the package
      // changed under this account" rather than as a number with no history.
      if (existing && existing.status === 'open') {
        db.prepare('UPDATE entitlement_overages SET last_observed_at=?, used_value=? WHERE org_id=? AND metric_key=? AND period_key=?')
          .run(at, used, orgId, metricKey, periodKey);
      } else {
        db.prepare(`INSERT INTO entitlement_overages
            (org_id, metric_key, period_key, status, first_detected_at, last_observed_at, used_value, maximum_value_at_detection, resolved_at)
          VALUES (?,?,?,'open',?,?,?,?,NULL)
          ON CONFLICT(org_id, metric_key, period_key) DO UPDATE SET
            status='open', first_detected_at=excluded.first_detected_at, last_observed_at=excluded.last_observed_at,
            used_value=excluded.used_value, maximum_value_at_detection=excluded.maximum_value_at_detection, resolved_at=NULL`)
          .run(orgId, metricKey, periodKey, at, at, used, eff.maxValue);
      }
      return { open: true, used, maximum: eff.maxValue };
    }
    // Resolved by a fresh reading showing it back inside the ceiling, and only
    // by that. There is no route that closes one by hand, because an overage
    // somebody dismissed is indistinguishable from one that was fixed.
    if (existing && existing.status === 'open') {
      db.prepare(`UPDATE entitlement_overages SET status='resolved', resolved_at=?, last_observed_at=?, used_value=?
                   WHERE org_id=? AND metric_key=? AND period_key=?`)
        .run(at, at, used, orgId, metricKey, periodKey);
    }
    return null;
  }

  // Ask the question of every metric at once, for the moment a ceiling moves
  // rather than the moment somebody next tries to create something. A downgrade
  // that nobody acts on for a fortnight is still an overage from the day it was
  // accepted, and a record that only appears when the account next tries to grow
  // would date it wrongly and tell nobody in between.
  async function observeOverages(orgId, periodKey = 'current') {
    const found = [];
    for (const metric of enabledMetrics()) {
      const eff = effectiveEntitlement(orgId, metric.metric_key);
      if (eff.missing) continue;
      // An unlimited metric is only worth measuring if there is an open row to
      // close. Metering every metric on every observation to find out that
      // nothing was ever wrong would put a `du` behind a screen refresh.
      if (eff.maxUnlimited) {
        const open = db.prepare("SELECT 1 FROM entitlement_overages WHERE org_id=? AND metric_key=? AND period_key=? AND status='open'")
          .get(orgId, metric.metric_key, periodKey);
        if (!open) continue;
      }
      // A measurement that is not usable decides nothing, in either direction.
      // Opening an overage on an unknown number would be an accusation, and
      // resolving one on it would be a pardon; both are the same mistake as
      // letting a stale reading pass an admission check.
      const used = await meterUsage(metric.metric_key, getSubtreeOrgIds(orgId));
      // An unknown measurement decides nothing, in either direction. Opening an
      // overage on it would be an accusation and closing one would be a pardon,
      // and both are the same mistake as letting an unknown number pass a limit.
      if (used === null) continue;
      const hit = observeUsage(orgId, metric.metric_key, periodKey, used, eff);
      if (hit) found.push({ metric: metric.metric_key, ...hit });
    }
    return found;
  }

  function listOverages(orgId, { includeResolved = false } = {}) {
    return db.prepare(`SELECT * FROM entitlement_overages WHERE org_id=?${includeResolved ? '' : " AND status='open'"}
                        ORDER BY first_detected_at`).all(orgId);
  }

  // ── Admission ────────────────────────────────────────────────────
  // The one question everything else exists to answer: can `targetOrgId`
  // absorb `delta` more of `metricKey` right now. Checks the target and
  // every ancestor up to root, exactly the spec's subtree-consumption rule,
  // and folds in active pending holds so two concurrent proposals against
  // the same headroom cannot both pass.
  function activeHoldTotal(orgId, metricKey, periodKey) {
    const row = db.prepare(`SELECT COALESCE(SUM(delta_value),0) AS n FROM entitlement_pending_holds
      WHERE target_org_id=? AND metric_key=? AND period_key=? AND state IN ('active','awaiting_reconcile') AND expires_at > ?`)
      .get(orgId, metricKey, periodKey, now().toISOString());
    return row.n;
  }

  async function checkCapacity(targetOrgId, metricKey, delta, periodKey = 'current') {
    // A negative delta is something being given back, and cleanup is never
    // blocked. A zero delta is a gate rather than a reservation: "this must
    // not run while the account is already over", which is the only honest
    // shape for storage, since nothing can say in advance how many bytes a
    // file upload is about to cost.
    if (delta < 0) return { ok: true };
    const chainOrgs = [targetOrgId, ...getAncestorChain(targetOrgId)];
    for (const orgId of chainOrgs) {
      const eff = effectiveEntitlement(orgId, metricKey);
      if (eff.missing) return { ok: false, code: 'ENTITLEMENT_ASSIGNMENT_MISSING', orgId };
      if (eff.maxUnlimited) continue;
      // Measured metrics have to say how old the measurement is before the
      // number is allowed to decide anything. A stale or failed reading means
      // the answer is unknown, and unknown refuses rather than passes: the
      // caller can refresh and try again, which is a delay, where waving it
      // through is a limit that silently does not work.
      const used = await meterUsage(metricKey, getSubtreeOrgIds(orgId));
      // Unknown usage refuses. It is the same rule as a stale disk reading in the
      // panel this engine came from, generalised: if nothing can say how much is
      // being used, a limit checked against it decides nothing, and passing is
      // indistinguishable from a limit that works right up until the bill.
      //
      // Refusing is a delay the caller can fix by measuring. Passing is a ceiling
      // that quietly does not exist.
      if (used === null) {
        return {
          ok: false, code: 'USAGE_UNKNOWN', orgId, metric: metricKey, maximum: eff.maxValue,
          reason: `Nothing on this deployment measures ${metricKey}, so its limit cannot be enforced.`,
        };
      }
      const holds = activeHoldTotal(orgId, metricKey, periodKey);
      // Recorded here because the numbers are already in hand, and recorded on
      // the way past whether or not this operation is about to be refused: an
      // account can be over its ceiling on one metric while proposing something
      // that touches another, and the row should not wait for a coincidence.
      const overage = observeUsage(orgId, metricKey, periodKey, used, eff);
      // A gate and a reservation read the limit differently, and getting this
      // wrong is quiet. Reserving one more asks whether there is room for it,
      // so exactly at the limit is fine until the reservation tips it over. A
      // gate asks whether the account is already using everything it is
      // allowed, so exactly at the limit is already spent: a budget used to
      // the last penny must stop the next call, not wave one more through
      // because it has not technically exceeded anything yet.
      const over = delta === 0 ? used + holds >= eff.maxValue : used + holds + delta > eff.maxValue;
      if (over) {
        // Two different refusals, said differently on purpose. "This would take
        // you past your limit" is a full account being told to stop, and the
        // way out is to buy more or use less. "You are already above your
        // limit" is an account whose ceiling moved underneath it, where nothing
        // it has is at risk and only growth is barred, and being told the first
        // sentence when the second is true is how somebody concludes their
        // service is about to be switched off. An ancestor still says only that
        // provider capacity is unavailable, because naming a reseller's own
        // overage to its customer discloses the reseller's business.
        return {
          ok: false,
          code: orgId !== targetOrgId ? 'PROVIDER_CAPACITY_UNAVAILABLE'
            : overage ? 'ENTITLEMENT_OVERAGE_BLOCKED' : 'ENTITLEMENT_LIMIT_EXCEEDED',
          orgId, used, holds, delta, maximum: eff.maxValue,
          ...(overage ? { overage: true } : {}),
        };
      }
    }
    return { ok: true };
  }

  // Runs the check and, if it passes, records a hold under the same lock so
  // no other proposal can spend the same headroom before this one either
  // executes or is rejected. Returns { ok:false, ... } without creating a
  // hold on refusal.
  // `createProposal` runs the actual proposal creation (actionStore.enqueue),
  // called from inside the lock, only once capacity is confirmed available,
  // and its returned id is what the holds are keyed to. This closes the race
  // window a two-step "check, then separately create a hold for an id you
  // get back later" design would leave open: nothing else can run between
  // "capacity is available" and "the hold now exists," because both happen
  // inside the same link of the lock chain.
  async function admitProposal(targetOrgId, effects, createProposal, periodKey = 'current') {
    return withLock(async () => {
      for (const effect of effects) {
        if (effect.delta < 0) continue;
        const result = await checkCapacity(targetOrgId, effect.metric, effect.delta, periodKey);
        if (!result.ok) return { ...result, metric: effect.metric };
      }
      const proposal = await createProposal();
      const expires = new Date(now().getTime() + 15 * 60 * 1000).toISOString();
      const insert = db.prepare(`INSERT OR REPLACE INTO entitlement_pending_holds
        (id, proposal_id, target_org_id, metric_key, period_key, delta_value, state, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const effect of effects) {
        if (effect.delta <= 0) continue;
        insert.run(id('hold'), proposal.id, targetOrgId, effect.metric, periodKey, effect.delta, 'active', now().toISOString(), expires);
      }
      return { ok: true, proposal };
    });
  }

  function releaseHolds(proposalId, { reason = 'released' } = {}) {
    db.prepare(`UPDATE entitlement_pending_holds SET state='released', released_at=?, release_reason=? WHERE proposal_id=? AND state='active'`)
      .run(now().toISOString(), reason, proposalId);
  }

  // ── Assignment ───────────────────────────────────────────────────
  // No withLock here: everything below is synchronous SQL with no `await`,
  // so `db.transaction()` alone already gives it full atomicity under
  // better-sqlite3's single-threaded synchronous execution — wrapping it in
  // the async lock as well only turned this into a function that silently
  // returned a Promise instead of its result to any caller that forgot to
  // await it, found by the unit tests catching a `{}` where a real
  // assignment id belonged.
  function assignPackage({ parentOrgId, targetOrgId, packageId, actorIdentityId }) {
    {
      const directParent = getDirectParent(targetOrgId);
      if (directParent !== parentOrgId) throw entitlementError(`${targetOrgId} is not a direct child of ${parentOrgId}`, 'TARGET_NOT_DIRECT_CHILD');
      const pkg = getPackage(packageId);
      if (!pkg || pkg.status !== 'active' || pkg.owner_org_id !== parentOrgId) throw entitlementError('That package is not active and owned by this organization', 'PACKAGE_NOT_OWNED_BY_PARENT');

      const tx = db.transaction(() => {
        for (const limit of pkg.limits) {
          assertWithinParentAllocation({
            parentOrgId,
            targetOrgId,
            metricKey: limit.metric_key,
            proposedValue: limit.maximum_is_unlimited ? null : limit.maximum_value,
            proposedUnlimited: !!limit.maximum_is_unlimited,
          });
        }

        const previous = db.prepare(`SELECT id FROM account_package_assignments WHERE target_org_id=? AND status='active'`).get(targetOrgId);
        const newId = id('asn');
        if (previous) db.prepare(`UPDATE account_package_assignments SET status='superseded', superseded_at=?, superseded_by_assignment_id=? WHERE id=?`)
          .run(now().toISOString(), newId, previous.id);
        db.prepare(`INSERT INTO account_package_assignments (id, parent_org_id, target_org_id, package_id, status, assigned_at, assigned_by_identity_id) VALUES (?,?,?,?,?,?,?)`)
          .run(newId, parentOrgId, targetOrgId, packageId, 'active', now().toISOString(), actorIdentityId);
        return newId;
      });
      return { assignmentId: tx() };
    }
  }

  // ── The allocation ceiling, in one place ─────────────────────────
  //
  // One rule: an organization can never promise its children more than it holds
  // itself, unless whoever provides for it deliberately turned overselling on
  // for that metric.
  //
  // `assignPackage` enforced this and `setOverride` did not, which made the
  // override the way around it: a reseller holding ten seats could override
  // one customer to five hundred and the books stopped balancing from there
  // down. Found by a hostile run rather than by reading, because both paths
  // looked right on their own. They share this now, so neither can drift from
  // the other.
  //
  // Siblings are counted at their *effective* maximum rather than at their
  // package's, so an override already granted to one child counts against what
  // is left for the next. Counting the package value alone was the same hole
  // one level along.
  function assertWithinParentAllocation({ parentOrgId, targetOrgId, metricKey, proposedValue, proposedUnlimited }) {
    if (!parentOrgId) return; // no provider above: the entitlement root
    // Capacity is divided; a capability is not. Ten resellers may all switch
    // watermarking on without anybody running out of watermarking, and running
    // the allocation arithmetic over an on/off row produces refusals that mean
    // nothing ("more than the 1 this account holds") for a metric that is not a
    // quantity of anything.
    if (isFeatureMetric(metricKey)) return;
    const parentEff = effectiveEntitlement(parentOrgId, metricKey);

    if (proposedUnlimited) {
      if (!parentEff.maxUnlimited) {
        throw entitlementError(`Cannot grant unlimited ${metricKey} under a finite parent`, 'ALLOCATION_LIMIT_EXCEEDED');
      }
      return;
    }
    if (parentEff.maxUnlimited) return;
    if (parentEff.downstreamPolicy === 'usage_based') return;

    const siblings = db.prepare(
      `SELECT child_org_id FROM organization_accounts WHERE parent_org_id=? AND status='active' AND child_org_id<>?`
    ).all(parentOrgId, targetOrgId).map(r => r.child_org_id);

    let allocated = Number(proposedValue) || 0;
    for (const sibling of siblings) {
      const eff = effectiveEntitlement(sibling, metricKey);
      if (eff.missing) continue; // nothing assigned yet allocates nothing
      if (eff.maxUnlimited) {
        throw entitlementError('A sibling already has an unlimited allocation', 'ALLOCATION_LIMIT_EXCEEDED');
      }
      allocated += Number(eff.maxValue) || 0;
    }
    if (allocated > Number(parentEff.maxValue)) {
      throw entitlementError(
        `That would allocate ${allocated} ${metricKey}, more than the ${parentEff.maxValue} this account holds`,
        'ALLOCATION_LIMIT_EXCEEDED');
    }
  }

  function setOverride({ targetOrgId, metricKey, fields, reason, actorOrgId, actorIdentityId }) {
    const assignment = db.prepare(`SELECT * FROM account_package_assignments WHERE target_org_id=? AND status='active'`).get(targetOrgId);
    if (!assignment) throw entitlementError('No active package assignment to override', 'ENTITLEMENT_ASSIGNMENT_MISSING');
    const existing = db.prepare('SELECT * FROM account_limit_overrides WHERE assignment_id=? AND metric_key=?').get(assignment.id, metricKey);
    if (existing && existing.set_by_org_id !== actorOrgId && !getAncestorChain(existing.set_by_org_id).includes(actorOrgId) && existing.set_by_org_id !== actorOrgId) {
      // The actor may replace an override only if they are the current
      // setter or an ancestor of the current setter's organization.
      if (!getAncestorChain(existing.set_by_org_id).includes(actorOrgId)) {
        throw entitlementError('This override was set by an ancestor and cannot be changed from here', 'OVERRIDE_LOCKED_BY_ANCESTOR');
      }
    }
    // An override that is neither unlimited nor a number is not an override,
    // it is a row that looks like one. Written, it reads back as "no override
    // set" and the caller is told the change succeeded, which is how a limit
    // ends up not applying while the panel shows that it does. Caught live: a
    // route passed the wrong field shape and got a 200 for doing nothing.
    if (!fields || !fields.maximum || (!fields.maximum.unlimited && !Number.isFinite(Number(fields.maximum.value)))) {
      throw entitlementError('An override needs either a number or unlimited', 'OVERRIDE_VALUE_MISSING');
    }
    // The ceiling, checked before the row is written rather than after. An
    // override is a grant like any other and is bounded by what the account's
    // own provider holds.
    assertWithinParentAllocation({
      parentOrgId: getDirectParent(targetOrgId),
      targetOrgId,
      metricKey,
      proposedValue: fields.maximum.unlimited ? null : Number(fields.maximum.value),
      proposedUnlimited: !!fields.maximum.unlimited,
    });
    const stamp = now().toISOString();
    db.prepare(`INSERT INTO account_limit_overrides
        (assignment_id, metric_key, maximum_override_value, maximum_override_is_unlimited, reserved_override_value, downstream_policy_override, reason, set_by_org_id, set_by_identity_id, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(assignment_id, metric_key) DO UPDATE SET
        maximum_override_value=excluded.maximum_override_value,
        maximum_override_is_unlimited=excluded.maximum_override_is_unlimited,
        reserved_override_value=excluded.reserved_override_value,
        downstream_policy_override=excluded.downstream_policy_override,
        reason=excluded.reason, set_by_org_id=excluded.set_by_org_id, set_by_identity_id=excluded.set_by_identity_id,
        updated_at=excluded.updated_at`)
      .run(assignment.id, metricKey,
        fields.maximum?.unlimited ? null : (fields.maximum?.value ?? null), fields.maximum?.unlimited ? 1 : 0,
        fields.reserved ?? null, fields.downstreamPolicy || null,
        reason, actorOrgId, actorIdentityId, stamp, stamp);
    return effectiveEntitlement(targetOrgId, metricKey);
  }

  function clearOverride({ targetOrgId, metricKey, actorOrgId }) {
    const assignment = db.prepare(`SELECT * FROM account_package_assignments WHERE target_org_id=? AND status='active'`).get(targetOrgId);
    if (!assignment) return;
    const existing = db.prepare('SELECT * FROM account_limit_overrides WHERE assignment_id=? AND metric_key=?').get(assignment.id, metricKey);
    if (existing && existing.set_by_org_id !== actorOrgId && !getAncestorChain(existing.set_by_org_id).includes(actorOrgId)) {
      throw entitlementError('This override was set by an ancestor and cannot be cleared from here', 'OVERRIDE_LOCKED_BY_ANCESTOR');
    }
    db.prepare('DELETE FROM account_limit_overrides WHERE assignment_id=? AND metric_key=?').run(assignment.id, metricKey);
    return effectiveEntitlement(targetOrgId, metricKey);
  }

  // ── Read API shape ──────────────────────────────────────────────
  async function usageReport(orgId) {
    const subtree = getSubtreeOrgIds(orgId);
    const out = [];
    for (const m of enabledMetrics()) {
      const eff = effectiveEntitlement(orgId, m.metric_key);
      const used = eff.missing ? 0 : await meterUsage(m.metric_key, subtree);
      const holds = activeHoldTotal(orgId, m.metric_key, 'current');
      // The report is a measurement too, so it opens and closes overage rows
      // like admission does. Reading the panel is the most likely moment for an
      // account to be looked at after a downgrade, and a screen that shows the
      // usage without writing down what it saw is a screen that knows something
      // the record does not.
      const overage = eff.missing ? null : observeUsage(orgId, m.metric_key, 'current', used, eff);
      out.push({
        metric: m.metric_key, unit: m.unit, kind: m.kind,
        maximum_allowed: eff.maxUnlimited ? { value: null, unlimited: true, source: eff.source } : { value: eff.maxValue, unlimited: false, source: eff.source },
        // Why this account has a number of its own, where it has one. The reason
        // is required at the moment an override is written, for the sake of
        // somebody asking a year later — and a required field that no reading
        // ever returns is the audit trail's mistake made a second time: the
        // expensive half built, the useful half missing.
        override_reason: eff.source === 'override' ? (eff.overrideReason || null) : null,
        actually_used: { subtree: used },
        pending_holds: holds,
        headroom: eff.maxUnlimited ? null : Math.max(0, eff.maxValue - used - holds),
        downstream_allocation_policy: eff.downstreamPolicy,
        missing_assignment: !!eff.missing,
        // Said in full rather than left to be inferred from used > maximum,
        // because the two rules that apply here are the part a person needs and
        // neither of them is visible in a pair of numbers.
        over_limit: overage ? {
          used: overage.used,
          maximum: overage.maximum,
          growth_blocked: true,
          existing_service_kept: true,
          since: (db.prepare('SELECT first_detected_at FROM entitlement_overages WHERE org_id=? AND metric_key=? AND period_key=?')
            .get(orgId, m.metric_key, 'current') || {}).first_detected_at || null,
        } : null,
      });
    }
    return out;
  }

  function entitlementError(message, code) {
    const error = new Error(message);
    error.entitlementCode = code;
    return error;
  }

  return {
    markRoot, isRoot, getDirectParent, getSubtreeOrgIds, getAncestorChain, linkOrganizations, endOrganizationLink,
    createPackage, getPackage, archivePackage, countActiveAssignments, effectiveEntitlement, assignPackage, setOverride, clearOverride,
    checkCapacity, admitProposal, releaseHolds, usageReport, meterUsage, enabledMetrics,
    isFeatureMetric, metricDefault,
    observeOverages, listOverages,
    monthKey, unmeteredMetrics,
  };
}

module.exports = { createEntitlementsService };
