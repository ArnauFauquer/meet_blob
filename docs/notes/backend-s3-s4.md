# Backend notes for S3 and S4: decisions and deviations

Where the design (`docs/designs/blob_design.md`) left a choice open, the backend took the simplest
option consistent with it. The S1 notes are in [`backend.md`](backend.md).

## Scope

*   **Built:** `alerts.py` (store, `POST`/`GET`/`DELETE /alerts`, scheduler), the `alerts` table
    (`user_version` 2), `ALERT_TOKEN`, `timer_rule.py` behind `TIMER_RULE`, `wake` gated by
    `devices.json`, `tts.followup` with the `FOLLOWUP_MAX` chain guard, `alert_read` and
    `alert_ack`, `snapshot.alerts[]`, `docs/alerts.md`, `scripts/e2e_alerts.py`, `--wake` and
    `--expect-followup` in `scripts/e2e_turn.py`, a `timer_es.wav` clip, and a `question` mode in
    the fake Hermes.
*   **Not built (page side, or not backend):** the 6 s, 8 s and 15 s listening limits, the wake
    word, the chime, quiet hours, shapes. `QUIET_HOURS` is only served by `/device-config` (as in
    S1).

## Configuration

1.  **`ALERT_TOKEN` is required**, as the design's Configuration table says. Startup fails without
    it. `README.md` and `.env.example` were updated; the deploy secret already has it.
2.  **`TIMER_RULE`** (default `on`, accepts `on`/`off`/`true`/`false`/`1`/`0`) and
    **`FOLLOWUP_MAX`** (default 3, `0` disables follow-ups) are new settings.

## Alerts store and API

3.  **Rows live in SQLite and in a dict mirror.** Every mutation takes one asyncio lock, writes to
    SQLite first (in a thread), then updates the mirror and broadcasts a snapshot. A snapshot is
    built from the mirror with no database call.
4.  **Times are whole epoch seconds.** `in_s` and float `fire_at` are rounded. A 2 s timer fires
    after 1.5 to 2.5 s plus at most 250 ms of scheduler sleep.
5.  **Re-raising an acked alert:** a changed payload (or any `in_s`) makes it `active`, or
    `pending` when its new time is in the future. The design says "back to active"; a future time
    staying in the future seemed the only sensible reading.
6.  **Updates of pending and active rows** follow the time: a due time makes the row `active`, a
    future time makes it `pending` (an active row moved to the future goes back to pending). An
    active row that stays active keeps its `activated_at`, so the page does not chime again for a
    changed text.
7.  **The cap of 20 counts `active` rows only.** A POST that would make a row active (new, re-raised
    or moved to now) gets 429 at the cap; an update of a row that is already active does not.
    Pending timers that fire while 20 are active are still activated, so the screen can briefly
    hold more than 20.
8.  **Validation beyond the contract table:** unknown fields get 422 (a typo such as `fire_in`
    would otherwise fire the alert at once); `source` is limited to 64 characters and `lang` to 16;
    `fire_at` must be between 0 and 10¹¹, `in_s` within ±10⁹ and `ttl_s` within 1 to 10⁹, so huge
    numbers cannot reach SQLite. `NaN` and `Infinity` (not valid JSON, but Python's parser accepts
    them) are refused by validation, but FastAPI's error renderer cannot serialise them and
    answers 500; no row is stored.
9.  **`GET /alerts` returns `{key, state, fire_at}`** for every row in any state, as the design
    says ("the same objects"). A source that wants to cancel a timer picks it by `fire_at`.
10. **Late timers** (due during downtime) get `activated_at = fire_at`, so `ttl_s` keeps counting
    from the time they were due, and a second restart does not fire them again.
11. **`snapshot.alerts[]` is sorted oldest first** (`activated_at`, then key). The page still
    computes the top alert itself.
