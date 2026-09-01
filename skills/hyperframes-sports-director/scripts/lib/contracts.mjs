import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const SCHEMA_VERSION = '1.0.0';
const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'schemas');
const SCHEMA_NAMES = new Set([
  'activity', 'asset-manifest', 'beat-map', 'data-overlays', 'design-system',
  'direction-proposals', 'director-approval', 'edit-brief', 'look-profile',
  'media-index', 'motion-map', 'probe', 'project', 'project-state',
  'review-metrics', 'scene-schema', 'segments', 'shot', 'sync-map',
  'timeline', 'transcript',
]);
const DIGEST = /^[0-9a-f]{64}$/;
const LIFECYCLE = ['draft', 'proposed', 'approved', 'frozen', 'superseded'];
const METRIC_AUTHORITY_KEYS = {
  averageHeartRate: 'heartRate',
  distance: 'distance',
  movingTime: 'movingTime',
  averageSpeed: 'speed',
  elevationGain: 'elevationGain',
};
const MAIN_STATES = [
  'INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT',
  'DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION',
  'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED',
];

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validators = new Map();

function diagnostic(code, path, message, schema) {
  return { code, path, message, schema };
}

function schemaName(schema) {
  const match = /\/([^/]+)\.schema\.json$/.exec(schema?.$id ?? '');
  return match?.[1] ?? 'unknown';
}

function addSemantic(errors, schema, code, path, message) {
  errors.push(diagnostic(code, path, message, schemaName(schema)));
}

function checkUniqueIds(entries, field, path, schema, errors) {
  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const value = entries[index]?.[field];
    if (seen.has(value)) addSemantic(errors, schema, 'E_ID_DUPLICATE', `${path}/${index}/${field}`, `${field} must be unique`);
    seen.add(value);
  }
}

function checkBounds(entries, path, schema, errors) {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.sourceInSeconds >= entry.sourceOutSeconds) {
      addSemantic(errors, schema, 'E_SOURCE_RANGE', `${path}/${index}`, 'source out time must be greater than source in time');
    }
    if (entry.sourceOutSeconds > entry.sourceDurationSeconds) {
      addSemantic(errors, schema, 'E_SOURCE_BOUNDS', `${path}/${index}/sourceOutSeconds`, 'source range exceeds probed duration');
    }
  }
}

function checkLifecycle(value, schema, errors) {
  const statuses = value.lifecycle.map((entry) => entry.status);
  const prefix = LIFECYCLE.slice(0, statuses.length);
  if (statuses.some((status, index) => status !== prefix[index]) || statuses.at(-1) !== value.status) {
    addSemantic(errors, schema, 'E_LIFECYCLE_TRANSITION', '/lifecycle', 'lifecycle must advance draft → proposed → approved → frozen → superseded without skips');
  }
  if (['approved', 'frozen', 'superseded'].includes(value.status) && !DIGEST.test(value.approvalDigest ?? '')) {
    addSemantic(errors, schema, 'E_APPROVAL_REQUIRED', '/approvalDigest', 'approved and later revisions require the exact approval digest');
  }
}

function checkProjectState(value, schema, errors) {
  for (let index = 0; index < value.transitions.length; index += 1) {
    const transition = value.transitions[index];
    const fromIndex = MAIN_STATES.indexOf(transition.from);
    const expected = fromIndex >= 0 ? MAIN_STATES[fromIndex + 1] : undefined;
    const allowed = !['BLOCKED', 'CANCELLED'].includes(transition.from)
      && (transition.to === expected || ['BLOCKED', 'CANCELLED'].includes(transition.to));
    if (!allowed) addSemantic(errors, schema, 'E_STATE_TRANSITION', `/transitions/${index}/to`, `${transition.from} cannot transition to ${transition.to}`);
    if (index > 0 && value.transitions[index - 1].to !== transition.from) {
      addSemantic(errors, schema, 'E_STATE_HISTORY', `/transitions/${index}/from`, 'transition history must be contiguous');
    }
  }
  if (value.transitions.length > 0 && value.transitions.at(-1).to !== value.state) {
    addSemantic(errors, schema, 'E_STATE_CURRENT', '/state', 'state must equal the final transition destination');
  }
}

