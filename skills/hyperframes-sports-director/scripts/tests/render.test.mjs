import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import sharp from 'sharp';

import { computeArtifactDigest } from '../lib/contracts.mjs';
import { ffprobeJson, runFfmpeg } from '../lib/ffmpeg.mjs';
import { sha256File } from '../lib/media.mjs';
import {
  compileFinalRenderPlan,
  commitFinalRenderState,
  createRenderSession,
  executeFinalRenderPlan,
  validateClosedDeliveryContract,
} from '../lib/render.mjs';

const digest = (character) => character.repeat(64);
const stamp = (value) => { value.integrity.digest = computeArtifactDigest(value); return value; };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hyperframes-final-'));
  const input = await mkdtemp(join(tmpdir(), 'hyperframes-originals-'));
  await mkdir(join(root, 'media', 'music'), { recursive: true });
  await mkdir(join(root, 'renders'), { recursive: true });
  await mkdir(join(root, 'cache', 'render'), { recursive: true });
  const video = join(input, 'ride-original.mp4');
  const still = join(input, 'summit-original.png');
  const music = join(root, 'media', 'music', 'approved.wav');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=0x123456:s=320x180:r=30000/1001:d=0.4', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=0.4', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=0x654321:s=320x180', '-frames:v', '1', still]);
  await runFfmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=1', music]);
  const videoDigest = await import('../lib/media.mjs').then(({ sha256File }) => sha256File(video));
  const stillDigest = await import('../lib/media.mjs').then(({ sha256File }) => sha256File(still));
  const base = {
    project: root,
    sourceRegistry: { entries: [
      { mediaId: 'media-video-001', sourcePath: video, sourceDigest: videoDigest },
      { mediaId: 'media-image-001', sourcePath: still, sourceDigest: stillDigest },
    ] },
    probe: stamp({ revision: 1, media: [
      { mediaId: 'media-video-001', mediaType: 'video', sourceDigest: videoDigest, streams: [{ type: 'video', width: 320, height: 180, frameRate: '30000/1001' }, { type: 'audio' }] },
      { mediaId: 'media-image-001', mediaType: 'image', sourceDigest: stillDigest, streams: [{ type: 'video', width: 320, height: 180, frameRate: '1/1' }] },
    ], integrity: { digest: null, upstream: {} } }),
    editBrief: stamp({ revision: 1, delivery: { container: 'mp4', videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, aspectRatio: '16:9', frameRate: { mode: 'source-compatible', fps: null }, maximumFileSizeBytes: null }, music: { mode: 'provided', localTracks: ['media/music/approved.wav'], mixPriority: 'ambient' }, integrity: { digest: null, upstream: {} } }),
    designSystem: stamp({ revision: 2, status: 'frozen', designRevision: 'design-2', tokens: { colors: { 'color.primaryText': '#FFFFFF' } }, integrity: { digest: null, upstream: {} } }),
    lookProfile: stamp({ revision: 2, status: 'frozen', lookRevision: 'look-2', output: { colorSpace: 'rec709-sdr' }, integrity: { digest: null, upstream: {} } }),
    assetManifest: stamp({ revision: 3, status: 'frozen', assetRevision: 'assets-3', acceptance: { anchorDigest: digest('1'), representativeDigest: digest('2'), batches: [{ digest: digest('3') }] }, assets: [], integrity: { digest: null, upstream: {} } }),
    motionMap: stamp({ revision: 4, status: 'frozen', motionRevision: 'motion-4', seed: 'render-fixture', owners: [{ ownerId: 'owner-chapter-title', layerId: 'layer-chapter-title', assetId: null, sceneId: 'scene-arrive', primitive: 'css', entryFrames: 2, holdFrames: 3, exitFrames: 2, colorToken: 'color.primaryText', timing: { entry: [.2, .25], hold: [.25, .35], exit: [.35, .4] }, proofPasses: ['layer-matte:layer-chapter-title'] }], integrity: { digest: null, upstream: {} } }),
    dataOverlays: { status: 'unavailable', normalizedFacts: {}, overlays: [], integrity: { digest: digest('d') } },
    sceneSchema: stamp({ revision: 2, status: 'frozen', scenes: [
      { sceneId: 'scene-depart', role: 'journey', colorTokens: [], shotIds: [], interval: { entry: [0, .05], hold: [.05, .15], exit: [.15, .2] }, readableLayers: [] },
      { sceneId: 'scene-arrive', role: 'chapter-title', colorTokens: [], shotIds: [], interval: { entry: [.2, .25], hold: [.25, .35], exit: [.35, .4] }, readableLayers: [{ layerId: 'layer-chapter-title', ownerId: 'owner-chapter-title', readableInterval: [.2, .4], typographyRole: 'type.chapterTitle', textRect: [{ time: .2, x: 80, y: 80, width: 640, height: 120 }, { time: .4, x: 80, y: 80, width: 640, height: 120 }], subjectRect: [{ time: .2, x: 1200, y: 400, width: 500, height: 500 }, { time: .4, x: 1200, y: 400, width: 500, height: 500 }], quietZone: [{ time: .2, x: 40, y: 40, width: 800, height: 200 }, { time: .4, x: 40, y: 40, width: 800, height: 200 }], safetyRegions: [], horizonRelation: 'above', screenDirection: 'static', motionDirection: 'static', evidenceFrameIds: ['frame-arrive'], staticFallback: { kind: 'glyph', text: 'ARRIVAL', viewBox: '0 0 640 120' } }] },
    ], integrity: { digest: null, upstream: {} } }),
    timeline: stamp({ revision: 5, phase: 'final', status: 'frozen', timelineRevision: 'timeline-5', designRevision: 'design-2', lookRevision: 'look-2', assetRevision: 'assets-3', motionRevision: 'motion-4', sourceProbeDigest: null, assetManifestDigest: null, motionMapDigest: null, dataOverlaysDigest: digest('d'), items: [
      { itemId: 'item-video', sourceMediaId: 'media-video-001', sourceKind: 'video', sourceReference: { kind: 'original', path: 'media/originals/video.mp4', digest: videoDigest }, sourceInSeconds: 0, sourceOutSeconds: .2, destinationInSeconds: 0, destinationOutSeconds: .2, playbackRate: 1, playbackRateCurve: [{ sourceTimeSeconds: 0, rate: 1 }, { sourceTimeSeconds: .2, rate: 1 }], transform: { stabilization: { mode: 'off', cropFraction: 0 } }, audioPolicy: { sourceGainDb: 0, denoise: false, bridge: 'ambience' }, assetReferences: [], motionReferences: [] },
      { itemId: 'item-still', sourceMediaId: 'media-image-001', sourceKind: 'image', sourceReference: { kind: 'original', path: 'media/originals/still.png', digest: stillDigest }, sourceInSeconds: 0, sourceOutSeconds: .2, destinationInSeconds: .2, destinationOutSeconds: .4, playbackRate: 1, playbackRateCurve: [{ sourceTimeSeconds: 0, rate: 1 }], transform: { stabilization: { mode: 'off', cropFraction: 0 }, stillMotion: { mode: 'hold', holdSeconds: .2, startScale: 1, endScale: 1 } }, audioPolicy: { sourceGainDb: 0, denoise: false, bridge: 'room-tone' }, assetReferences: [], motionReferences: [] },
    ], music: { mode: 'local', path: 'media/music/approved.wav', trimInSeconds: 0, loop: false, fadeInSeconds: .05, fadeOutSeconds: .05, gainDb: -18, duckUnderSpeechDb: -12 }, integrity: { digest: null, upstream: {} } }),
    projectState: { state: 'MOTION_COMPOSITION', revision: 13, transitions: [
      { from: 'DIRECTOR_REVIEW_READY', to: 'DIRECTOR_LOCK', at: '2026-09-01T00:00:00.000Z', evidenceDigests: { DESIGN_SYSTEM: digest('a'), LOOK_PROFILE: digest('b') }, evidenceRevisions: { DESIGN_SYSTEM: 2, LOOK_PROFILE: 2 } },
      { from: 'ASSET_PRODUCTION', to: 'MOTION_COMPOSITION', at: '2026-09-01T01:00:00.000Z', evidenceDigests: {}, evidenceRevisions: {} },
    ], gateEvidence: [], invalidations: [], integrity: { digest: digest('f'), upstream: {} } },
  };
  base.sceneSchema.designSystemDigest = base.designSystem.integrity.digest;
  base.sceneSchema.lookProfileDigest = base.lookProfile.integrity.digest;
  base.sceneSchema.integrity.digest = computeArtifactDigest(base.sceneSchema);
  base.motionMap.designSystemDigest = base.designSystem.integrity.digest;
  base.motionMap.assetManifestDigest = base.assetManifest.integrity.digest;
  base.motionMap.sceneSchemaDigest = base.sceneSchema.integrity.digest;
  base.motionMap.integrity.digest = computeArtifactDigest(base.motionMap);
  base.projectState.assetAcceptance = { stage: 'batch', manifestDigest: base.assetManifest.integrity.digest };
  for (const item of base.timeline.items) item.transition = { kind: 'none', ownerId: null };
  base.timeline.sourceProbeDigest = base.probe.integrity.digest;
  base.timeline.assetManifestDigest = base.assetManifest.integrity.digest;
  base.timeline.motionMapDigest = base.motionMap.integrity.digest;
  base.timeline.integrity.digest = computeArtifactDigest(base.timeline);
  return { ...base, input, video, still, music };
}

