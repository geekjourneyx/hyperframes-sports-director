import { createHash } from 'node:crypto';

import { formatDataOverlayWording, validateDataOverlayAuthority } from './activity.mjs';
import { validateSceneLayout } from './layout.mjs';

const RELATIONSHIPS = new Set(['spatial-continuation', 'motion-match', 'shape-mask-carry', 'environmental-texture-bridge', 'data-to-footage-bridge']);

function hard(code, path, message, category = 'motion') {
  return { code, classification: 'hard_error', category, path, message };
}

function intervalValid(value) {
  return Array.isArray(value) && value.length === 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && value[1] > value[0];
}

function seededUnit(seed, identity) {
  const bytes = createHash('sha256').update(`${seed}:${identity}`).digest();
  return bytes.readUInt32BE(0) / 0xffffffff;
}

export function validateDeterministicRuntimeSource(source) {
  const hardErrors = [];
  for (const forbidden of ['Date.now', 'Math.random', 'setTimeout', 'setInterval', 'requestAnimationFrame']) {
    if (String(source).includes(forbidden)) hardErrors.push(hard('E_RUNTIME_NONDETERMINISTIC', '/runtimeSource', `render truth cannot use ${forbidden}`, 'timing-determinism'));
  }
  return { valid: hardErrors.length === 0, hardErrors, errors: hardErrors };
}

export function resolveDataOverlayDisplay(dataOverlays, normalizedFacts) {
  return (dataOverlays?.overlays ?? []).map((overlay) => {
    const fact = normalizedFacts?.[overlay.metricId] ?? normalizedFacts?.[overlay.metricId.replace(/^metrics\./, '')];
    if (!fact || !Object.hasOwn(fact, 'value')) { const cause = new Error(`normalized fact is unavailable: ${overlay.metricId}`); cause.code = 'E_OVERLAY_FACT_AUTHORITY'; throw cause; }
    const wording = formatDataOverlayWording(overlay.metricId, fact);
    if (overlay.wording !== wording) { const cause = new Error(`overlay wording does not match its authorized fact: ${overlay.metricId}`); cause.code = 'E_OVERLAY_WORDING'; throw cause; }
    return {
      overlayId: overlay.overlayId, metricId: overlay.metricId, value: fact.value, unit: fact.unit ?? null,
      wording, displayAuthority: overlay.displayAuthority, syncAuthority: overlay.syncAuthority,
      colorToken: overlay.colorToken, interval: [overlay.destinationInSeconds, overlay.destinationOutSeconds],
    };
  });
}

