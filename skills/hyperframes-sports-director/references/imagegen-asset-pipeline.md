# Image Gen Asset Pipeline

Read this reference after `DIRECTOR_LOCK`, when producing the Style Anchor,
component sheets, separate Heroes, crops, or asset proofs. Production Image Gen
is forbidden before the committed lock; proposal prototypes remain code-rendered
review derivatives.

## Anchor-first sequence

1. Count meanings before images. Write the foreground inventory and group it
   into coherent visual worlds. One visual world is selected by the frozen
   direction; batch production cannot mix worlds.
2. Generate one full-resolution Style Anchor. It binds the approved asset-plan
   digest, frozen `DESIGN_SYSTEM.json`, frozen `LOOK_PROFILE.json`, declared
   semantic color tokens, prompt/source provenance, and a native display size.
   A 4K full-screen anchor supplies at least 3840×2160 native effective pixels.
3. Write the next higher-revision candidate manifest to a staging path, then
   accept the anchor with `validate_image_assets.mjs --stage anchor --manifest
   cache/ASSET_MANIFEST.candidate.json`. The command never treats the current
   accepted manifest as its own authority. This moves
   the project from `DIRECTOR_LOCK` to `STYLE_ANCHOR` and rebuilds the current
   workbench without changing the immutable lock snapshot.
4. Generate one representative component set related to the accepted anchor.
   Crop its members with `crop_component_sheet.mjs`, then create dark and light
   alpha proofs with `build_asset_proofs.mjs`.
5. Combine a representative component with provenance-safe real-footage
   evidence. The proof must bind its bytes, footage evidence ID, components,
   semantic intent, and meaning IDs. Accept the next higher-revision staged
   manifest with `validate_image_assets.mjs --stage representative --manifest
   cache/ASSET_MANIFEST.candidate.json`; only then does the run
   enter `ASSET_PRODUCTION`.
6. Generate remaining sheets under `assets/images/source/`. Keep them immutable.
   Extract transparent components into `assets/images/components/`, and keep
   proof output under `assets/images/proofs/`.
7. Generate a Hero separately under `assets/images/source/heroes/` whenever
   silhouette or display size requires one. A crowded sheet or its crop is
   never promoted to Hero or full-screen use.
8. Accept each completed batch from a next higher-revision staged manifest with
   `validate_image_assets.mjs --stage batch --manifest
   cache/ASSET_MANIFEST.candidate.json`.
   Every acceptance validates provenance and file digests, then rebuilds the
   workbench. Acceptance is a journaled transaction across the manifest,
   project state, and current workbench; rerunning the command completes an
   interrupted transaction. Each batch advances the manifest revision and
   records its own accepted digest. Durable completion receipts make an exact
   retry idempotent even when the prior process stopped after journal cleanup.

## Manifest boundary

`ASSET_MANIFEST.json` owns asset appearance and integrity, not motion or timing.
Every entry records both `id` and the compatible `assetId`, `source`,
`sourceKind`, provenance, documentary status, narrative role, semantic tokens,
crop, visible alpha bounds, expected display rectangle, native effective
pixels, Style Anchor relation, dark/light proofs, allowed uses, and combination
tests. The Style Anchor is a special independent entry. Every other accepted
asset names the exact selected-candidate typed plan item (`plannedAsset`,
`component`, or separately generated `hero`) and `selectedRole` it fulfills.
`selectedRole` preserves the proposal's role identity (for example
`chapter_slate`) and is independent from the normalized sports `narrativeRole`.
Each typed production item maps to exactly one accepted artifact.
Its upstream integrity set is exactly the frozen design digest, frozen Look
digest, and approval display digest; `selectedAssetPlanDigest` separately binds
the selected candidate's visual-world, component, and asset plans.

The source sheet, cropped component, Hero, and proof are distinct artifacts.
Do not replace their paths with an original input filename, absolute path,
remote URL, or raw/private route. The input directory remains read-only.

## Resolution and alpha

- Crop rectangles use integer source pixels. Padding is transparent and lies
  outside the visible alpha bounds.
- Crop receipts bind source-sheet bytes, crop geometry, output bytes, and
  visible-alpha bounds. Dark/light proof receipts bind component bytes,
  background, canvas, placement, and proof bytes. These receipts are checked
  against immutable file-handle snapshots, not trusted manifest claims.
- Project reads and publications stay beneath stable no-symlink directory
  descriptors. Transaction journals store portable identities and basenames,
  never ephemeral descriptor paths, so crash recovery remains cross-process.
- `nativeEffectivePixels` measures visible source pixels, not padded canvas
  pixels. It must cover the maximum approved `expectedDisplayRect` without
  upscaling.
- A full-screen 4K plate supplies native 3840×2160 effective pixels. A 1080p
  graphics layer is not a 4K composition layer.
- Thin routes, typography, and line graphics should remain SVG or final-canvas
  code rendering when practical.

The crop and proof commands write only inside the project asset directories and
refuse overwrites. Source-sheet bytes are hashed before and after extraction.