test('final plan resolves immutable originals and compiles semantic cache, audio, transforms, and one delivery encode', async () => {
  const input = await fixture();
  const plan = await compileFinalRenderPlan(input);
  assert.deepEqual(plan.raster, { width: 1920, height: 1080, sar: '1', aspectRatio: '16:9' });
  assert.equal(plan.fps, '30000/1001');
  assert.equal(plan.chapters.length, 2);
  assert.ok(plan.chapters[0].args.includes(input.video));
  assert.ok(plan.chapters[1].args.includes(input.still));
  assert.ok(plan.chapters[1].args.includes('-loop'), 'stills are decoded as timed inputs');
  assert.ok(plan.chapters.every(({ args }) => args.some((value) => String(value).includes('scale=1920:1080') && String(value).includes('setsar=1'))));
  assert.ok(plan.chapters[0].filterComplex.includes('apad') && plan.chapters[1].filterComplex.includes('anullsrc'));
  assert.ok(plan.final.args.some((value) => String(value).includes('loudnorm')));
  assert.ok(plan.final.args.some((value) => String(value).includes('sidechaincompress')));
  assert.equal(plan.lossyDeliveryEncodeCount, 1);
  assert.equal(plan.final.pass1Args, null);
  assert.equal(plan.chapters.every(({ intermediateSafe }) => intermediateSafe), true);

  const renamed = structuredClone(input);
  renamed.sceneSchema.scenes[1].readableLayers[0].staticFallback.text = 'HOME';
  renamed.sceneSchema.integrity.digest = computeArtifactDigest(renamed.sceneSchema);
  renamed.motionMap.sceneSchemaDigest = renamed.sceneSchema.integrity.digest;
  renamed.motionMap.integrity.digest = computeArtifactDigest(renamed.motionMap);
  renamed.timeline.motionMapDigest = renamed.motionMap.integrity.digest;
  renamed.timeline.integrity.digest = computeArtifactDigest(renamed.timeline);
  const renamedPlan = await compileFinalRenderPlan(renamed);
  assert.equal(renamedPlan.chapters[0].cacheKey, plan.chapters[0].cacheKey);
  assert.notEqual(renamedPlan.chapters[1].cacheKey, plan.chapters[1].cacheKey);
  const newLook = structuredClone(input);
  newLook.lookProfile.lookRevision = 'look-3';
  newLook.lookProfile.integrity.digest = computeArtifactDigest(newLook.lookProfile);
  newLook.sceneSchema.lookProfileDigest = newLook.lookProfile.integrity.digest;
  newLook.sceneSchema.integrity.digest = computeArtifactDigest(newLook.sceneSchema);
  newLook.motionMap.sceneSchemaDigest = newLook.sceneSchema.integrity.digest;
  newLook.motionMap.integrity.digest = computeArtifactDigest(newLook.motionMap);
  newLook.timeline.lookRevision = 'look-3';
  newLook.timeline.motionMapDigest = newLook.motionMap.integrity.digest;
  newLook.timeline.integrity.digest = computeArtifactDigest(newLook.timeline);
  const lookPlan = await compileFinalRenderPlan(newLook);
  assert.ok(lookPlan.chapters.every((chapter, index) => chapter.cacheKey !== plan.chapters[index].cacheKey));
});

