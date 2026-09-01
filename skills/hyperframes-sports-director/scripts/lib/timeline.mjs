import { createHash } from 'node:crypto';

import { validateAudioContinuity } from './audio.mjs';

function diagnostic(code, path, message, details = {}) {
  return { code, path, message, ...details };
}

function policies(profiles) {
  return profiles?.sport?.policies ?? profiles?.policies ?? {};
}

function decisionId(code, itemIds) {
  return `decision-${createHash('sha256').update(`${code}:${itemIds.join(':')}`).digest('hex').slice(0, 16)}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().flatMap((key) => {
    if (key === 'warningDecisions' || key === 'integrity') return [];
    return [[key, canonical(value[key])]];
  }));
  return value;
}

export function computeWarningDecisionDigest(timeline) {
  return createHash('sha256').update(JSON.stringify(canonical(timeline))).digest('hex');
}

export function normalizePlaybackRateCurve(item) {
  const curve = item?.playbackRateCurve ?? [];
  if (curve.length === 1) {
    return [
      { sourceTimeSeconds: item.sourceInSeconds, rate: curve[0].rate },
      { sourceTimeSeconds: item.sourceOutSeconds, rate: curve[0].rate },
    ];
  }
  return curve;
}

export function findDuplicateViolations(timeline, shots, minSeparationSeconds) {
  const byId = new Map((shots ?? []).map((shot) => [shot.shotId, shot]));
  const latestByGroup = new Map();
  const findings = [];
  for (const item of [...(timeline?.items ?? [])].sort((left, right) => left.destinationInSeconds - right.destinationInSeconds)) {
    const shot = byId.get(item.shotId);
    const group = shot?.duplicateGroup;
    if (!group) continue;
    const previous = latestByGroup.get(group);
    if (previous && item.destinationInSeconds - previous.item.destinationInSeconds < minSeparationSeconds) {
      findings.push({
        code: 'E_DUPLICATE_SEPARATION', duplicateGroup: group,
        previousItemId: previous.item.itemId, itemId: item.itemId,
        separationSeconds: item.destinationInSeconds - previous.item.destinationInSeconds,
        minimumSeparationSeconds: minSeparationSeconds,
      });
    }
    latestByGroup.set(group, { item, shot });
  }
  return findings;
}

export function findContinuityWarnings(previousShot, nextShot) {
  if (!previousShot || !nextShot) return [];
  const warnings = [];
  const pairs = [
    ['screenDirection', 'W_SCREEN_DIRECTION', 'screen direction reverses across the cut'],
    ['motionDirection', 'W_MOTION_DIRECTION', 'motion direction reverses across the cut'],
  ];
  for (const [field, code, message] of pairs) {
    const previous = previousShot.continuity?.[field];
    const next = nextShot.continuity?.[field];
    if (previous && next && previous !== 'unknown' && next !== 'unknown' && previous !== 'static' && next !== 'static' && previous !== next) {
      warnings.push({ code, message, previousShotId: previousShot.shotId, nextShotId: nextShot.shotId });
    }
  }
  return warnings;
}

function validateSource(item, index, phase, probeById, errors) {
  const path = `/items/${index}`;
  const source = probeById.get(item.sourceMediaId);
  if (!source) {
    errors.push(diagnostic('E_SOURCE_REFERENCE', `${path}/sourceMediaId`, 'source media must resolve in current PROBE'));
    return;
  }
  if (item.sourceKind !== source.mediaType || item.sourceReference?.digest !== source.sourceDigest) {
    errors.push(diagnostic('E_SOURCE_REFERENCE', `${path}/sourceReference`, 'timeline source must bind current media kind and source digest'));
  }
  if (source.mediaType === 'image') {
    if (item.sourceInSeconds !== 0 || item.sourceOutSeconds > 0.001 || item.sourceOutSeconds <= 0) {
      errors.push(diagnostic('E_STILL_SOURCE_RANGE', path, 'still sources use the zero-origin synthetic source interval only'));
    }
  } else if (item.sourceInSeconds < 0 || !(item.sourceOutSeconds > item.sourceInSeconds) || item.sourceOutSeconds > source.durationSeconds) {
    errors.push(diagnostic('E_SOURCE_BOUNDS', path, 'source interval exceeds the current probed duration'));
  }
  if (phase === 'rough') {
    if (item.sourceReference?.kind !== 'proxy' || item.sourceReference?.path !== source.proxy?.path) {
      errors.push(diagnostic('E_ROUGH_PROXY_REQUIRED', `${path}/sourceReference`, 'rough timelines must resolve the current analysis proxy'));
    }
    if ((item.assetReferences?.length ?? 0) > 0 || (item.motionReferences?.length ?? 0) > 0) {
      errors.push(diagnostic('E_ROUGH_PRODUCTION_REFERENCE', path, 'rough timelines cannot reference production assets or motion owners'));
    }
  } else if (item.sourceReference?.kind !== 'original') {
    errors.push(diagnostic('E_FINAL_ORIGINAL_REQUIRED', `${path}/sourceReference`, 'final timelines must resolve immutable originals'));
  } else if (typeof item.sourceReference.path !== 'string'
    || !item.sourceReference.path.startsWith(`media/originals/${item.sourceMediaId}.`)) {
    errors.push(diagnostic('E_FINAL_ORIGINAL_REQUIRED', `${path}/sourceReference/path`, 'final source locators must use the stable original media ID path'));
  }
}

function validateTreatment(item, shot, index, policy, errors) {
  const path = `/items/${index}`;
  const curve = normalizePlaybackRateCurve(item);
  const maximumRate = policy.speedPolicy?.maximumMontageRate ?? 1;
  for (let pointIndex = 0; pointIndex < curve.length; pointIndex += 1) {
    const point = curve[pointIndex];
    if (!(point.rate > 0) || point.rate > maximumRate) errors.push(diagnostic('E_SPEED_RATE', `${path}/playbackRateCurve/${pointIndex}/rate`, 'speed curve exceeds the active sport profile'));
    if (pointIndex > 0 && point.sourceTimeSeconds <= curve[pointIndex - 1].sourceTimeSeconds) {
      errors.push(diagnostic('E_SPEED_CURVE_ORDER', `${path}/playbackRateCurve/${pointIndex}`, 'speed-curve source times must be strictly increasing'));
    }
  }
  if (curve.length > 1 && (curve[0].sourceTimeSeconds !== item.sourceInSeconds
    || curve.at(-1).sourceTimeSeconds !== item.sourceOutSeconds)) {
    errors.push(diagnostic('E_SPEED_CURVE_COVERAGE', `${path}/playbackRateCurve`, 'speed curve must cover the exact selected source interval'));
  }
  const cropFraction = item.transform?.stabilization?.cropFraction ?? 0;
  if (cropFraction > (policy.stabilizationPolicy?.maximumCropFraction ?? 0)) {
    errors.push(diagnostic('E_STABILIZATION_CROP', `${path}/transform/stabilization/cropFraction`, 'stabilization crop exceeds the active profile'));
  }
  if (item.sourceKind === 'image') {
    const still = item.transform?.stillMotion;
    const destinationDuration = item.destinationOutSeconds - item.destinationInSeconds;
    if (!still || still.holdSeconds !== destinationDuration || still.holdSeconds < 0.75 || still.holdSeconds > 12) {
      errors.push(diagnostic('E_STILL_HOLD', `${path}/transform/stillMotion`, 'still hold must match the edit duration and remain between 0.75 and 12 seconds'));
    }
    if (still?.mode === 'panzoom' && (!(still.startScale >= 1) || still.endScale < still.startScale || still.endScale > 1.25)) {
      errors.push(diagnostic('E_STILL_PANZOOM', `${path}/transform/stillMotion`, 'still pan/zoom scale must remain restrained between 1.0 and 1.25'));
    }
  }
  if ((shot?.setupTailLikelihood ?? 0) >= 0.8) errors.push(diagnostic('E_SETUP_TAIL', path, 'high-likelihood setup/tail footage cannot enter the edit'));
  if (shot?.quality?.shake === 'severe' && !['exclude', 'stabilize-reviewed'].includes(item.transform?.severeShakeDisposition)) {
    errors.push(diagnostic('E_SEVERE_SHAKE', `${path}/transform`, 'severe shake requires explicit exclusion or reviewed stabilization'));
  }
  if (item.transition?.kind !== 'none' && !item.transition?.ownerId) {
    errors.push(diagnostic('E_TRANSITION_OWNER', `${path}/transition/ownerId`, 'a transition requires one declared visual owner'));
  }
  const expectedDuration = curve.length > 1
    ? curve.slice(0, -1).reduce((total, point, pointIndex) => total
      + (curve[pointIndex + 1].sourceTimeSeconds - point.sourceTimeSeconds) / point.rate, 0)
    : (item.sourceOutSeconds - item.sourceInSeconds) / (item.playbackRate ?? 1);
  const destinationDuration = item.destinationOutSeconds - item.destinationInSeconds;
  if (Number.isFinite(expectedDuration) && Math.abs(expectedDuration - destinationDuration) > 0.02) {
    errors.push(diagnostic('E_PLAYBACK_DURATION', path, 'picture and audio duration must match the declared playback-rate curve'));
  }
  if (!['off', 'subtle-reviewed'].includes(item.transform?.faceTreatment ?? 'off')) {
    errors.push(diagnostic('E_FACE_TREATMENT', `${path}/transform/faceTreatment`, 'face treatment defaults off and must be explicitly reviewed when enabled'));
  }
}

function validateShotBinding(item, shot, index, errors) {
  if (!shot) return;
  const path = `/items/${index}`;
  if (item.sourceMediaId !== shot.mediaId || item.sourceReference?.digest !== shot.sourceDigest
    || item.sourceDurationSeconds !== shot.sourceDurationSeconds) {
    errors.push(diagnostic('E_SHOT_SOURCE_BINDING', path, 'timeline source media, digest, and duration must match the referenced shot'));
  }
  if (item.sourceInSeconds < shot.sourceInSeconds || item.sourceOutSeconds > shot.sourceOutSeconds) {
    errors.push(diagnostic('E_SHOT_SOURCE_BOUNDS', path, 'timeline source interval must remain within the referenced shot'));
  }
}

export function validateTimeline({ phase, probe, shots, transcript, assetManifest, motionMap, timeline, profiles }) {
  const errors = [];
  const warnings = [];
  const actualPhase = phase ?? timeline?.phase;
  if (!['rough', 'final'].includes(actualPhase) || timeline?.phase !== actualPhase) errors.push(diagnostic('E_TIMELINE_PHASE', '/phase', 'timeline phase must match the requested rough/final phase'));
  if (timeline?.sourceProbeDigest !== probe?.integrity?.digest) errors.push(diagnostic('E_PROBE_DIGEST_STALE', '/sourceProbeDigest', 'timeline must bind the current PROBE digest'));
  const probeById = new Map((probe?.media ?? []).map((entry) => [entry.mediaId, entry]));
  const shotList = shots?.shots ?? [];
  const shotById = new Map(shotList.map((shot) => [shot.shotId, shot]));
  const policy = policies(profiles);
  const expectedUpstream = {
    ...(probe?.integrity?.digest ? { probe: probe.integrity.digest } : {}),
    ...(shots?.integrity?.digest ? { shots: shots.integrity.digest } : {}),
    ...(transcript?.integrity?.digest ? { transcript: transcript.integrity.digest } : {}),
  };
  if (timeline?.integrity && Object.keys(expectedUpstream).length > 0) {
    const actualUpstream = timeline?.integrity?.upstream ?? {};
    const expectedRoles = Object.keys(expectedUpstream).sort();
    const actualRoles = Object.keys(actualUpstream).sort();
    if (expectedRoles.length !== actualRoles.length || expectedRoles.some((role, index) => role !== actualRoles[index]
      || expectedUpstream[role] !== actualUpstream[role])) {
      errors.push(diagnostic('E_TIMELINE_LINEAGE', '/integrity/upstream', 'timeline must bind the exact current probe, shots, and transcript revisions'));
    }
  }
  const items = timeline?.items ?? [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const shot = shotById.get(item.shotId);
    if (!shot) errors.push(diagnostic('E_SHOT_REFERENCE', `/items/${index}/shotId`, 'timeline item must resolve an Agent-authored shot'));
    validateShotBinding(item, shot, index, errors);
    validateSource(item, index, actualPhase, probeById, errors);
    validateTreatment(item, shot, index, policy, errors);
    if (index > 0) {
      const previous = items[index - 1];
      if (item.destinationInSeconds < previous.destinationOutSeconds) errors.push(diagnostic('E_DESTINATION_OVERLAP', `/items/${index}`, 'destination intervals cannot overlap without a declared composite'));
      for (const warning of findContinuityWarnings(shotById.get(previous.shotId), shot)) {
        const itemIds = [previous.itemId, item.itemId];
        warnings.push({ ...warning, itemIds, decisionId: decisionId(warning.code, itemIds) });
      }
    }
  }
  const minimumSeparation = policy.duplicatePolicy?.minimumSeparationSeconds ?? 0;
  errors.push(...findDuplicateViolations(timeline, shotList, minimumSeparation).map((finding) => diagnostic(
    finding.code, '/items', 'duplicate shots are too close for the active profile', finding,
  )));
  errors.push(...validateAudioContinuity(timeline, transcript).errors);
  if (actualPhase === 'final') {
    const assets = new Set((assetManifest?.assets ?? []).map(({ assetId }) => assetId));
    const owners = new Set((motionMap?.owners ?? []).map(({ ownerId }) => ownerId));
    if (assetManifest?.status !== 'frozen' || motionMap?.status !== 'frozen') errors.push(diagnostic('E_FINAL_DESIGN_OWNERSHIP', '/', 'final timeline requires frozen asset and motion contracts'));
    for (let index = 0; index < items.length; index += 1) {
      for (const id of items[index].assetReferences ?? []) if (!assets.has(id)) errors.push(diagnostic('E_ASSET_REFERENCE', `/items/${index}/assetReferences`, `unresolved asset ${id}`));
      for (const id of items[index].motionReferences ?? []) if (!owners.has(id)) errors.push(diagnostic('E_MOTION_REFERENCE', `/items/${index}/motionReferences`, `unresolved motion owner ${id}`));
      const transitionOwner = items[index].transition?.ownerId;
      if (items[index].transition?.kind !== 'none'
        && (!owners.has(transitionOwner) || !(items[index].motionReferences ?? []).includes(transitionOwner))) {
        errors.push(diagnostic('E_TRANSITION_OWNER_REFERENCE', `/items/${index}/transition/ownerId`, 'final transition owner must resolve in the frozen motion map and this item motionReferences'));
      }
    }
  }
  const decisions = new Map((timeline?.warningDecisions ?? []).map((entry) => [entry.decisionId, entry]));
  const warningIds = new Set(warnings.map(({ decisionId: id }) => id));
  const basisDigest = computeWarningDecisionDigest(timeline);
  for (const [id, decision] of decisions) {
    if (!warningIds.has(id)) errors.push(diagnostic('E_WARNING_DECISION_UNKNOWN', '/warningDecisions', `decision ${id} does not bind a current warning`));
    if (decision.timelineRevision !== timeline.timelineRevision || decision.timelineDigest !== basisDigest) {
      errors.push(diagnostic('E_WARNING_DECISION_STALE', '/warningDecisions', `decision ${id} is stale`));
    }
    if (decision.decision !== 'accept') errors.push(diagnostic('E_WARNING_DECISION_REJECTED', '/warningDecisions', `decision ${id} does not accept the warning`));
  }
  const undecidedWarnings = warnings.filter(({ decisionId: id }) => {
    const decision = decisions.get(id);
    return !decision || decision.decision !== 'accept' || decision.timelineRevision !== timeline.timelineRevision
      || decision.timelineDigest !== basisDigest || typeof decision.reason !== 'string' || decision.reason.trim() === '';
  });
  return {
    valid: errors.length === 0, renderable: errors.length === 0 && undecidedWarnings.length === 0,
    errors, warnings, undecidedWarnings, agentDecisionRequired: undecidedWarnings.length > 0,
  };
}
