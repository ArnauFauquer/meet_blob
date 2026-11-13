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
