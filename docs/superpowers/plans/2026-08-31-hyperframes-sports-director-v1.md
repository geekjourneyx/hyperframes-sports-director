# HyperFrames Sports Director v1.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Use superpowers:test-driven-development for every code change and superpowers:writing-skills for the Skill RED-GREEN-REFACTOR cycle.

**Goal:** Ship `hyperframes-sports-director` v1.0.0 as a new, installable standard sports-Vlog editing workflow Skill that accepts a local mixed-media directory plus an editing brief and produces an immersive, truthful, approximately three-minute sports Vlog in 16:9 4K or 1080p, with optional music, copy, and activity-data enhancement.

**Architecture:** A thin Agent orchestrates small Node.js/FFmpeg commands through versioned file contracts. Originals are immutable; proxies exist only for analysis and rough review. A project-local HyperFrames director workbench presents source evidence, proxy rough cut, whole-direction proposals, asset/music plans, and one hash-bound approval. A deterministic lock command then freezes the selected design and Look before Anchor-first asset production and unattended final delivery. `ASSET_MANIFEST.json`, `MOTION_MAP.json`, and `TIMELINE.json` remain separate sources of truth.

**Tech Stack:** Node.js 22.12+ ESM, npm lockfile, built-in `node:test`, JSON Schema with Ajv, Sharp for component extraction/proofs, local FFmpeg/ffprobe, HTML/CSS/SVG/GSAP/Lottie/Three.js where a motion role requires them, HyperFrames project scaffolding, Markdown Agent Skill instructions, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-31-hyperframes-sports-director-v1-design.md`

**Plan boundary:** Media analysis, the director workbench, visual production, rendering, and release are separate implementation units, but they share one versioned state machine and remote resume table. They remain in this master plan so an executor cannot accept incompatible contract revisions across separate handoffs; Tasks 3–15 are independently reviewable checkpoints rather than one implementation batch.

## Execution Status and Remote Resume Point

This table is authoritative for handoff. Do not repeat an accepted task merely because its historical task steps remain visible.

| Task | Remote status | Accepted commit | Handoff rule |
|---|---|---|---|
| 1 — lineage and scaffold | Complete | `e9a88afc33d074179b569e6d84802d127ed555ed` | Inspect only; do not recreate. |
| 2 — no-Skill baselines and executable rubric | Complete | `2e7101fcd52d14ccf5d4eb98d886e930560932b3` | Baseline outputs are immutable test evidence. |
| 3 — versioned contracts and lifecycle | Next | — | Start from current remote `main`; no Task 3 implementation has been accepted remotely. |
| 4–19 | Pending | — | Execute in order after each preceding task passes RED, GREEN, full-suite, independent review, and remote checkpoint. |

A prior workspace may contain abandoned, uncommitted Task 3 files. They are not accepted work and must not be treated as authoritative. The remote branch, this design specification, the execution-status table, and accepted commits are the recovery source of truth.

This plan was recalibrated after the 2026-09-01 director-workbench design review. The recalibration narrows release-grade sport support to cycling, hiking/non-technical mountain journey, and pool swimming; adds a single `DIRECTOR_LOCK` approval; and makes Tasks 10–11 the workbench/lock proof before production visual assets. It does not change the accepted status of Tasks 1–2.

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
- [ ] Keep the three truth chains independent: recorded media (`PROBE → SEGMENTS → SHOTS → TIMELINE`), activity data (`ACTIVITY → SYNC_MAP → DATA_OVERLAYS`), and design (`DESIGN_SYSTEM + LOOK_PROFILE → ASSET_MANIFEST → MOTION_MAP`). Agent interpretation may reference but never overwrite deterministic facts.
- [ ] Track auditable project transitions in `PROJECT_STATE.json`: `INTAKE → CAPABILITY_CHECK → SCAN → ANALYZE → ROUGH_CUT → DIRECTOR_REVIEW_READY → DIRECTOR_LOCK → STYLE_ANCHOR → ASSET_PRODUCTION → MOTION_COMPOSITION → FINAL_RENDER → FINAL_QA → DELIVERED`, with optional non-blocking `USER_ACCEPTED` and terminal side states `BLOCKED`/`CANCELLED`.
- [ ] Missing activity values are `null` or `status: "unavailable"`, never numeric zero.
- [ ] Activity data is optional. With no FIT/KML/normalized activity JSON, the full media-editing pipeline still completes and emits `ACTIVITY.json` with `status: "unavailable"` without empty data graphics.
- [ ] Templates create `draft`, never pre-frozen, design and Look contracts. After one hash-bound `DIRECTOR_APPROVAL.json`, atomically freeze exactly one project-level `DESIGN_SYSTEM.json` and one independent `LOOK_PROFILE.json` before production visual generation. Scenes may reference semantic tokens but may not introduce arbitrary colors.
- [ ] The local director workbench is an evidence/decision view, not an editor or render controller. It uses stable HyperFrames near-black/white-gray/warm-gold chrome, isolates candidates in equal preview canvases, references only project-relative review derivatives, and updates atomically at required artifact/state revisions.
- [ ] Pre-approval direction previews use representative real footage plus CSS/SVG/code-rendered typography, data, layout, and motion storyboards. Production Image Gen assets are forbidden before `DIRECTOR_LOCK`.
- [ ] After lock, pass one full-resolution Style Anchor and one representative component/real-footage combination proof before batch asset generation. Require at least two semantically different combination proofs before final choreography.
- [ ] Machine facts hard-fail; Agent taste judgments use decoded final-MP4 evidence. Automatic repair is limited to three attempts per gate and may not change the approved story, key shots, direction, semantic tokens, Look, music direction, privacy policy, or delivery contract.
- [ ] Default v1 delivery color is SDR Rec.709. Enforce rendered local contrast (`7:1` target/`4.5:1` floor for critical text, `4.5:1` ordinary text, `3:1` large text/meaningful graphics), motion-interval sampling, and final token color Delta E 2000 `<=3`.
- [ ] Do not commit real user footage, GPS, biometrics, secrets, large generated media, or eval workspaces.
- [ ] Never modify the user-provided input directory. Register supported video, image, audio, activity-data, and sidecar files by hash and provenance; report unsupported files.
- [ ] Production defaults are 16:9 `3840x2160` or `1920x1080`; normal target duration is `180s` with accepted range `150–210s` unless the user overrides it.
- [ ] A final render must resolve original media and use one final lossy encode. Proxy-backed finals are a release blocker.
- [ ] Release-grade v1 support is cycling, hiking/non-technical mountain journey, and pool swimming. Running, technical-mountaineering, trail-running, and open-water-swimming profiles are experimental contract fixtures only.
- [ ] v1 music is `none`, user-provided, or explicitly selected local media. Suno/browser automation, remote music search/download, cloud review, portable HTML review packs, and a general editing GUI are non-goals.
- [ ] `DELIVERED` requires machine hard gates plus Agent inspection of the encoded final MP4; optional `USER_ACCEPTED` is not inferred and does not block delivery.
- [ ] Release requires all hard gates, at least `90/100` on cycling, hiking/non-technical-mountain, and pool-swimming golden evals, and no category below 80% of its available points.

## Per-Task Closure Gate

Every pending task uses the same non-negotiable closure sequence. The executing agent records the actual focused command and expected RED failure in the task log, then:

1. run one new focused test with all proxy variables unset and observe the intended failure;
2. implement the smallest production change;
3. rerun the focused test and observe GREEN with no warning/diagnostic noise;
4. run `env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY -u http_proxy -u https_proxy -u all_proxy -u no_proxy npm test`;
5. request independent review of the task diff and resolve every blocking finding;
6. rerun focused and full tests after review fixes;
7. commit only the task files, push the commit to remote `main`, update the execution-status table with the accepted 40-character SHA, and verify local `HEAD == origin/main` before starting the next task.

An uncommitted file, local-only commit, proxy-backed artifact, passing exit code without expected assertions, or review without post-fix tests is not a checkpoint.

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
    ├── assets/director-workbench/             # stable HyperFrames review chrome/template
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
    │   ├── director-workbench.md
    │   ├── hyperframes-composition.md
    │   ├── imagegen-asset-pipeline.md
    │   ├── ingest-and-shot-understanding.md
    │   ├── sport-profiles.md
    │   ├── unix-pipeline.md
    │   ├── visual-standard.md
    │   └── workflow.md
    ├── schemas/
    │   ├── activity.schema.json
    │   ├── data-overlays.schema.json
    │   ├── asset-manifest.schema.json
    │   ├── beat-map.schema.json
    │   ├── edit-brief.schema.json
    │   ├── design-system.schema.json
    │   ├── direction-proposals.schema.json
    │   ├── director-approval.schema.json
    │   ├── look-profile.schema.json
    │   ├── media-index.schema.json
    │   ├── motion-map.schema.json
    │   ├── project.schema.json
    │   ├── project-state.schema.json
    │   ├── review-metrics.schema.json
    │   ├── scene-schema.schema.json
    │   ├── shot.schema.json
    │   ├── sync-map.schema.json
    │   ├── timeline.schema.json
    │   └── transcript.schema.json
    ├── templates/
    │   ├── ACTIVITY.template.json
    │   ├── DATA_OVERLAYS.template.json
    │   ├── ASSET_MANIFEST.template.json
    │   ├── BEAT_MAP.template.json
    │   ├── BRIEF_DESIGN_PROPOSAL.template.md
    │   ├── EDIT_BRIEF.template.json
    │   ├── DESIGN_SYSTEM.template.json
    │   ├── DIRECTION_PROPOSALS.template.json
    │   ├── DIRECTOR_APPROVAL.template.json
    │   ├── LOOK_PROFILE.template.json
    │   ├── MEDIA_INDEX.template.json
    │   ├── MOTION_MAP.template.json
    │   ├── PROJECT.template.json
    │   ├── PROJECT_STATE.template.json
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
    │   ├── build_director_workbench.mjs
    │   ├── build_proxies.mjs
    │   ├── check_install.mjs
    │   ├── check_release.mjs
    │   ├── check_structure.mjs
    │   ├── create_project.mjs
    │   ├── crop_component_sheet.mjs
    │   ├── inspect_output.mjs
    │   ├── ingest_media.mjs
    │   ├── probe_media.mjs
    │   ├── record_director_approval.mjs
    │   ├── render_final.mjs
    │   ├── render_rough_cut.mjs
    │   ├── score_eval.mjs
    │   ├── segment_media.mjs
    │   ├── serve_director_workbench.mjs
    │   ├── lock_direction.mjs
    │   ├── validate_artifacts.mjs
    │   ├── validate_color_pipeline.mjs
    │   ├── validate_contrast.mjs
    │   ├── validate_design_system.mjs
    │   ├── validate_design_consistency.mjs
    │   ├── validate_image_assets.mjs
    │   ├── validate_shots.mjs
    │   ├── validate_timeline.mjs
    │   ├── lib/{activity,approval,audio,cli,contracts,director-workbench,ffmpeg,files,image-assets,invalidation,layout,media,motion,profiles,project-state,render,render-plan,time,timeline,visual-qc}.mjs
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

**Remote status:** Complete and accepted. Do not re-execute this task.

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

- [x] **Step 1: Initialize the new repository and resolve immutable upstream SHAs**

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

- [x] **Step 2: Write the failing lineage test**

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

- [x] **Step 3: Run RED, then add minimal repository metadata**

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

- [x] **Step 4: Add the derivation matrix**

`docs/upstream-derivation.md` must map each retained HyperFrames contract to its sports adaptation and record Guizang's activity normalization/privacy lineage. At minimum map:

| Upstream responsibility | v1 destination | Decision |
|---|---|---|
| `SKILL.md` phase gates | `SKILL.md`, `references/workflow.md` | Adapt terminology; retain gates |
| Image Gen pipeline | `references/imagegen-asset-pipeline.md` and image scripts | Retain and extend sports roles |
| Asset choreography/render QA | matching reference and validators | Retain invariants |
| Motion primitives/schema/beat map | schemas and templates | Retain as separate contracts |
| Guizang report contract | activity schema/analyzer | Adapt null/privacy/weighted metrics |

- [x] **Step 5: Verify GREEN and commit**

Run the focused test, then `npm test`. Expected: both exit `0`.

```bash
git add .
git commit -m "chore: scaffold sports vlog director v1"
```

## Task 2: Establish Skill RED Baselines Before Writing `SKILL.md`

**Remote status:** Complete and accepted. Do not re-execute this task.

**Files:**
- Create: `skills/hyperframes-sports-director/evals/evals.json`
- Create: `skills/hyperframes-sports-director/evals/rubric.json`
- Create: `skills/hyperframes-sports-director/evals/trigger-evals.json`
- Create: `skills/hyperframes-sports-director/scripts/tests/eval_contract.test.mjs`
- Create: `docs/skill-baseline-report.md`
- Modify: `.gitignore`

- [x] **Step 1: Write a failing eval-shape test**

Assert that `evals.json` has at least six realistic prompts, including a mixed video/image directory, cycling with FIT data, hiking without data, pool swimming, noisy speech with background music, 4K delivery with a file-size limit, copy requirements, and visual-component generation. Assert `trigger-evals.json` contains exactly 20 items, 10 `should_trigger: true` and 10 hard near-miss negatives.

- [x] **Step 2: Run RED**

Run:

```bash
node --test skills/hyperframes-sports-director/scripts/tests/eval_contract.test.mjs
```

Expected RED: missing eval files.

- [x] **Step 3: Add realistic eval prompts and objective expectations**

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

- [x] **Step 4: Run independent no-Skill baselines**

Before creating `SKILL.md`, run all six prompts in fresh contexts with no access to the Skill. Store raw outputs in the gitignored sibling directory `hyperframes-sports-director-workspace/iteration-0/without_skill/`. Record observed failures verbatim in `docs/skill-baseline-report.md` under these categories:

- proxies accidentally treated as final sources;
- promotional rather than experiential pacing;
- missing shot/audio continuity contracts;
- invented or zero-filled activity data;
- Image Gen assets pasted on without provenance/crop/motion ownership;
- overfitting to cycling;
- weak final MP4 inspection.

Do not invent baseline failures that did not occur.

- [x] **Step 5: Verify GREEN and commit**

Run the eval-shape test. Expected: pass.

```bash
git add skills/hyperframes-sports-director/evals docs/skill-baseline-report.md .gitignore
git commit -m "test: capture sports vlog skill baselines"
```

## Task 3: Define Versioned Contracts, Lifecycle, and Integrity Primitives

**Files:**
- Create: `skills/hyperframes-sports-director/schemas/{activity,asset-manifest,beat-map,data-overlays,design-system,direction-proposals,director-approval,edit-brief,look-profile,media-index,motion-map,probe,project,project-state,review-metrics,scene-schema,segments,shot,sync-map,timeline,transcript}.schema.json`
- Create: `skills/hyperframes-sports-director/templates/{ACTIVITY,ASSET_MANIFEST,BEAT_MAP,DATA_OVERLAYS,DESIGN_SYSTEM,DIRECTION_PROPOSALS,DIRECTOR_APPROVAL,EDIT_BRIEF,LOOK_PROFILE,MEDIA_INDEX,MOTION_MAP,PROBE,PROJECT,PROJECT_STATE,SCENE_SCHEMA,SEGMENTS,SHOT,SYNC_MAP,TIMELINE,TRANSCRIPT}.template.json`
- Create: `skills/hyperframes-sports-director/templates/{BRIEF_DESIGN_PROPOSAL,REVIEW_REPORT}.template.md`
- Create: `skills/hyperframes-sports-director/scripts/lib/contracts.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/time.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_artifacts.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/contracts.test.mjs`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Produces: `loadSchema(name)`, `validateDocument(schema, value)`, `validateArtifact(path, schemaName)`, `canonicalizeArtifact(value)`, `computeArtifactDigest(value)`, `verifyArtifactIntegrity(value)`, `secondsToFrames(seconds, fps)`, and `framesToSeconds(frames, fps)`.
- Integrity rule: `integrity.digest` is SHA-256 over canonical JSON with the `integrity.digest` field omitted; `integrity.upstream` maps artifact role to the exact upstream digest.
- Consumed by: every later project command, workbench approval binding, invalidation, rendering, and review task.

- [ ] **Step 1: Write failing tests for contract identity and invariants**

Tests must prove:

```js
assert.equal(project.schemaVersion, '1.0.0');
assert.equal(projectState.state, 'INTAKE');
assert.equal(editBrief.delivery.aspectRatio, '16:9');
assert.equal(editBrief.music.mode, 'provided');
assert.equal(mediaIndex.entries[0].sourceRootReadOnly, true);
assert.notEqual(probe.$id, segments.$id);
assert.equal(activity.metrics.averageHeartRate, null);
assert.equal(activity.availability.heartRate, 'unavailable');
assert.notEqual(assetManifest.$id, motionMap.$id);
assert.notEqual(motionMap.$id, timeline.$id);
assert.notEqual(dataOverlays.$id, activity.$id);
assert.equal(activity.status, 'unavailable');
assert.equal(designSystem.status, 'draft');
assert.equal(lookProfile.status, 'draft');
assert.equal(directionProposals.status, 'unavailable');
assert.equal(directorApproval.status, 'unavailable');
assert.equal(lookProfile.output.colorSpace, 'rec709-sdr');
```

Also test unique media/shot IDs, optional-activity status, separate metric/availability/coverage/reason/source maps, mixed-media classification, copy/music modes, maximum-file-size semantics, independent design/Look revisions, semantic-token references, and recorded-media truth-chain integrity: `PROBE` owns normalized media probe facts, `SEGMENTS` references exact probed media IDs and upstream probe digests, and neither portable artifact may expose an absolute input path or private filename. Test `DIRECTION_PROPOSALS.status: "unavailable"` only with an empty candidate list and `status: "proposed"` only with exactly two or three whole candidates. Also test `DIRECTOR_APPROVAL` binding one candidate plus displayed artifact digests, `DATA_OVERLAYS` references, monotonic destination times, source bounds, ISO-8601 timestamps, portable project-relative paths, canonical digest stability, digest mismatch rejection, and rejection of unknown schema versions.

The lifecycle tests must accept only `draft → proposed → approved → frozen → superseded`, reject `draft → frozen` without a valid approval, and enumerate `INTAKE`, `CAPABILITY_CHECK`, `SCAN`, `ANALYZE`, `ROUGH_CUT`, `DIRECTOR_REVIEW_READY`, `DIRECTOR_LOCK`, `STYLE_ANCHOR`, `ASSET_PRODUCTION`, `MOTION_COMPOSITION`, `FINAL_RENDER`, `FINAL_QA`, `DELIVERED`, optional `USER_ACCEPTED`, and side states `BLOCKED`/`CANCELLED`.

- [ ] **Step 2: Run RED**

Run `node --test skills/hyperframes-sports-director/scripts/tests/contracts.test.mjs`. Expected RED: imports or schema files are missing.

- [ ] **Step 3: Implement minimal schemas and validator API**

Expose:

```js
export async function loadSchema(name) {}
export function validateDocument(schema, value) {}
export async function validateArtifact(path, schemaName) {}
export function canonicalizeArtifact(value) {}
export function computeArtifactDigest(value) {}
export function verifyArtifactIntegrity(value) {}
export function secondsToFrames(seconds, fps) {}
export function framesToSeconds(frames, fps) {}
```

Use Ajv strict mode with `allErrors: true`. Errors printed by `validate_artifacts.mjs` must be JSON with `code`, `path`, `message`, and `schema`.

- [ ] **Step 4: Add complete templates with no placeholders**

Templates must be immediately valid documents using empty collections, `null`, `draft`, or `status: "unavailable"`; they must not use instructional strings such as “fill this in.” `DESIGN_SYSTEM` and `LOOK_PROFILE` start as `draft`, never `frozen`; the latter still declares SDR Rec.709 as the output default. `DIRECTION_PROPOSALS` begins `unavailable` with an empty `candidates` array, while `DIRECTOR_APPROVAL` begins `unavailable`. `PROBE` and `SEGMENTS` are separate versioned recorded-media contracts: they preserve stable media IDs, project-relative review-safe paths or basenames, probe/source bounds, segment source/time ranges, and exact integrity/upstream links without absolute input paths or private filenames. `PROJECT_STATE` uses the recalibrated state list. `DATA_OVERLAYS` references normalized metric IDs and may not contain independently calculated values. `EDIT_BRIEF` covers sport, story, local music, copy, duration, format, codecs, raster, frame-rate policy, maximum size, inclusions, exclusions, privacy, and whether remote capabilities are forbidden. Keep `ASSET_MANIFEST`, `MOTION_MAP`, and `TIMELINE` separate.

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

**Interfaces:**
- Consumes: strict artifact validation and digest helpers from Task 3.
- Produces: `loadProfile(kind, name)` and `resolvePolicies({ sport, device, delivery })`, including `maturity: "release-grade" | "experimental"`.

- [ ] **Step 1: Write failing cross-sport tests**

Assert all seven sport profiles implement the same keys: `journeyGrammar`, `cameraRoleWeights`, `speedPolicy`, `stabilizationPolicy`, `duplicatePolicy`, `audioPolicy`, `dataPolicy`, and `visualPolicy`. Add behavioral tests:

- cycling, hiking/mountain-journey, and pool swimming are exactly the release-grade set;
- running, mountaineering-specific, trail running, and open-water swimming are experimental and cannot satisfy a release-grade eval request;
- cycling permits a higher maximum montage rate than hiking;
- mountaineering rejects speed treatment marked `risk_obscuring`;
- pool swimming does not require GPS and includes lap-turn continuity;
- open-water swimming permits GPS but marks it optional;
- 4K and 1080p profiles are exactly `3840×2160` and `1920×1080`.

- [ ] **Step 2: Run RED**

Expected: missing profile loader.

- [ ] **Step 3: Implement profile composition**

Expose `loadProfile(kind, name)` and `resolvePolicies({ sport, device, delivery })`. Merge only documented namespaces; reject unknown keys and conflicting raster/aspect-ratio values. A caller that requests `requiredMaturity: "release-grade"` must receive a structured error for an experimental profile rather than silently treating contract coverage as production support.

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

## Task 5: Create Projects, Enforce State Transitions, and Verify Local Capabilities

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/create_project.mjs`
- Create: `skills/hyperframes-sports-director/scripts/check_install.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/cli.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/invalidation.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/project-state.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/create_project.test.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/check_install.test.mjs`
- Create: `docs/architecture.md`

