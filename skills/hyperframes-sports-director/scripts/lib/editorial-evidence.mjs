import { readFile } from 'node:fs/promises';

import { validateArtifact } from './contracts.mjs';
import { projectPath, readSourceRegistry, sha256File } from './media.mjs';
import { validateShots } from '../validate_shots.mjs';

function invalid(code, message, diagnostics = []) {
  const error = new Error(message);
  error.code = code;
  error.diagnostics = diagnostics;
  return error;
}

async function requiredArtifact(project, portablePath, schemaName) {
  const result = await validateArtifact(projectPath(project, portablePath), schemaName);
  if (!result.valid) throw invalid(`E_${schemaName.toUpperCase().replaceAll('-', '_')}_INVALID`, `${portablePath} is missing, schema-invalid, or integrity-stale`, result.errors);
  return result.value;
}

function sameDigest(role, provided, current) {
  if (provided === undefined) return;
  if (provided?.integrity?.digest !== current?.integrity?.digest) {
    throw invalid('E_EDITORIAL_AUTHORITY_STALE', `${role} does not match current project authority`);
  }
}

export function assertOriginalRegistryOwnership(timeline, sourceRegistry) {
  const registryById = new Map((sourceRegistry?.entries ?? []).map((entry) => [entry.mediaId, entry]));
  for (const item of timeline?.items ?? []) {
    const entry = registryById.get(item.sourceMediaId);
    if (!entry || entry.sourceDigest !== item.sourceReference?.digest) {
      throw invalid('E_ORIGINAL_AUTHORITY', 'final source media ID and digest must resolve in the immutable source registry');
    }
  }
  return true;
}

export async function loadEditorialEvidence({
  project, phase, input, timeline: timelinePath = 'edit/TIMELINE.json',
  provided = {}, requireTimelineIntegrity = false,
}) {
  const projectDocument = await requiredArtifact(project, 'PROJECT.json', 'project');
  const probe = await requiredArtifact(project, 'analysis/PROBE.json', 'probe');
  const transcript = await requiredArtifact(project, 'analysis/TRANSCRIPT.json', 'transcript');
  const timeline = await requiredArtifact(project, timelinePath, 'timeline');
  const actualPhase = phase ?? timeline.phase;
  if (requireTimelineIntegrity && timeline.integrity?.digest === null) throw invalid('E_TIMELINE_INVALID', 'rendering requires an integrity-stamped timeline');
  const shotValidation = await validateShots({ project, shots: 'analysis/SHOTS.jsonl' });
  if (!shotValidation.valid) throw invalid('E_SHOTS_INVALID', 'SHOTS failed current PROBE, SEGMENTS, or evidence validation', shotValidation.errors);
  const shots = shotValidation.value;
  sameDigest('PROBE', provided.probe, probe);
  sameDigest('SHOTS', provided.shots, shots);
  sameDigest('TRANSCRIPT', provided.transcript, transcript);
  sameDigest('TIMELINE', provided.timeline, timeline);
  const sportProfile = JSON.parse(await readFile(new URL(`../../profiles/sports/${projectDocument.profiles.sport}.json`, import.meta.url), 'utf8'));
  let assetManifest;
  let motionMap;
  let sourceRegistry;
  if (actualPhase === 'final') {
    if (!input) throw invalid('E_INPUT_REQUIRED', 'final timeline validation requires the immutable input root');
    assetManifest = await requiredArtifact(project, 'direction/ASSET_MANIFEST.json', 'asset-manifest');
    motionMap = await requiredArtifact(project, 'direction/MOTION_MAP.json', 'motion-map');
    const registryResult = await readSourceRegistry(project, input);
    sourceRegistry = registryResult.registry;
    assertOriginalRegistryOwnership(timeline, sourceRegistry);
  }
  const proxyDigests = [];
  if (actualPhase === 'rough') {
    const probeById = new Map(probe.media.map((entry) => [entry.mediaId, entry]));
    for (const item of timeline.items) {
      const media = probeById.get(item.sourceMediaId);
      if (!media?.proxy || item.sourceReference?.path !== media.proxy.path || item.sourceReference?.digest !== media.sourceDigest) {
        throw invalid('E_PROXY_ENTITY', 'rough source does not resolve the current PROBE proxy entity');
      }
      try {
        proxyDigests.push({ path: media.proxy.path, digest: await sha256File(projectPath(project, media.proxy.path)) });
      } catch {
        throw invalid('E_PROXY_ENTITY', 'rough source proxy is missing or unreadable');
      }
    }
  }
  return {
    project: projectDocument, probe, shots, transcript, timeline,
    profiles: { sport: sportProfile }, assetManifest, motionMap, sourceRegistry, proxyDigests,
  };
}
