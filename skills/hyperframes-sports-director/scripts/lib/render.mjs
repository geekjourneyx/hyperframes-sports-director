import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { basename } from 'node:path';

import { computeArtifactDigest } from './contracts.mjs';
import { ffprobeJson } from './ffmpeg.mjs';
import { assertFinalSource, projectPath, sha256File, writeJsonAtomic } from './media.mjs';
import { normalizePlaybackRateCurve } from './timeline.mjs';

const DIGEST = /^[0-9a-f]{64}$/;
const RASTERS = new Set(['1920x1080', '3840x2160']);
const VIDEO_CODEC = { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1' };
const AUDIO_CODEC = { aac: 'aac', pcm_s24le: 'pcm_s24le', opus: 'libopus' };

function fail(code, message, details = {}) {
  const cause = new Error(message);
  cause.code = code;
  Object.assign(cause, details);
  throw cause;
}

const seconds = (value) => Number(value).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
const stableHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function atempo(rate) {
  const chain = [];
  let remaining = rate;
  while (remaining > 2) { chain.push('atempo=2'); remaining /= 2; }
  while (remaining < 0.5) { chain.push('atempo=0.5'); remaining /= 0.5; }
  chain.push(`atempo=${seconds(remaining)}`);
  return chain;
}

function rationalFps(editBrief, probe, items) {
  if (editBrief.delivery.frameRate?.mode === 'fixed') {
    const value = editBrief.delivery.frameRate.fps;
    if (!(value > 0)) fail('E_FINAL_FPS', 'fixed delivery frame rate must be positive');
    return Number.isInteger(value) ? `${value}/1` : `${Math.round(value * 1000)}/1000`;
  }
  const byId = new Map(probe.media.map((entry) => [entry.mediaId, entry]));
  for (const item of items) {
    const value = byId.get(item.sourceMediaId)?.streams?.find(({ type }) => type === 'video')?.frameRate;
    if (/^[1-9]\d*\/[1-9]\d*$/.test(value ?? '')) return value;
  }
  return '24/1';
}

function assertAuthority(input) {
  const { projectState, timeline, probe, designSystem, lookProfile, assetManifest, motionMap, sceneSchema } = input;
  if (projectState?.state !== 'MOTION_COMPOSITION') fail('E_FINAL_PRE_LOCK', 'final rendering starts only from accepted MOTION_COMPOSITION');
  if ((projectState.transitions ?? []).filter(({ to }) => to === 'DIRECTOR_LOCK').length !== 1
    || designSystem?.status !== 'frozen' || lookProfile?.status !== 'frozen'
    || assetManifest?.status !== 'frozen' || motionMap?.status !== 'frozen' || sceneSchema?.status !== 'frozen') {
    fail('E_FINAL_PRE_LOCK', 'one committed frozen direction is required');
  }
  const current = timeline?.phase === 'final' && timeline?.status === 'frozen'
    && timeline.sourceProbeDigest === probe?.integrity?.digest
    && timeline.assetManifestDigest === assetManifest?.integrity?.digest
    && timeline.motionMapDigest === motionMap?.integrity?.digest
    && timeline.designRevision === designSystem?.designRevision
    && timeline.lookRevision === lookProfile?.lookRevision
    && timeline.assetRevision === assetManifest?.assetRevision
    && timeline.motionRevision === motionMap?.motionRevision;
  if (!current) fail('E_FINAL_AUTHORITY_STALE', 'final timeline or frozen render authority is stale');
  if (!Array.isArray(timeline.items) || timeline.items.length === 0) fail('E_FINAL_TIMELINE_EMPTY', 'final timeline requires items');
}

function semanticChapters(sceneSchema, timeline) {
  const scenes = (sceneSchema?.scenes ?? []).map((scene) => ({
    sceneId: scene.sceneId,
    title: scene.title ?? scene.sceneId,
    start: scene.interval?.entry?.[0],
    end: scene.interval?.exit?.[1],
    scene,
  })).filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .sort((left, right) => left.start - right.start || left.sceneId.localeCompare(right.sceneId));
  if (scenes.length > 0) return scenes;
  return timeline.items.map((item) => ({
    sceneId: `chapter-${item.itemId}`, title: item.reasons?.[0] ?? item.itemId,
    start: item.destinationInSeconds, end: item.destinationOutSeconds, scene: null,
  }));
}

function chapterItems(chapter, timeline) {
  return timeline.items.filter((item) => item.destinationInSeconds < chapter.end && item.destinationOutSeconds > chapter.start)
    .map((item) => ({ ...item,
      chapterDestinationIn: Math.max(item.destinationInSeconds, chapter.start) - chapter.start,
      chapterDestinationOut: Math.min(item.destinationOutSeconds, chapter.end) - chapter.start,
    }));
}

function sourceTransform(media, raster, fps) {
  const stream = media.streams?.find(({ type }) => type === 'video') ?? {};
  return {
    source: { width: stream.width ?? null, height: stream.height ?? null },
    delivery: { width: raster.width, height: raster.height },
    filters: [`scale=${raster.width}:${raster.height}:force_original_aspect_ratio=decrease`, `pad=${raster.width}:${raster.height}:(ow-iw)/2:(oh-ih)/2:color=black`, 'setsar=1', `fps=${fps}`],
  };
}

async function resolveSources({ project, sourceRegistry, timeline, probe }) {
  const registry = new Map((sourceRegistry?.entries ?? []).map((entry) => [entry.mediaId, entry]));
  const media = new Map((probe?.media ?? []).map((entry) => [entry.mediaId, entry]));
  const resolved = new Map();
  for (const item of timeline.items) {
    if (item.sourceReference?.kind !== 'original') {
      fail(item.sourceReference?.kind === 'proxy' ? 'E_PROXY_FINAL_SOURCE' : 'E_ANALYSIS_DERIVATIVE_FINAL_SOURCE', 'final items must declare original source references');
    }
    if (/(?:^|\/)(?:media\/proxies|analysis\/|review\/)/.test(item.sourceReference.path ?? '')) {
      fail(item.sourceReference.path?.includes('proxies') ? 'E_PROXY_FINAL_SOURCE' : 'E_ANALYSIS_DERIVATIVE_FINAL_SOURCE', 'analysis derivatives cannot enter final rendering');
    }
    const entry = registry.get(item.sourceMediaId);
    const probeEntry = media.get(item.sourceMediaId);
    if (!entry || !probeEntry || entry.sourceDigest !== item.sourceReference.digest || probeEntry.sourceDigest !== entry.sourceDigest || !DIGEST.test(entry.sourceDigest ?? '')) {
      fail('E_ORIGINAL_AUTHORITY', 'source ID and hash must resolve through current original registry and probe');
    }
    assertFinalSource(entry.sourcePath, project);
    let currentDigest;
    try { currentDigest = await sha256File(entry.sourcePath); } catch { fail('E_ORIGINAL_MISSING', `original source is unavailable for ${item.sourceMediaId}`); }
    if (currentDigest !== entry.sourceDigest) fail('E_SOURCE_CHANGED', `original source changed for ${item.sourceMediaId}`);
    resolved.set(item.sourceMediaId, { ...entry, media: probeEntry });
  }
  return resolved;
}

function assertMusic({ project, editBrief, timeline }) {
  const music = timeline.music ?? { mode: 'none' };
  if (music.mode === 'none') return null;
  if (music.mode !== 'local' || typeof music.path !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(music.path)) fail('E_REMOTE_MUSIC', 'final render accepts approved local music only');
  if (!editBrief.music?.localTracks?.includes(music.path) || editBrief.music.mode === 'none') fail('E_MUSIC_AUTHORITY', 'music is not part of the approved local brief');
  const absolutePath = projectPath(project, music.path);
  return { ...music, absolutePath };
}

function clarityBudget(delivery, durationSeconds) {
  const maximum = delivery.maximumFileSizeBytes;
  if (maximum === null || maximum === undefined) return null;
  const audioBitrate = delivery.audioCodec === 'pcm_s24le' ? 2_304_000 : 192_000;
  const totalBitrate = Math.floor((maximum * 8 * 0.98) / durationSeconds);
  const videoBitrate = totalBitrate - audioBitrate;
  const minimumVideoBitrate = delivery.width === 3840 ? 8_000_000 : 2_000_000;
  if (videoBitrate < minimumVideoBitrate) fail('E_CLARITY_FLOOR', 'requested raster, duration, codec, and size ceiling violate the clarity floor', {
    alternatives: ['increase maximumFileSizeBytes', 'select 1920x1080 delivery', 'shorten target duration'],
    budget: { totalBitrate, audioBitrate, videoBitrate, minimumVideoBitrate },
  });
  return { maximumFileSizeBytes: maximum, totalBitrate, audioBitrate, videoBitrate, minimumVideoBitrate, passes: 2 };
}

async function compileChapter({ project, chapter, items, resolvedSources, raster, fps, authority, assetManifest, motionMap }) {
  const args = [];
  const filters = [];
  const labels = [];
  const transforms = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const source = resolvedSources.get(item.sourceMediaId);
    const duration = item.chapterDestinationOut - item.chapterDestinationIn;
    const offset = Math.max(0, chapter.start - item.destinationInSeconds);
    const sourceStart = item.sourceInSeconds + offset * (item.playbackRate ?? 1);
    if (source.media.mediaType === 'image') args.push('-loop', '1', '-t', seconds(duration), '-i', source.sourcePath);
    else args.push('-ss', seconds(sourceStart), '-t', seconds(duration * (item.playbackRate ?? 1)), '-i', source.sourcePath);
    const transform = sourceTransform(source.media, raster, fps); transforms.push({ mediaId: item.sourceMediaId, ...transform });
    const video = [...transform.filters];
    const rate = normalizePlaybackRateCurve(item)[0]?.rate ?? item.playbackRate ?? 1;
    if (source.media.mediaType !== 'image' && rate !== 1) video.unshift(`setpts=(PTS-STARTPTS)/${seconds(rate)}`);
    video.push(`trim=duration=${seconds(duration)}`, 'setpts=PTS-STARTPTS', 'format=yuv420p');
    filters.push(`[${index}:v]${video.join(',')}[v${index}]`);
    const hasAudio = source.media.mediaType !== 'image' && source.media.streams?.some(({ type }) => type === 'audio');
    if (hasAudio) {
      const audio = [`atrim=duration=${seconds(duration * rate)}`, 'asetpts=PTS-STARTPTS'];
      if (rate !== 1) audio.push(...atempo(rate));
      if (item.audioPolicy?.denoise) audio.push('afftdn');
      audio.push(`volume=${seconds(10 ** ((item.audioPolicy?.sourceGainDb ?? 0) / 20))}`, `apad=whole_dur=${seconds(duration)}`, `atrim=duration=${seconds(duration)}`);
      filters.push(`[${index}:a]${audio.join(',')}[a${index}]`);
    } else filters.push(`anullsrc=r=48000:cl=stereo:d=${seconds(duration)}[a${index}]`);
    labels.push(`[v${index}][a${index}]`);
  }
  const owners = (motionMap.owners ?? []).filter(({ sceneId, assetId }) => sceneId === chapter.sceneId && assetId);
  const assetById = new Map((assetManifest.assets ?? []).map((asset) => [asset.id ?? asset.assetId, asset]));
  const compositionInputs = [];
  for (const owner of owners) {
    const asset = assetById.get(owner.assetId);
    if (!asset?.source) fail('E_HYPERFRAMES_LAYER_INPUT', `motion owner ${owner.ownerId} has no current asset source`);
    const sourcePath = projectPath(project, asset.source);
    let sourceDigest;
    try { sourceDigest = await sha256File(sourcePath); } catch { fail('E_HYPERFRAMES_LAYER_INPUT', `motion asset ${owner.assetId} is missing`); }
    compositionInputs.push({ ownerId: owner.ownerId, assetId: owner.assetId, path: asset.source, sourcePath, sourceDigest, timing: owner.timing });
    args.push('-loop', '1', '-t', seconds(chapter.end - chapter.start), '-i', sourcePath);
  }
  filters.push(`${labels.join('')}concat=n=${items.length}:v=1:a=1[${compositionInputs.length ? 'vfootage' : 'vchapter'}][achapter]`);
  let previous = 'vfootage';
  for (let index = 0; index < compositionInputs.length; index += 1) {
    const inputIndex = items.length + index;
    const layer = `hflayer${index}`;
    const output = index === compositionInputs.length - 1 ? 'vchapter' : `hfcomposite${index}`;
    const timing = compositionInputs[index].timing;
    const start = Math.max(0, (timing?.entry?.[0] ?? chapter.start) - chapter.start);
    const end = Math.min(chapter.end - chapter.start, (timing?.exit?.[1] ?? chapter.end) - chapter.start);
    filters.push(`[${inputIndex}:v]scale=${raster.width}:${raster.height}:force_original_aspect_ratio=decrease,format=rgba[${layer}]`);
    filters.push(`[${previous}][${layer}]overlay=x=(W-w)/2:y=(H-h)/2:enable='between(t,${seconds(start)},${seconds(end)})'[${output}]`);
    previous = output;
  }
  const semanticInput = {
    scene: chapter.scene ?? { sceneId: chapter.sceneId, title: chapter.title },
    items: items.map(({ chapterDestinationIn, chapterDestinationOut, ...item }) => item),
    sources: items.map(({ sourceMediaId }) => ({ mediaId: sourceMediaId, digest: resolvedSources.get(sourceMediaId).sourceDigest })),
    design: authority.design, look: authority.look, assets: authority.assets, motion: authority.motion,
    raster, fps, transforms,
    compositionInputs: compositionInputs.map(({ sourcePath, ...entry }) => entry),
  };
  const cacheKey = stableHash(semanticInput);
  const outputPath = projectPath(project, `cache/render/chapter-${chapter.sceneId}-${cacheKey}.mkv`);
  args.push('-filter_complex', filters.join(';'), '-map', '[vchapter]', '-map', '[achapter]', '-c:v', 'ffv1', '-level', '3', '-c:a', 'pcm_s16le', outputPath);
  return { chapterId: chapter.sceneId, title: chapter.title, startSeconds: chapter.start, endSeconds: chapter.end, cacheKey, outputPath, portablePath: `cache/render/${basename(outputPath)}`, args, filterComplex: filters.join(';'), transforms, compositionInputs, intermediateSafe: true };
}