**Interfaces:**
- Consumes: Task 3 artifact integrity/lifecycle primitives and Task 4 profile resolution.
- Produces: `validateTransition(current, next, evidence)`, `computeInvalidationClosure(changedRoles, dependencyGraph)`, `rollbackStateForInvalidation(projectState, invalidatedRoles)`, `createProject(options)`, and machine-readable capability results.

- [ ] **Step 1: Write failing CLI tests using a temporary directory**

The create test must assert the exact artifact tree from the design spec, copied valid draft templates, selected profile maturity in `PROJECT.json`, normalized choices in `EDIT_BRIEF.json`, an empty local review workspace, and no copied media when reference mode is used. The install test must dependency-inject command results so missing `ffmpeg`, `ffprobe`, required filters, Node version, Sharp, and HyperFrames/director-workbench scaffolds are independently testable.

Assert every allowed and forbidden `PROJECT_STATE` transition. In particular: proxy rough-cut work is allowed before approval; production Image Gen and final rendering are forbidden before `DIRECTOR_LOCK`; `STYLE_ANCHOR` requires frozen design/Look digests; `ASSET_PRODUCTION` requires anchor and representative-combination evidence; `DELIVERED` requires closed-file probe, hard gates, Agent visual inspection, and encoded-MP4 evidence; `USER_ACCEPTED` is optional; `BLOCKED` and `CANCELLED` never masquerade as delivery.

