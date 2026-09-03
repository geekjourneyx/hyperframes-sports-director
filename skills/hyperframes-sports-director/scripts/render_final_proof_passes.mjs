#!/usr/bin/env node
import { lstat, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import sharp from 'sharp';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest, validateArtifact, verifyArtifactIntegrity } from './lib/contracts.mjs';
import { projectPath, sha256File, writeJsonAtomic } from './lib/media.mjs';
import { buildInspectionSchedule, validateFinalPixelProof } from './lib/visual-qc.mjs';

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function current(project, path, schema) {
  const result = await validateArtifact(projectPath(project, path), schema);
  if (!result.valid) fail('E_FINAL_PROOF_AUTHORITY', `${path} is not current`);
  return result.value;
}
function exactKeys(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'); }

export async function closeFinalProofPasses({ project, capture }) {
  const [sceneSchema, motionMap, timeline, designSystem, lookProfile, assetManifest, dataOverlays] = await Promise.all([
    current(project, 'direction/SCENE_SCHEMA.json', 'scene-schema'), current(project, 'direction/MOTION_MAP.json', 'motion-map'), current(project, 'edit/TIMELINE.json', 'timeline'),
    current(project, 'direction/DESIGN_SYSTEM.json', 'design-system'), current(project, 'direction/LOOK_PROFILE.json', 'look-profile'), current(project, 'direction/ASSET_MANIFEST.json', 'asset-manifest'),
    current(project, 'direction/DATA_OVERLAYS.json', 'data-overlays'),
  ]);
  const provenance = await readJson(projectPath(project, 'renders/final.provenance.json'));
  if (!verifyArtifactIntegrity(provenance).valid || await sha256File(projectPath(project, 'renders/final.mp4')) !== provenance.outputDigest) fail('E_FINAL_PROOF_AUTHORITY', 'final MP4 provenance is stale');
  const authorities = { assetManifest: assetManifest.integrity.digest, dataOverlays: dataOverlays.integrity.digest, designSystem: designSystem.integrity.digest,
    lookProfile: lookProfile.integrity.digest, motionMap: motionMap.integrity.digest, sceneSchema: sceneSchema.integrity.digest, timeline: timeline.integrity.digest };
  if (!exactKeys(capture, ['schemaVersion', 'producerCommand', 'encodedMp4Digest', 'authorities', 'frames']) || capture.schemaVersion !== '1.0.0'
    || capture.producerCommand !== 'hyperframes-paused-runtime' || capture.encodedMp4Digest !== provenance.outputDigest
    || !exactKeys(capture.authorities, Object.keys(authorities)) || Object.entries(authorities).some(([role, digest]) => capture.authorities[role] !== digest)) fail('E_FINAL_PROOF_CAPTURE', 'capture manifest is not bound to the paused HyperFrames runtime and current final authority');
  const transitions = timeline.items.map(({ transition }) => transition).filter(({ kind }) => kind !== 'none').map(({ ownerId }) => {
    const owner = motionMap.owners.find((entry) => entry.ownerId === ownerId); return owner?.transition ? { ...owner.transition, sceneId: owner.sceneId, layerId: owner.layerId } : null;
  }).filter(Boolean);
  const schedule = buildInspectionSchedule({ scenes: sceneSchema.scenes, owners: motionMap.owners, overlays: dataOverlays.overlays, transitions });
  if (!Array.isArray(capture.frames) || capture.frames.length !== schedule.length) fail('E_FINAL_PROOF_CAPTURE', 'capture manifest does not cover the complete inspection schedule');
  const root = `review/final-proof-passes/${provenance.outputDigest}/`;
  const closeReference = async (path) => {
    if (typeof path !== 'string' || !path.startsWith(root)) fail('E_FINAL_PROOF_CAPTURE', 'proof passes must stay inside the encoded-digest directory');
    const absolute = projectPath(project, path); const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) fail('E_FINAL_PROOF_CAPTURE', `${path} is not a regular file`);
    const image = await sharp(absolute).metadata();
    if (image.width !== provenance.raster.width || image.height !== provenance.raster.height) fail('E_FINAL_PROOF_CAPTURE', `${path} does not match the final raster`);
    return { path, digest: await sha256File(absolute) };
  };
  const frames = [];
  for (const [index, frame] of capture.frames.entries()) {
    if (!exactKeys(frame, ['time', 'backgroundPath', 'layerMattes', 'tokenMattes']) || frame.time !== schedule[index].time
      || !Array.isArray(frame.layerMattes) || !Array.isArray(frame.tokenMattes)) fail('E_FINAL_PROOF_CAPTURE', `capture frame ${index} is malformed`);
    frames.push({ time: frame.time, backgroundPass: await closeReference(frame.backgroundPath),
      layerMattes: await Promise.all(frame.layerMattes.map(async ({ layerId, path }) => ({ layerId, ...await closeReference(path) }))),
      tokenMattes: await Promise.all(frame.tokenMattes.map(async ({ tokenName, path, alpha }) => ({ tokenName, alpha, ...await closeReference(path) }))) });
  }
  const documents = { sceneSchema, motionMap, timeline, designSystem, lookProfile, assetManifest, dataOverlays, finalRenderDigest: provenance.integrity.digest };
  const proof = { schemaVersion: '1.0.0', revision: 1, producerCommand: 'render_final_proof_passes.mjs', encodedMp4Digest: provenance.outputDigest,
    authorities, frames, integrity: { digest: null, upstream: { FINAL_RENDER: provenance.integrity.digest } } };
  proof.integrity.digest = computeArtifactDigest(proof);
  validateFinalPixelProof(proof, { encodedMp4Digest: provenance.outputDigest, documents, schedule });
  const output = `${root}PROOF.json`; await writeJsonAtomic(projectPath(project, output), proof);
  return { ok: true, output, digest: proof.integrity.digest, frameCount: frames.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCliArguments(process.argv.slice(2), { project: { required: true }, capture: { key: 'capturePath', required: true } });
    process.stdout.write(`${JSON.stringify(await closeFinalProofPasses({ project: options.project, capture: await readJson(options.capturePath) }))}\n`);
  } catch (error) { process.stdout.write(`${JSON.stringify(errorResult(error))}\n`); process.exitCode = 1; }
}