function semanticErrors(schema, value) {
  const errors = [];
  const name = schemaName(schema);
  if (name === 'media-index') checkUniqueIds(value.entries, 'mediaId', '/entries', schema, errors);
  if (name === 'probe') checkUniqueIds(value.media, 'mediaId', '/media', schema, errors);
  if (name === 'shot') {
    checkUniqueIds(value.shots, 'shotId', '/shots', schema, errors);
    checkBounds(value.shots, '/shots', schema, errors);
  }
  if (name === 'segments') {
    checkUniqueIds(value.segments, 'segmentId', '/segments', schema, errors);
    checkBounds(value.segments, '/segments', schema, errors);
    const mediaIds = new Set(value.sourceMediaIds);
    for (let index = 0; index < value.segments.length; index += 1) {
      const segment = value.segments[index];
      if (!mediaIds.has(segment.mediaId)) addSemantic(errors, schema, 'E_PROBE_MEDIA_REFERENCE', `/segments/${index}/mediaId`, 'segment mediaId must resolve in sourceMediaIds');
      if (segment.probeDigest !== value.integrity.upstream.probe) addSemantic(errors, schema, 'E_PROBE_DIGEST_REFERENCE', `/segments/${index}/probeDigest`, 'segment probeDigest must match integrity.upstream.probe');
    }
  }
  if (name === 'timeline') {
    checkUniqueIds(value.items, 'itemId', '/items', schema, errors);
    checkBounds(value.items, '/items', schema, errors);
    for (let index = 0; index < value.items.length; index += 1) {
      if (value.items[index].destinationInSeconds >= value.items[index].destinationOutSeconds) {
        addSemantic(errors, schema, 'E_DESTINATION_RANGE', `/items/${index}`, 'destination out time must be greater than destination in time');
      }
    }
    for (let index = 1; index < value.items.length; index += 1) {
      if (value.items[index].destinationInSeconds < value.items[index - 1].destinationOutSeconds) {
        addSemantic(errors, schema, 'E_DESTINATION_MONOTONIC', `/items/${index}/destinationInSeconds`, 'destination intervals must be monotonic and non-overlapping');
      }
    }
  }
  if (name === 'activity' && value.status === 'available') {
    const availableMetric = Object.entries(value.metrics).some(([metricId, metricValue]) => {
      const authorityKey = METRIC_AUTHORITY_KEYS[metricId];
      return metricValue !== null
        && value.availability[authorityKey] === 'available'
        && value.coverage[authorityKey] !== null
        && typeof value.sources[authorityKey] === 'string'
        && value.sources[authorityKey].trim().length > 0;
    });
    if (!availableMetric) addSemantic(errors, schema, 'E_ACTIVITY_SOURCE_REQUIRED', '/status', 'available activity requires at least one available sourced metric');
  }
  if (name === 'design-system' || name === 'look-profile') checkLifecycle(value, schema, errors);
  if (name === 'project-state') checkProjectState(value, schema, errors);
  return errors;
}

export async function loadSchema(name) {
  const normalized = String(name).replace(/\.schema\.json$/, '');
  if (!SCHEMA_NAMES.has(normalized)) throw new Error(`Unknown schema: ${name}`);
  return JSON.parse(await readFile(join(SCHEMA_DIR, `${normalized}.schema.json`), 'utf8'));
}

export function validateDocument(schema, value) {
  let validate = validators.get(schema.$id);
  if (!validate) {
    validate = ajv.compile(schema);
    validators.set(schema.$id, validate);
  }
  const validSchema = validate(value);
  const errors = (validate.errors ?? []).map((error) => diagnostic(
    `E_SCHEMA_${String(error.keyword).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
    error.instancePath || '/',
    error.message ?? 'schema validation failed',
    schemaName(schema),
  ));
  if (validSchema) errors.push(...semanticErrors(schema, value));
  return { valid: errors.length === 0, errors };
}

export async function validateArtifact(path, requestedSchemaName) {
  const schema = await loadSchema(requestedSchemaName);
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return {
      valid: false,
      errors: [diagnostic('E_ARTIFACT_READ', '/', error.message, schemaName(schema))],
    };
  }
  return { ...validateDocument(schema, value), value };
}

function canonicalValue(value, omitDigest = false) {
  if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
      if (omitDigest && key === 'digest') return [];
      if (value[key] === undefined) return [];
      return [[key, canonicalValue(value[key])]];
    }));
  }
  return value;
}

export function canonicalizeArtifact(value) {
  const canonical = canonicalValue(value);
  if (canonical?.integrity && typeof canonical.integrity === 'object') {
    canonical.integrity = canonicalValue(canonical.integrity, true);
  }
  return JSON.stringify(canonical);
}

export function computeArtifactDigest(value) {
  return createHash('sha256').update(canonicalizeArtifact(value)).digest('hex');
}

export function verifyArtifactIntegrity(value) {
  const actualDigest = value?.integrity?.digest;
  const expectedDigest = computeArtifactDigest(value);
  if (!DIGEST.test(actualDigest ?? '') || actualDigest !== expectedDigest) {
    return { valid: false, code: 'E_INTEGRITY_DIGEST_MISMATCH', expectedDigest, actualDigest: actualDigest ?? null };
  }
  return { valid: true, code: null, expectedDigest, actualDigest };
}

export { SCHEMA_VERSION };
