import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('three-run trigger evidence meets the release confusion matrix', async () => {
  const triggerEval = JSON.parse(await readFile(join(skillRoot, 'evals/trigger-evals.json'), 'utf8'));
  assert.equal(triggerEval.cases.length, 20);
  assert.equal(triggerEval.cases.filter(({ should_trigger: expected }) => expected).length, 10);
  assert.equal(triggerEval.cases.filter(({ should_trigger: expected }) => !expected).length, 10);

  for (const item of triggerEval.cases) {
    assert.equal(item.measurement?.runs, 3, `${item.id} must record three fresh-context runs`);
    assert.equal(item.measurement.judgments?.length, 3, `${item.id} must retain each judgment`);
    assert.deepEqual(new Set(item.measurement.judgments.map(({ evaluator }) => evaluator)), new Set(triggerEval.measurement_method.evaluators), `${item.id} must bind all independent evaluators`);
    assert.ok(item.measurement.judgments.every(({ triggered }) => typeof triggered === 'boolean'), `${item.id} has a non-boolean judgment`);
    assert.equal(item.measurement.triggers, item.measurement.judgments.filter(({ triggered }) => triggered).length, `${item.id} aggregate is not derived from judgments`);
  }

  const positives = triggerEval.cases.filter(({ should_trigger: expected }) => expected);
  const negatives = triggerEval.cases.filter(({ should_trigger: expected }) => !expected);
  const positiveJudgments = positives.flatMap((item) => item.measurement.judgments);
  const negativeJudgments = negatives.flatMap((item) => item.measurement.judgments);
  const truePositiveRate = positiveJudgments.filter(({ triggered }) => triggered).length / positiveJudgments.length;
  const trueNegativeRate = negativeJudgments.filter(({ triggered }) => !triggered).length / negativeJudgments.length;
  assert.ok(truePositiveRate >= 0.9, `true-positive rate ${truePositiveRate} is below 0.90`);
  assert.ok(trueNegativeRate >= 0.9, `true-negative rate ${trueNegativeRate} is below 0.90`);
  assert.ok(positives.every(({ prompt }) => !prompt.includes('$hyperframes-sports-director')), 'positive cases must prove implicit invocation');
  assert.ok(negatives.filter(({ id }) => /ffmpeg|promo|tiktok-ad/.test(id)).flatMap((item) => item.measurement.judgments).every(({ triggered }) => !triggered), 'generic FFmpeg and promotional-film near misses must never trigger');
  assert.ok(triggerEval.cases.filter(({ id }) => id.includes('fabricated')).flatMap((item) => item.measurement.judgments).every(({ triggered }) => !triggered), 'fabricated performance requests must never trigger');
});