export async function compileFinalRenderPlan(input) {
  assertAuthority(input);
  const { project, timeline, probe, editBrief, designSystem, lookProfile, assetManifest, motionMap, sceneSchema } = input;
  const delivery = editBrief.delivery;
  if (!RASTERS.has(`${delivery?.width}x${delivery?.height}`) || delivery.aspectRatio !== '16:9') fail('E_DELIVERY_RASTER', 'v1 final delivery is square-pixel 16:9 at 1080p or 4K');
  if (!VIDEO_CODEC[delivery.videoCodec] || !AUDIO_CODEC[delivery.audioCodec]) fail('E_DELIVERY_CODEC', 'unsupported final codec');
  const raster = { width: delivery.width, height: delivery.height, sar: '1', aspectRatio: '16:9' };
  const fps = rationalFps(editBrief, probe, timeline.items);
  const resolvedSources = await resolveSources({ project, sourceRegistry: input.sourceRegistry, timeline, probe });
  const music = assertMusic({ project, editBrief, timeline });
  const chapterInputs = semanticChapters(sceneSchema, timeline).map((chapter) => ({ chapter, items: chapterItems(chapter, timeline) })).filter(({ items }) => items.length > 0);
  const chapters = await Promise.all(chapterInputs.map(({ chapter, items }) => compileChapter({ project, chapter, items, resolvedSources, raster, fps, assetManifest, motionMap, authority: {
      design: designSystem.integrity.digest, look: lookProfile.integrity.digest, assets: assetManifest.integrity.digest, motion: motionMap.integrity.digest,
    } })));
  if (chapters.length === 0) fail('E_FINAL_CHAPTERS', 'final timeline has no semantic chapter intervals');
  const durationSeconds = Math.max(...timeline.items.map(({ destinationOutSeconds }) => destinationOutSeconds));
  const sizeBudget = clarityBudget(delivery, durationSeconds);
  const candidatePath = projectPath(project, `renders/.final.${process.pid}.candidate.${delivery.container}`);
  const finalArgs = chapters.flatMap(({ outputPath }) => ['-i', outputPath]);
  const concat = chapters.map((_, index) => `[${index}:v][${index}:a]`).join('');
  const filters = [`${concat}concat=n=${chapters.length}:v=1:a=1[vbase][abase]`];
  let audioLabel = 'abase';
  if (music) {
    if (music.loop) finalArgs.push('-stream_loop', '-1');
    finalArgs.push('-ss', seconds(music.trimInSeconds ?? 0), '-i', music.absolutePath);
    const musicIndex = chapters.length;
    const fadeIn = Math.min(music.fadeInSeconds ?? 0, durationSeconds);
    const fadeOut = Math.min(music.fadeOutSeconds ?? 0, durationSeconds);
    const treatments = [`atrim=duration=${seconds(durationSeconds)}`, 'asetpts=PTS-STARTPTS', 'loudnorm=I=-16:LRA=11:TP=-1.5', `volume=${seconds(10 ** ((music.gainDb ?? -18) / 20))}`];
    if (fadeIn > 0) treatments.push(`afade=t=in:st=0:d=${seconds(fadeIn)}`);
    if (fadeOut > 0) treatments.push(`afade=t=out:st=${seconds(durationSeconds - fadeOut)}:d=${seconds(fadeOut)}`);
    filters.push(`[${musicIndex}:a]${treatments.join(',')}[music]`);
    filters.push(`[music][abase]sidechaincompress=threshold=0.03:ratio=${seconds(1 + Math.abs(music.duckUnderSpeechDb ?? -12) / 3)}:attack=20:release=250[ducked]`);
    filters.push('[abase][ducked]amix=inputs=2:duration=first:dropout_transition=0[afinal]'); audioLabel = 'afinal';
  }
  finalArgs.push('-filter_complex', filters.join(';'), '-map', '[vbase]', '-map', `[${audioLabel}]`, '-c:v', VIDEO_CODEC[delivery.videoCodec]);
  if (sizeBudget) finalArgs.push('-b:v', String(sizeBudget.videoBitrate), '-maxrate', String(sizeBudget.videoBitrate), '-bufsize', String(sizeBudget.videoBitrate * 2));
  else finalArgs.push('-crf', delivery.videoCodec === 'h264' ? '18' : '20');
  finalArgs.push('-pix_fmt', 'yuv420p', '-r', fps, '-c:a', AUDIO_CODEC[delivery.audioCodec], ...(sizeBudget && delivery.audioCodec !== 'pcm_s24le' ? ['-b:a', String(sizeBudget.audioBitrate)] : []), '-movflags', '+faststart', candidatePath);
  const pass1Args = sizeBudget ? [...finalArgs.slice(0, -1), '-pass', '1', '-passlogfile', projectPath(project, 'cache/render/final-pass'), '-an', '-f', 'null', '/dev/null'] : null;
  const pass2Args = sizeBudget ? [...finalArgs.slice(0, -1), '-pass', '2', '-passlogfile', projectPath(project, 'cache/render/final-pass'), candidatePath] : finalArgs;
  return {
    command: 'ffmpeg', project, chapters, raster, fps, durationSeconds, sizeBudget,
    final: { args: finalArgs, pass1Args, pass2Args, candidatePath, outputPath: projectPath(project, 'renders/final.mp4'), filterComplex: filters.join(';') },
    lossyDeliveryEncodeCount: 1,
    authority: { timeline: timeline.integrity.digest, probe: probe.integrity.digest, designSystem: designSystem.integrity.digest, lookProfile: lookProfile.integrity.digest, assetManifest: assetManifest.integrity.digest, motionMap: motionMap.integrity.digest, sceneSchema: sceneSchema.integrity.digest, editBrief: editBrief.integrity.digest },
    originalSources: [...resolvedSources.values()].map(({ mediaId, sourceDigest }) => ({ mediaId, sourceDigest })).sort((a, b) => a.mediaId.localeCompare(b.mediaId)),
    hyperFramesComposition: { runtimeEntry: 'assets/hyperframes-project/index.html', command: 'paused-absolute-time-layer-render', sceneSchemaDigest: sceneSchema.integrity.digest, motionMapDigest: motionMap.integrity.digest, sceneIds: chapters.map(({ chapterId }) => chapterId), layerInputs: chapters.flatMap(({ compositionInputs }) => compositionInputs.map(({ ownerId, assetId, path, sourceDigest }) => ({ ownerId, assetId, path, sourceDigest }))) },
  };
}

