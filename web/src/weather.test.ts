import { afterEach, describe, expect, it, vi } from 'vitest';
import { skyParts, weatherLook } from './render/tables';
import { fetchWeather, icon, restShows, weatherHtml, type Weather } from './weather';

const W: Weather = {
  current: { temp: 14.6, kind: 'rain', day: true },
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
