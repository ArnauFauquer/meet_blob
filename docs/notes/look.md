# The look: liquid metal meets lava lamp

What changed in the blob shading, why, what it costs, and what still looks weak. The earlier assessment is in `docs/notes/web.md` (section "The look").

Screenshots: `docs/screenshots/<state>-1280x800.png` and `-1024x768.png` (real flows against the mock backend). Motion: `docs/screenshots/motion/<state>.png`, 12 frames over 6 s each, plus `error.png` and `idle-night-dim0.35.png`.

## Starting point

The first version read as a glossy glass or soap bubble: a small simple studio, a fresnel mix with the background (so the centre was darker than the rim and the blob looked like a lens), and lava shapes too faint to see.

## Review round 1 (coordinator notes)

| Note | Change |
| --- | --- |
| Thinking lava was a flat circular disc, like a sticker | A slice through a lobe gave a disc with a flat fill. The lava samples now add up like light through a volume. Each sample has a soft halo outside the shape (exponential falloff) and gets brighter towards the core. Lobes are 1.4x taller than wide (rising wax) and of different sizes (0.45 to 0.81 of the lobe radius), and merge with a tighter blend. Thinking lava is a deeper hot orange, `[1.0, 0.3, 0.03]`, so it separates from the amber body. |
| Hard, straight-edged reflection plates in idle and listening | Every light is now a fully rounded panel or pill, with edges two to three times softer. The flow smear along the surface is about twice as strong (`0.06 + 0.45 amp`), so reflections bend and stretch with the liquid. |
| Empty dark lower third crossed by a hard horizon | The horizon blend is about four times wider. The floor reflects a pool of gel light that grows towards the bottom, and a low, wide gel light behind wraps coloured light round the lower rim. The lower half now reads as volume. |
| Keep the translucent rim, the lava colour per state and the calm motion | Unchanged. |

## What changed and why (first pass, updated by the review where noted)

| Change | Why |
| --- | --- |
| **Studio environment (`env()`).** A broad gel-tinted sky that brightens towards the zenith, a horizon set below eye level, a near-black floor with a dim pool of gel light, two black cards that cut the sky into bands, a large soft overhead key, a wide strip on the right, a gel rim strip behind on the left, one off-centre diffusion panel behind the camera, and two tiny hard lights for glints. Values above 1 are lights (HDR). | Chrome reads through contrast: broad bright areas against true blacks, split by a sharp horizon. Thin lines, like the first try's horizon line and thin strips, read as glass edges instead. The front panel fills the centre, so the blob reads as a mirror and not as a see-through lens. It is a single panel: two panels plus a floor strip made a smiley face. |
| **Gels.** Every light is tinted by the state colour. The key keeps about half of its white, so strong highlights go towards white. | Mercury under coloured gels. Each state keeps a clear colour identity, and highlights still read as metal. |
| **Material.** Schlick fresnel with a high base reflectance (`F = 0.68 + 0.32 (1 - n·v)^5`), a 30 % coloured reflectance that fades to white on hot highlights, and a trace of thin-film colour at grazing angles only. The background no longer shows through. | A dark, slightly translucent liquid metal, not a glass ball. |
| **Lava (`lavaDist()`, `lavaHeat()`, new `uLava` colour per state).** The same lobes that push the surface are shrunk, stretched upwards and merged into a distance field. It is sampled just under the skin (bulges glow through) and deeper along the ray, with the lobes pulled towards the centre, so blobs float inside. The samples add up; each has a soft halo and a brighter, slightly whiter core. The emission is compressed (`1 - exp(-x)`), so bright states never go flat white. Where the lava presses on the skin, the mirror thins a little. | This is the visible lava-lamp life: blobs rise, merge and split inside (see the contact sheets). The lava has its own colour, like the wax in a lamp. With the body colour alone, the idle lava was invisible, because blue is perceptually dark. |
| **Lobes (`uLobes[5]`, computed on the CPU in `tables.ts` `lobes()`).** Each lobe rises and sinks on its own slow cycle (faster up, lazier down) and circles the vertical axis. Golden-angle phases keep any two lobes out of step. They reach further than before, so they bulge the skin. | The surface becomes lumpy, liquid chrome metaballs. On the CPU it is about 25 % cheaper than per-pixel trig in SwiftShader, and a global array filled in `main()` was slower still. |
| **Flow-warped reflection (`reflection()`).** The normal leans along the upward surface tangent by a slow streak pattern, plus fine travelling ripples, as an analytic bump that only bends the normal. | Subtle anisotropic stretching and drifting of the reflections as the liquid moves, and fine glints, for one env tap. Three blurred taps ghosted visibly (triple horizon), so I dropped them. |
| **Surface ripples in the SDF.** Three crossed sines replace the slow value-noise octave. The level noise is evaluated only when the level is above 0, at a lower frequency. | Cheaper. The lower frequency makes speech swells wobble instead of crumpling like foil. |
| **Background halo.** A tight coloured glow plus a faint wide one, capped by `min(uGlow, 1.2)`. | Soft colour bleeding into near-black, without fogging the frame in bright states. |
| **Tables.** `lava` colour per state. Speaking `bright` goes from 1.3 to 1.15. The state colours and their meaning are unchanged. | |
| **Night dimming.** `BlobRenderer.dim` (0..1) multiplies `uBright`, and `blobDebug.setDim()` sets it. `idle-night-dim0.35.png` shows idle at 35 %. | A night mode only needs to set one number. Dimmed idle stays a calm violet with visible lava: no harsh contrast, no flash. |
| Kept | The `shape(p, id)` / `map()` contract and `mix(sdfA, sdfB, uMix)`, the bounding-sphere early exit, the 0.75 render scale, the 30 fps idle cap, `webglcontextlost` handling, the dither and the soft exponential tone map. `sphereShape()`'s body changed (lobes, ripples) but not its signature. |