export function commitFinalRenderState(projectState, provenance, timestamp) {
  if (projectState?.state !== 'MOTION_COMPOSITION') fail('E_FINAL_RENDER_STATE', 'FINAL_RENDER requires current MOTION_COMPOSITION');
  if (!Number.isFinite(Date.parse(timestamp ?? '')) || !DIGEST.test(provenance?.integrity?.digest ?? '')
    || provenance?.closedFileProbe?.valid !== true || !DIGEST.test(provenance?.outputDigest ?? '')) {
    fail('E_FINAL_RENDER_EVIDENCE', 'FINAL_RENDER requires current closed-file render provenance');
  }
  const next = structuredClone(projectState);
  const record = {
    gate: 'FINAL_RENDER', role: 'FINAL_RENDER', revision: provenance.revision,
    digest: provenance.integrity.digest, timestamp, producerCommand: 'render_final.mjs',
    qualifiers: ['closed-original-backed-candidate'], validity: 'valid', invalidatedAt: null,
  };
  next.previousState = projectState.state;
  next.state = 'FINAL_RENDER';
  next.stateEnteredAt = timestamp;
  next.revision += 1;
  next.gateEvidence.push(record);
  next.transitions.push({
    from: 'MOTION_COMPOSITION', to: 'FINAL_RENDER', at: timestamp,
    evidenceDigests: { FINAL_RENDER: provenance.integrity.digest },
    evidenceRevisions: { FINAL_RENDER: provenance.revision },
  });
  next.integrity.digest = null;
  return next;
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolve() : reject(Object.assign(new Error(`ffmpeg exited ${code ?? signal}: ${stderr.trim()}`), { code: 'E_SUBPROCESS' })));
  });
}

