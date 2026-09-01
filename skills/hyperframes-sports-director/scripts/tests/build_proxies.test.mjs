import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { generateFixtures } from '../../evals/fixtures/generate-fixtures.mjs';
import { assertFinalSource } from '../lib/media.mjs';
import { validateArtifact } from '../lib/contracts.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(command, args) {
  const env = { ...process.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_TEST_CONTEXT']) delete env[key];
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

async function runCli(script, project, input) {
  return run(process.execPath, [join(SKILL, 'scripts', script), '--project', project, '--input', input]);
}

test('build_proxies creates watermarked timestamp-preserving analysis media with original time mappings', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-proxies-'));
  const input = join(scratch, 'private-input');
  const project = join(scratch, 'project');
  await mkdir(input);
  for (const directory of ['analysis', 'cache', 'media/proxies', 'review/probe']) await mkdir(join(project, directory), { recursive: true });
  await generateFixtures(input);
  for (const script of ['ingest_media.mjs', 'probe_media.mjs']) {
    const prerequisite = await runCli(script, project, input);
    assert.equal(prerequisite.code, 0, prerequisite.stderr || prerequisite.stdout);
  }

  const result = await runCli('build_proxies.mjs', project, input);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).built, 7);

  const probePath = join(project, 'analysis', 'PROBE.json');
  assert.equal((await validateArtifact(probePath, 'probe')).valid, true);
  const document = JSON.parse(await readFile(probePath, 'utf8'));
  assert.ok(document.media.every(({ proxy }) => proxy !== null));
  const video = document.media.find((entry) => entry.captureTimestamp === '2026-09-01T12:00:00.000Z');
  assert.equal(video.proxy.sourceDigest, video.sourceDigest);
  assert.equal(video.proxy.kind, 'video');
  assert.equal(video.proxy.transform.watermark, 'ANALYSIS PROXY');
  assert.equal(video.proxy.transform.preserveTimestamps, true);
  assert.equal(video.proxy.transform.preserveAudio, true);
  assert.deepEqual(video.proxy.timeMapping, [{ proxyStartSeconds: 0, originalStartSeconds: 0, durationSeconds: video.durationSeconds, rate: '1/1' }]);
  assert.equal(isAbsolute(video.proxy.path), false);
  assert.ok((await stat(join(project, video.proxy.path))).size > 0);

  const proxyProbe = await run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', join(project, video.proxy.path)]);
  assert.equal(proxyProbe.code, 0, proxyProbe.stderr);
  const encodedProxy = JSON.parse(proxyProbe.stdout);
  const proxyStreams = encodedProxy.streams;
  assert.ok(proxyStreams.some(({ codec_type }) => codec_type === 'video'));
  assert.ok(proxyStreams.some(({ codec_type }) => codec_type === 'audio'));
  assert.equal(Number(encodedProxy.format.start_time), 0);
  assert.ok(Math.abs(Number(encodedProxy.format.duration) - video.durationSeconds) < 0.1);

  const visibleWatermark = await run('ffmpeg', [
    '-hide_banner', '-v', 'info', '-ss', '0.25', '-i', join(input, '20260901T120000Z-main.mp4'),
    '-ss', '0.25', '-i', join(project, video.proxy.path),
    '-filter_complex', '[0:v]scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2[original];[original]crop=265:44:18:658[o];[1:v]crop=265:44:18:658[p];[o][p]ssim',
    '-frames:v', '1', '-f', 'null', '-',
  ]);
  assert.equal(visibleWatermark.code, 0, visibleWatermark.stderr);
  const watermarkSsim = /All:([0-9.]+)/.exec(visibleWatermark.stderr);
  assert.ok(watermarkSsim && Number(watermarkSsim[1]) < 0.9, visibleWatermark.stderr);

  const portrait = document.media.find((entry) => entry.captureTimestamp === '2026-09-01T12:03:00.000Z');
  assert.equal(portrait.proxy.kind, 'image');
  assert.equal(portrait.proxy.transform.autoOrient, true);
  const stillProbe = await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', join(project, portrait.proxy.path)]);
  assert.equal(stillProbe.code, 0, stillProbe.stderr);
  const still = JSON.parse(stillProbe.stdout).streams[0];
  assert.equal(still.width / still.height, 120 / 160);

  assert.throws(() => assertFinalSource(join(project, 'media/proxies', 'media-test.mp4'), project), (error) => error.code === 'E_PROXY_FINAL_SOURCE');
  assert.throws(() => assertFinalSource(join(project, 'review/probe', 'media-test.webp'), project), (error) => error.code === 'E_ANALYSIS_DERIVATIVE_FINAL_SOURCE');
  assert.throws(() => assertFinalSource(join(project, 'analysis/evidence', 'frame.webp'), project), (error) => error.code === 'E_ANALYSIS_DERIVATIVE_FINAL_SOURCE');
  const disguisedProxy = join(scratch, 'apparently-original.mp4');
  await symlink(join(project, video.proxy.path), disguisedProxy);
  assert.throws(() => assertFinalSource(disguisedProxy, project), (error) => error.code === 'E_PROXY_FINAL_SOURCE');
  assert.equal(assertFinalSource(join(input, '20260901T120000Z-main.mp4'), project), join(input, '20260901T120000Z-main.mp4'));
});
