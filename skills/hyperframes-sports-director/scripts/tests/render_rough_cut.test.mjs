import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeArtifactDigest } from '../lib/contracts.mjs';
import { ffprobeJson, runFfmpeg } from '../lib/ffmpeg.mjs';
import { compileRoughRenderPlan } from '../lib/render-plan.mjs';
import { assertRoughCutCurrentForDirectorReview, renderRoughCut, roughCutIsCurrent } from '../render_rough_cut.mjs';

const digest = (character) => character.repeat(64);

test('rough cut resolves only proxies, visibly marks analysis, preserves audio, closes/reprobes, and binds integrity', async () => {
  const project = await mkdtemp(join(tmpdir(), 'hyperframes-rough-'));
  await mkdir(join(project, 'analysis'), { recursive: true });
  await mkdir(join(project, 'media', 'proxies'), { recursive: true });
  await mkdir(join(project, 'analysis', 'evidence', 'segment-001'), { recursive: true });
  const proxyPath = join(project, 'media', 'proxies', 'media-video-001.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', proxyPath,
  ]);
  const evidencePath = join(project, 'analysis', 'evidence', 'segment-001', 'frame.webp');
  await runFfmpeg(['-ss', '1', '-i', proxyPath, '-frames:v', '1', evidencePath]);
  const projectDocument = {
    $schema: 'https://hyperframes.local/schemas/project.schema.json', schemaVersion: '1.0.0', projectId: 'rough-test', revision: 1,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    paths: { workspace: '.', inputReference: 'media/originals' },
    profiles: { sport: 'cycling', device: 'dji-osmo-action-5-pro', delivery: 'landscape-1080p', sportMaturity: 'release-grade' },
    remoteCapabilitiesForbidden: true, integrity: { digest: null, upstream: {} },
  };
  projectDocument.integrity.digest = computeArtifactDigest(projectDocument);
  const probe = {
    $schema: 'https://hyperframes.local/schemas/probe.schema.json', schemaVersion: '1.0.0', revision: 1,
    media: [{
      mediaId: 'media-video-001', mediaType: 'video', reviewPath: 'review/probe/media-video-001.mp4',
      sourceDigest: digest('1'), byteSize: 1, durationSeconds: 2,
      streams: [
        { streamId: 'v:0', type: 'video', codec: 'h264', timeBase: '1/12288', frameRate: '24/1', width: 320, height: 180 },
        { streamId: 'a:1', type: 'audio', codec: 'aac', timeBase: '1/48000', channels: 1, sampleRate: 48000, channelLayout: 'mono' },
      ], captureTimestamp: null,
      proxy: {
        kind: 'video', path: 'media/proxies/media-video-001.mp4', sourceDigest: digest('1'),
        transform: { codec: 'h264', maximumWidth: 1280, maximumHeight: 720, watermark: 'ANALYSIS PROXY', preserveTimestamps: true, preserveAudio: true, autoOrient: true },
        timeMapping: [{ proxyStartSeconds: 0, originalStartSeconds: 0, durationSeconds: 2, rate: '1/1' }],
      },
    }],
    integrity: { digest: null, upstream: { mediaIndex: digest('9') } },
  };
  probe.integrity.digest = computeArtifactDigest(probe);
  const segments = {
    $schema: 'https://hyperframes.local/schemas/segments.schema.json', schemaVersion: '1.0.0', revision: 1,
    sourceMediaIds: ['media-video-001'], segments: [{
      segmentId: 'segment-001', mediaId: 'media-video-001', mediaType: 'video', sourceDigest: digest('1'), probeDigest: probe.integrity.digest,
      sourceInSeconds: 0, sourceOutSeconds: 2, sourceDurationSeconds: 2, sceneScore: 0, motionScore: 0, audioPresent: true,
      reviewPath: 'analysis/segments/segment-001.webp', evidenceFrames: [{ path: 'analysis/evidence/segment-001/frame.webp', sourceTimeSeconds: 1 }],
    }], integrity: { digest: null, upstream: { probe: probe.integrity.digest } },
  };
  segments.integrity.digest = computeArtifactDigest(segments);
  const shots = {
    $schema: 'https://hyperframes.local/schemas/shot.schema.json', schemaVersion: '1.0.0', revision: 1, status: 'available',
    shots: [{
      shotId: 'shot-video-001', mediaId: 'media-video-001', segmentId: 'segment-001', sourceDigest: digest('1'),
      sourceInSeconds: 0, sourceOutSeconds: 2, sourceDurationSeconds: 2, cameraRole: 'wide', actionRole: 'move',
      environmentTags: ['test'], subjectTags: ['athlete'],
      quality: { motionIntensity: 'low', blur: 'none', shake: 'none', exposure: 'good', horizon: 'level', occlusion: 'none' },
      continuity: { screenDirection: 'static', motionDirection: 'static', subjectEntry: 'none', subjectExit: 'none', location: 'test', timeRelation: 'continuous' },
      audioSpans: [{ kind: 'ambient', sourceInSeconds: 0, sourceOutSeconds: 2 }], duplicateGroup: null,
      setupTailLikelihood: 0, evidenceFrames: ['analysis/evidence/segment-001/frame.webp'], confidence: 0.9,
    }], integrity: { digest: null, upstream: { probe: probe.integrity.digest, segments: segments.integrity.digest } },
  };
  shots.integrity.digest = computeArtifactDigest(shots);
  const transcript = {
    $schema: 'https://hyperframes.local/schemas/transcript.schema.json', schemaVersion: '1.0.0', revision: 1,
    status: 'unavailable', language: null, segments: [], integrity: { digest: null, upstream: {} },
  };
  transcript.integrity.digest = computeArtifactDigest(transcript);
  const timeline = {
    $schema: 'https://hyperframes.local/schemas/timeline.schema.json', schemaVersion: '1.0.0', revision: 1,
    timelineRevision: 'timeline-1', status: 'available', phase: 'rough', designRevision: 'design-1', lookRevision: 'look-1', assetRevision: 'assets-1', motionRevision: 'motion-1',
    sourceProbeDigest: probe.integrity.digest,
    items: [{
      itemId: 'item-001', shotId: 'shot-video-001', sourceMediaId: 'media-video-001', sourceKind: 'video',
      sourceReference: { kind: 'proxy', path: 'media/proxies/media-video-001.mp4', digest: digest('1') },
      sourceInSeconds: 0, sourceOutSeconds: 2, sourceDurationSeconds: 2, destinationInSeconds: 0, destinationOutSeconds: 2,
      playbackRate: 1, playbackRateCurve: [{ sourceTimeSeconds: 0, rate: 1 }, { sourceTimeSeconds: 2, rate: 1 }],
      transform: { stabilization: { mode: 'off', cropFraction: 0 }, cropReframe: null, stillMotion: null, draftColorTransform: 'neutral', faceTreatment: 'off' },
      audioPolicy: { sourceGainDb: 0, denoise: false, bridge: 'none' }, transition: { kind: 'none', ownerId: null }, assetReferences: [], motionReferences: [], reasons: ['test'], colorToken: 'color.textPrimary',
    }],
    music: { mode: 'none' }, warningDecisions: [],
    integrity: { digest: null, upstream: { probe: probe.integrity.digest, shots: shots.integrity.digest, transcript: transcript.integrity.digest } },
  };
  timeline.integrity.digest = computeArtifactDigest(timeline);
  await writeFile(join(project, 'PROJECT.json'), `${JSON.stringify(projectDocument)}\n`);
  await writeFile(join(project, 'analysis', 'PROBE.json'), `${JSON.stringify(probe)}\n`);
  await writeFile(join(project, 'analysis', 'SEGMENTS.json'), `${JSON.stringify(segments)}\n`);
  await writeFile(join(project, 'analysis', 'SHOTS.jsonl'), `${JSON.stringify(shots)}\n`);
  await writeFile(join(project, 'analysis', 'TRANSCRIPT.json'), `${JSON.stringify(transcript)}\n`);
  await mkdir(join(project, 'edit'), { recursive: true });
  await writeFile(join(project, 'edit', 'TIMELINE.json'), `${JSON.stringify(timeline)}\n`);

  const plan = await compileRoughRenderPlan({ project, probe, timeline, width: 320, height: 180 });
  assert.equal(Array.isArray(plan.args), true);
  assert.ok(plan.args.some((argument) => argument.includes('ANALYSIS PROXY')));
  assert.deepEqual(plan.sources, ['media/proxies/media-video-001.mp4']);
  assert.equal(plan.args.some((argument) => argument.includes('originals')), false);

  const rampTimeline = structuredClone(timeline);
  rampTimeline.items[0].destinationOutSeconds = 1.5;
  rampTimeline.items[0].playbackRateCurve = [
    { sourceTimeSeconds: 0, rate: 1 }, { sourceTimeSeconds: 1, rate: 2 }, { sourceTimeSeconds: 2, rate: 2 },
  ];
  const rampPlan = await compileRoughRenderPlan({ project, probe, timeline: rampTimeline, width: 320, height: 180 });
  const rampFilters = rampPlan.args[rampPlan.args.indexOf('-filter_complex') + 1];
  assert.ok(rampFilters.includes('trim=start=0:end=1'));
  assert.ok(rampFilters.includes('trim=start=1:end=2'));
  assert.ok(rampFilters.includes('atempo=2'));
  for (const { rate, sourceOutSeconds, destinationOutSeconds, label } of [
    { rate: 2, sourceOutSeconds: 2, destinationOutSeconds: 1, label: 'fast' },
    { rate: 0.5, sourceOutSeconds: 1, destinationOutSeconds: 2, label: 'slow' },
  ]) {
    const singlePoint = structuredClone(timeline);
    singlePoint.items[0].sourceOutSeconds = sourceOutSeconds;
    singlePoint.items[0].destinationOutSeconds = destinationOutSeconds;
    singlePoint.items[0].playbackRate = rate;
    singlePoint.items[0].playbackRateCurve = [{ sourceTimeSeconds: 0, rate }];
    const speedOutput = join(project, `${label}.mp4`);
    const speedPlan = await compileRoughRenderPlan({ project, probe, timeline: singlePoint, width: 320, height: 180, outputPath: speedOutput });
    const speedFilters = speedPlan.args[speedPlan.args.indexOf('-filter_complex') + 1];
    assert.ok(speedFilters.includes(`atempo=${rate}`), `${label} keeps source audio on the normalized curve`);
    assert.equal(speedFilters.includes('anullsrc=r=48000:cl=stereo'), false, `${label} must not replace recorded audio with silence`);
    await runFfmpeg(speedPlan.args);
    const speedProbe = await ffprobeJson(speedOutput);
    const videoDuration = Number(speedProbe.streams.find(({ codec_type: type }) => type === 'video').duration);
    const audioDuration = Number(speedProbe.streams.find(({ codec_type: type }) => type === 'audio').duration);
    assert.ok(Math.abs(videoDuration - audioDuration) <= 0.1, `${label} A/V duration drift`);
    assert.ok(Math.abs(Number(speedProbe.format.duration) - destinationOutSeconds) <= 0.1, `${label} output duration`);
  }
  const missingMusic = structuredClone(timeline);
  missingMusic.music = { mode: 'local', path: 'media/music/missing.m4a', loop: true, loopCrossfadeSeconds: 0.2 };
  await assert.rejects(
    () => compileRoughRenderPlan({ project, probe, timeline: missingMusic, width: 320, height: 180 }),
    (error) => error.code === 'E_MUSIC_LOCAL_MISSING',
  );
  const duckedMusic = structuredClone(timeline);
  duckedMusic.music = {
    mode: 'local', path: 'media/proxies/media-video-001.mp4', loop: false,
    gainDb: -18, duckUnderSpeechDb: -12,
  };
  const duckPlan = await compileRoughRenderPlan({ project, probe, timeline: duckedMusic, width: 320, height: 180 });
  const duckFilters = duckPlan.args[duckPlan.args.indexOf('-filter_complex') + 1];
  assert.ok(duckFilters.includes('sidechaincompress=threshold=0.03:ratio=5:'), 'duckUnderSpeechDb compiles into deterministic sidechain strength');

  const profiles = { sport: { policies: { speedPolicy: { maximumMontageRate: 12 }, stabilizationPolicy: { maximumCropFraction: 0.12 }, duplicatePolicy: { minimumSeparationSeconds: 12 } } } };
  const result = await renderRoughCut({ project, probe, timeline, shots, transcript, profiles, width: 320, height: 180 });
  assert.equal(result.ok, true);
  assert.equal(result.closedFileProbe.valid, true);
  assert.equal(result.integrity.timelineDigest, timeline.integrity.digest);
  assert.equal(result.integrity.probeDigest, probe.integrity.digest);
  assert.equal(result.integrity.proxyDigests.length, 1);
  const outputProbe = await ffprobeJson(join(project, result.artifact));
  assert.ok(outputProbe.streams.some(({ codec_type: type }) => type === 'video'));
  assert.ok(outputProbe.streams.some(({ codec_type: type }) => type === 'audio'));
  assert.equal(await roughCutIsCurrent({ project, timeline, probe }), true);

  timeline.revision = 2;
  timeline.integrity.digest = computeArtifactDigest(timeline);
  assert.equal(await roughCutIsCurrent({ project, timeline, probe }), false);
  await assert.rejects(() => assertRoughCutCurrentForDirectorReview({ project, timeline, probe }), (error) => error.code === 'E_ROUGH_CUT_STALE');
  const metadata = JSON.parse(await readFile(join(project, 'renders', 'rough-cut.json'), 'utf8'));
  assert.equal(metadata.stateAuthority, 'ROUGH_CUT');
  assert.notEqual(metadata.stateAuthority, 'DIRECTOR_REVIEW_READY');
});
