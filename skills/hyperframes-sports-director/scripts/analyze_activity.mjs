#!/usr/bin/env node
/*
 * Copyright (C) 2026 HyperFrames Sports Director contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Activity truth and privacy rules are adapted from Guizang Sports Skill at
 * the exact revision recorded in UPSTREAM.lock.json; code is implemented here.
 */
import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildDataOverlayAllowList, buildSyncMap, normalizeActivity, trimPrivateEndpoints } from './lib/activity.mjs';
import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest, loadSchema, validateDocument } from './lib/contracts.mjs';
import { loadProfile } from './lib/profiles.mjs';

class AnalyzerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AnalyzerError';
    this.code = code;
  }
}

function haversine(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = radians(b.longitude - a.longitude);
  const value = Math.sin(deltaLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function withDistances(points) {
  let distanceMeters = 0;
  return points.map((point, index) => {
    if (index > 0) distanceMeters += haversine(points[index - 1], point);
    return { ...point, distanceMeters };
  });
}

function parseKml(text) {
  const coordinateBlocks = [...text.matchAll(/<coordinates[^>]*>([\s\S]*?)<\/coordinates>/gi)];
  const points = coordinateBlocks.flatMap((match) => match[1].trim().split(/\s+/).filter(Boolean).map((tuple) => {
    const [longitude, latitude] = tuple.split(',').map(Number);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new AnalyzerError('E_ACTIVITY_INPUT', 'KML contains invalid coordinates');
    return { latitude, longitude };
  }));
  const trackCoordinates = [...text.matchAll(/<(?:gx:)?coord[^>]*>\s*([^<]+)<\/(?:gx:)?coord>/gi)].map((match) => {
    const [longitude, latitude] = match[1].trim().split(/\s+/).map(Number);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new AnalyzerError('E_ACTIVITY_INPUT', 'KML contains invalid track coordinates');
    return { latitude, longitude };
  });
  const timestamps = [...text.matchAll(/<when[^>]*>([^<]+)<\/when>/gi)].map((match) => match[1].trim());
  const route = withDistances(trackCoordinates.length > 0 ? trackCoordinates : points).map((point, index) => (
    timestamps[index] && Number.isFinite(Date.parse(timestamps[index])) ? { ...point, timestamp: new Date(timestamps[index]).toISOString() } : point
  ));
  const timed = route.length > 1 && route.every(({ timestamp }) => timestamp);
  const movingTimeSeconds = timed ? (Date.parse(route.at(-1).timestamp) - Date.parse(route[0].timestamp)) / 1000 : undefined;
  return {
    activityId: 'activity-kml', sourceType: 'kml', sportProfile: 'hiking',
    ...(route[0]?.timestamp ? { startTime: route[0].timestamp } : {}),
    ...(route.length > 1 ? { distanceMeters: route.at(-1).distanceMeters, route } : {}),
    ...(movingTimeSeconds > 0 ? { movingTimeSeconds } : {}), samples: {},
  };
}

const FIT_EPOCH_SECONDS = Date.parse('1989-12-31T00:00:00Z') / 1000;

function fitValue(buffer, offset, size, baseType, littleEndian) {
  const type = baseType & 0x1f;
  const endian = littleEndian;
  let value;
  if (size === 1) value = type === 1 ? buffer.readInt8(offset) : buffer.readUInt8(offset);
  else if (size === 2) value = type === 3 ? (endian ? buffer.readInt16LE(offset) : buffer.readInt16BE(offset)) : (endian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset));
  else if (size === 4) value = [5, 8].includes(type) ? (endian ? buffer.readInt32LE(offset) : buffer.readInt32BE(offset)) : (endian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset));
  else return null;
  const invalid = (size === 1 && ((type === 1 && value === 0x7f) || (type !== 1 && value === 0xff)))
    || (size === 2 && ((type === 3 && value === 0x7fff) || (type !== 3 && value === 0xffff)))
    || (size === 4 && ([5, 8].includes(type) ? value === 0x7fffffff : value === 0xffffffff));
  return invalid ? null : value;
}

