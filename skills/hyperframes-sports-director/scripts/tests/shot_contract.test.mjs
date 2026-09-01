import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generateFixtures } from '../../evals/fixtures/generate-fixtures.mjs';
import { computeArtifactDigest } from '../lib/contracts.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(command, args) {
  const env = { ...process.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_TEST_CONTEXT']) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function fixture() {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-shots-'));
  const input = join(scratch, 'private-input'); const project = join(scratch, 'project');
  await mkdir(input);
  for (const directory of ['analysis', 'cache', 'media/proxies', 'review/probe']) await mkdir(join(project, directory), { recursive: true });
  await generateFixtures(input);
  for (const script of ['ingest_media.mjs', 'probe_media.mjs', 'build_proxies.mjs', 'segment_media.mjs']) {
    const result = await run(process.execPath, [join(SKILL, 'scripts', script), '--project', project, '--input', input]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
  }
  return { project };
}

function agentEnvelope(segments) {
  const segment = segments.segments.find(({ mediaType }) => mediaType === 'video');
  const envelope = {
    $schema: 'https://hyperframes.local/schemas/shot.schema.json', schemaVersion: '1.0.0', revision: 1, status: 'available',
    shots: [{
      shotId: 'shot-001', mediaId: segment.mediaId, segmentId: segment.segmentId, sourceDigest: segment.sourceDigest,
      sourceInSeconds: segment.sourceInSeconds, sourceOutSeconds: segment.sourceOutSeconds, sourceDurationSeconds: segment.sourceDurationSeconds,
      cameraRole: 'unknown', actionRole: 'unknown', environmentTags: ['unknown'], subjectTags: ['unknown'],
      quality: { motionIntensity: 'unknown', blur: 'unknown', shake: 'unknown', exposure: 'unknown', horizon: 'unknown', occlusion: 'unknown' },
      continuity: { screenDirection: 'unknown', motionDirection: 'unknown', subjectEntry: 'unknown', subjectExit: 'unknown', location: 'unknown', timeRelation: 'unknown' },
      audioSpans: [{ kind: 'ambient', sourceInSeconds: segment.sourceInSeconds, sourceOutSeconds: segment.sourceOutSeconds }],
      duplicateGroup: null, setupTailLikelihood: 0.1, evidenceFrames: segment.evidenceFrames.map(({ path }) => path), confidence: 0.1,
    }],
    integrity: { digest: null, upstream: { probe: segments.integrity.upstream.probe, segments: segments.integrity.digest } },
  };
  envelope.integrity.digest = computeArtifactDigest(envelope);
  return envelope;
}

test('validate_shots accepts exactly one Agent-authored envelope with unknown low-confidence semantics and exact current lineage', async () => {
  const { project } = await fixture();
  const segments = JSON.parse(await readFile(join(project, 'analysis', 'SEGMENTS.json'), 'utf8'));
  const envelope = agentEnvelope(segments);
  const shotsPath = join(project, 'analysis', 'SHOTS.jsonl');
  await writeFile(shotsPath, `${JSON.stringify(envelope)}\n`);
  const result = await run(process.execPath, [join(SKILL, 'scripts', 'validate_shots.mjs'), '--project', project, '--shots', shotsPath]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).valid, true);
  assert.equal((await readFile(shotsPath, 'utf8')).split('\n').filter(Boolean).length, 1, 'SHOTS remains one canonical JSONL envelope');
});

test('validate_shots rejects invented semantics, out-of-segment bounds, unreferenced evidence, and stale upstream digests', async () => {
  const { project } = await fixture();
  const segments = JSON.parse(await readFile(join(project, 'analysis', 'SEGMENTS.json'), 'utf8'));
  const mutations = [
    (value) => { value.shots[0].cameraRole = 'drone'; },
    (value) => { value.shots[0].sourceOutSeconds += 1; },
    (value) => { value.shots[0].evidenceFrames = ['analysis/evidence/not-a-real-frame.webp']; },
    (value) => { value.integrity.upstream.probe = 'f'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(agentEnvelope(segments));
    mutate(value);
    value.integrity.digest = computeArtifactDigest(value);
    const shotsPath = join(project, 'analysis', 'SHOTS.jsonl');
    await writeFile(shotsPath, `${JSON.stringify(value)}\n`);
    const result = await run(process.execPath, [join(SKILL, 'scripts', 'validate_shots.mjs'), '--project', project, '--shots', shotsPath]);
    assert.equal(result.code, 1, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).valid, false);
  }
});

test('validate_shots rejects an integrity-valid segment that exceeds its probed source duration', async () => {
  const { project } = await fixture();
  const segmentsPath = join(project, 'analysis', 'SEGMENTS.json');
  const segments = JSON.parse(await readFile(segmentsPath, 'utf8'));
  const segment = segments.segments.find(({ mediaType }) => mediaType === 'video');
  segment.sourceDurationSeconds += 1;
  segment.sourceOutSeconds = segment.sourceDurationSeconds;
  segments.integrity.digest = computeArtifactDigest(segments);
  await writeFile(segmentsPath, `${JSON.stringify(segments, null, 2)}\n`);
  const envelope = agentEnvelope(segments);
  envelope.integrity.upstream.segments = segments.integrity.digest;
  envelope.integrity.digest = computeArtifactDigest(envelope);
  const shotsPath = join(project, 'analysis', 'SHOTS.jsonl');
  await writeFile(shotsPath, `${JSON.stringify(envelope)}\n`);
  const result = await run(process.execPath, [join(SKILL, 'scripts', 'validate_shots.mjs'), '--project', project, '--shots', shotsPath]);
  assert.equal(result.code, 1, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).valid, false);
});

