#!/usr/bin/env node
import { access, constants, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { computeArtifactDigest, validateArtifact } from './lib/contracts.mjs';
import { errorResult, parseCliArguments } from './lib/cli.mjs';
import { resolvePolicies } from './lib/profiles.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = join(SCRIPT_DIR, '..');
const TEMPLATE_ROOT = join(SKILL_ROOT, 'templates');
const PROJECT_ID = /^[a-z0-9][a-z0-9-]*$/;
const MUSIC_MODES = new Set(['none', 'provided', 'select-local']);
const COPY_MODES = new Set(['none', 'titles', 'captions', 'voiceover-script']);
const JSON_TEMPLATES = {
  'analysis/ACTIVITY.json': 'ACTIVITY',
  'analysis/MEDIA_INDEX.json': 'MEDIA_INDEX',
  'analysis/PROBE.json': 'PROBE',
  'analysis/SEGMENTS.json': 'SEGMENTS',
  'analysis/SHOTS.jsonl': 'SHOT',
  'analysis/SYNC_MAP.json': 'SYNC_MAP',
  'analysis/TRANSCRIPT.json': 'TRANSCRIPT',
  'direction/ASSET_MANIFEST.json': 'ASSET_MANIFEST',
  'direction/BEAT_MAP.json': 'BEAT_MAP',
  'direction/DATA_OVERLAYS.json': 'DATA_OVERLAYS',
  'direction/DESIGN_SYSTEM.json': 'DESIGN_SYSTEM',
  'direction/DIRECTION_PROPOSALS.json': 'DIRECTION_PROPOSALS',
  'direction/DIRECTOR_APPROVAL.json': 'DIRECTOR_APPROVAL',
  'direction/LOOK_PROFILE.json': 'LOOK_PROFILE',
  'direction/MOTION_MAP.json': 'MOTION_MAP',
  'direction/SCENE_SCHEMA.json': 'SCENE_SCHEMA',
  'edit/TIMELINE.json': 'TIMELINE',
};
const DIRECTORIES = [
  'media/originals', 'media/proxies', 'analysis', 'direction', 'edit',
  'assets/images/source', 'assets/images/components', 'assets/images/proofs',
  'renders', 'review/workbench-assets', 'cache',
];

export class ProjectCreationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectCreationError';
    this.code = code;
    Object.assign(this, details);
  }
}

async function readTemplate(name) {
  return JSON.parse(await readFile(join(TEMPLATE_ROOT, `${name}.template.json`), 'utf8'));
}

