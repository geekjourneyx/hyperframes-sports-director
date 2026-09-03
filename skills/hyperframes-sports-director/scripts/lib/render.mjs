import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import sharp from 'sharp';

import { computeArtifactDigest } from './contracts.mjs';
import { ffprobeJson, runCommand } from './ffmpeg.mjs';
import { assertFinalSource, projectPath, sha256File, writeJsonAtomic } from './media.mjs';
import { compilePausedTimelines } from './motion.mjs';
import { normalizePlaybackRateCurve } from './timeline.mjs';
import { installSceneRuntime } from '../../assets/hyperframes-project/src/scene-runtime.js';

const DIGEST = /^[0-9a-f]{64}$/;
const RASTERS = new Set(['1920x1080', '3840x2160']);
const VIDEO_CODEC = { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1' };
const AUDIO_CODEC = { aac: 'aac', pcm_s24le: 'pcm_s24le', opus: 'libopus' };
const VIDEO_CODEC_NAME = { h264: 'h264', hevc: 'hevc', av1: 'av1' };
let detectedCapabilities;

function fail(code, message, details = {}) {
  const cause = new Error(message);
  cause.code = code;
  Object.assign(cause, details);
  throw cause;
}

async function renderCapabilities(provided) {
  if (provided?.filters) return provided;
  detectedCapabilities ??= runCommand('ffmpeg', ['-hide_banner', '-filters']).then(({ stdout }) => ({
    filters: {
      vidstabdetect: /\bvidstabdetect\b/.test(stdout),
      vidstabtransform: /\bvidstabtransform\b/.test(stdout),
    },
  }));
  return detectedCapabilities;
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
    title: timeline.items.find((item) => item.destinationInSeconds < scene.interval?.exit?.[1]
      && item.destinationOutSeconds > scene.interval?.entry?.[0])?.reasons?.[0] ?? scene.sceneId,
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
    .map((item) => {
      const destinationStart = Math.max(item.destinationInSeconds, chapter.start);
      const destinationEnd = Math.min(item.destinationOutSeconds, chapter.end);
      return {
        ...item,
        chapterDestinationIn: destinationStart - chapter.start,
        chapterDestinationOut: destinationEnd - chapter.start,
        renderPlaybackRateCurve: clipPlaybackCurve(item, destinationStart - item.destinationInSeconds, destinationEnd - item.destinationInSeconds),
      };
    });
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

async function assertMusic({ project, editBrief, timeline }) {
  const music = timeline.music ?? { mode: 'none' };
  if (music.mode === 'none') return null;
  if (music.mode !== 'local' || typeof music.path !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(music.path)) fail('E_REMOTE_MUSIC', 'final render accepts approved local music only');
  if (!editBrief.music?.localTracks?.includes(music.path) || editBrief.music.mode === 'none') fail('E_MUSIC_AUTHORITY', 'music is not part of the approved local brief');
  const absolutePath = projectPath(project, music.path);
  let digest;
  try { digest = await sha256File(absolutePath); } catch { fail('E_MUSIC_LOCAL_MISSING', 'approved local music is missing'); }
  let probe;
  try { probe = await ffprobeJson(absolutePath); } catch { fail('E_MUSIC_LOCAL_INVALID', 'approved local music cannot be decoded'); }
  const durationSeconds = Number(probe.format?.duration ?? probe.streams?.find(({ codec_type }) => codec_type === 'audio')?.duration);
  if (!(durationSeconds > 0)) fail('E_MUSIC_LOCAL_INVALID', 'approved local music has no positive duration');
  return { ...music, absolutePath, digest, durationSeconds };
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

function escapeDrawtext(value) {
  return String(value).replace(/([\\':])/g, '\\$1');
}

function tokenColor(designSystem, token) {
  return designSystem?.tokens?.colors?.[token] ?? '#FFFFFF';
}

function normalizedCurve(item) {
  if (item.renderPlaybackRateCurve?.length >= 2) return item.renderPlaybackRateCurve;
  const curve = normalizePlaybackRateCurve(item);
  if (curve.length >= 2) return curve;
  return [
    { sourceTimeSeconds: item.sourceInSeconds, rate: item.playbackRate ?? 1 },
    { sourceTimeSeconds: item.sourceOutSeconds, rate: item.playbackRate ?? 1 },
  ];
}

function sourceAtDestinationOffset(curve, offset) {
  let elapsed = 0;
  for (let index = 0; index < curve.length - 1; index += 1) {
    const point = curve[index]; const next = curve[index + 1];
    const duration = (next.sourceTimeSeconds - point.sourceTimeSeconds) / point.rate;
    if (offset <= elapsed + duration + 1e-9) return point.sourceTimeSeconds + (Math.max(0, offset - elapsed) * point.rate);
    elapsed += duration;
  }
  return curve.at(-1).sourceTimeSeconds;
}

function rateAtDestinationOffset(curve, offset) {
  let elapsed = 0;
  for (let index = 0; index < curve.length - 1; index += 1) {
    const duration = (curve[index + 1].sourceTimeSeconds - curve[index].sourceTimeSeconds) / curve[index].rate;
    if (offset < elapsed + duration - 1e-9) return curve[index].rate;
    elapsed += duration;
  }
  return curve.at(-2)?.rate ?? curve[0].rate;
}

function clipPlaybackCurve(item, destinationStartOffset, destinationEndOffset) {
  const curve = normalizePlaybackRateCurve(item);
  const startSource = sourceAtDestinationOffset(curve, destinationStartOffset);
  const endSource = sourceAtDestinationOffset(curve, destinationEndOffset);
  const clipped = [{ sourceTimeSeconds: startSource, rate: rateAtDestinationOffset(curve, destinationStartOffset) }];
  let elapsed = 0;
  for (let index = 0; index < curve.length - 1; index += 1) {
    elapsed += (curve[index + 1].sourceTimeSeconds - curve[index].sourceTimeSeconds) / curve[index].rate;
    if (elapsed > destinationStartOffset + 1e-9 && elapsed < destinationEndOffset - 1e-9) clipped.push({ sourceTimeSeconds: curve[index + 1].sourceTimeSeconds, rate: curve[index + 1].rate });
  }
  clipped.push({ sourceTimeSeconds: endSource, rate: clipped.at(-1).rate });
  return clipped;
}

function runtimeSamples(renderer, layer, chapter) {
  const boundaries = [...new Set([
    ...(layer.layoutEvidence?.textRect ?? []).map(({ time }) => time),
    ...Object.values(layer.timing ?? {}).flat(),
    ...Object.values(layer.timing ?? {}).map(([start, end]) => (start + end) / 2),
  ].filter((time) => Number.isFinite(time) && time >= chapter.start && time <= chapter.end))].sort((a, b) => a - b);
  return boundaries.map((time) => {
    const rendered = renderer.__renderAt(time, 'composite').layers.find(({ layerId }) => layerId === layer.layerId);
    return rendered ? { time, geometry: rendered.geometry, coverage: rendered.coverage } : null;
  }).filter(Boolean);
}

function geometryExpression(samples, key, chapterStart, fallback) {
  if (samples.length < 2) return String(samples[0]?.geometry?.[key] ?? fallback);
  const terms = samples.slice(0, -1).map((sample, index) => {
    const next = samples[index + 1];
    const start = sample.time - chapterStart; const end = next.time - chapterStart;
    const from = sample.geometry[key]; const to = next.geometry[key];
    const value = end === start ? seconds(to) : `${seconds(from)}+(${seconds(to - from)})*(t-${seconds(start)})/${seconds(end - start)}`;
    return { end, value };
  });
  let expression = seconds(samples.at(-1).geometry[key]);
  for (let index = terms.length - 1; index >= 0; index -= 1) expression = `if(lte(t,${seconds(terms[index].end)}),${terms[index].value},${expression})`;
  return `'${expression}'`;
}

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function fallbackSvg(fallback, color, width, height) {
  const shapes = fallback.shapes ?? (fallback.path ? [{ type: 'path', d: fallback.path }] : []);
  const shapeBody = shapes.map((shape) => {
    const fill = xml(color); const opacity = Number.isFinite(shape.opacity) ? ` fill-opacity="${shape.opacity}"` : '';
    if (shape.type === 'rect') return `<rect x="${shape.x ?? 0}" y="${shape.y ?? 0}" width="${shape.width}" height="${shape.height}" fill="${fill}"${opacity}/>`;
    if (shape.type === 'circle') return `<circle cx="${shape.cx}" cy="${shape.cy}" r="${shape.r}" fill="${fill}"${opacity}/>`;
    return `<path d="${xml(shape.d ?? shape.path)}" fill="${fill}"${opacity}/>`;
  }).join('');
  const textBody = ['glyph', 'text'].includes(fallback.kind) && fallback.text
    ? `<text x="0" y="${height * 0.75}" font-size="${height * 0.7}" fill="${xml(color)}">${xml(fallback.text)}</text>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${xml(fallback.viewBox ?? `0 0 ${width} ${height}`)}">${shapeBody}${textBody}</svg>`;
}

function stabilizationPass(sourcePath, curve, crop, transformsPath) {
  const filters = [];
  const labels = [];
  for (let index = 0; index < curve.length - 1; index += 1) {
    const point = curve[index]; const next = curve[index + 1];
    filters.push(`[0:v]trim=start=${seconds(point.sourceTimeSeconds)}:end=${seconds(next.sourceTimeSeconds)},setpts=(PTS-STARTPTS)/${seconds(point.rate)}[detect${index}]`);
    labels.push(`[detect${index}]`);
  }
  filters.push(`${labels.join('')}concat=n=${labels.length}:v=1:a=0[detectraw]`);
  const treatments = [];
  if (crop) treatments.push(`crop=iw*${seconds(crop.width)}:ih*${seconds(crop.height)}:iw*${seconds(crop.x)}:ih*${seconds(crop.y)}`);
  treatments.push(`vidstabdetect=result=${transformsPath}`);
  filters.push(`[detectraw]${treatments.join(',')}[vdetect]`);
  return ['-i', sourcePath, '-filter_complex', filters.join(';'), '-map', '[vdetect]', '-f', 'null', '-'];
}

function addVideoTreatments(filters, item, raster, fps, stabilization) {
  const crop = item.transform?.cropReframe;
  if (crop) filters.push(`crop=iw*${seconds(crop.width)}:ih*${seconds(crop.height)}:iw*${seconds(crop.x)}:ih*${seconds(crop.y)}`);
  if (['minimal', 'conservative'].includes(item.transform?.stabilization?.mode)) filters.push(stabilization?.mode === 'vidstab-two-pass' ? `vidstabtransform=input=${stabilization.transformsPath}` : 'deshake');
  filters.push(`scale=${raster.width}:${raster.height}:force_original_aspect_ratio=decrease`, `pad=${raster.width}:${raster.height}:(ow-iw)/2:(oh-ih)/2:color=black`, 'setsar=1', `fps=${fps}`);
  if (item.sourceKind === 'image' && item.transform?.stillMotion?.mode === 'panzoom') {
    filters.push(`zoompan=z='min(zoom+0.0015,${seconds(item.transform.stillMotion.endScale)})':d=1:s=${raster.width}x${raster.height}:fps=${fps}`);
  }
}

async function compileChapter({ project, chapter, items, resolvedSources, raster, fps, authority, assetManifest, runtimeScene, runtimeOverlays, designSystem, runtimeRenderer, capabilities }) {
  const args = [];
  const filters = [];
  const videoLabels = []; const audioLabels = [];
  const audioMetadata = [];
  const transforms = [];
  const stabilizationPasses = [];
  const runtimeEvidence = (runtimeScene?.layers ?? []).map((layer) => ({ layerId: layer.layerId, samples: runtimeSamples(runtimeRenderer, layer, chapter) }));
  const vidstab = capabilities?.filters?.vidstabdetect === true && capabilities?.filters?.vidstabtransform === true;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const source = resolvedSources.get(item.sourceMediaId);
    const duration = item.chapterDestinationOut - item.chapterDestinationIn;
    if (source.media.mediaType === 'image') args.push('-loop', '1', '-t', seconds(duration), '-i', source.sourcePath);
    else args.push('-i', source.sourcePath);
    const transform = sourceTransform(source.media, raster, fps); transforms.push({ mediaId: item.sourceMediaId, ...transform });
    const hasAudio = source.media.mediaType !== 'image' && source.media.streams?.some(({ type }) => type === 'audio');
    if (source.media.mediaType === 'image') {
      const video = [];
      addVideoTreatments(video, item, raster, fps);
      video.push(`trim=duration=${seconds(duration)}`, 'setpts=PTS-STARTPTS', 'format=yuv420p');
      filters.push(`[${index}:v]${video.join(',')}[v${index}]`);
      filters.push(`anullsrc=r=48000:cl=stereo:d=${seconds(duration)}[a${index}]`);
    } else {
      const curve = normalizedCurve(item);
      const segmentLabels = [];
      for (let segment = 0; segment < curve.length - 1; segment += 1) {
        const point = curve[segment]; const next = curve[segment + 1]; const rate = point.rate;
        filters.push(`[${index}:v]trim=start=${seconds(point.sourceTimeSeconds)}:end=${seconds(next.sourceTimeSeconds)},setpts=(PTS-STARTPTS)/${seconds(rate)}[v${index}s${segment}]`);
        if (hasAudio) filters.push(`[${index}:a]atrim=start=${seconds(point.sourceTimeSeconds)}:end=${seconds(next.sourceTimeSeconds)},asetpts=PTS-STARTPTS,${atempo(rate).join(',')}[a${index}s${segment}]`);
        else filters.push(`anullsrc=r=48000:cl=stereo:d=${seconds((next.sourceTimeSeconds - point.sourceTimeSeconds) / rate)}[a${index}s${segment}]`);
        segmentLabels.push(`[v${index}s${segment}][a${index}s${segment}]`);
      }
      filters.push(`${segmentLabels.join('')}concat=n=${segmentLabels.length}:v=1:a=1[v${index}raw][a${index}raw]`);
      const video = [];
      const stabilization = ['minimal', 'conservative'].includes(item.transform?.stabilization?.mode) && vidstab
        ? { mode: 'vidstab-two-pass', transformsPath: projectPath(project, `cache/render/vidstab-${chapter.sceneId}-${index}.trf`) } : null;
      if (stabilization) stabilizationPasses.push({ sourcePath: source.sourcePath, transformsPath: stabilization.transformsPath, args: stabilizationPass(source.sourcePath, curve, item.transform?.cropReframe, stabilization.transformsPath) });
      addVideoTreatments(video, item, raster, fps, stabilization);
      video.push(`trim=duration=${seconds(duration)}`, 'setpts=PTS-STARTPTS', 'format=yuv420p');
      filters.push(`[v${index}raw]${video.join(',')}[v${index}]`);
      const audio = [];
      if (item.audioPolicy?.denoise) audio.push('afftdn');
      audio.push(`volume=${seconds(10 ** ((item.audioPolicy?.sourceGainDb ?? 0) / 20))}`);
      audio.push(`atrim=duration=${seconds(duration)}`);
      filters.push(`[a${index}raw]${audio.join(',')}[a${index}]`);
    }
    audioMetadata.push({ hasAudio, curve: source.media.mediaType === 'image' ? null : normalizedCurve(item) });
    videoLabels.push(`[v${index}]`); audioLabels.push(`[a${index}]`);
  }
  const assetById = new Map((assetManifest.assets ?? []).map((asset) => [asset.id ?? asset.assetId, asset]));
  const compositionInputs = [];
  for (const layer of runtimeScene?.layers ?? []) {
    if (!layer.assetId) continue;
    const asset = assetById.get(layer.assetId);
    if (!asset?.source) fail('E_HYPERFRAMES_LAYER_INPUT', `motion owner ${layer.ownerId} has no current asset source`);
    const sourcePath = projectPath(project, asset.source);
    let sourceDigest;
    try { sourceDigest = await sha256File(sourcePath); } catch { fail('E_HYPERFRAMES_LAYER_INPUT', `motion asset ${layer.assetId} is missing`); }
    const samples = runtimeSamples(runtimeRenderer, layer, chapter);
    compositionInputs.push({ ownerId: layer.ownerId, layerId: layer.layerId, assetId: layer.assetId, path: asset.source, sourcePath, sourceDigest, timing: layer.timing, geometry: samples[0]?.geometry ?? asset.expectedDisplayRect ?? null, runtimeSamples: samples });
    args.push('-loop', '1', '-t', seconds(chapter.end - chapter.start), '-i', sourcePath);
  }
  const generatedLayers = [];
  for (const layer of runtimeScene?.layers ?? []) {
    if (layer.assetId || !['shape', 'glyph', 'text'].includes(layer.staticFallback?.kind)) continue;
    const samples = runtimeSamples(runtimeRenderer, layer, chapter);
    const geometry = samples[0]?.geometry ?? { x: 96, y: 96, width: 480, height: 160 };
    const digest = stableHash({ layerId: layer.layerId, fallback: layer.staticFallback, color: tokenColor(designSystem, layer.colorToken), geometry });
    const renderPath = projectPath(project, `cache/render/layer-${digest}.png`);
    generatedLayers.push({ layerId: layer.layerId, renderPath, svg: fallbackSvg(layer.staticFallback, tokenColor(designSystem, layer.colorToken), geometry.width, geometry.height), width: geometry.width, height: geometry.height, runtimeSamples: samples, timing: layer.timing });
    args.push('-loop', '1', '-t', seconds(chapter.end - chapter.start), '-i', renderPath);
  }
  const hasRuntimeLayers = (runtimeScene?.layers?.length ?? 0) > 0 || (runtimeOverlays?.length ?? 0) > 0;
  filters.push(`${videoLabels.join('')}concat=n=${items.length}:v=1:a=0[${hasRuntimeLayers ? 'vfootage' : 'vchapter'}]`);
  const alignedAudio = audioLabels.map((label, index) => {
    const output = `aaligned${index}`; const delay = Math.round(items[index].chapterDestinationIn * 1000);
    filters.push(`${label}adelay=${delay}|${delay}[${output}]`);
    return `[${output}]`;
  });
  const bridgeAudio = [];
  for (let index = 0; index < items.length - 1; index += 1) {
    const kind = items[index].audioPolicy?.bridge ?? 'none';
    const duration = { 'l-cut': 0.04, 'j-cut': 0.06, ambience: 0.1, 'room-tone': 0.08 }[kind] ?? 0;
    if (!(duration > 0)) continue;
    const incoming = kind === 'j-cut';
    const sourceIndex = incoming ? index + 1 : index;
    const metadata = audioMetadata[sourceIndex];
    if (!metadata?.hasAudio) continue;
    const curve = metadata.curve;
    const boundarySource = incoming ? curve[0].sourceTimeSeconds : curve.at(-1).sourceTimeSeconds;
    const rate = incoming ? curve[0].rate : curve.at(-2)?.rate ?? 1;
    const sourceStart = incoming ? Math.max(0, boundarySource - (duration * rate)) : boundarySource;
    const sourceEnd = incoming ? boundarySource : boundarySource + (duration * rate);
    if (!(sourceEnd > sourceStart)) continue;
    const delay = Math.max(0, Math.round((items[index + 1].chapterDestinationIn - (incoming ? duration : 0)) * 1000));
    const output = `abridge${index}`;
    filters.push(`[${sourceIndex}:a]atrim=start=${seconds(sourceStart)}:end=${seconds(sourceEnd)},asetpts=PTS-STARTPTS,${atempo(rate).join(',')},afade=t=${incoming ? 'in' : 'out'}:st=0:d=${seconds(duration)},adelay=${delay}|${delay}[${output}]`);
    bridgeAudio.push(`[${output}]`);
  }
  const mixInputs = [...alignedAudio, ...bridgeAudio];
  filters.push(`${mixInputs.join('')}amix=inputs=${mixInputs.length}:duration=longest:normalize=0,apad=whole_dur=${seconds(chapter.end - chapter.start)},atrim=duration=${seconds(chapter.end - chapter.start)}[achapter]`);
  let previous = 'vfootage';
  let renderStep = 0;
  for (let index = 0; index < compositionInputs.length; index += 1) {
    const inputIndex = items.length + index;
    const layer = `hflayer${index}`;
    const output = `hfcomposite${renderStep++}`;
    const timing = compositionInputs[index].timing;
    const start = Math.max(0, (timing?.entry?.[0] ?? chapter.start) - chapter.start);
    const end = Math.min(chapter.end - chapter.start, (timing?.exit?.[1] ?? chapter.end) - chapter.start);
    const geometry = compositionInputs[index].geometry;
    const width = geometry?.width ?? raster.width; const height = geometry?.height ?? raster.height;
    const x = geometryExpression(compositionInputs[index].runtimeSamples, 'x', chapter.start, geometry?.x ?? 0);
    const y = geometryExpression(compositionInputs[index].runtimeSamples, 'y', chapter.start, geometry?.y ?? 0);
    const dynamicWidth = geometryExpression(compositionInputs[index].runtimeSamples, 'width', chapter.start, width);
    const dynamicHeight = geometryExpression(compositionInputs[index].runtimeSamples, 'height', chapter.start, height);
    filters.push(`[${inputIndex}:v]scale=w=${dynamicWidth}:h=${dynamicHeight}:eval=frame,format=rgba[${layer}]`);
    filters.push(`[${previous}][${layer}]overlay=x=${x}:y=${y}:enable='between(t,${seconds(start)},${seconds(end)})'[${output}]`);
    previous = output;
  }
  for (const layer of runtimeScene?.layers ?? []) {
    if (layer.assetId) continue;
    const fallback = layer.staticFallback;
    const start = Math.max(0, (layer.timing?.entry?.[0] ?? chapter.start) - chapter.start);
    const end = Math.min(chapter.end - chapter.start, (layer.timing?.exit?.[1] ?? chapter.end) - chapter.start);
    const output = `hfcomposite${renderStep++}`;
    if (['glyph', 'text', 'shape'].includes(fallback?.kind)) {
      const generatedIndex = generatedLayers.findIndex(({ layerId }) => layerId === layer.layerId);
      const generated = generatedLayers[generatedIndex];
      const inputIndex = items.length + compositionInputs.length + generatedIndex;
      const x = geometryExpression(generated.runtimeSamples, 'x', chapter.start, 0); const y = geometryExpression(generated.runtimeSamples, 'y', chapter.start, 0);
      const width = geometryExpression(generated.runtimeSamples, 'width', chapter.start, generated.width);
      const height = geometryExpression(generated.runtimeSamples, 'height', chapter.start, generated.height);
      filters.push(`[${inputIndex}:v]format=rgba,scale=w=${width}:h=${height}:eval=frame[hfshape${generatedIndex}]`);
      filters.push(`[${previous}][hfshape${generatedIndex}]overlay=x=${x}:y=${y}:enable='between(t,${seconds(start)},${seconds(end)})'[${output}]`);
    } else continue;
    previous = output;
  }
  for (const overlay of runtimeOverlays ?? []) {
    if (overlay.interval[0] >= chapter.end || overlay.interval[1] <= chapter.start) continue;
    const output = `hfcomposite${renderStep++}`;
    const start = Math.max(0, overlay.interval[0] - chapter.start); const end = Math.min(chapter.end - chapter.start, overlay.interval[1] - chapter.start);
    filters.push(`[${previous}]drawtext=text='${escapeDrawtext(overlay.wording)}':x=w-tw-80:y=h-th-80:fontsize=48:fontcolor=${tokenColor(designSystem, overlay.colorToken)}:enable='between(t,${seconds(start)},${seconds(end)})'[${output}]`);
    previous = output;
  }
  if (hasRuntimeLayers) filters.push(`[${previous}]null[vchapter]`);
  const semanticInput = {
    scene: chapter.scene ?? { sceneId: chapter.sceneId, title: chapter.title },
    items: items.map(({ chapterDestinationIn, chapterDestinationOut, ...item }) => item),
    sources: items.map(({ sourceMediaId }) => ({ mediaId: sourceMediaId, digest: resolvedSources.get(sourceMediaId).sourceDigest })),
    design: authority.design, look: authority.look, assets: authority.assets,
    raster, fps, transforms,
    runtimeScene,
    compositionInputs: compositionInputs.map(({ sourcePath, ...entry }) => entry), generatedLayers: generatedLayers.map(({ svg, ...entry }) => entry), stabilizationPasses, runtimeEvidence,
  };
  const cacheKey = stableHash(semanticInput);
  const outputPath = projectPath(project, `cache/render/chapter-${chapter.sceneId}-${cacheKey}.mkv`);
  const renderPath = `${outputPath}.pending-${process.pid}`;
  const sidecarPath = `${outputPath}.json`; const pendingSidecarPath = `${sidecarPath}.pending-${process.pid}`;
  args.push('-filter_complex', filters.join(';'), '-map', '[vchapter]', '-map', '[achapter]', '-c:v', 'ffv1', '-level', '3', '-c:a', 'pcm_s16le', '-f', 'matroska', renderPath);
  return { chapterId: chapter.sceneId, title: chapter.title, startSeconds: chapter.start, endSeconds: chapter.end, cacheKey, outputPath, renderPath, sidecarPath, pendingSidecarPath, portablePath: `cache/render/${basename(outputPath)}`, args, filterComplex: filters.join(';'), transforms, compositionInputs, generatedLayers, stabilizationPasses, runtimeEvidence, intermediateSafe: true };
}

export async function compileFinalRenderPlan(input) {
  assertAuthority(input);
  const { project, timeline, probe, editBrief, designSystem, lookProfile, assetManifest, motionMap, sceneSchema, projectState } = input;
  const delivery = editBrief.delivery;
  if (!RASTERS.has(`${delivery?.width}x${delivery?.height}`) || delivery.aspectRatio !== '16:9') fail('E_DELIVERY_RASTER', 'v1 final delivery is square-pixel 16:9 at 1080p or 4K');
  if (delivery.container !== 'mp4') fail('E_DELIVERY_CONTAINER', 'v1 final artifact is renders/final.mp4; select MP4 delivery');
  if (!VIDEO_CODEC[delivery.videoCodec] || !AUDIO_CODEC[delivery.audioCodec]) fail('E_DELIVERY_CODEC', 'unsupported final codec');
  const raster = { width: delivery.width, height: delivery.height, sar: '1', aspectRatio: '16:9' };
  const fps = rationalFps(editBrief, probe, timeline.items);
  const resolvedSources = await resolveSources({ project, sourceRegistry: input.sourceRegistry, timeline, probe });
  const music = await assertMusic({ project, editBrief, timeline });
  const capabilities = await renderCapabilities(input.capabilities);
  const runtime = compilePausedTimelines(input);
  const runtimeRenderer = installSceneRuntime({}, runtime);
  const runtimeByScene = new Map(runtime.scenes.map((scene) => [scene.sceneId, scene]));
  const chapterInputs = semanticChapters(sceneSchema, timeline).map((chapter) => ({ chapter, items: chapterItems(chapter, timeline) })).filter(({ items }) => items.length > 0);
  const chapters = await Promise.all(chapterInputs.map(({ chapter, items }) => compileChapter({ project, chapter, items, resolvedSources, raster, fps, assetManifest, runtimeScene: runtimeByScene.get(chapter.sceneId), runtimeOverlays: runtime.overlays, designSystem, runtimeRenderer, capabilities, authority: {
      design: designSystem.integrity.digest, look: lookProfile.integrity.digest, assets: assetManifest.integrity.digest, motion: motionMap.integrity.digest,
    } })));
  if (chapters.length === 0) fail('E_FINAL_CHAPTERS', 'final timeline has no semantic chapter intervals');
  const durationSeconds = Math.max(...timeline.items.map(({ destinationOutSeconds }) => destinationOutSeconds));
  const sizeBudget = clarityBudget(delivery, durationSeconds);
  const transactionId = stableHash({ timeline: timeline.integrity.digest, projectState: projectState.integrity.digest, pid: process.pid }).slice(0, 32);
  const candidatePath = projectPath(project, `renders/.final-render.${transactionId}.candidate.mp4`);
  const finalArgs = chapters.flatMap(({ outputPath }) => ['-i', outputPath]);
  const concat = chapters.map((_, index) => `[${index}:v][${index}:a]`).join('');
  const filters = [`${concat}concat=n=${chapters.length}:v=1:a=1[vbase][abase]`];
  let audioLabel = 'abase';
  if (music) {
    finalArgs.push('-ss', seconds(music.trimInSeconds ?? 0), '-i', music.absolutePath);
    const musicIndex = chapters.length;
    const fadeIn = Math.min(music.fadeInSeconds ?? 0, durationSeconds);
    const fadeOut = Math.min(music.fadeOutSeconds ?? 0, durationSeconds);
    let musicLabel = `${musicIndex}:a`;
    if (music.loop) {
      const crossfade = music.loopCrossfadeSeconds ?? 0;
      if (!(crossfade > 0)) fail('E_MUSIC_LOOP_SEAM', 'looped local music requires an approved crossfade');
      const usableDuration = Math.max(0.001, music.durationSeconds - (music.trimInSeconds ?? 0));
      const copies = Math.max(2, Math.ceil((durationSeconds - crossfade) / Math.max(0.001, usableDuration - crossfade)));
      filters.push(`[${musicIndex}:a]asplit=${copies}${Array.from({ length: copies }, (_, index) => `[music${index}]`).join('')}`);
      for (let index = 0; index < copies; index += 1) filters.push(`[music${index}]atrim=duration=${seconds(usableDuration)},asetpts=PTS-STARTPTS[music${index}t]`);
      let loopLabel = 'music0t';
      for (let index = 1; index < copies; index += 1) {
        const nextLabel = index === copies - 1 ? 'musicLoop' : `musicLoop${index}`;
        filters.push(`[${loopLabel}][music${index}t]acrossfade=d=${seconds(crossfade)}:c1=tri:c2=tri[${nextLabel}]`);
        loopLabel = nextLabel;
      }
      musicLabel = loopLabel;
    }
    const treatments = [`atrim=duration=${seconds(durationSeconds)}`, 'asetpts=PTS-STARTPTS', 'loudnorm=I=-16:LRA=11:TP=-1.5', `volume=${seconds(10 ** ((music.gainDb ?? -18) / 20))}`];
    if (fadeIn > 0) treatments.push(`afade=t=in:st=0:d=${seconds(fadeIn)}`);
    if (fadeOut > 0) treatments.push(`afade=t=out:st=${seconds(durationSeconds - fadeOut)}:d=${seconds(fadeOut)}`);
    filters.push(`[${musicLabel}]${treatments.join(',')}[music]`);
    filters.push('[abase]asplit=2[abaseMix][asidechain]');
    filters.push(`[music][asidechain]sidechaincompress=threshold=0.03:ratio=${seconds(1 + Math.abs(music.duckUnderSpeechDb ?? -12) / 3)}:attack=20:release=250[ducked]`);
    filters.push('[abaseMix][ducked]amix=inputs=2:duration=first:dropout_transition=0[afinal]'); audioLabel = 'afinal';
  }
  finalArgs.push('-filter_complex', filters.join(';'), '-map', '[vbase]', '-map', `[${audioLabel}]`, '-c:v', VIDEO_CODEC[delivery.videoCodec]);
  if (sizeBudget) finalArgs.push('-b:v', String(sizeBudget.videoBitrate), '-maxrate', String(sizeBudget.videoBitrate), '-bufsize', String(sizeBudget.videoBitrate * 2));
  else finalArgs.push('-crf', delivery.videoCodec === 'h264' ? '18' : '20');
  finalArgs.push('-pix_fmt', 'yuv420p', '-r', fps, '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv', '-c:a', AUDIO_CODEC[delivery.audioCodec], ...(sizeBudget && delivery.audioCodec !== 'pcm_s24le' ? ['-b:a', String(sizeBudget.audioBitrate)] : []), '-movflags', '+faststart', candidatePath);
  const pass1Args = sizeBudget ? [...finalArgs.slice(0, -1), '-pass', '1', '-passlogfile', projectPath(project, 'cache/render/final-pass'), '-an', '-f', 'null', '/dev/null'] : null;
  const pass2Args = sizeBudget ? [...finalArgs.slice(0, -1), '-pass', '2', '-passlogfile', projectPath(project, 'cache/render/final-pass'), candidatePath] : finalArgs;
  return {
    command: 'ffmpeg', project, transactionId, chapters, raster, fps, durationSeconds, sizeBudget,
    expected: { container: delivery.container, videoCodec: VIDEO_CODEC_NAME[delivery.videoCodec], audioCodec: delivery.audioCodec },
    final: { args: finalArgs, pass1Args, pass2Args, candidatePath, outputPath: projectPath(project, 'renders/final.mp4'), filterComplex: filters.join(';') },
    lossyDeliveryEncodeCount: 1,
    authority: { timeline: timeline.integrity.digest, probe: probe.integrity.digest, designSystem: designSystem.integrity.digest, lookProfile: lookProfile.integrity.digest, assetManifest: assetManifest.integrity.digest, motionMap: motionMap.integrity.digest, sceneSchema: sceneSchema.integrity.digest, editBrief: editBrief.integrity.digest, ...(music ? { music: music.digest } : {}) },
    originalSources: [...resolvedSources.values()].map(({ mediaId, sourceDigest }) => ({ mediaId, sourceDigest })).sort((a, b) => a.mediaId.localeCompare(b.mediaId)),
    sourceChecks: [...resolvedSources.values()].map(({ mediaId, sourcePath, sourceDigest }) => ({ mediaId, sourcePath, sourceDigest })),
    musicCheck: music ? { sourcePath: music.absolutePath, sourceDigest: music.digest } : null,
    hyperFramesComposition: { clock: runtime.clock, runtimeEntry: 'assets/hyperframes-project/index.html', command: 'paused-absolute-time-layer-render', sceneSchemaDigest: sceneSchema.integrity.digest, motionMapDigest: motionMap.integrity.digest, sceneIds: chapters.map(({ chapterId }) => chapterId), layerInputs: chapters.flatMap(({ compositionInputs }) => compositionInputs.map(({ ownerId, assetId, path, sourceDigest }) => ({ ownerId, assetId, path, sourceDigest }))) },
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

export function commitCancelledRenderState(projectState, timestamp) {
  if (projectState?.state !== 'MOTION_COMPOSITION' || !Number.isFinite(Date.parse(timestamp ?? ''))) fail('E_RENDER_CANCELLED_STATE', 'render cancellation requires current MOTION_COMPOSITION and an ISO timestamp');
  const next = structuredClone(projectState);
  const digest = computeArtifactDigest({ reason: 'render-cancelled', stateDigest: projectState.integrity?.digest ?? null, timestamp });
  const revision = projectState.revision + 1;
  next.previousState = projectState.state; next.state = 'CANCELLED'; next.stateEnteredAt = timestamp; next.revision = revision;
  next.assetAcceptance = null;
  next.gateEvidence.push({ gate: 'CANCELLED', role: 'CANCELLATION', revision, digest, timestamp, producerCommand: 'render_final.mjs', qualifiers: ['render-cancelled'], validity: 'valid', invalidatedAt: null });
  next.transitions.push({ from: projectState.state, to: 'CANCELLED', at: timestamp, evidenceDigests: { CANCELLATION: digest }, evidenceRevisions: { CANCELLATION: revision } });
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

export function createRenderSession({ partialPaths = [], signal, killAfterMs = 1500, forceKill = (child) => process.kill(child.pid, 'SIGKILL') } = {}) {
  const children = new Set();
  let cancelled = false;
  let cancellation;
  const session = {
    get cancelled() { return cancelled; },
    track(child) { if (cancelled) child.kill('SIGTERM'); else { children.add(child); child.once('close', () => children.delete(child)); } return child; },
    async cancel() {
      if (cancellation) return cancellation;
      cancelled = true;
      cancellation = (async () => {
        await Promise.allSettled([...children].map(async (child) => {
          const closed = new Promise((resolve) => child.once('close', resolve));
          child.kill('SIGTERM');
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.pid) {
              try { forceKill(child); } catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
            }
          }, killAfterMs);
          try { await closed; } finally { clearTimeout(timer); }
        }));
        await Promise.all(partialPaths.map((path) => unlink(path).catch((cause) => { if (cause.code !== 'ENOENT') throw cause; })));
      })();
      return cancellation;
    },
  };
  if (signal) {
    if (signal.aborted) void session.cancel();
    else signal.addEventListener('abort', () => { void session.cancel(); }, { once: true });
  }
  return session;
}

async function runFfmpeg(args, session) {
  if (session.cancelled) fail('E_RENDER_CANCELLED', 'render was cancelled');
  const child = session.track(spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { shell: false, stdio: ['ignore', 'ignore', 'pipe'] }));
  try { await waitForChild(child); } catch (cause) { if (session.cancelled) fail('E_RENDER_CANCELLED', 'render was cancelled'); throw cause; }
  if (session.cancelled) fail('E_RENDER_CANCELLED', 'render was cancelled');
}

async function cachedChapterValid(chapter) {
  try {
    const info = await stat(chapter.outputPath);
    if (!info.isFile() || info.size === 0) return false;
    const sidecar = JSON.parse(await readFile(chapter.sidecarPath, 'utf8'));
    if (sidecar.cacheKey !== chapter.cacheKey || sidecar.outputDigest !== await sha256File(chapter.outputPath)) return false;
    const probe = await ffprobeJson(chapter.outputPath);
    return probe.streams?.some(({ codec_type }) => codec_type === 'video') && probe.streams?.some(({ codec_type }) => codec_type === 'audio')
      && Number(probe.format?.duration) >= chapter.endSeconds - chapter.startSeconds - 0.05;
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

export function validateClosedDeliveryContract(plan, rawProbe, fileSize) {
  const closedFileProbe = closedProbeSummary(rawProbe, plan.fps);
  const [expectedNumerator, expectedDenominator] = plan.fps.split('/').map(Number);
  const [actualNumerator, actualDenominator] = closedFileProbe.frameRate.split('/').map(Number);
  const expectedFps = expectedNumerator / expectedDenominator;
  const actualFps = actualNumerator / actualDenominator;
  if (!closedFileProbe.valid || closedFileProbe.width !== plan.raster.width || closedFileProbe.height !== plan.raster.height
    || !['1:1', '1/1'].includes(closedFileProbe.sampleAspectRatio) || !Number.isFinite(actualFps) || Math.abs(expectedFps - actualFps) > 0.001
    || closedFileProbe.videoCodec !== plan.expected.videoCodec || closedFileProbe.audioCodec !== plan.expected.audioCodec
    || !rawProbe.format?.format_name?.split(',').includes(plan.expected.container)
    || Math.abs(closedFileProbe.durationSeconds - plan.durationSeconds) > 1 / expectedFps
    || closedFileProbe.avDurationDeltaSeconds > 1 / expectedFps
    || (plan.sizeBudget && fileSize > plan.sizeBudget.maximumFileSizeBytes)) fail('E_FINAL_CLOSED_PROBE', 'closed final candidate failed the complete delivery contract');
  return closedFileProbe;
}

export async function executeFinalRenderPlan(plan, options = {}) {
  await mkdir(projectPath(plan.project, 'cache/render'), { recursive: true });
  await mkdir(projectPath(plan.project, 'renders'), { recursive: true });
  const partialPaths = [plan.final.candidatePath, ...plan.chapters.flatMap(({ renderPath, pendingSidecarPath }) => [renderPath, pendingSidecarPath])];
  const session = options.session ?? createRenderSession({ partialPaths, signal: options.signal });
  let hits = 0; let misses = 0;
  try {
    for (const source of plan.sourceChecks ?? []) if (await sha256File(source.sourcePath).catch(() => null) !== source.sourceDigest) fail('E_SOURCE_CHANGED', `original source changed for ${source.mediaId}`);
    if (plan.musicCheck && await sha256File(plan.musicCheck.sourcePath).catch(() => null) !== plan.musicCheck.sourceDigest) fail('E_MUSIC_CHANGED', 'approved local music changed before render');
    for (const chapter of plan.chapters) {
      if (await cachedChapterValid(chapter)) { hits += 1; continue; }
      misses += 1;
      for (const generated of chapter.generatedLayers ?? []) {
        const pending = `${generated.renderPath}.pending-${process.pid}`;
        await sharp(Buffer.from(generated.svg)).png().toFile(pending);
        await rename(pending, generated.renderPath);
      }
      for (const stabilization of chapter.stabilizationPasses ?? []) await runFfmpeg(stabilization.args, session);
      await runFfmpeg(chapter.args, session);
      const handle = await open(chapter.renderPath, 'r'); try { await handle.sync(); } finally { await handle.close(); }
      const probe = await ffprobeJson(chapter.renderPath);
      if (!probe.streams?.some(({ codec_type }) => codec_type === 'video') || !probe.streams?.some(({ codec_type }) => codec_type === 'audio')) fail('E_CHAPTER_CACHE', `chapter ${chapter.chapterId} did not close with audio and video`);
      const outputDigest = await sha256File(chapter.renderPath);
      await writeJsonAtomic(chapter.pendingSidecarPath, { schemaVersion: '1.0.0', chapterId: chapter.chapterId, cacheKey: chapter.cacheKey, outputDigest });
      await rename(chapter.renderPath, chapter.outputPath);
      await rename(chapter.pendingSidecarPath, chapter.sidecarPath);
    }
    if (plan.final.pass1Args) await runFfmpeg(plan.final.pass1Args, session);
    await runFfmpeg(plan.final.pass2Args, session);
    const handle = await open(plan.final.candidatePath, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    const rawProbe = await ffprobeJson(plan.final.candidatePath);
    const candidateStat = await stat(plan.final.candidatePath);
    const closedFileProbe = validateClosedDeliveryContract(plan, rawProbe, candidateStat.size);
    for (const source of plan.sourceChecks ?? []) if (await sha256File(source.sourcePath).catch(() => null) !== source.sourceDigest) fail('E_SOURCE_CHANGED', `original source changed during render for ${source.mediaId}`);
    if (plan.musicCheck && await sha256File(plan.musicCheck.sourcePath).catch(() => null) !== plan.musicCheck.sourceDigest) fail('E_MUSIC_CHANGED', 'approved local music changed during render');
    const outputDigest = await sha256File(plan.final.candidatePath);
    const provenance = {
      schemaVersion: '1.0.0', revision: 1, producerCommand: 'render_final.mjs', artifact: 'renders/final.mp4', outputDigest,
      closedFileProbe, raster: plan.raster, fps: plan.fps, lossyDeliveryEncodeCount: 1,
      chapterCache: await Promise.all(plan.chapters.map(async ({ chapterId, cacheKey, portablePath, outputPath }) => ({ chapterId, cacheKey, path: portablePath, outputDigest: await sha256File(outputPath) }))),
      originalSources: plan.originalSources, hyperFramesComposition: plan.hyperFramesComposition,
      integrity: { digest: null, upstream: plan.authority },
    };
    provenance.integrity.digest = computeArtifactDigest(provenance);
    const provenancePath = projectPath(plan.project, 'renders/final.provenance.json');
    const pendingProvenancePath = projectPath(plan.project, `renders/.final-render.${plan.transactionId}.provenance.pending.json`);
    await writeJsonAtomic(pendingProvenancePath, provenance);
    if (options.publish === false) {
      return { ok: true, transactionId: plan.transactionId, artifact: 'renders/final.mp4', outputDigest, closedFileProbe, provenance, cache: { hits, misses }, pending: { candidatePath: plan.final.candidatePath, provenancePath: pendingProvenancePath } };
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
