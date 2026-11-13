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
| `POST /alerts` with a JSON body (below) | 201 for a new key, 200 for an existing key. Body `{key, state, fire_at}` |
| `GET /alerts` | 200, an array of `{key, state, fire_at}`: every row, in any state |
| `DELETE /alerts/{key}` | 204, also when the key does not exist (idempotent) |

`state` is `pending` (a timer that has not fired), `active` (on screen) or `acked` (someone
tapped it and heard it). `fire_at` is UTC epoch seconds, or `null`.

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
| `ttl_s` | no | 1 to 10⁹. Delete the alert this many seconds after it becomes active |

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

curl -sS "$BLOB/alerts" -H "$AUTH"                       # list
curl -sS -X DELETE "$BLOB/alerts/garage-door" -H "$AUTH" # clear (204)
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
`curl`.

The one thing Hermes needs on its side is the token: the environment variable
`BLOB_ALERT_TOKEN` (Blob's `ALERT_TOKEN`) in the Hermes pod. In home_lab, Terraform writes it to
the Secret `hermes-agent-blob`, which the Hermes chart loads with `envFrom`. The token is kept out
of the prompt so it never lands in Hermes sessions or the model provider's logs.

The skill only needs `curl`, `date` and the terminal tool. If Hermes runs outside the cluster, set
`HERMES_ALERTS_URL=https://<blob host>`.