test('size ceiling compiles an explicit null-output first pass and delivery second pass', async () => {
  const input = await fixture();
  input.editBrief.delivery.maximumFileSizeBytes = 2_000_000;
  input.editBrief.integrity.digest = computeArtifactDigest(input.editBrief);
  const plan = await compileFinalRenderPlan(input);
  assert.ok(plan.final.pass1Args.includes('/dev/null'));
  assert.ok(plan.final.pass1Args.includes('-an'));
  assert.equal(plan.final.pass1Args.includes(plan.final.candidatePath), false);
  assert.ok(plan.final.pass2Args.includes(plan.final.candidatePath));
  assert.equal(plan.sizeBudget.passes, 2);
});

test('HyperFrames asset owners become validated chapter composition inputs, not metadata only', async () => {
  const input = await fixture();
  await mkdir(join(input.project, 'assets', 'images', 'components'), { recursive: true });
  const layer = join(input.project, 'assets', 'images', 'components', 'route.png');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=red@0.35:s=64x64', '-frames:v', '1', layer]);
  input.assetManifest.assets = [{ id: 'asset-route', source: 'assets/images/components/route.png' }];
  input.assetManifest.integrity.digest = computeArtifactDigest(input.assetManifest);
  input.motionMap.assetManifestDigest = input.assetManifest.integrity.digest;
  input.projectState.assetAcceptance.manifestDigest = input.assetManifest.integrity.digest;
  input.motionMap.owners.push({ ownerId: 'owner-route', layerId: 'layer-route', assetId: 'asset-route', sceneId: 'scene-depart', primitive: 'svg', entryFrames: 2, holdFrames: 3, exitFrames: 2, colorToken: 'color.primaryText', timing: { entry: [0, .05], hold: [.05, .15], exit: [.15, .2] }, proofPasses: ['layer-matte:layer-route'] });
  input.motionMap.integrity.digest = computeArtifactDigest(input.motionMap);
  input.timeline.assetManifestDigest = input.assetManifest.integrity.digest;
  input.timeline.motionMapDigest = input.motionMap.integrity.digest;
  input.timeline.items[0].assetReferences = ['asset-route'];
  input.timeline.items[0].motionReferences = ['owner-route'];
  input.timeline.integrity.digest = computeArtifactDigest(input.timeline);
  const plan = await compileFinalRenderPlan(input);
  assert.deepEqual(plan.chapters[0].compositionInputs.map(({ assetId }) => assetId), ['asset-route']);
  assert.ok(plan.chapters[0].args.includes(layer));
  assert.ok(plan.chapters[0].filterComplex.includes('overlay='));
});

