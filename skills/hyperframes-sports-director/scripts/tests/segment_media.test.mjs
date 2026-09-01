import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generateFixtures } from '../../evals/fixtures/generate-fixtures.mjs';
import { validateArtifact } from '../lib/contracts.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_TEST_CONTEXT'];

function run(command, args) {
  const env = { ...process.env };
  for (const key of PROXY_KEYS) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runCli(script, project, input) {
  return run(process.execPath, [join(SKILL, 'scripts', script), '--project', project, '--input', input]);
}

async function preparedProject() {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-segments-'));
  const input = join(scratch, 'private-input');
  const project = join(scratch, 'project');
  await mkdir(input);
  for (const directory of ['analysis', 'cache', 'media/proxies', 'review/probe']) await mkdir(join(project, directory), { recursive: true });
  await generateFixtures(input);
  for (const script of ['ingest_media.mjs', 'probe_media.mjs', 'build_proxies.mjs']) {
    const result = await runCli(script, project, input);
    assert.equal(result.code, 0, result.stderr || result.stdout);
  }
  return { scratch, input, project };
}

test('segment_media deterministically writes bounded mechanical segments and review-safe evidence from Task 6 media', async () => {
  const { input, project } = await preparedProject();
  const first = await runCli('segment_media.mjs', project, input);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.equal(first.stderr, '');
  assert.equal(JSON.parse(first.stdout).artifact, 'analysis/SEGMENTS.json');

  const segmentsPath = join(project, 'analysis', 'SEGMENTS.json');
  assert.equal((await validateArtifact(segmentsPath, 'segments')).valid, true);
  const document = JSON.parse(await readFile(segmentsPath, 'utf8'));
  assert.equal(document.integrity.upstream.probe.length, 64);
  assert.ok(document.segments.length >= 3, 'video and still review evidence are represented');
  for (const segment of document.segments) {
    assert.ok(segment.sourceInSeconds >= 0);
    assert.ok(segment.sourceOutSeconds > segment.sourceInSeconds);
    assert.ok(segment.sourceOutSeconds <= segment.sourceDurationSeconds);
    assert.match(segment.reviewPath, new RegExp(`^analysis/evidence/${segment.mediaId}/${segment.segmentId}\\.webp$`));
    assert.equal(segment.reviewPath.includes(input), false);
    assert.equal(await stat(join(project, segment.reviewPath)).then(() => true), true);
    assert.ok(segment.sceneScore >= 0 && segment.sceneScore <= 1);
    assert.ok(segment.motionScore >= 0 && segment.motionScore <= 1);
    assert.equal(typeof segment.audioPresent, 'boolean');
    assert.ok(segment.evidenceFrames.length >= 1 && segment.evidenceFrames.length <= 4);
    for (const frame of segment.evidenceFrames) {
      assert.match(frame.path, new RegExp(`^analysis/evidence/${segment.mediaId}/${segment.segmentId}/evidence-${segment.mediaId}-${segment.segmentId}-frame-[0-9]{3}\\.webp$`));
      assert.ok(frame.sourceTimeSeconds >= segment.sourceInSeconds && frame.sourceTimeSeconds <= segment.sourceOutSeconds);
      assert.equal(await stat(join(project, frame.path)).then(() => true), true);
    }
  }
  const still = document.segments.find((segment) => segment.mediaType === 'image');
  assert.ok(still, 'still images create normalised evidence');
  assert.equal(still.evidenceFrames.length, 1);

  const firstBoundaries = document.segments.map(({ segmentId, mediaId, sourceInSeconds, sourceOutSeconds, evidenceFrames }) => ({
    segmentId, mediaId, sourceInSeconds, sourceOutSeconds, evidenceFrames: evidenceFrames.map(({ sourceTimeSeconds }) => sourceTimeSeconds),
  }));
  const second = await runCli('segment_media.mjs', project, input);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  const rerun = JSON.parse(await readFile(segmentsPath, 'utf8'));
  assert.deepEqual(rerun.segments.map(({ segmentId, mediaId, sourceInSeconds, sourceOutSeconds, evidenceFrames }) => ({
    segmentId, mediaId, sourceInSeconds, sourceOutSeconds, evidenceFrames: evidenceFrames.map(({ sourceTimeSeconds }) => sourceTimeSeconds),
  })), firstBoundaries, 'segment boundaries and sample timestamps are deterministic');
});

test('build_contact_sheets places review-safe IDs and timecodes in gutters without exposing private input names', async () => {
  const { input, project } = await preparedProject();
  assert.equal((await runCli('segment_media.mjs', project, input)).code, 0);
  const segments = JSON.parse(await readFile(join(project, 'analysis', 'SEGMENTS.json'), 'utf8'));
  const firstSegment = segments.segments.find(({ mediaType }) => mediaType === 'video');
  const shots = {
    $schema: 'https://hyperframes.local/schemas/shot.schema.json', schemaVersion: '1.0.0', revision: 1, status: 'available',
    shots: [{
      shotId: 'shot-001', mediaId: firstSegment.mediaId, segmentId: firstSegment.segmentId,
      sourceDigest: firstSegment.sourceDigest, sourceInSeconds: firstSegment.sourceInSeconds,
      sourceOutSeconds: firstSegment.sourceOutSeconds, sourceDurationSeconds: firstSegment.sourceDurationSeconds,
      cameraRole: 'unknown', actionRole: 'unknown', environmentTags: ['unknown'], subjectTags: ['unknown'],
      quality: { motionIntensity: 'unknown', blur: 'unknown', shake: 'unknown', exposure: 'unknown', horizon: 'unknown', occlusion: 'unknown' },
      continuity: { screenDirection: 'unknown', motionDirection: 'unknown', subjectEntry: 'unknown', subjectExit: 'unknown', location: 'unknown', timeRelation: 'unknown' },
      audioSpans: [], duplicateGroup: null, setupTailLikelihood: 0.1,
      evidenceFrames: firstSegment.evidenceFrames.map(({ path }) => path), confidence: 0.1,
    }],
    integrity: { digest: null, upstream: { probe: segments.integrity.upstream.probe, segments: segments.integrity.digest } },
  };
  const write = await run(process.execPath, [join(SKILL, 'scripts', 'validate_shots.mjs'), '--project', project, '--shots', join(project, 'analysis', 'SHOTS.jsonl')]);
  assert.notEqual(write.code, 0, 'the validator must reject an absent Agent envelope before a contact sheet exists');
  const { computeArtifactDigest } = await import('../lib/contracts.mjs');
  shots.integrity.digest = computeArtifactDigest(shots);
  await (await import('node:fs/promises')).writeFile(join(project, 'analysis', 'SHOTS.jsonl'), `${JSON.stringify(shots)}\n`);
  const validated = await run(process.execPath, [join(SKILL, 'scripts', 'validate_shots.mjs'), '--project', project, '--shots', join(project, 'analysis', 'SHOTS.jsonl')]);
  assert.equal(validated.code, 0, validated.stderr || validated.stdout);

  const result = await run(process.execPath, [join(SKILL, 'scripts', 'build_contact_sheets.mjs'), '--project', project]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.contactSheets, 1);
  assert.match(output.artifacts[0], /^review\/contact-sheets\/shot-001\.webp$/);
  assert.equal(await stat(join(project, output.artifacts[0])).then(() => true), true);
  const files = await readdir(join(project, 'review', 'contact-sheets'));
  assert.deepEqual(files, ['shot-001.webp']);
});
