import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { computeArtifactDigest, validateArtifact } from '../lib/contracts.mjs';
import {
  compileDirectionProposals,
  validateDirectionProposals,
} from '../lib/direction-proposals.mjs';
import {
  buildDirectorWorkbench,
  buildWorkbenchModel,
  recordDirectorApproval,
  renderWorkbenchHtml,
  startWorkbenchServer,
} from '../lib/director-workbench.mjs';

const NOW = '2026-09-01T12:00:00.000Z';
const CHROME = {
  background: '#050505', surface: '#0D0D0D', surfaceRaised: '#141414', textPrimary: '#F5F2EA',
  textSecondary: '#A8A29A', accent: '#C9A86A', danger: '#E36B5D', line: '#2A2A2A',
};
const STATES = ['INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT', 'DIRECTOR_REVIEW_READY'];

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requestStatus(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

async function responseBytes(url) {
  const response = await fetch(url);
  return { response, bytes: Buffer.from(await response.arrayBuffer()) };
}

function stamp(value) {
  value.integrity ??= { digest: null, upstream: {} };
  value.integrity.digest = computeArtifactDigest(value);
  return value;
}

function approvalLease({ pid, createdAt, expiresAt, ownerToken = 'a'.repeat(64) }) {
  return stamp({ schemaVersion: '1.0.0', ownerToken, pid, createdAt, expiresAt, integrity: { digest: null, upstream: {} } });
}

async function installApprovalLease(projectRoot, lease, { malformed = false } = {}) {
  const directory = join(projectRoot, 'cache/director-approval.lock');
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(join(directory, 'lease.json'), malformed ? '{"broken":true}\n' : `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
  return directory;
}

async function approvalLockSnapshot(lockPath) {
  const leasePath = join(lockPath, 'lease.json');
  const [directory, lease, bytes] = await Promise.all([stat(lockPath), stat(leasePath), readFile(leasePath)]);
  return { directoryInode: directory.ino, leaseInode: lease.ino, bytes };
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(stamp(value), null, 2)}\n`);
}

async function installSession(projectRoot, session) {
  const directory = join(projectRoot, 'cache/director-workbench-sessions', session.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(join(directory, 'session.json'), `${JSON.stringify({
    id: session.id, csrfDigest: sha(session.csrfToken), expiresAt: session.expiresAt,
  })}\n`, { mode: 0o600 });
}

function evidenceRecord(gate, index) {
  const role = `${gate}_GATE`;
  const digest = sha(`${gate}:${index}`);
  const at = `2026-09-01T00:${String(index).padStart(2, '0')}:00.000Z`;
  return {
    record: {
      gate, role, revision: index, digest, timestamp: at,
      producerCommand: `fixture --gate ${gate}`, qualifiers: ['accepted'], validity: 'valid', invalidatedAt: null,
    },
    transition: { at, role, digest },
  };
}

function stateAt(state) {
  const route = STATES.slice(0, STATES.indexOf(state) + 1);
  if (state === 'INTAKE') {
    return stamp({
      $schema: 'https://hyperframes.local/schemas/project-state.schema.json', schemaVersion: '1.0.0', revision: 1,
      state, previousState: null, stateEnteredAt: NOW, transitions: [], gateEvidence: [], invalidations: [],
      integrity: { digest: null, upstream: {} },
    });
  }
  const gateEvidence = [];
  const transitions = route.slice(1).map((to, offset) => {
    const index = offset + 1;
    const evidence = evidenceRecord(to, index);
    gateEvidence.push(evidence.record);
    return {
      from: route[offset], to, at: evidence.transition.at,
      evidenceDigests: { [evidence.transition.role]: evidence.transition.digest },
      evidenceRevisions: { [evidence.transition.role]: index },
    };
  });
  return stamp({
    $schema: 'https://hyperframes.local/schemas/project-state.schema.json', schemaVersion: '1.0.0', revision: route.length,
    state, previousState: transitions.at(-1).from, stateEnteredAt: transitions.at(-1).at,
    transitions, gateEvidence, invalidations: [], integrity: { digest: null, upstream: {} },
  });
}

function candidate(id, title, accent) {
  const suffix = id.replace('candidate-', '');
  const kinetic = suffix === 'b';
  return {
    candidateId: id,
    title,
    thesis: `${title} follows effort through restraint, scale, and release.`,
    wholeDirection: true,
    representativeEvidenceIds: ['frame-001', 'frame-002'],
    copy: ['THE LONG CLIMB', '06:12 / RIDGELINE'],
    viewport: { width: 1920, height: 1080, aspectRatio: '16:9' },
    informationDensityBudget: { maximumSimultaneousLayers: 3, maximumWordsPerFrame: 12 },
    prototypeKind: 'code-rendered',
    designRevision: `design-${suffix}`,
    designCandidate: {
      candidateId: id,
      tokenNamespace: `direction-${suffix}`,
      semanticColors: { canvas: '#08090A', ink: '#F4F0E6', accent, signal: '#D7D1C3' },
      typography: { journeyTitle: 'editorial-display', chapterTitle: 'condensed-grotesk', annotation: 'mono-ledger' },
    },
    lookRevision: `look-${suffix}`,
    lookCandidate: { candidateId: id, treatment: suffix === 'a' ? 'mineral-cool' : 'warm-emulsion', grain: 'restrained' },
    typographyHierarchy: ['journeyTitle', 'chapterTitle', 'annotation'],
    storyStructure: kinetic ? ['acceleration', 'compression', 'breakaway'] : ['departure', 'effort', 'release'],
    visualWorldPlan: kinetic
      ? { statement: `${title} turns switchback momentum into a paced editorial ledger.`, plannedAssets: ['turn-marker', 'cadence-thread'] }
      : { statement: `${title} uses mineral darkness and editorial restraint.`, plannedAssets: ['chapter-slate', 'route-thread'] },
    componentPlan: kinetic
      ? { components: ['cadence-index', 'turn-marker'], heroAssets: ['switchback-silhouette'] }
      : { components: ['chapter-index', 'effort-marker'], heroAssets: ['summit-silhouette'] },
    layoutProofs: [`review/workbench-assets/prototype-${id}-layout-001.svg`],
    motionStoryboard: [`review/workbench-assets/prototype-${id}-motion-001.svg`],
    assetPlan: { roles: ['journey_anchor', 'chapter_slate', 'effort_marker'], productionImageGenUsed: false },
    musicPlan: { mode: 'provided', trackIds: ['music-001'] },
    risks: kinetic ? ['Keep the cadence ledger legible through rapid direction changes.'] : ['Protect the rider silhouette against dense forest frames.'],
    previewArtifactDigests: {},
  };
}

function interactionFixture() {
  const element = ({ dataset = {}, textContent = '', selected, active = false } = {}) => {
    const listeners = new Map();
    return {
      dataset,
      textContent,
      attributes: new Map(selected === undefined ? [] : [['aria-selected', String(selected)]]),
      classList: {
        active,
        toggle(name, value) { if (name === 'is-active') this.active = value; },
        contains(name) { return name === 'is-active' && this.active; },
      },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      querySelector(selector) { return selector === 'strong' ? { textContent } : null; },
      addEventListener(event, handler) { listeners.set(event, handler); },
      click() { listeners.get('click')?.(); },
    };
  };
  const tabs = [
    element({ dataset: { candidateTab: 'candidate-a' }, textContent: 'MONUMENTAL QUIET', selected: true }),
    element({ dataset: { candidateTab: 'candidate-b' }, textContent: 'KINETIC LEDGER', selected: false }),
  ];
  const stages = [
    element({ dataset: { candidateStage: 'candidate-a' }, active: true }),
    element({ dataset: { candidateStage: 'candidate-b' }, active: false }),
  ];
  const details = [
    element({ dataset: { candidateDetail: 'candidate-a' }, active: true }),
    element({ dataset: { candidateDetail: 'candidate-a' }, active: true }),
    element({ dataset: { candidateDetail: 'candidate-b' }, active: false }),
    element({ dataset: { candidateDetail: 'candidate-b' }, active: false }),
  ];
  const approval = element();
  const label = element({ textContent: 'MONUMENTAL QUIET' });
  const result = element();
  return {
    tabs, stages, details, approval, label,
    document: {
      querySelectorAll(selector) {
        return selector === '[data-candidate-tab]' ? tabs
          : selector === '[data-candidate-stage]' ? stages
            : selector === '[data-candidate-detail]' ? details : [];
      },
      querySelector(selector) {
        return selector === '[data-approve]' ? approval
          : selector === '[data-selected-candidate-label]' ? label
            : selector === '[data-approval-result]' ? result
              : selector === '[data-displayed-digests]' ? { textContent: '{}' } : null;
      },
    },
  };
}

async function fixture(t, { state = 'ROUGH_CUT' } = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'hf-workbench-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(projectRoot, { recursive: true, force: true });
  });
  for (const directory of ['analysis/evidence/media-video-001/segment-001', 'direction', 'edit', 'renders', 'review/workbench-assets', 'cache']) {
    await mkdir(join(projectRoot, directory), { recursive: true });
  }
  const sourceDigest = sha('source-video');
  const editBrief = stamp({
    $schema: 'https://hyperframes.local/schemas/edit-brief.schema.json', schemaVersion: '1.0.0', revision: 2,
    sport: { profile: 'cycling' }, story: { emphasis: ['climb', 'arrival'], tone: 'observational', pacing: 'balanced' },
    duration: { targetSeconds: 180, minSeconds: 150, maxSeconds: 210 },
    music: { mode: 'provided', localTracks: ['music-001'], mixPriority: 'balanced' },
    copy: { modes: ['titles'], language: 'en', tone: 'spare', title: 'THE LONG CLIMB', subtitle: 'RIDGELINE', prohibitedClaims: [] },
    delivery: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: 3840, height: 2160, aspectRatio: '16:9', frameRate: { mode: 'source-compatible', fps: null }, maximumFileSizeBytes: null },
    inclusions: ['arrival'], exclusions: ['setup tail'], privacy: { routeTrimRequired: true, allowIdentities: false },
    remoteCapabilitiesForbidden: true, integrity: { digest: null, upstream: {} },
  });
  const mediaIndex = stamp({
    $schema: 'https://hyperframes.local/schemas/media-index.schema.json', schemaVersion: '1.0.0', revision: 2,
    entries: [{ mediaId: 'media-video-001', mediaType: 'video', sourceRootReadOnly: true, sourceDigest, byteSize: 1024, portablePath: 'media/originals/media-video-001.mp4' }],
    integrity: { digest: null, upstream: {} },
  });
  const probe = stamp({
    $schema: 'https://hyperframes.local/schemas/probe.schema.json', schemaVersion: '1.0.0', revision: 2,
    media: [{
      mediaId: 'media-video-001', mediaType: 'video', reviewPath: 'review/probe/media-video-001.mp4', sourceDigest, byteSize: 1024,
      durationSeconds: 12, streams: [
        { streamId: 'v0', type: 'video', codec: 'h264', timeBase: '1/24', frameRate: '24/1', width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorSpace: 'bt709', colorPrimaries: 'bt709', colorTransfer: 'bt709', colorRange: 'tv', sampleAspectRatio: '1/1' },
        { streamId: 'a0', type: 'audio', codec: 'aac', timeBase: '1/48000', channels: 2, sampleRate: 48000, channelLayout: 'stereo' },
      ], captureTimestamp: null,
      proxy: { kind: 'video', path: 'media/proxies/media-video-001.mp4', sourceDigest, transform: { codec: 'h264', maximumWidth: 1920, maximumHeight: 1080, watermark: 'ANALYSIS PROXY', preserveTimestamps: true, preserveAudio: true, autoOrient: true }, timeMapping: [{ proxyStartSeconds: 0, originalStartSeconds: 0, durationSeconds: 12, rate: '1/1' }] },
    }], integrity: { digest: null, upstream: { mediaIndex: mediaIndex.integrity.digest } },
  });
  const segments = stamp({
    $schema: 'https://hyperframes.local/schemas/segments.schema.json', schemaVersion: '1.0.0', revision: 2,
    sourceMediaIds: ['media-video-001'], segments: [{
      segmentId: 'segment-001', mediaId: 'media-video-001', mediaType: 'video', sourceDigest, probeDigest: probe.integrity.digest,
      sourceInSeconds: 0, sourceOutSeconds: 12, sourceDurationSeconds: 12, sceneScore: 0.7, motionScore: 0.8, audioPresent: true,
      reviewPath: 'analysis/evidence/media-video-001/segment-001.webp', evidenceFrames: [
        { path: 'analysis/evidence/media-video-001/segment-001/evidence-media-video-001-segment-001-frame-001.webp', sourceTimeSeconds: 2 },
        { path: 'analysis/evidence/media-video-001/segment-001/evidence-media-video-001-segment-001-frame-002.webp', sourceTimeSeconds: 8 },
      ],
    }], integrity: { digest: null, upstream: { probe: probe.integrity.digest } },
  });
  const shots = stamp({
    $schema: 'https://hyperframes.local/schemas/shot.schema.json', schemaVersion: '1.0.0', revision: 2, status: 'available',
    shots: [{
      shotId: 'shot-001', mediaId: 'media-video-001', segmentId: 'segment-001', sourceDigest, sourceInSeconds: 0, sourceOutSeconds: 12, sourceDurationSeconds: 12,
      cameraRole: 'pov', actionRole: 'effort', environmentTags: ['forest-climb'], subjectTags: ['rider'],
      quality: { motionIntensity: 'high', blur: 'none', shake: 'minor', exposure: 'good', horizon: 'level', occlusion: 'none' },
      continuity: { screenDirection: 'left-to-right', motionDirection: 'forward', subjectEntry: 'center', subjectExit: 'center', location: 'forest climb', timeRelation: 'continuous' },
      audioSpans: [{ kind: 'ambient', sourceInSeconds: 0, sourceOutSeconds: 12 }], duplicateGroup: null, setupTailLikelihood: 0.03,
      evidenceFrames: [
        'analysis/evidence/media-video-001/segment-001/evidence-media-video-001-segment-001-frame-001.webp',
        'analysis/evidence/media-video-001/segment-001/evidence-media-video-001-segment-001-frame-002.webp',
      ], confidence: 0.91,
    }], integrity: { digest: null, upstream: { probe: probe.integrity.digest, segments: segments.integrity.digest } },
  });
  const timeline = stamp({
    $schema: 'https://hyperframes.local/schemas/timeline.schema.json', schemaVersion: '1.0.0', revision: 2, timelineRevision: 'timeline-2', status: 'available', phase: 'rough',
    designRevision: 'design-1', lookRevision: 'look-1', assetRevision: 'assets-1', motionRevision: 'motion-1', sourceProbeDigest: probe.integrity.digest,
    items: [{
      itemId: 'item-001', shotId: 'shot-001', sourceMediaId: 'media-video-001', sourceKind: 'video', sourceReference: { kind: 'proxy', path: 'media/proxies/media-video-001.mp4', digest: sourceDigest },
      sourceInSeconds: 0, sourceOutSeconds: 12, sourceDurationSeconds: 12, destinationInSeconds: 0, destinationOutSeconds: 12, playbackRate: 1,
      playbackRateCurve: [{ sourceTimeSeconds: 0, rate: 1 }, { sourceTimeSeconds: 12, rate: 1 }],
      transform: { stabilization: { mode: 'off', cropFraction: 0 }, cropReframe: null, stillMotion: null, draftColorTransform: 'neutral', faceTreatment: 'off' },
      audioPolicy: { sourceGainDb: 0, denoise: false, bridge: 'none' }, transition: { kind: 'none', ownerId: null }, assetReferences: [], motionReferences: [], reasons: ['opening effort'], colorToken: 'color.textPrimary',
    }], music: { mode: 'local', path: 'media/music/music-001.m4a', loop: true, loopCrossfadeSeconds: 0.25 }, warningDecisions: [],
    integrity: { digest: null, upstream: { probe: probe.integrity.digest, shots: shots.integrity.digest } },
  });
  const overlays = stamp({
    $schema: 'https://hyperframes.local/schemas/data-overlays.schema.json', schemaVersion: '1.0.0', revision: 1, status: 'unavailable', activityDigest: null, syncMapDigest: null,
    publicRoute: { status: 'unavailable', trimmedRouteId: null }, overlays: [], integrity: { digest: null, upstream: {} },
  });
  const roughBytes = Buffer.from('closed-proxy-mp4-fixture');
  await writeFile(join(projectRoot, 'renders/rough-cut.mp4'), roughBytes);
  const roughCut = {
    schemaVersion: '1.0.0', revision: 2, stateAuthority: 'ROUGH_CUT', artifact: 'renders/rough-cut.mp4', outputDigest: sha(roughBytes),
    closedFileProbe: { valid: true, durationSeconds: 12, width: 960, height: 540, videoCodec: 'h264', audioCodec: 'aac' },
    raster: { width: 960, height: 540 }, watermark: 'ANALYSIS PROXY', preservesAudio: true,
    integrity: { timelineDigest: timeline.integrity.digest, probeDigest: probe.integrity.digest, proxyDigests: [], musicDigest: null },
  };
  const documents = {
    'EDIT_BRIEF.json': editBrief,
    'PROJECT_STATE.json': stateAt(state),
    'analysis/MEDIA_INDEX.json': mediaIndex,
    'analysis/PROBE.json': probe,
    'analysis/SEGMENTS.json': segments,
    'analysis/SHOTS.jsonl': shots,
    'direction/DATA_OVERLAYS.json': overlays,
    'edit/TIMELINE.json': timeline,
  };
  for (const [path, value] of Object.entries(documents)) await writeJson(join(projectRoot, path), value);
  await writeFile(join(projectRoot, 'renders/rough-cut.json'), `${JSON.stringify(roughCut, null, 2)}\n`);
  await writeFile(join(projectRoot, 'analysis/evidence/media-video-001/segment-001.webp'), 'segment-001');
  for (const name of [
    'evidence-media-video-001-segment-001-frame-001.webp',
    'evidence-media-video-001-segment-001-frame-002.webp',
  ]) await writeFile(join(projectRoot, 'analysis/evidence/media-video-001/segment-001', name), name);
  const candidates = [candidate('candidate-a', 'MONUMENTAL QUIET', '#D6A65B'), candidate('candidate-b', 'KINETIC LEDGER', '#63B3A6')];
  for (const proposal of candidates) {
    for (const path of [...proposal.layoutProofs, ...proposal.motionStoryboard]) {
      const content = `<svg xmlns="http://www.w3.org/2000/svg"><text>${proposal.candidateId}</text></svg>`;
      await writeFile(join(projectRoot, path), content);
      proposal.previewArtifactDigests[path] = sha(content);
    }
  }
  return { projectRoot, candidates, documents, roughCut };
}

