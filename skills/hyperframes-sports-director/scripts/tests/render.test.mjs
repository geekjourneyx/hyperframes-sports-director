import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { computeArtifactDigest } from '../lib/contracts.mjs';
import { ffprobeJson, runFfmpeg } from '../lib/ffmpeg.mjs';
import {
  compileFinalRenderPlan,
  commitFinalRenderState,
  createRenderSession,
  executeFinalRenderPlan,
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
    designSystem: stamp({ revision: 2, status: 'frozen', designRevision: 'design-2', integrity: { digest: null, upstream: {} } }),
    lookProfile: stamp({ revision: 2, status: 'frozen', lookRevision: 'look-2', output: { colorSpace: 'rec709-sdr' }, integrity: { digest: null, upstream: {} } }),
    assetManifest: stamp({ revision: 3, status: 'frozen', assetRevision: 'assets-3', integrity: { digest: null, upstream: {} } }),
    motionMap: stamp({ revision: 4, status: 'frozen', motionRevision: 'motion-4', integrity: { digest: null, upstream: {} } }),
    sceneSchema: stamp({ revision: 2, status: 'frozen', scenes: [
      { sceneId: 'scene-depart', title: 'Departure', interval: { entry: [0, .05], hold: [.05, .15], exit: [.15, .2] } },
      { sceneId: 'scene-arrive', title: 'Arrival', interval: { entry: [.2, .25], hold: [.25, .35], exit: [.35, .4] } },
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
  renamed.sceneSchema.scenes[1].title = 'Home';
  renamed.sceneSchema.integrity.digest = computeArtifactDigest(renamed.sceneSchema);
  const renamedPlan = await compileFinalRenderPlan(renamed);
  assert.equal(renamedPlan.chapters[0].cacheKey, plan.chapters[0].cacheKey);
  assert.notEqual(renamedPlan.chapters[1].cacheKey, plan.chapters[1].cacheKey);
  const newLook = structuredClone(input);
  newLook.lookProfile.lookRevision = 'look-3';
  newLook.lookProfile.integrity.digest = computeArtifactDigest(newLook.lookProfile);
  newLook.timeline.lookRevision = 'look-3';
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
  input.motionMap.owners = [{ ownerId: 'owner-route', assetId: 'asset-route', sceneId: 'scene-depart', timing: { entry: [0, .05], hold: [.05, .15], exit: [.15, .2] } }];
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

test('FINAL_RENDER commit binds closed provenance and cannot claim QA or delivery', async () => {
  const input = await fixture();
  const provenance = stamp({ revision: 1, outputDigest: digest('8'), closedFileProbe: { valid: true }, integrity: { digest: null, upstream: {} } });
  const next = commitFinalRenderState(input.projectState, provenance, '2026-09-03T10:00:00.000Z');
  assert.equal(next.state, 'FINAL_RENDER');
  assert.notEqual(next.state, 'FINAL_QA');
  assert.notEqual(next.state, 'DELIVERED');
  assert.deepEqual(next.transitions.at(-1).evidenceDigests, { FINAL_RENDER: provenance.integrity.digest });
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
