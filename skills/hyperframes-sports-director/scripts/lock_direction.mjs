#!/usr/bin/env node
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import {
  ApprovalError,
  compileApprovedDesign,
  compileApprovedLook,
  validateCommittedDirection,
  validateDirectorApproval,
} from './lib/approval.mjs';
import { computeArtifactDigest, loadSchema, validateDocument, verifyArtifactIntegrity } from './lib/contracts.mjs';
import { buildWorkbenchModel, renderWorkbenchHtml } from './lib/director-workbench.mjs';
import { projectPath, sha256File } from './lib/media.mjs';
import { commitDirectorLockState } from './lib/project-state.mjs';

const JOURNAL = 'cache/direction-lock.transaction.json';
const DESIGN = 'direction/DESIGN_SYSTEM.json';
const LOOK = 'direction/LOOK_PROFILE.json';
const STATE = 'PROJECT_STATE.json';
const DESIGN_TEMP = 'cache/.direction-design.tmp';
const LOOK_TEMP = 'cache/.direction-look.tmp';

async function syncDirectory(path) {
  const handle = await open(dirname(path), 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeDurable(path, bytes, flag = 'w') {
  const handle = await open(path, flag, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomic(path, bytes) {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeDurable(temporary, bytes, 'wx');
    await rename(temporary, path);
    await syncDirectory(path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function stampJournal(journal) {
  journal.integrity = { digest: null, upstream: {} };
  journal.integrity.digest = computeArtifactDigest(journal);
  return journal;
}

async function writeJournal(projectRoot, journal) {
  const path = projectPath(projectRoot, JOURNAL);
  await writeAtomic(path, `${JSON.stringify(stampJournal(journal), null, 2)}\n`);
}

async function createJournal(projectRoot, journal) {
  const path = projectPath(projectRoot, JOURNAL);
  try {
    await writeDurable(path, `${JSON.stringify(stampJournal(journal), null, 2)}\n`, 'wx');
    await syncDirectory(path);
  } catch (error) {
    if (error.code === 'EEXIST') throw new ApprovalError('E_LOCK_BUSY', 'another direction lock transaction is active');
    throw error;
  }
}

function ownerIsLive(ownerPid) {
  if (!Number.isInteger(ownerPid) || ownerPid < 1) return false;
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function readJournal(projectRoot) {
  try {
    const journal = JSON.parse(await readFile(projectPath(projectRoot, JOURNAL), 'utf8'));
    if (!verifyArtifactIntegrity(journal).valid) throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'direction lock journal has invalid integrity');
    return journal;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function inject(options, point) {
  if (options.injectFailure === point) throw new ApprovalError('E_INJECTED_FAILURE', `injected failure at ${point}`);
}

async function verifyCompiledPair(design, look) {
  for (const [value, schemaName] of [[design, 'design-system'], [look, 'look-profile']]) {
    const validation = validateDocument(await loadSchema(schemaName), value);
    if (!validation.valid || !verifyArtifactIntegrity(value).valid || value.status !== 'frozen') {
      throw new ApprovalError('E_DIRECTION_PAIR_INVALID', `compiled ${schemaName} is invalid`, { diagnostics: validation.errors });
    }
  }
  if (design.approvalDigest !== look.approvalDigest) throw new ApprovalError('E_DIRECTION_PAIR_MISMATCH', 'design and Look approval digests differ');
}

async function verifyPairOnDisk(projectRoot, journal) {
  const [design, look] = await Promise.all([
    JSON.parse(await readFile(projectPath(projectRoot, DESIGN), 'utf8')),
    JSON.parse(await readFile(projectPath(projectRoot, LOOK), 'utf8')),
  ]);
  await verifyCompiledPair(design, look);
  if (design.integrity.digest !== journal.designDigest || look.integrity.digest !== journal.lookDigest) {
    throw new ApprovalError('E_DIRECTION_PAIR_MISMATCH', 'renamed design and Look do not match the transaction journal');
  }
  return { design, look };
}

async function defaultRebuildWorkbench({ projectRoot, selectedCandidate, state }) {
  const model = await buildWorkbenchModel(projectRoot);
  const selected = model.proposals.candidates.find(({ candidateId }) => candidateId === selectedCandidate.candidateId);
  if (!selected) throw new ApprovalError('E_CANDIDATE_UNKNOWN', 'selected proposal disappeared before locked workbench rebuild');
  model.proposals.candidates = [selected];
  model.approvalAvailable = false;
  model.state = state;
  const html = renderWorkbenchHtml(model);
  const output = projectPath(projectRoot, 'review/director-workbench.html');
  await writeAtomic(output, html);
  return { digest: await sha256File(output) };
}

async function commitStateAndWorkbench(projectRoot, journal, pair, options) {
  const state = JSON.parse(await readFile(projectPath(projectRoot, STATE), 'utf8'));
  if (state.state !== 'DIRECTOR_REVIEW_READY') {
    if (state.state === 'DIRECTOR_LOCK') return validateCommittedDirection(projectRoot);
    throw new ApprovalError('E_APPROVAL_CONSUMED', 'direction approval is no longer consumable');
  }
  const approval = JSON.parse(await readFile(projectPath(projectRoot, 'direction/DIRECTOR_APPROVAL.json'), 'utf8'));
  const proposals = JSON.parse(await readFile(projectPath(projectRoot, 'direction/DIRECTION_PROPOSALS.json'), 'utf8'));
  const selectedCandidate = proposals.candidates.find(({ candidateId }) => candidateId === journal.selectedCandidateId);
  if (!selectedCandidate || approval.integrity.digest !== journal.approvalDigest) {
    throw new ApprovalError('E_LOCK_JOURNAL_STALE', 'transaction approval or selected proposal is stale');
  }
  const stateRevision = state.revision + 1;
  const projected = commitDirectorLockState(state, {
    DESIGN_SYSTEM: { revision: pair.design.revision, digest: pair.design.integrity.digest },
    LOOK_PROFILE: { revision: pair.look.revision, digest: pair.look.integrity.digest },
    DIRECTOR_APPROVAL: { revision: approval.revision, digest: approval.integrity.digest },
    WORKBENCH: { revision: stateRevision, digest: '0'.repeat(64) },
  }, { timestamp: journal.lockedAt, producerCommand: 'lock_direction.mjs' });
  projected.integrity.digest = computeArtifactDigest(projected);
  const rebuildWorkbench = options.rebuildWorkbench ?? defaultRebuildWorkbench;
  const workbench = await rebuildWorkbench({ projectRoot, selectedCandidate, state: projected });
  if (!/^[0-9a-f]{64}$/.test(workbench?.digest ?? '')) throw new ApprovalError('E_WORKBENCH_REBUILD', 'locked workbench must return its exact digest');
  const committed = commitDirectorLockState(state, {
    DESIGN_SYSTEM: { revision: pair.design.revision, digest: pair.design.integrity.digest },
    LOOK_PROFILE: { revision: pair.look.revision, digest: pair.look.integrity.digest },
    DIRECTOR_APPROVAL: { revision: approval.revision, digest: approval.integrity.digest },
    WORKBENCH: { revision: stateRevision, digest: workbench.digest },
  }, { timestamp: journal.lockedAt, producerCommand: 'lock_direction.mjs' });
  committed.integrity.digest = computeArtifactDigest(committed);
  const stateValidation = validateDocument(await loadSchema('project-state'), committed);
  if (!stateValidation.valid) throw new ApprovalError('E_STATE_INVALID', 'DIRECTOR_LOCK state commit is invalid', { diagnostics: stateValidation.errors });
  await writeAtomic(projectPath(projectRoot, STATE), `${JSON.stringify(committed, null, 2)}\n`);
  const persisted = JSON.parse(await readFile(projectPath(projectRoot, STATE), 'utf8'));
  if (!verifyArtifactIntegrity(persisted).valid || persisted.state !== 'DIRECTOR_LOCK'
    || persisted.transitions.at(-1).evidenceDigests.DESIGN_SYSTEM !== pair.design.integrity.digest
    || persisted.transitions.at(-1).evidenceDigests.LOOK_PROFILE !== pair.look.integrity.digest) {
    throw new ApprovalError('E_STATE_COMMIT', 'persisted DIRECTOR_LOCK state does not bind the matching pair');
  }
  return { state: persisted, workbenchDigest: workbench.digest, selectedCandidate };
}

async function rollbackJournal(projectRoot, journal) {
  await Promise.all([
    writeAtomic(projectPath(projectRoot, DESIGN), `${JSON.stringify(journal.priorDesign, null, 2)}\n`),
    writeAtomic(projectPath(projectRoot, LOOK), `${JSON.stringify(journal.priorLook, null, 2)}\n`),
  ]);
  await Promise.all([
    unlink(projectPath(projectRoot, DESIGN_TEMP)).catch(() => {}),
    unlink(projectPath(projectRoot, LOOK_TEMP)).catch(() => {}),
    unlink(projectPath(projectRoot, JOURNAL)).catch(() => {}),
  ]);
}

async function recoverDirectionLock(projectRoot, options) {
  const journal = await readJournal(projectRoot);
  if (!journal) {
    await Promise.all([
      unlink(projectPath(projectRoot, DESIGN_TEMP)).catch(() => {}),
      unlink(projectPath(projectRoot, LOOK_TEMP)).catch(() => {}),
    ]);
    return null;
  }
  if (ownerIsLive(journal.ownerPid)) throw new ApprovalError('E_LOCK_BUSY', 'another direction lock transaction is active');
  if (journal.phase === 'pair-renamed') {
    const pair = await verifyPairOnDisk(projectRoot, journal);
    const committed = await commitStateAndWorkbench(projectRoot, journal, pair, options);
    await unlink(projectPath(projectRoot, JOURNAL));
    return { ok: true, recovered: true, designDigest: pair.design.integrity.digest, lookDigest: pair.look.integrity.digest, ...committed };
  }
  if (journal.phase === 'committed') {
    const committed = await validateCommittedDirection(projectRoot);
    await unlink(projectPath(projectRoot, JOURNAL));
    return { ok: true, recovered: true, designDigest: committed.design.integrity.digest, lookDigest: committed.look.integrity.digest, state: committed.state, workbenchDigest: committed.workbenchDigest };
  }
  await rollbackJournal(projectRoot, journal);
  return null;
}

export async function lockDirection(projectRoot, options = {}) {
  // Resolve every configurable destination before touching artifacts.
  const designPath = projectPath(projectRoot, options.designPath ?? DESIGN);
  const lookPath = projectPath(projectRoot, options.lookPath ?? LOOK);
  const statePath = projectPath(projectRoot, options.statePath ?? STATE);
  if (designPath !== projectPath(projectRoot, DESIGN) || lookPath !== projectPath(projectRoot, LOOK) || statePath !== projectPath(projectRoot, STATE)) {
    throw new ApprovalError('E_LOCK_DESTINATION', 'v1 lock destinations are fixed project contracts');
  }
  const recovered = await recoverDirectionLock(projectRoot, options);
  if (recovered) return recovered;
  const validated = await validateDirectorApproval(projectRoot);
  const lockedAt = (options.now ?? (() => new Date().toISOString()))();
  if (!Number.isFinite(Date.parse(lockedAt))) throw new ApprovalError('E_LOCK_TIME', 'lock timestamp must be ISO-8601');
  const design = compileApprovedDesign(validated.draftDesign, validated.selectedCandidate, validated.approval, lockedAt);
  const look = compileApprovedLook(validated.draftLook, validated.selectedCandidate, validated.approval, lockedAt);
  await verifyCompiledPair(design, look);
  const journal = {
    schemaVersion: '1.0.0', phase: 'preparing', ownerPid: process.pid, lockedAt,
    selectedCandidateId: validated.selectedCandidate.candidateId,
    approvalDigest: validated.approval.integrity.digest,
    designDigest: design.integrity.digest, lookDigest: look.integrity.digest,
    priorDesign: validated.draftDesign, priorLook: validated.draftLook,
    integrity: { digest: null, upstream: {} },
  };
  let ownsJournal = false;
  try {
    await createJournal(projectRoot, journal);
    ownsJournal = true;
    await Promise.all([
      writeDurable(projectPath(projectRoot, DESIGN_TEMP), `${JSON.stringify(design, null, 2)}\n`, 'wx'),
      writeDurable(projectPath(projectRoot, LOOK_TEMP), `${JSON.stringify(look, null, 2)}\n`, 'wx'),
    ]);
    journal.phase = 'temps-written';
    await writeJournal(projectRoot, journal);
    inject(options, 'afterTemporaryWrites');
    await rename(projectPath(projectRoot, DESIGN_TEMP), designPath);
    await syncDirectory(designPath);
    journal.phase = 'design-renamed';
    await writeJournal(projectRoot, journal);
    inject(options, 'afterFirstRename');
    await rename(projectPath(projectRoot, LOOK_TEMP), lookPath);
    await syncDirectory(lookPath);
    journal.phase = 'pair-renamed';
    await writeJournal(projectRoot, journal);
    const pair = await verifyPairOnDisk(projectRoot, journal);
    inject(options, 'beforeStateCommit');
    const committed = await commitStateAndWorkbench(projectRoot, journal, pair, options);
    journal.phase = 'committed';
    await writeJournal(projectRoot, journal);
    await unlink(projectPath(projectRoot, JOURNAL));
    ownsJournal = false;
    return {
      ok: true, recovered: false,
      selectedCandidateId: validated.selectedCandidate.candidateId,
      designDigest: design.integrity.digest, lookDigest: look.integrity.digest,
      stateRevision: committed.state.revision, workbenchDigest: committed.workbenchDigest,
    };
  } catch (error) {
    if (ownsJournal) {
      journal.ownerPid = null;
      await writeJournal(projectRoot, journal).catch(() => {});
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { project } = parseCliArguments(process.argv.slice(2), { project: { required: true } });
    process.stdout.write(`${JSON.stringify(await lockDirection(project))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
