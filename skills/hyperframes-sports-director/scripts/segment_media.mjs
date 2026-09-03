#!/usr/bin/env node
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest, loadSchema, validateArtifact, validateDocument } from './lib/contracts.mjs';
import { runCommand, runFfmpeg } from './lib/ffmpeg.mjs';
import { projectPath, readSourceRegistry, writeJsonAtomic } from './lib/media.mjs';

const MIN_SEGMENT_SECONDS = 0.5;
const SCENE_THRESHOLD = 0.12;
const MAX_EVIDENCE_FRAMES = 4;

function bounded(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function stableSeconds(value) {
  return Number(value.toFixed(3));
}

function segmentId(mediaId, ordinal) {
  return `segment-${mediaId.slice('media-'.length)}-${String(ordinal).padStart(3, '0')}`;
}

function timeSamples(start, end) {
  const duration = end - start;
  const count = Math.max(1, Math.min(MAX_EVIDENCE_FRAMES, Math.ceil(duration / 1.5)));
  return Array.from({ length: count }, (_, index) => stableSeconds(start + (duration * (index + 0.5) / count)));
}

async function signalMetadata(path, filter) {
  const { stderr } = await runCommand('ffmpeg', [
    '-hide_banner', '-nostdin', '-i', path, '-vf', filter, '-an', '-f', 'null', '-',
  ]);
  return stderr;
}

async function sceneBoundaries(path, duration) {
  let output = '';
  try {
    output = await signalMetadata(path, `select='gt(scene,${SCENE_THRESHOLD})',metadata=print`);
  } catch {
    // Evidence extraction still proceeds for a decodable file when scene metadata is unavailable.
  }
  const candidates = [];
  const matcher = /pts_time:([0-9.]+)[\s\S]{0,180}?lavfi\.scene_score=([0-9.]+)/g;
  for (const match of output.matchAll(matcher)) candidates.push({ at: Number(match[1]), score: bounded(Number(match[2])) });
  const boundaries = [{ at: 0, score: 0 }];
  for (const candidate of candidates.sort((left, right) => left.at - right.at)) {
    if (candidate.at - boundaries.at(-1).at >= MIN_SEGMENT_SECONDS && duration - candidate.at >= MIN_SEGMENT_SECONDS) {
      boundaries.push({ at: stableSeconds(candidate.at), score: candidate.score });
    }
  }
  boundaries.push({ at: stableSeconds(duration), score: 0 });
  return boundaries;
}

async function motionScore(path) {
  let output = '';
  try {
    output = await signalMetadata(path, 'fps=2,signalstats,metadata=print');
  } catch {
    return 0;
  }
  const values = [...output.matchAll(/lavfi\.signalstats\.YDIF=([0-9.]+)/g)].map((match) => Number(match[1])).filter(Number.isFinite);
  return values.length === 0 ? 0 : stableSeconds(bounded(values.reduce((sum, value) => sum + value, 0) / values.length / 255));
}

async function renderWebp(project, input, portablePath, sourcePath, sourceSeconds) {
  const destination = projectPath(project, portablePath, input);
  await mkdir(dirname(destination), { recursive: true });
  const extension = extname(destination);
  const temporary = `${destination.slice(0, -extension.length)}.${process.pid}.tmp${extension}`;
  try {
    const seek = sourceSeconds === null ? [] : ['-ss', String(sourceSeconds)];
    await runFfmpeg([...seek, '-i', sourcePath, '-frames:v', '1', '-vf', 'scale=640:360:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=640:360:(ow-iw)/2:(oh-ih)/2:black', '-c:v', 'libwebp', '-quality', '80', temporary]);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function nextRevision(path) {
  try {
    const prior = JSON.parse(await (await import('node:fs/promises')).readFile(path, 'utf8'));
    return Number.isInteger(prior.revision) ? prior.revision + 1 : 1;
  } catch { return 1; }
}

export async function segmentMedia(options) {
  const { project, input } = await readSourceRegistry(options.project, options.input);
  const probePath = projectPath(project, 'analysis/PROBE.json', input);
  const probeValidation = await validateArtifact(probePath, 'probe');
  if (!probeValidation.valid) {
    const error = new Error('PROBE is missing or integrity-invalid'); error.code = 'E_PROBE_INVALID'; throw error;
  }
  const probe = probeValidation.value;
  const artifactPath = projectPath(project, 'analysis/SEGMENTS.json', input);
  const segments = [];
  for (const media of probe.media.filter(({ mediaType, proxy }) => (mediaType === 'video' || mediaType === 'image') && proxy)) {
    const sourcePath = projectPath(project, media.proxy.path, input);
    const duration = media.mediaType === 'image' ? 1 : media.durationSeconds;
    if (!Number.isFinite(duration) || duration <= 0) continue;
    const boundaries = media.mediaType === 'video' ? await sceneBoundaries(sourcePath, duration) : [{ at: 0, score: 0 }, { at: 1, score: 0 }];
    const mechanicalMotion = media.mediaType === 'video' ? await motionScore(sourcePath) : 0;
    const audioPresent = media.streams.some(({ type }) => type === 'audio');
    for (let ordinal = 0; ordinal < boundaries.length - 1; ordinal += 1) {
      const start = boundaries[ordinal].at;
      const end = boundaries[ordinal + 1].at;
      if (end <= start) continue;
      const id = segmentId(media.mediaId, ordinal + 1);
      const reviewPath = `analysis/evidence/${media.mediaId}/${id}.webp`;
      const samples = timeSamples(start, end);
      const evidenceFrames = samples.map((sourceTimeSeconds, index) => ({
        path: `analysis/evidence/${media.mediaId}/${id}/evidence-${media.mediaId}-${id}-frame-${String(index + 1).padStart(3, '0')}.webp`, sourceTimeSeconds,
      }));
      await renderWebp(project, input, reviewPath, sourcePath, media.mediaType === 'image' ? null : samples[Math.floor(samples.length / 2)]);
      for (const frame of evidenceFrames) await renderWebp(project, input, frame.path, sourcePath, media.mediaType === 'image' ? null : frame.sourceTimeSeconds);
      segments.push({
        segmentId: id, mediaId: media.mediaId, mediaType: media.mediaType, sourceDigest: media.sourceDigest,
        probeDigest: probe.integrity.digest, sourceInSeconds: start, sourceOutSeconds: end, sourceDurationSeconds: duration,
        sceneScore: boundaries[ordinal + 1].score, motionScore: mechanicalMotion, audioPresent, reviewPath, evidenceFrames,
      });
    }
  }
  const document = {
    $schema: 'https://hyperframes.local/schemas/segments.schema.json', schemaVersion: '1.0.0', revision: await nextRevision(artifactPath),
    sourceMediaIds: [...new Set(segments.map(({ mediaId }) => mediaId))], segments,
    integrity: { digest: null, upstream: { probe: probe.integrity.digest } },
  };
  document.integrity.digest = computeArtifactDigest(document);
  const validation = validateDocument(await loadSchema('segments'), document);
  if (!validation.valid) { const error = new Error(`SEGMENTS validation failed: ${JSON.stringify(validation.errors)}`); error.code = 'E_SEGMENTS_INVALID'; throw error; }
  await writeJsonAtomic(artifactPath, document);
  return { ok: true, segmented: segments.length, artifact: 'analysis/SEGMENTS.json' };
}

const DEFINITIONS = { project: { required: true }, input: { required: true } };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await segmentMedia(parseCliArguments(process.argv.slice(2), DEFINITIONS)))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify(errorResult(error))}\n`); process.exitCode = error.code === 'E_USAGE' ? 2 : 1; }
}
