import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { computeArtifactDigest, validateArtifact } from '../lib/contracts.mjs';
import { createProject } from '../create_project.mjs';
import { computeInvalidationClosure, rollbackStateForInvalidation } from '../lib/invalidation.mjs';
import { validateTransition } from '../lib/project-state.mjs';

const execFileAsync = promisify(execFile);
const ROOT = 'skills/hyperframes-sports-director';
const DIGEST = 'a'.repeat(64);
const NOW = '2026-09-01T12:00:00.000Z';
const MAIN_STATES = [
  'INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT',
  'DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION',
  'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED',
];
const ALL_STATES = [...MAIN_STATES, 'BLOCKED', 'CANCELLED'];
const EXPECTED_TREE = [
  'EDIT_BRIEF.json',
  'PROJECT.json',
  'PROJECT_STATE.json',
  'analysis/',
  'analysis/ACTIVITY.json',
  'analysis/MEDIA_INDEX.json',
  'analysis/PROBE.json',
  'analysis/SEGMENTS.json',
  'analysis/SHOTS.jsonl',
  'analysis/SYNC_MAP.json',
  'analysis/TRANSCRIPT.json',
  'assets/',
  'assets/images/',
  'assets/images/components/',
  'assets/images/proofs/',
  'assets/images/source/',
  'cache/',
  'direction/',
  'direction/ASSET_MANIFEST.json',
  'direction/BEAT_MAP.json',
  'direction/BRIEF_DESIGN_PROPOSAL.md',
  'direction/DATA_OVERLAYS.json',
  'direction/DESIGN_SYSTEM.json',
  'direction/DIRECTION_PROPOSALS.json',
  'direction/DIRECTOR_APPROVAL.json',
  'direction/LOOK_PROFILE.json',
  'direction/MOTION_MAP.json',
  'direction/SCENE_SCHEMA.json',
  'edit/',
  'edit/TIMELINE.json',
  'media/',
  'media/originals/',
  'media/proxies/',
  'renders/',
  'renders/final.mp4',
  'renders/rough-cut.mp4',
  'review/',
  'review/REVIEW_REPORT.md',
  'review/director-workbench.html',
  'review/metrics.json',
  'review/workbench-assets/',
];

async function listTree(root, relative = '') {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    result.push(entry.isDirectory() ? `${path}/` : path);
    if (entry.isDirectory()) result.push(...await listTree(root, path));
  }
  return result.sort();
}

function options(project, input, overrides = {}) {
  return {
    project,
    input,
    sport: 'cycling',
    device: 'dji-osmo-action-5-pro',
    delivery: 'landscape-4k',
    duration: 180,
    music: 'provided',
    copy: ['titles'],
    maxSizeMiB: 1536,
    inputMode: 'reference',
    now: () => NOW,
    ...overrides,
  };
}

function evidenceRecord(role, qualifiers = ['accepted'], digest = DIGEST) {
  return {
    role,
    revision: 1,
    digest,
    timestamp: NOW,
    producerCommand: `test-producer --role ${role}`,
    qualifiers,
  };
}

function evidenceFor(next) {
  let records;
  if (next === 'STYLE_ANCHOR') {
    records = [
      evidenceRecord('DESIGN_SYSTEM', ['frozen']),
      evidenceRecord('LOOK_PROFILE', ['frozen']),
      evidenceRecord('ASSET_PLAN', ['approved']),
    ];
  } else if (next === 'ASSET_PRODUCTION') {
    records = [
      evidenceRecord('STYLE_ANCHOR', ['accepted']),
      evidenceRecord('REPRESENTATIVE_COMBINATION', ['accepted']),
    ];
  } else if (next === 'DELIVERED') {
    records = [
      evidenceRecord('CLOSED_FILE_PROBE', ['passed']),
      evidenceRecord('HARD_GATES', ['passed']),
      evidenceRecord('AGENT_VISUAL_INSPECTION', ['accepted']),
      evidenceRecord('ENCODED_MP4_EVIDENCE', ['accepted']),
    ];
  } else {
    records = [evidenceRecord(`${next}_GATE`)];
  }
  return { records, currentDigests: Object.fromEntries(records.map((record) => [record.role, record.digest])) };
}

