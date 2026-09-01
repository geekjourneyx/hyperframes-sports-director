import { readFile } from 'node:fs/promises';

import {
  computeArtifactDigest,
  loadSchema,
  validateDocument,
  verifyArtifactIntegrity,
} from './contracts.mjs';
import { validateDirectionProposals } from './direction-proposals.mjs';
import { projectPath, sha256File } from './media.mjs';

const DISPLAYED_ROLES = ['assetPlan', 'editBrief', 'evidence', 'musicPlan', 'proposals', 'roughCut'];
const DIGEST = /^[0-9a-f]{64}$/;

export class ApprovalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    Object.assign(this, details);
  }
}

function fail(code, message, details) {
  throw new ApprovalError(code, message, details);
}

function stableEqual(left, right) {
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    }
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

async function readJson(projectRoot, relativePath, code = 'E_SOURCE_INVALID') {
  let value;
  try {
    value = JSON.parse(await readFile(projectPath(projectRoot, relativePath), 'utf8'));
  } catch (error) {
    fail(code, `${relativePath} is missing or unreadable`, { cause: error });
  }
  if (!verifyArtifactIntegrity(value).valid) fail(code, `${relativePath} has a stale integrity digest`);
  return value;
}

async function readContract(projectRoot, relativePath, schemaName, code) {
  const value = await readJson(projectRoot, relativePath, code);
  const validation = validateDocument(await loadSchema(schemaName), value);
  if (!validation.valid) fail(code, `${relativePath} violates ${schemaName}`, { diagnostics: validation.errors });
  return value;
}

function assertDraft(value, kind) {
  const oneDraft = value?.status === 'draft' && value.approvalDigest === null
    && value.lifecycle?.length === 1 && value.lifecycle[0]?.status === 'draft';
  if (!oneDraft) fail('E_DRAFT_REQUIRED', `${kind} must be the one current draft and may not be directly frozen`);
}

function assertCandidateOwnership(candidate) {
  if (!candidate?.wholeDirection || candidate.designCandidate?.candidateId !== candidate.candidateId
    || candidate.lookCandidate?.candidateId !== candidate.candidateId) {
    fail('E_CROSS_CANDIDATE', 'design and Look must come from the same complete selected proposal');
  }
}

function assertLocalMusic(value, at) {
  const strings = [];
  const collect = (entry) => {
    if (typeof entry === 'string') strings.push(entry);
    else if (Array.isArray(entry)) entry.forEach(collect);
    else if (entry && typeof entry === 'object') Object.values(entry).forEach(collect);
  };
  collect(value);
  if (strings.some((entry) => /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(entry))) {
    fail('E_REMOTE_MUSIC', `remote music reference is forbidden at ${at}`);
  }
}

function exactDigestSet(actual, expected) {
  const actualKeys = Object.keys(actual ?? {}).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key] && DIGEST.test(actual[key]));
}

function approvedLifecycle(draft, approvedAt) {
  return [
    ...structuredClone(draft.lifecycle),
    { status: 'proposed', at: approvedAt },
    { status: 'approved', at: approvedAt },
    { status: 'frozen', at: approvedAt },
  ];
}

export function compileApprovedDesign(draft, selectedCandidate, approval, lockedAt = approval?.approvedAt) {
  assertDraft(draft, 'DESIGN_SYSTEM');
  assertCandidateOwnership(selectedCandidate);
  if (!DIGEST.test(approval?.integrity?.digest ?? '') || !Number.isFinite(Date.parse(lockedAt))) {
    fail('E_APPROVAL_INVALID', 'a current approval digest and lock timestamp are required');
  }
  const colors = Object.fromEntries(Object.entries(selectedCandidate.designCandidate.semanticColors).map(([role, value]) => [
    role.startsWith('color.') ? role : `color.${role === 'canvas' ? 'background' : role === 'ink' ? 'primaryText' : role}`,
    value,
  ]));
  const typography = Object.fromEntries(Object.entries(selectedCandidate.designCandidate.typography).map(([role, family]) => [role, { family }]));
  const result = {
    ...structuredClone(draft),
    revision: draft.revision + 1,
    designRevision: selectedCandidate.designRevision,
    status: 'frozen',
    approvalDigest: approval.integrity.digest,
    lifecycle: approvedLifecycle(draft, lockedAt),
    tokens: { ...structuredClone(draft.tokens), colors, typography },
    integrity: {
      digest: null,
      upstream: {
        approval: approval.integrity.digest,
        proposal: approval.displayedArtifactDigests.proposals,
        selectedDesign: computeArtifactDigest(selectedCandidate.designCandidate),
      },
    },
  };
  result.integrity.digest = computeArtifactDigest(result);
  return result;
}