test('validate_shots requires low confidence when any declared semantic field is exactly unknown', async () => {
  const { project } = await fixture();
  const segments = JSON.parse(await readFile(join(project, 'analysis', 'SEGMENTS.json'), 'utf8'));
  const mutations = [
    (shot) => { shot.cameraRole = 'unknown'; },
    (shot) => { shot.actionRole = 'unknown'; },
    (shot) => { shot.quality.blur = 'unknown'; },
    (shot) => { shot.continuity.motionDirection = 'unknown'; },
    (shot) => { shot.continuity.location = 'unknown'; },
    (shot) => { shot.environmentTags = ['unknown']; },
    (shot) => { shot.subjectTags = ['unknown']; },
    (shot) => { shot.audioSpans[0].kind = 'unknown'; },
  ];
  for (const mutate of mutations) {
    const value = agentEnvelope(segments);
    value.shots[0].cameraRole = 'wide';
    value.shots[0].actionRole = 'move';
    value.shots[0].quality = { motionIntensity: 'medium', blur: 'none', shake: 'minor', exposure: 'good', horizon: 'level', occlusion: 'none' };
    value.shots[0].continuity = { screenDirection: 'static', motionDirection: 'static', subjectEntry: 'none', subjectExit: 'none', location: 'known route', timeRelation: 'continuous' };
    value.shots[0].environmentTags = ['road'];
    value.shots[0].subjectTags = ['rider'];
    value.shots[0].audioSpans[0].kind = 'ambient';
    value.shots[0].confidence = 0.9;
    mutate(value.shots[0]);
    value.integrity.digest = computeArtifactDigest(value);
    const shotsPath = join(project, 'analysis', 'SHOTS.jsonl');
    await writeFile(shotsPath, `${JSON.stringify(value)}\n`);
    const result = await run(process.execPath, [join(SKILL, 'scripts', 'validate_shots.mjs'), '--project', project, '--shots', shotsPath]);
    assert.equal(result.code, 1, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).valid, false);
  }

  const literal = agentEnvelope(segments);
  literal.shots[0].cameraRole = 'wide';
  literal.shots[0].actionRole = 'move';
  literal.shots[0].quality = { motionIntensity: 'medium', blur: 'none', shake: 'minor', exposure: 'good', horizon: 'level', occlusion: 'none' };
  literal.shots[0].continuity = { screenDirection: 'static', motionDirection: 'static', subjectEntry: 'none', subjectExit: 'none', location: 'unknown terrain landmark', timeRelation: 'continuous' };
  literal.shots[0].environmentTags = ['unknownish-road'];
  literal.shots[0].subjectTags = ['rider'];
  literal.shots[0].confidence = 0.9;
  literal.integrity.digest = computeArtifactDigest(literal);
  const literalPath = join(project, 'analysis', 'SHOTS.jsonl');
  await writeFile(literalPath, `${JSON.stringify(literal)}\n`);
  const literalResult = await run(process.execPath, [join(SKILL, 'scripts', 'validate_shots.mjs'), '--project', project, '--shots', literalPath]);
  assert.equal(literalResult.code, 0, literalResult.stderr || literalResult.stdout);
});

test('validate_shots requires each segment evidence entity to be in-shot, present, and decodable', async () => {
  const { project } = await fixture();
  const segments = JSON.parse(await readFile(join(project, 'analysis', 'SEGMENTS.json'), 'utf8'));
  const timing = agentEnvelope(segments);
  const segment = segments.segments.find(({ segmentId }) => segmentId === timing.shots[0].segmentId);
  timing.shots[0].sourceInSeconds = segment.evidenceFrames[0].sourceTimeSeconds + 0.1;
  timing.shots[0].audioSpans[0].sourceInSeconds = timing.shots[0].sourceInSeconds;
  timing.integrity.digest = computeArtifactDigest(timing);
  const shotsPath = join(project, 'analysis', 'SHOTS.jsonl');
  await writeFile(shotsPath, `${JSON.stringify(timing)}\n`);
  const timingResult = await run(process.execPath, [join(SKILL, 'scripts', 'validate_shots.mjs'), '--project', project, '--shots', shotsPath]);
  assert.equal(timingResult.code, 1, timingResult.stderr || timingResult.stdout);
  assert.equal(JSON.parse(timingResult.stdout).valid, false);

  for (const corrupt of [
    async (path) => rm(path),
    async (path) => writeFile(path, 'not an image'),
  ]) {
    const isolated = await fixture();
    const isolatedSegments = JSON.parse(await readFile(join(isolated.project, 'analysis', 'SEGMENTS.json'), 'utf8'));
    const value = agentEnvelope(isolatedSegments);
    const evidencePath = join(isolated.project, value.shots[0].evidenceFrames[0]);
    await corrupt(evidencePath);
    const isolatedShotsPath = join(isolated.project, 'analysis', 'SHOTS.jsonl');
    await writeFile(isolatedShotsPath, `${JSON.stringify(value)}\n`);
    const result = await run(process.execPath, [join(SKILL, 'scripts', 'validate_shots.mjs'), '--project', isolated.project, '--shots', isolatedShotsPath]);
    assert.equal(result.code, 1, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).valid, false);
  }
});
