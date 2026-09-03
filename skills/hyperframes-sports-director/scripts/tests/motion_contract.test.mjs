import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { validateDesignConsistency } from '../validate_design_consistency.mjs';
import { validateColorPipeline } from '../validate_color_pipeline.mjs';
import { validateContrast } from '../validate_contrast.mjs';
import { validateDesignSystem } from '../validate_design_system.mjs';
import { compilePausedTimelines, normalizeRuntimeOutput, resolveDataOverlayDisplay, validateMotionContract } from '../lib/motion.mjs';
import { loadSchema, validateDocument } from '../lib/contracts.mjs';
import { commitMotionCompositionState } from '../lib/project-state.mjs';
import { validateSceneLayout } from '../lib/layout.mjs';
import { installSceneRuntime } from '../../assets/hyperframes-project/src/scene-runtime.js';

const digest = (character) => character.repeat(64);

function fixture() {
  const designSystem = {
    status: 'frozen', designRevision: 'design-2', integrity: { digest: digest('a') },
    tokens: {
      colors: { 'color.background': '#050505', 'color.primaryText': '#F5F2EA', 'color.route': '#C9A86A' },
      typography: { 'type.journeyTitle': { family: 'Inter', size: 96, weight: 700, lineHeight: 1 } },
      spacing: { 'space.titleInset': 64 }, safeZones: { 'safe.title': 0.08 }, strokes: { 'stroke.route': 4 },
      radii: { 'radius.panel': 18 }, depth: { 'depth.title': 2 },
      motion: { 'duration.entry': 0.5, 'duration.exit': 0.4 }, easing: { 'easing.standard': 'cubic-out' },
      contrast: { criticalTextTarget: 7, textMinimum: 4.5, meaningfulGraphicMinimum: 3 },
      redundantEncodings: { route: 'label-boundary-pattern', grade: 'label-symbol-pattern', status: 'label-symbol-boundary' },
    },
  };
  const lookProfile = {
    status: 'frozen', lookRevision: 'look-2', integrity: { digest: digest('b') },
    input: { interpretation: 'source-metadata' }, working: { colorSpace: 'linear-rec709' }, output: { colorSpace: 'rec709-sdr' },
  };
  const assetManifest = {
    status: 'frozen', designRevision: 'design-2', lookRevision: 'look-2', assetRevision: 'assets-3', integrity: { digest: digest('c') },
    acceptance: { anchorDigest: digest('d'), representativeDigest: digest('e'), batches: [{ digest: digest('f') }] },
    assets: [{ id: 'asset-route', narrativeRole: 'journey_anchor', colorToken: 'color.route', expectedDisplayRect: { width: 800, height: 400 }, nativeEffectivePixels: { width: 800, height: 400 } }],
  };
  const sceneSchema = {
    status: 'frozen', designRevision: 'design-2', lookRevision: 'look-2', integrity: { digest: digest('1') },
    designSystemDigest: digest('a'), lookProfileDigest: digest('b'),
    scenes: [{
      sceneId: 'scene-climb', role: 'journey', colorTokens: ['color.primaryText', 'color.route'], shotIds: ['shot-climb'],
      interval: { entry: [0, 0.5], hold: [0.5, 3.6], exit: [3.6, 4] },
      readableLayers: [{
        layerId: 'layer-title', ownerId: 'owner-title', readableInterval: [0, 4], typographyRole: 'type.journeyTitle',
        textRect: [{ time: 0, x: 80, y: 80, width: 700, height: 120 }, { time: 4, x: 80, y: 80, width: 700, height: 120 }],
        subjectRect: [{ time: 0, x: 1200, y: 400, width: 500, height: 900 }, { time: 4, x: 1200, y: 400, width: 500, height: 900 }],
        quietZone: [{ time: 0, x: 40, y: 40, width: 820, height: 200 }, { time: 4, x: 40, y: 40, width: 820, height: 200 }],
        safetyRegions: [{ kind: 'road', rect: { x: 1080, y: 300, width: 840, height: 780 } }],
        horizonRelation: 'above', screenDirection: 'left-to-right', motionDirection: 'forward', evidenceFrameIds: ['frame-climb-01'],
      }],
    }],
  };
  const motionMap = {
    status: 'frozen', motionRevision: 'motion-4', designRevision: 'design-2', assetRevision: 'assets-3', integrity: { digest: digest('2') }, seed: 'project-seed',
    designSystemDigest: digest('a'), assetManifestDigest: digest('c'), sceneSchemaDigest: digest('1'),
    owners: [
      { ownerId: 'owner-route', layerId: 'layer-route', assetId: 'asset-route', sceneId: 'scene-climb', primitive: 'svg', entryFrames: 15, holdFrames: 93, exitFrames: 12, colorToken: 'color.route', timing: { entry: [0, 0.5], hold: [0.5, 3.6], exit: [3.6, 4] }, proofPasses: ['background-only', 'layer-matte:layer-route', 'token-matte:color.route'] },
      { ownerId: 'owner-title', layerId: 'layer-title', assetId: null, sceneId: 'scene-climb', primitive: 'css', entryFrames: 15, holdFrames: 93, exitFrames: 12, colorToken: 'color.primaryText', timing: { entry: [0, 0.5], hold: [0.5, 3.6], exit: [3.6, 4] }, proofPasses: ['background-only', 'layer-matte:layer-title', 'token-matte:color.primaryText'] },
      { ownerId: 'owner-transition', layerId: 'layer-transition', assetId: null, sceneId: 'scene-climb', primitive: 'svg', entryFrames: 6, holdFrames: 1, exitFrames: 6, colorToken: 'color.route', timing: { entry: [3.7, 3.9], hold: [3.9, 3.94], exit: [3.94, 4.14] }, proofPasses: ['layer-matte:layer-transition'], transition: { relationship: 'motion-match', midpointSeconds: 3.92, nonEmpty: true, designReason: 'continues forward footage direction' } },
    ],
  };
  const dataOverlays = {
    status: 'available', integrity: { digest: digest('3') },
    normalizedFacts: { 'metrics.elevationGain': { value: 428, unit: 'm' } },
    activityDigest: digest('4'), syncMapDigest: digest('5'), publicRoute: { status: 'unavailable', trimmedRouteId: null },
    overlays: [{ overlayId: 'overlay-elevation-gain', metricId: 'metrics.elevationGain', displayAuthority: 'whole-activity', syncAuthority: 'whole-activity', wording: '428 m climbed', colorToken: 'color.route', destinationInSeconds: 0.5, destinationOutSeconds: 3.5 }],
  };
  const timeline = {
    phase: 'final', designRevision: 'design-2', lookRevision: 'look-2', assetRevision: 'assets-3', motionRevision: 'motion-4',
    assetManifestDigest: digest('c'), motionMapDigest: digest('2'), dataOverlaysDigest: digest('3'),
    items: [{ itemId: 'item-climb', destinationInSeconds: 0, destinationOutSeconds: 4, assetReferences: ['asset-route'], motionReferences: ['owner-route', 'owner-title', 'owner-transition'], transition: { kind: 'motion-match', ownerId: 'owner-transition' } }],
  };
  const activity = { status: 'available', integrity: { digest: digest('4') }, metrics: { elevationGain: { value: 428, unit: 'm' } }, coverage: { elevationGain: 0.9 }, route: { status: 'unavailable', trimmedRouteId: null, pointCount: 0, points: [] } };
  const syncMap = { status: 'unavailable', integrity: { digest: digest('5') }, validInterval: null };
  dataOverlays.integrity.upstream = { activity: digest('4'), syncMap: digest('5') };
  const renderedTokenSamples = [{ token: 'color.route', deltaE2000: 0.8, alpha: 1 }];
  const colorVisionProofs = ['protanopia', 'deuteranopia'].map((simulation) => ({ simulation, semantic: 'route', contrastRatio: 3.2, encodings: ['label', 'boundary'] }));
  const contrastLayers = [{ layerId: 'layer-title', kind: 'critical-text', readableInterval: [0, 4], samples: Array.from({ length: 41 }, (_, index) => ({ time: index / 10, ratio: 7.2, hasBackgroundPass: true, hasCoverageMatte: true })) }];
  return { designSystem, lookProfile, assetManifest, sceneSchema, motionMap, dataOverlays, timeline, activity, syncMap, primaryMetricIds: ['elevationGain'], renderedTokenSamples, colorVisionProofs, contrastLayers };
}

