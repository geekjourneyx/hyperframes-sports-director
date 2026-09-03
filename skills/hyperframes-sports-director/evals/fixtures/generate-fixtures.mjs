import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { computeArtifactDigest } from '../../scripts/lib/contracts.mjs';
import { renderWorkbenchHtml } from '../../scripts/lib/director-workbench.mjs';
import { MAIN_STATES, validateTransition } from '../../scripts/lib/project-state.mjs';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

async function ffmpeg(args) {
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
}

async function addExifOrientation(path, orientation) {
  const jpeg = await readFile(path);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('fixture JPEG has no SOI marker');
  const payload = Buffer.alloc(32);
  payload.write('Exif\0\0', 0, 'binary');
  payload.write('II', 6, 'ascii');
  payload.writeUInt16LE(42, 8);
  payload.writeUInt32LE(8, 10);
  payload.writeUInt16LE(1, 14);
  payload.writeUInt16LE(0x0112, 16);
  payload.writeUInt16LE(3, 18);
  payload.writeUInt32LE(1, 20);
  payload.writeUInt16LE(orientation, 24);
  payload.writeUInt32LE(0, 28);
  const app1 = Buffer.alloc(payload.length + 4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(payload.length + 2, 2);
  payload.copy(app1, 4);
  await writeFile(path, Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]));
}

export async function generateFixtures(root) {
  const nested = join(root, 'nested');
  await mkdir(nested, { recursive: true });

  const mainVideo = join(root, '20260901T120000Z-main.mp4');
  await ffmpeg([
    '-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=30000/1001:duration=5',
    '-f', 'lavfi', '-i', "aevalsrc=if(between(t\\,1\\,2)\\,0\\,sin(2*PI*1000*t)):s=48000:d=5",
    '-vf', "loop=loop=1:size=30:start=30,loop=loop=15:size=1:start=105,drawbox=x='mod(t*80\\,280)':y=60:w=40:h=40:color=white:t=fill,drawbox=enable='between(t\\,3\\,3.5)':x=0:y=0:w=iw:h=ih:color=black:t=fill,crop=300:160:x='10+if(between(t\\,4\\,5)\\,8*sin(80*t)\\,0)':y='10+if(between(t\\,4\\,5)\\,8*cos(80*t)\\,0)',scale=320:180,format=yuv420p",
    '-t', '5', '-r', '30000/1001', '-video_track_timescale', '30000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-c:a', 'aac', '-shortest',
    '-metadata', 'creation_time=2026-09-01T12:00:00Z', mainVideo,
  ]);
  await ffmpeg([
    '-display_rotation', '90', '-i', mainVideo, '-map', '0', '-c', 'copy',
    '-metadata', 'creation_time=2026-09-01T12:01:00Z', join(root, '20260901T120100Z-rotated.mov'),
  ]);

  const orientedJpeg = join(root, '20260901T120200Z-photo.jpg');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=1', '-frames:v', '1', orientedJpeg]);
  await addExifOrientation(orientedJpeg, 6);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x336699:size=120x160:rate=1', '-frames:v', '1', join(nested, '20260901T120300Z-portrait.png')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=144x96:rate=1', '-frames:v', '1', '-c:v', 'libwebp', join(root, '20260901T120400Z-photo.webp')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=1', '-c:a', 'pcm_s16le', join(root, '20260901T120500Z-tone.wav')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-c:a', 'aac', join(root, '20260901T120600Z-music.m4a')]);

  await writeFile(join(root, '20260901T120700Z-activity.fit'), Buffer.from([
    0x0e, 0x10, 0x00, 0x00, 0x2e, 0x46, 0x49, 0x54, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]));
  await writeFile(join(root, '20260901T120800Z-route.kml'), '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>\n');
  await writeFile(join(root, '20260901T120900Z-sidecar.json'), '{"rating":5,"note":"fixture sidecar"}\n');
  await writeFile(join(root, '20260901T121000Z-unsupported.txt'), 'unsupported fixture\n');
  await writeFile(join(root, '.hidden.mp4'), 'ignored hidden fixture\n');
  await mkdir(join(root, '__MACOSX'));
  await writeFile(join(root, '__MACOSX', 'resource.txt'), 'ignored system fixture\n');

  return { root, mainVideo };
}

