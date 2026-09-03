import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import {
  applyInspectionRepair,
  buildInspectionSchedule,
  commitInspectionBlockedState,
  commitInspectionStates,
  evaluateMachineGates,
  measureLocalContrast,
  measureRenderedTokenColor,
  reviewRepairDecision,
  validateFinalPixelProof,
} from '../lib/visual-qc.mjs';
import { analyzeEncodedMp4, measureProofPasses, recoverInspectionTransaction } from '../inspect_output.mjs';
import { computeArtifactDigest, loadSchema, validateDocument } from '../lib/contracts.mjs';
import { runCommand } from '../lib/ffmpeg.mjs';
import { commitFinalRenderState } from '../lib/render.mjs';

const hex = (character) => character.repeat(64);

function gateSpecifications(state) {
  if (state === 'DIRECTOR_LOCK') return [['DESIGN_SYSTEM', 'frozen'], ['LOOK_PROFILE', 'frozen'], ['DIRECTOR_APPROVAL', 'consumed'], ['WORKBENCH', 'state-bound']];
  if (state === 'STYLE_ANCHOR') return [['DESIGN_SYSTEM', 'frozen'], ['LOOK_PROFILE', 'frozen'], ['ASSET_PLAN', 'approved'], ['STYLE_ANCHOR', 'accepted']];
  if (state === 'ASSET_PRODUCTION') return [['STYLE_ANCHOR', 'accepted'], ['REPRESENTATIVE_COMBINATION', 'accepted']];
  return [[`${state}_GATE`, 'accepted']];
}

function validFinalRenderState() {
  const route = ['INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT', 'DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION', 'MOTION_COMPOSITION'];
  const gateEvidence = [];
  const transitions = route.slice(1).map((to, index) => {
    const timestamp = `2026-09-01T00:${String(index).padStart(2, '0')}:00.000Z`;
    const records = gateSpecifications(to).map(([role, qualifier], roleIndex) => ({ gate: to, role, revision: index + 1, digest: `${index + 1}${roleIndex + 1}`.padStart(64, '0'), timestamp, producerCommand: to === 'DIRECTOR_LOCK' ? 'lock_direction.mjs' : `test-gate --state ${to}`, qualifiers: [qualifier], validity: 'valid', invalidatedAt: null }));
    gateEvidence.push(...records);
    return { from: route[index], to, at: timestamp, evidenceDigests: Object.fromEntries(records.map(({ role, digest }) => [role, digest])), evidenceRevisions: Object.fromEntries(records.map(({ role, revision }) => [role, revision])) };
  });
  const previous = {
    $schema: 'https://hyperframes.local/schemas/project-state.schema.json', schemaVersion: '1.0.0', revision: 13, state: 'MOTION_COMPOSITION', previousState: 'ASSET_PRODUCTION', stateEnteredAt: transitions.at(-1).at,
    transitions, gateEvidence, invalidations: [], assetAcceptance: { stage: 'batch', manifestRevision: 2, manifestDigest: hex('e'), anchorDigest: gateEvidence.find(({ gate, role }) => gate === 'ASSET_PRODUCTION' && role === 'STYLE_ANCHOR').digest, representativeDigest: gateEvidence.find(({ gate, role }) => gate === 'ASSET_PRODUCTION' && role === 'REPRESENTATIVE_COMBINATION').digest, anchorIdentityDigest: hex('a'), representativeIdentityDigest: hex('b'), batchDigest: hex('c'), acceptedAt: transitions.at(-1).at }, integrity: { digest: null, upstream: {} },
  };
  previous.integrity.digest = computeArtifactDigest(previous);
  const provenance = { revision: 1, outputDigest: hex('8'), closedFileProbe: { valid: true }, integrity: { digest: null, upstream: {} } };
  provenance.integrity.digest = computeArtifactDigest(provenance);
  const final = commitFinalRenderState(previous, provenance, '2026-09-03T00:00:00.000Z');
  final.integrity.digest = computeArtifactDigest(final);
  return final;
}

