import { randomBytes } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { computeArtifactDigest, loadSchema, validateDocument, verifyArtifactIntegrity } from './contracts.mjs';
import { deriveInvalidationPolicy } from './invalidation-policy.mjs';
import { projectPath } from './media.mjs';
import { blockCurrentRun } from './project-state.mjs';

export const ARTIFACT_ROLE_DEPENDENCIES = Object.freeze({
  MEDIA_INDEX: ['PROBE'],
  PROBE: ['SEGMENTS'],
  SEGMENTS: ['SHOTS'],
  SHOTS: ['TIMELINE'],
  ACTIVITY: ['SYNC_MAP'],
  SYNC_MAP: ['DATA_OVERLAYS'],
  DATA_OVERLAYS: ['TIMELINE'],
  DESIGN_SYSTEM: ['ASSET_MANIFEST'],
  LOOK_PROFILE: ['ASSET_MANIFEST'],
  ASSET_MANIFEST: ['MOTION_MAP', 'TIMELINE'],
  TIMELINE: ['MOTION_MAP'],
  MOTION_MAP: ['TIMELINE', 'FINAL_RENDER'],
  FINAL_RENDER: ['REVIEW'],
  REVIEW: [],
});

const ALLOWED_REPAIR_CLASSES = new Set([
  'position', 'scrim', 'timing', 'gain', 'same-role-fallback', 'trim-seam', 'remove-optional-decorative',
]);
const FORBIDDEN_REPAIR_CLASSES = new Set([
  'story', 'key-shot', 'direction', 'token', 'look', 'music', 'privacy', 'delivery',
]);
const REQUIRED_ROLES = new Set(['journey_anchor', 'activity_evidence', 'transition_owner']);
const ALLOWED_ROLE_BY_CLASS = Object.freeze({
  position: new Set(['MOTION_MAP']), scrim: new Set(['MOTION_MAP']), timing: new Set(['TIMELINE']), gain: new Set(['TIMELINE']),
  'same-role-fallback': new Set(['ASSET_MANIFEST']), 'trim-seam': new Set(['TIMELINE']), 'remove-optional-decorative': new Set(['ASSET_MANIFEST']),
});
const FROZEN_ROLES = new Set(['DESIGN_SYSTEM', 'LOOK_PROFILE']);
const FORBIDDEN_CHANGED_ROLE = {
  story: 'TIMELINE', 'key-shot': 'TIMELINE', direction: 'DESIGN_SYSTEM', token: 'DESIGN_SYSTEM',
  look: 'LOOK_PROFILE', music: 'TIMELINE', privacy: 'DATA_OVERLAYS', delivery: 'FINAL_RENDER',
};

export function classifyApprovedRepair(change) {
  if (!change || typeof change.repairClass !== 'string') throw new TypeError('change.repairClass is required');
  const repairClass = change.repairClass;
  if (FROZEN_ROLES.has(change.role)) {
    return { allowed: false, code: 'approval_boundary_crossed', repairClass, role: change.role, rollbackTarget: 'DIRECTOR_REVIEW_READY' };
  }
  if (FORBIDDEN_REPAIR_CLASSES.has(repairClass)) {
    return { allowed: false, code: 'approval_boundary_crossed', repairClass, rollbackTarget: 'DIRECTOR_REVIEW_READY' };
  }
  if (repairClass === 'role-failure') {
    const required = change.required === true || REQUIRED_ROLES.has(change.role);
    return required
      ? {
        allowed: false, code: 'required_role_failed', repairClass, role: change.role,
        rollbackTarget: change.role === 'activity_evidence' ? 'ANALYZE'
          : change.role === 'transition_owner' ? 'ASSET_PRODUCTION' : 'STYLE_ANCHOR',
      }
      : change.optional === true
        ? { allowed: true, code: 'repair_allowed', repairClass, role: change.role, changedRole: 'ASSET_MANIFEST' }
        : { allowed: false, code: 'repair_role_unauthorized', repairClass, role: change.role };
  }
  if (repairClass === 'remove-optional-decorative' && (change.optional !== true || REQUIRED_ROLES.has(change.role))) {
    return { allowed: false, code: 'required_role_failed', repairClass, role: change.role };
  }
  if (repairClass === 'remove-optional-decorative') {
    return { allowed: true, code: 'repair_allowed', repairClass, role: change.role, changedRole: 'ASSET_MANIFEST' };
  }
  if (!ALLOWED_REPAIR_CLASSES.has(repairClass)) {
    return { allowed: false, code: 'repair_class_unsupported', repairClass };
  }
  const allowedRoles = ALLOWED_ROLE_BY_CLASS[repairClass];
  const requestedRole = change.role ?? [...allowedRoles][0];
  if (!allowedRoles.has(requestedRole)) return { allowed: false, code: 'repair_role_unauthorized', repairClass, role: requestedRole };
  return { allowed: true, code: 'repair_allowed', repairClass, role: requestedRole, changedRole: requestedRole };
}

