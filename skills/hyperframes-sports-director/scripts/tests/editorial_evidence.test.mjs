import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { computeArtifactDigest } from '../lib/contracts.mjs';
import { assertCurrentDataOverlayAuthority, assertOriginalRegistryOwnership, loadEditorialEvidence } from '../lib/editorial-evidence.mjs';
import { renderRoughCut } from '../render_rough_cut.mjs';
import { validateTimelineFile } from '../validate_timeline.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const digest = (character) => character.repeat(64);

async function template(name) {
  return JSON.parse(await readFile(join(SKILL, 'templates', `${name}.template.json`), 'utf8'));
}

function stamp(value) {
  value.integrity.digest = computeArtifactDigest(value);
  return value;
}

async function authorityFixture({ invalidShot = false } = {}) {
  const project = await mkdtemp(join(tmpdir(), 'hyperframes-editorial-evidence-'));
  for (const directory of ['analysis', 'edit']) await mkdir(join(project, directory), { recursive: true });
  const projectDocument = stamp(await template('PROJECT'));
  const probe = stamp(await template('PROBE'));
  const segments = await template('SEGMENTS');
  segments.integrity.upstream.probe = probe.integrity.digest;
  stamp(segments);
  const shots = await template('SHOT');
  shots.integrity.upstream = { probe: probe.integrity.digest, segments: segments.integrity.digest };
  if (invalidShot) {
    shots.status = 'available';
    shots.shots = [{
      shotId: 'shot-forged', mediaId: 'media-missing', segmentId: 'segment-missing', sourceDigest: digest('1'),
      sourceInSeconds: 0, sourceOutSeconds: 1, sourceDurationSeconds: 1,
      cameraRole: 'unknown', actionRole: 'unknown', environmentTags: ['unknown'], subjectTags: ['unknown'],
      quality: { motionIntensity: 'unknown', blur: 'unknown', shake: 'unknown', exposure: 'unknown', horizon: 'unknown', occlusion: 'unknown' },
      continuity: { screenDirection: 'unknown', motionDirection: 'unknown', subjectEntry: 'unknown', subjectExit: 'unknown', location: 'unknown', timeRelation: 'unknown' },
      audioSpans: [], duplicateGroup: null, setupTailLikelihood: 0, evidenceFrames: ['analysis/evidence/forged.webp'], confidence: 0.1,
    }];
  }
  stamp(shots);
  const transcript = stamp(await template('TRANSCRIPT'));
  const timeline = await template('TIMELINE');
  timeline.integrity.upstream = { probe: probe.integrity.digest, shots: shots.integrity.digest, transcript: transcript.integrity.digest };
  stamp(timeline);
  await writeFile(join(project, 'PROJECT.json'), `${JSON.stringify(projectDocument)}\n`);
  await writeFile(join(project, 'analysis', 'PROBE.json'), `${JSON.stringify(probe)}\n`);
  await writeFile(join(project, 'analysis', 'SEGMENTS.json'), `${JSON.stringify(segments)}\n`);
  await writeFile(join(project, 'analysis', 'SHOTS.jsonl'), `${JSON.stringify(shots)}\n`);
  await writeFile(join(project, 'analysis', 'TRANSCRIPT.json'), `${JSON.stringify(transcript)}\n`);
  await writeFile(join(project, 'edit', 'TIMELINE.json'), `${JSON.stringify(timeline)}\n`);
  return { project, timeline };
}

