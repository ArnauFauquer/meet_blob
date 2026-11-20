# Alerts API: how a source raises, updates and clears an alert

Any program that holds `ALERT_TOKEN` can put an alert on every Blob screen: Hermes, a Home
Assistant automation, a cron job. A timer is an alert with a time in the future. This page is the
contract and the copy-paste text for each source.

*   Inside the cluster: `http://blob.blob.svc.cluster.local:80`
*   From the home network: `https://<blob host>` (the ingress routes `/alerts` too)
*   Every request needs `Authorization: Bearer <ALERT_TOKEN>`. A missing or wrong token gets 401.

The token lets anyone who has it create and delete alerts. Keep it in a secret and only on the
home network.

## Endpoints

| Request | Response |
| --- | --- |
| `POST /alerts` with a JSON body (below) | 201 for a new key, 200 for an existing key. Body `{key, state, fire_at, repeat}` |
| `GET /alerts` | 200, an array of `{key, state, fire_at, repeat}`: every row, in any state |
| `DELETE /alerts/{key}` | 204, also when the key does not exist (idempotent) |

`state` is `pending` (a timer that has not fired), `active` (on screen) or `acked` (someone
tapped it and heard it). `fire_at` is UTC epoch seconds, or `null`. `repeat` is the rule of a
recurring alert in its canonical form, or `null` for a one-off alert
([Recurring alerts](#recurring-alerts-repeat)).

## `POST /alerts` body

| Field | Required | Rule |
| --- | --- | --- |
| `key` | yes | `[A-Za-z0-9._-]{1,64}`. The dedupe key: a second POST with the same key updates the row |
| `source` | yes | 1 to 64 characters. `timer` draws the timer shape; any other value draws the square |
| `text` | yes | 1 to 300 characters. Spoken when someone taps the alert |
| `urgency` | no | `info` (green) or `urgent` (red, pulses faster). Default `info`, but `urgent` for `source=timer` |
| `lang` | no | Language of `text` for the voice: `es` (default), `en`, `ca` (spoken with the Spanish voice) |
| `fire_at` | no | When it fires: epoch seconds, or RFC3339 with an offset (`2026-11-12T19:30:00+01:00`, `...Z`). A time without an offset gets 422 |
| `in_s` | no | Seconds from now, computed with Blob's clock. Use this for timers |
| `ttl_s` | no | 1 to 10⁹. Delete the alert this many seconds after it becomes active (a recurring alert waits for its next time instead) |
| `repeat` | no | Ring again and again: `daily HH:MM`, `weekly DAYS HH:MM` or `every N days HH:MM`, in Blob's local time. See [Recurring alerts](#recurring-alerts-repeat) |

Any other field gets 422, so a typo (such as `fire_in`) cannot make an alert fire at once.

## Rules

| Case | Result |
| --- | --- |
| A required field is missing, `text` is over 300 characters, `key` does not match, `urgency` is unknown | 422 |
| Both `fire_at` and `in_s` | 422 |
| `fire_at` without a UTC offset, or not a number or RFC3339, or out of range | 422 |
| No `fire_at`, a past `fire_at`, `in_s` 0 or negative | `active` at once |
| A future `fire_at` or a positive `in_s` | `pending`; the scheduler makes it `active` at `fire_at` (within about 250 ms) |
| Same `key` while `pending` or `active` | the row is updated (200). A new future `fire_at` puts it back to `pending`; an active alert that stays active keeps its activation time |
| Same `key` while `acked`, with the same `text`, `urgency` and `fire_at` | ignored (200, `state: acked`). A source can repeat a status check every minute |
| Same `key` while `acked`, with a changed `text`, `urgency` or `fire_at`, or any `in_s` | raised again: `active`, or `pending` if the new time is in the future |
| 20 alerts already `active` and this one would become active | 429. Pending timers do not count until they fire |
| The same timer twice (two different keys) | two timers |

Lifetime: a `pending` row stays until it fires or someone calls `DELETE`. Other rows are deleted
by `DELETE`, when `ttl_s` runs out (counted from activation), or 24 h after they were acked.

Restart: alerts are stored in SQLite and survive a restart of the service. A timer that came due
while the service was down fires once at startup, marked `late`, unless its `ttl_s` had also run
out (then it is deleted).

## Recurring alerts (`repeat`)

A recurring alert rings at the same local time again and again: the pills every day at 9, the
bins on Tuesdays, the plants every 4 days. The source creates it once; Blob puts it back to
`pending` for the next time after each ring. It ends only with `DELETE /alerts/{key}`.

### Format

Lowercase, one space between the parts, a 24-hour `HH:MM` (two digits each) at the end:

| `repeat` | Rings |
| --- | --- |
| `daily 09:00` | every day at 09:00 |
| `weekly tue 20:00` | every Tuesday at 20:00 |
| `weekly mon,thu 08:30` | every Monday and Thursday at 08:30. Days: `mon tue wed thu fri sat sun`, comma-separated, no spaces, no repeats, any order |
| `every 4 days 10:00` | every 4th day at 10:00. `N` is 2 to 365 (use `daily` for 1), without a leading zero |

Anything else gets 422: `daily 9:00`, `Daily 09:00`, `weekly martes 20:00`, `every 1 days
10:00`, `monthly ...`. The responses give the rule back in canonical form (`weekly thu,mon 08:30`
comes back as `weekly mon,thu 08:30`); compare against that.

The time is wall-clock time in Blob's zone, `TZ` (the chart sets `Europe/Madrid`, which is also
the default). "09:00" stays 09:00 after a clock change, in spring and in autumn. On the
spring-forward night a time between 02:00 and 02:59 does not exist; it rings at the same instant
the clock jumps past, one hour later. A time that happens twice on the autumn night rings once,
the first time. A source never deals with UTC offsets for a recurring alert.

### Rules

| Case | Result |
| --- | --- |
| `repeat` with no `fire_at` | `pending` at the next matching time after now (09:00 today if it is 08:00, else tomorrow) |
| `repeat` with `fire_at` (epoch or RFC3339 with an offset) | `fire_at` is the start: the first ring is the first matching time at or after it ("starting Saturday"). For `every N days` it also fixes the days: a past start keeps counting from it |
| `repeat` with `in_s` | 422 |
| A recurring alert is never `active` on the POST | It always starts `pending`, even when `fire_at` is in the past |
| The scheduler reaches the time | `active`, like any alert (snapshot, chime) |
| Someone taps it and hears it (`alert_ack`) | `pending` at its next time, not `acked`. `GET /alerts` shows the new `fire_at` |
| Its `ttl_s` runs out while it is `active` | `pending` at its next time, not deleted |
| Nobody taps it | It stays `active` on the screen. The times that pass meanwhile do not stack or ring again; after the tap it waits for the next time after now. Give it a `ttl_s` if it should go away and ring fresh next time |
| Same `key`, same `text`, `urgency` and `repeat` (and the same start) | ignored (200, the current row). A ringing alert keeps ringing. A source can re-send it every day |
| Same `key`, anything of that changed | the row is replaced: `pending` at the new rule's next time (a ringing alert stops ringing) |
| Same `key` without `repeat` | a one-off alert from then on, with the normal rules |
| Blob was down when it was due | it rings once at startup, marked `late`, for the last time that was missed, unless its `ttl_s` had also run out (then it waits for its next time) |
| `source: "timer"` | allowed, but no countdown is shown for it |

Lifetime: a recurring row stays until `DELETE`; it is never `acked`, so the 24 h clean-up of acked
rows does not touch it.

What the page does with it: every connected screen gets a new snapshot within about 1 s. The top
alert is `urgent` before `info`, then oldest first. During a conversation turn the alert is held
until the turn ends. A tap reads the alert aloud and acks it.

## `curl` examples

```sh
BLOB=http://blob.blob.svc.cluster.local:80          # or https://<blob host>
AUTH="Authorization: Bearer $ALERT_TOKEN"

# An alert now
curl -sS -X POST "$BLOB/alerts" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"key": "garage-door", "source": "homeassistant", "urgency": "urgent",
       "text": "La puerta del garaje está abierta.", "lang": "es"}'
# -> {"key":"garage-door","state":"active","fire_at":null}   (HTTP 201)

# A 10 minute timer
curl -sS -X POST "$BLOB/alerts" -H "$AUTH" -H 'Content-Type: application/json' \
  -d "{\"key\": \"timer-$(date +%s)\", \"source\": \"timer\", \"in_s\": 600,
       \"text\": \"El temporizador de 10 minutos ha terminado.\", \"lang\": \"es\"}"

# A calendar reminder at a fixed time, gone one hour after it fires
curl -sS -X POST "$BLOB/alerts" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"key": "cal-dentist", "source": "calendar", "fire_at": "2026-11-20T09:30:00+01:00",
       "ttl_s": 3600, "text": "Dentist at ten.", "lang": "en"}'

# The pills every day at nine (pending until 09:00, back to pending after each tap)
curl -sS -X POST "$BLOB/alerts" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"key": "repeat-pastillas", "source": "reminder", "urgency": "urgent",
       "repeat": "daily 09:00", "text": "Toca tomar las pastillas.", "lang": "es"}'
# -> {"key":"repeat-pastillas","state":"pending","fire_at":1795161600,"repeat":"daily 09:00"}   (asked on 2026-11-20 before nine)

# The bins on Tuesday evenings, gone after two hours if nobody taps it
curl -sS -X POST "$BLOB/alerts" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"key": "repeat-basura", "source": "reminder", "repeat": "weekly tue 20:00",
       "ttl_s": 7200, "text": "Hoy hay que sacar la basura.", "lang": "es"}'

# Water the plants every 4 days at ten, starting on Saturday
curl -sS -X POST "$BLOB/alerts" -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"key": "repeat-plantas", "source": "reminder", "repeat": "every 4 days 10:00",
       "fire_at": "2026-11-21T00:00:00+01:00", "text": "Toca regar las plantas.", "lang": "es"}'

# A bad rule is refused
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BLOB/alerts" -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -d '{"key": "x", "source": "reminder", "repeat": "every day at 9", "text": "x"}'
# -> 422

curl -sS "$BLOB/alerts" -H "$AUTH"                       # list (recurring rows have a repeat)
curl -sS "$BLOB/alerts" -H "$AUTH" | jq '.[] | select(.repeat)'   # only the recurring ones
curl -sS -X DELETE "$BLOB/alerts/garage-door" -H "$AUTH" # clear (204)
curl -sS -X DELETE "$BLOB/alerts/repeat-pastillas" -H "$AUTH"    # stop a recurring one (204)
```

## Home Assistant `rest_command`

In `configuration.yaml`, with the token in `secrets.yaml` as
`blob_alert_auth: "Bearer <ALERT_TOKEN>"`:

```yaml
rest_command:
  blob_alert:
    url: "https://blob.example.home/alerts"
    method: POST
    headers:
      Authorization: !secret blob_alert_auth
    content_type: "application/json"
    payload: >-
      {"key": "{{ key }}", "source": "homeassistant",
       "urgency": "{{ urgency | default('info') }}",
       "text": {{ text | tojson }}, "lang": "{{ lang | default('es') }}"}
  blob_alert_clear:
    url: "https://blob.example.home/alerts/{{ key }}"
    method: DELETE
    headers:
      Authorization: !secret blob_alert_auth
```

Use it from an automation:

```yaml
- alias: Washing machine done
  trigger:
    - platform: state
      entity_id: sensor.washing_machine_status
      to: "done"
  action:
    - service: rest_command.blob_alert
      data:
        key: washing-machine
        text: "La lavadora ha terminado."
- alias: Washing machine emptied
  trigger:
    - platform: state
      entity_id: sensor.washing_machine_status
      to: "idle"
  action:
    - service: rest_command.blob_alert_clear
      data:
        key: washing-machine
```

A repeated `blob_alert` with the same text does not raise the alert again after someone acked
it; change the text (or `DELETE` it first) to raise it again.

## Hermes: create and cancel timers through `/alerts`

Blob has a local timer rule (`TIMER_RULE=on`, the default): a transcript such as "pon un
temporizador de 10 minutos" becomes a timer before Hermes is called, and Hermes never sees it.
Phrases the rule does not take (cancel, change, "how long is left", anything without a number
and a unit) still go to Hermes. Once Hermes creates timers reliably with the Blob skill below, set
`TIMER_RULE=off` so every timer request goes to Hermes.

The skill ships inside Blob: [`backend/blob/hermes_skill.md`](../backend/blob/hermes_skill.md).
Blob appends it to the system message of every request to Hermes, with `{alerts_url}` replaced by
`HERMES_ALERTS_URL` and the current local time added (for reminders at a time of day). Nothing is
installed in Hermes, so a new Blob version updates the skill on its next turn. It tells Hermes what
Blob is (replies are spoken), and how to set, list and cancel timers, reminders and notices with
`curl`, including recurring reminders ("recuérdame las pastillas cada día a las 9", "¿qué
recordatorios tengo?", "ya no tomo esa pastilla").

The one thing Hermes needs on its side is the token: the environment variable
`BLOB_ALERT_TOKEN` (Blob's `ALERT_TOKEN`) in the Hermes pod. In home_lab, Terraform writes it to
the Secret `hermes-agent-blob`, which the Hermes chart loads with `envFrom`. The token is kept out
of the prompt so it never lands in Hermes sessions or the model provider's logs.

The skill only needs `curl`, `date` and the terminal tool. If Hermes runs outside the cluster, set
`HERMES_ALERTS_URL=https://<blob host>`.
