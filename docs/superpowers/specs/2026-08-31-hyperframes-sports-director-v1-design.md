# HyperFrames Sports Director v1.0.0 Design Specification

**Status:** Approved after director-workbench recalibration; Tasks 1–2 accepted on `main`
**Date:** 2026-09-01  
**Implementation resume point:** Recalibrated Task 3 — versioned data contracts and lifecycle
**Project:** `hyperframes-sports-director`  
**Skill:** `hyperframes-sports-director`  
**Upstream lineage:** `geekjourneyx/hyperframes-motion-director` and `op7418/guizang-sports-skill`

## 1. Product definition

HyperFrames Sports Director is a standard sports-Vlog editing workflow Skill plus a set of small local media tools. It accepts a user-provided local media directory and an editing brief, then turns mixed short videos, long action-camera recordings, still images, optional music, and optional activity data into an immersive sports Vlog. It is derived from HyperFrames Motion Director rather than rebuilt from zero.

The system keeps real footage as the narrative truth. HyperFrames motion design, Image Gen assets, activity-data graphics, titles, transitions, sound design, and color treatment exist to clarify rhythm and deepen immersion. They must not turn the result into a promotional film or make generated material appear to be documentary evidence.

The user brief declares sport, story emphasis, background-music choice, copy requirements, output container/codecs, resolution, duration, and optional file-size ceiling. Defaults are a roughly three-minute, 16:9 landscape MP4 at either 3840×2160 or 1920×1080. The primary capture profile is DJI Osmo Action 5 Pro. The architecture is sport-neutral. Cycling, hiking/non-technical mountain journey, and pool swimming are release-grade v1 profiles. Running, technical mountaineering safety extensions, trail running, and open-water swimming remain schema-compatible experimental profiles and are not release claims.

Activity data is optional. A video/image-only project must complete the entire editing pipeline without FIT, KML, GPS, or sensor input. When activity data exists, it adds truthful route, metric, chapter, and motion context only after availability, coverage, privacy, and time-sync checks pass.

Local FFmpeg/ffprobe is mandatory, not an optional export utility. It scans and probes the input directory, decodes still images, extracts keyframes and evidence frames, generates proxies/contact sheets, analyzes audio and motion, applies treatments, mixes background music, composites the final picture, encodes delivery files, and inspects the result. HyperFrames is the mandatory visual-direction and motion-composition core.

## 2. First principles

1. **Truth before spectacle.** Source footage and recorded activity data are evidence. Generated imagery is interpretive support and is visibly subordinate to evidence.
2. **Experience before coverage.** The edit reconstructs a felt journey—departure, motion, effort, place, pause, return—not a catalog of every captured clip.
3. **Continuity before compression.** Speed ramps, removals, and transitions may shorten time without breaking spatial, action, or audio continuity.
4. **Motion must carry meaning.** Every graphic, crop, mask, particle, title, and transition has a declared narrative role.
5. **Quality must be measurable.** Resolution, source provenance, A/V sync, frozen frames, black frames, speech cuts, duplicate shots, visual-asset integrity, and release structure have executable gates.
6. **One core, many policies.** Sport differences belong in declarative profiles. The pipeline must not fork into separate applications for cycling, swimming, or hiking.
7. **The Agent judges; tools measure.** Semantic shot interpretation and editorial choice remain with the Agent. Deterministic scripts probe, transform, validate, render, and score artifacts.

### 2.1 Constraint authority and three truth chains

The system has three independent, versioned truth chains. A later chain may reference an earlier one but may not silently rewrite it:

| Truth chain | Deterministic contracts | Agent authority |
|---|---|---|
| Recorded-media truth | `PROBE.json → SEGMENTS.json → SHOTS.jsonl → TIMELINE.json` | Interpret meaning, select moments, and build story; never invent source ranges, camera facts, or recorded events. |
| Activity-data truth | `ACTIVITY.json → SYNC_MAP.json → DATA_OVERLAYS.json` | Decide whether truthful metrics help the story; never change measured values, coverage, availability, sync confidence, or privacy state. |
| Design truth | `DESIGN_SYSTEM.json + LOOK_PROFILE.json → ASSET_MANIFEST.json → MOTION_MAP.json` | Propose and select a coherent direction; after freeze, use declared tokens and ownership only. |

`TIMELINE.json` may consume all three chains, but final rendering is valid only when every referenced revision is frozen and all source IDs resolve. Generated assets are always labeled as interpretive or decorative; they cannot enter the recorded-media or activity-data truth chains.

### 2.2 Execution state machine and authorization

Every project records its state and gate evidence in `PROJECT_STATE.json`:

```text
INTAKE
→ CAPABILITY_CHECK
→ SCAN
→ ANALYZE
→ ROUGH_CUT
→ DIRECTOR_REVIEW_READY
→ DIRECTOR_LOCK
→ STYLE_ANCHOR
→ ASSET_PRODUCTION
→ MOTION_COMPOSITION
→ FINAL_RENDER
→ FINAL_QA
→ DELIVERED
→ USER_ACCEPTED (optional, non-blocking)
```

`BLOCKED` and `CANCELLED` are terminal side states reachable from any production stage. `USER_ACCEPTED` records optional post-delivery feedback; it is not required for unattended delivery.

