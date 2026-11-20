import { afterEach, describe, expect, it, vi } from 'vitest';
import { skyParts, weatherLook } from './render/tables';
import { fetchWeather, hoursHtml, icon, restShows, stripHtml, weatherHtml, type Weather } from './weather';

const H0 = Date.UTC(2026, 10, 19, 14) / 1000; // the hour now in the tests
const NOW = H0 * 1000 + 20 * 60_000; // 20 minutes into it

const W: Weather = {
  current: { temp: 14.6, kind: 'rain', day: true },
  hours: Array.from({ length: 10 }, (_, i) => ({
    time: H0 + i * 3600,
    kind: i < 2 ? ('rain' as const) : ('clear' as const),
    temp: 14.4 - i,
    rain: i < 2 ? 70 : 0,
    day: i < 3,
  })),
  days: [
    { date: '2026-11-19', kind: 'rain', max: 16.4, min: 10.6, rain: 85 },
    { date: '2026-11-20', kind: 'clear', max: 21, min: 9, rain: 5 },
  ],
  updated: 0,
};

describe('weather', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('takes turns: clock first, then the sky', () => {
    expect(restShows(0, 30_000, 20_000)).toBe('clock');
    expect(restShows(29_999, 30_000, 20_000)).toBe('clock');
    expect(restShows(30_000, 30_000, 20_000)).toBe('weather');
    expect(restShows(50_000, 30_000, 20_000)).toBe('clock');
  });

  it('draws a sun by day, a moon at night, a raining cloud for rain', () => {
    expect(skyParts({ kind: 'clear', day: true })).toMatchObject({ sun: 1, moon: 0, cloud: 0, fall: 0 });
    expect(skyParts({ kind: 'clear', day: false })).toMatchObject({ sun: 0, moon: 1, cloud: 0 });
    expect(skyParts({ kind: 'partly', day: true })).toMatchObject({ sun: 1, cloud: 1, fall: 0 });
    expect(skyParts({ kind: 'rain', day: true })).toMatchObject({ sun: 0, cloud: 1, fall: 1, snow: 0 });
    expect(skyParts({ kind: 'snow', day: false })).toMatchObject({ moon: 0, cloud: 1, fall: 1, snow: 1 });
  });

  it("grows every sky to the sphere's volume, and makes room below for falling drops", () => {
    for (const kind of ['clear', 'partly', 'cloudy', 'fog', 'rain', 'snow', 'storm'] as const)
      for (const day of [true, false]) {
        const p = skyParts({ kind, day });
        expect(p.size).toBeGreaterThan(1);
        expect(p.top).toBeGreaterThan(0);
        expect(p.bottom).toBeLessThan(0);
      }
    expect(skyParts({ kind: 'clear', day: false }).size).toBeGreaterThan(skyParts({ kind: 'clear', day: true }).size); // the crescent is thin
    expect(skyParts({ kind: 'rain', day: true }).bottom).toBeLessThan(skyParts({ kind: 'cloudy', day: true }).bottom);
  });

  it('gives each sky its own colours, as copies', () => {
    const sun = weatherLook({ kind: 'clear', day: true });
    const rain = weatherLook({ kind: 'rain', day: true });
    expect(sun.color[0]).toBeGreaterThan(sun.color[2]); // warm
    expect(rain.color[2]).toBeGreaterThan(rain.color[0]); // blue
    sun.color[0] = 9;
    expect(weatherLook({ kind: 'clear', day: true }).color[0]).not.toBe(9);
  });

  it('renders the week with rounded temperatures and likely rain only', () => {
    const html = weatherHtml(W, true, 'es');
    expect(html).toContain('15°'); // now
    expect(html).toContain('16°');
    expect(html).toContain('11°');
    expect(html).toContain('85%');
    expect(html).not.toContain('>5%');
    expect(html.match(/class="day/g)).toHaveLength(2);
    expect(weatherHtml(W, false)).toContain('now off');
  });

  it('renders the seven hours after the current one, without the temperature now', () => {
    const html = hoursHtml(W, NOW, 'es');
    expect(html.match(/class="day/g)).toHaveLength(7);
    expect(html).toContain(new Date((H0 + 3600) * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false }));
    expect(hoursHtml(W, NOW, 'en-US')).not.toMatch(/AM|PM/); // 24 h, like the clock
    expect(html).not.toContain('14°'); // the current hour (14.4) is left out
    expect(html).not.toContain('15°'); // and so is the temperature now (14.6)
    expect(html).not.toContain('class="now');
    expect(html).toContain('13°'); // the next hour
    expect(html).toContain('70%');
    expect(html).toContain(icon('clear', true)); // the fourth hour is a clear night
    expect(hoursHtml(W, H0 * 1000 + 9 * 3600_000)).toBe(''); // none ahead
    expect(hoursHtml({ ...W, hours: undefined }, NOW)).toBe('');
  });

  it('shows the hours beside the clock and the week beside the sky', () => {
    expect(stripHtml(W, 'clock', NOW)).toContain('week hours');
    expect(stripHtml(W, 'weather', NOW)).toBe(weatherHtml(W, true));
    expect(stripHtml({ ...W, hours: [] }, 'clock', NOW)).toBe(weatherHtml(W, false)); // no hours: the week
  });

  it('uses the moon icon only for clear nights', () => {
    expect(icon('clear', true)).not.toBe(icon('clear'));
    expect(icon('rain', true)).toBe(icon('rain'));
  });

  it('fetches with the session cookie and rejects bad answers', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(W)));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchWeather()).toEqual(W);
    expect(fetch).toHaveBeenCalledWith('/weather', { credentials: 'same-origin', cache: 'no-store' });
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ current: { kind: 'lava' }, days: [] })));
    expect(await fetchWeather()).toBeNull();
    vi.stubGlobal('fetch', async () => new Response('', { status: 404 }));
    expect(await fetchWeather()).toBeNull();
    vi.stubGlobal('fetch', async () => Promise.reject(new Error('offline')));
    expect(await fetchWeather()).toBeNull();
  });
});
