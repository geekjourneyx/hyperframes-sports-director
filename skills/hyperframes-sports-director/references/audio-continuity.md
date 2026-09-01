# Audio continuity SOP

Use this reference while authoring and reviewing a timeline that contains
speech, meaningful natural sound, or requested local background music.

- Protect transcript spans and shot-level speech evidence. A cut strictly
  inside a protected span is a hard failure unless the adjacent edit declares
  an L-cut, J-cut, room-tone bridge, or ambience bridge. A bridge must preserve
  the same recorded-media time relationship; it cannot relabel unrelated audio.
- Keep picture speed and audio time compression on the same validated playback
  curve. Denoise and gain are declared per item. Face/skin treatment remains
  `off` unless the Agent records that a subtle treatment improves the shot.
- `music.mode: none` creates no music input. `music.mode: local` accepts only a
  project-relative file selected or supplied locally. URLs, absolute locators,
  providers, Suno/browser automation, downloading, and rights claims are outside
  v1.
- A loop requires a positive crossfade. Apply trim, fade, gain, and ducking
  without masking protected speech, safety sound, effort sound, or place-defining
  ambience. Abrupt seams and clipped endings fail validation.

The Agent decides whether a measured treatment helps the edit. Validators own
bounds, locality, protected-span cuts, loop seams, and stale lineage; they do not
invent semantic approval.