Build a dependency fixture in which changing `TIMELINE` invalidates motion/render/review but not media/activity facts, while changing a frozen design digest invalidates asset/motion/render/review and rolls back past `DIRECTOR_LOCK`. Assert bounded downstream corrections do not mutate frozen design/Look digests.

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

Refuse a non-empty destination unless `--resume` finds compatible `PROJECT.json` and `PROJECT_STATE.json` documents whose integrity checks pass. Never overwrite originals. Expose pure state-transition and invalidation functions; invalid transitions and stale evidence fail before filesystem or FFmpeg mutation. State gate evidence stores artifact role, revision, digest, timestamp, and producer command.

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

**Interfaces:**
- Consumes: project root, immutable input root, Task 3 schemas, and Task 5 capability result.
- Produces: integrity-stamped `MEDIA_INDEX.json`, normalized `PROBE.json`, raw probe evidence, proxy records, `assertFinalSource(path)`, and proxy/original time mappings.

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

**Interfaces:**
- Consumes: Task 6 media/probe/proxy artifacts.
- Produces: `SEGMENTS.json`, provenance-safe evidence frames/contact sheets, and validated Agent-authored `SHOTS.jsonl` with integrity/upstream digests.

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

**Interfaces:**
- Consumes: optional classified activity inputs, media capture timing, selected sport profile, and privacy preferences.
- Produces: `normalizeActivity`, `weightedAverage`, `distanceWeightedDistribution`, `deduplicateActivities`, `trimPrivateEndpoints`, `buildSyncMap`, `buildDataOverlayAllowList`, and integrity-stamped `ACTIVITY.json`, `SYNC_MAP.json`, and `DATA_OVERLAYS.json`.

