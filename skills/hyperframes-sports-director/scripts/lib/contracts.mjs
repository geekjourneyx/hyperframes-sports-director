import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { deriveInvalidationPolicy } from './invalidation-policy.mjs';
import { hasGateRequirements, validateGateEvidence } from './project-state.mjs';

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
const REVIEW_EXTENSIONS = {
  video: new Set(['mp4', 'webm']),
  image: new Set(['jpg', 'jpeg', 'png', 'webp']),
  audio: new Set(['m4a', 'wav']),
};
const SPORT_MATURITY = {
  cycling: 'release-grade',
  hiking: 'release-grade',
  'pool-swimming': 'release-grade',
  running: 'experimental',
  'technical-mountaineering': 'experimental',
  'trail-running': 'experimental',
  'open-water-swimming': 'experimental',
};

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
  if (value.transitions.length === 0) {
    if (value.state !== 'INTAKE' || value.previousState !== null || value.gateEvidence.length > 0 || value.invalidations.length > 0) {
      addSemantic(errors, schema, 'E_STATE_HISTORY_REQUIRED', '/transitions', 'only INTAKE with no gate or invalidation evidence may have empty transition history');
    }
    return;
  }
  if (value.transitions[0].from !== 'INTAKE') {
    addSemantic(errors, schema, 'E_STATE_HISTORY_ROOT', '/transitions/0/from', 'transition history must start at INTAKE');
  }
  for (let index = 0; index < value.transitions.length; index += 1) {
    const transition = value.transitions[index];
    const fromIndex = MAIN_STATES.indexOf(transition.from);
    const expected = fromIndex >= 0 ? MAIN_STATES[fromIndex + 1] : undefined;
    const invalidation = transition.kind === 'invalidation'
      ? value.invalidations.find((entry) => entry.at === transition.at && entry.fromState === transition.from
        && entry.rollbackTarget === transition.rollbackTarget && entry.evidenceDigest === Object.values(transition.evidenceDigests)[0])
      : undefined;
    let invalidationPolicy;
    try {
      invalidationPolicy = invalidation ? deriveInvalidationPolicy(invalidation.invalidatedRoles, transition.from) : null;
    } catch {
      invalidationPolicy = null;
    }
    const validInvalidationDigest = invalidation && (() => {
      const { evidenceDigest, ...digestInput } = invalidation;
      return evidenceDigest === computeArtifactDigest(digestInput);
    })();
    const validInvalidation = invalidation && invalidationPolicy && validInvalidationDigest
      && invalidation.rollbackTarget === invalidationPolicy.rollbackTarget
      && invalidation.disposition === invalidationPolicy.disposition
      && transition.rollbackTarget === invalidationPolicy.rollbackTarget
      && transition.to === invalidationPolicy.nextState;
    const allowed = !['BLOCKED', 'CANCELLED'].includes(transition.from)
      && (transition.to === expected || ['BLOCKED', 'CANCELLED'].includes(transition.to) || validInvalidation);
    if (!allowed) addSemantic(errors, schema, 'E_STATE_TRANSITION', `/transitions/${index}/to`, `${transition.from} cannot transition to ${transition.to}`);
    if (index > 0 && value.transitions[index - 1].to !== transition.from) {
      addSemantic(errors, schema, 'E_STATE_HISTORY', `/transitions/${index}/from`, 'transition history must be contiguous');
    }
    const records = value.gateEvidence.filter((evidence) => evidence.gate === transition.to
      && Object.hasOwn(transition.evidenceDigests, evidence.role));
    const digestRoles = Object.keys(transition.evidenceDigests).sort();
    const revisionRoles = Object.keys(transition.evidenceRevisions).sort();
    const recordRoles = records.map(({ role }) => role).sort();
    if (digestRoles.length !== revisionRoles.length || digestRoles.length !== recordRoles.length
      || digestRoles.some((role, roleIndex) => role !== revisionRoles[roleIndex] || role !== recordRoles[roleIndex])) {
      addSemantic(errors, schema, 'E_STATE_EVIDENCE_METADATA', `/transitions/${index}`, 'transition evidence roles must have exact digest and revision metadata');
    } else {
      try {
        validateGateEvidence(
          transition.to,
          records,
          Object.fromEntries(digestRoles.map((role) => [role, { revision: transition.evidenceRevisions[role], digest: transition.evidenceDigests[role] }])),
          { timestamp: transition.at, skipGateRequirements: transition.kind === 'invalidation', allowInvalidated: true },
        );
      } catch (error) {
        addSemantic(errors, schema, error.code ?? 'E_STATE_GATE_HISTORY', '/gateEvidence', error.message);
      }
    }
    if (transition.kind === 'invalidation') {
      const record = records[0];
      const expectedRole = invalidation?.disposition === 'blocked' ? 'APPROVAL_BOUNDARY_CROSSED' : 'INVALIDATION';
      const expectedQualifier = invalidation?.disposition === 'blocked' ? 'approval-boundary-crossed' : 'rollback';
      if (!validInvalidation || records.length !== 1 || record?.role !== expectedRole
        || record.qualifiers.length !== 1 || record.qualifiers[0] !== expectedQualifier) {
        addSemantic(errors, schema, 'E_STATE_INVALIDATION', `/transitions/${index}`, 'invalidation transition must bind its rollback target, disposition, and evidence');
      }
    }
  }
  if (value.transitions.length > 0 && value.transitions.at(-1).to !== value.state) {
    addSemantic(errors, schema, 'E_STATE_CURRENT', '/state', 'state must equal the final transition destination');
  }
  const finalTransition = value.transitions.at(-1);
  if (value.previousState !== finalTransition.from) {
    addSemantic(errors, schema, 'E_STATE_PREVIOUS', '/previousState', 'previousState must equal the final transition source');
  }
  if (value.stateEnteredAt !== finalTransition.at) {
    addSemantic(errors, schema, 'E_STATE_ENTERED_AT', '/stateEnteredAt', 'stateEnteredAt must equal the final transition timestamp');
  }
  if (hasGateRequirements(value.state)) {
    const currentGateTransition = finalTransition.kind === 'invalidation'
      ? value.transitions.findLast((transition) => transition.kind !== 'invalidation' && transition.to === value.state)
      : finalTransition;
    const currentRecords = currentGateTransition
      ? value.gateEvidence.filter((evidence) => evidence.gate === value.state
        && Object.hasOwn(currentGateTransition.evidenceDigests, evidence.role))
      : [];
    try {
      validateGateEvidence(
        value.state,
        currentRecords,
        Object.fromEntries(Object.keys(currentGateTransition?.evidenceDigests ?? {}).map((role) => [role, {
          revision: currentGateTransition.evidenceRevisions[role], digest: currentGateTransition.evidenceDigests[role],
        }])),
        { timestamp: currentGateTransition?.at },
      );
    } catch (error) {
      addSemantic(errors, schema, error.code ?? 'E_STATE_GATE_HISTORY', '/gateEvidence', error.message);
    }
  }
  const finalGate = value.gateEvidence.findLast((evidence) => evidence.gate === value.state
    && finalTransition.evidenceDigests[evidence.role] === evidence.digest
    && evidence.validity === 'valid');
  if (!finalGate) {
    addSemantic(errors, schema, 'E_STATE_GATE_EVIDENCE', '/gateEvidence', 'final gate evidence must bind the current state to the final transition');
  }
  for (let index = 0; index < value.gateEvidence.length; index += 1) {
    const evidence = value.gateEvidence[index];
    if ((evidence.validity === 'valid' && evidence.invalidatedAt !== null)
      || (evidence.validity === 'invalidated' && evidence.invalidatedAt === null)) {
      addSemantic(errors, schema, 'E_STATE_EVIDENCE_VALIDITY', `/gateEvidence/${index}`, 'evidence validity and invalidatedAt must agree');
    }
    const boundTransitionIndex = value.transitions.findIndex((transition) => transition.to === evidence.gate
      && transition.evidenceDigests[evidence.role] === evidence.digest
      && transition.evidenceRevisions[evidence.role] === evidence.revision
      && transition.at === evidence.timestamp);
    if (boundTransitionIndex < 0) {
      addSemantic(errors, schema, 'E_STATE_ORPHAN_EVIDENCE', `/gateEvidence/${index}`, 'gate evidence must bind to one transition role and digest');
    }
    if (evidence.validity === 'invalidated') {
      const auditedInvalidation = value.transitions.some((transition, transitionIndex) => transitionIndex > boundTransitionIndex
        && transition.kind === 'invalidation' && transition.at === evidence.invalidatedAt);
      if (!auditedInvalidation) {
        addSemantic(errors, schema, 'E_STATE_EVIDENCE_INVALIDATION', `/gateEvidence/${index}`, 'invalidated evidence requires a later auditable invalidation transition');
      }
    }
  }
  if (value.invalidations.length !== value.transitions.filter(({ kind }) => kind === 'invalidation').length) {
    addSemantic(errors, schema, 'E_STATE_INVALIDATION_HISTORY', '/invalidations', 'every invalidation record must bind exactly one invalidation transition');
  }
}

