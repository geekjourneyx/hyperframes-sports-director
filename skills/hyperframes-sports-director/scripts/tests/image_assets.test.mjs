import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';

import { computeArtifactDigest } from '../lib/contracts.mjs';
import { buildProjectAssetProofs } from '../build_asset_proofs.mjs';
import { cropProjectComponent } from '../crop_component_sheet.mjs';
import { lockDirection } from '../lock_direction.mjs';
import { createDirectorLockFixture } from './director_lock.test.mjs';
import { persistApprovedRepair } from '../lib/invalidation.mjs';
import {
  AssetPipelineError,
  acceptAssetStage,
  assertImageGenerationAuthorized,
  buildAssetProofs,
  cropComponentSheet,
  inspectStyleAnchor,
  persistAssetStage,
  resolveProjectAssetPath,
  withProjectAssetDescriptors,
  validateImageAssetFiles,
  validateImageAssets,
} from '../lib/image-assets.mjs';

const NOW = '2026-09-01T12:00:00.000Z';
const HEX = (value) => createHash('sha256').update(value).digest('hex');

function stamp(value) {
  value.integrity.digest = computeArtifactDigest(value);
  return value;
}

function lockedDirection() {
  const design = stamp({
    $schema: 'https://hyperframes.local/schemas/design-system.schema.json', schemaVersion: '1.0.0',
    revision: 2, designRevision: 'design-candidate-a', status: 'frozen', approvalDigest: HEX('approval'),
    lifecycle: [{ status: 'draft', at: NOW }, { status: 'proposed', at: NOW }, { status: 'approved', at: NOW }, { status: 'frozen', at: NOW }],
    tokens: {
      colors: { 'color.background': '#050505', 'color.primaryText': '#F5F2EA', 'color.accent': '#C9A86A' },
      typography: {}, spacing: {}, safeZones: {}, strokes: {}, radii: {}, depth: {}, motion: {},
      easing: { standard: 'power2.out' }, contrast: { criticalText: 7 }, redundantEncodings: { status: 'shape-and-label' },
    },
    selectedDirection: { candidateId: 'candidate-a', digest: HEX('candidate'), candidate: {} },
    integrity: { digest: null, upstream: {} },
  });
  const look = stamp({
    $schema: 'https://hyperframes.local/schemas/look-profile.schema.json', schemaVersion: '1.0.0',
    revision: 2, lookRevision: 'look-candidate-a', status: 'frozen', approvalDigest: HEX('approval'),
    lifecycle: [{ status: 'draft', at: NOW }, { status: 'proposed', at: NOW }, { status: 'approved', at: NOW }, { status: 'frozen', at: NOW }],
    input: { interpretation: 'rec709' }, working: { colorSpace: 'linear-rec709' }, output: { colorSpace: 'rec709-sdr' },
    adjustments: { whiteBalance: 0, exposure: 0, contrast: 1, saturation: 1, highlightProtection: 0.5 },
    shotMatchingPolicy: 'conservative', selectedLook: { candidateId: 'candidate-a', treatment: 'mineral', grain: 'restrained' },
    directionBinding: { candidateId: 'candidate-a', candidateDigest: HEX('candidate') }, integrity: { digest: null, upstream: {} },
  });
  const assetPlanDigest = HEX('asset-plan');
  const selectedCandidate = {
    candidateId: 'candidate-a',
    representativeEvidenceIds: ['frame-proof-climb', 'frame-proof-release', 'frame-proof-label-only'],
    visualWorldPlan: { statement: 'Mineral effort world', plannedAssets: ['chapter-slate', 'route-thread'] },
    componentPlan: { components: ['terrain', 'effort', 'water'], heroAssets: ['hero-summit'] },
    assetPlan: { roles: ['journey_anchor', 'chapter_slate'], productionImageGenUsed: false },
  };
  const selectedAssetPlanDigest = computeArtifactDigest({
    visualWorldPlan: selectedCandidate.visualWorldPlan, componentPlan: selectedCandidate.componentPlan, assetPlan: selectedCandidate.assetPlan,
  });
  return { design, look, assetPlanDigest, selectedCandidate, selectedAssetPlanDigest };
}

function stateAt(state, evidence = {}) {
  return {
    $schema: 'https://hyperframes.local/schemas/project-state.schema.json', schemaVersion: '1.0.0', revision: 11,
    state, previousState: 'DIRECTOR_REVIEW_READY', stateEnteredAt: NOW, transitions: evidence.transitions ?? [],
    gateEvidence: evidence.gateEvidence ?? [], invalidations: [], integrity: { digest: HEX(`state:${state}`), upstream: {} },
  };
}

function lockEvidenceState(state, design, look, trailing = {}) {
  const lockAt = '2026-09-01T11:00:00.000Z';
  const lockRecords = [
    ['DESIGN_SYSTEM', design.revision, design.integrity.digest, 'frozen'],
    ['LOOK_PROFILE', look.revision, look.integrity.digest, 'frozen'],
    ['DIRECTOR_APPROVAL', 1, HEX('approval'), 'consumed'],
    ['WORKBENCH', 10, HEX('workbench'), 'state-bound'],
  ].map(([role, revision, digest, qualifier]) => ({
    gate: 'DIRECTOR_LOCK', role, revision, digest, timestamp: lockAt, producerCommand: 'lock_direction.mjs',
    qualifiers: [qualifier], validity: 'valid', invalidatedAt: null,
  }));
  const lockTransition = {
    from: 'DIRECTOR_REVIEW_READY', to: 'DIRECTOR_LOCK', at: lockAt,
    evidenceDigests: Object.fromEntries(lockRecords.map(({ role, digest }) => [role, digest])),
    evidenceRevisions: Object.fromEntries(lockRecords.map(({ role, revision }) => [role, revision])),
  };
  return stateAt(state, {
    transitions: [lockTransition, ...(trailing.transitions ?? [])],
    gateEvidence: [...lockRecords, ...(trailing.gateEvidence ?? [])],
  });
}

function proof(id, semanticIntent, meaningIds, representative = false, componentIds = ['asset-terrain']) {
  const footageEvidenceId = `frame-${id}`;
  return {
    id, path: `assets/images/proofs/${id}.png`, digest: HEX(id), status: 'accepted', semanticIntent,
    meaningIds, footageEvidenceId, includesRealFootage: true, componentIds, representative,
    semanticAcceptance: { decision: 'accepted', reviewer: 'Agent', reviewedAt: NOW,
      evidencePath: `review/assets/${id}.json`, evidenceDigest: HEX(`agent-review:${id}`), proofDigest: HEX(id),
      componentIds, footageEvidenceId, meaningIds, semanticIntent },
  };
}

function anchorVisualAcceptance(anchorDigest, { design, look, assetPlanDigest } = lockedDirection()) {
  const conclusions = {
    palette: 'accepted', material: 'accepted', lighting: 'accepted', grain: 'accepted',
    edge: 'accepted', composition: 'accepted',
  };
  return {
    decision: 'accepted', reviewer: 'Agent', visualInspectionAvailable: true, reviewedAt: NOW,
    evidencePath: 'review/assets/style-anchor-acceptance.json', evidenceDigest: HEX('style-anchor-visual-review'),
    anchorDigest, designSystemDigest: design.integrity.digest, lookProfileDigest: look.integrity.digest,
    assetPlanDigest, conclusions,
  };
}

function asset(overrides = {}) {
  return {
    id: 'asset-terrain', assetId: 'asset-terrain', source: 'assets/images/components/terrain.png', sourceKind: 'component-crop',
    provenance: { kind: 'generated-interpretive', sourceDigest: HEX('terrain'), producer: 'image-gen', generatedAt: NOW },
    documentaryStatus: 'interpretive', narrativeRole: 'journey_anchor', semanticColorTokens: ['color.accent'],
    crop: { sourceSheet: 'assets/images/source/terrain-sheet.png', sourceSheetDigest: HEX('terrain-sheet'), receiptDigest: HEX('terrain-receipt'), left: 20, top: 30, width: 140, height: 120, padding: 12 },
    alphaBounds: { left: 22, top: 22, width: 100, height: 80 },
    expectedDisplayRect: { x: 100, y: 100, width: 80, height: 64, canvasWidth: 3840, canvasHeight: 2160 },
    nativeEffectivePixels: { width: 100, height: 80 }, styleAnchorId: 'asset-style-anchor',
    proofs: {
      dark: { path: 'assets/images/proofs/terrain-dark.png', digest: HEX('terrain-dark'), background: '#050505', componentDigest: HEX('terrain'), canvas: { width: 320, height: 180 }, displayRect: { x: 50, y: 40, width: 100, height: 80 }, receiptDigest: HEX('terrain-dark-receipt') },
      light: { path: 'assets/images/proofs/terrain-light.png', digest: HEX('terrain-light'), background: '#F5F2EA', componentDigest: HEX('terrain'), canvas: { width: 320, height: 180 }, displayRect: { x: 50, y: 40, width: 100, height: 80 }, receiptDigest: HEX('terrain-light-receipt') },
    },
    allowedUses: ['overlay', 'transition'], combinationTests: [proof('proof-climb', 'terrain reveals effort', ['terrain', 'effort'], true)],
    visualAcceptance: null, optional: false, planItem: 'terrain', planType: 'component', selectedRole: 'journey_anchor',
    ...overrides,
  };
}

