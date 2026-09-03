import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRenderedProofEvidence } from '../lib/proof-evidence.mjs';
import { computeArtifactDigest, loadSchema, validateDocument } from '../lib/contracts.mjs';
import { validateRenderedEvidenceAuthority } from '../validate_design_consistency.mjs';
import { renderMotionProofs } from '../render_motion_proofs.mjs';

const digest = (character) => character.repeat(64);

function fixture() {
  const documents = {
    designSystem: { integrity: { digest: digest('a') }, tokens: { colors: { 'color.primaryText': '#FFFFFF' }, redundantEncodings: { status: 'label-symbol' } } },
    lookProfile: { integrity: { digest: digest('b') } }, assetManifest: { integrity: { digest: digest('c') } },
    sceneSchema: { integrity: { digest: digest('d') }, scenes: [{ readableLayers: [{ layerId: 'layer-title', typographyRole: 'type.journeyTitle', readableInterval: [0, 0.1] }] }] },
    motionMap: { integrity: { digest: digest('e') }, owners: [{ layerId: 'layer-title', colorToken: 'color.primaryText' }] },
  };
  const authorities = Object.fromEntries(Object.entries(documents).map(([role, value]) => [role, value.integrity.digest]));
  const proof = { schemaVersion: '1.0.0', revision: 1, authorities, samples: [0, 0.1].map((time) => ({
    layerId: 'layer-title', time, kind: 'critical-text', token: 'color.primaryText', layerAlpha: 1,
    composite: [255, 255, 255, 255], background: [0, 0, 0, 255], matte: [255, 255, 255, 255],
  })), colorVisionSamples: ['protanopia', 'deuteranopia'].map((simulation) => ({ simulation, semantic: 'status', foreground: [255, 255, 255, 255], background: [0, 0, 0, 255] })) };
  return { documents, proof, renderedArtifact: { path: 'review/motion-proofs/pixels.json', digest: digest('f') } };
}

test('proof producer computes color, local contrast, and coverage from captured pixels', async () => {
  assert.equal(typeof renderMotionProofs, 'function');
  const input = fixture();
  const evidence = buildRenderedProofEvidence(input);
  assert.equal(evidence.colorEvidence.renderedTokenSamples[0].deltaE2000, 0);
  assert.equal(evidence.colorEvidence.renderedTokenSamples[0].highCoverageMatte, true);
  assert.equal(evidence.contrastEvidence.layers[0].samples[0].ratio, 21);
  assert.deepEqual(evidence.colorEvidence.colorVisionProofs.map(({ encodings }) => encodings), [['label', 'symbol'], ['label', 'symbol']]);
  assert.equal(validateDocument(await loadSchema('design-color-evidence'), evidence.colorEvidence).valid, true);
  assert.equal(validateDocument(await loadSchema('design-contrast-evidence'), evidence.contrastEvidence).valid, true);
});

test('validator recomputes producer measurements instead of trusting self-signed values', () => {
  const input = fixture();
  const evidence = buildRenderedProofEvidence(input);
  evidence.colorEvidence.renderedTokenSamples[0].deltaE2000 = 0.1;
  evidence.colorEvidence.integrity.digest = computeArtifactDigest(evidence.colorEvidence);
  const result = validateRenderedEvidenceAuthority({ ...evidence, ...input, renderedBytes: { color: input.renderedArtifact.digest, contrast: input.renderedArtifact.digest } });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(({ code }) => code === 'E_DESIGN_EVIDENCE_MEASUREMENT'));
});