async function compileAndReady(t) {
  const context = await fixture(t);
  const artifact = await compileDirectionProposals({ projectRoot: context.projectRoot, candidates: context.candidates });
  await writeJson(join(context.projectRoot, 'PROJECT_STATE.json'), stateAt('DIRECTOR_REVIEW_READY'));
  return { ...context, artifact };
}

test('proposal compiler validates current evidence and atomically writes two equal, code-rendered whole directions', async (t) => {
  const { projectRoot, candidates } = await fixture(t);
  const artifact = await compileDirectionProposals({ projectRoot, candidates });
  assert.equal(artifact.status, 'proposed');
  assert.equal(artifact.candidates.length, 2);
  assert.equal(validateDirectionProposals(artifact).valid, true);
  assert.equal((await validateArtifact(join(projectRoot, 'direction/DIRECTION_PROPOSALS.json'), 'direction-proposals')).valid, true);
  assert.deepEqual(artifact.candidates.map(({ representativeEvidenceIds }) => representativeEvidenceIds), [
    ['frame-001', 'frame-002'], ['frame-001', 'frame-002'],
  ]);
  assert.deepEqual(artifact.candidates.map(({ copy }) => copy), [candidates[0].copy, candidates[0].copy]);
  assert.deepEqual(artifact.candidates.map(({ viewport }) => viewport), [candidates[0].viewport, candidates[0].viewport]);
  assert.deepEqual(artifact.candidates.map(({ informationDensityBudget }) => informationDensityBudget), [
    candidates[0].informationDensityBudget, candidates[0].informationDensityBudget,
  ]);
  assert.ok(Object.keys(artifact.integrity.upstream).includes('roughCut'));
  assert.ok(Object.keys(artifact.integrity.upstream).includes('musicPlan'));
  assert.ok(artifact.candidates.every(({ prototypeKind, assetPlan }) => prototypeKind === 'code-rendered' && assetPlan.productionImageGenUsed === false));
  assert.deepEqual((await readdir(join(projectRoot, 'direction'))).sort(), ['DATA_OVERLAYS.json', 'DIRECTION_PROPOSALS.json']);

  const unavailable = { ...artifact, status: 'unavailable', candidates: [] };
  unavailable.integrity.digest = computeArtifactDigest(unavailable);
  assert.equal(validateDirectionProposals(unavailable).valid, true);
  assert.equal(validateDirectionProposals({ ...unavailable, candidates: [candidates[0]] }).valid, false);
  assert.equal(validateDirectionProposals({ ...artifact, candidates: [candidates[0]] }).valid, false);
});