export function validateMotionContract({ designSystem, lookProfile, assetManifest, motionMap, sceneSchema, dataOverlays, timeline, activity, syncMap, primaryMetricIds, normalizedActivityFacts, runtimeSource, shots, projectState } = {}) {
  const hardErrors = [];
  if (designSystem?.status !== 'frozen' || lookProfile?.status !== 'frozen' || assetManifest?.status !== 'frozen' || motionMap?.status !== 'frozen' || sceneSchema?.status !== 'frozen') {
    hardErrors.push(hard('E_COMPOSITION_AUTHORITY', '/', 'composition requires frozen design, Look, asset, motion, and scene contracts', 'authority'));
  }
  if (!assetManifest?.acceptance?.anchorDigest || !assetManifest?.acceptance?.representativeDigest || !(assetManifest?.acceptance?.batches?.length > 0)) {
    hardErrors.push(hard('E_ASSET_GATE_AUTHORITY', '/assetManifest/acceptance', 'Task 12 anchor, representative proof, and accepted batch authority are required', 'authority'));
  }
  if (motionMap?.designSystemDigest !== designSystem?.integrity?.digest || motionMap?.assetManifestDigest !== assetManifest?.integrity?.digest
    || motionMap?.sceneSchemaDigest !== sceneSchema?.integrity?.digest || sceneSchema?.designSystemDigest !== designSystem?.integrity?.digest
    || sceneSchema?.lookProfileDigest !== lookProfile?.integrity?.digest) hardErrors.push(hard('E_COMPOSITION_DIGEST_BINDING', '/', 'scene and motion contracts must bind exact frozen design, Look, asset, and scene digests', 'authority'));
  if (projectState && (!['ASSET_PRODUCTION', 'MOTION_COMPOSITION', 'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED'].includes(projectState.state) || projectState.assetAcceptance?.manifestDigest !== assetManifest?.integrity?.digest
    || projectState.assetAcceptance?.stage !== 'batch')) hardErrors.push(hard('E_ASSET_GATE_AUTHORITY', '/projectState/assetAcceptance', 'composition requires the current accepted Task 12 manifest batch', 'authority'));
  const owners = motionMap?.owners ?? [];
  const ownerIds = new Set(); const layerIds = new Set();
  for (const [index, owner] of owners.entries()) {
    const path = `/motionMap/owners/${index}`;
    if (ownerIds.has(owner.ownerId) || layerIds.has(owner.layerId)) hardErrors.push(hard('E_MOTION_OWNER_COUNT', path, 'each visible layer must have exactly one deterministic owner', 'ownership'));
    ownerIds.add(owner.ownerId); layerIds.add(owner.layerId);
    for (const name of ['entry', 'hold', 'exit']) if (!intervalValid(owner.timing?.[name])) hardErrors.push(hard('E_MOTION_INTERVAL', `${path}/timing/${name}`, `owner requires a non-empty ${name} interval`, 'timing-determinism'));
    if (intervalValid(owner.timing?.entry) && intervalValid(owner.timing?.hold) && intervalValid(owner.timing?.exit)
      && (owner.timing.entry[1] > owner.timing.hold[0] || owner.timing.hold[1] > owner.timing.exit[0])) hardErrors.push(hard('E_MOTION_INTERVAL_ORDER', `${path}/timing`, 'entry, hold, and exit intervals must be ordered without overlap', 'timing-determinism'));
    if (!Array.isArray(owner.proofPasses) || owner.proofPasses.length === 0) hardErrors.push(hard('E_PROOF_PASS', `${path}/proofPasses`, 'motion owner requires deterministic proof-pass metadata'));
    if (owner.transition) {
      const midpoint = owner.transition.midpointSeconds;
      if (!RELATIONSHIPS.has(owner.transition.relationship) || owner.transition.nonEmpty !== true || !Number.isFinite(midpoint)
        || !intervalValid(owner.timing?.hold) || midpoint < owner.timing.hold[0] || midpoint > owner.timing.hold[1]) {
        hardErrors.push(hard('E_TRANSITION_MIDPOINT', `${path}/transition`, 'transition requires a semantic relationship and a non-empty owned midpoint', 'timing-determinism'));
      }
    }
  }
  const referencedAssets = new Set((timeline?.items ?? []).flatMap(({ assetReferences = [] }) => assetReferences));
  for (const [index, asset] of (assetManifest?.assets ?? []).entries()) {
    const id = asset.id ?? asset.assetId;
    if ((referencedAssets.has(id) || asset.visible === true) && owners.filter(({ assetId }) => assetId === id).length !== 1) hardErrors.push(hard('E_MOTION_OWNER_COUNT', `/assetManifest/assets/${index}`, `visible asset ${id} must have exactly one motion owner`, 'ownership'));
  }
  for (const [index, scene] of (sceneSchema?.scenes ?? []).entries()) for (const name of ['entry', 'hold', 'exit']) {
    if (!intervalValid(scene.interval?.[name])) hardErrors.push(hard('E_SCENE_INTERVAL', `/sceneSchema/scenes/${index}/interval/${name}`, `scene requires a non-empty ${name} interval`, 'timing-determinism'));
  }
  const shotById = new Map((shots?.shots ?? shots ?? []).map((shot) => [shot.shotId, shot]));
  for (const [sceneIndex, scene] of (sceneSchema?.scenes ?? []).entries()) for (const [layerIndex, layer] of (scene.readableLayers ?? []).entries()) {
    const owner = owners.find(({ ownerId }) => ownerId === layer.ownerId);
    if (!owner) hardErrors.push(hard('E_MOTION_OWNER_COUNT', `/sceneSchema/scenes/${sceneIndex}/readableLayers/${layerIndex}/ownerId`, 'readable layer must resolve exactly one motion owner', 'ownership'));
    for (const shotId of scene.shotIds ?? []) {
      const continuity = shotById.get(shotId)?.continuity;
      if (continuity && ((continuity.screenDirection !== 'unknown' && continuity.screenDirection !== layer.screenDirection)
        || (continuity.motionDirection !== 'unknown' && continuity.motionDirection !== layer.motionDirection)) && !owner?.designReason) {
        hardErrors.push(hard('E_DIRECTION_CONFLICT', `/sceneSchema/scenes/${sceneIndex}/readableLayers/${layerIndex}`, 'composition direction conflicts with shot continuity without a recorded design reason', 'bounds'));
      }
    }
  }
  if (!motionMap?.seed || typeof motionMap.seed !== 'string') hardErrors.push(hard('E_MOTION_SEED', '/motionMap/seed', 'deterministic composition requires an explicit seed', 'timing-determinism'));
  const facts = normalizedActivityFacts ?? dataOverlays?.normalizedFacts ?? activity?.metrics ?? {};
  for (const [index, overlay] of (dataOverlays?.overlays ?? []).entries()) {
    const path = `/dataOverlays/overlays/${index}`;
    const factKey = overlay.metricId?.replace(/^metrics\./, '');
    const fact = facts[overlay.metricId] ?? facts[factKey];
    if (!Object.hasOwn(facts, overlay.metricId) && !Object.hasOwn(facts, factKey)) hardErrors.push(hard('E_OVERLAY_FACT_AUTHORITY', `${path}/metricId`, 'overlay must reference a normalized activity fact; runtime cannot calculate metrics', 'activity-truth'));
    else if (overlay.wording !== formatDataOverlayWording(overlay.metricId, typeof fact === 'object' && fact !== null && Object.hasOwn(fact, 'value') ? fact : { value: fact })) hardErrors.push(hard('E_OVERLAY_WORDING', `${path}/wording`, 'overlay wording must be deterministically formatted from its current authorized fact', 'activity-truth'));
    if (!['local-observation', 'visible-with-caveat', 'chapter-summary', 'whole-activity'].includes(overlay.displayAuthority)
      || !['whole-activity', 'chapter', 'time-synchronized'].includes(overlay.syncAuthority)) hardErrors.push(hard('E_OVERLAY_DISPLAY_AUTHORITY', path, 'overlay lacks sufficient display or sync authority', 'activity-truth'));
  }
  if (activity && syncMap) {
    const authority = validateDataOverlayAuthority(activity, syncMap, dataOverlays, { primaryMetricIds });
    if (!authority.valid) hardErrors.push(...authority.errors.map((message) => hard('E_OVERLAY_DISPLAY_AUTHORITY', '/dataOverlays', message, 'activity-truth')));
  }
  if (timeline?.phase !== 'final' || timeline?.designRevision !== designSystem?.designRevision || timeline?.lookRevision !== lookProfile?.lookRevision
    || timeline?.assetRevision !== assetManifest?.assetRevision || timeline?.motionRevision !== motionMap?.motionRevision
    || timeline?.assetManifestDigest !== assetManifest?.integrity?.digest || timeline?.motionMapDigest !== motionMap?.integrity?.digest
    || timeline?.dataOverlaysDigest !== dataOverlays?.integrity?.digest) hardErrors.push(hard('E_TIMELINE_PRODUCTION_AUTHORITY', '/timeline', 'final timeline must bind current frozen production authority', 'authority'));
  const ownerById = new Map(owners.map((owner) => [owner.ownerId, owner]));
  for (const [index, item] of (timeline?.items ?? []).entries()) if (item.transition?.kind !== 'none' && !ownerById.get(item.transition?.ownerId)?.transition) {
    hardErrors.push(hard('E_TRANSITION_MIDPOINT', `/timeline/items/${index}/transition`, 'timeline transition must resolve an owner with semantic midpoint evidence', 'timing-determinism'));
  }
  const layout = validateSceneLayout({ sceneSchema, motionMap });
  hardErrors.push(...layout.hardErrors);
  if (runtimeSource !== undefined) hardErrors.push(...validateDeterministicRuntimeSource(runtimeSource).hardErrors);
  return { valid: hardErrors.length === 0, hardErrors, errors: hardErrors };
}

