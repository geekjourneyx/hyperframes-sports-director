# HyperFrames composition

Read this reference after `ASSET_PRODUCTION` when authoring `SCENE_SCHEMA.json`,
`MOTION_MAP.json`, and the final `TIMELINE.json`.

## Authority boundaries

- `ASSET_MANIFEST.json` owns asset identity, provenance, accepted proofs, crop,
  alpha, and effective resolution. Composition never rewrites it.
- `MOTION_MAP.json` owns exactly one owner for each visible timeline asset and
  each code-rendered layer. Owners declare absolute entry/hold/exit intervals,
  semantic primitives, token references, static review fallbacks, and proof
  passes.
- `SCENE_SCHEMA.json` owns scene layout evidence: readable intervals, tracked
  text/subject/quiet-zone rectangles, road/water safety regions, horizon and
  direction relations, typography roles, and evidence-frame IDs.
- `TIMELINE.json` owns original-backed edit time and references asset and motion
  IDs without absorbing either contract.

The frozen `DESIGN_SYSTEM.json` and independent `LOOK_PROFILE.json` remain
immutable. Every visible style value resolves through their approved semantic
tokens. No scene-local color, font, spacing, stroke, radius, or easing value is
an acceptable substitute.

## Paused runtime

Compile with `compilePausedTimelines(...)`, install the result with
`installSceneRuntime(window, compiled)`, and drive it only by supplied absolute
time. The runtime exposes:

- `window.__timelines`: registered, paused scene timelines;
- `window.__renderAt(time, "composite")`: visible composition at that time;
- `window.__renderAt(time, "background-only")`: matching local background;
- `window.__renderAt(time, "layer-matte:<layerId>")`: one layer coverage matte;
- `window.__renderAt(time, "token-matte:<semanticToken>")`: token coverage;
- `window.__layerEvidence`: owner, proof-pass, typography, and evidence bindings.

The runtime has no autonomous clock. Do not add wall-clock reads, unseeded
randomness, timers, or animation-frame render truth. GSAP, SVG, CSS, Lottie,
and Three.js are selected only when their semantic role merits them; every
role keeps a static SVG/CSS review fallback.

## Gates

Transitions use one of: spatial continuation, motion match, shape/mask carry,
environmental texture bridge, or data-to-footage bridge. A decorative-only
transition or empty midpoint is a hard failure. Local contrast, rendered token
color, ownership, timing, bounds, input-color interpretation, Rec.709 output,
and effective pixels are hard evidence. Density, restraint, pacing, and
cross-scene taste remain explicit Agent review of decoded final-MP4 evidence.

Run `validate_design_consistency.mjs --project <project>` while authoring. Add
`--input <immutable-input-root>` only when the final original-backed timeline
and every frozen artifact are integrity-stamped; that form validates the final
timeline, records the `MOTION_COMPOSITION` gate, and rebuilds the local
workbench. It does not render media or expose an editor.