export async function generateGoldenFinals(root) {
  await mkdir(root, { recursive: true });
  const outputs = {
    cycling: join(root, 'cycling-final.mp4'),
    hiking: join(root, 'hiking-final.mp4'),
    'pool-swimming': join(root, 'pool-swimming-final.mp4'),
  };
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=0x111820:size=3840x2160:rate=24:duration=0.5',
    '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000:duration=0.5',
    '-vf', "drawbox=x=2250:y=280:w=1250:h=1320:color=0x24313b:t=fill,drawbox=x=240:y=1660:w=3360:h=8:color=white@0.7:t=fill,drawbox=x=900+1200*t:y=1450-700*t:w=80:h=80:color=0xf3bd5b:t=fill,drawtext=text='CYCLING / ROUTE + EFFORT':x=240:y=180:fontsize=96:fontcolor=white,drawtext=text='42 KM  +640 M':x=240:y=1320:fontsize=72:fontcolor=0xf3bd5b",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '32', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', '-shortest', outputs.cycling,
  ]);
  await ffmpeg([
    '-f', 'lavfi', '-i', 'gradients=size=1920x1080:rate=24:duration=0.8:c0=0x17221c:c1=0x56624b:x0=0:y0=1080:x1=1920:y1=0',
    '-f', 'lavfi', '-i', 'sine=frequency=180:sample_rate=48000:duration=0.8',
    '-vf', "drawbox=x=0:y=760:w=1920:h=320:color=0x111712@0.6:t=fill,drawbox=x=100:y=790:w=1720:h=4:color=white@0.55:t=fill,drawtext=text='HIKING / ELEVATION UNAVAILABLE':x=100:y=100:fontsize=54:fontcolor=white,drawtext=text='OBSERVE THE WEATHER':x=100:y=850:fontsize=40:fontcolor=0xf3bd5b",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', '-shortest', outputs.hiking,
  ]);
  await ffmpeg([
    '-f', 'lavfi', '-i', 'color=c=0x0b6680:size=1920x1080:rate=24:duration=0.8',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=0.8',
    '-vf', "drawgrid=width=480:height=1080:thickness=8:color=white@0.35,drawbox=x=200+1200*t:y=570:w=120:h=40:color=0xf3bd5b:t=fill,drawbox=x=70:y=65:w=710:h=105:color=0x073c4c@0.7:t=fill,drawtext=text='POOL / LAP 04 / 00\\:42':x=100:y=95:fontsize=52:fontcolor=white",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-c:a', 'aac', '-shortest', outputs['pool-swimming'],
  ]);
  return outputs;
}

