import { pathToFileURL } from 'node:url';
import { readFile, unlink } from 'node:fs/promises';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest, loadSchema, validateDocument, verifyArtifactIntegrity } from './lib/contracts.mjs';
import { buildPostLockWorkbench } from './lib/approval.mjs';
import { loadEditorialEvidence } from './lib/editorial-evidence.mjs';
import { acquireRepairGuard, releaseRepairGuard } from './lib/invalidation.mjs';
import { projectPath, writeJsonAtomic } from './lib/media.mjs';
import { validateMotionContract } from './lib/motion.mjs';
import { validateSceneLayout } from './lib/layout.mjs';
import { commitMotionCompositionState } from './lib/project-state.mjs';
import { validateTimeline } from './lib/timeline.mjs';
import { validateColorPipeline } from './validate_color_pipeline.mjs';
import { validateContrast } from './validate_contrast.mjs';
import { validateDesignSystem } from './validate_design_system.mjs';

const REVIEW_CATEGORIES = ['visual-density', 'restraint', 'pacing', 'cross-scene-taste'];
const reviewFinding = (category) => ({ code: 'AGENT_REVIEW_REQUIRED', classification: 'agent_review_required', category, message: `${category} requires Agent review of decoded final-MP4 evidence` });
const rasterError = (path) => ({ code: 'E_RASTER_BUDGET', classification: 'hard_error', category: 'raster-budget', path, message: 'asset effective pixels do not cover its approved maximum display rectangle' });

export function validateDesignConsistency(input = {}) {
  const results = [validateDesignSystem(input), validateMotionContract(input), validateSceneLayout(input), validateColorPipeline({ ...input, requireRenderedEvidence: true }), validateContrast({ layers: input.contrastLayers, requireRenderedEvidence: true })];
  const hardErrors = results.flatMap(({ hardErrors = [] }) => hardErrors);
  for (const [index, asset] of (input.assetManifest?.assets ?? []).entries()) {
    const display = asset.expectedDisplayRect; const effective = asset.nativeEffectivePixels;
    if (display && (!effective || effective.width < display.width || effective.height < display.height)) hardErrors.push(rasterError(`/assetManifest/assets/${index}`));
  }
  const unique = [...new Map(hardErrors.map((entry) => [`${entry.code}:${entry.path}`, entry])).values()];
  const agentReviewRequired = REVIEW_CATEGORIES.map(reviewFinding);
  return { valid: unique.length === 0, hardGatePassed: unique.length === 0, agentReviewPending: true, hardErrors: unique, agentReviewRequired, findings: [...unique, ...agentReviewRequired] };
}