function validateDigestMap(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.values(value).some((digest) => !/^[0-9a-f]{64}$/.test(digest))) {
    throw new TypeError(`${name} must be an artifact-role digest map`);
  }
}

export function applyApprovedRepair(projectState, change, context) {
  const classification = classifyApprovedRepair(change);
  if (!context || typeof context.gate !== 'string' || !context.gate || typeof context.reason !== 'string' || !context.reason
    || !Number.isFinite(Date.parse(context.timestamp)) || !Array.isArray(context.history)) {
    throw new TypeError('repair context requires gate, reason, timestamp, and history');
  }
  validateDigestMap(context.beforeDigests, 'beforeDigests');
  validateDigestMap(context.afterDigests, 'afterDigests');
  const priorAttempts = context.history.filter((record) => record.gate === context.gate).length;
  const attempt = priorAttempts + 1;
  if (attempt > 3) return { code: 'repair_budget_exhausted', allowed: false, history: structuredClone(context.history), projectState };

  if (!classification.allowed) {
    const changedRole = FORBIDDEN_CHANGED_ROLE[change.repairClass] ?? 'ASSET_MANIFEST';
    const repair = {
      attempt,
      gate: context.gate,
      repairClass: change.repairClass,
      reason: context.reason,
      invalidatedRoles: computeInvalidationClosure([changedRole], ARTIFACT_ROLE_DEPENDENCIES),
      beforeDigests: structuredClone(context.beforeDigests),
      afterDigests: structuredClone(context.afterDigests),
    };
    const boundary = {
      code: classification.code,
      repairClass: change.repairClass,
      reason: context.reason,
      rollbackTarget: classification.rollbackTarget ?? 'DIRECTOR_REVIEW_READY',
    };
    boundary.digest = computeArtifactDigest(boundary);
    const blocked = blockCurrentRun(projectState, boundary, { timestamp: context.timestamp, producerCommand: 'approved-repair --block' });
    blocked.integrity.digest = computeArtifactDigest(blocked);
    return { code: classification.code, allowed: false, repair, history: [...structuredClone(context.history), repair], projectState: blocked };
  }

  const invalidatedRoles = computeInvalidationClosure([classification.changedRole], ARTIFACT_ROLE_DEPENDENCIES);
  const repair = {
    attempt,
    gate: context.gate,
    repairClass: change.repairClass,
    reason: context.reason,
    invalidatedRoles,
    beforeDigests: structuredClone(context.beforeDigests),
    afterDigests: structuredClone(context.afterDigests),
  };
  const invalidatedState = rollbackStateForInvalidation(projectState, invalidatedRoles, {
    timestamp: context.timestamp,
    producerCommand: `approved-repair --class ${change.repairClass}`,
  });
  return {
    code: 'repair_allowed', allowed: true, repair,
    history: [...structuredClone(context.history), repair], projectState: invalidatedState,
  };
}