function checkExactLineage(value, schema, errors, references) {
  const requiredRoles = Object.keys(references).sort();
  const actualRoles = Object.keys(value.integrity.upstream).sort();
  if (requiredRoles.length !== actualRoles.length || requiredRoles.some((role, index) => role !== actualRoles[index])) {
    addSemantic(errors, schema, 'E_UPSTREAM_ROLES', '/integrity/upstream', `upstream roles must be exactly: ${requiredRoles.join(', ')}`);
  }
  for (const [role, digest] of Object.entries(references)) {
    if (value.integrity.upstream[role] !== digest) {
      addSemantic(errors, schema, 'E_UPSTREAM_DIGEST_REFERENCE', `/integrity/upstream/${role}`, `${role} digest must match its explicit reference`);
    }
  }
  if (!DIGEST.test(value.integrity.digest ?? '')) {
    addSemantic(errors, schema, 'E_INTEGRITY_REQUIRED', '/integrity/digest', 'an artifact with upstream dependencies requires its content digest');
  }
}

function checkActivity(value, schema, errors) {
  let availableCount = 0;
  for (const [metricId, authorityKey] of Object.entries(METRIC_AUTHORITY_KEYS)) {
    const metricValue = value.metrics[metricId];
    const availability = value.availability[authorityKey];
    const coverage = value.coverage[authorityKey];
    const reason = value.reasons[authorityKey];
    const source = value.sources[authorityKey];
    if (metricValue !== null) {
      availableCount += 1;
      if (availability !== 'available' || coverage === null || typeof source !== 'string' || source.trim().length === 0 || reason !== null) {
        addSemantic(errors, schema, 'E_ACTIVITY_TUPLE', `/metrics/${metricId}`, 'available metric requires available status, coverage, source, and null reason');
      }
    } else if (availability !== 'unavailable' || coverage !== null || source !== null || typeof reason !== 'string' || reason.trim().length === 0) {
      addSemantic(errors, schema, 'E_ACTIVITY_TUPLE', `/metrics/${metricId}`, 'unavailable metric requires null value, coverage, source, and a non-empty reason');
    }
  }
  if (value.status === 'available' && availableCount === 0) {
    addSemantic(errors, schema, 'E_ACTIVITY_STATUS', '/status', 'available activity requires at least one available metric tuple');
  }
  if (value.status === 'unavailable' && availableCount !== 0) {
    addSemantic(errors, schema, 'E_ACTIVITY_STATUS', '/status', 'unavailable activity requires every metric tuple to be unavailable');
  }
}

