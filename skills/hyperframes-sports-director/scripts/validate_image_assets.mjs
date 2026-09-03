#!/usr/bin/env node
/* Copyright (C) 2026 HyperFrames Sports Director contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * HyperFrames visual-asset lineage: see ATTRIBUTIONS.md and UPSTREAM.lock.json.
 */
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { persistAssetStage } from './lib/image-assets.mjs';

const DEFINITIONS = {
  project: { required: true }, stage: { required: true }, manifest: { required: true }, timeline: { required: false },
  'representative-proof-digest': { required: false, key: 'representativeProofDigest' },
};

export async function validateImageAssetProject(options) {
  return persistAssetStage({
    projectRoot: options.project, stage: options.stage, manifestPath: options.manifest,
    timelinePath: options.timeline ?? 'edit/TIMELINE.json', representativeProofDigest: options.representativeProofDigest,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await validateImageAssetProject(parseCliArguments(process.argv.slice(2), DEFINITIONS)))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ ...errorResult(error), diagnostics: error.diagnostics ?? [] })}\n`); process.exitCode = error.code === 'E_USAGE' ? 2 : 1; }
}
