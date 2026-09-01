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
  validateCommittedDirection,
  validateDirectorApproval,
} from '../lib/approval.mjs';
import {
  applyApprovedRepair,
  classifyApprovedRepair,
  computeInvalidationClosure,
  persistApprovedRepair,
} from '../lib/invalidation.mjs';
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
      semanticColors: { canvas: '#050505', ink: '#F5F2EA', accent, signal: '#A8A29A' },
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
    musicPlan: { mode: 'provided', trackIds: ['music-001'] }, risks: [],
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
  for (const path of ['analysis', 'direction', 'edit', 'renders', 'review', 'cache']) await mkdir(join(root, path), { recursive: true });

  const editBrief = await writeJson(join(root, 'EDIT_BRIEF.json'), {
    revision: 2, music: { mode: 'provided', localTracks: ['music-001'] }, privacy: { routeTrimRequired: true },
    delivery: { width: 1920, height: 1080 }, remoteCapabilitiesForbidden: true, integrity: { digest: null, upstream: {} },
  });
  const mediaIndex = await writeJson(join(root, 'analysis/MEDIA_INDEX.json'), { revision: 2, entries: [], integrity: { digest: null, upstream: {} } });
  const probe = await writeJson(join(root, 'analysis/PROBE.json'), { revision: 2, media: [], integrity: { digest: null, upstream: {} } });
  const segments = await writeJson(join(root, 'analysis/SEGMENTS.json'), { revision: 2, segments: [], integrity: { digest: null, upstream: {} } });
  const shots = await writeJson(join(root, 'analysis/SHOTS.jsonl'), { revision: 2, shots: [], integrity: { digest: null, upstream: {} } });
  const overlays = await writeJson(join(root, 'direction/DATA_OVERLAYS.json'), { revision: 2, status: 'unavailable', integrity: { digest: null, upstream: {} } });
  const timeline = await writeJson(join(root, 'edit/TIMELINE.json'), { revision: 2, music: { mode: 'provided', trackIds: ['music-001'] }, integrity: { digest: null, upstream: {} } });
  await writeFile(join(root, 'renders/rough-cut.mp4'), 'closed proxy rough cut');
  const roughCutDigest = SHA('closed proxy rough cut');
  // Lock validation deliberately binds a closed-file digest record, not a guessed filename.
  await writeJson(join(root, 'renders/rough-cut.json'), { artifact: 'renders/rough-cut.mp4', outputDigest: roughCutDigest, integrity: { digest: null, upstream: {} } });
  const candidates = [candidate('candidate-a', '#C9A86A'), candidate('candidate-b', '#65B8D6')];
  const evidenceDigest = computeArtifactDigest({ mediaIndex: mediaIndex.integrity.digest, probe: probe.integrity.digest, segments: segments.integrity.digest, shots: shots.integrity.digest, dataOverlays: overlays.integrity.digest });
  const assetPlanDigest = computeArtifactDigest(candidates.map(({ candidateId, visualWorldPlan, componentPlan, assetPlan }) => ({ candidateId, visualWorldPlan, componentPlan, assetPlan })));
  const proposals = await writeJson(join(root, 'direction/DIRECTION_PROPOSALS.json'), {
    $schema: 'https://hyperframes.local/schemas/direction-proposals.schema.json', schemaVersion: '1.0.0', revision: 2, status: 'proposed', candidates,
    bindings: { editBriefDigest: editBrief.integrity.digest, evidenceDigest, roughCutDigest, timelineDigest: timeline.integrity.digest, musicPlanDigest: computeArtifactDigest(timeline.music), assetPlanDigest },
    integrity: { digest: null, upstream: {} },
  });
  const workbench = '<html><button data-approve>Approve</button></html>\n';
  await writeFile(join(root, 'review/director-workbench.html'), workbench);
  const approval = await writeJson(join(root, 'direction/DIRECTOR_APPROVAL.json'), {
    $schema: 'https://hyperframes.local/schemas/director-approval.schema.json', schemaVersion: '1.0.0', revision: 1, status: 'approved', selectedCandidateId: 'candidate-a',
    displayedArtifactDigests: { editBrief: editBrief.integrity.digest, roughCut: roughCutDigest, musicPlan: computeArtifactDigest(timeline.music), assetPlan: assetPlanDigest, evidence: evidenceDigest, proposals: proposals.integrity.digest },
    workbenchDigest: SHA(workbench), approvedAt: NOW,
    integrity: { digest: null, upstream: {} },
  });
  await writeJson(join(root, 'direction/DESIGN_SYSTEM.json'), draftDesign());
  await writeJson(join(root, 'direction/LOOK_PROFILE.json'), draftLook());
  await writeJson(join(root, 'PROJECT_STATE.json'), stateAtReview());

  const rebuildWorkbench = async ({ selectedCandidate, state }) => {
    const html = `<html data-state-revision="${state.revision}"><h1>${selectedCandidate.title}</h1><p>Locked direction · read-only</p></html>\n`;
    await writeFile(join(root, 'review/director-workbench.html'), html);
    return { digest: SHA(html) };
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