export async function validateDesignConsistencyFile({ project }) {
  const files = {
    designSystem: ['direction/DESIGN_SYSTEM.json', 'design-system'], lookProfile: ['direction/LOOK_PROFILE.json', 'look-profile'],
    assetManifest: ['direction/ASSET_MANIFEST.json', 'asset-manifest'], motionMap: ['direction/MOTION_MAP.json', 'motion-map'],
    sceneSchema: ['direction/SCENE_SCHEMA.json', 'scene-schema'], dataOverlays: ['direction/DATA_OVERLAYS.json', 'data-overlays'],
    timeline: ['edit/TIMELINE.json', 'timeline'], activity: ['analysis/ACTIVITY.json', 'activity'], syncMap: ['analysis/SYNC_MAP.json', 'sync-map'],
    projectState: ['PROJECT_STATE.json', 'project-state'],
  };
  const input = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([role, [path, schemaName]]) => {
    const artifact = JSON.parse(await readFile(projectPath(project, path), 'utf8'));
    const contract = validateDocument(await loadSchema(schemaName), artifact);
    if (!contract.valid || !verifyArtifactIntegrity(artifact).valid) { const cause = new Error(`${role} is not a current integrity-valid artifact`); cause.code = 'E_COMPOSITION_AUTHORITY'; cause.diagnostics = contract.errors; throw cause; }
    return [role, artifact];
  })));
  const projectDocument = JSON.parse(await readFile(projectPath(project, 'PROJECT.json'), 'utf8'));
  const projectContract = validateDocument(await loadSchema('project'), projectDocument);
  if (!projectContract.valid || !verifyArtifactIntegrity(projectDocument).valid) { const cause = new Error('PROJECT is not a current integrity-valid artifact'); cause.code = 'E_COMPOSITION_AUTHORITY'; cause.diagnostics = projectContract.errors; throw cause; }
  const sportProfile = JSON.parse(await readFile(new URL(`../profiles/sports/${projectDocument.profiles.sport}.json`, import.meta.url), 'utf8'));
  input.primaryMetricIds = sportProfile.policies.dataPolicy.primaryMetrics;
  const [colorEvidence, contrastEvidence] = await Promise.all(['review/design-color-evidence.json', 'review/design-contrast-evidence.json']
    .map((path) => readFile(projectPath(project, path), 'utf8').then(JSON.parse)));
  if (!verifyArtifactIntegrity(colorEvidence).valid || !verifyArtifactIntegrity(contrastEvidence).valid) { const cause = new Error('rendered design evidence integrity is stale'); cause.code = 'E_DESIGN_EVIDENCE'; throw cause; }
  const expectedColorUpstream = { designSystem: input.designSystem.integrity.digest, lookProfile: input.lookProfile.integrity.digest, motionMap: input.motionMap.integrity.digest };
  const expectedContrastUpstream = { sceneSchema: input.sceneSchema.integrity.digest, motionMap: input.motionMap.integrity.digest };
  if (JSON.stringify(colorEvidence.integrity.upstream) !== JSON.stringify(expectedColorUpstream)
    || JSON.stringify(contrastEvidence.integrity.upstream) !== JSON.stringify(expectedContrastUpstream)) { const cause = new Error('rendered design evidence lineage is stale'); cause.code = 'E_DESIGN_EVIDENCE'; throw cause; }
  input.renderedTokenSamples = colorEvidence.renderedTokenSamples;
  input.colorVisionProofs = colorEvidence.colorVisionProofs;
  input.contrastLayers = contrastEvidence.layers;
  input.runtimeSource = (await Promise.all([
    new URL('../assets/hyperframes-project/src/main.js', import.meta.url),
    new URL('../assets/hyperframes-project/src/scene-runtime.js', import.meta.url),
  ].map((url) => readFile(url, 'utf8')))).join('\n');
  return validateDesignConsistency(input);
}