12. **Alert changes broadcast `snapshot` only.** `state` stays for turn transitions (design: "state
    is sent only for turn transitions").
13. **Scheduler:** one task that ticks at least every 250 ms. Each tick activates due timers and
    deletes rows whose `ttl_s` ran out and rows acked 24 h ago. It scans the mirror (a few rows),
    so the "sleep until the earliest `fire_at`" of the design is `min(250 ms, time to next)`.

## WebSocket

14. **`alert_read`** needs an `active` key and no open turn, else `error{bad_message}`. While the
    models load it gets `error{not_ready}`. A synthesis failure also gets `error{bad_message}`:
    the contract has no code for it, and the page's rule ("keep the alert, play the beep, send
    nothing") applies to any error answer. Reported to the coordinator. Synthesis runs under the
    GPU lock in that connection's receive loop (about 0.5 s on the CPU).
15. **`alert_ack`** of an unknown, pending or already acked key is ignored silently: two screens
    acking the same alert is a normal race.
16. **`wake`** from a device that is not `wake=true` in `devices.json` (including a device missing
    from the file) gets `error{bad_message}`. Otherwise it is exactly a `tap` (`not_ready`, `busy`).
    The `followup` field is accepted and not checked; the server does not require a prior
    follow-up reply.
17. **`tts.followup`** is set as the design says, whatever the owner device. A desktop page
    (`wake=false`) must ignore it, because its `wake{followup: true}` would get `bad_message`.

## Follow-up chain (`turn.py`)

18. The counter counts follow-up flags sent in a row. A reply that ends with `?` gets
    `followup: true` while the counter is below `FOLLOWUP_MAX`. Any turn that does not end `ok`
    with a reply ending in `?` (an `empty` follow-up, a cancel, a failure, a timer confirmation)
    resets it. So does a turn that starts more than 10 s after the previous one ended. A `?`
    reply at the cap keeps the counter at the cap, so the chain stays closed until one of the
    resets.

## Timer rule

19. **Built and on by default**, because whether Hermes can call `/alerts` is untested. It runs on
    the transcript after the empty check and before Hermes. Words: `temporizador`,
    `temporitzador`, `timer`. Numbers: digits (also `1,5` and `1.5`) and the words for 1 to 10 in
    Spanish, Catalan and English (`un`, `una`, `dues`, `a`, `an`, ...). Units: seconds, minutes,
    hours in the three languages. Halves: `media hora`, `mitja hora`, `half an hour`, `y media`,
    `i mig`, `and a half`. Several amounts add up ("1 hora y 15 minutos").
20. **Phrases that go to Hermes instead:** cancel, change, stop, delete and "how much is left"
    words, and negations (`no`, `not`, `don't`). `para` is not excluded: in Spanish it is also
    "for" ("un temporizador para 5 minutos").
21. **The confirmation is synthesised at turn time** from a fixed template ("Vale, temporizador de
    N minutos." / "Okay, N minute timer."), because N varies; the design's "pre-rendered" is read
    as "fixed text, no Hermes". English for `lang=en`, Spanish for everything else (Catalan gets
    Spanish, like `voice_for`). N uses the largest unit that divides evenly (90 s is "90
    segundos", 1.5 h is "90 minutos").
22. **The timer alert** has `source=timer`, `urgency=urgent`, key `timer-<unix time>`, and the text
    "El temporizador de N minutos ha terminado." / "Your N minute timer is done.".
23. **If creating the timer fails**, the transcript goes to Hermes. A cancel that arrives after the
    timer was created leaves the timer in place.
24. The turn ends `ok` with `hermes_ms: null`. A `{"kind": "timer_rule", "turn", "key", "in_s"}`
    line (no text) is printed next to the timing line.
25. Two timers created in the same second (by voice impossible, a turn takes seconds; by Hermes
    possible) share a key and the second updates the first. The design fixes the key format.

## Database

26. The `alerts` table is created with `CREATE TABLE IF NOT EXISTS` on every open and
    `user_version` is raised to 2 only when lower, so an S1 file opens with S4 code (tested) and a
    newer file keeps its version.
