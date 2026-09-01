import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { loadSchema, validateArtifact, validateDocument, verifyArtifactIntegrity } from './lib/contracts.mjs';
import { projectPath } from './lib/media.mjs';

function shotFilePath(project, requested) {
  const candidate = requested ?? 'analysis/SHOTS.jsonl';
  const portable = isAbsolute(candidate) ? relative(project, resolve(candidate)) : candidate;
  return projectPath(project, portable);
}

function parseOneEnvelope(text) {
  const match = /^([^\r\n]+)\r?\n?$/.exec(text);
  if (!match) {
    const error = new Error('SHOTS.jsonl must contain exactly one canonical JSON envelope line'); error.code = 'E_SHOTS_ENVELOPE'; throw error;
  }
  try { return JSON.parse(match[1]); }
  catch { const error = new Error('SHOTS.jsonl line is not JSON'); error.code = 'E_SHOTS_JSON'; throw error; }
}

function invalid(code, message, details = {}) {
  const error = new Error(message); error.code = code; Object.assign(error, details); return error;
}

export async function validateShots({ project: projectRoot, shots: requestedShots }) {
  const project = resolve(projectRoot);
  const shotsPath = shotFilePath(project, requestedShots);
  const probeValidation = await validateArtifact(projectPath(project, 'analysis/PROBE.json'), 'probe');
  const segmentsValidation = await validateArtifact(projectPath(project, 'analysis/SEGMENTS.json'), 'segments');
  if (!probeValidation.valid) throw invalid('E_PROBE_INVALID', 'PROBE is missing or integrity-invalid');
  if (!segmentsValidation.valid) throw invalid('E_SEGMENTS_INVALID', 'SEGMENTS is missing or integrity-invalid');
  const value = parseOneEnvelope(await readFile(shotsPath, 'utf8'));
  const schema = await loadSchema('shot');
  const validation = validateDocument(schema, value);
  if (!validation.valid) return { valid: false, errors: validation.errors };
  const integrity = verifyArtifactIntegrity(value);
  if (!integrity.valid) return { valid: false, errors: [{ code: integrity.code, path: '/integrity/digest', message: 'SHOTS digest does not match canonical content', schema: 'shot' }] };
  const probe = probeValidation.value;
  const segments = segmentsValidation.value;
  const errors = [];
  const media = new Map(probe.media.map((entry) => [entry.mediaId, entry]));
  const segmentById = new Map(segments.segments.map((entry) => [entry.segmentId, entry]));
  if (value.integrity.upstream.probe !== probe.integrity.digest) errors.push({ code: 'E_PROBE_DIGEST_STALE', path: '/integrity/upstream/probe', message: 'SHOTS must bind the current PROBE digest', schema: 'shot' });
  if (value.integrity.upstream.segments !== segments.integrity.digest) errors.push({ code: 'E_SEGMENTS_DIGEST_STALE', path: '/integrity/upstream/segments', message: 'SHOTS must bind the current SEGMENTS digest', schema: 'shot' });
  for (let index = 0; index < value.shots.length; index += 1) {
    const shot = value.shots[index];
    const prefix = `/shots/${index}`;
    const source = media.get(shot.mediaId);
    const segment = segmentById.get(shot.segmentId);
    if (!source || !segment || segment.mediaId !== shot.mediaId) {
      errors.push({ code: 'E_SHOT_SEGMENT_REFERENCE', path: `${prefix}/segmentId`, message: 'shot segmentId must resolve to the same current mediaId', schema: 'shot' });
      continue;
    }
    const probedDuration = source.mediaType === 'image' ? 1 : source.durationSeconds;
    if (segment.mediaType !== source.mediaType || !Number.isFinite(probedDuration)
      || segment.sourceDurationSeconds !== probedDuration || segment.sourceInSeconds < 0
      || segment.sourceOutSeconds > probedDuration || segment.probeDigest !== probe.integrity.digest) {
      errors.push({ code: 'E_SEGMENT_PROBE_BOUNDS', path: `${prefix}/segmentId`, message: 'referenced segment must match current PROBE media type, digest, duration, and bounds', schema: 'shot' });
    }
    if (shot.sourceDigest !== source.sourceDigest || shot.sourceDigest !== segment.sourceDigest) errors.push({ code: 'E_SHOT_SOURCE_DIGEST', path: `${prefix}/sourceDigest`, message: 'shot sourceDigest must match PROBE and SEGMENTS', schema: 'shot' });
    if (shot.sourceDurationSeconds !== segment.sourceDurationSeconds || shot.sourceInSeconds < segment.sourceInSeconds || shot.sourceOutSeconds > segment.sourceOutSeconds) errors.push({ code: 'E_SHOT_SEGMENT_BOUNDS', path: prefix, message: 'shot interval must remain within its segment and use its exact source duration', schema: 'shot' });
    const allowedEvidence = new Set(segment.evidenceFrames.map(({ path }) => path));
    for (const frame of shot.evidenceFrames) {
      if (!allowedEvidence.has(frame)) errors.push({ code: 'E_SHOT_EVIDENCE_REFERENCE', path: `${prefix}/evidenceFrames`, message: 'shot evidence must be extracted by its referenced segment', schema: 'shot' });
    }
  }
  return { valid: errors.length === 0, errors, value, segments, artifact: 'analysis/SHOTS.jsonl' };
}

const DEFINITIONS = { project: { required: true }, shots: { required: false } };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await validateShots(parseCliArguments(process.argv.slice(2), DEFINITIONS));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.valid) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ valid: false, errors: [{ code: error.code ?? 'E_INTERNAL', path: '/', message: error.message, schema: 'shot' }] })}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
