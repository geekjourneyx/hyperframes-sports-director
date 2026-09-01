import { basename, dirname } from 'node:path';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';

import { computeArtifactDigest, loadSchema, validateDocument, verifyArtifactIntegrity } from './contracts.mjs';
import { projectPath, sha256File } from './media.mjs';

const DIGEST = /^[0-9a-f]{64}$/;
const REQUIRED_CANDIDATE_KEYS = [
  'candidateId', 'title', 'thesis', 'wholeDirection', 'representativeEvidenceIds', 'copy', 'viewport',
  'informationDensityBudget', 'prototypeKind', 'designRevision', 'designCandidate', 'lookRevision', 'lookCandidate',
  'typographyHierarchy', 'storyStructure', 'visualWorldPlan', 'componentPlan', 'layoutProofs', 'motionStoryboard',
  'assetPlan', 'musicPlan', 'risks', 'previewArtifactDigests',
];

export class DirectionProposalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DirectionProposalError';
    this.code = code;
    Object.assign(this, details);
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function stableEqual(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function allStrings(value, at = '') {
  if (typeof value === 'string') return [{ value, at }];
  if (Array.isArray(value)) return value.flatMap((entry, index) => allStrings(entry, `${at}/${index}`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => allStrings(entry, `${at}/${key}`));
  }
  return [];
}

function assertSafeCandidate(candidate) {
  for (const { value, at } of allStrings(candidate)) {
    if (/\braw\s*gps\b|(?:^|\D)-?\d{1,2}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}(?:\D|$)/i.test(value)) {
      throw new DirectionProposalError('E_RAW_GPS', `raw GPS is forbidden at ${at}`);
    }
    if (/^(?:https?:)?\/\//i.test(value)) throw new DirectionProposalError('E_REFERENCE_REMOTE', `remote reference is forbidden at ${at}`);
    if (/^data:/i.test(value) || /;base64,/i.test(value)) throw new DirectionProposalError('E_REFERENCE_EMBEDDED', `embedded media is forbidden at ${at}`);
    if (/^(?:\/|[A-Za-z]:[\\/])/.test(value)) throw new DirectionProposalError('E_REFERENCE_ABSOLUTE', `absolute reference is forbidden at ${at}`);
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value) || value.includes('\\')) {
      throw new DirectionProposalError('E_REFERENCE_TRAVERSAL', `path traversal is forbidden at ${at}`);
    }
    if (/(?:^|\/)media\/originals(?:\/|$)/.test(value)) {
      throw new DirectionProposalError('E_REFERENCE_ORIGINAL', `original-media reference is forbidden at ${at}`);
    }
  }
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertIdDerivedPrototypePaths(candidate) {
  for (const [role, paths] of [['layout', candidate.layoutProofs ?? []], ['motion', candidate.motionStoryboard ?? []]]) {
    for (const [index, path] of paths.entries()) {
      const ordinal = String(index + 1).padStart(3, '0');
      const expected = new RegExp(`^review/workbench-assets/prototype-${escapePattern(candidate.candidateId)}-${role}-${ordinal}\\.(?:svg|html|webp|png)$`);
      if (!expected.test(path)) {
        throw new DirectionProposalError('E_REFERENCE_PRIVATE_NAME', `${role} prototype basename must derive only from its candidate ID, role, and ordinal`);
      }
    }
  }
}

function assertIdDerivedEvidencePaths(segments, shots) {
  const segmentById = new Map();
  for (const segment of segments.segments) {
    segmentById.set(segment.segmentId, segment);
    const root = `analysis/evidence/${segment.mediaId}/${segment.segmentId}`;
    if (segment.reviewPath !== `${root}.webp`) {
      throw new DirectionProposalError('E_REFERENCE_PRIVATE_NAME', 'segment review basename must derive only from media and segment IDs');
    }
    for (const [index, frame] of segment.evidenceFrames.entries()) {
      const ordinal = String(index + 1).padStart(3, '0');
      if (frame.path !== `${root}/evidence-${segment.mediaId}-${segment.segmentId}-frame-${ordinal}.webp`) {
        throw new DirectionProposalError('E_REFERENCE_PRIVATE_NAME', 'evidence frame basename must derive only from media, segment, and frame IDs');
      }
    }
  }
  for (const shot of shots.shots) {
    const segment = segmentById.get(shot.segmentId);
    const allowed = new Set(segment?.evidenceFrames.map(({ path }) => path) ?? []);
    if (shot.mediaId !== segment?.mediaId || shot.evidenceFrames.some((path) => !allowed.has(path))) {
      throw new DirectionProposalError('E_REFERENCE_PRIVATE_NAME', 'shot evidence paths must resolve to ID-derived frames in its exact segment');
    }
  }
}

