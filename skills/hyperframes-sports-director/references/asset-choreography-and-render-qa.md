# Asset Choreography and Render QA

Read this reference after an asset batch is accepted and before assigning
motion, or when an asset-related render gate fails. It preserves the boundary
between `ASSET_MANIFEST.json`, `MOTION_MAP.json`, and `TIMELINE.json`.

## Combination gate before choreography

Before motion choreography, retain at least two accepted combination proofs
with different meaning-ID sets and genuinely different semantic intent. A
changed number, metric value, caption, label, colorway, or crop of the same
meaning does not create a second proof. The proofs must have distinct decoded
bytes and distinct role/meaning/component structures, plus explicit digest-bound
Agent semantic-acceptance evidence. Each proof includes current real-footage
evidence, lists current component IDs, and resolves to the accepted Style Anchor.

`TIMELINE.json` may reference registered cropped components, separately
generated Heroes, and code-rendered assets. It must never reference a component
sheet or source sheet directly. `MOTION_MAP.json` gives each visible asset
exactly one animation owner; it does not copy crop, provenance, or appearance
facts out of the manifest.

## Choreography checks

- Assign motion only after alpha, padding, effective-pixel, dark/light, and
  combination proofs pass.
- Preserve real footage as the documentary layer. Generated material may
  bridge space, effort, water, terrain, weather feeling, or rhythm, but cannot
  impersonate a missing shot or measured performance.
- Inspect entry, hold, exit, and transition midpoint. A transition midpoint has
  one owned visible layer and cannot collapse into an empty effect frame.
- Final judgment uses decoded final-MP4 evidence. Browser preview and source
  PNG appearance are supporting evidence, not delivery acceptance.

## Task 11 repair boundary

Automatic repair is role-aware and receives at most three attempts per failed
gate. Within the approved direction it may reposition an asset, select an
approved same-role fallback, adjust a declared mask or scrim, or remove an
optional decorative asset followed by full dependent validation.

Failure of `journey_anchor`, truthful `activity_evidence`, a required transition
owner, or another non-optional role records `BLOCKED`. Exhausting the third
attempt also records `BLOCKED`. A repair may not change story, key shots,
direction, semantic tokens, Look, music, privacy, or delivery contract, and may
not request a second approval. Such a change starts a separate project revision.

Revalidate the invalidation closure after every accepted repair: manifest,
motion ownership, timeline, rendered output, and review evidence remain separate
revisions. Never accept a plausible output filename or process exit code as
visual proof.
