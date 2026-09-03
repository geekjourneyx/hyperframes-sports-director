import assert from 'node:assert/strict';
import test from 'node:test';

import { compilePausedTimelines } from '../lib/motion.mjs';
import { installSceneRuntime } from '../../assets/hyperframes-project/src/scene-runtime.js';

const digest = (character) => character.repeat(64);

class StyleDeclaration {
  #values = new Map();

  setProperty(name, value) { this.#values.set(name, String(value)); }
  getPropertyValue(name) { return this.#values.get(name) ?? ''; }
}

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.dataset = {};
    this.style = new StyleDeclaration();
    this.children = [];
    this.attributes = new Map();
    this.textContent = '';
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
}

function runtimeDocument() {
  const stage = new Element('main');
  return {
    stage,
    document: {
      getElementById(id) { return id === 'hyperframes-stage' ? stage : null; },
      createElement(tagName) { return new Element(tagName); },
      createElementNS(_namespace, tagName) { return new Element(tagName); },
    },
  };
}

function renderedLayer(stage, layerId) {
  return stage.children.find((element) => element.dataset.hfLayer === layerId);
}

function productionInput() {
  const designDigest = digest('a');
  const lookDigest = digest('b');
  const assetDigest = digest('c');
  const sceneDigest = digest('d');
  const motionDigest = digest('e');
  const overlayDigest = digest('f');
  return {
    designSystem: { status: 'frozen', designRevision: 'design-1', integrity: { digest: designDigest } },
    lookProfile: { status: 'frozen', lookRevision: 'look-1', integrity: { digest: lookDigest } },
    assetManifest: {
      status: 'frozen', designRevision: 'design-1', lookRevision: 'look-1', assetRevision: 'assets-1', integrity: { digest: assetDigest },
      acceptance: { anchorDigest: digest('1'), representativeDigest: digest('2'), batches: [{ digest: digest('3') }] },
      assets: [{
        id: 'asset-route', narrativeRole: 'journey_anchor', colorToken: 'color.route', sourceKind: 'component-crop',
        source: 'assets/components/route-mask.svg', alphaBounds: { left: 16, top: 12, width: 608, height: 96 },
        expectedDisplayRect: { width: 640, height: 120 }, nativeEffectivePixels: { width: 640, height: 120 },
        staticFallback: { kind: 'asset-alpha-mask', path: 'M16 84 L180 12 L360 96 L520 26 L624 92 L624 108 L16 108 Z', viewBox: '0 0 640 120' },
      }],
    },
    sceneSchema: {
      status: 'frozen', designRevision: 'design-1', lookRevision: 'look-1', integrity: { digest: sceneDigest },
      designSystemDigest: designDigest, lookProfileDigest: lookDigest,
      scenes: [{
        sceneId: 'scene-climb', role: 'journey', colorTokens: ['color.primaryText', 'color.route'], shotIds: ['shot-climb'],
        interval: { entry: [0, 0.5], hold: [0.5, 3.6], exit: [3.6, 4] },
        background: {
          backgroundId: 'background-climb', colorToken: 'color.background', assetId: 'media-climb',
          source: { path: 'review/frames/climb-0024.png', digest: digest('4') }, geometry: { x: 0, y: 0, width: 1920, height: 1080 },
          staticFallback: { kind: 'source-frame', path: 'review/frames/climb-0024.png', digest: digest('4'), viewBox: '0 0 1920 1080' },
        },
        readableLayers: [{
          layerId: 'layer-title', ownerId: 'owner-title', readableInterval: [0, 4], typographyRole: 'type.journeyTitle',
          textRect: [{ time: 0, x: 80, y: 90, width: 640, height: 120 }, { time: 4, x: 160, y: 90, width: 640, height: 120 }],
          subjectRect: [{ time: 0, x: 1200, y: 400, width: 500, height: 900 }, { time: 4, x: 1200, y: 400, width: 500, height: 900 }], quietZone: [{ time: 0, x: 40, y: 40, width: 820, height: 200 }, { time: 4, x: 40, y: 40, width: 820, height: 200 }],
          safetyRegions: [], horizonRelation: 'above', screenDirection: 'left-to-right', motionDirection: 'forward', evidenceFrameIds: ['frame-climb-01'],
          staticFallback: { kind: 'glyph', text: 'SUMMIT APPROACH', viewBox: '0 0 640 120' },
        }],
      }],
    },
    motionMap: {
      status: 'frozen', motionRevision: 'motion-1', designRevision: 'design-1', assetRevision: 'assets-1', integrity: { digest: motionDigest }, seed: 'runtime-seed',
      designSystemDigest: designDigest, assetManifestDigest: assetDigest, sceneSchemaDigest: sceneDigest,
      owners: [
        { ownerId: 'owner-route', layerId: 'layer-route', assetId: 'asset-route', sceneId: 'scene-climb', primitive: 'svg', entryFrames: 15, holdFrames: 93, exitFrames: 12, colorToken: 'color.route', timing: { entry: [0, 0.5], hold: [0.5, 3.6], exit: [3.6, 4] }, proofPasses: ['background-only', 'layer-matte:layer-route', 'token-matte:color.route'] },
        { ownerId: 'owner-title', layerId: 'layer-title', assetId: null, sceneId: 'scene-climb', primitive: 'css', entryFrames: 15, holdFrames: 93, exitFrames: 12, colorToken: 'color.primaryText', timing: { entry: [0, 0.5], hold: [0.5, 3.6], exit: [3.6, 4] }, proofPasses: ['background-only', 'layer-matte:layer-title', 'token-matte:color.primaryText'] },
        { ownerId: 'owner-transition', layerId: 'layer-transition', assetId: null, sceneId: 'scene-climb', primitive: 'svg', entryFrames: 6, holdFrames: 1, exitFrames: 6, colorToken: 'color.route', timing: { entry: [3.7, 3.9], hold: [3.9, 3.94], exit: [3.94, 4.14] }, proofPasses: ['layer-matte:layer-transition'], transition: { relationship: 'motion-match', midpointSeconds: 3.92, nonEmpty: true, designReason: 'continues forward footage direction' }, staticFallback: { kind: 'shape', path: 'M0 0 L480 0 L240 160 Z', viewBox: '0 0 480 160' } },
      ],
    },
    dataOverlays: { status: 'unavailable', integrity: { digest: overlayDigest }, normalizedFacts: {}, overlays: [] },
    timeline: {
      phase: 'final', designRevision: 'design-1', lookRevision: 'look-1', assetRevision: 'assets-1', motionRevision: 'motion-1',
      assetManifestDigest: assetDigest, motionMapDigest: motionDigest, dataOverlaysDigest: overlayDigest,
      items: [{ itemId: 'item-climb', destinationInSeconds: 0, destinationOutSeconds: 4, assetReferences: ['asset-route'], motionReferences: ['owner-route', 'owner-title', 'owner-transition'], transition: { kind: 'motion-match', ownerId: 'owner-transition' } }],
    },
  };
}

test('production compiler retains declared background, glyph, shape, and alpha-mask fallbacks', () => {
  const compiled = compilePausedTimelines(productionInput());
  const scene = compiled.scenes[0];
  assert.equal(scene.background.source.path, 'review/frames/climb-0024.png');
  assert.equal(scene.background.geometry.width, 1920);
  assert.deepEqual(scene.layers.find(({ layerId }) => layerId === 'layer-title').staticFallback, { kind: 'glyph', text: 'SUMMIT APPROACH', viewBox: '0 0 640 120' });
  assert.equal(scene.layers.find(({ layerId }) => layerId === 'layer-route').staticFallback.kind, 'asset-alpha-mask');
  assert.equal(scene.layers.find(({ layerId }) => layerId === 'layer-route').source.path, 'assets/components/route-mask.svg');
  assert.equal(scene.layers.find(({ layerId }) => layerId === 'layer-transition').staticFallback.path, 'M0 0 L480 0 L240 160 Z');
});

test('production-compiled runtime reuses source background and exact coverage at one absolute time', () => {
  const { document, stage } = runtimeDocument();
  const runtime = installSceneRuntime({ document }, compilePausedTimelines(productionInput()));
  const composite = runtime.__renderAt(2, 'composite');
  const title = composite.layers.find(({ layerId }) => layerId === 'layer-title');
  const route = composite.layers.find(({ layerId }) => layerId === 'layer-route');
  assert.equal(composite.background.source.path, 'review/frames/climb-0024.png');
  assert.equal(stage.children[0].children[0].children[0].tagName, 'image');
  assert.equal(stage.children[0].children[0].children[0].getAttribute('href'), 'review/frames/climb-0024.png');
  assert.deepEqual(title.geometry, { x: 120, y: 90, width: 640, height: 120 });
  assert.equal(renderedLayer(stage, 'layer-title').children[0].children[0].textContent, 'SUMMIT APPROACH');
  assert.equal(renderedLayer(stage, 'layer-route').children[0].children[0].getAttribute('d'), 'M16 84 L180 12 L360 96 L520 26 L624 92 L624 108 L16 108 Z');
  assert.equal(route.coverage.kind, 'asset-alpha-mask');

  const background = runtime.__renderAt(2, 'background-only');
  assert.deepEqual(background.background, composite.background);
  assert.equal(stage.children[0].children[0].children[0].getAttribute('href'), 'review/frames/climb-0024.png');

  runtime.__renderAt(2, 'token-matte:color.route');
  assert.equal(stage.children[0].style.getPropertyValue('background-color'), 'var(--hf-matte-background)');
  assert.equal(renderedLayer(stage, 'layer-route').children[0].children[0].getAttribute('fill'), 'var(--hf-matte-coverage)');
  assert.equal(renderedLayer(stage, 'layer-route').children[0].children[0].getAttribute('d'), 'M16 84 L180 12 L360 96 L520 26 L624 92 L624 108 L16 108 Z');
  assert.equal(runtime.__layerEvidence['layer-route'].coverage.path, 'M16 84 L180 12 L360 96 L520 26 L624 92 L624 108 L16 108 Z');

  runtime.__renderAt(3.92, 'layer-matte:layer-transition');
  assert.equal(renderedLayer(stage, 'layer-transition').children[0].children[0].getAttribute('d'), 'M0 0 L480 0 L240 160 Z');
  assert.equal(runtime.__layerEvidence['layer-transition'].coverage.nonEmpty, true);
});

test('production-compiled runtime does not fabricate glyph coverage when the declared text is absent', () => {
  const input = productionInput();
  delete input.sceneSchema.scenes[0].readableLayers[0].staticFallback.text;
  const { document, stage } = runtimeDocument();
  const runtime = installSceneRuntime({ document }, compilePausedTimelines(input));

  runtime.__renderAt(2, 'composite');
  assert.equal(renderedLayer(stage, 'layer-title').children[0].children.length, 0);
  assert.equal(runtime.__layerEvidence['layer-title'].coverage.nonEmpty, false);
});
