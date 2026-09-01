import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeArtifactDigest } from '../lib/contracts.mjs';
import {
  ApprovalError,
  compileApprovedDesign,
  compileApprovedLook,
  renderLockedWorkbench,
  validateCommittedDirection,
  validateDirectorApproval,
} from '../lib/approval.mjs';
import {
  ARTIFACT_ROLE_DEPENDENCIES,
  applyApprovedRepair,
  classifyApprovedRepair,
  computeInvalidationClosure,
  persistApprovedRepair,
} from '../lib/invalidation.mjs';
import { validateTransition } from '../lib/project-state.mjs';
import { lockDirection } from '../lock_direction.mjs';

const NOW = '2026-09-01T12:00:00.000Z';
const HEX = (value) => computeArtifactDigest({ value });
const SHA = (value) => createHash('sha256').update(value).digest('hex');

function stamp(value) {
  value.integrity ??= { digest: null, upstream: {} };
  value.integrity.digest = null;
  value.integrity.digest = computeArtifactDigest(value);
  return value;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(stamp(value), null, 2)}\n`);
  return value;
}

function candidate(id, accent) {
  return {
    candidateId: id,
    title: id === 'candidate-a' ? 'Monumental Quiet' : 'Kinetic Ledger',
    thesis: `${id} is one complete direction`, wholeDirection: true,
    representativeEvidenceIds: ['frame-001'], copy: ['THE LONG CLIMB'],
    viewport: { width: 1920, height: 1080, aspectRatio: '16:9' },
    informationDensityBudget: { maximumSimultaneousLayers: 3, maximumWordsPerFrame: 12 },
    prototypeKind: 'code-rendered', designRevision: `design-${id.at(-1)}`,
    designCandidate: {
      candidateId: id, tokenNamespace: id,
      semanticColors: { canvas: '#050505', ink: '#F5F2EA', accent, signal: '#A8A29A', dataPrimary: '#77BBDD' },
      typography: { journeyTitle: 'display', chapterTitle: 'grotesk', annotation: 'mono' },
    },
    lookRevision: `look-${id.at(-1)}`,
    lookCandidate: { candidateId: id, treatment: id === 'candidate-a' ? 'mineral-cool' : 'warm-emulsion', grain: 'restrained' },
    typographyHierarchy: ['journeyTitle', 'chapterTitle', 'annotation'],
    storyStructure: ['departure', 'effort', 'release'],
    visualWorldPlan: { statement: 'Restrained evidence-first direction.', plannedAssets: ['route-thread'] },
    componentPlan: { components: ['chapter-index'], heroAssets: ['summit-silhouette'] },
    layoutProofs: [`review/workbench-assets/prototype-${id}-layout-001.svg`],
    motionStoryboard: [`review/workbench-assets/prototype-${id}-motion-001.svg`],
    assetPlan: { roles: ['journey_anchor', 'chapter_slate'], productionImageGenUsed: false },
    musicPlan: { mode: 'provided', trackIds: ['media/music/music-001.m4a'] }, risks: [],
    previewArtifactDigests: { [`review/workbench-assets/prototype-${id}-layout-001.svg`]: HEX(`${id}:layout`), [`review/workbench-assets/prototype-${id}-motion-001.svg`]: HEX(`${id}:motion`) },
  };
}

function draftDesign() {
  return stamp({
    $schema: 'https://hyperframes.local/schemas/design-system.schema.json', schemaVersion: '1.0.0', revision: 1,
    designRevision: 'design-1', status: 'draft', approvalDigest: null,
    lifecycle: [{ status: 'draft', at: '1970-01-01T00:00:00.000Z' }],
    tokens: {
      colors: { 'color.background': '#050505', 'color.primaryText': '#F5F2EA', 'color.accent': '#C9A86A', 'color.dataPrimary': '#F5F2EA' },
      typography: {}, spacing: { unit: 8 }, safeZones: { title: 0.08 }, strokes: { thin: 1 }, radii: { small: 2 }, depth: { base: 0 }, motion: { fast: 0.2 },
    }, integrity: { digest: null, upstream: {} },
  });
}

function draftLook() {
  return stamp({
    $schema: 'https://hyperframes.local/schemas/look-profile.schema.json', schemaVersion: '1.0.0', revision: 1,
    lookRevision: 'look-1', status: 'draft', approvalDigest: null,
    lifecycle: [{ status: 'draft', at: '1970-01-01T00:00:00.000Z' }],
    input: { interpretation: 'source-metadata' }, working: { colorSpace: 'linear-rec709' }, output: { colorSpace: 'rec709-sdr' },
    adjustments: { whiteBalance: 0, exposure: 0, contrast: 0, saturation: 1, highlightProtection: 0 },
    shotMatchingPolicy: 'conservative', integrity: { digest: null, upstream: {} },
  });
}

function stateAtReview() {
  const states = ['INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT', 'DIRECTOR_REVIEW_READY'];
  const gateEvidence = [];
  const transitions = states.slice(1).map((to, index) => {
    const at = `2026-09-01T00:0${index}:00.000Z`;
    const role = `${to}_GATE`;
    const digest = HEX(`${to}:${index}`);
    gateEvidence.push({ gate: to, role, revision: index + 2, digest, timestamp: at, producerCommand: `fixture ${to}`, qualifiers: ['accepted'], validity: 'valid', invalidatedAt: null });
    return { from: states[index], to, at, evidenceDigests: { [role]: digest }, evidenceRevisions: { [role]: index + 2 } };
  });
  return stamp({
    $schema: 'https://hyperframes.local/schemas/project-state.schema.json', schemaVersion: '1.0.0', revision: 6,
    state: 'DIRECTOR_REVIEW_READY', previousState: 'ROUGH_CUT', stateEnteredAt: transitions.at(-1).at,
    transitions, gateEvidence, invalidations: [], integrity: { digest: null, upstream: {} },
  });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hf-director-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['analysis/evidence/media-video-001/segment-001', 'direction', 'edit', 'renders', 'review/workbench-assets', 'cache', 'media/music']) await mkdir(join(root, path), { recursive: true });

  const editBrief = await writeJson(join(root, 'EDIT_BRIEF.json'), {
    $schema: 'https://hyperframes.local/schemas/edit-brief.schema.json', schemaVersion: '1.0.0', revision: 2,
    sport: { profile: 'cycling' }, story: { emphasis: ['climb'], tone: 'observational', pacing: 'balanced' },
    duration: { targetSeconds: 180, minSeconds: 150, maxSeconds: 210 },
    music: { mode: 'provided', localTracks: ['media/music/music-001.m4a'], mixPriority: 'balanced' },
    copy: { modes: ['titles'], language: 'en', tone: 'spare', title: 'THE LONG CLIMB', subtitle: null, prohibitedClaims: [] },
    delivery: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, aspectRatio: '16:9', frameRate: { mode: 'source-compatible', fps: null }, maximumFileSizeBytes: null },
    inclusions: [], exclusions: [], privacy: { routeTrimRequired: true, allowIdentities: false },
    remoteCapabilitiesForbidden: true, integrity: { digest: null, upstream: {} },
  });
  const sourceDigest = SHA('source-video');
  const mediaIndex = await writeJson(join(root, 'analysis/MEDIA_INDEX.json'), {
    $schema: 'https://hyperframes.local/schemas/media-index.schema.json', schemaVersion: '1.0.0', revision: 2,
    entries: [{ mediaId: 'media-video-001', mediaType: 'video', sourceRootReadOnly: true, sourceDigest, byteSize: 1024, portablePath: 'media/originals/media-video-001.mp4' }],
    integrity: { digest: null, upstream: {} },
  });
  const probe = await writeJson(join(root, 'analysis/PROBE.json'), {
    $schema: 'https://hyperframes.local/schemas/probe.schema.json', schemaVersion: '1.0.0', revision: 2,
    media: [{ mediaId: 'media-video-001', mediaType: 'video', reviewPath: 'review/probe/media-video-001.mp4', sourceDigest, byteSize: 1024, durationSeconds: 12,
      streams: [{ streamId: 'v0', type: 'video', codec: 'h264', timeBase: '1/24', frameRate: '24/1', width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorSpace: 'bt709', colorPrimaries: 'bt709', colorTransfer: 'bt709', colorRange: 'tv', sampleAspectRatio: '1/1' }], captureTimestamp: null,
      proxy: { kind: 'video', path: 'media/proxies/media-video-001.mp4', sourceDigest, transform: { codec: 'h264', maximumWidth: 1920, maximumHeight: 1080, watermark: 'ANALYSIS PROXY', preserveTimestamps: true, preserveAudio: true, autoOrient: true }, timeMapping: [{ proxyStartSeconds: 0, originalStartSeconds: 0, durationSeconds: 12, rate: '1/1' }] } }],
    integrity: { digest: null, upstream: { mediaIndex: mediaIndex.integrity.digest } },
  });
  const segments = await writeJson(join(root, 'analysis/SEGMENTS.json'), {
    $schema: 'https://hyperframes.local/schemas/segments.schema.json', schemaVersion: '1.0.0', revision: 2, sourceMediaIds: ['media-video-001'],
    segments: [{ segmentId: 'segment-001', mediaId: 'media-video-001', mediaType: 'video', sourceDigest, probeDigest: probe.integrity.digest, sourceInSeconds: 0, sourceOutSeconds: 12, sourceDurationSeconds: 12, sceneScore: 0.7, motionScore: 0.8, audioPresent: true,
      reviewPath: 'analysis/evidence/media-video-001/segment-001.webp', evidenceFrames: [{ path: 'analysis/evidence/media-video-001/segment-001/evidence-media-video-001-segment-001-frame-001.webp', sourceTimeSeconds: 2 }] }],
    integrity: { digest: null, upstream: { probe: probe.integrity.digest } },
  });
  const shots = await writeJson(join(root, 'analysis/SHOTS.jsonl'), {
    $schema: 'https://hyperframes.local/schemas/shot.schema.json', schemaVersion: '1.0.0', revision: 2, status: 'available',
    shots: [{ shotId: 'shot-001', mediaId: 'media-video-001', segmentId: 'segment-001', sourceDigest, sourceInSeconds: 0, sourceOutSeconds: 12, sourceDurationSeconds: 12,
      cameraRole: 'pov', actionRole: 'effort', environmentTags: ['forest'], subjectTags: ['rider'], quality: { motionIntensity: 'high', blur: 'none', shake: 'minor', exposure: 'good', horizon: 'level', occlusion: 'none' }, continuity: { screenDirection: 'left-to-right', motionDirection: 'forward', subjectEntry: 'center', subjectExit: 'center', location: 'forest', timeRelation: 'continuous' }, audioSpans: [{ kind: 'ambient', sourceInSeconds: 0, sourceOutSeconds: 12 }], duplicateGroup: null, setupTailLikelihood: 0.03, evidenceFrames: ['analysis/evidence/media-video-001/segment-001/evidence-media-video-001-segment-001-frame-001.webp'], confidence: 0.91 }],
    integrity: { digest: null, upstream: { probe: probe.integrity.digest, segments: segments.integrity.digest } },
  });
  const overlays = await writeJson(join(root, 'direction/DATA_OVERLAYS.json'), {
    $schema: 'https://hyperframes.local/schemas/data-overlays.schema.json', schemaVersion: '1.0.0', revision: 1, status: 'unavailable', activityDigest: null, syncMapDigest: null, publicRoute: { status: 'unavailable', trimmedRouteId: null }, overlays: [], integrity: { digest: null, upstream: {} },
  });
  const timeline = await writeJson(join(root, 'edit/TIMELINE.json'), {
    $schema: 'https://hyperframes.local/schemas/timeline.schema.json', schemaVersion: '1.0.0', revision: 2, timelineRevision: 'timeline-2', status: 'available', phase: 'rough', designRevision: 'design-1', lookRevision: 'look-1', assetRevision: 'assets-1', motionRevision: 'motion-1', sourceProbeDigest: probe.integrity.digest,
    items: [{ itemId: 'item-001', shotId: 'shot-001', sourceMediaId: 'media-video-001', sourceKind: 'video', sourceReference: { kind: 'proxy', path: 'media/proxies/media-video-001.mp4', digest: sourceDigest }, sourceInSeconds: 0, sourceOutSeconds: 12, sourceDurationSeconds: 12, destinationInSeconds: 0, destinationOutSeconds: 12, playbackRate: 1, playbackRateCurve: [{ sourceTimeSeconds: 0, rate: 1 }], transform: { stabilization: { mode: 'off', cropFraction: 0 }, cropReframe: null, stillMotion: null, draftColorTransform: 'neutral', faceTreatment: 'off' }, audioPolicy: { sourceGainDb: 0, denoise: false, bridge: 'none' }, transition: { kind: 'none', ownerId: null }, assetReferences: [], motionReferences: [], reasons: ['effort'], colorToken: 'color.primaryText' }],
    music: { mode: 'local', path: 'media/music/music-001.m4a', loop: true, loopCrossfadeSeconds: 0.25 }, warningDecisions: [], integrity: { digest: null, upstream: { probe: probe.integrity.digest, shots: shots.integrity.digest } },
  });
  await writeFile(join(root, 'analysis/evidence/media-video-001/segment-001.webp'), 'segment');
  const frameBytes = 'frame';
  const frameDigest = SHA(frameBytes);
  const frameBundlePath = `review/workbench-assets/test/evidence-media-video-001-segment-001-frame-001-${frameDigest}.webp`;
  await mkdir(join(root, 'review/workbench-assets/test'), { recursive: true });
  await writeFile(join(root, 'analysis/evidence/media-video-001/segment-001/evidence-media-video-001-segment-001-frame-001.webp'), frameBytes);
  await writeFile(join(root, frameBundlePath), frameBytes);
  await writeFile(join(root, 'media/music/music-001.m4a'), 'local music');
  await writeFile(join(root, 'renders/rough-cut.mp4'), 'closed proxy rough cut');
  const roughCutDigest = SHA('closed proxy rough cut');
  // Lock validation deliberately binds a closed-file digest record, not a guessed filename.
  await writeFile(join(root, 'renders/rough-cut.json'), `${JSON.stringify({ schemaVersion: '1.0.0', revision: 2, stateAuthority: 'ROUGH_CUT', artifact: 'renders/rough-cut.mp4', outputDigest: roughCutDigest, closedFileProbe: { valid: true, durationSeconds: 12, width: 960, height: 540, videoCodec: 'h264', audioCodec: 'aac' }, integrity: { timelineDigest: timeline.integrity.digest, probeDigest: probe.integrity.digest, proxyDigests: [], musicDigest: null } }, null, 2)}\n`);
  const candidates = [candidate('candidate-a', '#C9A86A'), candidate('candidate-b', '#65B8D6')];
  const prototypeBundlePaths = [];
  for (const proposal of candidates) {
    for (const path of [...proposal.layoutProofs, ...proposal.motionStoryboard]) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${proposal.candidateId}</text></svg>`;
      await writeFile(join(root, path), svg);
      proposal.previewArtifactDigests[path] = SHA(svg);
      const stable = path.split('/').at(-1).replace(/\.svg$/, '');
      const bundlePath = `review/workbench-assets/test/${stable}-${SHA(svg)}.svg`;
      await writeFile(join(root, bundlePath), svg);
      prototypeBundlePaths.push(bundlePath);
    }
  }
  const evidenceDigest = computeArtifactDigest({ mediaIndex: mediaIndex.integrity.digest, probe: probe.integrity.digest, segments: segments.integrity.digest, shots: shots.integrity.digest, dataOverlays: overlays.integrity.digest });
  const assetPlanDigest = computeArtifactDigest(candidates.map(({ candidateId, visualWorldPlan, componentPlan, assetPlan }) => ({ candidateId, visualWorldPlan, componentPlan, assetPlan })));
  const proposals = await writeJson(join(root, 'direction/DIRECTION_PROPOSALS.json'), {
    $schema: 'https://hyperframes.local/schemas/direction-proposals.schema.json', schemaVersion: '1.0.0', revision: 2, status: 'proposed', candidates,
    bindings: { editBriefDigest: editBrief.integrity.digest, evidenceDigest, roughCutDigest, timelineDigest: timeline.integrity.digest, musicPlanDigest: computeArtifactDigest(timeline.music), assetPlanDigest },
    integrity: { digest: null, upstream: {} },
  });
  const displayedArtifactDigests = { editBrief: editBrief.integrity.digest, roughCut: roughCutDigest, musicPlan: computeArtifactDigest(timeline.music), assetPlan: assetPlanDigest, evidence: evidenceDigest, proposals: proposals.integrity.digest };
  const roughBundlePath = `review/workbench-assets/test/rough-cut-${roughCutDigest}.mp4`;
  await writeFile(join(root, roughBundlePath), 'closed proxy rough cut');
  const bundleRefs = [frameBundlePath, roughBundlePath, ...prototypeBundlePaths].map((path) => `<img src="${path.slice('review/'.length)}">`).join('');
  const workbench = `<html><button data-approve>Approve</button>${bundleRefs}<script type="application/json" data-displayed-digests>${JSON.stringify(displayedArtifactDigests)}</script></html>\n`;
  await writeFile(join(root, 'review/director-workbench.html'), workbench);
  const approval = await writeJson(join(root, 'direction/DIRECTOR_APPROVAL.json'), {
    $schema: 'https://hyperframes.local/schemas/director-approval.schema.json', schemaVersion: '1.0.0', revision: 1, status: 'approved', selectedCandidateId: 'candidate-a',
    displayedArtifactDigests,
    workbenchDigest: SHA(workbench), approvedAt: NOW,
    integrity: { digest: null, upstream: {} },
  });
  await writeJson(join(root, 'direction/DESIGN_SYSTEM.json'), draftDesign());
  await writeJson(join(root, 'direction/LOOK_PROFILE.json'), draftLook());
  await writeJson(join(root, 'PROJECT_STATE.json'), stateAtReview());

  const rebuildWorkbench = async ({ selectedCandidate, state }) => {
    return { html: renderLockedWorkbench(state, selectedCandidate) };
  };
  return { root, approval, proposals, candidates, rebuildWorkbench };
}

