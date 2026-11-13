# Report: the blob look (branch t3/blob-look)

**Result:** the blob now reads as dark liquid metal under coloured gels, with lava-lamp blobs that rise, merge and split inside it and push its surface. The five states stay clearly distinct: violet idle, cyan listening with teal lava, amber thinking, warm-silver speaking, dim grey error. Details, cost and honest weaknesses: `docs/notes/look.md`.

Best screenshot: `docs/screenshots/thinking-1280x800.png`. Best still for idle as a painting: `docs/screenshots/idle-1280x800.png`. Motion: `docs/screenshots/motion/*.png`.

## Review round 1

All three coordinator notes are addressed (details: `docs/notes/look.md`, "Review round 1"):

- **Lava.** Soft, volumetric and elongated: samples add up, each with a halo and a brighter core; lobes are taller than wide and of different sizes. Thinking lava is a deeper orange.
- **Reflections.** Every light is a rounded panel or pill with soft edges, and the flow smear is about twice as strong.
- **Lower half.** A soft horizon, a floor bounce of gel light, and a low gel rim light behind.

The translucent rim, the lava colour per state and the motion speed are unchanged.

## Checks (run in `web/`, all passed on the final commit)

| Command | Result |
| --- | --- |
| `npm run lint` | No issues |
| `npm run typecheck` | No errors |
| `npm test` | 10 files, 73 tests passed |
| `npm run e2e` | 16 passed |
| `npm run screenshots` | 5 passed: states at 1280x800 and 1024x768, PWA icons, motion contact sheets, frame cost |

## Cost

Measured with `web/scripts/shader-bench.mjs` (one page, alternating frames, SwiftShader at 960x600). Quality 2 costs **1.43x** the old shader at idle and **1.39x** with the level at 0.7 (medians 1.45x), inside the 1.5x target. Quality 1 costs 1.31x and quality 0 costs 1.21x. The page drops one tier when its frame interval averages over 50 ms for 4 s.

## Interface changes others should know

- New uniforms: `uLava` (vec3, per-state lava colour, crossfaded like `uColor`) and `uLobes[5]` (vec4, lobe centres and radii from `tables.ts` `lobes()`).
- New define: `QUALITY` (0, 1 or 2) on the material.
- `Look` gains a `lava` field. `BlobRenderer` gains `quality`, `autoQuality`, `setQuality()`, `dim`, `freeze()` and `step()`.
- `blobDebug` gains `quality`, `setQuality()`, `setDim()`, `freeze()` and `step()`.
- `shape(p, id)`, `map()` and `normalAt()` are unchanged. `sphereShape()` keeps its signature (new body). The S3/S4 session should see only small conflicts in the uniform block of `blob.frag` and the uniform list in `blob.ts`.
- `npm run screenshots` now also runs `e2e/motion.spec.ts`. Normal `npm run e2e` ignores it.

## Not done or not verified

Not seen on the real tablet, a real GPU or a real display. Motion was judged only from contact sheets: software GL draws about 8 to 10 fps. The weak points are listed in `docs/notes/look.md`.

## Merge with main (page S3/S4)

`git merge main` is committed on this branch (not pushed). Conflicts were in `blob.ts`, `tables.ts` and `main.ts`; `blob.frag` merged automatically. Both sides are kept:

- **From main:** the `shape()`/`map()` structure, with each distance function evaluated once, and the alert shapes, morph, uniforms and plumbing.
- **From this branch:** the shading, the lava and lobe uniforms, the quality tiers, dimming and the debug clock.

Other merge details:

- **Alert lava colours.** Alerts get a lava colour too: `ALERT_LAVA` in `tables.ts`, light green for info, orange-red for urgent.
- **`blobDebug.freeze`.** With no argument it holds the current frame (main's mid-morph capture). `freeze(view)` restarts that view's motion at zero (film strip).
- **Alert faces.** One small shading change for alerts: their flat faces get stronger flowing ripples in the reflection (`faceted` in `reflection()`, driven by the shape uniforms). Without it they mirrored one flat colour and read as tinted glass.

Checks after the merge, run in `web/` with `MOCK_PORT=8797`:

| Command | Result |
| --- | --- |
| `npm run lint` | No issues |
| `npm run typecheck` | No errors |
| `npm test` | 17 files, 136 tests passed |
| `npm run build` | Built |
| `npm run e2e` | 26 passed |
| `npm run screenshots` | 6 passed: states, icons, alert shapes and morph, motion sheets |

**Alert screenshots** (`docs/screenshots/alert-*.png`): the triangle and the square read as coloured liquid metal with lava inside, and the morph frame (uMix 0.32) renders without artefacts from the shading. Two things still look weak, and both come from the shapes, not the shading: the triangle's edges look sharp at this size, and the mid-morph shape shows creases where the two distance fields mix. I did not change those (they are the S3/S4 session's scope).

**Load-time compile:** there is no stall. Compile, link and first draw take 277 ms for the merged shader, against 211 ms for main and 171 ms for the original. Each figure includes one drawn frame. Measured with `scripts/shader-bench.mjs`, which now reports this as well.

**Cost after the merge.** This is worth the coordinator's attention.

| Shader | Idle frame (min) | vs original | vs main |
| --- | --- | --- | --- |
| Original (`576a5b6`) | 72 ms | 1.00 | |
| Main (S3/S4 `map()`, old shading) | 96 ms | 1.33 | 1.00 |
| Merged | 138 ms | 1.92 | **1.44** |

My shading adds 1.44x over main, inside the 1.5x target. But main's new `map()` already costs about 1.3x to 1.4x over the original in SwiftShader. The same merged shader with a sphere-only `map()` (scratch test, not committed) takes 87 ms, against 137 ms with main's `map()`.

The likely cause is software GL running both branches of a uniform-only condition, so `alertShapes()` (two distance functions plus a value noise) runs at every march step even when only the sphere is drawn. Rewriting the ternaries as `if` statements did not help. A real tablet GPU should branch on a uniform condition for free, but that is not verified.

If the tablet turns out slow, a cheap fix in `map()` (S3/S4 scope) is a compile-time `ALERTS` define: `blob.ts` would set it only while an alert shape is shown or morphing, at the cost of one shader rebuild (about 0.1 to 0.2 s) when an alert appears. The quality tiers lower the cost meanwhile: quality 0 is 1.72x the original.
