import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('contracts CI installs ffmpeg on every matrix runner before contract tests', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const contractsJob = workflow.split('\n  synthetic-media-and-evals:')[0];
  const contractTestIndex = contractsJob.indexOf('npm run test:contracts');

  assert.notEqual(contractTestIndex, -1, 'contracts job must run contract tests');

  const setup = contractsJob.slice(0, contractTestIndex);
  assert.match(setup, /if: runner\.os == 'Linux'[\s\S]*apt-get install -y ffmpeg/);
  assert.match(setup, /if: runner\.os == 'macOS'[\s\S]*brew install ffmpeg/);
});
