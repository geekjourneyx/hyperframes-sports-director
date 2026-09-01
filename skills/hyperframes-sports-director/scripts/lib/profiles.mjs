import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeArtifactDigest } from './contracts.mjs';

const PROFILE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'profiles');
const PROFILE_KINDS = {
  sport: {
    directory: 'sports',
    profileKind: 'sport',
    namespaces: [
      'journeyGrammar', 'cameraRoleWeights', 'speedPolicy', 'stabilizationPolicy',
      'duplicatePolicy', 'audioPolicy', 'dataPolicy', 'visualPolicy',
    ],
  },
  device: { directory: 'devices', profileKind: 'device', namespaces: ['capturePolicy'] },
  delivery: { directory: 'delivery', profileKind: 'delivery', namespaces: ['deliveryPolicy'] },
};
const RESOLUTION_KEYS = new Set(['sport', 'device', 'delivery', 'requiredMaturity', 'raster', 'aspectRatio']);
const MATURITY_VALUES = new Set(['release-grade', 'experimental']);
const PROFILE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class ProfileError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProfileError';
    this.code = code;
    Object.assign(this, details);
  }
}

export function loadProfile(kind, name) {
  const descriptor = PROFILE_KINDS[kind];
  if (!descriptor) throw new ProfileError('E_PROFILE_UNKNOWN_KIND', `Unknown profile kind: ${kind}`, { kind });
  if (typeof name !== 'string' || !PROFILE_ID.test(name)) {
    throw new ProfileError('E_PROFILE_UNKNOWN_NAME', 'Profile names must be known kebab-case identifiers', { kind, name });
  }

  let value;
  try {
    value = JSON.parse(readFileSync(join(PROFILE_ROOT, descriptor.directory, `${name}.json`), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new ProfileError('E_PROFILE_UNKNOWN_NAME', `Unknown ${kind} profile: ${name}`, { kind, name });
    }
    throw new ProfileError('E_PROFILE_READ', `Unable to load ${kind} profile ${name}: ${error.message}`, { kind, name });
  }

  validateProfile(value, descriptor, kind, name);
  const profileDocument = cloneAndFreeze(value);
  return Object.freeze({
    id: profileDocument.id,
    kind: profileDocument.kind,
    maturity: profileDocument.maturity,
    policies: profileDocument.policies,
    profileDigest: computeArtifactDigest(profileDocument),
  });
}

export function resolvePolicies(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ProfileError('E_PROFILE_OPTIONS', 'Profile selections must be an object');
  }
  for (const key of Object.keys(options)) {
    if (!RESOLUTION_KEYS.has(key)) {
      throw new ProfileError('E_PROFILE_UNKNOWN_OPTION', `Unknown profile selection option: ${key}`, { key });
    }
  }
  for (const key of ['sport', 'device', 'delivery']) {
    if (typeof options[key] !== 'string') {
      throw new ProfileError('E_PROFILE_SELECTION_REQUIRED', `${key} profile selection is required`, { key });
    }
  }
  if (options.requiredMaturity !== undefined && !MATURITY_VALUES.has(options.requiredMaturity)) {
    throw new ProfileError('E_PROFILE_MATURITY_REQUEST', 'requiredMaturity must be release-grade or experimental', { requiredMaturity: options.requiredMaturity });
  }

  const sport = loadProfile('sport', options.sport);
  const device = loadProfile('device', options.device);
  const delivery = loadProfile('delivery', options.delivery);
  if (options.requiredMaturity === 'release-grade' && sport.maturity !== 'release-grade') {
    throw new ProfileError('E_PROFILE_MATURITY', `${sport.id} is experimental and cannot satisfy a release-grade request`, {
      profile: sport.id,
      maturity: sport.maturity,
      requiredMaturity: options.requiredMaturity,
    });
  }

  const deliveryPolicy = delivery.policies.deliveryPolicy;
  validateDeliveryPolicy(deliveryPolicy, delivery.id);
  if (options.raster !== undefined && !sameRaster(options.raster, deliveryPolicy.raster)) {
    throw new ProfileError('E_PROFILE_RASTER_CONFLICT', 'Requested raster conflicts with the delivery profile', {
      requestedRaster: options.raster,
      deliveryRaster: deliveryPolicy.raster,
    });
  }
  if (options.aspectRatio !== undefined && options.aspectRatio !== deliveryPolicy.aspectRatio) {
    throw new ProfileError('E_PROFILE_ASPECT_RATIO_CONFLICT', 'Requested aspect ratio conflicts with the delivery profile', {
      requestedAspectRatio: options.aspectRatio,
      deliveryAspectRatio: deliveryPolicy.aspectRatio,
    });
  }
  if (!device.policies.capturePolicy.supportedRasters.some((raster) => sameRaster(raster, deliveryPolicy.raster))) {
    throw new ProfileError('E_PROFILE_DEVICE_RASTER_UNSUPPORTED', 'Device profile does not support the selected delivery raster', {
      device: device.id,
      delivery: delivery.id,
    });
  }

  const policies = cloneAndFreeze({
    ...sport.policies,
    ...device.policies,
    ...delivery.policies,
  });
  return Object.freeze({
    sport: sport.id,
    device: device.id,
    delivery: delivery.id,
    maturity: sport.maturity,
    policies,
    profileDigests: Object.freeze({ sport: sport.profileDigest, device: device.profileDigest, delivery: delivery.profileDigest }),
    policyDigest: computeArtifactDigest({ sport: sport.id, device: device.id, delivery: delivery.id, maturity: sport.maturity, policies }),
  });
}

