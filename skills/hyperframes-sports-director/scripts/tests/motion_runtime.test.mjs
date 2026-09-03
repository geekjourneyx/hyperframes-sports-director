import assert from 'node:assert/strict';
import test from 'node:test';

import { installSceneRuntime } from '../../assets/hyperframes-project/src/scene-runtime.js';

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

const compiled = {
  clock: 'paused-absolute-time',
  scenes: [{
    sceneId: 'scene-climb',
    background: {
      backgroundId: 'background-climb', colorToken: 'color.background', assetId: 'asset-footage-climb',
      staticFallback: { kind: 'svg', viewBox: '0 0 1920 1080', shapes: [
        { type: 'path', d: 'M0 720 L560 480 L1120 690 L1920 360 L1920 1080 L0 1080 Z', colorToken: 'color.route' },
        { type: 'path', d: 'M0 820 L640 590 L1280 730 L1920 510', colorToken: 'color.primaryText', opacity: 0.25 },
      ] },
    },
    layers: [{
      ownerId: 'owner-title', layerId: 'layer-title', assetId: null, sceneId: 'scene-climb', primitive: 'css',
      staticFallback: 'svg-or-css', colorToken: 'color.primaryText', deterministicOffset: 0.25,
      timing: { entry: [0, 1], hold: [1, 3], exit: [3, 4] }, proofPasses: ['background-only', 'layer-matte:layer-title', 'token-matte:color.primaryText'],
      typographyRole: 'type.journeyTitle', evidenceFrameIds: ['frame-climb-01'],
      layoutEvidence: {
        textRect: [{ time: 1, x: 80, y: 90, width: 640, height: 120 }, { time: 3, x: 160, y: 90, width: 640, height: 120 }],
        subjectRect: [], quietZone: [], safetyRegions: [], horizonRelation: 'above', screenDirection: 'left-to-right', motionDirection: 'forward',
      },
    }, {
      ownerId: 'owner-route', layerId: 'layer-route', assetId: 'asset-route', sceneId: 'scene-climb', primitive: 'svg',
      staticFallback: { kind: 'asset-alpha-mask', path: 'M0 84 L180 12 L360 96 L520 26 L640 92 L640 120 L0 120 Z', viewBox: '0 0 640 120' },
      colorToken: 'color.route', deterministicOffset: 0.5,
      timing: { entry: [0, 1], hold: [1, 3], exit: [3, 4] }, proofPasses: ['background-only', 'layer-matte:layer-route', 'token-matte:color.route'],
      typographyRole: null, evidenceFrameIds: ['frame-climb-01'], layoutEvidence: null,
    }, {
      ownerId: 'owner-transition', layerId: 'layer-transition', assetId: null, sceneId: 'scene-climb', primitive: 'svg',
      staticFallback: { kind: 'shape', path: 'M0 0 L480 0 L240 160 Z', viewBox: '0 0 480 160' },
      colorToken: 'color.route', deterministicOffset: 0.75,
      timing: { entry: [3, 3.5], hold: [3.5, 4], exit: [4, 4.5] }, proofPasses: ['layer-matte:layer-transition'],
      typographyRole: null, evidenceFrameIds: ['frame-climb-04'], layoutEvidence: null,
      transition: { midpointSeconds: 3.75, nonEmpty: true },
    }],
  }],
};

