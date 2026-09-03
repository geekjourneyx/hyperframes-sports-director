import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeWarningDecisionDigest,
  findContinuityWarnings,
  findDuplicateViolations,
  validateTimeline,
} from '../lib/timeline.mjs';

const digest = (character) => character.repeat(64);

function probeFixture() {
  return {
    integrity: { digest: digest('a') },
    media: [
      {
        mediaId: 'media-video-001', mediaType: 'video', sourceDigest: digest('1'), durationSeconds: 10,
        proxy: { kind: 'video', path: 'media/proxies/media-video-001.mp4', sourceDigest: digest('1') },
      },
      {
        mediaId: 'media-image-001', mediaType: 'image', sourceDigest: digest('2'), durationSeconds: null,
        proxy: { kind: 'image', path: 'review/probe/media-image-001.webp', sourceDigest: digest('2') },
      },
    ],
  };
}

function shotFixture(overrides = {}) {
  return {
    shotId: 'shot-video-001', mediaId: 'media-video-001', sourceInSeconds: 0, sourceOutSeconds: 10,
    sourceDigest: digest('1'), sourceDurationSeconds: 10, duplicateGroup: null, setupTailLikelihood: 0.05,
    quality: { shake: 'none' },
    continuity: {
      screenDirection: 'left-to-right', motionDirection: 'forward', subjectEntry: 'left', subjectExit: 'right',
      location: 'road', timeRelation: 'continuous',
    },
    ...overrides,
  };
}

function itemFixture(overrides = {}) {
  return {
    itemId: 'item-001', shotId: 'shot-video-001', sourceMediaId: 'media-video-001', sourceKind: 'video',
    sourceReference: { kind: 'proxy', path: 'media/proxies/media-video-001.mp4', digest: digest('1') },
    sourceInSeconds: 0, sourceOutSeconds: 4, sourceDurationSeconds: 10,
    destinationInSeconds: 0, destinationOutSeconds: 4, playbackRate: 1,
    playbackRateCurve: [{ sourceTimeSeconds: 0, rate: 1 }, { sourceTimeSeconds: 4, rate: 1 }],
    transform: {
      stabilization: { mode: 'off', cropFraction: 0 }, cropReframe: null, stillMotion: null,
      draftColorTransform: 'neutral', faceTreatment: 'off',
    },
    audioPolicy: { sourceGainDb: 0, denoise: false, bridge: 'none' },
    transition: { kind: 'none', ownerId: null }, assetReferences: [], motionReferences: [],
    reasons: ['establish movement'], colorToken: 'color.textPrimary',
    ...overrides,
  };
}

function timelineFixture(items = [itemFixture()], overrides = {}) {
  return {
    phase: 'rough', sourceProbeDigest: digest('a'), items,
    music: { mode: 'none' }, warningDecisions: [],
    ...overrides,
  };
}

const profiles = {
  sport: {
    policies: {
      speedPolicy: { maximumMontageRate: 12 }, stabilizationPolicy: { maximumCropFraction: 0.12 },
      duplicatePolicy: { minimumSeparationSeconds: 12 },
    },
  },
};

test('timeline rejects video and still source ranges outside deterministic bounds', () => {
  const video = itemFixture({ sourceOutSeconds: 10.1 });
  const still = itemFixture({
    itemId: 'item-still', shotId: 'shot-image-001', sourceMediaId: 'media-image-001', sourceKind: 'image',
    sourceReference: { kind: 'proxy', path: 'review/probe/media-image-001.webp', digest: digest('2') },
    sourceInSeconds: 0.1, sourceOutSeconds: 4, sourceDurationSeconds: 0,
    destinationInSeconds: 11, destinationOutSeconds: 15,
    playbackRateCurve: [{ sourceTimeSeconds: 0.1, rate: 1 }, { sourceTimeSeconds: 4, rate: 1 }],
    transform: { ...itemFixture().transform, stillMotion: { mode: 'hold', holdSeconds: 4, startScale: 1, endScale: 1 } },
  });
  const result = validateTimeline({ phase: 'rough', probe: probeFixture(), shots: { shots: [shotFixture(), shotFixture({ shotId: 'shot-image-001', mediaId: 'media-image-001', sourceDigest: digest('2') })] }, timeline: timelineFixture([video, still]), profiles });
  assert.ok(result.errors.some(({ code }) => code === 'E_SOURCE_BOUNDS'));
  assert.ok(result.errors.some(({ code }) => code === 'E_STILL_SOURCE_RANGE'));
});

