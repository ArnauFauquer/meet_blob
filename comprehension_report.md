# Comprehension review: `/home/arnau/workspace/meet_blob/docs/designs/blob_design.md`

Mode: REVIEW. Feature range is lines 1-461 and detailed range is lines 462-939. The reviewer read the whole target and no other file.

## What this proposes

Blob is a self-hosted voice assistant meant to replace a smart speaker. A browser page (tablet PWA or desktop tab) draws a dark liquid-metal blob whose colour and motion follow the conversation state: idle, listening, thinking, speaking and error. The page also handles taps, the microphone and audio playback. A single Python/FastAPI backend in one GPU pod does speech-to-text (faster-whisper) and text-to-speech (Kokoro). It also holds the conversation state machine and a SQLite store of alerts and timers. It asks Hermes Agent for answers through Hermes's OpenAI-compatible HTTP API. External sources (Home Assistant, Hermes, curl) push alerts to `POST /alerts`. The page then shows an open alert as a shape (shape by source, colour by urgency) until a tap reads it aloud and clears it.

The work is split into slices. S0 runs two spikes (a Hermes test and a tablet test). S1 is tap-to-talk on the desktop, S2 is the tablet and Kubernetes deployment, S3 is the hands-free wake word and S4 is alerts and timers. Lines 462-939 list 87 numbered file changes, a build order and a verification plan.

## How the existing system works, per this document

Hermes Agent is the "brain". It already has its own voice mode and wake word, but only in its CLI, TUI and desktop app, not in a browser. It handles Home Assistant through its own integration. It cannot push messages to clients. It can only act as an HTTP caller, and whether it can call Blob with a bearer token is untested. Voice Satellite and Kiosk Satellite already provide a tablet wake word and voice loop, but only inside Home Assistant, with CSS-only skins. The author's homelab already has a Kubernetes cluster with an NVIDIA GPU (unconfirmed), cert-manager, internal DNS and an ingress. The only fixed facts about Hermes are its endpoint shape and that it may forward text to an external model provider. Most behaviour (sessions, system message, streaming during tool use) is explicitly unverified.

The reviewer could paraphrase every section. No Blockers.

## Findings

**1. Major. Undefined reference "D57" (line 483).**
File 1 says "Records which of D57's two branches applies (Hermes tool or the transcript rule)". No "D57" exists anywhere in the document. A reader can guess it is a decision ID from a source document, but the guess is not supported.

**2. Major. "SC1", "SC4", "SC5", "SC6" are never defined (lines 428-434, 645).**
The labels look like "success criteria", but there is no SC section. SC2 and SC3 are missing. SC1 duplicates G9, SC5 duplicates G6, and SC6 duplicates the startup bullet. Say what SC means, or use the G numbers.

**3. Major. `turn_start` is not a defined message (lines 150, 665).**
The doc says "The backend answers `busy` to a second `turn_start`" and the test list says "A second `turn_start` gets `busy`". The protocol table (lines 219-234) has no `turn_start`, only `tap` and `wake`. File 22 uses `start(device)`. A reader cannot tell whether `turn_start` is a wire message, an internal method or a synonym for `tap`.

**4. Major. Error state vs fallback speech ordering conflicts (lines 111, 146, 158).**
- CUJ 6 says the blob goes grey for about 3 s, then speaks the fallback line, then returns to idle.
- The state table says `error` is entered when the turn ends with a non-`ok` reason.
- Step 5 says the fallback is spoken before the turn ends with `hermes_fail`.
- So the fallback plays either before `error` (during `speaking`) or during it. The doc does not say which.
- The 3 s count also has no stated start point, and it is unclear whether `error` is held through the fallback audio.

**5. Major. Hermes total timeout (120 s) exceeds the turn watchdog (90 s) (lines 143, 150, 158, 590).**
The 90 s turn timeout releases the turn and ends it, so the 120 s Hermes total timeout can never fire. The `timeout` reason is then ambiguous. It could come from either the 90 s watchdog or the Hermes timeout, and the doc does not say which. The no-bytes timeout (30 s) and connect timeout (5 s) are fine.

**6. Major. G9/SC1 metric cannot be computed as written (lines 39, 428, 645).**
It is "median time from last voiced frame to first audio". Audio is not streamed (line 155): the server receives it only after the second tap. The doc never says how "last voiced frame" is located. It could be a position in the PCM, or a client timestamp. It also does not say whether the silence between the last word and the stop-tap counts. G9 says the median is reported over 20 turns, while the S1 exit test uses 10 turns (lines 31, 932).

**7. Major. "Server-side voice filter" is undefined (lines 156, 565).**
It is "language auto-detect, one pass, the server-side voice filter on". A reader may guess this is the faster-whisper VAD filter, but nothing says so. Name it or say what it does and what it drops.

**8. Major. G4 is contradicted by follow-up listening (lines 34, 161, 264, 282).**
G4 and the privacy section say audio leaves a device only after a tap, a key or the wake word. Follow-up listening opens the microphone for 6 s with no tap or wake word. The doc treats this as acceptable ("the 6 s limit bounds that cost") but never lists it as an exception to G4. Also, "a key" is never defined. It could mean a keyboard key, a hardware button, or the "tap or button mode" of line 265.

