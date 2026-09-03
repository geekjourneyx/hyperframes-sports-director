#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { loadSchema, validateDocument, verifyArtifactIntegrity } from './lib/contracts.mjs';
import { projectPath, sha256File, writeJsonAtomic } from './lib/media.mjs';
import { buildRenderedProofEvidence } from './lib/proof-evidence.mjs';

const AUTHORITIES = {
  designSystem: ['direction/DESIGN_SYSTEM.json', 'design-system'],
  lookProfile: ['direction/LOOK_PROFILE.json', 'look-profile'],
  assetManifest: ['direction/ASSET_MANIFEST.json', 'asset-manifest'],
  sceneSchema: ['direction/SCENE_SCHEMA.json', 'scene-schema'],
  motionMap: ['direction/MOTION_MAP.json', 'motion-map'],
};

async function readContract(project, path, schemaName) {
  const value = JSON.parse(await readFile(projectPath(project, path), 'utf8'));
  const contract = validateDocument(await loadSchema(schemaName), value);
  if (!contract.valid || !verifyArtifactIntegrity(value).valid) { const cause = new Error(`${path} is not current ${schemaName} authority`); cause.code = 'E_PROOF_AUTHORITY'; cause.diagnostics = contract.errors; throw cause; }
  return value;
}

export async function renderMotionProofs({ project, proof }) {
  const documents = Object.fromEntries(await Promise.all(Object.entries(AUTHORITIES).map(async ([role, [path, schemaName]]) => [role, await readContract(project, path, schemaName)])));
  const proofPath = projectPath(project, proof);
  const renderedArtifact = { path: proof, digest: await sha256File(proofPath) };
  const pixelProof = JSON.parse(await readFile(proofPath, 'utf8'));
  const evidence = buildRenderedProofEvidence({ proof: pixelProof, documents, renderedArtifact });
  for (const [role, schemaName] of [['colorEvidence', 'design-color-evidence'], ['contrastEvidence', 'design-contrast-evidence']]) {
    const contract = validateDocument(await loadSchema(schemaName), evidence[role]);
    if (!contract.valid) { const cause = new Error(`computed ${schemaName} violates its closed schema`); cause.code = 'E_PROOF_OUTPUT'; cause.diagnostics = contract.errors; throw cause; }
  }
  await writeJsonAtomic(projectPath(project, 'review/design-color-evidence.json'), evidence.colorEvidence);
  await writeJsonAtomic(projectPath(project, 'review/design-contrast-evidence.json'), evidence.contrastEvidence);
  return { ok: true, proofDigest: renderedArtifact.digest, colorEvidenceDigest: evidence.colorEvidence.integrity.digest, contrastEvidenceDigest: evidence.contrastEvidence.integrity.digest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCliArguments(process.argv.slice(2), { project: { required: true }, proof: { required: true } });
    process.stdout.write(`${JSON.stringify(await renderMotionProofs(options))}\n`);
  } catch (cause) { process.stdout.write(`${JSON.stringify(errorResult(cause))}\n`); process.exitCode = cause.code === 'E_USAGE' ? 2 : 1; }
}