test('runtime proof passes paint semantic, measurable coverage instead of empty layers', () => {
  const { document, stage } = runtimeDocument();
  const runtime = installSceneRuntime({ document }, compiled);

  const composite = runtime.__renderAt(2, 'composite');
  const compositeLayer = composite.layers[0];
  assert.deepEqual(compositeLayer.geometry, { x: 120, y: 90, width: 640, height: 120 });
  assert.equal(compositeLayer.paint.colorToken, 'color.primaryText');
  assert.equal(compositeLayer.paint.cssVariable, '--color-primaryText');
  assert.equal(stage.children.length, 3, 'background, text glyphs, and graphic coverage are rendered');
  assert.equal(stage.children[1].style.getPropertyValue('width'), '640px');
  assert.equal(stage.children[1].style.getPropertyValue('height'), '120px');
  assert.equal(stage.children[1].dataset.hfStaticFallback, 'svg-or-css');
  assert.equal(stage.children[1].children[0].tagName, 'svg');
  assert.equal(stage.children[1].children[0].children[0].tagName, 'text');
  assert.equal(stage.children[1].children[0].children[0].textContent, 'type.journeyTitle');
  assert.equal(stage.children[2].children[0].children[0].tagName, 'path', 'graphic fallback paints its declared alpha-mask path');

  const background = runtime.__renderAt(2, 'background-only');
  assert.deepEqual(background.layers, []);
  assert.equal(background.background.assetId, 'asset-footage-climb');
  assert.equal(stage.children.length, 1, 'background-only retains the same full-frame visual content');
  assert.equal(stage.children[0].style.getPropertyValue('background-color'), 'var(--color-background)');
  assert.equal(stage.children[0].style.getPropertyValue('width'), '100%');
  assert.equal(stage.children[0].style.getPropertyValue('height'), '100%');
  assert.equal(stage.children[0].children[0].tagName, 'svg');
  assert.equal(stage.children[0].children[0].children.length, 2, 'background fallback preserves two visual paths rather than a pure color plane');

  const layerMatte = runtime.__renderAt(2, 'layer-matte:layer-title');
  assert.deepEqual(layerMatte.layers[0].geometry, { x: 120, y: 90, width: 640, height: 120 });
  assert.equal(stage.children.length, 2, 'layer matte paints its coverage over the matte background');
  assert.equal(stage.children[1].dataset.hfMatte, 'layer');
  assert.equal(stage.children[0].style.getPropertyValue('background-color'), 'var(--hf-matte-background)');
  assert.equal(stage.children[1].children[0].children[0].getAttribute('fill'), 'var(--hf-matte-coverage)');
  assert.equal(stage.children[1].children[0].children[0].tagName, 'text', 'text matte is a glyph, not its text rectangle');

  const tokenMatte = runtime.__renderAt(2, 'token-matte:color.route');
  assert.equal(tokenMatte.layers[0].paint.colorToken, 'color.route');
  assert.equal(stage.children[1].dataset.hfMatte, 'token');
  assert.equal(stage.children[1].children[0].children[0].tagName, 'path', 'token matte uses graphic path coverage');
  assert.deepEqual(runtime.__layerEvidence['layer-title'].geometry, { x: 120, y: 90, width: 640, height: 120 });
  assert.equal(runtime.__layerEvidence['layer-route'].colorToken, tokenMatte.layers[0].paint.colorToken);
  assert.equal(runtime.__layerEvidence['layer-route'].coverage.kind, 'asset-alpha-mask');

  const transitionMatte = runtime.__renderAt(3.75, 'layer-matte:layer-transition');
  assert.equal(transitionMatte.layers.length, 1);
  assert.equal(stage.children[1].children[0].children[0].getAttribute('fill'), 'var(--hf-matte-coverage)');
  assert.equal(runtime.__layerEvidence['layer-transition'].coverage.nonEmpty, true);
});

test('runtime geometry is identical for repeated absolute-time proof renders', () => {
  const { document } = runtimeDocument();
  const runtime = installSceneRuntime({ document }, compiled);
  const first = runtime.__renderAt(2, 'token-matte:color.route');
  const second = runtime.__renderAt(2, 'token-matte:color.route');
  assert.deepEqual(second, first);
});

test('static background fallback remains visible when a compiled scene has no background descriptor', () => {
  const noBackground = structuredClone(compiled);
  delete noBackground.scenes[0].background;
  const { document, stage } = runtimeDocument();
  const runtime = installSceneRuntime({ document }, noBackground);

  runtime.__renderAt(2, 'composite');
  assert.equal(stage.children[0].children[0].children.length, 1, 'composite has deterministic fallback background content');
  runtime.__renderAt(2, 'background-only');
  assert.equal(stage.children[0].children[0].children.length, 1, 'background-only preserves that same fallback content');
});
