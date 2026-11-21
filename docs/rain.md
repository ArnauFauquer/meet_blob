# Rain soon

When rain is about to start, Blob raises one calm alert: the blob becomes the idle sky's rain
cloud, in the green of an `info` alert, with drops falling below it. A tap reads it aloud:
"Empieza a llover en 20 minutos. Si hay ropa tendida, es buen momento para recogerla." It is for
bringing the washing in.

![Rain soon alert](screenshots/alert-rain-info-1280x800.png)

## Rules

| Case | Result |
| --- | --- |
| The next wet quarter starts within `RAIN_SOON_LEAD_MIN` (30) minutes | one `info` alert, in `RAIN_SOON_LANG` (`es`) |
| It is already raining (the current quarter is wet) | no alert |
| Rain stops and starts again, or the next fetch moves the start by a quarter | no second alert: the same episode |
| Two hours (`EPISODE_GAP_S`) without rain, then rain again | a new episode, a new alert |
| It is night (`NIGHT_HOURS`, read in `TZ`) | no alert is created. If rain is still coming when the night ends, the alert comes then ("en 15 minutos"); if it is already raining by then, none |
| No `NIGHT_HOURS` | no night: the alert can come at any hour |
| Someone tapped the alert | it stays acked; later fetches do not raise it again |

A quarter is wet when the forecast precipitation in it is at least 0.1 mm (the smallest step
Open-Meteo reports). A quarter without a value counts as dry. The minutes in the text are rounded
to 5; under 2.5 minutes the text says "en unos minutos".

The alert: `source: rain`, `urgency: info`, key `rain-soon-YYYYMMDD-HHMM` (the local start of
the rain, stable for the episode), `ttl_s` until 30 minutes after the rain was due. It goes
through the alert store like any `POST /alerts`, so every screen gets it once through the
snapshot, the bubble alarm rings once, and it survives a restart. After a restart, a `rain-soon-`
row still in the store keeps its episode going, so the alert is not raised twice.

## Night

The rain alert uses night mode's window, `NIGHT_HOURS` (for example `23:00-07:30`), so there is
one night for the whole house. The page reads it in the browser's local time; the backend reads
it in `TZ` (default `Europe/Madrid`, which the chart sets and the tablet's clock shares), so the
two agree and daylight saving moves both. During the night the watcher keeps following the
forecast (rain that starts at night still opens an episode) but creates no alert. The first check
after the night ends warns if rain is still due within the lead.

An alert created just before the night (22:50 for rain at 23:15) rings as usual. Once the night
begins, night mode hides `info` alerts until morning; this one's `ttl_s` ends 30 minutes after the
rain was due (23:45), so it is gone by then and does not show up stale at dawn. The alert raised
when the night ends comes after the page's night too (same window, same clock), so it rings.

## Where the logic lives, and why

In the backend (`backend/blob/rain_soon.py`), not in the page:

*   One decision for the whole house. Every screen polls `/weather` on its own clock; a page-side
    rule would need a shared dedupe to not ring twice. The alert store already has it: one row,
    one key, one alarm, one ack for all screens.
*   It works with no screen open, and the episode state survives a reload of the page.
*   It reuses everything alerts already do: alarm, tap to read, ack, quiet chimes, ttl, restart.
*   The decision is a pure function (`decide`) of the forecast, the time and the episode, so the
    tests feed it simulated forecasts.

The page only learns a new alert source: `rain` draws the weather shape with the rain sky
(`SOURCE_SHAPE`, `alertSky` in `web/src/render/tables.ts`). The colour stays the alert's green so
it reads as something to tap, not as the idle weather turn. The rain cloud's face looks up at its
drops. There is no text on screen.

## The forecast

The watcher asks Open-Meteo every 10 minutes for `minutely_15=precipitation` (3 hours ahead plus
the last quarter) and checks the last answer every minute, so the lead time does not depend on
the fetch interval. Open-Meteo labels each 15 minute value with the *end* of the quarter
(precipitation of the preceding 15 minutes); the code turns it into the quarter's start.

Precision. Open-Meteo has native 15 minute data only from its short-range models (NOAA RRFS in
North America, DWD ICON-D2 and Météo-France AROME in Europe); elsewhere it interpolates the hourly
forecast. For Barcelona the default `best_match` gives smooth, interpolated-looking quarters
(0.1 mm in every quarter of a 0.5 mm hour, rain starting a quarter before its hour). Météo-France
AROME HD covers Catalonia: `RAIN_SOON_MODEL=meteofrance_seamless` gives native quarters for the
next ~2 days (null after that, which the rule treats as dry; only the next 30 minutes matter).
The code's default stays `best_match` because it works anywhere. The home deployment sets
`RAIN_SOON_MODEL=meteofrance_seamless` (home_lab, `faukinator/blob/values.yaml`, `env:`, next to
`WEATHER_LAT` and `WEATHER_LON`). A home elsewhere in Catalonia or France should do the same.
The setting is ignored by an image without this feature, so it can go in before the image.

The idle screen's weather (`/weather`, `weather.py`) is a separate fetch and is not changed.

## Settings

Off unless `WEATHER_LAT` and `WEATHER_LON` are set (the same place as the idle weather).

| Variable | Default | |
| --- | --- | --- |
| `RAIN_SOON` | `true` | `false` turns the alert off |
| `RAIN_SOON_LEAD_MIN` | `30` | 5 to 120 |
| `RAIN_SOON_MODEL` | `best_match` | an Open-Meteo `models` value; the home deployment uses `meteofrance_seamless` |
| `RAIN_SOON_LANG` | `es` | `es`, `ca` or `en` |

## Tests

`backend/tests/test_rain_soon.py`: rain in 20 minutes, rain beyond the lead, already raining,
rain that just stopped, intermittent rain over three hours (one alert), a forecast that slips, a
new episode after a dry spell, the night window and the morning after it, a stale forecast, a
tap, a restart, the fetch parameters. `web/src/render/tables.test.ts` and `web/e2e/alerts.spec.ts`:
the `rain` source draws the green rain cloud and no strip or text. Screenshots:
`docs/screenshots/alert-rain-info-1280x800.png` and `-800x1280.png`.