test('motion ownership, absolute timing, layout evidence, and output bytes are deterministic', () => {
  const input = fixture();
  const validated = validateMotionContract(input);
  assert.equal(validated.valid, true, JSON.stringify(validated.hardErrors));
  assert.equal(validateSceneLayout(input).valid, true);
  const first = normalizeRuntimeOutput(compilePausedTimelines(input));
  const second = normalizeRuntimeOutput(compilePausedTimelines(input));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.scenes[0].intervals, { entry: [0, 0.5], hold: [0.5, 3.6], exit: [3.6, 4] });
});

test('paused browser runtime renders supplied time and deterministic proof modes only', () => {
  const input = fixture();
  const runtime = installSceneRuntime({}, compilePausedTimelines(input));
  assert.equal(runtime.__timelines.length, 1);
  assert.equal(runtime.__renderAt(1.25, 'background-only').time, 1.25);
  assert.equal(runtime.__renderAt(1.25, 'token-matte:color.route').mode, 'token-matte:color.route');
  assert.equal(runtime.__renderAt(1.25, 'layer-matte:layer-title').layers[0].layerId, 'layer-title');
  assert.ok(runtime.__layerEvidence['layer-title'].evidenceFrameIds.includes('frame-climb-01'));
  assert.throws(() => runtime.__renderAt(1, 'unknown'), /render mode/i);
});