| State | Required entry evidence | Produced evidence and exit gate | Workbench behavior |
|---|---|---|---|
| `INTAKE` | Readable project destination and user request | Draft `PROJECT`, `EDIT_BRIEF`, design, Look, and unavailable optional contracts | Not yet available |
| `CAPABILITY_CHECK` | Valid intake contracts | Compatible Node, FFmpeg/ffprobe, required filters, Sharp, HyperFrames and workbench scaffold report | Not yet available |
| `SCAN` | Mandatory capabilities pass | Immutable media inventory, hashes, probe records, classified unsupported files, provenance-safe proxies | Not yet available |
| `ANALYZE` | Current scan digests | Segments, evidence frames, shots, transcript status, activity/sync/data authority | Not yet available |
| `ROUGH_CUT` | Current analysis plus edit authorization | Valid rough-phase timeline and closed/re-probed proxy rough cut | Initial build can reconstruct all prior progress |
| `DIRECTOR_REVIEW_READY` | Current brief/evidence/rough cut plus two or three complete direction proposals | Workbench digest exactly matches displayed artifact digests and every approval field is available | Show the single approval action |
| `DIRECTOR_LOCK` | One current hash-bound approval | Transactionally committed frozen design/Look pair and lock evidence | Remove approval action; show locked direction |
| `STYLE_ANCHOR` | Current lock and approved asset plan | Accepted full-resolution Style Anchor plus representative component/real-footage combination proof | Show anchor/proof progress and failures |
| `ASSET_PRODUCTION` | Both anchor gates pass | Valid manifest, crops, alpha/effective-resolution proofs, and two semantically different combination proofs | Update after each accepted asset batch |
| `MOTION_COMPOSITION` | Current assets/data/timeline | Final-phase timeline, scene schema, motion ownership, deterministic entry/hold/exit/midpoint evidence | Show scene/motion completion and hard findings |
| `FINAL_RENDER` | Every referenced digest current and no hard error | Closed/re-probed original-backed final candidate plus render provenance | Show render completion, never claim delivery |
| `FINAL_QA` | Current final candidate | Machine metrics, bounded-repair history, decoded-MP4 evidence, and Agent visual-review decision | Show each repair revision and current gate |
| `DELIVERED` | All hard gates and Agent final-MP4 review pass | Verified final path and review pack handed off | Show delivered artifact and evidence links |
| `USER_ACCEPTED` | Optional post-delivery user signal | Acceptance record only; it does not change technical evidence | Show optional acceptance status |
| `BLOCKED` / `CANCELLED` | Failed non-optional gate / explicit cancellation | Reason, attempts, cleanup, last valid checkpoint, and no delivery claim | Show exact recovery or terminal evidence |

State transitions are deterministic and auditable:

- an unreadable input directory or missing/incompatible FFmpeg/ffprobe stops before `SCAN`;
- missing activity data is a supported branch, not a blocker: emit `ACTIVITY.json` with `status: "unavailable"`;
- a request for analysis does not authorize rough-cut or final rendering; a request to edit and deliver a video authorizes analysis and a low-cost proxy rough cut, but production asset generation and final rendering remain blocked until `DIRECTOR_LOCK`;
- `DIRECTOR_REVIEW_READY` requires a complete local director workbench containing the normalized brief, source evidence, key frames, proxy rough cut, whole-direction candidates, visual-asset/component plan, music plan, risks, and artifact hashes;
- the project accepts exactly one normal-path user approval in `DIRECTOR_APPROVAL.json`; the approval binds the selected whole direction and the exact brief, rough-cut, music-plan, asset-plan, evidence, and proposal revisions;
- a deterministic lock command validates the approval hashes and atomically freezes exactly one `DESIGN_SYSTEM.json` and one independent `LOOK_PROFILE.json`; production visual generation and final composition cannot start earlier;
- bounded automatic corrections may change only approved implementation details. A change to story, key shots, selected visual direction, semantic tokens, Look, music direction, privacy policy, or delivery contract immediately moves the current run to `BLOCKED`; it never requests an exception approval. A user who wants such a change starts a separate project revision and approval flow outside the unattended run;
- final rendering cannot start while source, sync, privacy, asset, motion, or timeline references are unresolved;
- cancellation terminates child FFmpeg processes, removes incomplete temporary output, records `CANCELLED`, and never reports an encoding failure as success;
- `DELIVERED` requires the output file to exist, be closed, re-probe successfully, pass machine hard gates, pass Agent visual inspection of the encoded MP4, and have review evidence generated from that MP4; it does not imply `USER_ACCEPTED`;
- when visual inspection is unavailable, the system may report measurable checks but must not claim visual acceptance.

## 3. UNIX design assessment

The system conforms to UNIX design philosophy when implemented as a thin Agent orchestrator over composable file-based tools:

```text
intake -> scan -> probe -> proxy -> segment -> understand -> sync -> plan -> treat -> compose -> render -> inspect
```

Each command owns one transformation, reads declared inputs, writes declared outputs, prints machine-readable diagnostics, and exits non-zero on contract failure. JSON, JSONL, WAV, PNG, WebP, MP4, MKV, and Markdown are the integration boundary. Tools do not hide editorial state in a database or global process.

Two boundaries are intentionally not collapsed:

