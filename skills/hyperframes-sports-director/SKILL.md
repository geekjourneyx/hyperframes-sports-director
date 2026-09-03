---
name: hyperframes-sports-director
description: Use when editing a local directory of sports videos, action-camera footage, still images, local music, or optional FIT/KML data into an immersive sports Vlog with shot evidence, one director approval, truthful graphics, mandatory FFmpeg processing, HyperFrames motion design, unattended QA, and 16:9 4K/1080p delivery.
---

# HyperFrames Sports Director

## Purpose

Turn a local mixed-media sports directory into an immersive, evidence-backed 16:9 Vlog. Use the bundled scripts for deterministic work and keep editorial or visual judgment with the Agent. HyperFrames owns visual direction and motion composition; FFmpeg owns media analysis, assembly, encoding, and measurement.

## Use boundary

Use this Skill for participant-led sports stories assembled from a directory of videos and/or stills, optionally with recorded activity data and local music.

Do not use it for a generic FFmpeg command, a single-file transcode or retouch, sports-data-only analysis, training advice, score lookup, an advertisement, or promotional motion graphics. V1 never generates, searches for, or downloads music remotely.

## Start here

1. Read [the workflow and final-inspection gate](references/workflow.md) on every run.
2. Inspect the input directory without modifying it. Check local capabilities before creating a project.
3. Normalize the editing brief, then follow the current `PROJECT_STATE.json`; do not skip ahead or infer a completed gate from filenames.
4. Use [the Unix command pipeline](references/unix-pipeline.md) for exact command order and inputs.

### Input and brief discovery

Resolve these values from the request and local directory:

- sport and maturity profile;
- videos, stills, local music, voice/dialogue, and optional FIT/KML/normalized activity data;
- duration target, required moments, exclusions, title/caption/copy language, and experiential intent;
- 16:9 resolution (`3840x2160` or `1920x1080`), MP4 container, video/audio codecs, source-compatible frame-rate policy, and optional maximum file size;
- privacy requirements, including route trimming and footage exclusions.

Keep genuinely missing optional values `null` or `status: "unavailable"`. Ask only when a missing value would materially change the single director approval; otherwise choose the narrowest profile-compatible default and record it in `EDIT_BRIEF.json`.

## State router

Resume from the current integrity-valid state:

| State | Next responsibility |
| --- | --- |
| `INTAKE` | Run the capability check; do not start media work when mandatory FFmpeg, ffprobe, Sharp, or HyperFrames support is absent. |
| `CAPABILITY_CHECK` | Ingest the immutable input directory and establish the portable media index plus private locator registry. |
| `SCAN` | Probe sources, build analysis proxies, and normalize the optional activity-data chain. |
| `ANALYZE` | Segment mechanically, inspect review derivatives, author/validate evidence-backed shots, then build the original-backed timeline and audio continuity. |
| `ROUGH_CUT` | Render/re-probe the proxy rough cut and prepare two or three complete direction proposals. |
| `DIRECTOR_REVIEW_READY` | Present the local workbench and record exactly one hash-bound approval. |
| `DIRECTOR_LOCK` | Produce and accept one full-resolution Style Anchor, then one representative real-footage combination proof. |
| `STYLE_ANCHOR` | Accept the representative component/real-footage combination proof before batch production. |
| `ASSET_PRODUCTION` | Finish approved batches and at least two semantically different final combination proofs. |
| `MOTION_COMPOSITION` | Validate ownership, semantic tokens, layouts, paused-time motion, contrast, and color before final render. |
| `FINAL_RENDER` | Inspect the closed encoded MP4 with machine gates and create final-only review evidence. |
| `FINAL_QA` | Record Agent judgments from decoded final-MP4 evidence; accepted evidence alone reaches `DELIVERED`. |
| `DELIVERED` | Report the output and evidence. `USER_ACCEPTED` is optional later input, never an inference. |
| `BLOCKED` / `CANCELLED` | Stop honestly, preserve evidence, and report the exact cause; do not claim delivery. |

## Non-negotiable boundaries

- Never modify the input directory or commit originals, GPS, biometrics, secrets, large media, or evaluation workspaces.
- Portable artifacts use stable IDs and project-relative paths, never private filenames or absolute input paths.
- Render final video only from hash-matching originals. Proxies and review derivatives are analysis evidence, never delivery sources.
- Recorded footage and activity values are evidence. Generated visuals may interpret a journey but cannot impersonate a shot or invent a metric.
- Keep truth chains independent: `PROBE → SEGMENTS → SHOTS → TIMELINE`; `ACTIVITY → SYNC_MAP → DATA_OVERLAYS`; and `DESIGN_SYSTEM + LOOK_PROFILE → ASSET_MANIFEST → MOTION_MAP`.
- Use only semantic colors frozen in `DESIGN_SYSTEM.json`; keep asset appearance, motion ownership, and timing in their separate contracts.
- A normal run has one `DIRECTOR_LOCK` approval. A requested change to story, key shots, direction, tokens, Look, music, privacy, or delivery starts a separate project revision.

## Conditional references

- When footage or stills exist, read [ingest and shot understanding](references/ingest-and-shot-understanding.md).
- When activity data exists, read [activity data](references/activity-data.md).
- For the selected sport, read [sport profiles](references/sport-profiles.md).
- While selecting shots and building the story, read [continuity editing](references/continuity-editing.md).
- When speech, important ambience, or local music exists, read [audio continuity](references/audio-continuity.md).
- While preparing `DIRECTOR_REVIEW_READY` or recording approval, read [director workbench](references/director-workbench.md).
- When defining visual direction, read [visual standard](references/visual-standard.md) and [HyperFrames composition](references/hyperframes-composition.md).
- After lock, when generated visual assets are planned, read [Image Gen asset pipeline](references/imagegen-asset-pipeline.md) and [asset choreography and render QA](references/asset-choreography-and-render-qa.md).
- Before final render, read [clarity and export](references/clarity-and-export.md).

## Completion contract

Required output evidence includes the current project state, source/probe/shot/timeline chain, optional truthful activity chain, the one approval and frozen direction, accepted asset and motion contracts, `renders/final.mp4` plus provenance, final inspection metrics, decoded evidence, and `review/REVIEW_REPORT.md`.

Run machine gates before Agent review. Automatic repair is limited to three attempts for allowed downstream roles and may not cross an approved boundary. A closed file that re-probes successfully is still not delivered until all hard gates pass and the Agent accepts composition, density, restraint, pacing, Style Anchor consistency, and transition meaning from the encoded MP4.

Every completion or blocker handoff states the current project state, whether a final output actually exists, the used/remaining repair budget, and that `USER_ACCEPTED` remains separate from `DELIVERED`.
