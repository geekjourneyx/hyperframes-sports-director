import { computeArtifactDigest } from './contracts.mjs';

const AUTHORITY_ROLES = ['assetManifest', 'designSystem', 'lookProfile', 'motionMap', 'sceneSchema'];
const SAMPLE_KEYS = ['background', 'composite', 'kind', 'layerAlpha', 'layerId', 'matte', 'time', 'token'];
const VISION_KEYS = ['background', 'foreground', 'semantic', 'simulation'];

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function exactKeys(value, keys) { return value && typeof value === 'object' && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }
function rgba(value) { return Array.isArray(value) && value.length === 4 && value.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255); }
function round(value) { return Number(value.toFixed(6)); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
export function proofEvidenceEqual(left, right) { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)); }

function assertProofInput(proof, documents) {
  if (!exactKeys(proof, ['schemaVersion', 'revision', 'authorities', 'samples', 'colorVisionSamples']) || proof.schemaVersion !== '1.0.0' || !Number.isInteger(proof.revision) || proof.revision < 1) fail('E_PROOF_INPUT', 'proof sample bundle has an invalid root contract');
  if (!exactKeys(proof.authorities, AUTHORITY_ROLES) || AUTHORITY_ROLES.some((role) => proof.authorities[role] !== documents?.[role]?.integrity?.digest)) fail('E_PROOF_AUTHORITY', 'proof sample bundle does not bind the current design/Look/asset/scene/motion authorities');
  if (!Array.isArray(proof.samples) || proof.samples.length === 0 || proof.samples.some((sample) => !exactKeys(sample, SAMPLE_KEYS)
    || !/^layer-[a-zA-Z0-9-]+$/.test(sample.layerId) || !/^color\.[a-z][A-Za-z0-9]*$/.test(sample.token)
    || !['critical-text', 'ordinary-text', 'large-text', 'meaningful-graphic'].includes(sample.kind)
    || !Number.isFinite(sample.time) || sample.time < 0 || !Number.isFinite(sample.layerAlpha) || sample.layerAlpha < 0 || sample.layerAlpha > 1
    || !rgba(sample.composite) || !rgba(sample.background) || !rgba(sample.matte))) fail('E_PROOF_INPUT', 'proof pixel samples are incomplete or malformed');
  const readable = new Map((documents?.sceneSchema?.scenes ?? []).flatMap((scene) => (scene.readableLayers ?? []).map((layer) => [layer.layerId, layer])));
  const owners = new Map((documents?.motionMap?.owners ?? []).map((owner) => [owner.layerId, owner]));
  for (const sample of proof.samples) {
    const layer = readable.get(sample.layerId); const owner = owners.get(sample.layerId);
    const expectedKind = /(?:title|metric)/i.test(layer?.typographyRole ?? '') ? 'critical-text' : /large/i.test(layer?.typographyRole ?? '') ? 'large-text' : 'ordinary-text';
    if (!layer || owner?.colorToken !== sample.token || sample.kind !== expectedKind
      || sample.time < layer.readableInterval[0] || sample.time > layer.readableInterval[1]) fail('E_PROOF_AUTHORITY', 'proof samples must bind authoritative layer, token, kind, and readable time');
  }
  if (!Array.isArray(proof.colorVisionSamples) || proof.colorVisionSamples.length < 2 || proof.colorVisionSamples.some((sample) => !exactKeys(sample, VISION_KEYS)
    || !['protanopia', 'deuteranopia'].includes(sample.simulation) || typeof sample.semantic !== 'string' || !rgba(sample.foreground) || !rgba(sample.background))) fail('E_PROOF_INPUT', 'color-vision pixel samples are incomplete or malformed');
}

function linear(channel) {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function luminance(pixel) { return (0.2126 * linear(pixel[0])) + (0.7152 * linear(pixel[1])) + (0.0722 * linear(pixel[2])); }
function contrast(left, right) { const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a); return (bright + 0.05) / (dark + 0.05); }
function rgbToLab(pixel) {
  const [r, g, b] = pixel.map(linear);
  const xyz = [
    ((r * 0.4124564) + (g * 0.3575761) + (b * 0.1804375)) / 0.95047,
    (r * 0.2126729) + (g * 0.7151522) + (b * 0.072175),
    ((r * 0.0193339) + (g * 0.119192) + (b * 0.9503041)) / 1.08883,
  ].map((value) => value > 0.008856 ? Math.cbrt(value) : (7.787 * value) + (16 / 116));
  return [(116 * xyz[1]) - 16, 500 * (xyz[0] - xyz[1]), 200 * (xyz[1] - xyz[2])];
}
function degrees(value) { const result = value * 180 / Math.PI; return result < 0 ? result + 360 : result; }
function radians(value) { return value * Math.PI / 180; }
export function deltaE2000(leftRgb, rightRgb) {
  const [l1, a1, b1] = rgbToLab(leftRgb); const [l2, a2, b2] = rgbToLab(rightRgb);
  const c1 = Math.hypot(a1, b1); const c2 = Math.hypot(a2, b2); const meanC = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt((meanC ** 7) / ((meanC ** 7) + (25 ** 7))));
  const ap1 = (1 + g) * a1; const ap2 = (1 + g) * a2;
  const cp1 = Math.hypot(ap1, b1); const cp2 = Math.hypot(ap2, b2);
  const hp1 = cp1 === 0 ? 0 : degrees(Math.atan2(b1, ap1)); const hp2 = cp2 === 0 ? 0 : degrees(Math.atan2(b2, ap2));
  const dL = l2 - l1; const dC = cp2 - cp1; const hueDelta = hp2 - hp1;
  const dHAngle = cp1 * cp2 === 0 ? 0 : Math.abs(hueDelta) <= 180 ? hueDelta : hueDelta > 180 ? hueDelta - 360 : hueDelta + 360;
  const dH = 2 * Math.sqrt(cp1 * cp2) * Math.sin(radians(dHAngle / 2));
  const meanL = (l1 + l2) / 2; const meanCp = (cp1 + cp2) / 2;
  const meanHp = cp1 * cp2 === 0 ? hp1 + hp2 : Math.abs(hueDelta) <= 180 ? (hp1 + hp2) / 2 : hp1 + hp2 < 360 ? (hp1 + hp2 + 360) / 2 : (hp1 + hp2 - 360) / 2;
  const t = 1 - (0.17 * Math.cos(radians(meanHp - 30))) + (0.24 * Math.cos(radians(2 * meanHp))) + (0.32 * Math.cos(radians((3 * meanHp) + 6))) - (0.2 * Math.cos(radians((4 * meanHp) - 63)));
  const sL = 1 + ((0.015 * ((meanL - 50) ** 2)) / Math.sqrt(20 + ((meanL - 50) ** 2)));
  const sC = 1 + (0.045 * meanCp); const sH = 1 + (0.015 * meanCp * t);
  const rT = -2 * Math.sqrt((meanCp ** 7) / ((meanCp ** 7) + (25 ** 7))) * Math.sin(radians(60 * Math.exp(-(((meanHp - 275) / 25) ** 2))));
  return Math.sqrt((dL / sL) ** 2 + (dC / sC) ** 2 + (dH / sH) ** 2 + (rT * (dC / sC) * (dH / sH)));
}