- `ASSET_MANIFEST.json` is the source of truth for visual assets, provenance, crop status, alpha bounds, and narrative roles.
- `MOTION_MAP.json` is the source of truth for animation ownership, primitives, entry/hold/exit timing, compositing, and transition responsibility.

`TIMELINE.json` references both contracts but does not absorb them. This preserves separation of evidence, appearance, and time.

## 4. Design-engineering assessment

The visual system follows design engineering rather than decorative motion graphics:

- Typography, color, spacing, stroke, corner radius, depth, and motion durations come from tokens.
- A title hierarchy distinguishes journey title, chapter title, metric label, and annotation.
- Real footage maintains visual primacy. Generated elements appear at narrative hinges, information gaps, spatial transitions, or controlled moments of emphasis.
- Composite assets have explicit ownership, readable silhouettes, safe zones, and verified alpha bounds.
- Transitions have semantic relationships between outgoing and incoming shots; the midpoint cannot become an empty or arbitrary effect frame.
- Motion is evaluated at entry, hold, exit, and transition midpoint in the final encoded MP4—not only in a browser preview.
- The same profile and seed produce deterministic animation timing.

### 4.1 Visual lineage and project-level style lock

Retain HyperFrames' default cinematic lineage as the fallback visual grammar: near-black `#050505`, white/gray typography, one restrained warm-gold accent, low-brightness cinematic contrast, large negative space, subtle grain, shallow depth, haze, rim light, and local metallic highlights. Do not force that exact accent onto every sport or every source environment.

Each project creates two independent draft contracts before visual production:

- `DESIGN_SYSTEM.json`: semantic colors, typography, spacing, safe zones, strokes, radii, depth, data colors, and motion tokens.
- `LOOK_PROFILE.json`: input color interpretation, working/output color space, white balance, exposure, contrast, saturation, highlight protection, shot-matching policy, and any approved LUT/source transform.

The lifecycle is `draft → proposed → approved → frozen → superseded`. Project templates start at `draft`; an empty or default template must never claim `frozen`. After inspecting representative footage, the Agent creates two or three whole-direction proposals that use the same footage, copy, viewport, and information density. The proposals show real key frames, code-rendered typography/data layers, layout proofs, motion storyboards, and planned visual assets, but they do not generate production Image Gen assets.

The local director workbench records one selected whole direction in `DIRECTOR_APPROVAL.json`. Cross-proposal mixing is not supported in v1. A deterministic lock command verifies all bound hashes, promotes the approved proposal, and atomically freezes exactly one active `DESIGN_SYSTEM.json` and one independent `LOOK_PROFILE.json`. Scenes, titles, data overlays, transitions, and generated assets then reference semantic tokens; scene-local arbitrary colors are invalid. Frozen design and Look contracts are immutable during unattended production. A change that would alter either contract immediately blocks the current run; it may be considered only in a separately initiated project revision and approval flow, never by mutating or re-approving this run.

The default v1 delivery color space is SDR Rec.709. HDR delivery is outside v1 unless a later profile explicitly adds end-to-end input, working-space, render, metadata, and display validation.

### 4.2 Contrast and color consistency gates

- Key titles and critical metrics target `7:1` local contrast and must never fall below `4.5:1`.
- Ordinary readable text must remain at or above `4.5:1`.
- Large chapter titles and meaningful non-text graphics must remain at or above `3:1`.
- Contrast is measured inside the rendered glyph/graphic bounds against the local moving background, not against whole-frame average luminance.
- Critical text passes every sampled frame. Ordinary text passes at least 95% of sampled frames with no continuous failure longer than 0.25 seconds.
- Sample every readable interval at least 10 Hz plus entry, hold, exit, transition midpoint, motion extrema, and background-luminance extrema. The HyperFrames runtime must provide a deterministic background-only pass and glyph/graphic coverage mattes for the same absolute times.
- If footage cannot support the threshold, apply local shadow/stroke, scrim, mask/gradient, blur/desaturation, position change, then token-approved color change—in that order.
- Final rendered semantic-token colors must remain within Delta E 2000 `<=3` of their declared values after the delivery color transform. For translucent layers, compute the expected alpha composite from the declared token and decoded background-only pass, then compare it with decoded final pixels inside the high-coverage matte; do not compare a composited pixel directly with an uncomposited source token or include anti-aliased edges.
- Route, grade, intensity, and status categories cannot rely on hue alone. Protanopia/deuteranopia simulations must preserve labels, boundaries, symbols, or patterns with at least `3:1` meaningful-graphic contrast.

### 4.3 Activity-data display authority

- No activity file: write `ACTIVITY.json` with `status: "unavailable"`; do not block editing or create empty data graphics.
- No reliable time mapping: route and metrics may appear only as whole-activity or chapter-summary visuals, never as time-synchronized overlays.
- Coverage below 10%: suppress the metric and report insufficient coverage.
- Coverage from 10% through 39.9%: permit only a labeled local observation.
- Coverage from 40% through 79.9%: permit a visible metric with a coverage caveat; do not present it as whole-activity truth.
- Coverage at least 80%: permit a primary whole-activity metric when the sport profile also allows it.
- Mixed sports are aggregated and ranked only inside comparable sport profiles.
- Public route assets use an actually trimmed derivative; a warning alone does not satisfy privacy.

