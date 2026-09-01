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