function candidateErrors(candidate) {
  const errors = [];
  for (const key of REQUIRED_CANDIDATE_KEYS) if (!Object.hasOwn(candidate ?? {}, key)) errors.push(`missing ${key}`);
  if (candidate?.wholeDirection !== true) errors.push('wholeDirection must be true');
  if (candidate?.prototypeKind !== 'code-rendered') errors.push('prototypeKind must be code-rendered');
  if (candidate?.assetPlan?.productionImageGenUsed !== false) errors.push('production Image Gen must be false');
  if (candidate?.designCandidate?.candidateId !== candidate?.candidateId || candidate?.lookCandidate?.candidateId !== candidate?.candidateId) {
    errors.push('candidate-owned design and Look IDs must match');
  }
  if (!Array.isArray(candidate?.representativeEvidenceIds) || candidate.representativeEvidenceIds.length === 0) errors.push('representative evidence required');
  if (!Array.isArray(candidate?.copy) || candidate.copy.length === 0) errors.push('copy required');
  if (!Number.isInteger(candidate?.viewport?.width) || !Number.isInteger(candidate?.viewport?.height) || candidate?.viewport?.aspectRatio !== '16:9') errors.push('valid 16:9 viewport required');
  if (!Number.isInteger(candidate?.informationDensityBudget?.maximumSimultaneousLayers)
    || !Number.isInteger(candidate?.informationDensityBudget?.maximumWordsPerFrame)) errors.push('information-density budget required');
  if (!Array.isArray(candidate?.layoutProofs) || candidate.layoutProofs.length === 0
    || !Array.isArray(candidate?.motionStoryboard) || candidate.motionStoryboard.length === 0) errors.push('layout and motion proofs required');
  if (!Array.isArray(candidate?.componentPlan?.components) || !Array.isArray(candidate?.componentPlan?.heroAssets)) errors.push('component and Hero plan required');
  return errors;
}

export function validateDirectionProposals(value) {
  const errors = [];
  if (!value || !['unavailable', 'proposed'].includes(value.status)) errors.push({ code: 'E_STATUS', message: 'status must be unavailable or proposed' });
  if (!Array.isArray(value?.candidates)) errors.push({ code: 'E_CANDIDATES', message: 'candidates must be an array' });
  if (value?.status === 'unavailable' && value.candidates?.length !== 0) errors.push({ code: 'E_CANDIDATE_CARDINALITY', message: 'unavailable has no candidates' });
  if (value?.status === 'proposed' && ![2, 3].includes(value.candidates?.length)) errors.push({ code: 'E_CANDIDATE_CARDINALITY', message: 'proposed requires two or three candidates' });
  const ids = new Set();
  for (const candidate of value?.candidates ?? []) {
    if (ids.has(candidate.candidateId)) errors.push({ code: 'E_CANDIDATE_DUPLICATE', message: 'candidate IDs must be unique' });
    ids.add(candidate.candidateId);
    for (const message of candidateErrors(candidate)) errors.push({ code: 'E_CANDIDATE_INCOMPLETE', message, candidateId: candidate?.candidateId });
    try {
      assertSafeCandidate(candidate);
      assertIdDerivedPrototypePaths(candidate);
    } catch (error) { errors.push({ code: error.code, message: error.message }); }
  }
  if (value?.status === 'proposed' && value.candidates.length > 1) {
    const sharedKeys = ['representativeEvidenceIds', 'copy', 'viewport', 'informationDensityBudget', 'musicPlan'];
    for (const key of sharedKeys) {
      if (value.candidates.slice(1).some((candidate) => !stableEqual(candidate[key], value.candidates[0][key]))) {
        errors.push({ code: 'E_CANDIDATE_PARITY', message: `all candidates must share ${key}` });
      }
    }
  }
  if (!DIGEST.test(value?.integrity?.digest ?? '') || verifyArtifactIntegrity(value).valid !== true) {
    errors.push({ code: 'E_INTEGRITY', message: 'proposal integrity digest is invalid' });
  }
  return { valid: errors.length === 0, errors };
}

