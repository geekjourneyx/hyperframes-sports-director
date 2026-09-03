#!/usr/bin/env node
/* Copyright (C) 2026 HyperFrames Sports Director contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * HyperFrames visual-asset lineage: see ATTRIBUTIONS.md and UPSTREAM.lock.json.
 */
import { pathToFileURL } from 'node:url';

import { validateCommittedDirection } from './lib/approval.mjs';
import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { assertImageGenerationAuthorized, cropComponentSheet, withProjectAssetDescriptors } from './lib/image-assets.mjs';

const DEFINITIONS = {
  project: { required: true }, stage: { required: true }, source: { required: true }, output: { required: true },
  left: { required: true, type: 'number' }, top: { required: true, type: 'number' },
  width: { required: true, type: 'number' }, height: { required: true, type: 'number' }, padding: { required: true, type: 'number' },
  'display-x': { required: true, type: 'number', key: 'displayX' }, 'display-y': { required: true, type: 'number', key: 'displayY' },
  'display-width': { required: true, type: 'number', key: 'displayWidth' }, 'display-height': { required: true, type: 'number', key: 'displayHeight' },
  'canvas-width': { required: true, type: 'number', key: 'canvasWidth' }, 'canvas-height': { required: true, type: 'number', key: 'canvasHeight' },
};

export async function cropProjectComponent(options) {
  const result = await withProjectAssetDescriptors(options.project, [
    { key: 'projectRoot', portablePath: '', requiredRoot: '', directory: true },
    { key: 'sourcePath', portablePath: options.source, requiredRoot: 'assets/images/source' },
    { key: 'outputPath', portablePath: options.output, requiredRoot: 'assets/images/components' },
  ], async ({ projectRoot, sourcePath, outputPath }) => {
    const committed = await validateCommittedDirection(projectRoot);
    const expectedState = options.stage === 'representative' ? 'STYLE_ANCHOR' : options.stage === 'batch' ? 'ASSET_PRODUCTION' : null;
    if (!expectedState || committed.state.state !== expectedState) {
      const error = new Error('component cropping requires an explicit representative or batch production stage');
      error.code = 'E_ASSET_PRODUCTION_STAGE';
      throw error;
    }
    assertImageGenerationAuthorized({
      projectState: committed.state, design: committed.design, look: committed.look,
      assetPlanDigest: committed.approval.displayedArtifactDigests.assetPlan,
    });
    return cropComponentSheet({
      sourcePath, outputPath, crop: { left: options.left, top: options.top, width: options.width, height: options.height }, padding: options.padding,
      expectedDisplayRect: { x: options.displayX, y: options.displayY, width: options.displayWidth, height: options.displayHeight, canvasWidth: options.canvasWidth, canvasHeight: options.canvasHeight },
    });
  });
  return { ...result, source: options.source, output: options.output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await cropProjectComponent(parseCliArguments(process.argv.slice(2), DEFINITIONS)))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify(errorResult(error))}\n`); process.exitCode = error.code === 'E_USAGE' ? 2 : 1; }
}