function manifest(entries) {
  const { design, look, assetPlanDigest, selectedAssetPlanDigest } = lockedDirection();
  return stamp({
    $schema: 'https://hyperframes.local/schemas/asset-manifest.schema.json', schemaVersion: '1.0.0', revision: 2,
    assetRevision: 'assets-2', status: 'available', designRevision: design.designRevision, lookRevision: look.lookRevision,
    designSystemDigest: design.integrity.digest, lookProfileDigest: look.integrity.digest, assetPlanDigest, selectedAssetPlanDigest,
    acceptance: { anchorDigest: null, representativeDigest: null, anchorIdentity: null, representativeIdentity: null, batches: [] },
    assets: entries, integrity: { digest: null, upstream: { designSystem: design.integrity.digest, lookProfile: look.integrity.digest, assetPlan: assetPlanDigest } },
  });
}

test('public project APIs cannot consume caller-forged authority and validation dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hf-public-asset-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['assets/images/source', 'assets/images/components', 'assets/images/proofs', 'cache', 'direction']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  const sheet = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#C9A86A' } }).png().toBuffer();
  await writeFile(join(root, 'assets/images/source/sheet.png'), sheet);
  await writeFile(join(root, 'assets/images/components/component.png'), sheet);
  const candidate = manifest([]);
  await writeFile(join(root, 'cache/candidate.json'), `${JSON.stringify(candidate)}\n`);
  let forgedCalls = 0;
  const forged = {
    validateCommittedDirection: async () => { forgedCalls += 1; return lockedDirection(); },
    validateImageAssetFiles: async () => ({ valid: true, errors: [] }),
    buildPostLockWorkbench: async () => ({ ok: true }),
  };
  const minted = { ...forged, [Symbol('forged-capability')]: true };
  await assert.rejects(cropProjectComponent({ project: root, stage: 'representative', source: 'assets/images/source/sheet.png',
    output: 'assets/images/components/crop.png', left: 0, top: 0, width: 32, height: 32, padding: 0,
    displayX: 0, displayY: 0, displayWidth: 32, displayHeight: 32, canvasWidth: 32, canvasHeight: 32 }, minted));
  await assert.rejects(buildProjectAssetProofs({ project: root, stage: 'representative', component: 'assets/images/components/component.png',
    basename: 'component', x: 0, y: 0, width: 32, height: 32, canvasWidth: 32, canvasHeight: 32 }, minted));
  await assert.rejects(persistAssetStage({ projectRoot: root, stage: 'anchor', manifestPath: 'cache/candidate.json', timestamp: NOW }, minted));
  assert.equal(forgedCalls, 0);
});

test('crop recovery removes an owned partial prepared stage and rebuilds exact source-derived bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hf-crop-prepared-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, 'sheet.png');
  const outputPath = join(root, 'crop.png');
  await sharp({ create: { width: 100, height: 100, channels: 4, background: '#C9A86A' } }).png().toFile(sourcePath);
  const options = { sourcePath, outputPath, crop: { left: 0, top: 0, width: 100, height: 100 }, padding: 0,
    expectedDisplayRect: { x: 0, y: 0, width: 100, height: 100, canvasWidth: 100, canvasHeight: 100 } };
  await assert.rejects(cropComponentSheet({ ...options, injectFailure: 'afterInitialJournalLink' }), (error) => error.code === 'E_INJECTED_FAILURE');
  const journalPath = join(root, '.crop.png.crop.transaction.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  const stagePath = join(root, `.crop.png.${journal.transactionId}.tmp.png`);
  await writeFile(stagePath, 'partial-owned-stage');
  const recovered = await cropComponentSheet(options);
  assert.equal(recovered.recovered, true);
  assert.equal(HEX(await readFile(outputPath)), recovered.outputDigest);
  await assert.rejects(access(journalPath));
  await assert.rejects(access(stagePath));
  for (const failure of ['afterOutputLink', 'afterCompletionWrite', 'afterStageUnlink', 'afterJournalUnlink', 'beforeDirectoryFsync']) {
    const stageOptions = { ...options, outputPath: join(root, `${failure}.png`) };
    await assert.rejects(cropComponentSheet({ ...stageOptions, injectFailure: failure }), (error) => error.code === 'E_INJECTED_FAILURE');
    const retry = await cropComponentSheet(stageOptions);
    assert.equal(retry.ok, true, failure);
    assert.equal(HEX(await readFile(stageOptions.outputPath)), retry.outputDigest, failure);
  }
});

test('component-crop consumers require an exact durable crop completion and no pending crop journal', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hf-crop-receipt-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['assets/images/source', 'assets/images/components']) await mkdir(join(root, directory), { recursive: true });
  const sheet = await sharp({ create: { width: 100, height: 100, channels: 4, background: '#C9A86A' } }).png().toBuffer();
  await writeFile(join(root, 'assets/images/source/sheet.png'), sheet);
  const result = await cropComponentSheet({ sourcePath: join(root, 'assets/images/source/sheet.png'),
    outputPath: join(root, 'assets/images/components/crop.png'), crop: { left: 0, top: 0, width: 100, height: 100 }, padding: 0,
    expectedDisplayRect: { x: 0, y: 0, width: 100, height: 100, canvasWidth: 100, canvasHeight: 100 } });
  const entry = asset({ source: 'assets/images/components/crop.png', provenance: { ...asset().provenance, sourceDigest: result.outputDigest },
    crop: { sourceSheet: 'assets/images/source/sheet.png', sourceSheetDigest: result.sourceSheetDigest, receiptDigest: result.cropReceiptDigest,
      left: 0, top: 0, width: 100, height: 100, padding: 0 }, alphaBounds: result.alphaBounds,
    nativeEffectivePixels: result.nativeEffectivePixels, expectedDisplayRect: result.expectedDisplayRect, proofs: {}, combinationTests: [] });
  const completionPath = join(root, 'assets/images/components/.crop.png.crop.complete.json');
  const completion = await readFile(completionPath);
  await rm(completionPath);
  assert.ok((await validateImageAssetFiles({ projectRoot: root, manifest: manifest([entry]), phase: 'anchor' })).errors
    .some(({ code }) => code === 'E_CROP_COMPLETION'));
  await writeFile(completionPath, completion);
  await writeFile(join(root, 'assets/images/components/.crop.png.crop.transaction.json'), '{}\n');
  assert.ok((await validateImageAssetFiles({ projectRoot: root, manifest: manifest([entry]), phase: 'anchor' })).errors
    .some(({ code }) => code === 'E_CROP_COMPLETION'));
});

test('Style Anchor acceptance requires digest-bound Agent visual conclusions and representative is an explicit subset', () => {
  const { design, look, assetPlanDigest, selectedCandidate } = lockedDirection();
  const lockedState = lockEvidenceState('DIRECTOR_LOCK', design, look);
  const anchor = asset({ id: 'asset-style-anchor', assetId: 'asset-style-anchor', sourceKind: 'style-anchor',
    source: 'assets/images/source/style-anchor.png', crop: null, proofs: {}, combinationTests: [], planItem: null,
    planType: 'styleAnchor', selectedRole: null, allowedUses: ['style-reference', 'fullscreen'],
    alphaBounds: { left: 0, top: 0, width: 3840, height: 2160 }, nativeEffectivePixels: { width: 3840, height: 2160 },
    expectedDisplayRect: { x: 0, y: 0, width: 3840, height: 2160, canvasWidth: 3840, canvasHeight: 2160 },
    styleAnchorId: 'asset-style-anchor', visualAcceptance: null });
  let result = validateImageAssets({ manifest: manifest([anchor]), design, look, projectState: lockedState, phase: 'anchor',
    approvedAssetPlanDigest: assetPlanDigest, selectedCandidate });
  assert.ok(result.errors.some(({ code }) => code === 'E_STYLE_ANCHOR_VISUAL_ACCEPTANCE'));
  anchor.visualAcceptance = anchorVisualAcceptance(anchor.provenance.sourceDigest, { design, look, assetPlanDigest });
  const representative = asset();
  const extra = asset({ id: 'asset-extra', assetId: 'asset-extra', planItem: 'water', combinationTests: [] });
  result = validateImageAssets({ manifest: manifest([anchor, representative, extra]), design, look,
    projectState: lockEvidenceState('STYLE_ANCHOR', design, look), phase: 'representative',
    approvedAssetPlanDigest: assetPlanDigest, selectedCandidate, acceptedFootageEvidenceIds: ['frame-proof-climb'] });
  assert.ok(result.errors.some(({ code }) => code === 'E_REPRESENTATIVE_SUBSET'));
});

