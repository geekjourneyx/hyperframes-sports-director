# Releasing HyperFrames Sports Director

This process prepares and verifies a release archive. It does not create or
push a Git tag and does not publish an artifact automatically.

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

## Verification

Run with every proxy environment variable unset:

```bash
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy npm ci
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy npm test
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy npm run test:contracts
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy npm run test:media
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy npm run test:skill
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy npm run eval
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy npm run check
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  -u http_proxy -u https_proxy -u all_proxy npm run release:dry
git status --short
```

`npm run release:dry` creates:

- `dist/hyperframes-sports-director-v1.0.0.skill`
- `dist/hyperframes-sports-director-v1.0.0.skill.sha256`

The `.skill` file is a deterministic ZIP archive containing one
`hyperframes-sports-director/` root. It excludes the evaluation workspace,
source footage, activity files, proxies, renders, secrets, and generated media.

## Inspect the dry run

```bash
(cd dist && sha256sum -c hyperframes-sports-director-v1.0.0.skill.sha256)
unzip -Z1 dist/hyperframes-sports-director-v1.0.0.skill
```

Unpack into a temporary directory and run Skill Creator validation against the
single extracted Skill root before approving a tag:

```bash
hf_release_tmp="$(mktemp -d)"
unzip -q dist/hyperframes-sports-director-v1.0.0.skill -d "$hf_release_tmp"
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" \
  "$hf_release_tmp/hyperframes-sports-director"
```

Inspect the archive listing and checksum, then obtain explicit confirmation for
the exact `v1.0.0` tag. Tagging and publishing are outside this dry run.
