import assert from 'node:assert/strict';
import test from 'node:test';

import { validateMotionProgressDiagnostics } from '../lib/approval.mjs';
import { computeArtifactDigest, loadSchema, validateDocument } from '../lib/contracts.mjs';

const stamp = (artifact) => { artifact.integrity.digest = computeArtifactDigest(artifact); return artifact; };

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
