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
  const proxyPath = join(project, 'media', 'proxies', 'media-video-001.mp4');
  await runFfmpeg([
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=24:d=2',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=2',
    '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', proxyPath,
  ]);
  const probe = {
    integrity: { digest: digest('a') },
    media: [{
      mediaId: 'media-video-001', mediaType: 'video', sourceDigest: digest('1'), durationSeconds: 2,
      streams: [{ type: 'video' }, { type: 'audio' }],
      proxy: { kind: 'video', path: 'media/proxies/media-video-001.mp4', sourceDigest: digest('1') },
    }],
  };
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
    integrity: { digest: null, upstream: { probe: probe.integrity.digest } },
  };
  timeline.integrity.digest = computeArtifactDigest(timeline);
  await writeFile(join(project, 'analysis', 'PROBE.json'), `${JSON.stringify(probe)}\n`);
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
  const missingMusic = structuredClone(timeline);
  missingMusic.music = { mode: 'local', path: 'media/music/missing.m4a', loop: true, loopCrossfadeSeconds: 0.2 };
  await assert.rejects(
    () => compileRoughRenderPlan({ project, probe, timeline: missingMusic, width: 320, height: 180 }),
    (error) => error.code === 'E_MUSIC_LOCAL_MISSING',
  );

  const shots = { shots: [{
    shotId: 'shot-video-001', mediaId: 'media-video-001', sourceDigest: digest('1'), sourceInSeconds: 0, sourceOutSeconds: 2,
    duplicateGroup: null, setupTailLikelihood: 0, quality: { shake: 'none' },
    continuity: { screenDirection: 'static', motionDirection: 'static', subjectEntry: 'none', subjectExit: 'none', location: 'test', timeRelation: 'continuous' },
  }] };
  const transcript = { status: 'unavailable', segments: [] };
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