function parseHex(value) {
  if (!/^#[0-9a-fA-F]{6}$/.test(value ?? '')) fail('E_PROOF_TOKEN', 'proof token must resolve to a six-digit frozen color');
  return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
}
function expectedComposite(token, background, alpha) { return token.map((channel, index) => Math.round((channel * alpha) + (background[index] * (1 - alpha)))); }
function matteCoverage(matte) { return ((matte[0] + matte[1] + matte[2]) / (3 * 255)) * (matte[3] / 255); }
function encodings(designSystem, semantic) {
  const declared = designSystem.tokens.redundantEncodings?.[semantic] ?? '';
  return ['label', 'boundary', 'symbol', 'pattern'].filter((encoding) => declared.split('-').includes(encoding));
}

export function buildRenderedProofEvidence({ proof, documents, renderedArtifact }) {
  assertProofInput(proof, documents);
  if (!renderedArtifact || typeof renderedArtifact.path !== 'string' || !/^[0-9a-f]{64}$/.test(renderedArtifact.digest ?? '')) fail('E_PROOF_INPUT', 'proof source bytes require a portable path and digest');
  const upstream = Object.fromEntries(AUTHORITY_ROLES.map((role) => [role, documents[role].integrity.digest]));
  const tokenSamples = proof.samples.map((sample) => {
    const token = parseHex(documents.designSystem.tokens.colors[sample.token]);
    const expected = expectedComposite(token, sample.background, sample.layerAlpha);
    const coverage = matteCoverage(sample.matte);
    return { token: sample.token, time: sample.time, deltaE2000: round(deltaE2000(sample.composite, expected)), alpha: sample.layerAlpha,
      backgroundPass: true, highCoverageMatte: coverage >= 0.9 };
  });
  const colorVisionProofs = proof.colorVisionSamples.map((sample) => ({ simulation: sample.simulation, semantic: sample.semantic,
    contrastRatio: round(contrast(sample.foreground, sample.background)), encodings: encodings(documents.designSystem, sample.semantic) }));
  const grouped = Map.groupBy(proof.samples, ({ layerId }) => layerId);
  const readable = new Map(documents.sceneSchema.scenes.flatMap((scene) => scene.readableLayers.map((layer) => [layer.layerId, layer])));
  const layers = [...grouped.entries()].map(([layerId, samples]) => ({ layerId, kind: samples[0].kind,
    readableInterval: structuredClone(readable.get(layerId)?.readableInterval), samples: samples.map((sample) => ({ time: sample.time,
      ratio: round(contrast(sample.composite, sample.background)), hasBackgroundPass: true, hasCoverageMatte: matteCoverage(sample.matte) >= 0.9 })).sort((left, right) => left.time - right.time) })).sort((left, right) => left.layerId.localeCompare(right.layerId));
  const common = { schemaVersion: '1.0.0', revision: proof.revision, producerCommand: 'render_motion_proofs.mjs', renderedArtifact: structuredClone(renderedArtifact) };
  const evidenceUpstream = { ...upstream, renderedBytes: renderedArtifact.digest };
  const colorEvidence = { $schema: 'https://hyperframes.local/schemas/design-color-evidence.schema.json', ...common,
    renderedTokenSamples: tokenSamples, colorVisionProofs, integrity: { digest: null, upstream: evidenceUpstream } };
  const contrastEvidence = { $schema: 'https://hyperframes.local/schemas/design-contrast-evidence.schema.json', ...common,
    layers, integrity: { digest: null, upstream: evidenceUpstream } };
  colorEvidence.integrity.digest = computeArtifactDigest(colorEvidence); contrastEvidence.integrity.digest = computeArtifactDigest(contrastEvidence);
  return { colorEvidence, contrastEvidence };
}
