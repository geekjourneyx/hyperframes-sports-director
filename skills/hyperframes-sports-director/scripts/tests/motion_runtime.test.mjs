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
  }

  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
}

function runtimeDocument() {
  const stage = new Element('main');
  return {
    stage,
    document: {
      getElementById(id) { return id === 'hyperframes-stage' ? stage : null; },
      createElement(tagName) { return new Element(tagName); },
    },
  };
}

const compiled = {
  clock: 'paused-absolute-time',
  scenes: [{
    sceneId: 'scene-climb',
    layers: [{
      ownerId: 'owner-title', layerId: 'layer-title', assetId: null, sceneId: 'scene-climb', primitive: 'css',
      staticFallback: 'svg-or-css', colorToken: 'color.primaryText', deterministicOffset: 0.25,
      timing: { entry: [0, 1], hold: [1, 3], exit: [3, 4] }, proofPasses: ['background-only', 'layer-matte:layer-title', 'token-matte:color.primaryText'],
      typographyRole: 'type.journeyTitle', evidenceFrameIds: ['frame-climb-01'],
      layoutEvidence: {
        textRect: [{ time: 1, x: 80, y: 90, width: 640, height: 120 }, { time: 3, x: 160, y: 90, width: 640, height: 120 }],
        subjectRect: [], quietZone: [], safetyRegions: [], horizonRelation: 'above', screenDirection: 'left-to-right', motionDirection: 'forward',
      },
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
  assert.equal(stage.children.length, 2, 'background and one visible layer are rendered');
  assert.equal(stage.children[1].style.getPropertyValue('width'), '640px');
  assert.equal(stage.children[1].style.getPropertyValue('height'), '120px');
  assert.equal(stage.children[1].style.getPropertyValue('background-color'), 'var(--color-primaryText)');
  assert.equal(stage.children[1].dataset.hfStaticFallback, 'svg-or-css');

  const background = runtime.__renderAt(2, 'background-only');
  assert.deepEqual(background.layers, []);
  assert.equal(stage.children.length, 1, 'background-only retains a full-frame pixel plane');
  assert.equal(stage.children[0].style.getPropertyValue('background-color'), 'var(--color-background)');
  assert.equal(stage.children[0].style.getPropertyValue('width'), '100%');
  assert.equal(stage.children[0].style.getPropertyValue('height'), '100%');

  const layerMatte = runtime.__renderAt(2, 'layer-matte:layer-title');
  assert.deepEqual(layerMatte.layers[0].geometry, { x: 120, y: 90, width: 640, height: 120 });
  assert.equal(stage.children.length, 2, 'layer matte paints its coverage over the matte background');
  assert.equal(stage.children[1].dataset.hfMatte, 'layer');
  assert.equal(stage.children[1].style.getPropertyValue('background-color'), 'var(--color-primaryText)');

  const tokenMatte = runtime.__renderAt(2, 'token-matte:color.primaryText');
  assert.equal(tokenMatte.layers[0].paint.colorToken, 'color.primaryText');
  assert.equal(stage.children[1].dataset.hfMatte, 'token');
  assert.deepEqual(runtime.__layerEvidence['layer-title'].geometry, { x: 120, y: 90, width: 640, height: 120 });
  assert.equal(runtime.__layerEvidence['layer-title'].colorToken, tokenMatte.layers[0].paint.colorToken);
});

test('runtime geometry is identical for repeated absolute-time proof renders', () => {
  const { document } = runtimeDocument();
  const runtime = installSceneRuntime({ document }, compiled);
  const first = runtime.__renderAt(2, 'token-matte:color.primaryText');
  const second = runtime.__renderAt(2, 'token-matte:color.primaryText');
  assert.deepEqual(second, first);
});
