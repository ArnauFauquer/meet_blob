# Presence: wake when someone comes in, sleep when the room is empty

A motion or occupancy sensor tells Blob whether someone is in the room. Blob never asks Home
Assistant (design NG1, NG8): an automation calls `POST /presence`, the same way sources call
`/alerts`. The backend keeps the last report in memory and forwards it to every screen over the
WebSocket. The page decides what to draw.

With no sensor, or when Home Assistant never calls, nothing changes: no `presence` message is
sent and the page behaves exactly as before.

## What the screen does

| Room | Screen |
| --- | --- |
| Unknown (no report since Blob started, after `DELETE /presence`, or while the page's socket is down) | As without a sensor: the face, and the clock after 5 minutes of idle |
| Someone there (`present: true`) | The face at once, also from the clock or the dark screen. While nobody talks to it, the clock comes back after the usual 5 minutes. It never goes dark |
| Nobody there (`present: false`) | After 30 s of quiet the idle blob rests as the clock (and the sky, if the weather is on). `PRESENCE_SLEEP_S` (default 600 s) after the last activity, the screen fades to black and nothing is drawn |

"Activity" is the latest of: the room becoming empty, the end of the last turn, alert or error,
and a tap on the dark screen. Only an idle screen rests or sleeps:

*   An **active alert** is always shown, also with nobody there. A new alert lights the dark
    screen; once it is gone the screen sleeps again after the quiet time. The alarm and the chime
    follow the usual rules (sound flag, quiet hours, held during a turn); presence does not
    change them.
*   **Hands-free keeps working.** The microphone, the wake word, the voice-activity detector and
    the socket keep running on the dark screen. "Hey Blob" starts a turn as usual and the screen
    lights up with it.
*   A **tap on the dark screen** only wakes it (and unlocks audio); it does not start a turn,
    because you cannot see what you tap. The next tap is a normal tap. A tap on the resting clock
    is a normal tap, as before.
*   A **turn, an error or offline** are always shown.

The page logic is `web/src/presence.ts` (the state machine and its unit tests in
`presence.test.ts`); the backend is `backend/blob/presence.py`.

## Endpoints

Every request needs `Authorization: Bearer <ALERT_TOKEN>` (the alerts token); a missing or
wrong token gets 401. Same addresses as `/alerts`: `http://blob.blob.svc.cluster.local:80`
inside the cluster, `https://<blob host>` from the home network.

| Request | Response |
| --- | --- |
| `POST /presence` with `{"present": true}` or `{"present": false}` | 200 `{present, since_s}`. Every screen gets a `presence` message |
| `GET /presence` | 200 `{present, since_s}`; `present` is `null` until a sensor reports |
| `DELETE /presence` | 204. Back to unknown (as with no sensor), for example after removing the sensor |

`present` must be a JSON boolean: `"on"`, `"true"`, `1` or any other field get 422, so a
template mistake does not silently mean "nobody". `since_s` is how long the current value has
held.

Rules:

*   Every `true` counts as a new arrival: the screen wakes again, even if the last report was
    also `true`.
*   A repeated `false` keeps the time the room became empty, so sending it again (for example
    every 10 minutes) does not push the dark screen further away.
*   The state lives in memory only. After a Blob restart it is unknown until the next report
    (see the optional resync automation below).

WebSocket message (`protocol/messages.json`): `presence {present: bool|null, since_s: float|null}`,
sent to every screen on each `POST` or `DELETE`, and to a screen that connects, right after its
snapshot, only when a sensor has reported.

```sh
BLOB=https://blob.example.home
AUTH="Authorization: Bearer $ALERT_TOKEN"
curl -sS -X POST "$BLOB/presence" -H "$AUTH" -H 'Content-Type: application/json' -d '{"present": false}'
# -> {"present":false,"since_s":0.0}
curl -sS "$BLOB/presence" -H "$AUTH"
curl -sS -X DELETE "$BLOB/presence" -H "$AUTH"      # 204, back to "no sensor"
```

## Home Assistant

In `configuration.yaml`, with the token in `secrets.yaml` as
`blob_alert_auth: "Bearer <ALERT_TOKEN>"` (the same secret as the alerts commands). Two fixed
payloads, so there is no template that could render `"True"` instead of `true`:

```yaml
rest_command:
  blob_present:
    url: "https://blob.example.home/presence"
    method: POST
    headers:
      Authorization: !secret blob_alert_auth
    content_type: "application/json"
    payload: '{"present": true}'
  blob_absent:
    url: "https://blob.example.home/presence"
    method: POST
    headers:
      Authorization: !secret blob_alert_auth
    content_type: "application/json"
    payload: '{"present": false}'
```

One automation (in `automations.yaml`, or under `automation:`). Replace
`binary_sensor.living_room_occupancy` with your motion or occupancy sensor. The `for:` on the
"off" trigger is how long the sensor must report nobody before Blob hears it; Blob then shows the
clock after 30 s and goes dark `PRESENCE_SLEEP_S` later.

```yaml
- alias: Blob presence
  mode: queued
  triggers:
    - trigger: state
      entity_id: binary_sensor.living_room_occupancy
      to: "on"
    - trigger: state
      entity_id: binary_sensor.living_room_occupancy
      to: "off"
      for: "00:05:00"
    - trigger: homeassistant
      event: start
  actions:
    - if:
        - condition: state
          entity_id: binary_sensor.living_room_occupancy
          state: "on"
      then:
        - action: rest_command.blob_present
      else:
        - action: rest_command.blob_absent
```

Optional: Blob forgets the room when it restarts (a deploy). This re-sends "nobody" every
10 minutes while the room is empty; a repeated `false` does not move the sleep time, and it never
sends `true`, so it cannot wake the face by itself.

```yaml
- alias: Blob presence resync
  triggers:
    - trigger: time_pattern
      minutes: "/10"
  conditions:
    - condition: state
      entity_id: binary_sensor.living_room_occupancy
      state: "off"
      for: "00:05:00"
  actions:
    - action: rest_command.blob_absent
```

The syntax (`triggers:`, `trigger: state`, `action:`) is the one Home Assistant uses since
2024.10. On an older version write `trigger:`, `platform: state` and `service:` instead.

To stop using the sensor, delete the automations and call `DELETE /presence` once (or restart
Blob).

## Settings

| Where | Name | Default | What |
| --- | --- | --- | --- |
| Backend env, served by `/device-config` | `PRESENCE_SLEEP_S` | 600 (min 10) | With nobody there, quiet seconds before the screen goes dark |
| `web/src/presence.ts` | `REST_WHEN_EMPTY_MS` | 30 000 | With nobody there, quiet time before the face rests as the clock |

## Why "dark" is a black page, not a screen that turns off

What a page in Chrome on Android can and cannot do (checked against the specs and reports
below; not yet measured on the tablet):

*   **It cannot turn the screen back on.** The Screen Wake Lock API only lets a *visible*
    document hold a lock; a request from a hidden page is rejected with `NotAllowedError`. If the
    page released its lock, Android would turn the screen off after the system timeout, the page
    would become hidden, and a later `present: true` could not bring the screen back. Nothing in
    the web platform turns a display on.
*   **It cannot set the backlight.** There is no shipped API to set the display brightness. The
    Screen Brightness proposal was folded into the wake lock discussion, only ever covered raising
    the brightness (for showing a QR code), and has not shipped.
*   **The microphone with the screen off is not reliable.** Reports on Chrome for Android
    disagree: some say capture stops shortly after the screen turns off, others that audio keeps
    recording. Android may also freeze a hidden tab. Hands-free must not break, so the screen must
    stay on.

So Blob keeps its wake lock (`web/src/wakelock.ts`, unchanged) and makes the screen as close to
off as a page can:

*   The renderer fades to black (the `presence` dim source; brightness is the lowest of all
    sources, such as the night mode's `night`), and the shader's dither is switched off at zero,
    so every pixel is exactly `#000`. The weather strip and the timer countdown fade out too; the
    fault line stays, so a real problem (microphone denied, offline) still shows.
*   Once the black frame is on screen nothing is drawn and no animation frames are requested: the
    page looks again four times a second with a timer (so waking takes at most about 250 ms). The
    GPU and the compositor have nothing to do.
*   On an **OLED** screen black pixels are off: real energy savings and no burn-in. On an **LCD**
    the backlight stays lit (a dark glow in a dark room); the savings are the GPU and CPU work
    only. To really switch the backlight off you need something outside the page (a kiosk browser
    such as Fully Kiosk with its own Home Assistant integration, or the tablet's own settings);
    that is outside Blob.

Sources: [Screen Wake Lock API (W3C)](https://w3.org/TR/wake-lock/),
[the Screen Brightness draft](https://beaufortfrancois.github.io/screen-brightness),
[its move into the wake lock discussion](https://lists.w3.org/Archives/Public/public-device-apis-log/2021Apr/0037.html),
[WebRTC on Chrome for Android with the display off](https://lists.w3.org/Archives/Public/public-webrtc-logs/2020Mar/0129.html),
[Mozilla bug 1195654 (Chrome compared)](https://bugzilla.mozilla.org/show_bug.cgi?id=1195654).

## Not verified

*   On the tablet: power drawn by the dark page, whether its screen is OLED or LCD, and the wake
    word over a long dark night (only headless Chromium with a fake microphone was tested: on the
    dark screen the wake gate stays open and audio keeps arriving).
*   Against a real Home Assistant: the YAML above was written from the Home Assistant docs, not
    run.
