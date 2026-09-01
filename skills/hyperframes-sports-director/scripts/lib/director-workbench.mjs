import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, join } from 'node:path';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';

import { computeArtifactDigest, loadSchema, validateDocument, verifyArtifactIntegrity } from './contracts.mjs';
import { loadDirectionSources, validateDirectionProposals } from './direction-proposals.mjs';
import { projectPath, sha256File } from './media.mjs';

const ASSET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'director-workbench');
const TEMPLATE = await readFile(join(ASSET_ROOT, 'index.template.html'), 'utf8');
const WORKBENCH_CSS = await readFile(join(ASSET_ROOT, 'workbench.css'), 'utf8');
const WORKBENCH_JS = await readFile(join(ASSET_ROOT, 'workbench.js'), 'utf8');
const CHROME = Object.freeze({
  background: '#050505', surface: '#0D0D0D', surfaceRaised: '#141414', textPrimary: '#F5F2EA',
  textSecondary: '#A8A29A', accent: '#C9A86A', danger: '#E36B5D', line: '#2A2A2A',
});
const STAGES = [
  'INTAKE', 'CAPABILITY_CHECK', 'SCAN', 'ANALYZE', 'ROUGH_CUT', 'DIRECTOR_REVIEW_READY',
  'DIRECTOR_LOCK', 'STYLE_ANCHOR', 'ASSET_PRODUCTION', 'MOTION_COMPOSITION',
  'FINAL_RENDER', 'FINAL_QA', 'DELIVERED', 'USER_ACCEPTED',
];
const TERMINAL_STAGES = new Set(['BLOCKED', 'CANCELLED']);
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'],
]);

export class DirectorWorkbenchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DirectorWorkbenchError';
    this.code = code;
    Object.assign(this, details);
  }
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function reviewUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('review/workbench-assets/')) {
    throw new DirectorWorkbenchError('E_REVIEW_REFERENCE', 'workbench media must be a review derivative');
  }
  return path.slice('review/'.length).split('/').map(encodeURIComponent).join('/');
}

