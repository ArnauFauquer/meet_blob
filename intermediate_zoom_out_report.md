# Goldfish Review Report (Stage 8, Intermediate Zoom Out)

**Target:** `/home/arnau/workspace/meet_blob/docs/designs/blob_design.md` (`lines 1-1018`)

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-zoom-out` | completed |

Caveats from the reviewer: it read the target and the report files in full but only ran two greps on `hermes-api-server.html` and none on the other `review_context/` pages. File counts (87 files; S1 = 47) are the reviewer's own count and unverified. No browser, Android, Kokoro or Hermes behaviour was verified.

## Summary

No Blockers. Document grew about 8% (939 to 1018 lines). The additions (failure table 175-184, Risks table 334-347, timeouts, session-header default) are small, sit at the right level, and are mostly sound.

1. **Altitude:** the line 541 boundary is clean. Detail leaks both ways (see finding 7).
2. **Growth:** S1 to S4 total 87 files (S0 adds 3 spikes). S1 alone is 47 files for "tap, talk, hear Hermes". The review rounds added S1 work and removed none. The first pass's main cut (plan size) was not acted on.
3. **First-pass findings:** 8 fixed or mostly fixed, 10 still open (one partly).

## First-Pass Status

| First-pass finding | Status | Evidence |
| --- | --- | --- |
| Plan too big; S1 exceeds slice 1 | OPEN | Files 7, 14, 20, 21, 57 and coverage gate (1010) unchanged. `pytest-cov` still missing from deps (609). |
| `first_sentence_split` and `seq/final` built but streaming deferred | OPEN | 260, 269, 629, 734, 468 |
| S2-S4 specified file by file | OPEN | Overview line 15 admits spike dependency. S2: 681-702, 863-935. S3: 940-970. S4: 696-704, 972-1002. |
| Hermes history vs session header | MOSTLY FIXED | Header is default (192); `API_SERVER_HOST` route question added (62). Residual in finding 6. |
| Voice timers contradict Alternative I | OPEN | 27, 38, 103, 220, 419-420, 701, 977 |
| Hermes timeouts contradict (`stream: false`) | FIXED | 164, 320. Dead config remains (finding 8). |
| Readiness probe vs "HTTP first" | OPEN | 308, 503, 878 |
| Follow-up listening | PARTLY | G4 contradiction fixed (36, 316). Heuristic and three knobs remain (167, 298, 320, 965). Now cited as a security mitigation (343). |
| Cancel is only an HTTP abort | FIXED | Disconnect and `/v1/runs` question in S0 (62, 562). Flag-based cancel at 173. Risk at 340. |
| Held alerts vs 1 s goal | OPEN | G6 (38), SC5 (498) have no exception. Hold at 109, 226. |
| Capture-format contradiction | FIXED | Stale open question gone. `MediaRecorder` / 16 kHz `AudioContext` offer not taken (161, 461); nit, let go. |
| S0 tablet stub blocks S1 | OPEN | 549 |
| Adaptive quality tiers | OPEN | File 74 (930-933) on top of fixed controls at 233 |
| three.js without a reason | OPEN | 124 |
| Docs sprawl | OPEN | Files 8, 9, 68, 79, 86, 87. `exit-tests.md` repeats Verification Plan (1011-1012). |
| Server-side wake rung | OPEN, recommend dropping | Author decided in Alternative H1; adding a rung adds scope. |
| Hermes cron or jobs question | OPEN (Nit) | Line 27 says Hermes is wrong place for timers. No S0 cron question added. Page lists Jobs API and `hermes cron` with delivery target (`hermes-api-server.html`, lines 402-407; unverified). |
| Small consistency items | MOSTLY FIXED | Fixed: `turn_start` (156, 744), "D57" (562), `wake` row order, version guard moved to S2 (file 72), WER note. Open: "re-created by sources" (313, 344) vs voice timers; unused-in-S1 `client_event`, `ping`, `hello_ok` (245-257); wake-word score in file 57 (846). |

## Prioritized Findings (Blockers -> Major -> Nits)

No Blockers.

### S1 is still 47 of 87 files, and the rounds added to it - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `541-1002`, `1010`, `290`
* **Discrepancy Description**: The first-pass cut list was not applied. S1 still carries SQLite, `turnlog`, `db.py`, diagnostics, CI, `mypy`, an 80% coverage gate over 9 modules, and `first_sentence_split` (unused). It also carries `seq/final`, `client_event`, `ping` and `hello_ok`, which nothing uses until later slices. New S1 work since the first pass: a `tts_fail` path plus beep file (58, 183); `timeout_kind` in log and tests (164, 664, 744); a fallback history class with injected-clock tests (654, 739); `tts_max_chars` truncation (165); diagnostics now spelled out in the spec (290). `blob.md` lines 93-98 list SQLite and diagnostics as out of slice 1 and in D70, so the design contradicts the brief without saying so. The brief's switch-to-option-A rule is about 6 weekends for S1 plus S2 (`blob.md` line 126, a judgment call).
* **Rationale & Recommendation**: Either cut S1 to `config`, `stt`, `tts`, `hermes`, `turn`, `main` (WebSocket handlers inside `main`) plus the page; log one JSONL line per turn; drop diagnostics, CI and the coverage gate; move SQLite to S4. Or amend `blob.md` slice 1 to say what was added back and why. Keep `first_sentence_split` and `seq/final` out of S1 unless SC1 misses. If the coverage gate stays, add `pytest-cov` to deps (609).

### S2-S4 are specified at file level before the spikes that decide them - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** files 25-29, 41-44, 61-87 (`681-702`, `863-935`, `940-970`, `972-1002`)
* **Discrepancy Description**: About 40 files, unchanged. A failed tablet test removes S3. A passing Hermes timer test removes `timer_rule.py` and its tests. The follow-up change added files 80-81 to a slice that may never run.
* **Rationale & Recommendation**: Keep S0 and S1 at file level. Reduce S2-S4 to one paragraph each: goal, components, exit test, gating spike. Expand a slice when it starts.

### Readiness on "models loaded" defeats the "HTTP first" startup - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `308`, `499`, `503`, `878`
* **Discrepancy Description**: An unready pod leaves the Service endpoints, so `/alerts`, the page and `/ws` are unreachable while models load. That contradicts SC6 and the grey-blob-while-warming rule. The Hermes fix at 339 does not address this.
* **Rationale & Recommendation**: Point both probes at `alive`. Expose `ready` only in the `/healthz` body and in `snapshot` (for example `models_ready`). One pod, one user: the weaker rollout signal is acceptable.

### Voice timers: Alternative I still contradicts CUJ 4 - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `27`, `38`, `103`, `220`, `419-420`, `701`, `977`, `1012`
* **Discrepancy Description**: Alternative I rejects Hermes-routed alerts ("no LLM in the path"), yet CUJ 4 makes Hermes the primary way to create a voice timer. The fallback rule is still "about 20 lines" but must handle number words in three languages (estimate, untested). Exit tests do not check the timer exists in Blob; Hermes could say "timer set" after a failed tool call.
* **Rationale & Recommendation**: Reword G6 and Alternative I: creating a timer by voice uses Hermes, firing and display do not. State whether the fallback covers digits only. Make the S4 exit test read `GET /alerts`. Add the cron S0 question (line 27) so the fallback may never be needed.

### Follow-up listening is now cited as a security mitigation - Severity: Major
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `167`, `298`, `320`, `343`, `965` (also described at `36`, `316`)
* **Discrepancy Description**: The mic opens after any reply ending in "?". That needs `wake{followup}`, `tts.followup`, `followup_max`, `followup_listen_s` and three new tests. The Risks table (343) lists it as the mitigation for voice-reachable Hermes tools. That is weak: a TV can answer "sí", and a model may ask without "?". The behaviour is described in four places.
* **Rationale & Recommendation**: Defer to Future Improvements and restrict the Hermes toolset instead, or mark the risk "accepted for a home LAN" without citing follow-up. If it stays, hard-code one follow-up turn, drop `followup_max` and `followup_listen_s`, and state the behaviour once.

### History fallback is built unconditionally; one claim overreaches - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `192`, `654`, `739`
* **Discrepancy Description**: Files 19 and 36 list the 6-pair history class and tests as normal S1 work, unlike conditional files 29 and 44. Line 192 says cancelled and errored turns "never enter history"; in header mode Hermes may record them (unverified).
* **Rationale & Recommendation**: Mark the history class and tests "build only if S0 shows the header fails". Reword 192 to cover Blob-side history only.

### Spec and plan leak across the line - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `231`, `269`, `164`, `320`; files 22, 80, 83, 84, 85
* **Discrepancy Description**: Spec holds `nextT = max(now, nextT) + duration` (269), the `mix()` march step of about 0.7 (231), `timeout_kind: hermes | turn` (164) and an env-var inventory (320) that file 6 repeats. The plan restates spec behaviour in files 22, 80, 83, 84, 85.
* **Rationale & Recommendation**: Move the `nextT` formula and `mix()` step to files 53 and 55. Drop the env-var list at 320 in favour of file 6. In files 22, 80, 84, 85 point to the spec section instead of restating.

### Timer and config sprawl; `stt_fail` language gap - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `164`, `179`, `320`
* **Discrepancy Description**: `hermes_no_bytes_s` is dead config in S1. Five timers exist: 30 s listening watchdog, 15 s client cap, 5 s connect timeout, 75 s Hermes total, 120 s turn watchdog; WebSocket close also releases the lock. `stt_fail` speaks "the fallback line for the detected language", but STT failed so no language exists.
* **Rationale & Recommendation**: Remove the dormant setting until streaming exists. State that `stt_fail` uses `es`. Consider one server watchdog counted from `tap`.

### `devices.json` and `/device-config` may be unnecessary - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `267`, `273`, `306`; files 26, 27, 48
* **Discrepancy Description**: Two devices need two flags. The page already stores device name and token from the install URL. Putting `sound` and `wake` in the fragment (`#t=…&device=tablet&sound=1&wake=1`) would remove `devices.py`, example JSON, the endpoint, its auth header and a test. Server never needs the flags: it broadcasts and each page decides locally. Untested; assumes no server logic depends on the flags.
* **Rationale & Recommendation**: Try the fragment-only approach first.

