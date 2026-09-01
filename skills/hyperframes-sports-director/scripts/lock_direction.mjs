#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { ApprovalError, compileApprovedDesign, compileApprovedLook, LOCK_WORKBENCH_SNAPSHOT_PATH, renderLockedWorkbench, revalidateDirectorApprovalInputs, validateCommittedDirection, validateDirectorApproval } from './lib/approval.mjs';
import { computeArtifactDigest, loadSchema, validateDocument, verifyArtifactIntegrity } from './lib/contracts.mjs';
import { buildWorkbenchModel } from './lib/director-workbench.mjs';
import { projectPath } from './lib/media.mjs';
import { commitDirectorLockState } from './lib/project-state.mjs';

const PATHS = Object.freeze({ journal: 'cache/direction-lock.transaction.json', guard: 'cache/direction-lock.guard.json', design: 'direction/DESIGN_SYSTEM.json', look: 'direction/LOOK_PROFILE.json', state: 'PROJECT_STATE.json', approval: 'direction/DIRECTOR_APPROVAL.json', proposals: 'direction/DIRECTION_PROPOSALS.json', workbench: 'review/director-workbench.html', snapshot: LOCK_WORKBENCH_SNAPSHOT_PATH });
const PHASES = new Set(['validated', 'temps-written', 'design-renamed', 'pair-renamed', 'workbench-staged', 'state-intent', 'state-renamed', 'workbench-published', 'committed']);