### 4.4 Local director workbench and single approval

`review/director-workbench.html` is the canonical human-facing project view. It is a local evidence and decision surface, not an editor, render controller, or second source of truth. Its independent, non-exported UI tokens are `background #050505`, `surface #0D0D0D`, `surfaceRaised #141414`, `textPrimary #F5F2EA`, `textSecondary #A8A29A`, `accent #C9A86A`, `danger #E36B5D`, and `line #2A2A2A`. These stable HyperFrames tokens style only the workbench chrome. Candidate directions remain isolated inside equal-size preview canvases so the chrome does not change their project palettes or layouts.

The workbench must:

- present the brief, stage progress, provenance-safe key frames, key shots, proxy rough cut, story structure, music plan, whole-direction candidates, asset/component/Hero plan, risks, and current gate evidence;
- show every candidate against the same representative footage, copy, viewport, and information density;
- update atomically whenever a required artifact revision or `PROJECT_STATE` gate changes;
- reference only project-relative review derivatives and never embed original media, raw GPS, absolute paths, or private filenames;
- bind only to `127.0.0.1`/localhost when served, use a random expiring owner-only session, and expose only a narrow approval endpoint;
- write one append-only `DIRECTOR_APPROVAL.json` when the project is `DIRECTOR_REVIEW_READY`; it may not edit timelines, design contracts, assets, or FFmpeg processes directly.

The v1 normal path has exactly one `DIRECTOR_LOCK` approval. A required correction that crosses the approved story, key shots, direction, semantic tokens, Look, music, privacy, or delivery boundary immediately records `BLOCKED` for the current run; the workbench never requests a second or exception approval. A user may start a separate project revision and approval flow to change that direction.

### 4.5 Consistency, invalidation, and bounded repair

Machine-enforceable design facts are hard gates: semantic-token resolution, typography role, safe-zone containment, local contrast, rendered token color, raster/effective-pixel budget, asset provenance, alpha proof, motion ownership, deterministic timing, and non-empty transition midpoint. Composition, visual density, pacing, restraint, and cross-scene taste are Agent review judgments supported by decoded final-MP4 evidence; a numerical score cannot silently replace them.

Every artifact records its revision, content hash, and upstream hashes. When an upstream artifact changes, the project computes the dependency closure, invalidates affected cache/render/review evidence, and rolls `PROJECT_STATE` back to the earliest affected gate. A frozen design or Look change always crosses the single-approval boundary and immediately blocks the current run rather than reopening approval.

Automatic repair receives at most three attempts per failed gate. Repairs may reposition text, select a same-role approved fallback, adjust a declared mask/scrim, tune gain, trim a seam, or adjust timing within profile and approval limits. Optional decorative assets may be removed followed by full dependent validation. Failure of a `journey_anchor`, truthful `activity_evidence`, required transition owner, or another non-optional role moves the project to `BLOCKED`; the system may not substitute style-incompatible media merely to produce a file.

## 5. v1.0.0 scope

### 5.1 Included

- A new standalone AGPL-3.0 repository and installable Agent Skill.
- Input-directory intake for mixed video, image, audio, activity-data, and sidecar files without modifying the user's directory.
- A versioned editing brief covering story intent, background music, copy, captions, duration, container, codec, raster, frame rate, and maximum file size.
- A project-local HyperFrames-styled director workbench for progress, evidence, whole-direction comparison, and one auditable `DIRECTOR_LOCK` approval.
- Attribution and retained lineage to both upstream AGPL projects.
- Thin orchestration instructions built around HyperFrames.
- Media probe, proxy creation, scene segmentation, contact-sheet generation, and artifact validation.
- Agent-authored shot understanding for camera role, action, environment, quality, continuity, audio, and confidence.
- Removal candidates for camera pickup/setup/tail handling, accidental ground shots, severe shake, unusable blur, duplicates, and broken audio.
- Conservative stabilization, reframing, speed ramps, color normalization, optional face/skin treatment, and sound continuity rules.
- Optional FIT/KML/normalized activity JSON ingestion with missing-data semantics, GPS/time alignment, route privacy, and data-truth gates.
- Declarative sport, device, and delivery profiles.
- HyperFrames visual-direction brief, scene schema, asset manifest, motion map, beat map, and deterministic timeline.
- Built-in Image Gen workflow for source visual worlds, component sheets, separately generated hero assets, crop extraction, dark/light proof sheets, and combination tests.
- Anchor-first visual production: one accepted Style Anchor and one representative component combination proof before batch generation.
- Bounded unattended correction with dependency invalidation, three-attempt budgets, role-aware degradation, and honest `BLOCKED` results.
- Rough-cut and final-render separation. Proxies are never accepted as final source.
- FFmpeg-based still-image decoding, keyframe extraction, audio/music mixing, picture composition, delivery encoding, and final inspection.
- 4K and 1080p landscape delivery profiles.
- Automated unit, contract, synthetic-media, end-to-end, and Agent-trigger evals.
- Release gates and `v1.0.0` packaging.

### 5.2 Explicitly excluded from v1.0.0

