import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const EVALS_PATH = 'skills/hyperframes-sports-director/evals/evals.json';
const RUBRIC_PATH = 'skills/hyperframes-sports-director/evals/rubric.json';
const TRIGGERS_PATH = 'skills/hyperframes-sports-director/evals/trigger-evals.json';

async function readJson(path) {
  const text = await readFile(path, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    assert.fail(`${path} must contain valid JSON: ${error.message}`);
  }
}

function plainObject(value, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function array(value, label) {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function string(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.ok(value.trim(), `${label} must not be blank`);
}

function ids(records, label) {
  const seen = new Set();
  for (const [index, record] of records.entries()) {
    plainObject(record, `${label}[${index}]`);
    string(record.id, `${label}[${index}].id`);
    assert.ok(!seen.has(record.id), `${label} IDs must be unique: ${record.id}`);
    seen.add(record.id);
  }
  return seen;
}

test('evaluation contracts cover six realistic no-skill baselines', async () => {
  const evalDocument = plainObject(await readJson(EVALS_PATH), EVALS_PATH);
  const evals = array(evalDocument.evals, `${EVALS_PATH}.evals`);
  assert.equal(evals.length, 6, 'evals.json must contain exactly six baseline prompts');
  const evalIds = ids(evals, `${EVALS_PATH}.evals`);

  for (const [index, record] of evals.entries()) {
    string(record.prompt, `evals[${index}].prompt`);
    string(record.expected_output, `evals[${index}].expected_output`);
    array(record.files, `evals[${index}].files`);
  }

  assert.deepEqual([...evalIds].sort(), [
    'cycling-fit-4k',
    'hiking-no-data',
    'mixed-directory-story',
    'noisy-speech-music',
    'pool-swimming',
    'visual-copy-delivery',
  ]);

  const joinedPrompts = evals.map(({ prompt }) => prompt).join('\n').toLowerCase();
  for (const requiredScenario of [
    'dji action 5 pro',
    'fit',
    'hiking',
    'unavailable',
    'pool',
    'speech',
    'background music',
    '4k',
    '1.5 gb',
    'chapter',
    'image gen',
  ]) {
    assert.ok(joinedPrompts.includes(requiredScenario), `baseline prompts must cover: ${requiredScenario}`);
  }
});

test('trigger evaluation contract has a balanced set of hard near-misses', async () => {
  const triggerDocument = plainObject(await readJson(TRIGGERS_PATH), TRIGGERS_PATH);
  const cases = array(triggerDocument.cases, `${TRIGGERS_PATH}.cases`);
  assert.equal(cases.length, 20, 'trigger-evals.json must contain exactly 20 cases');
  ids(cases, `${TRIGGERS_PATH}.cases`);

  const trueCases = cases.filter((entry) => entry.should_trigger === true);
  const falseCases = cases.filter((entry) => entry.should_trigger === false);
  assert.equal(trueCases.length, 10, 'trigger-evals.json must have 10 true cases');
  assert.equal(falseCases.length, 10, 'trigger-evals.json must have 10 false cases');

  for (const [index, record] of cases.entries()) {
    string(record.prompt, `cases[${index}].prompt`);
    assert.equal(typeof record.should_trigger, 'boolean', `cases[${index}].should_trigger must be boolean`);
  }

  const negatives = falseCases.map(({ prompt }) => prompt).join('\n').toLowerCase();
  for (const nearMiss of [
    'ffmpeg',
    'product launch',
    'retouch',
    'analysis',
    'tiktok',
    'faster pace',
  ]) {
    assert.ok(negatives.includes(nearMiss), `near-miss negatives must include: ${nearMiss}`);
  }
});

test('rubric is a deterministic, normalized 100-point safety contract', async () => {
  const rubric = plainObject(await readJson(RUBRIC_PATH), RUBRIC_PATH);
  const scoring = plainObject(rubric.scoring, 'rubric.scoring');
  assert.equal(scoring.maximum_score, 100);
  assert.equal(scoring.passing_score, 90);
  assert.equal(scoring.rounding, 'round-half-up');
  assert.equal(scoring.na_denominator_normalization, true);
  string(scoring.formula, 'rubric.scoring.formula');

  const applicability = plainObject(rubric.applicability, 'rubric.applicability');
  assert.equal(applicability.activation_source, 'prompt-or-evaluated-output');
  const dimensions = array(applicability.dimensions, 'rubric.applicability.dimensions');
  const dimensionIds = ids(dimensions, 'rubric.applicability.dimensions');
  assert.deepEqual([...dimensionIds].sort(), ['activity-data', 'generated-visuals', 'music', 'speech']);
  for (const dimension of dimensions) {
    array(dimension.prompt_signals, `applicability.${dimension.id}.prompt_signals`);
    array(dimension.output_signals, `applicability.${dimension.id}.output_signals`);
    assert.ok(dimension.prompt_signals.length > 0, `${dimension.id} needs prompt signals`);
    assert.ok(dimension.output_signals.length > 0, `${dimension.id} needs output signals`);
  }

  const criteria = array(rubric.criteria, 'rubric.criteria');
  const criterionIds = ids(criteria, 'rubric.criteria');
  for (const requiredCriterion of ['input-provenance', 'null-or-unavailable-data', 'final-mp4-inspection']) {
    assert.ok(criterionIds.has(requiredCriterion), `rubric must include ${requiredCriterion}`);
  }
  for (const criterion of criteria) {
    assert.equal(typeof criterion.points, 'number', `criterion ${criterion.id} needs numeric points`);
    assert.ok(criterion.points > 0, `criterion ${criterion.id} points must be positive`);
    plainObject(criterion.applicability, `criterion ${criterion.id}.applicability`);
    array(criterion.checks, `criterion ${criterion.id}.checks`);
    assert.ok(criterion.checks.length > 0, `criterion ${criterion.id} needs deterministic checks`);
    array(criterion.partial_credit, `criterion ${criterion.id}.partial_credit`);
    for (const partial of criterion.partial_credit) {
      plainObject(partial, `criterion ${criterion.id} partial-credit entry`);
      assert.equal(typeof partial.award_points, 'number', `criterion ${criterion.id} partial credit needs numeric award_points`);
      assert.ok(partial.award_points >= 0 && partial.award_points < criterion.points, `criterion ${criterion.id} partial credit must be below full points`);
      plainObject(partial.condition, `criterion ${criterion.id} partial-credit condition`);
    }
  }
  assert.equal(criteria.reduce((total, criterion) => total + criterion.points, 0), 100);

  const provenance = criteria.find(({ id }) => id === 'input-provenance');
  assert.ok(provenance.checks.some(({ expected }) => expected === 'original-or-explicit-derivative'), 'input-provenance must require original-backed provenance');
  const unavailable = criteria.find(({ id }) => id === 'null-or-unavailable-data');
  assert.ok(unavailable.checks.some(({ expected }) => expected === 'null-or-status-unavailable'), 'null-or-unavailable-data must prohibit zero-filled missing data');
  const finalInspection = criteria.find(({ id }) => id === 'final-mp4-inspection');
  assert.ok(finalInspection.checks.some(({ expected }) => expected === 'ffprobe-or-equivalent-plus-decoded-samples'), 'final-mp4-inspection must require robust inspection');

  const hardFailures = array(rubric.hard_failures, 'rubric.hard_failures');
  const hardFailureIds = ids(hardFailures, 'rubric.hard_failures');
  assert.deepEqual([...hardFailureIds].sort(), [
    'fabricated-metrics',
    'generated-asset-ownership',
    'generated-imagery-as-documentary',
    'missing-final-mp4-inspection',
    'proxy-as-final-source',
  ]);
  for (const failure of hardFailures) {
    string(failure.when, `hard failure ${failure.id}.when`);
    assert.equal(failure.result, 'fail', `hard failure ${failure.id} must fail the evaluation`);
    plainObject(failure.condition, `hard failure ${failure.id}.condition`);
  }

  const generatedAssetOwnership = hardFailures.find(({ id }) => id === 'generated-asset-ownership');
  assert.deepEqual(generatedAssetOwnership.required_fields, ['provenance', 'crop', 'motion_owner']);
  const missingInspection = hardFailures.find(({ id }) => id === 'missing-final-mp4-inspection');
  assert.deepEqual(missingInspection.required_fields, ['probe_summary', 'decoded_sample_times', 'audio_stream_check']);
});
