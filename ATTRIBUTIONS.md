# Upstream Attributions

This repository is licensed under AGPL-3.0-only. It derives workflow and
contract ideas from the following AGPL-3.0 projects, frozen in
`UPSTREAM.lock.json`:

- **HyperFrames Motion Director** —
  `https://github.com/geekjourneyx/hyperframes-motion-director` at
  `0b66750322ccb50ae56ace5a8d361da2c1f65400`.
- **Guizang Sports Skill** —
  `https://github.com/op7418/guizang-sports-skill` at
  `f165bf2993c4eafd5dd91581317c8993230f84e1`.

Adapted files must retain their applicable upstream copyright and license
notices. `docs/upstream-derivation.md` records retained, adapted, and
independently implemented responsibilities.

## File-level derivation records

- `skills/hyperframes-sports-director/scripts/lib/activity.mjs` and
  `skills/hyperframes-sports-director/scripts/analyze_activity.mjs` adapt the
  Guizang Sports Skill's activity-report, deterministic metric, staged
  workflow, and local-privacy invariants. The implementation is original to
  this repository; the source headers retain the AGPL lineage and point to the
  exact pinned upstream revision.
- `skills/hyperframes-sports-director/references/activity-data.md` restates the
  adapted activity truth, availability, coverage, time-sync, and privacy SOP
  for this project's three-chain architecture.
- `skills/hyperframes-sports-director/scripts/lib/image-assets.mjs`, the three
  image-asset CLIs, and `references/{imagegen-asset-pipeline,asset-choreography-and-render-qa,visual-standard}.md`
  adapt HyperFrames Motion Director's visual-world, Style Anchor,
  component-sheet, separate-Hero, crop, alpha-proof, combination-test, and
  motion-boundary workflow at the exact revision above. The implementation is
  original to this repository and extends the workflow with sports narrative
  roles, lock-bound provenance, effective-resolution gates, and documentary
  truth constraints.
- `skills/hyperframes-sports-director/assets/hyperframes-project/`,
  `scripts/lib/{motion,layout}.mjs`, the four design-consistency validators, and
  `references/hyperframes-composition.md` adapt HyperFrames Motion Director's
  paused absolute-time timeline, layer-ownership, component choreography, and
  deterministic review-extraction concepts at the exact pinned revision. The
  implementation is original to this repository and adds sports continuity,
  activity authority, Rec.709/color-vision, local-contrast, and explicit
  hard-versus-Agent-review gates.
