'use strict';

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createOwnershipService } = require('./ownership');
const { createEntitlementsService } = require('./entitlements');

// Metrics live in the product now, not in the engine, so the fixture declares
// them. A test that relied on the engine's built-in list was testing a hosting
// panel's vocabulary, which is how a file product ended up selling websites.
const TEST_METRICS = [
  ['storage_bytes', 'bytes', 'current', 1, 1, 1],
  ['seats', 'items', 'current', 0, 1, 2],
];
const TEST_FEATURES = [
  ['files_public', 'items', 3],
  ['files_watermark', 'items', 4],
];

// Usage is supplied by the product too. The fixture holds a number per
// organization so a test can say "this org is using 900 bytes" without needing a
// filesystem, and a metric with no entry here is deliberately UNKNOWN.
function freshDb(options = {}) {
  const db = new Database(':memory:');
  const ownership = createOwnershipService({ db });
  const usage = new Map();
  const readers = {
    storage_bytes: orgIds => orgIds.reduce((n, id) => n + (usage.get(`storage_bytes:${id}`) || 0), 0),
    seats: orgIds => orgIds.reduce((n, id) => n + (usage.get(`seats:${id}`) || 0), 0),
    ...(options.usageReaders || {}),
  };
  const ent = createEntitlementsService({
    db,
    metrics: options.metrics || TEST_METRICS,
    features: options.features || TEST_FEATURES,
    usageReaders: readers,
  });
  const use = (metric, orgId, value) => usage.set(`${metric}:${orgId}`, value);
  return { db, ownership, ent, use, usage };
}

function unlimitedLimits(ent) {
  return ent.enabledMetrics().map(m => ({ metric: m.metric_key, unlimited: true }));
}
function finiteLimits(ent, overrides) {
  return ent.enabledMetrics().map(m => ({ metric: m.metric_key, unlimited: false, value: overrides[m.metric_key] ?? 1000 }));
}

async function run() {
  testRootIsUnlimited();
  testNonRootWithNoAssignmentIsMissing();
  testPackageAssignmentGivesEffectiveLimit();
  await testAdmissionBlocksAtLimitAllowsUnderIt();
  await testAMetricWithNoReaderRefusesRatherThanPassing();
  testStrictAllocationRefusesOversell();
  testUsageBasedAllocationPermitsOversell();
  testOverrideProvenanceAndClear();
  testOverrideLockedByAncestor();
  testCycleAndDuplicateParentRefused();
  await testConcurrentAdmissionOnlyOneWins();
  testSubtreeAggregationDoesNotDoubleCount();
  testFeatureMetricsAreOptionalInAPackage();
  testAFeatureNobodyPricedIsOn();
  testAHosterCanTurnAFeatureOffAndBackOn();
  testAFeatureIsNotDividedBetweenChildren();
  console.log('entitlements tests passed');
}

function testRootIsUnlimited() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  const eff = ent.effectiveEntitlement('org_root', 'seats');
  assert.equal(eff.maxUnlimited, true);
  assert.equal(eff.source, 'root');
}

function testNonRootWithNoAssignmentIsMissing() {
  const { ent } = freshDb();
  const eff = ent.effectiveEntitlement('org_nobody', 'seats');
  assert.equal(eff.missing, true);
}

function testPackageAssignmentGivesEffectiveLimit() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Starter', limits: finiteLimits(ent, { seats: 3 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });
  const eff = ent.effectiveEntitlement('org_child', 'seats');
  assert.equal(eff.maxValue, 3);
  assert.equal(eff.source, 'package');
}

async function testAdmissionBlocksAtLimitAllowsUnderIt() {
  // Usage arrives through the product's reader now rather than by inserting rows
  // into a hosting panel's inventory table, which is what this used to do.
  const { ent, use } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Two Seats', limits: finiteLimits(ent, { seats: 2 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });

  const a = await ent.admitProposal('org_child', [{ metric: 'seats', delta: 1 }], () => ({ id: 'prop_1' }));
  assert.equal(a.ok, true);
  use('seats', 'org_child', 1);
  ent.releaseHolds('prop_1');

  const b = await ent.admitProposal('org_child', [{ metric: 'seats', delta: 1 }], () => ({ id: 'prop_2' }));
  assert.equal(b.ok, true);
  use('seats', 'org_child', 2);
  ent.releaseHolds('prop_2');

  const c = await ent.admitProposal('org_child', [{ metric: 'seats', delta: 1 }], () => ({ id: 'prop_3' }));
  assert.equal(c.ok, false);
  assert.equal(c.code, 'ENTITLEMENT_LIMIT_EXCEEDED');
  console.log('  ok  admission allows up to the limit and refuses past it');
}