async function syncDirectory(path) {
  const handle = await open(dirname(path), 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJsonAtomic(path, value, token = randomBytes(16).toString('hex')) {
  const temporary = `${path}.${process.pid}.${token}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await syncDirectory(path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function processStartIdentity(pid) {
  try {
    const fields = (await readFile(`/proc/${pid}/stat`, 'utf8')).trim().split(' ');
    return fields[21] ?? null;
  } catch { return null; }
}

function stamp(value) {
  value.integrity = { digest: null, upstream: {} };
  value.integrity.digest = computeArtifactDigest(value);
  return value;
}

const REPAIR_JOURNAL = 'cache/repair.transaction.json';
const REPAIR_GUARD = 'cache/repair.guard.json';
const REPAIR_PHASES = new Set(['prepared', 'history-renamed', 'state-renamed', 'pair-renamed']);

async function writeJsonExclusive(path, value) {
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    throw error;
  }
}

function validateRepairGuard(value) {
  if (!verifyArtifactIntegrity(value).valid
    || !stableKeys(Object.keys(value ?? {}).sort(), ['schemaVersion', 'owner', 'integrity'])
    || !stableKeys(Object.keys(value?.owner ?? {}).sort(), ['active', 'pid', 'processStartId', 'token'])
    || value.schemaVersion !== '1.0.0' || value.owner.active !== true
    || !/^[0-9a-f]{64}$/.test(value.owner.token ?? '') || !Number.isInteger(value.owner.pid) || value.owner.pid <= 0
    || typeof value.owner.processStartId !== 'string' || value.owner.processStartId.length === 0) {
    const error = new Error('repair guard is structurally invalid'); error.code = 'E_REPAIR_GUARD_INVALID'; throw error;
  }
  return value;
}

async function acquireRepairTakeoverMutex(path, owner, hooks = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { await writeJsonExclusive(path, stamp({ schemaVersion: '1.0.0', owner, integrity: { digest: null, upstream: {} } })); return owner; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = validateRepairGuard(JSON.parse(await readFile(path, 'utf8'))); }
      catch { const busy = new Error('repair takeover mutex is unreadable'); busy.code = 'E_REPAIR_BUSY'; throw busy; }
      const liveIdentity = await processStartIdentity(existing.owner.pid);
      if (liveIdentity !== null && liveIdentity === existing.owner.processStartId) { const busy = new Error('another repair takeover is active'); busy.code = 'E_REPAIR_BUSY'; throw busy; }
      if (hooks.beforeTakeoverMutexClaim) await hooks.beforeTakeoverMutexClaim();
      let current;
      try { current = validateRepairGuard(JSON.parse(await readFile(path, 'utf8'))); }
      catch { const busy = new Error('repair takeover mutex changed'); busy.code = 'E_REPAIR_BUSY'; throw busy; }
      if (current.integrity.digest !== existing.integrity.digest) { const busy = new Error('repair takeover mutex changed'); busy.code = 'E_REPAIR_BUSY'; throw busy; }
      const claim = `${path}.claim.${owner.token}`;
      await rename(path, claim); await syncDirectory(path);
      const claimed = validateRepairGuard(JSON.parse(await readFile(claim, 'utf8')));
      if (claimed.integrity.digest !== existing.integrity.digest) { const busy = new Error('repair takeover mutex claim changed'); busy.code = 'E_REPAIR_BUSY'; throw busy; }
      await unlink(claim); await syncDirectory(claim);
    }
  }
  const busy = new Error('repair takeover mutex recovery lost a race'); busy.code = 'E_REPAIR_BUSY'; throw busy;
}

async function releaseRepairTakeoverMutex(path, owner) {
  try {
    const current = validateRepairGuard(JSON.parse(await readFile(path, 'utf8')));
    if (current.owner.token !== owner.token) { const busy = new Error('repair takeover mutex ownership changed'); busy.code = 'E_REPAIR_BUSY'; throw busy; }
    await unlink(path); await syncDirectory(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function acquireRepairGuard(projectRoot, hooks = {}) {
  const path = projectPath(projectRoot, REPAIR_GUARD);
  const owner = { token: randomBytes(32).toString('hex'), pid: process.pid, processStartId: await processStartIdentity(process.pid), active: true };
  if (owner.processStartId === null) { const error = new Error('process identity unavailable'); error.code = 'E_REPAIR_OWNER'; throw error; }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeJsonExclusive(path, stamp({ schemaVersion: '1.0.0', owner, integrity: { digest: null, upstream: {} } }));
      const acquired = validateRepairGuard(JSON.parse(await readFile(path, 'utf8')));
      if (acquired.owner.token !== owner.token) { const busy = new Error('repair guard ownership changed after acquisition'); busy.code = 'E_REPAIR_BUSY'; throw busy; }
      return owner;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try { existing = validateRepairGuard(JSON.parse(await readFile(path, 'utf8'))); }
      catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
      const liveIdentity = await processStartIdentity(existing.owner.pid);
      if (liveIdentity !== null && liveIdentity === existing.owner.processStartId) {
        const busy = new Error('another repair transaction is active'); busy.code = 'E_REPAIR_BUSY'; throw busy;
      }
      const mutex = `${path}.takeover`; const claim = `${path}.claim.${owner.token}`;
      const mutexOwner = await acquireRepairTakeoverMutex(mutex, owner, hooks);
      try {
        if (hooks.beforeTakeoverClaim) await hooks.beforeTakeoverClaim();
        let current;
        try { current = validateRepairGuard(JSON.parse(await readFile(path, 'utf8'))); }
        catch { const busy = new Error('repair guard changed during takeover'); busy.code = 'E_REPAIR_BUSY'; throw busy; }
        if (current.integrity.digest !== existing.integrity.digest) { const busy = new Error('repair guard changed during takeover'); busy.code = 'E_REPAIR_BUSY'; throw busy; }
        await rename(path, claim); await syncDirectory(path);
        const claimed = validateRepairGuard(JSON.parse(await readFile(claim, 'utf8')));
        if (claimed.integrity.digest !== existing.integrity.digest) {
          await rename(claim, path).catch(() => {});
          const busy = new Error('repair takeover claim changed'); busy.code = 'E_REPAIR_BUSY'; throw busy;
        }
        await writeJsonExclusive(path, stamp({ schemaVersion: '1.0.0', owner, integrity: { digest: null, upstream: {} } }));
        const acquired = validateRepairGuard(JSON.parse(await readFile(path, 'utf8')));
        if (acquired.owner.token !== owner.token) { const busy = new Error('repair guard ownership changed after takeover'); busy.code = 'E_REPAIR_BUSY'; throw busy; }
        await unlink(claim); await syncDirectory(claim);
        return owner;
      } finally {
        await releaseRepairTakeoverMutex(mutex, mutexOwner);
      }
    }
  }
  const busy = new Error('repair guard takeover lost a race'); busy.code = 'E_REPAIR_BUSY'; throw busy;
}

export async function releaseRepairGuard(projectRoot, owner) {
  const path = projectPath(projectRoot, REPAIR_GUARD);
  try {
    const current = validateRepairGuard(JSON.parse(await readFile(path, 'utf8')));
    if (current.owner.token === owner.token) { await unlink(path); await syncDirectory(path); }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function assertRepairGuardOwnership(projectRoot, owner) {
  let current;
  try { current = validateRepairGuard(JSON.parse(await readFile(projectPath(projectRoot, REPAIR_GUARD), 'utf8'))); }
  catch {
    const error = new Error('project mutation guard ownership is not current'); error.code = 'E_REPAIR_BUSY'; throw error;
  }
  if (!owner || current.owner.token !== owner.token || current.owner.pid !== owner.pid
    || current.owner.processStartId !== owner.processStartId || owner.active !== true) {
    const error = new Error('project mutation guard ownership is not current'); error.code = 'E_REPAIR_BUSY'; throw error;
  }
  return true;
}

export async function assertNoPendingAssetTransaction(projectRoot) {
  try {
    await readFile(projectPath(projectRoot, 'cache/asset-stage.transaction.json'), 'utf8');
    const error = new Error('an asset-stage transaction is pending recovery'); error.code = 'E_ASSET_TRANSACTION_PENDING'; throw error;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function validateRepairHistory(value) {
  const recordKeys = ['attempt', 'gate', 'repairClass', 'reason', 'invalidatedRoles', 'beforeDigests', 'afterDigests'];
  if (!verifyArtifactIntegrity(value).valid || !stableKeys(Object.keys(value ?? {}).sort(), ['schemaVersion', 'revision', 'repairs', 'integrity'])
    || value.schemaVersion !== '1.0.0' || !Number.isInteger(value.revision) || value.revision < 0 || !Array.isArray(value.repairs)
    || value.repairs.some((record) => !stableKeys(Object.keys(record ?? {}).sort(), recordKeys)
      || !Number.isInteger(record.attempt) || record.attempt < 1 || record.attempt > 3
      || typeof record.gate !== 'string' || record.gate.length === 0 || typeof record.repairClass !== 'string' || record.repairClass.length === 0
      || typeof record.reason !== 'string' || record.reason.length === 0 || !Array.isArray(record.invalidatedRoles)
      || record.invalidatedRoles.some((role) => typeof role !== 'string' || role.length === 0)
      || !record.beforeDigests || Object.values(record.beforeDigests).some((digest) => !/^[0-9a-f]{64}$/.test(digest))
      || !record.afterDigests || Object.values(record.afterDigests).some((digest) => !/^[0-9a-f]{64}$/.test(digest)))) {
    const error = new Error('repair history is structurally invalid'); error.code = 'E_REPAIR_JOURNAL_INVALID'; throw error;
  }
  return value;
}

async function validateRepairJournal(value) {
  const exact = ['schemaVersion', 'transactionId', 'owner', 'phase', 'priorHistoryDigest', 'priorStateDigest', 'nextHistoryDigest', 'nextStateDigest', 'nextHistory', 'nextState', 'integrity'].sort();
  const keys = Object.keys(value ?? {}).sort();
  const ownerKeys = Object.keys(value?.owner ?? {}).sort();
  if (!verifyArtifactIntegrity(value).valid || !stableKeys(keys, exact) || !stableKeys(ownerKeys, ['active', 'pid', 'processStartId', 'token'])
    || value.schemaVersion !== '1.0.0' || !/^[0-9a-f]{32}$/.test(value.transactionId ?? '')
    || !/^[0-9a-f]{64}$/.test(value.owner.token ?? '') || !Number.isInteger(value.owner.pid) || value.owner.pid <= 0
    || typeof value.owner.processStartId !== 'string' || value.owner.processStartId.length === 0 || typeof value.owner.active !== 'boolean' || !REPAIR_PHASES.has(value.phase)
    || !/^[0-9a-f]{64}$/.test(value.priorHistoryDigest ?? '') || !/^[0-9a-f]{64}$/.test(value.priorStateDigest ?? '')
    || value.nextHistoryDigest !== value.nextHistory?.integrity?.digest || value.nextStateDigest !== value.nextState?.integrity?.digest
    || value.nextHistory?.integrity?.upstream?.projectState !== value.nextStateDigest) {
    const error = new Error('repair journal is structurally invalid'); error.code = 'E_REPAIR_JOURNAL_INVALID'; throw error;
  }
  validateRepairHistory(value.nextHistory);
  const stateValidation = validateDocument(await loadSchema('project-state'), value.nextState);
  if (!stateValidation.valid || !verifyArtifactIntegrity(value.nextState).valid) {
    const error = new Error('repair journal next state is invalid'); error.code = 'E_REPAIR_JOURNAL_INVALID'; throw error;
  }
  return value;
}

function stableKeys(left, right) { return left.length === right.length && left.every((entry, index) => entry === [...right].sort()[index]); }

async function readRepairJournal(projectRoot) {
  try { return await validateRepairJournal(JSON.parse(await readFile(projectPath(projectRoot, REPAIR_JOURNAL), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function assertNoPendingRepairTransaction(projectRoot) {
  if (await readRepairJournal(projectRoot)) { const error = new Error('a repair transaction is pending recovery'); error.code = 'E_REPAIR_PENDING'; throw error; }
  return true;
}

async function recoverRepairTransaction(projectRoot) {
  const journal = await readRepairJournal(projectRoot);
  if (!journal) return;
  const liveIdentity = await processStartIdentity(journal.owner.pid);
  if (journal.owner.active && liveIdentity !== null && liveIdentity === journal.owner.processStartId) {
    const error = new Error('another repair transaction is active'); error.code = 'E_REPAIR_BUSY'; throw error;
  }
  const [currentHistory, currentState] = await Promise.all([readRepairHistory(projectRoot), readFile(projectPath(projectRoot, 'PROJECT_STATE.json'), 'utf8').then(JSON.parse)]);
  const currentStateValidation = validateDocument(await loadSchema('project-state'), currentState);
  if (!currentStateValidation.valid || !verifyArtifactIntegrity(currentState).valid) { const error = new Error('current repair state is invalid'); error.code = 'E_REPAIR_JOURNAL_STALE'; throw error; }
  const historySide = currentHistory.integrity.digest === journal.priorHistoryDigest ? 'prior' : currentHistory.integrity.digest === journal.nextHistoryDigest ? 'next' : null;
  const stateSide = currentState.integrity.digest === journal.priorStateDigest ? 'prior' : currentState.integrity.digest === journal.nextStateDigest ? 'next' : null;
  if (!historySide || !stateSide) { const error = new Error('repair journal no longer matches the current history/state pair'); error.code = 'E_REPAIR_JOURNAL_STALE'; throw error; }
  const writeHistory = async () => {
    if ((await readRepairHistory(projectRoot)).integrity.digest !== journal.priorHistoryDigest) { const error = new Error('repair history advanced during recovery'); error.code = 'E_REPAIR_JOURNAL_STALE'; throw error; }
    await writeJsonAtomic(projectPath(projectRoot, 'cache/REPAIR_HISTORY.json'), journal.nextHistory, journal.transactionId);
  };
  const writeState = async () => {
    const current = JSON.parse(await readFile(projectPath(projectRoot, 'PROJECT_STATE.json'), 'utf8'));
    if (current.integrity.digest !== journal.priorStateDigest) { const error = new Error('repair state advanced during recovery'); error.code = 'E_REPAIR_JOURNAL_STALE'; throw error; }
    await writeJsonAtomic(projectPath(projectRoot, 'PROJECT_STATE.json'), journal.nextState, journal.transactionId);
  };
  if (journal.nextState.state === 'BLOCKED') {
    if (stateSide === 'prior') await writeState();
    if (historySide === 'prior') await writeHistory();
  } else {
    if (historySide === 'prior') await writeHistory();
    if (stateSide === 'prior') await writeState();
  }
  const [finalHistory, finalState] = await Promise.all([readRepairHistory(projectRoot), readFile(projectPath(projectRoot, 'PROJECT_STATE.json'), 'utf8').then(JSON.parse)]);
  if (finalHistory.integrity.digest !== journal.nextHistoryDigest || finalState.integrity.digest !== journal.nextStateDigest) { const error = new Error('repair recovery did not commit its exact pair'); error.code = 'E_REPAIR_JOURNAL_STALE'; throw error; }
  await unlink(projectPath(projectRoot, REPAIR_JOURNAL));
  await syncDirectory(projectPath(projectRoot, REPAIR_JOURNAL));
  return { recovered: true, state: finalState.state };
}

async function createRepairJournal(projectRoot, journal) {
  const path = projectPath(projectRoot, REPAIR_JOURNAL);
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(stamp(journal), null, 2)}\n`); await handle.sync(); await handle.close(); handle = null;
    await syncDirectory(path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error.code === 'EEXIST') { const busy = new Error('another repair transaction is active'); busy.code = 'E_REPAIR_BUSY'; throw busy; }
    throw error;
  }
}

