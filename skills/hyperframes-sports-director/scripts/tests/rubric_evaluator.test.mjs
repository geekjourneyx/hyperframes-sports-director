import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const RUBRIC_PATH = 'skills/hyperframes-sports-director/evals/rubric.json';

async function evaluator() {
  return import('../lib/rubric_evaluator.mjs');
}

async function productionRubric() {
  return JSON.parse(await readFile(RUBRIC_PATH, 'utf8'));
}

function fullOutput() {
  return {
    asset_manifest: {
      input_assets: [
        { id: 'cam-1', provenance: 'original' },
        { id: 'music-1', provenance: 'explicit-derivative' },
      ],
      generated_assets: [
        {
          id: 'generated-route-1',
          provenance: 'imagegen-job-123',
          crop: 'center-safe-16:9',
          motion_owner: 'motion-map:route-transition',
          documentary_status: 'interpretive-not-documentary',
        },
      ],
    },
    timeline: {
      shots: [{ source_asset_id: 'cam-1', role: 'original' }],
      render_source: 'original-backed',
      speech_segments: [{ source_asset_id: 'cam-1' }],
      music_segments: [{ source_asset_id: 'music-1' }],
    },
    audio: {
      continuity_plan: 'room tone bridges each speech cut',
      speech_claims: [{ source_asset_id: 'cam-1' }],
      music_claims: [{ provenance: 'source' }],
    },
    activity: {
      status: 'available',
      metrics: [{ value: 42, source_asset_id: 'cam-1' }],
      claims: [{ source_asset_id: 'cam-1' }],
    },
    assets: { generated: true },
    motion_map: { generated_asset_ids: ['generated-route-1'] },
    copy: { title: 'Ride outward', chapter: ['Start', 'Finish'] },
    final_mp4: {
      path: '/deliveries/ride.mp4',
      inspection: 'ffprobe-or-equivalent-plus-decoded-samples',
      probe_summary: 'codec=h265 duration=180 audio=aac',
      decoded_sample_times: [0, 36, 72, 108, 144],
      audio_stream_check: 'present-and-decodable',
      width: 3840,
      height: 2160,
      aspect_ratio: '16:9',
      file_size_gb: 1.4,
    },
  };
}

function miniRubric({ criteria, dimensions = [], hard_failures = [] }) {
  return {
    scoring: {
      maximum_score: 100,
      passing_score: 90,
      rounding: 'round-half-up',
      na_denominator_normalization: true,
    },
    applicability: {
      activation_source: 'prompt-or-evaluated-output',
      dimensions,
    },
    criteria,
    hard_failures,
  };
}

test('evaluateRubric awards full points for a complete production-rubric output', async () => {
  const { evaluateRubric } = await evaluator();
  const result = evaluateRubric({
    rubric: await productionRubric(),
    prompt: 'speech with background music, FIT data, Image Gen route visual, title and chapter, 4K 16:9 under 1.5 GB',
    evaluatedOutput: fullOutput(),
  });

  assert.equal(result.status, 'pass');
  assert.equal(result.score, 100);
  assert.equal(result.applicable_points, 100);
  assert.deepEqual(result.hard_failures, []);
  assert.ok(result.criteria.every((criterion) => criterion.status === 'full'));
});

test('evaluateRubric uses declared partial credit and normalized scoring', async () => {
  const { evaluateRubric } = await evaluator();
  const output = fullOutput();
  output.asset_manifest.input_assets[1].provenance = 'unknown';
  const result = evaluateRubric({
    rubric: await productionRubric(),
    prompt: 'speech with background music, FIT data, Image Gen route visual, title and chapter, 4K 16:9 under 1.5 GB',
    evaluatedOutput: output,
  });

  assert.equal(result.status, 'pass');
  assert.equal(result.score, 93);
  assert.deepEqual(result.criteria.find(({ id }) => id === 'input-provenance'), {
    id: 'input-provenance',
    status: 'partial',
    awarded_points: 8,
    available_points: 15,
  });
});

