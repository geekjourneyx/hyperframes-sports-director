import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';

import { computeArtifactDigest, loadSchema, validateDocument, verifyArtifactIntegrity } from './contracts.mjs';
import { loadDirectionSources, validateDirectionProposals, validateProposalPreviewArtifacts } from './direction-proposals.mjs';
import { projectPath, sha256File } from './media.mjs';
import { validateGateEvidence } from './project-state.mjs';

const DISPLAYED_ROLES = ['assetPlan', 'editBrief', 'evidence', 'musicPlan', 'proposals', 'roughCut'];
const DIGEST = /^[0-9a-f]{64}$/;
const LOCKED_STATES = new Set(['DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION', 'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED']);

export class ApprovalError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'ApprovalError'; this.code = code; Object.assign(this, details); }
}

function fail(code, message, details) { throw new ApprovalError(code, message, details); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function stableEqual(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }

async function readJson(projectRoot, relativePath, code = 'E_SOURCE_INVALID') {
  let value;
  try { value = JSON.parse(await readFile(projectPath(projectRoot, relativePath), 'utf8')); }
  catch (error) { fail(code, `${relativePath} is missing or unreadable`, { cause: error }); }
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
  if (!(value?.status === 'draft' && value.approvalDigest === null && value.lifecycle?.length === 1 && value.lifecycle[0]?.status === 'draft')) {
    fail('E_DRAFT_REQUIRED', `${kind} must be the one current draft and may not be directly frozen`);
  }
}
function assertCandidateOwnership(candidate) {
  if (!candidate?.wholeDirection || candidate.designCandidate?.candidateId !== candidate.candidateId || candidate.lookCandidate?.candidateId !== candidate.candidateId) {
    fail('E_CROSS_CANDIDATE', 'design and Look must come from the same complete selected proposal');
  }
}
function exactDigestSet(actual, expected) {
  const actualKeys = Object.keys(actual ?? {}).sort(); const expectedKeys = Object.keys(expected).sort();
  return stableEqual(actualKeys, expectedKeys) && actualKeys.every((key) => DIGEST.test(actual[key]) && actual[key] === expected[key]);
}
function approvedLifecycle(draft, approvedAt) {
  return [...structuredClone(draft.lifecycle), { status: 'proposed', at: approvedAt }, { status: 'approved', at: approvedAt }, { status: 'frozen', at: approvedAt }];
}

export function compileApprovedDesign(draft, selectedCandidate, approval, lockedAt = approval?.approvedAt) {
  assertDraft(draft, 'DESIGN_SYSTEM'); assertCandidateOwnership(selectedCandidate);
  if (!DIGEST.test(approval?.integrity?.digest ?? '') || !Number.isFinite(Date.parse(lockedAt))) fail('E_APPROVAL_INVALID', 'a current approval digest and lock timestamp are required');
  const mapped = Object.fromEntries(Object.entries(selectedCandidate.designCandidate.semanticColors).map(([role, value]) => [role.startsWith('color.') ? role : `color.${role === 'canvas' ? 'background' : role === 'ink' ? 'primaryText' : role}`, value]));
  const typography = Object.fromEntries(Object.entries(selectedCandidate.designCandidate.typography).map(([role, family]) => [role, { family }]));
  const candidateDigest = computeArtifactDigest(selectedCandidate);
  const upstream = { approval: approval.integrity.digest, proposal: approval.displayedArtifactDigests.proposals, selectedCandidate: candidateDigest, selectedDesign: computeArtifactDigest(selectedCandidate.designCandidate), selectedLook: computeArtifactDigest(selectedCandidate.lookCandidate) };
  const result = { ...structuredClone(draft), revision: draft.revision + 1, designRevision: selectedCandidate.designRevision, status: 'frozen', approvalDigest: approval.integrity.digest, lifecycle: approvedLifecycle(draft, lockedAt), tokens: { ...structuredClone(draft.tokens), colors: { ...structuredClone(draft.tokens.colors), ...mapped }, typography }, selectedDirection: { candidateId: selectedCandidate.candidateId, digest: candidateDigest, candidate: structuredClone(selectedCandidate) }, integrity: { digest: null, upstream } };
  result.integrity.digest = computeArtifactDigest(result); return result;
}

export function compileApprovedLook(draft, selectedCandidate, approval, lockedAt = approval?.approvedAt) {
  assertDraft(draft, 'LOOK_PROFILE'); assertCandidateOwnership(selectedCandidate);
  if (!DIGEST.test(approval?.integrity?.digest ?? '') || !Number.isFinite(Date.parse(lockedAt))) fail('E_APPROVAL_INVALID', 'a current approval digest and lock timestamp are required');
  const candidateDigest = computeArtifactDigest(selectedCandidate);
  const upstream = { approval: approval.integrity.digest, proposal: approval.displayedArtifactDigests.proposals, selectedCandidate: candidateDigest, selectedDesign: computeArtifactDigest(selectedCandidate.designCandidate), selectedLook: computeArtifactDigest(selectedCandidate.lookCandidate) };
  const result = { ...structuredClone(draft), revision: draft.revision + 1, lookRevision: selectedCandidate.lookRevision, status: 'frozen', approvalDigest: approval.integrity.digest, lifecycle: approvedLifecycle(draft, lockedAt), selectedLook: structuredClone(selectedCandidate.lookCandidate), directionBinding: { candidateId: selectedCandidate.candidateId, candidateDigest }, integrity: { digest: null, upstream } };
  result.integrity.digest = computeArtifactDigest(result); return result;
}

async function hashPaths(projectRoot, paths, code) {
  const result = {};
  for (const relativePath of [...new Set(paths)].sort()) {
    try { result[relativePath] = await sha256File(projectPath(projectRoot, relativePath)); }
    catch (error) { fail(code, `${relativePath} is missing or unreadable`, { cause: error }); }
  }
  return result;
}
function workbenchBundlePaths(html) {
  const paths = [];
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
    const decoded = decodeURIComponent(match[1].replace(/^\//, ''));
    if (decoded.startsWith('workbench-assets/')) paths.push(`review/${decoded}`);
  }
  return paths;
}
function assertMusicAuthority(projectRoot, editBrief, timeline, proposals) {
  const declared = editBrief.music?.localTracks ?? [];
  if (declared.some((entry) => typeof entry !== 'string' || entry !== entry.trim() || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(entry))) fail('E_REMOTE_MUSIC', 'EDIT_BRIEF localTracks must be exact local project paths without obscuring whitespace');
  const approved = new Set(declared);
  if (timeline.music?.mode === 'none') {
    if (proposals.candidates.some(({ musicPlan }) => musicPlan.mode !== 'none' || musicPlan.trackIds.length)) fail('E_MUSIC_AUTHORITY', 'no-music timeline cannot approve tracks');
    return [];
  }
  const selected = timeline.music?.path;
  if (typeof selected !== 'string' || selected !== selected.trim() || !approved.has(selected)) fail('E_MUSIC_AUTHORITY', 'timeline music must resolve exactly to EDIT_BRIEF localTracks');
  for (const candidate of proposals.candidates) {
    const ids = candidate.musicPlan?.trackIds ?? [];
    if (ids.some((entry) => typeof entry !== 'string' || entry !== entry.trim() || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(entry))) fail('E_REMOTE_MUSIC', `remote or whitespace-obscured music is forbidden for ${candidate.candidateId}`);
    if (ids.length !== 1 || ids[0] !== selected || !approved.has(ids[0])) fail('E_MUSIC_AUTHORITY', 'every proposal must bind the exact selected local music contract');
  }
  projectPath(projectRoot, selected); return [selected];
}

async function captureApprovalAuthority(projectRoot) {
  let sources;
  try { sources = await loadDirectionSources(projectRoot); }
  catch (error) { fail(error.code ?? 'E_SOURCE_INVALID', error.message, { cause: error, diagnostics: error.diagnostics }); }
  const [approval, proposals, html] = await Promise.all([
    readContract(projectRoot, 'direction/DIRECTOR_APPROVAL.json', 'director-approval', 'E_APPROVAL_INVALID'),
    readContract(projectRoot, 'direction/DIRECTION_PROPOSALS.json', 'direction-proposals', 'E_PROPOSALS_INVALID'),
    readFile(projectPath(projectRoot, 'review/director-workbench.html'), 'utf8'),
  ]);
  if (approval.status !== 'approved') fail('E_APPROVAL_INVALID', 'one approved DIRECTOR_APPROVAL is required');
  const proposalValidation = validateDirectionProposals(proposals);
  if (!proposalValidation.valid) fail('E_PROPOSALS_INVALID', 'direction proposals are incomplete or unsafe', { diagnostics: proposalValidation.errors });
  try { await validateProposalPreviewArtifacts(projectRoot, proposals); } catch (error) { fail(error.code ?? 'E_PREVIEW_STALE', error.message, { cause: error }); }
  const selectedCandidate = proposals.candidates.find(({ candidateId }) => candidateId === approval.selectedCandidateId);
  if (!selectedCandidate) fail('E_CANDIDATE_UNKNOWN', 'approval does not select a current whole proposal');
  assertCandidateOwnership(selectedCandidate);
  const evidenceDigest = computeArtifactDigest({ mediaIndex: sources.mediaIndex.integrity.digest, probe: sources.probe.integrity.digest, segments: sources.segments.integrity.digest, shots: sources.shots.integrity.digest, dataOverlays: sources.dataOverlays.integrity.digest });
  const assetPlanDigest = computeArtifactDigest(proposals.candidates.map(({ candidateId, visualWorldPlan, componentPlan, assetPlan }) => ({ candidateId, visualWorldPlan, componentPlan, assetPlan })));
  const expectedBindings = { editBrief: sources.editBrief.integrity.digest, roughCut: sources.roughCut.outputDigest, musicPlan: computeArtifactDigest(sources.timeline.music), assetPlan: assetPlanDigest, evidence: evidenceDigest, proposals: proposals.integrity.digest };
  const expectedProposalBindings = { editBriefDigest: expectedBindings.editBrief, evidenceDigest: expectedBindings.evidence, roughCutDigest: expectedBindings.roughCut, timelineDigest: sources.timeline.integrity.digest, musicPlanDigest: expectedBindings.musicPlan, assetPlanDigest: expectedBindings.assetPlan };
  if (!exactDigestSet(approval.displayedArtifactDigests, expectedBindings) || !stableEqual(proposals.bindings, expectedProposalBindings)) fail('E_APPROVAL_BINDINGS', 'approval or proposal digests are stale, missing, or partial');
  const displayedMatch = html.match(/<script type="application\/json" data-displayed-digests>([^<]+)<\/script>/);
  let displayed;
  try { displayed = JSON.parse(displayedMatch?.[1] ?? ''); } catch { fail('E_WORKBENCH_STALE', 'workbench lacks its canonical displayed digest binding'); }
  if (!stableEqual(displayed, expectedBindings)) fail('E_WORKBENCH_STALE', 'workbench displayed digests no longer match current approval authority');
  const musicPaths = assertMusicAuthority(projectRoot, sources.editBrief, sources.timeline, proposals);
  const evidencePaths = sources.segments.segments.flatMap(({ evidenceFrames }) => evidenceFrames.map(({ path }) => path));
  const bundlePaths = workbenchBundlePaths(html);
  const previewFiles = Object.fromEntries(proposals.candidates.flatMap(({ previewArtifactDigests }) => Object.entries(previewArtifactDigests)).sort(([left], [right]) => left.localeCompare(right)));
  const [evidenceFiles, bundleFiles, musicFiles] = await Promise.all([hashPaths(projectRoot, evidencePaths, 'E_EVIDENCE_STALE'), hashPaths(projectRoot, bundlePaths, 'E_WORKBENCH_STALE'), hashPaths(projectRoot, musicPaths, 'E_MUSIC_AUTHORITY')]);
  for (const [path, digest] of Object.entries(bundleFiles)) {
    const match = basename(path).match(/-([0-9a-f]{64})(?:\.[^.]+)$/);
    if (!match || match[1] !== digest) fail('E_WORKBENCH_STALE', `workbench bundle asset ${path} is stale`);
  }
  for (const [sourcePath, digest] of Object.entries(evidenceFiles)) {
    const stableName = basename(sourcePath).replace(/\.[^.]+$/, '');
    const published = Object.keys(bundleFiles).find((path) => basename(path).startsWith(`${stableName}-`));
    if (!published || !basename(published).includes(`-${digest}.`)) fail('E_EVIDENCE_STALE', `displayed evidence ${sourcePath} no longer matches its immutable workbench bundle`);
  }
  for (const [sourcePath, digest] of Object.entries(previewFiles)) {
    const stableName = basename(sourcePath).replace(/\.[^.]+$/, '');
    const published = Object.keys(bundleFiles).find((path) => basename(path).startsWith(`${stableName}-`));
    if (!published || !basename(published).includes(`-${digest}.`)) fail('E_PREVIEW_STALE', `prototype ${sourcePath} no longer matches its immutable workbench bundle`);
  }
  const roughBundle = Object.keys(bundleFiles).find((path) => basename(path).startsWith('rough-cut-'));
  if (!roughBundle || !basename(roughBundle).includes(`-${sources.roughCut.outputDigest}.`)) fail('E_WORKBENCH_STALE', 'displayed rough cut no longer matches its immutable workbench bundle');
  const workbenchDigest = createHash('sha256').update(html).digest('hex');
  if (workbenchDigest !== approval.workbenchDigest) fail('E_WORKBENCH_STALE', 'approval workbench digest is stale');
  const inputDigests = { approval: approval.integrity.digest, proposals: proposals.integrity.digest, state: sources.projectState.integrity.digest, editBrief: sources.editBrief.integrity.digest, mediaIndex: sources.mediaIndex.integrity.digest, probe: sources.probe.integrity.digest, segments: sources.segments.integrity.digest, shots: sources.shots.integrity.digest, dataOverlays: sources.dataOverlays.integrity.digest, timeline: sources.timeline.integrity.digest, roughCut: sources.roughCut.outputDigest, workbench: workbenchDigest, evidenceFiles: computeArtifactDigest(evidenceFiles), bundleFiles: computeArtifactDigest(bundleFiles), musicFiles: computeArtifactDigest(musicFiles), previewFiles: computeArtifactDigest(previewFiles) };
  return { approval, proposals, selectedCandidate, sources, inputDigests };
}

export async function validateDirectorApproval(projectRoot) {
  const authority = await captureApprovalAuthority(projectRoot);
  const [draftDesign, draftLook] = await Promise.all([readContract(projectRoot, 'direction/DESIGN_SYSTEM.json', 'design-system', 'E_DESIGN_INVALID'), readContract(projectRoot, 'direction/LOOK_PROFILE.json', 'look-profile', 'E_LOOK_INVALID')]);
  if (authority.sources.projectState.state !== 'DIRECTOR_REVIEW_READY') fail(authority.sources.projectState.state === 'DIRECTOR_LOCK' || draftDesign.status === 'frozen' || draftLook.status === 'frozen' ? 'E_APPROVAL_CONSUMED' : 'E_APPROVAL_STATE', 'approval is consumable only once from DIRECTOR_REVIEW_READY');
  assertDraft(draftDesign, 'DESIGN_SYSTEM'); assertDraft(draftLook, 'LOOK_PROFILE');
  return { ...authority, draftDesign, draftLook, projectState: authority.sources.projectState, inputDigests: { ...authority.inputDigests, draftDesign: draftDesign.integrity.digest, draftLook: draftLook.integrity.digest } };
}

export async function revalidateDirectorApprovalInputs(projectRoot, expected) {
  const current = await captureApprovalAuthority(projectRoot); const comparable = { ...expected }; delete comparable.draftDesign; delete comparable.draftLook;
  if (!stableEqual(current.inputDigests, comparable)) fail('E_LOCK_INPUT_STALE', 'validated lock inputs changed before commit');
  return current;
}

async function validateFrozenContract(value, schemaName) {
  const validation = validateDocument(await loadSchema(schemaName), value);
  if (!validation.valid || !verifyArtifactIntegrity(value).valid || value.status !== 'frozen') fail('E_DIRECTION_PAIR_INVALID', `committed ${schemaName} is not an integrity-valid frozen contract`, { diagnostics: validation.errors });
}

export function lockedWorkbenchBinding(state, selectedCandidate) {
  const transition = state.transitions?.findLast(({ to }) => to === 'DIRECTOR_LOCK');
  return computeArtifactDigest({ stateRevision: transition?.evidenceRevisions?.WORKBENCH, at: transition?.at, selectedCandidateId: selectedCandidate.candidateId, selectedCandidateDigest: computeArtifactDigest(selectedCandidate), evidenceDigests: Object.fromEntries(Object.entries(transition?.evidenceDigests ?? {}).filter(([role]) => role !== 'WORKBENCH').sort()), evidenceRevisions: Object.fromEntries(Object.entries(transition?.evidenceRevisions ?? {}).filter(([role]) => role !== 'WORKBENCH').sort()) });
}
export function renderLockedWorkbench(state, selectedCandidate) {
  const transition = state.transitions?.findLast(({ to }) => to === 'DIRECTOR_LOCK'); const lockRevision = transition?.evidenceRevisions?.WORKBENCH;
  const binding = lockedWorkbenchBinding(state, selectedCandidate); const title = String(selectedCandidate.title).replace(/[&<>"']/g, '');
  return `<!doctype html>\n<html lang="en" data-state="DIRECTOR_LOCK" data-state-revision="${lockRevision}" data-state-binding="${binding}"><head><meta charset="utf-8"><title>Locked Director Direction</title></head><body><main><p>DIRECTOR LOCK · READ-ONLY</p><h1>${title}</h1><p>${selectedCandidate.candidateId}</p></main></body></html>\n`;
}

export async function validateCommittedDirection(projectRoot) {
  const [design, look, state, approval, proposals, html] = await Promise.all([
    readContract(projectRoot, 'direction/DESIGN_SYSTEM.json', 'design-system', 'E_DIRECTION_PAIR_INVALID'), readContract(projectRoot, 'direction/LOOK_PROFILE.json', 'look-profile', 'E_DIRECTION_PAIR_INVALID'), readContract(projectRoot, 'PROJECT_STATE.json', 'project-state', 'E_DIRECTION_UNCOMMITTED'), readContract(projectRoot, 'direction/DIRECTOR_APPROVAL.json', 'director-approval', 'E_DIRECTION_PAIR_INVALID'), readContract(projectRoot, 'direction/DIRECTION_PROPOSALS.json', 'direction-proposals', 'E_DIRECTION_PAIR_INVALID'), readFile(projectPath(projectRoot, 'review/director-workbench.html'), 'utf8'),
  ]);
  if (!LOCKED_STATES.has(state.state)) fail('E_DIRECTION_UNCOMMITTED', 'consumers require a state-committed frozen design/Look pair');
  const transitions = state.transitions.filter(({ to }) => to === 'DIRECTOR_LOCK'); if (transitions.length !== 1) fail('E_DIRECTION_UNCOMMITTED', 'exactly one DIRECTOR_LOCK transition is required');
  const transition = transitions[0]; const requiredRoles = ['DESIGN_SYSTEM', 'LOOK_PROFILE', 'DIRECTOR_APPROVAL', 'WORKBENCH'];
  const exactRoleMap = (value) => stableEqual(Object.keys(value ?? {}).sort(), requiredRoles.slice().sort());
  const lockRevision = transition.evidenceRevisions?.WORKBENCH;
  if (transition.from !== 'DIRECTOR_REVIEW_READY' || !exactRoleMap(transition.evidenceDigests) || !exactRoleMap(transition.evidenceRevisions)
    || (state.state === 'DIRECTOR_LOCK' && state.revision !== lockRevision)) fail('E_DIRECTION_UNCOMMITTED', 'DIRECTOR_LOCK transition origin, roles, or revisions are not exact');
  await Promise.all([validateFrozenContract(design, 'design-system'), validateFrozenContract(look, 'look-profile')]);
  const selected = proposals.candidates.find(({ candidateId }) => candidateId === approval.selectedCandidateId); if (!selected) fail('E_DIRECTION_UNCOMMITTED', 'locked candidate no longer resolves');
  const candidateDigest = computeArtifactDigest(selected); const expectedUpstream = { approval: approval.integrity.digest, proposal: proposals.integrity.digest, selectedCandidate: candidateDigest, selectedDesign: computeArtifactDigest(selected.designCandidate), selectedLook: computeArtifactDigest(selected.lookCandidate) };
  if (!stableEqual(design.integrity.upstream, expectedUpstream) || !stableEqual(look.integrity.upstream, expectedUpstream) || !stableEqual(design.selectedDirection?.candidate, selected) || design.selectedDirection?.candidateId !== selected.candidateId || design.selectedDirection?.digest !== candidateDigest || !stableEqual(look.selectedLook, selected.lookCandidate) || look.directionBinding?.candidateId !== selected.candidateId || look.directionBinding?.candidateDigest !== candidateDigest) fail('E_DIRECTION_UNCOMMITTED', 'frozen contracts do not preserve the exact selected proposal origins');
  const workbenchDigest = createHash('sha256').update(html).digest('hex'); const records = state.gateEvidence.filter(({ gate }) => gate === 'DIRECTOR_LOCK');
  if (records.some(({ producerCommand }) => producerCommand !== 'lock_direction.mjs')) fail('E_DIRECTION_UNCOMMITTED', 'DIRECTOR_LOCK evidence producer is not authoritative');
  try { validateGateEvidence('DIRECTOR_LOCK', records, { DESIGN_SYSTEM: { revision: design.revision, digest: design.integrity.digest }, LOOK_PROFILE: { revision: look.revision, digest: look.integrity.digest }, DIRECTOR_APPROVAL: { revision: approval.revision, digest: approval.integrity.digest }, WORKBENCH: { revision: lockRevision, digest: workbenchDigest } }, { timestamp: transition.at }); }
  catch (error) { fail('E_DIRECTION_UNCOMMITTED', error.message, { cause: error }); }
  const evidence = transition.evidenceDigests;
  if (transition.evidenceRevisions.DESIGN_SYSTEM !== design.revision || transition.evidenceRevisions.LOOK_PROFILE !== look.revision || transition.evidenceRevisions.DIRECTOR_APPROVAL !== approval.revision || evidence.DESIGN_SYSTEM !== design.integrity.digest || evidence.LOOK_PROFILE !== look.integrity.digest || evidence.DIRECTOR_APPROVAL !== approval.integrity.digest || design.approvalDigest !== approval.integrity.digest || look.approvalDigest !== approval.integrity.digest || evidence.WORKBENCH !== workbenchDigest || html !== renderLockedWorkbench(state, selected)) fail('E_DIRECTION_UNCOMMITTED', 'committed direction evidence or canonical workbench is stale');
  return { design, look, state, approval, workbenchDigest };
}

export { DISPLAYED_ROLES };
