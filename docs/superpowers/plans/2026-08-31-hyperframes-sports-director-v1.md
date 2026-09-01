# HyperFrames Sports Director v1.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Use superpowers:test-driven-development for every code change and superpowers:writing-skills for the Skill RED-GREEN-REFACTOR cycle.

**Goal:** Ship `hyperframes-sports-director` v1.0.0 as a new, installable standard sports-Vlog editing workflow Skill that accepts a local mixed-media directory plus an editing brief and produces an immersive, truthful, approximately three-minute sports Vlog in 16:9 4K or 1080p, with optional music, copy, and activity-data enhancement.

**Architecture:** A thin Agent orchestrates small Node.js/FFmpeg commands through versioned file contracts. Originals are immutable; proxies exist only for analysis and rough review. Declarative sport, device, and delivery profiles supply policy. HyperFrames retains ownership of visual direction, Image Gen asset systems, component cropping, motion choreography, and final composition. `ASSET_MANIFEST.json`, `MOTION_MAP.json`, and `TIMELINE.json` remain separate sources of truth.

**Tech Stack:** Node.js 22.12+ ESM, npm lockfile, built-in `node:test`, JSON Schema with Ajv, Sharp for component extraction/proofs, local FFmpeg/ffprobe, HTML/CSS/SVG/GSAP/Lottie/Three.js where a motion role requires them, HyperFrames project scaffolding, Markdown Agent Skill instructions, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-31-hyperframes-sports-director-v1-design.md`

## Global Constraints

- [ ] Start a new AGPL-3.0 repository named `hyperframes-sports-director`; do not edit either upstream repository in place.
- [ ] Resolve and pin literal commit SHAs for `geekjourneyx/hyperframes-motion-director` and `op7418/guizang-sports-skill` in `UPSTREAM.lock.json` before adapting code. Never build from floating branch names.
- [ ] Preserve attribution, copyright notices, and a derivation map for adapted AGPL files.
- [ ] Preserve HyperFrames' visual-world, component-sheet, hero-asset, crop, alpha-proof, combination-test, motion-ownership, deterministic-timeline, transition-midpoint, and final-MP4-review contracts.
- [ ] Treat local FFmpeg/ffprobe as mandatory from directory scan and visual/audio analysis through music mixing, picture composition, delivery encoding, and final QC. `check_install` must stop when they are absent.
- [ ] Treat HyperFrames as the mandatory visual-direction and motion-composition core, not an optional polish pass.
- [ ] Keep `SKILL.md` below 500 lines. Put shared routing and non-obvious invariants there; put mode-specific detail in one-level-deep `references/` files and deterministic work in `scripts/`.
- [ ] Keep implicit invocation enabled. The frontmatter description must start with `Use when`, be third-person, distinguish directory-based sports-Vlog editing from generic FFmpeg and promotional motion work, and avoid summarizing the full workflow.
- [ ] Follow the Skill TDD order: run new-skill baseline evals without the Skill, capture failures, write the minimum useful Skill, run with-Skill evals, then refactor from observed failures.
- [ ] Follow code TDD strictly: add one failing test, run it and verify the expected failure, add minimum production code, rerun the focused test, then run the full suite before committing.
- [ ] Source footage and recorded data are evidence. Generated imagery may interpret or bridge experience but may not impersonate real footage or invent metrics.
- [ ] Missing activity values are `null` or `status: "unavailable"`, never numeric zero.
- [ ] Activity data is optional. With no FIT/KML/normalized activity JSON, the full media-editing pipeline still completes and emits `ACTIVITY.json` with `status: "unavailable"` without empty data graphics.
- [ ] Freeze one project-level `DESIGN_SYSTEM.json` and one independent `LOOK_PROFILE.json` before generating visual assets. Scenes may reference semantic tokens but may not introduce arbitrary colors.
- [ ] Default v1 delivery color is SDR Rec.709. Enforce rendered local contrast (`7:1` target/`4.5:1` floor for critical text, `4.5:1` ordinary text, `3:1` large text/meaningful graphics), motion-interval sampling, and final token color Delta E 2000 `<=3`.
- [ ] Do not commit real user footage, GPS, biometrics, secrets, large generated media, or eval workspaces.
- [ ] Never modify the user-provided input directory. Register supported video, image, audio, activity-data, and sidecar files by hash and provenance; report unsupported files.
- [ ] Production defaults are 16:9 `3840x2160` or `1920x1080`; normal target duration is `180s` with accepted range `150–210s` unless the user overrides it.
- [ ] A final render must resolve original media and use one final lossy encode. Proxy-backed finals are a release blocker.
- [ ] Release requires all hard gates, at least `90/100` on cycling, hiking, and pool-swimming golden evals, and no category below 80% of its available points.

## File and Responsibility Map

```text
hyperframes-sports-director/
├── .github/workflows/ci.yml                 # tests on supported Node/OS matrix
├── .github/workflows/release.yml            # v* packaging and release gates
├── AGENTS.md                                 # contributor TDD and scope rules
├── ATTRIBUTIONS.md                           # upstream file-level derivation
├── CHANGELOG.md                              # 1.0.0 release notes
├── LICENSE                                   # AGPL-3.0
├── README.md                                 # project-facing install and use
├── RELEASING.md                              # reproducible release procedure
├── UPSTREAM.lock.json                        # pinned upstream URLs and SHAs
├── package.json
├── package-lock.json
├── docs/architecture.md                      # UNIX boundaries and data flow
├── docs/design-engineering.md                # design tokens and review logic
├── docs/upstream-derivation.md               # kept/adapted/replaced rationale
└── skills/hyperframes-sports-director/
    ├── SKILL.md                              # concise router and core invariants
    ├── agents/openai.yaml                    # UI metadata and invocation policy
    ├── assets/hyperframes-project/           # copied project scaffold, not instructions
    ├── assets/icons/                         # final generated Skill icons
    ├── profiles/
    │   ├── devices/dji-osmo-action-5-pro.json
    │   ├── delivery/landscape-1080p.json
    │   ├── delivery/landscape-4k.json
    │   └── sports/{cycling,running,hiking,mountaineering,trail-running,pool-swimming,open-water-swimming}.json
    ├── references/
    │   ├── activity-data.md
    │   ├── asset-choreography-and-render-qa.md
    │   ├── audio-continuity.md
    │   ├── clarity-and-export.md
    │   ├── continuity-editing.md
    │   ├── hyperframes-composition.md
    │   ├── imagegen-asset-pipeline.md
    │   ├── ingest-and-shot-understanding.md
    │   ├── sport-profiles.md
    │   ├── unix-pipeline.md
    │   ├── visual-standard.md
    │   └── workflow.md
    ├── schemas/
    │   ├── activity.schema.json
    │   ├── asset-manifest.schema.json
    │   ├── beat-map.schema.json
    │   ├── edit-brief.schema.json
    │   ├── design-system.schema.json
    │   ├── look-profile.schema.json
    │   ├── media-index.schema.json
    │   ├── motion-map.schema.json
    │   ├── project.schema.json
    │   ├── review-metrics.schema.json
    │   ├── scene-schema.schema.json
    │   ├── shot.schema.json
    │   ├── sync-map.schema.json
    │   ├── timeline.schema.json
    │   └── transcript.schema.json
    ├── templates/
    │   ├── ACTIVITY.template.json
    │   ├── ASSET_MANIFEST.template.json
    │   ├── BEAT_MAP.template.json
    │   ├── BRIEF_DESIGN_PROPOSAL.template.md
    │   ├── EDIT_BRIEF.template.json
    │   ├── DESIGN_SYSTEM.template.json
    │   ├── LOOK_PROFILE.template.json
    │   ├── MEDIA_INDEX.template.json
    │   ├── MOTION_MAP.template.json
    │   ├── PROJECT.template.json
    │   ├── REVIEW_REPORT.template.md
    │   ├── SCENE_SCHEMA.template.json
    │   ├── SHOT.template.json
    │   ├── SYNC_MAP.template.json
    │   ├── TIMELINE.template.json
    │   └── TRANSCRIPT.template.json
    ├── scripts/
    │   ├── analyze_activity.mjs
    │   ├── build_asset_proofs.mjs
    │   ├── build_contact_sheets.mjs
    │   ├── build_proxies.mjs
    │   ├── check_install.mjs
    │   ├── check_release.mjs
    │   ├── check_structure.mjs
    │   ├── create_project.mjs
    │   ├── crop_component_sheet.mjs
    │   ├── inspect_output.mjs
    │   ├── ingest_media.mjs
    │   ├── probe_media.mjs
    │   ├── render_final.mjs
    │   ├── render_rough_cut.mjs
    │   ├── score_eval.mjs
    │   ├── segment_media.mjs
    │   ├── validate_artifacts.mjs
    │   ├── validate_color_pipeline.mjs
    │   ├── validate_contrast.mjs
    │   ├── validate_design_system.mjs
    │   ├── validate_image_assets.mjs
    │   ├── validate_shots.mjs
    │   ├── validate_timeline.mjs
    │   ├── lib/{cli,contracts,ffmpeg,files,media,time}.mjs
    │   └── tests/*.test.mjs
    └── evals/
        ├── evals.json
        ├── rubric.json
        ├── trigger-evals.json
        ├── trigger-prompts.md
        ├── fixtures/generate-fixtures.mjs
        ├── fixtures/projects/{cycling,hiking,pool-swimming}/
        └── expected/{cycling,hiking,pool-swimming}.json
```

## Test Commands Used Throughout

```bash
npm ci
npm test
npm run test:contracts
npm run test:media
npm run test:skill
npm run eval
npm run check
npm run release:dry
```

Expected final result: all commands exit `0`; `npm run eval` reports three profile scores `>= 90`, and `npm run release:dry` creates `dist/hyperframes-sports-director-v1.0.0.skill` without publishing or tagging.

## Task 1: Freeze Upstream Lineage and Scaffold the Repository

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `LICENSE`
- Create: `AGENTS.md`
- Create: `UPSTREAM.lock.json`
- Create: `ATTRIBUTIONS.md`
- Create: `docs/upstream-derivation.md`
- Create: `skills/hyperframes-sports-director/scripts/tests/upstream_lock.test.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/files.mjs`

- [ ] **Step 1: Initialize the new repository and resolve immutable upstream SHAs**

Run:

```bash
mkdir hyperframes-sports-director
cd hyperframes-sports-director
git init
git branch -M main
git ls-remote https://github.com/geekjourneyx/hyperframes-motion-director.git HEAD
git ls-remote https://github.com/op7418/guizang-sports-skill.git HEAD
```

Write the returned 40-character SHAs and repository URLs into `UPSTREAM.lock.json`. Do not copy a sample SHA from this plan.

- [ ] **Step 2: Write the failing lineage test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('pins both AGPL upstreams to immutable commits', async () => {
  const lock = JSON.parse(await readFile('UPSTREAM.lock.json', 'utf8'));
  assert.deepEqual(lock.upstreams.map((x) => x.name).sort(), [
    'guizang-sports-skill',
    'hyperframes-motion-director',
  ]);
  for (const upstream of lock.upstreams) {
    assert.match(upstream.commit, /^[0-9a-f]{40}$/);
    assert.equal(upstream.license, 'AGPL-3.0');
  }
});
```

- [ ] **Step 3: Run RED, then add minimal repository metadata**

Run `node --test skills/hyperframes-sports-director/scripts/tests/upstream_lock.test.mjs`. Expected RED: `ENOENT: UPSTREAM.lock.json`.

Create `package.json` with name/version/type/engine and scripts, then add the literal upstream lock. Use Node `>=22.12.0`, version `1.0.0`, and ESM. Add `.gitignore` entries for `node_modules/`, `dist/`, `*-workspace/`, project `cache/`, media originals/proxies/renders, and generated eval media.

```json
{
  "name": "hyperframes-sports-director",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "license": "AGPL-3.0-only",
  "engines": { "node": ">=22.12.0" },
  "scripts": {
    "test": "node --test skills/hyperframes-sports-director/scripts/tests/*.test.mjs",
    "test:contracts": "node --test skills/hyperframes-sports-director/scripts/tests/contracts.test.mjs skills/hyperframes-sports-director/scripts/tests/*_contract.test.mjs",
    "test:media": "node --test skills/hyperframes-sports-director/scripts/tests/probe_media.test.mjs skills/hyperframes-sports-director/scripts/tests/build_proxies.test.mjs skills/hyperframes-sports-director/scripts/tests/render.test.mjs skills/hyperframes-sports-director/scripts/tests/inspect_output.test.mjs",
    "test:skill": "node --test skills/hyperframes-sports-director/scripts/tests/check_structure.test.mjs skills/hyperframes-sports-director/scripts/tests/trigger_eval.test.mjs",
    "eval": "node skills/hyperframes-sports-director/scripts/score_eval.mjs --all-golden",
    "check": "node skills/hyperframes-sports-director/scripts/check_structure.mjs && node skills/hyperframes-sports-director/scripts/check_release.mjs --check-only",
    "release:dry": "node skills/hyperframes-sports-director/scripts/check_release.mjs --version 1.0.0 --dry-run"
  }
}
```

- [ ] **Step 4: Add the derivation matrix**

`docs/upstream-derivation.md` must map each retained HyperFrames contract to its sports adaptation and record Guizang's activity normalization/privacy lineage. At minimum map:

| Upstream responsibility | v1 destination | Decision |
|---|---|---|
| `SKILL.md` phase gates | `SKILL.md`, `references/workflow.md` | Adapt terminology; retain gates |
| Image Gen pipeline | `references/imagegen-asset-pipeline.md` and image scripts | Retain and extend sports roles |
| Asset choreography/render QA | matching reference and validators | Retain invariants |
| Motion primitives/schema/beat map | schemas and templates | Retain as separate contracts |
| Guizang report contract | activity schema/analyzer | Adapt null/privacy/weighted metrics |

- [ ] **Step 5: Verify GREEN and commit**

Run the focused test, then `npm test`. Expected: both exit `0`.

```bash
git add .
git commit -m "chore: scaffold sports vlog director v1"
```

## Task 2: Establish Skill RED Baselines Before Writing `SKILL.md`

**Files:**
- Create: `skills/hyperframes-sports-director/evals/evals.json`
- Create: `skills/hyperframes-sports-director/evals/rubric.json`
- Create: `skills/hyperframes-sports-director/evals/trigger-evals.json`
- Create: `skills/hyperframes-sports-director/scripts/tests/eval_contract.test.mjs`
- Create: `docs/skill-baseline-report.md`
- Modify: `.gitignore`

- [ ] **Step 1: Write a failing eval-shape test**

Assert that `evals.json` has at least six realistic prompts, including a mixed video/image directory, cycling with FIT data, hiking without data, pool swimming, noisy speech with background music, 4K delivery with a file-size limit, copy requirements, and visual-component generation. Assert `trigger-evals.json` contains exactly 20 items, 10 `should_trigger: true` and 10 hard near-miss negatives.

- [ ] **Step 2: Run RED**

Run:

```bash
node --test skills/hyperframes-sports-director/scripts/tests/eval_contract.test.mjs
```

Expected RED: missing eval files.

- [ ] **Step 3: Add realistic eval prompts and objective expectations**

Use this record shape:

```json
{
  "id": "cycling-fit-4k",
  "prompt": "把 /data/2026-ride 目录中 DJI Action 5 Pro 的视频、手机照片、music.m4a 和 FIT 数据剪成约 3 分钟 16:9 4K 沉浸式 Vlog，成片 MP4 不超过 1.5 GB，保留环境声，给我一级标题和简短章节文案，去掉捡相机片段，用 HyperFrames 和 Image Gen 做克制的路线与转场视觉。",
  "expected_output": "A validated project containing shot evidence, truthful activity data, original-backed timeline, asset manifest, motion map, final MP4, and review report.",
  "files": []
}
```

Near-miss negatives must include: a generic FFmpeg concat command, a product launch promo, a single photo retouch, sports-data-only analysis, a vertical TikTok ad, and a request to fabricate a faster pace.

- [ ] **Step 4: Run independent no-Skill baselines**

Before creating `SKILL.md`, run all six prompts in fresh contexts with no access to the Skill. Store raw outputs in the gitignored sibling directory `hyperframes-sports-director-workspace/iteration-0/without_skill/`. Record observed failures verbatim in `docs/skill-baseline-report.md` under these categories:

- proxies accidentally treated as final sources;
- promotional rather than experiential pacing;
- missing shot/audio continuity contracts;
- invented or zero-filled activity data;
- Image Gen assets pasted on without provenance/crop/motion ownership;
- overfitting to cycling;
- weak final MP4 inspection.

Do not invent baseline failures that did not occur.

- [ ] **Step 5: Verify GREEN and commit**

Run the eval-shape test. Expected: pass.

```bash
git add skills/hyperframes-sports-director/evals docs/skill-baseline-report.md .gitignore
git commit -m "test: capture sports vlog skill baselines"
```

## Task 3: Define Versioned Data Contracts and Validation Library

**Files:**
- Create: `skills/hyperframes-sports-director/schemas/*.schema.json`
- Create: `skills/hyperframes-sports-director/templates/*.template.*`
- Create: `skills/hyperframes-sports-director/scripts/lib/contracts.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/time.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_artifacts.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/contracts.test.mjs`
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Write failing tests for contract identity and invariants**

Tests must prove:

```js
assert.equal(project.schemaVersion, '1.0.0');
assert.equal(editBrief.delivery.aspectRatio, '16:9');
assert.equal(editBrief.music.mode, 'provided');
assert.equal(mediaIndex.entries[0].sourceRootReadOnly, true);
assert.equal(activity.metrics.averageHeartRate, null);
assert.equal(activity.availability.heartRate, 'unavailable');
assert.notEqual(assetManifest.$id, motionMap.$id);
assert.notEqual(motionMap.$id, timeline.$id);
assert.equal(activity.status, 'unavailable');
assert.equal(designSystem.status, 'frozen');
assert.equal(lookProfile.output.colorSpace, 'rec709-sdr');
```

Also test unique media/shot IDs, optional-activity status, mixed-media classification, copy/music modes, maximum-file-size semantics, design-system revisions, semantic-token references, independent look profiles, monotonic destination times, source bounds, ISO-8601 timestamps, and rejection of unknown schema versions.

- [ ] **Step 2: Run RED**

Run `node --test skills/hyperframes-sports-director/scripts/tests/contracts.test.mjs`. Expected RED: imports or schema files are missing.

- [ ] **Step 3: Implement minimal schemas and validator API**

Expose:

```js
export async function loadSchema(name) {}
export function validateDocument(schema, value) {}
export async function validateArtifact(path, schemaName) {}
export function secondsToFrames(seconds, fps) {}
export function framesToSeconds(frames, fps) {}
```

Use Ajv strict mode with `allErrors: true`. Errors printed by `validate_artifacts.mjs` must be JSON with `code`, `path`, `message`, and `schema`.

- [ ] **Step 4: Add complete templates with no placeholders**

Templates must be immediately valid documents using empty collections, `null`, or `status: "unavailable"`; they must not use instructional strings such as “fill this in.” `EDIT_BRIEF` must cover sport, story, music, copy, duration, format, codecs, raster, frame-rate policy, maximum size, inclusions, exclusions, and privacy. `DESIGN_SYSTEM` defines frozen semantic tokens and contrast thresholds; `LOOK_PROFILE` defines input/working/output color handling and defaults to SDR Rec.709. Keep `ASSET_MANIFEST`, `MOTION_MAP`, and `TIMELINE` as separate files.

- [ ] **Step 5: Verify and commit**

Run the focused test and `npm test`.

```bash
git add package.json package-lock.json skills/hyperframes-sports-director/{schemas,templates,scripts}
git commit -m "feat: define v1 media and motion contracts"
```

## Task 4: Add Declarative Sport, Device, and Delivery Profiles

**Files:**
- Create: `skills/hyperframes-sports-director/profiles/devices/dji-osmo-action-5-pro.json`
- Create: `skills/hyperframes-sports-director/profiles/delivery/*.json`
- Create: `skills/hyperframes-sports-director/profiles/sports/*.json`
- Create: `skills/hyperframes-sports-director/scripts/lib/profiles.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/profiles.test.mjs`

- [ ] **Step 1: Write failing cross-sport tests**

Assert all seven sport profiles implement the same keys: `journeyGrammar`, `cameraRoleWeights`, `speedPolicy`, `stabilizationPolicy`, `duplicatePolicy`, `audioPolicy`, `dataPolicy`, and `visualPolicy`. Add behavioral tests:

- cycling permits a higher maximum montage rate than hiking;
- mountaineering rejects speed treatment marked `risk_obscuring`;
- pool swimming does not require GPS and includes lap-turn continuity;
- open-water swimming permits GPS but marks it optional;
- 4K and 1080p profiles are exactly `3840×2160` and `1920×1080`.

- [ ] **Step 2: Run RED**

Expected: missing profile loader.

- [ ] **Step 3: Implement profile composition**

Expose `loadProfile(kind, name)` and `resolvePolicies({ sport, device, delivery })`. Merge only documented namespaces; reject unknown keys and conflicting raster/aspect-ratio values.

- [ ] **Step 4: Verify all profiles through one parameterized suite**

Run:

```bash
node --test skills/hyperframes-sports-director/scripts/tests/profiles.test.mjs
```

Expected: seven sport subtests, one device subtest, and two delivery subtests pass.

- [ ] **Step 5: Commit**

```bash
git add skills/hyperframes-sports-director/profiles skills/hyperframes-sports-director/scripts
git commit -m "feat: add sport-neutral policy profiles"
```

## Task 5: Create Projects and Verify Local Capabilities

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/create_project.mjs`
- Create: `skills/hyperframes-sports-director/scripts/check_install.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/cli.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/create_project.test.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/check_install.test.mjs`
- Create: `docs/architecture.md`

- [ ] **Step 1: Write failing CLI tests using a temporary directory**

The create test must assert the exact artifact tree from the design spec, copied valid templates, selected profiles in `PROJECT.json`, normalized choices in `EDIT_BRIEF.json`, and no copied media when reference mode is used. The install test must dependency-inject command results so missing `ffmpeg`, `ffprobe`, required filters, Node version, Sharp, and HyperFrames scaffold are independently testable.

- [ ] **Step 2: Run RED**

Run the two test files. Expected: missing CLI modules.

- [ ] **Step 3: Implement deterministic project creation**

Required interface:

```bash
node skills/hyperframes-sports-director/scripts/create_project.mjs \
  --project /tmp/ride-vlog \
  --input /data/2026-ride \
  --sport cycling \
  --device dji-osmo-action-5-pro \
  --delivery landscape-4k \
  --duration 180 \
  --music provided \
  --copy titles \
  --max-size-mib 1536
```

Refuse a non-empty destination unless `--resume` finds a compatible `PROJECT.json`. Never overwrite originals.

- [ ] **Step 4: Implement machine-readable install checks**

`check_install.mjs --json` must report `ok`, detected versions, and required FFmpeg filters including `blackdetect`, `freezedetect`, `silencedetect`, `ebur128`, `vidstabdetect`/`vidstabtransform` availability, and `ssim`. A missing optional stabilization filter produces a named fallback warning; missing FFmpeg/ffprobe is fatal.

Document the same command boundaries in `docs/architecture.md`: one responsibility per command, file-based composition, stdout diagnostics, non-zero failure exits, immutable originals, and policy/profile separation.

- [ ] **Step 5: Verify and commit**

Run focused tests and `npm test`, then commit.

## Task 6: Scan the Mixed-Media Directory, Probe Originals, and Build Provenance-Safe Proxies

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/probe_media.mjs`
- Create: `skills/hyperframes-sports-director/scripts/ingest_media.mjs`
- Create: `skills/hyperframes-sports-director/scripts/build_proxies.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/ffmpeg.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/media.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/probe_media.test.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/ingest_media.test.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/build_proxies.test.mjs`
- Create: `skills/hyperframes-sports-director/evals/fixtures/generate-fixtures.mjs`

- [ ] **Step 1: Write a deterministic fixture generator and failing tests**

Generate small 16:9 clips from FFmpeg `lavfi`: color bars with moving geometry, a 1 kHz tone interrupted by silence, a duplicate interval, a black interval, a frozen interval, and a high-frequency shake segment. Add JPEG, PNG, WebP, WAV/M4A, FIT, KML, sidecar JSON, and unsupported text fixtures. Write source timestamps into filenames. Tests assert read-only directory scanning, media classification, SHA-256, still-image dimensions/color metadata, video stream metadata, rotation, capture time, and proxy-to-original time mapping.

- [ ] **Step 2: Run RED**

Expected: `ingest_media.mjs`, `probe_media.mjs`, and `build_proxies.mjs` are missing.

- [ ] **Step 3: Implement safe subprocess and probe normalization**

Use `spawn(command, args, { shell: false })`. `ingest_media.mjs` recursively enumerates the declared directory, ignores hidden/system files, classifies supported video/image/audio/activity/sidecar types, records absolute source path plus hash, writes `analysis/MEDIA_INDEX.json`, and never writes inside the input root. Probe still images with local ffprobe/FFmpeg decoding as well as video/audio. Normalize rational frame rates and time bases without rounding to integer fps. Preserve ffprobe raw output under `analysis/probe/raw/` and write stable normalized `analysis/PROBE.json`.

- [ ] **Step 4: Implement analysis proxies**

Video proxies must preserve timestamps and audio, record source SHA-256 and transform parameters, and be visibly watermarked `ANALYSIS PROXY`. Still-image analysis derivatives preserve aspect ratio and EXIF orientation. A helper `assertFinalSource(path)` must reject any path under `media/proxies/` or analysis derivatives.

- [ ] **Step 5: Verify and commit**

Run focused tests, `npm run test:media`, and commit.

## Task 7: Segment Media and Produce Evidence for Agent Shot Understanding

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/segment_media.mjs`
- Create: `skills/hyperframes-sports-director/scripts/build_contact_sheets.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_shots.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/segment_media.test.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/shot_contract.test.mjs`
- Create: `skills/hyperframes-sports-director/references/ingest-and-shot-understanding.md`

- [ ] **Step 1: Write failing tests for evidence, not fake semantics**

Tests must assert deterministic scene boundaries, minimum/maximum sample density, contact-sheet frame timestamps, still-image evidence generation, and validation of Agent-authored `SHOTS.jsonl`. FFmpeg is mandatory for local decode, keyframe/evidence extraction, image normalization, and motion/audio measurements; the segmenter must never pretend those mechanical results are semantic camera/action labels. The Agent performs semantic recognition from the extracted evidence and short source clips, with confidence and evidence-frame references.

- [ ] **Step 2: Run RED**

Expected: missing segment/contact-sheet commands.

- [ ] **Step 3: Implement mechanical analysis**

Produce `SEGMENTS.json` with source/time/scene-score/motion-score/audio-presence and evidence frames. Build readable contact sheets with shot ID, source timecode, and filename baked into gutters rather than over the image.

- [ ] **Step 4: Implement shot validation**

Validate camera role, action role, environment, quality, continuity vectors, audio spans, duplicate group, setup-tail likelihood, evidence frames, and confidence. Permit `unknown` plus low confidence; reject invented fields and source intervals outside probe bounds.

- [ ] **Step 5: Document Agent review routing and commit**

The reference must tell the Agent to inspect contact sheets first, open short clips when motion/audio ambiguity remains, and ask for review when high-impact shots have low confidence. Commit after focused and full tests pass.

## Task 8: Normalize FIT/KML Data, Sync It, and Protect Privacy

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/analyze_activity.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/activity.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/activity.test.mjs`
- Create: `skills/hyperframes-sports-director/references/activity-data.md`
- Modify: `ATTRIBUTIONS.md`

- [ ] **Step 1: Write failing tests derived from Guizang invariants**

Test FIT, KML, and normalized JSON inputs. Assert:

- missing heart rate stays `null` and `unavailable`;
- averages use duration or distance weighting, not arithmetic mean of segment means;
- an invalid file exits non-zero with a diagnostic and no partial metric document;
- start/end GPS privacy trimming occurs before route graphics are exported;
- absolute timestamp, manual anchor, and explicit offset produce reproducible `SYNC_MAP.json`;
- pool swimming succeeds without GPS.
- no activity input emits `status: "unavailable"` and does not block project validation;
- coverage controls display authority at `<10%`, `10–39.9%`, `40–79.9%`, and `>=80%`;
- mixed-sport rankings never compare unlike sport profiles;
- public route export uses the trimmed derivative rather than only emitting a warning.

- [ ] **Step 2: Run RED**

Expected: missing activity analyzer.

- [ ] **Step 3: Implement normalization and privacy as pure functions**

Expose `normalizeActivity`, `weightedAverage`, `trimPrivateEndpoints`, and `buildSyncMap`. Reuse/adapt Guizang code only with file-level attribution. Keep raw GPS and biometrics out of logs.

- [ ] **Step 4: Add CLI contract**

```bash
node skills/hyperframes-sports-director/scripts/analyze_activity.mjs \
  --input activity.fit \
  --project /tmp/ride-vlog \
  --trim-start-m 300 \
  --trim-end-m 300
```

Write normalized `ACTIVITY.json` and `SYNC_MAP.json`; do not render a report or graphic in this command.

- [ ] **Step 5: Verify and commit**

Run focused tests, contract tests, and commit.

## Task 9: Validate Editorial Timeline, Continuity, Duplicates, and Audio Cuts

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/validate_timeline.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/timeline.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/audio.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/timeline.test.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/audio_continuity.test.mjs`
- Create: `skills/hyperframes-sports-director/references/continuity-editing.md`
- Create: `skills/hyperframes-sports-director/references/audio-continuity.md`

- [ ] **Step 1: Write failing editorial-invariant tests**

Cover video/still source bounds, original-only final references, still-image hold and pan/zoom limits, playback-rate curves, duplicate separation, screen/motion direction warnings, setup-tail rejection, severe-shake handling, and transition ownership. Add a protected transcript span from `4.0–5.2s` and prove a cut at `4.7s` fails unless an L-cut/J-cut/ambience bridge is declared. Add a music loop seam and prove it fails without a crossfade.

- [ ] **Step 2: Run RED**

Expected: missing timeline/audio modules.

- [ ] **Step 3: Implement pure validators**

Expose:

```js
validateTimeline({ project, probe, shots, transcript, assetManifest, motionMap, timeline, profiles })
findProtectedSpeechCuts(timeline, transcript)
findDuplicateViolations(timeline, shots, minSeparationSeconds)
findContinuityWarnings(previousShot, nextShot)
```

Return errors and warnings separately. Hard errors block render; warnings require an Agent decision recorded in `TIMELINE.json`.

- [ ] **Step 4: Encode treatment policies, not aesthetic automation**

Timeline supports stabilization, crop/reframe, still-image hold/pan/zoom, speed ramp, color transform, optional face/skin treatment, source-audio gain, denoise, background-music trim/loop/fade/duck, and continuity bridges. Scripts validate parameters and compile filters; the Agent chooses whether treatment improves the shot. Default face treatment is `off`.

- [ ] **Step 5: Verify and commit**

Run focused tests and the full suite, then commit.

## Task 10: Preserve and Extend the HyperFrames Image Gen Asset Pipeline

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/crop_component_sheet.mjs`
- Create: `skills/hyperframes-sports-director/scripts/build_asset_proofs.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_image_assets.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/image-assets.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/image_assets.test.mjs`
- Create: `skills/hyperframes-sports-director/references/imagegen-asset-pipeline.md`
- Create: `skills/hyperframes-sports-director/references/asset-choreography-and-render-qa.md`
- Create: `skills/hyperframes-sports-director/references/visual-standard.md`

- [ ] **Step 1: Write failing asset-integrity tests**

Generate a synthetic component sheet with known colored silhouettes. Test crop boxes, transparent background, visible alpha bounds, padding, minimum effective resolution, dark/light proof generation, role coverage, combination tests, and rejection of direct source-sheet references in `TIMELINE.json`.

- [ ] **Step 2: Run RED**

Expected: image-asset modules are missing.

- [ ] **Step 3: Implement crop, proof, and manifest mechanics**

Use Sharp to extract components. Keep source sheets immutable. Each manifest entry includes `id`, `source`, `sourceKind`, `provenance`, `documentaryStatus`, `narrativeRole`, `crop`, `alphaBounds`, `proofs`, `allowedUses`, and `combinationTests`.

- [ ] **Step 4: Port HyperFrames visual rules into progressive references**

The Image Gen reference must retain:

- count meanings before images;
- define visual worlds and foreground inventory;
- component sheets for related parts;
- separate hero generation when resolution/silhouette requires it;
- source/components/proofs directory separation;
- dark/light alpha proofs;
- combination tests before choreography.

The sports extension defines `journey_anchor`, `activity_evidence`, and `experience_carrier`, with examples for terrain, water flow, route, effort, and environmental texture. It explicitly forbids generated scenery as documentary evidence.

- [ ] **Step 5: Verify and commit**

Run `node --test .../image_assets.test.mjs`, full tests, and commit.

## Task 11: Build Deterministic HyperFrames Composition and Motion Ownership

**Files:**
- Create: `skills/hyperframes-sports-director/assets/hyperframes-project/index.html`
- Create: `skills/hyperframes-sports-director/assets/hyperframes-project/src/main.js`
- Create: `skills/hyperframes-sports-director/assets/hyperframes-project/src/scene-runtime.js`
- Create: `skills/hyperframes-sports-director/assets/hyperframes-project/src/styles.css`
- Create: `skills/hyperframes-sports-director/scripts/lib/motion.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_design_system.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_color_pipeline.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_contrast.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/motion_contract.test.mjs`
- Create: `skills/hyperframes-sports-director/references/hyperframes-composition.md`
- Create: `docs/design-engineering.md`

- [ ] **Step 1: Write failing motion-contract tests**

Assert every visible asset has exactly one motion owner, every scene has entry/hold/exit intervals, each transition owns a non-empty midpoint, and timeline values are deterministic for the same seed. Reject `Date.now`, unseeded `Math.random`, `setTimeout`, `setInterval`, and render-truth `requestAnimationFrame` in the scaffold. Reject raw scene-local color literals, unresolved semantic tokens, non-frozen design systems, undeclared input color interpretation, and non-Rec.709 v1 delivery.

- [ ] **Step 2: Run RED**

Expected: missing motion runtime/scaffold.

- [ ] **Step 3: Implement the paused master-timeline contract**

Expose registered timelines through `window.__timelines`. Composition renders a supplied absolute time; it does not advance itself. GSAP/SVG/CSS/Lottie/Three.js are selected by semantic role, with static fallbacks for review extraction.

- [ ] **Step 4: Implement design tokens and transition grammar**

Define tokens for title hierarchy, metric typography, safe zones, spacing, contrast, colors, strokes, radii, shadow/depth, entry/exit durations, and easing. Preserve the HyperFrames fallback grammar (`#050505`, white/gray, restrained warm gold), but allow one footage-derived project accent and Guizang-derived semantic data colors only through the frozen design system. Transitions must declare relationship: spatial continuation, motion match, shape/mask carry, environmental texture bridge, or data-to-footage bridge. Pure decorative transitions fail review.

- [ ] **Step 5: Verify and commit**

Run motion tests twice and compare normalized outputs byte-for-byte, then full tests and commit.

## Task 12: Render Rough Cuts and Original-Backed Finals

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/render_rough_cut.mjs`
- Create: `skills/hyperframes-sports-director/scripts/render_final.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/render.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/render.test.mjs`
- Create: `skills/hyperframes-sports-director/references/clarity-and-export.md`

- [ ] **Step 1: Write failing render-plan tests before invoking FFmpeg**

Given a timeline and brief, assert the compiled plan resolves proxies only for rough cut, originals only for final, decodes original still images, preserves rational fps, calculates transforms from source and delivery rasters, includes source-audio bridges and requested background music, and keys cache chunks by source hash plus normalized treatment parameters.

- [ ] **Step 2: Run RED**

Expected: missing render compiler.

- [ ] **Step 3: Implement render-plan compilation and cache**

Compile explicit FFmpeg argument arrays. Stabilization uses a two-pass filter when available and a documented conservative fallback otherwise. Speed changes use matched video PTS and audio tempo chains; no clip may silently desynchronize audio. Background music uses trim/loop, fades, loudness normalization, speech-aware ducking, and ambience-priority automation declared by the timeline.

- [ ] **Step 4: Implement final export policies**

4K output is `3840:2160`; 1080p output is `1920:1080`; both use square pixels and 16:9. Container, codecs, and optional `maxFileSizeMiB` come from `EDIT_BRIEF.json`. A hard size ceiling uses an explicit audio/video bitrate budget and two-pass encoding; the first pass writes no delivery media. If the requested duration/raster/codec/size violates the clarity floor, fail with alternatives rather than silently lowering quality. The final command resolves original hashes, composes HyperFrames layers, and performs one delivery encode. Write a render provenance sidecar before moving the successful temporary output to `renders/final.mp4`.

- [ ] **Step 5: Verify with synthetic 1080p and short 4K renders**

Run the focused media test. Expected: correct dimensions/fps, proxy watermark absent from final, A/V duration delta within one frame, and cache hit on the identical second render. Commit.

## Task 13: Inspect the Final MP4 and Produce Review Evidence

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/inspect_output.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/inspect_output.test.mjs`
- Modify: `skills/hyperframes-sports-director/templates/REVIEW_REPORT.template.md`
- Create: `skills/hyperframes-sports-director/references/workflow.md`

- [ ] **Step 1: Write failing QC tests using injected known defects**

Fixtures must include black frames, freeze spans, clipped audio, loudness outside policy, A/V duration drift, deliberate excessive detail loss, low-contrast moving backgrounds, token color drift, and an undeclared input color profile. Add frame-evidence assertions for each scene's entry, hold, exit, and every transition midpoint.

- [ ] **Step 2: Run RED**

Expected: missing output inspector.

- [ ] **Step 3: Implement measurable QC**

Use ffprobe plus FFmpeg `blackdetect`, `freezedetect`, `ebur128`, clipping analysis, and SSIM on controlled identity segments. Sample local contrast across every readable interval: critical text must pass every sample; ordinary text must pass at least 95% with no failure longer than 0.25 seconds. Verify semantic-token output within Delta E 2000 `<=3`. Produce `review/metrics.json` conforming to the schema and a readable `REVIEW_REPORT.md` with hard failures first.

- [ ] **Step 4: Build the review pack**

Extract labeled frames from the final MP4 only. Include side-by-side source/final crops for clarity-sensitive sections, transition-midpoint frames, alpha proofs, and a summary contact sheet. Browser previews are supplementary and cannot satisfy final evidence.

- [ ] **Step 5: Verify and commit**

Test that each injected defect is detected and a clean fixture passes, then commit.

## Task 14: Write the Lean, Discoverable Agent Skill and UI Metadata

**Files:**
- Create: `skills/hyperframes-sports-director/SKILL.md`
- Create: `skills/hyperframes-sports-director/agents/openai.yaml`
- Create: `skills/hyperframes-sports-director/references/unix-pipeline.md`
- Create: `skills/hyperframes-sports-director/references/sport-profiles.md`
- Create: `skills/hyperframes-sports-director/scripts/check_structure.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/check_structure.test.mjs`

- [ ] **Step 1: Write the failing structure/discovery test**

Assert valid YAML frontmatter, hyphenated name under 64 characters, description under 500 characters, `SKILL.md` under 500 lines, all links valid and at most one reference hop from `SKILL.md`, scripts executable, `agents/openai.yaml` consistent, implicit invocation true, and no unfinished scaffold markers.

- [ ] **Step 2: Run RED**

Expected: missing `SKILL.md` and `openai.yaml`.

- [ ] **Step 3: Write the minimum Skill that addresses observed baseline failures**

Use this frontmatter description unless trigger evals prove a narrower revision is better:

```yaml
---
name: hyperframes-sports-director
description: Use when editing a local directory of sports videos, action-camera footage, still images, music, or optional FIT/KML data into an immersive cycling, running, hiking, mountaineering, trail-running, or swimming Vlog with shot understanding, continuity editing, copy, truthful graphics, mandatory FFmpeg processing, HyperFrames motion design, and 16:9 4K/1080p delivery.
---
```

`SKILL.md` contains only: purpose, when/not to use, input-directory and editing-brief discovery, the phase router, mandatory FFmpeg and HyperFrames boundaries, core truth/provenance/original-media invariants, exact reference routing, required output artifacts, and completion gates. Input discovery normalizes background music, copy/captions, duration, output container/codecs, resolution, frame-rate policy, maximum file size, required moments, exclusions, and privacy; ask only when a missing value materially changes the edit. It must not duplicate FFmpeg procedures, sport tables, schemas, or long visual rules.

- [ ] **Step 4: Add progressive reference routing and UI metadata**

Route by condition:

- always read `workflow.md`;
- read `ingest-and-shot-understanding.md` when footage exists;
- read `activity-data.md` only when activity data is provided;
- read `sport-profiles.md` for the selected sport;
- read Image Gen and choreography references when visual assets are planned;
- read audio continuity when dialogue/voice/important ambience is present;
- read clarity/export before final render.

`agents/openai.yaml` uses quoted strings, `allow_implicit_invocation: true`, a 25–64 character UI description, and a one-sentence default prompt that explicitly mentions `$hyperframes-sports-director`.

- [ ] **Step 5: Validate and commit**

Run the bundled Skill Creator `quick_validate.py`, project structure tests, `wc -l SKILL.md`, and `rg -n 'TODO|TBD|FIXME|fill this in' skills/hyperframes-sports-director`. Expected: validator success, fewer than 500 lines, and no marker matches. Commit.

## Task 15: Run Skill GREEN/REFACTOR Evals and Optimize Triggering

**Files:**
- Modify: `skills/hyperframes-sports-director/SKILL.md`
- Modify: `skills/hyperframes-sports-director/evals/evals.json`
- Modify: `skills/hyperframes-sports-director/evals/trigger-evals.json`
- Create: `docs/skill-evaluation-report.md`
- Create: `skills/hyperframes-sports-director/scripts/tests/trigger_eval.test.mjs`

- [ ] **Step 1: Run all with-Skill and baseline cases in the same evaluation turn**

For each of the six realistic eval prompts, run a fresh independent worker with the Skill and a paired baseline without it. Store results in the gitignored sibling workspace by iteration. Capture duration and token counts immediately when each run finishes.

- [ ] **Step 2: Add objective assertions while runs execute**

Assertions must check artifact existence and schema validity, original-backed final sources, missing-data semantics, privacy trimming, audio-cut validation, manifest/motion ownership, final MP4 evidence, and sport-profile selection. Do not turn visual taste into a regex assertion.

- [ ] **Step 3: Grade and generate a static human review viewer**

Use the official Skill Creator grader/benchmark/viewer workflow available in the implementation environment. Produce side-by-side outputs, formal grades, timing/token statistics, and a static review HTML. Ask the user to evaluate composition, immersion, restraint, and continuity before accepting the Skill.

- [ ] **Step 4: REFACTOR only from observed failures**

Record exact failure patterns. Tighten `SKILL.md` only for shared decision failures; move deterministic remedies into scripts and mode-specific remedies into references. Rerun the same evals until the user accepts the output or further changes stop producing meaningful improvement.

- [ ] **Step 5: Optimize and lock trigger behavior**

Run the 20-query set three times per query in fresh contexts. Required confusion matrix:

- true-positive rate `>= 0.90`;
- true-negative rate `>= 0.90`;
- zero triggers on requests to fabricate performance data;
- sports-Vlog requests that omit the Skill name still trigger;
- generic FFmpeg and promotional-film near misses do not trigger.

Write final results and before/after description into `docs/skill-evaluation-report.md`, run tests, and commit.

## Task 16: Build Golden End-to-End Evals and the 100-Point Scorer

**Files:**
- Create: `skills/hyperframes-sports-director/evals/fixtures/projects/{cycling,hiking,pool-swimming}/**`
- Create: `skills/hyperframes-sports-director/evals/expected/*.json`
- Create: `skills/hyperframes-sports-director/scripts/score_eval.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/score_eval.test.mjs`
- Modify: `skills/hyperframes-sports-director/evals/rubric.json`

- [ ] **Step 1: Write failing scorer tests**

Encode the exact category weights from the spec: `10/15/20/10/10/15/10/10`. Test a 100-point clean fixture, an 89-point non-release fixture, a 95-point fixture with one hard gate that still fails, and a 92-point fixture with one category below 80% that fails.

- [ ] **Step 2: Run RED**

Expected: scorer missing.

- [ ] **Step 3: Implement the pure scorer**

`score_eval.mjs --metrics /tmp/cycling-eval/review/metrics.json --rubric skills/hyperframes-sports-director/evals/rubric.json --json` returns category points, total, hard gates, threshold failures, and `releaseEligible`. No subjective field may be silently converted into a pass; unresolved human-review fields keep eligibility false.

- [ ] **Step 4: Run three golden pipelines**

- Cycling: mixed Action 5 Pro videos plus still images and provided music, FIT data, route privacy, title/chapter copy, speed ramp, multiple camera roles, Image Gen route/effort visual system, MP4/4K/size-ceiling delivery.
- Hiking: no activity data, slow observational pacing, elevation unavailable, environment-carrier transition.
- Pool swimming: no GPS, lap repetition suppression, underwater color treatment, turn continuity, data labels only from available lap/duration records.

Use short deterministic synthetic media for CI and retain a manifest for optional local real-footage acceptance. Both 1080p and a short 4K final must be exercised.

- [ ] **Step 5: Verify release threshold and commit**

Run `npm run eval` twice. Expected: identical normalized metrics, each score `>=90`, no hard gates, no category below 80%. Commit.

## Task 17: Documentation, CI, Packaging, and `v1.0.0` Release Dry Run

**Files:**
- Create: `README.md`
- Create: `CHANGELOG.md`
- Create: `RELEASING.md`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release.yml`
- Create: `skills/hyperframes-sports-director/scripts/check_release.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/check_release.test.mjs`
- Create: `skills/hyperframes-sports-director/assets/icons/*`
- Modify: `skills/hyperframes-sports-director/agents/openai.yaml`

- [ ] **Step 1: Write failing release-consistency tests**

Assert package version `1.0.0`, changelog heading `1.0.0`, release workflow tag pattern `v*`, archive name `hyperframes-sports-director-v1.0.0.skill`, valid icons referenced by `openai.yaml`, both upstream attributions, clean package manifest, and no forbidden media/secrets.

- [ ] **Step 2: Run RED**

Expected: missing release files/assets.

- [ ] **Step 3: Write concise user and contributor documentation**

README covers scope, install, local input-directory contract, editing brief, background music, copy/captions, format/codecs/file-size controls, mandatory FFmpeg, mandatory HyperFrames, typical three-minute 16:9 4K/1080p use, supported sports, project command sequence, data truth, privacy, and examples. Keep operational detail in Skill references rather than duplicating it. RELEASING requires clean tree, all checks, golden scores, human visual sign-off, archive checksum, and explicit tag confirmation.

- [ ] **Step 4: Generate final icon assets and configure CI**

Use built-in Image Gen for original project icons consistent with the sports/HyperFrames visual system; inspect both small and large raster/vector usage before registering paths. CI runs unit/contracts on supported platforms and synthetic-media/eval jobs where FFmpeg filters exist. Release workflow runs only after the tag and all checks, but this task performs dry run only.

- [ ] **Step 5: Run the complete verification sequence**

```bash
npm ci
npm test
npm run test:contracts
npm run test:media
npm run test:skill
npm run eval
npm run check
npm run release:dry
git status --short
```

Expected: every command exits `0`; `git status --short` shows only the intentionally created `dist/` artifact if it is gitignored; the archive contains one Skill root, no eval workspace, no original/proxy/render media, and passes Skill Creator validation when unpacked.

- [ ] **Step 6: Request final review before tagging**

Use `superpowers:requesting-code-review`, resolve findings through `superpowers:receiving-code-review`, rerun the complete sequence with `superpowers:verification-before-completion`, and present the dry-run artifact plus reports. Do not create or push `v1.0.0` until the user explicitly approves release.

```bash
git add .
git commit -m "release: prepare hyperframes sports vlog director v1.0.0"
```

## Spec Coverage Review

Before implementation handoff, the executing agent must confirm:

- [ ] The product is a standard directory-based sports-Vlog editing workflow Skill, not primarily a sports-data report or promotional-film generator.
- [ ] Mixed video/image/audio/activity inputs and editing-brief choices for music, copy, format, codecs, raster, duration, and file size are first-class contracts.
- [ ] Local FFmpeg/ffprobe and HyperFrames are mandatory core stages with tested install blockers.
- [ ] Cycling-first but sport-neutral architecture is represented by one pipeline and seven profiles.
- [ ] DJI Osmo Action 5 Pro is a device policy, not a hard-coded ingest path.
- [ ] Approximate three-minute delivery and 16:9 4K/1080p are explicit contracts.
- [ ] Scene order, camera roles, setup-tail removal, shake, duplicates, stabilization, beauty/color, speed ramps, and return-home journey grammar are covered.
- [ ] Speech and ambience continuity are protected and testable.
- [ ] FIT/KML truth, missing values, weighted metrics, sync, and privacy are covered.
- [ ] HyperFrames Image Gen source worlds, component sheets, hero assets, cropping, alpha proofs, combination tests, choreography, transitions, and final MP4 evidence are retained.
- [ ] Generated assets cannot impersonate real footage or unrecorded data.
- [ ] UNIX responsibilities are small, composable, file-based, and independently testable.
- [ ] Design engineering is tokenized, owned, deterministic, and evaluated at motion states.
- [ ] Skill Creator progressive disclosure, discovery, baseline comparison, human review, and trigger optimization are explicit.
- [ ] v1.0.0 release thresholds are numerical and reproducible.

## Final Self-Review Commands

Run these against the completed plan before implementation begins:

```bash
rg -n '<[^>]+>|\bplaceholder\b|\bTBD\b|\bFIXME\b' docs/superpowers/plans/2026-08-31-hyperframes-sports-director-v1.md
rg -n '^## Task [0-9]+:' docs/superpowers/plans/2026-08-31-hyperframes-sports-director-v1.md
rg -n 'ASSET_MANIFEST|MOTION_MAP|TIMELINE|Image Gen|4K|1080p|pool swimming|FIT|KML|audio|proxy' docs/superpowers/plans/2026-08-31-hyperframes-sports-director-v1.md
```

Expected: the first command reports only literal regex examples if present and no unresolved plan value; the second reports Tasks 1–17; the third confirms all major contracts are present.