async function readRepairHistory(projectRoot) {
  try {
    const value = JSON.parse(await readFile(projectPath(projectRoot, 'cache/REPAIR_HISTORY.json'), 'utf8'));
    return validateRepairHistory(value);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = { schemaVersion: '1.0.0', revision: 0, repairs: [], integrity: { digest: null, upstream: {} } };
    value.integrity.digest = computeArtifactDigest(value);
    return value;
  }
}

async function persistApprovedRepairUnderGuard(projectRoot, change, context, guard) {
  await assertRepairGuardOwnership(projectRoot, guard);
  await assertNoPendingAssetTransaction(projectRoot);
  const recovery = await recoverRepairTransaction(projectRoot);
  if (recovery?.state === 'BLOCKED') return recovery;
  const transactionId = randomBytes(16).toString('hex');
  const owner = structuredClone(guard);
  const [projectState, persistedHistory] = await Promise.all([
    readFile(projectPath(projectRoot, 'PROJECT_STATE.json'), 'utf8').then(JSON.parse),
    readRepairHistory(projectRoot),
  ]);
  if (!verifyArtifactIntegrity(projectState).valid) throw new Error('PROJECT_STATE integrity is invalid');
  const result = applyApprovedRepair(projectState, change, { ...context, history: persistedHistory.repairs });
  if (result.code === 'repair_budget_exhausted') return result;
  const nextState = result.projectState;
  const validation = validateDocument(await loadSchema('project-state'), nextState);
  if (!validation.valid) throw new Error(`repair project state is invalid: ${JSON.stringify(validation.errors)}`);
  const history = {
    ...persistedHistory,
    revision: persistedHistory.revision + 1,
    repairs: result.history,
    integrity: { digest: null, upstream: { projectState: nextState.integrity.digest } },
  };
  history.integrity.digest = computeArtifactDigest(history);
  const journal = { schemaVersion: '1.0.0', transactionId, owner, phase: 'prepared', priorHistoryDigest: persistedHistory.integrity.digest, priorStateDigest: projectState.integrity.digest, nextHistoryDigest: history.integrity.digest, nextStateDigest: nextState.integrity.digest, nextHistory: history, nextState, integrity: { digest: null, upstream: {} } };
  let owns = false;
  try {
    await createRepairJournal(projectRoot, journal); owns = true;
    const inject = (point) => { if (context.injectFailure === point) { const error = new Error('injected repair transaction failure'); error.code = 'E_INJECTED_FAILURE'; throw error; } };
    const commitHistory = async () => { await writeJsonAtomic(projectPath(projectRoot, 'cache/REPAIR_HISTORY.json'), history, transactionId); inject('afterHistoryRename'); journal.phase = 'history-renamed'; await writeJsonAtomic(projectPath(projectRoot, REPAIR_JOURNAL), stamp(journal), transactionId); };
    const commitState = async () => { await writeJsonAtomic(projectPath(projectRoot, 'PROJECT_STATE.json'), nextState, transactionId); inject('afterStateRename'); journal.phase = 'state-renamed'; await writeJsonAtomic(projectPath(projectRoot, REPAIR_JOURNAL), stamp(journal), transactionId); };
    if (nextState.state === 'BLOCKED') { await commitState(); await commitHistory(); }
    else { await commitHistory(); await commitState(); }
    journal.phase = 'pair-renamed'; await writeJsonAtomic(projectPath(projectRoot, REPAIR_JOURNAL), stamp(journal), transactionId);
    const [persistedNextHistory, persistedNextState] = await Promise.all([readRepairHistory(projectRoot), readFile(projectPath(projectRoot, 'PROJECT_STATE.json'), 'utf8').then(JSON.parse)]);
    if (persistedNextHistory.integrity.upstream.projectState !== persistedNextState.integrity.digest) throw new Error('repair transaction pair is split');
    await unlink(projectPath(projectRoot, REPAIR_JOURNAL)); await syncDirectory(projectPath(projectRoot, REPAIR_JOURNAL)); owns = false;
  } catch (error) {
    if (owns) { journal.owner.active = false; await writeJsonAtomic(projectPath(projectRoot, REPAIR_JOURNAL), stamp(journal), transactionId).catch(() => {}); }
    throw error;
  }
  return result;
}

