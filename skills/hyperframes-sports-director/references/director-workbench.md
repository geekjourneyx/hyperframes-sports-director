# Director workbench

Read this reference when preparing `DIRECTOR_REVIEW_READY` or recording the single normal-path director approval.

## Responsibility boundary

The proposal compiler is the only Task 10 writer of `direction/DIRECTION_PROPOSALS.json`. Give it two or three complete candidate drafts after the rough cut is closed and all evidence contracts are current. Every candidate must use the same representative evidence IDs, copy, 16:9 viewport, information-density budget, and local-music plan. Candidate previews are code-rendered direction prototypes; production Image Gen is forbidden.

The workbench is a local evidence and decision surface. It reads current contracts and never creates candidates, edits a timeline, invokes FFmpeg, generates production assets, or freezes design and Look. Rebuild it atomically after an upstream revision changes. Do not manually edit `review/director-workbench.html`.

## Standard sequence

1. Put review-safe frame, clip, layout-proof, and motion-storyboard derivatives under `review/workbench-assets/`. Originals, private basenames, raw GPS, remote URLs, and embedded base64 are invalid.
2. Run `node scripts/compile_direction_proposals.mjs --project <project> --candidates <local-candidate-drafts.json>`.
3. Advance the independently validated project gate to `DIRECTOR_REVIEW_READY` with current proposal/workbench evidence.
4. Run `node scripts/build_director_workbench.mjs --project <project>`.
5. Run `node scripts/serve_director_workbench.mjs --project <project>`. Open the printed `127.0.0.1` URL before its expiry.
6. Compare complete directions, then use the sole approval control once. The endpoint binds the selected candidate, canonical workbench digest, and complete displayed digest set in `direction/DIRECTOR_APPROVAL.json`.

Task 10 does not enter `DIRECTOR_LOCK`. The lock command independently revalidates this approval and transactionally freezes one design system and one Look profile in Task 11.

## Security and recovery

The temporary server binds to `127.0.0.1`, serves an explicit review-derivative allow-list, creates a random owner-only `0700` session, requires exact session and CSRF tokens, and removes only its exact session directory on shutdown. Stale, partial, duplicate, expired, cross-proposal, or wrong-state approvals fail without a state transition. An atomic write failure leaves no partial approval or temporary file.

If a user wants to change an approved story, key shot, direction, semantic token, Look, music, privacy, or delivery boundary, stop the current run. The user starts a separate project revision and approval flow; the unattended run never requests a second approval.
