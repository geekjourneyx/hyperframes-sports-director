# Continuity editing SOP

Use this reference after `SHOTS.jsonl` has passed validation and before building
the director workbench. Author `edit/TIMELINE.json` from current shot IDs and
current `PROBE` source facts; never copy a duration or locator from an unverified
timeline draft.

## Editorial pass

1. Build the journey structure from Agent-authored shot meaning while keeping
   source in/out points inside the current probe and shot evidence.
2. Use current proxies only in `rough`. Use immutable-original locators and
   resolved frozen asset/motion ownership only in `final`.
3. Reject pickup/setup/tail candidates, unresolved severe shake, profile-illegal
   speed, nearby duplicate groups, and unowned transitions. A still uses a
   deliberate 0.75–12 second hold; pan/zoom remains between 1.0× and 1.25×.
4. Treat screen- and motion-direction findings as review prompts, not automatic
   aesthetic verdicts. An Agent may accept a warning only with a reason bound to
   its stable warning ID, timeline revision, and decision-basis digest. A stale,
   unknown, rejected, or undecided warning blocks rendering.
5. Run `validate_timeline.mjs`, then `render_rough_cut.mjs`. The renderer reads
   proxies, writes a visible `ANALYSIS PROXY` raster, keeps audio, closes and
   re-probes the file, hashes it, and records exact timeline/proxy lineage.

`renders/rough-cut.mp4` proves only `ROUGH_CUT`. A changed timeline, probe, proxy,
or output digest makes its evidence stale and cannot authorize
`DIRECTOR_REVIEW_READY`. Task 10 separately assembles the workbench and approval
surface.

Keep originals immutable. FFmpeg receives argument arrays only. Portable
contracts and diagnostics contain stable IDs and project-relative paths, never
absolute input paths, private filenames, raw GPS, or remote media locators.