export async function finalizeMotionComposition({ project, input, timestamp = new Date().toISOString() }) {
  if (!input) { const cause = new Error('final motion composition requires the immutable input root'); cause.code = 'E_INPUT_REQUIRED'; throw cause; }
  const mutationGuard = await acquireRepairGuard(project);
  const statePath = projectPath(project, 'PROJECT_STATE.json');
  const diagnosticPath = projectPath(project, 'review/design-consistency.json');
  const journalPath = projectPath(project, 'cache/motion-composition.transaction.json');
  const readOptional = async (path) => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; } };
  try {
    const orphan = await readOptional(journalPath);
    if (orphan) {
      if (!verifyArtifactIntegrity(orphan).valid || orphan.kind !== 'motion-composition-transaction') { const cause = new Error('motion transaction journal is invalid'); cause.code = 'E_MOTION_TRANSACTION'; throw cause; }
      const currentState = JSON.parse(await readFile(statePath, 'utf8'));
      if (![JSON.stringify(orphan.previousState), JSON.stringify(orphan.nextState)].includes(JSON.stringify(currentState))) { const cause = new Error('motion transaction conflicts with later state'); cause.code = 'E_MOTION_TRANSACTION_CONFLICT'; throw cause; }
      await writeJsonAtomic(statePath, orphan.previousState);
      if (orphan.previousDiagnostic) await writeJsonAtomic(diagnosticPath, orphan.previousDiagnostic); else await unlink(diagnosticPath).catch((cause) => { if (cause.code !== 'ENOENT') throw cause; });
      await buildPostLockWorkbench(project, { mutationGuard }); await unlink(journalPath);
    }
    const evidence = await loadEditorialEvidence({ project, input, phase: 'final', requireTimelineIntegrity: true });
    const consistency = await validateDesignConsistencyFile({ project });
    if (!consistency.valid) { const cause = new Error('motion composition hard gates failed'); cause.code = 'E_DESIGN_CONSISTENCY'; cause.diagnostics = consistency.hardErrors; throw cause; }
    const timelineResult = validateTimeline({ phase: 'final', ...evidence });
    if (!timelineResult.renderable) { const cause = new Error('final timeline is not renderable'); cause.code = 'E_TIMELINE_FINAL'; cause.diagnostics = [...timelineResult.errors, ...timelineResult.undecidedWarnings]; throw cause; }
    const [sceneSchema, motionMap] = await Promise.all(['direction/SCENE_SCHEMA.json', 'direction/MOTION_MAP.json'].map((path) => readFile(projectPath(project, path), 'utf8').then(JSON.parse)));
    const diagnosticArtifact = {
    schemaVersion: '1.0.0', revision: 1, status: 'hard-gates-passed', checkedAt: timestamp,
    sceneCount: sceneSchema.scenes.length, motionOwnerCount: motionMap.owners.length,
    timelineItemCount: evidence.timeline.items.length,
    hardErrors: [], agentReviewRequired: consistency.agentReviewRequired,
    integrity: { digest: null, upstream: { sceneSchema: sceneSchema.integrity.digest, motionMap: motionMap.integrity.digest, timeline: evidence.timeline.integrity.digest } },
    };
    diagnosticArtifact.integrity.digest = computeArtifactDigest(diagnosticArtifact);
    const artifacts = {
    SCENE_SCHEMA: { revision: sceneSchema.revision, digest: sceneSchema.integrity.digest },
    MOTION_MAP: { revision: motionMap.revision, digest: motionMap.integrity.digest },
    TIMELINE: { revision: evidence.timeline.revision, digest: evidence.timeline.integrity.digest },
    DESIGN_CONSISTENCY: { revision: diagnosticArtifact.revision, digest: diagnosticArtifact.integrity.digest },
    };
    const nextState = commitMotionCompositionState(evidence.projectState, artifacts, { timestamp, producerCommand: 'validate_design_consistency.mjs' });
    nextState.integrity.digest = computeArtifactDigest(nextState);
    const stateContract = validateDocument(await loadSchema('project-state'), nextState);
    if (!stateContract.valid) { const cause = new Error('compiled motion state violates project contract'); cause.code = 'E_MOTION_STATE_CONTRACT'; cause.diagnostics = stateContract.errors; throw cause; }
    const previousDiagnostic = await readOptional(diagnosticPath);
    const journal = { kind: 'motion-composition-transaction', schemaVersion: '1.0.0', phase: 'prepared', previousState: evidence.projectState, nextState, previousDiagnostic, nextDiagnostic: diagnosticArtifact, integrity: { digest: null, upstream: {} } };
    journal.integrity.digest = computeArtifactDigest(journal); await writeJsonAtomic(journalPath, journal);
    try {
      await writeJsonAtomic(diagnosticPath, diagnosticArtifact); await writeJsonAtomic(statePath, nextState);
      const workbench = await buildPostLockWorkbench(project, { mutationGuard }); await unlink(journalPath);
      return { ok: true, state: nextState.state, stateRevision: nextState.revision, timelineDigest: evidence.timeline.integrity.digest, motionMapDigest: motionMap.integrity.digest, diagnosticsDigest: diagnosticArtifact.integrity.digest, agentReviewPending: true, workbench };
    } catch (cause) {
      await writeJsonAtomic(statePath, evidence.projectState);
      if (previousDiagnostic) await writeJsonAtomic(diagnosticPath, previousDiagnostic); else await unlink(diagnosticPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      await buildPostLockWorkbench(project, { mutationGuard }); await unlink(journalPath).catch(() => {}); throw cause;
    }
  } finally { await releaseRepairGuard(project, mutationGuard); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const options = parseCliArguments(process.argv.slice(2), { project: { required: true }, input: { required: false }, timestamp: { required: false } }); const result = options.input ? await finalizeMotionComposition(options) : await validateDesignConsistencyFile(options); process.stdout.write(`${JSON.stringify({ ok: result.valid ?? result.ok, ...result })}\n`); if (!(result.valid ?? result.ok)) process.exitCode = 1; }
  catch (cause) { process.stdout.write(`${JSON.stringify(errorResult(cause))}\n`); process.exitCode = cause.code === 'E_USAGE' ? 2 : 1; }
}