test('proposal compiler rejects mixed candidate tokens, stale evidence, production generation, and unsafe references', async (t) => {
  const variants = [
    { code: 'E_CANDIDATE_MIXED', mutate(value) { value[1].designCandidate.candidateId = 'candidate-a'; } },
    { code: 'E_PRODUCTION_IMAGE_GEN', mutate(value) { value[0].assetPlan.productionImageGenUsed = true; } },
    { code: 'E_REFERENCE_ORIGINAL', mutate(value) { value[0].layoutProofs[0] = 'media/originals/media-video-001.mp4'; } },
    { code: 'E_REFERENCE_REMOTE', mutate(value) { value[0].motionStoryboard[0] = 'https://example.com/story.svg'; } },
    { code: 'E_REFERENCE_EMBEDDED', mutate(value) { value[0].visualWorldPlan.statement = 'data:image/png;base64,AAAA'; } },
    { code: 'E_REFERENCE_TRAVERSAL', mutate(value) { value[0].layoutProofs[0] = '../escape.svg'; } },
    { code: 'E_RAW_GPS', mutate(value) { value[0].risks[0] = 'raw GPS 37.7749,-122.4194'; } },
    { code: 'E_REFERENCE_PRIVATE_NAME', mutate(value) { value[0].layoutProofs[0] = 'review/workbench-assets/Alice-Sunday-Ride.svg'; } },
    { code: 'E_REFERENCE_PRIVATE_NAME', mutate(value) { value[0].motionStoryboard[0] = 'review/workbench-assets/Alice-Motion-Test.svg'; } },
  ];
  for (const variant of variants) {
    const { projectRoot, candidates } = await fixture(t);
    variant.mutate(candidates);
    await assert.rejects(() => compileDirectionProposals({ projectRoot, candidates }), (error) => error.code === variant.code, variant.code);
  }
  const { projectRoot, candidates } = await fixture(t);
  const probe = JSON.parse(await readFile(join(projectRoot, 'analysis/PROBE.json'), 'utf8'));
  probe.revision += 1;
  await writeJson(join(projectRoot, 'analysis/PROBE.json'), probe);
  await assert.rejects(() => compileDirectionProposals({ projectRoot, candidates }), (error) => error.code === 'E_SOURCE_STALE');

  const staleMediaIndex = await fixture(t);
  staleMediaIndex.documents['analysis/MEDIA_INDEX.json'].revision += 1;
  await writeJson(join(staleMediaIndex.projectRoot, 'analysis/MEDIA_INDEX.json'), staleMediaIndex.documents['analysis/MEDIA_INDEX.json']);
  await assert.rejects(
    () => compileDirectionProposals({ projectRoot: staleMediaIndex.projectRoot, candidates: staleMediaIndex.candidates }),
    (error) => error.code === 'E_SOURCE_STALE',
  );

  const privateFrame = await fixture(t);
  const framePath = 'analysis/evidence/media-video-001/segment-001/Alice-Sunday-Ride.webp';
  await writeFile(join(privateFrame.projectRoot, framePath), 'private frame basename');
  privateFrame.documents['analysis/SEGMENTS.json'].segments[0].evidenceFrames[0].path = framePath;
  await writeJson(join(privateFrame.projectRoot, 'analysis/SEGMENTS.json'), privateFrame.documents['analysis/SEGMENTS.json']);
  privateFrame.documents['analysis/SHOTS.jsonl'].shots[0].evidenceFrames[0] = framePath;
  privateFrame.documents['analysis/SHOTS.jsonl'].integrity.upstream.segments = privateFrame.documents['analysis/SEGMENTS.json'].integrity.digest;
  await writeJson(join(privateFrame.projectRoot, 'analysis/SHOTS.jsonl'), privateFrame.documents['analysis/SHOTS.jsonl']);
  privateFrame.documents['edit/TIMELINE.json'].integrity.upstream.shots = privateFrame.documents['analysis/SHOTS.jsonl'].integrity.digest;
  await writeJson(join(privateFrame.projectRoot, 'edit/TIMELINE.json'), privateFrame.documents['edit/TIMELINE.json']);
  privateFrame.roughCut.integrity.timelineDigest = privateFrame.documents['edit/TIMELINE.json'].integrity.digest;
  await writeFile(join(privateFrame.projectRoot, 'renders/rough-cut.json'), `${JSON.stringify(privateFrame.roughCut, null, 2)}\n`);
  await assert.rejects(
    () => compileDirectionProposals({ projectRoot: privateFrame.projectRoot, candidates: privateFrame.candidates }),
    (error) => error.code === 'E_REFERENCE_PRIVATE_NAME',
  );
});

