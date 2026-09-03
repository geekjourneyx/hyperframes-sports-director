# Final inspection and bounded repair

Run `inspect_output.mjs` only after an integrity-valid `FINAL_RENDER`. Rehash
and re-probe the closed `renders/final.mp4`; bind every measurement and decoded
evidence frame to its render provenance digest. A successful FFmpeg exit or a
plausible filename is not evidence.

Run machine gates before Agent inspection. Detect black and frozen spans,
clipping, loudness, A/V drift, controlled-segment detail loss, and undeclared
color metadata. Sample every readable interval at 10 Hz plus scene entry,
hold, exit, transition midpoint, motion extrema, and background-luminance
extrema. Measure contrast from the matching final-pixel background pass and
coverage matte. Exclude coverage below 0.9 when measuring token color, compare
the expected alpha composite after the delivery transform, and require Delta E
2000 at most 3.

Close the paused HyperFrames capture manifest with
`render_final_proof_passes.mjs --project <project> --capture <manifest>` and
pass its `PROOF.json` to the inspector with `--proof`. The closed bundle binds
the encoded MP4 plus the current design, Look, asset, overlay, scene, motion,
and timeline digests and hashes every background-only, layer-matte, and
token-matte frame. The inspector decodes the matching composite frames from
the final MP4 itself, rereads all pass pixels, derives motion/luminance extrema
and layout findings, and recomputes contrast, token color, and cross-scene
consistency. It never accepts submitted RGBA values or submitted gate results.
Missing, stale, symlinked, incomplete, or wrong-raster proof data fails closed.
The inspector also compares the final encode with the hash-verified chapter
intermediates using FFmpeg SSIM.

If hard gates pass, advance to `FINAL_QA`. The Agent then inspects only decoded
final-MP4 evidence for composition, density, restraint, pacing, Style Anchor
consistency, and transition meaning. Record cited project-relative evidence
paths and an explicit accepted/rejected status. Only accepted Agent evidence
advances to `DELIVERED`; never infer `USER_ACCEPTED`.

Use two invocations: first run with the proof to create the final-only frames,
contact sheet, metrics, and `FINAL_QA`; then record all six Agent judgments in a
local JSON file and rerun with `--agent-inspection`. Every non-unavailable
judgment must cite a generated frame or the final contact sheet. The review pack
also records review-safe source/final clarity pairs, alpha proofs, and at least
the already accepted semantically distinct combination proofs. Reports live at
`review/REVIEW_REPORT.md`; no portable pack or remote asset is created.

Automatic repair has three attempts per failing gate. Position, scrim, timing,
gain, same-role fallback, trim-seam, and removal of an optional decorative
asset may invalidate only their declared downstream closure. A fourth attempt
returns `repair_budget_exhausted`. Story, key shots, direction, semantic
tokens, Look, music, privacy, or delivery changes cross the approval boundary
and record `BLOCKED`; they never request a second approval in the same run.

For a repairable first failure, pass one local repair request with `--repair`.
The inspector routes it through the project repair transaction, records the
attempt in `cache/REPAIR_HISTORY.json`, invalidates the exact downstream role
closure, returns the roles that must rerun, and leaves delivery closed. Rerun
that closure and inspect the new encoded digest. A boundary-crossing request
blocks immediately; a fourth attempt cannot mutate the approved run.
