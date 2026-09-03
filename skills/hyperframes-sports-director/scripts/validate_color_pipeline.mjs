import { pathToFileURL } from 'node:url';
import { errorResult } from './lib/cli.mjs';

function error(code, path, message) { return { code, classification: 'hard_error', category: 'color-pipeline', path, message }; }

export function validateColorPipeline({ lookProfile, designSystem, renderedTokenSamples = [], colorVisionProofs = [], requireRenderedEvidence = false } = {}) {
  const hardErrors = [];
  if (!['source-metadata', 'rec709'].includes(lookProfile?.input?.interpretation)) hardErrors.push(error('E_INPUT_COLOR_UNDECLARED', '/lookProfile/input/interpretation', 'input color interpretation must be declared'));
  if (lookProfile?.working?.colorSpace !== 'linear-rec709' || lookProfile?.output?.colorSpace !== 'rec709-sdr') hardErrors.push(error('E_DELIVERY_COLOR_SPACE', '/lookProfile/output/colorSpace', 'v1 delivery must be SDR Rec.709'));
  if (requireRenderedEvidence && renderedTokenSamples.length === 0) hardErrors.push(error('E_COLOR_PROOF_INPUT', '/renderedTokenSamples', 'rendered token samples are required'));
  for (const [index, sample] of renderedTokenSamples.entries()) {
    if (!designSystem?.tokens?.colors?.[sample.token]) hardErrors.push(error('E_TOKEN_UNRESOLVED', `/renderedTokenSamples/${index}/token`, 'rendered token must resolve in frozen colors'));
    if (!Number.isFinite(sample.deltaE2000) || sample.deltaE2000 > 3) hardErrors.push(error('E_TOKEN_COLOR_DRIFT', `/renderedTokenSamples/${index}`, 'rendered token color must remain within Delta E 2000 <= 3'));
    if (sample.alpha < 1 && (!sample.backgroundPass || !sample.highCoverageMatte)) hardErrors.push(error('E_COLOR_PROOF_INPUT', `/renderedTokenSamples/${index}`, 'translucent color validation requires background-only and high-coverage matte evidence'));
  }
  for (const [index, proof] of colorVisionProofs.entries()) {
    const redundant = (proof.encodings ?? []).some((encoding) => ['label', 'boundary', 'symbol', 'pattern'].includes(encoding));
    if (!['protanopia', 'deuteranopia'].includes(proof.simulation) || !redundant || !(proof.contrastRatio >= 3)) hardErrors.push(error('E_COLOR_VISION_MEANING', `/colorVisionProofs/${index}`, 'route/grade/status meaning requires redundant non-hue encoding and 3:1 meaningful-graphic contrast'));
  }
  if (requireRenderedEvidence) for (const simulation of ['protanopia', 'deuteranopia']) if (!colorVisionProofs.some((proof) => proof.simulation === simulation)) hardErrors.push(error('E_COLOR_VISION_MEANING', '/colorVisionProofs', `${simulation} proof is required`));
  return { valid: hardErrors.length === 0, hardErrors, errors: hardErrors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const input = JSON.parse(await new Promise((resolve) => { let body = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { body += chunk; }); process.stdin.on('end', () => resolve(body)); })); const result = validateColorPipeline(input); process.stdout.write(`${JSON.stringify({ ok: result.valid, ...result })}\n`); if (!result.valid) process.exitCode = 1; }
  catch (cause) { process.stdout.write(`${JSON.stringify(errorResult(cause))}\n`); process.exitCode = 1; }
}
