# Architecture

HyperFrames Sports Director is a thin local orchestrator over small commands and versioned project artifacts. HyperFrames remains the visual-direction and motion-composition core. FFmpeg and ffprobe remain mandatory local media capabilities.

## Command boundaries

Each command owns one transformation. A command reads declared files, writes only its declared outputs, prints one machine-readable diagnostic result to standard output, and exits non-zero when its contract cannot be satisfied. Commands compose through JSON, JSONL, Markdown, images, audio, and video files rather than hidden process or database state.

`create_project.mjs` creates only the project artifact tree and normalized intake contracts. In reference mode it leaves `media/originals/` empty and never copies, renames, rewrites, or deletes input files. A non-empty destination is refused unless `--resume` validates the integrity and compatibility of its existing `PROJECT.json` and `PROJECT_STATE.json`.

`check_install.mjs --json` only inspects local capabilities. It reports Node, FFmpeg, ffprobe, required filters, Sharp, and the HyperFrames and director-workbench scaffolds. A mandatory failure exits non-zero. Missing vidstab filters produce an explicit conservative-stabilization fallback warning.

Later commands keep scan, probe, proxy, analysis, workbench compilation, approval, direction locking, asset production, motion composition, final rendering, and encoded-output inspection separate. In particular, project creation does not ingest media, capability checking does not mutate a project, and the director workbench is neither an editor nor a render controller.

## Artifact and truth boundaries

Portable artifacts use project-relative paths or basenames. The input root and its original media remain immutable and are not embedded as private absolute paths. Recorded-media, activity-data, and design truth remain independent versioned chains. `ASSET_MANIFEST.json`, `MOTION_MAP.json`, and `TIMELINE.json` remain separate authorities for asset provenance, animation ownership, and edit timing.

Every non-`INTAKE` state transition retains role-bound evidence with artifact revision, digest, timestamp, and producer command. Invalid transitions and stale evidence are rejected before a caller can begin filesystem or FFmpeg work. Production Image Gen and final rendering cannot start before `DIRECTOR_LOCK`; delivery additionally requires a closed-file probe, hard-gate results, Agent visual inspection, and evidence decoded from the encoded MP4.

## Policy separation

Pipeline topology is sport-neutral. Sport, device, and delivery profiles contribute declarative policy namespaces and immutable digests. `PROJECT.json` stores only the resolved profile IDs, selected sport maturity, and profile digests; it does not duplicate policy bodies. Editing choices are normalized separately in `EDIT_BRIEF.json`. A profile may change thresholds and editorial weights but cannot bypass lifecycle, evidence, privacy, visual-lock, or delivery gates.
