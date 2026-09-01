import { createHash } from 'node:crypto';
import { basename, dirname, extname } from 'node:path';
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
      if (extname(path).toLowerCase() !== '.svg') {
        throw new DirectionProposalError('E_PROTOTYPE_ACTIVE_CONTENT', 'v1 direction prototypes must be inert local SVG');
      }
      const ordinal = String(index + 1).padStart(3, '0');
      const expected = new RegExp(`^review/workbench-assets/prototype-${escapePattern(candidate.candidateId)}-${role}-${ordinal}\\.svg$`);
      if (!expected.test(path)) {
        throw new DirectionProposalError('E_REFERENCE_PRIVATE_NAME', `${role} prototype basename must derive only from its candidate ID, role, and ordinal`);
      }
    }
  }
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SVG_GLOBAL_ATTRIBUTES = new Set([
  'id', 'transform', 'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'clip-path', 'mask', 'font-family', 'font-size', 'font-weight', 'letter-spacing',
  'text-anchor', 'dominant-baseline', 'vector-effect', 'shape-rendering', 'text-rendering',
]);
const SVG_ELEMENTS = new Map(Object.entries({
  svg: ['xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio'],
  g: [], defs: [], title: [], desc: [],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'], ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'], polyline: ['points'], polygon: ['points'],
  path: ['d', 'pathLength'], text: ['x', 'y', 'dx', 'dy'], tspan: ['x', 'y', 'dx', 'dy'],
  linearGradient: ['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'fr', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  stop: ['offset', 'stop-color', 'stop-opacity'],
  clipPath: ['clipPathUnits'], mask: ['x', 'y', 'width', 'height', 'maskUnits', 'maskContentUnits'],
}).map(([element, attributes]) => [element, new Set([...SVG_GLOBAL_ATTRIBUTES, ...attributes])]));
const SVG_TEXT_ELEMENTS = new Set(['text', 'tspan', 'title', 'desc']);
const SVG_LOCAL_REFERENCE_ATTRIBUTES = new Set(['fill', 'stroke', 'clip-path', 'mask']);
const SVG_SAFE_ATTRIBUTE_VALUE = /^[A-Za-z0-9#.,%+() _-]+$/;
const SVG_SAFE_ID = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const SVG_POSIX_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._~/-])\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*/;
const SVG_DRIVE_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9._~/\\-])[A-Za-z]:[\\/][^\s<>"']+/i;
const SVG_UNC_ABSOLUTE_PATH = /(?:^|[^\\])\\\\[A-Za-z0-9._$~-]+\\[^\s<>"']+/;
const SVG_KNOWN_PRIVATE_BASENAME = /\b[A-Z0-9][A-Z0-9._-]*\.(?:mov|mp4|m4v|mkv|avi|webm|jpg|jpeg|png|webp|heic|tif|tiff|wav|mp3|m4a|aac|flac|fit|gpx|tcx|kml)\b/i;
const SVG_UNLISTED_PRIVATE_BASENAME = /(?:^|[^A-Za-z0-9._-])(?=[A-Za-z0-9._-]*[-_])[A-Za-z0-9][A-Za-z0-9._-]*\.[A-Za-z][A-Za-z0-9-]*(?=$|[^A-Za-z0-9._-])/;
const SVG_CAMELCASE_PRIVATE_BASENAME = /(?:^|[^A-Za-z0-9._-])(?=[A-Za-z0-9_-]*[a-z0-9][A-Z])[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*\.[A-Za-z][A-Za-z0-9-]*(?=$|[^A-Za-z0-9._-])/;
const SVG_LABELED_PRIVATE_BASENAME = /\b(?:source|file(?:name)?|basename|asset|media)\s*[:=]\s*[A-Za-z0-9][A-Za-z0-9._-]*(?:\.[A-Za-z][A-Za-z0-9-]*)?\b/i;

function activePrototype(message) {
  return new DirectionProposalError('E_PROTOTYPE_ACTIVE_CONTENT', message);
}

function containsRawGpsPair(value) {
  const pairs = value.matchAll(/(?:^|[^0-9.+-])([+-]?\d{1,2}\.\d{3,})\s*,\s*([+-]?\d{1,3}\.\d{3,})(?=$|[^0-9.])/g);
  for (const match of pairs) {
    if (Math.abs(Number(match[1])) <= 90 && Math.abs(Number(match[2])) <= 180) return true;
  }
  return false;
}

function assertSvgPrivacy(value, kind) {
  const at = `prototype SVG ${kind}`;
  if (SVG_POSIX_ABSOLUTE_PATH.test(value) || SVG_DRIVE_ABSOLUTE_PATH.test(value) || SVG_UNC_ABSOLUTE_PATH.test(value)) {
    throw new DirectionProposalError('E_REFERENCE_ABSOLUTE', `${at} contains an absolute path`);
  }
  if (/\braw\s*gps\b|\b(?:lat(?:itude)?|lon(?:gitude)?)\s*[:=]?\s*[+-]?\d{1,3}\.\d{2,}\b/i.test(value) || containsRawGpsPair(value)) {
    throw new DirectionProposalError('E_RAW_GPS', `${at} contains raw GPS`);
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.[a-z0-9.-]+/i.test(value)) {
    throw new DirectionProposalError('E_REFERENCE_REMOTE', `${at} contains a URL`);
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)
    || SVG_KNOWN_PRIVATE_BASENAME.test(value)
    || SVG_UNLISTED_PRIVATE_BASENAME.test(value)
    || SVG_CAMELCASE_PRIVATE_BASENAME.test(value)
    || SVG_LABELED_PRIVATE_BASENAME.test(value)) {
    throw new DirectionProposalError('E_REFERENCE_PRIVATE_NAME', `${at} contains a private filename or email`);
  }
}

function readSvgTag(text, start) {
  let quote = null;
  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '<') {
      throw activePrototype('prototype SVG contains malformed XML');
    } else if (character === '>') {
      return { source: text.slice(start + 1, index), end: index + 1 };
    }
  }
  throw activePrototype('prototype SVG contains an unterminated tag');
}