- A desktop or web GUI.
- Cloud rendering, hosted storage, or a persistent media database.
- Direct DJI camera control or automatic media download.
- A custom vision model or hard dependency on one ASR provider.
- Automatic music licensing or publishing to social platforms.
- Vertical or square masters as release targets.
- A general-purpose editing GUI, draggable timeline, live FFmpeg control console, cloud review service, or portable HTML review pack.
- Browser automation for Suno or another remote music-generation/download provider. v1 uses only user-provided or explicitly selected local music and does not claim music rights.
- Release-grade claims for experimental running, technical-mountaineering, trail-running, or open-water-swimming profiles.
- Fabricated route points, heart rate, speed, scenery, landmarks, or athlete performance.

## 6. Supported profiles

| Profile | v1 maturity | v1 behavior | Required evidence |
|---|---|---|---|
| Cycling | Release-grade | Full journey grammar, POV/side/rear/front/stop roles, speed ramps, route and performance overlays | Golden final-MP4 evaluation |
| Hiking / non-technical mountain journey | Release-grade | Slower observational pacing, terrain/place emphasis, elevation/pause semantics, safety-biased non-technical mountain defaults | Golden final-MP4 evaluation |
| Pool swimming | Release-grade | Lap repetition control, underwater color policy, turn continuity, no GPS assumptions | Golden final-MP4 evaluation |
| Running | Experimental | Cadence-aware rhythm, gait continuity, breathing/audio protection, conservative stabilization | Schema and contract tests only |
| Technical mountaineering extension | Experimental | Altitude/terrain context and stricter risk rules layered on the non-technical mountain-journey profile | Schema and contract tests only |
| Trail running | Experimental | Running rhythm plus terrain-risk rules and elevation context | Schema and contract tests only |
| Open-water swimming | Experimental | Horizon and stroke continuity, GPS route optional, water color policy | Schema and contract tests only |

All sport profiles share the same schemas and commands. A profile changes thresholds and editorial weights, not pipeline topology. Experimental means installable and contract-valid, not release-validated or advertised as production-ready.

## 7. Required project artifacts

Every project workspace contains:

```text
project/
  PROJECT.json
  PROJECT_STATE.json
  EDIT_BRIEF.json
  media/originals/
  media/proxies/
  analysis/MEDIA_INDEX.json
  analysis/PROBE.json
  analysis/SEGMENTS.json
  analysis/SHOTS.jsonl
  analysis/ACTIVITY.json
  analysis/TRANSCRIPT.json
  analysis/SYNC_MAP.json
  direction/BRIEF_DESIGN_PROPOSAL.md
  direction/DIRECTION_PROPOSALS.json
  direction/DIRECTOR_APPROVAL.json
  direction/DESIGN_SYSTEM.json
  direction/LOOK_PROFILE.json
  direction/DATA_OVERLAYS.json
  direction/BEAT_MAP.json
  direction/SCENE_SCHEMA.json
  direction/ASSET_MANIFEST.json
  direction/MOTION_MAP.json
  edit/TIMELINE.json
  assets/images/source/
  assets/images/components/
  assets/images/proofs/
  renders/rough-cut.mp4
  renders/final.mp4
  review/director-workbench.html
  review/workbench-assets/
  review/REVIEW_REPORT.md
  review/metrics.json
  cache/
```

`ACTIVITY.json` and `TRANSCRIPT.json` may report `status: "unavailable"`; missing inputs are not represented as zero values.

### 7.1 Input contract

The minimum invocation supplies a readable local directory plus a concrete editing request. The Agent normalizes it into `EDIT_BRIEF.json` with:

- sport and story emphasis;
- target duration and pacing preference;
- background music mode: `none`, `provided`, or `select-local`, plus mix priority;
- copy mode: `none`, `titles`, `captions`, `voiceover-script`, or a declared combination;
- language, tone, title/subtitle requirements, and prohibited claims;
- output container, video/audio codecs, raster, frame rate policy, and optional maximum file size;
- required inclusions/exclusions and privacy preferences.

If a missing choice materially changes the edit, the Agent asks before rendering. Otherwise it applies the documented defaults and records them in the brief.

## 8. Pipeline contracts

### 8.1 Ingest and provenance

- The input directory is read-only. Its supported files are classified into video, image, audio/music, activity data, and sidecars; unsupported files are reported and skipped.
- Originals are immutable.
- Still images receive the same hash/provenance treatment as video and are decoded locally before visual inspection.
- Every original receives SHA-256, byte size, duration, stream metadata, time base, frame rate, color metadata, audio layout, and capture timestamp.
- Proxy records point back to the original hash and declare scaling, codec, and time mapping.
- A final timeline may reference original media only. A validation error is raised if a final render resolves a proxy path.

### 8.2 Shot understanding

Each shot record includes:

- stable `shotId`, source URI, source hash, and in/out time;
- sport-independent camera role: `pov`, `front`, `rear`, `side`, `overhead`, `low`, `ground`, `detail`, `portrait`, `wide`, or `unknown`;
- action role: `prepare`, `depart`, `move`, `effort`, `observe`, `hydrate`, `pause`, `push`, `arrive`, `return`, or `other`;
- environment tags, subject tags, motion intensity, blur/shake, exposure, horizon, occlusion, duplicate group, setup-tail likelihood, speech/music/ambient spans, and confidence;
- continuity vectors: screen direction, motion direction, subject entry/exit, location, and time relation;
- `evidenceFrames` referencing extracted images.