test('Task 13 paused timelines drive glyph, data, and transition pixels at absolute times', async () => {
  const input = await fixture();
  input.timeline.music = { mode: 'none' };
  input.editBrief.music = { mode: 'none', localTracks: [], mixPriority: 'ambient' };
  input.designSystem.tokens = { colors: { 'color.background': '#123456', 'color.primaryText': '#FFFFFF', 'color.route': '#FF0000', 'color.dataPrimary': '#00FF00' } };
  input.designSystem.integrity.digest = computeArtifactDigest(input.designSystem);
  input.assetManifest.acceptance = { anchorDigest: digest('1'), representativeDigest: digest('2'), batches: [{ digest: digest('3') }] };
  input.assetManifest.assets = [];
  input.assetManifest.integrity.digest = computeArtifactDigest(input.assetManifest);
  input.sceneSchema.designSystemDigest = input.designSystem.integrity.digest;
  input.sceneSchema.lookProfileDigest = input.lookProfile.integrity.digest;
  input.sceneSchema.scenes = [{ sceneId: 'scene-depart', role: 'journey', colorTokens: ['color.primaryText', 'color.route'], shotIds: [], interval: { entry: [0, .1], hold: [.1, .3], exit: [.3, .4] }, readableLayers: [{ layerId: 'layer-title', ownerId: 'owner-title', readableInterval: [0, .4], typographyRole: 'type.chapterTitle', textRect: [{ time: 0, x: 80, y: 80, width: 640, height: 120 }, { time: .4, x: 80, y: 80, width: 640, height: 120 }], subjectRect: [{ time: 0, x: 1200, y: 400, width: 500, height: 500 }, { time: .4, x: 1200, y: 400, width: 500, height: 500 }], quietZone: [{ time: 0, x: 40, y: 40, width: 800, height: 200 }, { time: .4, x: 40, y: 40, width: 800, height: 200 }], safetyRegions: [], horizonRelation: 'above', screenDirection: 'static', motionDirection: 'static', evidenceFrameIds: ['frame-title'], staticFallback: { kind: 'glyph', text: 'RIDE', viewBox: '0 0 640 120' } }] }];
  input.sceneSchema.integrity.digest = computeArtifactDigest(input.sceneSchema);
  input.motionMap.sceneSchemaDigest = input.sceneSchema.integrity.digest;
  input.motionMap.owners = [];
  input.motionMap.integrity.digest = computeArtifactDigest(input.motionMap);
  input.timeline.motionMapDigest = input.motionMap.integrity.digest;
  input.motionMap.seed = 'render-seed';
  input.motionMap.designSystemDigest = input.designSystem.integrity.digest;
  input.motionMap.assetManifestDigest = input.assetManifest.integrity.digest;
  input.motionMap.sceneSchemaDigest = input.sceneSchema.integrity.digest;
  input.motionMap.owners = [
    { ownerId: 'owner-title', layerId: 'layer-title', assetId: null, sceneId: 'scene-depart', primitive: 'css', entryFrames: 3, holdFrames: 6, exitFrames: 3, colorToken: 'color.primaryText', timing: { entry: [0, .1], hold: [.1, .2], exit: [.2, .3] }, proofPasses: ['layer-matte:layer-title'] },
    { ownerId: 'owner-transition', layerId: 'layer-transition', assetId: null, sceneId: 'scene-depart', primitive: 'svg', entryFrames: 1, holdFrames: 1, exitFrames: 1, colorToken: 'color.route', timing: { entry: [.3, .32], hold: [.32, .34], exit: [.34, .4] }, proofPasses: ['layer-matte:layer-transition'], transition: { relationship: 'motion-match', midpointSeconds: .33, nonEmpty: true, designReason: 'absolute-time transition' }, staticFallback: { kind: 'shape', path: 'M0 0 L200 0 L200 200 L0 200 Z', viewBox: '0 0 200 200' } },
  ];
  input.motionMap.integrity.digest = computeArtifactDigest(input.motionMap);
  input.dataOverlays = { status: 'available', normalizedFacts: { 'metrics.distance': { value: 100, unit: 'm' } }, overlays: [{ overlayId: 'overlay-distance', metricId: 'metrics.distance', displayAuthority: 'whole-activity', syncAuthority: 'whole-activity', wording: '100 m', colorToken: 'color.dataPrimary', destinationInSeconds: .1, destinationOutSeconds: .3 }], integrity: { digest: digest('d') } };
  input.timeline.items = [input.timeline.items[0]];
  input.timeline.items[0].destinationOutSeconds = .4;
  input.timeline.items[0].sourceOutSeconds = .4;
  input.timeline.items[0].playbackRateCurve = [{ sourceTimeSeconds: 0, rate: 1 }, { sourceTimeSeconds: .4, rate: 1 }];
  input.timeline.items[0].transition = { kind: 'motion-match', ownerId: 'owner-transition' };
  input.timeline.items[0].motionReferences = ['owner-title', 'owner-transition'];
  input.timeline.assetManifestDigest = input.assetManifest.integrity.digest;
  input.timeline.motionMapDigest = input.motionMap.integrity.digest;
  input.timeline.dataOverlaysDigest = input.dataOverlays.integrity.digest;
  input.timeline.integrity.digest = computeArtifactDigest(input.timeline);
  input.projectState.assetAcceptance = { stage: 'batch', manifestDigest: input.assetManifest.integrity.digest };
  const plan = await compileFinalRenderPlan(input);
  assert.equal(plan.hyperFramesComposition.clock, 'paused-absolute-time');
  assert.ok(plan.chapters[0].filterComplex.includes("drawtext=text='RIDE'"));
  assert.ok(plan.chapters[0].filterComplex.includes("drawtext=text='100 m'"));
  assert.ok(plan.chapters[0].filterComplex.includes('drawbox='));
  const rendered = await executeFinalRenderPlan(plan);
  const frame = join(input.project, 'transition.png');
  await runFfmpeg(['-ss', '0.33', '-i', join(input.project, rendered.artifact), '-frames:v', '1', frame]);
  const { data } = await sharp(frame).raw().toBuffer({ resolveWithObject: true });
  let redPixels = 0;
  for (let offset = 0; offset < data.length; offset += 3) if (data[offset] > 180 && data[offset + 1] < 100) redPixels += 1;
  assert.ok(redPixels > 100, 'transition fallback produces actual red pixels at its absolute midpoint');
});

