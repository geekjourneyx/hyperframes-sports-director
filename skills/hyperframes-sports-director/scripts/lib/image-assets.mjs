/*
 * HyperFrames Sports Director image-asset integrity pipeline.
 * Copyright (C) 2026 HyperFrames Sports Director contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Visual-world, Style Anchor, component-sheet, Hero, crop, proof, and
 * combination-test invariants are adapted from HyperFrames Motion Director at
 * the exact revision recorded in UPSTREAM.lock.json. This implementation is
 * original to this repository.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import sharp from 'sharp';

import { validateDataOverlayAuthority } from './activity.mjs';
import { buildPostLockWorkbenchDuringAssetRecovery as rebuildPostLockWorkbenchDuringAssetRecovery,
  validateCommittedDirection as validateDirectionLock,
  validateDirectionDuringAssetRecovery } from './approval.mjs';
import { computeArtifactDigest, loadSchema, validateDocument, verifyArtifactIntegrity } from './contracts.mjs';
import { acquireRepairGuard, assertNoPendingRepairTransaction, processStartIdentity, releaseRepairGuard } from './invalidation.mjs';
import { projectPath, writeJsonAtomic } from './media.mjs';
import { loadProfile } from './profiles.mjs';
import { validateTransition } from './project-state.mjs';

const DIGEST = /^[0-9a-f]{64}$/;
const LOCKED_STATES = new Set([
  'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION', 'MOTION_COMPOSITION',
  'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED',
]);
const REQUIRED_ROLES = new Set(['journey_anchor', 'activity_evidence', 'experience_carrier']);
const GENERATED_PROVENANCE = new Set(['generated-interpretive', 'generated-decorative']);
const SOURCE_SHEET_KINDS = new Set(['component-sheet', 'source-sheet']);
const ASSET_MUTATION_GUARD = Symbol('assetMutationGuard');
const ASSET_TRANSACTION_PATHS = Symbol('assetTransactionPaths');
const CROP_OPERATION_PATHS = Symbol('cropOperationPaths');
const PROOF_OPERATION_PATHS = Symbol('proofOperationPaths');

export class AssetPipelineError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AssetPipelineError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new AssetPipelineError(code, message, details);
}

function diagnostic(code, path, message) {
  return { code, path, message };
}

function sha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function validatePortableAssetPath(portablePath, requiredRoot) {
  const parts = typeof portablePath === 'string' ? portablePath.split('/') : [];
  const rootParts = typeof requiredRoot === 'string' ? requiredRoot.replace(/\/$/, '').split('/') : [];
  if (parts.length === 0 || rootParts.length === 0 || isAbsolute(portablePath ?? '') || portablePath.includes('\\')
    || parts.some((part) => part === '' || part === '.' || part === '..')
    || rootParts.some((part, index) => parts[index] !== part)) {
    fail('E_ASSET_PATH', `asset path must stay under ${requiredRoot}`);
  }
}

export function resolveProjectAssetPath(projectRoot, portablePath, requiredRoot) {
  validatePortableAssetPath(portablePath, requiredRoot);
  const root = projectPath(projectRoot, requiredRoot);
  const target = projectPath(projectRoot, portablePath);
  let cursor = realpathSync(projectRoot);
  for (const part of portablePath.split('/')) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('E_ASSET_PATH', 'asset path cannot traverse a symlink');
  }
  const child = relative(root, target);
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) fail('E_ASSET_PATH', `asset path must stay under ${requiredRoot}`);
  return target;
}

async function openStableProjectDirectory(portableDirectory, requiredRoot, rootHandle) {
  if (portableDirectory === '') {
    if (requiredRoot !== '') fail('E_ASSET_PATH', 'project-root descriptor requires an empty root identity');
  } else validatePortableAssetPath(portableDirectory, requiredRoot);
  const handles = [];
  try {
    let handle = rootHandle;
    for (const part of portableDirectory === '' ? [] : portableDirectory.split('/')) {
      handle = await open(`/proc/self/fd/${handle.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      handles.push(handle);
    }
    return { path: `/proc/self/fd/${handle.fd}`, close: async () => {
      for (const entry of handles.reverse()) await entry.close().catch(() => {});
    } };
  } catch (error) {
    for (const entry of handles.reverse()) await entry.close().catch(() => {});
    fail('E_ASSET_PATH', `asset directory cannot be opened without symlinks beneath ${requiredRoot}`, { cause: error });
  }
}

export async function withProjectAssetDescriptors(projectRoot, specifications, operation) {
  const opened = [];
  let rootHandle;
  try {
    const canonicalRoot = realpathSync(projectRoot);
    const observedRoot = lstatSync(canonicalRoot);
    rootHandle = await open(canonicalRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const openedRoot = await rootHandle.stat();
    if (!openedRoot.isDirectory() || openedRoot.dev !== observedRoot.dev || openedRoot.ino !== observedRoot.ino) {
      fail('E_ASSET_PATH', 'project root changed while acquiring the stable operation descriptor');
    }
    const paths = {};
    for (const specification of specifications) {
      const portable = specification.portablePath;
      if (portable === '') {
        if (!specification.directory || specification.requiredRoot !== '') fail('E_ASSET_PATH', 'only the project-root descriptor may use an empty path');
      } else validatePortableAssetPath(portable, specification.requiredRoot);
      const directory = specification.directory ? portable : dirname(portable);
      const stable = await openStableProjectDirectory(directory, specification.requiredRoot, rootHandle);
      opened.push(stable);
      paths[specification.key] = specification.directory ? stable.path : join(stable.path, basename(portable));
    }
    return await operation(paths);
  } finally {
    for (const stable of opened.reverse()) await stable.close();
    if (rootHandle) await rootHandle.close().catch(() => {});
  }
}

async function withStableAbsolutePaths(specifications, operation) {
  if (specifications.every(({ path }) => path.startsWith('/proc/self/fd/'))) {
    return operation(Object.fromEntries(specifications.map(({ key, path }) => [key, path])));
  }
  const rootHandle = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const handles = [rootHandle];
  try {
    const resolved = {};
    for (const { key, path, directory = false } of specifications) {
      const absolute = resolve(path);
      const parts = (directory ? absolute : dirname(absolute)).split('/').filter(Boolean);
      let current = rootHandle;
      for (const part of parts) {
        current = await open(`/proc/self/fd/${current.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        handles.push(current);
      }
      resolved[key] = directory ? `/proc/self/fd/${current.fd}` : join(`/proc/self/fd/${current.fd}`, basename(absolute));
    }
    return await operation(resolved);
  } finally {
    for (const handle of handles.reverse()) await handle.close().catch(() => {});
  }
}

async function readImmutableProjectAsset(projectRoot, portablePath, requiredRoot) {
  return withProjectAssetDescriptors(projectRoot, [{ key: 'source', portablePath, requiredRoot }],
    ({ source }) => readImmutableFile(source));
}

async function shaFile(path) {
  return (await readImmutableFile(path)).digest;
}

async function readImmutableFile(path) {
  let handle;
  try {
    const observed = await lstat(path);
    if (!observed.isFile() || observed.isSymbolicLink()) fail('E_IMMUTABLE_SOURCE', `asset source must be a regular non-symlink file: ${basename(path)}`);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== observed.dev || opened.ino !== observed.ino) fail('E_IMMUTABLE_SOURCE', `asset source changed while opening: ${basename(path)}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail('E_IMMUTABLE_SOURCE', `asset source changed while reading: ${basename(path)}`);
    }
    return { bytes, digest: sha(bytes), metadata: opened };
  } finally { if (handle) await handle.close().catch(() => {}); }
}

async function syncDirectory(path) {
  const handle = await open(dirname(path), 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

function validRect(rect, includeCanvas = false) {
  return rect && nonNegativeInteger(rect.x ?? rect.left) && nonNegativeInteger(rect.y ?? rect.top)
    && positiveInteger(rect.width) && positiveInteger(rect.height)
    && (!includeCanvas || (positiveInteger(rect.canvasWidth) && positiveInteger(rect.canvasHeight)
      && (rect.x + rect.width) <= rect.canvasWidth && (rect.y + rect.height) <= rect.canvasHeight));
}

function currentAcceptedEvidence(projectState, role) {
  const transition = projectState?.transitions?.findLast(({ to, kind }) => to === 'ASSET_PRODUCTION' && kind !== 'invalidation');
  return projectState?.gateEvidence?.find(({ gate, role: evidenceRole, digest, validity, qualifiers }) => (
    gate === 'ASSET_PRODUCTION' && evidenceRole === role && validity === 'valid'
    && qualifiers?.length === 1 && qualifiers[0] === 'accepted'
    && transition?.to === 'ASSET_PRODUCTION' && transition.evidenceDigests?.[role] === digest
  ));
}

export function assertImageGenerationAuthorized({ projectState, design, look, assetPlanDigest }) {
  if (!LOCKED_STATES.has(projectState?.state)) {
    fail('E_DIRECTOR_LOCK_REQUIRED', 'production image generation requires a committed DIRECTOR_LOCK');
  }
  if (design?.status !== 'frozen' || look?.status !== 'frozen'
    || !DIGEST.test(design?.integrity?.digest ?? '') || !DIGEST.test(look?.integrity?.digest ?? '')) {
    fail('E_DIRECTION_BINDING', 'production image generation requires integrity-bound frozen design and Look contracts');
  }
  const lockTransitions = (projectState?.transitions ?? []).filter(({ to }) => to === 'DIRECTOR_LOCK');
  const lockTransition = lockTransitions[0];
  const currentLockRecords = (projectState?.gateEvidence ?? []).filter(({ gate }) => gate === 'DIRECTOR_LOCK');
  const byRole = new Map(currentLockRecords.map((record) => [record.role, record]));
  const exactRoles = ['DESIGN_SYSTEM', 'LOOK_PROFILE', 'DIRECTOR_APPROVAL', 'WORKBENCH'];
  const expectedQualifiers = { DESIGN_SYSTEM: 'frozen', LOOK_PROFILE: 'frozen', DIRECTOR_APPROVAL: 'consumed', WORKBENCH: 'state-bound' };
  const transitionRoles = Object.keys(lockTransition?.evidenceDigests ?? {}).sort();
  const transitionRevisionRoles = Object.keys(lockTransition?.evidenceRevisions ?? {}).sort();
  if (lockTransitions.length !== 1 || currentLockRecords.length !== exactRoles.length
    || transitionRoles.join() !== exactRoles.slice().sort().join() || transitionRevisionRoles.join() !== exactRoles.slice().sort().join()
    || exactRoles.some((role) => !byRole.has(role))
    || byRole.get('DESIGN_SYSTEM')?.digest !== design.integrity.digest
    || byRole.get('DESIGN_SYSTEM')?.revision !== design.revision
    || byRole.get('LOOK_PROFILE')?.digest !== look.integrity.digest
    || byRole.get('LOOK_PROFILE')?.revision !== look.revision
    || currentLockRecords.some((record) => record.validity !== 'valid' || record.invalidatedAt !== null
      || record.producerCommand !== 'lock_direction.mjs' || record.timestamp !== lockTransition?.at
      || record.qualifiers?.length !== 1 || record.qualifiers[0] !== expectedQualifiers[record.role])
    || exactRoles.some((role) => lockTransition?.evidenceDigests?.[role] !== byRole.get(role)?.digest
      || lockTransition?.evidenceRevisions?.[role] !== byRole.get(role)?.revision)) {
    fail('E_DIRECTOR_LOCK_EVIDENCE', 'production image generation requires current digest-bound DIRECTOR_LOCK evidence');
  }
  if (!DIGEST.test(assetPlanDigest ?? '')) fail('E_ASSET_PLAN_BINDING', 'production image generation requires the approved asset-plan digest');
  return {
    designSystemDigest: design.integrity.digest,
    lookProfileDigest: look.integrity.digest,
    assetPlanDigest,
  };
}

function assertBatchAuthorized(projectState, errors) {
  if (projectState?.state !== 'ASSET_PRODUCTION') {
    errors.push(diagnostic('E_BATCH_NOT_AUTHORIZED', '/projectState/state', 'batch assets require ASSET_PRODUCTION state'));
    return;
  }
  for (const role of ['STYLE_ANCHOR', 'REPRESENTATIVE_COMBINATION']) {
    if (!currentAcceptedEvidence(projectState, role)) {
      errors.push(diagnostic('E_BATCH_NOT_AUTHORIZED', '/projectState/gateEvidence', `batch assets require current accepted ${role} digest`));
    }
  }
}

function proofMeaningKey(value) {
  const meanings = Array.isArray(value?.meaningIds) ? [...new Set(value.meaningIds)].sort() : [];
  return meanings.length > 0 ? meanings.join('\u0000') : null;
}

function anchorIdentity(anchor) {
  if (!anchor) return null;
  return {
    assetId: anchor.id, sourceDigest: anchor.provenance?.sourceDigest ?? null,
    narrativeRole: anchor.narrativeRole, semanticColorTokens: structuredClone(anchor.semanticColorTokens ?? []),
    visualAcceptanceDigest: computeArtifactDigest(anchor.visualAcceptance),
  };
}

function representativeIdentity(manifest) {
  const proof = manifest?.assets?.flatMap(({ combinationTests }) => combinationTests ?? [])
    .find(({ representative, status }) => representative === true && status === 'accepted');
  if (!proof) return null;
  const byId = new Map(manifest.assets.map((entry) => [entry.id, entry]));
  return {
    proofId: proof.id, proofDigest: proof.digest, semanticAcceptanceDigest: proof.semanticAcceptance?.evidenceDigest ?? null,
    footageEvidenceId: proof.footageEvidenceId,
    components: proof.componentIds.map((id) => {
      const entry = byId.get(id);
      return { assetId: id, sourceDigest: entry?.provenance?.sourceDigest ?? null,
        cropReceiptDigest: entry?.crop?.receiptDigest ?? null };
    }),
  };
}

export function deriveSelectedAssetPlan(selectedCandidate) {
  if (!selectedCandidate?.visualWorldPlan || !selectedCandidate?.componentPlan || !selectedCandidate?.assetPlan) {
    fail('E_SELECTED_ASSET_PLAN', 'selected candidate must contain the committed visual-world, component, and asset plans');
  }
  const plan = {
    visualWorldPlan: selectedCandidate.visualWorldPlan,
    componentPlan: selectedCandidate.componentPlan,
    assetPlan: selectedCandidate.assetPlan,
  };
  const typed = new Map();
  const add = (type, items) => items.forEach((item) => {
    if (typed.has(item)) fail('E_SELECTED_ASSET_PLAN', `selected plan item ${item} appears in more than one typed inventory`);
    typed.set(item, type);
  });
  add('plannedAsset', plan.visualWorldPlan.plannedAssets ?? []);
  add('component', plan.componentPlan.components ?? []);
  add('hero', plan.componentPlan.heroAssets ?? []);
  const roles = new Set(plan.assetPlan.roles ?? []);
  return { digest: computeArtifactDigest(plan), inventory: typed, roles,
    typedInventory: [...typed].map(([id, type]) => ({ id, type })).concat([...roles].map((id) => ({ id, type: 'role' }))) };
}

function validateProof(proof, path, errors) {
  if (!proof || typeof proof.id !== 'string' || !DIGEST.test(proof.digest ?? '') || proof.status !== 'accepted'
    || typeof proof.path !== 'string' || !proof.path.startsWith('assets/images/proofs/')
    || typeof proof.semanticIntent !== 'string' || proof.semanticIntent.trim() === ''
    || !Array.isArray(proof.meaningIds) || proof.meaningIds.length === 0
    || new Set(proof.meaningIds).size !== proof.meaningIds.length
    || proof.meaningIds.some((meaning) => typeof meaning !== 'string' || meaning.trim() === '')
    || proof.includesRealFootage !== true || typeof proof.footageEvidenceId !== 'string'
    || !Array.isArray(proof.componentIds) || proof.componentIds.length === 0
    || proof.semanticAcceptance?.decision !== 'accepted'
    || proof.semanticAcceptance?.reviewer !== 'Agent'
    || typeof proof.semanticAcceptance?.evidencePath !== 'string' || !proof.semanticAcceptance.evidencePath.startsWith('review/assets/')
    || !Number.isFinite(Date.parse(proof.semanticAcceptance?.reviewedAt))
    || !DIGEST.test(proof.semanticAcceptance?.evidenceDigest ?? '')
    || proof.semanticAcceptance?.proofDigest !== proof.digest
    || proof.semanticAcceptance?.footageEvidenceId !== proof.footageEvidenceId
    || proof.semanticAcceptance?.semanticIntent !== proof.semanticIntent
    || JSON.stringify(proof.semanticAcceptance?.componentIds) !== JSON.stringify(proof.componentIds)
    || JSON.stringify(proof.semanticAcceptance?.meaningIds) !== JSON.stringify(proof.meaningIds)) {
    errors.push(diagnostic('E_COMBINATION_PROOF', path, 'combination proof must bind accepted bytes, semantic meanings, real-footage evidence, and components'));
  }
}

function validateAnchorVisualAcceptance(anchor, authorization, path, errors) {
  const acceptance = anchor?.visualAcceptance;
  const conclusions = acceptance?.conclusions;
  const exactConclusions = ['palette', 'material', 'lighting', 'grain', 'edge', 'composition'];
  if (acceptance?.decision !== 'accepted' || acceptance?.reviewer !== 'Agent'
    || acceptance?.visualInspectionAvailable !== true || !Number.isFinite(Date.parse(acceptance?.reviewedAt))
    || typeof acceptance?.evidencePath !== 'string' || !acceptance.evidencePath.startsWith('review/assets/')
    || !DIGEST.test(acceptance?.evidenceDigest ?? '') || acceptance?.anchorDigest !== anchor?.provenance?.sourceDigest
    || acceptance?.designSystemDigest !== authorization.designSystemDigest
    || acceptance?.lookProfileDigest !== authorization.lookProfileDigest
    || acceptance?.assetPlanDigest !== authorization.assetPlanDigest
    || JSON.stringify(Object.keys(conclusions ?? {}).sort()) !== JSON.stringify(exactConclusions.sort())
    || exactConclusions.some((key) => typeof conclusions[key] !== 'string' || conclusions[key].trim() === '')) {
    errors.push(diagnostic('E_STYLE_ANCHOR_VISUAL_ACCEPTANCE', path,
      'Style Anchor requires digest-bound Agent visual inspection of palette, material, lighting, grain, edge, and composition'));
  }
}

function validateAsset(asset, index, tokenNames, anchorIds, errors) {
  const path = `/assets/${index}`;
  const required = ['id', 'assetId', 'source', 'sourceKind', 'provenance', 'documentaryStatus', 'narrativeRole',
    'crop', 'alphaBounds', 'expectedDisplayRect', 'nativeEffectivePixels', 'styleAnchorId', 'proofs', 'allowedUses', 'combinationTests', 'planItem', 'planType', 'selectedRole'];
  for (const field of required) if (!Object.hasOwn(asset ?? {}, field)) errors.push(diagnostic('E_ASSET_FIELD', `${path}/${field}`, `asset requires ${field}`));
  if (asset?.id !== asset?.assetId || !/^asset-[A-Za-z0-9-]+$/.test(asset?.id ?? '')) {
    errors.push(diagnostic('E_ASSET_ID', `${path}/id`, 'id and assetId must be the same portable asset identifier'));
  }
  if (typeof asset?.source !== 'string' || !asset.source.startsWith('assets/images/')) {
    errors.push(diagnostic('E_ASSET_SOURCE', `${path}/source`, 'asset source must be project-relative under assets/images'));
  }
  if (!DIGEST.test(asset?.provenance?.sourceDigest ?? '') || typeof asset?.provenance?.producer !== 'string'
    || !Number.isFinite(Date.parse(asset?.provenance?.generatedAt))) {
    errors.push(diagnostic('E_ASSET_PROVENANCE', `${path}/provenance`, 'asset provenance must bind source bytes, producer, and generation time'));
  }
  if (GENERATED_PROVENANCE.has(asset?.provenance?.kind) && asset.documentaryStatus === 'documentary') {
    errors.push(diagnostic('E_GENERATED_DOCUMENTARY', `${path}/documentaryStatus`, 'generated scenery or components cannot be documentary evidence'));
  }
  if (!REQUIRED_ROLES.has(asset?.narrativeRole)) errors.push(diagnostic('E_NARRATIVE_ROLE', `${path}/narrativeRole`, 'asset narrative role is not recognized'));
  if (!Array.isArray(asset?.semanticColorTokens) || asset.semanticColorTokens.length === 0
    || asset.semanticColorTokens.some((token) => !tokenNames.has(token))) {
    errors.push(diagnostic('E_TOKEN_BINDING', `${path}/semanticColorTokens`, 'asset colors must resolve only to frozen semantic tokens'));
  }
  if (!validRect(asset?.alphaBounds) || !validRect(asset?.expectedDisplayRect, true)
    || !positiveInteger(asset?.nativeEffectivePixels?.width) || !positiveInteger(asset?.nativeEffectivePixels?.height)) {
    errors.push(diagnostic('E_ASSET_GEOMETRY', path, 'asset requires valid alpha, display, and native-effective-pixel rectangles'));
  } else if (asset.nativeEffectivePixels.width < asset.expectedDisplayRect.width
    || asset.nativeEffectivePixels.height < asset.expectedDisplayRect.height) {
    errors.push(diagnostic('E_EFFECTIVE_PIXELS', `${path}/nativeEffectivePixels`, 'native effective pixels must cover the maximum approved display rectangle'));
  }
  if (asset?.sourceKind === 'component-crop') {
    const crop = asset.crop;
    if (!crop || typeof crop.sourceSheet !== 'string' || !crop.sourceSheet.startsWith('assets/images/source/')
      || !DIGEST.test(crop.sourceSheetDigest ?? '') || !DIGEST.test(crop.receiptDigest ?? '')
      || !nonNegativeInteger(crop.left) || !nonNegativeInteger(crop.top) || !positiveInteger(crop.width)
      || !positiveInteger(crop.height) || !nonNegativeInteger(crop.padding)) {
      errors.push(diagnostic('E_CROP', `${path}/crop`, 'component crops require a source-sheet box and non-negative padding'));
    } else if (asset.alphaBounds && (asset.alphaBounds.left < crop.padding || asset.alphaBounds.top < crop.padding
      || asset.alphaBounds.left + asset.alphaBounds.width > crop.width + crop.padding
      || asset.alphaBounds.top + asset.alphaBounds.height > crop.height + crop.padding)) {
      errors.push(diagnostic('E_ALPHA_PADDING', `${path}/alphaBounds`, 'visible alpha must remain inside the declared transparent padding'));
    }
    const proofComplete = (proof, kind) => proof?.path && DIGEST.test(proof.digest ?? '') && DIGEST.test(proof.componentDigest ?? '')
      && DIGEST.test(proof.receiptDigest ?? '') && proof.background === (kind === 'dark' ? '#050505' : '#F5F2EA')
      && validRect(proof.displayRect) && positiveInteger(proof.canvas?.width) && positiveInteger(proof.canvas?.height);
    if (!proofComplete(asset.proofs?.dark, 'dark') || !proofComplete(asset.proofs?.light, 'light')) {
      errors.push(diagnostic('E_ALPHA_PROOFS', `${path}/proofs`, 'transparent components require dark and light proof digests'));
    }
  }
  if (asset?.sourceKind === 'hero' && (asset.crop !== null || !asset.source?.startsWith('assets/images/source/heroes/')
    || !asset.allowedUses?.includes('hero'))) {
    errors.push(diagnostic('E_HERO_SEPARATE_GENERATION', path, 'Hero assets must be generated separately under assets/images/source/heroes with no sheet crop'));
  }
  if (SOURCE_SHEET_KINDS.has(asset?.sourceKind)
    && asset.allowedUses?.some((use) => ['hero', 'fullscreen'].includes(use))) {
    errors.push(diagnostic('E_CROWDED_SHEET_HERO', `${path}/allowedUses`, 'a crowded source sheet cannot be enlarged into a Hero'));
  }
  if (asset?.sourceKind === 'component-crop' && asset.allowedUses?.includes('hero')) {
    errors.push(diagnostic('E_CROWDED_SHEET_HERO', `${path}/allowedUses`, 'a component-sheet crop cannot be used as a Hero'));
  }
  if (asset?.allowedUses?.includes('fullscreen') && (asset.nativeEffectivePixels?.width < 3840
    || asset.nativeEffectivePixels?.height < 2160)) {
    errors.push(diagnostic('E_4K_FULLSCREEN_NATIVE', `${path}/nativeEffectivePixels`, 'a 4K full-screen plate requires native 3840x2160 effective pixels'));
  }
  if (typeof asset?.styleAnchorId !== 'string' || !anchorIds.has(asset.styleAnchorId)) {
    errors.push(diagnostic('E_STYLE_ANCHOR_RELATION', `${path}/styleAnchorId`, 'every asset must resolve to the accepted Style Anchor'));
  }
  if (!Array.isArray(asset?.allowedUses) || asset.allowedUses.length === 0 || !Array.isArray(asset?.combinationTests)) {
    errors.push(diagnostic('E_ASSET_USES', path, 'asset allowed uses and combination tests must be explicit'));
  }
  for (const [proofIndex, combination] of (asset?.combinationTests ?? []).entries()) {
    validateProof(combination, `${path}/combinationTests/${proofIndex}`, errors);
  }
}

export function validateImageAssets({ manifest, design, look, projectState, timeline = { items: [] }, phase = 'batch',
  approvedAssetPlanDigest, selectedCandidate, acceptedFootageEvidenceIds = [], currentEvidenceBindings = {}, activityStatus = 'available' }) {
  const errors = [];
  let authorization;
  try {
    authorization = assertImageGenerationAuthorized({ projectState, design, look, assetPlanDigest: approvedAssetPlanDigest });
  } catch (error) {
    errors.push(diagnostic(error.code ?? 'E_AUTHORIZATION', '/projectState', error.message));
    return { valid: false, errors };
  }
  let selectedPlan;
  try { selectedPlan = deriveSelectedAssetPlan(selectedCandidate); }
  catch (error) { errors.push(diagnostic(error.code, '/selectedCandidate', error.message)); }
  if (manifest?.designSystemDigest !== authorization.designSystemDigest
    || manifest?.lookProfileDigest !== authorization.lookProfileDigest
    || manifest?.integrity?.upstream?.designSystem !== authorization.designSystemDigest
    || manifest?.integrity?.upstream?.lookProfile !== authorization.lookProfileDigest
    || manifest?.assetPlanDigest !== authorization.assetPlanDigest
    || manifest?.integrity?.upstream?.assetPlan !== authorization.assetPlanDigest
    || manifest?.selectedAssetPlanDigest !== selectedPlan?.digest) {
    const code = manifest?.assetPlanDigest !== authorization.assetPlanDigest ? 'E_ASSET_PLAN_BINDING'
      : manifest?.selectedAssetPlanDigest !== selectedPlan?.digest ? 'E_SELECTED_ASSET_PLAN' : 'E_STYLE_BINDING';
    errors.push(diagnostic(code, '/integrity/upstream', 'manifest must bind the frozen design, Look, and approved asset plan'));
  }
  if (!['available', 'frozen'].includes(manifest?.status)) {
    errors.push(diagnostic('E_MANIFEST_STATUS', '/status', 'accepted image assets require an available or frozen manifest'));
  }
  const assets = manifest?.assets ?? [];
  const duplicateIds = assets.map(({ id }) => id).filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length) errors.push(diagnostic('E_ASSET_ID_DUPLICATE', '/assets', 'asset identifiers must be unique'));
  const anchors = assets.filter(({ sourceKind }) => sourceKind === 'style-anchor');
  if (anchors.length !== 1) errors.push(diagnostic('E_STYLE_ANCHOR_COUNT', '/assets', 'exactly one Style Anchor is required'));
  const anchorIds = new Set(anchors.map(({ id }) => id));
  const byId = new Map(assets.map((entry) => [entry.id, entry]));
  const tokenNames = new Set(Object.keys(design?.tokens?.colors ?? {}));
  for (const [index, entry] of assets.entries()) validateAsset(entry, index, tokenNames, anchorIds, errors);
  for (const [index, entry] of assets.entries()) {
    const anchorEntry = entry.sourceKind === 'style-anchor';
    const expectedType = anchorEntry ? 'styleAnchor' : selectedPlan?.inventory.get(entry.planItem);
    const permittedKinds = { styleAnchor: new Set(['style-anchor']), plannedAsset: new Set(['component-crop', 'code-rendered']),
      component: new Set(['component-crop', 'code-rendered']), hero: new Set(['hero']) };
    if (expectedType !== entry.planType || !permittedKinds[entry.planType]?.has(entry.sourceKind)
      || (anchorEntry ? entry.planItem !== null || entry.selectedRole !== null
        : typeof entry.planItem !== 'string' || !selectedPlan?.roles.has(entry.selectedRole))) {
      errors.push(diagnostic('E_SELECTED_ASSET_INVENTORY', `/assets/${index}/planItem`, 'asset must map to an item in the committed selected-candidate plan'));
    }
  }
  const anchor = anchors[0];
  if (anchor) validateAnchorVisualAcceptance(anchor, authorization, `/assets/${assets.indexOf(anchor)}/visualAcceptance`, errors);
  if (manifest?.acceptance?.anchorIdentity !== null && manifest?.acceptance?.anchorIdentity !== undefined
    && JSON.stringify(manifest.acceptance.anchorIdentity) !== JSON.stringify(anchorIdentity(anchor))) {
    errors.push(diagnostic('E_ACCEPTED_ANCHOR_IDENTITY', '/acceptance/anchorIdentity', 'accepted Anchor identity no longer matches its bytes and semantic fields'));
  }
  if (manifest?.acceptance?.representativeIdentity !== null && manifest?.acceptance?.representativeIdentity !== undefined
    && JSON.stringify(manifest.acceptance.representativeIdentity) !== JSON.stringify(representativeIdentity(manifest))) {
    errors.push(diagnostic('E_ACCEPTED_REPRESENTATIVE_IDENTITY', '/acceptance/representativeIdentity',
      'accepted representative identity no longer matches proof, component bytes, footage, and Agent evidence'));
  }
  if (anchor && (!anchor.allowedUses?.includes('style-reference') || anchor.nativeEffectivePixels?.width < 3840
    || anchor.nativeEffectivePixels?.height < 2160)) {
    errors.push(diagnostic('E_STYLE_ANCHOR_RESOLUTION', `/assets/${assets.indexOf(anchor)}`, 'the accepted Style Anchor must be full-resolution and declared as the style reference'));
  }
  if (phase !== 'anchor') {
    const representative = assets.flatMap(({ combinationTests }) => combinationTests ?? []).filter(({ representative, status }) => representative === true && status === 'accepted');
    if (representative.length !== 1) errors.push(diagnostic('E_REPRESENTATIVE_COMBINATION', '/assets', 'exactly one accepted representative real-footage/component proof is required before batch'));
  }
  if (phase === 'representative') {
    const representativeProofs = assets.flatMap(({ combinationTests }) => combinationTests ?? [])
      .filter(({ representative, status }) => representative === true && status === 'accepted');
    const representativeIds = new Set(representativeProofs.flatMap(({ componentIds }) => componentIds ?? []));
    const nonAnchor = assets.filter(({ sourceKind }) => sourceKind !== 'style-anchor');
    if (representativeProofs.length !== 1 || nonAnchor.some((entry) => entry.sourceKind === 'hero'
      || !representativeIds.has(entry.id)) || [...representativeIds].some((id) => !nonAnchor.some((entry) => entry.id === id))) {
      errors.push(diagnostic('E_REPRESENTATIVE_SUBSET', '/assets',
        'representative acceptance may contain only the accepted Anchor and the component set used by its one real-footage proof'));
    }
  }
  if (phase === 'anchor' && assets.some(({ sourceKind }) => sourceKind !== 'style-anchor')) {
    errors.push(diagnostic('E_ANCHOR_FIRST', '/assets', 'Style Anchor acceptance must precede component-sheet, component, and Hero production'));
  }
  if (phase === 'batch') {
    assertBatchAuthorized(projectState, errors);
    const roles = new Set(assets.filter(({ sourceKind }) => !SOURCE_SHEET_KINDS.has(sourceKind)).map(({ narrativeRole }) => narrativeRole));
    const requiredRoles = activityStatus === 'available' ? REQUIRED_ROLES : new Set(['journey_anchor', 'experience_carrier']);
    for (const role of requiredRoles) if (!roles.has(role)) errors.push(diagnostic('E_ROLE_COVERAGE', '/assets', `batch assets must cover ${role}`));
    if (activityStatus !== 'available' && assets.some(({ narrativeRole }) => narrativeRole === 'activity_evidence')) {
      errors.push(diagnostic('E_ACTIVITY_EVIDENCE_UNAVAILABLE', '/assets', 'activity_evidence cannot be generated when current ACTIVITY authority is unavailable'));
    }
    const mappedPlanItems = new Set(assets.filter(({ sourceKind }) => sourceKind !== 'style-anchor').map(({ planItem }) => planItem));
    for (const item of selectedPlan?.inventory.keys() ?? []) if (!mappedPlanItems.has(item)) {
      errors.push(diagnostic('E_SELECTED_ASSET_INVENTORY', '/assets', `accepted batch does not fulfill committed selected-plan item ${item}`));
    }
    for (const item of mappedPlanItems) if (assets.filter(({ planItem }) => planItem === item).length !== 1) {
      errors.push(diagnostic('E_SELECTED_ASSET_INVENTORY', '/assets', `selected-plan item ${item} must map to exactly one accepted artifact`));
    }
    const selectedRoles = new Set(assets.filter(({ sourceKind }) => sourceKind !== 'style-anchor').map(({ selectedRole }) => selectedRole));
    for (const role of selectedPlan?.roles ?? []) if (!selectedRoles.has(role)) errors.push(diagnostic('E_ROLE_COVERAGE', '/assets', `selected plan role ${role} is not fulfilled`));
    const acceptedProofs = assets.flatMap(({ combinationTests }) => combinationTests ?? []).filter(({ status }) => status === 'accepted');
    const representative = acceptedProofs.find(({ representative: selected }) => selected === true);
    if (currentAcceptedEvidence(projectState, 'STYLE_ANCHOR')?.digest !== anchor?.provenance?.sourceDigest
      || currentAcceptedEvidence(projectState, 'REPRESENTATIVE_COMBINATION')?.digest !== representative?.digest) {
      errors.push(diagnostic('E_BATCH_EVIDENCE_STALE', '/projectState/gateEvidence', 'batch manifest must match the accepted Style Anchor and representative proof byte digests'));
    }
    const semanticKeys = new Set(acceptedProofs.map(proofMeaningKey).filter(Boolean));
    const proofDigests = new Set(acceptedProofs.map(({ digest }) => digest));
    const structures = new Set(acceptedProofs.map((proof) => JSON.stringify({ meanings: [...proof.meaningIds].sort(),
      components: [...proof.componentIds].sort(), roles: [...new Set(proof.componentIds.map((id) => byId.get(id)?.narrativeRole).filter(Boolean))].sort(),
      intent: proof.semanticIntent })));
    if (semanticKeys.size < 2 || proofDigests.size < 2 || structures.size < 2) errors.push(diagnostic('E_COMBINATION_SEMANTICS', '/assets', 'final choreography requires two byte-distinct, structurally and semantically different Agent-accepted combination proofs; number or label changes do not count'));
  }
  const acceptedFootage = new Set(acceptedFootageEvidenceIds);
  for (const [assetIndex, entry] of assets.entries()) {
    if (entry.narrativeRole === 'activity_evidence' && (entry.documentaryStatus !== 'documentary'
      || entry.provenance?.kind !== 'code-rendered-activity')) {
      errors.push(diagnostic('E_DOCUMENTARY_ACTIVITY_BINDING', `/assets/${assetIndex}/provenance`,
        'activity_evidence must be truthful activity-derived code-rendered documentary authority'));
    }
    if (entry.provenance?.kind === 'code-rendered-activity') {
      const binding = entry.provenance?.evidenceBinding;
      const current = currentEvidenceBindings[binding?.id];
      if (entry.provenance?.kind !== 'code-rendered-activity' || !binding || current?.digest !== binding.digest
        || current?.kind !== binding.kind || (binding.kind === 'trimmed-route' && binding.privacyStatus !== 'trimmed')) {
        errors.push(diagnostic('E_DOCUMENTARY_ACTIVITY_BINDING', `/assets/${assetIndex}/provenance/evidenceBinding`, 'documentary code-rendered activity must bind current normalized overlay data or a privacy-trimmed route derivative'));
      }
    }
    for (const [proofIndex, proof] of (entry.combinationTests ?? []).entries()) {
      if (!acceptedFootage.has(proof.footageEvidenceId)) errors.push(diagnostic('E_PROOF_FOOTAGE_REFERENCE', `/assets/${assetIndex}/combinationTests/${proofIndex}/footageEvidenceId`, 'combination proof must resolve current accepted real-footage evidence'));
      if (proof.componentIds.some((componentId) => !byId.has(componentId) || SOURCE_SHEET_KINDS.has(byId.get(componentId)?.sourceKind))) {
        errors.push(diagnostic('E_PROOF_COMPONENT_REFERENCE', `/assets/${assetIndex}/combinationTests/${proofIndex}/componentIds`, 'combination proof components must resolve current accepted non-sheet assets'));
      }
    }
  }
  for (const [itemIndex, item] of (timeline?.items ?? []).entries()) {
    for (const assetId of item.assetReferences ?? []) {
      if (SOURCE_SHEET_KINDS.has(byId.get(assetId)?.sourceKind)) {
        errors.push(diagnostic('E_TIMELINE_SOURCE_SHEET', `/timeline/items/${itemIndex}/assetReferences`, 'TIMELINE may reference cropped/hero assets, never a source sheet directly'));
      }
    }
  }
  return { valid: errors.length === 0, errors, styleAnchor: anchor ?? null };
}

function evidenceRecord(gate, role, revision, digest, timestamp, qualifier) {
  return { gate, role, revision, digest, timestamp, producerCommand: 'validate_image_assets.mjs', qualifiers: [qualifier], validity: 'valid', invalidatedAt: null };
}

function transitionState(projectState, next, records, timestamp) {
  validateTransition(projectState.state, next, {
    records,
    currentArtifacts: Object.fromEntries(records.map(({ role, revision, digest }) => [role, { revision, digest }])),
  });
  const result = structuredClone(projectState);
  result.previousState = projectState.state;
  result.state = next;
  result.stateEnteredAt = timestamp;
  result.revision += 1;
  result.gateEvidence = [...(result.gateEvidence ?? []), ...records];
  result.transitions = [...(result.transitions ?? []), {
    from: projectState.state, to: next, at: timestamp,
    evidenceDigests: Object.fromEntries(records.map(({ role, digest }) => [role, digest])),
    evidenceRevisions: Object.fromEntries(records.map(({ role, revision }) => [role, revision])),
  }];
  result.integrity = { ...(result.integrity ?? {}), digest: null };
  result.integrity.digest = computeArtifactDigest(result);
  return result;
}

export async function acceptAssetStage(input, dependencies = {}) {
  const { projectState, manifest, design, look, assetPlanDigest, selectedCandidate, acceptedFootageEvidenceIds = [], currentEvidenceBindings = {}, activityStatus = 'available', stage, timestamp } = input;
  if (!Number.isFinite(Date.parse(timestamp))) fail('E_ACCEPTANCE_TIME', 'asset acceptance requires an ISO timestamp');
  if (!['anchor', 'representative', 'batch'].includes(stage)) fail('E_ACCEPTANCE_STAGE', 'asset acceptance stage is invalid');
  const validationPhase = stage === 'batch' ? 'batch' : stage;
  const validation = validateImageAssets({ manifest, design, look, projectState, phase: validationPhase,
    approvedAssetPlanDigest: assetPlanDigest, selectedCandidate, acceptedFootageEvidenceIds, currentEvidenceBindings, activityStatus });
  const ignorable = stage === 'representative' ? new Set(['E_BATCH_NOT_AUTHORIZED']) : new Set();
  const blocking = validation.errors.filter(({ code }) => !ignorable.has(code));
  if (blocking.length) fail('E_ASSET_VALIDATION', 'asset acceptance failed', { diagnostics: blocking });
  let nextState = structuredClone(projectState);
  if (stage === 'anchor') {
    if (projectState.state !== 'DIRECTOR_LOCK') fail('E_ACCEPTANCE_STATE', 'Style Anchor acceptance requires DIRECTOR_LOCK');
    const anchor = manifest.assets.find(({ sourceKind }) => sourceKind === 'style-anchor');
    const records = [
      evidenceRecord('STYLE_ANCHOR', 'DESIGN_SYSTEM', design.revision, design.integrity.digest, timestamp, 'frozen'),
      evidenceRecord('STYLE_ANCHOR', 'LOOK_PROFILE', look.revision, look.integrity.digest, timestamp, 'frozen'),
      evidenceRecord('STYLE_ANCHOR', 'ASSET_PLAN', manifest.revision, assetPlanDigest, timestamp, 'approved'),
      evidenceRecord('STYLE_ANCHOR', 'STYLE_ANCHOR', manifest.revision, anchor.provenance.sourceDigest, timestamp, 'accepted'),
    ];
    nextState = transitionState(projectState, 'STYLE_ANCHOR', records, timestamp);
  } else if (stage === 'representative') {
    if (projectState.state !== 'STYLE_ANCHOR') fail('E_ACCEPTANCE_STATE', 'representative proof acceptance requires STYLE_ANCHOR');
    const anchor = manifest.assets.find(({ sourceKind }) => sourceKind === 'style-anchor');
    const representative = manifest.assets.flatMap(({ combinationTests }) => combinationTests ?? []).find(({ representative: selected }) => selected === true);
    const representativeDigest = input.representativeProofDigest ?? representative?.digest;
    if (!DIGEST.test(representativeDigest ?? '')) fail('E_REPRESENTATIVE_COMBINATION', 'representative proof digest is required');
    if (representativeDigest !== representative?.digest) fail('E_REPRESENTATIVE_COMBINATION', 'representative proof digest must match the accepted manifest proof');
    const records = [
      evidenceRecord('ASSET_PRODUCTION', 'STYLE_ANCHOR', manifest.revision, anchor.provenance.sourceDigest, timestamp, 'accepted'),
      evidenceRecord('ASSET_PRODUCTION', 'REPRESENTATIVE_COMBINATION', manifest.revision, representativeDigest, timestamp, 'accepted'),
    ];
    nextState = transitionState(projectState, 'ASSET_PRODUCTION', records, timestamp);
  } else if (projectState.state !== 'ASSET_PRODUCTION') {
    fail('E_ACCEPTANCE_STATE', 'accepted asset batches require ASSET_PRODUCTION');
  }
  await (dependencies.rebuildWorkbench ?? (async () => {}))({ projectState: nextState, manifest, stage });
  return { ok: true, stage, projectState: nextState, manifest, validation };
}

async function assertOutputAbsent(path) {
  try {
    await lstat(path);
    fail('E_OUTPUT_EXISTS', `refusing to overwrite existing asset: ${basename(path)}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function alphaBounds(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = info.width; let minY = info.height; let maxX = -1; let maxY = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * info.channels + 3] === 0) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) fail('E_ALPHA_EMPTY', 'cropped component has no visible alpha');
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function publishCropOutput({ journalPath, journal, outputPath, bytes }) {
  if (!/^[0-9a-f]{64}$/.test(journal.transactionId ?? '') || !['prepared', 'published'].includes(journal.phase)) {
    fail('E_CROP_TRANSACTION', 'crop journal has an invalid owner or publication phase');
  }
  const temporary = join(dirname(outputPath), `.${basename(outputPath)}.${journal.transactionId}.tmp.png`);
  let staged;
  try {
    staged = await readImmutableFile(temporary);
  } catch (error) {
    if (error.code !== 'ENOENT' || journal.phase !== 'prepared') throw error;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    staged = await readImmutableFile(temporary);
  }
  if (staged.digest !== journal.outputDigest) fail('E_CROP_TRANSACTION', 'staged crop differs from the expected immutable bytes');

  let targetStat;
  try { targetStat = await lstat(outputPath); }
  catch (error) {
    if (error.code !== 'ENOENT' || journal.phase !== 'prepared') throw error;
    try { await link(temporary, outputPath); }
    catch (linkError) {
      if (linkError.code === 'EEXIST') fail('E_OUTPUT_EXISTS', `refusing to overwrite existing asset: ${basename(outputPath)}`);
      throw linkError;
    }
    targetStat = await lstat(outputPath);
  }
  const stageStat = await lstat(temporary);
  if (stageStat.dev !== targetStat.dev || stageStat.ino !== targetStat.ino || await shaFile(outputPath) !== journal.outputDigest) {
    fail('E_CROP_TRANSACTION', 'published crop is not the exact inode-owned expected output');
  }
  if (journal.phase === 'prepared') {
    await syncDirectory(outputPath);
    journal.phase = 'published';
    await writeJournal(journalPath, journal);
  }
  return temporary;
}

async function resetOwnedPreparedCrop(journalPath, journal, outputPath) {
  const temporary = join(dirname(outputPath), `.${basename(outputPath)}.${journal.transactionId}.tmp.png`);
  let stageStat = null; let targetStat = null;
  try { stageStat = await lstat(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { targetStat = await lstat(outputPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (targetStat && (!stageStat || targetStat.dev !== stageStat.dev || targetStat.ino !== stageStat.ino)) {
    fail('E_OUTPUT_EXISTS', `refusing to overwrite existing asset: ${basename(outputPath)}`);
  }
  if (targetStat) await unlink(outputPath);
  if (stageStat) await unlink(temporary);
  await syncDirectory(outputPath);
  journal.phase = 'prepared';
  await writeJournal(journalPath, journal);
}

export async function cropComponentSheet({ sourcePath, outputPath, crop, padding = 0, expectedDisplayRect, injectFailure }) {
  if (resolve(sourcePath) === resolve(outputPath)) fail('E_SOURCE_IMMUTABLE', 'component output cannot overwrite its source sheet');
  if (!arguments[0]?.[CROP_OPERATION_PATHS]) {
    return withStableAbsolutePaths([{ key: 'sourcePath', path: sourcePath }, { key: 'outputPath', path: outputPath }],
      (stable) => cropComponentSheet({ sourcePath: stable.sourcePath, outputPath: stable.outputPath, crop, padding,
        expectedDisplayRect, injectFailure, [CROP_OPERATION_PATHS]: true }));
  }
  if (!nonNegativeInteger(crop?.left) || !nonNegativeInteger(crop?.top) || !positiveInteger(crop?.width)
    || !positiveInteger(crop?.height) || !nonNegativeInteger(padding) || !validRect(expectedDisplayRect, true)) {
    fail('E_CROP_OPTIONS', 'crop, padding, and expected display rectangle must be integer pixel rectangles');
  }
  const source = await readImmutableFile(sourcePath);
  const before = source.digest;
  const metadata = await sharp(source.bytes).metadata();
  if (!positiveInteger(metadata.width) || !positiveInteger(metadata.height)
    || crop.left + crop.width > metadata.width || crop.top + crop.height > metadata.height) {
    fail('E_CROP_BOUNDS', 'crop rectangle exceeds the source sheet');
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const bytes = await sharp(source.bytes).extract(crop).ensureAlpha().extend({
    top: padding, bottom: padding, left: padding, right: padding,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  }).png().toBuffer();
  const outputDigest = sha(bytes);
  const bounds = await alphaBounds(bytes);
  const effective = { width: bounds.width, height: bounds.height };
  if (effective.width < expectedDisplayRect.width || effective.height < expectedDisplayRect.height) {
    fail('E_EFFECTIVE_PIXELS', 'cropped native effective pixels do not cover the approved display rectangle');
  }
  const receipt = { sourceSheetDigest: before, outputDigest, crop: { ...crop, padding }, alphaBounds: bounds };
  const result = { ok: true, sourceDigest: before, outputDigest, sourceSheetDigest: before,
    cropReceiptDigest: computeArtifactDigest(receipt), crop: { ...crop, padding }, alphaBounds: bounds,
    expectedDisplayRect: structuredClone(expectedDisplayRect), nativeEffectivePixels: effective };
  const journalPath = join(dirname(outputPath), `.${basename(outputPath)}.crop.transaction.json`);
  const completionPath = join(dirname(outputPath), `.${basename(outputPath)}.crop.complete.json`);
  const completion = await readOptionalJson(completionPath);
  if (completion) {
    const valid = JSON.stringify(Object.keys(completion).sort()) === JSON.stringify([
      'kind', 'schemaVersion', 'transactionId', 'sourceDigest', 'outputDigest', 'receiptDigest', 'crop', 'alphaBounds', 'expectedDisplayRect', 'integrity',
    ].sort()) && completion.kind === 'component-crop-completion' && completion.schemaVersion === '1.0.0'
      && DIGEST.test(completion.transactionId ?? '')
      && verifyArtifactIntegrity(completion).valid
      && completion.sourceDigest === before && completion.outputDigest === outputDigest
      && completion.receiptDigest === result.cropReceiptDigest
      && JSON.stringify(completion.crop) === JSON.stringify(result.crop)
      && JSON.stringify(completion.alphaBounds) === JSON.stringify(result.alphaBounds)
      && JSON.stringify(completion.expectedDisplayRect) === JSON.stringify(result.expectedDisplayRect)
      && await shaFile(outputPath) === outputDigest;
    if (!valid) fail('E_CROP_TRANSACTION', 'crop completion is stale or does not bind current source and output bytes');
    const completedJournal = await readOptionalJson(journalPath);
    if (completedJournal?.kind === 'component-crop'
      && JSON.stringify(Object.keys(completedJournal).sort()) === JSON.stringify([
        'kind', 'schemaVersion', 'transactionId', 'phase', 'sourceDigest', 'outputDigest', 'receiptDigest', 'integrity',
      ].sort()) && completedJournal.schemaVersion === '1.0.0' && /^[0-9a-f]{64}$/.test(completedJournal.transactionId ?? '')
      && ['prepared', 'published'].includes(completedJournal.phase) && verifyArtifactIntegrity(completedJournal).valid
      && completedJournal.sourceDigest === before && completedJournal.outputDigest === outputDigest
      && completedJournal.receiptDigest === result.cropReceiptDigest) {
      await unlink(join(dirname(outputPath), `.${basename(outputPath)}.${completedJournal.transactionId}.tmp.png`))
        .catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await recoverOrphanJournalStage(journalPath); await cleanupOwnedJournalStages(journalPath, completedJournal);
      await unlink(journalPath); await syncDirectory(journalPath);
    }
    return { ...result, idempotent: true };
  }
  await recoverOrphanJournalStage(journalPath);
  const pending = await readOptionalJson(journalPath);
  if (pending) {
    const valid = JSON.stringify(Object.keys(pending).sort()) === JSON.stringify([
      'kind', 'schemaVersion', 'transactionId', 'phase', 'sourceDigest', 'outputDigest', 'receiptDigest', 'integrity',
    ].sort()) && pending.kind === 'component-crop' && pending.schemaVersion === '1.0.0'
      && /^[0-9a-f]{64}$/.test(pending.transactionId ?? '') && verifyArtifactIntegrity(pending).valid
      && pending.sourceDigest === before && pending.outputDigest === outputDigest && pending.receiptDigest === result.cropReceiptDigest
      && ['prepared', 'published'].includes(pending.phase);
    if (!valid) fail('E_CROP_TRANSACTION', 'crop transaction does not bind this immutable source and crop');
    const temporaryPath = join(dirname(outputPath), `.${basename(outputPath)}.${pending.transactionId}.tmp.png`);
    let stagedValid = false;
    try { stagedValid = (await readImmutableFile(temporaryPath)).digest === pending.outputDigest; }
    catch (error) { if (error.code !== 'ENOENT' && error.code !== 'E_IMMUTABLE_SOURCE') throw error; }
    if (!stagedValid) await resetOwnedPreparedCrop(journalPath, pending, outputPath);
    const temporary = await publishCropOutput({ journalPath, journal: pending, outputPath, bytes });
    await writeDurableJson(completionPath, stampJournal({ kind: 'component-crop-completion', schemaVersion: '1.0.0',
      transactionId: pending.transactionId, sourceDigest: before, outputDigest, receiptDigest: result.cropReceiptDigest,
      crop: result.crop, alphaBounds: result.alphaBounds, expectedDisplayRect: result.expectedDisplayRect,
      integrity: { digest: null, upstream: {} } }));
    if (injectFailure === 'afterCompletionWrite') fail('E_INJECTED_FAILURE', 'injected crop crash after completion publication');
    await unlink(temporary); await cleanupOwnedJournalStages(journalPath, pending); await unlink(journalPath); await syncDirectory(journalPath);
    return { ...result, recovered: true };
  }
  await assertOutputAbsent(outputPath);
  const transactionId = randomBytes(32).toString('hex');
  const temporary = join(dirname(outputPath), `.${basename(outputPath)}.${transactionId}.tmp.png`);
  const journal = { kind: 'component-crop', schemaVersion: '1.0.0', transactionId, phase: 'prepared', sourceDigest: before,
    outputDigest, receiptDigest: result.cropReceiptDigest, integrity: { digest: null, upstream: {} } };
  try {
    await createJournal(journalPath, journal, 'E_CROP_TRANSACTION', injectFailure);
    await publishCropOutput({ journalPath, journal, outputPath, bytes });
    if (injectFailure === 'afterOutputLink') fail('E_INJECTED_FAILURE', 'injected crop crash after durable output publication');
    await writeDurableJson(completionPath, stampJournal({ kind: 'component-crop-completion', schemaVersion: '1.0.0',
      transactionId, sourceDigest: before, outputDigest, receiptDigest: result.cropReceiptDigest,
      crop: result.crop, alphaBounds: result.alphaBounds, expectedDisplayRect: result.expectedDisplayRect,
      integrity: { digest: null, upstream: {} } }));
    if (injectFailure === 'afterCompletionWrite') fail('E_INJECTED_FAILURE', 'injected crop crash after completion publication');
    await unlink(temporary);
    if (injectFailure === 'afterStageUnlink') fail('E_INJECTED_FAILURE', 'injected crop crash after stage unlink');
    await cleanupOwnedJournalStages(journalPath, journal); await unlink(journalPath);
    if (injectFailure === 'afterJournalUnlink') fail('E_INJECTED_FAILURE', 'injected crop crash after journal unlink');
    if (injectFailure === 'beforeDirectoryFsync') fail('E_INJECTED_FAILURE', 'injected crop crash before final directory sync');
    await syncDirectory(journalPath);
    return result;
  } catch (error) {
    let publishedFromTemporary = false;
    try {
      const [stageStat, targetStat] = await Promise.all([lstat(temporary), lstat(outputPath)]);
      publishedFromTemporary = stageStat.dev === targetStat.dev && stageStat.ino === targetStat.ino;
    } catch (ownershipError) {
      if (ownershipError.code !== 'ENOENT') throw ownershipError;
    }
    if (!publishedFromTemporary) await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function readProofJournal(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; fail('E_PROOF_TRANSACTION', 'proof transaction journal is unreadable', { cause: error }); }
}

async function recoverOrphanJournalStage(path) {
  const prefix = `.${basename(path)}.`;
  let finalStat = null;
  try { finalStat = await lstat(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const names = (await readdir(dirname(path))).filter((name) => name.startsWith(prefix) && name.endsWith('.staged'));
  if (finalStat) {
    let cleaned = false;
    for (const name of names) {
      const staged = join(dirname(path), name);
      try {
        const stagedStat = await lstat(staged);
        if (stagedStat.dev === finalStat.dev && stagedStat.ino === finalStat.ino) { await unlink(staged); cleaned = true; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (cleaned) await syncDirectory(path);
    return;
  }
  let cleaned = false;
  for (const name of names) {
    const staged = join(dirname(path), name);
    try {
      const snapshot = await readImmutableFile(staged);
      const value = JSON.parse(snapshot.bytes.toString('utf8'));
      const token = value.owner?.token ?? value.transactionId;
      if (verifyArtifactIntegrity(value).valid && /^[0-9a-f]{32,64}$/.test(token ?? '')
        && name === `.${basename(path)}.${token}.staged`) {
        await unlink(staged); cleaned = true;
      }
    } catch { /* An unowned or partial stage was never published and cannot become authority. */ }
  }
  if (cleaned) await syncDirectory(path);
}