Low-confidence semantic records remain reviewable; validators must never invent certainty.

### 8.3 Activity data

- Accepted inputs: FIT, KML, or normalized activity JSON. No input produces a valid `ACTIVITY.json` with `status: "unavailable"`.
- Keep `metrics`, `availability`, `coverage`, `reasons`, and `sources` distinct. A missing value is `null`; numeric `0` is valid only when the source recorded zero.
- KML without timestamps cannot produce duration, speed, pace, pause, or time-synchronized overlays. Spatial geometry never implies missing time.
- Overall speed is total valid distance divided by total valid moving time. Heart rate, power, cadence/step rate, and temperature are weighted by valid sample count. Grade distribution is weighted by analyzed distance. Calories are summed only from device-provided estimates and carry coverage.
- Deduplicate repeated activities before aggregation. Compare, rank, and label activities only inside compatible sport profiles; cycling speed and hiking pace never share a ranking.
- GPS and media time sync may use absolute timestamp, manual anchor, or declared offset. `SYNC_MAP.json` records method, anchors, confidence, residual error, and valid interval.
- Route visualization applies configurable start/end privacy trimming before any generated route asset. Public exports reference only the trimmed derivative.
- Coverage controls display authority: below 10% suppress; 10–39.9% local observation only; 40–79.9% visible with a caveat; at least 80% may support a primary whole-activity metric when the sport profile allows it.
- `DATA_OVERLAYS.json` is a derived allow-list, not a second calculator. It references normalized metric IDs, display authority, sync authority, wording, semantic color tokens, and timeline windows.
- Agent copy separates recorded fact, evidence-backed interpretation, subjective narration, limitation, and action. It must not invent FTP, VO₂max, training load, recovery status, diagnosis, treatment, or other medical/training conclusions.
- Guizang-derived numeric fields remain owned by deterministic analysis. Agent-written interpretation and UI enrichment cannot overwrite them.

### 8.4 Director review and lock

After `ANALYZE`, the Agent may compile a low-cost proxy rough cut and two or three complete direction proposals. The single proposal compiler consumes only integrity-verified `EDIT_BRIEF`, recorded-media evidence (`MEDIA_INDEX`, `PROBE`, `SEGMENTS`, and `SHOTS`), the current rough-cut timeline and closed proxy MP4, optional allowed data overlays, and the local-music plan; it validates and atomically writes the integrity-stamped `DIRECTION_PROPOSALS.json` before any workbench build. No workbench code may synthesize or alter proposals. `DIRECTION_PROPOSALS.status: "unavailable"` requires `candidates: []`; `status: "proposed"` requires exactly two or three complete whole-direction candidates. Each candidate records representative source-evidence IDs, code-rendered token candidate, typography hierarchy, layout proofs, motion storyboard, Look candidate, visual-world/asset/component/Hero plan, music plan, risk notes, and preview artifact hashes. Proposal previews must not reference production Image Gen outputs.

`build_director_workbench.mjs` compiles the current project artifacts into a stable local workbench without becoming an authority over them. A project reaches `DIRECTOR_REVIEW_READY` only when the workbench hash matches all required current revisions and every approval field is present.

The approval endpoint accepts one selected proposal ID and the exact displayed artifact hashes. It atomically writes `DIRECTOR_APPROVAL.json`; stale, partial, duplicate, cross-proposal, or path-escaping approval requests fail without changing project state. `lock_direction.mjs` independently revalidates the approval, writes the approved `DESIGN_SYSTEM.json` and `LOOK_PROFILE.json` through temporary files under a transaction journal, fsyncs and renames them, verifies the matching pair, then commits both hashes as one `DIRECTOR_LOCK` gate record. Consumers reject an uncommitted or mismatched pair. Crash recovery restores the prior drafts or completes the matching frozen pair before any project command proceeds.

### 8.5 Timeline and continuity

Timeline items declare source-original references, source in/out, destination in/out, playback rate curve, transform stack, audio policy, transition, asset references, and reasons.

Hard failures include:

- overlapping destination intervals without declared compositing;
- source bounds outside probed duration;
- speed outside the active sport profile;
- unresolved proxy in a final render;
- cuts through protected speech spans without an approved audio bridge;
- duplicate-group recurrence inside the profile's minimum separation;
- transition midpoint without an owned visual layer;
- generated image labeled as documentary evidence.

### 8.6 Visual assets and Image Gen

The retained HyperFrames workflow is mandatory:

1. Count meanings before images.
2. Define visual worlds and foreground inventory.
3. After `DIRECTOR_LOCK`, generate one full-resolution Style Anchor and validate palette, material, lighting direction, grain, edge treatment, composition, provenance, and declared display size.
4. Generate one representative component set and prove it combines with the Style Anchor and real footage without style, alpha, ownership, or readability failure.
5. Generate remaining source sheets in `assets/images/source/` only after both anchor gates pass.
6. Generate hero assets separately when resolution or silhouette requires it.
7. Crop components into `assets/images/components/` with transparency.
8. Produce dark and light proof sheets.
9. Register every asset in `ASSET_MANIFEST.json` with provenance, role, source relation, crop status, visible alpha bounds, expected display rectangle, native effective pixels, Style Anchor relation, and allowed uses.
10. Build at least two semantically different combination proofs before full choreography; changing only numbers or labels does not count as a second proof.
11. Assign every visible asset to exactly one owner in `MOTION_MAP.json`.
12. Inspect entry, hold, exit, and transition midpoint in the final MP4.