async function finalAuthorityFixture(t) {
  const { project, timeline } = await authorityFixture();
  const input = await mkdtemp(join(tmpdir(), 'hyperframes-editorial-input-'));
  t.after(() => Promise.all([rm(project, { recursive: true, force: true }), rm(input, { recursive: true, force: true })]));
  for (const directory of ['direction', 'cache']) await mkdir(join(project, directory), { recursive: true });
  const activity = stamp(await template('ACTIVITY'));
  const syncMap = stamp(await template('SYNC_MAP'));
  const dataOverlays = stamp(await template('DATA_OVERLAYS'));
  const anchorIdentity = { assetId: 'asset-anchor', sourceDigest: digest('1'), narrativeRole: 'journey_anchor',
    semanticColorTokens: ['color.accent'], visualAcceptanceDigest: digest('2') };
  const representativeIdentity = { proofId: 'proof-representative', proofDigest: digest('3'), semanticAcceptanceDigest: digest('4'),
    footageEvidenceId: 'frame-representative', components: [{ assetId: 'asset-component', sourceDigest: digest('5'), cropReceiptDigest: digest('6') }] };
  const assetManifest = stamp({
    $schema: 'https://hyperframes.local/schemas/asset-manifest.schema.json', schemaVersion: '1.0.0', revision: 2,
    assetRevision: 'assets-2', status: 'frozen', designRevision: 'design-2', lookRevision: 'look-2',
    designSystemDigest: digest('7'), lookProfileDigest: digest('8'), assetPlanDigest: digest('9'), selectedAssetPlanDigest: digest('a'),
    acceptance: { anchorDigest: digest('1'), representativeDigest: digest('3'), anchorIdentity, representativeIdentity,
      batches: [{ revision: 2, digest: digest('b'), acceptedAt: '2026-09-01T12:00:00.000Z' }] },
    assets: [], integrity: { digest: null, upstream: { designSystem: digest('7'), lookProfile: digest('8'), assetPlan: digest('9') } },
  });
  const motionMap = stamp({ ...(await template('MOTION_MAP')), revision: 2, motionRevision: 'motion-2', status: 'frozen',
    designRevision: 'design-2', assetRevision: 'assets-2', integrity: { digest: null,
      upstream: { designSystem: digest('7'), assetManifest: assetManifest.integrity.digest } } });
  const states = ['INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT', 'DIRECTOR_REVIEW_READY',
    'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION', 'MOTION_COMPOSITION'];
  const gateEvidence = [];
  const roleSpecs = {
    DIRECTOR_LOCK: [['DESIGN_SYSTEM', 'frozen'], ['LOOK_PROFILE', 'frozen'], ['DIRECTOR_APPROVAL', 'consumed'], ['WORKBENCH', 'state-bound']],
    STYLE_ANCHOR: [['DESIGN_SYSTEM', 'frozen'], ['LOOK_PROFILE', 'frozen'], ['ASSET_PLAN', 'approved'], ['STYLE_ANCHOR', 'accepted']],
    ASSET_PRODUCTION: [['STYLE_ANCHOR', 'accepted'], ['REPRESENTATIVE_COMBINATION', 'accepted']],
  };
  const transitions = states.slice(1).map((to, index) => {
    const at = `2026-09-01T${String(index).padStart(2, '0')}:00:00.000Z`;
    const specs = roleSpecs[to] ?? [[`${to}_GATE`, 'accepted']];
    const records = specs.map(([role, qualifier], roleIndex) => {
      const roleDigest = role === 'STYLE_ANCHOR' ? digest('1') : role === 'REPRESENTATIVE_COMBINATION' ? digest('3') : digest(String((index + roleIndex) % 10));
      return { gate: to, role, revision: 2, digest: roleDigest, timestamp: at,
        producerCommand: to === 'DIRECTOR_LOCK' ? 'lock_direction.mjs' : `fixture-${to}`, qualifiers: [qualifier], validity: 'valid', invalidatedAt: null };
    });
    gateEvidence.push(...records);
    return { from: states[index], to, at, evidenceDigests: Object.fromEntries(records.map(({ role, digest: value }) => [role, value])),
      evidenceRevisions: Object.fromEntries(records.map(({ role, revision }) => [role, revision])) };
  });
  const projectState = stamp({
    $schema: 'https://hyperframes.local/schemas/project-state.schema.json', schemaVersion: '1.0.0', revision: 12,
    state: 'MOTION_COMPOSITION', previousState: 'ASSET_PRODUCTION', stateEnteredAt: transitions.at(-1).at,
    transitions, gateEvidence, invalidations: [], assetAcceptance: {
      stage: 'batch', manifestRevision: 2, manifestDigest: assetManifest.integrity.digest,
      anchorDigest: digest('1'), representativeDigest: digest('3'),
      anchorIdentityDigest: computeArtifactDigest(anchorIdentity), representativeIdentityDigest: computeArtifactDigest(representativeIdentity),
      batchDigest: digest('b'), acceptedAt: transitions.find(({ to }) => to === 'ASSET_PRODUCTION').at,
    }, integrity: { digest: null, upstream: {} },
  });
  timeline.phase = 'final'; timeline.status = 'frozen'; timeline.designRevision = 'design-2'; timeline.lookRevision = 'look-2';
  timeline.assetRevision = 'assets-2'; timeline.motionRevision = 'motion-2'; timeline.assetManifestDigest = assetManifest.integrity.digest;
  timeline.motionMapDigest = motionMap.integrity.digest; timeline.dataOverlaysDigest = dataOverlays.integrity.digest;
  timeline.integrity.digest = null; stamp(timeline);
  for (const [portable, value] of [
    ['analysis/ACTIVITY.json', activity], ['analysis/SYNC_MAP.json', syncMap], ['direction/DATA_OVERLAYS.json', dataOverlays],
    ['direction/ASSET_MANIFEST.json', assetManifest], ['direction/MOTION_MAP.json', motionMap], ['PROJECT_STATE.json', projectState],
    ['edit/TIMELINE.json', timeline],
  ]) await writeFile(join(project, portable), `${JSON.stringify(value)}\n`);
  await writeFile(join(project, 'cache/source-registry.json'), `${JSON.stringify({ portable: false, inputRoot: input, entries: [] })}\n`);
  return { project, input, motionMap };
}