function stamp(value) {
  value.integrity.digest = computeArtifactDigest(value);
  return value;
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(stamp(value), null, 2)}\n`, { flag: 'wx' });
}

async function ensureReadableInput(input) {
  try {
    const inputStat = await stat(input);
    if (!inputStat.isDirectory()) throw new ProjectCreationError('E_INPUT_NOT_DIRECTORY', 'input must be a readable directory');
    await access(input, constants.R_OK);
  } catch (error) {
    if (error instanceof ProjectCreationError) throw error;
    throw new ProjectCreationError('E_INPUT_UNREADABLE', `input directory is not readable: ${error.message}`);
  }
}

async function destinationEntries(project) {
  try {
    const projectStat = await stat(project);
    if (!projectStat.isDirectory()) return ['<non-directory>'];
    return readdir(project);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function ensureProjectOutsideInput(project, input) {
  const relation = relative(resolve(input), resolve(project));
  if (relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))) {
    throw new ProjectCreationError('E_PROJECT_INPUT_OVERLAP', 'project destination must be outside the immutable input directory');
  }
}

async function resumeProject(options, resolved) {
  const projectPath = join(options.project, 'PROJECT.json');
  const statePath = join(options.project, 'PROJECT_STATE.json');
  const [projectValidation, stateValidation] = await Promise.all([
    validateArtifact(projectPath, 'project'),
    validateArtifact(statePath, 'project-state'),
  ]);
  if (!projectValidation.valid || !stateValidation.valid) {
    throw new ProjectCreationError('E_RESUME_INVALID', 'resume requires integrity-valid PROJECT.json and PROJECT_STATE.json');
  }
  const selection = projectValidation.value.profiles;
  const lineage = projectValidation.value.integrity.upstream;
  if (selection.sport !== resolved.sport || selection.device !== resolved.device
    || selection.delivery !== resolved.delivery || selection.sportMaturity !== resolved.maturity
    || Object.keys(lineage).length !== Object.keys(resolved.profileDigests).length
    || Object.entries(resolved.profileDigests).some(([role, digest]) => lineage[role] !== digest)) {
    throw new ProjectCreationError('E_RESUME_INCOMPATIBLE', 'resume profile selections do not match the existing project');
  }
  return { ok: true, project: options.project, resumed: true, state: stateValidation.value.state };
}

function validateChoices(options) {
  if (!Number.isFinite(options.duration) || options.duration <= 0) throw new ProjectCreationError('E_DURATION', 'duration must be positive');
  if (!MUSIC_MODES.has(options.music)) throw new ProjectCreationError('E_MUSIC_MODE', `unsupported music mode: ${options.music}`);
  if (!Array.isArray(options.copy) || options.copy.length === 0 || options.copy.some((mode) => !COPY_MODES.has(mode))) {
    throw new ProjectCreationError('E_COPY_MODE', 'copy must contain supported modes');
  }
  if (options.copy.includes('none') && options.copy.length > 1) throw new ProjectCreationError('E_COPY_MODE', 'copy mode none cannot be combined');
  if (options.maxSizeMiB !== undefined && (!Number.isFinite(options.maxSizeMiB) || options.maxSizeMiB <= 0)) {
    throw new ProjectCreationError('E_MAX_SIZE', 'max-size-mib must be positive');
  }
  if ((options.inputMode ?? 'reference') !== 'reference') throw new ProjectCreationError('E_INPUT_MODE', 'Task 5 supports reference input mode only');
}

export async function createProject(options) {
  if (options === null || typeof options !== 'object' || !options.project || !options.input) {
    throw new ProjectCreationError('E_OPTIONS', 'project and input are required');
  }
  validateChoices(options);
  await ensureReadableInput(options.input);
  ensureProjectOutsideInput(options.project, options.input);
  const resolved = resolvePolicies({ sport: options.sport, device: options.device, delivery: options.delivery });
  const entries = await destinationEntries(options.project);
  if (entries.length > 0) {
    if (!options.resume) throw new ProjectCreationError('E_DESTINATION_NOT_EMPTY', 'destination is not empty; use --resume for a compatible project');
    return resumeProject(options, resolved);
  }
  if (options.resume) throw new ProjectCreationError('E_RESUME_INVALID', 'resume requires an existing non-empty project');

  const projectId = basename(options.project);
  if (!PROJECT_ID.test(projectId)) throw new ProjectCreationError('E_PROJECT_ID', 'project directory basename must be kebab-case');
  const timestamp = (options.now ?? (() => new Date().toISOString()))();
  if (!Number.isFinite(Date.parse(timestamp))) throw new ProjectCreationError('E_TIMESTAMP', 'clock must return an ISO-8601 timestamp');

  await mkdir(options.project, { recursive: true });
  for (const directory of DIRECTORIES) await mkdir(join(options.project, directory), { recursive: true });

  const projectDocument = await readTemplate('PROJECT');
  Object.assign(projectDocument, {
    projectId,
    createdAt: timestamp,
    updatedAt: timestamp,
    profiles: {
      sport: resolved.sport,
      device: resolved.device,
      delivery: resolved.delivery,
      sportMaturity: resolved.maturity,
    },
  });
  projectDocument.integrity.upstream = { ...resolved.profileDigests };
  await writeJson(join(options.project, 'PROJECT.json'), projectDocument);

  const projectState = await readTemplate('PROJECT_STATE');
  projectState.stateEnteredAt = timestamp;
  await writeJson(join(options.project, 'PROJECT_STATE.json'), projectState);

  const brief = await readTemplate('EDIT_BRIEF');
  const deliveryPolicy = resolved.policies.deliveryPolicy;
  brief.sport.profile = resolved.sport;
  brief.duration = { targetSeconds: options.duration, minSeconds: Math.max(1, options.duration - 30), maxSeconds: options.duration + 30 };
  brief.music.mode = options.music;
  brief.copy.modes = [...new Set(options.copy)];
  Object.assign(brief.delivery, {
    container: deliveryPolicy.container,
    videoCodec: deliveryPolicy.videoCodec,
    audioCodec: deliveryPolicy.audioCodec,
    width: deliveryPolicy.raster.width,
    height: deliveryPolicy.raster.height,
    aspectRatio: deliveryPolicy.aspectRatio,
    maximumFileSizeBytes: options.maxSizeMiB === undefined ? null : Math.round(options.maxSizeMiB * 1024 * 1024),
  });
  await writeJson(join(options.project, 'EDIT_BRIEF.json'), brief);

  for (const [relativePath, templateName] of Object.entries(JSON_TEMPLATES)) {
    await writeJson(join(options.project, relativePath), await readTemplate(templateName));
  }
  await writeJson(join(options.project, 'review/metrics.json'), {
    $schema: 'https://hyperframes.local/schemas/review-metrics.schema.json',
    schemaVersion: '1.0.0',
    revision: 1,
    status: 'unavailable',
    encodedMp4Digest: null,
    metrics: [],
    agentInspection: { status: 'unavailable', evidencePaths: [] },
    integrity: { digest: null, upstream: {} },
  });
  await writeFile(join(options.project, 'direction/BRIEF_DESIGN_PROPOSAL.md'), await readFile(join(TEMPLATE_ROOT, 'BRIEF_DESIGN_PROPOSAL.template.md'), 'utf8'), { flag: 'wx' });
  await writeFile(join(options.project, 'review/REVIEW_REPORT.md'), await readFile(join(TEMPLATE_ROOT, 'REVIEW_REPORT.template.md'), 'utf8'), { flag: 'wx' });
  for (const relativePath of ['renders/rough-cut.mp4', 'renders/final.mp4', 'review/director-workbench.html']) {
    await writeFile(join(options.project, relativePath), '', { flag: 'wx' });
  }
  return { ok: true, project: options.project, resumed: false, state: 'INTAKE' };
}

const CLI_DEFINITIONS = {
  project: { required: true },
  input: { required: true },
  sport: { required: true },
  device: { required: true },
  delivery: { required: true },
  duration: { required: true, type: 'number' },
  music: { required: true },
  copy: { required: true, type: 'list' },
  'max-size-mib': { key: 'maxSizeMiB', type: 'number' },
  resume: { type: 'boolean' },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await createProject(parseCliArguments(process.argv.slice(2), CLI_DEFINITIONS));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResult(error))}\n`);
    process.exitCode = error.code === 'E_USAGE' ? 2 : 1;
  }
}
