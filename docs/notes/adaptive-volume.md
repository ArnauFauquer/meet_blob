# Adaptive volume (page)

Blob speaks softly at night and a little louder over a noisy room, with no setting to touch.
Everything is in the page: `web/src/audio/noise.ts` (background noise estimate),
`web/src/audio/volume.ts` (night curve, gain curves, debug parameters) and `web/src/audio/playback.ts`
(where the gain is applied, plus a peak limiter). `main.ts` only wires them together.

## How it works

```
gain (dB) = curve.nightDb × nightness(local time) + boost(background noise)
```

| | Voice (replies, alert reads, `tts_fail` beep) | Chime (alarm bubbles, alert-read beep) |
| --- | --- | --- |
| Deep night | −9 dB | −6 dB (a timer must still wake someone) |
| Noise boost | 0 dB at ≤ −56 dBFS → +6 dB at ≥ −32 dBFS | 0 → +9 dB over the same range |
| Cap | +6 dB | +9 dB |

The boost is linear in dB between the two noise levels and adds to the night drop (a TV at
23:30 gives about −9 + 4 dB).

**Night.** Default window 22:00–08:00. The volume eases down over 45 min after the start and back
up over 45 min before the end (smoothstep), so it never moves more than 0.3 dB per minute;
outside the window it is the day volume.

**Background noise.** Every 20 ms microphone block (the hands-free stream, or the recording of a
tap turn on a tap-only page) gives one RMS level in dBFS. Blocks are skipped while Blob makes any
sound (reply, read, chime, beep) and for 600 ms after it (echo), and while the voice-activity
detector hears speech. The estimate is the 20th percentile of the last 8 s of the remaining
blocks: a hood, a dishwasher or a TV sets it; a door, a cough or "hey jarvis" fill too few blocks
to move it. A lasting change shows after about 6.4 s going up and 1.6 s going down (it prefers
not to boost when in doubt). Less than 0.6 s heard, or nothing heard for 5 min: no estimate, no
boost.

**No jumps.** The voice gain is taken when a reply (or read, or beep) starts from silence and kept
for all of it, including chunks queued behind it. Each chime ring takes one value when it starts.
The alarm's own swell (35 % → 100 % over 12 s) is unchanged and multiplies with it.

**No clipping.** All of Playback's output goes through a `DynamicsCompressorNode` used as a peak
limiter (−3 dBFS, ratio 20, knee 0, attack 1 ms, release 150 ms). Chromium adds a fixed makeup gain
of 0.6 × 3 × (1 − 1/20) = 1.71 dB (Web Audio spec; measured), which a gain in front of it takes
back off, so at 0 dB nothing changes (measured in headless Chromium: Kokoro's peak goes through
unchanged). With +6 dB on Kokoro the peak stays at −0.3 dBFS and speech loses 0.1–0.2 dB RMS to the
limiter. The bubbles are peakier: at +9 dB the limiter shaves their attack and they gain about
+7 dB RMS rather than +9.

## Trying it by hand

Page parameters (combine them):

| Parameter | Effect |
| --- | --- |
| `?volume=debug` | logs `client_event` `kind: "volume"` (backend standard output) and `console.debug`: `event: "estimate"` every 2 s while the mic delivers audio, `event: "apply"` for each sound that starts, with `noise_dbfs`, `night` (0..1), `voice_db`, `chime_db`, `gain_db` |
| `volume_at=23:30` | pretends this is the local time (to hear the night curve by day) |
| `volume_noise=-35` | pretends this is the background noise in dBFS (to hear the boost in a quiet room) |

The diagnostics view (long press) and the 10 s `mic` log line also show `volume`
(`noise_dbfs`, `night`, `voice_db`, `chime_db`); `window.blobDebug.volume` has the same.

Calibrating on the tablet: open `/?volume=debug`, read `noise_dbfs` in a quiet room, then with the
hood, the dishwasher and the TV at a normal level, and set `NOISE_QUIET_DBFS` / `NOISE_LOUD_DBFS`
in `volume.ts` so that quiet stays at 0 dB and the loud cases get most of the boost.

## Joining the night mode

`nightWindow()` in `volume.ts` (marked `UNIFY(night-mode)`) reads `/device-config` `night`:
`{start: "HH:MM", end: "HH:MM"}` uses that window, `null` means no night (no night drop), a
missing field uses the default 22:00–08:00. When the night mode lands, the default can go and the
night window comes only from there; the volume keeps its own curve (`nightDb`, `RAMP_MIN`).

## Not verified

*   **The noise levels are guesses.** The page measures the microphone after Chrome's
    `noiseSuppression` and `autoGainControl` (on, for the wake word and speech to text).
    Suppression removes most of a *stationary* noise such as a hood or a dishwasher, so they read
    lower than they sound; a TV or music passes. The thresholds must be set from the tablet's
    `?volume=debug` readings. If the hood still reads too low, the next step is a second,
    unprocessed track for the measurement only (Chrome support for two processing settings on one
    device needs checking on the tablet).
*   On a tap-only page the estimate comes only from tap recordings (the mic is closed otherwise)
    and is forgotten after 5 min.
*   Audible result on the tablet's speaker; headless audio is muted. The levels were checked by
    rendering the real `Playback` graph in an `OfflineAudioContext` in headless Chromium.
*   Replies streamed as several chunks keep the first chunk's gain; a later, louder chunk is
    caught by the limiter.
