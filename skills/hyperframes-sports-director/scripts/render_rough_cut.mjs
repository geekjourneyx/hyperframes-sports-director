import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { loadEditorialEvidence } from './lib/editorial-evidence.mjs';
import { ffprobeJson, runFfmpeg } from './lib/ffmpeg.mjs';
import { projectPath, sha256File, writeJsonAtomic } from './lib/media.mjs';
import { compileRoughRenderPlan } from './lib/render-plan.mjs';
import { validateTimeline } from './lib/timeline.mjs';

function closedProbeSummary(probe) {
  const streams = probe?.streams ?? [];
  const video = streams.find(({ codec_type: type }) => type === 'video');
  const audio = streams.find(({ codec_type: type }) => type === 'audio');
  return {
    valid: Boolean(video && audio && Number(probe?.format?.duration) > 0),
    durationSeconds: Number(probe?.format?.duration),
    width: video?.width ?? null, height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null, audioCodec: audio?.codec_name ?? null,
  };
}

export async function renderRoughCut({ project, probe, shots, transcript, timeline, profiles, width = 960, height = 540 }) {
  const output = projectPath(project, 'renders/rough-cut.mp4');
  const temporary = projectPath(project, `renders/.rough-cut.${process.pid}.tmp.mp4`);
  let plan;
  try {
    const evidence = await loadEditorialEvidence({
      project, phase: 'rough', requireTimelineIntegrity: true,
      provided: { probe, shots, transcript, timeline },
    });
    ({ probe, shots, transcript, timeline, profiles } = evidence);
    const validation = validateTimeline({ phase: 'rough', project, probe, shots, transcript, timeline, profiles });
    if (!validation.renderable) {
      const error = new Error('rough timeline has hard errors or unresolved Agent warnings');
      error.code = validation.errors[0]?.code ?? 'E_AGENT_DECISION_REQUIRED';
      error.diagnostics = { errors: validation.errors, warnings: validation.undecidedWarnings };
      throw error;
    }
    await mkdir(dirname(output), { recursive: true });
    plan = await compileRoughRenderPlan({ project, probe, timeline, width, height, outputPath: temporary });
    await runFfmpeg(plan.args.slice(0, -1).concat(temporary));
    const handle = await open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    const rawProbe = await ffprobeJson(temporary);
    const closedFileProbe = closedProbeSummary(rawProbe);
    if (!closedFileProbe.valid) {
      const error = new Error('closed rough cut must re-probe with video, audio, and positive duration');
      error.code = 'E_ROUGH_CLOSED_PROBE';
      throw error;
    }
    const outputDigest = await sha256File(temporary);
    await rename(temporary, output);
    const metadata = {
      schemaVersion: '1.0.0', revision: timeline.revision, stateAuthority: 'ROUGH_CUT',
      artifact: 'renders/rough-cut.mp4', outputDigest, closedFileProbe,
      raster: plan.raster, watermark: plan.watermark, preservesAudio: plan.preservesAudio,
      integrity: {
        timelineDigest: timeline.integrity?.digest ?? null,
        probeDigest: probe.integrity?.digest ?? null,
        proxyDigests: plan.proxyDigests,
        musicDigest: plan.musicDigest,
      },
    };
    await writeJsonAtomic(projectPath(project, 'renders/rough-cut.json'), metadata);
    return { ok: true, artifact: metadata.artifact, outputDigest, closedFileProbe, integrity: metadata.integrity };
  } catch (error) {
    try { await unlink(temporary); } catch {}
    throw error;
  }
}

export async function roughCutIsCurrent({ project, timeline, probe }) {
  try {
    const metadata = JSON.parse(await readFile(projectPath(project, 'renders/rough-cut.json'), 'utf8'));
    if (metadata.stateAuthority !== 'ROUGH_CUT' || metadata.integrity.timelineDigest !== timeline.integrity?.digest
      || metadata.integrity.probeDigest !== probe.integrity?.digest || !metadata.closedFileProbe?.valid) return false;
    if (await sha256File(projectPath(project, metadata.artifact)) !== metadata.outputDigest) return false;
    const mediaByPath = new Map(probe.media.filter(({ proxy }) => proxy).map(({ proxy }) => [proxy.path, proxy]));
    for (const entry of metadata.integrity.proxyDigests ?? []) {
      if (!mediaByPath.has(entry.path) || await sha256File(projectPath(project, entry.path)) !== entry.digest) return false;
    }
    if (metadata.integrity.musicDigest
      && await sha256File(projectPath(project, metadata.integrity.musicDigest.path)) !== metadata.integrity.musicDigest.digest) return false;
    return true;
  } catch {
    return false;
  }
}

export async function assertRoughCutCurrentForDirectorReview(options) {
  if (!(await roughCutIsCurrent(options))) {
    const error = new Error('stale rough cut cannot advance to DIRECTOR_REVIEW_READY');
    error.code = 'E_ROUGH_CUT_STALE';
    throw error;
  }
  return true;
}

const DEFINITIONS = { project: { required: true }, width: { required: false }, height: { required: false } };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseCliArguments(process.argv.slice(2), DEFINITIONS);
    process.stdout.write(`${JSON.stringify(await renderRoughCut({ ...options, width: Number(options.width ?? 960), height: Number(options.height ?? 540) }))}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
