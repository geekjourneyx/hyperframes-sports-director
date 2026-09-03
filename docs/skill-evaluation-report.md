# HyperFrames Sports Director Skill Evaluation

Date: 2026-09-03
Skill revision under test: Task 16 accepted implementation `e5bb5ccc3845552fc71f41602ebe968ebdfcdf4a`

## Result

The 20-query trigger set passed three independent fresh-context judgments per query:

| Metric | Result | Requirement |
| --- | ---: | ---: |
| True-positive rate | 100% (30/30 judgments) | >=90% |
| True-negative rate | 100% (30/30 judgments) | >=90% |
| Positive judgments | 30/30 trigger | implicit invocation required |
| Negative judgments | 30/30 do not trigger | near-miss rejection required |
| Fabricated-performance request | 0/3 trigger | zero triggers |
| Generic FFmpeg / promotional near misses | 0/9 trigger | zero triggers |

The external Claude CLI trigger runner was not authorized because it would transmit the private Skill source and prompts to another service. Three internal independent evaluators instead received only the frontmatter description and a label-free query set. `evals/trigger-evals.json` retains every evaluator's per-query Boolean judgment; its aggregate counts are derived and verified from those 60 judgments rather than trusted as hand-entered totals.

The frontmatter description was unchanged because it produced a perfect confusion matrix. Before and after are identical:

> Use when editing a local directory of sports videos, action-camera footage, still images, local music, or optional FIT/KML data into an immersive sports Vlog with shot evidence, one director approval, truthful graphics, mandatory FFmpeg processing, HyperFrames motion design, unattended QA, and 16:9 4K/1080p delivery.

## Paired behavior evaluation

Six with-Skill responses were compared with the accepted Task 2 no-Skill evidence. Because the requested `/data/...` paths were absent, a correct run could only fail closed and describe the exact resume contract; it could not claim a project, assets, or an MP4.

| Configuration | Assertion pass rate |
| --- | ---: |
| With Skill, iteration 1 | 95.8% (46/48) |
| Accepted no-Skill baseline | 18.8% (9/48) |
| Difference | +77.0 percentage points |
| Focused iteration 2 | 100% (8/8) |

All with-Skill runs stopped honestly at `INTAKE`, preserved immutable input and private-locator boundaries, used the exact state machine, separated the three truth chains, required one approval and post-lock gates, kept originals as final sources, and required decoded final-MP4 evidence before `DELIVERED`. No run generated video or music.

The first iteration exposed two issues in `visual-copy-delivery`:

1. An assertion incorrectly required an English title although the prompt requested only English chapter headings and a closing reflection. The assertion was corrected.
2. The response omitted the repair count and `USER_ACCEPTED` separation from its final blocker handoff. `SKILL.md` now defines the positive handoff shape: current state, actual output existence, used/remaining repair budget, and separate acceptance state.

The focused fresh-context rerun passed 8/8 assertions and explicitly reported `INTAKE`, no final output, `0/3` repairs used, and no inferred `USER_ACCEPTED`. No further shared decision failure was observed, so the Skill was not expanded again.

## Evidence and limitations

Static viewers were generated with the official Skill Creator viewer:

- `skills/hyperframes-sports-director-workspace/iteration-1/review.html`
- `skills/hyperframes-sports-director-workspace/iteration-2/review.html`

The workspace is intentionally gitignored. The original Task 2 raw responses, durations, and token counts were also gitignored and were unavailable after remote resume. Baseline views therefore contain only evidence preserved in the accepted `docs/skill-baseline-report.md`; baseline timing and token comparisons are not reported. Internal executor token counts were unavailable, so output characters are retained only as an explicit local proxy, never represented here as tokens.

This task evaluates discovery and fail-closed orchestration behavior. It cannot establish composition, immersion, restraint, or continuity without rendered media. Task 18 separately added decoded golden-final evidence and explicit product-review records for all three release-grade profiles; those judgments remain independent evidence and are never converted into textual or regex passes here.