function parseFit(buffer) {
  const headerSize = buffer[0];
  if (![12, 14].includes(headerSize) || buffer.subarray(8, 12).toString('ascii') !== '.FIT') throw new AnalyzerError('E_ACTIVITY_INPUT', 'FIT header is invalid');
  const dataSize = buffer.readUInt32LE(4);
  const end = headerSize + dataSize;
  if (end > buffer.length) throw new AnalyzerError('E_ACTIVITY_INPUT', 'FIT payload is truncated');
  const definitions = new Map();
  const records = [];
  const sessions = [];
  let lastTimestamp = null;
  let offset = headerSize;
  while (offset < end) {
    const header = buffer[offset++];
    const compressed = (header & 0x80) !== 0;
    const localType = compressed ? (header >> 5) & 0x03 : header & 0x0f;
    if ((header & 0x40) !== 0) {
      offset += 1;
      const architecture = buffer[offset++];
      const littleEndian = architecture === 0;
      const globalMessage = littleEndian ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
      offset += 2;
      const count = buffer[offset++];
      const fields = [];
      for (let index = 0; index < count; index += 1) {
        fields.push({ number: buffer[offset++], size: buffer[offset++], baseType: buffer[offset++] });
      }
      if ((header & 0x20) !== 0) {
        const developerCount = buffer[offset++];
        offset += developerCount * 3;
      }
      definitions.set(localType, { globalMessage, littleEndian, fields });
      continue;
    }
    const definition = definitions.get(localType);
    if (!definition) throw new AnalyzerError('E_ACTIVITY_INPUT', 'FIT data record has no definition');
    const values = {};
    for (const field of definition.fields) {
      if (compressed && field.number === 253) continue;
      if (offset + field.size > end) throw new AnalyzerError('E_ACTIVITY_INPUT', 'FIT record is truncated');
      values[field.number] = fitValue(buffer, offset, field.size, field.baseType, definition.littleEndian);
      offset += field.size;
    }
    if (compressed && Number.isFinite(lastTimestamp)) {
      let timestamp = (lastTimestamp & ~0x1f) + (header & 0x1f);
      if (timestamp <= lastTimestamp) timestamp += 0x20;
      values[253] = timestamp;
    }
    if (Number.isFinite(values[253])) lastTimestamp = values[253];
    if (definition.globalMessage === 20) records.push(values);
    if (definition.globalMessage === 18) sessions.push(values);
  }
  if (records.length === 0 && sessions.length === 0) throw new AnalyzerError('E_ACTIVITY_INPUT', 'FIT has no supported activity records');
  const session = sessions.at(-1) ?? {};
  const sport = ({ 1: 'running', 2: 'cycling', 5: 'pool-swimming', 11: 'hiking' })[session[5]] ?? 'cycling';
  const route = withDistances(records.filter((record) => Number.isFinite(record[0]) && Number.isFinite(record[1])).map((record) => ({
    latitude: record[0] * 180 / 2 ** 31,
    longitude: record[1] * 180 / 2 ** 31,
    ...(Number.isFinite(record[253]) ? { timestamp: new Date((FIT_EPOCH_SECONDS + record[253]) * 1000).toISOString() } : {}),
  })));
  const samples = {
    heartRate: records.map((record) => record[3]).filter(Number.isFinite),
    cadence: records.map((record) => record[4]).filter(Number.isFinite),
    power: records.map((record) => record[7]).filter(Number.isFinite),
    temperature: records.map((record) => record[13]).filter(Number.isFinite),
  };
  return {
    activityId: 'activity-fit', sourceType: 'fit', sportProfile: sport,
    ...(Number.isFinite(session[2]) ? { startTime: new Date((FIT_EPOCH_SECONDS + session[2]) * 1000).toISOString() } : {}),
    ...(Number.isFinite(session[9]) ? { distanceMeters: session[9] / 100 } : route.length > 1 ? { distanceMeters: route.at(-1).distanceMeters } : {}),
    ...(Number.isFinite(session[8]) ? { movingTimeSeconds: session[8] / 1000 } : {}),
    ...(Number.isFinite(session[22]) ? { elevationGainMeters: session[22] } : {}),
    ...(Number.isFinite(session[11]) ? { calories: { value: session[11], deviceReported: true, coverage: 1 } } : {}),
    samples, route,
  };
}

