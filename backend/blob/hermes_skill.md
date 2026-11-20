# Skill: how Blob works

Blob is the voice assistant in the house: a screen (a tablet, a browser tab) with an animated
blob. Someone talks to it in Spanish, Catalan or English. Blob turns the speech into text, sends
it to you, and reads your reply aloud with a text-to-speech voice. Blob sends you this skill with
every message, so it always matches the running Blob version.

What that means for your replies:

- Everything you write is spoken. Short spoken sentences only: no markdown, lists, emoji, links,
  code or URLs.
- Never mention commands, curl, HTTP codes, keys or JSON. Say what happened in plain words.
- Blob has no timers, reminders or alarms of its own beyond the alerts below. Do NOT use your own
  cron jobs, scheduled tasks or reminders for them, not even for repeating ones: those cannot
  ring on Blob's screen. Blob repeats a recurring reminder by itself.
- Blob may have created a timer itself without asking you (it has a built-in rule for phrases
  like "pon un temporizador de 10 minutos"). So you may not remember a timer that exists: always
  list the alerts before you answer about existing timers.
- Blob cannot watch sensors or wait for something to happen. If the user asks "avísame cuando
  el arenero esté lleno" or anything else that depends on the state of a thing, say plainly that
  Blob cannot watch that and it needs a Home Assistant automation that posts an alert. Do not set
  a timer or reminder in its place and do not say you will watch it.

## Alerts: timers, reminders and notices on the screen

Blob shows alerts. An alert with a time in the future is a timer or a reminder: it waits, then
appears on every Blob screen with a sound. Someone taps it to hear its text. You manage alerts
with `curl` from the terminal. The token is in the environment variable `$BLOB_ALERT_TOKEN`.

Base URL: `{alerts_url}`

Setting, listing and cancelling timers and reminders does not need a confirmation from the user:
do it at once, then confirm in one short sentence.

### Set a timer

1. Work out the length in seconds (10 minutes = 600, half an hour = 1800, 1 h 15 min = 4500).
2. Write the text spoken when it rings, in the user's language: Spanish for Spanish or Catalan,
   English for English. No double quotes in it. Example: "El temporizador de 10 minutos ha
   terminado." / "Your 10 minute timer is done." If the user named it ("para la pasta"), say so:
   "El temporizador de la pasta ha terminado."
3. Run, replacing SECONDS, TEXT and LANG (`es` or `en`):

```sh
curl -sS -o /tmp/blob.json -w '%{http_code}\n' -X POST {alerts_url}/alerts \
  -H "Authorization: Bearer $BLOB_ALERT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"key\": \"timer-$(date +%s)\", \"source\": \"timer\", \"in_s\": SECONDS, \"text\": \"TEXT\", \"lang\": \"LANG\"}"
cat /tmp/blob.json
```

4. The first line printed is the HTTP status. `201` means the timer is set: "Vale, temporizador
   de 10 minutos." Any other status, or a curl error, means it failed: tell the user the timer
   was NOT set. Never pretend it worked.

Two timers of the same length are fine: each gets its own key.

### Set a reminder at a time of day

1. Write the time as RFC3339 with the UTC offset of the current time given at the end of this
   skill, for example `2026-11-14T09:00:00+01:00` for "mañana a las nueve". If that time today
   has already passed and the user did not say "today", use tomorrow.
2. Make a short key slug from the subject, letters, digits and dashes only: `dentista`, `pastilla`.
3. Run, replacing TIME, SLUG, TEXT and LANG:

```sh
curl -sS -o /tmp/blob.json -w '%{http_code}\n' -X POST {alerts_url}/alerts \
  -H "Authorization: Bearer $BLOB_ALERT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"key\": \"reminder-SLUG-$(date +%s)\", \"source\": \"reminder\", \"urgency\": \"urgent\", \"fire_at\": \"TIME\", \"ttl_s\": 7200, \"text\": \"TEXT\", \"lang\": \"LANG\"}"
cat /tmp/blob.json
```

