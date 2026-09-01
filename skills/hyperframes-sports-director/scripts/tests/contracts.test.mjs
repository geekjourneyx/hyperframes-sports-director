import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  canonicalizeArtifact,
  computeArtifactDigest,
  loadSchema,
  validateArtifact,
  validateDocument,
  verifyArtifactIntegrity,
} from '../lib/contracts.mjs';
import { framesToSeconds, secondsToFrames } from '../lib/time.mjs';

const execFileAsync = promisify(execFile);
const ROOT = 'skills/hyperframes-sports-director';

async function template(name) {
  return JSON.parse(await readFile(`${ROOT}/templates/${name}.template.json`, 'utf8'));
}

function clone(value) {
  return structuredClone(value);
}

function assertValid(schema, value, message) {
  const result = validateDocument(schema, value);
  assert.equal(result.valid, true, `${message}: ${JSON.stringify(result.errors)}`);
}

function assertInvalid(schema, value, message) {
  const result = validateDocument(schema, value);
  assert.equal(result.valid, false, message);
  assert.ok(result.errors.length > 0, `${message}: missing diagnostic`);
  for (const error of result.errors) {
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'path', 'schema']);
  }
}

function directionCandidate(candidateId) {
  return {
    candidateId,
    wholeDirection: true,
    representativeEvidenceIds: ['shot-001'],
    designRevision: `design-${candidateId}`,
    lookRevision: `look-${candidateId}`,
    typographyHierarchy: ['journey-title'],
    layoutProofs: ['review/layout-proof.webp'],
    motionStoryboard: ['review/motion-storyboard.webp'],
    assetPlan: { roles: ['journey-anchor'], productionImageGenUsed: false },
    musicPlan: { mode: 'provided', trackIds: ['music-001'] },
    risks: [],
    previewArtifactDigests: { layout: 'a'.repeat(64), motion: 'b'.repeat(64) },
  };
}

function stampIntegrity(value) {
  value.integrity.digest = computeArtifactDigest(value);
  return value;
}

function gateSpecifications(state) {
  if (state === 'STYLE_ANCHOR') return [['DESIGN_SYSTEM', 'frozen'], ['LOOK_PROFILE', 'frozen'], ['ASSET_PLAN', 'approved']];
  if (state === 'ASSET_PRODUCTION') return [['STYLE_ANCHOR', 'accepted'], ['REPRESENTATIVE_COMBINATION', 'accepted']];
  if (state === 'DELIVERED') {
    return [
      ['CLOSED_FILE_PROBE', 'passed'], ['HARD_GATES', 'passed'],
      ['AGENT_VISUAL_INSPECTION', 'accepted'], ['ENCODED_MP4_EVIDENCE', 'accepted'],
    ];
  }
  return [[`${state}_GATE`, 'accepted']];
}

function projectStateAt(base, state) {
  if (state === 'INTAKE') return clone(base);
  const mainStates = [
    'INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT',
    'DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION',
    'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED',
  ];
  const route = ['BLOCKED', 'CANCELLED'].includes(state)
    ? ['INTAKE', state]
    : mainStates.slice(0, mainStates.indexOf(state) + 1);
  const gateEvidence = [];
  const transitions = route.slice(1).map((to, index) => {
    const at = `2026-09-01T00:${String(index).padStart(2, '0')}:00.000Z`;
    const records = gateSpecifications(to).map(([role, qualifier], roleIndex) => ({
      gate: to,
      role,
      revision: index + 1,
      digest: `${index + 1}${roleIndex + 1}`.padStart(64, '0'),
      timestamp: at,
      producerCommand: `test-gate --state ${to}`,
      qualifiers: [qualifier],
      validity: 'valid',
      invalidatedAt: null,
    }));
    gateEvidence.push(...records);
    return {
      from: route[index],
      to,
      at,
      evidenceDigests: Object.fromEntries(records.map(({ role, digest }) => [role, digest])),
      evidenceRevisions: Object.fromEntries(records.map(({ role, revision }) => [role, revision])),
    };
  });
  const last = transitions.at(-1);
  return {
    ...clone(base),
    state,
    previousState: last.from,
    stateEnteredAt: last.at,
    transitions,
    invalidations: [],
    gateEvidence,
  };
}

