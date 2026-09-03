import { readFile, rename, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { buildPostLockWorkbench, validateCommittedDirection } from './lib/approval.mjs';
import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest, loadSchema, validateArtifact, validateDocument } from './lib/contracts.mjs';
import { loadEditorialEvidence } from './lib/editorial-evidence.mjs';
import { acquireRepairGuard, releaseRepairGuard } from './lib/invalidation.mjs';
import { projectPath, writeJsonAtomic } from './lib/media.mjs';
import { compileFinalRenderPlan, commitCancelledRenderState, commitFinalRenderState, executeFinalRenderPlan } from './lib/render.mjs';
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

const TRANSACTION_ID = /^[0-9a-f]{32}$/;

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function ownedTransactionPaths(transactionId) {
  return {
    candidate: `renders/.final-render.${transactionId}.candidate.mp4`,
    pendingProvenance: `renders/.final-render.${transactionId}.provenance.pending.json`,
    final: 'renders/final.mp4',
    finalProvenance: 'renders/final.provenance.json',
    state: 'PROJECT_STATE.json',
  };
}

function validateJournalPaths(journal) {
  if (!TRANSACTION_ID.test(journal?.transactionId ?? '')
    || !exactKeys(journal?.paths, ['candidate', 'pendingProvenance', 'final', 'finalProvenance', 'state'])) {
    fail('E_FINAL_TRANSACTION_PATH', 'final render transaction paths are invalid');
  }
  const expected = ownedTransactionPaths(journal.transactionId);
  if (Object.keys(expected).some((key) => journal.paths[key] !== expected[key])) {
    fail('E_FINAL_TRANSACTION_PATH', 'final render transaction paths are not owned by this transaction');
  }
  return expected;
}

async function validateJournal(journal) {
  if (!exactKeys(journal, ['kind', 'schemaVersion', 'transactionId', 'phase', 'paths', 'previousState', 'nextState', 'integrity'])
    || journal.kind !== 'final-render-transaction' || journal.schemaVersion !== '1.0.0' || journal.phase !== 'prepared'
    || !exactKeys(journal.integrity, ['digest', 'upstream']) || !exactKeys(journal.integrity.upstream, ['renderProvenance'])
    || journal.integrity.digest !== computeArtifactDigest(journal)) fail('E_FINAL_TRANSACTION', 'final render transaction journal is invalid');
  const schema = await loadSchema('project-state');
  for (const [name, state] of [['previousState', journal.previousState], ['nextState', journal.nextState]]) {
    const result = validateDocument(schema, state);
    if (!result.valid || state.integrity?.digest !== computeArtifactDigest(state)) fail('E_FINAL_TRANSACTION_STATE', `${name} is not an integrity-valid project state`, result.errors);
  }
  const transition = journal.nextState.transitions?.at(-1);
  const evidence = journal.nextState.gateEvidence?.findLast(({ gate, role, validity }) => gate === 'FINAL_RENDER' && role === 'FINAL_RENDER' && validity === 'valid');
  const provenanceDigest = journal.integrity.upstream.renderProvenance;
  if (journal.previousState.state !== 'MOTION_COMPOSITION' || journal.nextState.state !== 'FINAL_RENDER'
    || journal.nextState.previousState !== 'MOTION_COMPOSITION' || journal.nextState.revision !== journal.previousState.revision + 1
    || transition?.from !== 'MOTION_COMPOSITION' || transition?.to !== 'FINAL_RENDER'
    || transition.evidenceDigests?.FINAL_RENDER !== provenanceDigest || evidence?.digest !== provenanceDigest) {
    fail('E_FINAL_TRANSACTION_STATE', 'journal states do not describe the exact prepared FINAL_RENDER transition');
  }
}