const GOLDEN_HARD_GATES = ['closed-file-reprobe', 'machine-hard-gates', 'single-director-lock', 'style-anchor', 'representative-combination', 'final-combinations', 'delivered-state'];
const GOLDEN_CHECKS = ['structure', 'workbench-current', 'shot-bounds', 'edit-continuity', 'audio-continuity', 'activity-truth', 'route-privacy', 'design-lock', 'style-anchor', 'combination-proofs', 'motion-ownership', 'deterministic-timeline', 'final-inspection', 'delivered'];
const AGENT_CATEGORIES = ['composition', 'density', 'restraint', 'pacing', 'style-anchor-consistency', 'transition-meaning'];

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stateRecords(profile, gate, revision, timestamp, encodedMp4Digest, previousRecords) {
  const specifications = gate === 'DIRECTOR_LOCK' ? [['DESIGN_SYSTEM', 'frozen'], ['LOOK_PROFILE', 'frozen'], ['DIRECTOR_APPROVAL', 'consumed'], ['WORKBENCH', 'state-bound']]
    : gate === 'STYLE_ANCHOR' ? [['DESIGN_SYSTEM', 'frozen'], ['LOOK_PROFILE', 'frozen'], ['ASSET_PLAN', 'approved'], ['STYLE_ANCHOR', 'accepted']]
      : gate === 'ASSET_PRODUCTION' ? [['STYLE_ANCHOR', 'accepted'], ['REPRESENTATIVE_COMBINATION', 'accepted']]
        : gate === 'DELIVERED' ? [['CLOSED_FILE_PROBE', 'passed'], ['HARD_GATES', 'passed'], ['AGENT_VISUAL_INSPECTION', 'accepted'], ['ENCODED_MP4_EVIDENCE', 'accepted']]
          : [[`${gate}_GATE`, 'accepted']];
  return specifications.map(([role, qualifier]) => ({
    gate, role, revision,
    digest: role === 'ENCODED_MP4_EVIDENCE' ? encodedMp4Digest
      : gate === 'ASSET_PRODUCTION' && role === 'STYLE_ANCHOR'
        ? previousRecords.findLast((record) => record.gate === 'STYLE_ANCHOR' && record.role === 'STYLE_ANCHOR').digest
        : digest(`${profile}:${gate}:${role}:${revision}`),
    timestamp,
    producerCommand: gate === 'DIRECTOR_LOCK' ? 'lock_direction.mjs' : `golden-pipeline --gate ${gate}`,
    qualifiers: [qualifier], validity: 'valid', invalidatedAt: null,
  }));
}

function deliveredState(profile, encodedMp4Digest) {
  const route = MAIN_STATES.slice(0, MAIN_STATES.indexOf('DELIVERED') + 1);
  const gateEvidence = [];
  const transitions = [];
  route.slice(1).forEach((to, index) => {
    const revision = index + 1;
    const timestamp = `2026-09-03T00:${String(index).padStart(2, '0')}:00.000Z`;
    const records = stateRecords(profile, to, revision, timestamp, encodedMp4Digest, gateEvidence);
    const currentArtifacts = Object.fromEntries(records.map((record) => [record.role, { revision: record.revision, digest: record.digest }]));
    validateTransition(route[index], to, { records, currentArtifacts });
    gateEvidence.push(...records);
    transitions.push({ from: route[index], to, at: timestamp, evidenceDigests: Object.fromEntries(records.map(({ role, digest: value }) => [role, value])), evidenceRevisions: Object.fromEntries(records.map(({ role, revision: value }) => [role, value])) });
  });
  const anchor = gateEvidence.findLast((record) => record.gate === 'ASSET_PRODUCTION' && record.role === 'STYLE_ANCHOR');
  const representative = gateEvidence.findLast((record) => record.gate === 'ASSET_PRODUCTION' && record.role === 'REPRESENTATIVE_COMBINATION');
  const state = {
    $schema: 'https://hyperframes.local/schemas/project-state.schema.json', schemaVersion: '1.0.0', revision: route.length,
    state: 'DELIVERED', previousState: 'FINAL_QA', stateEnteredAt: transitions.at(-1).at, transitions, gateEvidence, invalidations: [],
    assetAcceptance: { stage: 'batch', manifestRevision: anchor.revision, manifestDigest: digest(`${profile}:asset-manifest`), anchorDigest: anchor.digest, representativeDigest: representative.digest, anchorIdentityDigest: digest(`${profile}:anchor-identity`), representativeIdentityDigest: digest(`${profile}:representative-identity`), batchDigest: digest(`${profile}:batch`), acceptedAt: transitions.find(({ to }) => to === 'ASSET_PRODUCTION').at },
    integrity: { digest: null, upstream: {} },
  };
  state.integrity.digest = computeArtifactDigest(state);
  return state;
}