test('variable speed curves, approved treatments, audio bridges, and loop crossfade compile and keep real A/V aligned', async () => {
  const input = await fixture();
  input.sceneSchema.scenes = [{ sceneId: 'scene-speed', role: 'journey', colorTokens: [], shotIds: [], interval: { entry: [0, .05], hold: [.05, .2], exit: [.2, .25] }, readableLayers: [] }];
  input.sceneSchema.integrity.digest = computeArtifactDigest(input.sceneSchema);
  input.motionMap.sceneSchemaDigest = input.sceneSchema.integrity.digest;
  input.motionMap.owners = [];
  input.motionMap.integrity.digest = computeArtifactDigest(input.motionMap);
  input.timeline.items = [input.timeline.items[0]];
  Object.assign(input.timeline.items[0], { sourceOutSeconds: .4, destinationOutSeconds: .25, playbackRateCurve: [{ sourceTimeSeconds: 0, rate: 1 }, { sourceTimeSeconds: .1, rate: 2 }, { sourceTimeSeconds: .4, rate: 2 }], transform: { stabilization: { mode: 'conservative', cropFraction: .05 }, cropReframe: { x: .05, y: .05, width: .9, height: .9 }, stillMotion: null }, audioPolicy: { sourceGainDb: 0, denoise: false, bridge: 'l-cut' } });
  input.timeline.music = { mode: 'local', path: 'media/music/approved.wav', trimInSeconds: 0, loop: true, loopCrossfadeSeconds: .05, fadeInSeconds: .02, fadeOutSeconds: .02, gainDb: -18, duckUnderSpeechDb: -12 };
  input.timeline.motionMapDigest = input.motionMap.integrity.digest;
  input.timeline.integrity.digest = computeArtifactDigest(input.timeline);
  const plan = await compileFinalRenderPlan(input);
  assert.match(plan.chapters[0].filterComplex, /trim=start=0:end=0\.1.*atempo=1/);
  assert.match(plan.chapters[0].filterComplex, /trim=start=0\.1:end=0\.4.*atempo=2/);
  assert.ok(plan.chapters[0].filterComplex.includes('deshake'));
  assert.ok(plan.chapters[0].filterComplex.includes('crop='));
  assert.ok(plan.chapters[0].filterComplex.includes('afade='));
  assert.ok(plan.final.filterComplex.includes('acrossfade='));
  assert.equal(plan.authority.music, await sha256File(input.music));
  const result = await executeFinalRenderPlan(plan);
  assert.ok(result.closedFileProbe.avDurationDeltaSeconds <= 1 / (30000 / 1001));
});