Full-screen 4K plates target native `3840×2160`. A transparent raster component must provide at least the effective pixels required by its maximum approved display rectangle after crop; a crowded sheet crop cannot be enlarged into a Hero. Routes, thin lines, and typography use SVG or final-canvas code rendering when practical. A 1080p graphics layer may not be upscaled as the 4K composition layer.

Sport-specific visual roles are:

- `journey_anchor`: route, place, chapter, or destination context;
- `activity_evidence`: truthful metric or activity-derived graphic;
- `experience_carrier`: texture, environmental motif, spatial bridge, or transition carrier.

Generated assets may stylize a map, force, weather feeling, water flow, terrain, or rhythm. They may not impersonate a missing real-world shot or display unrecorded performance data.

### 8.7 Audio

- Dialogue and meaningful voice spans are protected.
- Cut points within protected spans require an explicit J-cut, L-cut, room-tone bridge, ambience bridge, or transcript-approved boundary.
- Ambient continuity is scored across adjacent shots.
- Loudness and true peak are measured on the final master.
- Music does not erase safety-relevant, place-defining, or effort-defining natural sound unless the brief explicitly chooses that treatment.
- Background music is mixed only when requested. User-provided or locally selected tracks retain provenance; the system does not claim or acquire music rights.
- If the approved brief requires music and no valid local track exists, `DIRECTOR_REVIEW_READY` is blocked. Remote music search, Suno creation, account automation, and download are outside v1.
- Music may be trimmed, looped, faded, loudness-normalized, and ducked around speech or important natural sound with FFmpeg. Abrupt loop seams and clipped endings are hard failures.

### 8.8 Rendering and clarity

- Rough cuts may use proxies; final renders resolve originals.
- Transform calculation uses source raster dimensions and delivery raster dimensions explicitly.
- 4K profile: 3840×2160, square pixels, 16:9.
- 1080p profile: 1920×1080, square pixels, 16:9.
- Default delivery is MP4 with codecs declared by the delivery profile. The brief may select another supported container/codec pair.
- When `maxFileSizeMiB` is present, the renderer calculates an explicit bitrate budget and uses a two-pass size-constrained encode. It must warn instead of silently violating the clarity floor when duration, raster, codec, and size are incompatible.
- Source frame rate is preserved when practical; any conversion is explicit in `PROJECT.json`.
- The approved timeline is partitioned into journey-chapter intermediates at semantic beat boundaries. Each chapter is independently cached by all relevant source/contract digests plus treatment parameters; changing one chapter invalidates that chapter and final assembly rather than forcing unrelated 4K chapters to rerender.
- Chapter intermediates use an intermediate-safe profile. Delivery still performs exactly one final lossy encode.
- Delivery uses one final lossy encode; tests use lossless/intermediate-safe fixtures.
- Final QC measures duration, dimensions, frame rate, codec, pixel format, A/V sync, black frames, freeze spans, clipping, loudness, and suspicious detail loss.

### 8.9 Honest degradation and completion semantics

- Corrupt media is isolated and reported by basename. Valid siblings continue when the brief can still be satisfied.
- Unsupported files remain in the inventory with an explicit status; they are never silently ignored or rewritten.
- A missing optional capability removes only the dependent enhancement. Missing mandatory FFmpeg/ffprobe or an incompatible Node runtime stops before mutation.
- Analysis complete, rough cut complete, final render written, and delivery accepted are different states with different evidence.
- `DIRECTOR_LOCK` is the only normal-path user approval. Later stages update the workbench but do not request routine approval.
- A bounded repair writes a new downstream revision, records the failing gate and repair class, invalidates dependent evidence, and reruns the full affected closure. It may not mutate frozen design or Look contracts.
- Browser previews, proxy renders, process exit code `0`, and a plausible filename cannot independently satisfy delivery.
- `DELIVERED` means the verified final artifact and review pack were produced and handed off. Optional `USER_ACCEPTED` is a later user signal and is not retroactively inferred from Agent inspection.
- Portable JSON/Markdown artifacts use project-relative paths or basenames and never expose the user's absolute input path.
- Any temporary preview server binds to `127.0.0.1`/localhost only, uses a random session identifier and a `0700` session directory, expires stale sessions, and supports exact-session cleanup.

## 9. Quality model and release gates

The v1 release score is 100 points:

| Category | Points | Hard gate examples |
|---|---:|---|
| Structure and installability | 10 | Missing Skill entry point, broken relative link, stale director-workbench revision at approval |
| Media provenance and clarity | 15 | Proxy in final, wrong raster, A/V drift > 80 ms, requested size ceiling exceeded |
| Shot evidence and edit continuity | 20 | Out-of-bounds source, unresolved severe shake, setup-tail in final |
| Audio continuity | 10 | Unbridged protected-speech cut, music loop seam, clipping above policy |
| Activity truth and privacy | 10 | Missing treated as zero, invented metric, untrimmed private endpoints |
| Visual assets and provenance | 15 | Pre-lock production generation, missing Style Anchor, source sheet used directly, missing alpha/effective-resolution proof, generated evidence claim |
| Motion and transitions | 10 | Unowned layer, nondeterministic timeline, missing required combination proof, empty transition midpoint |
| Final review and delivery | 10 | Missing final MP4 evidence, black/freeze failure |

