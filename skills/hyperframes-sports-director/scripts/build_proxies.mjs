import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest, loadSchema, validateArtifact, validateDocument } from './lib/contracts.mjs';
import { runFfmpeg } from './lib/ffmpeg.mjs';
import { projectPath, readSourceRegistry, writeJsonAtomic } from './lib/media.mjs';

async function renderAtomically(project, input, portablePath, args) {
  const destination = projectPath(project, portablePath, input);
  await mkdir(dirname(destination), { recursive: true });
  const extension = extname(destination);
  const temporary = `${destination.slice(0, -extension.length)}.${process.pid}.tmp${extension}`;
  try {
    await runFfmpeg([...args, temporary]);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function proxyDefinition(media) {
  const timeMapping = [{
    proxyStartSeconds: 0,
    originalStartSeconds: 0,
    durationSeconds: media.durationSeconds,
    rate: '1/1',
  }];
  if (media.mediaType === 'video') {
    return {
      kind: 'video',
      path: `media/proxies/${media.mediaId}.mp4`,
      sourceDigest: media.sourceDigest,
      transform: {
        codec: 'h264', maximumWidth: 1280, maximumHeight: 720,
        watermark: 'ANALYSIS PROXY', preserveTimestamps: true, preserveAudio: true, autoOrient: true,
      },
      timeMapping,
    };
  }
  if (media.mediaType === 'image') {
    return {
      kind: 'image',
      path: `review/probe/${media.mediaId}.webp`,
      sourceDigest: media.sourceDigest,
      transform: {
        codec: 'webp', maximumWidth: 1280, maximumHeight: 720,
        watermark: null, preserveTimestamps: false, preserveAudio: false, autoOrient: true,
      },
      timeMapping,
    };
  }
  return {
    kind: 'audio',
    path: `media/proxies/${media.mediaId}.m4a`,
    sourceDigest: media.sourceDigest,
    transform: {
      codec: 'aac', maximumWidth: null, maximumHeight: null,
      watermark: null, preserveTimestamps: true, preserveAudio: true, autoOrient: false,
    },
    timeMapping,
  };
}

async function buildOne(project, input, sourcePath, media) {
  const proxy = proxyDefinition(media);
  if (media.mediaType === 'video') {
    await renderAtomically(project, input, proxy.path, [
      '-copyts', '-start_at_zero', '-i', sourcePath,
      '-map', '0:v:0', '-map', '0:a?', '-map_metadata', '0',
      '-vf', "scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,drawbox=x=18:y=h-62:w=265:h=44:color=black@0.72:t=fill,drawtext=text='ANALYSIS PROXY':x=30:y=h-50:fontsize=24:fontcolor=white",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    ]);
  } else if (media.mediaType === 'image') {
    await renderAtomically(project, input, proxy.path, [
      '-i', sourcePath, '-map_metadata', '0', '-frames:v', '1',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease',
      '-c:v', 'libwebp', '-quality', '78',
    ]);
  } else {
    await renderAtomically(project, input, proxy.path, [
      '-copyts', '-start_at_zero', '-i', sourcePath, '-map', '0:a:0', '-map_metadata', '0',
      '-vn', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
    ]);
  }
  return proxy;
}

export async function buildProxies(options) {
  const { project, input, registry } = await readSourceRegistry(options.project, options.input);
  const probePath = projectPath(project, 'analysis/PROBE.json', input);
  const probeValidation = await validateArtifact(probePath, 'probe');
  if (!probeValidation.valid) {
    const error = new Error('PROBE is missing or integrity-invalid');
    error.code = 'E_PROBE_INVALID';
    throw error;
  }
  const sources = new Map(registry.entries.map((entry) => [entry.mediaId, entry]));
  const document = structuredClone(probeValidation.value);
  for (const media of document.media) {
    const source = sources.get(media.mediaId);
    if (!source || source.sourceDigest !== media.sourceDigest) {
      const error = new Error(`probe source lineage is stale for ${media.mediaId}`);
      error.code = 'E_SOURCE_LINEAGE';
      throw error;
    }
    media.proxy = await buildOne(project, input, source.sourcePath, media);
  }
  document.revision += 1;
  document.integrity.digest = computeArtifactDigest(document);
  const validation = validateDocument(await loadSchema('probe'), document);
  if (!validation.valid) {
    const error = new Error(`proxy records failed PROBE validation: ${JSON.stringify(validation.errors)}`);
    error.code = 'E_PROXY_RECORD_INVALID';
    throw error;
  }
  await writeJsonAtomic(probePath, document);
  return { ok: true, built: document.media.length, artifact: 'analysis/PROBE.json' };
}

const DEFINITIONS = { project: { required: true }, input: { required: true } };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(await buildProxies(parseCliArguments(process.argv.slice(2), DEFINITIONS)))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
