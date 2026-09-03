import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeArtifactDigest } from '../lib/contracts.mjs';
import { recoverFinalRenderTransaction } from '../render_final.mjs';

const HEX = (character) => character.repeat(64);

function sign(value) {
  value.integrity.digest = computeArtifactDigest(value);
  return value;
}

test('re-signed transaction with an absolute owned path is rejected before touching that path', async () => {
  const project = await mkdtemp(join(tmpdir(), 'hyperframes-render-transaction-'));
  const input = await mkdtemp(join(tmpdir(), 'hyperframes-render-input-'));
  const sentinel = join(input, 'original.mp4');
  await mkdir(join(project, 'cache'), { recursive: true });
  await writeFile(sentinel, 'immutable input');
  const transaction = sign({
    kind: 'final-render-transaction', schemaVersion: '1.0.0',
    transactionId: '0123456789abcdef0123456789abcdef',
    phase: 'prepared',
    paths: {
      candidate: sentinel,
      pendingProvenance: 'renders/.final-render.0123456789abcdef0123456789abcdef.provenance.pending.json',
      final: 'renders/final.mp4', finalProvenance: 'renders/final.provenance.json', state: 'PROJECT_STATE.json',
    },
    previousState: { state: 'MOTION_COMPOSITION', integrity: { digest: HEX('a'), upstream: {} } },
    nextState: { state: 'FINAL_RENDER', integrity: { digest: HEX('b'), upstream: {} } },
    integrity: { digest: null, upstream: { renderProvenance: HEX('c') } },
  });
  await writeFile(join(project, 'cache', 'final-render.transaction.json'), `${JSON.stringify(transaction)}\n`);

  await assert.rejects(
    () => recoverFinalRenderTransaction(project, null, { rebuildWorkbench: async () => {} }),
    (error) => error.code === 'E_FINAL_TRANSACTION_PATH',
  );
  assert.equal(await readFile(sentinel, 'utf8'), 'immutable input');
});

test('re-signed transaction cannot use forged project states before deleting owned files', async () => {
  const project = await mkdtemp(join(tmpdir(), 'hyperframes-render-state-'));
  const transactionId = 'fedcba9876543210fedcba9876543210';
  await mkdir(join(project, 'cache'), { recursive: true });
  await mkdir(join(project, 'renders'), { recursive: true });
  const candidate = join(project, 'renders', `.final-render.${transactionId}.candidate.mp4`);
  await writeFile(candidate, 'owned but not yet safe to delete');
  const transaction = sign({
    kind: 'final-render-transaction', schemaVersion: '1.0.0', transactionId, phase: 'prepared',
    paths: { candidate: `renders/.final-render.${transactionId}.candidate.mp4`, pendingProvenance: `renders/.final-render.${transactionId}.provenance.pending.json`, final: 'renders/final.mp4', finalProvenance: 'renders/final.provenance.json', state: 'PROJECT_STATE.json' },
    previousState: { state: 'MOTION_COMPOSITION', integrity: { digest: HEX('a'), upstream: {} } },
    nextState: { state: 'FINAL_RENDER', integrity: { digest: HEX('b'), upstream: {} } },
    integrity: { digest: null, upstream: { renderProvenance: HEX('c') } },
  });
  await writeFile(join(project, 'cache', 'final-render.transaction.json'), `${JSON.stringify(transaction)}\n`);
  await assert.rejects(() => recoverFinalRenderTransaction(project, null, { rebuildWorkbench: async () => {} }), (error) => error.code === 'E_FINAL_TRANSACTION_STATE');
  assert.equal(await readFile(candidate, 'utf8'), 'owned but not yet safe to delete');
});