**9. Major. Chime and quiet hours are both in scope and deferred (lines 206, 286, 455, 540).**
Display rules (line 206) describe chimes that play at turn end, and `quiet_hours` mutes them. `quiet_hours` is in Configuration, and S4 adds it to `config.py`. Future Improvements (line 455) lists "Chime and quiet hours for urgent alerts, repeated every 2 minutes" as deferred. A reader cannot tell whether S4 ships a chime. The sound itself (which file, who plays it) is also not described.

**10. Major. Audio-locked tap behaviour conflicts with the tap table (lines 242, 246-254).**
Line 242 says that while audio is locked "a tap in that state only unlocks audio and clears nothing". The tap table's last row says that in `idle` with no alert, a tap starts a turn. The doc does not say whether a tap while locked in `idle` or `listening` starts a turn or only unlocks. How the page detects "locked" is also unstated. The table's "(and audio is unlocked)" qualifier appears only on the alert row.

**11. Major. Version mismatch handling has no wire contract (lines 269, 595, 844).**
The page reloads "on a version mismatch in `hello`". The protocol table has no server reply to `hello`, and the `error` codes list only `busy` and `4401`. It is not stated who compares the versions or how the page learns of a mismatch. File 23 says the hub "validates version", but no message carries the result.

**12. Major. How a browser learns its device name is unspecified (lines 242, 263, 610, 722).**
`GET /device-config?device=<name>` and `hello{device}` both need a name. The config file (file 48) says the name is "loaded from `/device-config`", which is circular. The page needs a name before it can ask. Nothing says whether it comes from the URL, `localStorage` or a prompt. Whether `/device-config` needs `DEVICE_TOKEN` is also not stated, although the page calls it before or around `hello`.

**13. Major. Whether `acked` alerts are still shown is not stated (lines 189, 198, 206, 194).**
`acked` rows stay in the table for 24 h and are included in `snapshot.alerts[]`, since it carries the list. Display rules say "top alert" without saying that `acked` rows are excluded. "Clear" (lines 99, 202, 908), `alert_ack` and `DELETE` are used for related but different things. The doc should say that a tap sends `alert_ack` and that the client hides `acked` rows.

**14. Nit. "Marked late" has no field (lines 189, 198).**
Overdue timers are "marked late", but the `alerts` table has no `late` column. Say where the mark is stored, or whether it affects display.

**15. Nit. Unspecified alert-cap behaviour (line 194).**
"Limits: 20 active alerts." gives no response code or eviction policy for the 21st alert. Is it rejected, or does it replace the oldest? The sentence is also an incomplete "Limits".

**16. Nit. `ttl_s` for pending alerts (lines 188, 198).**
"Counts from activation" is clear. "Rows are deleted ... when `ttl_s` expires" is not clear for a `pending` row that has no activation time.

**17. Nit. Unexplained terms and one-off references.**
- Line 87: "The blob flashes" for the wake word has no entry in the display tables.
- Line 93: "Hands-free mode is on" refers to a mode with no stated switch.
- Line 903: "Urgency colours as approved" refers to an approval that is not recorded here. Line 211 only says "green or blue" and "red or magenta".
- Line 307: Alternative A points to "the switch conditions in `docs/designs/blob.md`". That is an external document, though a shorter fallback order is repeated at line 265.
- Line 300 and line 438: "review rounds 1 and 2", "review_round2.md" and "reviewer memory" point to history the reader does not have.
- Kiosk Satellite (line 21) has no link.
- NG11 "stop phrases" and "second wake phrase" are not explained in that section.

**18. Nit. Slice vocabulary introduced late (lines 15, 464).**
The Overview names four slices and two tests. "S0" and "kill rule" appear only in the Detailed Plan. The first use of S0 should say it is the pair of spikes from line 15. "Timer" and "alert" are treated as separate in the Overview, and only the alerts table (`source=timer`) shows that a timer is an alert.

**19. Nit. Duplicate and split file entries (lines 590-595, 883-886, 749-757, 851-854, 900-903).**
File 22 and file 80 both describe `turn.py` S3 changes. Files 54, 74 and 83 split changes to the same renderer files. File 22 also says S4 adds "a hold on alert display ... (the hold itself is client-side)". That sentence reads as a backend change but describes a client one. The numbering note at line 468 covers order but not this overlap.

**20. Nit. Config items missing from the Configuration section (lines 286, 161, 886).**
`followup_max` and `followup_listen_s` appear in the Technical Plan and file 80 but not in the Configuration list. Also, `.env.example` (file 6) is said to cover "every environment variable from the Configuration section", so these would be missing from it.

**21. Nit. The turn id is learned implicitly (lines 154-155, 228).**
The client must put `turn` in `utterance`. Step 1 creates the id, and `state{conv, turn}` is presumably how the client gets it. That is not said. `state` and `snapshot` overlap, since `snapshot` is said to be sent "on every change" while `state` is also sent. When each is used is unclear.

**22. Nit. G6 "within 1 s" vs held alerts (lines 36, 105, 206).**
G6 and SC5 say an alert shows within 1 s. Display rules hold alerts hidden during a turn. CUJ 5 states the exception, but G6 and SC5 do not.

Not checked: nothing outside the target, as instructed.
Risk: the "last voiced frame" reading in finding 6 is the reviewer's interpretation, so confirm it with the author.
