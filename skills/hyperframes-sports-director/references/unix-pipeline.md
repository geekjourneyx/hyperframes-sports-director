# Unix command pipeline

Run commands from the Skill directory with proxy environment variables unset. Every command emits machine-readable JSON and fails closed; inspect that result before continuing. The current validated `PROJECT_STATE.json`, not this list, decides where to resume.

## Intake and analysis

```bash
node scripts/check_install.mjs --json
node scripts/create_project.mjs --project "$PROJECT" --input "$INPUT" --sport cycling --device dji-osmo-action-5-pro --delivery landscape-4k --duration 180 --music none --copy titles
node scripts/ingest_media.mjs --project "$PROJECT" --input "$INPUT"
node scripts/probe_media.mjs --project "$PROJECT" --input "$INPUT"
node scripts/build_proxies.mjs --project "$PROJECT" --input "$INPUT"
node scripts/segment_media.mjs --project "$PROJECT" --input "$INPUT"
node scripts/build_contact_sheets.mjs --project "$PROJECT"
node scripts/validate_shots.mjs --project "$PROJECT" --shots "$PROJECT/analysis/SHOTS.jsonl"
```

When activity data is present, add `analyze_activity.mjs --project "$PROJECT" --input "$ACTIVITY"` with explicit trim/sync flags. With no activity input, run it without `--input` to create the valid unavailable chain.

## Edit and the one approval

Author artifacts only from current evidence, validate the timeline, and render the proxy review:

```bash
node scripts/validate_timeline.mjs --project "$PROJECT"
node scripts/render_rough_cut.mjs --project "$PROJECT"
node scripts/compile_direction_proposals.mjs --project "$PROJECT" --candidates "$PROJECT/cache/direction-candidates.json"
node scripts/build_director_workbench.mjs --project "$PROJECT"
node scripts/serve_director_workbench.mjs --project "$PROJECT"
node scripts/lock_direction.mjs --project "$PROJECT"
```

The local workbench records the sole normal-path approval. Do not automate a second approval.

## Assets, motion, render, and inspection

Use `validate_image_assets.mjs` in `anchor`, `representative`, then `batch` stages. Crop sheets with `crop_component_sheet.mjs`, build alpha proofs with `build_asset_proofs.mjs`, and validate final assets before motion. Then:

```bash
node scripts/render_motion_proofs.mjs --project "$PROJECT" --proof "$PROJECT/cache/MOTION_PROOF_INPUT.json"
node scripts/validate_design_consistency.mjs --project "$PROJECT" --input "$PROJECT/cache/MOTION_COMPOSITION_INPUT.json"
node scripts/render_final.mjs --project "$PROJECT" --input "$PROJECT/cache/FINAL_RENDER_INPUT.json"
node scripts/render_final_proof_passes.mjs --project "$PROJECT" --capture "$PROJECT/cache/FINAL_PROOF_CAPTURE.json"
node scripts/inspect_output.mjs --project "$PROJECT" --proof "$PROJECT/review/final-proof-passes/<final-digest>/PROOF.json"
node scripts/inspect_output.mjs --project "$PROJECT" --proof "$PROJECT/review/final-proof-passes/<final-digest>/PROOF.json" --agent-inspection "$PROJECT/cache/AGENT_FINAL_INSPECTION.json"
```

On a repairable gate failure, pass one local request using `--repair`; rerun only the returned invalidation closure, then inspect the new final digest. Stop at `BLOCKED` or `CANCELLED`. Never infer `USER_ACCEPTED`.
