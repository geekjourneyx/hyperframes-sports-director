# HyperFrames Sports Director

Evidence-backed sports footage in, immersive 16:9 Vlog out.

<p align="center">
  <img src="skills/hyperframes-sports-director/assets/icons/icon-large.png" alt="HyperFrames Sports Director icon" width="160">
</p>

HyperFrames Sports Director is a local Codex Skill for turning mixed videos,
stills, optional activity data, and local music into a reviewed sports Vlog.
It keeps real footage, recorded metrics, and generated design on separate truth
chains, then uses FFmpeg for media work and HyperFrames for visual direction and
motion composition.

## What it is for

The v1 release-grade profiles are cycling, hiking/non-technical mountain
journeys, and pool swimming. Running, technical mountaineering, trail running,
and open-water swimming are included as experimental contract coverage, not as
v1 release claims.

Typical delivery is an approximately three-minute 16:9 MP4 in 4K
(`3840x2160`) or 1080p (`1920x1080`). The editing brief can set duration,
required or excluded moments, titles and captions, codec, frame-rate policy,
file-size ceiling, and optional local background music. The Skill never
generates, searches for, or downloads music remotely.

## Requirements

- Node.js 22.12 or newer and npm.
- Local `ffmpeg` and `ffprobe` with the filters reported by
  `scripts/check_install.mjs`.
- The bundled HyperFrames project and director-workbench assets.
- Local source media that the workflow may read but never modifies.

Run the capability check from the Skill directory before starting media work:

```bash
npm ci
cd skills/hyperframes-sports-director
node scripts/check_install.mjs --json
```

## Install the Skill

Clone this repository, then copy the Skill directory into your Codex skills
directory, preserving the directory name:

```bash
git clone https://github.com/geekjourneyx/hyperframes-sports-director.git
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R hyperframes-sports-director/skills/hyperframes-sports-director \
  "${CODEX_HOME:-$HOME/.codex}/skills/hyperframes-sports-director"
```

Restart Codex after installation. The packaged `.skill` archive produced by
the release dry run contains the same single Skill root.

## Quick start

Invoke the Skill with a local input directory and an editing brief:

```text
Use $hyperframes-sports-director to turn /path/to/ride-media into a three-minute
16:9 4K cycling Vlog. Use the local track music.m4a, keep the spoken arrival,
add English chapter titles, trim the route near home, and stay under 900 MB.
```

Another valid request can omit activity data without inventing zero values:

```text
Use $hyperframes-sports-director to edit /path/to/pool-session as a 1080p pool
swimming Vlog. GPS is unavailable; use only recorded lap and duration fields.
```

The Agent inspects the input without changing it, normalizes the brief, checks
capabilities, and resumes from the integrity-valid `PROJECT_STATE.json`. Exact
commands and artifact order live in the
[Unix pipeline](skills/hyperframes-sports-director/references/unix-pipeline.md).

## How the review and delivery gates work

The local director workbench presents review-safe derivatives and equal
whole-direction candidates. It is an evidence and approval view, not an editor,
render controller, cloud review page, or share export. A normal run records
exactly one hash-bound `DIRECTOR_LOCK` approval and transactionally freezes one
project design system plus one independent Look profile.

Production visual generation starts only after that lock. The workflow accepts
one full-resolution Style Anchor, one representative real-footage combination,
and two semantically different final combination proofs before delivery.
Generated visuals can interpret the journey but cannot impersonate footage or
invent metrics.

Final rendering is original-backed. A closed MP4 is re-probed, checked by
machine gates, and reviewed from decoded encoded-video evidence. Only then can
the project reach `DELIVERED`; optional `USER_ACCEPTED` is a later, separate
signal. Automatic repair is limited to three attempts per gate and cannot
change the approved story, key shots, direction, colors, Look, music, privacy,
or delivery contract. Crossing that boundary records `BLOCKED`.

## Evidence and privacy

- Recorded media, activity data, and design remain independent truth chains.
- Missing values are `null` or `status: "unavailable"`, never fabricated zeroes.
- Public route visuals require a genuinely privacy-trimmed derivative.
- Portable artifacts use stable IDs and relative paths, never private filenames
  or absolute input paths.
- Originals, GPS, biometrics, secrets, proxies, renders, and evaluation
  workspaces are excluded from release packages.
- Cancellation stops child processes and removes incomplete temporary output;
  a filename or successful encoder exit alone never proves delivery.

## Non-goals

V1 does not provide a GUI editor, cloud/share review, remote music or Suno
integration, advertisements, generic single-file transcoding, training advice,
or release-grade claims for the four experimental profiles.

## Documentation

- [Architecture](docs/architecture.md)
- [Design engineering contract](docs/design-engineering.md)
- [Workflow and final inspection](skills/hyperframes-sports-director/references/workflow.md)
- [Sport profiles](skills/hyperframes-sports-director/references/sport-profiles.md)
- [Release process](RELEASING.md)
- [Upstream derivation](docs/upstream-derivation.md) and [attributions](ATTRIBUTIONS.md)
- [Baseline report](docs/skill-baseline-report.md), [Skill evaluation](docs/skill-evaluation-report.md), and [changelog](CHANGELOG.md)
- [Design specification](docs/superpowers/specs/2026-08-31-hyperframes-sports-director-v1-design.md) and [implementation plan](docs/superpowers/plans/2026-08-31-hyperframes-sports-director-v1.md)

## Development

Contributor rules are in [AGENTS.md](AGENTS.md). Install dependencies with
`npm ci`, then run `npm test`. The complete release sequence is documented in
[RELEASING.md](RELEASING.md).

## License

[AGPL-3.0-only](LICENSE). See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for the exact
upstream commits and file-level derivation record.