test('hard validators reject ownership, timing, authority, token, layout, raster, color, and contrast defects', () => {
  const base = fixture();
  const broken = structuredClone(base);
  broken.motionMap.owners.push(structuredClone(broken.motionMap.owners[0]));
  broken.sceneSchema.scenes[0].readableLayers[0].textRect[1].x = 1250;
  broken.sceneSchema.scenes[0].readableLayers[0].textRect[1].y = 450;
  broken.motionMap.owners[1].colorToken = 'color.missing';
  broken.assetManifest.assets[0].expectedDisplayRect.width = 1200;
  broken.dataOverlays.overlays[0].metricId = 'metrics.unrecordedPower';
  const result = validateDesignConsistency(broken);
  for (const code of ['E_MOTION_OWNER_COUNT', 'E_LAYOUT_COLLISION', 'E_TOKEN_UNRESOLVED', 'E_RASTER_BUDGET', 'E_OVERLAY_FACT_AUTHORITY']) {
    assert.ok(result.hardErrors.some((finding) => finding.code === code), code);
  }
  assert.deepEqual(result.agentReviewRequired.map(({ category }) => category).sort(), ['cross-scene-taste', 'pacing', 'restraint', 'visual-density']);
  assert.equal(validateDesignConsistency(base).valid, true);
  const missingRasterEvidence = structuredClone(base);
  delete missingRasterEvidence.assetManifest.assets[0].nativeEffectivePixels;
  assert.ok(validateDesignConsistency(missingRasterEvidence).hardErrors.some(({ code }) => code === 'E_RASTER_BUDGET'));
  const noRenderedEvidence = validateDesignConsistency({ ...base, renderedTokenSamples: [], colorVisionProofs: [], contrastLayers: [] });
  for (const code of ['E_COLOR_PROOF_INPUT', 'E_COLOR_VISION_MEANING', 'E_CONTRAST_INPUT']) {
    assert.ok(noRenderedEvidence.hardErrors.some((finding) => finding.code === code), code);
  }

  const forgedAuthority = structuredClone(base);
  forgedAuthority.dataOverlays.overlays[0].displayAuthority = 'local-observation';
  assert.ok(validateMotionContract(forgedAuthority).hardErrors.some(({ code }) => code === 'E_OVERLAY_DISPLAY_AUTHORITY'));

  assert.equal(validateDesignSystem({ ...base, designSystem: { ...base.designSystem, status: 'draft' } }).valid, false);
  assert.equal(validateColorPipeline({ ...base, colorVisionProofs: [{ simulation: 'protanopia', semantic: 'route', contrastRatio: 2.9, encodings: ['hue'] }] }).valid, false);
  assert.equal(validateContrast({ layers: [{ layerId: 'critical', kind: 'critical-text', readableInterval: [0, 1], samples: [{ time: 0, ratio: 4.4, hasBackgroundPass: true, hasCoverageMatte: true }] }] }).valid, false);
});

