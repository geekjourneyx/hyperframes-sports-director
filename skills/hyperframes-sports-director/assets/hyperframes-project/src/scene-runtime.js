function activeAt(layer, time) {
  const intervals = Object.values(layer.timing ?? {});
  return intervals.some(([start, end]) => time >= start && time <= end);
}

function renderModeLayers(layers, mode) {
  if (mode === 'composite') return layers;
  if (mode === 'background-only') return [];
  if (mode.startsWith('layer-matte:')) return layers.filter(({ layerId }) => layerId === mode.slice('layer-matte:'.length));
  if (mode.startsWith('token-matte:')) return layers.filter(({ colorToken }) => colorToken === mode.slice('token-matte:'.length));
  throw new TypeError(`unsupported render mode: ${mode}`);
}

function rectangleAt(track, time) {
  const points = [...(track ?? [])].sort((left, right) => left.time - right.time);
  if (points.length === 0) return null;
  if (time <= points[0].time) return { x: points[0].x, y: points[0].y, width: points[0].width, height: points[0].height };
  if (time >= points.at(-1).time) return { x: points.at(-1).x, y: points.at(-1).y, width: points.at(-1).width, height: points.at(-1).height };
  const endIndex = points.findIndex((point) => point.time >= time);
  const start = points[endIndex - 1];
  const end = points[endIndex];
  const progress = (time - start.time) / (end.time - start.time);
  return Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number((start[key] + ((end[key] - start[key]) * progress)).toFixed(6))]));
}

function fallbackRectangle(layer) {
  const offset = Number.isFinite(layer.deterministicOffset) ? layer.deterministicOffset : 0;
  return {
    x: 96 + Math.round(offset * 192), y: 96 + Math.round(offset * 108),
    width: 480, height: 160,
  };
}

function geometryAt(layer, time) {
  return rectangleAt(layer.layoutEvidence?.textRect, time) ?? fallbackRectangle(layer);
}

function cssVariableForToken(colorToken) {
  if (!/^color\.[a-z][A-Za-z0-9]*$/.test(colorToken ?? '')) throw new TypeError(`invalid semantic color token: ${colorToken}`);
  return `--color-${colorToken.slice('color.'.length)}`;
}

function proofKind(mode) {
  if (mode.startsWith('layer-matte:')) return 'layer';
  if (mode.startsWith('token-matte:')) return 'token';
  return null;
}

function appendBackgroundPlane(target, stage) {
  const background = target.document.createElement('div');
  background.dataset.hfKind = 'background';
  background.dataset.hfColorToken = 'color.background';
  background.style.setProperty('left', '0');
  background.style.setProperty('top', '0');
  background.style.setProperty('width', '100%');
  background.style.setProperty('height', '100%');
  background.style.setProperty('background-color', 'var(--color-background)');
  stage.append(background);
}

function appendLayerPlane(target, stage, layer, mode) {
  const element = target.document.createElement('div');
  const { geometry, paint } = layer;
  const matte = proofKind(mode);
  element.dataset.hfLayer = layer.layerId;
  element.dataset.hfOwner = layer.ownerId;
  element.dataset.hfPrimitive = layer.primitive;
  element.dataset.hfColorToken = layer.colorToken;
  element.dataset.hfStaticFallback = layer.staticFallback;
  if (matte) element.dataset.hfMatte = matte;
  element.style.setProperty('left', `${geometry.x}px`);
  element.style.setProperty('top', `${geometry.y}px`);
  element.style.setProperty('width', `${geometry.width}px`);
  element.style.setProperty('height', `${geometry.height}px`);
  element.style.setProperty('background-color', `var(${paint.cssVariable})`);
  stage.append(element);
}

export function installSceneRuntime(target, compiled) {
  if (!target || !compiled || compiled.clock !== 'paused-absolute-time') throw new TypeError('paused compiled timelines are required');
  target.__timelines = structuredClone(compiled.scenes);
  target.__layerEvidence = Object.fromEntries(compiled.scenes.flatMap(({ layers }) => layers.map((layer) => [layer.layerId, {
    ownerId: layer.ownerId, assetId: layer.assetId, sceneId: layer.sceneId, colorToken: layer.colorToken,
    typographyRole: layer.typographyRole, evidenceFrameIds: [...layer.evidenceFrameIds], proofPasses: [...layer.proofPasses],
    layoutEvidence: structuredClone(layer.layoutEvidence), timing: structuredClone(layer.timing), transition: structuredClone(layer.transition),
  }])));
  target.__renderAt = (time, mode = 'composite') => {
    if (!Number.isFinite(time) || time < 0) throw new TypeError('render time must be a non-negative absolute time');
    const active = compiled.scenes.flatMap(({ layers }) => layers).filter((layer) => activeAt(layer, time));
    const layers = renderModeLayers(active, mode).map((layer) => ({
      layerId: layer.layerId, ownerId: layer.ownerId, primitive: layer.primitive, staticFallback: layer.staticFallback,
      colorToken: layer.colorToken, deterministicOffset: layer.deterministicOffset, geometry: geometryAt(layer, time),
      paint: { colorToken: layer.colorToken, cssVariable: cssVariableForToken(layer.colorToken) },
    }));
    for (const layer of layers) target.__layerEvidence[layer.layerId].geometry = structuredClone(layer.geometry);
    const stage = target.document?.getElementById?.('hyperframes-stage');
    if (stage) {
      stage.replaceChildren();
      stage.dataset.hfMode = mode;
      stage.dataset.hfTime = String(time);
      appendBackgroundPlane(target, stage);
      for (const layer of layers) appendLayerPlane(target, stage, layer, mode);
    }
    return { clock: 'paused-absolute-time', time, mode, layers };
  };
  return target;
}