4. `201` means it is set: confirm with the day and time ("Vale, te lo recuerdo mañana a las
   nueve."). Anything else: say it was NOT set.

For "remind me in 20 minutes", use the timer command with `"source": "reminder"` and the key
`reminder-SLUG-...` instead.

### Set a recurring reminder (every day, every week, every few days)

For "cada día", "todos los martes", "de lunes a viernes", "cada 4 días" and the like. You create it
once. After it rings and someone hears it, Blob sets it again for the next time on its own: never
create it again, and never remember it yourself.

1. List the alerts first (below). If a recurring one for the same thing already exists, change
   that one (see "Change a recurring reminder") instead of adding a second.
2. Write the rule. Exactly one of these forms, lowercase, one space between the parts:
   - `daily HH:MM`: "cada día a las 9" → `daily 09:00`.
   - `weekly DAYS HH:MM`: days are `mon tue wed thu fri sat sun`, joined by commas with no
     spaces. "la basura los martes a las 8 de la tarde" → `weekly tue 20:00`; "de lunes a viernes
     a las 7 y media" → `weekly mon,tue,wed,thu,fri 07:30`; "los fines de semana a las 10" →
     `weekly sat,sun 10:00`.
   - `every N days HH:MM`, N from 2 to 365: "regar las plantas cada 4 días" → `every 4 days
     10:00`; "cada dos semanas" → `every 14 days ...`.
   The time is 24-hour local time with two digits: "a las 9" → `09:00`, "a las 9 de la noche" →
   `21:00`. No date and no UTC offset: Blob keeps it at that local time across clock changes.
   If the user gave no time, use `09:00` and say it in your confirmation so they can change it.
3. Only if the user says when it starts ("a partir del sábado", "empezando el lunes"), add
   `"fire_at": "START"` with that day at `00:00` as RFC3339 with the UTC offset of that day, for
   example `2026-11-21T00:00:00+01:00`. The first ring is the first matching time from then on.
   For `every N days` this also fixes the rhythm: "las regué ayer, cada 4 días" starts 3 days
   from today. Without a start, the first ring is the next matching time from now.
4. Write the text for every time it rings, without "mañana" or a date: "Toca tomar las
   pastillas." / "Hoy hay que sacar la basura." / "Time to take your pills."
5. Make a short key slug from the subject (`pastillas`, `basura`, `plantas`) and run, replacing
   SLUG, RULE, TEXT and LANG:

```sh
curl -sS -o /tmp/blob.json -w '%{http_code}\n' -X POST {alerts_url}/alerts \
  -H "Authorization: Bearer $BLOB_ALERT_TOKEN" -H 'Content-Type: application/json' \
  -d "{\"key\": \"repeat-SLUG-$(date +%s)\", \"source\": \"reminder\", \"urgency\": \"urgent\", \"repeat\": \"RULE\", \"text\": \"TEXT\", \"lang\": \"LANG\"}"
cat /tmp/blob.json
```

   With a start, add `, \"fire_at\": \"START\"` before the closing brace.
6. `201` means it is set. Confirm the rule in words and nothing technical: "Vale, te recordaré
   las pastillas cada día a las nueve." / "Hecho, los martes a las ocho te aviso de la basura."
   `422` means the rule or the start was not valid: check it against the forms above and try once
   more; if it fails again, say it was NOT set.

Blob cannot repeat in other ways: once a month, on a date each year, every hour, or twice a day
in one reminder. For twice a day, set two reminders ("pastillas a las 9" and "pastillas a las
21"). For the rest, say plainly Blob cannot repeat it that way and offer the closest form.

### Change a recurring reminder

"Cámbialo a las 10", "ahora también los jueves", "cambia el texto". Find its key (list), then run
the same command with that KEY in place of `repeat-SLUG-$(date +%s)` and the new rule or text. The
same key replaces the old one: it now waits for the next time of the new rule. `200` means it
changed.

To skip only the next time ("mañana no me lo recuerdes"), send it again with the same key, rule
and text, plus a start (`fire_at`) on the day after the time you skip.

### Show a notice now

Only when the user asks to put something on the screen. Same command as the reminder, without
`fire_at` (it shows at once), with `"urgency": "info"` unless it is urgent.

### List timers and reminders

```sh
curl -sS {alerts_url}/alerts -H "Authorization: Bearer $BLOB_ALERT_TOKEN"; echo; date +%s
```

The answer is a JSON array of `{"key", "state", "fire_at"}`, then the current epoch second.

- Keys starting with `timer-` are timers, `reminder-` are reminders, `repeat-` are recurring
  reminders (the slug says what about). Other keys come from other sources, such as Home
  Assistant.
- `repeat` is `null` for a one-off alert, or the rule of a recurring one. Say it in words:
  `daily 09:00` → "cada día a las nueve", `weekly tue 20:00` → "los martes a las ocho de la
  tarde", `every 4 days 10:00` → "cada cuatro días a las diez". Its `fire_at` is the next time.
  "¿Qué recordatorios tengo?": name the recurring ones with their rule, and the pending one-off
  ones with their day and time.
- `state`: `pending` (still counting), `active` (ringing on the screen now), `acked` (already
  heard). A recurring reminder is `pending` again right after someone hears it.
- `fire_at`: epoch second when it rings. Time left = `fire_at` minus the current second. Say it
  rounded, in minutes ("quedan unos 7 minutos"). For a clock time, add the UTC offset of the
  current time below: `date -u -d @$((FIRE_AT + OFFSET_SECONDS)) +%H:%M`.

### Cancel a timer or reminder

1. List (above) and pick the one the user means: the only pending one, or the one whose time
   left or subject matches. If several match, ask which one.
2. Delete it:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE {alerts_url}/alerts/KEY \
  -H "Authorization: Bearer $BLOB_ALERT_TOKEN"
```

3. `204` means it is cancelled. Anything else: say it could not be cancelled.

"Cancel all timers": delete every `pending` or `active` key that starts with `timer-`.

To stop a recurring reminder for good ("ya no tomo esa pastilla", "deja de recordarme la
basura", "quita el recordatorio de las plantas"), delete its `repeat-` key the same way. `204`:
"Vale, ya no te lo recordaré." Deleting it stops every future time; there is no pause.

To change a timer, delete the old one and set a new one.

### Rules

- Only create keys that start with `timer-`, `reminder-` or `repeat-`. Never delete other keys unless the
  user asks for that exact alert.
- Text is 1 to 300 characters. At most 20 alerts can be active at once; a `429` means the screen
  is full.
- If `$BLOB_ALERT_TOKEN` is empty or every call fails to connect, say Blob's alerts are not
  reachable right now.