export async function persistApprovedRepair(projectRoot, change, context) {
  const guard = await acquireRepairGuard(projectRoot, context.guardHooks);
  try { return await persistApprovedRepairUnderGuard(projectRoot, change, context, guard); }
  finally { await releaseRepairGuard(projectRoot, guard); }
}

export function computeInvalidationClosure(changedRoles, dependencyGraph) {
  if (!Array.isArray(changedRoles) || changedRoles.some((role) => typeof role !== 'string')) {
    throw new TypeError('changedRoles must be an array of artifact roles');
  }
  if (dependencyGraph === null || typeof dependencyGraph !== 'object' || Array.isArray(dependencyGraph)) {
    throw new TypeError('dependencyGraph must be an artifact-role adjacency map');
  }
  const closure = [];
  const seen = new Set();
  const queue = [...changedRoles];
  while (queue.length > 0) {
    const role = queue.shift();
    if (seen.has(role)) continue;
    seen.add(role);
    closure.push(role);
    const dependents = dependencyGraph[role] ?? [];
    if (!Array.isArray(dependents) || dependents.some((dependent) => typeof dependent !== 'string')) {
      throw new TypeError(`dependencyGraph.${role} must be an array of artifact roles`);
    }
    queue.push(...dependents);
  }
  return closure;
}