test('shared editorial loader rejects schema-valid SHOTS that fail current PROBE/SEGMENTS/evidence authority', async () => {
  const { project } = await authorityFixture({ invalidShot: true });
  await assert.rejects(() => loadEditorialEvidence({ project, phase: 'rough' }), (error) => error.code === 'E_SHOTS_INVALID');
});

test('shared editorial loader rejects a stale timeline digest instead of raw JSON acceptance', async () => {
  const { project, timeline } = await authorityFixture();
  timeline.revision = 2;
  await writeFile(join(project, 'edit', 'TIMELINE.json'), `${JSON.stringify(timeline)}\n`);
  await assert.rejects(() => loadEditorialEvidence({ project, phase: 'rough' }), (error) => error.code === 'E_TIMELINE_INVALID');
});

test('final editorial loader rejects a pending asset publication before consuming a split authority pair', async (t) => {
  const { project } = await authorityFixture();
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(project, { recursive: true, force: true })));
  await mkdir(join(project, 'cache'), { recursive: true });
  await writeFile(join(project, 'cache', 'asset-stage.transaction.json'), '{}\n');
  await assert.rejects(() => loadEditorialEvidence({ project, phase: 'final', input: project }),
    (error) => error.code === 'E_ASSET_TRANSACTION_PENDING');
});

test('final editorial loader rechecks one exact authority epoch after the complete read', async (t) => {
  const { project, input, motionMap } = await finalAuthorityFixture(t);
  await assert.rejects(loadEditorialEvidence({ project, input, phase: 'final' }, {
    beforeFinalEpochCheck: async () => {
      motionMap.revision += 1; motionMap.integrity.digest = null; stamp(motionMap);
      await writeFile(join(project, 'direction/MOTION_MAP.json'), `${JSON.stringify(motionMap)}\n`);
    },
  }), (error) => {
    assert.equal(error.code, 'E_EDITORIAL_AUTHORITY_STALE', JSON.stringify(error.diagnostics));
    return true;
  });
});

test('timeline CLI API and programmatic rough renderer share cross-artifact authority instead of raw SHOTS JSON', async () => {
  const { project } = await authorityFixture({ invalidShot: true });
  await assert.rejects(() => validateTimelineFile({ project, phase: 'rough' }), (error) => error.code === 'E_SHOTS_INVALID');
  await assert.rejects(
    () => renderRoughCut({ project, probe: { integrity: { digest: digest('a') }, media: [] }, shots: { integrity: { digest: digest('b') }, shots: [] }, transcript: { integrity: { digest: digest('c') }, status: 'unavailable', segments: [] }, timeline: { integrity: { digest: digest('d') }, phase: 'rough', items: [] }, profiles: {} }),
    (error) => error.code === 'E_SHOTS_INVALID',
  );
});

test('final source ownership requires exact immutable registry media ID and digest', () => {
  const registry = { entries: [{ mediaId: 'media-a', sourceDigest: digest('a') }] };
  assert.throws(
    () => assertOriginalRegistryOwnership({ items: [{ sourceMediaId: 'media-a', sourceReference: { digest: digest('b') } }] }, registry),
    (error) => error.code === 'E_ORIGINAL_AUTHORITY',
  );
  assert.throws(
    () => assertOriginalRegistryOwnership({ items: [{ sourceMediaId: 'media-b', sourceReference: { digest: digest('a') } }] }, registry),
    (error) => error.code === 'E_ORIGINAL_AUTHORITY',
  );
});

test('final documentary authority is recomputed from current coverage and sync interval', async () => {
  const activity = await template('ACTIVITY');
  activity.status = 'available'; activity.sportProfiles = ['cycling']; activity.metrics.distance = 1000;
  activity.availability.distance = 'available'; activity.coverage.distance = 0.1;
  activity.reasons.distance = null; activity.sources.distance = 'activity-source-fixture'; stamp(activity);
  const syncMap = stamp(await template('SYNC_MAP'));
  const overlays = stamp({
    $schema: 'https://hyperframes.local/schemas/data-overlays.schema.json', schemaVersion: '1.0.0', revision: 1,
    status: 'available', activityDigest: activity.integrity.digest, syncMapDigest: syncMap.integrity.digest,
    publicRoute: { status: 'unavailable', trimmedRouteId: null }, overlays: [{ overlayId: 'overlay-distance',
      metricId: 'metrics.distance', displayAuthority: 'whole-activity', syncAuthority: 'whole-activity', wording: 'Distance',
      colorToken: 'color.dataPrimary', destinationInSeconds: 0, destinationOutSeconds: 1 }],
    integrity: { digest: null, upstream: { activity: activity.integrity.digest, syncMap: syncMap.integrity.digest } },
  });
  const sportProfile = { policies: { dataPolicy: { primaryMetrics: ['distance'] } } };
  assert.throws(() => assertCurrentDataOverlayAuthority(activity, syncMap, overlays, sportProfile),
    (error) => error.code === 'E_DATA_OVERLAYS_AUTHORITY'
      && error.diagnostics.some((message) => message.includes('display authority')));
});
