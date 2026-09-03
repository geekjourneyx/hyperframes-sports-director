#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REQUIRED_FILTERS = ['blackdetect', 'freezedetect', 'silencedetect', 'ebur128', 'ssim'];
const STABILIZATION_FILTERS = ['vidstabdetect', 'vidstabtransform'];

function normalizedVersion(output, name) {
  const match = new RegExp(`${name} version\\s+([^\\s]+)`, 'i').exec(output);
  return match?.[1] ?? null;
}

function normalizedNodeVersion(value) {
  return String(value).replace(/^v/, '').split('-')[0];
}

function compatibleNode(value) {
  const [major, minor, patch] = normalizedNodeVersion(value).split('.').map(Number);
  return Number.isInteger(major) && Number.isInteger(minor) && Number.isInteger(patch)
    && (major > 22 || (major === 22 && (minor > 12 || (minor === 12 && patch >= 0))));
}

async function defaultRunCommand(command, args) {
  return execFileAsync(command, args, { encoding: 'utf8' });
}

async function defaultResolveSharp() {
  try {
    const sharp = await import('sharp');
    return { version: sharp.default?.versions?.sharp ?? sharp.versions?.sharp ?? 'unknown' };
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw error;
  }
}

async function defaultPathExists(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function checkInstall(dependencies = {}) {
  const nodeVersion = dependencies.nodeVersion ?? process.version;
  const runCommand = dependencies.runCommand ?? defaultRunCommand;
  const resolveSharp = dependencies.resolveSharp ?? defaultResolveSharp;
  const pathExists = dependencies.pathExists ?? defaultPathExists;
  const errors = [];
  const warnings = [];
  const versions = { node: normalizedNodeVersion(nodeVersion), ffmpeg: null, ffprobe: null, sharp: null };
  const filters = Object.fromEntries([...REQUIRED_FILTERS, ...STABILIZATION_FILTERS].map((filter) => [filter, false]));

  if (!compatibleNode(nodeVersion)) {
    errors.push({ code: 'E_NODE_VERSION', required: '>=22.12.0', detected: versions.node });
  }

  let ffmpegAvailable = false;
  try {
    const result = await runCommand('ffmpeg', ['-version']);
    versions.ffmpeg = normalizedVersion(result.stdout, 'ffmpeg');
    ffmpegAvailable = true;
  } catch (error) {
    errors.push({ code: 'E_FFMPEG_MISSING', message: error.message });
  }
  try {
    const result = await runCommand('ffprobe', ['-version']);
    versions.ffprobe = normalizedVersion(result.stdout, 'ffprobe');
  } catch (error) {
    errors.push({ code: 'E_FFPROBE_MISSING', message: error.message });
  }

  if (ffmpegAvailable) {
    try {
      const result = await runCommand('ffmpeg', ['-filters']);
      for (const filter of Object.keys(filters)) {
        filters[filter] = new RegExp(`(^|\\s)${filter}(\\s|$)`, 'm').test(result.stdout);
      }
      for (const filter of REQUIRED_FILTERS) {
        if (!filters[filter]) errors.push({ code: 'E_FFMPEG_FILTER_MISSING', filter });
      }
      const missingStabilization = STABILIZATION_FILTERS.filter((filter) => !filters[filter]);
      if (missingStabilization.length > 0) {
        warnings.push({
          code: 'W_STABILIZATION_FALLBACK',
          capability: 'vidstab',
          fallback: 'conservative-non-vidstab-stabilization',
          missingFilters: missingStabilization,
        });
      }
    } catch (error) {
      errors.push({ code: 'E_FFMPEG_FILTER_CHECK', message: error.message });
    }
  }

  try {
    const sharp = await resolveSharp();
    if (sharp === null) errors.push({ code: 'E_SHARP_MISSING' });
    else versions.sharp = sharp.version;
  } catch (error) {
    errors.push({ code: error?.code === 'ERR_DLOPEN_FAILED' ? 'E_SHARP_LOAD' : 'E_SHARP_CHECK_FAILED', message: error.message });
  }

  const scaffoldPaths = {
    hyperframesProject: join(SCRIPT_DIR, '..', 'assets', 'hyperframes-project'),
    directorWorkbench: join(SCRIPT_DIR, '..', 'assets', 'director-workbench'),
  };
  const scaffolds = {
    hyperframesProject: await pathExists(scaffoldPaths.hyperframesProject),
    directorWorkbench: await pathExists(scaffoldPaths.directorWorkbench),
  };
  if (!scaffolds.hyperframesProject) errors.push({ code: 'E_HYPERFRAMES_SCAFFOLD_MISSING' });
  if (!scaffolds.directorWorkbench) errors.push({ code: 'E_DIRECTOR_WORKBENCH_SCAFFOLD_MISSING' });

  return { ok: errors.length === 0, versions, filters, scaffolds, warnings, errors };
}

export async function runCheckInstallCli(argv, dependencies, write = (text) => process.stdout.write(text)) {
  if (argv.length !== 1 || argv[0] !== '--json') {
    write(`${JSON.stringify({ ok: false, errors: [{ code: 'E_USAGE', message: 'usage: check_install.mjs --json' }], warnings: [] })}\n`);
    return 2;
  }
  let result;
  try {
    result = await checkInstall(dependencies);
  } catch (error) {
    result = {
      ok: false,
      versions: { node: null, ffmpeg: null, ffprobe: null, sharp: null },
      filters: {},
      scaffolds: {},
      warnings: [],
      errors: [{ code: 'E_CAPABILITY_CHECK', message: error instanceof Error ? error.message : String(error) }],
    };
  }
  write(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCheckInstallCli(process.argv.slice(2));
}
