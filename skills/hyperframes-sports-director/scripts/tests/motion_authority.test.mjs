import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRenderedEvidenceAuthority } from '../validate_design_consistency.mjs';
import { validateMotionProgressDiagnostics } from '../lib/approval.mjs';
import { computeArtifactDigest, loadSchema, validateDocument } from '../lib/contracts.mjs';

const digest = (character) => character.repeat(64);
const stamp = (artifact) => { artifact.integrity.digest = computeArtifactDigest(artifact); return artifact; };

test('rendered proof evidence is current, integrity-valid, and produced by the trusted renderer', () => {
  const authorities = { designSystem: digest('a'), lookProfile: digest('b'), motionMap: digest('c'), sceneSchema: digest('d') };
  const renderedBytes = { color: digest('e'), contrast: digest('f') };
  const colorEvidence = stamp({ schemaVersion: '1.0.0', revision: 1, producerCommand: 'render_motion_proofs.mjs',
    renderedArtifact: { path: 'review/motion-proofs/color.rgba', digest: renderedBytes.color }, renderedTokenSamples: [], colorVisionProofs: [],
    integrity: { digest: null, upstream: { designSystem: authorities.designSystem, lookProfile: authorities.lookProfile, motionMap: authorities.motionMap, renderedBytes: renderedBytes.color } } });
  const contrastEvidence = stamp({ schemaVersion: '1.0.0', revision: 1, producerCommand: 'render_motion_proofs.mjs',
    renderedArtifact: { path: 'review/motion-proofs/contrast.rgba', digest: renderedBytes.contrast }, layers: [],
    integrity: { digest: null, upstream: { sceneSchema: authorities.sceneSchema, motionMap: authorities.motionMap, renderedBytes: renderedBytes.contrast } } });
  assert.equal(validateRenderedEvidenceAuthority({ colorEvidence, contrastEvidence, authorities, renderedBytes }).valid, true);
  const tampered = structuredClone(colorEvidence); tampered.renderedTokenSamples.push({ token: 'color.route', deltaE2000: 99, alpha: 1 });
  assert.equal(validateRenderedEvidenceAuthority({ colorEvidence: tampered, contrastEvidence, authorities, renderedBytes }).valid, false);
  const wrongProducer = structuredClone(colorEvidence); wrongProducer.producerCommand = 'unknown.mjs'; wrongProducer.integrity.digest = computeArtifactDigest(wrongProducer);
  assert.equal(validateRenderedEvidenceAuthority({ colorEvidence: wrongProducer, contrastEvidence, authorities, renderedBytes }).valid, false);
});

test('workbench diagnostics require one exact integrity-valid gate binding', () => {
  const diagnostics = stamp({ schemaVersion: '1.0.0', revision: 1, status: 'hard-gates-passed', sceneCount: 1, motionOwnerCount: 2, timelineItemCount: 1,
    hardErrors: [], agentReviewRequired: [], integrity: { digest: null, upstream: {} } });
  const record = { gate: 'MOTION_COMPOSITION', role: 'DESIGN_CONSISTENCY', revision: 1, digest: diagnostics.integrity.digest, qualifiers: ['hard-gates-passed'] };
  assert.equal(validateMotionProgressDiagnostics({ gateEvidence: [record] }, diagnostics).valid, true);
  assert.equal(validateMotionProgressDiagnostics({ gateEvidence: [record, structuredClone(record)] }, diagnostics).valid, false);
  diagnostics.sceneCount = 9;
  assert.equal(validateMotionProgressDiagnostics({ gateEvidence: [record] }, diagnostics).valid, false);
});

test('rendered color and contrast evidence have closed schemas', async () => {
  for (const name of ['design-color-evidence', 'design-contrast-evidence']) {
    const schema = await loadSchema(name);
    assert.equal(validateDocument(schema, {}).valid, false);
  }
});