function parseSvgAttributes(source, element) {
  const allowed = SVG_ELEMENTS.get(element);
  const attributes = new Map();
  let cursor = 0;
  while (cursor < source.length) {
    const whitespace = source.slice(cursor).match(/^\s+/);
    if (!whitespace) throw activePrototype('prototype SVG attributes must be whitespace-separated');
    cursor += whitespace[0].length;
    if (cursor === source.length) break;
    const nameMatch = source.slice(cursor).match(/^[A-Za-z][A-Za-z0-9-]*/);
    if (!nameMatch) throw activePrototype('prototype SVG contains a namespaced or malformed attribute');
    const name = nameMatch[0];
    cursor += name.length;
    const beforeEquals = source.slice(cursor).match(/^\s*/)[0];
    cursor += beforeEquals.length;
    if (source[cursor] !== '=') throw activePrototype('prototype SVG attributes require quoted values');
    cursor += 1;
    const afterEquals = source.slice(cursor).match(/^\s*/)[0];
    cursor += afterEquals.length;
    const quote = source[cursor];
    if (quote !== '"' && quote !== "'") throw activePrototype('prototype SVG attributes require quoted values');
    const end = source.indexOf(quote, cursor + 1);
    if (end === -1) throw activePrototype('prototype SVG contains an unterminated attribute');
    const value = source.slice(cursor + 1, end);
    cursor = end + 1;
    if (!allowed.has(name) || /^on/i.test(name) || attributes.has(name)) {
      throw activePrototype('prototype SVG contains an unknown, active, or duplicate attribute');
    }
    if (name === 'xmlns') {
      if (element !== 'svg' || value !== SVG_NAMESPACE) throw activePrototype('prototype SVG namespace is invalid');
    } else {
      assertSvgPrivacy(value, 'attribute');
      if (name === 'id') {
        if (!SVG_SAFE_ID.test(value)) throw activePrototype('prototype SVG ID is invalid');
      } else {
        const localReference = SVG_LOCAL_REFERENCE_ATTRIBUTES.has(name) && /^url\(#[A-Za-z_][A-Za-z0-9_.-]*\)$/.test(value);
        if (!localReference && (!SVG_SAFE_ATTRIBUTE_VALUE.test(value) || /(?:url|data|javascript|@import|font-face)/i.test(value))) {
          throw activePrototype('prototype SVG attribute value is outside the inert subset');
        }
      }
    }
    attributes.set(name, value);
  }
  return attributes;
}

function assertInertSvg(bytes) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw activePrototype('prototype SVG must be valid UTF-8');
  }
  if (!text || /&|<\!|<\?|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
    throw activePrototype('prototype SVG contains declarations, entities, escapes, or invalid characters');
  }

  const stack = [];
  let rootSeen = false;
  let rootClosed = false;
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '<') {
      const next = text.indexOf('<', cursor);
      const end = next === -1 ? text.length : next;
      const content = text.slice(cursor, end);
      if (content.trim() && (!stack.length || !SVG_TEXT_ELEMENTS.has(stack.at(-1)))) {
        throw activePrototype('prototype SVG text is outside an allowed text element');
      }
      if (content.trim()) assertSvgPrivacy(content, 'text');
      cursor = end;
      continue;
    }

    const tag = readSvgTag(text, cursor);
    cursor = tag.end;
    if (tag.source.startsWith('/')) {
      const match = tag.source.match(/^\/([A-Za-z][A-Za-z0-9]*)\s*$/);
      if (!match || stack.at(-1) !== match[1]) throw activePrototype('prototype SVG tags are malformed or unbalanced');
      stack.pop();
      if (!stack.length) rootClosed = true;
      continue;
    }

    const selfClosing = /\/\s*$/.test(tag.source);
    const source = selfClosing ? tag.source.replace(/\/\s*$/, '') : tag.source;
    const match = source.match(/^([A-Za-z][A-Za-z0-9]*)([\s\S]*)$/);
    const element = match?.[1];
    if (!element || !SVG_ELEMENTS.has(element) || rootClosed) {
      throw activePrototype('prototype SVG contains an unknown, namespaced, or extra element');
    }
    if (!rootSeen) {
      if (element !== 'svg' || stack.length) throw activePrototype('prototype SVG requires one SVG root');
      rootSeen = true;
    } else if (!stack.length) {
      throw activePrototype('prototype SVG contains more than one root');
    }
    const attributes = parseSvgAttributes(match[2], element);
    if (element === 'svg' && (!attributes.has('xmlns') || stack.length)) {
      throw activePrototype('prototype SVG root requires the exact SVG namespace');
    }
    if (!selfClosing) stack.push(element);
    else if (element === 'svg') rootClosed = true;
  }
  if (!rootSeen || !rootClosed || stack.length) throw activePrototype('prototype SVG document is incomplete');
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
  const reviewSourceStates = ['ROUGH_CUT', 'DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION', 'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED'];
  if (!reviewSourceStates.includes(projectState.state)) {
    throw new DirectionProposalError('E_PROPOSAL_STATE', 'direction proposal evidence is unavailable in the current state');
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
    const bytes = await readFile(projectPath(projectRoot, path));
    assertInertSvg(bytes);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== candidate.previewArtifactDigests[path]) throw new DirectionProposalError('E_PREVIEW_STALE', `stale preview ${path}`);
  }
}

export async function validateProposalPreviewArtifacts(projectRoot, proposals) {
  for (const candidate of proposals.candidates ?? []) await validatePreviewArtifacts(projectRoot, candidate);
  return true;
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