- [ ] **Step 1: Write failing tests derived from Guizang invariants**

Test FIT, KML, and normalized JSON inputs. Assert:

- missing heart rate stays `null` and `unavailable`, while a recorded zero remains zero;
- KML without timestamps leaves duration, speed, pace, pause, and sync overlays unavailable;
- overall speed uses total valid distance divided by total valid moving time;
- heart rate, power, cadence/step rate, and temperature use valid-sample weighting;
- grade distribution uses analyzed-distance weighting and rejects short elevation spikes;
- device-provided calories are summed only with reported coverage;
- duplicate activities are excluded before aggregation;
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

Expose `normalizeActivity`, `weightedAverage`, `distanceWeightedDistribution`, `deduplicateActivities`, `trimPrivateEndpoints`, `buildSyncMap`, and `buildDataOverlayAllowList`. Reuse/adapt Guizang code only with file-level attribution. Keep raw GPS, biometrics, absolute input paths, and private filenames out of logs and portable artifacts. The overlay allow-list references normalized facts and display authority; it never recalculates metrics.

- [ ] **Step 4: Add CLI contract**

```bash
node skills/hyperframes-sports-director/scripts/analyze_activity.mjs \
  --input activity.fit \
  --project /tmp/ride-vlog \
  --trim-start-m 300 \
  --trim-end-m 300
```

Write normalized `ACTIVITY.json`, `SYNC_MAP.json`, and `direction/DATA_OVERLAYS.json`; do not render a report or graphic in this command. Public route output must accept only the validated trimmed-route ID.

- [ ] **Step 5: Verify and commit**

Run focused tests, contract tests, and commit.

## Task 9: Validate the Editorial Timeline and Render the Approval Rough Cut

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/validate_timeline.mjs`
- Create: `skills/hyperframes-sports-director/scripts/render_rough_cut.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/timeline.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/audio.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/render-plan.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/timeline.test.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/audio_continuity.test.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/render_rough_cut.test.mjs`
- Create: `skills/hyperframes-sports-director/references/continuity-editing.md`
- Create: `skills/hyperframes-sports-director/references/audio-continuity.md`

**Interfaces:**
- Consumes: Task 6 probe/proxy mappings, Task 7 shots/transcript evidence, Task 8 optional data authority, and Task 4 policies.
- Produces: `validateTimeline({ phase, project, probe, shots, transcript, assetManifest, motionMap, timeline, profiles })`, continuity/duplicate/audio diagnostics, `compileRoughRenderPlan(...)`, integrity-stamped `TIMELINE.json`, and `renders/rough-cut.mp4` with an analysis-proxy watermark.

- [ ] **Step 1: Write failing editorial-invariant tests**

Cover video/still source bounds, phase-aware rough-proxy versus final-original references, still-image hold and pan/zoom limits, playback-rate curves, duplicate separation, screen/motion direction warnings, setup-tail rejection, severe-shake handling, and transition ownership. Add a protected transcript span from `4.0–5.2s` and prove a cut at `4.7s` fails unless an L-cut/J-cut/ambience bridge is declared. Add a local-music loop seam and prove it fails without a crossfade. Prove remote music URLs and provider automation are rejected in v1.

The rough-render test must assert proxy-only resolution, visible `ANALYSIS PROXY` marking, preserved audio, valid closed-file re-probe, integrity linkage to the timeline/proxy hashes, and refusal to advance to `DIRECTOR_REVIEW_READY` when the rough cut is stale.

- [ ] **Step 2: Run RED**

Expected: missing timeline/audio modules.

- [ ] **Step 3: Implement pure validators**

Expose:

```js
validateTimeline({ phase, project, probe, shots, transcript, assetManifest, motionMap, timeline, profiles })
findProtectedSpeechCuts(timeline, transcript)
findDuplicateViolations(timeline, shots, minSeparationSeconds)
findContinuityWarnings(previousShot, nextShot)
```

Return errors and warnings separately. In `rough` phase, proxy references are required and production asset/motion references are forbidden. In `final` phase, originals and resolved asset/motion ownership are required. Hard errors block render; warnings require an Agent decision recorded in `TIMELINE.json`.

- [ ] **Step 4: Encode policies and compile the low-cost rough render**

Timeline supports stabilization, crop/reframe, still-image hold/pan/zoom, speed ramp, draft color transform, optional face/skin treatment, source-audio gain, denoise, local background-music trim/loop/fade/duck, and continuity bridges. Scripts validate parameters and compile explicit FFmpeg argument arrays; the Agent chooses whether treatment improves the shot. Default face treatment is `off`. `render_rough_cut.mjs` renders the approved review raster from proxies only, fsyncs/closes/re-probes it, and records its digest before `ROUGH_CUT` completes.

- [ ] **Step 5: Verify and commit**

Run focused tests and the full suite, then commit.

## Task 10: Build the Local Director Workbench and Record One Approval

**Files:**
- Create: `skills/hyperframes-sports-director/assets/director-workbench/index.template.html`
- Create: `skills/hyperframes-sports-director/assets/director-workbench/workbench.css`
- Create: `skills/hyperframes-sports-director/assets/director-workbench/workbench.js`
- Create: `skills/hyperframes-sports-director/scripts/build_director_workbench.mjs`
- Create: `skills/hyperframes-sports-director/scripts/compile_direction_proposals.mjs`
- Create: `skills/hyperframes-sports-director/scripts/serve_director_workbench.mjs`
- Create: `skills/hyperframes-sports-director/scripts/record_director_approval.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/direction-proposals.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/director-workbench.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/director_workbench.test.mjs`
- Create: `skills/hyperframes-sports-director/references/director-workbench.md`

**Interfaces:**
- Proposal compilation consumes: current integrity-verified `EDIT_BRIEF`, `MEDIA_INDEX`, `PROBE`, `SEGMENTS`, agent-validated `SHOTS`, rough-cut `TIMELINE` and closed MP4, optional allowed `DATA_OVERLAYS`, a local-music plan, and `PROJECT_STATE`.
- Proposal compilation produces: `compileDirectionProposals(inputs)`, `validateDirectionProposals(value)`, and one atomically written integrity-stamped `direction/DIRECTION_PROPOSALS.json`. It is the only Task 10 writer of that artifact. `status: "unavailable"` permits only `candidates: []`; `status: "proposed"` requires exactly two or three complete whole-direction candidates.
- Workbench consumes: the verified compiler output plus the same current evidence and `PROJECT_STATE`; it does not create, select, or mutate direction candidates.
- Workbench produces: `buildWorkbenchModel(projectRoot)`, `renderWorkbenchHtml(model)`, `startWorkbenchServer(options)`, `recordDirectorApproval(request)`, `review/director-workbench.html`, allowed review derivatives, and one integrity-stamped `direction/DIRECTOR_APPROVAL.json`.
- Security boundary: the server binds only to `127.0.0.1`, serves an allow-list under the project review root, and its only mutation is an atomic approval write.

- [ ] **Step 1: Write failing direction-compilation, workbench, privacy, and approval tests**

Build a fixture from integrity-verified brief, real media/shot evidence, rough-cut timeline and closed proxy MP4, and local-music plan. Assert the proposal compiler atomically writes one integrity-stamped `DIRECTION_PROPOSALS.json`; `status: "unavailable"` has no candidates, while `status: "proposed"` has exactly two or three complete candidates. Assert each candidate uses the same representative frame IDs, copy, viewport, and information-density budget, binds current evidence/rough-cut/music-plan digests, and contains only code-rendered direction prototypes and planned assets—not production Image Gen output. Assert the workbench consumes this file rather than creating or changing candidates, and the generated page contains the brief, stage progress, key frames/shots, rough-cut link, story structure, local-music plan, visual-world plan, component/Hero inventory, layout proofs, motion storyboard, risks, and approval control.

Assert the workbench chrome resolves only `background #050505`, `surface #0D0D0D`, `surfaceRaised #141414`, `textPrimary #F5F2EA`, `textSecondary #A8A29A`, `accent #C9A86A`, `danger #E36B5D`, and `line #2A2A2A`; candidate tokens remain scoped to their preview canvases and cannot style the chrome or final video. Reject original-media paths, raw GPS, absolute paths, private basenames, embedded base64 media, remote scripts/fonts, remote music URLs, and path traversal.

