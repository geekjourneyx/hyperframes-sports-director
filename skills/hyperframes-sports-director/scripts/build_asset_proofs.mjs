#!/usr/bin/env node
/* Copyright (C) 2026 HyperFrames Sports Director contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * HyperFrames visual-asset lineage: see ATTRIBUTIONS.md and UPSTREAM.lock.json.
 */
import { pathToFileURL } from 'node:url';

import { validateCommittedDirection } from './lib/approval.mjs';
import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { assertImageGenerationAuthorized, buildAssetProofs, withProjectAssetDescriptors } from './lib/image-assets.mjs';
import { computeArtifactDigest } from './lib/contracts.mjs';

const DEFINITIONS = {
  project: { required: true }, stage: { required: true }, component: { required: true }, basename: { required: true },
  x: { required: true, type: 'number' }, y: { required: true, type: 'number' },
  width: { required: true, type: 'number' }, height: { required: true, type: 'number' },
  'canvas-width': { required: true, type: 'number', key: 'canvasWidth' }, 'canvas-height': { required: true, type: 'number', key: 'canvasHeight' },
};

export async function buildProjectAssetProofs(options) {
  const result = await withProjectAssetDescriptors(options.project, [
    { key: 'projectRoot', portablePath: '', requiredRoot: '', directory: true },
    { key: 'componentPath', portablePath: options.component, requiredRoot: 'assets/images/components' },
    { key: 'outputDirectory', portablePath: 'assets/images/proofs', requiredRoot: 'assets/images/proofs', directory: true },
  ], async ({ projectRoot, componentPath, outputDirectory }) => {
    const committed = await validateCommittedDirection(projectRoot);
    const expectedState = options.stage === 'representative' ? 'STYLE_ANCHOR' : options.stage === 'batch' ? 'ASSET_PRODUCTION' : null;
    if (!expectedState || committed.state.state !== expectedState) {
      const error = new Error('component proof generation requires an explicit representative or batch production stage');
      error.code = 'E_ASSET_PRODUCTION_STAGE';
      throw error;
    }
    assertImageGenerationAuthorized({ projectState: committed.state, design: committed.design, look: committed.look, assetPlanDigest: committed.approval.displayedArtifactDigests.assetPlan });
    return buildAssetProofs({ componentPath, outputDirectory, basename: options.basename,
      directoryIdentity: 'assets/images/proofs',
      displayRect: { x: options.x, y: options.y, width: options.width, height: options.height }, canvas: { width: options.canvasWidth, height: options.canvasHeight } });
  });
  return {
    ...result,
    proofs: Object.fromEntries(Object.entries(result.proofs).map(([kind, proof]) => {
      const portable = { ...proof, path: `assets/images/proofs/${options.basename}-${kind}.png` };
      portable.receiptDigest = null;
      delete portable.receiptDigest;
      portable.receiptDigest = computeArtifactDigest(portable);
      return [kind, portable];
    })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await buildProjectAssetProofs(parseCliArguments(process.argv.slice(2), DEFINITIONS)))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify(errorResult(error))}\n`); process.exitCode = error.code === 'E_USAGE' ? 2 : 1; }
}