export function compileApprovedLook(draft, selectedCandidate, approval, lockedAt = approval?.approvedAt) {
  assertDraft(draft, 'LOOK_PROFILE');
  assertCandidateOwnership(selectedCandidate);
  if (!DIGEST.test(approval?.integrity?.digest ?? '') || !Number.isFinite(Date.parse(lockedAt))) {
    fail('E_APPROVAL_INVALID', 'a current approval digest and lock timestamp are required');
  }
  const result = {
    ...structuredClone(draft),
    revision: draft.revision + 1,
    lookRevision: selectedCandidate.lookRevision,
    status: 'frozen',
    approvalDigest: approval.integrity.digest,
    lifecycle: approvedLifecycle(draft, lockedAt),
    integrity: {
      digest: null,
      upstream: {
        approval: approval.integrity.digest,
        proposal: approval.displayedArtifactDigests.proposals,
        selectedLook: computeArtifactDigest(selectedCandidate.lookCandidate),
      },
    },
  };
  result.integrity.digest = computeArtifactDigest(result);
  return result;
}

async function validateFrozenContract(value, schemaName) {
  const validation = validateDocument(await loadSchema(schemaName), value);
  if (!validation.valid || !verifyArtifactIntegrity(value).valid || value.status !== 'frozen') {
    fail('E_DIRECTION_PAIR_INVALID', `committed ${schemaName} is not an integrity-valid frozen contract`, { diagnostics: validation.errors });
  }
}

