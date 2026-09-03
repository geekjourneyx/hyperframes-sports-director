#!/usr/bin/env node
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { runFfmpeg } from './lib/ffmpeg.mjs';
import { projectPath } from './lib/media.mjs';
import { validateShots } from './validate_shots.mjs';

function timecode(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = Math.floor(milliseconds / 3600000);
  const minutes = Math.floor(milliseconds / 60000) % 60;
  const wholeSeconds = Math.floor(milliseconds / 1000) % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds % 1000).padStart(3, '0')}`;
}

function escapeDrawtext(value) {
  return String(value).replace(/([\\':])/g, '\\$1');
}

async function renderSheet(project, shot, evidenceTimes) {
  const destinationPath = `review/contact-sheets/${shot.shotId}.webp`;
  const destination = projectPath(project, destinationPath);
  await mkdir(dirname(destination), { recursive: true });
  const extension = extname(destination);
  const temporary = `${destination.slice(0, -extension.length)}.${process.pid}.tmp${extension}`;
  const inputs = shot.evidenceFrames.flatMap((frame) => ['-i', projectPath(project, frame)]);
  const filters = shot.evidenceFrames.map((frame, index) => {
    const basename = frame.split('/').at(-1);
    const label = `${shot.shotId} | ${shot.mediaId} | ${shot.segmentId} | ${timecode(evidenceTimes.get(frame))} | ${basename}`;
    return `[${index}:v]scale=320:180:force_original_aspect_ratio=decrease,pad=320:220:0:0:black,drawbox=x=0:y=180:w=320:h=40:color=black@0.94:t=fill,drawtext=text='${escapeDrawtext(label)}':x=6:y=194:fontsize=10:fontcolor=white[f${index}]`;
  });
  filters.push(`${shot.evidenceFrames.map((_, index) => `[f${index}]`).join('')}hstack=inputs=${shot.evidenceFrames.length}[out]`);
  try {
    await runFfmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-frames:v', '1', '-c:v', 'libwebp', '-quality', '82', temporary]);
    await rename(temporary, destination);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
  return destinationPath;
}

export async function buildContactSheets(options) {
  const validation = await validateShots({ project: options.project, shots: options.shots });
  if (!validation.valid) { const error = new Error(`SHOTS validation failed: ${JSON.stringify(validation.errors)}`); error.code = 'E_SHOTS_INVALID'; throw error; }
  const project = options.project;
  const segmentById = new Map(validation.segments.segments.map((segment) => [segment.segmentId, segment]));
  const artifacts = [];
  for (const shot of [...validation.value.shots].sort((left, right) => left.shotId.localeCompare(right.shotId))) {
    const evidenceTimes = new Map(segmentById.get(shot.segmentId).evidenceFrames.map(({ path, sourceTimeSeconds }) => [path, sourceTimeSeconds]));
    artifacts.push(await renderSheet(project, shot, evidenceTimes));
  }
  return { ok: true, contactSheets: artifacts.length, artifacts };
}

const DEFINITIONS = { project: { required: true }, shots: { required: false } };
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(`${JSON.stringify(await buildContactSheets(parseCliArguments(process.argv.slice(2), DEFINITIONS)))}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify(errorResult(error))}\n`); process.exitCode = error.code === 'E_USAGE' ? 2 : 1; }
}