async function readVerified(projectRoot, relativePath, schemaName) {
  const path = projectPath(projectRoot, relativePath);
  const value = JSON.parse(await readFile(path, 'utf8'));
  const schema = await loadSchema(schemaName);
  const result = validateDocument(schema, value);
  const integrity = verifyArtifactIntegrity(value);
  if (!result.valid || !integrity.valid) {
    throw new DirectionProposalError('E_SOURCE_CONTRACT', `${relativePath} is not an integrity-valid ${schemaName}`, { diagnostics: result.errors });
  }
  return value;
}

function assertCurrentLineage({ mediaIndex, probe, segments, shots, timeline, roughCut }) {
  const stale = probe.integrity.upstream.mediaIndex !== mediaIndex.integrity.digest
    || segments.integrity.upstream.probe !== probe.integrity.digest
    || shots.integrity.upstream.probe !== probe.integrity.digest
    || shots.integrity.upstream.segments !== segments.integrity.digest
    || timeline.sourceProbeDigest !== probe.integrity.digest
    || timeline.integrity.upstream.probe !== probe.integrity.digest
    || timeline.integrity.upstream.shots !== shots.integrity.digest
    || roughCut.integrity?.timelineDigest !== timeline.integrity.digest
    || roughCut.integrity?.probeDigest !== probe.integrity.digest;
  if (stale) throw new DirectionProposalError('E_SOURCE_STALE', 'direction proposals require exact current evidence and rough-cut lineage');
}

async function loadSources(projectRoot) {
  const [editBrief, mediaIndex, probe, segments, shots, timeline, dataOverlays, projectState] = await Promise.all([
    readVerified(projectRoot, 'EDIT_BRIEF.json', 'edit-brief'),
    readVerified(projectRoot, 'analysis/MEDIA_INDEX.json', 'media-index'),
    readVerified(projectRoot, 'analysis/PROBE.json', 'probe'),
    readVerified(projectRoot, 'analysis/SEGMENTS.json', 'segments'),
    readVerified(projectRoot, 'analysis/SHOTS.jsonl', 'shot'),
    readVerified(projectRoot, 'edit/TIMELINE.json', 'timeline'),
    readVerified(projectRoot, 'direction/DATA_OVERLAYS.json', 'data-overlays'),
    readVerified(projectRoot, 'PROJECT_STATE.json', 'project-state'),
  ]);
  if (!['ROUGH_CUT', 'DIRECTOR_REVIEW_READY'].includes(projectState.state)) {
    throw new DirectionProposalError('E_PROPOSAL_STATE', 'direction proposals require ROUGH_CUT or DIRECTOR_REVIEW_READY state');
  }
  if (shots.status !== 'available' || shots.shots.length === 0 || timeline.status !== 'available' || timeline.phase !== 'rough') {
    throw new DirectionProposalError('E_SOURCE_INCOMPLETE', 'Agent-validated shots and an available rough timeline are required');
  }
  assertIdDerivedEvidencePaths(segments, shots);
  const roughCut = JSON.parse(await readFile(projectPath(projectRoot, 'renders/rough-cut.json'), 'utf8'));
  if (roughCut.stateAuthority !== 'ROUGH_CUT' || roughCut.closedFileProbe?.valid !== true || roughCut.artifact !== 'renders/rough-cut.mp4'
    || await sha256File(projectPath(projectRoot, roughCut.artifact)) !== roughCut.outputDigest) {
    throw new DirectionProposalError('E_ROUGH_CUT_STALE', 'closed current rough-cut evidence is required');
  }
  assertCurrentLineage({ mediaIndex, probe, segments, shots, timeline, roughCut });
  return { editBrief, mediaIndex, probe, segments, shots, timeline, dataOverlays, projectState, roughCut };
}

async function validatePreviewArtifacts(projectRoot, candidate) {
  const expectedPaths = [...candidate.layoutProofs, ...candidate.motionStoryboard].sort();
  const actualPaths = Object.keys(candidate.previewArtifactDigests).sort();
  if (!stableEqual(expectedPaths, actualPaths)) {
    throw new DirectionProposalError('E_PREVIEW_DIGEST_SET', 'every layout and motion prototype requires exactly one digest');
  }
  for (const path of expectedPaths) {
    if (!path.startsWith('review/workbench-assets/')) throw new DirectionProposalError('E_REFERENCE_SCOPE', 'prototype paths must be project review derivatives');
    const actual = await sha256File(projectPath(projectRoot, path));
    if (actual !== candidate.previewArtifactDigests[path]) throw new DirectionProposalError('E_PREVIEW_STALE', `stale preview ${path}`);
  }
}

