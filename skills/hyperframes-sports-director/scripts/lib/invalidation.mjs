import { open, readFile, rename, unlink } from 'node:fs/promises';

import { computeArtifactDigest, loadSchema, validateDocument, verifyArtifactIntegrity } from './contracts.mjs';
import { deriveInvalidationPolicy } from './invalidation-policy.mjs';
import { projectPath } from './media.mjs';
import { blockCurrentRun } from './project-state.mjs';

export const ARTIFACT_ROLE_DEPENDENCIES = Object.freeze({
  MEDIA_INDEX: ['PROBE'],
  PROBE: ['TIMELINE'],
  ACTIVITY: ['DATA_OVERLAYS'],
  DATA_OVERLAYS: ['TIMELINE'],
  DESIGN_SYSTEM: ['ASSET_MANIFEST'],
  LOOK_PROFILE: ['ASSET_MANIFEST'],
  ASSET_MANIFEST: ['MOTION_MAP'],
  TIMELINE: ['MOTION_MAP'],
  MOTION_MAP: ['FINAL_RENDER'],
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
const DEFAULT_CHANGED_ROLE = {
  position: 'MOTION_MAP', scrim: 'MOTION_MAP', timing: 'TIMELINE', gain: 'TIMELINE',
  'same-role-fallback': 'ASSET_MANIFEST', 'trim-seam': 'TIMELINE', 'remove-optional-decorative': 'ASSET_MANIFEST',
};
const FORBIDDEN_CHANGED_ROLE = {
  story: 'TIMELINE', 'key-shot': 'TIMELINE', direction: 'DESIGN_SYSTEM', token: 'DESIGN_SYSTEM',
  look: 'LOOK_PROFILE', music: 'TIMELINE', privacy: 'DATA_OVERLAYS', delivery: 'FINAL_RENDER',
};

export function classifyApprovedRepair(change) {
  if (!change || typeof change.repairClass !== 'string') throw new TypeError('change.repairClass is required');
  const repairClass = change.repairClass;
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
      : { allowed: true, code: 'repair_allowed', repairClass, role: change.role, changedRole: 'ASSET_MANIFEST' };
  }
  if (repairClass === 'remove-optional-decorative' && change.optional !== true) {
    return { allowed: false, code: 'required_role_failed', repairClass, role: change.role };
  }
  if (!ALLOWED_REPAIR_CLASSES.has(repairClass)) {
    return { allowed: false, code: 'repair_class_unsupported', repairClass };
  }
  return {
    allowed: true, code: 'repair_allowed', repairClass, role: change.role ?? null,
    changedRole: change.role && Object.hasOwn(ARTIFACT_ROLE_DEPENDENCIES, change.role)
      ? change.role : DEFAULT_CHANGED_ROLE[repairClass],
  };
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

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
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

export async function persistApprovedRepair(projectRoot, change, context) {
  const [projectState, persistedHistory] = await Promise.all([
    readFile(projectPath(projectRoot, 'PROJECT_STATE.json'), 'utf8').then(JSON.parse),
    readRepairHistory(projectRoot),
  ]);
  if (!verifyArtifactIntegrity(projectState).valid) throw new Error('PROJECT_STATE integrity is invalid');
  const result = applyApprovedRepair(projectState, change, { ...context, history: persistedHistory.repairs });
  if (result.code === 'repair_budget_exhausted') return result;
  const history = {
    ...persistedHistory,
    revision: persistedHistory.revision + 1,
    repairs: result.history,
    integrity: { digest: null, upstream: { projectState: projectState.integrity.digest } },
  };
  history.integrity.digest = computeArtifactDigest(history);
  await writeJsonAtomic(projectPath(projectRoot, 'cache/REPAIR_HISTORY.json'), history);
  if (result.projectState !== projectState) {
    const validation = validateDocument(await loadSchema('project-state'), result.projectState);
    if (!validation.valid) throw new Error(`BLOCKED project state is invalid: ${JSON.stringify(validation.errors)}`);
    await writeJsonAtomic(projectPath(projectRoot, 'PROJECT_STATE.json'), result.projectState);
  }
  return result;
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
