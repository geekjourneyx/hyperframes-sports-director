import { ARTIFACT_ROLE_DEPENDENCIES, applyApprovedRepair, classifyApprovedRepair, computeInvalidationClosure } from './invalidation.mjs';
import { computeArtifactDigest } from './contracts.mjs';
import { deltaE2000 } from './proof-evidence.mjs';

const round = (value) => Number(value.toFixed(6));

function linear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(pixel) {
  return (0.2126 * linear(pixel[0])) + (0.7152 * linear(pixel[1])) + (0.0722 * linear(pixel[2]));
}

function contrastRatio(left, right) {
  const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (bright + 0.05) / (dark + 0.05);
}

function matteCoverage(pixel) {
  return ((pixel[0] + pixel[1] + pixel[2]) / (3 * 255)) * ((pixel[3] ?? 255) / 255);
}

function addSample(samples, time, reason, context = {}) {
  if (!Number.isFinite(time) || time < 0) return;
  const key = round(time);
  const existing = samples.get(key) ?? { time: key, reasons: [], targets: [] };
  if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
  if (context.sceneId || context.layerId || context.overlayId) {
    const target = { ...(context.sceneId ? { sceneId: context.sceneId } : {}), ...(context.layerId ? { layerId: context.layerId } : {}), ...(context.overlayId ? { overlayId: context.overlayId } : {}) };
    if (!existing.targets.some((entry) => entry.sceneId === target.sceneId && entry.layerId === target.layerId && entry.overlayId === target.overlayId)) existing.targets.push(target);
  }
  samples.set(key, existing);
}

export function buildInspectionSchedule({ scenes = [], owners = [], overlays = [], transitions = [], motionExtrema = [], luminanceExtrema = [] } = {}) {
  const samples = new Map();
  for (const scene of scenes) {
    const bounds = [...(scene.interval?.entry ?? []), ...(scene.interval?.hold ?? []), ...(scene.interval?.exit ?? [])];
    for (const time of bounds) addSample(samples, time, 'scene-boundary', { sceneId: scene.sceneId });
    for (const layer of scene.readableLayers ?? []) {
      const [start, end] = layer.readableInterval ?? [];
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
      for (let tick = Math.ceil(start * 10); tick <= Math.floor(end * 10); tick += 1) addSample(samples, tick / 10, 'readable-10hz', { sceneId: scene.sceneId, layerId: layer.layerId });
      addSample(samples, start, 'readable-entry', { sceneId: scene.sceneId, layerId: layer.layerId });
      addSample(samples, end, 'readable-exit', { sceneId: scene.sceneId, layerId: layer.layerId });
    }
  }
  for (const owner of owners) {
    const interval = [owner.timing?.entry?.[0], owner.timing?.exit?.[1]];
    if (interval.every(Number.isFinite)) for (let tick = Math.ceil(interval[0] * 10); tick <= Math.floor(interval[1] * 10); tick += 1) addSample(samples, tick / 10, 'visible-layer-10hz', { sceneId: owner.sceneId, layerId: owner.layerId });
    for (const [phase, bounds] of Object.entries(owner.timing ?? {})) for (const time of bounds ?? []) addSample(samples, time, `layer-${phase}`, { sceneId: owner.sceneId, layerId: owner.layerId });
  }
  for (const overlay of overlays) {
    const [start, end] = overlay.interval ?? [overlay.destinationInSeconds, overlay.destinationOutSeconds];
    if (Number.isFinite(start) && Number.isFinite(end)) for (let tick = Math.ceil(start * 10); tick <= Math.floor(end * 10); tick += 1) addSample(samples, tick / 10, 'overlay-10hz', { overlayId: overlay.overlayId });
    addSample(samples, start, 'overlay-entry', { overlayId: overlay.overlayId }); addSample(samples, end, 'overlay-exit', { overlayId: overlay.overlayId });
  }
  for (const transition of transitions) addSample(samples, transition.midpointSeconds, 'transition-midpoint', { sceneId: transition.sceneId, layerId: transition.layerId });
  for (const time of motionExtrema) addSample(samples, time, 'motion-extremum');
  for (const time of luminanceExtrema) addSample(samples, time, 'luminance-extremum');
  return [...samples.values()].map((sample) => ({ ...sample, reasons: sample.reasons.sort(), targets: sample.targets.sort((left, right) => `${left.sceneId ?? ''}:${left.layerId ?? ''}:${left.overlayId ?? ''}`.localeCompare(`${right.sceneId ?? ''}:${right.layerId ?? ''}:${right.overlayId ?? ''}`)) })).sort((left, right) => left.time - right.time);
}