async function writeJsonAtomic(path, value, beforeRename) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = projectPath(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    if (beforeRename) await beforeRename(temporary, path);
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function compileDirectionProposals({ projectRoot, candidates, beforeRename } = {}) {
  if (!projectRoot || !Array.isArray(candidates)) throw new DirectionProposalError('E_OPTIONS', 'projectRoot and candidate drafts are required');
  const sources = await loadSources(projectRoot);
  const sorted = structuredClone(candidates).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  const evidenceIds = new Set(sources.segments.segments
    .flatMap((segment) => segment.evidenceFrames)
    .map((_, index) => `frame-${String(index + 1).padStart(3, '0')}`));
  for (const candidate of sorted) {
    assertSafeCandidate(candidate);
    assertIdDerivedPrototypePaths(candidate);
    if (candidate.designCandidate?.candidateId !== candidate.candidateId || candidate.lookCandidate?.candidateId !== candidate.candidateId) {
      throw new DirectionProposalError('E_CANDIDATE_MIXED', 'cross-candidate design or Look token mixing is forbidden');
    }
    if (candidate.assetPlan?.productionImageGenUsed !== false || candidate.prototypeKind !== 'code-rendered') {
      throw new DirectionProposalError('E_PRODUCTION_IMAGE_GEN', 'pre-lock proposals permit code-rendered prototypes only');
    }
    if (candidate.representativeEvidenceIds.some((id) => !evidenceIds.has(id))) {
      throw new DirectionProposalError('E_EVIDENCE_REFERENCE', 'representative frame IDs must resolve current review evidence');
    }
    await validatePreviewArtifacts(projectRoot, candidate);
  }
  const musicPlanDigest = computeArtifactDigest(sources.timeline.music);
  const evidenceDigest = computeArtifactDigest({
    mediaIndex: sources.mediaIndex.integrity.digest, probe: sources.probe.integrity.digest,
    segments: sources.segments.integrity.digest, shots: sources.shots.integrity.digest,
    dataOverlays: sources.dataOverlays.integrity.digest,
  });
  const assetPlanDigest = computeArtifactDigest(sorted.map(({ candidateId, visualWorldPlan, componentPlan, assetPlan }) => ({ candidateId, visualWorldPlan, componentPlan, assetPlan })));
  const artifact = {
    $schema: 'https://hyperframes.local/schemas/direction-proposals.schema.json', schemaVersion: '1.0.0', revision: 1,
    status: 'proposed', candidates: sorted,
    bindings: {
      editBriefDigest: sources.editBrief.integrity.digest,
      evidenceDigest,
      roughCutDigest: sources.roughCut.outputDigest,
      timelineDigest: sources.timeline.integrity.digest,
      musicPlanDigest,
      assetPlanDigest,
    },
    integrity: {
      digest: null,
      upstream: {
        editBrief: sources.editBrief.integrity.digest,
        mediaIndex: sources.mediaIndex.integrity.digest,
        probe: sources.probe.integrity.digest,
        segments: sources.segments.integrity.digest,
        shots: sources.shots.integrity.digest,
        timeline: sources.timeline.integrity.digest,
        roughCut: sources.roughCut.outputDigest,
        dataOverlays: sources.dataOverlays.integrity.digest,
        musicPlan: musicPlanDigest,
      },
    },
  };
  artifact.integrity.digest = computeArtifactDigest(artifact);
  const validation = validateDirectionProposals(artifact);
  if (!validation.valid) {
    const first = validation.errors[0];
    throw new DirectionProposalError(first.code === 'E_CANDIDATE_INCOMPLETE' ? 'E_CANDIDATE_INCOMPLETE' : first.code, first.message, { diagnostics: validation.errors });
  }
  const schemaValidation = validateDocument(await loadSchema('direction-proposals'), artifact);
  if (!schemaValidation.valid) throw new DirectionProposalError('E_PROPOSAL_SCHEMA', 'compiled proposal artifact violates its schema', { diagnostics: schemaValidation.errors });
  await writeJsonAtomic(projectPath(projectRoot, 'direction/DIRECTION_PROPOSALS.json'), artifact, beforeRename);
  return artifact;
}

export { loadSources as loadDirectionSources };
