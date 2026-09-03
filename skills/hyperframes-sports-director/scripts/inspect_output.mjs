#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { buildPostLockWorkbench } from './lib/approval.mjs';
import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest, loadSchema, validateArtifact, validateDocument, verifyArtifactIntegrity } from './lib/contracts.mjs';
import { ffprobeJson, runCommand } from './lib/ffmpeg.mjs';
import { acquireRepairGuard, persistApprovedRepairWithGuard, releaseRepairGuard } from './lib/invalidation.mjs';
import { rectangleContains, rectanglesIntersect, sampleTrackedRect } from './lib/layout.mjs';
import { projectPath, sha256File, writeJsonAtomic } from './lib/media.mjs';
import {
  buildInspectionSchedule,
  commitDeliveredState,
  commitFinalQaState,
  commitInspectionBlockedState,
  evaluateMachineGates,
  measureLocalContrast,
  measureRenderedTokenColor,
  validateFinalPixelProof,
} from './lib/visual-qc.mjs';

function fail(code, message, details) { const error = new Error(message); error.code = code; error.details = details; throw error; }

async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function readOptionalText(path) { try { return await readFile(path, 'utf8'); } catch (cause) { if (cause.code === 'ENOENT') return null; throw cause; } }
async function writeTextAtomic(path, text) { const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`; await writeFile(temporary, text, { flag: 'wx' }); await rename(temporary, path); }

const INSPECTION_JOURNAL = 'cache/final-inspection.transaction.json';
const REVIEW_FILES = { metrics: 'review/metrics.json', pack: 'review/final-evidence.json', report: 'review/REVIEW_REPORT.md', page: 'review/final-evidence.html' };

export async function recoverInspectionTransaction(project, mutationGuard, dependencies = {}) {
  const path = projectPath(project, INSPECTION_JOURNAL); const journal = await readJson(path).catch((cause) => cause.code === 'ENOENT' ? null : Promise.reject(cause));
  if (!journal) return false;
  if (journal.kind !== 'final-inspection-transaction' || journal.integrity?.digest !== computeArtifactDigest(journal)
    || !verifyArtifactIntegrity(journal.previousState).valid || Object.keys(journal.previousFiles ?? {}).sort().join('\0') !== Object.keys(REVIEW_FILES).sort().join('\0')) fail('E_FINAL_QA_TRANSACTION', 'final inspection recovery journal is invalid');
  await writeJsonAtomic(projectPath(project, 'PROJECT_STATE.json'), journal.previousState);
  for (const [role, portablePath] of Object.entries(REVIEW_FILES)) {
    const prior = journal.previousFiles[role]; const target = projectPath(project, portablePath);
    if (prior === null) await unlink(target).catch((cause) => { if (cause.code !== 'ENOENT') throw cause; }); else await writeTextAtomic(target, prior);
  }
  await (dependencies.rebuildWorkbench ?? buildPostLockWorkbench)(project, { mutationGuard });
  await unlink(path); return true;
}

async function current(project, path, schema) {
  const result = await validateArtifact(projectPath(project, path), schema);
  if (!result.valid) fail('E_INSPECTION_AUTHORITY', `${path} is not current`, result.errors);
  return result.value;
}

function totalMatches(text, pattern) {
  return [...text.matchAll(pattern)].reduce((total, match) => total + Number(match[1]), 0);
}

export async function analyzeEncodedMp4(path, provenance, dependencies = {}) {
  const probe = await (dependencies.ffprobe ?? ffprobeJson)(path);
  const video = probe.streams?.find(({ codec_type }) => codec_type === 'video');
  const audio = probe.streams?.find(({ codec_type }) => codec_type === 'audio');
  const duration = Number(probe.format?.duration);
  const videoDuration = Number(video?.duration ?? duration); const audioDuration = Number(audio?.duration ?? duration);
  const run = dependencies.runCommand ?? runCommand;
  const [black, freeze, audioStats, identitySsim] = await Promise.all([
    run('ffmpeg', ['-hide_banner', '-nostdin', '-i', path, '-vf', 'blackdetect=d=0.1:pix_th=0.1', '-an', '-f', 'null', '-']),
    run('ffmpeg', ['-hide_banner', '-nostdin', '-i', path, '-vf', 'freezedetect=n=-60dB:d=0.5', '-an', '-f', 'null', '-']),
    run('ffmpeg', ['-hide_banner', '-nostdin', '-i', path, '-af', 'ebur128=peak=true,astats=metadata=1:reset=0', '-vn', '-f', 'null', '-']),
    measureControlledSsim(path, provenance, dependencies),
  ]);
  const integrated = [...audioStats.stderr.matchAll(/\bI:\s*(-?\d+(?:\.\d+)?)\s*LUFS/g)].at(-1);
  const peaks = [...audioStats.stderr.matchAll(/Peak level dB:\s*(-?\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  const fpsParts = String(video?.avg_frame_rate ?? provenance.fps ?? '24/1').split('/').map(Number);
  const expected = provenance.closedFileProbe ?? {};
  const delivery = dependencies.editBrief?.delivery ?? {};
  const requestedVideoCodec = { h264: 'h264', h265: 'hevc' }[delivery.videoCodec] ?? delivery.videoCodec;
  const fileSize = await stat(path).then(({ size }) => size);
  const actualFps = fpsParts[0] / fpsParts[1]; const expectedParts = String(provenance.fps ?? expected.frameRate ?? '0/1').split('/').map(Number);
  const expectedFps = expectedParts[0] / expectedParts[1];
  const closedProbe = {
    valid: Boolean(video && audio && duration > 0 && await sha256File(path) === provenance.outputDigest
      && video.width === provenance.raster?.width && video.height === provenance.raster?.height
      && ['1:1', '1/1'].includes(video.sample_aspect_ratio)
      && Number.isFinite(actualFps) && Number.isFinite(expectedFps) && Math.abs(actualFps - expectedFps) <= 0.001
      && video.codec_name === expected.videoCodec && audio.codec_name === expected.audioCodec
      && video.codec_name === requestedVideoCodec && audio.codec_name === delivery.audioCodec && video.pix_fmt === 'yuv420p'
      && video.width === delivery.width && video.height === delivery.height && delivery.aspectRatio === '16:9'
      && probe.format?.format_name?.split(',').includes(delivery.container)
      && Math.abs(duration - expected.durationSeconds) <= 1 / expectedFps
      && duration >= dependencies.editBrief.duration.minSeconds && duration <= dependencies.editBrief.duration.maxSeconds
      && (delivery.maximumFileSizeBytes === null || delivery.maximumFileSizeBytes === undefined || fileSize <= delivery.maximumFileSizeBytes)),
    width: video?.width ?? null, height: video?.height ?? null, durationSeconds: duration, pixelFormat: video?.pix_fmt ?? null, fileSizeBytes: fileSize,
  };
  const usedMediaIds = new Set(dependencies.usedMediaIds ?? []);
  const sourceColorDeclared = (dependencies.probe?.media ?? []).filter(({ mediaId, mediaType }) => mediaType === 'video' && usedMediaIds.has(mediaId)).every(({ streams }) => streams.filter(({ type }) => type === 'video')
    .every(({ colorSpace, colorPrimaries, colorTransfer }) => [colorSpace, colorPrimaries, colorTransfer].every((value) => typeof value === 'string' && value !== 'unknown')));
  return {
    closedProbe,
    blackFramesSeconds: totalMatches(black.stderr, /black_duration:(\d+(?:\.\d+)?)/g),
    freezeSpansSeconds: totalMatches(freeze.stderr, /freeze_duration:\s*(\d+(?:\.\d+)?)/g),
    clippedSamples: peaks.some((value) => value >= -0.01) ? 1 : 0,
    integratedLufs: integrated ? Number(integrated[1]) : null,
    avDriftSeconds: Math.abs(videoDuration - audioDuration),
    frameDurationSeconds: fpsParts[1] / fpsParts[0],
    identitySsim,
    inputColorDeclared: sourceColorDeclared && video?.color_space === 'bt709' && video?.color_primaries === 'bt709' && video?.color_transfer === 'bt709',
    contrast: [], tokenColor: [], layoutCollisions: [], quietZoneLosses: [], crossSceneConsistency: { pass: false, reason: 'final-pixel evidence unavailable' },
  };
}

export async function measureControlledSsim(finalPath, provenance, dependencies = {}) {
  const project = dependencies.project;
  if (!project || !Array.isArray(provenance.chapterCache) || provenance.chapterCache.length === 0) return null;
  const references = [];
  for (const chapter of provenance.chapterCache) {
    const reference = projectPath(project, chapter.path);
    const sidecar = await readJson(`${reference}.json`).catch(() => null);
    if (!sidecar || sidecar.cacheKey !== chapter.cacheKey || sidecar.outputDigest !== chapter.outputDigest || sidecar.outputDigest !== await sha256File(reference).catch(() => null)) return null;
    references.push(reference);
  }
  const args = ['-hide_banner', '-nostdin', '-i', finalPath, ...references.flatMap((reference) => ['-i', reference])];
  const labels = references.map((_, index) => `[${index + 1}:v]`).join('');
  const referenceFilter = references.length === 1 ? '[1:v]setpts=PTS-STARTPTS,format=yuv420p[identity]' : `${labels}concat=n=${references.length}:v=1:a=0,format=yuv420p[identity]`;
  args.push('-filter_complex', `${referenceFilter};[0:v]setpts=PTS-STARTPTS,format=yuv420p[encoded];[encoded][identity]ssim`, '-an', '-f', 'null', '-');
  const result = await (dependencies.runCommand ?? runCommand)('ffmpeg', args);
  const matches = [...result.stderr.matchAll(/\bAll:([0-9]+(?:\.[0-9]+)?)/g)];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

function parseHex(value) { return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)); }
function pixel(image, index) { const offset = index * image.info.channels; return [...image.data.subarray(offset, offset + image.info.channels)]; }
async function loadProofImage(project, reference) {
  const path = projectPath(project, reference.path);
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) fail('E_FINAL_PIXEL_PROOF', `${reference.path} must be a regular local proof-pass file`);
  if (await sha256File(path).catch(() => null) !== reference.digest) fail('E_FINAL_PIXEL_PROOF', `${reference.path} failed its content digest`);
  return sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
function compatible(...images) { return images.every(({ info }) => info.width === images[0].info.width && info.height === images[0].info.height && info.channels === 4); }
function sampledPixels(composite, background, matte, time, alpha = null) {
  if (!compatible(composite, background, matte)) fail('E_FINAL_PIXEL_PROOF', 'composite, background, and matte pass dimensions must match');
  const count = composite.info.width * composite.info.height; let eligible = 0;
  for (let index = 0; index < count; index += 1) if (pixel(matte, index)[0] >= 230) eligible += 1;
  const stride = Math.max(1, Math.ceil(eligible / 4096)); const samples = []; let seen = 0;
  for (let index = 0; index < count; index += 1) {
    const coverage = pixel(matte, index)[0] / 255;
    if (coverage >= .9) { if (seen % stride === 0) samples.push({ time, composite: pixel(composite, index), background: pixel(background, index), matte: pixel(matte, index), alpha: alpha ?? coverage }); seen += 1; }
  }
  return samples;
}
function matteBounds(matte) {
  let left = matte.info.width; let top = matte.info.height; let right = -1; let bottom = -1;
  const count = matte.info.width * matte.info.height;
  for (let index = 0; index < count; index += 1) if (pixel(matte, index)[0] >= 26) {
    const x = index % matte.info.width; const y = Math.floor(index / matte.info.width);
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return right < left ? null : { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
function averageLuminance(image) {
  let total = 0; const count = image.info.width * image.info.height; const step = Math.max(1, Math.floor(count / 4096)); let samples = 0;
  for (let index = 0; index < count; index += step) { const [r, g, b] = pixel(image, index); total += (.2126 * r) + (.7152 * g) + (.0722 * b); samples += 1; }
  return total / samples;
}
function averageDifference(left, right) {
  if (!compatible(left, right)) return Number.POSITIVE_INFINITY;
  const count = left.info.width * left.info.height; const step = Math.max(1, Math.floor(count / 4096)); let total = 0; let samples = 0;
  for (let index = 0; index < count; index += step) { const a = pixel(left, index); const b = pixel(right, index); total += Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]); samples += 3; }
  return total / samples;
}

function sourceTimeForDestination(item, destinationTime) {
  const curve = item.playbackRateCurve?.length > 1 ? item.playbackRateCurve : [
    { sourceTimeSeconds: item.sourceInSeconds, rate: item.playbackRate },
    { sourceTimeSeconds: item.sourceOutSeconds, rate: item.playbackRate },
  ];
  let remaining = Math.max(0, destinationTime - item.destinationInSeconds);
  for (let index = 0; index < curve.length - 1; index += 1) {
    const span = (curve[index + 1].sourceTimeSeconds - curve[index].sourceTimeSeconds) / curve[index].rate;
    if (remaining <= span) return curve[index].sourceTimeSeconds + (remaining * curve[index].rate);
    remaining -= span;
  }
  return curve.at(-1).sourceTimeSeconds;
}

export async function measureProofPasses({ project, proof, schedule, compositePaths, documents }) {
  const readable = new Map(documents.sceneSchema.scenes.flatMap((scene) => scene.readableLayers.map((layer) => [layer.layerId, layer])));
  const layerSamples = new Map(); const tokenSamples = new Map(); const layoutCollisions = []; const quietZoneLosses = [];
  const frameStats = []; let previous = null;
  for (const [frameIndex, frame] of proof.frames.entries()) {
    const composite = await sharp(projectPath(project, compositePaths[frameIndex])).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const background = await loadProofImage(project, frame.backgroundPass);
    if (!compatible(composite, background)) fail('E_FINAL_PIXEL_PROOF', 'decoded final frame and background pass dimensions must match');
    frameStats.push({ time: schedule[frameIndex].time, luminance: averageLuminance(background), motion: previous ? averageDifference(previous, composite) : 0,
      readable: (schedule[frameIndex].targets ?? []).some(({ layerId, overlayId }) => layerId || overlayId) }); previous = composite;
    for (const reference of frame.layerMattes) {
      const matte = await loadProofImage(project, reference); const samples = sampledPixels(composite, background, matte, frame.time);
      const layer = readable.get(reference.layerId); const list = layerSamples.get(reference.layerId) ?? { layerId: reference.layerId, kind: /(?:title|metric)/i.test(layer?.typographyRole ?? '') ? 'critical-text' : /large/i.test(layer?.typographyRole ?? '') ? 'large-text' : layer?.typographyRole ? 'ordinary-text' : 'meaningful-graphic', samples: [] };
      list.samples.push(...samples); layerSamples.set(reference.layerId, list);
      if (layer) {
        const bounds = matteBounds(matte); const subject = sampleTrackedRect(layer.subjectRect, frame.time); const quiet = sampleTrackedRect(layer.quietZone, frame.time);
        if (bounds && subject && rectanglesIntersect(bounds, subject)) layoutCollisions.push({ layerId: reference.layerId, time: frame.time });
        if (bounds && quiet && !rectangleContains(quiet, bounds)) quietZoneLosses.push({ layerId: reference.layerId, time: frame.time });
      }
    }
    for (const reference of frame.tokenMattes) {
      const matte = await loadProofImage(project, reference); const list = tokenSamples.get(reference.tokenName) ?? { tokenName: reference.tokenName, samples: [] };
      list.samples.push(...sampledPixels(composite, background, matte, frame.time, reference.alpha)); tokenSamples.set(reference.tokenName, list);
    }
  }
  const readableStats = frameStats.filter(({ readable }) => readable); const extremaStats = readableStats.length ? readableStats : frameStats;
  const lowest = extremaStats.reduce((best, frame) => frame.luminance < best.luminance ? frame : best, extremaStats[0]);
  const highest = extremaStats.reduce((best, frame) => frame.motion > best.motion ? frame : best, extremaStats[0]);
  const contrast = [...layerSamples.values()].map((layer) => ({ layerId: layer.layerId, ...measureLocalContrast(layer) }));
  const tokenColor = [...tokenSamples.values()].map((entry) => ({ token: entry.tokenName, ...measureRenderedTokenColor({ ...entry, token: parseHex(documents.designSystem.tokens.colors[entry.tokenName]) }) }));
  const typographyValid = [...readable.values()].every(({ typographyRole }) => documents.designSystem.tokens.typography?.[typographyRole]);
  return { contrast, tokenColor, layoutCollisions, quietZoneLosses, crossSceneConsistency: { pass: typographyValid && tokenColor.every(({ pass }) => pass) }, motionExtrema: [highest.time], luminanceExtrema: [lowest.time] };
}

async function buildReviewPack({ project, schedule, evidencePaths, timeline, segments, assetManifest, provenance }, dependencies = {}) {
  if (evidencePaths.length === 0) fail('E_FINAL_EVIDENCE', 'final inspection requires semantic or extrema evidence frames');
  const contactSheetPath = `${dirname(evidencePaths[0])}/contact-sheet.png`;
  const existingContact = await lstat(projectPath(project, contactSheetPath)).catch(() => null);
  if (existingContact?.isSymbolicLink() || (existingContact && !existingContact.isFile())) fail('E_FINAL_EVIDENCE', 'contact sheet target is not an owned regular file');
  const step = Math.max(1, Math.ceil(evidencePaths.length / 36));
  await (dependencies.buildContactSheet ?? (async () => runCommand('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-framerate', '1', '-pattern_type', 'glob',
    '-i', `${dirname(projectPath(project, evidencePaths[0]))}/frame-*.png`, '-vf', `select='not(mod(n\,${step}))',scale=320:-2,tile=6x6:padding=2:margin=2`,
    '-frames:v', '1', projectPath(project, contactSheetPath),
  ])))();
  const segmentByMedia = Map.groupBy(segments.segments, ({ mediaId }) => mediaId);
  const comparisons = [];
  for (const [index, sample] of schedule.entries()) {
    if (!(sample.targets ?? []).some(({ layerId }) => layerId)) continue;
    const item = timeline.items.find(({ destinationInSeconds, destinationOutSeconds }) => sample.time >= destinationInSeconds && sample.time <= destinationOutSeconds);
    if (!item) continue;
    const sourceTime = sourceTimeForDestination(item, sample.time);
    const source = (segmentByMedia.get(item.sourceMediaId) ?? []).flatMap(({ evidenceFrames }) => evidenceFrames)
      .sort((left, right) => Math.abs(left.sourceTimeSeconds - sourceTime) - Math.abs(right.sourceTimeSeconds - sourceTime))[0];
    if (source) comparisons.push({ sourcePath: source.path, sourceDigest: await sha256File(projectPath(project, source.path)), finalPath: evidencePaths[index], finalTimeSeconds: sample.time });
  }
  const alphaProofs = [...new Map(assetManifest.assets.flatMap(({ proofs }) => Object.values(proofs ?? {}).map(({ path, digest }) => [path, { path, digest }]))).values()];
  const combinationProofs = [...new Map(assetManifest.assets.flatMap(({ combinationTests }) => combinationTests ?? [])
    .filter(({ status }) => status === 'accepted').map((entry) => [entry.id, { proofId: entry.id, path: entry.path, digest: entry.digest, semanticIntent: entry.semanticIntent }])).values()];
  if (new Set(combinationProofs.map(({ semanticIntent }) => semanticIntent)).size < 2) fail('E_FINAL_EVIDENCE', 'final review requires two semantically different accepted combination proofs');
  for (const entry of [...alphaProofs, ...combinationProofs]) {
    if (await sha256File(projectPath(project, entry.path)).catch(() => null) !== entry.digest) fail('E_FINAL_EVIDENCE', `${entry.path} is stale or missing`);
  }
  const frameEvidence = await Promise.all(evidencePaths.map(async (path, index) => ({ path, digest: await sha256File(projectPath(project, path)), ...schedule[index] })));
  const pack = {
    schemaVersion: '1.0.0', revision: 1, encodedMp4Digest: provenance.outputDigest,
    finalFrames: frameEvidence, contactSheet: { path: contactSheetPath, digest: await sha256File(projectPath(project, contactSheetPath)) },
    clarityComparisons: comparisons, alphaProofs, combinationProofs,
    metricEvidence: { contrast: 'review/metrics.json#local_contrast', tokenColor: 'review/metrics.json#token_color' },
    integrity: { digest: null, upstream: { FINAL_RENDER: provenance.integrity.digest, assetManifest: assetManifest.integrity.digest, segments: segments.integrity.digest, timeline: timeline.integrity.digest } },
  };
  const relativeReviewPath = (path) => path.startsWith('review/') ? path.slice('review/'.length) : `../${path}`;
  const image = (path, alt) => `<img src="${relativeReviewPath(path).replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" alt="${alt}">`;
  const page = `<!doctype html><meta charset="utf-8"><title>Final MP4 evidence</title><style>body{margin:0;background:#050505;color:#f5f2ea;font:14px system-ui;padding:24px}h1,h2{font-weight:600}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}figure{margin:0;background:#141414;padding:12px}img{display:block;width:100%;height:auto}figcaption{margin-top:8px;color:#a8a29a}</style><h1>Final MP4 evidence</h1><h2>Summary contact sheet</h2>${image(contactSheetPath, 'Decoded final MP4 contact sheet')}<h2>Source / final clarity comparisons</h2><div class="grid">${comparisons.map((entry) => `<figure>${image(entry.sourcePath, 'Review-safe source crop')}<figcaption>Source derivative</figcaption></figure><figure>${image(entry.finalPath, 'Decoded final MP4 frame')}<figcaption>Final at ${entry.finalTimeSeconds.toFixed(3)}s</figcaption></figure>`).join('')}</div><h2>Alpha proofs</h2><div class="grid">${alphaProofs.map(({ path }) => `<figure>${image(path, 'Alpha proof')}</figure>`).join('')}</div><h2>Combination proofs</h2><div class="grid">${combinationProofs.map(({ path, semanticIntent }) => `<figure>${image(path, 'Accepted combination proof')}<figcaption>${String(semanticIntent).replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</figcaption></figure>`).join('')}</div>`;
  const reviewPagePath = 'review/final-evidence.html';
  pack.reviewPage = { path: reviewPagePath, digest: createHash('sha256').update(page).digest('hex') };
  pack.integrity.digest = computeArtifactDigest(pack);
  return { pack, page };
}

function report(metrics, gates, reviewPack) {
  const lines = ['# Review Report', '', `Status: ${metrics.status}`, '', '## Encoded output', '', `- Digest: ${metrics.encodedMp4Digest}`, '', '## Machine gates', ''];
  if (gates.pass) lines.push('- PASS');
  else lines.push(...gates.failures.map(({ code }) => `- FAIL: ${code}`));
  lines.push('', '## Agent inspection', '', `- ${metrics.agentInspection.status}`);
  for (const path of metrics.agentInspection.evidencePaths) lines.push(`- ${path}`);
  for (const judgment of metrics.agentInspection.judgments ?? []) lines.push(`- ${judgment.category}: ${judgment.status} (${judgment.evidencePaths.join(', ')})`);
  lines.push('', '## Review pack', '', `- ${reviewPack.reviewPage.path}`, `- ${reviewPack.contactSheet.path}`, `- ${reviewPack.clarityComparisons.length} source/final clarity comparisons`, `- ${reviewPack.alphaProofs.length} alpha proofs`, `- ${reviewPack.combinationProofs.length} accepted combination proofs`);
  return `${lines.join('\n')}\n`;
}

const AGENT_CATEGORIES = ['composition', 'density', 'restraint', 'pacing', 'style-anchor-consistency', 'transition-meaning'];

function validateAgentInspection(agentInspection) {
  if (!agentInspection || !['unavailable', 'accepted', 'rejected'].includes(agentInspection.status) || !Array.isArray(agentInspection.evidencePaths)) fail('E_AGENT_INSPECTION', 'Agent inspection requires an explicit status and evidence path array');
  const judgments = agentInspection.judgments ?? [];
  if (agentInspection.status !== 'unavailable' && (!Array.isArray(judgments) || judgments.length !== AGENT_CATEGORIES.length
    || new Set(judgments.map(({ category }) => category)).size !== AGENT_CATEGORIES.length
    || judgments.some(({ category, status, evidencePaths }) => !AGENT_CATEGORIES.includes(category) || !['accepted', 'rejected'].includes(status) || !Array.isArray(evidencePaths) || evidencePaths.length === 0)
    || (agentInspection.status === 'accepted' && judgments.some(({ status }) => status !== 'accepted'))
    || (agentInspection.status === 'rejected' && judgments.every(({ status }) => status !== 'rejected')))) fail('E_AGENT_INSPECTION', 'Agent inspection must record all six decoded-MP4 judgments');
  return { status: agentInspection.status, evidencePaths: agentInspection.evidencePaths, judgments };
}

async function inspectOutputInternal({ project, timestamp = new Date().toISOString(), agentInspection = { status: 'unavailable', evidencePaths: [], judgments: [] }, proof = null, repair = null }, dependencies = {}) {
  if (!dependencies.mutationGuard) {
    const mutationGuard = await acquireRepairGuard(project, dependencies.guardHooks);
    try {
      const guarded = { ...dependencies, mutationGuard };
      await recoverInspectionTransaction(project, mutationGuard, guarded);
      return await inspectOutputInternal({ project, timestamp, agentInspection, proof, repair }, guarded);
    }
    finally { await releaseRepairGuard(project, mutationGuard); }
  }
  agentInspection = validateAgentInspection(agentInspection);
  const [projectState, sceneSchema, motionMap, timeline, designSystem, lookProfile, assetManifest, segments, editBrief, probe, dataOverlays, activity, syncMap] = await Promise.all([
    current(project, 'PROJECT_STATE.json', 'project-state'), current(project, 'direction/SCENE_SCHEMA.json', 'scene-schema'),
    current(project, 'direction/MOTION_MAP.json', 'motion-map'), current(project, 'edit/TIMELINE.json', 'timeline'),
    current(project, 'direction/DESIGN_SYSTEM.json', 'design-system'), current(project, 'direction/LOOK_PROFILE.json', 'look-profile'), current(project, 'direction/ASSET_MANIFEST.json', 'asset-manifest'),
    current(project, 'analysis/SEGMENTS.json', 'segments'),
    current(project, 'EDIT_BRIEF.json', 'edit-brief'), current(project, 'analysis/PROBE.json', 'probe'), current(project, 'direction/DATA_OVERLAYS.json', 'data-overlays'),
    current(project, 'analysis/ACTIVITY.json', 'activity'), current(project, 'analysis/SYNC_MAP.json', 'sync-map'),
  ]);
  if (!['FINAL_RENDER', 'FINAL_QA'].includes(projectState.state)) fail('E_FINAL_QA_STATE', 'inspection starts from FINAL_RENDER or resumes at FINAL_QA');
  if (projectState.state === 'FINAL_RENDER' && agentInspection.status !== 'unavailable') fail('E_AGENT_INSPECTION', 'machine inspection must enter FINAL_QA before Agent review');
  if (projectState.state === 'FINAL_QA' && agentInspection.status === 'unavailable') fail('E_AGENT_INSPECTION', 'resuming FINAL_QA requires an explicit Agent decision');
  const finalPath = projectPath(project, 'renders/final.mp4');
  const provenance = await readJson(projectPath(project, 'renders/final.provenance.json'));
  if (!verifyArtifactIntegrity(provenance).valid || provenance.artifact !== 'renders/final.mp4') fail('E_FINAL_PROVENANCE', 'render provenance is not integrity-valid');
  const finalEvidence = projectState.gateEvidence.findLast(({ gate, role, validity }) => gate === 'FINAL_RENDER' && role === 'FINAL_RENDER' && validity === 'valid');
  const requiredUpstream = { timeline: timeline.integrity.digest, sceneSchema: sceneSchema.integrity.digest, motionMap: motionMap.integrity.digest,
    designSystem: designSystem.integrity.digest, lookProfile: lookProfile.integrity.digest, assetManifest: assetManifest.integrity.digest,
    editBrief: editBrief.integrity.digest, probe: probe.integrity.digest };
  if (finalEvidence?.digest !== provenance.integrity.digest || Object.entries(requiredUpstream).some(([role, digest]) => provenance.integrity.upstream[role] !== digest)
    || timeline.dataOverlaysDigest !== dataOverlays.integrity.digest || dataOverlays.integrity.upstream?.activity !== activity.integrity.digest
    || dataOverlays.integrity.upstream?.syncMap !== syncMap.integrity.digest || lookProfile.output?.colorSpace !== 'rec709-sdr') {
    fail('E_FINAL_PROVENANCE', 'render provenance is stale against current final authority');
  }
  const transitions = (timeline.items ?? []).map(({ transition }) => transition).filter(({ kind }) => kind !== 'none').map(({ ownerId }) => {
    const owner = motionMap.owners.find((entry) => entry.ownerId === ownerId); return owner?.transition ? { ...owner.transition, sceneId: owner.sceneId, layerId: owner.layerId } : null;
  }).filter(Boolean);
  const documents = { sceneSchema, motionMap, designSystem, lookProfile, assetManifest, timeline, dataOverlays, finalRenderDigest: provenance.integrity.digest };
  const schedule = buildInspectionSchedule({ scenes: sceneSchema.scenes, owners: motionMap.owners, overlays: dataOverlays.overlays, transitions });
  if (schedule.length === 0) fail('E_FINAL_EVIDENCE', 'final inspection schedule is empty');
  if (proof) validateFinalPixelProof(proof, { encodedMp4Digest: provenance.outputDigest, documents, schedule });
  const frameRoot = `review/final-frames/${provenance.outputDigest}`;
  await mkdir(projectPath(project, frameRoot), { recursive: true });
  const frameRootMetadata = await lstat(projectPath(project, frameRoot));
  if (!frameRootMetadata.isDirectory() || frameRootMetadata.isSymbolicLink()) fail('E_FINAL_EVIDENCE', 'final frame directory must be a local directory');
  const extract = dependencies.extractFrame ?? (async (time, output) => runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-ss', String(time), '-i', finalPath, '-frames:v', '1', output]));
  const compositePaths = [];
  for (let index = 0; index < schedule.length; index += 1) {
    const portable = `${frameRoot}/frame-${String(index).padStart(5, '0')}.png`;
    const existing = await lstat(projectPath(project, portable)).catch(() => null);
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) fail('E_FINAL_EVIDENCE', `${portable} is not an owned regular evidence file`);
    await extract(schedule[index].time, projectPath(project, portable)); compositePaths.push(portable);
  }
  const compositeDigests = new Map(await Promise.all(compositePaths.map(async (path) => [path, await sha256File(projectPath(project, path))])));
  const analyzed = await (dependencies.analyze ?? analyzeEncodedMp4)(finalPath, provenance, { ...dependencies, project, editBrief, probe, usedMediaIds: timeline.items.map(({ sourceMediaId }) => sourceMediaId) });
  const pixelProof = proof ? await measureProofPasses({ project, proof, schedule, compositePaths, documents }) : { contrast: [], tokenColor: [], layoutCollisions: null, quietZoneLosses: null, crossSceneConsistency: { pass: false, reason: 'final proof passes unavailable' }, motionExtrema: [], luminanceExtrema: [] };
  const evidenceIndexes = schedule.map((sample, index) => ({ sample, index })).filter(({ sample }) => sample.reasons.some((reason) => !['readable-10hz', 'visible-layer-10hz', 'overlay-10hz'].includes(reason))
    || pixelProof.motionExtrema.includes(sample.time) || pixelProof.luminanceExtrema.includes(sample.time));
  const evidenceSchedule = evidenceIndexes.map(({ sample }) => sample); const evidencePaths = evidenceIndexes.map(({ index }) => compositePaths[index]);
  const { pack: reviewPack, page: reviewPage } = await buildReviewPack({ project, schedule: evidenceSchedule, evidencePaths, timeline, segments, assetManifest, provenance }, dependencies);
  const measurements = { ...analyzed, ...pixelProof };
  const gates = evaluateMachineGates(measurements, { frameDurationSeconds: analyzed.frameDurationSeconds, loudness: { minimumLufs: -20, maximumLufs: -10 }, minimumIdentitySsim: .95 });
  const citedEvidence = [...agentInspection.evidencePaths, ...agentInspection.judgments.flatMap((judgment) => judgment.evidencePaths)];
  const finalEvidencePaths = new Set([...evidencePaths, reviewPack.contactSheet.path]);
  if (agentInspection.status !== 'unavailable' && (citedEvidence.length === 0 || !citedEvidence.every((path) => finalEvidencePaths.has(path)))) fail('E_AGENT_EVIDENCE', 'Agent inspection must cite decoded final-MP4 evidence');
  const priorMetrics = await readJson(projectPath(project, 'review/metrics.json')).catch(() => null);
  const metrics = {
    $schema: 'https://hyperframes.local/schemas/review-metrics.schema.json', schemaVersion: '1.0.0', revision: Number.isInteger(priorMetrics?.revision) ? priorMetrics.revision + 1 : 1,
    status: !gates.pass || agentInspection.status === 'rejected' ? 'rejected' : agentInspection.status === 'accepted' ? 'accepted' : 'measured',
    encodedMp4Digest: provenance.outputDigest,
    metrics: [
      ['closed_file_probe', measurements.closedProbe], ['black_frames', measurements.blackFramesSeconds], ['freeze_spans', measurements.freezeSpansSeconds],
      ['audio_clipping', measurements.clippedSamples], ['loudness', measurements.integratedLufs], ['av_drift', measurements.avDriftSeconds],
      ['detail_loss', measurements.identitySsim], ['input_color_profile', measurements.inputColorDeclared], ['local_contrast', measurements.contrast],
      ['token_color', measurements.tokenColor], ['layout_collision', measurements.layoutCollisions], ['quiet_zone_loss', measurements.quietZoneLosses],
      ['cross_scene_consistency', measurements.crossSceneConsistency],
    ].map(([metricId, value]) => ({ metricId, status: gates.failures.some(({ code }) => code === metricId) ? 'fail' : 'pass', value })),
    agentInspection: { status: gates.pass ? agentInspection.status : 'unavailable', evidencePaths: gates.pass ? agentInspection.evidencePaths : [], judgments: gates.pass ? agentInspection.judgments : [] },
    integrity: { digest: null, upstream: { FINAL_RENDER: provenance.integrity.digest } },
  };
  metrics.integrity.digest = computeArtifactDigest(metrics);
  if (!gates.pass && repair) {
    if (typeof repair.reason !== 'string' || !repair.reason || repair.gate !== gates.failures[0].code || !repair.change
      || !repair.beforeDigests || !repair.afterDigests) fail('E_REPAIR_REQUEST', 'repair must target the first failing gate with change, reason, and before/after digests');
    const repaired = await persistApprovedRepairWithGuard(project, repair.change, { gate: repair.gate, reason: repair.reason, timestamp,
      beforeDigests: repair.beforeDigests, afterDigests: repair.afterDigests }, dependencies.mutationGuard);
    if (repaired.allowed) {
      await (dependencies.rebuildWorkbench ?? buildPostLockWorkbench)(project, { mutationGuard: dependencies.mutationGuard });
      return { ok: false, state: repaired.projectState.state, repair: { code: repaired.code, attempt: repaired.repair.attempt, rerunRoles: repaired.repair.invalidatedRoles }, gates, schedule, evidencePaths };
    }
    if (repaired.projectState?.state === 'BLOCKED') {
      await (dependencies.rebuildWorkbench ?? buildPostLockWorkbench)(project, { mutationGuard: dependencies.mutationGuard });
      return { ok: false, state: 'BLOCKED', repair: { code: repaired.code, attempt: repaired.repair?.attempt ?? null, rerunRoles: [] }, gates, schedule, evidencePaths };
    }
  }
  const next = !gates.pass || agentInspection.status === 'rejected' ? commitInspectionBlockedState(projectState, metrics, timestamp)
    : agentInspection.status === 'accepted'
      ? commitDeliveredState(projectState, metrics, timestamp)
      : commitFinalQaState(projectState, metrics, timestamp);
  const [metricsContract, stateContract] = await Promise.all([loadSchema('review-metrics'), loadSchema('project-state')]).then(([metricsSchema, stateSchema]) => [validateDocument(metricsSchema, metrics), validateDocument(stateSchema, next)]);
  if (!metricsContract.valid || !stateContract.valid) fail('E_FINAL_QA_CONTRACT', 'inspection output violates a closed contract', [...metricsContract.errors, ...stateContract.errors]);
  const proofReferences = proof ? proof.frames.flatMap(({ backgroundPass, layerMattes, tokenMattes }) => [backgroundPass, ...layerMattes, ...tokenMattes]) : [];
  const assertInputsCurrent = async () => {
    if (await sha256File(finalPath) !== provenance.outputDigest
      || (await Promise.all([...compositeDigests].map(async ([path, digest]) => await sha256File(projectPath(project, path)) === digest))).some((valid) => !valid)
      || (await Promise.all(proofReferences.map(async ({ path, digest }) => await sha256File(projectPath(project, path)) === digest))).some((valid) => !valid)) fail('E_FINAL_CHANGED', 'final MP4 or proof-pass evidence changed during inspection');
  };
  await assertInputsCurrent();
  const previousFiles = Object.fromEntries(await Promise.all(Object.entries(REVIEW_FILES).map(async ([role, portablePath]) => [role, await readOptionalText(projectPath(project, portablePath))])));
  const journal = { kind: 'final-inspection-transaction', schemaVersion: '1.0.0', previousState: projectState, previousFiles,
    next: { stateDigest: next.integrity.digest, metricsDigest: metrics.integrity.digest, packDigest: reviewPack.integrity.digest, pageDigest: reviewPack.reviewPage.digest }, integrity: { digest: null, upstream: { FINAL_RENDER: provenance.integrity.digest } } };
  journal.integrity.digest = computeArtifactDigest(journal); await writeJsonAtomic(projectPath(project, INSPECTION_JOURNAL), journal);
  try {
    await writeJsonAtomic(projectPath(project, REVIEW_FILES.metrics), metrics);
    await writeJsonAtomic(projectPath(project, REVIEW_FILES.pack), reviewPack);
    await writeTextAtomic(projectPath(project, REVIEW_FILES.report), report(metrics, gates, reviewPack));
    await writeTextAtomic(projectPath(project, REVIEW_FILES.page), reviewPage);
    await assertInputsCurrent();
    await writeJsonAtomic(projectPath(project, 'PROJECT_STATE.json'), next);
    await assertInputsCurrent();
    await (dependencies.rebuildWorkbench ?? buildPostLockWorkbench)(project, { mutationGuard: dependencies.mutationGuard });
    await unlink(projectPath(project, INSPECTION_JOURNAL));
  } catch (cause) { await recoverInspectionTransaction(project, dependencies.mutationGuard, dependencies); throw cause; }
  return { ok: gates.pass && agentInspection.status !== 'rejected', state: next?.state ?? 'FINAL_QA', metrics, gates, schedule, evidencePaths, reviewPack };
}

export async function inspectOutput(options) { return inspectOutputInternal(options); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCliArguments(process.argv.slice(2), { project: { required: true }, proof: { key: 'proofPath', required: false }, repair: { key: 'repairPath', required: false }, 'agent-inspection': { key: 'agentInspectionPath', required: false }, timestamp: { required: false } });
    if (options.proofPath) options.proof = await readJson(options.proofPath);
    if (options.repairPath) options.repair = await readJson(options.repairPath);
    if (options.agentInspectionPath) options.agentInspection = await readJson(options.agentInspectionPath);
    process.stdout.write(`${JSON.stringify(await inspectOutput(options))}\n`);
  } catch (error) { process.stdout.write(`${JSON.stringify(errorResult(error))}\n`); process.exitCode = 1; }
}