Approval tests must reject a stale workbench digest, stale underlying artifact digest, unknown/cross-proposal selection, missing CSRF/session token, second normal-path approval, non-localhost binding, expired session, and any request outside `DIRECTOR_REVIEW_READY`. Inject a write failure and assert there is no partial approval document and no state transition.

- [ ] **Step 2: Run RED**

Run `node --test skills/hyperframes-sports-director/scripts/tests/director_workbench.test.mjs`. Expected RED: direction-proposal/workbench modules and assets are missing.

- [ ] **Step 3: Implement the single proposal compiler and validator**

`compile_direction_proposals.mjs` must validate every source contract and closed rough-cut evidence, build two or three complete whole-direction candidates from the same representative real-footage review derivatives, and atomically write the integrity-stamped artifact. The compiler, not the workbench, owns candidate creation. It must reject unavailable-with-candidates, proposed-with-fewer-than-two-or-more-than-three candidates, stale evidence/music/rough-cut digests, cross-candidate token mixing, absolute/private/original/remote references, and production Image Gen output. Candidate previews remain code-rendered local direction prototypes with planned visual assets only.

- [ ] **Step 4: Implement the pure view model and deterministic HTML generator**

Sort all evidence and candidates by stable IDs, calculate the displayed digest set, and escape all user/project text. Generate one stable `review/director-workbench.html` through a temporary file plus atomic rename. The page is desktop-first, uses a strong filmstrip/evidence hierarchy rather than generic admin cards, keeps the active preview dominant, and displays status as secondary production context. Rebuilding identical inputs must produce byte-identical HTML.

- [ ] **Step 5: Implement the localhost approval probe**

Create an owner-only `0700` temporary session with a random ID, expiry, CSRF token, exact-session cleanup, and an allow-listed static server. `POST /approval` accepts only the selected candidate ID plus the complete displayed digest set, revalidates source artifacts, writes `DIRECTOR_APPROVAL.json` atomically, and advances only to approval-recorded evidence; it does not freeze contracts or invoke another command. Print the local URL and session expiry as JSON.

- [ ] **Step 6: Verify functional and visual evidence, then commit**

Run `node --test skills/hyperframes-sports-director/scripts/tests/director_workbench.test.mjs`, then `npm test`. Open the generated fixture through the available local browser and inspect at `1440×900` and `3840×2160`: no overflow, no clipped key evidence, equal candidate canvases, readable hierarchy, stable filmstrip, no generic dashboard density, and no candidate-style leakage into the chrome. Save screenshots only in the gitignored eval workspace. If visual inspection is unavailable, record only measurable DOM/layout checks and do not claim design acceptance. Request independent design review, resolve findings, rerun focused/full tests, and complete the remote checkpoint.

## Task 11: Lock the Approved Direction and Enforce Dependency Invalidation

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/lock_direction.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/approval.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/director_lock.test.mjs`
- Modify: `skills/hyperframes-sports-director/scripts/lib/invalidation.mjs`
- Modify: `skills/hyperframes-sports-director/scripts/lib/project-state.mjs`

**Interfaces:**
- Consumes: one current `DIRECTOR_APPROVAL.json`, selected proposal, bound brief/rough-cut/music/asset/evidence digests, and draft design/Look contracts.
- Produces: `validateDirectorApproval(...)`, `compileApprovedDesign(...)`, `compileApprovedLook(...)`, `lockDirection(projectRoot)`, `classifyApprovedRepair(change)`, frozen design/Look digests, `DIRECTOR_LOCK` gate evidence, and deterministic invalidation closure.

- [ ] **Step 1: Write failing approval-lock and crash-recovery tests**

Assert a valid approval selects one whole proposal, binds every displayed digest, produces exactly one frozen design and one frozen Look, records their digests in `PROJECT_STATE`, and advances to `DIRECTOR_LOCK`. Reject stale/missing digests, cross-proposal token mixing, direct `draft → frozen`, already consumed approval, remote-music references, and any output path outside the project.

Inject failures after temporary writes, after the first rename, and before state commit. Consumers must reject any uncommitted pair, recovery must restore the prior valid drafts or complete the matching pair, and the project must never report `DIRECTOR_LOCK` with mismatched design/Look digests.

Create change fixtures for allowed position/scrim/timing/gain corrections and forbidden story/key-shot/token/Look/music/privacy/delivery changes. Assert allowed changes invalidate only their dependency closure; forbidden changes return `approval_boundary_crossed` and move the project to `BLOCKED` without mutation.

- [ ] **Step 2: Run RED**

Run `node --test skills/hyperframes-sports-director/scripts/tests/director_lock.test.mjs`. Expected RED: approval/lock functions are missing.

- [ ] **Step 3: Implement approval validation and transactional lock**

Recompute every bound digest from disk, compile the selected proposal without cross-candidate fields, write design/Look temporary files plus a transaction journal, fsync, rename, verify both frozen documents, then commit matching gate evidence. On startup, recover or roll back an incomplete journal before accepting any project artifact. A frozen contract is immutable. Any requested repair that crosses the approved story, key shots, direction, semantic tokens, Look, music, privacy, or delivery boundary records `BLOCKED` for this run; it never creates a superseding approval or edits the frozen document. A user may initiate a separate project revision and approval flow outside this unattended run.

After the lock commit, rebuild the director workbench from the committed gate evidence. The approval control disappears, the selected direction becomes read-only, and the workbench digest is recorded with the state revision.

- [ ] **Step 4: Implement invalidation and three-attempt repair budgets**

Represent dependencies by artifact role, not filename. Store `attempt`, `gate`, `repairClass`, `reason`, `invalidatedRoles`, and before/after digests for each repair. Attempts above three return `repair_budget_exhausted`. Optional decorative roles may be removed and revalidated; `journey_anchor`, truthful `activity_evidence`, and required transition ownership failures move to `BLOCKED`.

- [ ] **Step 5: Verify and commit**

Run `node --test skills/hyperframes-sports-director/scripts/tests/director_lock.test.mjs`, then `npm test`. Request independent review, resolve findings, rerun both commands, and complete the per-task remote checkpoint.

## Task 12: Preserve and Extend the Anchor-First HyperFrames Image Gen Pipeline

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/crop_component_sheet.mjs`
- Create: `skills/hyperframes-sports-director/scripts/build_asset_proofs.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_image_assets.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/image-assets.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/image_assets.test.mjs`
- Create: `skills/hyperframes-sports-director/references/imagegen-asset-pipeline.md`
- Create: `skills/hyperframes-sports-director/references/asset-choreography-and-render-qa.md`
- Create: `skills/hyperframes-sports-director/references/visual-standard.md`

**Interfaces:**
- Consumes: `DIRECTOR_LOCK`, frozen design/Look, approved asset plan, representative footage evidence, and privacy-trimmed data assets.
- Produces: Style Anchor acceptance evidence, representative combination evidence, crop/proof artifacts, and `ASSET_MANIFEST.json` entries with display/effective-resolution and anchor relations.

- [ ] **Step 1: Write failing anchor, effective-resolution, and asset-integrity tests**

Generate a synthetic full-resolution Style Anchor and component sheet with known colored silhouettes. Test lock authorization, provenance, token/style relation, crop boxes, transparent background, visible alpha bounds, padding, expected display rectangle, native effective pixels, 4K full-screen plate requirements, dark/light proof generation, role coverage, and rejection of a crowded-sheet crop used as a Hero. Assert production generation before `DIRECTOR_LOCK` fails.