export function rollbackStateForInvalidation(projectState, invalidatedRoles, context) {
  if (projectState === null || typeof projectState !== 'object' || Array.isArray(projectState)) {
    throw new TypeError('projectState must be an object');
  }
  if (!Array.isArray(invalidatedRoles)) throw new TypeError('invalidatedRoles must be an array');
  if (!context || !Number.isFinite(Date.parse(context.timestamp)) || typeof context.producerCommand !== 'string' || context.producerCommand.length === 0) {
    throw new TypeError('invalidation context requires timestamp and producerCommand');
  }
  const result = structuredClone(projectState);
  const policy = deriveInvalidationPolicy(invalidatedRoles, projectState.state);
  if (policy === null) return result;
  const { rollbackTarget, disposition, nextState } = policy;
  const frozenBoundary = disposition === 'blocked';
  const revision = (projectState.revision ?? 0) + 1;
  const invalidation = {
    at: context.timestamp,
    fromState: projectState.state,
    rollbackTarget,
    disposition,
    invalidatedRoles: [...new Set(invalidatedRoles)],
  };
  const evidenceDigest = computeArtifactDigest(invalidation);
  invalidation.evidenceDigest = evidenceDigest;
  const role = frozenBoundary ? 'APPROVAL_BOUNDARY_CROSSED' : 'INVALIDATION';
  const qualifiers = frozenBoundary ? ['approval-boundary-crossed'] : ['rollback'];
  const rollbackTransitionIndex = result.transitions.findLastIndex((transition) => transition.to === rollbackTarget);
  const supersededTransitions = result.transitions.slice(rollbackTransitionIndex + 1);
  result.gateEvidence = result.gateEvidence.map((evidence) => {
    const superseded = supersededTransitions.some((transition) => evidence.gate === transition.to
      && transition.evidenceDigests[evidence.role] === evidence.digest);
    return superseded ? { ...evidence, validity: 'invalidated', invalidatedAt: context.timestamp } : evidence;
  });
  result.previousState = projectState.state;
  if (nextState === 'ASSET_PRODUCTION' && !invalidatedRoles.includes('ASSET_MANIFEST')) {
    result.assetAcceptance = structuredClone(projectState.assetAcceptance ?? null);
  } else if (nextState === 'STYLE_ANCHOR' && projectState.assetAcceptance?.anchorDigest) {
    result.assetAcceptance = { ...structuredClone(projectState.assetAcceptance), stage: 'anchor',
      representativeDigest: null, batchDigest: null, acceptedAt: context.timestamp };
  } else result.assetAcceptance = null;
  result.state = nextState;
  result.stateEnteredAt = context.timestamp;
  result.revision = revision;
  result.invalidations = [...(result.invalidations ?? []), invalidation];
  result.transitions.push({
    from: projectState.state,
    to: nextState,
    at: context.timestamp,
    kind: 'invalidation',
    rollbackTarget,
    evidenceDigests: { [role]: evidenceDigest },
    evidenceRevisions: { [role]: revision },
  });
  result.gateEvidence.push({
    gate: nextState,
    role,
    revision,
    digest: evidenceDigest,
    timestamp: context.timestamp,
    producerCommand: context.producerCommand,
    qualifiers,
    validity: 'valid',
    invalidatedAt: null,
  });
  result.integrity.digest = null;
  result.integrity.digest = computeArtifactDigest(result);
  return result;
}