test('createProject builds the exact v1 artifact tree from valid draft templates without copying reference media', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-create-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(scratch, { recursive: true, force: true });
  });
  const input = join(scratch, 'private-input');
  const project = join(scratch, 'ride-vlog');
  await mkdir(input);
  await writeFile(join(input, 'private-ride.mov'), 'source-evidence');
  await writeFile(join(input, 'track.fit'), 'recorded-activity');
  const inputBefore = await listTree(input);

  const result = await createProject(options(project, input));

  assert.equal(result.ok, true);
  assert.equal(result.resumed, false);
  assert.deepEqual(await listTree(project), [...EXPECTED_TREE].sort());
  assert.deepEqual(await listTree(input), inputBefore, 'the input directory is immutable');
  assert.deepEqual(await readdir(join(project, 'media/originals')), [], 'reference mode copies no media');
  assert.deepEqual(await readdir(join(project, 'review/workbench-assets')), [], 'review derivatives start empty');
  assert.equal((await stat(join(project, 'review/director-workbench.html'))).size, 0);
  assert.equal((await stat(join(project, 'renders/rough-cut.mp4'))).size, 0);
  assert.equal((await stat(join(project, 'renders/final.mp4'))).size, 0);

  const projectDocument = JSON.parse(await readFile(join(project, 'PROJECT.json'), 'utf8'));
  assert.equal(projectDocument.projectId, basename(project));
  assert.deepEqual(projectDocument.profiles, {
    sport: 'cycling',
    device: 'dji-osmo-action-5-pro',
    delivery: 'landscape-4k',
    sportMaturity: 'release-grade',
  });
  assert.equal(projectDocument.paths.inputReference, 'media/originals');
  assert.equal(JSON.stringify(projectDocument).includes(input), false, 'portable project JSON does not expose the absolute input path');
  assert.equal((await validateArtifact(join(project, 'PROJECT.json'), 'project')).valid, true);
  assert.equal((await validateArtifact(join(project, 'PROJECT_STATE.json'), 'project-state')).valid, true);

  const brief = JSON.parse(await readFile(join(project, 'EDIT_BRIEF.json'), 'utf8'));
  assert.deepEqual(brief.sport, { profile: 'cycling' });
  assert.deepEqual(brief.duration, { targetSeconds: 180, minSeconds: 150, maxSeconds: 210 });
  assert.equal(brief.music.mode, 'provided');
  assert.deepEqual(brief.copy.modes, ['titles']);
  assert.deepEqual(brief.delivery, {
    container: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    width: 3840,
    height: 2160,
    aspectRatio: '16:9',
    frameRate: { mode: 'source-compatible', fps: null },
    maximumFileSizeBytes: 1610612736,
  });
  assert.equal((await validateArtifact(join(project, 'EDIT_BRIEF.json'), 'edit-brief')).valid, true);

  for (const path of ['direction/DESIGN_SYSTEM.json', 'direction/LOOK_PROFILE.json']) {
    const draft = JSON.parse(await readFile(join(project, path), 'utf8'));
    assert.equal(draft.status, 'draft');
    assert.equal(draft.approvalDigest, null);
  }
  for (const path of ['analysis/ACTIVITY.json', 'analysis/TRANSCRIPT.json']) {
    assert.equal(JSON.parse(await readFile(join(project, path), 'utf8')).status, 'unavailable');
  }
  assert.equal(JSON.parse(await readFile(join(project, 'direction/DIRECTION_PROPOSALS.json'), 'utf8')).status, 'unavailable');
  assert.equal(JSON.parse(await readFile(join(project, 'direction/DIRECTOR_APPROVAL.json'), 'utf8')).status, 'unavailable');
});

test('createProject refuses non-empty destinations and only resumes compatible integrity-valid projects without mutation', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-resume-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(scratch, { recursive: true, force: true });
  });
  const input = join(scratch, 'input');
  const project = join(scratch, 'project');
  await mkdir(input);
  await createProject(options(project, input));

  const before = await readFile(join(project, 'PROJECT.json'), 'utf8');
  await assert.rejects(createProject(options(project, input)), (error) => error.code === 'E_DESTINATION_NOT_EMPTY');
  const resumed = await createProject(options(project, input, { resume: true }));
  assert.equal(resumed.resumed, true);
  assert.equal(await readFile(join(project, 'PROJECT.json'), 'utf8'), before);
  await assert.rejects(
    createProject(options(project, input, { resume: true, sport: 'hiking' })),
    (error) => error.code === 'E_RESUME_INCOMPATIBLE',
  );

  const staleProfileLineage = JSON.parse(before);
  staleProfileLineage.integrity.upstream.sport = 'f'.repeat(64);
  staleProfileLineage.integrity.digest = computeArtifactDigest(staleProfileLineage);
  await writeFile(join(project, 'PROJECT.json'), `${JSON.stringify(staleProfileLineage, null, 2)}\n`);
  await assert.rejects(
    createProject(options(project, input, { resume: true })),
    (error) => error.code === 'E_RESUME_INCOMPATIBLE',
  );
  await writeFile(join(project, 'PROJECT.json'), before);

  const tampered = JSON.parse(before);
  tampered.projectId = 'tampered';
  await writeFile(join(project, 'PROJECT.json'), `${JSON.stringify(tampered, null, 2)}\n`);
  const stateBeforeFailure = await readFile(join(project, 'PROJECT_STATE.json'), 'utf8');
  await assert.rejects(
    createProject(options(project, input, { resume: true })),
    (error) => error.code === 'E_RESUME_INVALID',
  );
  assert.equal(await readFile(join(project, 'PROJECT_STATE.json'), 'utf8'), stateBeforeFailure);

  const occupied = join(scratch, 'occupied');
  await mkdir(occupied);
  await writeFile(join(occupied, 'keep.txt'), 'user-owned');
  await assert.rejects(
    createProject(options(occupied, input)),
    (error) => error.code === 'E_DESTINATION_NOT_EMPTY',
  );
  assert.equal(await readFile(join(occupied, 'keep.txt'), 'utf8'), 'user-owned');
});

