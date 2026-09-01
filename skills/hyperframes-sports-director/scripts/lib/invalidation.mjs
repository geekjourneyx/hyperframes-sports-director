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

export function rollbackStateForInvalidation(projectState, invalidatedRoles) {
  if (projectState === null || typeof projectState !== 'object' || Array.isArray(projectState)) {
    throw new TypeError('projectState must be an object');
  }
  if (!Array.isArray(invalidatedRoles)) throw new TypeError('invalidatedRoles must be an array');
  const result = structuredClone(projectState);
  if (invalidatedRoles.some((role) => FROZEN_BOUNDARY_ROLES.has(role))) {
    result.state = 'BLOCKED';
    result.previousState = projectState.state;
    result.revision = (projectState.revision ?? 0) + 1;
    return result;
  }
  const currentIndex = STATE_ORDER.indexOf(projectState.state);
  const candidates = invalidatedRoles
    .map((role) => ROLLBACK_STATE[role])
    .filter(Boolean)
    .filter((state) => STATE_ORDER.indexOf(state) < currentIndex);
  if (candidates.length === 0) return result;
  candidates.sort((left, right) => STATE_ORDER.indexOf(left) - STATE_ORDER.indexOf(right));
  result.previousState = projectState.state;
  result.state = candidates[0];
  result.revision = (projectState.revision ?? 0) + 1;
  return result;
}