test('runtime source contains no autonomous or nondeterministic render clock', async () => {
  const paths = ['../../assets/hyperframes-project/src/scene-runtime.js', '../../assets/hyperframes-project/src/main.js'];
  const source = (await Promise.all(paths.map((path) => readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
  for (const forbidden of ['Date.now', 'Math.random', 'setTimeout', 'setInterval', 'requestAnimationFrame']) assert.equal(source.includes(forbidden), false, forbidden);
});

test('data display reads normalized facts without recalculation and motion gate keeps Agent review pending', () => {
  const input = fixture();
  assert.deepEqual(resolveDataOverlayDisplay(input.dataOverlays, input.dataOverlays.normalizedFacts), [{
    overlayId: 'overlay-elevation-gain', metricId: 'metrics.elevationGain', value: 428, unit: 'm', wording: '428 m climbed',
    displayAuthority: 'whole-activity', syncAuthority: 'whole-activity', colorToken: 'color.route', interval: [0.5, 3.5],
  }]);
  const state = { state: 'ASSET_PRODUCTION', revision: 9, stateEnteredAt: '2026-09-01T12:00:00.000Z', previousState: 'STYLE_ANCHOR', transitions: [], gateEvidence: [], invalidations: [], assetAcceptance: {}, integrity: { digest: null, upstream: {} } };
  const artifacts = Object.fromEntries(['SCENE_SCHEMA', 'MOTION_MAP', 'TIMELINE', 'DESIGN_CONSISTENCY'].map((role, index) => [role, { revision: index + 1, digest: digest(String(index + 4)) }]));
  const next = commitMotionCompositionState(state, artifacts, { timestamp: '2026-09-01T12:30:00.000Z', producerCommand: 'validate_design_consistency.mjs' });
  assert.equal(next.state, 'MOTION_COMPOSITION');
  assert.deepEqual(next.gateEvidence.map(({ role }) => role).sort(), Object.keys(artifacts).sort());
});

test('available composition schemas require current authority bindings', async () => {
  const motion = { $schema: 'https://hyperframes.local/schemas/motion-map.schema.json', schemaVersion: '1.0.0', revision: 1,
    motionRevision: 'motion-1', status: 'available', designRevision: 'design-1', assetRevision: 'assets-1', owners: [], integrity: { digest: null, upstream: {} } };
  const scene = { $schema: 'https://hyperframes.local/schemas/scene-schema.schema.json', schemaVersion: '1.0.0', revision: 1,
    status: 'available', designRevision: 'design-1', lookRevision: 'look-1', scenes: [], integrity: { digest: null, upstream: {} } };
  assert.equal(validateDocument(await loadSchema('motion-map'), motion).valid, false);
  assert.equal(validateDocument(await loadSchema('scene-schema'), scene).valid, false);
});

test('layout and contrast evidence cover the entire readable motion window at 10Hz', () => {
  const input = fixture();
  const layer = input.sceneSchema.scenes[0].readableLayers[0];
  layer.readableInterval = [0, 4];
  layer.textRect = [{ time: 0, x: 0, y: 80, width: 300, height: 120 }, { time: 4, x: 1000, y: 80, width: 300, height: 120 }];
  layer.subjectRect = [{ time: 0, x: 600, y: 80, width: 100, height: 120 }, { time: 4, x: 600, y: 80, width: 100, height: 120 }];
  layer.quietZone = [{ time: 0, x: 0, y: 40, width: 1400, height: 200 }, { time: 4, x: 0, y: 40, width: 1400, height: 200 }];
  assert.ok(validateSceneLayout(input).hardErrors.some(({ code, time }) => code === 'E_LAYOUT_COLLISION' && time > 1 && time < 4));
  const sparse = [{ layerId: 'layer-title', kind: 'critical-text', readableInterval: [0, 1], samples: [
    { time: 0, ratio: 7, hasBackgroundPass: true, hasCoverageMatte: true }, { time: 1, ratio: 7, hasBackgroundPass: true, hasCoverageMatte: true },
  ] }];
  assert.ok(validateContrast({ layers: sparse, sceneSchema: input.sceneSchema, motionMap: input.motionMap }).hardErrors.some(({ code }) => code === 'E_CONTRAST_COVERAGE'));
});

test('overlay wording and semantic token references are deterministic and group-typed', () => {
  const input = fixture();
  input.dataOverlays.overlays[0].wording = 'Record-breaking mountain conquest';
  assert.ok(validateMotionContract(input).hardErrors.some(({ code }) => code === 'E_OVERLAY_WORDING'));
  const wrongGroup = fixture();
  wrongGroup.motionMap.owners[0].colorToken = 'type.journeyTitle';
  assert.ok(validateDesignSystem(wrongGroup).hardErrors.some(({ code }) => code === 'E_TOKEN_UNRESOLVED'));
});
