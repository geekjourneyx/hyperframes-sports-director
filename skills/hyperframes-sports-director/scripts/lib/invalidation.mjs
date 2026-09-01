import { computeArtifactDigest } from './contracts.mjs';

const STATE_ORDER = [
  'INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT',
  'DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION',
  'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED',
];
const ROLLBACK_STATE = {
  MEDIA_INDEX: 'CAPABILITY_CHECK',
  PROBE: 'SCAN',
  ACTIVITY: 'SCAN',
  DATA_OVERLAYS: 'ANALYZE',
  TIMELINE: 'ASSET_PRODUCTION',
  ASSET_MANIFEST: 'STYLE_ANCHOR',
  MOTION_MAP: 'ASSET_PRODUCTION',
  FINAL_RENDER: 'MOTION_COMPOSITION',
  REVIEW: 'FINAL_RENDER',
};
const FROZEN_BOUNDARY_ROLES = new Set(['DESIGN_SYSTEM', 'LOOK_PROFILE']);

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
  const frozenBoundary = invalidatedRoles.some((role) => FROZEN_BOUNDARY_ROLES.has(role));
  const currentIndex = STATE_ORDER.indexOf(projectState.state);
  const candidates = invalidatedRoles
    .map((role) => ROLLBACK_STATE[role])
    .filter(Boolean)
    .filter((state) => STATE_ORDER.indexOf(state) < currentIndex);
  if (frozenBoundary) candidates.push('DIRECTOR_REVIEW_READY');
  if (candidates.length === 0) return result;
  candidates.sort((left, right) => STATE_ORDER.indexOf(left) - STATE_ORDER.indexOf(right));
  const rollbackTarget = candidates[0];
  const disposition = frozenBoundary ? 'blocked' : 'rollback';
  const nextState = frozenBoundary ? 'BLOCKED' : rollbackTarget;
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