test('unavailable activity removes the activity_evidence requirement and rejects fabricated substitutes', () => {
  const { design, look, assetPlanDigest, selectedCandidate } = lockedDirection();
  const anchor = asset({ id: 'asset-style-anchor', assetId: 'asset-style-anchor', sourceKind: 'style-anchor', source: 'assets/images/source/style-anchor.png',
    crop: null, proofs: {}, combinationTests: [], planItem: null, planType: 'styleAnchor', selectedRole: null,
    allowedUses: ['style-reference', 'fullscreen'], alphaBounds: { left: 0, top: 0, width: 3840, height: 2160 },
    nativeEffectivePixels: { width: 3840, height: 2160 }, expectedDisplayRect: { x: 0, y: 0, width: 3840, height: 2160, canvasWidth: 3840, canvasHeight: 2160 },
    styleAnchorId: 'asset-style-anchor', visualAcceptance: anchorVisualAcceptance(asset().provenance.sourceDigest, { design, look, assetPlanDigest }) });
  anchor.provenance.sourceDigest = anchor.visualAcceptance.anchorDigest;
  const journey = asset();
  const carrier = asset({ id: 'asset-water', assetId: 'asset-water', planItem: 'water', narrativeRole: 'experience_carrier',
    combinationTests: [proof('proof-release', 'water carries release', ['water', 'release'], false, ['asset-water'])] });
  const generatedActivity = asset({ id: 'asset-effort', assetId: 'asset-effort', planItem: 'effort', narrativeRole: 'activity_evidence',
    documentaryStatus: 'interpretive', provenance: { ...asset().provenance, kind: 'generated-interpretive' }, combinationTests: [] });
  const acceptedState = lockEvidenceState('ASSET_PRODUCTION', design, look, { transitions: [{ from: 'STYLE_ANCHOR', to: 'ASSET_PRODUCTION', at: NOW,
    evidenceDigests: { STYLE_ANCHOR: anchor.provenance.sourceDigest, REPRESENTATIVE_COMBINATION: HEX('proof-climb') },
    evidenceRevisions: { STYLE_ANCHOR: 2, REPRESENTATIVE_COMBINATION: 2 } }], gateEvidence: [
    { gate: 'ASSET_PRODUCTION', role: 'STYLE_ANCHOR', revision: 2, digest: anchor.provenance.sourceDigest, timestamp: NOW, producerCommand: 'validate_image_assets.mjs', qualifiers: ['accepted'], validity: 'valid', invalidatedAt: null },
    { gate: 'ASSET_PRODUCTION', role: 'REPRESENTATIVE_COMBINATION', revision: 2, digest: HEX('proof-climb'), timestamp: NOW, producerCommand: 'validate_image_assets.mjs', qualifiers: ['accepted'], validity: 'valid', invalidatedAt: null },
  ] });
  let result = validateImageAssets({ manifest: manifest([anchor, journey, carrier]), design, look, projectState: acceptedState,
    phase: 'batch', activityStatus: 'unavailable', approvedAssetPlanDigest: assetPlanDigest, selectedCandidate,
    acceptedFootageEvidenceIds: ['frame-proof-climb', 'frame-proof-release'] });
  assert.ok(!result.errors.some(({ code }) => code === 'E_ROLE_COVERAGE' && /activity_evidence/.test(code.message ?? '')));
  result = validateImageAssets({ manifest: manifest([anchor, journey, carrier, generatedActivity]), design, look, projectState: acceptedState,
    phase: 'batch', activityStatus: 'unavailable', approvedAssetPlanDigest: assetPlanDigest, selectedCandidate,
    acceptedFootageEvidenceIds: ['frame-proof-climb', 'frame-proof-release'] });
  assert.ok(result.errors.some(({ code }) => code === 'E_ACTIVITY_EVIDENCE_UNAVAILABLE'));
});

test('accepted Anchor and representative identities reject same-ID byte substitution', () => {
  const { design, look, assetPlanDigest, selectedCandidate } = lockedDirection();
  const anchor = asset({ id: 'asset-style-anchor', assetId: 'asset-style-anchor', sourceKind: 'style-anchor', source: 'assets/images/source/style-anchor.png',
    crop: null, proofs: {}, combinationTests: [], planItem: null, planType: 'styleAnchor', selectedRole: null,
    allowedUses: ['style-reference', 'fullscreen'], alphaBounds: { left: 0, top: 0, width: 3840, height: 2160 },
    nativeEffectivePixels: { width: 3840, height: 2160 }, expectedDisplayRect: { x: 0, y: 0, width: 3840, height: 2160, canvasWidth: 3840, canvasHeight: 2160 },
    styleAnchorId: 'asset-style-anchor' });
  anchor.visualAcceptance = anchorVisualAcceptance(anchor.provenance.sourceDigest, { design, look, assetPlanDigest });
  const component = asset();
  const candidate = manifest([anchor, component]);
  candidate.acceptance.anchorDigest = anchor.provenance.sourceDigest;
  candidate.acceptance.representativeDigest = component.combinationTests[0].digest;
  candidate.acceptance.anchorIdentity = { assetId: anchor.id, sourceDigest: anchor.provenance.sourceDigest,
    narrativeRole: anchor.narrativeRole, semanticColorTokens: anchor.semanticColorTokens,
    visualAcceptanceDigest: computeArtifactDigest(anchor.visualAcceptance) };
  candidate.acceptance.representativeIdentity = { proofId: component.combinationTests[0].id,
    proofDigest: component.combinationTests[0].digest,
    semanticAcceptanceDigest: component.combinationTests[0].semanticAcceptance.evidenceDigest,
    footageEvidenceId: component.combinationTests[0].footageEvidenceId,
    components: [{ assetId: component.id, sourceDigest: component.provenance.sourceDigest, cropReceiptDigest: component.crop.receiptDigest }] };
  anchor.provenance.sourceDigest = HEX('replacement-anchor-bytes');
  anchor.visualAcceptance.anchorDigest = anchor.provenance.sourceDigest;
  component.provenance.sourceDigest = HEX('replacement-component-bytes');
  component.crop.receiptDigest = HEX('replacement-crop-receipt');
  const result = validateImageAssets({ manifest: candidate, design, look, projectState: lockEvidenceState('STYLE_ANCHOR', design, look),
    phase: 'representative', approvedAssetPlanDigest: assetPlanDigest, selectedCandidate,
    acceptedFootageEvidenceIds: ['frame-proof-climb'] });
  assert.ok(result.errors.some(({ code }) => code === 'E_ACCEPTED_ANCHOR_IDENTITY'));
  assert.ok(result.errors.some(({ code }) => code === 'E_ACCEPTED_REPRESENTATIVE_IDENTITY'));
});

function validateForTest(input) {
  const { assetPlanDigest, selectedCandidate } = lockedDirection();
  return validateImageAssets({
    approvedAssetPlanDigest: assetPlanDigest,
    selectedCandidate,
    acceptedFootageEvidenceIds: ['frame-proof-climb', 'frame-proof-release', 'frame-proof-label-only'],
    currentEvidenceBindings: { 'overlay-effort': { kind: 'data-overlay', digest: HEX('activity-overlays') } },
    ...input,
  });
}