test('rough uses current proxies while final uses originals and resolved production ownership', () => {
  const probe = probeFixture();
  const shots = { shots: [shotFixture()] };
  const roughOriginal = validateTimeline({ phase: 'rough', probe, shots, timeline: timelineFixture([itemFixture({ sourceReference: { kind: 'original', path: 'media/originals/media-video-001.mp4', digest: digest('1') } })]), profiles });
  assert.ok(roughOriginal.errors.some(({ code }) => code === 'E_ROUGH_PROXY_REQUIRED'));

  const finalProxy = validateTimeline({
    phase: 'final', probe, shots,
    timeline: timelineFixture([itemFixture()], { phase: 'final' }), profiles,
    assetManifest: { status: 'frozen', assetRevision: 'assets-2', assets: [{ assetId: 'asset-map' }] },
    motionMap: { status: 'frozen', motionRevision: 'motion-2', owners: [{ ownerId: 'owner-map', assetId: 'asset-map' }] },
  });
  assert.ok(finalProxy.errors.some(({ code }) => code === 'E_FINAL_ORIGINAL_REQUIRED'));

  const unresolved = validateTimeline({
    phase: 'final', probe, shots,
    timeline: timelineFixture([itemFixture({
      sourceReference: { kind: 'original', path: 'media/originals/media-video-001.mp4', digest: digest('1') },
      assetReferences: ['asset-missing'], motionReferences: ['owner-missing'],
    })], { phase: 'final' }), profiles,
    assetManifest: { status: 'frozen', assetRevision: 'assets-2', assets: [] },
    motionMap: { status: 'frozen', motionRevision: 'motion-2', owners: [] },
  });
  assert.ok(unresolved.errors.some(({ code }) => code === 'E_ASSET_REFERENCE'));
  assert.ok(unresolved.errors.some(({ code }) => code === 'E_MOTION_REFERENCE'));

  const generatedDocumentary = validateTimeline({
    phase: 'final', probe, shots,
    timeline: timelineFixture([itemFixture({
      sourceReference: { kind: 'original', path: 'media/originals/media-video-001.mp4', digest: digest('1') },
      assetReferences: ['asset-generated'],
    })], { phase: 'final' }), profiles,
    assetManifest: { status: 'frozen', assets: [{ assetId: 'asset-generated', documentaryStatus: 'documentary', provenance: { kind: 'generated-interpretive' } }] },
    motionMap: { status: 'frozen', owners: [] },
  });
  assert.ok(generatedDocumentary.errors.some(({ code }) => code === 'E_GENERATED_DOCUMENTARY'));

  const staleActivity = validateTimeline({
    phase: 'final', probe, shots,
    timeline: timelineFixture([itemFixture({
      sourceReference: { kind: 'original', path: 'media/originals/media-video-001.mp4', digest: digest('1') },
      assetReferences: ['asset-activity'],
    })], { phase: 'final' }), profiles,
    dataOverlays: { integrity: { digest: digest('c') }, publicRoute: { status: 'unavailable', trimmedRouteId: null }, overlays: [{ overlayId: 'overlay-effort' }] },
    assetManifest: { status: 'frozen', assets: [{ assetId: 'asset-activity', documentaryStatus: 'documentary', narrativeRole: 'journey_anchor',
      provenance: { kind: 'code-rendered-activity', evidenceBinding: { kind: 'data-overlay', id: 'overlay-effort', digest: digest('d'), privacyStatus: 'not-applicable' } } }] },
    motionMap: { status: 'frozen', owners: [] },
  });
  assert.ok(staleActivity.errors.some(({ code }) => code === 'E_DOCUMENTARY_ACTIVITY_BINDING'));
});

test('final timeline binds current design, Look, asset, motion, and overlay revisions and digests', () => {
  const probe = probeFixture();
  const shots = { shots: [shotFixture()] };
  const assetManifest = { status: 'frozen', designRevision: 'design-4', lookRevision: 'look-3', assetRevision: 'assets-9',
    integrity: { digest: digest('b') }, assets: [] };
  const motionMap = { status: 'frozen', designRevision: 'design-4', assetRevision: 'assets-9', motionRevision: 'motion-8',
    integrity: { digest: digest('c') }, owners: [] };
  const dataOverlays = { status: 'unavailable', integrity: { digest: digest('d') }, publicRoute: { status: 'unavailable', trimmedRouteId: null }, overlays: [] };
  const timeline = timelineFixture([itemFixture({ sourceReference: { kind: 'original', path: 'media/originals/media-video-001.mp4', digest: digest('1') } })], {
    phase: 'final', designRevision: 'design-4', lookRevision: 'look-3', assetRevision: 'assets-9', motionRevision: 'motion-8',
    assetManifestDigest: digest('b'), motionMapDigest: digest('c'), dataOverlaysDigest: digest('d'),
  });
  assert.ok(!validateTimeline({ phase: 'final', probe, shots, timeline, profiles, assetManifest, motionMap, dataOverlays }).errors
    .some(({ code }) => code === 'E_TIMELINE_PRODUCTION_AUTHORITY'));
  const stale = { ...timeline, assetManifestDigest: digest('e'), motionRevision: 'motion-7' };
  assert.ok(validateTimeline({ phase: 'final', probe, shots, timeline: stale, profiles, assetManifest, motionMap, dataOverlays }).errors
    .some(({ code }) => code === 'E_TIMELINE_PRODUCTION_AUTHORITY'));
});