const PIXEL_PROOF_KEYS = ['schemaVersion', 'revision', 'producerCommand', 'encodedMp4Digest', 'authorities', 'frames', 'integrity'];
const PROOF_AUTHORITIES = ['assetManifest', 'dataOverlays', 'designSystem', 'lookProfile', 'motionMap', 'sceneSchema', 'timeline'];
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const portable = (value) => typeof value === 'string' && !value.startsWith('/') && !value.includes('..') && !value.includes('\\') && !/^[a-z][a-z0-9+.-]*:/i.test(value);
const fileRef = (value, root) => exactKeys(value, ['path', 'digest']) && portable(value.path) && value.path.startsWith(root) && /^[0-9a-f]{64}$/.test(value.digest);

export function validateFinalPixelProof(proof, { encodedMp4Digest, documents, schedule }) {
  if (!exactKeys(proof, PIXEL_PROOF_KEYS) || proof.schemaVersion !== '1.0.0' || !Number.isInteger(proof.revision) || proof.revision < 1
    || proof.producerCommand !== 'render_final_proof_passes.mjs' || proof.encodedMp4Digest !== encodedMp4Digest
    || !exactKeys(proof.authorities, PROOF_AUTHORITIES) || PROOF_AUTHORITIES.some((role) => proof.authorities[role] !== documents?.[role]?.integrity?.digest)
    || !exactKeys(proof.integrity, ['digest', 'upstream']) || proof.integrity.digest !== computeArtifactDigest(proof)
    || !exactKeys(proof.integrity.upstream, ['FINAL_RENDER']) || proof.integrity.upstream.FINAL_RENDER !== documents.finalRenderDigest) {
    const error = new Error('final pixel proof is malformed or stale'); error.code = 'E_FINAL_PIXEL_PROOF'; throw error;
  }
  const root = `review/final-proof-passes/${encodedMp4Digest}/`;
  if (!Array.isArray(proof.frames) || proof.frames.length !== schedule.length) {
    const error = new Error('final pixel proof is incomplete'); error.code = 'E_FINAL_PIXEL_PROOF'; throw error;
  }
  const owners = new Map((documents.motionMap.owners ?? []).map((owner) => [owner.layerId, owner]));
  const overlayTokens = new Map((documents.dataOverlays.overlays ?? []).map((overlay) => [overlay.overlayId, overlay.colorToken]));
  for (const [index, sample] of schedule.entries()) {
    const frame = proof.frames[index];
    const requiredLayers = [...new Set(sample.targets.flatMap(({ layerId }) => layerId ? [layerId] : []))].sort();
    const requiredTokens = [...new Set(sample.targets.flatMap(({ layerId, overlayId }) => layerId ? [owners.get(layerId)?.colorToken] : overlayId ? [overlayTokens.get(overlayId)] : []).filter(Boolean))].sort();
    if (!exactKeys(frame, ['time', 'backgroundPass', 'layerMattes', 'tokenMattes']) || round(frame.time) !== round(sample.time)
      || !fileRef(frame.backgroundPass, root) || !Array.isArray(frame.layerMattes) || !Array.isArray(frame.tokenMattes)
      || frame.layerMattes.some((entry) => !exactKeys(entry, ['layerId', 'path', 'digest']) || !fileRef({ path: entry.path, digest: entry.digest }, root))
      || frame.tokenMattes.some((entry) => !exactKeys(entry, ['tokenName', 'path', 'digest', 'alpha']) || !fileRef({ path: entry.path, digest: entry.digest }, root) || !Number.isFinite(entry.alpha) || entry.alpha < 0 || entry.alpha > 1)
      || JSON.stringify(frame.layerMattes.map(({ layerId }) => layerId).sort()) !== JSON.stringify(requiredLayers)
      || JSON.stringify(frame.tokenMattes.map(({ tokenName }) => tokenName).sort()) !== JSON.stringify(requiredTokens)) {
      const error = new Error(`final proof-pass frame ${index} does not cover its authoritative schedule targets`); error.code = 'E_FINAL_PIXEL_PROOF'; throw error;
    }
  }
  return proof;
}