export async function recoverFinalRenderTransaction(project, mutationGuard, dependencies = {}) {
  const journalPath = projectPath(project, 'cache/final-render.transaction.json');
  const journal = await readOptional(journalPath);
  if (!journal) return;
  const paths = validateJournalPaths(journal);
  await validateJournal(journal);
  const currentState = await (dependencies.loadCurrentState ?? (() => current(project, 'PROJECT_STATE.json', 'project-state')))();
  const currentDigest = currentState?.integrity?.digest;
  if (![journal.previousState.integrity.digest, journal.nextState.integrity.digest].includes(currentDigest)) {
    fail('E_FINAL_TRANSACTION_CONFLICT', 'current project state is newer than the prepared final-render transaction');
  }
  await writeJsonAtomic(projectPath(project, 'PROJECT_STATE.json'), journal.previousState);
  await Promise.all([paths.final, paths.finalProvenance, paths.candidate, paths.pendingProvenance]
    .map((path) => unlink(projectPath(project, path)).catch(() => {})));
  await (dependencies.rebuildWorkbench ?? buildPostLockWorkbench)(project, { mutationGuard });
  await unlink(journalPath);
}

export async function renderFinal({ project, input, timestamp = new Date().toISOString(), signal, session }) {
  if (!input) fail('E_INPUT_REQUIRED', 'final rendering requires the immutable input root');
  const mutationGuard = await acquireRepairGuard(project);
  const statePath = projectPath(project, 'PROJECT_STATE.json');
  const journalPath = projectPath(project, 'cache/final-render.transaction.json');
  let publication;
  let evidence;
  try {
    await recoverFinalRenderTransaction(project, mutationGuard);
    let committed; let editBrief; let sceneSchema;
    [evidence, committed, editBrief, sceneSchema] = await Promise.all([
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
      motionMap: evidence.motionMap, sceneSchema, dataOverlays: evidence.dataOverlays, activity: evidence.activity,
      syncMap: evidence.syncMap, timeline: evidence.timeline, projectState: evidence.projectState,
    });
    publication = await executeFinalRenderPlan(plan, { publish: false, signal, session });
    const nextState = commitFinalRenderState(evidence.projectState, publication.provenance, timestamp);
    nextState.integrity.digest = computeArtifactDigest(nextState);
    const stateContract = validateDocument(await loadSchema('project-state'), nextState);
    if (!stateContract.valid) fail('E_FINAL_STATE_CONTRACT', 'FINAL_RENDER state violates the project contract', stateContract.errors);
    const journal = {
      kind: 'final-render-transaction', schemaVersion: '1.0.0', transactionId: publication.transactionId, phase: 'prepared',
      paths: ownedTransactionPaths(publication.transactionId), previousState: evidence.projectState, nextState,
      integrity: { digest: null, upstream: { renderProvenance: publication.provenance.integrity.digest } },
    };
    journal.integrity.digest = computeArtifactDigest(journal);
    await writeJsonAtomic(journalPath, journal);
    try {
      await rename(projectPath(project, journal.paths.candidate), projectPath(project, journal.paths.final));
      await rename(projectPath(project, journal.paths.pendingProvenance), projectPath(project, journal.paths.finalProvenance));
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
    if (cause.code === 'E_RENDER_CANCELLED' && evidence?.projectState?.state === 'MOTION_COMPOSITION') {
      const cancelled = commitCancelledRenderState(evidence.projectState, timestamp);
      cancelled.integrity.digest = computeArtifactDigest(cancelled);
      const contract = validateDocument(await loadSchema('project-state'), cancelled);
      if (!contract.valid) fail('E_RENDER_CANCELLED_STATE', 'cancelled render state violates the project contract', contract.errors);
      await writeJsonAtomic(statePath, cancelled);
      await buildPostLockWorkbench(project, { mutationGuard });
    }
    throw cause;
  } finally { await releaseRepairGuard(project, mutationGuard); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const options = parseCliArguments(process.argv.slice(2), { project: { required: true }, input: { required: true }, timestamp: { required: false } });
    process.stdout.write(`${JSON.stringify(await renderFinal({ ...options, signal: controller.signal }))}\n`);
  } catch (cause) {
    process.stdout.write(`${JSON.stringify(errorResult(cause))}\n`);
    process.exitCode = cause.code === 'E_USAGE' ? 2 : 1;
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
