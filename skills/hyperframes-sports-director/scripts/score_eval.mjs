#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadSchema, validateDocument, verifyArtifactIntegrity } from './lib/contracts.mjs';
import { materializeGoldenProjects } from '../evals/fixtures/generate-fixtures.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const skillRoot = resolve(dirname(scriptPath), '..');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateReleaseRubric(rubric) {
  const release = rubric?.release_scoring;
  if (!isObject(release) || !Array.isArray(release.categories) || !Array.isArray(release.required_hard_gates)) throw new Error('E_RELEASE_RUBRIC');
  if (release.categories.reduce((sum, item) => sum + Number(item.points), 0) !== 100) throw new Error('E_RELEASE_WEIGHTS');
  if (!Number.isFinite(release.passing_score) || !Number.isFinite(release.minimum_category_ratio)) throw new Error('E_RELEASE_THRESHOLDS');
  for (const category of release.categories) {
    if (!Array.isArray(category.checks) || category.checks.reduce((sum, check) => sum + Number(check.points), 0) !== category.points
      || category.checks.some((check) => !['metric', 'evidence'].includes(check.source) || typeof check.id !== 'string' || !Number.isFinite(check.points))) {
      throw new Error(`E_RELEASE_CATEGORY:${category.id}`);
    }
  }
  return release;
}