async function syncDirectory(path) { const handle = await open(dirname(path), 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function writeDurable(path, bytes, flag = 'w') { const handle = await open(path, flag, 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); } }
async function readRegularFile(path, code, message) {
  let observed; let handle;
  try {
    observed = await lstat(path);
    if (!observed.isFile() || observed.isSymbolicLink()) throw new ApprovalError(code, message);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== observed.dev || opened.ino !== observed.ino) throw new ApprovalError(code, message);
    const bytes = await handle.readFile();
    return { bytes, metadata: opened };
  } catch (error) {
    if (error instanceof ApprovalError) throw error;
    throw new ApprovalError(code, message, { cause: error });
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}
async function writeAtomic(path, bytes, token = randomBytes(16).toString('hex')) {
  const temporary = `${path}.${process.pid}.${token}.tmp`;
  try { await writeDurable(temporary, bytes, 'wx'); await rename(temporary, path); await syncDirectory(path); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}
function stamp(value) { value.integrity = { digest: null, upstream: {} }; value.integrity.digest = computeArtifactDigest(value); return value; }
async function processStartIdentity(pid) { try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).trim().split(' ')[21] ?? null; } catch { return null; } }
async function ownerLive(owner) { return owner?.active === true && await processStartIdentity(owner.pid) === owner.processStartId; }
function exactKeys(value, keys) { const actual = Object.keys(value ?? {}).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]); }
function validateOwner(owner, { requireActive = false } = {}) {
  return exactKeys(owner, ['token', 'pid', 'processStartId', 'active'])
    && /^[0-9a-f]{64}$/.test(owner.token ?? '') && Number.isInteger(owner.pid) && owner.pid > 0
    && typeof owner.processStartId === 'string' && owner.processStartId.length > 0
    && typeof owner.active === 'boolean' && (!requireActive || owner.active === true);
}
function validateGuard(value) {
  return verifyArtifactIntegrity(value).valid && exactKeys(value, ['schemaVersion', 'owner', 'integrity'])
    && value.schemaVersion === '1.0.0' && validateOwner(value.owner, { requireActive: true });
}
async function acquireTakeoverMutex(path, owner, hooks = {}) {
  const bytes = () => `${JSON.stringify(stamp({ schemaVersion: '1.0.0', owner, integrity: { digest: null, upstream: {} } }), null, 2)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { await writeDurable(path, bytes(), 'wx'); await syncDirectory(path); return owner; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = JSON.parse(await readFile(path, 'utf8')); } catch { throw new ApprovalError('E_LOCK_BUSY', 'direction lock takeover mutex is unreadable'); }
      if (!validateGuard(existing) || await ownerLive(existing.owner)) throw new ApprovalError('E_LOCK_BUSY', 'another direction lock takeover is active');
      if (hooks.beforeTakeoverMutexClaim) await hooks.beforeTakeoverMutexClaim();
      let current;
      try { current = JSON.parse(await readFile(path, 'utf8')); } catch { throw new ApprovalError('E_LOCK_BUSY', 'direction lock takeover mutex changed'); }
      if (!validateGuard(current) || current.integrity.digest !== existing.integrity.digest) throw new ApprovalError('E_LOCK_BUSY', 'direction lock takeover mutex changed');
      const claim = `${path}.claim.${owner.token}`;
      await rename(path, claim); await syncDirectory(path);
      const claimed = JSON.parse(await readFile(claim, 'utf8'));
      if (!validateGuard(claimed) || claimed.integrity.digest !== existing.integrity.digest) throw new ApprovalError('E_LOCK_BUSY', 'direction lock takeover mutex claim changed');
      await unlink(claim); await syncDirectory(claim);
    }
  }
  throw new ApprovalError('E_LOCK_BUSY', 'direction lock takeover mutex recovery lost a race');
}
async function releaseTakeoverMutex(path, owner) {
  try {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (!validateGuard(current) || current.owner.token !== owner.token) throw new ApprovalError('E_LOCK_BUSY', 'direction lock takeover mutex ownership changed');
    await unlink(path); await syncDirectory(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function acquireGuard(projectRoot, hooks = {}) {
  const path = projectPath(projectRoot, PATHS.guard);
  const owner = { token: randomBytes(32).toString('hex'), pid: process.pid, processStartId: await processStartIdentity(process.pid), active: true };
  if (!owner.processStartId) throw new ApprovalError('E_LOCK_OWNER', 'process start identity is unavailable');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeDurable(path, `${JSON.stringify(stamp({ schemaVersion: '1.0.0', owner, integrity: { digest: null, upstream: {} } }), null, 2)}\n`, 'wx'); await syncDirectory(path);
      const acquired = JSON.parse(await readFile(path, 'utf8'));
      if (!validateGuard(acquired) || acquired.owner.token !== owner.token) throw new ApprovalError('E_LOCK_BUSY', 'direction lock guard ownership changed after acquisition');
      return owner;
    }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = JSON.parse(await readFile(path, 'utf8')); } catch { throw new ApprovalError('E_LOCK_GUARD_INVALID', 'direction lock guard is unreadable'); }
      if (!validateGuard(existing)) throw new ApprovalError('E_LOCK_GUARD_INVALID', 'direction lock guard is structurally invalid');
      if (await ownerLive(existing.owner)) throw new ApprovalError('E_LOCK_BUSY', 'another direction lock transaction is active');
      const mutex = `${path}.takeover`; const claim = `${path}.claim.${owner.token}`;
      const mutexOwner = await acquireTakeoverMutex(mutex, owner, hooks);
      try {
        if (hooks.beforeTakeoverClaim) await hooks.beforeTakeoverClaim();
        let current;
        try { current = JSON.parse(await readFile(path, 'utf8')); } catch { throw new ApprovalError('E_LOCK_BUSY', 'direction lock guard changed during takeover'); }
        if (!validateGuard(current) || current.integrity.digest !== existing.integrity.digest) throw new ApprovalError('E_LOCK_BUSY', 'direction lock guard changed during takeover');
        await rename(path, claim); await syncDirectory(path);
        const claimed = JSON.parse(await readFile(claim, 'utf8'));
        if (!validateGuard(claimed) || claimed.integrity.digest !== existing.integrity.digest) {
          await rename(claim, path).catch(() => {});
          throw new ApprovalError('E_LOCK_BUSY', 'direction lock takeover claim changed');
        }
        await writeDurable(path, `${JSON.stringify(stamp({ schemaVersion: '1.0.0', owner, integrity: { digest: null, upstream: {} } }), null, 2)}\n`, 'wx'); await syncDirectory(path);
        const acquired = JSON.parse(await readFile(path, 'utf8'));
        if (!validateGuard(acquired) || acquired.owner.token !== owner.token) throw new ApprovalError('E_LOCK_BUSY', 'direction lock guard ownership changed after takeover');
        await unlink(claim); await syncDirectory(claim);
        return owner;
      } finally {
        await releaseTakeoverMutex(mutex, mutexOwner);
      }
    }
  }
  throw new ApprovalError('E_LOCK_BUSY', 'direction lock guard takeover lost a race');
}
async function releaseGuard(projectRoot, owner) {
  const path = projectPath(projectRoot, PATHS.guard);
  try { const current = JSON.parse(await readFile(path, 'utf8')); if (current.owner?.token === owner.token) { await unlink(path); await syncDirectory(path); } } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function validateJournal(projectRoot, journal) {
  const keys = ['schemaVersion', 'transactionId', 'owner', 'phase', 'lockedAt', 'selectedCandidate', 'approvalDigest', 'inputDigests', 'designDigest', 'lookDigest', 'priorDesign', 'priorLook', 'priorState', 'designTemp', 'lookTemp', 'workbenchTemp', 'snapshotPath', 'lockedHtml', 'integrity'];
  const inputKeys = ['approval', 'proposals', 'state', 'editBrief', 'mediaIndex', 'probe', 'segments', 'shots', 'dataOverlays', 'timeline', 'roughCut', 'workbench', 'evidenceFiles', 'bundleFiles', 'musicFiles', 'previewFiles', 'draftDesign', 'draftLook'];
  if (!verifyArtifactIntegrity(journal).valid || !exactKeys(journal, keys) || !validateOwner(journal.owner) || !exactKeys(journal.inputDigests, inputKeys) || Object.values(journal.inputDigests).some((digest) => !/^[0-9a-f]{64}$/.test(digest)) || journal.schemaVersion !== '1.0.0' || !/^[0-9a-f]{32}$/.test(journal.transactionId ?? '') || !PHASES.has(journal.phase) || !Number.isFinite(Date.parse(journal.lockedAt)) || journal.approvalDigest !== journal.inputDigests.approval || !/^[0-9a-f]{64}$/.test(journal.designDigest ?? '') || !/^[0-9a-f]{64}$/.test(journal.lookDigest ?? '') || !journal.selectedCandidate?.wholeDirection || (['validated', 'temps-written', 'design-renamed', 'pair-renamed'].includes(journal.phase) ? journal.lockedHtml !== null : typeof journal.lockedHtml !== 'string')) throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'direction lock journal is structurally invalid');
  for (const [value, schemaName] of [[journal.priorDesign, 'design-system'], [journal.priorLook, 'look-profile']]) {
    const validation = validateDocument(await loadSchema(schemaName), value);
    if (!validation.valid || !verifyArtifactIntegrity(value).valid || value.status !== 'draft') throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'journal prior contract is invalid');
  }
  if (journal.priorDesign.integrity.digest !== journal.inputDigests.draftDesign || journal.priorLook.integrity.digest !== journal.inputDigests.draftLook) throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'journal prior contracts do not match validated inputs');
  const stateValidation = validateDocument(await loadSchema('project-state'), journal.priorState);
  if (!stateValidation.valid || !verifyArtifactIntegrity(journal.priorState).valid || journal.priorState.state !== 'DIRECTOR_REVIEW_READY' || journal.priorState.integrity.digest !== journal.inputDigests.state) throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'journal prior state is invalid');
  if (journal.designTemp !== `cache/.direction-design.${journal.transactionId}.tmp` || journal.lookTemp !== `cache/.direction-look.${journal.transactionId}.tmp` || journal.workbenchTemp !== `cache/.direction-workbench.${journal.transactionId}.tmp` || journal.snapshotPath !== PATHS.snapshot) throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'journal temporary and immutable snapshot paths are not transaction-owned');
  return journal;
}
async function readJournal(projectRoot) {
  try { return await validateJournal(projectRoot, JSON.parse(await readFile(projectPath(projectRoot, PATHS.journal), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writeJournal(projectRoot, journal, create = false) {
  const bytes = `${JSON.stringify(stamp(journal), null, 2)}\n`; const path = projectPath(projectRoot, PATHS.journal);
  if (create) { try { await writeDurable(path, bytes, 'wx'); await syncDirectory(path); } catch (error) { if (error.code === 'EEXIST') throw new ApprovalError('E_LOCK_BUSY', 'another direction lock journal exists'); throw error; } }
  else await writeAtomic(path, bytes, journal.transactionId);
}
function inject(options, point) { if (options.injectFailure === point) throw new ApprovalError('E_INJECTED_FAILURE', `injected failure at ${point}`); }

async function verifyPair(projectRoot, journal) {
  const [design, look] = await Promise.all([readFile(projectPath(projectRoot, PATHS.design), 'utf8').then(JSON.parse), readFile(projectPath(projectRoot, PATHS.look), 'utf8').then(JSON.parse)]);
  for (const [value, schemaName, digest] of [[design, 'design-system', journal.designDigest], [look, 'look-profile', journal.lookDigest]]) {
    const validation = validateDocument(await loadSchema(schemaName), value);
    if (!validation.valid || !verifyArtifactIntegrity(value).valid || value.status !== 'frozen' || value.integrity.digest !== digest) throw new ApprovalError('E_DIRECTION_PAIR_INVALID', 'transaction pair is invalid or mismatched');
  }
  if (design.approvalDigest !== journal.approvalDigest || look.approvalDigest !== journal.approvalDigest) throw new ApprovalError('E_DIRECTION_PAIR_MISMATCH', 'transaction pair approval origins differ');
  const selectedDigest = computeArtifactDigest(journal.selectedCandidate);
  if (design.selectedDirection?.digest !== selectedDigest || computeArtifactDigest(design.selectedDirection?.candidate) !== selectedDigest || look.directionBinding?.candidateDigest !== selectedDigest || design.integrity.upstream.proposal !== journal.inputDigests.proposals || look.integrity.upstream.proposal !== journal.inputDigests.proposals) throw new ApprovalError('E_DIRECTION_PAIR_MISMATCH', 'transaction pair does not bind its exact validated selected proposal');
  return { design, look };
}

function projectedState(state, journal, pair, approval, workbenchDigest) {
  const revision = state.revision + 1;
  const result = commitDirectorLockState(state, { DESIGN_SYSTEM: { revision: pair.design.revision, digest: pair.design.integrity.digest }, LOOK_PROFILE: { revision: pair.look.revision, digest: pair.look.integrity.digest }, DIRECTOR_APPROVAL: { revision: approval.revision, digest: approval.integrity.digest }, WORKBENCH: { revision, digest: workbenchDigest } }, { timestamp: journal.lockedAt, producerCommand: 'lock_direction.mjs' });
  result.integrity.digest = computeArtifactDigest(result); return result;
}

async function assertSnapshotAbsent(projectRoot) {
  try {
    await lstat(join(projectRoot, PATHS.snapshot));
    throw new ApprovalError('E_LOCK_SNAPSHOT_EXISTS', 'immutable direction-lock workbench snapshot already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function publishSnapshotAndCurrent(projectRoot, journal) {
  const tempPath = join(projectRoot, journal.workbenchTemp);
  const snapshotPath = join(projectRoot, journal.snapshotPath);
  const currentPath = join(projectRoot, PATHS.workbench);
  let staged;
  try {
    staged = await readRegularFile(tempPath, 'E_LOCK_JOURNAL_INVALID', 'staged workbench is not a regular transaction-owned file');
    if (!staged.bytes.equals(Buffer.from(journal.lockedHtml))) throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'staged workbench bytes changed after state commit');
    await writeDurable(snapshotPath, staged.bytes, 'wx');
    await syncDirectory(snapshotPath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.cause?.code === 'ENOENT') {
      const [snapshot, current] = await Promise.all([
        readRegularFile(snapshotPath, 'E_LOCK_JOURNAL_INVALID', 'published snapshot is not a regular file'),
        readRegularFile(currentPath, 'E_LOCK_JOURNAL_INVALID', 'published current workbench is not a regular file'),
      ]);
      if (!snapshot.bytes.equals(Buffer.from(journal.lockedHtml)) || !current.bytes.equals(Buffer.from(journal.lockedHtml))
        || (snapshot.metadata.dev === current.metadata.dev && snapshot.metadata.ino === current.metadata.ino)) {
        throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'published workbench bytes or inode isolation changed after state commit');
      }
      return;
    }
    if (error.code !== 'EEXIST') throw error;
    const existing = await readRegularFile(snapshotPath, 'E_LOCK_SNAPSHOT_EXISTS', 'immutable direction-lock snapshot is not a regular file');
    if (!existing.bytes.equals(Buffer.from(journal.lockedHtml))) throw new ApprovalError('E_LOCK_SNAPSHOT_EXISTS', 'immutable direction-lock snapshot bytes differ from the journal');
  }
  try {
    staged ??= await readRegularFile(tempPath, 'E_LOCK_JOURNAL_INVALID', 'staged workbench is not a regular transaction-owned file');
    await rename(tempPath, currentPath);
    await syncDirectory(currentPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const current = await readRegularFile(currentPath, 'E_LOCK_JOURNAL_INVALID', 'published current workbench is not a regular file');
    if (!current.bytes.equals(Buffer.from(journal.lockedHtml))) throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'published current workbench differs from the immutable lock snapshot');
  }
  const [snapshot, current] = await Promise.all([
    readRegularFile(snapshotPath, 'E_LOCK_JOURNAL_INVALID', 'published snapshot is not a regular file'),
    readRegularFile(currentPath, 'E_LOCK_JOURNAL_INVALID', 'published current workbench is not a regular file'),
  ]);
  if (!snapshot.bytes.equals(Buffer.from(journal.lockedHtml)) || !current.bytes.equals(Buffer.from(journal.lockedHtml))
    || (snapshot.metadata.dev === current.metadata.dev && snapshot.metadata.ino === current.metadata.ino)) {
    throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'published workbench bytes or inode isolation are invalid');
  }
}

async function stageAndCommit(projectRoot, journal, pair, options) {
  const [state, approval] = await Promise.all([readFile(projectPath(projectRoot, PATHS.state), 'utf8').then(JSON.parse), readFile(projectPath(projectRoot, PATHS.approval), 'utf8').then(JSON.parse)]);
  if (state.state !== 'DIRECTOR_REVIEW_READY' || approval.integrity.digest !== journal.approvalDigest) throw new ApprovalError('E_LOCK_JOURNAL_STALE', 'state or approval changed during lock');
  let html = journal.lockedHtml;
  if (journal.phase === 'pair-renamed') {
    const placeholder = projectedState(state, journal, pair, approval, '0'.repeat(64));
    const model = await buildWorkbenchModel(projectRoot);
    const canonicalHtml = renderLockedWorkbench(placeholder, journal.selectedCandidate, model);
    const built = options.rebuildWorkbench ? await options.rebuildWorkbench({ projectRoot, selectedCandidate: journal.selectedCandidate, state: placeholder, model, canonicalHtml }) : { html: canonicalHtml };
    html = typeof built === 'string' ? built : built?.html;
    if (html !== canonicalHtml) throw new ApprovalError('E_WORKBENCH_REBUILD', 'locked workbench builder must return the canonical state-bound bytes');
    await writeDurable(join(projectRoot, journal.workbenchTemp), html, 'wx'); journal.lockedHtml = html; journal.phase = 'workbench-staged'; await writeJournal(projectRoot, journal);
  } else {
    const staged = await readRegularFile(join(projectRoot, journal.workbenchTemp), 'E_LOCK_JOURNAL_INVALID', 'staged workbench is not a regular transaction-owned file');
    if (typeof html !== 'string' || !staged.bytes.equals(Buffer.from(html))) throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'staged locked workbench does not match its journal');
  }
  const currentAuthority = await revalidateDirectorApprovalInputs(projectRoot, journal.inputDigests);
  if (computeArtifactDigest(currentAuthority.selectedCandidate) !== computeArtifactDigest(journal.selectedCandidate)) throw new ApprovalError('E_LOCK_JOURNAL_STALE', 'journal selected candidate no longer matches current approval');
  const staged = await readRegularFile(join(projectRoot, journal.workbenchTemp), 'E_LOCK_JOURNAL_INVALID', 'staged workbench is not a regular transaction-owned file');
  const digest = createHash('sha256').update(staged.bytes).digest('hex'); const committed = projectedState(state, journal, pair, approval, digest);
  const validation = validateDocument(await loadSchema('project-state'), committed); if (!validation.valid) throw new ApprovalError('E_STATE_INVALID', 'DIRECTOR_LOCK state is schema-invalid', { diagnostics: validation.errors });
  await assertSnapshotAbsent(projectRoot);
  journal.phase = 'state-intent'; await writeJournal(projectRoot, journal);
  await writeAtomic(projectPath(projectRoot, PATHS.state), `${JSON.stringify(committed, null, 2)}\n`, journal.transactionId); inject(options, 'afterStateRenameBeforeJournal');
  journal.phase = 'state-renamed'; await writeJournal(projectRoot, journal); inject(options, 'afterStateCommit');
  await publishSnapshotAndCurrent(projectRoot, journal); journal.phase = 'workbench-published'; await writeJournal(projectRoot, journal);
  const verified = await validateCommittedDirection(projectRoot); return { state: verified.state, workbenchDigest: verified.workbenchDigest };
}

async function rollback(projectRoot, journal) {
  await writeAtomic(projectPath(projectRoot, PATHS.design), `${JSON.stringify(journal.priorDesign, null, 2)}\n`, journal.transactionId);
  await writeAtomic(projectPath(projectRoot, PATHS.look), `${JSON.stringify(journal.priorLook, null, 2)}\n`, journal.transactionId);
  for (const path of [journal.designTemp, journal.lookTemp, journal.workbenchTemp, PATHS.journal]) await unlink(projectPath(projectRoot, path)).catch(() => {});
  await syncDirectory(projectPath(projectRoot, PATHS.journal));
}

async function recover(projectRoot, options) {
  const journal = await readJournal(projectRoot); if (!journal) return null;
  if (journal.owner.active && await ownerLive(journal.owner)) throw new ApprovalError('E_LOCK_BUSY', 'a live journal owner is active');
  if (['validated', 'temps-written', 'design-renamed'].includes(journal.phase)) { await rollback(projectRoot, journal); return null; }
  if (journal.phase === 'pair-renamed') {
    const committed = await stageAndCommit(projectRoot, journal, await verifyPair(projectRoot, journal), options);
    await unlink(projectPath(projectRoot, PATHS.journal)); await syncDirectory(projectPath(projectRoot, PATHS.journal));
    return { ok: true, recovered: true, designDigest: journal.designDigest, lookDigest: journal.lookDigest, ...committed };
  }
  if (['workbench-staged', 'state-intent', 'state-renamed'].includes(journal.phase)) {
    const state = JSON.parse(await readFile(projectPath(projectRoot, PATHS.state), 'utf8'));
    if (state.state === 'DIRECTOR_REVIEW_READY') {
      const committed = await stageAndCommit(projectRoot, journal, await verifyPair(projectRoot, journal), options);
      await unlink(projectPath(projectRoot, PATHS.journal)); await syncDirectory(projectPath(projectRoot, PATHS.journal));
      return { ok: true, recovered: true, designDigest: journal.designDigest, lookDigest: journal.lookDigest, ...committed };
    }
    const [pair, approval] = await Promise.all([verifyPair(projectRoot, journal), readFile(projectPath(projectRoot, PATHS.approval), 'utf8').then(JSON.parse)]);
    const workbenchDigest = createHash('sha256').update(journal.lockedHtml).digest('hex');
    const expected = projectedState(journal.priorState, journal, pair, approval, workbenchDigest);
    if (state.integrity?.digest !== expected.integrity.digest) throw new ApprovalError('E_LOCK_JOURNAL_STALE', 'state-intent does not match the journaled DIRECTOR_LOCK state');
    const tempPath = join(projectRoot, journal.workbenchTemp);
    try {
      const staged = await readRegularFile(tempPath, 'E_LOCK_JOURNAL_INVALID', 'staged workbench is not a regular transaction-owned file');
      if (!staged.bytes.equals(Buffer.from(journal.lockedHtml))) throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'staged workbench bytes changed');
    }
    catch (error) {
      if (error.code !== 'ENOENT' && error.cause?.code !== 'ENOENT') throw error;
      const [snapshot, current] = await Promise.all([
        readRegularFile(join(projectRoot, PATHS.snapshot), 'E_LOCK_JOURNAL_INVALID', 'published snapshot is not a regular file'),
        readRegularFile(join(projectRoot, PATHS.workbench), 'E_LOCK_JOURNAL_INVALID', 'published current workbench is not a regular file'),
      ]);
      if (!snapshot.bytes.equals(Buffer.from(journal.lockedHtml)) || !current.bytes.equals(Buffer.from(journal.lockedHtml))
        || (snapshot.metadata.dev === current.metadata.dev && snapshot.metadata.ino === current.metadata.ino)) {
        throw new ApprovalError('E_LOCK_JOURNAL_INVALID', 'published workbench bytes or inode isolation changed after state commit');
      }
    }
    await publishSnapshotAndCurrent(projectRoot, journal);
    journal.phase = 'workbench-published'; await writeJournal(projectRoot, journal);
  }
  const committed = await validateCommittedDirection(projectRoot); await unlink(projectPath(projectRoot, PATHS.journal)); await syncDirectory(projectPath(projectRoot, PATHS.journal));
  return { ok: true, recovered: true, designDigest: journal.designDigest, lookDigest: journal.lookDigest, state: committed.state, workbenchDigest: committed.workbenchDigest };
}

export async function lockDirection(projectRoot, options = {}) {
  const resolved = [options.designPath ?? PATHS.design, options.lookPath ?? PATHS.look, options.statePath ?? PATHS.state].map((path) => projectPath(projectRoot, path));
  if (resolved[0] !== projectPath(projectRoot, PATHS.design) || resolved[1] !== projectPath(projectRoot, PATHS.look) || resolved[2] !== projectPath(projectRoot, PATHS.state)) throw new ApprovalError('E_LOCK_DESTINATION', 'v1 lock destinations are fixed project contracts');
  const guard = await acquireGuard(projectRoot, options.guardHooks);
  try {
    const recovered = await recover(projectRoot, options); if (recovered) return recovered;
    const state = JSON.parse(await readFile(projectPath(projectRoot, PATHS.state), 'utf8'));
    if (state.state === 'DIRECTOR_LOCK') throw new ApprovalError('E_APPROVAL_CONSUMED', 'direction approval is already consumed');
    const validated = await validateDirectorApproval(projectRoot); const lockedAt = (options.now ?? (() => new Date().toISOString()))();
    if (!Number.isFinite(Date.parse(lockedAt))) throw new ApprovalError('E_LOCK_TIME', 'lock timestamp must be ISO-8601');
    const design = compileApprovedDesign(validated.draftDesign, validated.selectedCandidate, validated.approval, lockedAt); const look = compileApprovedLook(validated.draftLook, validated.selectedCandidate, validated.approval, lockedAt);
    const transactionId = randomBytes(16).toString('hex'); const journal = { schemaVersion: '1.0.0', transactionId, owner: guard, phase: 'validated', lockedAt, selectedCandidate: structuredClone(validated.selectedCandidate), approvalDigest: validated.approval.integrity.digest, inputDigests: validated.inputDigests, designDigest: design.integrity.digest, lookDigest: look.integrity.digest, priorDesign: validated.draftDesign, priorLook: validated.draftLook, priorState: validated.projectState, designTemp: `cache/.direction-design.${transactionId}.tmp`, lookTemp: `cache/.direction-look.${transactionId}.tmp`, workbenchTemp: `cache/.direction-workbench.${transactionId}.tmp`, snapshotPath: PATHS.snapshot, lockedHtml: null, integrity: { digest: null, upstream: {} } };
    let ownsJournal = false;
    try {
      await writeJournal(projectRoot, journal, true); ownsJournal = true;
      await Promise.all([writeDurable(projectPath(projectRoot, journal.designTemp), `${JSON.stringify(design, null, 2)}\n`, 'wx'), writeDurable(projectPath(projectRoot, journal.lookTemp), `${JSON.stringify(look, null, 2)}\n`, 'wx')]); journal.phase = 'temps-written'; await writeJournal(projectRoot, journal); inject(options, 'afterTemporaryWrites');
      await rename(projectPath(projectRoot, journal.designTemp), resolved[0]); await syncDirectory(resolved[0]); journal.phase = 'design-renamed'; await writeJournal(projectRoot, journal); inject(options, 'afterFirstRename');
      await rename(projectPath(projectRoot, journal.lookTemp), resolved[1]); await syncDirectory(resolved[1]); journal.phase = 'pair-renamed'; await writeJournal(projectRoot, journal); const pair = await verifyPair(projectRoot, journal); inject(options, 'beforeStateCommit');
      const committed = await stageAndCommit(projectRoot, journal, pair, options); journal.phase = 'committed'; await writeJournal(projectRoot, journal); await unlink(projectPath(projectRoot, PATHS.journal)); await syncDirectory(projectPath(projectRoot, PATHS.journal)); ownsJournal = false;
      return { ok: true, recovered: false, selectedCandidateId: validated.selectedCandidate.candidateId, designDigest: design.integrity.digest, lookDigest: look.integrity.digest, stateRevision: committed.state.revision, workbenchDigest: committed.workbenchDigest };
    } catch (error) { if (ownsJournal) { journal.owner.active = false; await writeJournal(projectRoot, journal).catch(() => {}); } throw error; }
  } finally { await releaseGuard(projectRoot, guard); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const { project } = parseCliArguments(process.argv.slice(2), { project: { required: true } }); process.stdout.write(`${JSON.stringify(await lockDirection(project))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify(errorResult(error))}\n`); process.exitCode = error.code === 'E_USAGE' ? 2 : 1; }
}
