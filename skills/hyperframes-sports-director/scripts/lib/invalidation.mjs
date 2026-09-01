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

async function processStartIdentity(pid) {
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
const REPAIR_PHASES = new Set(['prepared', 'history-renamed', 'pair-renamed']);

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
    || !/^[0-9a-f]{64}$/.test(value.owner.token ?? '') || !Number.isInteger(value.owner.pid)
    || typeof value.owner.processStartId !== 'string' || value.owner.processStartId.length === 0) {
    const error = new Error('repair guard is structurally invalid'); error.code = 'E_REPAIR_GUARD_INVALID'; throw error;
  }
  return value;
}

async function acquireRepairGuard(projectRoot) {
  const path = projectPath(projectRoot, REPAIR_GUARD);
  const owner = { token: randomBytes(32).toString('hex'), pid: process.pid, processStartId: await processStartIdentity(process.pid), active: true };
  if (owner.processStartId === null) { const error = new Error('process identity unavailable'); error.code = 'E_REPAIR_OWNER'; throw error; }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeJsonExclusive(path, stamp({ schemaVersion: '1.0.0', owner, integrity: { digest: null, upstream: {} } }));
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
      await unlink(path).catch((unlinkError) => { if (unlinkError.code !== 'ENOENT') throw unlinkError; });
      await syncDirectory(path);
    }
  }
  const busy = new Error('repair guard takeover lost a race'); busy.code = 'E_REPAIR_BUSY'; throw busy;
}

async function releaseRepairGuard(projectRoot, owner) {
  const path = projectPath(projectRoot, REPAIR_GUARD);
  try {
    const current = validateRepairGuard(JSON.parse(await readFile(path, 'utf8')));
    if (current.owner.token === owner.token) { await unlink(path); await syncDirectory(path); }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function validateRepairJournal(value) {
  const exact = ['schemaVersion', 'transactionId', 'owner', 'phase', 'priorHistoryDigest', 'priorStateDigest', 'nextHistory', 'nextState', 'integrity'].sort();
  const keys = Object.keys(value ?? {}).sort();
  const ownerKeys = Object.keys(value?.owner ?? {}).sort();
  if (!verifyArtifactIntegrity(value).valid || !stableKeys(keys, exact) || !stableKeys(ownerKeys, ['active', 'pid', 'processStartId', 'token'])
    || value.schemaVersion !== '1.0.0' || !/^[0-9a-f]{32}$/.test(value.transactionId ?? '')
    || !/^[0-9a-f]{64}$/.test(value.owner.token ?? '') || !Number.isInteger(value.owner.pid)
    || typeof value.owner.processStartId !== 'string' || typeof value.owner.active !== 'boolean' || !REPAIR_PHASES.has(value.phase)
    || !verifyArtifactIntegrity(value.nextHistory).valid || !verifyArtifactIntegrity(value.nextState).valid
    || value.nextHistory.integrity.upstream.projectState !== value.nextState.integrity.digest) {
    const error = new Error('repair journal is structurally invalid'); error.code = 'E_REPAIR_JOURNAL_INVALID'; throw error;
  }
  return value;
}

function stableKeys(left, right) { return left.length === right.length && left.every((entry, index) => entry === [...right].sort()[index]); }

async function readRepairJournal(projectRoot) {
  try { return validateRepairJournal(JSON.parse(await readFile(projectPath(projectRoot, REPAIR_JOURNAL), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function recoverRepairTransaction(projectRoot) {
  const journal = await readRepairJournal(projectRoot);
  if (!journal) return;
  const liveIdentity = await processStartIdentity(journal.owner.pid);
  if (journal.owner.active && liveIdentity !== null && liveIdentity === journal.owner.processStartId) {
    const error = new Error('another repair transaction is active'); error.code = 'E_REPAIR_BUSY'; throw error;
  }
  await writeJsonAtomic(projectPath(projectRoot, 'cache/REPAIR_HISTORY.json'), journal.nextHistory, journal.transactionId);
  await writeJsonAtomic(projectPath(projectRoot, 'PROJECT_STATE.json'), journal.nextState, journal.transactionId);
  await unlink(projectPath(projectRoot, REPAIR_JOURNAL));
  await syncDirectory(projectPath(projectRoot, REPAIR_JOURNAL));
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
    if (!verifyArtifactIntegrity(value).valid || !Array.isArray(value.repairs)) throw new Error('repair history integrity is invalid');
    return value;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const value = { schemaVersion: '1.0.0', revision: 0, repairs: [], integrity: { digest: null, upstream: {} } };
    value.integrity.digest = computeArtifactDigest(value);
    return value;
  }
}

async function persistApprovedRepairUnderGuard(projectRoot, change, context, guard) {
  await recoverRepairTransaction(projectRoot);
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
  const journal = { schemaVersion: '1.0.0', transactionId, owner, phase: 'prepared', priorHistoryDigest: persistedHistory.integrity.digest, priorStateDigest: projectState.integrity.digest, nextHistory: history, nextState, integrity: { digest: null, upstream: {} } };
  let owns = false;
  try {
    await createRepairJournal(projectRoot, journal); owns = true;
    await writeJsonAtomic(projectPath(projectRoot, 'cache/REPAIR_HISTORY.json'), history, transactionId);
    journal.phase = 'history-renamed'; await writeJsonAtomic(projectPath(projectRoot, REPAIR_JOURNAL), stamp(journal), transactionId);
    if (context.injectFailure === 'afterHistoryRename') { const error = new Error('injected repair transaction failure'); error.code = 'E_INJECTED_FAILURE'; throw error; }
    await writeJsonAtomic(projectPath(projectRoot, 'PROJECT_STATE.json'), nextState, transactionId);
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
  const guard = await acquireRepairGuard(projectRoot);
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
    const superseded = supersededTransitions.some((transition) => transition.evidenceDigests[evidence.role] === evidence.digest);
    return superseded ? { ...evidence, validity: 'invalidated', invalidatedAt: context.timestamp } : evidence;
  });
  result.previousState = projectState.state;
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
