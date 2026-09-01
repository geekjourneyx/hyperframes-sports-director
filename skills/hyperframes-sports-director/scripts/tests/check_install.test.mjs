import assert from 'node:assert/strict';
import test from 'node:test';

import { checkInstall, runCheckInstallCli } from '../check_install.mjs';

const FILTERS = ['blackdetect', 'freezedetect', 'silencedetect', 'ebur128', 'vidstabdetect', 'vidstabtransform', 'ssim'];

function dependencies(overrides = {}) {
  const missingCommands = new Set(overrides.missingCommands ?? []);
  const filters = overrides.filters ?? FILTERS;
  const missingScaffolds = new Set(overrides.missingScaffolds ?? []);
  return {
    nodeVersion: overrides.nodeVersion ?? 'v22.12.0',
    runCommand: async (command, args) => {
      if (missingCommands.has(command)) {
        const error = new Error(`${command} not found`);
        error.code = 'ENOENT';
        throw error;
      }
      if (command === 'ffmpeg' && args[0] === '-version') return { stdout: 'ffmpeg version 7.1 Copyright FFmpeg developers\n', stderr: '' };
      if (command === 'ffprobe') return { stdout: 'ffprobe version 7.1 Copyright FFmpeg developers\n', stderr: '' };
      if (command === 'ffmpeg' && args[0] === '-filters') {
        return { stdout: filters.map((name) => ` ... ${name} filter description`).join('\n'), stderr: '' };
      }
      throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
    },
    resolveSharp: async () => {
      if (overrides.sharpError) throw overrides.sharpError;
      return overrides.sharp === false ? null : { version: '0.34.3' };
    },
    pathExists: async (path) => {
      if (overrides.pathError) throw overrides.pathError;
      return ![...missingScaffolds].some((name) => path.includes(name));
    },
  };
}

function errorCodes(result) {
  return result.errors.map((error) => error.code);
}

test('checkInstall reports detected versions, required FFmpeg filters, Sharp, and both mandatory scaffolds', async () => {
  const result = await checkInstall(dependencies());

  assert.equal(result.ok, true);
  assert.deepEqual(result.versions, { node: '22.12.0', ffmpeg: '7.1', ffprobe: '7.1', sharp: '0.34.3' });
  assert.deepEqual(result.filters, Object.fromEntries(FILTERS.map((filter) => [filter, true])));
  assert.deepEqual(result.scaffolds, { hyperframesProject: true, directorWorkbench: true });
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.errors, []);
});

test('checkInstall independently reports every mandatory command, runtime, filter, module, and scaffold failure', async (t) => {
  const cases = [
    ['incompatible Node', { nodeVersion: 'v22.11.0' }, 'E_NODE_VERSION'],
    ['missing ffmpeg', { missingCommands: ['ffmpeg'] }, 'E_FFMPEG_MISSING'],
    ['missing ffprobe', { missingCommands: ['ffprobe'] }, 'E_FFPROBE_MISSING'],
    ['missing Sharp', { sharp: false }, 'E_SHARP_MISSING'],
    ['missing HyperFrames scaffold', { missingScaffolds: ['hyperframes-project'] }, 'E_HYPERFRAMES_SCAFFOLD_MISSING'],
    ['missing workbench scaffold', { missingScaffolds: ['director-workbench'] }, 'E_DIRECTOR_WORKBENCH_SCAFFOLD_MISSING'],
  ];
  for (const [name, override, code] of cases) {
    await t.test(name, async () => {
      const result = await checkInstall(dependencies(override));
      assert.equal(result.ok, false);
      assert.ok(errorCodes(result).includes(code), JSON.stringify(result));
    });
  }

  for (const filter of ['blackdetect', 'freezedetect', 'silencedetect', 'ebur128', 'ssim']) {
    await t.test(`missing required filter ${filter}`, async () => {
      const result = await checkInstall(dependencies({ filters: FILTERS.filter((candidate) => candidate !== filter) }));
      assert.equal(result.ok, false);
      assert.ok(errorCodes(result).includes('E_FFMPEG_FILTER_MISSING'));
      assert.ok(result.errors.some((error) => error.filter === filter));
    });
  }
});

test('missing optional stabilization filters produce one named fallback warning without failing install', async () => {
  for (const omitted of [
    ['vidstabdetect', 'vidstabtransform'],
    ['vidstabdetect'],
    ['vidstabtransform'],
  ]) {
    const result = await checkInstall(dependencies({ filters: FILTERS.filter((filter) => !omitted.includes(filter)) }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, [{
      code: 'W_STABILIZATION_FALLBACK',
      capability: 'vidstab',
      fallback: 'conservative-non-vidstab-stabilization',
      missingFilters: omitted,
    }]);
  }
});

test('Sharp native-load and arbitrary probe failures become named capability errors', async () => {
  const nativeError = new Error('libvips ABI mismatch');
  nativeError.code = 'ERR_DLOPEN_FAILED';
  const native = await checkInstall(dependencies({ sharpError: nativeError }));
  assert.equal(native.ok, false);
  assert.ok(native.errors.some(({ code }) => code === 'E_SHARP_LOAD'));

  const arbitrary = await checkInstall(dependencies({ sharpError: new Error('unexpected sharp probe failure') }));
  assert.equal(arbitrary.ok, false);
  assert.ok(arbitrary.errors.some(({ code }) => code === 'E_SHARP_CHECK_FAILED'));
});

test('check_install CLI converts an unexpected probe throw into exactly one JSON diagnostic', async () => {
  const writes = [];
  const exit = await runCheckInstallCli(
    ['--json'],
    dependencies({ pathError: new Error('filesystem probe exploded') }),
    (text) => writes.push(text),
  );
  assert.equal(exit, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0]), {
    ok: false,
    versions: { node: null, ffmpeg: null, ffprobe: null, sharp: null },
    filters: {},
    scaffolds: {},
    warnings: [],
    errors: [{ code: 'E_CAPABILITY_CHECK', message: 'filesystem probe exploded' }],
  });
});

test('check_install --json CLI writes one machine-readable result and uses a non-zero failure exit', async () => {
  const writes = [];
  const successExit = await runCheckInstallCli(['--json'], dependencies(), (text) => writes.push(text));
  assert.equal(successExit, 0);
  assert.equal(writes.length, 1);
  assert.equal(JSON.parse(writes[0]).ok, true);

  writes.length = 0;
  const failureExit = await runCheckInstallCli(['--json'], dependencies({ missingCommands: ['ffprobe'] }), (text) => writes.push(text));
  assert.equal(failureExit, 1);
  const failure = JSON.parse(writes[0]);
  assert.equal(failure.ok, false);
  assert.ok(errorCodes(failure).includes('E_FFPROBE_MISSING'));

  writes.length = 0;
  const usageExit = await runCheckInstallCli([], dependencies(), (text) => writes.push(text));
  assert.equal(usageExit, 2);
  assert.deepEqual(JSON.parse(writes[0]), {
    ok: false,
    errors: [{ code: 'E_USAGE', message: 'usage: check_install.mjs --json' }],
    warnings: [],
  });
});
