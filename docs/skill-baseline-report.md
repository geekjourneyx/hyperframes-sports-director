# HyperFrames Sports Director: No-Skill Baseline Report

## Method and evidence boundary

The six raw responses were read in full from `skills/hyperframes-sports-director-workspace/iteration-0/without_skill/<eval-id>/raw_response.md`. This report records only what those responses state or omit. They are planning responses, not rendered projects; consequently, an omitted artifact is reported as an observed omission from the response, not as proof that an eventual render would fail.

## Observed results by required category

### Proxies accidentally treated as final sources

Not observed. No response says that a proxy is the final render source. `noisy-speech-music` explicitly calls the requested recap “original-backed”; the other responses do not state a final-source choice.

### Promotional rather than experiential pacing

Not observed. `noisy-speech-music` says “not a promo,” while `cycling-fit-4k` describes an immersive vlog with natural ambience and `visual-copy-delivery` calls the result an experiential city-ride vlog. No raw response uses product-launch or advertising framing.

### Missing shot or audio continuity contracts

Observed. No raw response supplies a per-shot source contract or a formal audio-continuity plan. `mixed-directory-story` promises a future source ledger and timecoded edit plan, but has not supplied either; `cycling-fit-4k` has a high-level sequence and sound intent but no shot-to-original ledger or continuity artifact. `noisy-speech-music` explains cautious dialogue and music handling, and `pool-swimming` says ambience will remain believable, yet neither defines a continuity plan or source-linked audio segments.

### Invented or zero-filled activity data

Not observed. `hiking-no-data` explicitly says activity display will read “Activity data unavailable” instead of estimating metrics. `pool-swimming` says it will use only supplied lap data, and `cycling-fit-4k` lists possible FIT-derived overlays without asserting any specific metric. No raw response gives an unsupported activity value or substitutes zero for missing data.

### Image Gen assets without provenance, crop, or motion ownership

Observed in `cycling-fit-4k`: it proposes “Image Gen” transition material but provides no provenance record, crop decision, or named motion owner for those generated assets. By contrast, `visual-copy-delivery` explicitly promises all three controls; this is a stated intention, not an asset manifest.

### Overfitting to cycling

Not observed. The hiking, pool-swimming, and trail-running responses each address their own medium or data condition, and no non-cycling response instructs the use of a route/ride/FIT treatment. This does not establish broad competence; it only means the supplied raw outputs do not directly evidence cycling-only overfit.

### Weak final-MP4 inspection

Observed. `hiking-no-data`, `pool-swimming`, `noisy-speech-music`, and `mixed-directory-story` promise or request an MP4 without an inspection procedure. `cycling-fit-4k` proposes checks for duration, resolution, size, sync, and excluded footage; `visual-copy-delivery` adds codec and bitrate. Neither response specifies decoded visual samples and an audio-stream decode check, and none provides an actual inspection result.

## Rubric-criterion evidence matrix

| Criterion | Direct evidence from raw outputs | Baseline observation |
| --- | --- | --- |
| `input-provenance` | `mixed-directory-story` says it needs directory access before it can “truthfully report source provenance” and promises a future source ledger; `noisy-speech-music` says “original-backed.” | No response supplies the required input asset manifest or original/derivative provenance record. |
| `shot-evidence` | `mixed-directory-story` promises a future timecoded plan and exact filename/time-range ledger. | No actual per-shot source record is supplied. |
| `original-backed-timeline` | `noisy-speech-music` calls the desired cut “original-backed.” | One assertion of intent; no timeline/render-source evidence is supplied. |
| `audio-continuity` | Cycling discusses environmental sound, music, and pacing; noisy-speech-music discusses intelligibility and cautious use of background music; pool-swimming promises believable ambience. | Audio intent is present, but no formal continuity plan or source-linked audio segment contract is present. |
| `null-or-unavailable-data` | Hiking explicitly says “Activity data unavailable”; pool says only supplied lap data will be used. | The raw output supports honest missing-data intent; it supplies no structured activity-data ledger. |
| `generated-visual-provenance` | Cycling proposes Image Gen visuals; visual-copy-delivery promises a provenance record. | Cycling omits provenance detail; visual-copy-delivery has a promise but no actual manifest. |
| `generated-visual-motion-ownership` | Visual-copy-delivery promises crop decisions and named motion owners. | Cycling omits both; visual-copy-delivery has no delivered motion map. |
| `copy-requirements` | Cycling supplies a title and four chapter texts. Visual-copy-delivery only promises future English chapter cards and reflection. | Cycling satisfies the requested copy in the raw response; no conclusion is possible for the latter without delivered copy. |
| `final-mp4-inspection` | Cycling lists some export checks; visual-copy-delivery lists resolution, duration, codec, bitrate, and size. | No response states or provides robust inspection with probe metadata, decoded samples, and an audio-stream decode result. |

## Hard-failure risk matrix

| Hard-failure risk | Direct evidence | Observation |
| --- | --- | --- |
| `fabricated-metrics` | Hiking rejects estimates; pool limits metrics to supplied data. | Not observed. |
| `proxy-as-final-source` | No response declares a proxy final source. | Not observed. |
| `generated-imagery-as-documentary` | Cycling limits generated material to abstract texture/light transitions and says not to generate scenery or people. | Not observed. |
| `generated-asset-ownership` | Cycling proposes Image Gen without provenance/crop/motion-owner details; visual-copy-delivery promises them but supplies no asset record. | Risk observed for cycling’s stated plan. |
| `missing-final-mp4-inspection` | No raw response supplies probe metadata, decoded samples, and an audio-stream check. | Risk observed in all six planning responses. |

## Baseline conclusion

The responses generally preserve the intended experiential tone and reject fabricated activity data. Their main directly observed gaps are production-evidence contracts: source/shot ledgers, audio continuity contracts, generated-asset ownership for the cycling prompt, and robust final-MP4 inspection. These are no-Skill baseline observations only; they do not claim failures not supported by the six raw files.
