const STATE_ORDER = [
  'INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT',
  'DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION',
  'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED',
];

const ROLLBACK_TARGET_BY_ROLE = {
  MEDIA_INDEX: 'CAPABILITY_CHECK',
  PROBE: 'SCAN',
  ACTIVITY: 'SCAN',
  DATA_OVERLAYS: 'ANALYZE',
  TIMELINE: 'ASSET_PRODUCTION',
  ASSET_MANIFEST: 'STYLE_ANCHOR',
  MOTION_MAP: 'ASSET_PRODUCTION',
  FINAL_RENDER: 'MOTION_COMPOSITION',
  REVIEW: 'FINAL_RENDER',
  DESIGN_SYSTEM: 'DIRECTOR_REVIEW_READY',
  LOOK_PROFILE: 'DIRECTOR_REVIEW_READY',
};

const FROZEN_BOUNDARY_ROLES = new Set(['DESIGN_SYSTEM', 'LOOK_PROFILE']);

export function deriveInvalidationPolicy(invalidatedRoles, fromState) {
  if (!Array.isArray(invalidatedRoles) || invalidatedRoles.length === 0) {
    throw new TypeError('invalidatedRoles must be a non-empty array');
  }
  const unknownRoles = invalidatedRoles.filter((role) => !Object.hasOwn(ROLLBACK_TARGET_BY_ROLE, role));
  if (unknownRoles.length > 0) throw new TypeError(`unsupported invalidation roles: ${unknownRoles.join(', ')}`);
  const fromIndex = STATE_ORDER.indexOf(fromState);
  if (fromIndex < 0) throw new TypeError(`unsupported invalidation source state: ${fromState}`);
  const candidates = invalidatedRoles
    .map((role) => ROLLBACK_TARGET_BY_ROLE[role])
    .filter((state) => STATE_ORDER.indexOf(state) < fromIndex)
    .sort((left, right) => STATE_ORDER.indexOf(left) - STATE_ORDER.indexOf(right));
  if (candidates.length === 0) return null;
  const frozenBoundary = invalidatedRoles.some((role) => FROZEN_BOUNDARY_ROLES.has(role));
  const rollbackTarget = candidates[0];
  return {
    rollbackTarget,
    disposition: frozenBoundary ? 'blocked' : 'rollback',
    nextState: frozenBoundary ? 'BLOCKED' : rollbackTarget,
  };
}