test('timeline validates still hold/panzoom, speed curves, setup-tail, shake, and transition ownership', () => {
  const invalid = itemFixture({
    playbackRateCurve: [{ sourceTimeSeconds: 0, rate: 1 }, { sourceTimeSeconds: 2, rate: 13 }, { sourceTimeSeconds: 1, rate: 2 }],
    transform: { ...itemFixture().transform, stabilization: { mode: 'conservative', cropFraction: 0.2 } },
    transition: { kind: 'cross-dissolve', ownerId: null },
  });
  const result = validateTimeline({
    phase: 'rough', probe: probeFixture(),
    shots: { shots: [shotFixture({ setupTailLikelihood: 0.95, quality: { shake: 'severe' } })] },
    timeline: timelineFixture([invalid]), profiles,
  });
  for (const code of ['E_SPEED_CURVE_ORDER', 'E_SPEED_RATE', 'E_STABILIZATION_CROP', 'E_SETUP_TAIL', 'E_SEVERE_SHAKE', 'E_TRANSITION_OWNER']) {
    assert.ok(result.errors.some((entry) => entry.code === code), code);
  }

  const still = itemFixture({
    itemId: 'item-still', shotId: 'shot-image-001', sourceMediaId: 'media-image-001', sourceKind: 'image',
    sourceReference: { kind: 'proxy', path: 'review/probe/media-image-001.webp', digest: digest('2') },
    sourceInSeconds: 0, sourceOutSeconds: 0.001, sourceDurationSeconds: 0,
    destinationOutSeconds: 14,
    playbackRateCurve: [{ sourceTimeSeconds: 0, rate: 1 }],
    transform: { ...itemFixture().transform, stillMotion: { mode: 'panzoom', holdSeconds: 14, startScale: 1, endScale: 1.6 } },
  });
  const stillResult = validateTimeline({ phase: 'rough', probe: probeFixture(), shots: { shots: [shotFixture({ shotId: 'shot-image-001', mediaId: 'media-image-001', sourceDigest: digest('2') })] }, timeline: timelineFixture([still]), profiles });
  assert.ok(stillResult.errors.some(({ code }) => code === 'E_STILL_HOLD'));
  assert.ok(stillResult.errors.some(({ code }) => code === 'E_STILL_PANZOOM'));
});

test('duplicate and continuity findings stay explicit and require Agent decisions', () => {
  const shots = [
    shotFixture({ duplicateGroup: 'duplicate-a' }),
    shotFixture({ shotId: 'shot-video-002', duplicateGroup: 'duplicate-a', continuity: { ...shotFixture().continuity, screenDirection: 'right-to-left', motionDirection: 'backward' } }),
  ];
  const items = [itemFixture(), itemFixture({ itemId: 'item-002', shotId: 'shot-video-002', destinationInSeconds: 7, destinationOutSeconds: 11 })];
  assert.equal(findDuplicateViolations(timelineFixture(items), shots, 12).length, 1);
  assert.deepEqual(findContinuityWarnings(shots[0], shots[1]).map(({ code }) => code).sort(), ['W_MOTION_DIRECTION', 'W_SCREEN_DIRECTION']);
  const result = validateTimeline({ phase: 'rough', probe: probeFixture(), shots: { shots }, timeline: timelineFixture(items), profiles });
  assert.ok(result.errors.some(({ code }) => code === 'E_DUPLICATE_SEPARATION'));
  assert.equal(result.warnings.length, 2);
  assert.equal(result.agentDecisionRequired, true);

  const decidedTimeline = timelineFixture(items, { timelineRevision: 'timeline-2' });
  const timelineDigest = computeWarningDecisionDigest(decidedTimeline);
  decidedTimeline.warningDecisions = result.warnings.map(({ decisionId }) => ({
    decisionId, decision: 'accept', reason: 'intentional reversal at a story beat',
    timelineRevision: decidedTimeline.timelineRevision, timelineDigest,
  }));
  const decided = validateTimeline({ phase: 'rough', probe: probeFixture(), shots: { shots }, timeline: decidedTimeline, profiles });
  assert.equal(decided.agentDecisionRequired, false);
  assert.equal(decided.errors.length, 1, 'duplicate spacing remains a hard error independent of Agent warning acceptance');

  decidedTimeline.warningDecisions[0].timelineDigest = digest('f');
  const stale = validateTimeline({ phase: 'rough', probe: probeFixture(), shots: { shots }, timeline: decidedTimeline, profiles });
  assert.ok(stale.errors.some(({ code }) => code === 'E_WARNING_DECISION_STALE'));
  assert.equal(stale.agentDecisionRequired, true);
});

