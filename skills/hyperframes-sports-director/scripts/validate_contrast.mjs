import { pathToFileURL } from 'node:url';
import { errorResult } from './lib/cli.mjs';

function error(code, path, message) { return { code, classification: 'hard_error', category: 'contrast-inputs', path, message }; }
const minimumFor = (kind) => kind === 'critical-text' ? 4.5 : kind === 'ordinary-text' ? 4.5 : 3;

export function validateContrast({ layers = [], requireRenderedEvidence = false } = {}) {
  const hardErrors = [];
  if (requireRenderedEvidence && layers.length === 0) hardErrors.push(error('E_CONTRAST_INPUT', '/layers', 'rendered local-contrast samples are required'));
  for (const [layerIndex, layer] of layers.entries()) {
    const path = `/layers/${layerIndex}`;
    if (!Array.isArray(layer.readableInterval) || layer.readableInterval[1] <= layer.readableInterval[0] || !Array.isArray(layer.samples) || layer.samples.length === 0) {
      hardErrors.push(error('E_CONTRAST_INPUT', path, 'readable layer requires an interval and sampled proof inputs')); continue;
    }
    const minimum = minimumFor(layer.kind);
    const failing = layer.samples.filter((sample) => !sample.hasBackgroundPass || !sample.hasCoverageMatte || !Number.isFinite(sample.ratio) || sample.ratio < minimum);
    if (failing.some((sample) => !sample.hasBackgroundPass || !sample.hasCoverageMatte || !Number.isFinite(sample.ratio))) hardErrors.push(error('E_CONTRAST_INPUT', path, 'local contrast requires matching background-only and coverage-matte samples'));
    if (layer.kind === 'critical-text' && failing.length > 0) hardErrors.push(error('E_CONTRAST_MINIMUM', path, 'critical text must never fall below 4.5:1'));
    if (layer.kind === 'ordinary-text') {
      const passRatio = (layer.samples.length - failing.length) / layer.samples.length;
      const times = failing.map(({ time }) => time).filter(Number.isFinite).sort((a, b) => a - b);
      const excessiveRun = times.some((time, index) => index > 0 && time - times[index - 1] <= 0.11 && time - (times[index - 3] ?? time) > 0.25);
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