test('v1 contracts enforce identity, truth chains, lifecycle, integrity, paths, and time', async () => {
  const schemaNames = [
    'activity', 'asset-manifest', 'beat-map', 'data-overlays', 'design-system',
    'direction-proposals', 'director-approval', 'edit-brief', 'look-profile',
    'media-index', 'motion-map', 'probe', 'project', 'project-state',
    'review-metrics', 'scene-schema', 'segments', 'shot', 'sync-map',
    'timeline', 'transcript',
  ];
  const schemas = Object.fromEntries(await Promise.all(schemaNames.map(async (name) => [name, await loadSchema(name)])));

  const project = await template('PROJECT');
  const projectState = await template('PROJECT_STATE');
  const editBrief = await template('EDIT_BRIEF');
  const mediaIndex = await template('MEDIA_INDEX');
  const activity = await template('ACTIVITY');
  const designSystem = await template('DESIGN_SYSTEM');
  const lookProfile = await template('LOOK_PROFILE');
  const directionProposals = await template('DIRECTION_PROPOSALS');
  const directorApproval = await template('DIRECTOR_APPROVAL');

  assert.equal(project.schemaVersion, '1.0.0');
  assert.deepEqual(project.profiles, {
    sport: 'cycling',
    device: 'dji-osmo-action-5-pro',
    delivery: 'landscape-4k',
    sportMaturity: 'release-grade',
  });
  const falseReleaseClaim = clone(project);
  falseReleaseClaim.profiles.sport = 'running';
  assertInvalid(schemas.project, falseReleaseClaim, 'experimental sports cannot claim release-grade maturity');
  const falseExperimentalClaim = clone(project);
  falseExperimentalClaim.profiles.sportMaturity = 'experimental';
  assertInvalid(schemas.project, falseExperimentalClaim, 'release-grade sports retain their resolved maturity');
  assert.equal(projectState.state, 'INTAKE');
  assert.equal(editBrief.delivery.aspectRatio, '16:9');
  assert.equal(editBrief.music.mode, 'provided');
  mediaIndex.entries.push({
    mediaId: 'media-001',
    mediaType: 'video',
    sourceRootReadOnly: true,
    sourceDigest: '1'.repeat(64),
    byteSize: 1024,
    portablePath: 'media/originals/media-001.mp4',
  });
  assert.equal(mediaIndex.entries[0].sourceRootReadOnly, true);
  assert.notEqual(schemas.probe.$id, schemas.segments.$id);
  assert.equal(activity.metrics.averageHeartRate, null);
  assert.equal(activity.availability.heartRate, 'unavailable');
  assert.notEqual(schemas['asset-manifest'].$id, schemas['motion-map'].$id);
  assert.notEqual(schemas['motion-map'].$id, schemas.timeline.$id);
  assert.notEqual(schemas['data-overlays'].$id, schemas.activity.$id);
  assert.equal(activity.status, 'unavailable');
  assert.equal(designSystem.status, 'draft');
  assert.equal(lookProfile.status, 'draft');
  assert.equal(directionProposals.status, 'unavailable');
  assert.equal(directorApproval.status, 'unavailable');
  assert.equal(lookProfile.output.colorSpace, 'rec709-sdr');

  const templateToSchema = {
    ACTIVITY: 'activity', ASSET_MANIFEST: 'asset-manifest', BEAT_MAP: 'beat-map',
    DATA_OVERLAYS: 'data-overlays', DESIGN_SYSTEM: 'design-system',
    DIRECTION_PROPOSALS: 'direction-proposals', DIRECTOR_APPROVAL: 'director-approval',
    EDIT_BRIEF: 'edit-brief', LOOK_PROFILE: 'look-profile', MEDIA_INDEX: 'media-index',
    MOTION_MAP: 'motion-map', PROBE: 'probe', PROJECT: 'project',
    PROJECT_STATE: 'project-state', SCENE_SCHEMA: 'scene-schema', SEGMENTS: 'segments',
    SHOT: 'shot', SYNC_MAP: 'sync-map', TIMELINE: 'timeline', TRANSCRIPT: 'transcript',
  };
  for (const [templateName, schemaName] of Object.entries(templateToSchema)) {
    assertValid(schemas[schemaName], await template(templateName), `${templateName} template`);
  }

  const unknownVersion = clone(project);
  unknownVersion.schemaVersion = '2.0.0';
  assertInvalid(schemas.project, unknownVersion, 'unknown schema versions are rejected');

  mediaIndex.entries.push(
    { mediaId: 'media-002', mediaType: 'image', sourceRootReadOnly: true, sourceDigest: '2'.repeat(64), byteSize: 2048, portablePath: 'media/originals/media-002.jpg' },
    { mediaId: 'media-003', mediaType: 'audio', sourceRootReadOnly: true, sourceDigest: '3'.repeat(64), byteSize: 4096, portablePath: 'media/originals/media-003.wav' },
    { mediaId: 'media-004', mediaType: 'activity', sourceRootReadOnly: true, sourceDigest: '4'.repeat(64), byteSize: 512, portablePath: 'media/originals/media-004.fit' },
    { mediaId: 'media-005', mediaType: 'sidecar', sourceRootReadOnly: true, sourceDigest: '5'.repeat(64), byteSize: 256, portablePath: 'media/originals/media-005.srt' },
    { mediaId: 'media-006', mediaType: 'unsupported', sourceRootReadOnly: true, sourceDigest: '6'.repeat(64), byteSize: 128, portablePath: 'media/originals/media-006.bin' },
  );
  assertValid(schemas['media-index'], mediaIndex, 'mixed media classifications');
  const duplicateMedia = clone(mediaIndex);
  duplicateMedia.entries[1].mediaId = 'media-001';
  assertInvalid(schemas['media-index'], duplicateMedia, 'media IDs are unique');

  const shots = await template('SHOT');
  shots.status = 'available';
  shots.integrity.upstream = { probe: '8'.repeat(64), segments: '9'.repeat(64) };
  shots.shots = [
    { shotId: 'shot-001', mediaId: 'media-001', segmentId: 'segment-001', sourceDigest: '1'.repeat(64), sourceInSeconds: 0, sourceOutSeconds: 2, sourceDurationSeconds: 4, cameraRole: 'wide', actionRole: 'move', environmentTags: ['road'], subjectTags: ['rider'], quality: { motionIntensity: 'medium', blur: 'none', shake: 'minor', exposure: 'good', horizon: 'level', occlusion: 'none' }, continuity: { screenDirection: 'left-to-right', motionDirection: 'forward', subjectEntry: 'left', subjectExit: 'right', location: 'riverside road', timeRelation: 'continuous' }, audioSpans: [], duplicateGroup: null, setupTailLikelihood: 0.1, evidenceFrames: ['analysis/evidence/shot-001.webp'], confidence: 0.9 },
    { shotId: 'shot-002', mediaId: 'media-001', segmentId: 'segment-002', sourceDigest: '1'.repeat(64), sourceInSeconds: 2, sourceOutSeconds: 4, sourceDurationSeconds: 4, cameraRole: 'wide', actionRole: 'move', environmentTags: ['road'], subjectTags: ['rider'], quality: { motionIntensity: 'medium', blur: 'none', shake: 'minor', exposure: 'good', horizon: 'level', occlusion: 'none' }, continuity: { screenDirection: 'left-to-right', motionDirection: 'forward', subjectEntry: 'left', subjectExit: 'right', location: 'riverside road', timeRelation: 'continuous' }, audioSpans: [], duplicateGroup: null, setupTailLikelihood: 0.1, evidenceFrames: ['analysis/evidence/shot-002.webp'], confidence: 0.8 },
  ];
  stampIntegrity(shots);
  assertValid(schemas.shot, shots, 'unique shot IDs');
  const duplicateShots = clone(shots);
  duplicateShots.shots[1].shotId = 'shot-001';
  assertInvalid(schemas.shot, duplicateShots, 'duplicate shot IDs');

  assert.notStrictEqual(activity.metrics, activity.availability);
  assert.notStrictEqual(activity.availability, activity.coverage);
  assert.notStrictEqual(activity.coverage, activity.reasons);
  assert.notStrictEqual(activity.reasons, activity.sources);
  const falselyAvailableActivity = clone(activity);
  falselyAvailableActivity.status = 'available';
  assertInvalid(schemas.activity, falselyAvailableActivity, 'optional activity cannot be available without sourced metrics');
  falselyAvailableActivity.metrics.averageHeartRate = 0;
  falselyAvailableActivity.availability.heartRate = 'available';
  assertInvalid(schemas.activity, falselyAvailableActivity, 'available activity requires coverage and an exact source');
  falselyAvailableActivity.coverage.heartRate = 0.8;
  falselyAvailableActivity.sources.heartRate = 'activity-001:heart-rate';
  falselyAvailableActivity.reasons.heartRate = null;
  assertValid(schemas.activity, falselyAvailableActivity, 'a recorded zero remains valid when coverage and source exist');
  assertValid(schemas.activity, activity, 'missing activity is a valid unavailable branch');

  for (const mode of ['none', 'provided', 'select-local']) {
    const value = clone(editBrief);
    value.music.mode = mode;
    assertValid(schemas['edit-brief'], value, `music mode ${mode}`);
  }
  for (const modes of [['none'], ['titles'], ['captions'], ['voiceover-script'], ['titles', 'captions']]) {
    const value = clone(editBrief);
    value.copy.modes = modes;
    assertValid(schemas['edit-brief'], value, `copy modes ${modes.join('+')}`);
  }
  const impossibleMaximum = clone(editBrief);
  impossibleMaximum.delivery.maximumFileSizeBytes = 0;
  assertInvalid(schemas['edit-brief'], impossibleMaximum, 'maximum file size is null or a positive byte ceiling');

  const assetManifest = await template('ASSET_MANIFEST');
  assetManifest.designRevision = 'design-7';
  assetManifest.lookRevision = 'look-11';
  assetManifest.designSystemDigest = '7'.repeat(64);
  assetManifest.lookProfileDigest = 'b'.repeat(64);
  assetManifest.integrity.upstream = { designSystem: assetManifest.designSystemDigest, lookProfile: assetManifest.lookProfileDigest };
  assetManifest.assets = [{
    assetId: 'asset-001', role: 'journey-anchor', provenance: 'generated-interpretive',
    portablePath: 'assets/images/components/anchor.webp', colorToken: 'color.accent',
    optional: false,
  }];
  stampIntegrity(assetManifest);
  assertValid(schemas['asset-manifest'], assetManifest, 'independent design and Look revisions');
  const arbitraryColor = clone(assetManifest);
  arbitraryColor.assets[0].colorToken = '#ff0000';
  assertInvalid(schemas['asset-manifest'], arbitraryColor, 'assets reference semantic tokens, not arbitrary colors');

  const probe = await template('PROBE');
  probe.media = [{
    mediaId: 'media-001', mediaType: 'video', reviewPath: 'review/probe/media-001.mp4',
    sourceDigest: '1'.repeat(64), byteSize: 1024, durationSeconds: 12,
    streams: [{ streamId: 'v:0', type: 'video', codec: 'h264', timeBase: '1/30000', frameRate: '30000/1001', width: 3840, height: 2160 }],
    captureTimestamp: '2026-08-31T12:00:00.000Z',
  }];
  probe.integrity.upstream.mediaIndex = '7'.repeat(64);
  stampIntegrity(probe);
  assertValid(schemas.probe, probe, 'probe owns normalized media facts');
  const proxyProbe = clone(probe);
  proxyProbe.media[0].proxy = {
    kind: 'video', path: 'media/proxies/media-001.mp4', sourceDigest: '1'.repeat(64),
    transform: {
      codec: 'h264', maximumWidth: 1280, maximumHeight: 720, watermark: 'ANALYSIS PROXY',
      preserveTimestamps: true, preserveAudio: true, autoOrient: true,
    },
    timeMapping: [{ proxyStartSeconds: 0, originalStartSeconds: 0, durationSeconds: 12, rate: '1/1' }],
  };
  stampIntegrity(proxyProbe);
  assertValid(schemas.probe, proxyProbe, 'proxy record binds the stable media path, digest, and complete 1/1 time mapping');
  for (const mutate of [
    (value) => { value.media[0].proxy.sourceDigest = '2'.repeat(64); },
    (value) => { value.media[0].proxy.path = 'media/proxies/private-source-name.mp4'; },
    (value) => { value.media[0].proxy.timeMapping[0].rate = '2/1'; },
  ]) {
    const invalidProxy = clone(proxyProbe);
    mutate(invalidProxy);
    stampIntegrity(invalidProxy);
    assertInvalid(schemas.probe, invalidProxy, 'proxy lineage and time mapping cannot diverge from the normalized source');
  }
  const stillProbe = clone(probe);
  stillProbe.media[0].mediaType = 'image';
  stillProbe.media[0].reviewPath = 'review/probe/media-001.webp';
  stillProbe.media[0].durationSeconds = null;
  stillProbe.media[0].streams[0].width = 160;
  stillProbe.media[0].streams[0].height = 90;
  stillProbe.media[0].stillDisplay = {
    orientationSource: 'exif', exifOrientation: 6, rotationDegrees: 90, mirrored: false,
    encodedWidth: 160, encodedHeight: 90, displayWidth: 90, displayHeight: 160,
  };
  stampIntegrity(stillProbe);
  assertValid(schemas.probe, stillProbe, 'still display geometry binds EXIF orientation to encoded dimensions');
  for (const mutate of [
    (value) => { value.media[0].stillDisplay.displayWidth = 160; },
    (value) => { value.media[0].stillDisplay.exifOrientation = null; },
  ]) {
    const invalidStill = clone(stillProbe);
    mutate(invalidStill);
    stampIntegrity(invalidStill);
    assertInvalid(schemas.probe, invalidStill, 'still display geometry and EXIF source must remain consistent');
  }
  const absoluteProbe = clone(probe);
  absoluteProbe.media[0].reviewPath = '/Users/alice/private-ride.mov';
  assertInvalid(schemas.probe, absoluteProbe, 'probe cannot expose an absolute input path');
  const segments = await template('SEGMENTS');
  segments.sourceMediaIds = ['media-001'];
  segments.integrity.upstream.probe = '8'.repeat(64);
  segments.segments = [{
    segmentId: 'segment-001', mediaId: 'media-001', mediaType: 'video', sourceDigest: '1'.repeat(64), probeDigest: '8'.repeat(64),
    sourceInSeconds: 1, sourceOutSeconds: 5, sourceDurationSeconds: 12,
    sceneScore: 0, motionScore: 0, audioPresent: true, reviewPath: 'analysis/segments/segment-001.webp', evidenceFrames: [{ path: 'analysis/evidence/segment-001/frame.webp', sourceTimeSeconds: 2 }],
  }];
  stampIntegrity(segments);
  assertValid(schemas.segments, segments, 'segments reference exact probe media IDs and digest');
  const staleSegmentId = clone(segments);
  staleSegmentId.segments[0].mediaId = 'media-999';
  assertInvalid(schemas.segments, staleSegmentId, 'segments reject an unprobed media ID');
  const staleProbeDigest = clone(segments);
  staleProbeDigest.segments[0].probeDigest = '9'.repeat(64);
  assertInvalid(schemas.segments, staleProbeDigest, 'segments reject a stale upstream probe digest');
  const absoluteSegment = clone(segments);
  absoluteSegment.segments[0].reviewPath = 'C:\\Users\\alice\\private.mov';
  assertInvalid(schemas.segments, absoluteSegment, 'segments cannot expose an absolute input path');

  const proposals = clone(directionProposals);
  proposals.status = 'proposed';
  proposals.candidates = [directionCandidate('candidate-a'), directionCandidate('candidate-b')];
  assertValid(schemas['direction-proposals'], proposals, 'two whole direction candidates');
  proposals.candidates.push(directionCandidate('candidate-c'));
  assertValid(schemas['direction-proposals'], proposals, 'three whole direction candidates');
  const oneProposal = clone(proposals);
  oneProposal.candidates = [directionCandidate('candidate-a')];
  assertInvalid(schemas['direction-proposals'], oneProposal, 'proposed requires two or three candidates');
  const unavailableWithCandidate = clone(directionProposals);
  unavailableWithCandidate.candidates = [directionCandidate('candidate-a')];
  assertInvalid(schemas['direction-proposals'], unavailableWithCandidate, 'unavailable requires no candidates');
  const incompleteProposal = clone(proposals);
  delete incompleteProposal.candidates[0].motionStoryboard;
  assertInvalid(schemas['direction-proposals'], incompleteProposal, 'direction candidates are whole');

  const approval = clone(directorApproval);
  approval.status = 'approved';
  approval.selectedCandidateId = 'candidate-b';
  approval.displayedArtifactDigests = {
    editBrief: 'a'.repeat(64), roughCut: 'b'.repeat(64), musicPlan: 'c'.repeat(64),
    assetPlan: 'd'.repeat(64), evidence: 'e'.repeat(64), proposals: 'f'.repeat(64),
  };
  approval.approvedAt = '2026-09-01T10:15:30.000Z';
  assertValid(schemas['director-approval'], approval, 'approval binds one candidate and displayed artifact digests');
  const partialApproval = clone(approval);
  delete partialApproval.displayedArtifactDigests.evidence;
  assertInvalid(schemas['director-approval'], partialApproval, 'approval rejects partial displayed digests');

  const overlays = await template('DATA_OVERLAYS');
  overlays.status = 'available';
  overlays.activityDigest = 'a'.repeat(64);
  overlays.syncMapDigest = 'b'.repeat(64);
  overlays.integrity.upstream = { activity: overlays.activityDigest, syncMap: overlays.syncMapDigest };
  overlays.overlays = [{
    overlayId: 'overlay-001', metricId: 'metrics.averageHeartRate', displayAuthority: 'chapter-summary',
    syncAuthority: 'whole-activity', wording: 'Average heart rate unavailable', colorToken: 'color.dataPrimary',
    destinationInSeconds: 10, destinationOutSeconds: 14,
  }];
  stampIntegrity(overlays);
  assertValid(schemas['data-overlays'], overlays, 'data overlays reference normalized metrics and authority digests');
  const calculatedOverlay = clone(overlays);
  calculatedOverlay.overlays[0].value = 160;
  assertInvalid(schemas['data-overlays'], calculatedOverlay, 'data overlays cannot independently calculate values');

  const timeline = await template('TIMELINE');
  timeline.status = 'draft';
  timeline.designRevision = 'design-7';
  timeline.lookRevision = 'look-11';
  timeline.sourceProbeDigest = '8'.repeat(64);
  timeline.integrity.upstream = { probe: timeline.sourceProbeDigest };
  timeline.items = [
    { itemId: 'item-001', sourceMediaId: 'media-001', sourceInSeconds: 1, sourceOutSeconds: 4, sourceDurationSeconds: 12, destinationInSeconds: 0, destinationOutSeconds: 3, playbackRate: 1, colorToken: 'color.primaryText' },
    { itemId: 'item-002', sourceMediaId: 'media-001', sourceInSeconds: 5, sourceOutSeconds: 8, sourceDurationSeconds: 12, destinationInSeconds: 3, destinationOutSeconds: 6, playbackRate: 1, colorToken: 'color.primaryText' },
  ];
  stampIntegrity(timeline);
  assertValid(schemas.timeline, timeline, 'timeline has monotonic destination time and bounded source time');
  const nonMonotonic = clone(timeline);
  nonMonotonic.items[1].destinationInSeconds = 2.5;
  assertInvalid(schemas.timeline, nonMonotonic, 'destination time is monotonic');
  const outOfBounds = clone(timeline);
  outOfBounds.items[1].sourceOutSeconds = 12.1;
  assertInvalid(schemas.timeline, outOfBounds, 'source time stays within probe bounds');
  const reversedSource = clone(timeline);
  reversedSource.items[0].sourceInSeconds = 4;
  reversedSource.items[0].sourceOutSeconds = 3;
  assertInvalid(schemas.timeline, reversedSource, 'source intervals have positive duration');
  const reversedDestination = clone(timeline);
  reversedDestination.items[0].destinationInSeconds = 2;
  reversedDestination.items[0].destinationOutSeconds = 1;
  assertInvalid(schemas.timeline, reversedDestination, 'destination intervals have positive duration');

  const invalidTimestamp = clone(project);
  invalidTimestamp.createdAt = 'yesterday';
  assertInvalid(schemas.project, invalidTimestamp, 'timestamps are ISO-8601');
  const escapingProjectPath = clone(project);
  escapingProjectPath.paths.workspace = '../outside';
  assertInvalid(schemas.project, escapingProjectPath, 'portable paths stay project-relative');
  const uriProjectPath = clone(project);
  uriProjectPath.paths.workspace = 'file:///private/input.mov';
  assertInvalid(schemas.project, uriProjectPath, 'portable paths reject URI schemes');

  const canonicalA = {
    schemaVersion: '1.0.0', revision: 4, nested: { z: 1, a: [3, { y: 2, x: 1 }] },
    integrity: { upstream: { probe: '1'.repeat(64) }, digest: '0'.repeat(64) },
  };
  const canonicalB = {
    integrity: { digest: 'f'.repeat(64), upstream: { probe: '1'.repeat(64) } },
    nested: { a: [3, { x: 1, y: 2 }], z: 1 }, revision: 4, schemaVersion: '1.0.0',
  };
  assert.equal(canonicalizeArtifact(canonicalA), canonicalizeArtifact(canonicalB));
  assert.equal(computeArtifactDigest(canonicalA), computeArtifactDigest(canonicalB));
  const stamped = clone(canonicalA);
  stamped.integrity.digest = computeArtifactDigest(stamped);
  assert.equal(verifyArtifactIntegrity(stamped).valid, true);
  stamped.nested.z = 2;
  assert.equal(verifyArtifactIntegrity(stamped).valid, false);
  assert.equal(verifyArtifactIntegrity(stamped).code, 'E_INTEGRITY_DIGEST_MISMATCH');

  for (const schemaName of ['design-system', 'look-profile']) {
    const value = await template(schemaName === 'design-system' ? 'DESIGN_SYSTEM' : 'LOOK_PROFILE');
    value.status = 'superseded';
    value.approvalDigest = 'a'.repeat(64);
    value.lifecycle = [
      { status: 'draft', at: '2026-09-01T00:00:00.000Z' },
      { status: 'proposed', at: '2026-09-01T00:01:00.000Z' },
      { status: 'approved', at: '2026-09-01T00:02:00.000Z' },
      { status: 'frozen', at: '2026-09-01T00:03:00.000Z' },
      { status: 'superseded', at: '2026-09-01T00:04:00.000Z' },
    ];
    assertValid(schemas[schemaName], value, `${schemaName} accepts the complete lifecycle`);
    const skippedApproval = clone(value);
    skippedApproval.status = 'frozen';
    skippedApproval.approvalDigest = null;
    skippedApproval.lifecycle = [
      { status: 'draft', at: '2026-09-01T00:00:00.000Z' },
      { status: 'frozen', at: '2026-09-01T00:01:00.000Z' },
    ];
    assertInvalid(schemas[schemaName], skippedApproval, `${schemaName} rejects draft to frozen`);
  }

  const states = [
    'INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT',
    'DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION',
    'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED',
    'BLOCKED', 'CANCELLED',
  ];
  for (const state of states) {
    const value = projectStateAt(projectState, state);
    assertValid(schemas['project-state'], value, `state ${state}`);
  }
  const validStateHistory = projectStateAt(projectState, 'DELIVERED');
  assertValid(schemas['project-state'], validStateHistory, 'main lifecycle transitions are ordered');
  assert.ok(validStateHistory.gateEvidence.length >= validStateHistory.transitions.length);
  assert.deepEqual(
    Object.keys(validStateHistory.gateEvidence[0]).sort(),
    ['digest', 'gate', 'invalidatedAt', 'producerCommand', 'qualifiers', 'revision', 'role', 'timestamp', 'validity'],
  );
  const unauditableHistory = clone(validStateHistory);
  unauditableHistory.gateEvidence.splice(2, 1);
  assertInvalid(schemas['project-state'], unauditableHistory, 'every non-INTAKE transition retains auditable gate evidence');
  const unboundHistory = clone(validStateHistory);
  unboundHistory.gateEvidence[2].digest = 'f'.repeat(64);
  assertInvalid(schemas['project-state'], unboundHistory, 'gate evidence digest binds to its transition role');
  for (const mutation of [
    (value) => { value.gateEvidence.find(({ role }) => role === 'CLOSED_FILE_PROBE').role = 'DELIVERED_GATE'; },
    (value) => { value.gateEvidence.find(({ role }) => role === 'HARD_GATES').qualifiers = ['accepted']; },
    (value) => { value.gateEvidence.find(({ role }) => role === 'AGENT_VISUAL_INSPECTION').revision += 1; },
    (value) => { value.gateEvidence.find(({ role }) => role === 'ENCODED_MP4_EVIDENCE').gate = 'FINAL_QA'; },
    (value) => { value.gateEvidence.find(({ role }) => role === 'ENCODED_MP4_EVIDENCE').qualifiers = ['accepted', 'accepted']; },
  ]) {
    const bypass = clone(validStateHistory);
    mutation(bypass);
    assertInvalid(schemas['project-state'], bypass, 'DELIVERED rejects wrong role, qualifier, revision, gate, or duplicate qualifier');
  }
  const invalidCurrentGate = clone(validStateHistory);
  for (const record of invalidCurrentGate.gateEvidence.filter(({ gate }) => gate === 'DELIVERED')) {
    record.validity = 'invalidated';
    record.invalidatedAt = '2026-09-01T01:00:00.000Z';
  }
  assertInvalid(schemas['project-state'], invalidCurrentGate, 'the current gate cannot rely on invalidated evidence');
  for (const [state, role] of [
    ['STYLE_ANCHOR', 'DESIGN_SYSTEM'],
    ['ASSET_PRODUCTION', 'REPRESENTATIVE_COMBINATION'],
    ['DELIVERED', 'HARD_GATES'],
  ]) {
    const partiallyInvalidated = projectStateAt(projectState, state);
    const record = partiallyInvalidated.gateEvidence.find((entry) => entry.gate === state && entry.role === role);
    record.validity = 'invalidated';
    record.invalidatedAt = '2026-09-01T01:00:00.000Z';
    assertInvalid(schemas['project-state'], partiallyInvalidated, `${state} requires every exact gate record to remain current-valid`);
  }
  const unauditedHistoricalInvalidation = clone(validStateHistory);
  const historicalRecord = unauditedHistoricalInvalidation.gateEvidence.find(({ gate, role }) => gate === 'STYLE_ANCHOR' && role === 'DESIGN_SYSTEM');
  historicalRecord.validity = 'invalidated';
  historicalRecord.invalidatedAt = '2026-09-01T01:00:00.000Z';
  assertInvalid(schemas['project-state'], unauditedHistoricalInvalidation, 'historical special-gate invalidation requires a later auditable rollback or BLOCKED transition');
  const inconsistentValidity = clone(validStateHistory);
  inconsistentValidity.gateEvidence[0].invalidatedAt = '2026-09-01T01:00:00.000Z';
  assertInvalid(schemas['project-state'], inconsistentValidity, 'valid evidence cannot carry an invalidation timestamp');
  for (const [state, role, qualifier] of [
    ['STYLE_ANCHOR', 'DESIGN_SYSTEM', 'frozen'],
    ['STYLE_ANCHOR', 'LOOK_PROFILE', 'frozen'],
    ['STYLE_ANCHOR', 'ASSET_PLAN', 'approved'],
    ['ASSET_PRODUCTION', 'STYLE_ANCHOR', 'accepted'],
    ['ASSET_PRODUCTION', 'REPRESENTATIVE_COMBINATION', 'accepted'],
  ]) {
    const bypass = projectStateAt(projectState, state);
    bypass.gateEvidence.find((record) => record.role === role).qualifiers = [qualifier === 'frozen' ? 'approved' : 'passed'];
    assertInvalid(schemas['project-state'], bypass, `${state} requires ${role} with ${qualifier}`);
  }
  const skippedState = clone(validStateHistory);
  skippedState.transitions[0].to = 'SCAN';
  assertInvalid(schemas['project-state'], skippedState, 'state transitions cannot skip required gates');
  const exitedTerminalState = clone(projectState);
  exitedTerminalState.state = 'CANCELLED';
  exitedTerminalState.transitions = [{
    from: 'BLOCKED', to: 'CANCELLED', at: '2026-09-01T00:00:00.000Z',
    evidenceDigests: { gate: '1'.repeat(64) },
    evidenceRevisions: { gate: 1 },
  }];
  assertInvalid(schemas['project-state'], exitedTerminalState, 'terminal side states have no outgoing transitions');

  assert.equal(secondsToFrames(1.5, 30), 45);
  assert.equal(secondsToFrames(1, '30000/1001'), 30);
  assert.equal(framesToSeconds(45, 30), 1.5);
  assert.equal(framesToSeconds(30, '30000/1001'), 1.001);
  assert.throws(() => secondsToFrames(-1, 30), /seconds/i);
  assert.throws(() => framesToSeconds(1, 0), /fps/i);

  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-contracts-'));
  try {
    const artifactPath = join(scratch, 'PROJECT.json');
    await writeFile(artifactPath, `${JSON.stringify(unknownVersion)}\n`);
    const validation = await validateArtifact(artifactPath, 'project');
    assert.equal(validation.valid, false);
    await assert.rejects(
      execFileAsync(process.execPath, [`${ROOT}/scripts/validate_artifacts.mjs`, 'project', artifactPath]),
      (error) => {
        const output = JSON.parse(error.stdout.trim());
        assert.equal(output.valid, false);
        assert.ok(output.errors.length > 0);
        assert.deepEqual(Object.keys(output.errors[0]).sort(), ['code', 'message', 'path', 'schema']);
        return true;
      },
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('project lifecycle requires auditable gate history before non-intake states', async () => {
  const schema = await loadSchema('project-state');
  const initial = await template('PROJECT_STATE');
  const historylessDelivery = { ...clone(initial), state: 'DELIVERED' };
  assertInvalid(schema, historylessDelivery, 'DELIVERED cannot omit all gates');
  const orphanInvalidation = clone(initial);
  orphanInvalidation.invalidations.push({
    at: '2026-09-01T00:00:00.000Z', fromState: 'INTAKE', rollbackTarget: 'INTAKE',
    disposition: 'rollback', invalidatedRoles: ['TIMELINE'], evidenceDigest: 'a'.repeat(64),
  });
  assertInvalid(schema, orphanInvalidation, 'INTAKE cannot carry an invalidation without transition history');

  const delivered = projectStateAt(initial, 'DELIVERED');
  assertValid(schema, delivered, 'DELIVERED accepts a contiguous INTAKE-rooted history');
  const wrongPrevious = clone(delivered);
  wrongPrevious.previousState = 'INTAKE';
  assertInvalid(schema, wrongPrevious, 'previousState binds to the final transition');
  const unboundGate = clone(delivered);
  unboundGate.gateEvidence[0].digest = 'f'.repeat(64);
  assertInvalid(schema, unboundGate, 'final gate evidence binds to the final transition');
});

test('artifact validation rejects digest mismatch and enforces explicit upstream lineage', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-integrity-'));
  try {
    const project = await template('PROJECT');
    project.integrity.digest = '0'.repeat(64);
    const artifactPath = join(scratch, 'PROJECT.json');
    await writeFile(artifactPath, `${JSON.stringify(project)}\n`);
    const result = await validateArtifact(artifactPath, 'project');
    assert.equal(result.valid, false, 'validateArtifact rejects a stale non-null digest');
    assert.ok(result.errors.some(({ code }) => code === 'E_INTEGRITY_DIGEST_MISMATCH'));
    await assert.rejects(
      execFileAsync(process.execPath, [`${ROOT}/scripts/validate_artifacts.mjs`, 'project', artifactPath]),
      (error) => JSON.parse(error.stdout).errors.some(({ code }) => code === 'E_INTEGRITY_DIGEST_MISMATCH'),
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const segmentsSchema = await loadSchema('segments');
  const segments = await template('SEGMENTS');
  segments.sourceMediaIds = ['media-001'];
  segments.integrity.upstream = { probe: '1'.repeat(64) };
  segments.segments = [{
    segmentId: 'segment-001', mediaId: 'media-001', mediaType: 'video', sourceDigest: '1'.repeat(64), probeDigest: '1'.repeat(64),
    sourceInSeconds: 0, sourceOutSeconds: 1, sourceDurationSeconds: 2,
    sceneScore: 0, motionScore: 0, audioPresent: true, reviewPath: 'review/segments/segment-001.webp', evidenceFrames: [{ path: 'analysis/evidence/segment-001/frame.webp', sourceTimeSeconds: 0.5 }],
  }];
  stampIntegrity(segments);
  assertValid(segmentsSchema, segments, 'SEGMENTS binds its explicit probe digest');
  const extraSegmentUpstream = clone(segments);
  extraSegmentUpstream.integrity.upstream.activity = '2'.repeat(64);
  assertInvalid(segmentsSchema, extraSegmentUpstream, 'SEGMENTS rejects undeclared upstream roles');

  const overlaysSchema = await loadSchema('data-overlays');
  const overlays = await template('DATA_OVERLAYS');
  overlays.status = 'available';
  overlays.activityDigest = 'a'.repeat(64);
  overlays.syncMapDigest = 'b'.repeat(64);
  overlays.integrity.upstream = { activity: overlays.activityDigest, syncMap: overlays.syncMapDigest };
  overlays.overlays = [{
    overlayId: 'overlay-001', metricId: 'metrics.distance', displayAuthority: 'whole-activity',
    syncAuthority: 'whole-activity', wording: 'Distance', colorToken: 'color.dataPrimary',
    destinationInSeconds: 0, destinationOutSeconds: 1,
  }];
  stampIntegrity(overlays);
  assertValid(overlaysSchema, overlays, 'DATA_OVERLAYS binds activity and sync-map digests');
  const staleActivity = clone(overlays);
  staleActivity.integrity.upstream.activity = 'c'.repeat(64);
  assertInvalid(overlaysSchema, staleActivity, 'DATA_OVERLAYS rejects stale activity lineage');

  const timelineSchema = await loadSchema('timeline');
  const timeline = await template('TIMELINE');
  timeline.sourceProbeDigest = 'd'.repeat(64);
  timeline.integrity.upstream = { probe: timeline.sourceProbeDigest };
  timeline.items = [{
    itemId: 'item-001', sourceMediaId: 'media-001', sourceInSeconds: 0,
    sourceOutSeconds: 1, sourceDurationSeconds: 2, destinationInSeconds: 0,
    destinationOutSeconds: 1, playbackRate: 1, colorToken: 'color.primaryText',
  }];
  stampIntegrity(timeline);
  assertValid(timelineSchema, timeline, 'TIMELINE binds its probe digest');
  const missingTimelineUpstream = clone(timeline);
  missingTimelineUpstream.integrity.upstream = {};
  assertInvalid(timelineSchema, missingTimelineUpstream, 'TIMELINE requires exact probe lineage');

  const assetsSchema = await loadSchema('asset-manifest');
  const assets = await template('ASSET_MANIFEST');
  assets.designSystemDigest = 'e'.repeat(64);
  assets.lookProfileDigest = 'f'.repeat(64);
  assets.integrity.upstream = { designSystem: assets.designSystemDigest, lookProfile: assets.lookProfileDigest };
  assets.assets = [{
    assetId: 'asset-001', role: 'journey-anchor', provenance: 'generated-interpretive',
    portablePath: 'assets/images/components/anchor.webp', colorToken: 'color.accent', optional: false,
  }];
  stampIntegrity(assets);
  assertValid(assetsSchema, assets, 'ASSET_MANIFEST binds design-system and Look digests');
  const staleLook = clone(assets);
  staleLook.lookProfileDigest = '0'.repeat(64);
  assertInvalid(assetsSchema, staleLook, 'ASSET_MANIFEST rejects stale Look lineage');
});

test('activity validation enforces every metric authority tuple', async () => {
  const schema = await loadSchema('activity');
  const activity = await template('ACTIVITY');
  for (const key of Object.keys(activity.reasons)) activity.reasons[key] = 'activity-data-unavailable';
  activity.status = 'available';
  activity.metrics.averageHeartRate = 0;
  activity.availability.heartRate = 'available';
  activity.coverage.heartRate = 0.8;
  activity.reasons.heartRate = null;
  activity.sources.heartRate = 'activity-001:heart-rate';
  activity.metrics.distance = 10;
  assertInvalid(schema, activity, 'one coherent tuple cannot hide another inconsistent metric');

  activity.metrics.distance = null;
  assertValid(schema, activity, 'all tuples are coherent and recorded zero remains valid');
  activity.status = 'unavailable';
  assertInvalid(schema, activity, 'overall unavailable requires every tuple unavailable');
});

test('edit brief leaves profile maturity to profile resolution', async () => {
  const schema = await loadSchema('edit-brief');
  const editBrief = await template('EDIT_BRIEF');
  delete editBrief.sport.maturity;
  assertValid(schema, editBrief, 'EDIT_BRIEF accepts a profile without caller-declared maturity');
  editBrief.sport.maturity = 'release-grade';
  assertInvalid(schema, editBrief, 'EDIT_BRIEF rejects independent maturity claims');
});

test('probe review paths are ID-derived and never expose private source basenames', async () => {
  const schema = await loadSchema('probe');
  const probe = await template('PROBE');
  probe.media = [{
    mediaId: 'media-001', mediaType: 'video', reviewPath: 'review/probe/media-001.mp4',
    sourceDigest: '1'.repeat(64), byteSize: 1024, durationSeconds: 2,
    streams: [{ streamId: 'v:0', type: 'video', codec: 'h264', timeBase: '1/30', frameRate: '30/1', width: 1920, height: 1080 }],
    captureTimestamp: null,
  }];
  probe.integrity.upstream = { mediaIndex: '2'.repeat(64) };
  stampIntegrity(probe);
  assertValid(schema, probe, 'ID-derived review path is valid');
  probe.media[0].reviewPath = 'review/probe/Alice-Sunday-Ride.mp4';
  assertInvalid(schema, probe, 'private source basename is rejected even under a portable namespace');
});

test('data overlays accept only normalized activity metric IDs', async () => {
  const schema = await loadSchema('data-overlays');
  const overlays = await template('DATA_OVERLAYS');
  overlays.status = 'available';
  overlays.activityDigest = 'a'.repeat(64);
  overlays.syncMapDigest = 'b'.repeat(64);
  overlays.integrity.upstream = { activity: overlays.activityDigest, syncMap: overlays.syncMapDigest };
  overlays.overlays = [{
    overlayId: 'overlay-001', metricId: 'metrics.vo2Max', displayAuthority: 'whole-activity',
    syncAuthority: 'whole-activity', wording: 'VO2 max', colorToken: 'color.dataPrimary',
    destinationInSeconds: 0, destinationOutSeconds: 1,
  }];
  stampIntegrity(overlays);
  assertInvalid(schema, overlays, 'nonexistent normalized metric IDs are rejected');
});