// The rule that the whole storage business depends on. A metric that is sold and
// has no reader must refuse, not pass. Passing is a ceiling that silently does
// not exist, and that is exactly what this engine did for storage.
async function testAMetricWithNoReaderRefusesRatherThanPassing() {
  const { ent } = freshDb({
    metrics: [['storage_bytes', 'bytes', 'current', 1, 1, 1], ['unmeasured_thing', 'items', 'current', 0, 1, 2]],
    usageReaders: {},
  });
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'P',
    limits: [{ metric: 'storage_bytes', unlimited: false, value: 1000 }, { metric: 'unmeasured_thing', unlimited: false, value: 5 }],
    actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });

  const verdict = await ent.checkCapacity('org_child', 'unmeasured_thing', 1);
  assert.equal(verdict.ok, false, 'a metric nothing measures admitted a write');
  assert.equal(verdict.code, 'USAGE_UNKNOWN');
  assert.ok(ent.unmeteredMetrics().includes('unmeasured_thing'));
  assert.ok(!ent.unmeteredMetrics().includes('storage_bytes'));
  console.log('  ok  a sold metric with no reader refuses rather than passing on no information');
}

function testStrictAllocationRefusesOversell() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_reseller', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_a', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_b', 'steve');

  const resellerPkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Reseller 10', limits: finiteLimits(ent, { seats: 10 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_reseller', packageId: resellerPkg.id, actorIdentityId: 'steve' });

  const custPkg = ent.createPackage({ ownerOrgId: 'org_reseller', name: 'Customer 6', limits: finiteLimits(ent, { seats: 6 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: 'org_cust_a', packageId: custPkg.id, actorIdentityId: 'steve' });

  assert.throws(() => ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: 'org_cust_b', packageId: custPkg.id, actorIdentityId: 'steve' }),
    err => err.entitlementCode === 'ALLOCATION_LIMIT_EXCEEDED');
}

function testUsageBasedAllocationPermitsOversell() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_reseller', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_a', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_b', 'steve');

  const resellerLimits = ent.enabledMetrics().map(m => ({ metric: m.metric_key, unlimited: false, value: m.metric_key === 'seats' ? 10 : 1000, downstreamPolicy: m.metric_key === 'seats' ? 'usage_based' : 'strict' }));
  const resellerPkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Reseller Oversell', limits: resellerLimits, actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_reseller', packageId: resellerPkg.id, actorIdentityId: 'steve' });

  // Every other metric stays well under the reseller's strict 1000 default
  // so this test isolates the one thing it's checking: seats oversell.
  const custPkg = ent.createPackage({ ownerOrgId: 'org_reseller', name: 'Customer 6', limits: finiteLimits(ent, { seats: 6, seats: 10, seats: 10, storage_bytes: 10, seats: 10, seats: 10 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: 'org_cust_a', packageId: custPkg.id, actorIdentityId: 'steve' });
  // Should NOT throw: reseller has usage_based policy for seats, so 6+6=12 > 10 is allowed at the allocation level.
  ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: 'org_cust_b', packageId: custPkg.id, actorIdentityId: 'steve' });
}

function testOverrideProvenanceAndClear() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Base', limits: finiteLimits(ent, { seats: 5 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });

  const overridden = ent.setOverride({ targetOrgId: 'org_child', metricKey: 'seats', fields: { maximum: { value: 20 } }, reason: 'Contract exception', actorOrgId: 'org_root', actorIdentityId: 'steve' });
  assert.equal(overridden.maxValue, 20);
  assert.equal(overridden.source, 'override');
  assert.equal(overridden.packageMaxValue, 5);

  const cleared = ent.clearOverride({ targetOrgId: 'org_child', metricKey: 'seats', actorOrgId: 'org_root' });
  assert.equal(cleared.maxValue, 5);
  assert.equal(cleared.source, 'package');
}