function validateProfile(value, descriptor, requestedKind, requestedName) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProfileError('E_PROFILE_DOCUMENT', 'Profile document must be an object', { kind: requestedKind, name: requestedName });
  }
  const allowedKeys = ['kind', 'id', 'maturity', 'policies'];
  const unknownKey = Object.keys(value).find((key) => !allowedKeys.includes(key));
  if (unknownKey) throw new ProfileError('E_PROFILE_UNKNOWN_KEY', `Unknown profile key: ${unknownKey}`, { kind: requestedKind, name: requestedName, key: unknownKey });
  if (value.kind !== descriptor.profileKind || value.id !== requestedName || !MATURITY_VALUES.has(value.maturity)) {
    throw new ProfileError('E_PROFILE_DOCUMENT', 'Profile kind, id, and maturity must be valid', { kind: requestedKind, name: requestedName });
  }
  if (value.policies === null || typeof value.policies !== 'object' || Array.isArray(value.policies)) {
    throw new ProfileError('E_PROFILE_DOCUMENT', 'Profile policies must be an object', { kind: requestedKind, name: requestedName });
  }
  const policyKeys = Object.keys(value.policies).sort();
  const expectedKeys = [...descriptor.namespaces].sort();
  if (policyKeys.length !== expectedKeys.length || policyKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new ProfileError('E_PROFILE_POLICY_NAMESPACE', `Profile policies must contain only: ${expectedKeys.join(', ')}`, { kind: requestedKind, name: requestedName });
  }
}

function validateDeliveryPolicy(policy, profile) {
  if (policy === null || typeof policy !== 'object' || !sameRaster(policy.raster, policy.raster) || typeof policy.aspectRatio !== 'string') {
    throw new ProfileError('E_PROFILE_DELIVERY', 'Delivery profile must declare a valid raster and aspect ratio', { profile });
  }
  const [widthPart, heightPart] = policy.aspectRatio.split(':').map(Number);
  if (!Number.isInteger(widthPart) || !Number.isInteger(heightPart) || widthPart <= 0 || heightPart <= 0
    || policy.raster.width * heightPart !== policy.raster.height * widthPart) {
    throw new ProfileError('E_PROFILE_ASPECT_RATIO_CONFLICT', 'Delivery raster conflicts with its declared aspect ratio', { profile });
  }
}

function sameRaster(left, right) {
  return left !== null && right !== null
    && typeof left === 'object' && typeof right === 'object'
    && Number.isInteger(left.width) && Number.isInteger(left.height)
    && Number.isInteger(right.width) && Number.isInteger(right.height)
    && left.width > 0 && left.height > 0
    && left.width === right.width && left.height === right.height;
}

function cloneAndFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneAndFreeze));
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, cloneAndFreeze(nested)]),
    ));
  }
  return value;
}
