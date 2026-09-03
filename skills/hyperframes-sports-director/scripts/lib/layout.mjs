function finding(code, path, message, details = {}) {
  return { code, classification: 'hard_error', category: 'bounds', path, message, ...details };
}
export function rectanglesIntersect(left, right) {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

export function rectangleContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

export function sampleTrackedRect(track, time) {
  if (!Array.isArray(track) || track.length === 0) return null;
  const sorted = [...track].sort((left, right) => left.time - right.time);
  if (time <= sorted[0].time) return { ...sorted[0] };
  if (time >= sorted.at(-1).time) return { ...sorted.at(-1) };
  const rightIndex = sorted.findIndex((point) => point.time >= time);
  const left = sorted[rightIndex - 1];
  const right = sorted[rightIndex];
  const progress = (time - left.time) / (right.time - left.time);
  return Object.fromEntries(Object.keys(left).map((key) => [key,
    key === 'time' ? time : Number.isFinite(left[key]) && Number.isFinite(right[key])
      ? left[key] + ((right[key] - left[key]) * progress) : left[key]]));
}

function validInterval(interval) {
  return Array.isArray(interval) && interval.length === 2 && Number.isFinite(interval[0])
    && Number.isFinite(interval[1]) && interval[1] > interval[0];
}

function sampledWindow(start, end, additional = []) {
  const count = Math.ceil((end - start) * 10);
  const regular = Array.from({ length: count + 1 }, (_, index) => Math.min(end, start + (index / 10)));
  return [...new Set([...regular, end, ...additional].filter((time) => Number.isFinite(time) && time >= start && time <= end))]
    .sort((left, right) => left - right);
}

export function requiredReadableTimes(scene, layer, owner) {
  const bounds = Object.values(scene?.interval ?? {}).flat();
  const extrema = ['textRect', 'subjectRect', 'quietZone'].flatMap((field) => (layer?.[field] ?? []).map(({ time }) => time));
  return [...new Set([...(layer?.readableInterval ?? []), ...bounds, owner?.transition?.midpointSeconds, ...extrema].filter(Number.isFinite))]
    .sort((left, right) => left - right);
}

export function validateSceneLayout({ sceneSchema, motionMap } = {}) {
  const hardErrors = [];
  const ownerById = new Map((motionMap?.owners ?? []).map((owner) => [owner.ownerId, owner]));
  for (const [sceneIndex, scene] of (sceneSchema?.scenes ?? []).entries()) {
    const scenePath = `/scenes/${sceneIndex}`;
    for (const [name, interval] of Object.entries(scene.interval ?? {})) {
      if (!validInterval(interval)) hardErrors.push(finding('E_SCENE_INTERVAL', `${scenePath}/interval/${name}`, `${name} must be a non-empty absolute-time interval`));
    }
    for (const name of ['entry', 'hold', 'exit']) {
      if (!validInterval(scene.interval?.[name])) hardErrors.push(finding('E_SCENE_INTERVAL', `${scenePath}/interval/${name}`, `scene requires ${name} interval`));
    }
    for (const [layerIndex, layer] of (scene.readableLayers ?? []).entries()) {
      const path = `${scenePath}/readableLayers/${layerIndex}`;
      for (const field of ['textRect', 'subjectRect', 'quietZone']) {
        if (!Array.isArray(layer[field]) || layer[field].length === 0) hardErrors.push(finding('E_LAYOUT_EVIDENCE', `${path}/${field}`, `readable layer requires tracked ${field}`));
      }
      for (const field of ['horizonRelation', 'screenDirection', 'motionDirection', 'typographyRole']) {
        if (typeof layer[field] !== 'string' || layer[field].length === 0) hardErrors.push(finding('E_LAYOUT_EVIDENCE', `${path}/${field}`, `readable layer requires ${field}`));
      }
      if (!Array.isArray(layer.evidenceFrameIds) || layer.evidenceFrameIds.length === 0) hardErrors.push(finding('E_LAYOUT_EVIDENCE', `${path}/evidenceFrameIds`, 'readable layer requires evidence-frame IDs'));
      if (!validInterval(layer.readableInterval)) hardErrors.push(finding('E_LAYOUT_EVIDENCE', `${path}/readableInterval`, 'readable interval must be non-empty'));
      const owner = ownerById.get(layer.ownerId);
      const window = layer.readableInterval;
      const sceneStart = scene.interval?.entry?.[0]; const sceneEnd = scene.interval?.exit?.[1];
      if (validInterval(window) && (window[0] > sceneStart || window[1] < sceneEnd)) hardErrors.push(finding('E_LAYOUT_COVERAGE', `${path}/readableInterval`, 'readable evidence must cover entry, hold, exit, and their endpoints'));
      for (const field of ['textRect', 'subjectRect', 'quietZone']) {
        const track = [...(layer[field] ?? [])].sort((left, right) => left.time - right.time);
        if (validInterval(window) && (track[0]?.time > window[0] || track.at(-1)?.time < window[1])) hardErrors.push(finding('E_LAYOUT_COVERAGE', `${path}/${field}`, `${field} must cover the complete readable interval`));
      }
      const times = validInterval(window) ? sampledWindow(window[0], window[1], requiredReadableTimes(scene, layer, owner)) : [];
      for (const time of times) {
        const textRect = sampleTrackedRect(layer.textRect, time);
        const subjectRect = sampleTrackedRect(layer.subjectRect, time);
        const quietZone = sampleTrackedRect(layer.quietZone, time);
        if (textRect && quietZone && !rectangleContains(quietZone, textRect)) hardErrors.push(finding('E_QUIET_ZONE_LOSS', path, 'title leaves its tracked quiet zone during motion', { time }));
        const safetyRects = (layer.safetyRegions ?? []).map(({ rect }) => rect);
        if (textRect && [subjectRect, ...safetyRects].filter(Boolean).some((rect) => rectanglesIntersect(textRect, rect))) {
          hardErrors.push(finding('E_LAYOUT_COLLISION', path, 'readable layer intersects tracked subject/road/water safety region', { time }));
        }
      }
      if (owner?.motionDirection && owner.motionDirection !== layer.motionDirection && !owner.designReason) {
        hardErrors.push(finding('E_DIRECTION_CONFLICT', path, 'layer animates against approved footage direction without a recorded design reason'));
      }
    }
  }
  return { valid: hardErrors.length === 0, hardErrors, errors: hardErrors };
}
