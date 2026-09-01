# Activity Data SOP

Use this reference when a project contains FIT, KML, or normalized activity
JSON, or when the Agent must decide whether a recorded metric may appear in an
edit. Activity data is optional and is never reconstructed from footage.

## Deterministic flow

1. Classify the local activity source during immutable media ingest.
2. Run `analyze_activity.mjs` with the project root and optional source. Supply
   `--trim-start-m` and/or `--trim-end-m` to authorize a public route
   derivative. Every positive side is physically removed; zero trimming on
   both sides creates no public route.
3. Treat `analysis/ACTIVITY.json` as metric/coverage/privacy truth,
   `analysis/SYNC_MAP.json` as time-mapping truth, and
   `direction/DATA_OVERLAYS.json` as an allow-list. Never recalculate a metric
   inside an overlay, scene, workbench, or timeline.
4. Before using an overlay, validate all three artifacts and resolve their
   integrity digests. A stale activity or sync digest invalidates the allow-list.

The analyzer accepts absolute timestamps, a manual anchor, or an explicitly
declared offset. KML geometry without timestamps cannot authorize duration,
speed, pace, pause, or synchronized overlays. Pool swimming does not require
GPS. No input produces a valid `status: "unavailable"` chain and does not block
media editing.

## Metric authority

- Overall speed is total valid distance divided by total valid moving time.
- Heart rate, power, cadence/step rate, and temperature use valid-sample
  weighting. A recorded zero is evidence; a missing sample remains `null`.
- Grade distribution is distance-weighted and ignores segments shorter than
  the deterministic elevation-spike threshold.
- Calories are summed only when explicitly reported by a device and retain
  their reported coverage.
- Duplicate activities are removed before aggregation. Unlike sport profiles
  are never aggregated or ranked together.

Coverage below 10% is suppressed. Coverage from 10% through 39.9% permits only
a labeled local observation; 40% through 79.9% requires a visible caveat; 80%
or greater may support whole-activity wording when the sport profile permits
it. Without a reliable sync map, use whole-activity or chapter-summary wording,
never a time-synchronized claim.

## Privacy and Agent limits

Raw GPS, biometrics, absolute paths, and private filenames stay in local input
or non-portable locator state. Portable artifacts may contain stable activity
source IDs and a genuinely trimmed route derivative. A public route consumer
accepts only the `trimmed-route-*` ID recorded in both `ACTIVITY.json` and
`DATA_OVERLAYS.json`; a warning is not a privacy control.

The Agent may decide that an allowed fact does not improve the story. It may
write evidence-backed interpretation or a limitation, but it may not overwrite
recorded values, coverage, availability, sync confidence, or privacy state, and
must not invent medical or training conclusions.