export function createRenderSession({ partialPaths = [] } = {}) {
  const children = new Set();
  let cancelled = false;
  return {
    get cancelled() { return cancelled; },
    track(child) { if (cancelled) child.kill('SIGTERM'); else { children.add(child); child.once('close', () => children.delete(child)); } return child; },
    async cancel() {
      cancelled = true;
      for (const child of children) child.kill('SIGTERM');
      await Promise.allSettled([...children].map((child) => new Promise((resolve) => child.once('close', resolve))));
      await Promise.all(partialPaths.map((path) => unlink(path).catch((cause) => { if (cause.code !== 'ENOENT') throw cause; })));
    },
  };
}

async function runFfmpeg(args, session) {
  if (session.cancelled) fail('E_RENDER_CANCELLED', 'render was cancelled');
  const child = session.track(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { shell: false, stdio: ['ignore', 'ignore', 'pipe'] }));
  await waitForChild(child);
}

async function cachedChapterValid(chapter) {
  try {
    const info = await stat(chapter.outputPath);
    if (!info.isFile() || info.size === 0) return false;
    const probe = await ffprobeJson(chapter.outputPath);
    return probe.streams?.some(({ codec_type }) => codec_type === 'video') && probe.streams?.some(({ codec_type }) => codec_type === 'audio');
  } catch { return false; }
}