test('chapter cache is atomic and digest-bound, and final execution rejects source TOCTOU', async () => {
  const input = await fixture();
  input.timeline.music = { mode: 'none' };
  const plan = await compileFinalRenderPlan(input);
  assert.notEqual(plan.chapters[0].renderPath, plan.chapters[0].outputPath);
  await executeFinalRenderPlan(plan);
  const sidecar = JSON.parse(await readFile(plan.chapters[0].sidecarPath, 'utf8'));
  assert.equal(sidecar.outputDigest, await sha256File(plan.chapters[0].outputPath));
  const changed = await fixture();
  const stalePlan = await compileFinalRenderPlan(changed);
  await writeFile(changed.video, 'changed');
  await assert.rejects(() => executeFinalRenderPlan(stalePlan), (error) => error.code === 'E_SOURCE_CHANGED');
});

test('FINAL_RENDER commit binds closed provenance and cannot claim QA or delivery', async () => {
  const input = await fixture();
  const provenance = stamp({ revision: 1, outputDigest: digest('8'), closedFileProbe: { valid: true }, integrity: { digest: null, upstream: {} } });
  const next = commitFinalRenderState(input.projectState, provenance, '2026-09-03T10:00:00.000Z');
  assert.equal(next.state, 'FINAL_RENDER');
  assert.notEqual(next.state, 'FINAL_QA');
  assert.notEqual(next.state, 'DELIVERED');
  assert.deepEqual(next.transitions.at(-1).evidenceDigests, { FINAL_RENDER: provenance.integrity.digest });
});

