import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkRelease,
  createReleaseArchive,
  listArchiveEntries,
} from '../check_release.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');

test('v1 release gate validates metadata and builds one clean Skill archive', async () => {
  const result = await checkRelease(repoRoot, { version: '1.0.0' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.version, '1.0.0');
  assert.deepEqual(result.goldenScores, {
    cycling: 100,
    hiking: 100,
    'pool-swimming': 100,
  });
  assert.deepEqual(result.icons, {
    small: { path: 'assets/icons/icon-small.png', width: 64, height: 64 },
    large: { path: 'assets/icons/icon-large.png', width: 1024, height: 1024 },
  });

  const output = await mkdtemp(join(tmpdir(), 'hf-release-'));
  try {
    const archive = await createReleaseArchive(repoRoot, { version: '1.0.0', output });
    assert.equal(basename(archive.path), 'hyperframes-sports-director-v1.0.0.skill');
    assert.match(await readFile(archive.checksumPath, 'utf8'), /^[a-f0-9]{64}  hyperframes-sports-director-v1\.0\.0\.skill\n$/);

    const entries = await listArchiveEntries(archive.path);
    assert.ok(entries.length > 20);
    assert.ok(entries.every((entry) => entry.startsWith('hyperframes-sports-director/')));
    assert.ok(entries.includes('hyperframes-sports-director/SKILL.md'));
    assert.ok(entries.includes('hyperframes-sports-director/assets/icons/icon-small.png'));
    assert.ok(entries.includes('hyperframes-sports-director/assets/icons/icon-large.png'));
    assert.ok(entries.every((entry) => !entry.includes('/evals/')));
    assert.ok(entries.every((entry) => !/(?:^|\/)(?:originals|proxies|renders)(?:\/|$)/.test(entry)));
    assert.ok(entries.every((entry) => !/\.(?:mp4|mov|mkv|avi|mp3|wav|m4a|fit|gpx|kml)$/i.test(entry)));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('release gate fails closed for unsafe files, corrupt assets, lineage drift, and tag mismatch', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'hf-release-negative-'));
  let fixtureNumber = 0;

  async function rejectMutation(name, mutate, expected) {
    await t.test(name, async () => {
      fixtureNumber += 1;
      const fixture = join(scratch, `fixture-${fixtureNumber}`);
      await cp(repoRoot, fixture, {
        recursive: true,
        filter(source) {
          const local = source === repoRoot ? '' : source.slice(repoRoot.length + 1).replaceAll('\\', '/');
          return !['.git', 'dist', 'node_modules'].includes(local.split('/')[0]);
        },
      });
      const options = await mutate(fixture) ?? { version: '1.0.0' };
      const result = await checkRelease(fixture, options);
      assert.equal(result.ok, false);
      assert.match(result.errors.join('\n'), expected);
      await assert.rejects(() => createReleaseArchive(fixture, { ...options, output: join(fixture, 'dist') }), /release check failed/);
    });
  }

  try {
    await rejectMutation('private media directory', async (fixture) => {
      const directory = join(fixture, 'skills/hyperframes-sports-director/assets/originals');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'session.webm'), 'private-media');
    }, /(?:forbidden|unrecognized) packaged/);

    await rejectMutation('arbitrary review workspace', async (fixture) => {
      const directory = join(fixture, 'skills/hyperframes-sports-director/review-workspace');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'notes.txt'), 'not for release');
    }, /(?:forbidden|unrecognized) packaged/);

    await rejectMutation('credential config', async (fixture) => {
      await writeFile(join(fixture, 'skills/hyperframes-sports-director/.npmrc'), '//registry.example/:_authToken=secret');
    }, /(?:secret|unrecognized) (?:filename|packaged file)/);

    await rejectMutation('truncated PNG icon', async (fixture) => {
      const icon = join(fixture, 'skills/hyperframes-sports-director/assets/icons/icon-small.png');
      await writeFile(icon, (await readFile(icon)).subarray(0, 24));
    }, /decodable 64x64 PNG/);

    await rejectMutation('package version drift', async (fixture) => {
      const path = join(fixture, 'package.json');
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      manifest.version = '2.0.0';
      await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    }, /package version must be 1\.0\.0/);

    await rejectMutation('attribution drift', async (fixture) => {
      const path = join(fixture, 'ATTRIBUTIONS.md');
      const source = await readFile(path, 'utf8');
      await writeFile(path, source.replace('0b66750322ccb50ae56ace5a8d361da2c1f65400', '0000000000000000000000000000000000000000'));
    }, /attribution does not match pinned upstream/);

    await rejectMutation('symbolic link in Skill package', async (fixture) => {
      await symlink('SKILL.md', join(fixture, 'skills/hyperframes-sports-director/linked.md'));
    }, /symbolic link is not portable/);

    await rejectMutation('tag and package version mismatch', async () => ({ version: '1.0.0', tag: 'v2.0.0' }), /release tag must equal v1\.0\.0/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