## Quality tiers

The `QUALITY` define is set by `blob.ts` (`material.defines`, one shader rebuild per change).

| Tier | March steps | Lobes | Lava samples | Glints |
| --- | --- | --- | --- | --- |
| 2 (default) | 96 | 5 | 2 | yes |
| 1 | 72 | 4 | 1 | yes |
| 0 | 48 | 3 | 1 | no |

The page starts at 2. It keeps a moving average of the frame interval (factor 0.05) and drops one tier when the average stays above 50 ms (under 20 fps) for 4 s. It never goes back up, so it cannot oscillate. Calling `blobDebug.setQuality(q)` locks the tier; the screenshot and film-strip specs lock 2.

## Frame cost (SwiftShader, so only ratios matter)

This machine was shared with other sessions (load average 4 to 18), so sequential timings swung 2x from run to run. `web/scripts/shader-bench.mjs` compiles the shaders in one page, alternates frames between them, and syncs each frame with a 1-pixel readback. Below: 25 frames each, drawing buffer 960x600 (1280x800 at 0.75), compared with the shader before this work (commit `576a5b6`).

| Variant | Idle, min / median | Listening (level 0.7), min / median | Ratio to before (min) |
| --- | --- | --- | --- |
| Before | 74.0 / 78.2 ms | 89.9 / 92.8 ms | 1.00 |
| After, quality 2 | 105.9 / 113.3 ms | 125.0 / 134.4 ms | **1.43 idle, 1.39 listening** (medians 1.45, 1.45) |
| After, quality 1 | 96.8 / 104.0 ms | 112.9 / 118.3 ms | 1.31 / 1.26 |
| After, quality 0 | 89.8 / 94.2 ms | 101.4 / 108.2 ms | 1.21 / 1.13 |

These figures are after the review round. Before the review I measured 1.46x and 1.45x. The review changes first cost 1.54x; dropping a brightness gradient inside each light and a `sqrt` brought it back under the target.

    cd web && node scripts/shader-bench.mjs base=<(git show 576a5b6:web/src/render/blob.frag) cur=src/render/blob.frag q1=src/render/blob.frag:1 q0=src/render/blob.frag:0

The film-strip spec also prints a sequential figure per tier (`frame cost at 1280x800`). It is less reliable under load. The last run gave quality 2: idle 115.7 ms, listening 128.3 ms; quality 0: 94.0 and 105.0 ms.

Where the time goes (removal tests, idle): lobes about 20 ms for three of them, env about 10 ms, lava about 6 ms, surface ripple about 6 ms. The average march length did not change (about 8.4 steps per marched pixel, before and after). The extra cost is per step.

## The film strip

`web/e2e/motion.spec.ts`, run by `npm run screenshots`. `blobDebug.freeze(view)` stops the render loop and restarts the motion at zero. `blobDebug.step(dt, view, level, draw)` advances it by fixed 1/30 s steps. Each tile is read from the canvas in the same task as its draw. Listening and speaking use a deterministic speech-like level: phrases of about 1.7 s with 0.6 s pauses, syllables near 4.7 Hz with uneven stress. The level is printed on each tile.

## What still looks weak (honest)

- **Glass versus metal.** It reads as dark liquid metal with lava inside, but the translucent rim and the floating lava keep some glass-sphere feeling, especially in idle. Making it more opaque would lose the lava; I chose the lava. The softer lights (review round) trade a little of the crisp chrome sparkle for a more liquid look.
- **The horizon** is now soft, but it still crosses the blob slightly below the middle as a faint lip.
- **Lava contrast in bright states.** In speaking and thinking, the lava shows as soft, darker-orange or warm shapes rather than as bright glowing wax, because the body is already bright. In thinking, the lava often shows as one large soft oval: it is shaded and soft-edged, but not very elongated in every frame.
- **Idle motion is slow** by design (one lobe cycle takes about 30 s at idle speed). Six seconds of film strip shows drift and one merge or split, not a full lava cycle.
- **Speaking** pulses with the level through the lava glow (up to +45 % at full level) and the swells; the mirror itself does not brighten, so the pulse is moderate.
- The thin-film iridescence is barely visible: on purpose, but it adds little.
- **Not verified:** real tablet GPU frame time, colour on a real display, and how the motion feels at full frame rate. SwiftShader draws about 8 to 10 frames per second here, so I judged motion only from the contact sheets.