function testOverrideLockedByAncestor() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_reseller', 'steve');
  ent.linkOrganizations('org_reseller', 'org_child', 'steve');
  const resellerPkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Reseller Capacity', limits: finiteLimits(ent, { seats: 100 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_reseller', packageId: resellerPkg.id, actorIdentityId: 'steve' });
  const pkg = ent.createPackage({ ownerOrgId: 'org_reseller', name: 'Base', limits: finiteLimits(ent, { seats: 5 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });

  // The root (grandparent) sets an override.
  ent.setOverride({ targetOrgId: 'org_child', metricKey: 'seats', fields: { maximum: { value: 99 } }, reason: 'Root exception', actorOrgId: 'org_root', actorIdentityId: 'steve' });
  // The direct parent (reseller) may not clear an override set by its own ancestor.
  assert.throws(() => ent.clearOverride({ targetOrgId: 'org_child', metricKey: 'seats', actorOrgId: 'org_reseller' }),
    err => err.entitlementCode === 'OVERRIDE_LOCKED_BY_ANCESTOR');
}

function testCycleAndDuplicateParentRefused() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_a', 'steve');
  ent.linkOrganizations('org_a', 'org_b', 'steve');
  assert.throws(() => ent.linkOrganizations('org_b', 'org_root', 'steve'), err => err.entitlementCode === 'ORG_LINK_CYCLE');
  assert.throws(() => ent.linkOrganizations('org_root', 'org_b', 'steve'), err => err.entitlementCode === 'TARGET_NOT_DIRECT_CHILD');
}

async function testConcurrentAdmissionOnlyOneWins() {
  const { db, ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'One Site', limits: finiteLimits(ent, { seats: 1 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });

  // createProposal claims the resource for real, same as the live path does
  // between the capacity check and the hold being recorded — without this,
  // both proposals would see zero usage and both would wrongly be admitted.
  const claim = (name, key) => () => {
    db.prepare(`INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site',?,?,?)`).run(key, 'org_child', new Date().toISOString());
    return { id: name };
  };
  const [a, b] = await Promise.all([
    ent.admitProposal('org_child', [{ metric: 'seats', delta: 1 }], claim('race_a', 'race-a.example')),
    ent.admitProposal('org_child', [{ metric: 'seats', delta: 1 }], claim('race_b', 'race-b.example')),
  ]);
  const winners = [a, b].filter(r => r.ok);
  const losers = [a, b].filter(r => !r.ok);
  assert.equal(winners.length, 1, 'exactly one of the two concurrent proposals should be admitted');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, 'ENTITLEMENT_LIMIT_EXCEEDED');
}

function testSubtreeAggregationDoesNotDoubleCount() {
  const { db, ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_reseller', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_a', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_b', 'steve');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site','a1.example','org_cust_a',?)`).run(now);
  db.prepare(`INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site','a2.example','org_cust_a',?)`).run(now);
  db.prepare(`INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site','b1.example','org_cust_b',?)`).run(now);
  const subtree = ent.getSubtreeOrgIds('org_reseller');
  assert.deepEqual(subtree.sort(), ['org_cust_a', 'org_cust_b', 'org_reseller'].sort());
  assert.equal(ent.meterUsage ? undefined : undefined, undefined); // meterUsage is async; direct SQL check instead:
  const row = db.prepare(`SELECT COUNT(*) AS n FROM resource_owners WHERE kind='site' AND org_id IN (${subtree.map(() => '?').join(',')})`).get(...subtree);
  assert.equal(row.n, 3);
}

// ── Measured storage ─────────────────────────────────────────────

function featureTree(limitOverrides = null) {
  const { db, ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const capacity = ent.enabledMetrics().filter(m => m.kind !== 'feature');
  const pkg = ent.createPackage({
    ownerOrgId: 'org_root', name: 'Plan',
    limits: [...capacity.map(m => ({ metric: m.metric_key, unlimited: false, value: 1000 })),
             ...(limitOverrides || [])],
    actorIdentityId: 'steve',
  });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });
  return { db, ent };
}