async function cleanupOwnedJournalStages(path, journal) {
  const token = journal.owner?.token ?? journal.transactionId;
  if (!/^[0-9a-f]{32,64}$/.test(token ?? '')) return;
  const staged = join(dirname(path), `.${basename(path)}.${token}.staged`);
  try {
    const value = JSON.parse((await readImmutableFile(staged)).bytes.toString('utf8'));
    if (verifyArtifactIntegrity(value).valid && value.integrity.digest === journal.integrity.digest) {
      await unlink(staged); await syncDirectory(path);
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'E_IMMUTABLE_SOURCE' && !(error instanceof SyntaxError)) throw error;
  }
}

async function publishProofPair(journalPath, journal, injectFailure, completionPath) {
  const outputDirectory = dirname(journalPath);
  const liveEntry = (entry) => ({ ...entry, staged: join(outputDirectory, entry.stagedBasename), target: join(outputDirectory, entry.targetBasename) });
  const rollbackOwnedTargets = async () => {
    for (const stored of Object.values(journal.proofs)) {
      const entry = liveEntry(stored);
      try {
        const [stageStat, targetStat] = await Promise.all([lstat(entry.staged), lstat(entry.target)]);
        if (stageStat.dev === targetStat.dev && stageStat.ino === targetStat.ino) await unlink(entry.target);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await syncDirectory(journalPath);
  };
  const publish = async (kind, priorPhase) => {
    const entry = liveEntry(journal.proofs[kind]);
    const intent = `${kind}-intent`;
    const published = `${kind}-published`;
    const completedPhases = kind === 'dark'
      ? new Set(['dark-published', 'light-intent', 'light-published', 'targets-durable'])
      : new Set(['light-published', 'targets-durable']);
    if (completedPhases.has(journal.phase)) {
      if (await shaFile(entry.target) !== entry.digest) fail('E_PROOF_TRANSACTION', `${kind} committed proof digest is stale`);
      return;
    }
    if (![priorPhase, intent].includes(journal.phase)) fail('E_PROOF_TRANSACTION', `proof journal phase cannot publish ${kind}`);
    if (journal.phase === priorPhase) {
      journal.phase = intent; await writeJournal(journalPath, journal);
      if (injectFailure === `after${kind[0].toUpperCase()}${kind.slice(1)}Intent`) fail('E_INJECTED_FAILURE', `injected failure after ${kind} publication intent`);
    }
    try {
      const [stageStat, targetStat] = await Promise.all([lstat(entry.staged), lstat(entry.target)]);
      if (stageStat.dev !== targetStat.dev || stageStat.ino !== targetStat.ino) fail('E_PROOF_TRANSACTION', `${kind} target exists outside this transaction`);
    }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try { await link(entry.staged, entry.target); }
      catch (publishError) {
        if (publishError.code !== 'EEXIST') throw publishError;
        const [stageStat, targetStat] = await Promise.all([lstat(entry.staged), lstat(entry.target)]);
        if (stageStat.dev !== targetStat.dev || stageStat.ino !== targetStat.ino) throw publishError;
      }
    }
    if (await shaFile(entry.target) !== entry.digest) fail('E_PROOF_TRANSACTION', `${kind} proof bytes do not match the journal`);
    await syncDirectory(entry.target);
    journal.phase = published;
    await writeJournal(journalPath, journal);
    if (injectFailure === `after${kind[0].toUpperCase()}${kind.slice(1)}Published`) fail('E_INJECTED_FAILURE', `injected failure after ${kind} publication`);
  };
  try {
    if (journal.phase !== 'targets-durable') {
      await publish('dark', 'staged');
      await publish('light', 'dark-published');
      for (const stored of Object.values(journal.proofs)) {
        const entry = liveEntry(stored);
        if (await shaFile(entry.target) !== entry.digest) fail('E_PROOF_TRANSACTION', 'proof target changed before commit');
      }
      await syncDirectory(liveEntry(journal.proofs.dark).target);
      journal.phase = 'targets-durable';
      await writeJournal(journalPath, journal);
    } else {
      for (const [kind, stored] of Object.entries(journal.proofs)) {
        const entry = liveEntry(stored);
        if (await shaFile(entry.target) !== entry.digest) fail('E_PROOF_TRANSACTION', `${kind} durable proof digest is stale`);
      }
    }
    if (injectFailure === 'beforeStageCleanup') fail('E_INJECTED_FAILURE', 'injected failure after durable proof-pair commit');
    await Promise.all(Object.values(journal.proofs).map((entry) => unlink(liveEntry(entry).staged).catch((error) => { if (error.code !== 'ENOENT') throw error; })));
    await syncDirectory(journalPath);
    const completion = { kind: 'asset-proof-completion', schemaVersion: '1.0.0', componentDigest: journal.componentDigest,
      directoryIdentity: journal.directoryIdentity, canvas: journal.canvas, displayRect: journal.displayRect,
      proofs: Object.fromEntries(Object.entries(journal.proofs).map(([kind, value]) => [kind, value.receipt])),
      integrity: { digest: null, upstream: {} } };
    await writeJsonAtomic(completionPath, stampJournal(completion));
    await syncDirectory(completionPath);
    await recoverOrphanJournalStage(journalPath);
    await cleanupOwnedJournalStages(journalPath, journal);
    await unlink(journalPath);
    if (injectFailure === 'afterJournalUnlink') fail('E_INJECTED_FAILURE', 'injected failure after proof journal unlink');
    await syncDirectory(journalPath);
    return { ok: true, componentDigest: journal.componentDigest, canvas: journal.canvas, displayRect: journal.displayRect,
      proofs: Object.fromEntries(Object.entries(journal.proofs).map(([kind, value]) => [kind, { ...value.receipt, path: join(outputDirectory, value.receipt.path) }])) };
  } catch (error) {
    if (error.code === 'E_INJECTED_FAILURE' && ['afterLightIntent', 'afterLightPublished'].includes(injectFailure)) throw error;
    if (journal.phase !== 'targets-durable') {
      await rollbackOwnedTargets();
      journal.phase = 'staged'; await writeJournal(journalPath, journal);
    }
    throw error;
  }
}

function validProofJournal(journal, requestedBasename, directoryIdentity, component, canvas, displayRect) {
  const phases = new Set(['preparing', 'staged', 'dark-intent', 'dark-published', 'light-intent', 'light-published', 'targets-durable']);
  const topKeys = ['schemaVersion', 'phase', 'owner', 'componentDigest', 'directoryIdentity', 'canvas', 'displayRect', 'proofs', 'integrity'];
  if (JSON.stringify(Object.keys(journal ?? {}).sort()) !== JSON.stringify(topKeys.sort()) || !phases.has(journal.phase)
    || !verifyArtifactIntegrity(journal).valid || journal.componentDigest !== component.digest
    || JSON.stringify(Object.keys(journal.owner ?? {}).sort()) !== JSON.stringify(['pid', 'processStartId', 'token'].sort())
    || !Number.isInteger(journal.owner?.pid) || journal.owner.pid <= 0
    || typeof journal.owner?.processStartId !== 'string' || journal.owner.processStartId.length === 0
    || !DIGEST.test(journal.owner?.token ?? '')
    || journal.directoryIdentity !== directoryIdentity
    || JSON.stringify(journal.canvas) !== JSON.stringify(canvas) || JSON.stringify(journal.displayRect) !== JSON.stringify(displayRect)) return false;
  return ['dark', 'light'].every((kind) => {
    const entry = journal.proofs?.[kind];
    const entryKeys = ['stagedBasename', 'targetBasename', 'digest', 'receipt'];
    const receiptKeys = ['path', 'digest', 'background', 'componentDigest', 'canvas', 'displayRect', 'receiptDigest'];
    return entry && JSON.stringify(Object.keys(entry).sort()) === JSON.stringify(entryKeys.sort())
      && entry.targetBasename === `${requestedBasename}-${kind}.png`
      && entry.stagedBasename.startsWith(`.${requestedBasename}-${kind}.`)
      && !entry.stagedBasename.includes('/') && !entry.targetBasename.includes('/')
      && (journal.phase === 'preparing' ? entry.digest === null && entry.receipt === null
        : DIGEST.test(entry.digest ?? '') && JSON.stringify(Object.keys(entry.receipt ?? {}).sort()) === JSON.stringify(receiptKeys.sort())
          && entry.receipt.path === entry.targetBasename && entry.receipt.digest === entry.digest && DIGEST.test(entry.receipt.receiptDigest ?? ''));
  });
}

async function expectedProof(componentBytes, kind, canvas, displayRect) {
  const background = kind === 'dark' ? '#050505' : '#F5F2EA';
  const resized = await sharp(componentBytes).resize(displayRect.width, displayRect.height,
    { fit: 'fill', withoutEnlargement: true }).png().toBuffer();
  const bytes = await sharp({ create: { width: canvas.width, height: canvas.height, channels: 4, background } })
    .composite([{ input: resized, left: displayRect.x, top: displayRect.y }]).png().toBuffer();
  return { background, bytes, digest: sha(bytes) };
}

async function validateProofContent(outputDirectory, journal, component, { completion = false } = {}) {
  if (JSON.stringify(Object.keys(journal.proofs ?? {}).sort()) !== JSON.stringify(['dark', 'light'])) return false;
  for (const kind of ['dark', 'light']) {
    const expected = await expectedProof(component.bytes, kind, journal.canvas, journal.displayRect);
    const stored = journal.proofs?.[kind];
    const receipt = completion ? stored : stored?.receipt;
    if (!receipt || JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify([
      'path', 'digest', 'background', 'componentDigest', 'canvas', 'displayRect', 'receiptDigest',
    ].sort()) || receipt.path !== `${basename(receipt.path, '.png').replace(/-(?:dark|light)$/, '')}-${kind}.png`
      || receipt.digest !== expected.digest || receipt.background !== expected.background
      || receipt.componentDigest !== component.digest
      || JSON.stringify(receipt.canvas) !== JSON.stringify(journal.canvas)
      || JSON.stringify(receipt.displayRect) !== JSON.stringify(journal.displayRect)) return false;
    const unsigned = { ...receipt }; delete unsigned.receiptDigest;
    if (receipt.receiptDigest !== computeArtifactDigest(unsigned)) return false;
    const proofBasename = completion || journal.phase === 'targets-durable' ? receipt.path : stored.stagedBasename;
    const path = join(outputDirectory, proofBasename);
    try {
      const snapshot = await readImmutableFile(path);
      if (snapshot.digest !== expected.digest || !snapshot.bytes.equals(expected.bytes)) return false;
    } catch { return false; }
  }
  return true;
}

async function unlinkOwnedProofJournal(journalPath, ownerToken) {
  const current = await readProofJournal(journalPath).catch(() => null);
  if (current?.owner?.token !== ownerToken || !verifyArtifactIntegrity(current).valid) return false;
  const reread = await readProofJournal(journalPath).catch(() => null);
  if (reread?.integrity?.digest !== current.integrity.digest || reread?.owner?.token !== ownerToken) return false;
  await unlink(journalPath);
  await syncDirectory(journalPath);
  return true;
}

export async function buildAssetProofs({ componentPath, outputDirectory, directoryIdentity = 'proof-output', basename: requestedBasename, displayRect, canvas, injectFailure, afterJournalAcquire }) {
  if (!arguments[0]?.[PROOF_OPERATION_PATHS]) {
    return withStableAbsolutePaths([{ key: 'componentPath', path: componentPath }, { key: 'outputDirectory', path: outputDirectory, directory: true }],
      (stable) => buildAssetProofs({ componentPath: stable.componentPath, outputDirectory: stable.outputDirectory, directoryIdentity,
        basename: requestedBasename, displayRect, canvas, injectFailure, afterJournalAcquire, [PROOF_OPERATION_PATHS]: true }));
  }
  if (!/^[A-Za-z0-9-]+$/.test(requestedBasename ?? '') || !validRect(displayRect)
    || !positiveInteger(canvas?.width) || !positiveInteger(canvas?.height)
    || displayRect.x + displayRect.width > canvas.width || displayRect.y + displayRect.height > canvas.height) {
    fail('E_PROOF_OPTIONS', 'proof basename, display rectangle, and canvas are invalid');
  }
  await mkdir(outputDirectory, { recursive: true });
  const component = await readImmutableFile(componentPath);
  const journalPath = join(outputDirectory, `.${requestedBasename}-proofs.transaction.json`);
  const completionPath = join(outputDirectory, `.${requestedBasename}-proofs.complete.json`);
  const completion = await readOptionalJson(completionPath);
  if (completion) {
    const exactKeys = ['kind', 'schemaVersion', 'componentDigest', 'directoryIdentity', 'canvas', 'displayRect', 'proofs', 'integrity'];
    const valid = JSON.stringify(Object.keys(completion).sort()) === JSON.stringify(exactKeys.sort())
      && completion.kind === 'asset-proof-completion' && completion.schemaVersion === '1.0.0'
      && completion.directoryIdentity === directoryIdentity
      && completion.componentDigest === component.digest && JSON.stringify(completion.canvas) === JSON.stringify(canvas)
      && JSON.stringify(completion.displayRect) === JSON.stringify(displayRect) && verifyArtifactIntegrity(completion).valid
      && ['dark', 'light'].every((kind) => completion.proofs?.[kind]?.path === `${requestedBasename}-${kind}.png`)
      && await validateProofContent(outputDirectory, completion, component, { completion: true });
    if (!valid) fail('E_PROOF_TRANSACTION', 'proof completion receipt is stale or does not bind this request');
    const completedJournal = await readProofJournal(journalPath);
    if (completedJournal && validProofJournal(completedJournal, requestedBasename, directoryIdentity, component, canvas, displayRect)
      && completedJournal.phase === 'targets-durable'
      && await validateProofContent(outputDirectory, completedJournal, component)) {
      await recoverOrphanJournalStage(journalPath);
      await cleanupOwnedJournalStages(journalPath, completedJournal);
      await Promise.all(Object.values(completedJournal.proofs).map(({ stagedBasename }) =>
        unlink(join(outputDirectory, stagedBasename)).catch((error) => { if (error.code !== 'ENOENT') throw error; })));
      await unlinkOwnedProofJournal(journalPath, completedJournal.owner.token);
    }
    return { ok: true, idempotent: true, componentDigest: completion.componentDigest, canvas: completion.canvas,
      displayRect: completion.displayRect, proofs: Object.fromEntries(Object.entries(completion.proofs)
        .map(([kind, proof]) => [kind, { ...proof, path: join(outputDirectory, proof.path) }])) };
  }
  await recoverOrphanJournalStage(journalPath);
  let pending = await readProofJournal(journalPath);
  if (pending) {
    if (!validProofJournal(pending, requestedBasename, directoryIdentity, component, canvas, displayRect)) {
      fail('E_PROOF_TRANSACTION', 'proof transaction journal does not bind this component, placement, and output pair');
    }
    if (pending.phase === 'preparing') {
      const liveIdentity = await processStartIdentity(pending.owner.pid);
      if (liveIdentity !== null && liveIdentity === pending.owner.processStartId) {
        fail('E_PROOF_TRANSACTION_BUSY', 'another proof transaction is already active');
      }
      await Promise.all(Object.values(pending.proofs).map(({ stagedBasename }) => rm(join(outputDirectory, stagedBasename), { force: true })));
      if (!await unlinkOwnedProofJournal(journalPath, pending.owner.token)) fail('E_PROOF_TRANSACTION_BUSY', 'proof journal ownership changed during recovery');
      pending = null;
    } else {
      if (!await validateProofContent(outputDirectory, pending, component)) {
        fail('E_PROOF_TRANSACTION', 'proof transaction bytes or receipts do not match the immutable component');
      }
      return publishProofPair(journalPath, pending, injectFailure, completionPath);
    }
  }
  const metadata = await sharp(component.bytes).metadata();
  if (!metadata.hasAlpha) fail('E_ALPHA_REQUIRED', 'component proofs require a transparent source component');
  const visible = await alphaBounds(component.bytes);
  if (visible.width < displayRect.width || visible.height < displayRect.height) fail('E_EFFECTIVE_PIXELS', 'proof display rectangle cannot upscale native visible-alpha pixels');
  const targets = Object.fromEntries(['dark', 'light'].map((kind) => [kind, join(outputDirectory, `${requestedBasename}-${kind}.png`)]));
  await Promise.all(Object.values(targets).map(assertOutputAbsent));
  const owner = { pid: process.pid, processStartId: await processStartIdentity(process.pid), token: randomBytes(32).toString('hex') };
  if (owner.processStartId === null) fail('E_PROOF_TRANSACTION', 'proof transaction process identity is unavailable');
  if (injectFailure === 'afterInitialJournalLink') owner.processStartId = `injected-crash-${owner.token}`;
  const stagedBasenames = Object.fromEntries(['dark', 'light'].map((kind) => [kind, `.${requestedBasename}-${kind}.${owner.token}.tmp.png`]));
  const staged = Object.fromEntries(Object.entries(stagedBasenames).map(([kind, name]) => [kind, join(outputDirectory, name)]));
  const proofs = Object.fromEntries(['dark', 'light'].map((kind) => [kind, { stagedBasename: stagedBasenames[kind],
    targetBasename: `${requestedBasename}-${kind}.png`, digest: null, receipt: null }]));
  const journal = { schemaVersion: '1.0.0', phase: 'preparing', owner, componentDigest: component.digest, directoryIdentity,
    canvas: structuredClone(canvas), displayRect: structuredClone(displayRect), proofs, integrity: { digest: null, upstream: {} } };
  try {
    await createJournal(journalPath, journal, 'E_PROOF_TRANSACTION_BUSY', injectFailure);
    if (afterJournalAcquire) await afterJournalAcquire();
    for (const kind of ['dark', 'light']) {
      const expected = await expectedProof(component.bytes, kind, canvas, displayRect);
      const handle = await open(staged[kind], 'wx', 0o600);
      try { await handle.writeFile(expected.bytes); await handle.sync(); } finally { await handle.close(); }
      const snapshot = await readImmutableFile(staged[kind]);
      const proofMetadata = await sharp(snapshot.bytes).metadata();
      if (proofMetadata.width !== canvas.width || proofMetadata.height !== canvas.height) fail('E_PROOF_CONTENT', `${kind} proof canvas is invalid`);
      proofs[kind].digest = snapshot.digest;
      proofs[kind].receipt = { path: proofs[kind].targetBasename, digest: snapshot.digest, background: expected.background, componentDigest: component.digest, canvas: structuredClone(canvas), displayRect: structuredClone(displayRect) };
      proofs[kind].receipt.receiptDigest = computeArtifactDigest(proofs[kind].receipt);
    }
    journal.phase = 'staged'; await writeJournal(journalPath, journal);
    return await publishProofPair(journalPath, journal, injectFailure, completionPath);
  } catch (error) {
    if (error.code === 'E_INJECTED_FAILURE' && injectFailure === 'afterInitialJournalLink') throw error;
    const current = await readProofJournal(journalPath).catch(() => null);
    if (current?.phase === 'preparing' && current.owner?.token === owner.token && verifyArtifactIntegrity(current).valid) {
      await Promise.all(Object.values(staged).map((path) => rm(path, { force: true })));
      await unlinkOwnedProofJournal(journalPath, owner.token);
    } else if (!current) await Promise.all(Object.values(staged).map((path) => rm(path, { force: true })));
    throw error;
  }
}

export async function inspectStyleAnchor({ path, expectedDisplayRect }) {
  if (!validRect(expectedDisplayRect, true)) fail('E_STYLE_ANCHOR_OPTIONS', 'Style Anchor display rectangle is invalid');
  const snapshot = await readImmutableFile(path);
  const metadata = await sharp(snapshot.bytes).metadata();
  if (!positiveInteger(metadata.width) || !positiveInteger(metadata.height)) fail('E_STYLE_ANCHOR_READ', 'Style Anchor raster metadata is unavailable');
  if (metadata.width < expectedDisplayRect.width || metadata.height < expectedDisplayRect.height
    || expectedDisplayRect.width < 3840 || expectedDisplayRect.height < 2160) {
    fail('E_STYLE_ANCHOR_RESOLUTION', 'Style Anchor must provide native full-resolution pixels for its declared 4K display size');
  }
  return {
    ok: true, sourceDigest: snapshot.digest, width: metadata.width, height: metadata.height,
    nativeEffectivePixels: { width: metadata.width, height: metadata.height },
    expectedDisplayRect: structuredClone(expectedDisplayRect),
  };
}

export async function validateImageAssetFiles({ projectRoot, manifest, phase = 'batch' }) {
  const errors = [];
  const semanticEvidence = new Set();
  for (const [index, asset] of (manifest?.assets ?? []).entries()) {
    const requiredRoot = asset.sourceKind === 'component-crop' || asset.sourceKind === 'code-rendered'
      ? 'assets/images/components'
      : asset.sourceKind === 'hero' ? 'assets/images/source/heroes' : 'assets/images/source';
    try { resolveProjectAssetPath(projectRoot, asset.source ?? '', requiredRoot); }
    catch { errors.push(diagnostic('E_ASSET_PATH', `/assets/${index}/source`, 'asset source escapes the project root')); continue; }
    let sourceSnapshot;
    try { sourceSnapshot = await readImmutableProjectAsset(projectRoot, asset.source, requiredRoot); }
    catch { errors.push(diagnostic('E_ASSET_FILE_MISSING', `/assets/${index}/source`, 'asset source is missing or unreadable')); continue; }
    if (sourceSnapshot.digest !== asset.provenance?.sourceDigest) {
      errors.push(diagnostic('E_PROVENANCE_DIGEST', `/assets/${index}/provenance/sourceDigest`, 'asset provenance digest does not match source bytes'));
    }
    if (asset.sourceKind === 'style-anchor') {
      try {
        const metadata = await sharp(sourceSnapshot.bytes).metadata();
        if (metadata.width < asset.expectedDisplayRect.width || metadata.height < asset.expectedDisplayRect.height
          || metadata.width !== asset.nativeEffectivePixels.width || metadata.height !== asset.nativeEffectivePixels.height) {
          fail('E_STYLE_ANCHOR_RESOLUTION', 'Style Anchor dimensions do not match its native effective pixel claim');
        }
      } catch (error) { errors.push(diagnostic(error.code ?? 'E_STYLE_ANCHOR_READ', `/assets/${index}`, error.message)); }
      try {
        const acceptance = asset.visualAcceptance;
        const evidenceSnapshot = await readImmutableProjectAsset(projectRoot, acceptance?.evidencePath, 'review/assets');
        const evidence = JSON.parse(evidenceSnapshot.bytes.toString('utf8'));
        const exactKeys = ['$schema', 'schemaVersion', 'revision', 'decision', 'reviewer', 'visualInspectionAvailable',
          'reviewedAt', 'anchorDigest', 'designSystemDigest', 'lookProfileDigest', 'assetPlanDigest', 'conclusions', 'integrity'];
        if (evidenceSnapshot.digest !== acceptance?.evidenceDigest
          || JSON.stringify(Object.keys(evidence).sort()) !== JSON.stringify(exactKeys.sort())
          || evidence.$schema !== 'https://hyperframes.local/contracts/style-anchor-visual-acceptance.json'
          || evidence.schemaVersion !== '1.0.0' || !Number.isInteger(evidence.revision) || evidence.revision < 1
          || evidence.decision !== acceptance.decision || evidence.reviewer !== 'Agent'
          || evidence.visualInspectionAvailable !== true || evidence.reviewedAt !== acceptance.reviewedAt
          || evidence.anchorDigest !== sourceSnapshot.digest
          || evidence.designSystemDigest !== manifest.designSystemDigest
          || evidence.lookProfileDigest !== manifest.lookProfileDigest || evidence.assetPlanDigest !== manifest.assetPlanDigest
          || JSON.stringify(evidence.conclusions) !== JSON.stringify(acceptance.conclusions)
          || !verifyArtifactIntegrity(evidence).valid) throw new Error('visual acceptance evidence is stale or incomplete');
      } catch (error) {
        errors.push(diagnostic('E_STYLE_ANCHOR_VISUAL_EVIDENCE', `/assets/${index}/visualAcceptance`,
          `Style Anchor visual acceptance requires current digest-bound Agent evidence: ${error.message}`));
      }
    }
    if (asset.sourceKind === 'component-crop') {
      try {
        const observed = await alphaBounds(sourceSnapshot.bytes);
        if (JSON.stringify(observed) !== JSON.stringify(asset.alphaBounds)
          || observed.width !== asset.nativeEffectivePixels?.width || observed.height !== asset.nativeEffectivePixels?.height) {
          errors.push(diagnostic('E_ALPHA_BOUNDS', `/assets/${index}/alphaBounds`, 'manifest alpha bounds and native effective pixels must match visible source pixels'));
        }
        const sheet = await readImmutableProjectAsset(projectRoot, asset.crop.sourceSheet, 'assets/images/source');
        const expectedOutput = await sharp(sheet.bytes).extract({ left: asset.crop.left, top: asset.crop.top,
          width: asset.crop.width, height: asset.crop.height }).ensureAlpha().extend({ top: asset.crop.padding,
          bottom: asset.crop.padding, left: asset.crop.padding, right: asset.crop.padding,
          background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
        const receipt = { sourceSheetDigest: sheet.digest, outputDigest: sourceSnapshot.digest,
          crop: { left: asset.crop.left, top: asset.crop.top, width: asset.crop.width, height: asset.crop.height, padding: asset.crop.padding }, alphaBounds: observed };
        if (sheet.digest !== asset.crop.sourceSheetDigest || sha(expectedOutput) !== sourceSnapshot.digest
          || computeArtifactDigest(receipt) !== asset.crop.receiptDigest) {
          errors.push(diagnostic('E_CROP_RECEIPT', `/assets/${index}/crop`, 'crop receipt must bind current source-sheet bytes, crop geometry, and output bytes'));
        }
      } catch (error) { errors.push(diagnostic(error.code ?? 'E_ALPHA_BOUNDS', `/assets/${index}/alphaBounds`, error.message)); }
      try {
        const outputBase = basename(asset.source);
        const outputDirectory = dirname(asset.source).replaceAll('\\', '/');
        const journalPortable = `${outputDirectory}/.${outputBase}.crop.transaction.json`;
        const completionPortable = `${outputDirectory}/.${outputBase}.crop.complete.json`;
        try {
          await readImmutableProjectAsset(projectRoot, journalPortable, 'assets/images/components');
          throw new Error('crop transaction remains pending');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const completionSnapshot = await readImmutableProjectAsset(projectRoot, completionPortable, 'assets/images/components');
        const completion = JSON.parse(completionSnapshot.bytes.toString('utf8'));
        const exactKeys = ['kind', 'schemaVersion', 'transactionId', 'sourceDigest', 'outputDigest', 'receiptDigest',
          'crop', 'alphaBounds', 'expectedDisplayRect', 'integrity'];
        if (JSON.stringify(Object.keys(completion).sort()) !== JSON.stringify(exactKeys.sort())
          || completion.kind !== 'component-crop-completion' || completion.schemaVersion !== '1.0.0'
          || !DIGEST.test(completion.transactionId ?? '') || !verifyArtifactIntegrity(completion).valid
          || completion.sourceDigest !== asset.crop.sourceSheetDigest
          || completion.outputDigest !== sourceSnapshot.digest || completion.receiptDigest !== asset.crop.receiptDigest
          || JSON.stringify(completion.crop) !== JSON.stringify({ left: asset.crop.left, top: asset.crop.top,
            width: asset.crop.width, height: asset.crop.height, padding: asset.crop.padding })
          || JSON.stringify(completion.alphaBounds) !== JSON.stringify(asset.alphaBounds)
          || JSON.stringify(completion.expectedDisplayRect) !== JSON.stringify(asset.expectedDisplayRect)) {
          throw new Error('crop completion does not bind the manifest crop');
        }
      } catch (error) {
        errors.push(diagnostic('E_CROP_COMPLETION', `/assets/${index}/crop`, `component crop requires one exact durable completion: ${error.message}`));
      }
    }
    if (asset.sourceKind !== 'component-crop') {
      try {
        const metadata = await sharp(sourceSnapshot.bytes).metadata();
        const observed = metadata.hasAlpha ? await alphaBounds(sourceSnapshot.bytes) : { left: 0, top: 0, width: metadata.width, height: metadata.height };
        if (JSON.stringify(observed) !== JSON.stringify(asset.alphaBounds)
          || observed.width !== asset.nativeEffectivePixels?.width || observed.height !== asset.nativeEffectivePixels?.height) {
          errors.push(diagnostic('E_NATIVE_PIXEL_PROVENANCE', `/assets/${index}/nativeEffectivePixels`, 'native effective pixels and alpha bounds must derive from decoded source bytes'));
        }
      } catch { errors.push(diagnostic('E_ASSET_FILE_MISSING', `/assets/${index}/source`, 'raster source is unreadable')); }
    }
    if (phase !== 'anchor' && asset.sourceKind === 'component-crop') {
      const darkPath = asset.proofs?.dark?.path ?? '';
      const lightPath = asset.proofs?.light?.path ?? '';
      const proofDirectory = dirname(darkPath).replaceAll('\\', '/');
      const proofBase = basename(darkPath).replace(/-dark\.png$/, '');
      const completionPortable = `${proofDirectory}/.${proofBase}-proofs.complete.json`;
      const journalPortable = `${proofDirectory}/.${proofBase}-proofs.transaction.json`;
      try {
        if (dirname(lightPath).replaceAll('\\', '/') !== proofDirectory || basename(lightPath) !== `${proofBase}-light.png`) throw new Error('proof pair paths diverge');
        try {
          await readImmutableProjectAsset(projectRoot, journalPortable, 'assets/images/proofs');
          throw new Error('proof transaction remains pending');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const completionSnapshot = await readImmutableProjectAsset(projectRoot, completionPortable, 'assets/images/proofs');
        const completion = JSON.parse(completionSnapshot.bytes.toString('utf8'));
        const manifestReceipt = (kind) => ({ ...completion.proofs?.[kind], path: asset.proofs[kind].path, receiptDigest: undefined });
        if (!verifyArtifactIntegrity(completion).valid || completion.kind !== 'asset-proof-completion'
          || completion.componentDigest !== sourceSnapshot.digest
          || completion.proofs?.dark?.digest !== asset.proofs.dark.digest
          || completion.proofs?.light?.digest !== asset.proofs.light.digest
          || computeArtifactDigest(manifestReceipt('dark')) !== asset.proofs.dark.receiptDigest
          || computeArtifactDigest(manifestReceipt('light')) !== asset.proofs.light.receiptDigest) throw new Error('proof completion does not bind the manifest pair');
      } catch (error) {
        errors.push(diagnostic('E_PROOF_COMPLETION', `/assets/${index}/proofs`, `dark/light proofs require one durable completed pair: ${error.message}`));
      }
      for (const kind of ['dark', 'light']) {
        const proof = asset.proofs?.[kind];
        if (!proof?.path) continue;
        try { resolveProjectAssetPath(projectRoot, proof.path, 'assets/images/proofs'); }
        catch { errors.push(diagnostic('E_PROOF_PATH', `/assets/${index}/proofs/${kind}`, `${kind} proof path escapes the project`)); continue; }
        try {
          const proofSnapshot = await readImmutableProjectAsset(projectRoot, proof.path, 'assets/images/proofs');
          const proofMetadata = await sharp(proofSnapshot.bytes).metadata();
          const expectedBackground = kind === 'dark' ? '#050505' : '#F5F2EA';
          const receipt = { path: proof.path, digest: proof.digest, background: proof.background,
            componentDigest: proof.componentDigest, canvas: proof.canvas, displayRect: proof.displayRect };
          const expectedComponent = await sharp(sourceSnapshot.bytes).resize(proof.displayRect?.width, proof.displayRect?.height,
            { fit: 'fill', withoutEnlargement: true }).png().toBuffer();
          const expectedProof = await sharp({ create: { width: proof.canvas?.width, height: proof.canvas?.height,
            channels: 4, background: expectedBackground } }).composite([{ input: expectedComponent,
            left: proof.displayRect?.x, top: proof.displayRect?.y }]).png().toBuffer();
          if (proofSnapshot.digest !== proof.digest || proof.componentDigest !== sourceSnapshot.digest
            || proof.background !== expectedBackground || proofMetadata.width !== proof.canvas?.width
            || proofMetadata.height !== proof.canvas?.height || sha(expectedProof) !== proofSnapshot.digest
            || computeArtifactDigest(receipt) !== proof.receiptDigest) {
            errors.push(diagnostic('E_PROOF_CONTENT', `/assets/${index}/proofs/${kind}`, `${kind} proof bytes and metadata must bind the component, background, canvas, and placement`));
          }
        } catch { errors.push(diagnostic('E_PROOF_MISSING', `/assets/${index}/proofs/${kind}`, `${kind} proof is missing or unreadable`)); }
      }
    }
    for (const [proofIndex, proof] of (asset.combinationTests ?? []).entries()) {
      try { resolveProjectAssetPath(projectRoot, proof.path, 'assets/images/proofs'); }
      catch { errors.push(diagnostic('E_PROOF_PATH', `/assets/${index}/combinationTests/${proofIndex}`, 'combination proof path escapes the project')); continue; }
      try {
        const proofSnapshot = await readImmutableProjectAsset(projectRoot, proof.path, 'assets/images/proofs');
        const metadata = await sharp(proofSnapshot.bytes).metadata();
        if (proofSnapshot.digest !== proof.digest || !positiveInteger(metadata.width) || !positiveInteger(metadata.height)) {
          errors.push(diagnostic('E_PROOF_DIGEST', `/assets/${index}/combinationTests/${proofIndex}`, 'combination proof must bind current decodable raster bytes'));
        }
      } catch { errors.push(diagnostic('E_PROOF_MISSING', `/assets/${index}/combinationTests/${proofIndex}`, 'combination proof is missing or unreadable')); }
      try {
        resolveProjectAssetPath(projectRoot, proof.semanticAcceptance?.evidencePath, 'review/assets');
        const evidenceSnapshot = await readImmutableProjectAsset(projectRoot, proof.semanticAcceptance.evidencePath, 'review/assets');
        const evidence = JSON.parse(evidenceSnapshot.bytes.toString('utf8'));
        const exactKeys = ['$schema', 'schemaVersion', 'revision', 'decision', 'reviewer', 'reviewedAt', 'proofDigest',
          'componentIds', 'footageEvidenceId', 'meaningIds', 'semanticIntent', 'integrity'];
        const evidenceKey = `${proof.semanticAcceptance.evidencePath}\u0000${proof.semanticAcceptance.evidenceDigest}`;
        const exact = JSON.stringify(Object.keys(evidence).sort()) === JSON.stringify(exactKeys.sort())
          && evidence.$schema === 'https://hyperframes.local/contracts/asset-semantic-acceptance.json'
          && evidence.schemaVersion === '1.0.0' && Number.isInteger(evidence.revision) && evidence.revision > 0
          && evidence.decision === 'accepted' && evidence.reviewer === 'Agent'
          && evidence.reviewedAt === proof.semanticAcceptance.reviewedAt && evidence.proofDigest === proof.digest
          && evidence.footageEvidenceId === proof.footageEvidenceId && evidence.semanticIntent === proof.semanticIntent
          && JSON.stringify(evidence.componentIds) === JSON.stringify(proof.componentIds)
          && JSON.stringify(evidence.meaningIds) === JSON.stringify(proof.meaningIds)
          && verifyArtifactIntegrity(evidence).valid && !semanticEvidence.has(evidenceKey);
        if (evidenceSnapshot.digest !== proof.semanticAcceptance.evidenceDigest || !exact) {
          errors.push(diagnostic('E_SEMANTIC_ACCEPTANCE_EVIDENCE', `/assets/${index}/combinationTests/${proofIndex}/semanticAcceptance`, 'Agent semantic acceptance evidence digest does not match current review bytes'));
        } else semanticEvidence.add(evidenceKey);
      } catch { errors.push(diagnostic('E_SEMANTIC_ACCEPTANCE_EVIDENCE', `/assets/${index}/combinationTests/${proofIndex}/semanticAcceptance`, 'Agent semantic acceptance evidence is missing or unreadable')); }
    }
  }
  return { valid: errors.length === 0, errors };
}

async function readJson(path, code) {
  try { return JSON.parse((await readImmutableFile(path)).bytes.toString('utf8')); }
  catch (error) { fail(code, `${basename(path)} is missing or unreadable`, { cause: error }); }
}

async function readOptionalJson(path) {
  try { return JSON.parse((await readImmutableFile(path)).bytes.toString('utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function currentDocumentaryEvidence(projectRoot) {
  let overlaysSnapshot;
  try {
    overlaysSnapshot = await readImmutableProjectAsset(projectRoot, 'direction/DATA_OVERLAYS.json', 'direction');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  let overlays;
  try { overlays = JSON.parse(overlaysSnapshot.bytes.toString('utf8')); } catch { return {}; }
  const overlayContract = validateDocument(await loadSchema('data-overlays'), overlays);
  if (!overlayContract.valid || !verifyArtifactIntegrity(overlays).valid || overlays.status !== 'available') return {};
  let activity; let syncMap;
  try {
    const [activitySnapshot, syncSnapshot] = await Promise.all([
      readImmutableProjectAsset(projectRoot, 'analysis/ACTIVITY.json', 'analysis'),
      readImmutableProjectAsset(projectRoot, 'analysis/SYNC_MAP.json', 'analysis'),
    ]);
    activity = JSON.parse(activitySnapshot.bytes.toString('utf8'));
    syncMap = JSON.parse(syncSnapshot.bytes.toString('utf8'));
  } catch { return {}; }
  const [activityContract, syncContract] = await Promise.all([
    loadSchema('activity').then((schema) => validateDocument(schema, activity)),
    loadSchema('sync-map').then((schema) => validateDocument(schema, syncMap)),
  ]);
  if (!activityContract.valid || !syncContract.valid || !verifyArtifactIntegrity(activity).valid || !verifyArtifactIntegrity(syncMap).valid
    || overlays.activityDigest !== activity.integrity.digest
    || overlays.syncMapDigest !== syncMap.integrity.digest) return {};
  let sportProfile;
  try { sportProfile = loadProfile('sport', activity.sportProfiles?.[0]); } catch { return {}; }
  const authority = validateDataOverlayAuthority(activity, syncMap, overlays, {
    primaryMetricIds: sportProfile.policies.dataPolicy.primaryMetrics,
  });
  if (!authority.valid) return {};
  const bindings = Object.fromEntries((overlays.overlays ?? []).map(({ overlayId }) => [overlayId,
    { kind: 'data-overlay', digest: overlays.integrity.digest }]));
  if (overlays.publicRoute?.status === 'available' && overlays.publicRoute.trimmedRouteId) {
    bindings[overlays.publicRoute.trimmedRouteId] = { kind: 'trimmed-route', digest: overlays.integrity.digest };
  }
  return bindings;
}

async function currentActivityStatus(projectRoot) {
  try {
    const snapshot = await readImmutableProjectAsset(projectRoot, 'analysis/ACTIVITY.json', 'analysis');
    const activity = JSON.parse(snapshot.bytes.toString('utf8'));
    const contract = validateDocument(await loadSchema('activity'), activity);
    return contract.valid && verifyArtifactIntegrity(activity).valid && activity.status === 'available' ? 'available' : 'unavailable';
  } catch { return 'unavailable'; }
}

function acceptedManifestForStage(manifest, previousManifest, previousState, stage, timestamp) {
  const next = structuredClone(manifest);
  next.acceptance ??= { anchorDigest: null, representativeDigest: null, anchorIdentity: null, representativeIdentity: null, batches: [] };
  const authority = previousState?.assetAcceptance;
  if (authority) {
    const rollbackAnchor = previousState.state === 'STYLE_ANCHOR' && previousState.transitions.at(-1)?.kind === 'invalidation';
    if (!previousManifest || previousManifest.revision !== authority.manifestRevision
      || previousManifest.integrity?.digest !== authority.manifestDigest
      || previousManifest.acceptance?.anchorDigest !== authority.anchorDigest
      || computeArtifactDigest(previousManifest.acceptance?.anchorIdentity) !== authority.anchorIdentityDigest
      || (previousManifest.acceptance?.representativeIdentity === null ? authority.representativeIdentityDigest !== null
        : computeArtifactDigest(previousManifest.acceptance?.representativeIdentity) !== authority.representativeIdentityDigest)
      || (!rollbackAnchor && (previousManifest.acceptance?.representativeDigest !== authority.representativeDigest
        || (previousManifest.acceptance?.batches?.at(-1)?.digest ?? null) !== authority.batchDigest))) {
      fail('E_ASSET_ACCEPTANCE_STALE', 'prior manifest does not match PROJECT_STATE acceptance authority');
    }
    const requiredPrefix = rollbackAnchor
      ? { anchorDigest: authority.anchorDigest, representativeDigest: null,
        anchorIdentity: previousManifest.acceptance.anchorIdentity, representativeIdentity: null, batches: [] }
      : previousManifest.acceptance;
    if (next.revision <= previousManifest.revision || JSON.stringify(next.acceptance) !== JSON.stringify(requiredPrefix)) {
      fail('E_BATCH_REVISION', 'candidate manifest must advance the authoritative revision and preserve the exact accepted history prefix');
    }
  } else if (stage !== 'anchor' || (previousManifest && next.revision <= previousManifest.revision)
    || next.acceptance.anchorDigest !== null || next.acceptance.representativeDigest !== null
    || next.acceptance.anchorIdentity !== null || next.acceptance.representativeIdentity !== null || next.acceptance.batches.length !== 0) {
    fail('E_ASSET_ACCEPTANCE_STALE', 'first anchor candidate must advance the draft manifest with an empty acceptance history');
  }
  const anchor = next.assets.find(({ sourceKind }) => sourceKind === 'style-anchor');
  const representative = next.assets.flatMap(({ combinationTests }) => combinationTests ?? [])
    .find(({ representative: chosen, status }) => chosen === true && status === 'accepted');
  if (stage === 'anchor') {
    next.acceptance.anchorDigest = anchor?.provenance?.sourceDigest ?? null;
    next.acceptance.anchorIdentity = anchorIdentity(anchor);
  }
  if (stage === 'representative') {
    next.acceptance.anchorDigest = previousManifest.acceptance.anchorDigest;
    next.acceptance.anchorIdentity = previousManifest.acceptance.anchorIdentity;
    next.acceptance.representativeDigest = representative?.digest ?? null;
    next.acceptance.representativeIdentity = representativeIdentity(next);
  }
  if (stage === 'batch') {
    next.status = 'frozen';
    const previousBatches = previousManifest.acceptance.batches;
    const digest = computeArtifactDigest({ revision: next.revision, assets: next.assets.map(({ id, provenance, combinationTests }) => ({
      id, sourceDigest: provenance.sourceDigest, proofDigests: (combinationTests ?? []).map(({ digest: proofDigest }) => proofDigest),
    })) });
    next.acceptance = {
      anchorDigest: previousManifest.acceptance.anchorDigest,
      representativeDigest: previousManifest.acceptance.representativeDigest,
      anchorIdentity: previousManifest.acceptance.anchorIdentity,
      representativeIdentity: previousManifest.acceptance.representativeIdentity,
      batches: [...previousBatches, { revision: next.revision, digest, acceptedAt: timestamp }],
    };
  }
  next.integrity.digest = null;
  next.integrity.digest = computeArtifactDigest(next);
  return next;
}

function stateWithAssetAcceptance(state, manifest, stage, timestamp) {
  const next = structuredClone(state);
  if (stage === 'batch') next.revision += 1;
  next.assetAcceptance = {
    stage, manifestRevision: manifest.revision, manifestDigest: manifest.integrity.digest,
    anchorDigest: manifest.acceptance.anchorDigest, representativeDigest: manifest.acceptance.representativeDigest,
    anchorIdentityDigest: manifest.acceptance.anchorIdentity ? computeArtifactDigest(manifest.acceptance.anchorIdentity) : null,
    representativeIdentityDigest: manifest.acceptance.representativeIdentity ? computeArtifactDigest(manifest.acceptance.representativeIdentity) : null,
    batchDigest: stage === 'batch' ? manifest.acceptance.batches.at(-1)?.digest ?? null : null,
    acceptedAt: timestamp,
  };
  next.integrity.digest = null;
  next.integrity.digest = computeArtifactDigest(next);
  return next;
}

function stampJournal(journal) {
  journal.integrity = { digest: null, upstream: {} };
  journal.integrity.digest = computeArtifactDigest(journal);
  return journal;
}

async function writeJournal(path, journal) {
  await writeJsonAtomic(path, stampJournal(journal));
  await syncDirectory(path);
}

async function writeDurableJson(path, value) {
  await writeJsonAtomic(path, value);
  await syncDirectory(path);
}

async function createJournal(path, journal, code, injectFailure) {
  stampJournal(journal);
  const transactionToken = journal.owner?.token ?? journal.transactionId;
  if (!/^[0-9a-f]{32,64}$/.test(transactionToken ?? '')) fail('E_ASSET_TRANSACTION', 'journal requires an internal transaction token');
  const staged = join(dirname(path), `.${basename(path)}.${transactionToken}.staged`);
  let handle;
  let published = false;
  try {
    await mkdir(dirname(path), { recursive: true });
    handle = await open(staged, 'wx', 0o600);
    const bytes = `${JSON.stringify(journal, null, 2)}\n`;
    if (injectFailure === 'duringJournalStage') {
      await handle.writeFile(bytes.slice(0, Math.floor(bytes.length / 2)));
      await handle.sync();
      fail('E_INJECTED_FAILURE', 'injected failure during staged journal write');
    }
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await link(staged, path);
    published = true;
    await syncDirectory(path);
    if (injectFailure === 'afterInitialJournalLink') fail('E_INJECTED_FAILURE', 'injected failure after journal publication');
    await unlink(staged);
    await syncDirectory(path);
  } catch (error) {
    if (!(published && injectFailure === 'afterInitialJournalLink')) await rm(staged, { force: true }).catch(() => {});
    if (error.code === 'EEXIST') fail(code, 'another asset transaction is already active');
    throw error;
  } finally { if (handle) await handle.close().catch(() => {}); }
}

async function strictRecoveryArtifacts(journal) {
  const stateSchema = await loadSchema('project-state');
  const manifestSchema = await loadSchema('asset-manifest');
  const documents = [journal.previousState, journal.nextState, journal.candidateManifest, journal.nextManifest,
    ...(journal.previousManifest ? [journal.previousManifest] : [])];
  if (!documents.every((document) => verifyArtifactIntegrity(document).valid)
    || !validateDocument(stateSchema, journal.previousState).valid || !validateDocument(stateSchema, journal.nextState).valid
    || !validateDocument(manifestSchema, journal.candidateManifest).valid
    || !validateDocument(manifestSchema, journal.nextManifest).valid
    || (journal.previousManifest && !validateDocument(manifestSchema, journal.previousManifest).valid)) {
    fail('E_ASSET_TRANSACTION', 'asset acceptance journal contains invalid artifact documents');
  }
}

async function recoverAssetStageTransaction(projectRoot, journalPath, dependencies, transactionPaths) {
  const journal = await readOptionalJson(journalPath);
  if (!journal) return null;
  const exactKeys = ['kind', 'schemaVersion', 'transactionId', 'phase', 'stage', 'timestamp', 'candidateManifest', 'previousManifest',
    'previousState', 'nextManifest', 'nextState', 'integrity'];
  if (JSON.stringify(Object.keys(journal).sort()) !== JSON.stringify(exactKeys.sort())
    || !['prepared', 'manifest-intent', 'manifest-published', 'state-intent', 'documents-published', 'workbench-published', 'completion-published'].includes(journal.phase)
    || !DIGEST.test(journal.transactionId ?? '') || !['anchor', 'representative', 'batch'].includes(journal.stage) || !Number.isFinite(Date.parse(journal.timestamp))
    || !verifyArtifactIntegrity(journal).valid || journal.kind !== 'asset-stage-acceptance' || journal.schemaVersion !== '1.0.0') {
    fail('E_ASSET_TRANSACTION', 'asset acceptance journal is invalid and requires operator repair');
  }
  await (dependencies.validateRecoveryArtifacts ?? strictRecoveryArtifacts)(journal);
  const committed = await dependencies.validateRecoveryDirection(projectRoot);
  const assetPlanDigest = committed.approval?.displayedArtifactDigests?.assetPlan;
  const acceptedFootageEvidenceIds = committed.selectedCandidate?.representativeEvidenceIds ?? [];
  const currentEvidenceBindings = await currentDocumentaryEvidence(projectRoot);
  const activityStatus = await currentActivityStatus(projectRoot);
  const expectedStageState = { anchor: 'DIRECTOR_LOCK', representative: 'STYLE_ANCHOR', batch: 'ASSET_PRODUCTION' }[journal.stage];
  if (journal.previousState.state !== expectedStageState || Date.parse(journal.timestamp) < Date.parse(journal.previousState.stateEnteredAt)) {
    fail('E_ASSET_TRANSACTION', 'asset journal stage or timestamp does not match its prior project state');
  }
  const semantic = validateImageAssets({ manifest: journal.candidateManifest, design: committed.design, look: committed.look,
    projectState: journal.previousState, phase: journal.stage, approvedAssetPlanDigest: assetPlanDigest,
    selectedCandidate: committed.selectedCandidate, acceptedFootageEvidenceIds, currentEvidenceBindings, activityStatus });
  if (!semantic.valid) fail('E_ASSET_TRANSACTION', 'asset journal candidate no longer passes semantic authority', { diagnostics: semantic.errors });
  const files = await dependencies.validateFiles({ projectRoot, manifest: journal.candidateManifest, phase: journal.stage });
  if (!files.valid) fail('E_ASSET_TRANSACTION', 'asset journal candidate files are stale', { diagnostics: files.errors });
  const accepted = await acceptAssetStage({ projectState: journal.previousState, manifest: journal.candidateManifest,
    design: committed.design, look: committed.look, assetPlanDigest, selectedCandidate: committed.selectedCandidate,
    acceptedFootageEvidenceIds, currentEvidenceBindings, activityStatus, stage: journal.stage, timestamp: journal.timestamp });
  const regeneratedManifest = acceptedManifestForStage(journal.candidateManifest, journal.previousManifest, journal.previousState, journal.stage, journal.timestamp);
  const regeneratedState = stateWithAssetAcceptance(journal.stage === 'batch' ? journal.previousState : accepted.projectState,
    regeneratedManifest, journal.stage, journal.timestamp);
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (!same(regeneratedManifest, journal.nextManifest) || !same(regeneratedState, journal.nextState)) {
    fail('E_ASSET_TRANSACTION', 'asset journal next documents do not match regenerated acceptance intent');
  }
  const manifestPath = transactionPaths.outputPath;
  const statePath = transactionPaths.statePath;
  const currentManifest = await readOptionalJson(manifestPath);
  const currentState = await readJson(statePath, 'E_PROJECT_STATE_READ');
  const previousPair = same(currentManifest, journal.previousManifest) && same(currentState, journal.previousState);
  const intermediatePair = same(currentManifest, journal.nextManifest) && same(currentState, journal.previousState);
  const nextPair = same(currentManifest, journal.nextManifest) && same(currentState, journal.nextState);
  const recognizedForPhase = {
    prepared: previousPair,
    'manifest-intent': previousPair || intermediatePair,
    'manifest-published': intermediatePair,
    'state-intent': intermediatePair || nextPair,
    'documents-published': nextPair,
    'workbench-published': nextPair,
    'completion-published': nextPair,
  }[journal.phase];
  if (!recognizedForPhase) {
    fail('E_ASSET_TRANSACTION_CONFLICT', 'asset transaction recovery refuses to overwrite a later manifest or project state');
  }
  await writeDurableJson(manifestPath, journal.nextManifest);
  await writeDurableJson(statePath, journal.nextState);
  journal.phase = 'documents-published';
  await writeJournal(journalPath, journal);
  const workbench = await dependencies.buildPostLockWorkbench(projectRoot, { mutationGuard: dependencies.mutationGuard });
  journal.phase = 'workbench-published';
  await writeJournal(journalPath, journal);
  const completionPath = transactionPaths.completionPath;
  const completion = stampJournal({ kind: 'asset-stage-completion', schemaVersion: '1.0.0', stage: journal.stage,
    candidateDigest: journal.candidateManifest.integrity.digest, manifestRevision: journal.nextManifest.revision,
    manifestDigest: journal.nextManifest.integrity.digest, stateRevision: journal.nextState.revision,
    stateDigest: journal.nextState.integrity.digest, integrity: { digest: null, upstream: {} } });
  await writeDurableJson(completionPath, completion);
  journal.phase = 'completion-published'; await writeJournal(journalPath, journal);
  await recoverOrphanJournalStage(journalPath);
  await cleanupOwnedJournalStages(journalPath, journal);
  await unlink(journalPath);
  await syncDirectory(journalPath);
  return { ok: true, recovered: true, stage: journal.stage, manifestDigest: journal.nextManifest.integrity.digest,
    state: journal.nextState.state, stateRevision: journal.nextState.revision, workbench };
}

export async function persistAssetStage(input) {
  return persistAssetStageInternal(input, {});
}

async function persistAssetStageInternal(input, dependencies) {
  const { projectRoot, stage, manifestPath, timelinePath = 'edit/TIMELINE.json' } = input;
  if (Object.hasOwn(input, 'transactionPaths')) fail('E_TRANSACTION_CAPABILITY', 'transaction paths are internal capabilities and cannot be supplied by callers');
  if (typeof manifestPath !== 'string' || isAbsolute(manifestPath) || manifestPath.includes('\\')
    || manifestPath.split('/').some((part) => !part || part === '.' || part === '..')
    || projectPath(projectRoot, manifestPath) === projectPath(projectRoot, 'direction/ASSET_MANIFEST.json')) {
    fail('E_MANIFEST_CANDIDATE_PATH', 'asset acceptance requires a distinct portable staged candidate manifest path');
  }
  if (!dependencies[ASSET_TRANSACTION_PATHS]) {
    const candidateDirectory = dirname(manifestPath) === '.' ? '' : dirname(manifestPath);
    const timelineDirectory = dirname(timelinePath) === '.' ? '' : dirname(timelinePath);
    const specifications = [
      { key: 'candidatePath', portablePath: manifestPath, requiredRoot: candidateDirectory },
      { key: 'directionDirectory', portablePath: 'direction', requiredRoot: 'direction', directory: true },
      { key: 'cacheDirectory', portablePath: 'cache', requiredRoot: 'cache', directory: true },
      { key: 'projectDirectory', portablePath: '', requiredRoot: '', directory: true },
    ];
    if (stage === 'batch') specifications.push({ key: 'timelinePath', portablePath: timelinePath, requiredRoot: timelineDirectory });
    return withProjectAssetDescriptors(projectRoot, specifications, (stable) => persistAssetStageInternal(input, { ...dependencies, [ASSET_TRANSACTION_PATHS]: {
      candidatePath: stable.candidatePath, outputPath: join(stable.directionDirectory, 'ASSET_MANIFEST.json'),
      journalPath: join(stable.cacheDirectory, 'asset-stage.transaction.json'),
      completionPath: join(stable.cacheDirectory, 'asset-stage.last-completion.json'),
      statePath: join(stable.projectDirectory, 'PROJECT_STATE.json'), projectRoot: stable.projectDirectory,
      timelinePath: stable.timelinePath ?? null,
    } }));
  }
  const transactionPaths = dependencies[ASSET_TRANSACTION_PATHS];
  const stableProjectRoot = transactionPaths.projectRoot;
  if (!dependencies[ASSET_MUTATION_GUARD]) {
    const mutationGuard = await acquireRepairGuard(stableProjectRoot);
    try { return await persistAssetStageInternal(input, { ...dependencies, [ASSET_MUTATION_GUARD]: mutationGuard }); }
    finally { await releaseRepairGuard(stableProjectRoot, mutationGuard); }
  }
  const mutationGuard = dependencies[ASSET_MUTATION_GUARD];
  await assertNoPendingRepairTransaction(stableProjectRoot);
  const timestamp = input.timestamp ?? new Date().toISOString();
  const validateCommittedDirection = validateDirectionLock;
  const validateRecoveryDirection = (root) => validateDirectionDuringAssetRecovery(root, mutationGuard);
  const validateFiles = validateImageAssetFiles;
  const buildPostLockWorkbench = (root) => rebuildPostLockWorkbenchDuringAssetRecovery(root, mutationGuard);
  const journalPath = transactionPaths.journalPath;
  await recoverOrphanJournalStage(journalPath);
  const recovered = await recoverAssetStageTransaction(stableProjectRoot, journalPath, {
    validateCommittedDirection, validateRecoveryDirection, validateFiles, buildPostLockWorkbench,
    mutationGuard,
  }, transactionPaths);
  if (recovered) return recovered;
  const manifest = await readJson(transactionPaths.candidatePath, 'E_MANIFEST_READ');
  if (!verifyArtifactIntegrity(manifest).valid) fail('E_MANIFEST_INTEGRITY', 'asset manifest integrity digest is stale');
  const schemaResult = validateDocument(await loadSchema('asset-manifest'), manifest);
  if (!schemaResult.valid) fail('E_MANIFEST_SCHEMA', 'asset manifest violates its schema', { diagnostics: schemaResult.errors });
  const committed = await validateCommittedDirection(stableProjectRoot);
  const completionPath = transactionPaths.completionPath;
  const completion = await readOptionalJson(completionPath);
  if (completion) {
    const exactKeys = ['kind', 'schemaVersion', 'stage', 'candidateDigest', 'manifestRevision', 'manifestDigest', 'stateRevision', 'stateDigest', 'integrity'];
    const [currentManifest, currentState] = await Promise.all([
      readOptionalJson(transactionPaths.outputPath), readJson(transactionPaths.statePath, 'E_PROJECT_STATE_READ'),
    ]);
    const accepted = currentState.assetAcceptance;
    const batchDigest = currentManifest?.acceptance?.batches?.at(-1)?.digest ?? null;
    const artifactsValid = currentManifest && verifyArtifactIntegrity(currentManifest).valid && verifyArtifactIntegrity(currentState).valid
      && validateDocument(await loadSchema('asset-manifest'), currentManifest).valid
      && validateDocument(await loadSchema('project-state'), currentState).valid;
    const acceptanceExact = accepted?.stage === stage && accepted.manifestRevision === currentManifest?.revision
      && accepted.manifestDigest === currentManifest?.integrity?.digest
      && accepted.anchorDigest === currentManifest?.acceptance?.anchorDigest
      && accepted.representativeDigest === currentManifest?.acceptance?.representativeDigest
      && accepted.anchorIdentityDigest === (currentManifest?.acceptance?.anchorIdentity ? computeArtifactDigest(currentManifest.acceptance.anchorIdentity) : null)
      && accepted.representativeIdentityDigest === (currentManifest?.acceptance?.representativeIdentity ? computeArtifactDigest(currentManifest.acceptance.representativeIdentity) : null)
      && accepted.batchDigest === (stage === 'batch' ? batchDigest : null);
    if (artifactsValid && acceptanceExact
      && JSON.stringify(Object.keys(completion).sort()) === JSON.stringify(exactKeys.sort())
      && completion.kind === 'asset-stage-completion' && completion.schemaVersion === '1.0.0'
      && completion.stage === stage && completion.candidateDigest === manifest.integrity.digest
      && completion.manifestRevision === currentManifest?.revision && completion.manifestDigest === currentManifest?.integrity?.digest
      && completion.stateRevision === currentState.revision && completion.stateDigest === currentState.integrity?.digest
      && verifyArtifactIntegrity(completion).valid) {
      const currentSemantic = validateImageAssets({ manifest: currentManifest, design: committed.design, look: committed.look,
        projectState: currentState, phase: stage, approvedAssetPlanDigest: committed.approval?.displayedArtifactDigests?.assetPlan,
        selectedCandidate: committed.selectedCandidate, acceptedFootageEvidenceIds: committed.selectedCandidate?.representativeEvidenceIds ?? [],
        currentEvidenceBindings: await currentDocumentaryEvidence(stableProjectRoot),
        activityStatus: await currentActivityStatus(stableProjectRoot) });
      const currentFiles = await validateFiles({ projectRoot: stableProjectRoot, manifest: currentManifest, phase: stage });
      if (!currentSemantic.valid || !currentFiles.valid) fail('E_ASSET_COMPLETION_STALE', 'asset completion no longer passes current semantic and file authority',
        { diagnostics: [...currentSemantic.errors, ...currentFiles.errors] });
      return { ok: true, idempotent: true, stage, manifestDigest: completion.manifestDigest,
        state: currentState.state, stateRevision: currentState.revision };
    }
    if (completion.stage === stage && completion.candidateDigest === manifest.integrity.digest) {
      fail('E_ASSET_COMPLETION_STALE', 'matching asset completion does not bind a current valid manifest/state pair');
    }
  }
  const assetPlanDigest = committed.approval?.displayedArtifactDigests?.assetPlan;
  const acceptedFootageEvidenceIds = committed.selectedCandidate?.representativeEvidenceIds ?? [];
  const currentEvidenceBindings = await currentDocumentaryEvidence(stableProjectRoot);
  const activityStatus = await currentActivityStatus(stableProjectRoot);
  const timeline = stage === 'batch' ? await readOptionalJson(transactionPaths.timelinePath) ?? { items: [] } : { items: [] };
  const semantic = validateImageAssets({
    manifest, design: committed.design, look: committed.look, projectState: committed.state, timeline, phase: stage,
    approvedAssetPlanDigest: assetPlanDigest, selectedCandidate: committed.selectedCandidate, acceptedFootageEvidenceIds, currentEvidenceBindings, activityStatus,
  });
  if (!semantic.valid) fail('E_ASSET_VALIDATION', 'asset manifest failed semantic validation', { diagnostics: semantic.errors });
  const files = await validateFiles({ projectRoot: stableProjectRoot, manifest, phase: stage });
  if (!files.valid) fail('E_ASSET_FILES', 'asset files failed provenance or proof validation', { diagnostics: files.errors });
  const accepted = await acceptAssetStage({
    projectState: committed.state, manifest, design: committed.design, look: committed.look,
    assetPlanDigest, selectedCandidate: committed.selectedCandidate, acceptedFootageEvidenceIds, currentEvidenceBindings, activityStatus,
    stage, timestamp, representativeProofDigest: input.representativeProofDigest,
  });
  const outputPath = transactionPaths.outputPath;
  const statePath = transactionPaths.statePath;
  const previousManifest = await readOptionalJson(outputPath);
  const previousState = await readJson(statePath, 'E_PROJECT_STATE_READ');
  if (!previousManifest || !verifyArtifactIntegrity(previousManifest).valid
    || !validateDocument(await loadSchema('asset-manifest'), previousManifest).valid) {
    fail('E_ASSET_ACCEPTANCE_STALE', 'current authoritative asset manifest is missing or invalid');
  }
  const nextManifest = acceptedManifestForStage(manifest, previousManifest, previousState, stage, timestamp);
  const nextState = stateWithAssetAcceptance(stage === 'batch' ? previousState : accepted.projectState, nextManifest, stage, timestamp);
  const [nextManifestContract, nextStateContract] = await Promise.all([
    loadSchema('asset-manifest').then((schema) => validateDocument(schema, nextManifest)),
    loadSchema('project-state').then((schema) => validateDocument(schema, nextState)),
  ]);
  if (!nextManifestContract.valid || !nextStateContract.valid) fail('E_ASSET_TRANSACTION', 'server-derived acceptance documents violate their contracts',
    { diagnostics: [...nextManifestContract.errors, ...nextStateContract.errors] });
  const journal = { kind: 'asset-stage-acceptance', schemaVersion: '1.0.0', transactionId: randomBytes(32).toString('hex'), phase: 'prepared', stage, timestamp,
    candidateManifest: manifest, previousManifest, previousState, nextManifest, nextState, integrity: { digest: null, upstream: {} } };
  await createJournal(journalPath, journal, 'E_ASSET_TRANSACTION_BUSY', input.injectFailure);
  if (input.afterJournalAcquire) await input.afterJournalAcquire({ previousManifest, previousState });
  const [casManifest, casState] = await Promise.all([readOptionalJson(outputPath), readJson(statePath, 'E_PROJECT_STATE_READ')]);
  if (JSON.stringify(casManifest) !== JSON.stringify(previousManifest) || JSON.stringify(casState) !== JSON.stringify(previousState)) {
    await unlink(journalPath); await syncDirectory(journalPath);
    fail('E_ASSET_TRANSACTION_CONFLICT', 'asset acceptance authority changed before publication');
  }
  journal.phase = 'manifest-intent'; await writeJournal(journalPath, journal);
  await writeDurableJson(outputPath, nextManifest);
  journal.phase = 'manifest-published'; await writeJournal(journalPath, journal);
  if (input.injectFailure === 'afterManifestWrite') fail('E_INJECTED_FAILURE', 'injected failure after manifest publication');
  journal.phase = 'state-intent'; await writeJournal(journalPath, journal);
  await writeDurableJson(statePath, nextState);
  journal.phase = 'documents-published'; await writeJournal(journalPath, journal);
  if (input.injectFailure === 'afterStateWrite') fail('E_INJECTED_FAILURE', 'injected failure after state publication');
  const workbench = await buildPostLockWorkbench(stableProjectRoot, { mutationGuard });
  journal.phase = 'workbench-published'; await writeJournal(journalPath, journal);
  if (input.injectFailure === 'afterWorkbench') fail('E_INJECTED_FAILURE', 'injected failure after workbench publication');
  const completionRecord = stampJournal({ kind: 'asset-stage-completion', schemaVersion: '1.0.0', stage,
    candidateDigest: manifest.integrity.digest, manifestRevision: nextManifest.revision, manifestDigest: nextManifest.integrity.digest,
    stateRevision: nextState.revision, stateDigest: nextState.integrity.digest, integrity: { digest: null, upstream: {} } });
  await writeDurableJson(completionPath, completionRecord);
  journal.phase = 'completion-published'; await writeJournal(journalPath, journal);
  await recoverOrphanJournalStage(journalPath);
  await cleanupOwnedJournalStages(journalPath, journal);
  await unlink(journalPath);
  if (input.injectFailure === 'afterJournalUnlink') fail('E_INJECTED_FAILURE', 'injected failure after asset journal unlink');
  await syncDirectory(journalPath);
  return { ok: true, stage, manifestDigest: nextManifest.integrity.digest, state: nextState.state, stateRevision: nextState.revision, workbench };
}