test('anchor-first image assets preserve source pixels and enforce production, proof, role, and timeline gates', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hf-image-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'component-sheet.png');
  const cropped = join(root, 'component.png');
  await sharp({ create: { width: 400, height: 240, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: { create: { width: 100, height: 80, channels: 4, background: { r: 201, g: 168, b: 106, alpha: 1 } } }, left: 30, top: 40 }])
    .png().toFile(source);
  const before = HEX(await readFile(source));
  const cropResult = await cropComponentSheet({
    sourcePath: source, outputPath: cropped, crop: { left: 20, top: 30, width: 140, height: 120 }, padding: 12,
    expectedDisplayRect: { x: 100, y: 100, width: 80, height: 64, canvasWidth: 3840, canvasHeight: 2160 },
  });
  assert.equal(HEX(await readFile(source)), before, 'source sheets remain byte-for-byte immutable');
  assert.deepEqual(cropResult.crop, { left: 20, top: 30, width: 140, height: 120, padding: 12 });
  assert.deepEqual(cropResult.alphaBounds, { left: 22, top: 22, width: 100, height: 80 });
  assert.deepEqual(cropResult.nativeEffectivePixels, { width: 100, height: 80 });
  assert.equal((await sharp(cropped).metadata()).hasAlpha, true);
  assert.equal((await sharp(cropped).ensureAlpha().raw().toBuffer())[3], 0, 'padding remains transparent');
  assert.equal((await cropComponentSheet({ sourcePath: source, outputPath: cropped,
    crop: { left: 20, top: 30, width: 140, height: 120 }, padding: 12,
    expectedDisplayRect: { x: 100, y: 100, width: 80, height: 64, canvasWidth: 3840, canvasHeight: 2160 } })).idempotent, true);
  const crashCrop = join(root, 'crash-crop.png');
  const crashCropOptions = { sourcePath: source, outputPath: crashCrop,
    crop: { left: 20, top: 30, width: 140, height: 120 }, padding: 12,
    expectedDisplayRect: { x: 100, y: 100, width: 80, height: 64, canvasWidth: 3840, canvasHeight: 2160 } };
  await assert.rejects(cropComponentSheet({ ...crashCropOptions, injectFailure: 'afterOutputLink' }),
    (error) => error.code === 'E_INJECTED_FAILURE');
  assert.equal((await cropComponentSheet(crashCropOptions)).recovered, true,
    'crop link crash recovers the exact durable inode and publishes completion idempotently');
  const prelinkCrashCrop = join(root, 'prelink-crash-crop.png');
  const prelinkCrashOptions = { ...crashCropOptions, outputPath: prelinkCrashCrop };
  await assert.rejects(cropComponentSheet({ ...prelinkCrashOptions, injectFailure: 'afterInitialJournalLink' }),
    (error) => error.code === 'E_INJECTED_FAILURE');
  assert.equal((await cropComponentSheet(prelinkCrashOptions)).recovered, true,
    'crop recovery reconstructs and publishes exact staged bytes after a durable pre-link journal crash');
  const forgedOwnerOutput = join(root, 'forged-owner-crop.png');
  const forgedOwnerJournal = stamp({ kind: 'component-crop', schemaVersion: '1.0.0', transactionId: '../../outside-owner',
    phase: 'prepared', sourceDigest: cropResult.sourceSheetDigest, outputDigest: cropResult.outputDigest,
    receiptDigest: cropResult.cropReceiptDigest, integrity: { digest: null, upstream: {} } });
  await writeFile(join(root, '.forged-owner-crop.png.crop.transaction.json'), `${JSON.stringify(forgedOwnerJournal, null, 2)}\n`);
  await assert.rejects(cropComponentSheet({ ...crashCropOptions, outputPath: forgedOwnerOutput }),
    (error) => error.code === 'E_CROP_TRANSACTION', 'self-stamped crop journals cannot inject cleanup or staging paths');

  const proofResult = await buildAssetProofs({
    componentPath: cropped, outputDirectory: root, basename: 'terrain',
    displayRect: { x: 50, y: 40, width: 100, height: 80 }, canvas: { width: 320, height: 180 },
  });
  assert.deepEqual(Object.keys(proofResult.proofs).sort(), ['dark', 'light']);
  assert.equal(proofResult.proofs.dark.componentDigest, cropResult.outputDigest);
  assert.deepEqual(proofResult.proofs.light.displayRect, { x: 50, y: 40, width: 100, height: 80 });
  assert.equal((await sharp(join(root, 'terrain-dark.png')).metadata()).width, 320);
  assert.equal((await sharp(join(root, 'terrain-light.png')).metadata()).height, 180);
  const initialJournalOptions = { componentPath: cropped, outputDirectory: root, basename: 'initial-link-crash',
    displayRect: { x: 50, y: 40, width: 100, height: 80 }, canvas: { width: 320, height: 180 } };
  await assert.rejects(buildAssetProofs({ ...initialJournalOptions, injectFailure: 'afterInitialJournalLink' }),
    (error) => error.code === 'E_INJECTED_FAILURE');
  const initialJournalPath = join(root, '.initial-link-crash-proofs.transaction.json');
  const journalStat = await lstat(initialJournalPath);
  const linkedJournalStages = (await readdir(root)).filter((name) => name.startsWith('..initial-link-crash-proofs.transaction.json.') && name.endsWith('.staged'));
  assert.equal(linkedJournalStages.length, 1);
  assert.equal((await lstat(join(root, linkedJournalStages[0]))).ino, journalStat.ino);
  assert.equal((await buildAssetProofs(initialJournalOptions)).ok, true);
  assert.deepEqual((await readdir(root)).filter((name) => name.includes('initial-link-crash') && name.endsWith('.staged')), [],
    'recovery and completion remove a same-inode initial journal stage so it cannot resurrect');

  let releaseProof;
  let proofAcquired;
  const proofAcquiredPromise = new Promise((resolveAcquired) => { proofAcquired = resolveAcquired; });
  const releaseProofPromise = new Promise((resolveRelease) => { releaseProof = resolveRelease; });
  const concurrentOptions = { ...initialJournalOptions, basename: 'proof-mutex' };
  const firstProof = buildAssetProofs({ ...concurrentOptions, afterJournalAcquire: async () => {
    proofAcquired(); await releaseProofPromise;
  } });
  await proofAcquiredPromise;
  await assert.rejects(buildAssetProofs(concurrentOptions), (error) => error.code === 'E_PROOF_TRANSACTION_BUSY');
  releaseProof();
  assert.equal((await firstProof).ok, true, 'a losing proof builder cannot delete the active owner journal');

  const maliciousBytes = await sharp({ create: { width: 320, height: 180, channels: 4, background: '#00FF00' } }).png().toBuffer();
  const forgedProofDocument = (requestedBasename, completion = false) => {
    const token = HEX(`${requestedBasename}:owner`);
    const forgedProofs = {};
    for (const kind of ['dark', 'light']) {
      const targetBasename = `${requestedBasename}-${kind}.png`;
      const stagedBasename = `.${requestedBasename}-${kind}.${token}.tmp.png`;
      const receipt = { path: targetBasename, digest: HEX(maliciousBytes), background: kind === 'dark' ? '#050505' : '#F5F2EA',
        componentDigest: cropResult.outputDigest, canvas: { width: 320, height: 180 },
        displayRect: { x: 50, y: 40, width: 100, height: 80 } };
      receipt.receiptDigest = computeArtifactDigest(receipt);
      forgedProofs[kind] = completion ? receipt : { stagedBasename, targetBasename, digest: receipt.digest, receipt };
    }
    return completion ? stamp({ kind: 'asset-proof-completion', schemaVersion: '1.0.0', componentDigest: cropResult.outputDigest,
      directoryIdentity: 'proof-output', canvas: { width: 320, height: 180 }, displayRect: { x: 50, y: 40, width: 100, height: 80 },
      proofs: forgedProofs, integrity: { digest: null, upstream: {} } })
      : stamp({ schemaVersion: '1.0.0', phase: 'staged', owner: { pid: 999999, processStartId: 'dead-owner', token },
        componentDigest: cropResult.outputDigest, directoryIdentity: 'proof-output', canvas: { width: 320, height: 180 },
        displayRect: { x: 50, y: 40, width: 100, height: 80 }, proofs: forgedProofs, integrity: { digest: null, upstream: {} } });
  };
  const forgedProofJournal = forgedProofDocument('forged-proof-journal');
  for (const entry of Object.values(forgedProofJournal.proofs)) await writeFile(join(root, entry.stagedBasename), maliciousBytes);
  await writeFile(join(root, '.forged-proof-journal-proofs.transaction.json'), `${JSON.stringify(forgedProofJournal, null, 2)}\n`);
  await assert.rejects(buildAssetProofs({ ...initialJournalOptions, basename: 'forged-proof-journal' }),
    (error) => error.code === 'E_PROOF_TRANSACTION');
  const forgedCompletion = forgedProofDocument('forged-proof-completion', true);
  for (const receipt of Object.values(forgedCompletion.proofs)) await writeFile(join(root, receipt.path), maliciousBytes);
  await writeFile(join(root, '.forged-proof-completion-proofs.complete.json'), `${JSON.stringify(forgedCompletion, null, 2)}\n`);
  await assert.rejects(buildAssetProofs({ ...initialJournalOptions, basename: 'forged-proof-completion' }),
    (error) => error.code === 'E_PROOF_TRANSACTION');
  const recoveryOptions = { componentPath: cropped, outputDirectory: root, basename: 'recoverable',
    displayRect: { x: 50, y: 40, width: 100, height: 80 }, canvas: { width: 320, height: 180 } };
  await assert.rejects(buildAssetProofs({ ...recoveryOptions, injectFailure: 'beforeStageCleanup' }),
    (error) => error.code === 'E_INJECTED_FAILURE');
  const durableProofJournalPath = join(root, '.recoverable-proofs.transaction.json');
  const durableProofJournalBytes = await readFile(durableProofJournalPath);
  const durableProofJournal = JSON.parse(durableProofJournalBytes);
  const unrelatedJournalStage = join(root, `..recoverable-proofs.transaction.json.${durableProofJournal.owner.token}.staged`);
  await writeFile(unrelatedJournalStage, durableProofJournalBytes);
  assert.notEqual((await lstat(unrelatedJournalStage)).ino, (await lstat(durableProofJournalPath)).ino);
  await access(join(root, 'recoverable-dark.png')); await access(join(root, 'recoverable-light.png'));
  const durableDarkBytes = await readFile(join(root, 'recoverable-dark.png'));
  await writeFile(join(root, 'recoverable-dark.png'), 'tampered');
  await assert.rejects(buildAssetProofs(recoveryOptions), (error) => error.code === 'E_PROOF_TRANSACTION');
  await writeFile(join(root, 'recoverable-dark.png'), durableDarkBytes);
  assert.equal((await buildAssetProofs(recoveryOptions)).ok, true);
  assert.equal((await buildAssetProofs(recoveryOptions)).idempotent, true, 'durable completion receipt makes proof publication idempotent');
  await assert.rejects(access(unrelatedJournalStage), (error) => error.code === 'ENOENT',
    'completion-first recovery removes only the exact owner-token journal stage and never promotes it');
  await assert.rejects(access(join(root, '.recoverable-proofs.transaction.json')));
  for (const phase of ['afterLightIntent', 'afterLightPublished']) {
    const phaseOptions = { ...recoveryOptions, basename: phase.toLowerCase() };
    await assert.rejects(buildAssetProofs({ ...phaseOptions, injectFailure: phase }), (error) => error.code === 'E_INJECTED_FAILURE');
    assert.equal((await buildAssetProofs(phaseOptions)).ok, true, `${phase} resumes the completed dark side and finishes the pair`);
  }
  const proofCompletionOptions = { ...recoveryOptions, basename: 'completion-receipt' };
  await assert.rejects(buildAssetProofs({ ...proofCompletionOptions, injectFailure: 'afterJournalUnlink' }),
    (error) => error.code === 'E_INJECTED_FAILURE');
  assert.equal((await buildAssetProofs(proofCompletionOptions)).idempotent, true,
    'durable proof completion survives failure after journal unlink');
  await assert.rejects(buildAssetProofs({ componentPath: cropped, outputDirectory: root, basename: 'upscale',
    displayRect: { x: 0, y: 0, width: 101, height: 80 }, canvas: { width: 320, height: 180 } }), (error) => error.code === 'E_EFFECTIVE_PIXELS');
  await writeFile(join(root, 'blocked-light.png'), 'occupied');
  await assert.rejects(buildAssetProofs({ componentPath: cropped, outputDirectory: root, basename: 'blocked',
    displayRect: { x: 0, y: 0, width: 100, height: 80 }, canvas: { width: 320, height: 180 } }), (error) => error.code === 'E_OUTPUT_EXISTS');
  await assert.rejects(access(join(root, 'blocked-dark.png')));

  const { design, look, assetPlanDigest, selectedCandidate } = lockedDirection();
  assert.throws(() => assertImageGenerationAuthorized({ projectState: stateAt('ROUGH_CUT'), design, look, assetPlanDigest }),
    (error) => error instanceof AssetPipelineError && error.code === 'E_DIRECTOR_LOCK_REQUIRED');
  assert.throws(() => assertImageGenerationAuthorized({ projectState: stateAt('DIRECTOR_LOCK'), design, look, assetPlanDigest }),
    (error) => error.code === 'E_DIRECTOR_LOCK_EVIDENCE');
  const lockedState = lockEvidenceState('DIRECTOR_LOCK', design, look);
  assert.doesNotThrow(() => assertImageGenerationAuthorized({ projectState: lockedState, design, look, assetPlanDigest }));
  const forgedLock = structuredClone(lockedState);
  forgedLock.gateEvidence[0].producerCommand = 'forged-lock.mjs';
  assert.throws(() => assertImageGenerationAuthorized({ projectState: forgedLock, design, look, assetPlanDigest }),
    (error) => error.code === 'E_DIRECTOR_LOCK_EVIDENCE');
  const extraLockRole = structuredClone(lockedState);
  extraLockRole.gateEvidence.push({ ...extraLockRole.gateEvidence[0], role: 'EXTRA', digest: HEX('extra') });
  assert.throws(() => assertImageGenerationAuthorized({ projectState: extraLockRole, design, look, assetPlanDigest }),
    (error) => error.code === 'E_DIRECTOR_LOCK_EVIDENCE');

  const directionFixture = await createDirectorLockFixture(t);
  await lockDirection(directionFixture.root, { now: () => NOW, rebuildWorkbench: directionFixture.rebuildWorkbench });
  const projectRoot = directionFixture.root;
  const anchorRelative = 'assets/images/source/style-anchor.png';
  await mkdir(join(projectRoot, 'assets/images/source'), { recursive: true });
  await mkdir(join(projectRoot, 'assets/images/components'), { recursive: true });
  await assert.rejects(persistAssetStage({ projectRoot, stage: 'anchor' }), (error) => error.code === 'E_MANIFEST_CANDIDATE_PATH');
  await assert.rejects(persistAssetStage({ projectRoot, stage: 'anchor', manifestPath: 'cache/anchor.json', transactionPaths: {} }),
    (error) => error.code === 'E_TRANSACTION_CAPABILITY', 'callers cannot inject transaction file capabilities');
  await assert.rejects(persistAssetStage({ projectRoot, stage: 'anchor', manifestPath: 'direction/ASSET_MANIFEST.json' }),
    (error) => error.code === 'E_MANIFEST_CANDIDATE_PATH');
  assert.throws(() => resolveProjectAssetPath(projectRoot, 'assets/images/source/../components/escape.png', 'assets/images/source'),
    (error) => error.code === 'E_ASSET_PATH');
  assert.throws(() => resolveProjectAssetPath(projectRoot, 'assets/images/components/../../escape.png', 'assets/images/components'),
    (error) => error.code === 'E_ASSET_PATH');
  await mkdir(join(projectRoot, 'assets/images/real-components'), { recursive: true });
  await symlink(join(projectRoot, 'assets/images/real-components'), join(projectRoot, 'assets/images/components-link'));
  assert.throws(() => resolveProjectAssetPath(projectRoot, 'assets/images/components-link/escape.png', 'assets/images/components-link'),
    (error) => error.code === 'E_ASSET_PATH');
  const swapDirectory = join(projectRoot, 'assets/images/swap-components');
  const movedSwapDirectory = join(projectRoot, 'assets/images/swap-components-held');
  const externalDirectory = join(root, 'external-components');
  await mkdir(swapDirectory); await mkdir(externalDirectory);
  await withProjectAssetDescriptors(projectRoot, [{ key: 'output', portablePath: 'assets/images/swap-components/result.png',
    requiredRoot: 'assets/images/swap-components' }], async ({ output }) => {
    await rename(swapDirectory, movedSwapDirectory);
    await symlink(externalDirectory, swapDirectory);
    await writeFile(output, 'descriptor-confined');
  });
  await assert.rejects(access(join(externalDirectory, 'result.png')), undefined, 'ancestor swap cannot redirect descriptor-relative writes');
  assert.equal(await readFile(join(movedSwapDirectory, 'result.png'), 'utf8'), 'descriptor-confined');
  const readSwapDirectory = join(projectRoot, 'assets/images/swap-source');
  const movedReadDirectory = join(projectRoot, 'assets/images/swap-source-held');
  const externalReadDirectory = join(root, 'external-source');
  await mkdir(readSwapDirectory); await mkdir(externalReadDirectory);
  await writeFile(join(readSwapDirectory, 'source.png'), 'internal-source');
  await writeFile(join(externalReadDirectory, 'source.png'), 'external-source');
  await withProjectAssetDescriptors(projectRoot, [{ key: 'source', portablePath: 'assets/images/swap-source/source.png',
    requiredRoot: 'assets/images/swap-source' }], async ({ source: stableSource }) => {
    await rename(readSwapDirectory, movedReadDirectory);
    await symlink(externalReadDirectory, readSwapDirectory);
    assert.equal(await readFile(stableSource, 'utf8'), 'internal-source');
  });
  await sharp({ create: { width: 3840, height: 2160, channels: 3, background: '#C9A86A' } }).png()
    .toFile(join(projectRoot, anchorRelative));
  const inspectedAnchor = await inspectStyleAnchor({
    path: join(projectRoot, anchorRelative),
    expectedDisplayRect: { x: 0, y: 0, width: 3840, height: 2160, canvasWidth: 3840, canvasHeight: 2160 },
  });
  assert.deepEqual(inspectedAnchor.nativeEffectivePixels, { width: 3840, height: 2160 });
  await writeFile(join(projectRoot, 'assets/images/source/terrain-sheet.png'), await readFile(source));
  await mkdir(join(projectRoot, 'assets/images/proofs'), { recursive: true });

  let stableCliAuthorizations = 0;
  const validateStableCliDirection = async (stableRoot) => {
    assert.match(stableRoot, /^\/proc\/self\/fd\/\d+$/, 'CLI direction authorization uses the acquired project root descriptor');
    stableCliAuthorizations += 1;
    return { state: lockedState, design, look, selectedCandidate,
      approval: { displayedArtifactDigests: { assetPlan: assetPlanDigest } } };
  };
  await assert.rejects(cropProjectComponent({ project: projectRoot, stage: 'representative',
    source: 'assets/images/source/terrain-sheet.png', output: 'assets/images/components/cli-terrain.png',
    left: 20, top: 30, width: 140, height: 120, padding: 12,
    displayX: 100, displayY: 100, displayWidth: 80, displayHeight: 64, canvasWidth: 3840, canvasHeight: 2160,
  }, { validateCommittedDirection: validateStableCliDirection }),
  (error) => error.code !== undefined, 'public crop API must ignore forged direction validators and read disk authority');
  await writeFile(join(projectRoot, 'assets/images/components/cli-terrain.png'), await readFile(cropped));
  await assert.rejects(buildProjectAssetProofs({ project: projectRoot, stage: 'representative', component: 'assets/images/components/cli-terrain.png',
    basename: 'cli-terrain', x: 50, y: 40, width: 100, height: 80, canvasWidth: 320, canvasHeight: 180,
  }, { validateCommittedDirection: validateStableCliDirection }),
  (error) => error.code !== undefined, 'public proof API must ignore forged direction validators and read disk authority');
  assert.equal(stableCliAuthorizations, 0, 'caller-supplied authority validators are never invoked');

  const anchor = asset({
    id: 'asset-style-anchor', assetId: 'asset-style-anchor', source: 'assets/images/source/style-anchor.png', sourceKind: 'style-anchor',
    provenance: { kind: 'generated-interpretive', sourceDigest: inspectedAnchor.sourceDigest, producer: 'image-gen', generatedAt: NOW },
    crop: null, alphaBounds: { left: 0, top: 0, width: 3840, height: 2160 },
    expectedDisplayRect: { x: 0, y: 0, width: 3840, height: 2160, canvasWidth: 3840, canvasHeight: 2160 },
    nativeEffectivePixels: { width: 3840, height: 2160 }, styleAnchorId: 'asset-style-anchor', proofs: {},
    allowedUses: ['style-reference', 'fullscreen'], combinationTests: [],
    visualAcceptance: anchorVisualAcceptance(inspectedAnchor.sourceDigest, { design, look, assetPlanDigest }),
    planItem: null, planType: 'styleAnchor', selectedRole: null,
  });
  await mkdir(join(projectRoot, 'review/assets'), { recursive: true });
  const anchorEvidence = stamp({
    $schema: 'https://hyperframes.local/contracts/style-anchor-visual-acceptance.json', schemaVersion: '1.0.0', revision: 1,
    decision: 'accepted', reviewer: 'Agent', visualInspectionAvailable: true, reviewedAt: NOW,
    anchorDigest: anchor.provenance.sourceDigest, designSystemDigest: design.integrity.digest,
    lookProfileDigest: look.integrity.digest, assetPlanDigest, conclusions: anchor.visualAcceptance.conclusions,
    integrity: { digest: null, upstream: {} },
  });
  const anchorEvidenceBytes = Buffer.from(`${JSON.stringify(anchorEvidence, null, 2)}\n`);
  await writeFile(join(projectRoot, anchor.visualAcceptance.evidencePath), anchorEvidenceBytes);
  anchor.visualAcceptance.evidenceDigest = HEX(anchorEvidenceBytes);
  const activity = asset({ id: 'asset-effort', assetId: 'asset-effort', narrativeRole: 'activity_evidence', documentaryStatus: 'documentary',
    provenance: { kind: 'code-rendered-activity', sourceDigest: HEX('terrain'), producer: 'render-activity.mjs', generatedAt: NOW,
      evidenceBinding: { kind: 'data-overlay', id: 'overlay-effort', digest: HEX('activity-overlays'), privacyStatus: 'not-applicable' } },
    selectedRole: 'chapter_slate', source: 'assets/images/components/effort.png', combinationTests: [], planItem: 'effort' });
  const carrier = asset({ id: 'asset-water', assetId: 'asset-water', narrativeRole: 'experience_carrier', source: 'assets/images/components/water.png',
    selectedRole: 'journey_anchor', combinationTests: [proof('proof-release', 'water carries release', ['water', 'release'], false, ['asset-water'])], planItem: 'water' });
  const hero = asset({ id: 'asset-hero-summit', assetId: 'asset-hero-summit', source: 'assets/images/source/heroes/summit.png', sourceKind: 'hero',
    crop: null, proofs: {}, allowedUses: ['hero'], planItem: 'hero-summit', planType: 'hero', selectedRole: 'journey_anchor', combinationTests: [] });
  const chapterSlate = asset({ id: 'asset-chapter-slate', assetId: 'asset-chapter-slate', source: 'assets/images/components/chapter-slate.png', sourceKind: 'code-rendered',
    crop: null, proofs: {}, allowedUses: ['chapter'], planItem: 'chapter-slate', planType: 'plannedAsset', selectedRole: 'chapter_slate', combinationTests: [] });
  const routeThread = asset({ id: 'asset-route-thread', assetId: 'asset-route-thread', source: 'assets/images/components/route-thread.png', sourceKind: 'code-rendered',
    crop: null, proofs: {}, allowedUses: ['overlay'], planItem: 'route-thread', planType: 'plannedAsset', selectedRole: 'journey_anchor', combinationTests: [] });
  const validManifest = manifest([anchor, asset(), activity, carrier, hero, chapterSlate, routeThread]);
  const acceptedState = lockEvidenceState('ASSET_PRODUCTION', design, look, {
    transitions: [{ from: 'STYLE_ANCHOR', to: 'ASSET_PRODUCTION', at: NOW,
      evidenceDigests: { STYLE_ANCHOR: inspectedAnchor.sourceDigest, REPRESENTATIVE_COMBINATION: HEX('proof-climb') },
      evidenceRevisions: { STYLE_ANCHOR: 2, REPRESENTATIVE_COMBINATION: 2 } }],
    gateEvidence: [
      { gate: 'ASSET_PRODUCTION', role: 'STYLE_ANCHOR', revision: 2, digest: inspectedAnchor.sourceDigest, timestamp: NOW, producerCommand: 'validate_image_assets.mjs', qualifiers: ['accepted'], validity: 'valid', invalidatedAt: null },
      { gate: 'ASSET_PRODUCTION', role: 'REPRESENTATIVE_COMBINATION', revision: 2, digest: HEX('proof-climb'), timestamp: NOW, producerCommand: 'validate_image_assets.mjs', qualifiers: ['accepted'], validity: 'valid', invalidatedAt: null },
    ],
  });
  const timeline = { items: [{ itemId: 'item-001', assetReferences: ['asset-terrain'] }] };
  assert.deepEqual(validateForTest({ manifest: validManifest, design, look, projectState: acceptedState, timeline, phase: 'batch' }).errors, []);
  assert.ok(validateImageAssets({ manifest: validManifest, design, look, projectState: acceptedState, timeline, phase: 'batch' }).errors.some(({ code }) => code === 'E_ASSET_PLAN_BINDING'));
  const staleBatchEvidence = structuredClone(acceptedState);
  staleBatchEvidence.gateEvidence.at(-1).digest = HEX('stale-proof');
  staleBatchEvidence.transitions.at(-1).evidenceDigests.REPRESENTATIVE_COMBINATION = HEX('stale-proof');
  assert.ok(validateForTest({ manifest: validManifest, design, look, projectState: staleBatchEvidence, timeline, phase: 'batch' }).errors.some(({ code }) => code === 'E_BATCH_EVIDENCE_STALE'));
  assert.ok(validateForTest({ manifest: validManifest, design, look, projectState: acceptedState, timeline, phase: 'batch',
    approvedAssetPlanDigest: HEX('forged-plan') }).errors.some(({ code }) => code === 'E_ASSET_PLAN_BINDING'));
  const anchorOnly = manifest([anchor]);
  assert.deepEqual((await validateImageAssetFiles({ projectRoot, manifest: anchorOnly, phase: 'anchor' })).errors, []);
  const forgedAnchor = structuredClone(anchorOnly);
  forgedAnchor.assets[0].provenance.sourceDigest = HEX('forged-anchor');
  assert.ok((await validateImageAssetFiles({ projectRoot, manifest: forgedAnchor, phase: 'anchor' })).errors.some(({ code }) => code === 'E_PROVENANCE_DIGEST'));

  await mkdir(join(projectRoot, 'assets/images/proofs'), { recursive: true });
  await writeFile(join(projectRoot, 'assets/images/source/terrain-sheet.png'), await readFile(source));
  await writeFile(join(projectRoot, 'assets/images/components/terrain.png'), await readFile(cropped));
  await writeFile(join(projectRoot, 'assets/images/components/.terrain.png.crop.complete.json'),
    await readFile(join(root, '.component.png.crop.complete.json')));
  const descriptorProof = (injectFailure) => withProjectAssetDescriptors(projectRoot, [
    { key: 'componentPath', portablePath: 'assets/images/components/terrain.png', requiredRoot: 'assets/images/components' },
    { key: 'outputDirectory', portablePath: 'assets/images/proofs', requiredRoot: 'assets/images/proofs', directory: true },
  ], ({ componentPath, outputDirectory }) => buildAssetProofs({ componentPath, outputDirectory,
    directoryIdentity: 'assets/images/proofs', basename: 'descriptor-recovery', injectFailure,
    displayRect: { x: 50, y: 40, width: 100, height: 80 }, canvas: { width: 320, height: 180 } }));
  await assert.rejects(descriptorProof('afterLightIntent'), (error) => error.code === 'E_INJECTED_FAILURE');
  assert.equal((await descriptorProof()).ok, true, 'a new directory descriptor rebinds and completes the prior proof journal');
  const projectProofs = await buildAssetProofs({ componentPath: join(projectRoot, 'assets/images/components/terrain.png'),
    outputDirectory: join(projectRoot, 'assets/images/proofs'), basename: 'terrain',
    displayRect: { x: 50, y: 40, width: 100, height: 80 }, canvas: { width: 320, height: 180 } });
  const portableProof = (kind) => {
    const value = { ...projectProofs.proofs[kind], path: `assets/images/proofs/terrain-${kind}.png` };
    delete value.receiptDigest;
    value.receiptDigest = computeArtifactDigest(value);
    return value;
  };
  const combinationBytes = await readFile(join(projectRoot, 'assets/images/proofs/terrain-dark.png'));
  await writeFile(join(projectRoot, 'assets/images/proofs/proof-climb.png'), combinationBytes);
  const fileCombination = proof('proof-climb', 'terrain reveals effort', ['terrain', 'effort'], true);
  fileCombination.digest = HEX(combinationBytes);
  fileCombination.semanticAcceptance.proofDigest = fileCombination.digest;
  const semanticContract = stamp({
    $schema: 'https://hyperframes.local/contracts/asset-semantic-acceptance.json', schemaVersion: '1.0.0', revision: 1,
    decision: 'accepted', reviewer: 'Agent', reviewedAt: NOW, proofDigest: fileCombination.digest,
    componentIds: fileCombination.componentIds, footageEvidenceId: fileCombination.footageEvidenceId,
    meaningIds: fileCombination.meaningIds, semanticIntent: fileCombination.semanticIntent, integrity: { digest: null, upstream: {} },
  });
  await mkdir(join(projectRoot, 'review/assets'), { recursive: true });
  const semanticBytes = Buffer.from(`${JSON.stringify(semanticContract, null, 2)}\n`);
  await writeFile(join(projectRoot, 'review/assets/proof-climb.json'), semanticBytes);
  fileCombination.semanticAcceptance.evidenceDigest = HEX(semanticBytes);
  const receiptedTerrain = asset({ provenance: { kind: 'generated-interpretive', sourceDigest: cropResult.outputDigest, producer: 'image-gen', generatedAt: NOW },
    crop: { sourceSheet: 'assets/images/source/terrain-sheet.png', sourceSheetDigest: cropResult.sourceSheetDigest,
      receiptDigest: cropResult.cropReceiptDigest, left: 20, top: 30, width: 140, height: 120, padding: 12 },
    proofs: { dark: portableProof('dark'), light: portableProof('light') }, combinationTests: [fileCombination] });
  assert.deepEqual((await validateImageAssetFiles({ projectRoot, manifest: manifest([anchor, receiptedTerrain]), phase: 'representative' })).errors, []);
  await writeFile(join(projectRoot, 'assets/images/proofs/.terrain-proofs.transaction.json'), '{}\n');
  assert.ok((await validateImageAssetFiles({ projectRoot, manifest: manifest([anchor, receiptedTerrain]), phase: 'representative' }))
    .errors.some(({ code }) => code === 'E_PROOF_COMPLETION'), 'proof consumers reject pending pair journals even when target bytes exist');
  await rm(join(projectRoot, 'assets/images/proofs/.terrain-proofs.transaction.json'));
  const forgedReceipt = manifest([anchor, { ...receiptedTerrain, crop: { ...receiptedTerrain.crop, receiptDigest: HEX('forged-receipt') } }]);
  assert.ok((await validateImageAssetFiles({ projectRoot, manifest: forgedReceipt, phase: 'representative' })).errors.some(({ code }) => code === 'E_CROP_RECEIPT'));

  const weakProofManifest = structuredClone(validManifest);
  weakProofManifest.assets.find(({ id }) => id === 'asset-water').combinationTests[0] = proof('proof-label-only', 'terrain reveals effort', ['terrain', 'effort']);
  assert.ok(validateForTest({ manifest: weakProofManifest, design, look, projectState: acceptedState, timeline, phase: 'batch' }).errors.some(({ code }) => code === 'E_COMBINATION_SEMANTICS'));

  const crowdedHero = structuredClone(validManifest);
  crowdedHero.assets[1].allowedUses.push('hero');
  assert.ok(validateForTest({ manifest: crowdedHero, design, look, projectState: acceptedState, timeline, phase: 'batch' }).errors.some(({ code }) => code === 'E_CROWDED_SHEET_HERO'));
  const lowResolutionPlate = structuredClone(validManifest);
  lowResolutionPlate.assets[0].nativeEffectivePixels.width = 1920;
  assert.ok(validateForTest({ manifest: lowResolutionPlate, design, look, projectState: acceptedState, timeline, phase: 'batch' }).errors.some(({ code }) => code === 'E_4K_FULLSCREEN_NATIVE'));
  const sheetBackedHero = structuredClone(validManifest);
  sheetBackedHero.assets[1] = asset({ id: 'asset-hero', assetId: 'asset-hero', sourceKind: 'hero', source: 'assets/images/source/heroes/hero.png',
    crop: { sourceSheet: 'assets/images/source/crowded.png', left: 0, top: 0, width: 3840, height: 2160, padding: 0 }, allowedUses: ['hero'] });
  assert.ok(validateForTest({ manifest: sheetBackedHero, design, look, projectState: acceptedState, timeline, phase: 'batch' }).errors.some(({ code }) => code === 'E_HERO_SEPARATE_GENERATION'));
  const mistypedHero = structuredClone(validManifest);
  mistypedHero.assets.find(({ planType }) => planType === 'hero').sourceKind = 'component-crop';
  assert.ok(validateForTest({ manifest: mistypedHero, design, look, projectState: acceptedState, timeline, phase: 'batch' }).errors.some(({ code }) => code === 'E_SELECTED_ASSET_INVENTORY'));
  const generatedDocumentary = structuredClone(validManifest);
  generatedDocumentary.assets[2].documentaryStatus = 'documentary';
  generatedDocumentary.assets[2].provenance.kind = 'generated-interpretive';
  delete generatedDocumentary.assets[2].provenance.evidenceBinding;
  assert.ok(validateForTest({ manifest: generatedDocumentary, design, look, projectState: acceptedState, timeline, phase: 'batch' }).errors.some(({ code }) => code === 'E_GENERATED_DOCUMENTARY'));

  const sourceSheet = asset({ id: 'asset-source-sheet', assetId: 'asset-source-sheet', sourceKind: 'component-sheet', source: 'assets/images/source/crowded.png', allowedUses: ['source-only'] });
  const directSheetManifest = manifest([anchor, sourceSheet, activity, carrier]);
  assert.ok(validateForTest({ manifest: directSheetManifest, design, look, projectState: acceptedState,
    timeline: { items: [{ itemId: 'item-001', assetReferences: ['asset-source-sheet'] }] }, phase: 'batch' }).errors.some(({ code }) => code === 'E_TIMELINE_SOURCE_SHEET'));

  let rebuilds = 0;
  const anchorAcceptance = await acceptAssetStage({ projectState: lockedState, manifest: manifest([anchor]), design, look,
    assetPlanDigest, selectedCandidate, stage: 'anchor', timestamp: NOW }, { rebuildWorkbench: async () => { rebuilds += 1; } });
  assert.equal(anchorAcceptance.projectState.state, 'STYLE_ANCHOR');
  const representativeAcceptance = await acceptAssetStage({ projectState: anchorAcceptance.projectState,
    manifest: manifest([anchor, asset()]), design, look, assetPlanDigest, selectedCandidate,
    acceptedFootageEvidenceIds: ['frame-proof-climb'], stage: 'representative', timestamp: NOW,
    representativeProofDigest: HEX('proof-climb') }, { rebuildWorkbench: async () => { rebuilds += 1; } });
  assert.equal(representativeAcceptance.projectState.state, 'ASSET_PRODUCTION');
  await acceptAssetStage({ projectState: representativeAcceptance.projectState, manifest: validManifest, design, look,
    assetPlanDigest, selectedCandidate, acceptedFootageEvidenceIds: ['frame-proof-climb', 'frame-proof-release'],
    currentEvidenceBindings: { 'overlay-effort': { kind: 'data-overlay', digest: HEX('activity-overlays') } },
    stage: 'batch', timestamp: NOW }, { rebuildWorkbench: async () => { rebuilds += 1; } });
  assert.equal(rebuilds, 3, 'workbench rebuilds after anchor, representative proof, and accepted batch');

  await mkdir(join(projectRoot, 'cache'), { recursive: true });
  await mkdir(join(projectRoot, 'direction'), { recursive: true });
  await mkdir(join(projectRoot, 'edit'), { recursive: true });
  const [genuineLockedState, genuineDesign, genuineLook, genuineApproval] = await Promise.all([
    readFile(join(projectRoot, 'PROJECT_STATE.json'), 'utf8').then(JSON.parse),
    readFile(join(projectRoot, 'direction/DESIGN_SYSTEM.json'), 'utf8').then(JSON.parse),
    readFile(join(projectRoot, 'direction/LOOK_PROFILE.json'), 'utf8').then(JSON.parse),
    readFile(join(projectRoot, 'direction/DIRECTOR_APPROVAL.json'), 'utf8').then(JSON.parse),
  ]);
  const genuineAssetPlanDigest = genuineApproval.displayedArtifactDigests.assetPlan;
  const genuineSelectedCandidate = directionFixture.candidates[0];
  const genuineSelectedAssetPlanDigest = computeArtifactDigest({
    visualWorldPlan: genuineSelectedCandidate.visualWorldPlan,
    componentPlan: genuineSelectedCandidate.componentPlan,
    assetPlan: genuineSelectedCandidate.assetPlan,
  });
  const persistenceManifest = (entries) => stamp({
    $schema: 'https://hyperframes.local/schemas/asset-manifest.schema.json', schemaVersion: '1.0.0', revision: 2,
    assetRevision: 'assets-2', status: 'available', designRevision: genuineDesign.designRevision,
    lookRevision: genuineLook.lookRevision, designSystemDigest: genuineDesign.integrity.digest,
    lookProfileDigest: genuineLook.integrity.digest, assetPlanDigest: genuineAssetPlanDigest,
    selectedAssetPlanDigest: genuineSelectedAssetPlanDigest,
    acceptance: { anchorDigest: null, representativeDigest: null, anchorIdentity: null, representativeIdentity: null, batches: [] },
    assets: entries, integrity: { digest: null, upstream: { designSystem: genuineDesign.integrity.digest,
      lookProfile: genuineLook.integrity.digest, assetPlan: genuineAssetPlanDigest } },
  });
  const persistenceAnchor = structuredClone(anchor);
  persistenceAnchor.visualAcceptance.designSystemDigest = genuineDesign.integrity.digest;
  persistenceAnchor.visualAcceptance.lookProfileDigest = genuineLook.integrity.digest;
  persistenceAnchor.visualAcceptance.assetPlanDigest = genuineAssetPlanDigest;
  const genuineAnchorEvidence = stamp({
    $schema: 'https://hyperframes.local/contracts/style-anchor-visual-acceptance.json', schemaVersion: '1.0.0', revision: 1,
    decision: 'accepted', reviewer: 'Agent', visualInspectionAvailable: true, reviewedAt: NOW,
    anchorDigest: persistenceAnchor.provenance.sourceDigest, designSystemDigest: genuineDesign.integrity.digest,
    lookProfileDigest: genuineLook.integrity.digest, assetPlanDigest: genuineAssetPlanDigest,
    conclusions: persistenceAnchor.visualAcceptance.conclusions, integrity: { digest: null, upstream: {} },
  });
  const genuineAnchorEvidenceBytes = Buffer.from(`${JSON.stringify(genuineAnchorEvidence, null, 2)}\n`);
  await writeFile(join(projectRoot, persistenceAnchor.visualAcceptance.evidencePath), genuineAnchorEvidenceBytes);
  persistenceAnchor.visualAcceptance.evidenceDigest = HEX(genuineAnchorEvidenceBytes);
  const authoritativeDraft = persistenceManifest([]);
  authoritativeDraft.revision = 1; authoritativeDraft.assetRevision = 'assets-1'; authoritativeDraft.status = 'draft';
  authoritativeDraft.integrity.digest = null; authoritativeDraft.integrity.digest = computeArtifactDigest(authoritativeDraft);
  await writeFile(join(projectRoot, 'direction/ASSET_MANIFEST.json'), `${JSON.stringify(authoritativeDraft, null, 2)}\n`);
  const stagedManifest = persistenceManifest([persistenceAnchor]);
  await writeFile(join(projectRoot, 'cache/anchor-manifest.json'), `${JSON.stringify(stagedManifest, null, 2)}\n`);
  await assert.rejects(persistAssetStage({ projectRoot, stage: 'anchor', manifestPath: 'cache/anchor-manifest.json', timestamp: NOW,
    injectFailure: 'duringJournalStage' }), (error) => error.code === 'E_INJECTED_FAILURE');
  await assert.rejects(access(join(projectRoot, 'cache/asset-stage.transaction.json')), undefined,
    'a short initial journal write never publishes a partial final journal');
  await assert.rejects(persistAssetStage({ projectRoot, stage: 'anchor', manifestPath: 'cache/anchor-manifest.json', timestamp: NOW,
    afterJournalAcquire: async ({ previousState }) => {
      const changed = structuredClone(previousState); changed.revision += 1;
      changed.integrity.digest = null; changed.integrity.digest = computeArtifactDigest(changed);
      await writeFile(join(projectRoot, 'PROJECT_STATE.json'), `${JSON.stringify(changed, null, 2)}\n`);
    },
  }), (error) => error.code === 'E_ASSET_TRANSACTION_CONFLICT');
  await writeFile(join(projectRoot, 'PROJECT_STATE.json'), `${JSON.stringify(genuineLockedState, null, 2)}\n`);
  await assert.rejects(access(join(projectRoot, 'cache/asset-stage.transaction.json')));
  let releaseAcceptance;
  let acceptanceAcquired;
  const acceptanceAcquiredPromise = new Promise((resolveAcquired) => { acceptanceAcquired = resolveAcquired; });
  const releaseAcceptancePromise = new Promise((resolveRelease) => { releaseAcceptance = resolveRelease; });
  const interruptedAcceptance = persistAssetStage({ projectRoot, stage: 'anchor', manifestPath: 'cache/anchor-manifest.json', timestamp: NOW,
    injectFailure: 'afterManifestWrite', afterJournalAcquire: async () => {
    acceptanceAcquired(); await releaseAcceptancePromise;
  } });
  await acceptanceAcquiredPromise;
  await assert.rejects(persistAssetStage({ projectRoot, stage: 'anchor', manifestPath: 'cache/anchor-manifest.json', timestamp: NOW,
    mutationGuard: {} }), (error) => error.code === 'E_REPAIR_BUSY',
  'caller-controlled mutationGuard input cannot bypass the private project mutation epoch');
  await assert.rejects(persistApprovedRepair(projectRoot, { repairClass: 'position', role: 'MOTION_MAP' }, {
    gate: 'FINAL_QA', reason: 'concurrent mutation probe', timestamp: '2026-09-01T12:00:30.000Z',
    beforeDigests: {}, afterDigests: {},
  }), (error) => error.code === 'E_REPAIR_BUSY', 'repair and asset acceptance share one project-state mutation guard');
  releaseAcceptance();
  await assert.rejects(interruptedAcceptance, (error) => error.code === 'E_INJECTED_FAILURE');
  await assert.rejects(persistApprovedRepair(projectRoot, { repairClass: 'position', role: 'MOTION_MAP' }, {
    gate: 'FINAL_QA', reason: 'pending asset split probe', timestamp: '2026-09-01T12:00:31.000Z',
    beforeDigests: {}, afterDigests: {},
  }), (error) => error.code === 'E_ASSET_TRANSACTION_PENDING',
  'a released or stale-taken-over guard cannot let repair cross a pending asset publication');
  await access(join(projectRoot, 'cache/asset-stage.transaction.json'));
  const journalPath = join(projectRoot, 'cache/asset-stage.transaction.json');
  const validJournal = JSON.parse(await readFile(journalPath, 'utf8'));
  const forgedJournal = structuredClone(validJournal);
  forgedJournal.nextState.state = 'DELIVERED'; forgedJournal.nextState.revision = 999;
  forgedJournal.nextState.integrity.digest = computeArtifactDigest(forgedJournal.nextState);
  forgedJournal.integrity.digest = computeArtifactDigest(forgedJournal);
  await writeFile(journalPath, `${JSON.stringify(forgedJournal, null, 2)}\n`);
  await assert.rejects(persistAssetStage({ projectRoot, stage: 'anchor', manifestPath: 'cache/anchor-manifest.json', timestamp: NOW }),
    (error) => error.code === 'E_ASSET_TRANSACTION');
  assert.equal(JSON.parse(await readFile(join(projectRoot, 'PROJECT_STATE.json'), 'utf8')).state, 'DIRECTOR_LOCK');
  await writeFile(journalPath, `${JSON.stringify(validJournal, null, 2)}\n`);
  const wrongPhaseJournal = structuredClone(validJournal);
  wrongPhaseJournal.phase = 'documents-published'; wrongPhaseJournal.integrity.digest = computeArtifactDigest(wrongPhaseJournal);
  await writeFile(journalPath, `${JSON.stringify(wrongPhaseJournal, null, 2)}\n`);
  await assert.rejects(persistAssetStage({ projectRoot, stage: 'anchor', manifestPath: 'cache/anchor-manifest.json', timestamp: NOW }),
    (error) => error.code === 'E_ASSET_TRANSACTION_CONFLICT', 'recovery rejects an intermediate pair in a phase that claims both documents durable');
  await writeFile(journalPath, `${JSON.stringify(validJournal, null, 2)}\n`);
  const recovered = await persistAssetStage({ projectRoot, stage: 'anchor', manifestPath: 'cache/anchor-manifest.json', timestamp: NOW });
  assert.equal(recovered.recovered, true);
  const durableManifest = JSON.parse(await readFile(join(projectRoot, 'direction/ASSET_MANIFEST.json'), 'utf8'));
  assert.equal(durableManifest.acceptance.anchorDigest, inspectedAnchor.sourceDigest);
  assert.notEqual(durableManifest.integrity.digest, stagedManifest.integrity.digest);
  const durableState = JSON.parse(await readFile(join(projectRoot, 'PROJECT_STATE.json'), 'utf8'));
  assert.equal(durableState.assetAcceptance.manifestDigest, durableManifest.integrity.digest);
  assert.equal(durableState.assetAcceptance.anchorDigest, inspectedAnchor.sourceDigest);
  await assert.rejects(access(join(projectRoot, 'cache/asset-stage.transaction.json')));
  const pendingRepairState = stamp(JSON.parse(await readFile('skills/hyperframes-sports-director/templates/PROJECT_STATE.template.json', 'utf8')));
  const pendingRepairHistory = stamp({ schemaVersion: '1.0.0', revision: 1, repairs: [],
    integrity: { digest: null, upstream: { projectState: pendingRepairState.integrity.digest } } });
  const pendingRepairJournal = stamp({ schemaVersion: '1.0.0', transactionId: 'a'.repeat(32),
    owner: { token: 'b'.repeat(64), pid: 999999, processStartId: 'dead-repair-owner', active: false }, phase: 'prepared',
    priorHistoryDigest: 'c'.repeat(64), priorStateDigest: durableState.integrity.digest,
    nextHistoryDigest: pendingRepairHistory.integrity.digest, nextStateDigest: pendingRepairState.integrity.digest,
    nextHistory: pendingRepairHistory, nextState: pendingRepairState, integrity: { digest: null, upstream: {} } });
  await writeFile(join(projectRoot, 'cache/repair.transaction.json'), `${JSON.stringify(pendingRepairJournal, null, 2)}\n`);
  await assert.rejects(persistAssetStage({ projectRoot, stage: 'anchor', manifestPath: 'cache/anchor-manifest.json',
    timestamp: '2026-09-01T12:08:00.000Z' }), (error) => error.code === 'E_REPAIR_PENDING',
  'asset acceptance cannot cross an interrupted repair history/state publication');
});