### SC1's "minus measured silence" needs capture code S1 lacks - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `494`
* **Discrepancy Description**: Subtracting silence from stop-tap time needs trailing-silence detection in the page. S1 has no VAD.
* **Rationale & Recommendation**: Define SC1 as stop-tap to first audio of the real reply. The 6 s target is already loose.

### Header-plus-binary pairing and its lock may be avoidable - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `237`, `260`; files 23, 38, 49, 60
* **Discrepancy Description**: The pairing rule exists only to stop a JSON header interleaving with its binary frame. It needs a per-connection server lock, client pairing code and tests. Round 2 (N4) said base64 inside JSON also works on a LAN.
* **Rationale & Recommendation**: Consider `{type: tts, turn, audio: <base64>}` for S1. Revisit binary frames if timings show a size or latency problem.

### Chime is specified but not planned - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `226`, `320`, `619`, `898`, `533`
* **Discrepancy Description**: Spec describes a chime file, `quiet_hours`, and "plays at turn end if still open". No plan file adds a chime asset or playback code.
* **Rationale & Recommendation**: Keep a simple chime with no sound during a turn, add the asset to a file, defer `quiet_hours` and queue-until-turn-end.

### Risks table lacks the schedule risk - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `334-347`, `486-490`
* **Discrepancy Description**: Section is the right size, but NFR security bullets repeat it. The 6-weekend rule and switch-to-option-A conditions live only in `blob.md` (126).
* **Rationale & Recommendation**: Add one row: "S1 plus S2 overrun; mitigation: switch per `blob.md` condition 6, tested at end of S1". Point the NFR security bullets at the table.

### Held alerts vs the 1 s goal - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `38`, `109`, `226`, `498`
* **Discrepancy Description**: The hold can last up to 120 s; G6 and SC5 have no exception.
* **Rationale & Recommendation**: Reword G6 and SC5 to "except during a turn". One-line edit.

### Still-open first-pass leftovers (carried, no new analysis) - Severity: Nit
* **Reviewer Lens:** `egm-zoom-out`
* **Affected Scope:** `549` (S0 tablet stub blocks S1), `124` (three.js without reason), `930-933` (adaptive quality tiers, file 74), files 8, 9, 68, 79, 86, 87 and `1011-1012` (docs sprawl), `846` (wake score), `313`, `344`, `245-257`, Hermes cron question (`27`)
* **Discrepancy Description**: See the status table above. Each was reported in the first pass and has not changed.
* **Rationale & Recommendation**: Apply the first-pass recommendations, or record in the document that they were considered and kept. The server-side wake rung stays rejected per Alternative H1; do not add it.