export function scoreEvaluation(evaluation, rubric) {
  const release = validateReleaseRubric(rubric);
  const metricStatus = new Map((evaluation?.metrics?.metrics ?? []).map((record) => [record.metricId, record.status]));
  const evidenceChecks = new Set(evaluation?.evidenceChecks ?? []);
  const categories = release.categories.map((category) => {
    const awardedPoints = category.checks.reduce((sum, check) => {
      const passed = check.source === 'metric' ? metricStatus.get(check.id) === 'pass' : evidenceChecks.has(check.id);
      return sum + (passed ? check.points : 0);
    }, 0);
    return { id: category.id, awardedPoints, availablePoints: category.points, ratio: awardedPoints / category.points };
  });
  const total = categories.reduce((sum, { awardedPoints }) => sum + awardedPoints, 0);
  const suppliedGates = new Map((evaluation?.hardGates ?? []).map((gate) => [gate.id, gate.status]));
  const hardGates = release.required_hard_gates.filter((id) => suppliedGates.get(id) !== 'pass');
  if (evaluation?.metrics?.status !== 'accepted') hardGates.push('review-metrics-status');
  if (evaluation?.profileMaturity !== release.required_profile_maturity) hardGates.push('profile-maturity');
  if (evaluation?.projectState?.state !== 'DELIVERED') hardGates.push('delivered-state');
  if (evaluation?.agentReview?.status !== release.required_agent_inspection) hardGates.push('agent-visual-review');
  for (const field of release.required_human_reviews) {
    if (evaluation?.humanReviews?.[field]?.status !== 'accepted') hardGates.push(`human-review-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  }
  const thresholdFailures = [];
  if (total < release.passing_score) thresholdFailures.push(`total-below-${release.passing_score}`);
  for (const category of categories) {
    if (category.ratio < release.minimum_category_ratio) thresholdFailures.push(`${category.id}-below-${Math.round(release.minimum_category_ratio * 100)}-percent`);
  }
  const normalizedHardGates = [...new Set(hardGates)].sort();
  return { categories, total, hardGates: normalizedHardGates, thresholdFailures, releaseEligible: normalizedHardGates.length === 0 && thresholdFailures.length === 0 };
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safePath(root, portable) {
  if (typeof portable !== 'string' || !portable || portable.startsWith('/') || portable.includes('\\')) throw new Error('E_EVIDENCE_PATH');
  const path = resolve(root, portable);
  if (relative(root, path).startsWith('..')) throw new Error('E_EVIDENCE_PATH');
  return path;
}

async function verifiedJson(root, reference) {
  if (!isObject(reference) || !/^[0-9a-f]{64}$/.test(reference.sha256 ?? '')) throw new Error('E_EVIDENCE_REFERENCE');
  const path = safePath(root, reference.path);
  const metadata = await lstat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error(`E_EVIDENCE_MISSING:${reference.path}`);
  const bytes = await readFile(path);
  if (hash(bytes) !== reference.sha256) throw new Error(`E_EVIDENCE_DIGEST:${reference.path}`);
  return JSON.parse(bytes);
}

export async function loadReleaseEvaluation(metricsPath) {
  const absoluteMetrics = resolve(metricsPath);
  const projectRoot = resolve(dirname(absoluteMetrics), '..');
  const envelope = JSON.parse(await readFile(join(projectRoot, 'review/release-eval.json'), 'utf8'));
  if (envelope.schemaVersion !== '1.0.0' || !isObject(envelope.references)) throw new Error('E_RELEASE_ENVELOPE');
  const metrics = await verifiedJson(projectRoot, envelope.references.metrics);
  if (resolve(projectRoot, envelope.references.metrics.path) !== absoluteMetrics) throw new Error('E_METRICS_REFERENCE');
  const metricsSchema = await loadSchema('review-metrics');
  if (!validateDocument(metricsSchema, metrics).valid || !verifyArtifactIntegrity(metrics).valid) throw new Error('E_METRICS_INTEGRITY');
  const projectState = await verifiedJson(projectRoot, envelope.references.projectState);
  const stateSchema = await loadSchema('project-state');
  if (!validateDocument(stateSchema, projectState).valid || !verifyArtifactIntegrity(projectState).valid) throw new Error('E_PROJECT_STATE_INTEGRITY');
  const hardGateEvidence = await verifiedJson(projectRoot, envelope.references.hardGates);
  const agentReview = await verifiedJson(projectRoot, envelope.references.agentReview);
  const workbenchReview = await verifiedJson(projectRoot, envelope.references.workbenchReview);
  const finalVideoReview = await verifiedJson(projectRoot, envelope.references.finalVideoReview);
  const finalPath = safePath(projectRoot, envelope.references.finalMp4.path);
  const finalMetadata = await lstat(finalPath).catch(() => null);
  if (!finalMetadata?.isFile() || finalMetadata.isSymbolicLink()) throw new Error('E_FINAL_MP4_MISSING');
  const finalDigest = hash(await readFile(finalPath));
  if (finalDigest !== envelope.references.finalMp4.sha256 || metrics.encodedMp4Digest !== finalDigest) throw new Error('E_FINAL_MP4_DIGEST');
  if (hardGateEvidence.encodedMp4Digest !== finalDigest || agentReview.encodedMp4Digest !== finalDigest || finalVideoReview.encodedMp4Digest !== finalDigest) throw new Error('E_REVIEW_MP4_BINDING');
  const workbenchPath = safePath(projectRoot, envelope.references.workbench.path);
  const workbenchMetadata = await lstat(workbenchPath).catch(() => null);
  if (!workbenchMetadata?.isFile() || workbenchMetadata.isSymbolicLink()) throw new Error('E_WORKBENCH_MISSING');
  const workbenchDigest = hash(await readFile(workbenchPath));
  if (workbenchDigest !== envelope.references.workbench.sha256 || workbenchReview.workbenchDigest !== workbenchDigest) throw new Error('E_WORKBENCH_DIGEST');
  const deliveredEvidence = projectState.gateEvidence?.findLast(({ gate, role, validity }) => gate === 'DELIVERED' && role === 'ENCODED_MP4_EVIDENCE' && validity === 'valid');
  if (deliveredEvidence?.digest !== finalDigest) throw new Error('E_DELIVERY_BINDING');
  return {
    metrics,
    projectState,
    profileMaturity: envelope.profileMaturity,
    hardGates: Array.isArray(hardGateEvidence.gates) ? hardGateEvidence.gates : [],
    evidenceChecks: hardGateEvidence.checks,
    agentReview,
    humanReviews: { workbench: workbenchReview, finalVideo: finalVideoReview },
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function parseArgs(argv) {
  const args = { json: false, allGolden: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--json') args.json = true;
    else if (value === '--all-golden') args.allGolden = true;
    else if (value === '--metrics') args.metrics = argv[++index];
    else if (value === '--rubric') args.rubric = argv[++index];
    else throw new Error(`E_ARGUMENT:${value}`);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const rubric = await readJson(resolve(args.rubric ?? join(skillRoot, 'evals/rubric.json')));
  let output;
  if (args.allGolden) {
    const workspace = await mkdtemp(join(tmpdir(), 'hf-golden-eval-'));
    try {
      const projects = await materializeGoldenProjects(workspace, { fixtureRoot: join(skillRoot, 'evals/fixtures/projects') });
      const results = [];
      for (const [profile, project] of Object.entries(projects)) results.push({ profile, ...scoreEvaluation(await loadReleaseEvaluation(join(project, 'review/metrics.json')), rubric) });
      output = { results, releaseEligible: results.every((result) => result.releaseEligible) };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  } else {
    if (!args.metrics) throw new Error('E_METRICS_REQUIRED');
    output = scoreEvaluation(await loadReleaseEvaluation(resolve(args.metrics)), rubric);
  }
  process.stdout.write(`${JSON.stringify(output, null, args.json ? 2 : 0)}\n`);
  if (!output.releaseEligible) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
