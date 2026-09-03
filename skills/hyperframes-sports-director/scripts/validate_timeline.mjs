#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest } from './lib/contracts.mjs';
import { loadEditorialEvidence } from './lib/editorial-evidence.mjs';
import { projectPath, writeJsonAtomic } from './lib/media.mjs';
import { validateTimeline } from './lib/timeline.mjs';

export async function validateTimelineFile({ project, phase, input, timeline: requestedTimeline = 'edit/TIMELINE.json' }) {
  const timelinePath = projectPath(project, requestedTimeline);
  const evidence = await loadEditorialEvidence({ project, phase, input, timeline: requestedTimeline });
  const { probe, shots, transcript, timeline, assetManifest, motionMap, dataOverlays, profiles } = evidence;
  const result = validateTimeline({
    phase: phase ?? timeline.phase, project, probe, shots, transcript, assetManifest, motionMap, dataOverlays,
    timeline, profiles,
  });
  if (!result.renderable) return { ok: false, ...result, artifact: requestedTimeline };
  timeline.integrity.digest = computeArtifactDigest(timeline);
  await writeJsonAtomic(timelinePath, timeline);
  return { ok: true, ...result, digest: timeline.integrity.digest, artifact: requestedTimeline };
}

const DEFINITIONS = { project: { required: true }, phase: { required: false }, input: { required: false }, timeline: { required: false } };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await validateTimelineFile(parseCliArguments(process.argv.slice(2), DEFINITIONS));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ...errorResult(error), diagnostics: error.diagnostics ?? [] })}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
