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
| Guizang report contract | activity schema and analyzer | Adapt to optional activity input, separate value/availability/coverage/reason/source fields, exact weighted formulas, privacy-trimmed public routes, sport-comparable metrics, coverage display authority, and time-sync authority. |
| Guizang staged workflow and completion semantics | `PROJECT_STATE.json`, workflow reference, render/inspect CLIs | Retain explicit stop conditions, analysis-versus-export authorization, cancellation cleanup, honest degradation, and the rule that saved/re-probed output plus evidence—not process exit—defines success. |
| Guizang local privacy runtime | project paths, optional preview session, route export contract | Retain localhost-only serving, owner-only expiring sessions, exact-session cleanup, portable basenames/relative paths, and structurally enforced trimmed-route export. |
| Guizang visual/data tokens | `DESIGN_SYSTEM.json`, `DATA_OVERLAYS.json` | Retain semantic data-color intent but centralize all colors in one project design system; add rendered contrast, Rec.709, color-difference, and color-vision checks. |

Known upstream gaps must not be copied: no cross-sport global fastest ranking, no missing-value `|| 0` fallback, no warning-only privacy trim, no shallow JSON validation, no browser encoder as the primary final-render path, and no fixed 12 Mbps assumption.

All retained or adapted source material must keep the applicable AGPL-3.0
notices and be recorded in `ATTRIBUTIONS.md` before release.
