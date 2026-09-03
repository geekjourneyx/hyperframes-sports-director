const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

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
  return { x: 96 + Math.round(offset * 192), y: 96 + Math.round(offset * 108), width: 480, height: 160 };
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

function createSvgElement(document, name) {
  return document.createElementNS?.(SVG_NAMESPACE, name) ?? document.createElement(name);
}

function setAttributes(element, attributes) {
  for (const [name, value] of Object.entries(attributes)) if (value !== undefined && value !== null) element.setAttribute(name, String(value));
  return element;
}

function fallbackDescription(layer, geometry) {
  if (layer.staticFallback && typeof layer.staticFallback === 'object') return layer.staticFallback;
  return { kind: 'unavailable', viewBox: `0 0 ${geometry.width} ${geometry.height}` };
}

function fallbackHasCoverage(fallback) {
  if (fallback.kind === 'text' || fallback.kind === 'glyph') return typeof fallback.text === 'string' && fallback.text.length > 0;
  if (fallback.kind === 'source-frame') return typeof (fallback.path ?? fallback.source?.path) === 'string';
  if (Array.isArray(fallback.shapes)) return fallback.shapes.length > 0;
  return typeof fallback.path === 'string' && fallback.path.length > 0;
}

function coverageFor(layer, geometry) {
  const fallback = fallbackDescription(layer, geometry);
  return {
    kind: fallback.kind, nonEmpty: fallbackHasCoverage(fallback), source: 'static-fallback',
    geometry: structuredClone(geometry), path: fallback.path ?? null,
  };
}

function appendShape(document, svg, shape, defaultToken, fill) {
  const type = ['path', 'rect', 'circle'].includes(shape.type) ? shape.type : 'path';
  const element = createSvgElement(document, type);
  const token = shape.colorToken ?? defaultToken;
  const attributes = type === 'path'
    ? { d: shape.d ?? shape.path, fill }
    : type === 'rect'
      ? { x: shape.x ?? 0, y: shape.y ?? 0, width: shape.width, height: shape.height, fill }
      : { cx: shape.cx, cy: shape.cy, r: shape.r, fill };
  setAttributes(element, attributes);
  if (Number.isFinite(shape.opacity)) setAttributes(element, { 'fill-opacity': shape.opacity });
  if (!fill) setAttributes(element, { fill: `var(${cssVariableForToken(token)})` });
  svg.append(element);
}

function appendFallbackSvg(document, container, fallback, geometry, colorToken, fill) {
  const svg = setAttributes(createSvgElement(document, 'svg'), {
    width: '100%', height: '100%', viewBox: fallback.viewBox ?? `0 0 ${geometry.width} ${geometry.height}`,
    preserveAspectRatio: 'none', 'data-hf-static-fallback': fallback.kind ?? 'shape',
  });
  if (fallback.kind === 'text' || fallback.kind === 'glyph') {
    if (fallbackHasCoverage(fallback)) {
      const text = setAttributes(createSvgElement(document, 'text'), { x: 0, y: geometry.height * 0.75, fill });
      text.textContent = fallback.text;
      svg.append(text);
    }
  } else if (fallback.kind === 'source-frame') {
    const image = setAttributes(createSvgElement(document, 'image'), {
      href: fallback.path ?? fallback.source?.path, x: 0, y: 0, width: geometry.width, height: geometry.height,
    });
    svg.append(image);
  } else if (Array.isArray(fallback.shapes)) {
    for (const shape of fallback.shapes) appendShape(document, svg, shape, colorToken, fill);
  } else if (fallback.path) {
    appendShape(document, svg, { type: 'path', path: fallback.path }, colorToken, fill);
  }
  container.append(svg);
}

function activeBackground(compiled, activeLayers, time) {
  const activeSceneIds = new Set(activeLayers.map(({ sceneId }) => sceneId));
  const scene = compiled.scenes.find(({ sceneId }) => activeSceneIds.has(sceneId));
  const background = scene?.background ?? null;
  return {
    backgroundId: background?.backgroundId ?? scene?.sceneId ?? 'semantic-background',
    assetId: background?.assetId ?? null, source: structuredClone(background?.source ?? null), time,
    geometry: structuredClone(background?.geometry ?? { x: 0, y: 0, width: 1920, height: 1080 }),
    colorToken: background?.colorToken ?? 'color.background',
    staticFallback: structuredClone(background?.staticFallback ?? { kind: 'unavailable' }),
  };
}

function appendBackgroundPlane(target, stage, background, mode) {
  const plane = target.document.createElement('div');
  const matte = proofKind(mode);
  plane.dataset.hfKind = 'background';
  plane.dataset.hfColorToken = background.colorToken;
  plane.style.setProperty('left', '0');
  plane.style.setProperty('top', '0');
  plane.style.setProperty('width', '100%');
  plane.style.setProperty('height', '100%');
  plane.style.setProperty('background-color', matte ? 'var(--hf-matte-background)' : `var(${cssVariableForToken(background.colorToken)})`);
  if (!matte) appendFallbackSvg(target.document, plane, background.staticFallback, background.geometry, background.colorToken);
  stage.append(plane);
}

function appendLayerPlane(target, stage, layer, mode) {
  const element = target.document.createElement('div');
  const matte = proofKind(mode);
  element.dataset.hfLayer = layer.layerId;
  element.dataset.hfOwner = layer.ownerId;
  element.dataset.hfPrimitive = layer.primitive;
  element.dataset.hfColorToken = layer.colorToken;
  element.dataset.hfStaticFallback = typeof layer.staticFallback === 'string' ? layer.staticFallback : layer.staticFallback?.kind ?? 'unavailable';
  if (matte) element.dataset.hfMatte = matte;
  element.style.setProperty('left', `${layer.geometry.x}px`);
  element.style.setProperty('top', `${layer.geometry.y}px`);
  element.style.setProperty('width', `${layer.geometry.width}px`);
  element.style.setProperty('height', `${layer.geometry.height}px`);
  appendFallbackSvg(target.document, element, fallbackDescription(layer, layer.geometry), layer.geometry, layer.colorToken,
    matte ? 'var(--hf-matte-coverage)' : `var(${layer.paint.cssVariable})`);
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
    const background = activeBackground(compiled, active, time);
    const layers = renderModeLayers(active, mode).map((layer) => {
      const geometry = geometryAt(layer, time);
      return {
        layerId: layer.layerId, ownerId: layer.ownerId, primitive: layer.primitive, staticFallback: layer.staticFallback,
        colorToken: layer.colorToken, typographyRole: layer.typographyRole, deterministicOffset: layer.deterministicOffset, geometry,
        coverage: coverageFor(layer, geometry), paint: { colorToken: layer.colorToken, cssVariable: cssVariableForToken(layer.colorToken) },
      };
    });
    for (const layer of layers) {
      target.__layerEvidence[layer.layerId].geometry = structuredClone(layer.geometry);
      target.__layerEvidence[layer.layerId].coverage = structuredClone(layer.coverage);
    }
    const stage = target.document?.getElementById?.('hyperframes-stage');
    if (stage) {
      stage.replaceChildren();
      stage.dataset.hfMode = mode;
      stage.dataset.hfTime = String(time);
      appendBackgroundPlane(target, stage, background, mode);
      for (const layer of layers) appendLayerPlane(target, stage, layer, mode);
    }
    return { clock: 'paused-absolute-time', time, mode, background, layers };
  };
  return target;
}
