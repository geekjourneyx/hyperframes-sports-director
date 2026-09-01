# Contributor Rules

## Scope and lineage

- Keep `UPSTREAM.lock.json` pinned to the exact upstream commit hashes. Do not
  substitute a branch, tag, or floating remote reference.
- Preserve copyright notices, license notices, and the file-level derivation
  record in `ATTRIBUTIONS.md` whenever adapting upstream material.
- Keep HyperFrames as the mandatory visual-direction and motion-composition
  core; retain the boundaries between asset manifests, motion maps, and
  timelines.

## Evidence, privacy, and media

- Source footage and recorded activity data are evidence. Generated media may
  support interpretation but must not impersonate footage or invent metrics.
- Never modify a user's input directory. Do not commit user footage, GPS,
  biometrics, secrets, large generated media, or evaluation workspaces.
- Missing activity values are `null` or `status: "unavailable"`, never zero.
  Public route assets require a genuinely trimmed derivative, not a warning.

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

## Development discipline

- Follow red-green-refactor: add one failing test, observe the intended
  failure, implement the smallest change, rerun the focused test, then run the
  full suite.
- Run focused and full tests with every proxy environment variable unset. Test
  output must contain no warnings or diagnostic noise.
- Keep shared behavior in scripts and put orchestration guidance in the Skill
  and one-level-deep references. Do not add unrelated refactors.
