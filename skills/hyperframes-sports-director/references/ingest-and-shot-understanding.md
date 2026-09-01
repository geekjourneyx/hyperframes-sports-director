# Ingest and shot-understanding review

Run the Task 6 ingest, probe, and proxy commands before segmenting media. Then run
`segment_media.mjs` to create `analysis/SEGMENTS.json` and normalised review-safe
evidence under `analysis/evidence/`. The segmenter reports only mechanical facts:
time ranges, scene and motion scores, audio presence, and extracted frames. It does
not identify camera, action, people, or environment.

Review contact sheets first. Their gutters carry stable shot, media, and segment IDs,
source timecode, and an ID-derived evidence basename; they intentionally never show
the source filename. Use the IDs and evidence paths when authoring the one-line
`analysis/SHOTS.jsonl` envelope. A shot must cite frames extracted by its segment.

For every shot, supply the declared camera/action roles, tags, quality, continuity,
audio spans, duplicate grouping, setup-tail likelihood, and confidence. If a fact
cannot be supported by the evidence, use `unknown` and low confidence rather than
guessing. Inspect a short local analysis proxy clip when a contact sheet leaves motion
or audio ambiguous. Ask for review when a high-impact prospective shot has low
confidence, severe quality risk, or uncertain setup/tail handling.

Validate the authored envelope before any edit work:

```bash
node scripts/validate_shots.mjs --project /path/to/project --shots /path/to/project/analysis/SHOTS.jsonl
node scripts/build_contact_sheets.mjs --project /path/to/project
```

Validation requires exactly one JSON line, current `PROBE` and `SEGMENTS` digests,
segment/probe bounds, and segment-derived evidence paths. It does not create or
alter semantic labels. All outputs are project-relative analysis or review derivatives;
originals and private filenames remain outside portable artifacts.