test('createProject rejects project destinations inside the immutable input tree before mutation', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-overlap-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(scratch, { recursive: true, force: true });
  });
  const input = join(scratch, 'input');
  await mkdir(input);
  const before = await listTree(input);

  await assert.rejects(
    createProject(options(join(input, 'project'), input)),
    (error) => error.code === 'E_PROJECT_INPUT_OVERLAP',
  );
  assert.deepEqual(await listTree(input), before);
  await assert.rejects(
    createProject(options(input, input)),
    (error) => error.code === 'E_PROJECT_INPUT_OVERLAP',
  );
  assert.deepEqual(await listTree(input), before);
});

test('create_project CLI prints one JSON result and machine-readable errors', async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-create-cli-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(scratch, { recursive: true, force: true });
  });
  const input = join(scratch, 'input');
  const project = join(scratch, 'cli-project');
  await mkdir(input);
  const args = [
    `${ROOT}/scripts/create_project.mjs`, '--project', project, '--input', input,
    '--sport', 'cycling', '--device', 'dji-osmo-action-5-pro', '--delivery', 'landscape-1080p',
    '--duration', '180', '--music', 'provided', '--copy', 'titles', '--max-size-mib', '512',
  ];
  const success = await execFileAsync(process.execPath, args);
  assert.equal(success.stderr, '');
  assert.deepEqual(JSON.parse(success.stdout), { ok: true, project: project, resumed: false, state: 'INTAKE' });

  await assert.rejects(
    execFileAsync(process.execPath, args),
    (error) => {
      assert.equal(error.stderr, '');
      const output = JSON.parse(error.stdout);
      return output.ok === false && output.error.code === 'E_DESTINATION_NOT_EMPTY';
    },
  );
});

test('validateTransition enumerates every allowed and forbidden state edge before evaluating evidence', () => {
  for (const current of ALL_STATES) {
    for (const next of ALL_STATES) {
      const currentIndex = MAIN_STATES.indexOf(current);
      const sequential = currentIndex >= 0 && MAIN_STATES[currentIndex + 1] === next;
      const terminalSide = currentIndex >= 0 && ['BLOCKED', 'CANCELLED'].includes(next);
      const allowed = sequential || terminalSide;
      if (allowed) {
        assert.equal(validateTransition(current, next, evidenceFor(next)), true, `${current} -> ${next}`);
      } else {
        assert.throws(
          () => validateTransition(current, next, evidenceFor(next)),
          (error) => error.code === 'E_STATE_TRANSITION',
          `${current} -> ${next} must be forbidden`,
        );
      }
    }
  }
  assert.throws(
    () => validateTransition('ANALYZE', 'STYLE_ANCHOR', { records: [], currentDigests: {} }),
    (error) => error.code === 'E_STATE_TRANSITION',
    'production Image Gen cannot skip the director lock',
  );
  assert.throws(
    () => validateTransition('ANALYZE', 'FINAL_RENDER', { records: [], currentDigests: {} }),
    (error) => error.code === 'E_STATE_TRANSITION',
    'final rendering cannot skip the director lock',
  );
});