Require one accepted Style Anchor and one representative real-footage/component combination before batch status. Require at least two semantically different final combination proofs; changing only a number or label must not count. Reject direct source-sheet references in `TIMELINE.json`.

- [ ] **Step 2: Run RED**

Run `node --test skills/hyperframes-sports-director/scripts/tests/image_assets.test.mjs`. Expected RED: image-asset modules are missing.

- [ ] **Step 3: Implement anchor-first crop, proof, and manifest mechanics**

Use Sharp to extract components. Keep source sheets immutable. Each manifest entry includes `id`, `source`, `sourceKind`, `provenance`, `documentaryStatus`, `narrativeRole`, `crop`, `alphaBounds`, `expectedDisplayRect`, `nativeEffectivePixels`, `styleAnchorId`, `proofs`, `allowedUses`, and `combinationTests`. Batch generation authorization requires accepted anchor and representative-combination digests in `PROJECT_STATE`. Rebuild the workbench after Style Anchor acceptance, representative-combination acceptance, and each accepted asset batch.

- [ ] **Step 4: Port HyperFrames visual rules into progressive references**

Retain meaning inventory, visual worlds, Style Anchor, related component sheets, separate Hero generation, source/components/proofs separation, dark/light alpha proofs, and combination tests before choreography. Define `journey_anchor`, `activity_evidence`, and `experience_carrier` with terrain, water, route, effort, and environmental examples. Forbid generated scenery as documentary evidence and define the three-attempt/role-aware failure behavior from Task 11.

- [ ] **Step 5: Verify and commit**

Run `node --test skills/hyperframes-sports-director/scripts/tests/image_assets.test.mjs`, then `npm test`. Request independent review, resolve findings, rerun both commands, and complete the per-task remote checkpoint.

## Task 13: Build Deterministic HyperFrames Composition and Design Consistency

**Files:**
- Create: `skills/hyperframes-sports-director/assets/hyperframes-project/index.html`
- Create: `skills/hyperframes-sports-director/assets/hyperframes-project/src/main.js`
- Create: `skills/hyperframes-sports-director/assets/hyperframes-project/src/scene-runtime.js`
- Create: `skills/hyperframes-sports-director/assets/hyperframes-project/src/styles.css`
- Create: `skills/hyperframes-sports-director/scripts/lib/motion.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/layout.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_design_system.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_design_consistency.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_color_pipeline.mjs`
- Create: `skills/hyperframes-sports-director/scripts/validate_contrast.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/motion_contract.test.mjs`
- Create: `skills/hyperframes-sports-director/references/hyperframes-composition.md`
- Create: `docs/design-engineering.md`

**Interfaces:**
- Consumes: frozen design/Look digests, Task 12 assets/proofs, shot continuity vectors, `SCENE_SCHEMA`, `DATA_OVERLAYS`, `MOTION_MAP`, and final-phase `TIMELINE`.
- Produces: paused absolute-time timelines, `window.__timelines`, `window.__renderAt(time, mode)`, `window.__layerEvidence`, deterministic background-only/token-matte proof passes, and hard/Agent-review consistency diagnostics.

- [ ] **Step 1: Write failing motion-contract tests**

Assert every visible asset has exactly one motion owner, every scene has entry/hold/exit intervals, each transition owns a non-empty midpoint, and timeline values are deterministic for the same seed. `DATA_OVERLAYS.json` may reference only normalized activity facts with sufficient display and sync authority; the runtime may format but never recalculate metrics.

For every readable interval, require `textRect`, `subjectRect`, tracked quiet-zone bounds, horizon relation, screen/motion direction, semantic typography role, and evidence-frame IDs. Reject a title that intersects the tracked subject/road/water safety region, loses its quiet zone during motion, or animates against the approved footage direction without a recorded design reason.

Reject `Date.now`, unseeded `Math.random`, `setTimeout`, `setInterval`, and render-truth `requestAnimationFrame`. Reject raw scene-local color literals, unresolved semantic tokens, typography/spacing/stroke/radius/easing values outside the frozen tokens, non-frozen design systems, undeclared input color interpretation, and non-Rec.709 v1 delivery. Simulated protanopia/deuteranopia must preserve route/grade/status meaning through labels, boundaries, symbols, or patterns with at least 3:1 meaningful-graphic contrast.

Classify findings explicitly. Token resolution, role, bounds, contrast inputs, ownership, timing determinism, and raster budgets are hard errors. Visual density, restraint, pacing, and cross-scene taste are `agent_review_required`; they can never be silently converted into a numeric pass.

- [ ] **Step 2: Run RED**

Expected: missing motion runtime/scaffold.

- [ ] **Step 3: Implement the paused master-timeline contract**

Expose registered timelines through `window.__timelines`. Composition renders a supplied absolute time; it does not advance itself. `window.__renderAt(time, mode)` supports `composite`, `background-only`, and per-token/per-layer matte modes so final inspection can measure local background, coverage, and transformed color. GSAP/SVG/CSS/Lottie/Three.js are selected by semantic role, with static fallbacks for review extraction.

- [ ] **Step 4: Implement design tokens and transition grammar**

Define tokens for title hierarchy, metric typography, safe zones, spacing, contrast, colors, strokes, radii, shadow/depth, entry/exit durations, easing, and redundant non-hue encodings for semantic data. Preserve the approved project tokens without mutation. Transitions must declare relationship: spatial continuation, motion match, shape/mask carry, environmental texture bridge, or data-to-footage bridge. Pure decorative transitions fail review. `SCENE_SCHEMA` carries the layout/quiet-zone tracks and `MOTION_MAP` carries the sole owner and proof-pass metadata for every layer. Finalize original-backed timeline asset/motion references, rerun `validateTimeline({ phase: "final", ... })`, advance to `MOTION_COMPOSITION`, and rebuild the workbench.

- [ ] **Step 5: Verify and commit**

Run `node --test skills/hyperframes-sports-director/scripts/tests/motion_contract.test.mjs` twice; the test fixture must compare its two normalized runtime outputs byte-for-byte. Then run `npm test`, independent review, post-review focused/full tests, and the remote checkpoint.

