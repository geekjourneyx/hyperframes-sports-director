import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  buildDataOverlayAllowList,
  buildSyncMap,
  deduplicateActivities,
  distanceWeightedDistribution,
  normalizeActivity,
  trimPrivateEndpoints,
  weightedAverage,
} from '../lib/activity.mjs';
import { analyzeActivity } from '../analyze_activity.mjs';
import { validateArtifact } from '../lib/contracts.mjs';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'NODE_TEST_CONTEXT'];

function cleanEnv() {
  const env = { ...process.env };
  for (const key of PROXY_KEYS) delete env[key];
  return env;
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(SKILL, 'scripts', 'analyze_activity.mjs'), ...args], {
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

function cycling(overrides = {}) {
  return {
    activityId: 'activity-a',
    sourceId: 'activity-source-a',
    sourceType: 'fit',
    sportProfile: 'cycling',
    startTime: '2026-09-01T10:00:00.000Z',
    distanceMeters: 1200,
    movingTimeSeconds: 120,
    samples: {
      heartRate: [0, 120, null],
      power: [100, 200],
      cadence: [70, 80],
      temperature: [20, 22],
    },
    gradeSegments: [
      { gradePercent: 2, distanceMeters: 600 },
      { gradePercent: 8, distanceMeters: 400 },
      { gradePercent: 30, distanceMeters: 2 },
    ],
    calories: { value: 300, deviceReported: true, coverage: 0.75 },
    route: [
      { latitude: 10, longitude: 20, distanceMeters: 0, timestamp: '2026-09-01T10:00:00.000Z' },
      { latitude: 10.001, longitude: 20.001, distanceMeters: 300, timestamp: '2026-09-01T10:00:30.000Z' },
      { latitude: 10.002, longitude: 20.002, distanceMeters: 900, timestamp: '2026-09-01T10:01:30.000Z' },
      { latitude: 10.003, longitude: 20.003, distanceMeters: 1200, timestamp: '2026-09-01T10:02:00.000Z' },
    ],
    ...overrides,
  };
}

function fitSessionFixture({ calories = 300 } = {}) {
  const definition = Buffer.from([
    0x40, 0x00, 0x00, 0x12, 0x00, 0x05,
    0x05, 0x01, 0x00,
    0x02, 0x04, 0x86,
    0x08, 0x04, 0x86,
    0x09, 0x04, 0x86,
    0x0b, 0x02, 0x84,
  ]);
  const record = Buffer.alloc(16);
  record[0] = 0x00;
  record[1] = 0x02;
  record.writeUInt32LE(1_157_932_800, 2);
  record.writeUInt32LE(120_000, 6);
  record.writeUInt32LE(120_000, 10);
  record.writeUInt16LE(calories, 14);
  const recordDefinition = Buffer.from([
    0x41, 0x00, 0x00, 0x14, 0x00, 0x02,
    0xfd, 0x04, 0x86,
    0x03, 0x01, 0x02,
  ]);
  const firstRecord = Buffer.alloc(6);
  firstRecord[0] = 0x01;
  firstRecord.writeUInt32LE(100, 1);
  firstRecord[5] = 0;
  const compressedRecord = Buffer.from([0xa5, 0xff]);
  const data = Buffer.concat([definition, record, recordDefinition, firstRecord, compressedRecord]);
  const header = Buffer.alloc(14);
  header[0] = 14;
  header[1] = 0x10;
  header.writeUInt16LE(100, 2);
  header.writeUInt32LE(data.length, 4);
  header.write('.FIT', 8, 'ascii');
  return Buffer.concat([header, data]);
}

test('activity truth preserves missing values, uses weighted formulas, trims routes, and derives authority', () => {
  assert.equal(weightedAverage([{ value: 100, weight: 1 }, { value: null, weight: 100 }, { value: 200, weight: 2 }]), 500 / 3);
  assert.deepEqual(distanceWeightedDistribution([
    { gradePercent: 2, distanceMeters: 60 },
    { gradePercent: 8, distanceMeters: 40 },
    { gradePercent: 40, distanceMeters: 2 },
  ], { minimumSegmentMeters: 5 }), { flat: 0.6, climb: 0.4, descent: 0, analyzedDistanceMeters: 100 });

  const duplicate = cycling({ activityId: 'duplicate', sourceId: 'source-duplicate' });
  const distinct = cycling({ activityId: 'distinct', sourceId: 'source-distinct', startTime: '2026-09-01T11:00:00.000Z' });
  assert.deepEqual(deduplicateActivities([cycling(), duplicate, distinct]).map(({ activityId }) => activityId), ['activity-a', 'distinct']);

  const activity = normalizeActivity([cycling(), distinct]);
  assert.equal(activity.status, 'available');
  assert.equal(activity.metrics.averageHeartRate, 60, 'recorded zero is a valid sample and missing is ignored');
  assert.equal(activity.metrics.averageSpeed, 10, 'speed is total distance divided by total moving time');
  assert.equal(activity.metrics.averagePower, 150);
  assert.equal(activity.metrics.averageCadence, 75);
  assert.equal(activity.metrics.averageTemperature, 21);
  assert.equal(activity.metrics.calories, 600);
  assert.equal(activity.coverage.calories, 0.75);
  assert.equal(activity.metrics.gradeDistribution.analyzedDistanceMeters, 2000);
  const unpaired = normalizeActivity([
    cycling({ activityId: 'distance-only', startTime: '2026-09-03T10:00:00Z', movingTimeSeconds: undefined }),
    cycling({ activityId: 'time-only', startTime: '2026-09-03T11:00:00Z', distanceMeters: undefined, route: undefined }),
  ]);
  assert.equal(unpaired.metrics.averageSpeed, null, 'distance and moving time from unlike activities cannot be spliced');
  const calorieCoverage = normalizeActivity([
    cycling({ activityId: 'cal-a', startTime: '2026-09-04T10:00:00Z', movingTimeSeconds: 100, calories: { value: 900, deviceReported: true, coverage: 0.2 } }),
    cycling({ activityId: 'cal-b', startTime: '2026-09-04T11:00:00Z', movingTimeSeconds: 300, calories: { value: 100, deviceReported: true, coverage: 0.8 } }),
  ]);
  assert.equal(calorieCoverage.coverage.calories, 0.65, 'calorie coverage is time-weighted, not calorie-value-weighted');

  const missingHeartRate = normalizeActivity([cycling({ samples: { heartRate: [], power: [0], cadence: [], temperature: [] } })]);
  assert.equal(missingHeartRate.metrics.averageHeartRate, null);
  assert.equal(missingHeartRate.availability.heartRate, 'unavailable');
  assert.equal(missingHeartRate.metrics.averagePower, 0, 'recorded zero must remain zero');

  const trimmed = trimPrivateEndpoints(cycling().route, { trimStartMeters: 300, trimEndMeters: 300 });
  assert.deepEqual(trimmed.points.map(({ distanceMeters }) => distanceMeters), [0, 600]);
  assert.match(trimmed.routeId, /^trimmed-route-[0-9a-f]{16}$/);
  assert.equal(JSON.stringify(trimmed).includes('10.000'), false, 'private start coordinate is removed');
  assert.equal(JSON.stringify(trimmed).includes('10.003'), false, 'private end coordinate is removed');

  const absolute = buildSyncMap({ method: 'absolute-timestamp', mediaStartTime: '2026-09-01T10:00:10.000Z', activityStartTime: '2026-09-01T10:00:00.000Z', durationSeconds: 100 });
  const manual = buildSyncMap({ method: 'manual-anchor', anchors: [{ mediaSeconds: 20, activitySeconds: 10 }], durationSeconds: 100 });
  const offset = buildSyncMap({ method: 'declared-offset', offsetSeconds: 10, durationSeconds: 100 });
  assert.deepEqual(absolute.anchors, [{ mediaSeconds: 0, activitySeconds: 10 }]);
  assert.deepEqual(manual.anchors, [{ mediaSeconds: 20, activitySeconds: 10 }]);
  assert.deepEqual(offset.anchors, [{ mediaSeconds: 10, activitySeconds: 0 }]);
  assert.deepEqual(offset.validInterval, { startSeconds: 10, endSeconds: 110 });
  const sortedManual = buildSyncMap({ method: 'manual-anchor', anchors: [{ mediaSeconds: 20, activitySeconds: 10 }, { mediaSeconds: 10, activitySeconds: 0 }], durationSeconds: 100 });
  assert.deepEqual(sortedManual.anchors, [{ mediaSeconds: 10, activitySeconds: 0 }, { mediaSeconds: 20, activitySeconds: 10 }]);
  assert.equal(buildSyncMap({ method: 'manual-anchor', anchors: [{ mediaSeconds: 10, activitySeconds: 0 }, { mediaSeconds: 10, activitySeconds: 5 }] }).status, 'unavailable');
  assert.equal(buildSyncMap({ method: 'manual-anchor', anchors: [{ mediaSeconds: 10, activitySeconds: 10 }, { mediaSeconds: 20, activitySeconds: 5 }] }).status, 'unavailable');
  assert.equal(buildSyncMap({ method: 'absolute-timestamp', mediaStartTime: '2026-09-01T10:02:00Z', activityStartTime: '2026-09-01T10:00:00Z', durationSeconds: 100 }).status, 'unavailable');
  const earlyMedia = buildSyncMap({ method: 'absolute-timestamp', mediaStartTime: '2026-09-01T09:59:50Z', activityStartTime: '2026-09-01T10:00:00Z', durationSeconds: 100 });
  assert.deepEqual(earlyMedia.anchors, [{ mediaSeconds: 10, activitySeconds: 0 }]);
  assert.deepEqual(earlyMedia.validInterval, { startSeconds: 10, endSeconds: 110 });

  const authority = buildDataOverlayAllowList(activity, absolute, {
    metricWindows: { averageHeartRate: { destinationInSeconds: 0, destinationOutSeconds: 8 } },
  });
  assert.equal(authority.overlays.find(({ metricId }) => metricId === 'metrics.averageHeartRate').displayAuthority, 'visible-with-caveat');
  assert.equal(authority.overlays.find(({ metricId }) => metricId === 'metrics.averageHeartRate').syncAuthority, 'time-synchronized');
  const thresholdCases = [[0.09, undefined], [0.1, 'local-observation'], [0.4, 'visible-with-caveat'], [0.8, 'whole-activity']];
  for (const [coverage, expected] of thresholdCases) {
    const candidate = structuredClone(activity);
    candidate.coverage.heartRate = coverage;
    const overlay = buildDataOverlayAllowList(candidate, absolute, { metricWindows: { averageHeartRate: { destinationInSeconds: 0, destinationOutSeconds: 1 } } })
      .overlays.find(({ metricId }) => metricId === 'metrics.averageHeartRate');
    assert.equal(overlay?.displayAuthority, expected);
  }
  assert.throws(
    () => normalizeActivity([cycling(), cycling({ activityId: 'hike', sportProfile: 'hiking', startTime: '2026-09-02T10:00:00Z' })]),
    (error) => error.code === 'E_ACTIVITY_INCOMPARABLE',
  );
});

test('KML without time and pool swimming without GPS remain truthful and non-blocking', () => {
  const kml = normalizeActivity([{ activityId: 'kml', sourceId: 'kml-source', sourceType: 'kml', sportProfile: 'hiking', route: [{ latitude: 1, longitude: 2, distanceMeters: 0 }, { latitude: 1.1, longitude: 2.1, distanceMeters: 1000 }] }]);
  assert.equal(kml.metrics.distance, 1000);
  for (const key of ['movingTime', 'averageSpeed', 'pace', 'pauseTime']) assert.equal(kml.metrics[key], null);
  assert.equal(buildSyncMap({ method: 'absolute-timestamp', activityStartTime: null, mediaStartTime: '2026-09-01T10:00:00Z' }).status, 'unavailable');

  const pool = normalizeActivity([{ activityId: 'swim', sourceId: 'swim-source', sourceType: 'normalized-json', sportProfile: 'pool-swimming', distanceMeters: 1000, movingTimeSeconds: 1200, samples: {} }]);
  assert.equal(pool.status, 'available');
  assert.equal(pool.route.status, 'unavailable');
  assert.equal(pool.reasons.route, 'gps-not-required-for-pool-swimming');
  const poolWithGps = normalizeActivity([{
    activityId: 'swim-gps', sourceType: 'normalized-json', sportProfile: 'pool-swimming', distanceMeters: 1000, movingTimeSeconds: 1200, samples: {}, route: cycling().route,
  }], { trimmedRoute: trimPrivateEndpoints(cycling().route, { trimStartMeters: 300, trimEndMeters: 300 }) });
  assert.equal(poolWithGps.route.status, 'unavailable', 'pool profile never authorizes GPS output');

  const poolOverlays = buildDataOverlayAllowList(pool, buildSyncMap({ method: 'none' }), { primaryMetricIds: ['movingTime'] });
  assert.equal(poolOverlays.overlays.find(({ metricId }) => metricId === 'metrics.movingTime').displayAuthority, 'whole-activity');
  assert.equal(poolOverlays.overlays.find(({ metricId }) => metricId === 'metrics.distance').displayAuthority, 'visible-with-caveat');

  const unavailable = normalizeActivity([]);
  assert.equal(unavailable.status, 'unavailable');
  assert.deepEqual(buildDataOverlayAllowList(unavailable, buildSyncMap({ method: 'none' })).overlays, []);
});

test('analyze_activity writes only integrity-valid portable artifacts and rejects invalid input atomically', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-activity-'));
  const project = join(scratch, 'project');
  const privateInput = join(scratch, 'private-ride-name.json');
  await mkdir(join(project, 'analysis'), { recursive: true });
  await mkdir(join(project, 'direction'), { recursive: true });
  await writeFile(privateInput, JSON.stringify(cycling()));
  const success = await runCli(['--input', privateInput, '--project', project, '--trim-start-m', '300', '--trim-end-m', '300', '--sync-method', 'declared-offset', '--offset-seconds', '10']);
  assert.equal(success.code, 0, success.stderr || success.stdout);
  assert.equal(success.stderr, '');
  const output = JSON.parse(success.stdout);
  assert.equal(output.ok, true);
  assert.match(output.trimmedRouteId, /^trimmed-route-/);
  const writtenActivity = JSON.parse(await readFile(join(project, 'analysis/ACTIVITY.json'), 'utf8'));
  assert.deepEqual(writtenActivity.route.points.map(({ latitude, longitude }) => [latitude, longitude]), [[10.001, 20.001], [10.002, 20.002]]);
  const writtenOverlays = JSON.parse(await readFile(join(project, 'direction/DATA_OVERLAYS.json'), 'utf8'));
  assert.deepEqual(writtenOverlays.publicRoute, { status: 'available', trimmedRouteId: output.trimmedRouteId });
  for (const [path, schema] of [['analysis/ACTIVITY.json', 'activity'], ['analysis/SYNC_MAP.json', 'sync-map'], ['direction/DATA_OVERLAYS.json', 'data-overlays']]) {
    assert.equal((await validateArtifact(join(project, path), schema)).valid, true, path);
    const portable = await readFile(join(project, path), 'utf8');
    assert.equal(portable.includes(scratch), false);
    assert.equal(portable.includes('private-ride-name'), false);
  }

  const badProject = join(scratch, 'bad-project');
  const badInput = join(scratch, 'secret-invalid.json');
  await mkdir(join(badProject, 'analysis'), { recursive: true });
  await mkdir(join(badProject, 'direction'), { recursive: true });
  await writeFile(badInput, '{bad');
  const failure = await runCli(['--input', badInput, '--project', badProject]);
  assert.equal(failure.code, 1);
  const diagnostic = JSON.parse(failure.stdout);
  assert.equal(diagnostic.error.code, 'E_ACTIVITY_INPUT');
  assert.equal(diagnostic.error.message.includes(badInput), false);
  for (const path of ['analysis/ACTIVITY.json', 'analysis/SYNC_MAP.json', 'direction/DATA_OVERLAYS.json']) {
    await assert.rejects(access(join(badProject, path)));
  }
});