test('timeline lineage binds current probe, shots, and transcript and final kind cannot disguise a proxy path', () => {
  const probe = probeFixture();
  const shots = { shots: [shotFixture()], integrity: { digest: digest('b') } };
  const transcript = { status: 'unavailable', segments: [], integrity: { digest: digest('c') } };
  const timeline = timelineFixture([itemFixture()], {
    integrity: { upstream: { probe: digest('a'), shots: digest('d'), transcript: digest('c') } },
  });
  const stale = validateTimeline({ phase: 'rough', probe, shots, transcript, timeline, profiles });
  assert.ok(stale.errors.some(({ code }) => code === 'E_TIMELINE_LINEAGE'));

  const disguised = timelineFixture([itemFixture({
    sourceReference: { kind: 'original', path: 'media/proxies/media-video-001.mp4', digest: digest('1') },
  })], {
    phase: 'final', integrity: { upstream: { probe: digest('a'), shots: digest('b'), transcript: digest('c') } },
  });
  const finalResult = validateTimeline({
    phase: 'final', probe, shots, transcript, timeline: disguised, profiles,
    assetManifest: { status: 'frozen', assets: [] }, motionMap: { status: 'frozen', owners: [] },
  });
  assert.ok(finalResult.errors.some(({ code }) => code === 'E_FINAL_ORIGINAL_REQUIRED'));
});

test('timeline item cannot impersonate another shot to bypass shot quality and continuity authority', () => {
  const shots = { shots: [
    shotFixture({ shotId: 'shot-safe', sourceInSeconds: 0, sourceOutSeconds: 4 }),
    shotFixture({
      shotId: 'shot-risky', mediaId: 'media-image-001', sourceDigest: digest('2'), sourceDurationSeconds: 0,
      sourceInSeconds: 0, sourceOutSeconds: 0.001, quality: { shake: 'severe' }, setupTailLikelihood: 0.95,
    }),
  ] };
  const impersonated = itemFixture({ shotId: 'shot-risky' });
  const result = validateTimeline({ phase: 'rough', probe: probeFixture(), shots, timeline: timelineFixture([impersonated]), profiles });
  assert.ok(result.errors.some(({ code }) => code === 'E_SHOT_SOURCE_BINDING'));

  const outsideShot = itemFixture({ shotId: 'shot-safe', sourceInSeconds: 3.5, sourceOutSeconds: 5,
    playbackRateCurve: [{ sourceTimeSeconds: 3.5, rate: 1 }, { sourceTimeSeconds: 5, rate: 1 }], destinationOutSeconds: 1.5 });
  const bounded = validateTimeline({ phase: 'rough', probe: probeFixture(), shots, timeline: timelineFixture([outsideShot]), profiles });
  assert.ok(bounded.errors.some(({ code }) => code === 'E_SHOT_SOURCE_BOUNDS'));
});

test('final transition owner resolves in the frozen motion map and the item motion references', () => {
  const probe = probeFixture();
  const shots = { shots: [shotFixture()] };
  const base = itemFixture({
    sourceReference: { kind: 'original', path: 'media/originals/media-video-001.mp4', digest: digest('1') },
    transition: { kind: 'cross-dissolve', ownerId: 'owner-transition' }, motionReferences: [],
  });
  const result = validateTimeline({
    phase: 'final', probe, shots, timeline: timelineFixture([base], { phase: 'final' }), profiles,
    assetManifest: { status: 'frozen', assets: [] },
    motionMap: { status: 'frozen', owners: [{ ownerId: 'owner-transition', assetId: 'asset-transition' }] },
  });
  assert.ok(result.errors.some(({ code }) => code === 'E_TRANSITION_OWNER_REFERENCE'));

  const missing = structuredClone(base);
  missing.motionReferences = ['owner-transition'];
  const absent = validateTimeline({
    phase: 'final', probe, shots, timeline: timelineFixture([missing], { phase: 'final' }), profiles,
    assetManifest: { status: 'frozen', assets: [] }, motionMap: { status: 'frozen', owners: [] },
  });
  assert.ok(absent.errors.some(({ code }) => code === 'E_TRANSITION_OWNER_REFERENCE'));
});