function goldenWorkbench(profile, state) {
  const candidate = (candidateId, title, accent) => ({
    candidateId, title, thesis: `${profile} evidence with restrained semantic motion`, copy: [profile.toUpperCase(), 'DIRECTION PROTOTYPE'],
    viewport: { width: 1920, height: 1080 }, informationDensityBudget: { maximumSimultaneousLayers: 3, maximumWordsPerFrame: 8 },
    designCandidate: { semanticColors: { canvas: '#050505', ink: '#F5F2EA', accent, signal: '#A8A29A' } },
    visualWorldPlan: { statement: 'Recorded evidence stays primary.', plannedAssets: ['semantic route', 'chapter typography'] },
    lookCandidate: { treatment: 'SDR Rec.709', grain: 'restrained' }, typographyHierarchy: ['journey title', 'chapter', 'metric'],
    representativeEvidenceIds: ['frame-001'], storyStructure: ['arrival', 'effort', 'reflection'],
    layoutProofs: [`review/workbench-assets/golden/${candidateId}-layout.svg`], motionStoryboard: [`review/workbench-assets/golden/${candidateId}-motion.svg`],
    componentPlan: { components: ['chapter card', 'metric label'], heroAssets: ['route line'] }, risks: ['synthetic fixture only'],
    musicPlan: { mode: profile === 'cycling' ? 'provided' : 'none', trackIds: profile === 'cycling' ? ['local-tone'] : [] },
  });
  return renderWorkbenchHtml({
    state, brief: { copy: { title: `${profile} golden` }, story: { tone: 'observational', pacing: 'profile-bound', emphasis: ['entry', 'hold', 'exit'] }, duration: { targetSeconds: 1 } },
    keyFrames: [{ frameId: 'frame-001', path: 'review/workbench-assets/golden/frame-001.png', sourceTimeSeconds: 0.25 }],
    shots: [{ shotId: 'shot-001', cameraRole: 'primary', actionRole: 'participant', confidence: 1 }],
    timeline: { items: [{ itemId: 'item-001', destinationInSeconds: 0, destinationOutSeconds: 1 }] },
    roughCut: { path: 'review/workbench-assets/golden/rough-cut.mp4' },
    proposals: { revision: 1, candidates: [candidate('direction-a', 'Evidence Current', '#C9A86A'), candidate('direction-b', 'Measured Quiet', '#D6B979')] },
    stylesheetPath: 'review/workbench-assets/golden/workbench.css', scriptPath: 'review/workbench-assets/golden/workbench.js',
    displayedArtifactDigests: { editBrief: digest(`${profile}:brief`), roughCut: digest(`${profile}:rough`), musicPlan: digest(`${profile}:music`), assetPlan: digest(`${profile}:assets`), evidence: digest(`${profile}:evidence`), proposals: digest(`${profile}:proposals`) },
    approvalAvailable: false,
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fileReference(project, path) {
  return { path, sha256: digest(await readFile(join(project, path))) };
}

export async function materializeGoldenProjects(workspace, { fixtureRoot } = {}) {
  if (!fixtureRoot) throw new Error('fixtureRoot is required');
  const mediaRoot = join(workspace, 'media');
  const media = await generateGoldenFinals(mediaRoot);
  const projects = {};
  for (const profile of ['cycling', 'hiking', 'pool-swimming']) {
    const project = join(workspace, profile);
    await cp(join(fixtureRoot, profile), project, { recursive: true });
    await mkdir(join(project, 'renders'), { recursive: true });
    await mkdir(join(project, 'review'), { recursive: true });
    await copyFile(media[profile], join(project, 'renders/final.mp4'));
    const encodedMp4Digest = digest(await readFile(join(project, 'renders/final.mp4')));
    const contract = JSON.parse(await readFile(join(project, 'golden-project.json'), 'utf8'));
    const projectState = deliveredState(profile, encodedMp4Digest);
    const workbench = goldenWorkbench(profile, projectState);
    await writeFile(join(project, 'review/workbench.html'), workbench);
    const workbenchDigest = digest(workbench);
    const hardGateEvidence = {
      status: 'pass', encodedMp4Digest,
      gates: GOLDEN_HARD_GATES.map((id) => ({ id, status: 'pass' })), checks: GOLDEN_CHECKS,
      closedProbe: { valid: true, width: profile === 'cycling' ? 3840 : 1920, height: profile === 'cycling' ? 2160 : 1080, videoCodec: 'h264', audioCodec: 'aac', color: 'bt709' },
      pipeline: { directorApprovals: contract.pipeline.directorApprovals, transactionalDesignLock: contract.pipeline.transactionalDesignLock, styleAnchor: contract.pipeline.styleAnchor, representativeCombination: contract.pipeline.representativeCombination, finalCombinationProofs: contract.pipeline.finalCombinationProofs, repairs: contract.pipeline.repairs, degradations: contract.pipeline.degradations },
    };
    await writeJson(join(project, 'review/hard-gates.json'), hardGateEvidence);
    const agentReview = { status: 'accepted', encodedMp4Digest, source: 'decoded-final-mp4-synthetic-evidence', judgments: AGENT_CATEGORIES, userAcceptedInferred: false };
    await writeJson(join(project, 'review/agent-visual-review.json'), agentReview);
    const workbenchReview = { status: 'accepted', reviewer: 'task-18-fixture-product-review', reviewedAt: '2026-09-03T02:00:00.000Z', workbenchDigest, scope: 'product-level synthetic workbench golden', userAcceptedInferred: false };
    await writeJson(join(project, 'review/workbench-human-review.json'), workbenchReview);
    const finalVideoReview = { status: 'accepted', reviewer: 'task-18-fixture-product-review', reviewedAt: '2026-09-03T02:01:00.000Z', encodedMp4Digest, scope: `short deterministic ${profile === 'cycling' ? '4K' : '1080p'} final fixture`, userAcceptedInferred: false };
    await writeJson(join(project, 'review/final-video-human-review.json'), finalVideoReview);
    const metrics = {
      $schema: 'https://hyperframes.local/schemas/review-metrics.schema.json', schemaVersion: '1.0.0', revision: 1, status: 'accepted', encodedMp4Digest,
      metrics: ['closed_file_probe', 'black_frames', 'freeze_spans', 'audio_clipping', 'loudness', 'av_drift', 'detail_loss', 'input_color_profile', 'local_contrast', 'token_color', 'layout_collision', 'quiet_zone_loss', 'cross_scene_consistency'].map((metricId) => ({ metricId, status: 'pass', value: metricId === 'closed_file_probe' ? hardGateEvidence.closedProbe : true })),
      agentInspection: { status: 'accepted', evidencePaths: ['review/agent-visual-review.json'], judgments: AGENT_CATEGORIES.map((category) => ({ category, status: 'accepted', evidencePaths: ['review/agent-visual-review.json'] })) },
      integrity: { digest: null, upstream: { FINAL_RENDER: encodedMp4Digest } },
    };
    metrics.integrity.digest = computeArtifactDigest(metrics);
    await writeJson(join(project, 'review/metrics.json'), metrics);
    await writeJson(join(project, 'PROJECT_STATE.json'), projectState);
    const references = {
      metrics: await fileReference(project, 'review/metrics.json'), projectState: await fileReference(project, 'PROJECT_STATE.json'), hardGates: await fileReference(project, 'review/hard-gates.json'),
      agentReview: await fileReference(project, 'review/agent-visual-review.json'), workbenchReview: await fileReference(project, 'review/workbench-human-review.json'), finalVideoReview: await fileReference(project, 'review/final-video-human-review.json'),
      finalMp4: await fileReference(project, 'renders/final.mp4'), workbench: await fileReference(project, 'review/workbench.html'),
    };
    await writeJson(join(project, 'review/release-eval.json'), { schemaVersion: '1.0.0', profile, profileMaturity: 'release-grade', references });
    projects[profile] = project;
  }
  return projects;
}
