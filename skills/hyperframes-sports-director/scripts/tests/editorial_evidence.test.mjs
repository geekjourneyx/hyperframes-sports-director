import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { computeArtifactDigest } from '../lib/contracts.mjs';
import { assertOriginalRegistryOwnership, loadEditorialEvidence } from '../lib/editorial-evidence.mjs';
import { renderRoughCut } from '../render_rough_cut.mjs';
import { validateTimelineFile } from '../validate_timeline.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const digest = (character) => character.repeat(64);

async function template(name) {
  return JSON.parse(await readFile(join(SKILL, 'templates', `${name}.template.json`), 'utf8'));
}

function stamp(value) {
  value.integrity.digest = computeArtifactDigest(value);
  return value;
}

async function authorityFixture({ invalidShot = false } = {}) {
  const project = await mkdtemp(join(tmpdir(), 'hyperframes-editorial-evidence-'));
  for (const directory of ['analysis', 'edit']) await mkdir(join(project, directory), { recursive: true });
  const projectDocument = stamp(await template('PROJECT'));
  const probe = stamp(await template('PROBE'));
  const segments = await template('SEGMENTS');
  segments.integrity.upstream.probe = probe.integrity.digest;
  stamp(segments);
  const shots = await template('SHOT');
  shots.integrity.upstream = { probe: probe.integrity.digest, segments: segments.integrity.digest };
  if (invalidShot) {
    shots.status = 'available';
    shots.shots = [{
      shotId: 'shot-forged', mediaId: 'media-missing', segmentId: 'segment-missing', sourceDigest: digest('1'),
      sourceInSeconds: 0, sourceOutSeconds: 1, sourceDurationSeconds: 1,
      cameraRole: 'unknown', actionRole: 'unknown', environmentTags: ['unknown'], subjectTags: ['unknown'],
      quality: { motionIntensity: 'unknown', blur: 'unknown', shake: 'unknown', exposure: 'unknown', horizon: 'unknown', occlusion: 'unknown' },
      continuity: { screenDirection: 'unknown', motionDirection: 'unknown', subjectEntry: 'unknown', subjectExit: 'unknown', location: 'unknown', timeRelation: 'unknown' },
      audioSpans: [], duplicateGroup: null, setupTailLikelihood: 0, evidenceFrames: ['analysis/evidence/forged.webp'], confidence: 0.1,
    }];
  }
  stamp(shots);
  const transcript = stamp(await template('TRANSCRIPT'));
  const timeline = await template('TIMELINE');
  timeline.integrity.upstream = { probe: probe.integrity.digest, shots: shots.integrity.digest, transcript: transcript.integrity.digest };
  stamp(timeline);
  await writeFile(join(project, 'PROJECT.json'), `${JSON.stringify(projectDocument)}\n`);
  await writeFile(join(project, 'analysis', 'PROBE.json'), `${JSON.stringify(probe)}\n`);
  await writeFile(join(project, 'analysis', 'SEGMENTS.json'), `${JSON.stringify(segments)}\n`);
  await writeFile(join(project, 'analysis', 'SHOTS.jsonl'), `${JSON.stringify(shots)}\n`);
  await writeFile(join(project, 'analysis', 'TRANSCRIPT.json'), `${JSON.stringify(transcript)}\n`);
  await writeFile(join(project, 'edit', 'TIMELINE.json'), `${JSON.stringify(timeline)}\n`);
  return { project, timeline };
}

test('shared editorial loader rejects schema-valid SHOTS that fail current PROBE/SEGMENTS/evidence authority', async () => {
  const { project } = await authorityFixture({ invalidShot: true });
  await assert.rejects(() => loadEditorialEvidence({ project, phase: 'rough' }), (error) => error.code === 'E_SHOTS_INVALID');
});

test('shared editorial loader rejects a stale timeline digest instead of raw JSON acceptance', async () => {
  const { project, timeline } = await authorityFixture();
  timeline.revision = 2;
  await writeFile(join(project, 'edit', 'TIMELINE.json'), `${JSON.stringify(timeline)}\n`);
  await assert.rejects(() => loadEditorialEvidence({ project, phase: 'rough' }), (error) => error.code === 'E_TIMELINE_INVALID');
});

test('timeline CLI API and programmatic rough renderer share cross-artifact authority instead of raw SHOTS JSON', async () => {
  const { project } = await authorityFixture({ invalidShot: true });
  await assert.rejects(() => validateTimelineFile({ project, phase: 'rough' }), (error) => error.code === 'E_SHOTS_INVALID');
  await assert.rejects(
    () => renderRoughCut({ project, probe: { integrity: { digest: digest('a') }, media: [] }, shots: { integrity: { digest: digest('b') }, shots: [] }, transcript: { integrity: { digest: digest('c') }, status: 'unavailable', segments: [] }, timeline: { integrity: { digest: digest('d') }, phase: 'rough', items: [] }, profiles: {} }),
    (error) => error.code === 'E_SHOTS_INVALID',
  );
});

test('final source ownership requires exact immutable registry media ID and digest', () => {
  const registry = { entries: [{ mediaId: 'media-a', sourceDigest: digest('a') }] };
  assert.throws(
    () => assertOriginalRegistryOwnership({ items: [{ sourceMediaId: 'media-a', sourceReference: { digest: digest('b') } }] }, registry),
    (error) => error.code === 'E_ORIGINAL_AUTHORITY',
  );
  assert.throws(
    () => assertOriginalRegistryOwnership({ items: [{ sourceMediaId: 'media-b', sourceReference: { digest: digest('a') } }] }, registry),
    (error) => error.code === 'E_ORIGINAL_AUTHORITY',
  );
});