function checkProbeReviewPaths(value, schema, errors) {
  for (let index = 0; index < value.media.length; index += 1) {
    const media = value.media[index];
    const prefix = `review/probe/${media.mediaId}.`;
    const extension = media.reviewPath.startsWith(prefix) ? media.reviewPath.slice(prefix.length) : '';
    if (!REVIEW_EXTENSIONS[media.mediaType].has(extension)) {
      addSemantic(errors, schema, 'E_REVIEW_PATH', `/media/${index}/reviewPath`, 'review path must use the mediaId basename in review/probe with an allowed media extension');
    }
  }
}

function semanticErrors(schema, value) {
  const errors = [];
  const name = schemaName(schema);
  if (name === 'project' && SPORT_MATURITY[value.profiles.sport] !== value.profiles.sportMaturity) {
    addSemantic(errors, schema, 'E_PROFILE_MATURITY', '/profiles/sportMaturity', 'sport maturity must match the resolved sport profile');
  }
  if (name === 'media-index') checkUniqueIds(value.entries, 'mediaId', '/entries', schema, errors);
  if (name === 'probe') {
    checkUniqueIds(value.media, 'mediaId', '/media', schema, errors);
    checkProbeReviewPaths(value, schema, errors);
  }
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
    if (value.sourceMediaIds.length > 0 || value.segments.length > 0) {
      checkExactLineage(value, schema, errors, { probe: value.integrity.upstream.probe });
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
    if (value.sourceProbeDigest !== null || value.items.length > 0) {
      checkExactLineage(value, schema, errors, { probe: value.sourceProbeDigest });
    }
  }
  if (name === 'activity') checkActivity(value, schema, errors);
  if (name === 'data-overlays' && value.status === 'available') {
    checkExactLineage(value, schema, errors, { activity: value.activityDigest, syncMap: value.syncMapDigest });
  }
  if (name === 'asset-manifest' && (value.assets.length > 0 || value.status !== 'draft')) {
    checkExactLineage(value, schema, errors, { designSystem: value.designSystemDigest, lookProfile: value.lookProfileDigest });
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
  const validation = validateDocument(schema, value);
  if (validation.valid && value.integrity?.digest !== null) {
    const integrity = verifyArtifactIntegrity(value);
    if (!integrity.valid) {
      validation.valid = false;
      validation.errors.push(diagnostic(integrity.code, '/integrity/digest', 'artifact digest does not match canonical content', schemaName(schema)));
    }
  }
  return { ...validation, value };
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