test('inspection schedule covers 10Hz intervals and every semantic or extrema frame', () => {
  const schedule = buildInspectionSchedule({
    scenes: [{ sceneId: 'scene-a', interval: { entry: [0, .2], hold: [.2, .6], exit: [.6, .8] }, readableLayers: [{ layerId: 'layer-title', readableInterval: [0, .8] }] }],
    transitions: [{ midpointSeconds: .65 }], motionExtrema: [.33], luminanceExtrema: [.47],
  });
  assert.deepEqual(schedule.filter(({ time }) => [.33, .47, .65].includes(time)).map(({ time }) => time), [.33, .47, .65]);
  assert.ok(schedule.filter(({ time }) => time >= 0 && time <= .8).length >= 9);
  assert.ok(schedule.every(({ reasons }) => reasons.length > 0));
  assert.deepEqual(schedule.find(({ time }) => time === .2).targets, [{ sceneId: 'scene-a' }, { sceneId: 'scene-a', layerId: 'layer-title' }]);
});

test('final pixel proof is digest-bound and covers every scheduled readable sample', () => {
  const documents = {
    sceneSchema: { scenes: [{ sceneId: 'scene-a', readableLayers: [{ layerId: 'layer-title', readableInterval: [0, .1], typographyRole: 'title' }] }], integrity: { digest: hex('1') } },
    motionMap: { owners: [{ layerId: 'layer-title', colorToken: 'color.primaryText' }], integrity: { digest: hex('2') } },
    designSystem: { tokens: { colors: { 'color.primaryText': '#FFFFFF' } }, integrity: { digest: hex('3') } },
    lookProfile: { integrity: { digest: hex('4') } }, assetManifest: { integrity: { digest: hex('5') }, },
    timeline: { items: [{ colorToken: 'color.primaryText' }], integrity: { digest: hex('8') } },
    dataOverlays: { overlays: [], integrity: { digest: hex('9') } }, finalRenderDigest: hex('a'),
  };
  const schedule = buildInspectionSchedule({ scenes: documents.sceneSchema.scenes });
  const proof = {
    schemaVersion: '1.0.0', revision: 1, producerCommand: 'render_final_proof_passes.mjs', encodedMp4Digest: hex('6'),
    authorities: { assetManifest: hex('5'), dataOverlays: hex('9'), designSystem: hex('3'), lookProfile: hex('4'), motionMap: hex('2'), sceneSchema: hex('1'), timeline: hex('8') },
    frames: schedule.map(({ time }, index) => ({ time,
      backgroundPass: { path: `review/final-proof-passes/${hex('6')}/background-${index}.png`, digest: hex('b') },
      layerMattes: [{ layerId: 'layer-title', path: `review/final-proof-passes/${hex('6')}/layer-${index}.png`, digest: hex('c') }],
      tokenMattes: [{ tokenName: 'color.primaryText', path: `review/final-proof-passes/${hex('6')}/token-${index}.png`, digest: hex('d'), alpha: 1 }],
    })), integrity: { digest: null, upstream: { FINAL_RENDER: hex('a') } },
  };
  proof.integrity.digest = computeArtifactDigest(proof);
  assert.equal(validateFinalPixelProof(proof, { encodedMp4Digest: hex('6'), documents, schedule }), proof);
  const stale = structuredClone(proof); stale.encodedMp4Digest = hex('7'); stale.integrity.digest = computeArtifactDigest(stale);
  assert.throws(() => validateFinalPixelProof(stale, { encodedMp4Digest: hex('6'), documents, schedule }), { code: 'E_FINAL_PIXEL_PROOF' });
  const incomplete = structuredClone(proof); incomplete.frames[0].layerMattes = []; incomplete.integrity.digest = computeArtifactDigest(incomplete);
  assert.throws(() => validateFinalPixelProof(incomplete, { encodedMp4Digest: hex('6'), documents, schedule }), { code: 'E_FINAL_PIXEL_PROOF' });
});

