import { readFile, rename, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { buildPostLockWorkbench, validateCommittedDirection } from './lib/approval.mjs';
import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest, loadSchema, validateArtifact, validateDocument } from './lib/contracts.mjs';
import { loadEditorialEvidence } from './lib/editorial-evidence.mjs';
import { acquireRepairGuard, releaseRepairGuard } from './lib/invalidation.mjs';
import { projectPath, writeJsonAtomic } from './lib/media.mjs';
import { compileFinalRenderPlan, commitFinalRenderState, executeFinalRenderPlan } from './lib/render.mjs';
import { validateTimeline } from './lib/timeline.mjs';

function fail(code, message, diagnostics) {
  const cause = new Error(message); cause.code = code; cause.diagnostics = diagnostics; throw cause;
}

async function current(project, portablePath, schema) {
  const result = await validateArtifact(projectPath(project, portablePath), schema);
  if (!result.valid) fail('E_FINAL_AUTHORITY', `${portablePath} is not current and integrity-valid`, result.errors);
  return result.value;
}

async function readOptional(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; }
}

async function recoverRenderTransaction(project, mutationGuard) {
  const journalPath = projectPath(project, 'cache/final-render.transaction.json');
  const journal = await readOptional(journalPath);
  if (!journal) return;
  if (journal.kind !== 'final-render-transaction' || journal.integrity?.digest !== computeArtifactDigest(journal)) fail('E_FINAL_TRANSACTION', 'final render transaction journal is invalid');
  await writeJsonAtomic(projectPath(project, 'PROJECT_STATE.json'), journal.previousState);
  await Promise.all(['renders/final.mp4', 'renders/final.provenance.json', journal.candidatePath, journal.pendingProvenancePath]
    .filter(Boolean).map((path) => unlink(path.startsWith('/') ? path : projectPath(project, path)).catch(() => {})));
  await buildPostLockWorkbench(project, { mutationGuard });
  await unlink(journalPath);
}

export async function renderFinal({ project, input, timestamp = new Date().toISOString() }) {
  if (!input) fail('E_INPUT_REQUIRED', 'final rendering requires the immutable input root');
  const mutationGuard = await acquireRepairGuard(project);
  const statePath = projectPath(project, 'PROJECT_STATE.json');
  const journalPath = projectPath(project, 'cache/final-render.transaction.json');
  let publication;
  try {
    await recoverRenderTransaction(project, mutationGuard);
    const [evidence, committed, editBrief, sceneSchema] = await Promise.all([
      loadEditorialEvidence({ project, input, phase: 'final', requireTimelineIntegrity: true }),
      validateCommittedDirection(project),
      current(project, 'EDIT_BRIEF.json', 'edit-brief'),
      current(project, 'direction/SCENE_SCHEMA.json', 'scene-schema'),
    ]);
    if (committed.state.integrity.digest !== evidence.projectState.integrity.digest) fail('E_FINAL_AUTHORITY_STALE', 'direction lock and editorial state were not read from one mutation epoch');
    const timelineResult = validateTimeline({ phase: 'final', ...evidence });
    if (!timelineResult.renderable) fail('E_TIMELINE_FINAL', 'final timeline is not renderable', [...timelineResult.errors, ...timelineResult.undecidedWarnings]);
    const plan = await compileFinalRenderPlan({
      project, sourceRegistry: evidence.sourceRegistry, probe: evidence.probe, editBrief,
      designSystem: committed.design, lookProfile: committed.look, assetManifest: evidence.assetManifest,
      motionMap: evidence.motionMap, sceneSchema, timeline: evidence.timeline, projectState: evidence.projectState,
    });
    publication = await executeFinalRenderPlan(plan, { publish: false });
    const nextState = commitFinalRenderState(evidence.projectState, publication.provenance, timestamp);
    nextState.integrity.digest = computeArtifactDigest(nextState);
    const stateContract = validateDocument(await loadSchema('project-state'), nextState);
    if (!stateContract.valid) fail('E_FINAL_STATE_CONTRACT', 'FINAL_RENDER state violates the project contract', stateContract.errors);
    const journal = {
      kind: 'final-render-transaction', schemaVersion: '1.0.0', previousState: evidence.projectState, nextState,
      candidatePath: publication.pending.candidatePath, pendingProvenancePath: publication.pending.provenancePath,
      integrity: { digest: null, upstream: { renderProvenance: publication.provenance.integrity.digest } },
    };
    journal.integrity.digest = computeArtifactDigest(journal);
    await writeJsonAtomic(journalPath, journal);
    try {
      await rename(publication.pending.candidatePath, projectPath(project, 'renders/final.mp4'));
      await rename(publication.pending.provenancePath, projectPath(project, 'renders/final.provenance.json'));
      await writeJsonAtomic(statePath, nextState);
      const workbench = await buildPostLockWorkbench(project, { mutationGuard });
      await unlink(journalPath);
      return { ok: true, state: 'FINAL_RENDER', stateRevision: nextState.revision, artifact: publication.artifact, outputDigest: publication.outputDigest, closedFileProbe: publication.closedFileProbe, provenanceDigest: publication.provenance.integrity.digest, cache: publication.cache, workbench };
    } catch (cause) {
      await writeJsonAtomic(statePath, evidence.projectState);
      await Promise.all(['renders/final.mp4', 'renders/final.provenance.json'].map((path) => unlink(projectPath(project, path)).catch(() => {})));
      await buildPostLockWorkbench(project, { mutationGuard });
      await unlink(journalPath).catch(() => {});
      throw cause;
    }
  } catch (cause) {
    if (publication?.pending) await Promise.all(Object.values(publication.pending).map((path) => unlink(path).catch(() => {})));
    throw cause;
  } finally { await releaseRepairGuard(project, mutationGuard); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCliArguments(process.argv.slice(2), { project: { required: true }, input: { required: true }, timestamp: { required: false } });
    process.stdout.write(`${JSON.stringify(await renderFinal(options))}\n`);
  } catch (cause) {
    process.stdout.write(`${JSON.stringify(errorResult(cause))}\n`);
    process.exitCode = cause.code === 'E_USAGE' ? 2 : 1;
  }
}