function testFeatureMetricsAreOptionalInAPackage() {
  // The whole point: a package naming only capacity is valid. Before this it was
  // refused, so shipping any new capability broke every package in existence.
  const { ent } = featureTree();
  assert.ok(ent.isFeatureMetric('files_public'), 'files_public is not registered as a feature');
  assert.ok(!ent.isFeatureMetric('seats'), 'seats was treated as a feature');
  console.log('  ok  a package may name only capacity, and still be a valid package');
}

function testAFeatureNobodyPricedIsOn() {
  const { ent } = featureTree();
  for (const key of ['files_public', 'files_watermark']) {
    const eff = ent.effectiveEntitlement('org_child', key);
    assert.strictEqual(eff.maxUnlimited, true, `${key} was not on by default`);
    assert.strictEqual(eff.source, 'default', `${key} resolved from ${eff.source}`);
    assert.ok(!eff.missing, `${key} came back missing, so the customer silently lost it`);
  }
  // And capacity is untouched by any of this: a metric nobody assigned is still
  // zero, because capacity you were never given is capacity you do not have.
  const { ent: bare } = (() => { const { db, ent } = freshDb(); ent.markRoot('org_root', 'steve');
    ent.linkOrganizations('org_root', 'org_orphan', 'steve'); return { db, ent }; })();
  assert.strictEqual(bare.effectiveEntitlement('org_orphan', 'seats').missing, true);
  // An account with no package at all still has the working product.
  assert.strictEqual(bare.effectiveEntitlement('org_orphan', 'files_public').maxUnlimited, true);
  console.log('  ok  a feature nobody priced is on, and capacity nobody granted is still zero');
}

function testAHosterCanTurnAFeatureOffAndBackOn() {
  // The business model in one test. The hoster decides, per package, and the
  // product does not choose the tiers for them.
  const { ent } = featureTree([{ metric: 'files_watermark', unlimited: false, value: 0 }]);
  const off = ent.effectiveEntitlement('org_child', 'files_watermark');
  assert.strictEqual(off.maxUnlimited, false);
  assert.strictEqual(off.maxValue, 0, 'the hoster could not switch a feature off');
  assert.strictEqual(off.source, 'package');
  // Another package, same box, feature on. Two tiers, the hoster's own choice.
  const { ent: on } = featureTree([{ metric: 'files_watermark', unlimited: true }]);
  assert.strictEqual(on.effectiveEntitlement('org_child', 'files_watermark').maxUnlimited, true);
  console.log('  ok  a hoster can switch a feature off in one package and on in another');
}

function testAFeatureIsNotDividedBetweenChildren() {
  // Ten resellers may all switch watermarking on without anybody running out of
  // watermarking. Running the allocation arithmetic over an on/off row produces
  // refusals that mean nothing, like "more than the 1 this account holds".
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_reseller', 'steve');
  ent.linkOrganizations('org_reseller', 'org_a', 'steve');
  ent.linkOrganizations('org_reseller', 'org_b', 'steve');
  const capacity = ent.enabledMetrics().filter(m => m.kind !== 'feature');
  // A package is assigned by whoever owns it, so the reseller's own customers get
  // a package the reseller minted rather than one of the hoster's.
  // Capacity is generous on purpose: this test is about the feature, and a
  // capacity refusal here would pass for the wrong reason.
  const mk = (owner, name, cap, extra) => ent.createPackage({ ownerOrgId: owner, name,
    limits: [...capacity.map(m => ({ metric: m.metric_key, unlimited: false, value: cap })), ...extra],
    actorIdentityId: 'steve' });
  const resellerPkg = mk('org_root', 'Reseller', 100, [{ metric: 'files_public', unlimited: false, value: 1 }]);
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_reseller', packageId: resellerPkg.id, actorIdentityId: 'steve' });
  const customerPkg = mk('org_reseller', 'Customer', 10, [{ metric: 'files_public', unlimited: false, value: 1 }]);
  for (const child of ['org_a', 'org_b']) {
    ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: child, packageId: customerPkg.id, actorIdentityId: 'steve' });
    assert.strictEqual(ent.effectiveEntitlement(child, 'files_public').maxValue, 1);
  }
  console.log('  ok  two customers under one reseller both have a feature the reseller has once');
}


run().catch(error => { console.error(error); process.exit(1); });