test('encoded analysis re-probes delivery, runs every FFmpeg detector, and measures controlled SSIM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hf-final-qc-'));
  try {
    const finalPath = join(root, 'final.mp4'); const chapterPath = join(root, 'chapter.mkv');
    await writeFile(finalPath, 'encoded-final'); await writeFile(chapterPath, 'identity-chapter');
    const digest = (value) => createHash('sha256').update(value).digest('hex');
    await writeFile(`${chapterPath}.json`, JSON.stringify({ cacheKey: 'chapter-key', outputDigest: digest('identity-chapter') }));
    const commands = [];
    const measurements = await analyzeEncodedMp4(finalPath, {
      outputDigest: digest('encoded-final'), raster: { width: 1920, height: 1080 }, fps: '30/1',
      closedFileProbe: { durationSeconds: 2, videoCodec: 'h264', audioCodec: 'aac' },
      chapterCache: [{ cacheKey: 'chapter-key', path: 'chapter.mkv', outputDigest: digest('identity-chapter') }],
    }, {
      project: root,
      editBrief: { duration: { minSeconds: 1, maxSeconds: 3 }, delivery: { videoCodec: 'h264', audioCodec: 'aac', width: 1920, height: 1080, aspectRatio: '16:9', container: 'mp4', maximumFileSizeBytes: null } },
      probe: { media: [{ mediaId: 'media-1', mediaType: 'video', streams: [{ type: 'video', colorSpace: 'bt709', colorPrimaries: 'bt709', colorTransfer: 'bt709' }] }] }, usedMediaIds: ['media-1'],
      ffprobe: async () => ({ format: { duration: '2', format_name: 'mov,mp4,m4a' }, streams: [
        { codec_type: 'video', width: 1920, height: 1080, sample_aspect_ratio: '1:1', avg_frame_rate: '30/1', duration: '2', codec_name: 'h264', pix_fmt: 'yuv420p', color_space: 'bt709', color_primaries: 'bt709', color_transfer: 'bt709' },
        { codec_type: 'audio', duration: '2', codec_name: 'aac' },
      ] }),
      runCommand: async (_command, args) => {
        commands.push(args.join(' '));
        if (args.join(' ').includes('ssim')) return { stderr: 'SSIM Y:0.99 All:0.987654 (19.3)' };
        if (args.join(' ').includes('ebur128')) return { stderr: 'I: -16.0 LUFS\nPeak level dB: -1.2' };
        return { stderr: '' };
      },
    });
    assert.equal(measurements.closedProbe.valid, true);
    assert.equal(measurements.identitySsim, .987654);
    for (const detector of ['blackdetect', 'freezedetect', 'ebur128', 'ssim']) assert.ok(commands.some((command) => command.includes(detector)), detector);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('real synthetic final executes black/freeze/audio/SSIM filters against closed bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hf-real-final-qc-'));
  try {
    const chapter = join(root, 'chapter.mkv'); const finalPath = join(root, 'final.mp4');
    await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=0.4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.4', '-shortest', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', chapter]);
    await runCommand('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', chapter, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', finalPath]);
    const chapterDigest = createHash('sha256').update(await readFile(chapter)).digest('hex');
    const finalDigest = createHash('sha256').update(await readFile(finalPath)).digest('hex');
    await writeFile(`${chapter}.json`, JSON.stringify({ cacheKey: 'real', outputDigest: chapterDigest }));
    const result = await analyzeEncodedMp4(finalPath, { outputDigest: finalDigest, raster: { width: 160, height: 90 }, fps: '30/1', closedFileProbe: { durationSeconds: .4, videoCodec: 'h264', audioCodec: 'aac' }, chapterCache: [{ cacheKey: 'real', path: 'chapter.mkv', outputDigest: chapterDigest }] }, {
      project: root, editBrief: { duration: { minSeconds: .3, maxSeconds: .5 }, delivery: { videoCodec: 'h264', audioCodec: 'aac', width: 160, height: 90, aspectRatio: '16:9', container: 'mp4', maximumFileSizeBytes: null } },
      probe: { media: [{ mediaId: 'media-real', mediaType: 'video', streams: [{ type: 'video', colorSpace: 'bt709', colorPrimaries: 'bt709', colorTransfer: 'bt709' }] }] }, usedMediaIds: ['media-real'],
    });
    assert.equal(result.closedProbe.valid, true); assert.ok(result.identitySsim > .95); assert.equal(Number.isFinite(result.integratedLufs), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('final pixel gates reread digest-bound composite, background, and matte image bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hf-pixel-proof-'));
  try {
    const folder = join(root, 'review/final-proof-passes', hex('6')); const frames = join(root, 'review/final-frames', hex('6'));
    await mkdir(folder, { recursive: true }); await mkdir(frames, { recursive: true });
    const composite = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#ffffff' } }).png().toBuffer();
    const background = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#000000' } }).png().toBuffer();
    const matte = await sharp({ create: { width: 10, height: 10, channels: 4, background: '#ffffff' } }).png().toBuffer();
    await writeFile(join(frames, 'frame-00000.png'), composite); await writeFile(join(folder, 'background.png'), background); await writeFile(join(folder, 'layer.png'), matte); await writeFile(join(folder, 'token.png'), matte);
    const ref = (name, bytes) => ({ path: `review/final-proof-passes/${hex('6')}/${name}.png`, digest: createHash('sha256').update(bytes).digest('hex') });
    const proof = { frames: [{ time: 0, backgroundPass: ref('background', background), layerMattes: [{ layerId: 'layer-title', ...ref('layer', matte) }], tokenMattes: [{ tokenName: 'color.primaryText', alpha: 1, ...ref('token', matte) }] }] };
    const layer = { layerId: 'layer-title', typographyRole: 'type.journeyTitle', subjectRect: [{ time: 0, x: 20, y: 20, width: 2, height: 2 }], quietZone: [{ time: 0, x: 0, y: 0, width: 10, height: 10 }] };
    const result = await measureProofPasses({ project: root, proof, schedule: [{ time: 0 }], compositePaths: [`review/final-frames/${hex('6')}/frame-00000.png`], documents: {
      sceneSchema: { scenes: [{ readableLayers: [layer] }] }, designSystem: { tokens: { colors: { 'color.primaryText': '#FFFFFF' }, typography: { 'type.journeyTitle': {} } } },
    } });
    assert.equal(result.contrast[0].pass, true); assert.equal(result.tokenColor[0].pass, true);
    await writeFile(join(folder, 'background.png'), composite);
    await assert.rejects(measureProofPasses({ project: root, proof, schedule: [{ time: 0 }], compositePaths: [`review/final-frames/${hex('6')}/frame-00000.png`], documents: { sceneSchema: { scenes: [{ readableLayers: [layer] }] }, designSystem: { tokens: { colors: { 'color.primaryText': '#FFFFFF' }, typography: { 'type.journeyTitle': {} } } } } }), { code: 'E_FINAL_PIXEL_PROOF' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('prepared final-inspection transaction restores the exact prior state and review set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hf-final-qc-recovery-'));
  try {
    await mkdir(join(root, 'cache'), { recursive: true }); await mkdir(join(root, 'review'), { recursive: true });
    const previousState = validFinalRenderState(); const previousFiles = { metrics: null, pack: null, report: 'prior report\n', page: null };
    await writeFile(join(root, 'PROJECT_STATE.json'), '{}\n'); await writeFile(join(root, 'review/REVIEW_REPORT.md'), 'partial report\n');
    const journal = { kind: 'final-inspection-transaction', schemaVersion: '1.0.0', previousState, previousFiles,
      next: { stateDigest: hex('1'), metricsDigest: hex('2'), packDigest: hex('3'), pageDigest: hex('4') }, integrity: { digest: null, upstream: { FINAL_RENDER: hex('5') } } };
    journal.integrity.digest = computeArtifactDigest(journal); await writeFile(join(root, 'cache/final-inspection.transaction.json'), JSON.stringify(journal));
    assert.equal(await recoverInspectionTransaction(root, {}, { rebuildWorkbench: async () => ({ ok: true }) }), true);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'PROJECT_STATE.json'), 'utf8')), previousState);
    assert.equal(await readFile(join(root, 'review/REVIEW_REPORT.md'), 'utf8'), 'prior report\n');
    await assert.rejects(readFile(join(root, 'cache/final-inspection.transaction.json')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('local contrast and token color use background and high-coverage matte samples', () => {
  const contrast = measureLocalContrast({ kind: 'critical-text', samples: [
    { time: 0, composite: [255, 255, 255, 255], background: [0, 0, 0, 255], matte: [255, 255, 255, 255] },
    { time: .1, composite: [245, 245, 245, 255], background: [10, 10, 10, 255], matte: [255, 255, 255, 255] },
  ] });
  assert.equal(contrast.pass, true);
  assert.ok(contrast.minimum >= 4.5);
  const token = measureRenderedTokenColor({ token: [255, 0, 0], samples: [
    { time: 0, composite: [128, 0, 0, 255], background: [0, 0, 0, 255], matte: [255, 255, 255, 255], alpha: .5 },
    { time: .1, composite: [200, 200, 200, 255], background: [0, 0, 0, 255], matte: [20, 20, 20, 255], alpha: 1 },
  ] });
  assert.equal(token.pass, true);
  assert.equal(token.interiorSamples, 1, 'anti-aliased/low-coverage edges are excluded');
});

test('all injected final-MP4 defects are hard failures before Agent review', () => {
  const defects = {
    closedProbe: { valid: false }, blackFramesSeconds: .5, freezeSpansSeconds: 1, clippedSamples: 2,
    integratedLufs: -5, avDriftSeconds: .2, identitySsim: .7, inputColorDeclared: false,
    contrast: [{ layerId: 'title', pass: false }], tokenColor: [{ token: 'color.accent', pass: false }],
    layoutCollisions: ['title/subject'], quietZoneLosses: ['title'], crossSceneConsistency: { pass: false },
  };
  const result = evaluateMachineGates(defects, { frameDurationSeconds: 1 / 30, loudness: { minimumLufs: -20, maximumLufs: -10 }, minimumIdentitySsim: .95 });
  assert.equal(result.pass, false);
  assert.deepEqual(new Set(result.failures.map(({ code }) => code)), new Set([
    'closed_file_probe', 'black_frames', 'freeze_spans', 'audio_clipping', 'loudness', 'av_drift', 'detail_loss',
    'input_color_profile', 'local_contrast', 'token_color', 'layout_collision', 'quiet_zone_loss', 'cross_scene_consistency',
  ]));
  assert.equal(result.agentReviewAllowed, false);
  const missing = evaluateMachineGates({ closedProbe: { valid: true }, blackFramesSeconds: 0, freezeSpansSeconds: 0, clippedSamples: 0, inputColorDeclared: true, layoutCollisions: [], quietZoneLosses: [], crossSceneConsistency: { pass: true } }, { loudness: { minimumLufs: -20, maximumLufs: -10 } });
  assert.deepEqual(new Set(missing.failures.map(({ code }) => code)), new Set(['loudness', 'av_drift', 'detail_loss', 'local_contrast', 'token_color']));
});

test('repair decisions allow bounded layout/decorative fixes and block fourth or frozen-token changes', () => {
  const history = [{ gate: 'local_contrast' }, { gate: 'local_contrast' }, { gate: 'local_contrast' }];
  assert.deepEqual(reviewRepairDecision({ repairClass: 'position', role: 'MOTION_MAP' }, { gate: 'layout_collision', history: [] }), { allowed: true, code: 'repair_allowed', invalidatedRoles: ['MOTION_MAP', 'TIMELINE', 'FINAL_RENDER', 'REVIEW'] });
  assert.equal(reviewRepairDecision({ repairClass: 'remove-optional-decorative', role: 'decorative', optional: true }, { gate: 'role_failure', history: [] }).allowed, true);
  assert.equal(reviewRepairDecision({ repairClass: 'position', role: 'MOTION_MAP' }, { gate: 'local_contrast', history }).code, 'repair_budget_exhausted');
  assert.equal(reviewRepairDecision({ repairClass: 'token', role: 'DESIGN_SYSTEM' }, { gate: 'token_color', history: [] }).code, 'approval_boundary_crossed');
  const context = { gate: 'layout_collision', reason: 'move title outside subject bounds', timestamp: '2026-09-03T02:00:00.000Z', history: [], beforeDigests: { MOTION_MAP: hex('1') }, afterDigests: { MOTION_MAP: hex('2') } };
  const applied = applyInspectionRepair(validFinalRenderState(), { repairClass: 'position', role: 'MOTION_MAP' }, context);
  assert.equal(applied.repair.attempt, 1);
  assert.deepEqual(applied.rerunRoles, ['MOTION_MAP', 'TIMELINE', 'FINAL_RENDER', 'REVIEW']);
  assert.equal(applied.projectState.state, 'ASSET_PRODUCTION');
  const decorative = applyInspectionRepair(validFinalRenderState(), { repairClass: 'remove-optional-decorative', role: 'decorative', optional: true }, { ...context, gate: 'role_failure', beforeDigests: { ASSET_MANIFEST: hex('3') }, afterDigests: { ASSET_MANIFEST: hex('4') } });
  assert.ok(decorative.projectState.revision > validFinalRenderState().revision);
});

test('clean encoded evidence reaches contract-valid DELIVERED without inferring USER_ACCEPTED; defects block', async () => {
  const clean = evaluateMachineGates({
    closedProbe: { valid: true }, blackFramesSeconds: 0, freezeSpansSeconds: 0, clippedSamples: 0,
    integratedLufs: -16, avDriftSeconds: 0, identitySsim: 1, inputColorDeclared: true,
    contrast: [{ pass: true }], tokenColor: [{ pass: true }], layoutCollisions: [], quietZoneLosses: [], crossSceneConsistency: { pass: true },
  }, { frameDurationSeconds: 1 / 30, loudness: { minimumLufs: -20, maximumLufs: -10 }, minimumIdentitySsim: .95 });
  assert.equal(clean.pass, true);
  const state = validFinalRenderState();
  const metrics = { revision: 1, status: 'accepted', agentInspection: { status: 'accepted', evidencePaths: ['review/final-frames/frame-00000.png'] }, integrity: { digest: 'b'.repeat(64), upstream: {} } };
  const committed = commitInspectionStates(state, metrics, '2026-09-03T01:00:00.000Z');
  assert.equal(committed.finalQa.state, 'FINAL_QA');
  assert.equal(committed.delivered.state, 'DELIVERED');
  assert.notEqual(committed.delivered.state, 'USER_ACCEPTED');
  const schema = await loadSchema('project-state');
  assert.equal(validateDocument(schema, committed.finalQa).valid, true);
  assert.equal(validateDocument(schema, committed.delivered).valid, true);
  const rejected = { ...metrics, status: 'rejected', agentInspection: { status: 'unavailable', evidencePaths: [] }, integrity: { digest: null, upstream: {} } };
  rejected.integrity.digest = computeArtifactDigest(rejected);
  assert.equal(commitInspectionBlockedState(state, rejected, '2026-09-03T01:00:00.000Z').state, 'BLOCKED');
});