test('evaluateRubric normalizes N/A criteria and rounds half up', async () => {
  const { evaluateRubric } = await evaluator();
  const normalized = evaluateRubric({
    rubric: miniRubric({
      dimensions: [{ id: 'activity', prompt_signals: ['fit'], output_signals: ['evaluated_output.activity.metrics'] }],
      criteria: [
        { id: 'always', points: 20, applicability: { mode: 'always' }, checks: [{ path: 'evaluated_output.ok', operator: 'equals', expected: true }], partial_credit: [] },
        { id: 'activity-only', points: 80, applicability: { mode: 'dimension-active', dimension: 'activity' }, checks: [{ path: 'evaluated_output.activity.metrics', operator: 'exists-and-nonempty', expected: true }], partial_credit: [] },
      ],
    }),
    prompt: 'make a video',
    evaluatedOutput: { ok: true },
  });
  assert.equal(normalized.score, 100);
  assert.equal(normalized.applicable_points, 20);
  assert.equal(normalized.criteria[1].status, 'not-applicable');

  const halfUp = evaluateRubric({
    rubric: miniRubric({
      dimensions: [{ id: 'off', prompt_signals: ['never'], output_signals: ['evaluated_output.never'] }],
      criteria: [
        { id: 'rounding', points: 8, applicability: { mode: 'always' }, checks: [{ path: 'evaluated_output.complete', operator: 'equals', expected: true }], partial_credit: [{ award_points: 1, condition: { path: 'evaluated_output.partial', operator: 'equals', expected: true } }] },
        { id: 'not-applicable', points: 92, applicability: { mode: 'dimension-active', dimension: 'off' }, checks: [{ path: 'evaluated_output.never', operator: 'equals', expected: true }], partial_credit: [] },
      ],
    }),
    prompt: '',
    evaluatedOutput: { complete: false, partial: true },
  });
  assert.equal(halfUp.score, 13);

  const zeroApplicable = evaluateRubric({
    rubric: miniRubric({
      dimensions: [{ id: 'off', prompt_signals: ['never'], output_signals: ['evaluated_output.never'] }],
      criteria: [{ id: 'only-off', points: 100, applicability: { mode: 'dimension-active', dimension: 'off' }, checks: [{ path: 'evaluated_output.never', operator: 'equals', expected: true }], partial_credit: [] }],
    }),
    prompt: '',
    evaluatedOutput: {},
  });
  assert.equal(zeroApplicable.score, 0);
  assert.equal(zeroApplicable.applicable_points, 0);
});

test('evaluateRubric activates dimensions from prompt or evaluated output', async () => {
  const { evaluateRubric } = await evaluator();
  const rubric = miniRubric({
    dimensions: [{ id: 'generated', prompt_signals: ['image gen'], output_signals: ['evaluated_output.assets.generated'] }],
    criteria: [{ id: 'generated-only', points: 100, applicability: { mode: 'dimension-active', dimension: 'generated' }, checks: [{ path: 'evaluated_output.assets.generated', operator: 'equals', expected: true }], partial_credit: [] }],
  });

  const activatedByPrompt = evaluateRubric({ rubric, prompt: 'Use Image Gen', evaluatedOutput: { assets: { generated: true } } });
  assert.equal(activatedByPrompt.criteria[0].status, 'full');
  const activatedByOutput = evaluateRubric({ rubric, prompt: 'Make a film', evaluatedOutput: { assets: { generated: true } } });
  assert.equal(activatedByOutput.criteria[0].status, 'full');
});

test('evaluateRubric hard-fails every weak final-MP4 inspection variant', async () => {
  const { evaluateRubric } = await evaluator();
  const rubric = await productionRubric();
  const cases = [
    ['empty probe metadata', (output) => { output.final_mp4.probe_summary = ''; }],
    ['too few decoded samples', (output) => { output.final_mp4.decoded_sample_times = [0, 1, 2, 3]; }],
    ['undecodable audio', (output) => { output.final_mp4.audio_stream_check = 'missing'; }],
    ['invalid inspection method', (output) => { output.final_mp4.inspection = 'export-settings-only'; }],
  ];

  for (const [name, mutate] of cases) {
    const output = fullOutput();
    mutate(output);
    const result = evaluateRubric({ rubric, prompt: 'speech with music and Image Gen', evaluatedOutput: output });
    assert.equal(result.status, 'fail', name);
    assert.ok(result.hard_failures.includes('missing-final-mp4-inspection'), name);
  }
});

test('evaluateRubric uses asset-manifest motion ownership as the canonical generated-asset record', async () => {
  const { evaluateRubric } = await evaluator();
  const output = fullOutput();
  delete output.asset_manifest.generated_assets[0].motion_owner;
  const result = evaluateRubric({ rubric: await productionRubric(), prompt: 'Use Image Gen', evaluatedOutput: output });

  assert.equal(result.criteria.find(({ id }) => id === 'generated-visual-motion-ownership').status, 'zero');
  assert.ok(result.hard_failures.includes('generated-asset-ownership'));
});

test('evaluateRubric returns stable diagnostics for malformed rubrics and unsupported operators', async () => {
  const { evaluateRubric } = await evaluator();
  const malformed = evaluateRubric({ rubric: { criteria: 'not-an-array' }, prompt: '', evaluatedOutput: {} });
  assert.deepEqual(malformed, {
    status: 'invalid',
    score: 0,
    applicable_points: 0,
    criteria: [],
    hard_failures: [],
    diagnostics: ['E_RUBRIC_APPLICABILITY', 'E_RUBRIC_CRITERIA', 'E_RUBRIC_HARD_FAILURES', 'E_RUBRIC_SCORING'],
  });

  const unsupported = evaluateRubric({
    rubric: miniRubric({
      criteria: [{ id: 'unknown-op', points: 100, applicability: { mode: 'always' }, checks: [{ path: 'evaluated_output.ok', operator: 'unknown-operator', expected: true }], partial_credit: [] }],
    }),
    prompt: '',
    evaluatedOutput: { ok: true },
  });
  assert.equal(unsupported.status, 'invalid');
  assert.deepEqual(unsupported.diagnostics, ['E_OPERATOR_UNSUPPORTED:unknown-operator']);
});
