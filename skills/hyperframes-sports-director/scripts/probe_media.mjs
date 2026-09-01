import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest, validateArtifact, validateDocument, loadSchema } from './lib/contracts.mjs';
import { assertImageDecodes, ffprobeJson } from './lib/ffmpeg.mjs';
import { projectPath, readSourceRegistry, writeJsonAtomic } from './lib/media.mjs';

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

export function normalizeRational(value) {
  const match = /^(-?[0-9]+)\/(-?[0-9]+)$/.exec(String(value ?? ''));
  if (!match) return null;
  let numerator = Number(match[1]);
  let denominator = Number(match[2]);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || numerator <= 0 || denominator <= 0) return null;
  const divisor = gcd(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;
  return `${numerator}/${denominator}`;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function captureTimestamp(sourcePath, raw) {
  const filenameTimestamp = /(20[0-9]{6}T[0-9]{6}Z)/.exec(basename(sourcePath))?.[1];
  const compact = filenameTimestamp && `${filenameTimestamp.slice(0, 4)}-${filenameTimestamp.slice(4, 6)}-${filenameTimestamp.slice(6, 11)}:${filenameTimestamp.slice(11, 13)}:${filenameTimestamp.slice(13, 15)}Z`;
  const candidates = [raw.format?.tags?.creation_time, ...raw.streams.map((stream) => stream.tags?.creation_time), compact];
  for (const value of candidates) {
    if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  }
  return null;
}

function rotationDegrees(stream) {
  const raw = stream.side_data_list?.find((entry) => Number.isFinite(Number(entry.rotation)))?.rotation ?? stream.tags?.rotate;
  if (!Number.isFinite(Number(raw))) return 0;
  return ((Number(raw) % 360) + 360) % 360;
}

function normalizeStream(stream, index) {
  const type = ['video', 'audio', 'subtitle', 'data'].includes(stream.codec_type) ? stream.codec_type : 'data';
  const normalized = {
    streamId: `${type === 'video' ? 'v' : type === 'audio' ? 'a' : type === 'subtitle' ? 's' : 'd'}:${index}`,
    type,
    codec: stream.codec_name || stream.codec_long_name || 'unknown',
    timeBase: normalizeRational(stream.time_base) ?? '1/1',
  };
  if (type === 'video') {
    const frameRate = normalizeRational(stream.avg_frame_rate) ?? normalizeRational(stream.r_frame_rate);
    if (frameRate) normalized.frameRate = frameRate;
    Object.assign(normalized, {
      width: Number(stream.width),
      height: Number(stream.height),
      rotationDegrees: rotationDegrees(stream),
      pixelFormat: stream.pix_fmt ?? null,
      colorSpace: stream.color_space ?? null,
      colorPrimaries: stream.color_primaries ?? null,
      colorTransfer: stream.color_transfer ?? null,
      colorRange: stream.color_range ?? null,
      sampleAspectRatio: normalizeRational(stream.sample_aspect_ratio) ?? null,
    });
  } else if (type === 'audio') {
    Object.assign(normalized, {
      channels: Number(stream.channels),
      sampleRate: Number(stream.sample_rate),
      channelLayout: stream.channel_layout || `${stream.channels} channels`,
    });
  }
  return normalized;
}

function reviewPath(mediaId, mediaType) {
  if (mediaType === 'video') return `review/probe/${mediaId}.mp4`;
  if (mediaType === 'image') return `review/probe/${mediaId}.webp`;
  return `review/probe/${mediaId}.m4a`;
}

export async function probeMedia(options) {
  const { project, registry } = await readSourceRegistry(options.project, options.input);
  const indexPath = projectPath(project, 'analysis/MEDIA_INDEX.json');
  const indexValidation = await validateArtifact(indexPath, 'media-index');
  if (!indexValidation.valid) {
    const error = new Error('MEDIA_INDEX is missing or integrity-invalid');
    error.code = 'E_MEDIA_INDEX_INVALID';
    throw error;
  }
  const mediaById = new Map(indexValidation.value.entries.map((entry) => [entry.mediaId, entry]));
  const registryIds = new Set(registry.entries.map(({ mediaId }) => mediaId));
  const exactLineage = registry.entries.length === indexValidation.value.entries.length
    && registryIds.size === registry.entries.length
    && registry.entries.every(({ mediaId, sourceDigest }) => mediaById.get(mediaId)?.sourceDigest === sourceDigest);
  if (!exactLineage) {
    const error = new Error('MEDIA_INDEX and the local source registry must contain the exact same media ID and digest set');
    error.code = 'E_SOURCE_LINEAGE';
    throw error;
  }
  const probeable = registry.entries.filter(({ mediaId, sourceDigest }) => {
    const indexed = mediaById.get(mediaId);
    return indexed && indexed.sourceDigest === sourceDigest && ['video', 'image', 'audio'].includes(indexed.mediaType);
  });
  const normalized = [];
  for (const source of probeable) {
    const indexed = mediaById.get(source.mediaId);
    const raw = await ffprobeJson(source.sourcePath);
    if (indexed.mediaType === 'image') await assertImageDecodes(source.sourcePath);
    await writeJsonAtomic(projectPath(project, `cache/probe/raw/${source.mediaId}.ffprobe.json`), raw);
    const streams = raw.streams.map(normalizeStream);
    normalized.push({
      mediaId: source.mediaId,
      mediaType: indexed.mediaType,
      reviewPath: reviewPath(source.mediaId, indexed.mediaType),
      sourceDigest: source.sourceDigest,
      byteSize: indexed.byteSize,
      durationSeconds: indexed.mediaType === 'image' ? null : finiteNumber(raw.format?.duration),
      streams,
      captureTimestamp: captureTimestamp(source.sourcePath, raw),
      proxy: null,
    });
  }
  normalized.sort((left, right) => left.mediaId.localeCompare(right.mediaId));
  let priorRevision = 0;
  try { priorRevision = JSON.parse(await readFile(projectPath(project, 'analysis/PROBE.json'), 'utf8')).revision ?? 0; } catch {}
  const document = {
    $schema: 'https://hyperframes.local/schemas/probe.schema.json',
    schemaVersion: '1.0.0',
    revision: priorRevision + 1,
    media: normalized,
    integrity: { digest: null, upstream: { mediaIndex: indexValidation.value.integrity.digest } },
  };
  document.integrity.digest = computeArtifactDigest(document);
  const validation = validateDocument(await loadSchema('probe'), document);
  if (!validation.valid) {
    const error = new Error(`PROBE validation failed: ${JSON.stringify(validation.errors)}`);
    error.code = 'E_PROBE_INVALID';
    throw error;
  }
  await writeJsonAtomic(projectPath(project, 'analysis/PROBE.json'), document);
  return { ok: true, probed: normalized.length, artifact: 'analysis/PROBE.json' };
}

const DEFINITIONS = { project: { required: true }, input: { required: true } };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await probeMedia(parseCliArguments(process.argv.slice(2), DEFINITIONS)))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
