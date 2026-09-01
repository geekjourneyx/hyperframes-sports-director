# HyperFrames Sports Director v1.0.0 Design Specification

**Status:** Approved for implementation planning  
**Date:** 2026-08-31  
**Project:** `hyperframes-sports-director`  
**Skill:** `hyperframes-sports-director`  
**Upstream lineage:** `geekjourneyx/hyperframes-motion-director` and `op7418/guizang-sports-skill`

## 1. Product definition

HyperFrames Sports Director is a standard sports-Vlog editing workflow Skill plus a set of small local media tools. It accepts a user-provided local media directory and an editing brief, then turns mixed short videos, long action-camera recordings, still images, optional music, and optional activity data into an immersive sports Vlog. It is derived from HyperFrames Motion Director rather than rebuilt from zero.

The system keeps real footage as the narrative truth. HyperFrames motion design, Image Gen assets, activity-data graphics, titles, transitions, sound design, and color treatment exist to clarify rhythm and deepen immersion. They must not turn the result into a promotional film or make generated material appear to be documentary evidence.

The user brief declares sport, story emphasis, background-music choice, copy requirements, output container/codecs, resolution, duration, and optional file-size ceiling. Defaults are a roughly three-minute, 16:9 landscape MP4 at either 3840×2160 or 1920×1080. The primary capture profile is DJI Osmo Action 5 Pro. The architecture is sport-neutral; cycling is the golden-path profile, with running, hiking, mountaineering, trail running, pool swimming, and open-water swimming supported through policy profiles.

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

Each project creates and freezes two independent contracts before visual production:

- `DESIGN_SYSTEM.json`: semantic colors, typography, spacing, safe zones, strokes, radii, depth, data colors, and motion tokens.
- `LOOK_PROFILE.json`: input color interpretation, working/output color space, white balance, exposure, contrast, saturation, highlight protection, shot-matching policy, and any approved LUT/source transform.

The Agent may propose up to three project palettes after inspecting representative footage. Once one palette is selected, scenes, titles, data overlays, transitions, and generated assets reference semantic tokens; scene-local arbitrary colors are invalid. A palette change increments the design-system revision and reruns asset, contrast, snapshot, and final-MP4 validation.

The default v1 delivery color space is SDR Rec.709. HDR delivery is outside v1 unless a later profile explicitly adds end-to-end input, working-space, render, metadata, and display validation.

### 4.2 Contrast and color consistency gates

- Key titles and critical metrics target `7:1` local contrast and must never fall below `4.5:1`.
- Ordinary readable text must remain at or above `4.5:1`.
- Large chapter titles and meaningful non-text graphics must remain at or above `3:1`.
- Contrast is measured inside the rendered glyph/graphic bounds against the local moving background, not against whole-frame average luminance.
- Critical text passes every sampled frame. Ordinary text passes at least 95% of sampled frames with no continuous failure longer than 0.25 seconds.
- If footage cannot support the threshold, apply local shadow/stroke, scrim, mask/gradient, blur/desaturation, position change, then token-approved color change—in that order.
- Final rendered semantic-token colors must remain within Delta E 2000 `<=3` of their declared values after the delivery color transform.

### 4.3 Activity-data display authority

- No activity file: write `ACTIVITY.json` with `status: "unavailable"`; do not block editing or create empty data graphics.
- No reliable time mapping: route and metrics may appear only as whole-activity or chapter-summary visuals, never as time-synchronized overlays.
- Coverage below 10%: suppress the metric and report insufficient coverage.
- Coverage from 10% through 39.9%: permit only a labeled local observation.
- Coverage from 40% through 79.9%: permit a visible metric with a coverage caveat; do not present it as whole-activity truth.
- Coverage at least 80%: permit a primary whole-activity metric when the sport profile also allows it.
- Mixed sports are aggregated and ranked only inside comparable sport profiles.
- Public route assets use an actually trimmed derivative; a warning alone does not satisfy privacy.