async function readActivities(path) {
  try {
    const buffer = await readFile(path);
    const extension = extname(path).toLowerCase();
    if (extension === '.kml') return [parseKml(buffer.toString('utf8'))];
    if (extension === '.fit') return [parseFit(buffer)];
    const parsed = JSON.parse(buffer.toString('utf8'));
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (error) {
    if (error?.code?.startsWith?.('E_ACTIVITY')) throw error;
    throw new AnalyzerError('E_ACTIVITY_INPUT', 'activity input is invalid');
  }
}

function artifact(schema, value, upstream = {}) {
  const document = { $schema: `https://hyperframes.local/schemas/${schema}.schema.json`, schemaVersion: '1.0.0', revision: 1, ...value, integrity: { digest: null, upstream } };
  document.integrity.digest = computeArtifactDigest(document);
  return document;
}

async function ensureValid(schemaName, document) {
  const schema = await loadSchema(schemaName);
  const result = validateDocument(schema, document);
  if (!result.valid) throw new AnalyzerError('E_ACTIVITY_CONTRACT', `generated ${schemaName} artifact is invalid`);
}

async function writeAtomically(entries) {
  const suffix = `${process.pid}-${randomUUID()}`;
  const staged = [];
  try {
    for (const [path, value] of entries) {
      const temporary = `${path}.tmp-${suffix}`;
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      staged.push([temporary, path]);
    }
    for (const [temporary, path] of staged) await rename(temporary, path);
  } catch (error) {
    await Promise.all(staged.map(([temporary]) => unlink(temporary).catch(() => {})));
    throw error;
  }
}

export async function analyzeActivity(options) {
  if (!options?.project) throw new AnalyzerError('E_USAGE', 'project is required');
  const activities = options.input ? await readActivities(options.input) : [];
  const route = activities.find((activity) => Array.isArray(activity.route) && activity.route.length > 1)?.route;
  const trimStartMeters = options.trimStartMeters ?? 0;
  const trimEndMeters = options.trimEndMeters ?? 0;
  const trimmedRoute = route && (trimStartMeters > 0 || trimEndMeters > 0)
    ? trimPrivateEndpoints(route, { trimStartMeters, trimEndMeters }) : null;
  const normalized = normalizeActivity(activities, { trimmedRoute });
  const activity = artifact('activity', normalized);
  const hasActivityTimeAxis = normalized.metrics.movingTime !== null;
  const syncValue = buildSyncMap({
    method: hasActivityTimeAxis ? options.syncMethod ?? 'none' : 'none', offsetSeconds: options.offsetSeconds,
    mediaStartTime: options.mediaStartTime, activityStartTime: activities[0]?.startTime,
    anchors: options.manualMediaSeconds === undefined || options.manualActivitySeconds === undefined ? undefined
      : [{ mediaSeconds: options.manualMediaSeconds, activitySeconds: options.manualActivitySeconds }],
    durationSeconds: normalized.metrics.movingTime,
  });
  const syncMap = artifact('sync-map', syncValue, { activity: activity.integrity.digest });
  const sportProfile = normalized.sportProfiles[0] ? loadProfile('sport', normalized.sportProfiles[0]) : null;
  const overlayValue = buildDataOverlayAllowList(activity, syncMap, {
    primaryMetricIds: sportProfile?.policies.dataPolicy.primaryMetrics ?? [],
  });
  overlayValue.activityDigest = overlayValue.status === 'available' ? activity.integrity.digest : null;
  overlayValue.syncMapDigest = overlayValue.status === 'available' ? syncMap.integrity.digest : null;
  overlayValue.publicRoute = activity.route.status === 'available'
    ? { status: 'available', trimmedRouteId: activity.route.trimmedRouteId }
    : { status: 'unavailable', trimmedRouteId: null };
  const overlays = artifact('data-overlays', overlayValue,
    overlayValue.status === 'available' ? { activity: activity.integrity.digest, syncMap: syncMap.integrity.digest } : {});
  await Promise.all([ensureValid('activity', activity), ensureValid('sync-map', syncMap), ensureValid('data-overlays', overlays)]);
  await writeAtomically([
    [join(options.project, 'analysis', 'ACTIVITY.json'), activity],
    [join(options.project, 'analysis', 'SYNC_MAP.json'), syncMap],
    [join(options.project, 'direction', 'DATA_OVERLAYS.json'), overlays],
  ]);
  return { ok: true, status: activity.status, trimmedRouteId: activity.route.trimmedRouteId };
}

const CLI = {
  project: { required: true }, input: {},
  'trim-start-m': { key: 'trimStartMeters', type: 'number' },
  'trim-end-m': { key: 'trimEndMeters', type: 'number' },
  'sync-method': { key: 'syncMethod' },
  'offset-seconds': { key: 'offsetSeconds', type: 'number' },
  'media-start-time': { key: 'mediaStartTime' },
  'manual-media-seconds': { key: 'manualMediaSeconds', type: 'number' },
  'manual-activity-seconds': { key: 'manualActivitySeconds', type: 'number' },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await analyzeActivity(parseCliArguments(process.argv.slice(2), CLI));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const safe = error instanceof AnalyzerError ? error : new AnalyzerError(error?.code ?? 'E_ACTIVITY_ANALYSIS', 'activity analysis failed');
    process.stdout.write(`${JSON.stringify(errorResult(safe))}\n`);
    process.exitCode = safe.code === 'E_USAGE' ? 2 : 1;
  }
}
