# Clarity and final export

Read this reference immediately before `render_final.mjs`.

Final rendering starts only from `MOTION_COMPOSITION`. Load the current final
timeline through the immutable input registry, validate the one committed
direction lock, and validate the final timeline before starting FFmpeg. A
logical `media/originals/<mediaId>.<ext>` locator must resolve to the registry's
hash-matching source path outside the project. Never substitute a proxy,
analysis/review derivative, URL, provider temporary file, or private path in a
portable artifact.

Derive chapters from the approved `SCENE_SCHEMA` intervals. If scenes are not
present, each approved timeline item is a semantic fallback chapter; never cut
chapters at arbitrary fixed wall-clock intervals. A chapter cache key binds its
scene content, timeline item slices, source hashes, normalized treatments,
source/delivery raster transform, rational frame rate, frozen design and Look,
asset authority, motion authority, and actual HyperFrames layer bytes. A local
title change invalidates its chapter and final assembly. A Look change
invalidates every visual chapter. Chapter intermediates are FFV1/PCM and are
not delivery encodes.

Use `1920x1080` or `3840x2160`, 16:9, SAR 1, and explicit source-to-delivery
scale/pad transforms. Preserve a rational source-compatible frame rate when
possible. Video speed changes must pair PTS changes with an `atempo` chain.
Clip that source-time curve at semantic chapter boundaries so an item crossing
a boundary continues rather than replaying. Use `vidstabdetect` and
`vidstabtransform` when both filters exist, with conservative `deshake` as the
documented fallback. Stills are decoded as timed image inputs. Preserve source audio, emit silence
only for genuinely silent sources/stills, and honor declared room-tone,
ambience, J-cut, and L-cut continuity in the approved timeline. Local approved
music may be trimmed or looped, faded, loudness-normalized, ducked around
source sound, and mixed with ambience priority. Loop enough crossfaded copies
to cover the delivery and hash the local track before and after rendering.
Remote music is forbidden.

Drive each visual layer from Task 13's paused absolute-time runtime. Sample its
entry, hold, exit, transition midpoint, and declared geometry keyframes, then
render the interpolated geometry, semantic-token paint, and exact static
fallback. Preserve approved SVG paths instead of replacing them with generic
rectangles.

Without a size ceiling, perform one CRF delivery encode. With
`maximumFileSizeBytes`, reserve the explicit audio budget and container margin,
then use a two-pass video encode: pass one writes `/dev/null` and no delivery
audio; pass two writes the temporary candidate. Refuse a bitrate below the
1080p/4K clarity floor and return concrete alternatives instead of silently
reducing quality.

Cancellation sends `SIGTERM` to every tracked child, escalates survivors to
`SIGKILL`, and removes incomplete candidates. After FFmpeg closes the candidate, fsync and re-probe it. Write the
portable, hash-bound provenance to a pending sidecar before the atomic final
move. Publish the candidate, provenance, `FINAL_RENDER` state, and rebuilt
workbench under the final-render transaction. Recovery may roll back only when
the current state digest equals the journal's previous or next state; a newer
state is a conflict and remains untouched. Recover or roll back the entire
publication on failure. Rendering never marks `FINAL_QA`, `DELIVERED`, or
`USER_ACCEPTED`.
