import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generateFixtures } from '../../evals/fixtures/generate-fixtures.mjs';
import { computeArtifactDigest, validateArtifact } from '../lib/contracts.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function runCli(script, project, input) {
  const env = { ...process.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_TEST_CONTEXT']) delete env[key];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(SKILL, 'scripts', script), '--project', project, '--input', input], {
      shell: false, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
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

test('probe_media records normalized rational stream facts, rotation, color, and capture time without private names', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-probe-'));
  const input = join(scratch, 'private-input');
  const project = join(scratch, 'project');
  await mkdir(input);
  await mkdir(join(project, 'analysis'), { recursive: true });
  await mkdir(join(project, 'cache'), { recursive: true });
  await generateFixtures(input);
  const ingest = await runCli('ingest_media.mjs', project, input);
  assert.equal(ingest.code, 0, ingest.stderr || ingest.stdout);

  const result = await runCli('probe_media.mjs', project, input);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).probed, 7);

  const probePath = join(project, 'analysis', 'PROBE.json');
  assert.equal((await validateArtifact(probePath, 'probe')).valid, true);
  const document = JSON.parse(await readFile(probePath, 'utf8'));
  assert.equal(document.media.length, 7);
  const main = document.media.find((entry) => entry.captureTimestamp === '2026-09-01T12:00:00.000Z');
  const mainVideo = main.streams.find(({ type }) => type === 'video');
  assert.equal(main.mediaType, 'video');
  assert.equal(mainVideo.frameRate, '30000/1001');
  assert.match(mainVideo.timeBase, /^[1-9][0-9]*\/[1-9][0-9]*$/);
  assert.equal(mainVideo.width, 320);
  assert.equal(mainVideo.height, 180);
  assert.equal(typeof mainVideo.pixelFormat, 'string');
  assert.ok(main.streams.some(({ type, sampleRate, channels, channelLayout }) => type === 'audio' && sampleRate === 48000 && channels >= 1 && typeof channelLayout === 'string'));

  const rotated = document.media.find((entry) => entry.captureTimestamp === '2026-09-01T12:01:00.000Z');
  assert.equal(rotated.streams.find(({ type }) => type === 'video').rotationDegrees, 90);
  const landscape = document.media.find((entry) => entry.captureTimestamp === '2026-09-01T12:02:00.000Z');
  assert.equal(landscape.mediaType, 'image');
  assert.deepEqual([landscape.streams[0].width, landscape.streams[0].height], [160, 90]);
  assert.equal(landscape.durationSeconds, null);
  assert.ok(Object.hasOwn(landscape.streams[0], 'colorSpace'));
  assert.ok(Object.hasOwn(landscape.streams[0], 'colorPrimaries'));
  assert.ok(Object.hasOwn(landscape.streams[0], 'colorTransfer'));
  assert.ok(Object.hasOwn(landscape.streams[0], 'colorRange'));

  const portableText = JSON.stringify(document);
  assert.equal(portableText.includes(input), false);
  for (const privateName of ['main.mp4', 'rotated.mov', 'photo.jpg', 'portrait.png', 'tone.wav', 'music.m4a']) {
    assert.equal(portableText.includes(privateName), false);
  }
  const rawFiles = await readdir(join(project, 'cache', 'probe', 'raw'));
  assert.equal(rawFiles.length, 7);
  assert.ok(rawFiles.every((name) => /^media-[0-9a-f]{16}-[0-9]{3}\.ffprobe\.json$/.test(name)));

  const indexPath = join(project, 'analysis', 'MEDIA_INDEX.json');
  const truncatedIndex = JSON.parse(await readFile(indexPath, 'utf8'));
  truncatedIndex.entries.splice(truncatedIndex.entries.findIndex(({ mediaType }) => mediaType === 'video'), 1);
  truncatedIndex.integrity.digest = computeArtifactDigest(truncatedIndex);
  await writeFile(indexPath, `${JSON.stringify(truncatedIndex, null, 2)}\n`);
  const staleLineage = await runCli('probe_media.mjs', project, input);
  assert.equal(staleLineage.code, 1, staleLineage.stderr || staleLineage.stdout);
  assert.equal(JSON.parse(staleLineage.stdout).error.code, 'E_SOURCE_LINEAGE');
});