Release requires:

- all hard gates pass;
- total score at least 90/100 for the release-grade cycling, hiking/non-technical-mountain, and pool-swimming end-to-end evals;
- no category below 80% of its available points;
- all unit, contract, synthetic-media, structure, trigger, and release tests pass;
- the package version, changelog, release notes, and Git tag all agree on `1.0.0` / `v1.0.0`.

## 10. Test strategy

1. **Unit tests:** JSON schema helpers, lifecycle transitions, approval-hash binding, atomic design/Look locking, invalidation closure, repair budgets, time math, profile maturity, missing-value propagation, weighted activity formulas, coverage authority, duplicate spacing, speech-boundary validation, asset ownership, privacy trimming, and cache keys.
2. **Contract tests:** each CLI command receives a minimal valid fixture and representative invalid fixtures; stdout JSON, exit codes, project-relative paths, stale/duplicate approval rejection, cancellation, cleanup, and completion evidence are asserted.
3. **Synthetic-media tests:** FFmpeg generates a mixed input directory with tiny 16:9 video, still images, music/audio, activity files, deterministic colors, motion, tones, silence, speech-marker intervals, duplicates, shake, black frames, and freeze spans.
4. **Golden pipeline evals:** cycling, hiking/non-technical-mountain, and pool-swimming manifests run from project creation through director approval, Style Anchor, final inspection, and unattended `DELIVERED`.
5. **Agent evals:** trigger and non-trigger prompts verify that the Skill activates for sports-Vlog direction while deferring generic FFmpeg questions and promotional-motion requests.
6. **Visual review:** the product-level workbench golden fixture and all three final-video golden fixtures receive human review. Per-project Agent inspection uses contact sheets and decoded frame evidence at entry/hold/exit/midpoint but does not claim `USER_ACCEPTED`.

### 10.1 Skill authoring and discovery contract

The Skill follows Codex Skill Creator, Superpowers Writing Skills, and the referenced Claude Skill Creator practices:

- Run realistic no-Skill baselines before writing `SKILL.md`, then compare paired with-Skill runs and refactor only from observed failures.
- Keep `SKILL.md` under 500 lines and use three-stage progressive disclosure: discriminating metadata, concise shared instructions, then conditionally loaded references or executed scripts.
- The description starts with `Use when`, is third-person, includes concrete sports-Vlog triggers and hard near misses, and does not summarize the full internal workflow.
- Put repeatable, mechanical, or fragile transformations in tested scripts. Keep context-dependent editorial judgment with the Agent.
- Link every reference from `SKILL.md` with an explicit condition for reading it; keep references one level deep and avoid duplicated guidance.
- Provide `agents/openai.yaml` with consistent UI metadata and implicit invocation enabled.
- Maintain at least six realistic output evals and 20 trigger/near-miss queries. Evaluate artifacts quantitatively where facts are measurable and visually where design taste is irreducible.
- Package only after structure validation, paired evals, human review, and release gates succeed.

## 11. Security and privacy

- No input media, GPS, biometrics, or generated review artifacts leave the local environment unless the user explicitly invokes a remote generation capability.
- Image Gen prompts include only the minimum visual context needed and exclude raw GPS coordinates or private identity data by default.
- Original GPS and biometrics remain local analysis inputs. Portable JSON, Markdown, logs, prompts, watermarks, and review packs contain only basenames, project-relative IDs, public place names when requested, and privacy-trimmed route derivatives.
- Public route export is structurally unable to reference raw coordinates: the export contract accepts only a validated trimmed-route ID.
- Shell commands use argument arrays, not interpolated command strings.
- Paths are resolved within the declared project root; source inputs are read-only and output paths cannot escape the project workspace.
- Temporary sessions use random IDs, owner-only permissions, localhost binding when served, explicit expiry, and exact-session cleanup.
- The director workbench serves only project-relative review derivatives through an allow-list. Its approval endpoint accepts a CSRF/session token plus exact displayed hashes, writes only `DIRECTOR_APPROVAL.json` atomically inside the project root, and cannot invoke render commands.
- Workbench HTML must not embed original media, raw coordinates, absolute paths, or private filenames. v1 has no portable/share export.
- The release contains no real user footage, route, biometric data, secrets, private filenames, or generated asset licenses that prohibit redistribution.

## 12. v1.0.0 definition of done

The version is complete when a clean clone can install dependencies, accept a mixed local input directory and editing brief, generate deterministic test fixtures, build a project-local HyperFrames director workbench, record one hash-bound approval, atomically freeze the approved design and Look, pass the Style Anchor and representative-combination gates, run the three release-grade golden profiles unattended after `DIRECTOR_LOCK`, mix requested local music, apply requested copy, produce final MP4 files at 4K and 1080p within declared size constraints, re-probe those closed files, emit encoded-MP4 review reports and frame evidence, reach `DELIVERED` without inferring `USER_ACCEPTED`, pass the 90/100 threshold with no hard-gate failure, package the Skill, and pass a release dry run for tag `v1.0.0`.