function compactTime(seconds) {
  const whole = Math.max(0, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function candidateStyle(candidate) {
  const colors = candidate.designCandidate.semanticColors;
  return [
    `--candidate-canvas:${colors.canvas}`, `--candidate-ink:${colors.ink}`,
    `--candidate-accent:${colors.accent}`, `--candidate-signal:${colors.signal}`,
  ].join(';');
}

function list(items) {
  return items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderCandidateEvidenceRibbon(keyFrames) {
  return `<div class="candidate-evidence-ribbon" style="--candidate-evidence-count:${keyFrames.length}" aria-label="Shared review-safe evidence">${keyFrames.map((frame) => `<img class="candidate-evidence-frame" src="${reviewUrl(frame.path)}" alt="Shared review frame ${escapeHtml(frame.frameId)}" data-candidate-evidence-id="${escapeHtml(frame.frameId)}">`).join('')}</div>`;
}

function renderStage(candidate, index, keyFrames) {
  const active = index === 0 ? ' is-active' : '';
  return `<section class="direction-stage${active}" data-candidate-stage="${escapeHtml(candidate.candidateId)}">
  <header class="stage-heading">
    <div><span class="eyebrow">Direction ${String(index + 1).padStart(2, '0')} · Whole proposal</span><h1>${escapeHtml(candidate.title)}</h1></div>
    <p class="stage-thesis">${escapeHtml(candidate.thesis)}</p>
  </header>
  <div>
    <div class="direction-canvas" style="${candidateStyle(candidate)}">
      ${renderCandidateEvidenceRibbon(keyFrames)}
      <div class="candidate-frame"></div><span class="candidate-index">HF / ${escapeHtml(candidate.candidateId.toUpperCase())}</span>
      <span class="candidate-rule"></span><strong class="candidate-title">${escapeHtml(candidate.copy[0])}</strong>
      <span class="candidate-timecode">${escapeHtml(candidate.copy[1] ?? 'DIRECTION PROTOTYPE')}</span>
    </div>
    <div class="canvas-meta"><span>${candidate.viewport.width} × ${candidate.viewport.height}</span><span>${candidate.informationDensityBudget.maximumSimultaneousLayers} layers / ${candidate.informationDensityBudget.maximumWordsPerFrame} words</span><span>Code-rendered prototype</span></div>
  </div>
  <dl class="stage-ledger">
    <div class="ledger-row"><dt>Visual world</dt><dd>${escapeHtml(candidate.visualWorldPlan.statement)}</dd></div>
    <div class="ledger-row"><dt>Look</dt><dd>${escapeHtml(candidate.lookCandidate.treatment)} · ${escapeHtml(candidate.lookCandidate.grain)} grain</dd></div>
    <div class="ledger-row"><dt>Typography</dt><dd>${escapeHtml(candidate.typographyHierarchy.join(' / '))}</dd></div>
    <div class="ledger-row"><dt>Evidence parity</dt><dd>${escapeHtml(candidate.representativeEvidenceIds.join(' · '))}</dd></div>
  </dl>
</section>`;
}

function renderCandidateTab(candidate, index) {
  return `<button class="candidate-tab" type="button" data-candidate-tab="${escapeHtml(candidate.candidateId)}" aria-selected="${index === 0}"><span>Direction ${String(index + 1).padStart(2, '0')}</span><strong>${escapeHtml(candidate.title)}</strong></button>`;
}

function renderCandidateProof(candidate, kind, path, proofIndex) {
  return `<figure class="candidate-proof"><img class="candidate-proof-image" src="${reviewUrl(path)}" alt="${escapeHtml(candidate.title)} ${kind} proof ${proofIndex + 1}"><figcaption><span>${escapeHtml(kind.toUpperCase())} PROOF ${String(proofIndex + 1).padStart(2, '0')}</span><span>Review-safe derivative</span></figcaption></figure>`;
}

function renderCandidateStoryDetail(candidate, index, brief) {
  const active = index === 0 ? ' is-active' : '';
  return `<section class="candidate-detail candidate-story-detail${active}" data-candidate-detail="${escapeHtml(candidate.candidateId)}">
  <div class="story-columns">${candidate.storyStructure.map((chapter, chapterIndex) => `<article class="story-column"><span class="section-label">0${chapterIndex + 1}</span><h3>${escapeHtml(chapter)}</h3><p>${escapeHtml(brief.story.emphasis[chapterIndex] ?? 'Editorial beat held by current shot evidence.')}</p></article>`).join('')}</div>
  <section class="candidate-proof-strip" aria-label="${escapeHtml(candidate.title)} direction proofs">${candidate.layoutProofs.map((path, proofIndex) => renderCandidateProof(candidate, 'layout', path, proofIndex)).join('')}${candidate.motionStoryboard.map((path, proofIndex) => renderCandidateProof(candidate, 'motion storyboard', path, proofIndex)).join('')}</section>
</section>`;
}

function renderCandidateRailDetail(candidate, index) {
  const active = index === 0 ? ' is-active' : '';
  const components = [...new Set(candidate.componentPlan.components)];
  const heroes = [...new Set(candidate.componentPlan.heroAssets)];
  return `<div class="candidate-detail candidate-rail-detail${active}" data-candidate-detail="${escapeHtml(candidate.candidateId)}">
    <section class="rail-section"><h3>STORY ARC</h3><ul class="rail-list">${list(candidate.storyStructure)}</ul></section>
    <section class="rail-section"><h3>VISUAL WORLD</h3><p class="rail-copy">${escapeHtml(candidate.visualWorldPlan.statement)}</p><ul class="rail-list">${list(candidate.visualWorldPlan.plannedAssets)}</ul></section>
    <section class="rail-section"><h3>COMPONENT / HERO PLAN</h3><p class="rail-copy">Components</p><ul class="rail-list">${list(components)}</ul><p class="rail-copy">Hero</p><ul class="rail-list">${list(heroes)}</ul></section>
    <section class="rail-section"><h3>RISKS</h3><ul class="rail-list risk-list">${list(candidate.risks)}</ul></section>
  </div>`;
}

function renderApprovalZone(candidate) {
  return `<section class="approval-zone"><span class="section-label">SINGLE APPROVAL GATE</span><h2 data-selected-candidate-label>${escapeHtml(candidate.title)}</h2><p>One approval records the selected whole direction. This records evidence only; design and Look lock remain a separate transaction.</p><button class="approve-button" type="button" data-approve>Approve ${escapeHtml(candidate.title)}</button><div class="approval-result" data-approval-result aria-live="polite"></div></section>`;
}

function renderKeyframe(frame, index) {
  return `<figure class="keyframe"><img src="${reviewUrl(frame.path)}" alt="Review-safe key frame ${index + 1}"><figcaption><span>${escapeHtml(frame.frameId)}</span><span>${compactTime(frame.sourceTimeSeconds)}</span></figcaption></figure>`;
}

function renderTimelineItem(item, total) {
  const duration = Math.max(0.01, item.destinationOutSeconds - item.destinationInSeconds);
  const basis = Math.max(8, (duration / total) * 100);
  return `<div class="timeline-clip" style="flex-basis:${basis.toFixed(3)}%"><strong>${escapeHtml(item.itemId)}</strong><br>${compactTime(item.destinationInSeconds)}–${compactTime(item.destinationOutSeconds)}</div>`;
}

function renderCurrentGateEvidence(model) {
  const records = model.currentGateEvidence ?? [];
  if (!records.length) return '';
  return `<section class="rail-section"><h3>CURRENT GATE EVIDENCE</h3><p class="rail-copy">${escapeHtml(model.state.state.replaceAll('_', ' '))} · revision ${model.state.revision}</p><ul class="rail-list">${records.map(({ role, digest }) => `<li>${escapeHtml(role.replaceAll('_', ' '))} · ${escapeHtml(digest.slice(0, 12))}</li>`).join('')}</ul></section>`;
}

function tokenStyle() {
  return Object.entries(CHROME).map(([key, value]) => `--hf-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value}`).join(';');
}

function renderContent(model) {
  const active = model.proposals.candidates[0];
  const total = Math.max(...model.timeline.items.map(({ destinationOutSeconds }) => destinationOutSeconds), 1);
  const locked = typeof model.lockedBinding === 'string';
  const terminal = TERMINAL_STAGES.has(model.state.state);
  const currentStage = terminal ? model.state.previousState : model.state.state;
  const stageIndex = Math.max(0, STAGES.indexOf(currentStage));
  const gateLabel = locked ? 'DIRECTOR LOCK' : 'DIRECTOR REVIEW';
  const gateNote = locked ? 'Read-only' : 'One approval';
  return `<main class="workbench-shell">
  <div class="director-deck">
    <header class="topline"><div class="wordmark"><span class="wordmark-mark"></span><span>HyperFrames / Director Workbench</span></div><span class="gate-stamp">Gate <strong>${gateLabel}</strong> · ${gateNote}</span></header>
    ${model.proposals.candidates.map((candidate, index) => renderStage(candidate, index, model.keyFrames)).join('\n')}
    <nav class="candidate-filmstrip" style="--candidate-count:${model.proposals.candidates.length}" aria-label="Whole direction candidates">${model.proposals.candidates.map(renderCandidateTab).join('')}</nav>
    <section class="evidence-room">
      <header class="evidence-room-header"><div><span class="section-label">Evidence rail 01</span><h2>KEY FRAMES</h2></div><span class="gate-stamp">Same evidence · same copy · same density</span></header>
      <div class="keyframe-track">${model.keyFrames.map(renderKeyframe).join('')}</div>
      <div class="edit-timeline"><span class="section-label">SHOT LEDGER / ROUGH CUT</span><div class="timeline-ruler"><span>00:00</span><span>01</span><span>02</span><span>03</span><span>04</span><span>${compactTime(total)}</span></div><div class="timeline-track">${model.timeline.items.map((item) => renderTimelineItem(item, total)).join('')}</div><div class="shot-strip">${model.shots.map((shot) => `<span><strong>${escapeHtml(shot.shotId)}</strong>${escapeHtml(`${shot.cameraRole.toUpperCase()} / ${shot.actionRole.toUpperCase()}`)} · ${Math.round(shot.confidence * 100)}%</span>`).join('')}</div></div>
      <a class="rough-cut-link" href="${reviewUrl(model.roughCut.path)}">Open proxy rough cut</a>
      ${model.proposals.candidates.map((candidate, index) => renderCandidateStoryDetail(candidate, index, model.brief)).join('\n')}
    </section>
  </div>
  <aside class="production-rail">
    <div class="rail-kicker"><span>${gateLabel}</span><span>Rev ${model.proposals.revision}</span></div>
    <ol class="progress-list">${STAGES.map((stage, index) => `<li class="${index < stageIndex || (terminal && index === stageIndex) ? 'is-complete' : !terminal && index === stageIndex ? 'is-current' : ''}">${escapeHtml(stage.replaceAll('_', ' '))}</li>`).join('')}${terminal ? `<li class="is-current is-terminal">${escapeHtml(model.state.state)}</li>` : ''}</ol>
    ${renderCurrentGateEvidence(model)}
    <section class="rail-section"><h3>BRIEF</h3><h2>${escapeHtml(model.brief.copy.title ?? 'Untitled journey')}</h2><p class="rail-copy">${escapeHtml(model.brief.story.tone ?? 'observational')} · ${model.brief.duration.targetSeconds}s · ${escapeHtml(model.brief.story.pacing)}</p></section>
    ${model.approvalAvailable ? renderApprovalZone(active) : ''}
    <section class="rail-section"><h3>LOCAL MUSIC</h3><p class="rail-copy">${escapeHtml(active.musicPlan.mode)} · ${escapeHtml(active.musicPlan.trackIds.join(', ') || 'No track')}</p></section>
    ${model.proposals.candidates.map(renderCandidateRailDetail).join('\n')}
    <script type="application/json" data-displayed-digests>${JSON.stringify(model.displayedArtifactDigests).replaceAll('<', '\\u003c')}</script>
  </aside>
</main>`;
}

function assertProposalBindings(proposals, sources) {
  const evidenceDigest = computeArtifactDigest({
    mediaIndex: sources.mediaIndex.integrity.digest, probe: sources.probe.integrity.digest,
    segments: sources.segments.integrity.digest, shots: sources.shots.integrity.digest,
    dataOverlays: sources.dataOverlays.integrity.digest,
  });
  const expected = {
    editBriefDigest: sources.editBrief.integrity.digest,
    evidenceDigest,
    roughCutDigest: sources.roughCut.outputDigest,
    timelineDigest: sources.timeline.integrity.digest,
    musicPlanDigest: computeArtifactDigest(sources.timeline.music),
    assetPlanDigest: computeArtifactDigest(proposals.candidates.map(({ candidateId, visualWorldPlan, componentPlan, assetPlan }) => ({ candidateId, visualWorldPlan, componentPlan, assetPlan }))),
  };
  for (const [role, digest] of Object.entries(expected)) {
    if (proposals.bindings?.[role] !== digest) throw new DirectorWorkbenchError('E_SOURCE_STALE', `stale direction proposal binding: ${role}`);
  }
  return expected;
}

async function readApproval(projectRoot) {
  try {
    const value = JSON.parse(await readFile(projectPath(projectRoot, 'direction/DIRECTOR_APPROVAL.json'), 'utf8'));
    const schemaValidation = validateDocument(await loadSchema('director-approval'), value);
    if (!schemaValidation.valid || !verifyArtifactIntegrity(value).valid) {
      throw new DirectorWorkbenchError('E_APPROVAL_INVALID', 'an existing approval artifact is invalid and cannot be overwritten');
    }
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof DirectorWorkbenchError) throw error;
    throw new DirectorWorkbenchError('E_APPROVAL_INVALID', 'an existing approval artifact is unreadable and cannot be overwritten');
  }
}

async function createWorkbenchContext(projectRoot) {
  const sources = await loadDirectionSources(projectRoot);
  const proposals = JSON.parse(await readFile(projectPath(projectRoot, 'direction/DIRECTION_PROPOSALS.json'), 'utf8'));
  const validation = validateDirectionProposals(proposals);
  const schemaValidation = validateDocument(await loadSchema('direction-proposals'), proposals);
  if (!validation.valid || !schemaValidation.valid) throw new DirectorWorkbenchError('E_PROPOSALS_INVALID', 'workbench requires current validated direction proposals');
  const bindings = assertProposalBindings(proposals, sources);
  const sourceFrames = sources.segments.segments
    .flatMap((segment) => segment.evidenceFrames.map((frame) => ({
      mediaId: segment.mediaId, segmentId: segment.segmentId, sourceTimeSeconds: frame.sourceTimeSeconds, sourcePath: frame.path,
    })))
    .sort((left, right) => left.segmentId.localeCompare(right.segmentId) || left.sourceTimeSeconds - right.sourceTimeSeconds)
    .map((frame, index) => ({ ...frame, frameId: `frame-${String(index + 1).padStart(3, '0')}` }));
  const frameAssets = await Promise.all(sourceFrames.map(async (frame, index) => ({
    kind: 'file', sourcePath: frame.sourcePath, digest: await sha256File(projectPath(projectRoot, frame.sourcePath)),
    stableName: `evidence-${frame.mediaId}-${frame.segmentId}-frame-${String(index + 1).padStart(3, '0')}`,
    extension: extname(frame.sourcePath).toLowerCase(), frame,
  })));
  const prototypeAssets = [];
  for (const candidate of proposals.candidates) {
    for (const [role, paths] of [['layout', candidate.layoutProofs], ['motion', candidate.motionStoryboard]]) {
      for (const [index, sourcePath] of paths.entries()) {
        prototypeAssets.push({
          kind: 'file', sourcePath, digest: candidate.previewArtifactDigests[sourcePath], candidateId: candidate.candidateId,
          role, index, stableName: `prototype-${candidate.candidateId}-${role}-${String(index + 1).padStart(3, '0')}`,
          extension: extname(sourcePath).toLowerCase(),
        });
      }
    }
  }
  const staticAssets = [
    { kind: 'bytes', bytes: WORKBENCH_CSS, digest: sha(WORKBENCH_CSS), stableName: 'workbench', extension: '.css' },
    { kind: 'bytes', bytes: WORKBENCH_JS, digest: sha(WORKBENCH_JS), stableName: 'workbench', extension: '.js' },
    { kind: 'file', sourcePath: sources.roughCut.artifact, digest: sources.roughCut.outputDigest, stableName: 'rough-cut', extension: '.mp4' },
  ];
  const assets = [...staticAssets, ...frameAssets, ...prototypeAssets];
  const bundleDigest = computeArtifactDigest(assets.map(({ stableName, extension, digest }) => ({ stableName, extension, digest })));
  const bundleRoot = `review/workbench-assets/${bundleDigest}`;
  for (const asset of assets) asset.targetPath = `${bundleRoot}/${asset.stableName}-${asset.digest}${asset.extension}`;
  const framePath = new Map(frameAssets.map((asset) => [asset.frame.frameId, asset.targetPath]));
  const prototypePath = new Map(prototypeAssets.map((asset) => [`${asset.candidateId}:${asset.role}:${asset.index}`, asset.targetPath]));
  const displayProposals = structuredClone(proposals);
  for (const candidate of displayProposals.candidates) {
    candidate.layoutProofs = candidate.layoutProofs.map((_, index) => prototypePath.get(`${candidate.candidateId}:layout:${index}`));
    candidate.motionStoryboard = candidate.motionStoryboard.map((_, index) => prototypePath.get(`${candidate.candidateId}:motion:${index}`));
    candidate.previewArtifactDigests = Object.fromEntries([...candidate.layoutProofs, ...candidate.motionStoryboard].map((path) => {
      const asset = assets.find(({ targetPath }) => targetPath === path);
      return [path, asset.digest];
    }));
  }
  const approval = await readApproval(projectRoot);
  const model = {
    chrome: CHROME,
    state: sources.projectState,
    brief: {
      revision: sources.editBrief.revision, sport: sources.editBrief.sport, story: sources.editBrief.story,
      duration: sources.editBrief.duration, music: sources.editBrief.music, copy: sources.editBrief.copy,
    },
    keyFrames: sourceFrames.map(({ sourcePath: _sourcePath, ...frame }) => ({ ...frame, path: framePath.get(frame.frameId) })),
    shots: [...sources.shots.shots].sort((left, right) => left.shotId.localeCompare(right.shotId)).map((shot) => ({
      shotId: shot.shotId, actionRole: shot.actionRole, cameraRole: shot.cameraRole, confidence: shot.confidence,
    })),
    timeline: { revision: sources.timeline.revision, items: [...sources.timeline.items].sort((left, right) => left.destinationInSeconds - right.destinationInSeconds) },
    roughCut: { path: staticAssets[2].targetPath, digest: sources.roughCut.outputDigest, closedFileProbe: sources.roughCut.closedFileProbe },
    proposals: displayProposals,
    sourceProposalDigest: proposals.integrity.digest,
    bundleDigest,
    stylesheetPath: staticAssets[0].targetPath,
    scriptPath: staticAssets[1].targetPath,
    displayedArtifactDigests: {
      editBrief: bindings.editBriefDigest, roughCut: bindings.roughCutDigest, musicPlan: bindings.musicPlanDigest,
      assetPlan: bindings.assetPlanDigest, evidence: bindings.evidenceDigest, proposals: proposals.integrity.digest,
    },
    approvalAvailable: sources.projectState.state === 'DIRECTOR_REVIEW_READY' && approval?.status !== 'approved',
  };
  return { model, assets };
}

export async function buildWorkbenchModel(projectRoot) {
  return (await createWorkbenchContext(projectRoot)).model;
}

export function renderWorkbenchHtml(model) {
  const modelDigest = computeArtifactDigest({
    state: model.state.integrity.digest, displayed: model.displayedArtifactDigests, approvalAvailable: model.approvalAvailable,
    lockedBinding: model.lockedBinding ?? null, currentViewBinding: model.currentViewBinding ?? null,
  });
  const html = TEMPLATE
    .replace('{{TOKENS}}', tokenStyle())
    .replace('{{MODEL_DIGEST}}', modelDigest)
    .replace('{{STYLESHEET}}', reviewUrl(model.stylesheetPath))
    .replace('{{SCRIPT}}', reviewUrl(model.scriptPath))
    .replace('{{CONTENT}}', renderContent(model));
  return model.lockedBinding
    ? html.replace('<html lang="en">', `<html lang="en" data-state="${escapeHtml(model.state.state)}" data-state-revision="${model.state.revision}" data-state-binding="${model.lockedBinding}"${model.currentViewBinding ? ` data-current-view-binding="${model.currentViewBinding}"` : ''}>`)
    : html;
}

async function writeAtomic(path, bytes, mode = 0o600, beforeRename) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    if (beforeRename) await beforeRename(temporary, path);
    await rename(temporary, path);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function writeStagedAsset(projectRoot, asset, target) {
  if (asset.kind === 'bytes') {
    await writeAtomic(target, asset.bytes);
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    await copyFile(projectPath(projectRoot, asset.sourcePath), temporary);
    const handle = await open(temporary, 'r');
    await handle.sync();
    await handle.close();
    if (await sha256File(temporary) !== asset.digest) throw new DirectorWorkbenchError('E_BUNDLE_SOURCE_STALE', 'workbench source changed during staging');
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function verifyBundle(projectRoot, assets) {
  const expectedNames = assets.map(({ targetPath }) => basename(targetPath)).sort();
  const bundleRoot = dirname(projectPath(projectRoot, assets[0].targetPath));
  const actualNames = (await readdir(bundleRoot)).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new DirectorWorkbenchError('E_BUNDLE_INCOMPLETE', 'immutable workbench bundle is incomplete or contains unexpected files');
  }
  for (const asset of assets) {
    if (await sha256File(projectPath(projectRoot, asset.targetPath)) !== asset.digest) {
      throw new DirectorWorkbenchError('E_BUNDLE_COLLISION', 'immutable workbench asset digest mismatch');
    }
  }
}

async function stageImmutableBundle(projectRoot, assets, bundleDigest, beforeBundlePublish) {
  const parent = projectPath(projectRoot, 'review/workbench-assets');
  const target = join(parent, bundleDigest);
  try {
    await stat(target);
    await verifyBundle(projectRoot, assets);
    return;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.${bundleDigest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const asset of assets) await writeStagedAsset(projectRoot, asset, join(temporary, basename(asset.targetPath)));
    if (beforeBundlePublish) await beforeBundlePublish(temporary, target);
    try {
      await rename(temporary, target);
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      await verifyBundle(projectRoot, assets);
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  await rm(temporary, { recursive: true, force: true });
  await verifyBundle(projectRoot, assets);
}

export async function buildDirectorWorkbench(projectRoot, options = {}) {
  const { model, assets } = await createWorkbenchContext(projectRoot);
  const html = renderWorkbenchHtml(model);
  await stageImmutableBundle(projectRoot, assets, model.bundleDigest, options.beforeBundlePublish);
  const reviewRoot = projectPath(projectRoot, 'review');
  const output = join(reviewRoot, 'director-workbench.html');
  await writeAtomic(output, html, 0o600, options.beforeHtmlPublish);
  return { ok: true, path: 'review/director-workbench.html', digest: sha(html), bundleDigest: model.bundleDigest, displayedArtifactDigests: model.displayedArtifactDigests };
}

function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function exactDigestSet(actual, expected) {
  const actualKeys = Object.keys(actual ?? {}).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

function makeApprovalLease(ownerToken, now, ttlMs) {
  const lease = {
    schemaVersion: '1.0.0', ownerToken, pid: process.pid,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + ttlMs).toISOString(),
    integrity: { digest: null, upstream: {} },
  };
  lease.integrity.digest = computeArtifactDigest(lease);
  return lease;
}

function validateApprovalLease(value) {
  const keys = Object.keys(value ?? {}).sort();
  const expectedKeys = ['createdAt', 'expiresAt', 'integrity', 'ownerToken', 'pid', 'schemaVersion'];
  const createdAt = Date.parse(value?.createdAt);
  const expiresAt = Date.parse(value?.expiresAt);
  const integrity = value?.integrity;
  const upstream = integrity?.upstream;
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
    && value.schemaVersion === '1.0.0'
    && /^[0-9a-f]{64}$/.test(value.ownerToken ?? '')
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && Number.isFinite(createdAt) && Number.isFinite(expiresAt) && expiresAt > createdAt
    && integrity && typeof integrity === 'object' && !Array.isArray(integrity)
    && Object.keys(integrity).sort().join(',') === 'digest,upstream'
    && upstream && typeof upstream === 'object' && !Array.isArray(upstream) && Object.keys(upstream).length === 0
    && verifyArtifactIntegrity(value).valid;
}

async function readApprovalLease(lockPath) {
  try {
    const [directoryMetadata, leaseMetadata, lease] = await Promise.all([
      lstat(lockPath),
      lstat(join(lockPath, 'lease.json')),
      readFile(join(lockPath, 'lease.json'), 'utf8').then(JSON.parse),
    ]);
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || (directoryMetadata.mode & 0o777) !== 0o700
      || !leaseMetadata.isFile() || leaseMetadata.isSymbolicLink() || (leaseMetadata.mode & 0o777) !== 0o600
      || !validateApprovalLease(lease)) {
      throw new DirectorWorkbenchError('E_APPROVAL_LOCK_INVALID', 'approval lock lease is malformed or not owner-only');
    }
    return lease;
  } catch (error) {
    if (error instanceof DirectorWorkbenchError) throw error;
    throw new DirectorWorkbenchError('E_APPROVAL_LOCK_INVALID', 'approval lock lease is missing, unreadable, or malformed');
  }
}

function ownerProcessStatus(pid, ownerProbe) {
  try {
    ownerProbe(pid, 0);
    return 'live';
  } catch (error) {
    if (error.code === 'ESRCH') return 'dead';
    return 'unconfirmed';
  }
}

async function restoreClaimOrFail(claimPath, lockPath, code, message) {
  try { await rename(claimPath, lockPath); } catch {}
  throw new DirectorWorkbenchError(code, message);
}

async function reclaimAbandonedApprovalLock(lockPath, observedLease, now, ownerToken, ownerProbe) {
  if (now < Date.parse(observedLease.expiresAt)) {
    throw new DirectorWorkbenchError('E_APPROVAL_BUSY', 'another director approval transaction is active');
  }
  const ownerStatus = ownerProcessStatus(observedLease.pid, ownerProbe);
  if (ownerStatus === 'live') throw new DirectorWorkbenchError('E_APPROVAL_BUSY', 'expired approval lease still has a live owner');
  if (ownerStatus !== 'dead') throw new DirectorWorkbenchError('E_APPROVAL_LOCK_UNCONFIRMED', 'approval lease owner liveness cannot be confirmed');
  const claimPath = `${lockPath}.abandoned-${ownerToken}`;
  try {
    await rename(lockPath, claimPath);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  let claimedLease;
  try {
    claimedLease = await readApprovalLease(claimPath);
  } catch {
    return restoreClaimOrFail(claimPath, lockPath, 'E_APPROVAL_LOCK_INVALID', 'claimed approval lease changed or became invalid');
  }
  if (!sameSecret(claimedLease.ownerToken, observedLease.ownerToken)
    || claimedLease.integrity.digest !== observedLease.integrity.digest
    || Date.parse(claimedLease.expiresAt) > now
    || ownerProcessStatus(claimedLease.pid, ownerProbe) !== 'dead') {
    return restoreClaimOrFail(claimPath, lockPath, 'E_APPROVAL_LOCK_INVALID', 'claimed approval lease is not the confirmed abandoned owner');
  }
  await rm(claimPath, { recursive: true, force: false });
  return true;
}

async function releaseApprovalLock(lockPath, ownerToken) {
  let lease;
  try { lease = await readApprovalLease(lockPath); } catch {
    throw new DirectorWorkbenchError('E_APPROVAL_LOCK_OWNERSHIP', 'approval lock cannot be released without its exact valid owner lease');
  }
  if (!sameSecret(lease.ownerToken, ownerToken)) {
    throw new DirectorWorkbenchError('E_APPROVAL_LOCK_OWNERSHIP', 'approval lock owner token changed');
  }
  const claimPath = `${lockPath}.release-${ownerToken}`;
  try {
    await rename(lockPath, claimPath);
  } catch {
    throw new DirectorWorkbenchError('E_APPROVAL_LOCK_OWNERSHIP', 'approval lock ownership changed before release');
  }
  let claimedLease;
  try { claimedLease = await readApprovalLease(claimPath); } catch {
    return restoreClaimOrFail(claimPath, lockPath, 'E_APPROVAL_LOCK_OWNERSHIP', 'claimed release lease is invalid');
  }
  if (!sameSecret(claimedLease.ownerToken, ownerToken) || claimedLease.integrity.digest !== lease.integrity.digest) {
    return restoreClaimOrFail(claimPath, lockPath, 'E_APPROVAL_LOCK_OWNERSHIP', 'claimed release lease belongs to another owner');
  }
  await rm(claimPath, { recursive: true, force: false });
}

async function acquireApprovalLock(projectRoot, now, ownerProbe, ttlMs = 60_000) {
  if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new DirectorWorkbenchError('E_APPROVAL_LOCK_OPTIONS', 'approval lease requires a valid clock and positive TTL');
  }
  const lockPath = projectPath(projectRoot, 'cache/director-approval.lock');
  const ownerToken = randomBytes(32).toString('hex');
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        await chmod(lockPath, 0o700);
        const lease = makeApprovalLease(ownerToken, now, ttlMs);
        await writeAtomic(join(lockPath, 'lease.json'), `${JSON.stringify(lease, null, 2)}\n`, 0o600);
      } catch (error) {
        await rmdir(lockPath).catch(() => {});
        throw error;
      }
      return async () => releaseApprovalLock(lockPath, ownerToken);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const observedLease = await readApprovalLease(lockPath);
      if (!await reclaimAbandonedApprovalLock(lockPath, observedLease, now, ownerToken, ownerProbe)) continue;
    }
  }
}

export async function recordDirectorApproval(request = {}, dependencies = {}) {
  const { projectRoot } = request;
  if (!projectRoot || !/^session-[0-9a-z-]{12,80}$/.test(request.sessionId ?? '') || typeof request.csrfToken !== 'string') {
    throw new DirectorWorkbenchError('E_SESSION_REQUIRED', 'exact session and CSRF tokens are required');
  }
  let session;
  try {
    session = JSON.parse(await readFile(projectPath(projectRoot, `cache/director-workbench-sessions/${request.sessionId}/session.json`), 'utf8'));
  } catch {
    throw new DirectorWorkbenchError('E_SESSION_REQUIRED', 'exact session and CSRF tokens are required');
  }
  if (!sameSecret(request.sessionId, session.id) || !sameSecret(sha(request.csrfToken), session.csrfDigest)) {
    throw new DirectorWorkbenchError('E_SESSION_REQUIRED', 'exact session and CSRF tokens are required');
  }
  const now = Date.parse((request.now ?? (() => new Date().toISOString()))());
  if (!Number.isFinite(now) || now >= Date.parse(session.expiresAt)) throw new DirectorWorkbenchError('E_SESSION_EXPIRED', 'director session expired');
  const ownerProbe = dependencies.ownerProbe ?? process.kill.bind(process);
  if (typeof ownerProbe !== 'function') throw new DirectorWorkbenchError('E_APPROVAL_LOCK_OPTIONS', 'approval owner probe must be callable');
  const releaseApprovalLock = await acquireApprovalLock(projectRoot, now, ownerProbe);
  try {
    const state = JSON.parse(await readFile(projectPath(projectRoot, 'PROJECT_STATE.json'), 'utf8'));
    if (state.state !== 'DIRECTOR_REVIEW_READY') throw new DirectorWorkbenchError('E_APPROVAL_STATE', 'approval is available only in DIRECTOR_REVIEW_READY');
    const existing = await readApproval(projectRoot);
    if (existing?.status === 'approved') throw new DirectorWorkbenchError('E_APPROVAL_EXISTS', 'the one normal-path approval already exists');
    const model = await buildWorkbenchModel(projectRoot);
    if (!model.proposals.candidates.some(({ candidateId }) => candidateId === request.selectedCandidateId)) {
      throw new DirectorWorkbenchError('E_CANDIDATE_UNKNOWN', 'selected candidate does not belong to the current whole proposals');
    }
    if (!exactDigestSet(request.displayedArtifactDigests, model.displayedArtifactDigests)) {
      throw new DirectorWorkbenchError('E_DISPLAYED_DIGEST_STALE', 'displayed artifact digest set is stale or partial');
    }
    const canonicalHtml = renderWorkbenchHtml(model);
    const canonicalDigest = sha(canonicalHtml);
    const path = projectPath(projectRoot, 'review/director-workbench.html');
    let diskDigest;
    try { diskDigest = await sha256File(path); } catch { diskDigest = null; }
    if (request.workbenchDigest !== canonicalDigest || diskDigest !== canonicalDigest) {
      throw new DirectorWorkbenchError('E_WORKBENCH_STALE', 'workbench digest does not match current canonical evidence view');
    }
    const approvedAt = new Date(now).toISOString();
    const approval = {
      $schema: 'https://hyperframes.local/schemas/director-approval.schema.json', schemaVersion: '1.0.0', revision: 1,
      status: 'approved', selectedCandidateId: request.selectedCandidateId,
      displayedArtifactDigests: { ...model.displayedArtifactDigests }, workbenchDigest: canonicalDigest, approvedAt,
      integrity: {
        digest: null,
        upstream: { proposals: model.sourceProposalDigest, workbench: canonicalDigest, ...model.displayedArtifactDigests },
      },
    };
    approval.integrity.digest = computeArtifactDigest(approval);
    const schemaValidation = validateDocument(await loadSchema('director-approval'), approval);
    if (!schemaValidation.valid) throw new DirectorWorkbenchError('E_APPROVAL_SCHEMA', 'compiled approval violates its schema', { diagnostics: schemaValidation.errors });
    await writeAtomic(projectPath(projectRoot, 'direction/DIRECTOR_APPROVAL.json'), `${JSON.stringify(approval, null, 2)}\n`, 0o600, request.beforeRename);
    return { ok: true, approval };
  } finally {
    await releaseApprovalLock();
  }
}

async function readBody(request, maximumBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new DirectorWorkbenchError('E_REQUEST_SIZE', 'request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function expireStaleSessions(parent, now) {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^session-[0-9a-z-]{12,80}$/.test(entry.name)) continue;
    const directory = join(parent, entry.name);
    try {
      const session = JSON.parse(await readFile(join(directory, 'session.json'), 'utf8'));
      if (session.id === entry.name && Number.isFinite(Date.parse(session.expiresAt)) && Date.parse(session.expiresAt) <= now) {
        await rm(directory, { recursive: true, force: true });
      }
    } catch {}
  }
}

function send(response, statusCode, body, contentType = 'application/json; charset=utf-8') {
  const svg = contentType === 'image/svg+xml';
  response.writeHead(statusCode, {
    'content-type': contentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': svg
      ? "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox"
      : "default-src 'self'; img-src 'self'; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'none'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function httpError(code, message, statusCode) {
  return new DirectorWorkbenchError(code, message, { statusCode });
}

async function readPersistedHttpSession(sessionDir, expected) {
  try {
    const path = join(sessionDir, 'session.json');
    const [directoryMetadata, fileMetadata, value] = await Promise.all([
      lstat(sessionDir), lstat(path), readFile(path, 'utf8').then(JSON.parse),
    ]);
    const keys = Object.keys(value ?? {}).sort();
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() || (directoryMetadata.mode & 0o777) !== 0o700
      || !fileMetadata.isFile() || fileMetadata.isSymbolicLink() || (fileMetadata.mode & 0o777) !== 0o600
      || keys.join(',') !== 'csrfDigest,expiresAt,id,integrity'
      || value.id !== expected.id || value.csrfDigest !== expected.csrfDigest || value.expiresAt !== expected.expiresAt
      || !verifyArtifactIntegrity(value).valid) {
      throw httpError('E_HTTP_SESSION_INVALID', 'persisted HTTP session is invalid', 403);
    }
    return value;
  } catch (error) {
    if (error instanceof DirectorWorkbenchError) throw error;
    throw httpError('E_HTTP_SESSION_INVALID', 'persisted HTTP session is missing or unreadable', 403);
  }
}

function declaredBundleDigest(path) {
  const match = basename(path).match(/-([a-f0-9]{64})\.[a-z0-9]+$/i);
  if (!match) throw new DirectorWorkbenchError('E_SERVE_BUNDLE_NAME', 'served bundle asset has no declared digest');
  return match[1].toLowerCase();
}

async function freezeVerifiedBytes(path, expectedDigest) {
  let handle;
  try {
    handle = await open(path, 'r');
    const [metadata, bytes] = await Promise.all([handle.stat(), handle.readFile()]);
    if (!metadata.isFile() || sha(bytes) !== expectedDigest) {
      throw new DirectorWorkbenchError('E_SERVE_BUNDLE_STALE', 'served bundle bytes do not match their declared digest');
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

export async function startWorkbenchServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!['127.0.0.1', 'localhost'].includes(host)) throw new DirectorWorkbenchError('E_BIND_LOCALHOST', 'director workbench binds only to localhost');
  const projectRoot = options.projectRoot;
  const built = await buildDirectorWorkbench(projectRoot);
  const model = await buildWorkbenchModel(projectRoot);
  if (sha(renderWorkbenchHtml(model)) !== built.digest) {
    throw new DirectorWorkbenchError('E_SERVE_WORKBENCH_STALE', 'workbench changed before immutable HTTP publication');
  }
  const allow = new Map();
  for (const path of [model.stylesheetPath, model.scriptPath, model.roughCut.path]
    .concat(model.keyFrames.map(({ path }) => path), model.proposals.candidates.flatMap((candidate) => [...candidate.layoutProofs, ...candidate.motionStoryboard]))) {
    const absolutePath = projectPath(projectRoot, path);
    allow.set(`/${reviewUrl(path)}`, {
      body: await freezeVerifiedBytes(absolutePath, declaredBundleDigest(absolutePath)),
      contentType: MIME.get(extname(absolutePath)) ?? 'application/octet-stream',
    });
  }
  const canonicalHtml = await freezeVerifiedBytes(projectPath(projectRoot, built.path), built.digest);
  const issuedAt = Number((options.now ?? Date.now)());
  const ttlMs = options.ttlMs ?? 15 * 60_000;
  if (!Number.isFinite(issuedAt) || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new DirectorWorkbenchError('E_SESSION_EXPIRY', 'valid session clock and positive expiry are required');
  const session = {
    id: `session-${randomBytes(32).toString('hex')}`,
    csrfToken: `csrf-${randomBytes(24).toString('hex')}`,
    expiresAt: new Date(issuedAt + ttlMs).toISOString(),
  };
  const sessionParent = projectPath(projectRoot, 'cache/director-workbench-sessions');
  await expireStaleSessions(sessionParent, issuedAt);
  const sessionDir = join(sessionParent, session.id);
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  await chmod(sessionDir, 0o700);
  const persistedSession = {
    id: session.id, csrfDigest: sha(session.csrfToken), expiresAt: session.expiresAt,
    integrity: { digest: null, upstream: {} },
  };
  persistedSession.integrity.digest = computeArtifactDigest(persistedSession);
  await writeAtomic(join(sessionDir, 'session.json'), `${JSON.stringify(persistedSession)}\n`, 0o600);

  const servedHtml = canonicalHtml.toString('utf8')
    .replace('__HF_SESSION_ID__', session.id)
    .replace('__HF_CSRF_TOKEN__', session.csrfToken)
    .replace('__HF_WORKBENCH_DIGEST__', built.digest);

  const sessionPrefix = `/${session.id}/`;
  let expectedHost;
  let server;
  let expiryTimer;
  let closePromise;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const close = async () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (expiryTimer) clearTimeout(expiryTimer);
      if (server.listening) await new Promise((resolvePromise) => server.close(resolvePromise));
      await rm(sessionDir, { recursive: true, force: true });
      resolveClosed();
    })();
    return closePromise;
  };
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.headers.host !== expectedHost) throw httpError('E_HTTP_HOST', 'exact loopback Host and port are required', 403);
      if (url.search || !url.pathname.startsWith(sessionPrefix)) throw httpError('E_HTTP_SESSION_ROUTE', 'exact HTTP session route is required', 404);
      const persisted = await readPersistedHttpSession(sessionDir, persistedSession);
      const currentTime = Number((options.now ?? Date.now)());
      if (!Number.isFinite(currentTime)) throw httpError('E_HTTP_SESSION_CLOCK', 'HTTP session clock is invalid', 403);
      if (currentTime >= Date.parse(persisted.expiresAt)) {
        send(response, 410, JSON.stringify({ ok: false, code: 'E_HTTP_SESSION_EXPIRED' }));
        queueMicrotask(() => { void close(); });
        return;
      }
      const route = `/${url.pathname.slice(sessionPrefix.length)}`;
      if (request.method === 'GET' && ['/', '/director-workbench.html'].includes(route)) {
        send(response, 200, servedHtml, MIME.get('.html'));
        return;
      }
      if (request.method === 'GET' && allow.has(route)) {
        const frozen = allow.get(route);
        send(response, 200, frozen.body, frozen.contentType);
        return;
      }
      if (request.method === 'POST' && route === '/approval') {
        const payload = await readBody(request);
        const result = await recordDirectorApproval({ ...payload, projectRoot, session });
        send(response, 200, JSON.stringify({ ok: true, approvalDigest: result.approval.integrity.digest }));
        return;
      }
      send(response, 404, JSON.stringify({ ok: false, code: 'E_NOT_FOUND' }));
    } catch (error) {
      send(response, error.statusCode ?? 400, JSON.stringify({ ok: false, code: error.code ?? 'E_REQUEST', message: error.message }));
    }
  });
  try {
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', resolvePromise);
    });
  } catch (error) {
    await close();
    throw error;
  }
  const address = server.address();
  expectedHost = `127.0.0.1:${address.port}`;
  expiryTimer = setTimeout(() => { void close(); }, ttlMs);
  return {
    url: `http://127.0.0.1:${address.port}${sessionPrefix}`, expiresAt: session.expiresAt,
    sessionId: session.id, csrfToken: session.csrfToken, session, sessionDir, close, closed,
  };
}

export { CHROME };
