import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { computeArtifactDigest } from '../lib/contracts.mjs';
import { commitFinalRenderState } from '../lib/render.mjs';
import { recoverFinalRenderTransaction } from '../render_final.mjs';

const HEX = (character) => character.repeat(64);

function sign(value) {
  value.integrity.digest = computeArtifactDigest(value);
  return value;
}

function gateSpecifications(state) {
  if (state === 'DIRECTOR_LOCK') return [['DESIGN_SYSTEM', 'frozen'], ['LOOK_PROFILE', 'frozen'], ['DIRECTOR_APPROVAL', 'consumed'], ['WORKBENCH', 'state-bound']];
  if (state === 'STYLE_ANCHOR') return [['DESIGN_SYSTEM', 'frozen'], ['LOOK_PROFILE', 'frozen'], ['ASSET_PLAN', 'approved'], ['STYLE_ANCHOR', 'accepted']];
  if (state === 'ASSET_PRODUCTION') return [['STYLE_ANCHOR', 'accepted'], ['REPRESENTATIVE_COMBINATION', 'accepted']];
  return [[`${state}_GATE`, 'accepted']];
}

function projectStateAt(state) {
  const route = ['INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT', 'DIRECTOR_REVIEW_READY', 'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION', 'MOTION_COMPOSITION'];
  const gateEvidence = [];
  const transitions = route.slice(1).map((to, index) => {
    const timestamp = `2026-09-01T00:${String(index).padStart(2, '0')}:00.000Z`;
    const records = gateSpecifications(to).map(([role, qualifier], roleIndex) => ({
      gate: to, role, revision: index + 1, digest: `${index + 1}${roleIndex + 1}`.padStart(64, '0'), timestamp,
      producerCommand: to === 'DIRECTOR_LOCK' ? 'lock_direction.mjs' : `test-gate --state ${to}`,
      qualifiers: [qualifier], validity: 'valid', invalidatedAt: null,
    }));
    gateEvidence.push(...records);
    return { from: route[index], to, at: timestamp, evidenceDigests: Object.fromEntries(records.map(({ role, digest }) => [role, digest])), evidenceRevisions: Object.fromEntries(records.map(({ role, revision }) => [role, revision])) };
  });
  const result = {
    $schema: 'https://hyperframes.local/schemas/project-state.schema.json', schemaVersion: '1.0.0', revision: 13,
    state, previousState: 'ASSET_PRODUCTION', stateEnteredAt: transitions.at(-1).at, transitions, gateEvidence, invalidations: [],
    assetAcceptance: { stage: 'batch', manifestRevision: 2, manifestDigest: HEX('e'), anchorDigest: gateEvidence.find(({ gate, role }) => gate === 'ASSET_PRODUCTION' && role === 'STYLE_ANCHOR').digest, representativeDigest: gateEvidence.find(({ gate, role }) => gate === 'ASSET_PRODUCTION' && role === 'REPRESENTATIVE_COMBINATION').digest, anchorIdentityDigest: HEX('a'), representativeIdentityDigest: HEX('b'), batchDigest: HEX('c'), acceptedAt: transitions.at(-1).at },
    integrity: { digest: null, upstream: {} },
  };
  return sign(result);
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

test('recovery rejects a newer state, then safely rolls back the matching prepared state', async () => {
  const project = await mkdtemp(join(tmpdir(), 'hyperframes-render-conflict-'));
  const transactionId = '00112233445566778899aabbccddeeff';
  await mkdir(join(project, 'cache'), { recursive: true });
  await mkdir(join(project, 'renders'), { recursive: true });
  const previousState = projectStateAt('MOTION_COMPOSITION');
  const provenance = sign({ revision: 1, outputDigest: HEX('8'), closedFileProbe: { valid: true }, integrity: { digest: null, upstream: {} } });
  const nextState = commitFinalRenderState(previousState, provenance, '2026-09-03T10:00:00.000Z');
  sign(nextState);
  const transaction = sign({
    kind: 'final-render-transaction', schemaVersion: '1.0.0', transactionId, phase: 'prepared', paths: {
      candidate: `renders/.final-render.${transactionId}.candidate.mp4`, pendingProvenance: `renders/.final-render.${transactionId}.provenance.pending.json`, final: 'renders/final.mp4', finalProvenance: 'renders/final.provenance.json', state: 'PROJECT_STATE.json',
    }, previousState, nextState, integrity: { digest: null, upstream: { renderProvenance: provenance.integrity.digest } },
  });
  await writeFile(join(project, 'cache', 'final-render.transaction.json'), `${JSON.stringify(transaction)}\n`);
  await writeFile(join(project, 'renders', 'final.mp4'), 'newer final');
  const laterState = structuredClone(nextState);
  laterState.state = 'FINAL_QA'; laterState.previousState = 'FINAL_RENDER'; laterState.revision += 1; sign(laterState);
  await assert.rejects(
    () => recoverFinalRenderTransaction(project, null, { loadCurrentState: async () => laterState, rebuildWorkbench: async () => {} }),
    (error) => error.code === 'E_FINAL_TRANSACTION_CONFLICT',
  );
  assert.equal(await readFile(join(project, 'renders', 'final.mp4'), 'utf8'), 'newer final');
  await writeFile(join(project, 'PROJECT_STATE.json'), `${JSON.stringify(previousState)}\n`);
  await recoverFinalRenderTransaction(project, null, { rebuildWorkbench: async () => ({ ok: true }) });
  assert.equal(JSON.parse(await readFile(join(project, 'PROJECT_STATE.json'), 'utf8')).integrity.digest, previousState.integrity.digest);
  await assert.rejects(() => readFile(join(project, 'renders', 'final.mp4')), (error) => error.code === 'ENOENT');
  await assert.rejects(() => readFile(join(project, 'cache', 'final-render.transaction.json')), (error) => error.code === 'ENOENT');
});