test('closed candidate contract rejects wrong fps, SAR, codec, container, duration, drift, and size', () => {
  const plan = { fps: '30000/1001', raster: { width: 1920, height: 1080 }, durationSeconds: 1, expected: { videoCodec: 'h264', audioCodec: 'aac', container: 'mp4' }, sizeBudget: { maximumFileSizeBytes: 1000 } };
  const valid = { format: { duration: '1', format_name: 'mov,mp4' }, streams: [{ codec_type: 'video', width: 1920, height: 1080, sample_aspect_ratio: '1:1', avg_frame_rate: '30000/1001', codec_name: 'h264', duration: '1' }, { codec_type: 'audio', codec_name: 'aac', duration: '1' }] };
  assert.equal(validateClosedDeliveryContract(plan, valid, 999).valid, true);
  for (const mutate of [
    (value) => { value.streams[0].avg_frame_rate = '24/1'; }, (value) => { value.streams[0].sample_aspect_ratio = '4:3'; },
    (value) => { value.streams[0].codec_name = 'hevc'; }, (value) => { value.format.format_name = 'matroska'; },
    (value) => { value.format.duration = '2'; }, (value) => { value.streams[1].duration = '.5'; },
  ]) {
    const broken = structuredClone(valid); mutate(broken);
    assert.throws(() => validateClosedDeliveryContract(plan, broken, 999), (error) => error.code === 'E_FINAL_CLOSED_PROBE');
  }
  assert.throws(() => validateClosedDeliveryContract(plan, valid, 1001), (error) => error.code === 'E_FINAL_CLOSED_PROBE');
});

test('final authority rejects pre-lock, stale lock, proxies, remote music, and impossible clarity budgets', async () => {
  const input = await fixture();
  const preLock = structuredClone(input); preLock.projectState.state = 'DIRECTOR_REVIEW_READY';
  await assert.rejects(() => compileFinalRenderPlan(preLock), (error) => error.code === 'E_FINAL_PRE_LOCK');
  const stale = structuredClone(input); stale.timeline.motionMapDigest = digest('9');
  await assert.rejects(() => compileFinalRenderPlan(stale), (error) => error.code === 'E_FINAL_AUTHORITY_STALE');
  const proxy = structuredClone(input); proxy.timeline.items[0].sourceReference.kind = 'proxy'; proxy.timeline.items[0].sourceReference.path = 'media/proxies/video.mp4';
  await assert.rejects(() => compileFinalRenderPlan(proxy), (error) => error.code === 'E_PROXY_FINAL_SOURCE');
  const remote = structuredClone(input); remote.timeline.music.path = 'https://music.invalid/track.wav';
  await assert.rejects(() => compileFinalRenderPlan(remote), (error) => error.code === 'E_REMOTE_MUSIC');
  const tiny = structuredClone(input); tiny.editBrief.delivery.maximumFileSizeBytes = 1024;
  await assert.rejects(() => compileFinalRenderPlan(tiny), (error) => error.code === 'E_CLARITY_FLOOR' && error.alternatives.length > 0);
});

test('synthetic 1080p and short 4K finals close/reprobe and identical rerun hits chapter cache', async () => {
  const input = await fixture();
  input.timeline.music = { mode: 'none' };
  input.editBrief.music = { mode: 'none', localTracks: [], mixPriority: 'ambient' };
  for (const [width, height] of [[1920, 1080], [3840, 2160]]) {
    input.editBrief.delivery.width = width; input.editBrief.delivery.height = height;
    input.editBrief.integrity.digest = computeArtifactDigest(input.editBrief);
    const first = await executeFinalRenderPlan(await compileFinalRenderPlan(input));
    assert.equal(first.closedFileProbe.valid, true);
    assert.equal(first.closedFileProbe.width, width);
    assert.equal(first.closedFileProbe.height, height);
    assert.ok(first.closedFileProbe.avDurationDeltaSeconds <= 1 / (30000 / 1001));
    const second = await executeFinalRenderPlan(await compileFinalRenderPlan(input));
    assert.equal(second.cache.hits, 2);
    const bytes = await readFile(join(input.project, 'renders', 'final.mp4'));
    assert.equal(bytes.includes(Buffer.from('ANALYSIS PROXY')), false);
  }
});

test('cancellation kills active children and removes incomplete outputs', async () => {
  const project = await mkdtemp(join(tmpdir(), 'hyperframes-cancel-'));
  const partial = join(project, 'partial.mp4');
  await writeFile(partial, 'incomplete');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const session = createRenderSession({ partialPaths: [partial] });
  session.track(child);
  await session.cancel();
  assert.equal(child.killed, true);
  await assert.rejects(() => stat(partial), (error) => error.code === 'ENOENT');
});
