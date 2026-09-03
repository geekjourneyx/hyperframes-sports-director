# Design engineering contract

HyperFrames is the motion-composition core. Its browser scaffold is a paused,
absolute-time renderer for deterministic composition and measurement, not an
editor, a remote-asset client, or a render controller.

## Truth and ownership

The recorded-media, activity-data, and design truth chains stay independent.
The final timeline resolves immutable originals and references current frozen
asset and motion revisions. The asset manifest describes what an asset is;
the motion map describes who moves it; the timeline describes when it appears.

Every visible asset has exactly one owner. Every scene and owner has ordered,
non-empty entry, hold, and exit intervals. Every transition has one semantic
relationship and a non-empty owned midpoint. Identical project seed and input
contracts produce byte-identical normalized runtime output.

## Layout and style

Readable layers bind semantic typography plus tracked text, subject, and quiet
zone rectangles throughout the readable interval. They also bind road/water
safety regions, horizon relation, screen and motion direction, and source
evidence-frame IDs. Collision, quiet-zone loss, or a direction reversal without
a recorded reason is a hard error.

Frozen semantic tokens cover color, title and metric typography, safe zones,
spacing, strokes, radii, depth, motion duration, easing, contrast, and redundant
non-hue encodings. SDR Rec.709 is the only v1 output. Critical text targets 7:1
and never falls below 4.5:1; ordinary text meets 4.5:1 under the sampled policy;
large text and meaningful graphics meet 3:1. Rendered tokens remain within
Delta E 2000 3 after delivery transformation.

Machine facts are reported as `hard_error`. Visual density, restraint, pacing,
and cross-scene taste are always `agent_review_required`; a numeric score never
silently accepts them. The final visual judgment must use decoded MP4 evidence.