test('approval validation selects exactly one complete current proposal and compilation follows the full lifecycle', async (t) => {
  const { root, approval, candidates } = await fixture(t);
  const validated = await validateDirectorApproval(root);
  assert.equal(validated.selectedCandidate.candidateId, 'candidate-a');
  const design = compileApprovedDesign(validated.draftDesign, validated.selectedCandidate, approval, NOW);
  const look = compileApprovedLook(validated.draftLook, validated.selectedCandidate, approval, NOW);
  assert.deepEqual(design.lifecycle.map(({ status }) => status), ['draft', 'proposed', 'approved', 'frozen']);
  assert.deepEqual(look.lifecycle.map(({ status }) => status), ['draft', 'proposed', 'approved', 'frozen']);
  assert.equal(design.tokens.colors['color.accent'], '#C9A86A');
  assert.equal(design.tokens.colors['color.accent'] === candidates[1].designCandidate.semanticColors.accent, false);
  assert.equal(look.lookRevision, 'look-a');

  const mixed = structuredClone(candidates[0]);
  mixed.lookCandidate = structuredClone(candidates[1].lookCandidate);
  assert.throws(() => compileApprovedLook(validated.draftLook, mixed, approval, NOW), (error) => error.code === 'E_CROSS_CANDIDATE');
  assert.throws(() => compileApprovedDesign({ ...validated.draftDesign, status: 'frozen' }, candidates[0], approval, NOW), (error) => error.code === 'E_DRAFT_REQUIRED');
});

