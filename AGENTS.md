# Contributor Rules

## Scope and lineage

- Keep `UPSTREAM.lock.json` pinned to the exact upstream commit hashes. Do not
  substitute a branch, tag, or floating remote reference.
- Preserve copyright notices, license notices, and the file-level derivation
  record in `ATTRIBUTIONS.md` whenever adapting upstream material.
- Keep HyperFrames as the mandatory visual-direction and motion-composition
  core; retain the boundaries between asset manifests, motion maps, and
  timelines.
- v1 release-grade profiles are cycling, hiking/non-technical mountain
  journey, and pool swimming. Running, technical mountaineering, trail
  running, and open-water swimming remain experimental contract coverage.

## Execution handoff

- Before implementation, read the relevant tracked architecture and contract
  documentation. Do not make ignored local planning files under
  `docs/superpowers/` a handoff dependency.
- Treat remote `main`, its tests, and accepted commits as authoritative.
  Abandoned or uncommitted workspace files are not accepted implementation.
- Execute one task at a time. Each task must complete its RED, GREEN, full-suite,
  independent review, and remote checkpoint before the next task begins.
- When a tracked implementation plan exists, its current execution-status table
  decides the next task. Otherwise, derive the next task from the user's request,
  remote history, and current failing tests; never repeat accepted work.

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

- Draft design and Look templates must not claim `frozen`. Build the local
  director workbench from real review derivatives and code-rendered direction
  prototypes, record one hash-bound `DIRECTOR_APPROVAL.json`, then
  transactionally freeze exactly one project-level `DESIGN_SYSTEM.json` and
  one independent `LOOK_PROFILE.json` before production visual generation.
- The workbench is an evidence and approval view, not an editor or render
  controller. It must not expose originals, raw GPS, absolute paths, private
  filenames, remote assets, or a portable/share export.
- After `DIRECTOR_LOCK`, accept one full-resolution Style Anchor and one
  representative component/real-footage combination proof before batch asset
  generation. Require two semantically different final combination proofs.
- Scenes, titles, overlays, transitions, and generated assets may use only
  semantic color tokens declared by `DESIGN_SYSTEM.json`; scene-local arbitrary
  colors are invalid.
- v1 delivery is SDR Rec.709. Validate rendered local contrast across sampled
  motion intervals: critical text targets 7:1 and never falls below 4.5:1,
  ordinary text is at least 4.5:1, and large text or meaningful graphics are at
  least 3:1.
- After the delivery transform, each rendered semantic-token color must be
  within Delta E 2000 `<=3` of its declared token.
- Machine-verifiable design facts are hard gates. Composition, density,
  restraint, pacing, and cross-scene taste require Agent review of decoded
  final-MP4 evidence and may not be silently reduced to a numeric pass.

## Completion semantics

- Analysis, rough cut, final render, final QA, cancellation, and delivery are
  distinct `PROJECT_STATE.json` states with explicit gate evidence.
- A final output is delivered only after the closed file re-probes successfully,
  passes hard gates, and its review evidence comes from the encoded MP4.
- On cancellation, stop child processes and remove incomplete temporary output.
  Never treat a plausible filename or process exit code as delivery evidence.
- When visual inspection is unavailable, report measurable checks without
  claiming visual acceptance.
- `DELIVERED` requires machine hard gates and Agent inspection of the encoded
  MP4. Optional `USER_ACCEPTED` is a later signal and must never be inferred.
- Automatic repair is limited to three attempts per gate and may not change
  the approved story, key shots, direction, semantic tokens, Look, music,
  privacy, or delivery contract. Crossing that boundary records `BLOCKED`.
- A normal v1 run has exactly one `DIRECTOR_LOCK` approval. It must never
  request an exception or second approval: a user who wants to change an
  approved boundary starts a separate project revision and approval flow,
  outside the unattended run.

## Development discipline

- Follow red-green-refactor: add one failing test, observe the intended
  failure, implement the smallest change, rerun the focused test, then run the
  full suite.
- Run focused and full tests with every proxy environment variable unset. Test
  output must contain no warnings or diagnostic noise.
- Keep shared behavior in scripts and put orchestration guidance in the Skill
  and one-level-deep references. Do not add unrelated refactors.

## Release discipline

- `package.json`, `package-lock.json`, and the newest `CHANGELOG.md` heading must
  declare the same version. The only valid release tag is `v<version>`.
- Before release, use a clean tree with all proxy variables unset and run the
  complete sequence in `RELEASING.md`, including tests, contracts, synthetic
  media, Skill checks, golden evals, structural/release checks, deterministic
  packaging, checksum verification, and Skill Creator validation.
- Do not tag a local-only or stale commit. Push the release commit first, wait
  for every required `main` check to pass, fetch `origin/main`, and verify that
  local `HEAD` and the intended tag target both equal `origin/main`.
- Release tags are annotated and immutable. Never move, replace, force-push, or
  reuse a published version tag. If tagged contents need a code change, prepare
  a new patch version.
- Pushing the exact version tag is the explicit release authorization. The tag
  workflow must independently validate the tag/version match and current-main
  commit, rerun all repository gates, rebuild the archive, verify its checksum,
  and create a GitHub Release containing both the `.skill` and
  `.skill.sha256` assets. Skill Creator validation remains a local pre-tag gate.
- An Actions artifact alone is not a release. Completion requires a successful
  tag workflow plus a publicly readable GitHub Release whose assets and digest
  match the locally approved package.