export function measureLocalContrast({ kind, samples }) {
  const perTime = Map.groupBy((samples ?? []).filter(({ matte }) => matteCoverage(matte) >= 0.9)
    .map((sample) => ({ time: sample.time, ratio: round(contrastRatio(sample.composite, sample.background)) })), ({ time }) => time);
  const interior = [...perTime.entries()].map(([time, entries]) => ({ time, ratio: Math.min(...entries.map(({ ratio }) => ratio)) })).sort((left, right) => left.time - right.time);
  const threshold = ['large-text', 'meaningful-graphic'].includes(kind) ? 3 : 4.5;
  const passed = interior.filter(({ ratio }) => ratio >= threshold);
  const failures = interior.filter(({ ratio }) => ratio < threshold);
  let longestFailureSeconds = 0; let runStart = null; let prior = null;
  for (const sample of interior) {
    if (sample.ratio < threshold) { if (runStart === null) runStart = sample.time; prior = sample.time; }
    else if (runStart !== null) { longestFailureSeconds = Math.max(longestFailureSeconds, prior - runStart + 0.1); runStart = null; }
  }
  if (runStart !== null) longestFailureSeconds = Math.max(longestFailureSeconds, prior - runStart + 0.1);
  const passFraction = interior.length === 0 ? 0 : passed.length / interior.length;
  const pass = interior.length > 0 && (kind === 'critical-text'
    ? failures.length === 0
    : ['large-text', 'meaningful-graphic'].includes(kind) ? failures.length === 0 : passFraction >= 0.95 && longestFailureSeconds <= 0.25);
  return { kind, pass, threshold, target: kind === 'critical-text' ? 7 : threshold, minimum: interior.length ? Math.min(...interior.map(({ ratio }) => ratio)) : null, passFraction: round(passFraction), longestFailureSeconds: round(longestFailureSeconds), samples: interior };
}

export function measureRenderedTokenColor({ token, samples }) {
  const measured = (samples ?? []).filter(({ matte }) => matteCoverage(matte) >= 0.9).map((sample) => {
    const expected = token.map((channel, index) => Math.round((channel * sample.alpha) + (sample.background[index] * (1 - sample.alpha))));
    return { time: sample.time, deltaE2000: round(deltaE2000(sample.composite, expected)) };
  });
  const interior = [...Map.groupBy(measured, ({ time }) => time).entries()].map(([time, entries]) => ({ time, deltaE2000: Math.max(...entries.map(({ deltaE2000: value }) => value)) })).sort((left, right) => left.time - right.time);
  return { pass: interior.length > 0 && interior.every(({ deltaE2000: value }) => value <= 3), threshold: 3, interiorSamples: interior.length, maximumDeltaE2000: interior.length ? Math.max(...interior.map(({ deltaE2000: value }) => value)) : null, samples: interior };
}

export function evaluateMachineGates(measurements, policy = {}) {
  const failures = [];
  const fail = (condition, code, value) => { if (condition) failures.push({ code, value }); };
  fail(measurements.closedProbe?.valid !== true, 'closed_file_probe', measurements.closedProbe);
  fail(!Number.isFinite(measurements.blackFramesSeconds) || measurements.blackFramesSeconds > 0, 'black_frames', measurements.blackFramesSeconds);
  fail(!Number.isFinite(measurements.freezeSpansSeconds) || measurements.freezeSpansSeconds > 0, 'freeze_spans', measurements.freezeSpansSeconds);
  fail(!Number.isInteger(measurements.clippedSamples) || measurements.clippedSamples > 0, 'audio_clipping', measurements.clippedSamples);
  fail(!Number.isFinite(measurements.integratedLufs) || measurements.integratedLufs < policy.loudness?.minimumLufs || measurements.integratedLufs > policy.loudness?.maximumLufs, 'loudness', measurements.integratedLufs);
  fail(!Number.isFinite(measurements.avDriftSeconds) || measurements.avDriftSeconds > (policy.frameDurationSeconds ?? 1 / 24), 'av_drift', measurements.avDriftSeconds);
  fail(!Number.isFinite(measurements.identitySsim) || measurements.identitySsim < (policy.minimumIdentitySsim ?? 0.95), 'detail_loss', measurements.identitySsim);
  fail(measurements.inputColorDeclared !== true, 'input_color_profile', measurements.inputColorDeclared);
  fail(!Array.isArray(measurements.contrast) || measurements.contrast.length === 0 || measurements.contrast.some(({ pass }) => !pass), 'local_contrast', measurements.contrast);
  fail(!Array.isArray(measurements.tokenColor) || measurements.tokenColor.length === 0 || measurements.tokenColor.some(({ pass }) => !pass), 'token_color', measurements.tokenColor);
  fail(!Array.isArray(measurements.layoutCollisions) || measurements.layoutCollisions.length > 0, 'layout_collision', measurements.layoutCollisions);
  fail(!Array.isArray(measurements.quietZoneLosses) || measurements.quietZoneLosses.length > 0, 'quiet_zone_loss', measurements.quietZoneLosses);
  fail(measurements.crossSceneConsistency?.pass !== true, 'cross_scene_consistency', measurements.crossSceneConsistency);
  return { pass: failures.length === 0, agentReviewAllowed: failures.length === 0, failures };
}