test('lock commits one matching frozen pair, gate evidence, consumed approval, and read-only selected workbench', async (t) => {
  const { root, approval, rebuildWorkbench } = await fixture(t);
  const result = await lockDirection(root, { now: () => NOW, rebuildWorkbench });
  assert.equal(result.ok, true);
  const [design, look, state, html] = await Promise.all([
    readFile(join(root, 'direction/DESIGN_SYSTEM.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'direction/LOOK_PROFILE.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'PROJECT_STATE.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'review/director-workbench.html'), 'utf8'),
  ]);
  assert.equal(design.status, 'frozen');
  assert.equal(look.status, 'frozen');
  assert.equal(design.approvalDigest, approval.integrity.digest);
  assert.equal(look.approvalDigest, approval.integrity.digest);
  assert.equal(state.state, 'DIRECTOR_LOCK');
  assert.equal(state.transitions.at(-1).evidenceDigests.DESIGN_SYSTEM, design.integrity.digest);
  assert.equal(state.transitions.at(-1).evidenceDigests.LOOK_PROFILE, look.integrity.digest);
  assert.equal(state.transitions.at(-1).evidenceDigests.DIRECTOR_APPROVAL, approval.integrity.digest);
  assert.equal(state.transitions.at(-1).evidenceDigests.WORKBENCH, result.workbenchDigest);
  assert.match(html, /Monumental Quiet/);
  assert.doesNotMatch(html, /Kinetic Ledger|data-approve|Approve/);
  assert.equal((await validateCommittedDirection(root)).design.integrity.digest, design.integrity.digest);
  await assert.rejects(() => lockDirection(root, { now: () => NOW, rebuildWorkbench }), (error) => error.code === 'E_APPROVAL_CONSUMED');
});

test('stale, partial, remote, cross-candidate, and escaping approval inputs are rejected without mutation', async (t) => {
  const { root } = await fixture(t);
  const designBefore = await readFile(join(root, 'direction/DESIGN_SYSTEM.json'), 'utf8');
  const approvalPath = join(root, 'direction/DIRECTOR_APPROVAL.json');
  const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
  delete approval.displayedArtifactDigests.evidence;
  await writeJson(approvalPath, approval);
  await assert.rejects(() => validateDirectorApproval(root), (error) => ['E_APPROVAL_BINDINGS', 'E_APPROVAL_INVALID'].includes(error.code));
  assert.equal(await readFile(join(root, 'direction/DESIGN_SYSTEM.json'), 'utf8'), designBefore);

  const second = await fixture(t);
  const proposalPath = join(second.root, 'direction/DIRECTION_PROPOSALS.json');
  const proposals = JSON.parse(await readFile(proposalPath, 'utf8'));
  proposals.candidates[0].musicPlan.trackIds = ['https://remote.example/music.mp3'];
  await writeJson(proposalPath, proposals);
  await assert.rejects(() => validateDirectorApproval(second.root), (error) => ['E_REMOTE_MUSIC', 'E_PROPOSALS_INVALID', 'E_APPROVAL_BINDINGS'].includes(error.code));

  await assert.rejects(
    () => lockDirection(second.root, { designPath: '../escaped.json', rebuildWorkbench: second.rebuildWorkbench }),
    (error) => error.code === 'E_PATH_ESCAPE',
  );
});

for (const injectionPoint of ['afterTemporaryWrites', 'afterFirstRename', 'beforeStateCommit']) {
  test(`transaction recovery leaves no uncommitted or mismatched pair after ${injectionPoint}`, async (t) => {
    const { root, rebuildWorkbench } = await fixture(t);
    await assert.rejects(
      () => lockDirection(root, { now: () => NOW, rebuildWorkbench, injectFailure: injectionPoint }),
      (error) => error.code === 'E_INJECTED_FAILURE',
    );
    await assert.rejects(() => validateCommittedDirection(root), (error) => error.code === 'E_DIRECTION_UNCOMMITTED');
    const recovered = await lockDirection(root, { now: () => NOW, rebuildWorkbench });
    assert.equal(recovered.ok, true);
    const committed = await validateCommittedDirection(root);
    assert.equal(committed.design.approvalDigest, committed.look.approvalDigest);
    await assert.rejects(stat(join(root, 'cache/direction-lock.transaction.json')), (error) => error.code === 'ENOENT');
  });
}

test('repair classification enforces role closure, three attempts, and the immutable approval boundary', async (t) => {
  const allowed = ['position', 'scrim', 'timing', 'gain'];
  for (const repairClass of allowed) assert.equal(classifyApprovedRepair({ repairClass }).allowed, true);
  for (const repairClass of ['story', 'key-shot', 'direction', 'token', 'look', 'music', 'privacy', 'delivery']) {
    assert.equal(classifyApprovedRepair({ repairClass }).code, 'approval_boundary_crossed');
  }
  assert.deepEqual(computeInvalidationClosure(['TIMELINE'], {
    TIMELINE: ['MOTION_MAP'], MOTION_MAP: ['FINAL_RENDER'], FINAL_RENDER: ['REVIEW'], REVIEW: [],
  }), ['TIMELINE', 'MOTION_MAP', 'FINAL_RENDER', 'REVIEW']);

  const { root, rebuildWorkbench } = await fixture(t);
  await lockDirection(root, { now: () => NOW, rebuildWorkbench });
  const state = JSON.parse(await readFile(join(root, 'PROJECT_STATE.json'), 'utf8'));
  const frozenBefore = await Promise.all(['DESIGN_SYSTEM.json', 'LOOK_PROFILE.json'].map((name) => readFile(join(root, 'direction', name), 'utf8')));
  let history = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = applyApprovedRepair(state, { repairClass: 'position', role: 'MOTION_MAP' }, {
      gate: 'FINAL_QA', reason: 'text collision', timestamp: NOW, beforeDigests: { MOTION_MAP: HEX(`before-${attempt}`) }, afterDigests: { MOTION_MAP: HEX(`after-${attempt}`) }, history,
    });
    assert.equal(result.code, 'repair_allowed');
    assert.equal(result.repair.attempt, attempt);
    assert.deepEqual(Object.keys(result.repair).sort(), ['afterDigests', 'attempt', 'beforeDigests', 'gate', 'invalidatedRoles', 'reason', 'repairClass'].sort());
    history = result.history;
  }
  assert.equal(applyApprovedRepair(state, { repairClass: 'position', role: 'MOTION_MAP' }, { gate: 'FINAL_QA', reason: 'still colliding', timestamp: NOW, beforeDigests: {}, afterDigests: {}, history }).code, 'repair_budget_exhausted');

  const forbidden = applyApprovedRepair(state, { repairClass: 'token', role: 'DESIGN_SYSTEM' }, { gate: 'FINAL_QA', reason: 'palette mismatch', timestamp: NOW, beforeDigests: {}, afterDigests: {}, history: [] });
  assert.equal(forbidden.code, 'approval_boundary_crossed');
  assert.equal(forbidden.projectState.state, 'BLOCKED');
  assert.equal(forbidden.projectState.transitions.at(-1).rollbackTarget, 'DIRECTOR_REVIEW_READY');
  assert.deepEqual(await Promise.all(['DESIGN_SYSTEM.json', 'LOOK_PROFILE.json'].map((name) => readFile(join(root, 'direction', name), 'utf8'))), frozenBefore);

  for (const role of ['journey_anchor', 'activity_evidence', 'transition_owner']) {
    const failed = applyApprovedRepair(state, { repairClass: 'role-failure', role, required: true }, { gate: 'ASSET_PRODUCTION', reason: `${role} missing`, timestamp: NOW, beforeDigests: {}, afterDigests: {}, history: [] });
    assert.equal(failed.projectState.state, 'BLOCKED');
  }
  assert.equal(classifyApprovedRepair({ repairClass: 'remove-optional-decorative', role: 'decorative', optional: true }).allowed, true);
});

test('ApprovalError exposes stable machine codes', () => {
  const error = new ApprovalError('E_EXAMPLE', 'example');
  assert.equal(error.code, 'E_EXAMPLE');
});

test('repair records and terminal approval-boundary decisions persist without touching frozen contracts', async (t) => {
  const { root, rebuildWorkbench } = await fixture(t);
  await lockDirection(root, { now: () => NOW, rebuildWorkbench });
  const before = await Promise.all(['DESIGN_SYSTEM.json', 'LOOK_PROFILE.json'].map((name) => readFile(join(root, 'direction', name), 'utf8')));
  const allowed = await persistApprovedRepair(root, { repairClass: 'gain', role: 'TIMELINE' }, {
    gate: 'FINAL_QA', reason: 'music masks ambience', timestamp: NOW,
    beforeDigests: { TIMELINE: HEX('timeline-before') }, afterDigests: { TIMELINE: HEX('timeline-after') },
  });
  assert.equal(allowed.repair.attempt, 1);
  const history = JSON.parse(await readFile(join(root, 'cache/REPAIR_HISTORY.json'), 'utf8'));
  assert.deepEqual(history.repairs, [allowed.repair]);
  const blocked = await persistApprovedRepair(root, { repairClass: 'delivery' }, {
    gate: 'FINAL_QA', reason: 'requested raster changed', timestamp: '2026-09-01T12:01:00.000Z', beforeDigests: {}, afterDigests: {},
  });
  assert.equal(blocked.projectState.state, 'BLOCKED');
  assert.equal(JSON.parse(await readFile(join(root, 'PROJECT_STATE.json'), 'utf8')).state, 'BLOCKED');
  assert.deepEqual(await Promise.all(['DESIGN_SYSTEM.json', 'LOOK_PROFILE.json'].map((name) => readFile(join(root, 'direction', name), 'utf8'))), before);
});

test('project-scoped lock serialization permits only one concurrent approval consumer', async (t) => {
  const { root, rebuildWorkbench } = await fixture(t);
  const outcomes = await Promise.allSettled([
    lockDirection(root, { now: () => NOW, rebuildWorkbench }),
    lockDirection(root, { now: () => NOW, rebuildWorkbench }),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = outcomes.find(({ status }) => status === 'rejected');
  assert.ok(['E_LOCK_BUSY', 'E_APPROVAL_CONSUMED'].includes(rejected?.reason?.code));
  assert.equal((await validateCommittedDirection(root)).state.state, 'DIRECTOR_LOCK');
});

test('repair authorization is class-scoped and frozen or required roles are never repairable', () => {
  assert.equal(classifyApprovedRepair({ repairClass: 'position', role: 'TIMELINE' }).code, 'repair_role_unauthorized');
  assert.equal(classifyApprovedRepair({ repairClass: 'gain', role: 'DESIGN_SYSTEM' }).code, 'approval_boundary_crossed');
  assert.equal(classifyApprovedRepair({ repairClass: 'scrim', role: 'LOOK_PROFILE' }).code, 'approval_boundary_crossed');
  for (const role of ['journey_anchor', 'activity_evidence', 'transition_owner']) {
    const decision = classifyApprovedRepair({ repairClass: 'remove-optional-decorative', role, optional: true });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, 'required_role_failed');
  }
});

test('artifact role graph carries complete recorded-media, activity, and design truth chains', () => {
  assert.deepEqual(computeInvalidationClosure(['MEDIA_INDEX'], ARTIFACT_ROLE_DEPENDENCIES).slice(0, 5), ['MEDIA_INDEX', 'PROBE', 'SEGMENTS', 'SHOTS', 'TIMELINE']);
  assert.deepEqual(computeInvalidationClosure(['ACTIVITY'], ARTIFACT_ROLE_DEPENDENCIES).slice(0, 4), ['ACTIVITY', 'SYNC_MAP', 'DATA_OVERLAYS', 'TIMELINE']);
  const designClosure = computeInvalidationClosure(['DESIGN_SYSTEM'], ARTIFACT_ROLE_DEPENDENCIES);
  for (const role of ['ASSET_MANIFEST', 'MOTION_MAP', 'TIMELINE', 'FINAL_RENDER', 'REVIEW']) assert.ok(designClosure.includes(role), role);
});

test('generic state transitions enforce the exact DIRECTOR_LOCK hard gate', () => {
  const record = (role, qualifier) => ({ gate: 'DIRECTOR_LOCK', role, revision: 2, digest: HEX(role), timestamp: NOW, producerCommand: 'lock_direction.mjs', qualifiers: [qualifier], validity: 'valid', invalidatedAt: null });
  const records = [record('DESIGN_SYSTEM', 'frozen'), record('LOOK_PROFILE', 'frozen'), record('DIRECTOR_APPROVAL', 'consumed'), record('WORKBENCH', 'state-bound')];
  const currentArtifacts = Object.fromEntries(records.map(({ role, revision, digest }) => [role, { revision, digest }]));
  assert.equal(validateTransition('DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', { records, currentArtifacts }), true);
  assert.throws(() => validateTransition('DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', { records: records.slice(0, 3), currentArtifacts }), (error) => error.code === 'E_DIRECTOR_LOCK_GATE');
  const wrong = structuredClone(records); wrong[3].qualifiers = ['accepted'];
  assert.throws(() => validateTransition('DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', { records: wrong, currentArtifacts }), (error) => error.code === 'E_DIRECTOR_LOCK_GATE');
});

test('approval authority schema-validates sources and rehashes every prototype and evidence derivative', async (t) => {
  const prototype = await fixture(t);
  await writeFile(join(prototype.root, prototype.candidates[0].layoutProofs[0]), '<svg xmlns="http://www.w3.org/2000/svg"><text>tampered</text></svg>');
  await assert.rejects(() => validateDirectorApproval(prototype.root), (error) => ['E_PREVIEW_STALE', 'E_APPROVAL_BINDINGS'].includes(error.code));

  const evidence = await fixture(t);
  await writeFile(join(evidence.root, 'analysis/evidence/media-video-001/segment-001/evidence-media-video-001-segment-001-frame-001.webp'), 'tampered frame');
  await assert.rejects(() => validateDirectorApproval(evidence.root), (error) => ['E_EVIDENCE_STALE', 'E_WORKBENCH_STALE'].includes(error.code));

  const invalid = await fixture(t);
  const editPath = join(invalid.root, 'EDIT_BRIEF.json');
  const edit = JSON.parse(await readFile(editPath, 'utf8'));
  delete edit.delivery.container;
  await writeJson(editPath, edit);
  await assert.rejects(() => validateDirectorApproval(invalid.root), (error) => ['E_EDIT_BRIEF_INVALID', 'E_SOURCE_CONTRACT'].includes(error.code));
});

test('approval music resolves exact trimmed selections to the local approved contract', async (t) => {
  for (const trackId of [' https://remote.example/track.m4a ', 'media/music/unapproved.m4a']) {
    const { root } = await fixture(t);
    const proposalPath = join(root, 'direction/DIRECTION_PROPOSALS.json');
    const proposals = JSON.parse(await readFile(proposalPath, 'utf8'));
    proposals.candidates.forEach((entry) => { entry.musicPlan.trackIds = [trackId]; });
    await writeJson(proposalPath, proposals);
    const approvalPath = join(root, 'direction/DIRECTOR_APPROVAL.json');
    const approval = JSON.parse(await readFile(approvalPath, 'utf8'));
    approval.displayedArtifactDigests.proposals = proposals.integrity.digest;
    const workbenchPath = join(root, 'review/director-workbench.html');
    const workbench = (await readFile(workbenchPath, 'utf8')).replace(/(<script type="application\/json" data-displayed-digests>)[^<]+/, `$1${JSON.stringify(approval.displayedArtifactDigests)}`);
    await writeFile(workbenchPath, workbench);
    approval.workbenchDigest = SHA(workbench);
    await writeJson(approvalPath, approval);
    await assert.rejects(() => validateDirectorApproval(root), (error) => error.code === 'E_REMOTE_MUSIC' || error.code === 'E_MUSIC_AUTHORITY');
  }
});

test('frozen contracts preserve the complete selected direction, semantic roles, and Look treatment', async (t) => {
  const { root, approval, candidates } = await fixture(t);
  const validated = await validateDirectorApproval(root);
  const design = compileApprovedDesign(validated.draftDesign, validated.selectedCandidate, approval, NOW);
  const look = compileApprovedLook(validated.draftLook, validated.selectedCandidate, approval, NOW);
  assert.deepEqual(design.selectedDirection.candidate, candidates[0]);
  for (const role of ['color.background', 'color.primaryText', 'color.accent', 'color.signal', 'color.dataPrimary']) assert.match(design.tokens.colors[role], /^#[0-9A-Fa-f]{6}$/);
  assert.deepEqual(look.selectedLook, candidates[0].lookCandidate);
});

test('lock independently hashes staged workbench bytes and revalidates authority before state commit', async (t) => {
  const { root } = await fixture(t);
  const proposalPath = join(root, 'direction/DIRECTION_PROPOSALS.json');
  const maliciousBuilder = async ({ selectedCandidate, state }) => {
    const proposals = JSON.parse(await readFile(proposalPath, 'utf8'));
    proposals.candidates[0].title = 'changed after validation';
    await writeJson(proposalPath, proposals);
    return { html: `<html data-state-revision="${state.revision}"><h1>${selectedCandidate.title}</h1><p>Locked direction · read-only</p></html>\n`, digest: 'f'.repeat(64) };
  };
  await assert.rejects(() => lockDirection(root, { now: () => NOW, rebuildWorkbench: maliciousBuilder }), (error) => ['E_LOCK_INPUT_STALE', 'E_WORKBENCH_REBUILD'].includes(error.code));
  assert.equal(JSON.parse(await readFile(join(root, 'PROJECT_STATE.json'), 'utf8')).state, 'DIRECTOR_REVIEW_READY');
});

test('committed direction validates schemas, exact gate records, frozen origins, and canonical workbench bytes', async (t) => {
  const { root, rebuildWorkbench } = await fixture(t);
  await lockDirection(root, { now: () => NOW, rebuildWorkbench });
  await writeFile(join(root, 'review/director-workbench.html'), '<html>forged locked view</html>\n');
  await assert.rejects(() => validateCommittedDirection(root), (error) => error.code === 'E_DIRECTION_UNCOMMITTED');
});

test('repair persistence serializes attempts and crash recovery prevents split history/state', async (t) => {
  const { root, rebuildWorkbench } = await fixture(t);
  await lockDirection(root, { now: () => NOW, rebuildWorkbench });
  const context = (index, extra = {}) => ({ gate: 'FINAL_QA', reason: `collision ${index}`, timestamp: `2026-09-01T12:0${index}:00.000Z`, beforeDigests: { MOTION_MAP: HEX(`b${index}`) }, afterDigests: { MOTION_MAP: HEX(`a${index}`) }, ...extra });
  const concurrent = await Promise.allSettled([
    persistApprovedRepair(root, { repairClass: 'position', role: 'MOTION_MAP' }, context(1)),
    persistApprovedRepair(root, { repairClass: 'position', role: 'MOTION_MAP' }, context(2)),
  ]);
  assert.equal(concurrent.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(concurrent.filter(({ status }) => status === 'rejected' && status).length, 1);
  await assert.rejects(() => persistApprovedRepair(root, { repairClass: 'position', role: 'MOTION_MAP' }, context(3, { injectFailure: 'afterHistoryRename' })), (error) => error.code === 'E_INJECTED_FAILURE');
  const recovery = await Promise.allSettled([
    persistApprovedRepair(root, { repairClass: 'position', role: 'MOTION_MAP' }, context(4)),
    persistApprovedRepair(root, { repairClass: 'position', role: 'MOTION_MAP' }, context(5)),
  ]);
  assert.equal(recovery.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(recovery.filter(({ status, reason }) => status === 'rejected' && reason.code === 'E_REPAIR_BUSY').length, 1);
  const history = JSON.parse(await readFile(join(root, 'cache/REPAIR_HISTORY.json'), 'utf8'));
  const state = JSON.parse(await readFile(join(root, 'PROJECT_STATE.json'), 'utf8'));
  assert.equal(history.integrity.upstream.projectState, state.integrity.digest);
  assert.equal(new Set(history.repairs.map(({ attempt }) => attempt)).size, history.repairs.length);
  assert.ok(history.repairs.length <= 3);
});

test('lock journal validation rejects shape drift and PID reuse identity recovers under exclusive takeover', async (t) => {
  const malformed = await fixture(t);
  await assert.rejects(() => lockDirection(malformed.root, { now: () => NOW, rebuildWorkbench: malformed.rebuildWorkbench, injectFailure: 'afterTemporaryWrites' }), (error) => error.code === 'E_INJECTED_FAILURE');
  const journalPath = join(malformed.root, 'cache/direction-lock.transaction.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  journal.unexpected = true;
  await writeJson(journalPath, journal);
  await assert.rejects(() => lockDirection(malformed.root, { now: () => NOW, rebuildWorkbench: malformed.rebuildWorkbench }), (error) => error.code === 'E_LOCK_JOURNAL_INVALID');

  const reused = await fixture(t);
  await assert.rejects(() => lockDirection(reused.root, { now: () => NOW, rebuildWorkbench: reused.rebuildWorkbench, injectFailure: 'afterTemporaryWrites' }), (error) => error.code === 'E_INJECTED_FAILURE');
  const reusedPath = join(reused.root, 'cache/direction-lock.transaction.json');
  const reusedJournal = JSON.parse(await readFile(reusedPath, 'utf8'));
  reusedJournal.owner.active = true;
  reusedJournal.owner.pid = process.pid;
  reusedJournal.owner.processStartId = 'pid-reused-start-identity';
  await writeJson(reusedPath, reusedJournal);
  const outcomes = await Promise.allSettled([
    lockDirection(reused.root, { now: () => NOW, rebuildWorkbench: reused.rebuildWorkbench }),
    lockDirection(reused.root, { now: () => NOW, rebuildWorkbench: reused.rebuildWorkbench }),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal((await validateCommittedDirection(reused.root)).state.state, 'DIRECTOR_LOCK');
});

test('state is committed before the locked view becomes visible and state-renamed recovery publishes the exact staged bytes', async (t) => {
  const { root, rebuildWorkbench } = await fixture(t);
  await assert.rejects(() => lockDirection(root, { now: () => NOW, rebuildWorkbench, injectFailure: 'afterStateCommit' }), (error) => error.code === 'E_INJECTED_FAILURE');
  assert.equal(JSON.parse(await readFile(join(root, 'PROJECT_STATE.json'), 'utf8')).state, 'DIRECTOR_LOCK');
  assert.match(await readFile(join(root, 'review/director-workbench.html'), 'utf8'), /data-approve/);
  await assert.rejects(() => validateCommittedDirection(root), (error) => error.code === 'E_DIRECTION_UNCOMMITTED');
  const recovered = await lockDirection(root, { now: () => NOW, rebuildWorkbench });
  assert.equal(recovered.recovered, true);
  assert.equal((await validateCommittedDirection(root)).state.state, 'DIRECTOR_LOCK');
});

test('committed consumer rejects wrong lock qualifier and repair journal rejects structural drift', async (t) => {
  const direction = await fixture(t);
  await lockDirection(direction.root, { now: () => NOW, rebuildWorkbench: direction.rebuildWorkbench });
  const statePath = join(direction.root, 'PROJECT_STATE.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.gateEvidence.find(({ gate, role }) => gate === 'DIRECTOR_LOCK' && role === 'WORKBENCH').qualifiers = ['accepted'];
  await writeJson(statePath, state);
  await assert.rejects(() => validateCommittedDirection(direction.root), (error) => error.code === 'E_DIRECTION_UNCOMMITTED');

  const origin = await fixture(t);
  await lockDirection(origin.root, { now: () => NOW, rebuildWorkbench: origin.rebuildWorkbench });
  const originStatePath = join(origin.root, 'PROJECT_STATE.json');
  const originState = JSON.parse(await readFile(originStatePath, 'utf8'));
  originState.gateEvidence.filter(({ gate }) => gate === 'DIRECTOR_LOCK').forEach((record) => { record.producerCommand = 'forged-lock.mjs'; });
  await writeJson(originStatePath, originState);
  await assert.rejects(() => validateCommittedDirection(origin.root), (error) => error.code === 'E_DIRECTION_UNCOMMITTED');

  const repair = await fixture(t);
  await lockDirection(repair.root, { now: () => NOW, rebuildWorkbench: repair.rebuildWorkbench });
  await assert.rejects(() => persistApprovedRepair(repair.root, { repairClass: 'position', role: 'MOTION_MAP' }, { gate: 'FINAL_QA', reason: 'collision', timestamp: NOW, beforeDigests: { MOTION_MAP: HEX('before') }, afterDigests: { MOTION_MAP: HEX('after') }, injectFailure: 'afterHistoryRename' }), (error) => error.code === 'E_INJECTED_FAILURE');
  const repairJournalPath = join(repair.root, 'cache/repair.transaction.json');
  const repairJournal = JSON.parse(await readFile(repairJournalPath, 'utf8'));
  repairJournal.unexpected = true;
  await writeJson(repairJournalPath, repairJournal);
  await assert.rejects(() => persistApprovedRepair(repair.root, { repairClass: 'position', role: 'MOTION_MAP' }, { gate: 'FINAL_QA', reason: 'again', timestamp: '2026-09-01T12:01:00.000Z', beforeDigests: {}, afterDigests: {} }), (error) => error.code === 'E_REPAIR_JOURNAL_INVALID');
});
