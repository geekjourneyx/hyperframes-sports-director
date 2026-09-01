import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { computeArtifactDigest, loadSchema, validateArtifact, validateDocument, verifyArtifactIntegrity } from './lib/contracts.mjs';
import { projectPath, writeJsonAtomic } from './lib/media.mjs';
import { validateTimeline } from './lib/timeline.mjs';

function invalid(code, message, diagnostics = []) {
  const error = new Error(message);
  error.code = code;
  error.diagnostics = diagnostics;
  return error;
}

async function readRequiredArtifact(project, portablePath, schemaName) {
  const result = await validateArtifact(projectPath(project, portablePath), schemaName);
  if (!result.valid) throw invalid(`E_${schemaName.toUpperCase().replaceAll('-', '_')}_INVALID`, `${portablePath} is missing or invalid`, result.errors);
  return result.value;
}

export async function validateTimelineFile({ project, phase, timeline: requestedTimeline = 'edit/TIMELINE.json' }) {
  const timelinePath = projectPath(project, requestedTimeline);
  const timeline = JSON.parse(await readFile(timelinePath, 'utf8'));
  const schemaValidation = validateDocument(await loadSchema('timeline'), timeline);
  if (!schemaValidation.valid) throw invalid('E_TIMELINE_SCHEMA', 'timeline contract is invalid', schemaValidation.errors);
  const existingIntegrity = verifyArtifactIntegrity(timeline);
  if (timeline.integrity.digest !== null && !existingIntegrity.valid) throw invalid(existingIntegrity.code, 'timeline integrity is stale');
  const probe = await readRequiredArtifact(project, 'analysis/PROBE.json', 'probe');
  const shots = await readRequiredArtifact(project, 'analysis/SHOTS.jsonl', 'shot');
  const transcript = await readRequiredArtifact(project, 'analysis/TRANSCRIPT.json', 'transcript');
  const projectDocument = await readRequiredArtifact(project, 'PROJECT.json', 'project');
  const sportProfile = JSON.parse(await readFile(new URL(`../profiles/sports/${projectDocument.profiles.sport}.json`, import.meta.url), 'utf8'));
  let assetManifest;
  let motionMap;
  if ((phase ?? timeline.phase) === 'final') {
    assetManifest = await readRequiredArtifact(project, 'direction/ASSET_MANIFEST.json', 'asset-manifest');
    motionMap = await readRequiredArtifact(project, 'direction/MOTION_MAP.json', 'motion-map');
  }
  const result = validateTimeline({
    phase: phase ?? timeline.phase, project, probe, shots, transcript, assetManifest, motionMap,
    timeline, profiles: { sport: sportProfile },
  });
  if (!result.renderable) return { ok: false, ...result, artifact: requestedTimeline };
  timeline.integrity.digest = computeArtifactDigest(timeline);
  await writeJsonAtomic(timelinePath, timeline);
  return { ok: true, ...result, digest: timeline.integrity.digest, artifact: requestedTimeline };
}

const DEFINITIONS = { project: { required: true }, phase: { required: false }, timeline: { required: false } };
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
