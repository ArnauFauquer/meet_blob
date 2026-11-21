# The look: liquid metal meets lava lamp

What changed in the blob shading, why, what it costs, and what still looks weak. The earlier assessment is in `docs/notes/web.md` (section "The look").

Screenshots: `docs/screenshots/<state>-1280x800.png` and `-1024x768.png` (real flows against the mock backend). Motion: `docs/screenshots/motion/<state>.png`, 12 frames over 6 s each, plus `error.png` and `idle-night.png`. Night mode: `docs/screenshots/night-<size>.png` (the day counterpart is `idle-<size>.png`).

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
| **Dimming.** `BlobRenderer.setDim(source, v)` per source; the lowest wins and scales `uDim` (see Night mode below). | Night mode and any other dimmer each set their own number without overwriting each other. |
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

## Idle clock

After 5 minutes of unbroken idle (`CLOCK_AFTER_MS`), the blob rests as a digital clock. Any other view (a tap, the wake word, an alert, an error) brings the blob back.

| What | How |
|---|---|
| Body | Shape 3 (`clockShape()`): a wide pill of the same liquid metal, 1.3 times larger than the blob so it reads from across the room. It uses the same shape morph as the alerts (`uMix`, 0.8 s), so the sphere flows into the pill and back. On a narrow screen it shrinks to fit. |
| Digits | `clockDist()`: HH:MM (24 h, local time) as seven-segment strokes, drawn like the face: a near white lava core over a dark patch of mirror. The face distance is mixed into the digit distance with the morph, so the eyes and the mouth melt into the digits and back. |
| Minute change | `uDigitsPrev` and `uTick`: the distance to the old digits is mixed into the new ones over 0.6 s. Only the strokes that change melt and grow back. |
| Look | `CLOCK_LOOK`: the idle colours with a calmer surface (`amp` 0.04), so the digits stay readable. Night dimming applies as in idle. |

Screenshots: `docs/screenshots/clock-1280x800.png` and `-1024x768.png` show the time of the run.

## Character: body motion

The shapes used to sit still once a morph ended. `animateBody()` in `blob.ts` now moves the whole body, on top of the look. The shader marches the ray in the body frame: one matrix `uBody` (turns and flips, jelly lean, squash and stretch) and an offset `uBodyPos`, applied once per pixel, so `map()` does not pay for it.

| What | How |
|---|---|
| Squash and stretch | A damped spring (2.6 Hz, damping ratio 0.22) at constant volume. Kicked by the crouch before a morph, the landing after it, every alert landing, each new minute on the clock, any other change of view and the acts. |
| Jelly lean | A second spring: the top lags behind sideways moves (a shear in `uBody`). |
| Morph | The body hops (0.22), stretches in the air and makes one full twirl (`stepTwirl()` in `morph.ts`). A morph reversed mid-way unwinds the twirl. |
| Acts | `acts.ts`: little scenes with anticipation, landing and expression (lids, happy eyes, mouth), chosen at random from a repertoire per mood. Idle: look to a side, look around, curious tilt, yawn, doze, dance, hops, backflip, spin jump, peek. Info alert: hops, dance, peek, flips. Urgent: panic, peek, hops (never a pleased face). Thinking: ponder, compute (eyes run like reading), foot tapping, loading orbit, turn the idea over, effort, eureka, stare at the ceiling, dizzy. Clock: hops, dance, tilt, flips, every 7 to 14 s. Any other view stops the act and fades its pose out in about 0.15 s. `blobDebug.act(name)` starts one. |
| Alerts | Rounder bodies: an exact rounded triangle prism and a rounded box. Three lava lobes push bumps out of their faces and edges, and the sphere's ripples run over them. Between acts they jump with the pulse and rock; `urgent` also trembles. |
| Clock | It floats, rocks and sways a little. The digits ride a slow wave (`uDigitY`), the colon beats once a second (`uColon`), and the lava lobes press on the pill. |
| Eyes | Between acts the eyes dart to a new point every 1.2 to 4 s, often back to the centre. |

