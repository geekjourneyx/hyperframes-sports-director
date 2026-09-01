import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

function cleanEnv() {
  const env = { ...process.env };
  for (const key of PROXY_KEYS) delete env[key];
  return env;
}

function runCli(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(SKILL, 'scripts', script), ...args], {
      shell: false, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'],
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

async function snapshot(root) {
  const records = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else {
        const metadata = await stat(path);
        const digest = createHash('sha256').update(await readFile(path)).digest('hex');
        records.push([path.slice(root.length + 1), metadata.mode, metadata.size, metadata.mtimeMs, digest]);
      }
    }
  }
  await visit(root);
  return records.sort(([a], [b]) => a.localeCompare(b));
}

test('ingest_media recursively indexes immutable mixed media without leaking source locators', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-ingest-'));
  const input = join(scratch, 'private-input');
  const project = join(scratch, 'project');
  await mkdir(input);
  await mkdir(join(project, 'analysis'), { recursive: true });
  await mkdir(join(project, 'cache'), { recursive: true });
  await generateFixtures(input);
  const before = await snapshot(input);

  const result = await runCli('ingest_media.mjs', ['--project', project, '--input', input]);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.unsupported, 1);

  const after = await snapshot(input);
  assert.deepEqual(after, before, 'scan must not mutate any input path, metadata, or bytes');
  const artifactPath = join(project, 'analysis', 'MEDIA_INDEX.json');
  assert.equal((await validateArtifact(artifactPath, 'media-index')).valid, true);
  const document = JSON.parse(await readFile(artifactPath, 'utf8'));
  assert.deepEqual(
    Object.fromEntries([...new Set(document.entries.map(({ mediaType }) => mediaType))].sort().map((type) => [type, document.entries.filter((entry) => entry.mediaType === type).length])),
    { activity: 2, audio: 2, image: 3, sidecar: 1, unsupported: 1, video: 2 },
  );
  assert.equal(document.entries.length, 11);
  assert.equal(new Set(document.entries.map(({ mediaId }) => mediaId)).size, 11);
  assert.ok(document.entries.every(({ mediaId, sourceDigest, portablePath, sourceRootReadOnly }) => (
    /^media-[0-9a-f]{16}-[0-9]{3}$/.test(mediaId)
      && /^[0-9a-f]{64}$/.test(sourceDigest)
      && portablePath.startsWith(`media/originals/${mediaId}.`)
      && sourceRootReadOnly === true
  )));
  const portableText = JSON.stringify(document);
  assert.equal(portableText.includes(input), false);
  for (const [relativePath] of before) assert.equal(portableText.includes(relativePath.split('/').at(-1)), false);

  const registry = JSON.parse(await readFile(join(project, 'cache', 'source-registry.json'), 'utf8'));
  assert.equal(registry.portable, false);
  assert.equal(registry.inputRoot, input);
  assert.equal(registry.entries.length, 11);
  assert.ok(registry.entries.every(({ mediaId, sourceDigest, sourcePath }) => (
    document.entries.some((entry) => entry.mediaId === mediaId && entry.sourceDigest === sourceDigest)
      && sourcePath.startsWith(`${input}/`)
  )));

  const mainPath = join(input, '20260901T120000Z-main.mp4');
  const expectedDigest = createHash('sha256').update(await readFile(mainPath)).digest('hex');
  const mainRegistry = registry.entries.find(({ sourcePath }) => sourcePath === mainPath);
  assert.equal(document.entries.find(({ mediaId }) => mediaId === mainRegistry.mediaId).sourceDigest, expectedDigest);
});