function ownerLayer(owner, scene, seed) {
  const readable = (scene.readableLayers ?? []).find(({ layerId }) => layerId === owner.layerId);
  return {
    ownerId: owner.ownerId, layerId: owner.layerId, assetId: owner.assetId ?? null, sceneId: owner.sceneId,
    primitive: owner.primitive, staticFallback: ['svg', 'css', 'lottie', 'three', 'gsap'].includes(owner.primitive) ? 'svg-or-css' : 'static',
    colorToken: owner.colorToken, timing: owner.timing, transition: owner.transition ?? null,
    deterministicOffset: Number(seededUnit(seed, owner.ownerId).toFixed(9)), proofPasses: [...(owner.proofPasses ?? [])].sort(),
    evidenceFrameIds: [...(readable?.evidenceFrameIds ?? [])].sort(), typographyRole: readable?.typographyRole ?? null,
    layoutEvidence: readable ? {
      readableInterval: structuredClone(readable.readableInterval), textRect: structuredClone(readable.textRect),
      subjectRect: structuredClone(readable.subjectRect), quietZone: structuredClone(readable.quietZone),
      safetyRegions: structuredClone(readable.safetyRegions ?? []), horizonRelation: readable.horizonRelation,
      screenDirection: readable.screenDirection, motionDirection: readable.motionDirection,
    } : null,
  };
}

export function compilePausedTimelines(input = {}) {
  const validation = validateMotionContract(input);
  if (!validation.valid) { const error = new Error('motion contract is invalid'); error.code = 'E_MOTION_CONTRACT'; error.diagnostics = validation.hardErrors; throw error; }
  const seed = input.motionMap.seed;
  const ownerByScene = Map.groupBy(input.motionMap.owners, ({ sceneId }) => sceneId);
  return {
    version: '1.0.0', seed, clock: 'paused-absolute-time', modes: ['composite', 'background-only', 'layer-matte:<layerId>', 'token-matte:<semanticToken>'],
    overlays: resolveDataOverlayDisplay(input.dataOverlays, input.normalizedActivityFacts ?? input.dataOverlays?.normalizedFacts ?? input.activity?.metrics ?? {}),
    scenes: input.sceneSchema.scenes.map((scene) => ({
      sceneId: scene.sceneId, intervals: structuredClone(scene.interval),
      layers: (ownerByScene.get(scene.sceneId) ?? []).map((owner) => ownerLayer(owner, scene, seed)).sort((left, right) => left.layerId.localeCompare(right.layerId)),
    })).sort((left, right) => left.sceneId.localeCompare(right.sceneId)),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

export function normalizeRuntimeOutput(output) { return canonical(structuredClone(output)); }

export { RELATIONSHIPS };
