const MAIN_STATES = [
  'INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT',
  'DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION',
  'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED',
];
const TERMINAL_STATES = new Set(['BLOCKED', 'CANCELLED']);
const DIGEST = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const GATE_REQUIREMENTS = {
  STYLE_ANCHOR: { code: 'E_STYLE_ANCHOR_GATE', roles: { DESIGN_SYSTEM: 'frozen', LOOK_PROFILE: 'frozen', ASSET_PLAN: 'approved' } },
  ASSET_PRODUCTION: { code: 'E_ASSET_PRODUCTION_GATE', roles: { STYLE_ANCHOR: 'accepted', REPRESENTATIVE_COMBINATION: 'accepted' } },
  DELIVERED: {
    code: 'E_DELIVERY_GATE',
    roles: {
      CLOSED_FILE_PROBE: 'passed', HARD_GATES: 'passed',
      AGENT_VISUAL_INSPECTION: 'accepted', ENCODED_MP4_EVIDENCE: 'accepted',
    },
  },
};

export class ProjectStateError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectStateError';
    this.code = code;
    Object.assign(this, details);
  }
}

function transitionAllowed(current, next) {
  const index = MAIN_STATES.indexOf(current);
  return index >= 0 && (MAIN_STATES[index + 1] === next || TERMINAL_STATES.has(next));
}

export function validateGateEvidence(next, records, currentArtifacts, options = {}) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new ProjectStateError('E_EVIDENCE_REQUIRED', `${next} requires auditable gate evidence`, { next });
  }
  if (currentArtifacts === null || typeof currentArtifacts !== 'object' || Array.isArray(currentArtifacts)) {
    throw new ProjectStateError('E_EVIDENCE_INVALID', 'currentArtifacts must map artifact roles to revision and digest');
  }
  const roles = new Set();
  for (const record of records) {
    const qualifiers = record?.qualifiers;
    if (record === null || typeof record !== 'object' || record.gate !== next
      || typeof record.role !== 'string' || record.role.length === 0 || roles.has(record.role)
      || !Number.isInteger(record.revision) || record.revision < 1 || !DIGEST.test(record.digest ?? '')
      || typeof record.timestamp !== 'string' || !ISO_TIMESTAMP.test(record.timestamp) || !Number.isFinite(Date.parse(record.timestamp))
      || (options.timestamp !== undefined && record.timestamp !== options.timestamp)
      || (!options.allowInvalidated && (record.validity !== 'valid' || record.invalidatedAt !== null))
      || typeof record.producerCommand !== 'string' || record.producerCommand.trim().length === 0
      || !Array.isArray(qualifiers) || qualifiers.length === 0 || new Set(qualifiers).size !== qualifiers.length
      || qualifiers.some((value) => typeof value !== 'string' || value.length === 0)) {
      throw new ProjectStateError('E_EVIDENCE_INVALID', 'gate evidence must bind gate, unique role, revision, digest, ISO timestamp, producer command, and unique qualifiers');
    }
    roles.add(record.role);
    const current = currentArtifacts[record.role];
    if (current?.revision !== record.revision || current?.digest !== record.digest) {
      throw new ProjectStateError('E_STALE_EVIDENCE', `stale evidence for ${record.role}`, { role: record.role });
    }
  }
  const requirement = GATE_REQUIREMENTS[next];
  if (requirement && !options.skipGateRequirements) {
    const expectedRoles = Object.keys(requirement.roles).sort();
    const actualRoles = [...roles].sort();
    const exactRoles = expectedRoles.length === actualRoles.length && expectedRoles.every((role, index) => role === actualRoles[index]);
    const exactQualifiers = records.every((record) => record.qualifiers.length === 1 && record.qualifiers[0] === requirement.roles[record.role]);
    if (!exactRoles || !exactQualifiers) throw new ProjectStateError(requirement.code, `${next} evidence requirements are not satisfied`);
  }
  return true;
}

export function validateTransition(current, next, evidence) {
  if (!transitionAllowed(current, next)) {
    throw new ProjectStateError('E_STATE_TRANSITION', `${current} cannot transition to ${next}`, { current, next });
  }
  return validateGateEvidence(next, evidence?.records, evidence?.currentArtifacts);
}

export function hasGateRequirements(state) {
  return Object.hasOwn(GATE_REQUIREMENTS, state);
}

export { MAIN_STATES };