## Task 14: Render Original-Backed Finals

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/render_final.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/render.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/render.test.mjs`
- Create: `skills/hyperframes-sports-director/references/clarity-and-export.md`

**Interfaces:**
- Consumes: `DIRECTOR_LOCK`, final-phase original-backed timeline, frozen design/Look, resolved asset/motion ownership, Task 9 render-plan primitives, and current dependency digests.
- Produces: cache-keyed intermediate chunks, final FFmpeg argument arrays, render provenance, and a closed original-backed `renders/final.mp4` candidate. It does not mark delivery.

- [ ] **Step 1: Write failing render-plan tests before invoking FFmpeg**

Given a timeline and brief, assert the compiled final plan resolves originals only, rejects every proxy/analysis derivative, decodes original still images, preserves rational fps, calculates transforms from source and delivery rasters, includes source-audio bridges and approved local background music, and partitions the three-minute timeline into journey-chapter intermediates keyed by every relevant upstream digest plus normalized treatment parameters. Changing one chapter title must invalidate only that chapter plus final assembly/review; changing the frozen Look must invalidate every visual chapter. Test pre-lock render rejection, stale-lock rejection, cancellation with child-process termination and partial-file cleanup, invalidation-driven cache misses, and deterministic failure when the requested size target violates the clarity floor.

- [ ] **Step 2: Run RED**

Expected: missing render compiler.

- [ ] **Step 3: Implement render-plan compilation and cache**

Compile explicit FFmpeg argument arrays per journey chapter, then a deterministic final assembly plan. Chapter boundaries come from approved timeline beats, not fixed wall-clock slices. Stabilization uses a two-pass filter when available and a documented conservative fallback otherwise. Speed changes use matched video PTS and audio tempo chains; no clip may silently desynchronize audio. Approved local background music uses trim/loop, fades, loudness normalization, speech-aware ducking, and ambience-priority automation across chapter seams. No final plan may resolve a remote music URL or temporary provider track.

- [ ] **Step 4: Implement final export policies**

4K output is `3840:2160`; 1080p output is `1920:1080`; both use square pixels and 16:9. Chapter intermediates use an intermediate-safe profile and never count as delivery encodes. Container, codecs, and optional `maxFileSizeMiB` come from `EDIT_BRIEF.json`. A hard size ceiling uses an explicit audio/video bitrate budget and two-pass encoding; the first pass writes no delivery media. If the requested duration/raster/codec/size violates the clarity floor, fail with alternatives rather than silently lowering quality. The final command resolves original hashes, composes HyperFrames layers, joins verified chapter intermediates, and performs one lossy delivery encode. Write a render provenance sidecar before moving the successful temporary output to `renders/final.mp4`. Advance only to `FINAL_RENDER` and rebuild the workbench; rendering alone cannot mark QA or delivery.

- [ ] **Step 5: Verify with synthetic 1080p and short 4K renders**

Run `node --test skills/hyperframes-sports-director/scripts/tests/render.test.mjs`. Expected: correct dimensions/fps, proxy watermark absent from final, A/V duration delta within one frame, and cache hit on the identical second render. Then run `npm test`, independent review, post-review tests, and the remote checkpoint.

## Task 15: Inspect the Final MP4, Repair Within Bounds, and Produce Review Evidence

**Files:**
- Create: `skills/hyperframes-sports-director/scripts/inspect_output.mjs`
- Create: `skills/hyperframes-sports-director/scripts/lib/visual-qc.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/inspect_output.test.mjs`
- Modify: `skills/hyperframes-sports-director/templates/REVIEW_REPORT.template.md`
- Create: `skills/hyperframes-sports-director/references/workflow.md`

**Interfaces:**
- Consumes: closed final MP4 candidate, render provenance, deterministic proof passes/mattes, frozen approval/design/Look digests, repair budget, and all hard-gate validators.
- Produces: `inspectOutput(...)`, `measureLocalContrast(...)`, `measureRenderedTokenColor(...)`, repair-or-block decisions, `review/metrics.json`, `REVIEW_REPORT.md`, final-MP4 evidence frames, updated workbench, and either `DELIVERED` or `BLOCKED`.

- [ ] **Step 1: Write failing QC tests using injected known defects**

Fixtures must include black frames, freeze spans, clipped audio, loudness outside policy, A/V duration drift, deliberate excessive detail loss, low-contrast moving backgrounds, token color drift, undeclared input color profile, layout/subject collision, quiet-zone loss, and cross-scene token/typography drift. Add frame-evidence assertions for each scene's entry, hold, exit, every transition midpoint, and the highest-motion/lowest-contrast points of readable intervals.

Inject a repairable text-position failure, an optional decorative-asset failure, a fourth-attempt failure, and a frozen-token change request. Prove the first two create bounded downstream revisions and rerun affected evidence, the third returns `repair_budget_exhausted`, and the fourth returns `approval_boundary_crossed` without mutation.

- [ ] **Step 2: Run RED**

Expected: missing output inspector.

- [ ] **Step 3: Implement measurable QC**

Use ffprobe plus FFmpeg `blackdetect`, `freezedetect`, `ebur128`, clipping analysis, and SSIM on controlled identity segments. A process exit code or existing filename is insufficient: close and re-probe the final file and verify its requested delivery contract.

For every readable interval, sample at least 10 Hz plus entry, hold, exit, transition midpoint, motion extrema, and background-luminance extrema. Use the runtime background-only pass and glyph/graphic matte to measure local contrast inside actual visible bounds. Critical text passes every sample; ordinary text passes at least 95% with no continuous failure longer than 0.25 seconds; large text/meaningful graphics meet 3:1.

For token-color validation, render the matching background-only and coverage-matte passes. Compute the expected alpha composite from the declared semantic token and the decoded local background, exclude anti-aliased edge pixels below the documented interior-coverage threshold, convert expected/actual Rec.709 samples to Lab, and require Delta E 2000 `<=3`. This avoids comparing a translucent overlay directly with its uncomposited source color.

Machine hard gates run before Agent review. The Agent then inspects decoded final-MP4 frames/contact sheets for composition, density, restraint, pacing, Style Anchor consistency, and transition meaning; it records evidence IDs and a pass/block decision without claiming `USER_ACCEPTED`.

- [ ] **Step 4: Build the review pack**

Extract labeled frames from the final MP4 only. Include side-by-side source/final crops for clarity-sensitive sections, transition-midpoint frames, alpha proofs, two distinct combination proofs, token/contrast evidence, and a summary contact sheet. Browser previews are supplementary and cannot satisfy final evidence. Rebuild the director workbench with final progress, output path, hard-gate results, Agent review, repair history, and final evidence links.

- [ ] **Step 5: Verify and commit**

Run `node --test skills/hyperframes-sports-director/scripts/tests/inspect_output.test.mjs` and assert each injected defect is detected, bounded repair invalidates and reruns the correct closure, a clean fixture reaches `DELIVERED`, and no path infers `USER_ACCEPTED`. Then run `npm test`, independent review, post-review tests, and the remote checkpoint.

## Task 16: Write the Lean, Discoverable Agent Skill and UI Metadata

**Files:**
- Create: `skills/hyperframes-sports-director/SKILL.md`
- Create: `skills/hyperframes-sports-director/agents/openai.yaml`
- Create: `skills/hyperframes-sports-director/references/unix-pipeline.md`
- Create: `skills/hyperframes-sports-director/references/sport-profiles.md`
- Create: `skills/hyperframes-sports-director/scripts/check_structure.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/check_structure.test.mjs`

**Interfaces:**
- Consumes: all validated commands, the recalibrated state machine, and progressive references from Tasks 5–15.
- Produces: the installable Skill router and UI metadata; it orchestrates commands but does not reimplement their contracts.

- [ ] **Step 1: Write the failing structure/discovery test**

Assert valid YAML frontmatter, hyphenated name under 64 characters, description under 500 characters, `SKILL.md` under 500 lines, all links valid and at most one reference hop from `SKILL.md`, scripts executable, `agents/openai.yaml` consistent, implicit invocation true, and no unfinished scaffold markers.

- [ ] **Step 2: Run RED**

Expected: missing `SKILL.md` and `openai.yaml`.

- [ ] **Step 3: Write the minimum Skill that addresses observed baseline failures**

Use this frontmatter description unless trigger evals prove a narrower revision is better:

```yaml
---
name: hyperframes-sports-director
description: Use when editing a local directory of sports videos, action-camera footage, still images, local music, or optional FIT/KML data into an immersive sports Vlog with shot evidence, one director approval, truthful graphics, mandatory FFmpeg processing, HyperFrames motion design, unattended QA, and 16:9 4K/1080p delivery.
---
```

`SKILL.md` contains only: purpose, when/not to use, input-directory and editing-brief discovery, the recalibrated `PROJECT_STATE` router, mandatory FFmpeg and HyperFrames boundaries, three truth-chain invariants, exact reference routing, required output artifacts, one `DIRECTOR_LOCK` approval, post-lock unattended operation, bounded repair, honest `BLOCKED`/`CANCELLED`, and `DELIVERED` versus optional `USER_ACCEPTED`. Input discovery normalizes local music, copy/captions, duration, output container/codecs, resolution, frame-rate policy, maximum file size, required moments, exclusions, and privacy; ask only when a missing value materially changes the one approval. It must not duplicate FFmpeg procedures, sport tables, schemas, or long visual rules.

- [ ] **Step 4: Add progressive reference routing and UI metadata**

Route by condition:

- always read `workflow.md`;
- read `director-workbench.md` while preparing `DIRECTOR_REVIEW_READY` or recording approval;
- read `ingest-and-shot-understanding.md` when footage exists;
- read `activity-data.md` only when activity data is provided;
- read `sport-profiles.md` for the selected sport;
- read Image Gen and choreography references when visual assets are planned;
- read audio continuity when dialogue/voice/important ambience is present;
- read clarity/export before final render;
- never route to remote music generation/download in v1.

`agents/openai.yaml` uses quoted strings, `allow_implicit_invocation: true`, a 25–64 character UI description, and a one-sentence default prompt that explicitly mentions `$hyperframes-sports-director`.

- [ ] **Step 5: Validate and commit**

Run the bundled Skill Creator `quick_validate.py`, project structure tests, `wc -l SKILL.md`, and `rg -n 'TODO|TBD|FIXME|fill this in' skills/hyperframes-sports-director`. Expected: validator success, fewer than 500 lines, and no marker matches. Commit.

## Task 17: Run Skill GREEN/REFACTOR Evals and Optimize Triggering

**Files:**
- Modify: `skills/hyperframes-sports-director/SKILL.md`
- Modify: `skills/hyperframes-sports-director/evals/evals.json`
- Modify: `skills/hyperframes-sports-director/evals/trigger-evals.json`
- Create: `docs/skill-evaluation-report.md`
- Create: `skills/hyperframes-sports-director/scripts/tests/trigger_eval.test.mjs`

**Interfaces:**
- Consumes: Task 2 immutable baselines and the complete Task 16 Skill.
- Produces: paired with/without-Skill evidence, trigger metrics, human evaluation results, and only failure-driven Skill/reference/script refinements.

- [ ] **Step 1: Run all with-Skill and baseline cases in the same evaluation turn**

For each of the six realistic eval prompts, run a fresh independent worker with the Skill and a paired baseline without it. Store results in the gitignored sibling workspace by iteration. Capture duration and token counts immediately when each run finishes.

- [ ] **Step 2: Add objective assertions while runs execute**

Assertions must check artifact existence and schema validity, draft-not-frozen templates, equal whole-direction proposals, local workbench privacy, one hash-bound approval, transactional direction lock, Style Anchor/combination gates, original-backed final sources, missing-data semantics, privacy trimming, audio-cut validation, manifest/motion ownership, bounded repair, final MP4 evidence, `DELIVERED`/`USER_ACCEPTED` separation, and profile maturity. Do not turn visual taste into a regex assertion.

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

## Task 18: Build Golden End-to-End Evals and the 100-Point Scorer

**Files:**
- Create: `skills/hyperframes-sports-director/evals/fixtures/projects/{cycling,hiking,pool-swimming}/**`
- Create: `skills/hyperframes-sports-director/evals/expected/*.json`
- Create: `skills/hyperframes-sports-director/scripts/score_eval.mjs`
- Create: `skills/hyperframes-sports-director/scripts/tests/score_eval.test.mjs`
- Modify: `skills/hyperframes-sports-director/evals/rubric.json`

**Interfaces:**
- Consumes: final `review/metrics.json`, hard-gate evidence, Agent visual-review status, profile maturity, and golden human-review fields.
- Produces: deterministic category points, hard/threshold failures, and `releaseEligible`; it never converts unresolved taste review into a pass.

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

Every golden project must build the local workbench, compare equal whole-direction candidates, record one synthetic hash-bound approval, lock design/Look transactionally, pass Style Anchor and representative-combination gates, update the workbench after each required state, and reach unattended `DELIVERED` without `USER_ACCEPTED`. Inject one bounded auto-repair in cycling and one optional-asset degradation in hiking; pool swimming proves no-GPS truth and underwater Look consistency.

Use short deterministic synthetic media for CI and retain a manifest for local real-footage acceptance. Both 1080p and a short 4K final must be exercised. Human product acceptance covers the workbench golden fixture and the final composition/taste of all three release-grade golden videos.

- [ ] **Step 5: Verify release threshold and commit**

Run `npm run eval` twice. Expected: identical normalized metrics, each score `>=90`, no hard gates, no category below 80%. Commit.

## Task 19: Documentation, CI, Packaging, and `v1.0.0` Release Dry Run

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

**Interfaces:**
- Consumes: the complete verified Skill tree, three release-grade scores, workbench/final-video human sign-off, attribution, and version metadata.
- Produces: CI/release gates, user/contributor docs, icons, and the dry-run `.skill` archive. It does not publish or tag.

- [ ] **Step 1: Write failing release-consistency tests**

Assert package version `1.0.0`, changelog heading `1.0.0`, release workflow tag pattern `v*`, archive name `hyperframes-sports-director-v1.0.0.skill`, valid icons referenced by `openai.yaml`, both upstream attributions, clean package manifest, and no forbidden media/secrets.

- [ ] **Step 2: Run RED**

Expected: missing release files/assets.

- [ ] **Step 3: Write concise user and contributor documentation**

README covers scope, install, local input-directory contract, editing brief, local background music, copy/captions, format/codecs/file-size controls, mandatory FFmpeg, mandatory HyperFrames, typical three-minute 16:9 4K/1080p use, the three release-grade versus four experimental profiles, local director workbench, one `DIRECTOR_LOCK` approval, Anchor-first assets, unattended delivery, bounded repair/`BLOCKED`, three truth chains, privacy, cancellation, `DELIVERED` versus optional `USER_ACCEPTED`, and examples. Explicitly list the GUI, cloud/share review, remote music/Suno, and experimental-profile release claims as non-goals. Keep operational detail in Skill references rather than duplicating it. RELEASING requires clean tree, all checks, golden scores, workbench plus final-video human sign-off, archive checksum, and explicit tag confirmation.

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

**Reviewed:** 2026-09-01. These checks cover the specification and plan; they do not claim the implementation is complete.

Before implementation handoff, the executing agent must confirm:

- [x] The product is a standard directory-based sports-Vlog editing workflow Skill, not primarily a sports-data report or promotional-film generator.
- [x] Mixed video/image/audio/activity inputs and editing-brief choices for music, copy, format, codecs, raster, duration, and file size are first-class contracts.
- [x] Local FFmpeg/ffprobe and HyperFrames are mandatory core stages with tested install blockers.
- [x] Sport-neutral architecture uses one pipeline; cycling, hiking/non-technical mountain journey, and pool swimming are release-grade while four additional profiles remain experimental contracts.
- [x] DJI Osmo Action 5 Pro is a device policy, not a hard-coded ingest path.
- [x] Approximate three-minute delivery and 16:9 4K/1080p are explicit contracts.
- [x] Scene order, camera roles, setup-tail removal, shake, duplicates, stabilization, beauty/color, speed ramps, and return-home journey grammar are covered.
- [x] Speech and ambience continuity are protected and testable.
- [x] The three versioned truth chains and their non-overwrite authority are explicit.
- [x] `PROJECT_STATE` gates analysis, rough cut, director review/lock, Style Anchor, asset production, motion composition, final render, final QA, cancellation/blocking, delivery, and optional user acceptance.
- [x] FIT/KML truth, missing values, exact weighted formulas, coverage authority, sync, duplicate exclusion, and privacy are covered.
- [x] Portable artifacts omit absolute paths/private filenames; optional preview sessions are localhost-only, owner-only, expiring, and cleanable.
- [x] The local HyperFrames director workbench presents equal whole-direction candidates and records exactly one hash-bound normal-path approval without becoming an editor or render controller.
- [x] Draft design/Look templates cannot claim frozen status; transactional lock, revision hashes, dependency invalidation, three-attempt repair budgets, and approval boundaries are explicit.
- [x] Delivery requires a closed, re-probed, encoded final file plus hard-gate evidence; process exit alone is insufficient.
- [x] HyperFrames Image Gen source worlds, component sheets, hero assets, cropping, alpha proofs, combination tests, choreography, transitions, and final MP4 evidence are retained.
- [x] Production Image Gen is forbidden before lock; Style Anchor, representative combination, 4K effective-pixel budgets, and two semantically different final combination proofs are hard gates.
- [x] Generated assets cannot impersonate real footage or unrecorded data.
- [x] UNIX responsibilities are small, composable, file-based, and independently testable.
- [x] Design engineering is tokenized, owned, deterministic, and evaluated at motion states.
- [x] Real-footage layout contracts include `textRect`, `subjectRect`, tracked quiet zones, horizon, motion direction, background-only passes, layer mattes, local contrast, and alpha-aware Delta E measurement.
- [x] Skill Creator progressive disclosure, discovery, baseline comparison, human review, and trigger optimization are explicit.
- [x] v1.0.0 release thresholds are numerical and reproducible.

## Final Self-Review Commands

Run these against the completed plan before implementation begins:

```bash
rg -n '<[^>]+>|\bplaceholder\b|\bTBD\b|\bFIXME\b' docs/superpowers/plans/2026-08-31-hyperframes-sports-director-v1.md
rg -n '^## Task [0-9]+:' docs/superpowers/plans/2026-08-31-hyperframes-sports-director-v1.md
rg -n 'ASSET_MANIFEST|MOTION_MAP|TIMELINE|Image Gen|4K|1080p|pool swimming|FIT|KML|audio|proxy' docs/superpowers/plans/2026-08-31-hyperframes-sports-director-v1.md
```

Expected: the first command reports only literal regex examples if present and no unresolved plan value; the second reports Tasks 1–19 exactly once; the third confirms all major contracts are present.