test('analyze_activity rolls back all three artifacts when the third commit rename fails', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-activity-transaction-'));
  const project = join(scratch, 'project');
  const input = join(scratch, 'activity.json');
  const paths = ['analysis/ACTIVITY.json', 'analysis/SYNC_MAP.json', 'direction/DATA_OVERLAYS.json'];
  await mkdir(join(project, 'analysis'), { recursive: true });
  await mkdir(join(project, 'direction'), { recursive: true });
  await writeFile(input, JSON.stringify(cycling()));
  for (const path of paths) await writeFile(join(project, path), `old:${path}\n`);

  let committedRenames = 0;
  let exitCode = 0;
  try {
    await analyzeActivity({ input, project, trimStartMeters: 300, trimEndMeters: 300 }, {
      fileOps: {
        rename: async (source, destination) => {
          if (source.includes('.tmp-') && (committedRenames += 1) === 3) {
            const error = new Error('deterministic third-commit failure');
            error.code = 'EIO';
            throw error;
          }
          return rename(source, destination);
        },
      },
    });
  } catch (error) {
    exitCode = error.code === 'E_ACTIVITY_WRITE' ? 1 : 2;
  }
  assert.equal(exitCode, 1, 'transaction failure must produce a non-zero analyzer result');
  for (const path of paths) assert.equal(await readFile(join(project, path), 'utf8'), `old:${path}\n`);
  assert.deepEqual((await readdir(join(project, 'analysis'))).sort(), ['ACTIVITY.json', 'SYNC_MAP.json']);
  assert.deepEqual(await readdir(join(project, 'direction')), ['DATA_OVERLAYS.json']);

  const unsafeProject = join(scratch, 'unsafe-project');
  await mkdir(join(unsafeProject, 'analysis'), { recursive: true });
  await mkdir(join(unsafeProject, 'direction', 'DATA_OVERLAYS.json'), { recursive: true });
  await writeFile(join(unsafeProject, 'analysis', 'ACTIVITY.json'), 'old-activity\n');
  await writeFile(join(unsafeProject, 'analysis', 'SYNC_MAP.json'), 'old-sync\n');
  await assert.rejects(
    analyzeActivity({ input, project: unsafeProject }),
    (error) => error.code === 'E_ACTIVITY_OUTPUT' && !error.message.includes(unsafeProject),
  );
  assert.equal(await readFile(join(unsafeProject, 'analysis', 'ACTIVITY.json'), 'utf8'), 'old-activity\n');
  assert.equal(await readFile(join(unsafeProject, 'analysis', 'SYNC_MAP.json'), 'utf8'), 'old-sync\n');
  assert.deepEqual(await readdir(join(unsafeProject, 'direction')), ['DATA_OVERLAYS.json']);
});

