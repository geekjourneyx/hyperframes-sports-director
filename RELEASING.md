# Releasing HyperFrames Sports Director

Pushing an annotated version tag is the release authorization. GitHub Actions
accepts the tag only when it matches `package.json` and points to the current
`main` commit, then reruns every gate and publishes the archive and checksum as
a GitHub Release.

## Preconditions

- Work from a clean tree at the intended release commit.
- Confirm `package.json`, `package-lock.json`, and the changelog all use the
  intended version.
- Confirm `UPSTREAM.lock.json` contains immutable commit hashes and that
  `ATTRIBUTIONS.md` names both upstream projects and those exact hashes.
- Record product-level human sign-off for the local director workbench golden
  fixture and the encoded final video for all three release-grade profiles.
- Confirm every golden score is at least 90, with no hard-gate failure and no
  category below 80 percent.
- Confirm the version tag does not already exist locally or on GitHub. Release
  tags are immutable and must never be moved or reused.

## Verification

Run with every proxy environment variable unset:

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
  -u http_proxy -u https_proxy -u all_proxy -u no_proxy npm ci
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
  -u http_proxy -u https_proxy -u all_proxy -u no_proxy npm test
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
  -u http_proxy -u https_proxy -u all_proxy -u no_proxy npm run test:contracts
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
  -u http_proxy -u https_proxy -u all_proxy -u no_proxy npm run test:media
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
  -u http_proxy -u https_proxy -u all_proxy -u no_proxy npm run test:skill
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
  -u http_proxy -u https_proxy -u all_proxy -u no_proxy npm run eval
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
  -u http_proxy -u https_proxy -u all_proxy -u no_proxy npm run check
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u NO_PROXY \
  -u http_proxy -u https_proxy -u all_proxy -u no_proxy npm run release:package -- --tag v1.0.1
git status --short
```

`npm run release:package` creates:

- `dist/hyperframes-sports-director-v1.0.1.skill`
- `dist/hyperframes-sports-director-v1.0.1.skill.sha256`

The `.skill` file is a deterministic ZIP archive containing one
`hyperframes-sports-director/` root. It excludes the evaluation workspace,
source footage, activity files, proxies, renders, secrets, and generated media.

## Inspect the dry run

```bash
(cd dist && sha256sum -c hyperframes-sports-director-v1.0.1.skill.sha256)
unzip -Z1 dist/hyperframes-sports-director-v1.0.1.skill
```

Unpack into a temporary directory and run Skill Creator validation against the
single extracted Skill root before approving a tag:

```bash
hf_release_tmp="$(mktemp -d)"
unzip -q dist/hyperframes-sports-director-v1.0.1.skill -d "$hf_release_tmp"
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" \
  "$hf_release_tmp/hyperframes-sports-director"
```

Inspect the archive listing and checksum, then obtain explicit confirmation for
the exact `v1.0.1` tag. `npm run release:dry` remains a compatibility alias for
local packaging; CI and release automation use the explicit
`release:package` name.

## Publish

Commit the release metadata and workflow, push it to `main`, and wait for every
required check on that exact commit to pass. Then prove that the local commit is
the current remote `main` and that the version tag is still unused:

```bash
git fetch origin main --tags
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
test -z "$(git tag --list v1.0.1)"
test -z "$(git ls-remote --tags origin refs/tags/v1.0.1)"
```

Create and push one annotated tag:

```bash
git tag -a v1.0.1 -m "Release v1.0.1"
git push origin v1.0.1
```

The `Release` workflow validates the exact tag and current-main commit, reruns
the full suite, rebuilds and checksums the archive, and creates the GitHub
Release. It also keeps the same files as a workflow artifact for CI diagnostics.

## Verify publication

```bash
gh run list --workflow Release --commit "$(git rev-list -n 1 v1.0.1)"
gh release view v1.0.1 --json url,tagName,isDraft,isPrerelease,assets
```

Release is complete only when the workflow is green and the GitHub Release is
public, not a draft, and contains both expected assets. If the workflow itself
can be retried without changing content, rerun the same workflow. If tagged
content needs a change, keep `v1.0.1` immutable and release a new patch version.
