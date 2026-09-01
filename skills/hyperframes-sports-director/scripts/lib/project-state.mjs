const MAIN_STATES = [
  'INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT',
  'DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION',
  'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED',
];
const TERMINAL_STATES = new Set(['BLOCKED', 'CANCELLED']);
const DIGEST = /^[0-9a-f]{64}$/;

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

function hasQualifiedRole(records, role, qualifier) {
  return records.some((record) => record.role === role && record.qualifiers.includes(qualifier));
}

function validateGate(next, records) {
  if (next === 'STYLE_ANCHOR') {
    if (!hasQualifiedRole(records, 'DESIGN_SYSTEM', 'frozen')
      || !hasQualifiedRole(records, 'LOOK_PROFILE', 'frozen')
      || !hasQualifiedRole(records, 'ASSET_PLAN', 'approved')) {
      throw new ProjectStateError('E_STYLE_ANCHOR_GATE', 'STYLE_ANCHOR requires frozen design and Look digests plus an approved asset plan');
    }
  }
  if (next === 'ASSET_PRODUCTION') {
    if (!hasQualifiedRole(records, 'STYLE_ANCHOR', 'accepted')
      || !hasQualifiedRole(records, 'REPRESENTATIVE_COMBINATION', 'accepted')) {
      throw new ProjectStateError('E_ASSET_PRODUCTION_GATE', 'ASSET_PRODUCTION requires accepted Style Anchor and representative combination evidence');
    }
  }
  if (next === 'DELIVERED') {
    const requirements = [
      ['CLOSED_FILE_PROBE', 'passed'],
      ['HARD_GATES', 'passed'],
      ['AGENT_VISUAL_INSPECTION', 'accepted'],
      ['ENCODED_MP4_EVIDENCE', 'accepted'],
    ];
    if (requirements.some(([role, qualifier]) => !hasQualifiedRole(records, role, qualifier))) {
      throw new ProjectStateError('E_DELIVERY_GATE', 'DELIVERED requires closed-file probe, hard gates, Agent inspection, and encoded-MP4 evidence');
    }
  }
}

export function validateTransition(current, next, evidence) {
  if (!transitionAllowed(current, next)) {
    throw new ProjectStateError('E_STATE_TRANSITION', `${current} cannot transition to ${next}`, { current, next });
  }
  const records = evidence?.records;
  if (!Array.isArray(records) || records.length === 0) {
    throw new ProjectStateError('E_EVIDENCE_REQUIRED', `${next} requires auditable gate evidence`, { next });
  }
  const currentDigests = evidence?.currentDigests;
  if (currentDigests === null || typeof currentDigests !== 'object' || Array.isArray(currentDigests)) {
    throw new ProjectStateError('E_EVIDENCE_INVALID', 'currentDigests must be an artifact-role digest map');
  }
  for (const record of records) {
    if (record === null || typeof record !== 'object'
      || typeof record.role !== 'string' || record.role.length === 0
      || !Number.isInteger(record.revision) || record.revision < 1
      || !DIGEST.test(record.digest ?? '')
      || !Number.isFinite(Date.parse(record.timestamp))
      || typeof record.producerCommand !== 'string' || record.producerCommand.trim().length === 0
      || !Array.isArray(record.qualifiers) || record.qualifiers.some((value) => typeof value !== 'string' || value.length === 0)) {
      throw new ProjectStateError('E_EVIDENCE_INVALID', 'gate evidence requires role, revision, digest, timestamp, producer command, and qualifiers');
    }
    if (currentDigests[record.role] !== record.digest) {
      throw new ProjectStateError('E_STALE_EVIDENCE', `stale evidence for ${record.role}`, { role: record.role });
    }
  }
  validateGate(next, records);
  return true;
}

export { MAIN_STATES };