test('analyze_activity accepts real FIT and KML contracts and the no-input branch', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'hyperframes-activity-formats-'));

  const fitInput = join(scratch, 'private-device-export.fit');
  const fitProject = join(scratch, 'fit-project');
  await mkdir(join(fitProject, 'analysis'), { recursive: true });
  await mkdir(join(fitProject, 'direction'), { recursive: true });
  await writeFile(fitInput, fitSessionFixture());
  const fitResult = await runCli(['--input', fitInput, '--project', fitProject]);
  assert.equal(fitResult.code, 0, fitResult.stderr || fitResult.stdout);
  const fitActivity = JSON.parse(await readFile(join(fitProject, 'analysis/ACTIVITY.json'), 'utf8'));
  assert.equal(fitActivity.metrics.distance, 1200);
  assert.equal(fitActivity.metrics.movingTime, 120);
  assert.equal(fitActivity.metrics.calories, 300);
  assert.equal(fitActivity.metrics.averageHeartRate, 0, 'FIT zero is retained while a sentinel sample is ignored');
  assert.equal(JSON.stringify(fitActivity).includes('private-device-export'), false);

  const sentinelInput = join(scratch, 'sentinel.fit');
  const sentinelProject = join(scratch, 'sentinel-project');
  await mkdir(join(sentinelProject, 'analysis'), { recursive: true });
  await mkdir(join(sentinelProject, 'direction'), { recursive: true });
  await writeFile(sentinelInput, fitSessionFixture({ calories: 0xffff }));
  assert.equal((await runCli(['--input', sentinelInput, '--project', sentinelProject])).code, 0);
  assert.equal(JSON.parse(await readFile(join(sentinelProject, 'analysis/ACTIVITY.json'), 'utf8')).metrics.calories, null);

  const kmlInput = join(scratch, 'private-route-name.kml');
  const kmlProject = join(scratch, 'kml-project');
  await mkdir(join(kmlProject, 'analysis'), { recursive: true });
  await mkdir(join(kmlProject, 'direction'), { recursive: true });
  await writeFile(kmlInput, '<?xml version="1.0"?><kml><LineString><coordinates>20,10 20.001,10.001 20.002,10.002 20.003,10.003</coordinates></LineString></kml>');
  const kmlResult = await runCli(['--input', kmlInput, '--project', kmlProject, '--trim-start-m', '100', '--trim-end-m', '100', '--sync-method', 'declared-offset', '--offset-seconds', '10']);
  assert.equal(kmlResult.code, 0, kmlResult.stderr || kmlResult.stdout);
  const kmlActivity = JSON.parse(await readFile(join(kmlProject, 'analysis/ACTIVITY.json'), 'utf8'));
  const kmlSync = JSON.parse(await readFile(join(kmlProject, 'analysis/SYNC_MAP.json'), 'utf8'));
  assert.equal(kmlActivity.metrics.movingTime, null);
  assert.equal(kmlActivity.metrics.averageSpeed, null);
  assert.equal(kmlActivity.route.status, 'available');
  assert.equal(kmlActivity.route.points.length, 2);
  assert.equal(kmlSync.status, 'unavailable');

  const oneSidedProject = join(scratch, 'one-sided-project');
  const oneSidedInput = join(scratch, 'one-sided.json');
  await mkdir(join(oneSidedProject, 'analysis'), { recursive: true });
  await mkdir(join(oneSidedProject, 'direction'), { recursive: true });
  await writeFile(oneSidedInput, JSON.stringify(cycling()));
  assert.equal((await runCli(['--input', oneSidedInput, '--project', oneSidedProject, '--trim-start-m', '300'])).code, 0);
  const oneSided = JSON.parse(await readFile(join(oneSidedProject, 'analysis/ACTIVITY.json'), 'utf8'));
  assert.equal(oneSided.route.status, 'available');
  assert.deepEqual(oneSided.route.points.map(({ latitude }) => latitude), [10.001, 10.002, 10.003]);

  const poolProject = join(scratch, 'pool-project');
  const poolInput = join(scratch, 'pool.json');
  await mkdir(join(poolProject, 'analysis'), { recursive: true });
  await mkdir(join(poolProject, 'direction'), { recursive: true });
  await writeFile(poolInput, JSON.stringify({ ...cycling(), activityId: 'pool', sportProfile: 'pool-swimming' }));
  assert.equal((await runCli(['--input', poolInput, '--project', poolProject, '--trim-start-m', '300', '--trim-end-m', '300'])).code, 0);
  const poolActivity = JSON.parse(await readFile(join(poolProject, 'analysis/ACTIVITY.json'), 'utf8'));
  const poolData = JSON.parse(await readFile(join(poolProject, 'direction/DATA_OVERLAYS.json'), 'utf8'));
  assert.equal(poolActivity.route.status, 'unavailable');
  assert.deepEqual(poolData.publicRoute, { status: 'unavailable', trimmedRouteId: null });

  const emptyProject = join(scratch, 'empty-project');
  await mkdir(join(emptyProject, 'analysis'), { recursive: true });
  await mkdir(join(emptyProject, 'direction'), { recursive: true });
  const emptyResult = await runCli(['--project', emptyProject]);
  assert.equal(emptyResult.code, 0, emptyResult.stderr || emptyResult.stdout);
  const emptyActivity = JSON.parse(await readFile(join(emptyProject, 'analysis/ACTIVITY.json'), 'utf8'));
  const emptyOverlays = JSON.parse(await readFile(join(emptyProject, 'direction/DATA_OVERLAYS.json'), 'utf8'));
  assert.equal(emptyActivity.status, 'unavailable');
  assert.deepEqual(emptyOverlays.overlays, []);

  const emptyKmlProject = join(scratch, 'empty-kml-project');
  const emptyKmlInput = join(scratch, 'empty.kml');
  await mkdir(join(emptyKmlProject, 'analysis'), { recursive: true });
  await mkdir(join(emptyKmlProject, 'direction'), { recursive: true });
  await writeFile(emptyKmlInput, '<?xml version="1.0"?><kml><Document/></kml>');
  const emptyKmlResult = await runCli(['--input', emptyKmlInput, '--project', emptyKmlProject]);
  assert.equal(emptyKmlResult.code, 0, emptyKmlResult.stderr || emptyKmlResult.stdout);
  assert.equal(JSON.parse(await readFile(join(emptyKmlProject, 'analysis/ACTIVITY.json'), 'utf8')).status, 'unavailable');

  const badGxProject = join(scratch, 'bad-gx-project');
  const badGxInput = join(scratch, 'bad-gx.kml');
  await mkdir(join(badGxProject, 'analysis'), { recursive: true });
  await mkdir(join(badGxProject, 'direction'), { recursive: true });
  for (const path of ['analysis/ACTIVITY.json', 'analysis/SYNC_MAP.json', 'direction/DATA_OVERLAYS.json']) {
    await writeFile(join(badGxProject, path), `existing-${path}\n`);
  }
  await writeFile(badGxInput, '<kml xmlns:gx="x"><gx:Track><gx:coord>bad 10 0</gx:coord></gx:Track></kml>');
  const badGxResult = await runCli(['--input', badGxInput, '--project', badGxProject]);
  assert.equal(badGxResult.code, 1);
  assert.equal(JSON.parse(badGxResult.stdout).error.code, 'E_ACTIVITY_INPUT');
  for (const path of ['analysis/ACTIVITY.json', 'analysis/SYNC_MAP.json', 'direction/DATA_OVERLAYS.json']) {
    assert.equal(await readFile(join(badGxProject, path), 'utf8'), `existing-${path}\n`, 'invalid input must not partially replace existing artifacts');
  }
});