test('proposal compiler accepts only inert local SVG prototypes and rejects active or remote content', async (t) => {
  const variants = [
    { name: 'html', extension: '.html', bytes: '<!doctype html><script>alert(1)</script>' },
    { name: 'script', extension: '.svg', bytes: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
    { name: 'event attribute', extension: '.svg', bytes: '<svg xmlns="http://www.w3.org/2000/svg"><rect onclick="alert(1)"/></svg>' },
    { name: 'foreign object', extension: '.svg', bytes: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><iframe/></foreignObject></svg>' },
    { name: 'remote href', extension: '.svg', bytes: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/a.png"/></svg>' },
    { name: 'remote CSS URL', extension: '.svg', bytes: '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://example.com/a.svg)}</style></svg>' },
    { name: 'remote font', extension: '.svg', bytes: '<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{font-family:x;src:url(font.woff2)}</style></svg>' },
    { name: 'CSS import', extension: '.svg', bytes: '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "theme.css";</style></svg>' },
    { name: 'embedded data', extension: '.svg', bytes: '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>' },
  ];
  for (const variant of variants) {
    const { projectRoot, candidates } = await fixture(t);
    const proposal = candidates[0];
    const oldPath = proposal.layoutProofs[0];
    const path = oldPath.replace(/\.svg$/, variant.extension);
    proposal.layoutProofs[0] = path;
    delete proposal.previewArtifactDigests[oldPath];
    proposal.previewArtifactDigests[path] = sha(variant.bytes);
    await writeFile(join(projectRoot, path), variant.bytes);
    await assert.rejects(
      () => compileDirectionProposals({ projectRoot, candidates }),
      (error) => error.code === 'E_PROTOTYPE_ACTIVE_CONTENT',
      variant.name,
    );
  }
});

test('proposal compiler rejects structural SVG bypasses and malformed XML', async (t) => {
  const variants = [
    ['prefixed script', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>'],
    ['prefixed event attribute', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="urn:x"><rect s:onclick="alert(1)"/></svg>'],
    ['CSS escape', '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:u\\72l(https://example.com/a.svg)"/></svg>'],
    ['style element', '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:red}</style></svg>'],
    ['unknown element', '<svg xmlns="http://www.w3.org/2000/svg"><a><text>link</text></a></svg>'],
    ['unknown attribute', '<svg xmlns="http://www.w3.org/2000/svg"><rect mystery="value"/></svg>'],
    ['doctype entity', '<!DOCTYPE svg [<!ENTITY payload SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><text>&payload;</text></svg>'],
    ['processing instruction', '<?xml-stylesheet href="https://example.com/a.css"?><svg xmlns="http://www.w3.org/2000/svg"><text>x</text></svg>'],
    ['obfuscated element', '<svg xmlns="http://www.w3.org/2000/svg"><s&#x63;ript>alert(1)</s&#x63;ript></svg>'],
    ['obfuscated URL', '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="java&#x73;cript:alert(1)"/></svg>'],
    ['unbalanced XML', '<svg xmlns="http://www.w3.org/2000/svg"><g><rect/></svg>'],
    ['trailing document', '<svg xmlns="http://www.w3.org/2000/svg"></svg><svg xmlns="http://www.w3.org/2000/svg"></svg>'],
  ];
  for (const [name, bytes] of variants) {
    const { projectRoot, candidates } = await fixture(t);
    const path = candidates[0].layoutProofs[0];
    candidates[0].previewArtifactDigests[path] = sha(bytes);
    await writeFile(join(projectRoot, path), bytes);
    await assert.rejects(
      () => compileDirectionProposals({ projectRoot, candidates }),
      (error) => error.code === 'E_PROTOTYPE_ACTIVE_CONTENT',
      name,
    );
  }
});

test('proposal compiler accepts the strict code-rendered SVG subset', async (t) => {
  const { projectRoot, candidates } = await fixture(t);
  const safe = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080"><defs><linearGradient id="signal" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#C9A86A"/><stop offset="100%" stop-color="#F5F2EA"/></linearGradient></defs><g opacity="0.9" transform="translate(24 24)"><rect id="panel" x="0" y="0" width="1872" height="1032" rx="24" fill="url(#signal)"/><path d="M 80 900 L 960 180 L 1840 900" fill="none" stroke="#050505" stroke-width="12"/><text x="80" y="980" fill="#050505" font-size="64" font-weight="700">Direction 01</text></g></svg>';
  for (const candidate of candidates) {
    for (const path of [...candidate.layoutProofs, ...candidate.motionStoryboard]) {
      candidate.previewArtifactDigests[path] = sha(safe);
      await writeFile(join(projectRoot, path), safe);
    }
  }
  const result = await compileDirectionProposals({ projectRoot, candidates });
  assert.equal(result.candidates.length, 2);
});

test('workbench is a deterministic escaped evidence view with isolated candidates and one dominant director canvas', async (t) => {
  const { projectRoot, artifact } = await compileAndReady(t);
  const first = await buildWorkbenchModel(projectRoot);
  const second = await buildWorkbenchModel(projectRoot);
  assert.equal(first.sourceProposalDigest, artifact.integrity.digest, 'the view binds the unchanged source proposal artifact');
  assert.deepEqual(first.proposals.candidates.map(({ candidateId }) => candidateId), artifact.candidates.map(({ candidateId }) => candidateId));
  assert.deepEqual(second, first);
  assert.ok(first.keyFrames.every(({ path }) => path.startsWith(`review/workbench-assets/${first.bundleDigest}/`)));
  assert.ok(first.keyFrames.every(({ path }) => !path.includes('analysis/evidence')));
  assert.ok(first.proposals.candidates.every(({ layoutProofs, motionStoryboard }) => [...layoutProofs, ...motionStoryboard]
    .every((path) => path.startsWith(`review/workbench-assets/${first.bundleDigest}/`))));
  const htmlA = renderWorkbenchHtml(first);
  const htmlB = renderWorkbenchHtml(second);
  assert.equal(htmlA, htmlB);
  for (const copy of ['THE LONG CLIMB', 'DIRECTOR REVIEW', 'KEY FRAMES', 'SHOT LEDGER', 'ROUGH CUT', 'STORY ARC', 'LOCAL MUSIC', 'VISUAL WORLD', 'COMPONENT / HERO PLAN', 'LAYOUT PROOF', 'MOTION STORYBOARD', 'RISKS', 'Approve MONUMENTAL QUIET']) {
    assert.ok(htmlA.includes(copy), copy);
  }
  assert.ok(htmlA.includes('shot-001'));
  assert.ok(htmlA.includes('POV / EFFORT'));
  for (const value of Object.values(CHROME)) assert.ok(htmlA.includes(value));
  assert.match(htmlA, /class="direction-canvas[^"\n]*"[^>]+style="--candidate-/);
  assert.match(htmlA, /class="direction-stage is-active"/);
  assert.ok(htmlA.indexOf('direction-stage is-active') < htmlA.indexOf('candidate-filmstrip'));
  assert.equal(htmlA.includes('/tmp/'), false);
  assert.equal(htmlA.includes('media/originals'), false);
  assert.equal(htmlA.includes('data:image'), false);
  assert.equal(htmlA.includes('https://'), false);
  const outputA = await buildDirectorWorkbench(projectRoot);
  const bytesA = await readFile(join(projectRoot, outputA.path));
  for (const path of [first.stylesheetPath, first.scriptPath, first.roughCut.path, ...first.keyFrames.map(({ path }) => path)]) {
    assert.equal((await stat(join(projectRoot, path))).isFile(), true, path);
  }
  assert.equal(await readFile(join(projectRoot, artifact.candidates[0].layoutProofs[0]), 'utf8'), '<svg xmlns="http://www.w3.org/2000/svg"><text>candidate-a</text></svg>');
  const outputB = await buildDirectorWorkbench(projectRoot);
  const bytesB = await readFile(join(projectRoot, outputB.path));
  assert.deepEqual(bytesA, bytesB, 'identical inputs produce byte-identical canonical HTML');
  assert.equal(outputA.digest, outputB.digest);
  assert.deepEqual(Object.keys(first.displayedArtifactDigests).sort(), ['assetPlan', 'editBrief', 'evidence', 'musicPlan', 'proposals', 'roughCut']);

  const escaped = structuredClone(first);
  escaped.brief.copy.title = '<img src=x onerror=alert(1)>';
  const safe = renderWorkbenchHtml(escaped);
  assert.ok(safe.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(safe.includes('<img src=x'), false);
});

test('candidate selection reveals only the matching server-rendered detail and names the approval target', async (t) => {
  const { projectRoot } = await compileAndReady(t);
  const model = await buildWorkbenchModel(projectRoot);
  const html = renderWorkbenchHtml(model);
  assert.match(html, /candidate-story-detail is-active" data-candidate-detail="candidate-a"/);
  assert.match(html, /candidate-rail-detail is-active" data-candidate-detail="candidate-a"/);
  assert.match(html, /candidate-story-detail" data-candidate-detail="candidate-b"/);
  assert.match(html, /candidate-rail-detail" data-candidate-detail="candidate-b"/);
  assert.match(html, /departure/);
  assert.match(html, /summit-silhouette/);
  assert.match(html, /acceleration/);
  assert.match(html, /switchback-silhouette/);
  assert.match(html, /rapid direction changes/);
  assert.equal((html.match(/data-candidate-detail="candidate-a"/g) ?? []).length, 2);
  assert.equal((html.match(/data-candidate-detail="candidate-b"/g) ?? []).length, 2);
  assert.match(html, /Same evidence · same copy · same density/);
  assert.match(html, /LOCAL MUSIC/);
  for (const frame of model.keyFrames) {
    assert.equal((html.match(new RegExp(`data-candidate-evidence-id="${frame.frameId}"`, 'g')) ?? []).length, model.proposals.candidates.length,
      `every candidate canvas binds shared review evidence ${frame.frameId}`);
    assert.equal((html.match(new RegExp(`src="${frame.path.replace('review/', '')}"`, 'g')) ?? []).length >= model.proposals.candidates.length, true);
  }
  for (const candidate of model.proposals.candidates) {
    for (const [kind, paths] of [['layout', candidate.layoutProofs], ['motion', candidate.motionStoryboard]]) {
      for (const path of paths) {
        const safeUrl = path.replace('review/', '');
        const basename = safeUrl.split('/').at(-1);
        const label = kind === 'motion' ? 'motion storyboard' : kind;
        assert.match(html, new RegExp(`<img class="candidate-proof-image" src="${safeUrl}" alt="${candidate.title} ${label} proof`));
        assert.equal(html.includes(`<li>${basename}</li>`), false, 'proofs render as images rather than basename-only lists');
      }
    }
  }
  assert.equal((html.match(/class="candidate-proof-strip"/g) ?? []).length, model.proposals.candidates.length);

  const fixture = interactionFixture();
  const script = await readFile(new URL('../../assets/director-workbench/workbench.js', import.meta.url), 'utf8');
  vm.runInNewContext(script, { document: fixture.document });
  fixture.tabs[1].click();
  assert.equal(fixture.stages[0].classList.contains('is-active'), false);
  assert.equal(fixture.stages[1].classList.contains('is-active'), true);
  assert.deepEqual(fixture.details.map((detail) => detail.classList.contains('is-active')), [false, false, true, true]);
  assert.equal(fixture.approval.textContent, 'Approve KINETIC LEDGER');
  assert.equal(fixture.label.textContent, 'KINETIC LEDGER');

  fixture.tabs[0].click();
  assert.equal(fixture.stages[0].classList.contains('is-active'), true);
  assert.deepEqual(fixture.details.map((detail) => detail.classList.contains('is-active')), [true, true, false, false]);
  assert.equal(fixture.approval.textContent, 'Approve MONUMENTAL QUIET');
  assert.equal(fixture.label.textContent, 'MONUMENTAL QUIET');
});

test('approval is a first-screen decision after the progress and brief, before candidate production detail', async (t) => {
  const { projectRoot } = await compileAndReady(t);
  const html = renderWorkbenchHtml(await buildWorkbenchModel(projectRoot));
  const approval = html.indexOf('<section class="approval-zone">');
  assert.ok(approval > html.indexOf('<section class="rail-section"><h3>BRIEF</h3>'));
  assert.ok(approval < html.indexOf('candidate-rail-detail is-active'));
  assert.match(html.slice(approval), /<h2 data-selected-candidate-label>MONUMENTAL QUIET<\/h2>/);
  assert.match(html.slice(approval), /SINGLE APPROVAL GATE/);
  assert.match(html.slice(approval), /One approval records the selected whole direction/);
});

test('workbench publishes a complete immutable asset bundle before replacing canonical HTML', async (t) => {
  const context = await compileAndReady(t);
  const oldBuild = await buildDirectorWorkbench(context.projectRoot);
  const canonicalPath = join(context.projectRoot, oldBuild.path);
  const oldHtml = await readFile(canonicalPath);
  const oldBundleRoot = join(context.projectRoot, 'review/workbench-assets', oldBuild.bundleDigest);
  const oldBundleNames = (await readdir(oldBundleRoot)).sort();
  const oldBundleBytes = await Promise.all(oldBundleNames.map((name) => readFile(join(oldBundleRoot, name))));

  const changedPath = context.candidates[0].layoutProofs[0];
  const changedBytes = '<svg xmlns="http://www.w3.org/2000/svg"><text>candidate-a revision 2</text></svg>';
  await writeFile(join(context.projectRoot, changedPath), changedBytes);
  context.candidates[0].previewArtifactDigests[changedPath] = sha(changedBytes);
  await compileDirectionProposals({ projectRoot: context.projectRoot, candidates: context.candidates });
  await assert.rejects(
    () => buildDirectorWorkbench(context.projectRoot, {
      beforeBundlePublish: async () => { throw Object.assign(new Error('injected bundle failure'), { code: 'E_INJECTED_BUNDLE' }); },
    }),
    (error) => error.code === 'E_INJECTED_BUNDLE',
  );

  assert.deepEqual(await readFile(canonicalPath), oldHtml, 'failed staging cannot replace the canonical view');
  assert.deepEqual((await readdir(oldBundleRoot)).sort(), oldBundleNames);
  for (const [index, name] of oldBundleNames.entries()) {
    assert.deepEqual(await readFile(join(oldBundleRoot, name)), oldBundleBytes[index], name);
  }
  const bundleEntries = await readdir(join(context.projectRoot, 'review/workbench-assets'), { withFileTypes: true });
  assert.deepEqual(bundleEntries.filter((entry) => entry.isDirectory()).map(({ name }) => name), [oldBuild.bundleDigest]);
  assert.equal(bundleEntries.some(({ name }) => name.includes('.tmp')), false);

  const currentBuild = await buildDirectorWorkbench(context.projectRoot);
  assert.notEqual(currentBuild.bundleDigest, oldBuild.bundleDigest);
  const currentHtml = await readFile(canonicalPath, 'utf8');
  assert.ok(currentHtml.includes(currentBuild.bundleDigest));
  assert.equal((await stat(join(context.projectRoot, 'review/workbench-assets', currentBuild.bundleDigest))).isDirectory(), true);
});

test('approval is one current atomic hash-bound decision and never freezes or transitions project state', async (t) => {
  const { projectRoot } = await compileAndReady(t);
  const built = await buildDirectorWorkbench(projectRoot);
  const staleSession = { id: 'session-expired-old-01', csrfToken: 'csrf-expired-old', expiresAt: '2026-09-01T11:00:00.000Z' };
  const unrelatedLiveSession = { id: 'session-live-other-01', csrfToken: 'csrf-live-other', expiresAt: '2026-09-01T13:00:00.000Z' };
  await installSession(projectRoot, staleSession);
  await installSession(projectRoot, unrelatedLiveSession);
  const server = await startWorkbenchServer({ projectRoot, port: 0, ttlMs: 60_000, now: () => Date.parse(NOW) });
  t.after(() => server.close());
  assert.ok(server.url.startsWith('http://127.0.0.1:'));
  assert.equal((await stat(server.sessionDir)).mode & 0o777, 0o700);
  await assert.rejects(() => stat(join(projectRoot, 'cache/director-workbench-sessions', staleSession.id)), { code: 'ENOENT' });
  assert.equal((await stat(join(projectRoot, 'cache/director-workbench-sessions', unrelatedLiveSession.id))).isDirectory(), true);
  const model = await buildWorkbenchModel(projectRoot);
  const stateBefore = await readFile(join(projectRoot, 'PROJECT_STATE.json'));
  const result = await recordDirectorApproval({
    projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: model.displayedArtifactDigests,
    workbenchDigest: built.digest, sessionId: server.sessionId, csrfToken: server.csrfToken, session: server.session,
    now: () => NOW,
  });
  assert.equal(result.approval.status, 'approved');
  assert.equal(result.approval.selectedCandidateId, 'candidate-a');
  assert.deepEqual(result.approval.displayedArtifactDigests, model.displayedArtifactDigests);
  assert.equal(result.approval.workbenchDigest, built.digest);
  assert.equal((await validateArtifact(join(projectRoot, 'direction/DIRECTOR_APPROVAL.json'), 'director-approval')).valid, true);
  assert.deepEqual(await readFile(join(projectRoot, 'PROJECT_STATE.json')), stateBefore);
  assert.equal((await readdir(join(projectRoot, 'direction'))).some((name) => name.includes('LOCK')), false);
  await assert.rejects(() => recordDirectorApproval({
    projectRoot, selectedCandidateId: 'candidate-b', displayedArtifactDigests: model.displayedArtifactDigests,
    workbenchDigest: built.digest, sessionId: server.sessionId, csrfToken: server.csrfToken, session: server.session, now: () => NOW,
  }), (error) => error.code === 'E_APPROVAL_EXISTS');

  const servedModel = await buildWorkbenchModel(projectRoot);
  const response = await fetch(new URL(servedModel.keyFrames[0].path.slice('review/'.length), server.url));
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${server.url}../EDIT_BRIEF.json`)).status, 404);
  await server.close();
  await assert.rejects(() => stat(server.sessionDir), { code: 'ENOENT' });
  assert.equal((await stat(join(projectRoot, 'cache/director-workbench-sessions', unrelatedLiveSession.id))).isDirectory(), true);
});

test('HTTP workbench authenticates every session route and expires with exact cleanup and automatic close', async (t) => {
  const { projectRoot } = await compileAndReady(t);
  await installSession(projectRoot, { id: 'session-unrelated-live', csrfToken: 'csrf-unrelated-live', expiresAt: '2026-09-01T13:00:00.000Z' });
  let clock = Date.parse(NOW);
  const server = await startWorkbenchServer({ projectRoot, port: 0, ttlMs: 60_000, now: () => clock });
  t.after(() => server.close());
  const sessionUrl = new URL(server.url);
  assert.match(sessionUrl.pathname, /^\/session-[0-9a-f]{64}\/$/);
  assert.equal(sessionUrl.search, '');
  assert.equal((await stat(server.sessionDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(server.sessionDir, 'session.json'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(server.sessionDir, 'session.json'), 'utf8')).includes(server.csrfToken), false);

  const rootUrl = new URL('/', sessionUrl);
  assert.equal((await fetch(rootUrl)).status, 404);
  assert.equal((await fetch(new URL('/approval', sessionUrl), { method: 'POST', body: '{}' })).status, 404);
  assert.equal((await fetch(new URL('/session-not-the-owner/', sessionUrl))).status, 404);
  assert.equal(await requestStatus(sessionUrl, { host: `localhost:${sessionUrl.port}` }), 403);

  const page = await fetch(sessionUrl);
  assert.equal(page.status, 200);
  const pageCsp = page.headers.get('content-security-policy');
  assert.match(pageCsp, /script-src 'self'(?:;|$)/);
  assert.equal(pageCsp.includes("script-src 'self' 'unsafe-inline'"), false);
  const model = await buildWorkbenchModel(projectRoot);
  const asset = await fetch(new URL(model.keyFrames[0].path.slice('review/'.length), sessionUrl));
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
  const svg = await fetch(new URL(model.proposals.candidates[0].layoutProofs[0].slice('review/'.length), sessionUrl));
  assert.equal(svg.status, 200);
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
  assert.equal(svg.headers.get('x-content-type-options'), 'nosniff');
  assert.match(svg.headers.get('content-security-policy'), /script-src 'none'/);
  assert.match(svg.headers.get('content-security-policy'), /(?:^|;) sandbox(?:;|$)/);

  clock += 60_001;
  const expired = await fetch(sessionUrl);
  assert.equal(expired.status, 410);
  await server.closed;
  await assert.rejects(() => stat(server.sessionDir), { code: 'ENOENT' });
  assert.equal((await stat(join(projectRoot, 'cache/director-workbench-sessions/session-unrelated-live'))).isDirectory(), true);

  const auto = await startWorkbenchServer({ projectRoot, port: 0, ttlMs: 40 });
  t.after(() => auto.close());
  await Promise.race([
    auto.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('expiry close timed out')), 1_000)),
  ]);
  await assert.rejects(() => stat(auto.sessionDir), { code: 'ENOENT' });
  await assert.rejects(() => fetch(auto.url));
});

test('HTTP workbench freezes verified bundle responses and fails closed after post-start disk mutation', async (t) => {
  const { projectRoot } = await compileAndReady(t);
  const built = await buildDirectorWorkbench(projectRoot);
  const model = await buildWorkbenchModel(projectRoot);
  const paths = [model.stylesheetPath, model.scriptPath, model.proposals.candidates[0].layoutProofs[0]];
  const originals = new Map(await Promise.all(paths.map(async (path) => [path, await readFile(join(projectRoot, path))])));
  const server = await startWorkbenchServer({ projectRoot, port: 0, ttlMs: 60_000, now: () => Date.parse(NOW) });
  t.after(() => server.close());

  const initialPage = await responseBytes(server.url);
  assert.equal(initialPage.response.status, 200);
  for (const path of paths) {
    const { response, bytes } = await responseBytes(new URL(path.slice('review/'.length), server.url));
    assert.equal(response.status, 200);
    assert.deepEqual(bytes, originals.get(path), path);
  }

  await Promise.all([
    writeFile(join(projectRoot, built.path), '<script>attacker-html</script>'),
    writeFile(join(projectRoot, model.stylesheetPath), 'attacker-css'),
    writeFile(join(projectRoot, model.scriptPath), 'attacker-js'),
    writeFile(join(projectRoot, model.proposals.candidates[0].layoutProofs[0]), '<svg><script>attacker-svg</script></svg>'),
  ]);
  const laterPage = await responseBytes(server.url);
  assert.deepEqual(laterPage.bytes, initialPage.bytes, 'session-injected HTML is frozen per session');
  assert.equal(laterPage.bytes.includes(Buffer.from('attacker-html')), false);
  for (const path of paths) {
    const { bytes } = await responseBytes(new URL(path.slice('review/'.length), server.url));
    assert.deepEqual(bytes, originals.get(path), `GET never serves post-start disk bytes: ${path}`);
  }

  const approval = await fetch(new URL('approval', server.url), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      selectedCandidateId: 'candidate-a', displayedArtifactDigests: model.displayedArtifactDigests,
      workbenchDigest: built.digest, sessionId: server.sessionId, csrfToken: server.csrfToken,
    }),
  });
  assert.equal(approval.status, 400, 'approval must not accept digests after canonical evidence becomes stale');
  await assert.rejects(() => stat(join(projectRoot, 'direction/DIRECTOR_APPROVAL.json')), { code: 'ENOENT' });
});

test('HTTP workbench removes only its new session when a real occupied port rejects listen', async (t) => {
  const { projectRoot } = await compileAndReady(t);
  const live = { id: 'session-unrelated-live-port', csrfToken: 'csrf-unrelated-live-port', expiresAt: '2026-09-01T13:00:00.000Z' };
  await installSession(projectRoot, live);
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const { port } = blocker.address();

  await assert.rejects(() => startWorkbenchServer({ projectRoot, port, ttlMs: 60_000, now: () => Date.parse(NOW) }),
    (error) => error.code === 'EADDRINUSE');
  const sessions = await readdir(join(projectRoot, 'cache/director-workbench-sessions'));
  assert.deepEqual(sessions, [live.id]);
  assert.equal((await stat(join(projectRoot, 'cache/director-workbench-sessions', live.id))).isDirectory(), true);
});

test('approval uses one project-scoped exclusive transaction across revalidation and atomic write', async (t) => {
  const { projectRoot } = await compileAndReady(t);
  const built = await buildDirectorWorkbench(projectRoot);
  const model = await buildWorkbenchModel(projectRoot);
  const session = { id: 'session-exclusive-lock', csrfToken: 'csrf-exclusive-lock', expiresAt: '2026-09-01T12:05:00.000Z' };
  await installSession(projectRoot, session);

  let announceLocked;
  const locked = new Promise((resolve) => { announceLocked = resolve; });
  let releaseWrite;
  const mayWrite = new Promise((resolve) => { releaseWrite = resolve; });
  const request = {
    projectRoot, displayedArtifactDigests: model.displayedArtifactDigests, workbenchDigest: built.digest,
    sessionId: session.id, csrfToken: session.csrfToken, now: () => NOW,
  };
  const first = recordDirectorApproval({
    ...request, selectedCandidateId: 'candidate-a',
    beforeRename: async () => { announceLocked(); await mayWrite; },
  });
  await locked;
  await assert.rejects(
    () => recordDirectorApproval({ ...request, selectedCandidateId: 'candidate-b' }),
    (error) => error.code === 'E_APPROVAL_BUSY',
  );
  releaseWrite();
  assert.equal((await first).approval.selectedCandidateId, 'candidate-a');
  await assert.rejects(
    () => recordDirectorApproval({ ...request, selectedCandidateId: 'candidate-b' }),
    (error) => error.code === 'E_APPROVAL_EXISTS',
  );
});

test('approval lock is an integrity-checked owner-only lease and ordinary write failure releases it', async (t) => {
  const { projectRoot } = await compileAndReady(t);
  const built = await buildDirectorWorkbench(projectRoot);
  const model = await buildWorkbenchModel(projectRoot);
  const session = { id: 'session-lease-metadata', csrfToken: 'csrf-lease-metadata', expiresAt: '2026-09-01T12:05:00.000Z' };
  await installSession(projectRoot, session);
  const lockPath = join(projectRoot, 'cache/director-approval.lock');
  await assert.rejects(() => recordDirectorApproval({
    projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: model.displayedArtifactDigests,
    workbenchDigest: built.digest, sessionId: session.id, csrfToken: session.csrfToken, now: () => NOW,
    beforeRename: async () => {
      const leasePath = join(lockPath, 'lease.json');
      assert.equal((await stat(lockPath)).mode & 0o777, 0o700);
      assert.equal((await stat(leasePath)).mode & 0o777, 0o600);
      const lease = JSON.parse(await readFile(leasePath, 'utf8'));
      assert.equal(lease.pid, process.pid);
      assert.match(lease.ownerToken, /^[0-9a-f]{64}$/);
      assert.equal(lease.integrity.digest, computeArtifactDigest(lease));
      assert.ok(Date.parse(lease.expiresAt) > Date.parse(lease.createdAt));
      throw Object.assign(new Error('injected approval write failure'), { code: 'E_INJECTED_WRITE' });
    },
  }), (error) => error.code === 'E_INJECTED_WRITE');
  await assert.rejects(() => stat(lockPath), { code: 'ENOENT' });
});

test('approval recovers only an expired integrity-valid abandoned lease whose owner is confirmed dead', async (t) => {
  const { projectRoot } = await compileAndReady(t);
  const built = await buildDirectorWorkbench(projectRoot);
  const model = await buildWorkbenchModel(projectRoot);
  const session = { id: 'session-dead-lease-01', csrfToken: 'csrf-dead-lease', expiresAt: '2026-09-01T12:05:00.000Z' };
  await installSession(projectRoot, session);
  await installApprovalLease(projectRoot, approvalLease({
    pid: 99_999_999, createdAt: '2026-09-01T10:00:00.000Z', expiresAt: '2026-09-01T11:00:00.000Z',
  }));
  const result = await recordDirectorApproval({
    projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: model.displayedArtifactDigests,
    workbenchDigest: built.digest, sessionId: session.id, csrfToken: session.csrfToken, now: () => NOW,
  });
  assert.equal(result.approval.selectedCandidateId, 'candidate-a');
  await assert.rejects(() => stat(join(projectRoot, 'cache/director-approval.lock')), { code: 'ENOENT' });
});

test('approval never reclaims an unexpired lease even when its owner is confirmed dead', async (t) => {
  const { projectRoot } = await compileAndReady(t);
  const built = await buildDirectorWorkbench(projectRoot);
  const model = await buildWorkbenchModel(projectRoot);
  const session = { id: 'session-dead-unexpired', csrfToken: 'csrf-dead-unexpired', expiresAt: '2026-09-01T12:05:00.000Z' };
  await installSession(projectRoot, session);
  const lockPath = await installApprovalLease(projectRoot, approvalLease({
    pid: 99_999_999, createdAt: '2026-09-01T11:59:00.000Z', expiresAt: '2026-09-01T12:01:00.000Z',
  }));
  const before = await approvalLockSnapshot(lockPath);
  await assert.rejects(() => recordDirectorApproval({
    projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: model.displayedArtifactDigests,
    workbenchDigest: built.digest, sessionId: session.id, csrfToken: session.csrfToken, now: () => NOW,
  }), (error) => error.code === 'E_APPROVAL_BUSY');
  assert.deepEqual(await approvalLockSnapshot(lockPath), before);
});

test('approval leaves an expired lease byte-identical when owner liveness is indeterminate', async (t) => {
  const { projectRoot } = await compileAndReady(t);
  const built = await buildDirectorWorkbench(projectRoot);
  const model = await buildWorkbenchModel(projectRoot);
  const session = { id: 'session-owner-eperm-01', csrfToken: 'csrf-owner-eperm', expiresAt: '2026-09-01T12:05:00.000Z' };
  await installSession(projectRoot, session);
  const lockPath = await installApprovalLease(projectRoot, approvalLease({
    pid: 99_999_999, createdAt: '2026-09-01T10:00:00.000Z', expiresAt: '2026-09-01T11:00:00.000Z',
  }));
  const before = await approvalLockSnapshot(lockPath);
  await assert.rejects(() => recordDirectorApproval({
    projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: model.displayedArtifactDigests,
    workbenchDigest: built.digest, sessionId: session.id, csrfToken: session.csrfToken, now: () => NOW,
  }, {
    ownerProbe: () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); },
  }), (error) => error.code === 'E_APPROVAL_LOCK_UNCONFIRMED');
  assert.deepEqual(await approvalLockSnapshot(lockPath), before);
});

test('approval fails closed for expired live, malformed, and unowned leases', async (t) => {
  const cases = [
    {
      code: 'E_APPROVAL_BUSY',
      install: (projectRoot) => installApprovalLease(projectRoot, approvalLease({
        pid: process.pid, createdAt: '2026-09-01T10:00:00.000Z', expiresAt: '2026-09-01T11:00:00.000Z',
      })),
    },
    {
      code: 'E_APPROVAL_LOCK_INVALID',
      install: (projectRoot) => installApprovalLease(projectRoot, null, { malformed: true }),
    },
  ];
  for (const entry of cases) {
    const { projectRoot } = await compileAndReady(t);
    const built = await buildDirectorWorkbench(projectRoot);
    const model = await buildWorkbenchModel(projectRoot);
    const session = { id: `session-${entry.code.toLowerCase().replaceAll('_', '-')}`, csrfToken: `csrf-${entry.code}`, expiresAt: '2026-09-01T12:05:00.000Z' };
    await installSession(projectRoot, session);
    const lockPath = await entry.install(projectRoot);
    await assert.rejects(() => recordDirectorApproval({
      projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: model.displayedArtifactDigests,
      workbenchDigest: built.digest, sessionId: session.id, csrfToken: session.csrfToken, now: () => NOW,
    }), (error) => error.code === entry.code, entry.code);
    assert.equal((await stat(lockPath)).isDirectory(), true, `${entry.code} lock must remain`);
  }

  const { projectRoot } = await compileAndReady(t);
  const built = await buildDirectorWorkbench(projectRoot);
  const model = await buildWorkbenchModel(projectRoot);
  const session = { id: 'session-lease-owner-swap', csrfToken: 'csrf-lease-owner-swap', expiresAt: '2026-09-01T12:05:00.000Z' };
  await installSession(projectRoot, session);
  const lockPath = join(projectRoot, 'cache/director-approval.lock');
  await assert.rejects(() => recordDirectorApproval({
    projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: model.displayedArtifactDigests,
    workbenchDigest: built.digest, sessionId: session.id, csrfToken: session.csrfToken, now: () => NOW,
    beforeRename: async () => {
      const leasePath = join(lockPath, 'lease.json');
      const lease = JSON.parse(await readFile(leasePath, 'utf8'));
      lease.ownerToken = 'b'.repeat(64);
      lease.integrity.digest = computeArtifactDigest(lease);
      await writeFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
      throw Object.assign(new Error('ownership changed'), { code: 'E_INJECTED_OWNER_SWAP' });
    },
  }), (error) => error.code === 'E_APPROVAL_LOCK_OWNERSHIP');
  assert.equal((await stat(lockPath)).isDirectory(), true, 'release cannot delete another owner lease');
});

test('approval rejects stale, unauthorized, expired, cross-proposal, wrong-state, non-localhost, and failed writes without residue', async (t) => {
  await assert.rejects(() => startWorkbenchServer({ projectRoot: '/tmp/unused', host: '0.0.0.0' }), (error) => error.code === 'E_BIND_LOCALHOST');
  const cases = [
    { code: 'E_SESSION_REQUIRED', mutate(request) { delete request.csrfToken; } },
    { code: 'E_SESSION_REQUIRED', mutate(request) { request.sessionId = 'wrong-session'; } },
    { code: 'E_SESSION_EXPIRED', mutate(request) { request.now = () => '2026-09-01T13:00:00.000Z'; } },
    { code: 'E_CANDIDATE_UNKNOWN', mutate(request) { request.selectedCandidateId = 'candidate-z'; } },
    { code: 'E_WORKBENCH_STALE', mutate(request) { request.workbenchDigest = sha('stale'); } },
    { code: 'E_DISPLAYED_DIGEST_STALE', mutate(request) { request.displayedArtifactDigests = { ...request.displayedArtifactDigests, evidence: sha('stale') }; } },
  ];
  for (const entry of cases) {
    const { projectRoot } = await compileAndReady(t);
    const built = await buildDirectorWorkbench(projectRoot);
    const session = { id: 'session-0123456789abcdef', csrfToken: 'csrf-0123456789abcdef', expiresAt: '2026-09-01T12:05:00.000Z' };
    await installSession(projectRoot, session);
    const model = await buildWorkbenchModel(projectRoot);
    const request = {
      projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: model.displayedArtifactDigests,
      workbenchDigest: built.digest, sessionId: session.id, csrfToken: session.csrfToken, session, now: () => NOW,
    };
    entry.mutate(request);
    await assert.rejects(() => recordDirectorApproval(request), (error) => error.code === entry.code, entry.code);
  }

  const corrupt = await compileAndReady(t);
  const corruptBuilt = await buildDirectorWorkbench(corrupt.projectRoot);
  const corruptModel = await buildWorkbenchModel(corrupt.projectRoot);
  const corruptSession = { id: 'session-corrupt-approval', csrfToken: 'csrf-corrupt-approval', expiresAt: '2026-09-01T12:05:00.000Z' };
  await installSession(corrupt.projectRoot, corruptSession);
  await writeFile(join(corrupt.projectRoot, 'direction/DIRECTOR_APPROVAL.json'), '{"status":"approved","corrupt":true}\n');
  await assert.rejects(() => recordDirectorApproval({
    projectRoot: corrupt.projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: corruptModel.displayedArtifactDigests,
    workbenchDigest: corruptBuilt.digest, sessionId: corruptSession.id, csrfToken: corruptSession.csrfToken, now: () => NOW,
  }), (error) => error.code === 'E_APPROVAL_INVALID');

  const stale = await compileAndReady(t);
  const staleBuilt = await buildDirectorWorkbench(stale.projectRoot);
  const staleModel = await buildWorkbenchModel(stale.projectRoot);
  stale.documents['EDIT_BRIEF.json'].revision += 1;
  await writeJson(join(stale.projectRoot, 'EDIT_BRIEF.json'), stale.documents['EDIT_BRIEF.json']);
  const session = { id: 'session-stale-artifact', csrfToken: 'csrf-stale-artifact', expiresAt: '2026-09-01T12:05:00.000Z' };
  await installSession(stale.projectRoot, session);
  await assert.rejects(() => recordDirectorApproval({
    projectRoot: stale.projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: staleModel.displayedArtifactDigests,
    workbenchDigest: staleBuilt.digest, sessionId: session.id, csrfToken: session.csrfToken, session, now: () => NOW,
  }), (error) => ['E_SOURCE_STALE', 'E_DISPLAYED_DIGEST_STALE', 'E_WORKBENCH_STALE'].includes(error.code));

  const wrongState = await compileAndReady(t);
  await installSession(wrongState.projectRoot, session);
  await writeJson(join(wrongState.projectRoot, 'PROJECT_STATE.json'), stateAt('ROUGH_CUT'));
  const wrongModel = await buildWorkbenchModel(wrongState.projectRoot, { allowRoughCut: true });
  const wrongWorkbenchDigest = sha('not-observed-because-state-gate-runs-first');
  await assert.rejects(() => recordDirectorApproval({
    projectRoot: wrongState.projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: wrongModel.displayedArtifactDigests,
    workbenchDigest: wrongWorkbenchDigest,
    sessionId: session.id, csrfToken: session.csrfToken, session, now: () => NOW,
  }), (error) => error.code === 'E_APPROVAL_STATE');

  const failed = await compileAndReady(t);
  await installSession(failed.projectRoot, session);
  const failedBuilt = await buildDirectorWorkbench(failed.projectRoot);
  const failedModel = await buildWorkbenchModel(failed.projectRoot);
  const stateBefore = await readFile(join(failed.projectRoot, 'PROJECT_STATE.json'));
  await assert.rejects(() => recordDirectorApproval({
    projectRoot: failed.projectRoot, selectedCandidateId: 'candidate-a', displayedArtifactDigests: failedModel.displayedArtifactDigests,
    workbenchDigest: failedBuilt.digest, sessionId: session.id, csrfToken: session.csrfToken, session, now: () => NOW,
    beforeRename: async () => { throw Object.assign(new Error('injected write failure'), { code: 'E_INJECTED_WRITE' }); },
  }), (error) => error.code === 'E_INJECTED_WRITE');
  await assert.rejects(() => stat(join(failed.projectRoot, 'direction/DIRECTOR_APPROVAL.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(failed.projectRoot, 'PROJECT_STATE.json')), stateBefore);
  assert.deepEqual((await readdir(join(failed.projectRoot, 'direction'))).filter((name) => name.includes('.tmp')), []);
});