## 5. v1.0.0 scope

### 5.1 Included

- A new standalone AGPL-3.0 repository and installable Agent Skill.
- Input-directory intake for mixed video, image, audio, activity-data, and sidecar files without modifying the user's directory.
- A versioned editing brief covering story intent, background music, copy, captions, duration, container, codec, raster, frame rate, and maximum file size.
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
- Fabricated route points, heart rate, speed, scenery, landmarks, or athlete performance.

## 6. Supported profiles

| Profile | v1 behavior | Golden evaluation |
|---|---|---|
| Cycling | Full journey grammar, POV/side/rear/front/stop roles, speed ramps, route and performance overlays | Yes |
| Running | Cadence-aware rhythm, gait continuity, breathing/audio protection, conservative stabilization | Contract tests |
| Hiking | Slower observational pacing, terrain/place emphasis, elevation and pause semantics | Yes |
| Mountaineering | Safety-biased cuts, altitude/terrain context, restrained speed changes | Contract tests |
| Trail running | Running rhythm plus terrain-risk rules and elevation context | Contract tests |
| Pool swimming | Lap repetition control, underwater color policy, turn continuity, no GPS assumptions | Yes |
| Open-water swimming | Horizon and stroke continuity, GPS route optional, water color policy | Contract tests |

All sport profiles share the same schemas and commands. A profile changes thresholds and editorial weights, not pipeline topology.

## 7. Required project artifacts

Every project workspace contains:

```text
project/
  PROJECT.json
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
  direction/DESIGN_SYSTEM.json
  direction/LOOK_PROFILE.json
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

- Accepted inputs: FIT, KML, or normalized activity JSON.
- Normalized metrics use `null` for unavailable values.
- Aggregations are duration- or distance-weighted where appropriate.
- GPS and media time sync can use absolute timestamp, manual anchor, or declared offset.
- Route visualization applies configurable start/end privacy trimming before any generated route asset.
- Activity data can drive labels, map paths, chapter anchors, and subtle motion parameters, but not fabricate missing values.
- Guizang-derived numeric fields remain owned by deterministic analysis. Agent-written interpretation cannot overwrite them.

### 8.4 Timeline and continuity

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

### 8.5 Visual assets and Image Gen

The retained HyperFrames workflow is mandatory:

1. Count meanings before images.
2. Define visual worlds and foreground inventory.
3. Generate source sheets in `assets/images/source/`.
4. Generate hero assets separately when resolution or silhouette requires it.
5. Crop components into `assets/images/components/` with transparency.
6. Produce dark and light proof sheets.
7. Register every asset in `ASSET_MANIFEST.json` with provenance, role, source relation, crop status, alpha bounds, and allowed uses.
8. Build combination tests before full choreography.
9. Assign every visible asset to an owner in `MOTION_MAP.json`.
10. Inspect entry, hold, exit, and transition midpoint in the final MP4.

Sport-specific visual roles are:

- `journey_anchor`: route, place, chapter, or destination context;
- `activity_evidence`: truthful metric or activity-derived graphic;
- `experience_carrier`: texture, environmental motif, spatial bridge, or transition carrier.

Generated assets may stylize a map, force, weather feeling, water flow, terrain, or rhythm. They may not impersonate a missing real-world shot or display unrecorded performance data.

### 8.6 Audio

- Dialogue and meaningful voice spans are protected.
- Cut points within protected spans require an explicit J-cut, L-cut, room-tone bridge, ambience bridge, or transcript-approved boundary.
- Ambient continuity is scored across adjacent shots.
- Loudness and true peak are measured on the final master.
- Music does not erase safety-relevant, place-defining, or effort-defining natural sound unless the brief explicitly chooses that treatment.
- Background music is mixed only when requested. User-provided or locally selected tracks retain provenance; the system does not claim or acquire music rights.
- Music may be trimmed, looped, faded, loudness-normalized, and ducked around speech or important natural sound with FFmpeg. Abrupt loop seams and clipped endings are hard failures.

### 8.7 Rendering and clarity

- Rough cuts may use proxies; final renders resolve originals.
- Transform calculation uses source raster dimensions and delivery raster dimensions explicitly.
- 4K profile: 3840×2160, square pixels, 16:9.
- 1080p profile: 1920×1080, square pixels, 16:9.
- Default delivery is MP4 with codecs declared by the delivery profile. The brief may select another supported container/codec pair.
- When `maxFileSizeMiB` is present, the renderer calculates an explicit bitrate budget and uses a two-pass size-constrained encode. It must warn instead of silently violating the clarity floor when duration, raster, codec, and size are incompatible.
- Source frame rate is preserved when practical; any conversion is explicit in `PROJECT.json`.
- Cache chunks are keyed by source hash plus treatment parameters.
- Delivery uses one final lossy encode; tests use lossless/intermediate-safe fixtures.
- Final QC measures duration, dimensions, frame rate, codec, pixel format, A/V sync, black frames, freeze spans, clipping, loudness, and suspicious detail loss.

## 9. Quality model and release gates

The v1 release score is 100 points:

| Category | Points | Hard gate examples |
|---|---:|---|
| Structure and installability | 10 | Missing Skill entry point, broken relative link |
| Media provenance and clarity | 15 | Proxy in final, wrong raster, A/V drift > 80 ms, requested size ceiling exceeded |
| Shot evidence and edit continuity | 20 | Out-of-bounds source, unresolved severe shake, setup-tail in final |
| Audio continuity | 10 | Unbridged protected-speech cut, music loop seam, clipping above policy |
| Activity truth and privacy | 10 | Missing treated as zero, invented metric, untrimmed private endpoints |
| Visual assets and provenance | 15 | Source sheet used directly, missing alpha proof, generated evidence claim |
| Motion and transitions | 10 | Unowned layer, nondeterministic timeline, empty transition midpoint |
| Final review and delivery | 10 | Missing final MP4 evidence, black/freeze failure |

Release requires:

- all hard gates pass;
- total score at least 90/100 for cycling, hiking, and pool-swimming end-to-end evals;
- no category below 80% of its available points;
- all unit, contract, synthetic-media, structure, trigger, and release tests pass;
- the package version, changelog, release notes, and Git tag all agree on `1.0.0` / `v1.0.0`.

## 10. Test strategy

1. **Unit tests:** JSON schema helpers, time math, profile resolution, duplicate spacing, speech-boundary validation, asset ownership, privacy trimming, cache keys.
2. **Contract tests:** each CLI command receives a minimal valid fixture and representative invalid fixtures; stdout JSON and exit codes are asserted.
3. **Synthetic-media tests:** FFmpeg generates a mixed input directory with tiny 16:9 video, still images, music/audio, activity files, deterministic colors, motion, tones, silence, speech-marker intervals, duplicates, shake, black frames, and freeze spans.
4. **Golden pipeline evals:** cycling, hiking, and pool-swimming manifests run from project creation through final inspection.
5. **Agent evals:** trigger and non-trigger prompts verify that the Skill activates for sports-Vlog direction while deferring generic FFmpeg questions and promotional-motion requests.
6. **Visual review:** contact sheets and frame evidence at entry/hold/exit/midpoint are required artifacts; automated scoring does not replace human acceptance of composition and taste.

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
- Shell commands use argument arrays, not interpolated command strings.
- Paths are resolved within the declared project root.
- The release contains no real user footage, route, biometric data, secrets, or generated asset licenses that prohibit redistribution.

## 12. v1.0.0 definition of done

The version is complete when a clean clone can install dependencies, accept a mixed local input directory and editing brief, generate deterministic test fixtures, run the three golden profiles, mix requested music, apply requested copy, produce final MP4 files at 4K and 1080p within declared size constraints, emit review reports and frame evidence, pass the 90/100 threshold with no hard-gate failure, package the Skill, and pass a release dry run for tag `v1.0.0`.
