// The weather for the idle screen: GET /weather (the backend polls Open-Meteo),
// the current sky for the blob and the week ahead as a strip under it.
import type { Sky, WeatherKind } from './render/tables';

export interface WeatherDay {
  date: string; // YYYY-MM-DD
  kind: WeatherKind;
  max: number;
  min: number;
  rain: number | null; // highest chance of precipitation, %
}

export interface Weather {
  current: { temp: number; kind: WeatherKind; day: boolean };
  days: WeatherDay[];
  updated: number;
}

export const WEATHER_POLL_MS = 15 * 60_000;
const KINDS: readonly WeatherKind[] = ['clear', 'partly', 'cloudy', 'fog', 'rain', 'snow', 'storm'];

// Null when the backend has no weather (off, not fetched yet, unreachable, signed out) or
// answers nonsense. The session cookie rides along (same origin).
export async function fetchWeather(): Promise<Weather | null> {
  try {
    const r = await fetch('/weather', { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return null;
    const w = (await r.json()) as Weather;
    return KINDS.includes(w?.current?.kind) && Array.isArray(w.days) ? w : null;
  } catch {
    return null;
  }
}

export const skyOf = (w: Weather): Sky => ({ kind: w.current.kind, day: w.current.day });

// The idle rest takes turns: clock, then weather, then clock again...
export function restShows(restMs: number, clockMs: number, weatherMs: number): 'clock' | 'weather' {
  return restMs % (clockMs + weatherMs) < clockMs ? 'clock' : 'weather';
}

const deg = (t: number) => `${Math.round(t)}°`;

// Line icons, 24 px grid, drawn with currentColor.
const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/>';
const MOON = '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z"/>';
const CLOUD = '<path d="M7 18h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 9.6 4.2 4.2 0 0 0 7 18z"/>';
const CLOUD_HI = '<path d="M7 15h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7.1 6.6 4.2 4.2 0 0 0 7 15z"/>';
const ICONS: Record<WeatherKind | 'night', string> = {
  clear: SUN,
  night: MOON,
  partly: '<circle cx="8.5" cy="8.5" r="3.2"/><path d="M8.5 2.5v1.5M2.5 8.5H4M4.3 4.3l1 1M12.7 4.3l-1 1"/><path d="M9 19h8.5a3.5 3.5 0 0 0 .5-6.96 4.8 4.8 0 0 0-9.2-.9A3.95 3.95 0 0 0 9 19z"/>',
  cloudy: CLOUD,
  fog: '<path d="M4 9h16M6 13h12M4 17h16"/>',
  rain: `${CLOUD_HI}<path d="M9 18l-1 3M13 18l-1 3M17 18l-1 3"/>`,
  snow: `${CLOUD_HI}<path d="M9 19.5h.01M13 21h.01M17 19.5h.01"/>`,
  storm: `${CLOUD_HI}<path d="M13 15l-2.5 4h3L11 23"/>`,
};

export function icon(kind: WeatherKind, night = false): string {
  const body = ICONS[night && (kind === 'clear' || kind === 'partly') ? 'night' : kind];
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

// Day labels in the page's language: "hoy", then short weekdays.
function dayLabel(date: string, i: number, locale?: string): string {
  if (i === 0) {
    try {
      return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(0, 'day');
    } catch {
      return 'today';
    }
  }
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale, { weekday: 'short' }).replace('.', '');
}

// The panel's HTML: the temperature now (only while the blob shows the sky),
// then one column per day with its icon, high, low and a likely rain chance.
export function weatherHtml(w: Weather, showNow: boolean, locale?: string): string {
  const now = `<div class="now${showNow ? '' : ' off'}">${deg(w.current.temp)}</div>`;
  const days = w.days
    .slice(0, 7)
    .map(
      (d, i) =>
        `<div class="day${i === 0 ? ' today' : ''}"><span class="dn">${dayLabel(d.date, i, locale)}</span>${icon(d.kind)}` +
        `<span class="hi">${deg(d.max)}</span><span class="lo">${deg(d.min)}</span>` +
        `<span class="rp">${d.rain != null && d.rain >= 30 ? `${d.rain}%` : ''}</span></div>`,
    )
    .join('');
  return `${now}<div class="week">${days}</div>`;
}
