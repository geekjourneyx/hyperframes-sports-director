import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { materializeGoldenProjects } from '../../evals/fixtures/generate-fixtures.mjs';
import { loadReleaseEvaluation, scoreEvaluation } from '../score_eval.mjs';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const rubric = JSON.parse(await readFile(join(skillRoot, 'evals/rubric.json'), 'utf8'));
const weights = [10, 15, 20, 10, 10, 15, 10, 10];

function fixture({ failedMetrics = [], missingEvidence = [], hardGate = null, humanReview = 'accepted' } = {}) {
  const metricIds = new Set(rubric.release_scoring.categories.flatMap(({ checks }) => checks.filter(({ source }) => source === 'metric').map(({ id }) => id)));
  const evidenceIds = new Set(rubric.release_scoring.categories.flatMap(({ checks }) => checks.filter(({ source }) => source === 'evidence').map(({ id }) => id)));
  return {
    metrics: { status: 'accepted', metrics: [...metricIds].map((metricId) => ({ metricId, status: failedMetrics.includes(metricId) ? 'fail' : 'pass', value: true })) },
    evidenceChecks: [...evidenceIds].filter((id) => !missingEvidence.includes(id)),
    hardGates: rubric.release_scoring.required_hard_gates.map((id) => ({ id, status: id === hardGate ? 'fail' : 'pass' })),
    projectState: { state: 'DELIVERED' }, profileMaturity: 'release-grade', agentReview: { status: 'accepted' },
    humanReviews: { workbench: { status: humanReview }, finalVideo: { status: humanReview } },
  };
}

test('release scorer derives the exact 10/15/20/10/10/15/10/10 weights from constrained checks', () => {
  const result = scoreEvaluation(fixture(), rubric);
  assert.deepEqual(result.categories.map(({ availablePoints }) => availablePoints), weights);
  assert.equal(result.total, 100);
  assert.equal(result.releaseEligible, true);
});

test('an evidence-derived 89-point fixture is not release eligible', () => {
  const result = scoreEvaluation(fixture({ failedMetrics: ['loudness', 'black_frames'], missingEvidence: ['structure'] }), rubric);
  assert.equal(result.total, 89);
  assert.ok(result.thresholdFailures.includes('total-below-90'));
  assert.equal(result.releaseEligible, false);
});

test('a 95-point fixture with one hard failure still fails', () => {
  const result = scoreEvaluation(fixture({ failedMetrics: ['closed_file_probe'], hardGate: 'closed-file-reprobe' }), rubric);
  assert.equal(result.total, 95);
  assert.deepEqual(result.hardGates, ['closed-file-reprobe']);
  assert.equal(result.releaseEligible, false);
});

test('a 92-point fixture with one category below 80 percent fails', () => {
  const result = scoreEvaluation(fixture({ failedMetrics: ['local_contrast'], missingEvidence: ['structure'] }), rubric);
  assert.equal(result.total, 92);
  assert.deepEqual(result.thresholdFailures, ['structure-installability-below-80-percent']);
  assert.equal(result.releaseEligible, false);
});

test('unresolved human taste review cannot be converted into a score pass', () => {
  const result = scoreEvaluation(fixture({ humanReview: 'unavailable' }), rubric);
  assert.equal(result.total, 100);
  assert.deepEqual(result.hardGates, ['human-review-final-video', 'human-review-workbench']);
  assert.equal(result.releaseEligible, false);
});

test('file-backed loader rejects nonexistent evidence instead of trusting paths', async () => {
  const project = await mkdtemp(join(tmpdir(), 'hf-forged-eval-'));
  try {
    await mkdir(join(project, 'review'));
    await writeFile(join(project, 'review/release-eval.json'), JSON.stringify({ schemaVersion: '1.0.0', references: { metrics: { path: 'review/missing.json', sha256: 'a'.repeat(64) } } }));
    await assert.rejects(loadReleaseEvaluation(join(project, 'review/metrics.json')), /E_EVIDENCE_MISSING/);
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('three golden runners bind real finals, production-shaped metrics, lifecycle gates, and expected scores', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'hf-golden-projects-'));
  try {
    const projects = await materializeGoldenProjects(workspace, { fixtureRoot: join(skillRoot, 'evals/fixtures/projects') });
    for (const profile of ['cycling', 'hiking', 'pool-swimming']) {
      const contract = JSON.parse(await readFile(join(projects[profile], 'golden-project.json'), 'utf8'));
      const expected = JSON.parse(await readFile(join(skillRoot, 'evals/expected', `${profile}.json`), 'utf8'));
      const evaluation = await loadReleaseEvaluation(join(projects[profile], 'review/metrics.json'));
      assert.equal(contract.profile, profile);
      assert.equal(evaluation.projectState.state, 'DELIVERED');
      assert.equal(evaluation.projectState.gateEvidence.filter(({ role }) => role === 'DIRECTOR_APPROVAL').length, 1);
      assert.equal(contract.pipeline.userAccepted, false);
      assert.equal(evaluation.metrics.metrics.some(({ metricId }) => metricId.startsWith('release-score.')), false);
      assert.deepEqual(scoreEvaluation(evaluation, rubric), expected);
    }
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
