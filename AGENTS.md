# Contributor Rules

## Scope and lineage

- Keep `UPSTREAM.lock.json` pinned to the exact upstream commit hashes. Do not
  substitute a branch, tag, or floating remote reference.
- Preserve copyright notices, license notices, and the file-level derivation
  record in `ATTRIBUTIONS.md` whenever adapting upstream material.
- Keep HyperFrames as the mandatory visual-direction and motion-composition
  core; retain the boundaries between asset manifests, motion maps, and
  timelines.

## Execution handoff

- Before implementation, read the design specification and the
  `Execution Status and Remote Resume Point` table in the implementation plan.
  That table decides which task is next; do not repeat an accepted task.
- Treat remote `main` and accepted commits as authoritative. Abandoned or
  uncommitted workspace files are not accepted implementation.
- Execute one task at a time. Each task must complete its RED, GREEN, full-suite,
  independent review, and remote checkpoint before the next task begins.

## Evidence, privacy, and media

- Source footage and recorded activity data are evidence. Generated media may
  support interpretation but must not impersonate footage or invent metrics.
- Keep recorded-media, activity-data, and design truth chains independent.
  Agent interpretation may reference but never overwrite deterministic facts.
- Never modify a user's input directory. Do not commit user footage, GPS,
  biometrics, secrets, large generated media, or evaluation workspaces.
- Missing activity values are `null` or `status: "unavailable"`, never zero.
  Public route assets require a genuinely trimmed derivative, not a warning.
- Portable artifacts use basenames or project-relative paths and never expose
  a user's absolute input path or private filename.

## Visual production and render quality

- Before any visual asset generation, freeze exactly one project-level
  `DESIGN_SYSTEM.json` and one independent `LOOK_PROFILE.json`.
- Scenes, titles, overlays, transitions, and generated assets may use only
  semantic color tokens declared by `DESIGN_SYSTEM.json`; scene-local arbitrary
  colors are invalid.
- v1 delivery is SDR Rec.709. Validate rendered local contrast across sampled
  motion intervals: critical text targets 7:1 and never falls below 4.5:1,
  ordinary text is at least 4.5:1, and large text or meaningful graphics are at
  least 3:1.
- After the delivery transform, each rendered semantic-token color must be
  within Delta E 2000 `<=3` of its declared token.

## Completion semantics

- Analysis, rough cut, final render, final QA, cancellation, and delivery are
  distinct `PROJECT_STATE.json` states with explicit gate evidence.
- A final output is delivered only after the closed file re-probes successfully,
  passes hard gates, and its review evidence comes from the encoded MP4.
- On cancellation, stop child processes and remove incomplete temporary output.
  Never treat a plausible filename or process exit code as delivery evidence.
- When visual inspection is unavailable, report measurable checks without
  claiming visual acceptance.

## Development discipline

- Follow red-green-refactor: add one failing test, observe the intended
  failure, implement the smallest change, rerun the focused test, then run the
  full suite.
- Run focused and full tests with every proxy environment variable unset. Test
  output must contain no warnings or diagnostic noise.
- Keep shared behavior in scripts and put orchestration guidance in the Skill
  and one-level-deep references. Do not add unrelated refactors.
