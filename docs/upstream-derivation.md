# Upstream Derivation Matrix

The two AGPL upstreams are frozen in `UPSTREAM.lock.json`. This matrix records
the intended lineage for future adaptations; it does not claim that a future
destination file has already been copied from an upstream.

| Upstream responsibility | v1 destination | Decision |
| --- | --- | --- |
| HyperFrames `SKILL.md` phase gates | `skills/hyperframes-sports-director/SKILL.md`, `skills/hyperframes-sports-director/references/workflow.md` | Adapt sports-Vlog terminology; retain explicit phase gates. |
| HyperFrames Image Gen pipeline | `skills/hyperframes-sports-director/references/imagegen-asset-pipeline.md` and image scripts | Retain the visual-world, component-sheet, hero-asset, crop, alpha-proof, and combination-test workflow; extend it with sports narrative roles. |
| HyperFrames asset choreography and render QA | Asset/render references and validators | Retain visual-asset integrity, motion ownership, deterministic timeline, transition-midpoint, and final-MP4 review invariants. Render QA remains SDR Rec.709, measures local contrast in sampled rendered motion intervals (7:1 target / 4.5:1 floor for critical text; 4.5:1 ordinary text; 3:1 large text or meaningful graphics), and requires rendered semantic-token Delta E 2000 `<=3`. |
| HyperFrames motion primitives, scene schema, and beat map | schemas and templates for `MOTION_MAP.json`, scene schema, and `BEAT_MAP.json` | Retain as distinct contracts; do not collapse asset ownership, appearance, and timeline timing into one file. |
| Guizang report contract | activity schema and analyzer | Adapt to optional activity input, `null`/`status: "unavailable"` missing data, privacy-trimmed public routes, sport-comparable weighted metrics, coverage limits, and time-sync authority. |

All retained or adapted source material must keep the applicable AGPL-3.0
notices and be recorded in `ATTRIBUTIONS.md` before release.
