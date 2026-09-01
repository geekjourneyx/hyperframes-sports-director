import assert from 'node:assert/strict';
import test from 'node:test';

import { loadProfile, resolvePolicies } from '../lib/profiles.mjs';

const SPORT_IDS = [
  'cycling',
  'hiking',
  'pool-swimming',
  'running',
  'technical-mountaineering',
  'trail-running',
  'open-water-swimming',
];
const SPORT_POLICY_KEYS = [
  'journeyGrammar',
  'cameraRoleWeights',
  'speedPolicy',
  'stabilizationPolicy',
  'duplicatePolicy',
  'audioPolicy',
  'dataPolicy',
  'visualPolicy',
];

const expectedMaturity = new Map([
  ['cycling', 'release-grade'],
  ['hiking', 'release-grade'],
  ['pool-swimming', 'release-grade'],
  ['running', 'experimental'],
  ['technical-mountaineering', 'experimental'],
  ['trail-running', 'experimental'],
  ['open-water-swimming', 'experimental'],
]);

for (const id of SPORT_IDS) {
  test(`sport profile ${id} exposes the shared policy contract`, async () => {
    const profile = await loadProfile('sport', id);

    assert.equal(profile.maturity, expectedMaturity.get(id));
    assert.deepEqual(Object.keys(profile.policies).sort(), [...SPORT_POLICY_KEYS].sort());
    if (id === 'technical-mountaineering') {
      assert.deepEqual(profile.policies.speedPolicy.rejectedTreatments, ['risk_obscuring']);
    }
    if (id === 'pool-swimming') {
      assert.equal(profile.policies.dataPolicy.gps.required, false);
      assert.ok(profile.policies.journeyGrammar.continuityRequirements.includes('lap-turn'));
    }
    if (id === 'open-water-swimming') {
      assert.deepEqual(profile.policies.dataPolicy.gps, { permitted: true, required: false });
    }
  });
}

test('sport composition applies comparative pacing and release-grade maturity boundaries', async () => {
  const cycling = await loadProfile('sport', 'cycling');
  const hiking = await loadProfile('sport', 'hiking');
  assert.ok(cycling.policies.speedPolicy.maximumMontageRate > hiking.policies.speedPolicy.maximumMontageRate);

  for (const id of ['running', 'technical-mountaineering', 'trail-running', 'open-water-swimming']) {
    assert.throws(
      () => resolvePolicies({ sport: id, device: 'dji-osmo-action-5-pro', delivery: 'landscape-1080p', requiredMaturity: 'release-grade' }),
      (error) => error.code === 'E_PROFILE_MATURITY' && error.profile === id && error.requiredMaturity === 'release-grade',
    );
  }
});

test('device profile is loaded as a documented policy namespace', async () => {
  const device = await loadProfile('device', 'dji-osmo-action-5-pro');

  assert.equal(device.id, 'dji-osmo-action-5-pro');
  assert.deepEqual(Object.keys(device.policies), ['capturePolicy']);
  assert.equal(device.policies.capturePolicy.primaryCapture, true);
});

for (const [id, raster] of [
  ['landscape-4k', { width: 3840, height: 2160 }],
  ['landscape-1080p', { width: 1920, height: 1080 }],
]) {
  test(`delivery profile ${id} declares its exact 16:9 raster`, async () => {
    const delivery = await loadProfile('delivery', id);

    assert.deepEqual(delivery.policies.deliveryPolicy.raster, raster);
    assert.equal(delivery.policies.deliveryPolicy.aspectRatio, '16:9');
  });
}

test('resolution composition rejects unknown options and conflicting raster or aspect-ratio requests', () => {
  const selections = { sport: 'cycling', device: 'dji-osmo-action-5-pro', delivery: 'landscape-4k' };

  assert.throws(
    () => resolvePolicies({ ...selections, raster: { width: 1920, height: 1080 } }),
    (error) => error.code === 'E_PROFILE_RASTER_CONFLICT',
  );
  assert.throws(
    () => resolvePolicies({ ...selections, aspectRatio: '9:16' }),
    (error) => error.code === 'E_PROFILE_ASPECT_RATIO_CONFLICT',
  );
  assert.throws(
    () => resolvePolicies({ ...selections, undocumented: true }),
    (error) => error.code === 'E_PROFILE_UNKNOWN_OPTION',
  );
  assert.throws(
    () => loadProfile('unknown', 'cycling'),
    (error) => error.code === 'E_PROFILE_UNKNOWN_KIND',
  );
});

test('profile and composed policy documents reject nested mutation after digesting', () => {
  const profile = loadProfile('sport', 'cycling');
  const profileDigest = profile.profileDigest;
  assert.throws(
    () => {
      profile.policies.speedPolicy.maximumMontageRate = 99;
    },
    TypeError,
  );
  assert.equal(profile.policies.speedPolicy.maximumMontageRate, 12);
  assert.equal(profile.profileDigest, profileDigest);

  const resolved = resolvePolicies({
    sport: 'cycling',
    device: 'dji-osmo-action-5-pro',
    delivery: 'landscape-1080p',
  });
  const policyDigest = resolved.policyDigest;
  assert.throws(
    () => {
      resolved.policies.dataPolicy.gps.required = true;
    },
    TypeError,
  );
  assert.equal(resolved.policies.dataPolicy.gps.required, false);
  assert.equal(resolved.policyDigest, policyDigest);
});