export function reviewRepairDecision(change, { gate, history = [] }) {
  if (history.filter((record) => record.gate === gate).length >= 3) return { allowed: false, code: 'repair_budget_exhausted' };
  const classification = classifyApprovedRepair(change);
  if (!classification.allowed) return { allowed: false, code: classification.code };
  return { allowed: true, code: 'repair_allowed', invalidatedRoles: computeInvalidationClosure([classification.changedRole], ARTIFACT_ROLE_DEPENDENCIES) };
}

export function applyInspectionRepair(projectState, change, context) {
  const result = applyApprovedRepair(projectState, change, context);
  return { ...result, rerunRoles: result.allowed ? [...result.repair.invalidatedRoles] : [] };
}

function evidence(gate, role, revision, digest, timestamp, qualifier) {
  return { gate, role, revision, digest, timestamp, producerCommand: 'inspect_output.mjs', qualifiers: [qualifier], validity: 'valid', invalidatedAt: null };
}

function transition(state, to, records, timestamp) {
  const next = structuredClone(state);
  next.previousState = state.state; next.state = to; next.stateEnteredAt = timestamp; next.revision += 1;
  next.gateEvidence.push(...records);
  next.transitions.push({ from: state.state, to, at: timestamp, evidenceDigests: Object.fromEntries(records.map(({ role, digest }) => [role, digest])), evidenceRevisions: Object.fromEntries(records.map(({ role, revision }) => [role, revision])) });
  next.integrity.digest = null;
  return next;
}

export function commitFinalQaState(projectState, metrics, timestamp) {
  if (projectState?.state !== 'FINAL_RENDER' || !['measured', 'accepted'].includes(metrics?.status)
    || !/^[0-9a-f]{64}$/.test(metrics.integrity?.digest ?? '') || !Number.isFinite(Date.parse(timestamp ?? ''))) {
    const error = new Error('FINAL_QA requires passed machine evidence from FINAL_RENDER'); error.code = 'E_FINAL_QA_EVIDENCE'; throw error;
  }
  const qa = transition(projectState, 'FINAL_QA', [evidence('FINAL_QA', 'REVIEW_METRICS', metrics.revision, metrics.integrity.digest, timestamp, 'hard-gates-passed')], timestamp);
  qa.integrity.digest = computeArtifactDigest(qa);
  return qa;
}

export function commitDeliveredState(projectState, metrics, timestamp) {
  if (projectState?.state !== 'FINAL_QA' || metrics?.status !== 'accepted' || metrics.agentInspection?.status !== 'accepted') {
    const error = new Error('delivery requires Agent inspection of encoded MP4 evidence after FINAL_QA'); error.code = 'E_DELIVERY_EVIDENCE'; throw error;
  }
  const roles = { CLOSED_FILE_PROBE: 'passed', HARD_GATES: 'passed', AGENT_VISUAL_INSPECTION: 'accepted', ENCODED_MP4_EVIDENCE: 'accepted' };
  const records = Object.entries(roles).map(([role, qualifier]) => evidence('DELIVERED', role, metrics.revision, metrics.integrity.digest, timestamp, qualifier));
  const delivered = transition(projectState, 'DELIVERED', records, timestamp);
  delivered.integrity.digest = computeArtifactDigest(delivered);
  return delivered;
}

export function commitInspectionStates(projectState, metrics, timestamp) {
  const qa = commitFinalQaState(projectState, metrics, timestamp);
  const delivered = commitDeliveredState(qa, metrics, timestamp);
  return { finalQa: qa, delivered };
}

export function commitInspectionBlockedState(projectState, metrics, timestamp) {
  if (!['FINAL_RENDER', 'FINAL_QA'].includes(projectState?.state) || metrics?.status !== 'rejected' || !/^[0-9a-f]{64}$/.test(metrics.integrity?.digest ?? '')) {
    const error = new Error('blocking final inspection requires rejected metrics from an active final gate'); error.code = 'E_FINAL_QA_EVIDENCE'; throw error;
  }
  const agentRejected = metrics.agentInspection?.status === 'rejected';
  const record = evidence('BLOCKED', agentRejected ? 'AGENT_VISUAL_INSPECTION' : 'HARD_GATE_FAILURE', metrics.revision, metrics.integrity.digest, timestamp, agentRejected ? 'agent-rejected' : 'hard-gate-failed');
  const blocked = transition(projectState, 'BLOCKED', [record], timestamp);
  blocked.assetAcceptance = null;
  blocked.integrity.digest = computeArtifactDigest(blocked);
  return blocked;
}