export async function validateDirectorApproval(projectRoot) {
  const [approval, proposals, draftDesign, draftLook, projectState, editBrief, mediaIndex, probe, segments, shots, dataOverlays, timeline, roughCut] = await Promise.all([
    readContract(projectRoot, 'direction/DIRECTOR_APPROVAL.json', 'director-approval', 'E_APPROVAL_INVALID'),
    readContract(projectRoot, 'direction/DIRECTION_PROPOSALS.json', 'direction-proposals', 'E_PROPOSALS_INVALID'),
    readContract(projectRoot, 'direction/DESIGN_SYSTEM.json', 'design-system', 'E_DESIGN_INVALID'),
    readContract(projectRoot, 'direction/LOOK_PROFILE.json', 'look-profile', 'E_LOOK_INVALID'),
    readContract(projectRoot, 'PROJECT_STATE.json', 'project-state', 'E_STATE_INVALID'),
    readJson(projectRoot, 'EDIT_BRIEF.json'),
    readJson(projectRoot, 'analysis/MEDIA_INDEX.json'),
    readJson(projectRoot, 'analysis/PROBE.json'),
    readJson(projectRoot, 'analysis/SEGMENTS.json'),
    readJson(projectRoot, 'analysis/SHOTS.jsonl'),
    readJson(projectRoot, 'direction/DATA_OVERLAYS.json'),
    readJson(projectRoot, 'edit/TIMELINE.json'),
    readJson(projectRoot, 'renders/rough-cut.json'),
  ]);
  if (projectState.state !== 'DIRECTOR_REVIEW_READY') {
    fail(projectState.state === 'DIRECTOR_LOCK' || draftDesign.status === 'frozen' || draftLook.status === 'frozen'
      ? 'E_APPROVAL_CONSUMED' : 'E_APPROVAL_STATE', 'approval is consumable only once from DIRECTOR_REVIEW_READY');
  }
  if (approval.status !== 'approved') fail('E_APPROVAL_INVALID', 'one approved DIRECTOR_APPROVAL is required');
  assertDraft(draftDesign, 'DESIGN_SYSTEM');
  assertDraft(draftLook, 'LOOK_PROFILE');
  const proposalValidation = validateDirectionProposals(proposals);
  if (!proposalValidation.valid) fail('E_PROPOSALS_INVALID', 'direction proposals are incomplete or unsafe', { diagnostics: proposalValidation.errors });
  for (const proposal of proposals.candidates) assertLocalMusic(proposal.musicPlan, proposal.candidateId);
  assertLocalMusic(editBrief.music, 'EDIT_BRIEF.music');

  const selectedCandidate = proposals.candidates.find(({ candidateId }) => candidateId === approval.selectedCandidateId);
  if (!selectedCandidate) fail('E_CANDIDATE_UNKNOWN', 'approval does not select a current whole proposal');
  assertCandidateOwnership(selectedCandidate);
  const evidenceDigest = computeArtifactDigest({
    mediaIndex: mediaIndex.integrity.digest,
    probe: probe.integrity.digest,
    segments: segments.integrity.digest,
    shots: shots.integrity.digest,
    dataOverlays: dataOverlays.integrity.digest,
  });
  const assetPlanDigest = computeArtifactDigest(proposals.candidates.map(({ candidateId, visualWorldPlan, componentPlan, assetPlan }) => ({
    candidateId, visualWorldPlan, componentPlan, assetPlan,
  })));
  const expectedBindings = {
    editBrief: editBrief.integrity.digest,
    roughCut: roughCut.outputDigest,
    musicPlan: computeArtifactDigest(timeline.music),
    assetPlan: assetPlanDigest,
    evidence: evidenceDigest,
    proposals: proposals.integrity.digest,
  };
  const expectedProposalBindings = {
    editBriefDigest: expectedBindings.editBrief,
    evidenceDigest: expectedBindings.evidence,
    roughCutDigest: expectedBindings.roughCut,
    timelineDigest: timeline.integrity.digest,
    musicPlanDigest: expectedBindings.musicPlan,
    assetPlanDigest: expectedBindings.assetPlan,
  };
  if (!exactDigestSet(approval.displayedArtifactDigests, expectedBindings)
    || !stableEqual(proposals.bindings, expectedProposalBindings)) {
    fail('E_APPROVAL_BINDINGS', 'approval or proposal digests are stale, missing, or partial');
  }
  if (roughCut.artifact !== 'renders/rough-cut.mp4'
    || await sha256File(projectPath(projectRoot, roughCut.artifact)) !== roughCut.outputDigest) {
    fail('E_ROUGH_CUT_STALE', 'approval rough cut is not the current closed file');
  }
  if (await sha256File(projectPath(projectRoot, 'review/director-workbench.html')) !== approval.workbenchDigest) {
    fail('E_WORKBENCH_STALE', 'approval workbench digest is stale');
  }
  return { approval, proposals, selectedCandidate, draftDesign, draftLook, projectState };
}

export async function validateCommittedDirection(projectRoot) {
  const [design, look, state, approval] = await Promise.all([
    readJson(projectRoot, 'direction/DESIGN_SYSTEM.json', 'E_DIRECTION_PAIR_INVALID'),
    readJson(projectRoot, 'direction/LOOK_PROFILE.json', 'E_DIRECTION_PAIR_INVALID'),
    readJson(projectRoot, 'PROJECT_STATE.json', 'E_DIRECTION_UNCOMMITTED'),
    readJson(projectRoot, 'direction/DIRECTOR_APPROVAL.json', 'E_DIRECTION_PAIR_INVALID'),
  ]);
  const lockTransition = state.transitions?.findLast((transition) => transition.to === 'DIRECTOR_LOCK');
  const evidence = lockTransition?.evidenceDigests ?? {};
  const committedState = ['DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION', 'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED'].includes(state.state);
  if (!committedState || !lockTransition) {
    fail('E_DIRECTION_UNCOMMITTED', 'consumers require a state-committed frozen design/Look pair');
  }
  await Promise.all([validateFrozenContract(design, 'design-system'), validateFrozenContract(look, 'look-profile')]);
  if (evidence.DESIGN_SYSTEM !== design.integrity.digest || evidence.LOOK_PROFILE !== look.integrity.digest
    || evidence.DIRECTOR_APPROVAL !== approval.integrity.digest || design.approvalDigest !== approval.integrity.digest
    || look.approvalDigest !== approval.integrity.digest) {
    fail('E_DIRECTION_UNCOMMITTED', 'consumers require one state-committed matching frozen design/Look pair');
  }
  return { design, look, state, approval, workbenchDigest: evidence.WORKBENCH ?? null };
}

export { DISPLAYED_ROLES };
