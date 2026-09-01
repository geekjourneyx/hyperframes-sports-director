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
  shots.shots = [
    { shotId: 'shot-001', mediaId: 'media-001', sourceInSeconds: 0, sourceOutSeconds: 2, sourceDurationSeconds: 4, evidenceFrames: ['analysis/evidence/shot-001.webp'], confidence: 0.9 },
    { shotId: 'shot-002', mediaId: 'media-001', sourceInSeconds: 2, sourceOutSeconds: 4, sourceDurationSeconds: 4, evidenceFrames: ['analysis/evidence/shot-002.webp'], confidence: 0.8 },
  ];
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
  assetManifest.assets = [{
    assetId: 'asset-001', role: 'journey-anchor', provenance: 'generated-interpretive',
    portablePath: 'assets/images/components/anchor.webp', colorToken: 'color.accent',
    optional: false,
  }];
  assertValid(schemas['asset-manifest'], assetManifest, 'independent design and Look revisions');
  const arbitraryColor = clone(assetManifest);
  arbitraryColor.assets[0].colorToken = '#ff0000';
  assertInvalid(schemas['asset-manifest'], arbitraryColor, 'assets reference semantic tokens, not arbitrary colors');

  const probe = await template('PROBE');
  probe.media = [{
    mediaId: 'media-001', mediaType: 'video', reviewPath: 'analysis/probe/media-001.json',
    sourceDigest: '1'.repeat(64), byteSize: 1024, durationSeconds: 12,
    streams: [{ streamId: 'v:0', type: 'video', codec: 'h264', timeBase: '1/30000', frameRate: '30000/1001', width: 3840, height: 2160 }],
    captureTimestamp: '2026-08-31T12:00:00.000Z',
  }];
  probe.integrity.upstream.mediaIndex = '7'.repeat(64);
  assertValid(schemas.probe, probe, 'probe owns normalized media facts');
  const absoluteProbe = clone(probe);
  absoluteProbe.media[0].reviewPath = '/Users/alice/private-ride.mov';
  assertInvalid(schemas.probe, absoluteProbe, 'probe cannot expose an absolute input path');
  const privateFilenameProbe = clone(probe);
  privateFilenameProbe.media[0].privateFilename = 'alice-private-ride.mov';
  assertInvalid(schemas.probe, privateFilenameProbe, 'probe cannot expose a private filename field');

  const segments = await template('SEGMENTS');
  segments.sourceMediaIds = ['media-001'];
  segments.integrity.upstream.probe = '8'.repeat(64);
  segments.segments = [{
    segmentId: 'segment-001', mediaId: 'media-001', probeDigest: '8'.repeat(64),
    sourceInSeconds: 1, sourceOutSeconds: 5, sourceDurationSeconds: 12,
    reviewPath: 'analysis/segments/segment-001.webp',
  }];
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
  overlays.overlays = [{
    overlayId: 'overlay-001', metricId: 'metrics.averageHeartRate', displayAuthority: 'chapter-summary',
    syncAuthority: 'whole-activity', wording: 'Average heart rate unavailable', colorToken: 'color.dataPrimary',
    destinationInSeconds: 10, destinationOutSeconds: 14,
  }];
  assertValid(schemas['data-overlays'], overlays, 'data overlays reference normalized metrics and authority digests');
  const calculatedOverlay = clone(overlays);
  calculatedOverlay.overlays[0].value = 160;
  assertInvalid(schemas['data-overlays'], calculatedOverlay, 'data overlays cannot independently calculate values');

  const timeline = await template('TIMELINE');
  timeline.status = 'draft';
  timeline.designRevision = 'design-7';
  timeline.lookRevision = 'look-11';
  timeline.sourceProbeDigest = '8'.repeat(64);
  timeline.items = [
    { itemId: 'item-001', sourceMediaId: 'media-001', sourceInSeconds: 1, sourceOutSeconds: 4, sourceDurationSeconds: 12, destinationInSeconds: 0, destinationOutSeconds: 3, playbackRate: 1, colorToken: 'color.primaryText' },
    { itemId: 'item-002', sourceMediaId: 'media-001', sourceInSeconds: 5, sourceOutSeconds: 8, sourceDurationSeconds: 12, destinationInSeconds: 3, destinationOutSeconds: 6, playbackRate: 1, colorToken: 'color.primaryText' },
  ];
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
    const value = clone(projectState);
    value.state = state;
    value.stateEnteredAt = '2026-09-01T00:00:00.000Z';
    assertValid(schemas['project-state'], value, `state ${state}`);
  }
  const validStateHistory = clone(projectState);
  validStateHistory.state = 'DELIVERED';
  validStateHistory.transitions = [
    ['INTAKE', 'CAPABILITY_CHECK'], ['CAPABILITY_CHECK', 'SCAN'], ['SCAN', 'ANALYZE'],
    ['ANALYZE', 'ROUGH_CUT'], ['ROUGH_CUT', 'DIRECTOR_REVIEW_READY'],
    ['DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK'], ['DIRECTOR_LOCK', 'STYLE_ANCHOR'],
    ['STYLE_ANCHOR', 'ASSET_PRODUCTION'], ['ASSET_PRODUCTION', 'MOTION_COMPOSITION'],
    ['MOTION_COMPOSITION', 'FINAL_RENDER'], ['FINAL_RENDER', 'FINAL_QA'], ['FINAL_QA', 'DELIVERED'],
  ].map(([from, to], index) => ({ from, to, at: `2026-09-01T00:${String(index).padStart(2, '0')}:00.000Z`, evidenceDigests: { gate: String(index).padStart(64, '0') } }));
  assertValid(schemas['project-state'], validStateHistory, 'main lifecycle transitions are ordered');
  const skippedState = clone(validStateHistory);
  skippedState.transitions[0].to = 'SCAN';
  assertInvalid(schemas['project-state'], skippedState, 'state transitions cannot skip required gates');
  const exitedTerminalState = clone(projectState);
  exitedTerminalState.state = 'CANCELLED';
  exitedTerminalState.transitions = [{
    from: 'BLOCKED', to: 'CANCELLED', at: '2026-09-01T00:00:00.000Z',
    evidenceDigests: { gate: '1'.repeat(64) },
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