test('validateTransition enforces current auditable evidence and the Style Anchor, asset, and delivery hard gates', () => {
  assert.throws(
    () => validateTransition('ANALYZE', 'ROUGH_CUT', { records: [], currentDigests: {} }),
    (error) => error.code === 'E_EVIDENCE_REQUIRED',
  );
  assert.equal(validateTransition('ANALYZE', 'ROUGH_CUT', evidenceFor('ROUGH_CUT')), true, 'proxy rough cuts are permitted before approval');

  const stale = evidenceFor('ROUGH_CUT');
  stale.currentDigests.ROUGH_CUT_GATE = 'b'.repeat(64);
  assert.throws(
    () => validateTransition('ANALYZE', 'ROUGH_CUT', stale),
    (error) => error.code === 'E_STALE_EVIDENCE',
  );
  const incomplete = evidenceFor('ROUGH_CUT');
  delete incomplete.records[0].producerCommand;
  assert.throws(
    () => validateTransition('ANALYZE', 'ROUGH_CUT', incomplete),
    (error) => error.code === 'E_EVIDENCE_INVALID',
  );

  const unfrozen = evidenceFor('STYLE_ANCHOR');
  unfrozen.records[0].qualifiers = ['approved'];
  assert.throws(
    () => validateTransition('DIRECTOR_LOCK', 'STYLE_ANCHOR', unfrozen),
    (error) => error.code === 'E_STYLE_ANCHOR_GATE',
  );
  const missingCombination = evidenceFor('ASSET_PRODUCTION');
  missingCombination.records.pop();
  assert.throws(
    () => validateTransition('STYLE_ANCHOR', 'ASSET_PRODUCTION', missingCombination),
    (error) => error.code === 'E_ASSET_PRODUCTION_GATE',
  );
  for (const role of ['CLOSED_FILE_PROBE', 'HARD_GATES', 'AGENT_VISUAL_INSPECTION', 'ENCODED_MP4_EVIDENCE']) {
    const insufficient = evidenceFor('DELIVERED');
    insufficient.records = insufficient.records.filter((record) => record.role !== role);
    assert.throws(
      () => validateTransition('FINAL_QA', 'DELIVERED', insufficient),
      (error) => error.code === 'E_DELIVERY_GATE',
      `DELIVERED requires ${role}`,
    );
  }
  assert.equal(validateTransition('FINAL_QA', 'DELIVERED', evidenceFor('DELIVERED')), true);
  assert.equal(validateTransition('DELIVERED', 'USER_ACCEPTED', evidenceFor('USER_ACCEPTED')), true);
  assert.throws(() => validateTransition('BLOCKED', 'DELIVERED', evidenceFor('DELIVERED')), (error) => error.code === 'E_STATE_TRANSITION');
  assert.throws(() => validateTransition('CANCELLED', 'DELIVERED', evidenceFor('DELIVERED')), (error) => error.code === 'E_STATE_TRANSITION');
});

test('invalidation closure rolls back downstream work without touching media/activity facts or frozen digests', () => {
  const graph = {
    MEDIA_INDEX: ['PROBE'],
    PROBE: ['TIMELINE'],
    ACTIVITY: ['DATA_OVERLAYS'],
    DESIGN_SYSTEM: ['ASSET_MANIFEST'],
    LOOK_PROFILE: ['ASSET_MANIFEST'],
    ASSET_MANIFEST: ['MOTION_MAP'],
    TIMELINE: ['MOTION_MAP'],
    MOTION_MAP: ['FINAL_RENDER'],
    FINAL_RENDER: ['REVIEW'],
  };
  assert.deepEqual(
    computeInvalidationClosure(['TIMELINE'], graph),
    ['TIMELINE', 'MOTION_MAP', 'FINAL_RENDER', 'REVIEW'],
  );
  assert.deepEqual(
    computeInvalidationClosure(['DESIGN_SYSTEM'], graph),
    ['DESIGN_SYSTEM', 'ASSET_MANIFEST', 'MOTION_MAP', 'FINAL_RENDER', 'REVIEW'],
  );

  const projectState = {
    state: 'FINAL_QA',
    revision: 12,
    frozenDesignDigest: 'd'.repeat(64),
    frozenLookDigest: 'e'.repeat(64),
  };
  const snapshot = structuredClone(projectState);
  const timelineRollback = rollbackStateForInvalidation(projectState, ['TIMELINE', 'MOTION_MAP', 'FINAL_RENDER', 'REVIEW']);
  assert.equal(timelineRollback.state, 'ASSET_PRODUCTION');
  assert.equal(timelineRollback.frozenDesignDigest, snapshot.frozenDesignDigest);
  assert.equal(timelineRollback.frozenLookDigest, snapshot.frozenLookDigest);
  assert.deepEqual(projectState, snapshot, 'bounded downstream correction is pure');

  const frozenBoundary = rollbackStateForInvalidation(projectState, ['DESIGN_SYSTEM', 'ASSET_MANIFEST', 'MOTION_MAP', 'FINAL_RENDER', 'REVIEW']);
  assert.equal(frozenBoundary.state, 'BLOCKED', 'a frozen design change never reopens or requests approval');
  assert.equal(frozenBoundary.frozenDesignDigest, snapshot.frozenDesignDigest);
  assert.equal(frozenBoundary.frozenLookDigest, snapshot.frozenLookDigest);
});