Contact sheets in `docs/screenshots/motion/`: `clock`, `alert-timer-info`, `alert-square-urgent`, `morph-to-triangle`, `morph-to-clock`, `act-backflip-square`, `act-look-around`, `act-doze`, `act-spin-triangle`, `thinking-acts`. Frame cost in SwiftShader at idle: 219 ms against 207 ms on main (+6%): software GL evaluates the alert shapes on every step even when the sphere is shown. A GPU skips them (uniform branch).

## After the merge with main (S3/S4)

- **Alerts.** Alerts use the same shading, with a lava colour from `ALERT_LAVA`. Their flat faces get stronger flowing ripples in the reflection (`faceted`), so they do not mirror one flat colour.
- **Cost.** The merged shader costs 1.92x the original at idle in SwiftShader: 1.44x from this shading on top of main's new `map()`, which already costs about 1.33x. If the tablet turns out slow, a cheap fix in `map()` is a compile-time `ALERTS` define: `blob.ts` would set it only while an alert shape is shown or morphing, at the cost of one shader rebuild (about 0.1 to 0.2 s) when an alert appears. The quality tiers lower the cost meanwhile: quality 0 is 1.72x the original.
- **Load.** Compile, link and first draw take 277 ms: no load-time stall.

## Night mode

`NIGHT_HOURS` (for example `23:00-07:30`, browser local time) reaches the page as `night {start, end}` in `/device-config`. The schedule and the alert rule live in `web/src/night.ts`; `main.ts` only hooks them up.

| What | How |
|---|---|
| Asleep | At night, once nothing has happened for `NIGHT_AWAKE_MS` (20 s), the idle blob sleeps. A tap or the wake word wakes it at once (the dim lifts in about 0.3 s) and it answers as usual; 20 s after the turn ends it falls asleep again (a 2.5 s fade). A turn, an alert being read and a ringing alarm keep it awake. |
| Darker | `setDim('night', NIGHT_DIM)`, 0.2. The dim scales the light after the tone map (`uDim`), so the glints dim as much as the body: the brightest pixel goes from 255 to about 122 (sRGB), the mean of the frame from 34 to 14. Dimming `uBright` before the tone map (the first try) left the highlights almost as bright. The countdown and the fault line fade to 40 % (`body.night`). |
| Slower | `setMaxFps('night', NIGHT_FPS)`, 10 fps instead of 30. The lowest cap of all sources applies in every view, so a source must let go (`Infinity`) when something happens; night mode does so as soon as it wakes. |
| Look | `SLEEP_LOOK`: the idle colours a little deeper, less glow, a third of the flow, a slow shallow breath, the eyes half shut (`eyeH` 0.045) looking slightly down, a soft smile. The eyes barely wander. Acts: `snooze` (the eyes fall shut, the head nods forward and settles back, no start and no kick) and now and then a `yawn`, every 20 to 45 s. |
| Clock | No clock and no weather strip at night: the blob sleeps instead. Bright static digits all night are the worst case for screen wear, and nobody watches. Asking "hey blob, ¿qué hora es?" still works. |
| Alerts | Only urgent alerts show and ring at night (timers are urgent by default). Info alerts stay in the snapshot but are hidden; they never ring, and appear silently when the night ends. An info alert that was ringing when the night begins goes quiet. An urgent alert wakes the blob while it rings and for 20 s after; then the red shape stays on screen, dimmed and at 10 fps. |

`QUIET_HOURS` and `NIGHT_HOURS` are separate settings, and both stay:

| | `QUIET_HOURS` (S4, older) | `NIGHT_HOURS` (night mode) |
|---|---|---|
| Sound | Mutes every alert sound in the window: timers and urgent alerts too | Only urgent alerts ring (timers are urgent by default) |
| Screen | Unchanged: every alert shows, the blob is as bright as by day, the clock comes | The blob sleeps (dim, 10 fps, no clock); info alerts are hidden until the night ends |
| Served as | `quiet_hours` string | `night {start, end}` or `null` |

Use `NIGHT_HOURS`. If both are set and overlap, `QUIET_HOURS` still mutes the urgent alerts in its window: leave it empty unless that is what you want.

Not verified: the tablet's real backlight. A web page cannot change it, so on an LCD tablet dark pixels cut screen wear and GPU heat but not the backlight; use the tablet's own night schedule or adaptive brightness for that. Frame time on the tablet at 10 fps is not measured either.