function closedProbeSummary(probe, fps) {
  const video = probe.streams?.find(({ codec_type }) => codec_type === 'video');
  const audio = probe.streams?.find(({ codec_type }) => codec_type === 'audio');
  const formatDuration = Number(probe.format?.duration);
  const videoDuration = Number(video?.duration ?? formatDuration);
  const audioDuration = Number(audio?.duration ?? formatDuration);
  return {
    valid: Boolean(video && audio && formatDuration > 0), durationSeconds: formatDuration,
    width: video?.width ?? null, height: video?.height ?? null, sampleAspectRatio: video?.sample_aspect_ratio ?? null,
    frameRate: video?.avg_frame_rate ?? fps, videoCodec: video?.codec_name ?? null, audioCodec: audio?.codec_name ?? null,
    avDurationDeltaSeconds: Math.abs(videoDuration - audioDuration),
  };
}

export async function executeFinalRenderPlan(plan, options = {}) {
  await mkdir(projectPath(plan.project, 'cache/render'), { recursive: true });
  await mkdir(projectPath(plan.project, 'renders'), { recursive: true });
  const partialPaths = [plan.final.candidatePath];
  const session = options.session ?? createRenderSession({ partialPaths });
  let hits = 0; let misses = 0;
  try {
    for (const chapter of plan.chapters) {
      if (await cachedChapterValid(chapter)) { hits += 1; continue; }
      misses += 1; await runFfmpeg(chapter.args, session);
    }
    if (plan.final.pass1Args) await runFfmpeg(plan.final.pass1Args, session);
    await runFfmpeg(plan.final.pass2Args, session);
    const handle = await open(plan.final.candidatePath, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    const rawProbe = await ffprobeJson(plan.final.candidatePath);
    const closedFileProbe = closedProbeSummary(rawProbe, plan.fps);
    if (!closedFileProbe.valid || closedFileProbe.width !== plan.raster.width || closedFileProbe.height !== plan.raster.height) fail('E_FINAL_CLOSED_PROBE', 'closed final candidate failed raster or stream re-probe');
    const outputDigest = await sha256File(plan.final.candidatePath);
    const provenance = {
      schemaVersion: '1.0.0', revision: 1, producerCommand: 'render_final.mjs', artifact: 'renders/final.mp4', outputDigest,
      closedFileProbe, raster: plan.raster, fps: plan.fps, lossyDeliveryEncodeCount: 1,
      chapterCache: plan.chapters.map(({ chapterId, cacheKey, portablePath }) => ({ chapterId, cacheKey, path: portablePath })),
      originalSources: plan.originalSources, hyperFramesComposition: plan.hyperFramesComposition,
      integrity: { digest: null, upstream: plan.authority },
    };
    provenance.integrity.digest = computeArtifactDigest(provenance);
    const provenancePath = projectPath(plan.project, 'renders/final.provenance.json');
    const pendingProvenancePath = projectPath(plan.project, `renders/.final.provenance.${process.pid}.pending.json`);
    await writeJsonAtomic(pendingProvenancePath, provenance);
    if (options.publish === false) {
      return { ok: true, artifact: 'renders/final.mp4', outputDigest, closedFileProbe, provenance, cache: { hits, misses }, pending: { candidatePath: plan.final.candidatePath, provenancePath: pendingProvenancePath } };
    }
    try {
      await rename(plan.final.candidatePath, plan.final.outputPath);
      await rename(pendingProvenancePath, provenancePath);
    } catch (cause) {
      await Promise.all([plan.final.outputPath, pendingProvenancePath].map((path) => unlink(path).catch(() => {})));
      throw cause;
    }
    return { ok: true, artifact: 'renders/final.mp4', outputDigest, closedFileProbe, provenance, cache: { hits, misses } };
  } catch (cause) {
    await session.cancel();
    throw cause;
  }
}
