/*
 * HyperFrames Sports Director activity normalization.
 * Copyright (C) 2026 HyperFrames Sports Director contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * The truth/coverage/privacy invariants are adapted from Guizang Sports Skill
 * at the exact revision recorded in UPSTREAM.lock.json. This implementation is
 * independent and keeps deterministic facts separate from Agent interpretation.
 */
import { createHash } from 'node:crypto';

const METRICS = {
  averageHeartRate: 'heartRate',
  distance: 'distance',
  movingTime: 'movingTime',
  averageSpeed: 'speed',
  elevationGain: 'elevationGain',
  averagePower: 'power',
  averageCadence: 'cadence',
  averageTemperature: 'temperature',
  pace: 'pace',
  pauseTime: 'pauseTime',
  calories: 'calories',
  gradeDistribution: 'gradeDistribution',
};

export class ActivityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ActivityError';
    this.code = code;
  }
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function round(value, digits = 9) {
  return Number(value.toFixed(digits));
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function weightedAverage(entries) {
  let weighted = 0;
  let weight = 0;
  for (const entry of entries ?? []) {
    if (!finite(entry?.value) || !finite(entry?.weight) || entry.weight <= 0) continue;
    weighted += entry.value * entry.weight;
    weight += entry.weight;
  }
  return weight === 0 ? null : weighted / weight;
}

export function distanceWeightedDistribution(segments, { minimumSegmentMeters = 5 } = {}) {
  const totals = { flat: 0, climb: 0, descent: 0 };
  for (const segment of segments ?? []) {
    if (!finite(segment?.gradePercent) || !finite(segment?.distanceMeters)
      || segment.distanceMeters < minimumSegmentMeters) continue;
    const bucket = segment.gradePercent >= 5 ? 'climb' : segment.gradePercent <= -5 ? 'descent' : 'flat';
    totals[bucket] += segment.distanceMeters;
  }
  const analyzedDistanceMeters = totals.flat + totals.climb + totals.descent;
  if (analyzedDistanceMeters === 0) return null;
  return {
    flat: round(totals.flat / analyzedDistanceMeters),
    climb: round(totals.climb / analyzedDistanceMeters),
    descent: round(totals.descent / analyzedDistanceMeters),
    analyzedDistanceMeters: round(analyzedDistanceMeters),
  };
}

function duplicateKey(activity) {
  return activity?.startTime
    ? [activity.sportProfile, activity.startTime, activity.distanceMeters ?? null, activity.movingTimeSeconds ?? null].join('|')
    : [activity?.sportProfile, activity?.activityId ?? activity?.sourceId ?? digest(activity)].join('|');
}

export function deduplicateActivities(activities) {
  const seen = new Set();
  return (activities ?? []).filter((activity) => {
    const key = duplicateKey(activity);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function routeDistance(route) {
  const points = route ?? [];
  if (points.length < 2) return null;
  const first = points[0]?.distanceMeters;
  const last = points.at(-1)?.distanceMeters;
  return finite(first) && finite(last) && last >= first ? last - first : null;
}

function safeSourceId(activity, index) {
  const candidate = activity?.sourceId;
  return typeof candidate === 'string' && /^activity-source-[a-zA-Z0-9-]+$/.test(candidate)
    ? candidate
    : `activity-source-${digest({ index, activity }).slice(0, 16)}`;
}

function validSamples(activities, key) {
  return activities.flatMap((activity) => (activity.samples?.[key] ?? []).filter(finite));
}

function coverageForSamples(activities, key) {
  const declared = activities.flatMap((activity) => {
    const value = activity.coverage?.[key];
    if (!finite(value)) return [];
    const weight = Math.max(1, activity.samples?.[key]?.length ?? 0);
    return [{ value, weight }];
  });
  if (declared.length > 0) return round(weightedAverage(declared));
  const counts = activities.map((activity) => activity.samples?.[key]?.length ?? 0);
  const valid = validSamples(activities, key).length;
  const total = counts.reduce((sum, value) => sum + value, 0);
  return total > 0 ? round(valid / total) : (valid > 0 ? 1 : null);
}

function unavailableDocument() {
  const metrics = Object.fromEntries(Object.keys(METRICS).map((key) => [key, null]));
  const authorityKeys = [...new Set(Object.values(METRICS)), 'route'];
  return {
    status: 'unavailable', metrics,
    availability: Object.fromEntries(authorityKeys.map((key) => [key, 'unavailable'])),
    coverage: Object.fromEntries(authorityKeys.map((key) => [key, null])),
    reasons: Object.fromEntries(authorityKeys.map((key) => [key, 'activity-data-unavailable'])),
    sources: Object.fromEntries(authorityKeys.map((key) => [key, null])),
    sportProfiles: [],
    route: { status: 'unavailable', trimmedRouteId: null, pointCount: 0, points: [] },
  };
}

function setTuple(document, metricId, value, coverage, sources, reason = 'source-value-unavailable') {
  const authority = METRICS[metricId];
  document.metrics[metricId] = value;
  document.availability[authority] = value === null ? 'unavailable' : 'available';
  document.coverage[authority] = value === null ? null : coverage;
  document.reasons[authority] = value === null ? reason : null;
  document.sources[authority] = value === null ? null : sources.join(',');
}

export function normalizeActivity(input, { trimmedRoute = null } = {}) {
  const raw = Array.isArray(input) ? input : input ? [input] : [];
  if (raw.some((activity) => activity === null || typeof activity !== 'object' || Array.isArray(activity))) {
    throw new ActivityError('E_ACTIVITY_INPUT', 'activity input must contain objects');
  }
  const activities = deduplicateActivities(raw);
  if (activities.length === 0) return unavailableDocument();
  const sports = [...new Set(activities.map(({ sportProfile }) => sportProfile).filter(Boolean))];
  if (sports.length > 1) throw new ActivityError('E_ACTIVITY_INCOMPARABLE', 'activities from unlike sport profiles cannot be aggregated or ranked');
  const sources = activities.map(safeSourceId);
  const document = unavailableDocument();
  document.status = 'available';
  document.sportProfiles = sports;

  const distances = activities.map((activity) => finite(activity.distanceMeters) ? activity.distanceMeters : routeDistance(activity.route)).filter(finite);
  const movingTimes = activities.map(({ movingTimeSeconds }) => movingTimeSeconds).filter(finite);
  const totalDistance = distances.length > 0 ? distances.reduce((sum, value) => sum + value, 0) : null;
  const totalMovingTime = movingTimes.length > 0 ? movingTimes.reduce((sum, value) => sum + value, 0) : null;
  setTuple(document, 'distance', totalDistance, totalDistance === null ? null : distances.length / activities.length, sources);
  setTuple(document, 'movingTime', totalMovingTime, totalMovingTime === null ? null : movingTimes.length / activities.length, sources,
    activities.every(({ sourceType, route }) => sourceType === 'kml' && !(route ?? []).some(({ timestamp }) => timestamp)) ? 'kml-has-no-timestamps' : 'moving-time-unavailable');
  const speedPairs = activities.flatMap((activity) => {
    const distance = finite(activity.distanceMeters) ? activity.distanceMeters : routeDistance(activity.route);
    return finite(distance) && finite(activity.movingTimeSeconds) && activity.movingTimeSeconds > 0
      ? [{ distance, movingTime: activity.movingTimeSeconds }] : [];
  });
  const pairedDistance = speedPairs.reduce((sum, pair) => sum + pair.distance, 0);
  const pairedMovingTime = speedPairs.reduce((sum, pair) => sum + pair.movingTime, 0);
  const speedCoverage = speedPairs.length > 0 ? speedPairs.length / activities.length : null;
  setTuple(document, 'averageSpeed', pairedMovingTime > 0 ? pairedDistance / pairedMovingTime : null,
    speedCoverage, sources, 'paired-distance-and-moving-time-unavailable');
  setTuple(document, 'pace', pairedDistance > 0 ? pairedMovingTime / (pairedDistance / 1000) : null,
    speedCoverage, sources, 'paired-distance-and-moving-time-unavailable');

  const pauseTimes = activities.map(({ pauseTimeSeconds }) => pauseTimeSeconds).filter(finite);
  setTuple(document, 'pauseTime', pauseTimes.length > 0 ? pauseTimes.reduce((sum, value) => sum + value, 0) : null,
    pauseTimes.length > 0 ? pauseTimes.length / activities.length : null, sources,
    activities.every(({ sourceType, route }) => sourceType === 'kml' && !(route ?? []).some(({ timestamp }) => timestamp)) ? 'kml-has-no-timestamps' : 'pause-time-unavailable');

  for (const [metricId, sampleKey] of [['averageHeartRate', 'heartRate'], ['averagePower', 'power'], ['averageCadence', 'cadence'], ['averageTemperature', 'temperature']]) {
    const samples = validSamples(activities, sampleKey);
    setTuple(document, metricId, samples.length > 0 ? samples.reduce((sum, value) => sum + value, 0) / samples.length : null,
      coverageForSamples(activities, sampleKey), sources, `${sampleKey}-unavailable`);
  }

  const gains = activities.map(({ elevationGainMeters }) => elevationGainMeters).filter(finite);
  setTuple(document, 'elevationGain', gains.length > 0 ? gains.reduce((sum, value) => sum + value, 0) : null,
    gains.length > 0 ? gains.length / activities.length : null, sources, 'elevation-gain-unavailable');
  const grades = distanceWeightedDistribution(activities.flatMap(({ gradeSegments }) => gradeSegments ?? []));
  setTuple(document, 'gradeDistribution', grades, grades === null || totalDistance === null ? null : Math.min(1, grades.analyzedDistanceMeters / totalDistance), sources, 'grade-distribution-unavailable');

  const reportedCalories = activities.map(({ calories }) => calories).filter((entry) => finite(entry?.value) && entry.deviceReported === true);
  const calories = reportedCalories.length > 0 ? reportedCalories.reduce((sum, entry) => sum + entry.value, 0) : null;
  const calorieCoverage = calories === null ? null : weightedAverage(reportedCalories.map((entry) => {
    const activity = activities.find(({ calories: candidate }) => candidate === entry);
    return { value: entry.coverage, weight: finite(activity?.movingTimeSeconds) && activity.movingTimeSeconds > 0 ? activity.movingTimeSeconds : 1 };
  }));
  setTuple(document, 'calories', calories, calorieCoverage, sources, 'device-reported-calories-unavailable');

  const hasRoute = activities.some(({ route }) => Array.isArray(route) && route.length > 1);
  const routePermitted = sports[0] !== 'pool-swimming';
  document.route = trimmedRoute && routePermitted ? { status: 'available', trimmedRouteId: trimmedRoute.routeId, pointCount: trimmedRoute.points.length, points: trimmedRoute.points }
    : { status: 'unavailable', trimmedRouteId: null, pointCount: 0, points: [] };
  document.availability.route = trimmedRoute && routePermitted ? 'available' : 'unavailable';
  document.coverage.route = trimmedRoute && routePermitted && hasRoute ? 1 : null;
  document.reasons.route = trimmedRoute && routePermitted ? null : sports[0] === 'pool-swimming' ? 'gps-not-required-for-pool-swimming' : hasRoute ? 'privacy-trim-required' : 'route-unavailable';
  document.sources.route = trimmedRoute && routePermitted ? sources.join(',') : null;
  if (Object.values(document.metrics).every((value) => value === null)) {
    const unavailable = unavailableDocument();
    unavailable.sportProfiles = sports;
    for (const key of Object.keys(unavailable.reasons)) unavailable.reasons[key] = 'activity-source-has-no-usable-data';
    return unavailable;
  }
  return document;
}

export function trimPrivateEndpoints(route, { trimStartMeters = 0, trimEndMeters = 0 } = {}) {
  if (!Array.isArray(route) || route.length < 2) throw new ActivityError('E_ROUTE_UNAVAILABLE', 'route requires at least two points');
  if (!finite(trimStartMeters) || !finite(trimEndMeters) || trimStartMeters < 0 || trimEndMeters < 0) {
    throw new ActivityError('E_PRIVACY_TRIM', 'privacy trim distances must be non-negative');
  }
  const origin = route[0].distanceMeters;
  const total = route.at(-1).distanceMeters - origin;
  if (!finite(origin) || !finite(total) || total <= trimStartMeters + trimEndMeters) {
    throw new ActivityError('E_PRIVACY_TRIM', 'privacy trim removes the complete route');
  }
  const selected = route.filter(({ distanceMeters }) => distanceMeters - origin >= trimStartMeters
    && distanceMeters - origin <= total - trimEndMeters);
  if (selected.length < 2) throw new ActivityError('E_PRIVACY_TRIM', 'privacy trim must retain at least two route points');
  const base = selected[0].distanceMeters;
  const points = selected.map(({ latitude, longitude, distanceMeters, timestamp }) => ({
    latitude, longitude, distanceMeters: round(distanceMeters - base), ...(timestamp ? { timestamp } : {}),
  }));
  return { routeId: `trimmed-route-${digest(points).slice(0, 16)}`, points };
}

export function buildSyncMap(options = {}) {
  const unavailable = { status: 'unavailable', method: 'none', anchors: [], confidence: null, residualErrorSeconds: null, validInterval: null };
  const duration = finite(options.durationSeconds) && options.durationSeconds > 0 ? options.durationSeconds : null;
  if (options.method === 'absolute-timestamp') {
    const media = Date.parse(options.mediaStartTime);
    const activity = Date.parse(options.activityStartTime);
    if (!Number.isFinite(media) || !Number.isFinite(activity)) return unavailable;
    const delta = (media - activity) / 1000;
    const mediaSeconds = Math.max(0, -delta);
    const activitySeconds = Math.max(0, delta);
    const endSeconds = duration === null ? null : duration - delta;
    if (endSeconds !== null && endSeconds <= mediaSeconds) return unavailable;
    return { status: 'available', method: options.method, anchors: [{ mediaSeconds, activitySeconds }], confidence: 1, residualErrorSeconds: 0, validInterval: duration ? { startSeconds: mediaSeconds, endSeconds } : null };
  }
  if (options.method === 'manual-anchor' && Array.isArray(options.anchors) && options.anchors.length > 0
    && options.anchors.every(({ mediaSeconds, activitySeconds }) => finite(mediaSeconds) && mediaSeconds >= 0 && finite(activitySeconds) && activitySeconds >= 0)) {
    const anchors = options.anchors.map(({ mediaSeconds, activitySeconds }) => ({ mediaSeconds, activitySeconds }))
      .sort((left, right) => left.mediaSeconds - right.mediaSeconds || left.activitySeconds - right.activitySeconds);
    if (anchors.some((anchor, index) => index > 0 && (anchor.mediaSeconds <= anchors[index - 1].mediaSeconds
      || anchor.activitySeconds <= anchors[index - 1].activitySeconds))) return unavailable;
    const offsets = anchors.map(({ mediaSeconds, activitySeconds }) => mediaSeconds - activitySeconds);
    const residualErrorSeconds = Math.max(...offsets) - Math.min(...offsets);
    const startSeconds = Math.max(0, offsets[0]);
    const endSeconds = duration === null ? null : duration + offsets.at(-1);
    if (endSeconds !== null && endSeconds <= startSeconds) return unavailable;
    return { status: 'available', method: options.method, anchors, confidence: 0.8, residualErrorSeconds, validInterval: duration ? { startSeconds, endSeconds } : null };
  }
  if (options.method === 'declared-offset' && finite(options.offsetSeconds)) {
    const mediaSeconds = Math.max(0, options.offsetSeconds);
    const activitySeconds = Math.max(0, -options.offsetSeconds);
    const endSeconds = duration === null ? null : duration + options.offsetSeconds;
    if (endSeconds !== null && endSeconds <= mediaSeconds) return unavailable;
    return { status: 'available', method: options.method, anchors: [{ mediaSeconds, activitySeconds }], confidence: 0.9, residualErrorSeconds: 0, validInterval: duration ? { startSeconds: mediaSeconds, endSeconds } : null };
  }
  return unavailable;
}

function displayAuthority(coverage, primary) {
  if (!finite(coverage) || coverage < 0.1) return null;
  if (coverage < 0.4) return 'local-observation';
  if (coverage < 0.8) return 'visible-with-caveat';
  return primary ? 'whole-activity' : 'visible-with-caveat';
}

export function buildDataOverlayAllowList(activity, syncMap, options = {}) {
  if (activity?.status !== 'available') return { status: 'unavailable', activityDigest: null, syncMapDigest: null, overlays: [] };
  const overlays = [];
  for (const [metricId, authority] of Object.entries(METRICS)) {
    const value = activity.metrics?.[metricId];
    const primary = options.primaryMetricIds === undefined || options.primaryMetricIds.includes(authority);
    const display = displayAuthority(activity.coverage?.[authority], primary);
    if (value === null || display === null) continue;
    const window = options.metricWindows?.[metricId] ?? { destinationInSeconds: 0, destinationOutSeconds: 1 };
    overlays.push({
      overlayId: `overlay-${metricId.replace(/^average/, '').replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`,
      metricId: `metrics.${metricId}`,
      displayAuthority: display,
      syncAuthority: syncMap?.status === 'available' ? 'time-synchronized' : 'whole-activity',
      wording: options.wording?.[metricId] ?? metricId,
      colorToken: options.colorTokens?.[metricId] ?? 'color.dataPrimary',
      destinationInSeconds: window.destinationInSeconds,
      destinationOutSeconds: window.destinationOutSeconds,
    });
  }
  return { status: overlays.length > 0 ? 'available' : 'unavailable', activityDigest: null, syncMapDigest: null, overlays };
}
