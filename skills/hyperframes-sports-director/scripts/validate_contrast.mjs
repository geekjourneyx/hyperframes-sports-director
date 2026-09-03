import { pathToFileURL } from 'node:url';
import { errorResult } from './lib/cli.mjs';
import { requiredReadableTimes } from './lib/layout.mjs';

function error(code, path, message) { return { code, classification: 'hard_error', category: 'contrast-inputs', path, message }; }
const minimumFor = (kind) => kind === 'critical-text' ? 4.5 : kind === 'ordinary-text' ? 4.5 : 3;

export function validateContrast({ layers = [], sceneSchema, motionMap, requireRenderedEvidence = false } = {}) {
  const hardErrors = [];
  const owners = new Map((motionMap?.owners ?? []).map((owner) => [owner.ownerId, owner]));
  const readable = new Map((sceneSchema?.scenes ?? []).flatMap((scene) => (scene.readableLayers ?? []).map((layer) => [layer.layerId, { scene, layer, owner: owners.get(layer.ownerId) }])));
  if (sceneSchema) {
    const expectedIds = (sceneSchema.scenes ?? []).flatMap((scene) => (scene.readableLayers ?? []).map(({ layerId }) => layerId));
    const actualIds = layers.map(({ layerId }) => layerId);
    const inventory = new Set([...expectedIds, ...actualIds]);
    const invalidInventory = expectedIds.length !== readable.size || inventory.size !== readable.size
      || [...inventory].some((layerId) => expectedIds.filter((id) => id === layerId).length !== 1 || actualIds.filter((id) => id === layerId).length !== 1)
      || layers.some((layer) => JSON.stringify(layer.readableInterval) !== JSON.stringify(readable.get(layer.layerId)?.layer.readableInterval));
    if (invalidInventory) hardErrors.push(error('E_CONTRAST_INVENTORY', '/layers', 'contrast evidence must bind every SCENE_SCHEMA readable layer exactly once with its exact readable interval'));
  }
  if (requireRenderedEvidence && layers.length === 0) hardErrors.push(error('E_CONTRAST_INPUT', '/layers', 'rendered local-contrast samples are required'));
  for (const [layerIndex, layer] of layers.entries()) {
    const path = `/layers/${layerIndex}`;
    if (!Array.isArray(layer.readableInterval) || layer.readableInterval[1] <= layer.readableInterval[0] || !Array.isArray(layer.samples) || layer.samples.length === 0) {
      hardErrors.push(error('E_CONTRAST_INPUT', path, 'readable layer requires an interval and sampled proof inputs')); continue;
    }
    const times = layer.samples.map(({ time }) => time).filter(Number.isFinite).sort((left, right) => left - right);
    const [start, end] = layer.readableInterval;
    const required = readable.has(layer.layerId) ? requiredReadableTimes(readable.get(layer.layerId).scene, readable.get(layer.layerId).layer, readable.get(layer.layerId).owner) : [start, end];
    const missingCoverage = times[0] > start + 0.000001 || times.at(-1) < end - 0.000001
      || times.some((time, index) => index > 0 && time - times[index - 1] > 0.100001)
      || required.filter((time) => time >= start && time <= end).some((time) => !times.some((sample) => Math.abs(sample - time) <= 0.050001));
    if (missingCoverage) hardErrors.push(error('E_CONTRAST_COVERAGE', path, 'contrast evidence must sample at least 10Hz and cover endpoints, phases, transition midpoint, and motion extrema'));
    const minimum = minimumFor(layer.kind);
    const failing = layer.samples.filter((sample) => !sample.hasBackgroundPass || !sample.hasCoverageMatte || !Number.isFinite(sample.ratio) || sample.ratio < minimum);
    if (failing.some((sample) => !sample.hasBackgroundPass || !sample.hasCoverageMatte || !Number.isFinite(sample.ratio))) hardErrors.push(error('E_CONTRAST_INPUT', path, 'local contrast requires matching background-only and coverage-matte samples'));
    if (layer.kind === 'critical-text' && failing.length > 0) hardErrors.push(error('E_CONTRAST_MINIMUM', path, 'critical text must never fall below 4.5:1'));
    if (layer.kind === 'ordinary-text') {
      const passRatio = (layer.samples.length - failing.length) / layer.samples.length;
      const failingTimes = failing.map(({ time }) => time).filter(Number.isFinite).sort((a, b) => a - b);
      const excessiveRun = failingTimes.some((time, index) => index > 0 && time - failingTimes[index - 1] <= 0.11 && time - (failingTimes[index - 3] ?? time) > 0.25);
      if (passRatio < 0.95 || excessiveRun) hardErrors.push(error('E_CONTRAST_MINIMUM', path, 'ordinary text requires 95% passing samples and no continuous failure over 0.25 seconds'));
    }
    if (!['critical-text', 'ordinary-text'].includes(layer.kind) && failing.length > 0) hardErrors.push(error('E_CONTRAST_MINIMUM', path, 'large text and meaningful graphics require 3:1 contrast'));
  }
  return { valid: hardErrors.length === 0, hardErrors, errors: hardErrors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const input = JSON.parse(await new Promise((resolve) => { let body = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { body += chunk; }); process.stdin.on('end', () => resolve(body)); })); const result = validateContrast(input); process.stdout.write(`${JSON.stringify({ ok: result.valid, ...result })}\n`); if (!result.valid) process.exitCode = 1; }
  catch (cause) { process.stdout.write(`${JSON.stringify(errorResult(cause))}\n`); process.exitCode = 1; }
}
