import { beforeAll, describe, expect, it } from 'vitest';
import { NIGHT_AWAKE_MS, NIGHT_DIM, NIGHT_FPS, NightMode, heldAtNight, isNight, nightWindow, shownAlerts, type NightHours } from './night';
import type { AlertItem } from './protocol';

// The home's time zone: the clocks change on 2026-03-29 (02:00 -> 03:00) and
// 2026-10-25 (03:00 -> 02:00).
beforeAll(() => {
  process.env.TZ = 'Europe/Madrid';
});

const NIGHT: NightHours = { start: '23:00', end: '07:30' };
const at = (mo: number, d: number, h: number, m = 0) => new Date(2026, mo - 1, d, h, m);
const iso = (d: Date) => d.toISOString();

describe('nightWindow', () => {
  it('uses the home time zone in these tests', () => {
    expect(at(1, 15, 12).getTimezoneOffset()).toBe(-60);
    expect(at(7, 15, 12).getTimezoneOffset()).toBe(-120);
  });

  it('a night that crosses midnight', () => {
    expect(isNight(NIGHT, at(11, 20, 22, 59))).toBe(false);
    expect(isNight(NIGHT, at(11, 20, 23, 0))).toBe(true); // start inclusive
    expect(isNight(NIGHT, at(11, 20, 23, 59))).toBe(true);
    expect(isNight(NIGHT, at(11, 21, 0, 0))).toBe(true);
    expect(isNight(NIGHT, at(11, 21, 3, 0))).toBe(true);
    expect(isNight(NIGHT, at(11, 21, 7, 29))).toBe(true);
    expect(isNight(NIGHT, at(11, 21, 7, 30))).toBe(false); // end exclusive
    expect(isNight(NIGHT, at(11, 21, 12, 0))).toBe(false);
  });

  it('gives the night as two instants, whichever side of midnight', () => {
    const before = nightWindow(NIGHT, at(11, 20, 23, 30));
    const after = nightWindow(NIGHT, at(11, 21, 2, 0));
    expect(before).toEqual(after);
    expect(iso(before!.start)).toBe('2026-11-20T22:00:00.000Z');
    expect(iso(before!.end)).toBe('2026-11-21T06:30:00.000Z');
  });

  it('a night across the end of a month and of a year', () => {
    expect(iso(nightWindow(NIGHT, at(12, 1, 3))!.start)).toBe('2026-11-30T22:00:00.000Z');
    expect(iso(nightWindow(NIGHT, at(1, 1, 3))!.start)).toBe('2025-12-31T22:00:00.000Z');
  });

  it('a window inside one day (a nap)', () => {
    const nap = { start: '13:30', end: '15:00' };
    expect(isNight(nap, at(11, 20, 13, 29))).toBe(false);
    expect(isNight(nap, at(11, 20, 14))).toBe(true);
    expect(isNight(nap, at(11, 20, 15))).toBe(false);
    expect(isNight(nap, at(11, 20, 23))).toBe(false);
  });

  it('missing, malformed or zero-length hours: never night', () => {
    for (const h of [null, undefined, { start: '23:00', end: '23:00' }, { start: '24:00', end: '07:00' }, { start: '23', end: '07:30' }, { start: '', end: '' }]) {
      expect(isNight(h as NightHours | null, at(11, 21, 2))).toBe(false);
    }
  });

  it('spring forward: 23:00-07:30 holds by the wall clock (7.5 real hours)', () => {
    const w = nightWindow(NIGHT, at(3, 29, 4))!;
    expect(iso(w.start)).toBe('2026-03-28T22:00:00.000Z'); // 23:00 CET
    expect(iso(w.end)).toBe('2026-03-29T05:30:00.000Z'); // 07:30 CEST
    expect((w.end.getTime() - w.start.getTime()) / 3_600_000).toBe(7.5);
    expect(isNight(NIGHT, new Date('2026-03-29T05:29:00Z'))).toBe(true);
    expect(isNight(NIGHT, new Date('2026-03-29T05:30:00Z'))).toBe(false);
  });

  it('fall back: 23:00-07:30 holds by the wall clock (9.5 real hours)', () => {
    const w = nightWindow(NIGHT, at(10, 25, 4))!;
    expect(iso(w.start)).toBe('2026-10-24T21:00:00.000Z'); // 23:00 CEST
    expect(iso(w.end)).toBe('2026-10-25T06:30:00.000Z'); // 07:30 CET
    expect((w.end.getTime() - w.start.getTime()) / 3_600_000).toBe(9.5);
    // Both passes through 02:30 are night.
    expect(isNight(NIGHT, new Date('2026-10-25T00:30:00Z'))).toBe(true); // 02:30 CEST
    expect(isNight(NIGHT, new Date('2026-10-25T01:30:00Z'))).toBe(true); // 02:30 CET
  });

  it('fall back: a night that ends inside the repeated hour ends the first time, and stays over', () => {
    const late = { start: '23:00', end: '02:30' };
    expect(isNight(late, new Date('2026-10-25T00:29:00Z'))).toBe(true); // 02:29 CEST
    expect(isNight(late, new Date('2026-10-25T00:30:00Z'))).toBe(false); // 02:30 CEST
    expect(isNight(late, new Date('2026-10-25T01:00:00Z'))).toBe(false); // 02:00 CET, again
    expect(isNight(late, new Date('2026-10-25T01:29:00Z'))).toBe(false); // 02:29 CET
  });

  it('fall back: a night that starts inside the repeated hour starts the first time', () => {
    const w = nightWindow({ start: '02:30', end: '07:30' }, new Date('2026-10-25T01:45:00Z'))!; // 02:45 CET
    expect(iso(w.start)).toBe('2026-10-25T00:30:00.000Z'); // 02:30 CEST
  });

  it('spring forward: a start or end in the skipped hour moves on by the gap', () => {
    const early = { start: '02:30', end: '07:30' };
    expect(isNight(early, new Date('2026-03-29T00:59:00Z'))).toBe(false); // 01:59 CET
    expect(isNight(early, new Date('2026-03-29T01:00:00Z'))).toBe(false); // 03:00 CEST
    expect(isNight(early, new Date('2026-03-29T01:30:00Z'))).toBe(true); // 03:30 CEST
    const late = { start: '23:00', end: '02:30' };
    expect(isNight(late, new Date('2026-03-29T00:59:00Z'))).toBe(true); // 01:59 CET
    expect(isNight(late, new Date('2026-03-29T01:29:00Z'))).toBe(true); // 03:29 CEST
    expect(isNight(late, new Date('2026-03-29T01:30:00Z'))).toBe(false); // 03:30 CEST
  });

  it('the nights next to a change are ordinary', () => {
    for (const [mo, d] of [[3, 28], [3, 30], [10, 24], [10, 26]]) {
      const w = nightWindow(NIGHT, at(mo, d, 2))!;
      expect((w.end.getTime() - w.start.getTime()) / 3_600_000).toBe(8.5);
    }
  });
});

const alert = (key: string, urgency: AlertItem['urgency'], source = 'homeassistant'): AlertItem => ({
  key,
  source,
  urgency,
  text: '',
  lang: 'es',
  late: false,
  activated_at: 1,
});

describe('held alerts', () => {
  it('info waits for the morning, urgent does not', () => {
    expect(heldAtNight(alert('a', 'info'))).toBe(true);
    expect(heldAtNight(alert('b', 'urgent'))).toBe(false);
    expect(heldAtNight(alert('t', 'urgent', 'timer'))).toBe(false); // timers default to urgent
    expect(heldAtNight(alert('t', 'info', 'timer'))).toBe(true); // unless sent as info
  });
  it('at night only urgent alerts are shown; by day all of them, in order', () => {
    const all = [alert('a', 'info'), alert('b', 'urgent'), alert('c', 'info'), alert('t', 'urgent', 'timer')];
    expect(shownAlerts(all, true).map((a) => a.key)).toEqual(['b', 't']);
    expect(shownAlerts(all, false).map((a) => a.key)).toEqual(['a', 'b', 'c', 't']);
    expect(shownAlerts([alert('a', 'info')], true)).toEqual([]);
  });
});

describe('NightMode', () => {
  function night(hours: NightHours | null = NIGHT, wall = at(11, 21, 2)) {
    let ms = 0;
    let now = wall;
    const applied: [number, number][] = [];
    const changes: boolean[] = [];
    const n = new NightMode({
      hours: () => hours,
      apply: (dim, fps) => applied.push([dim, fps]),
      onChange: (on) => changes.push(on),
      now: () => now,
      clock: () => ms,
    });
    return { n, applied, changes, tick: (d: number) => (ms += d), setWall: (d: Date) => (now = d) };
  }

  it('by day: awake, full brightness', () => {
    const { n, applied } = night(NIGHT, at(11, 20, 12));
    n.update(false);
    expect([n.on, n.asleep]).toEqual([false, false]);
    expect(applied).toEqual([[1, Infinity]]);
  });

  it('at night: asleep, dim and slow, applied once', () => {
    const { n, applied, changes } = night();
    n.update(false);
    n.update(false);
    expect([n.on, n.asleep]).toEqual([true, true]);
    expect(applied).toEqual([[NIGHT_DIM, NIGHT_FPS]]);
    expect(changes).toEqual([true]);
  });

  it('a tap wakes it; it dozes off again NIGHT_AWAKE_MS after', () => {
    const { n, applied, tick } = night();
    n.update(false);
    n.poke();
    n.update(false);
    expect(n.asleep).toBe(false);
    tick(NIGHT_AWAKE_MS - 1);
    n.update(false);
    expect(n.asleep).toBe(false);
    tick(1);
    n.update(false);
    expect(n.asleep).toBe(true);
    expect(applied).toEqual([[NIGHT_DIM, NIGHT_FPS], [1, Infinity], [NIGHT_DIM, NIGHT_FPS]]);
  });

  it('stays awake through a turn and counts from its end', () => {
    const { n, tick } = night();
    n.update(true);
    tick(60_000);
    n.update(true); // a long turn
    expect(n.asleep).toBe(false);
    tick(NIGHT_AWAKE_MS - 1);
    n.update(false);
    expect(n.asleep).toBe(false);
    tick(1);
    n.update(false);
    expect(n.asleep).toBe(true);
  });

  it('wakes in the morning and reports the change', () => {
    const { n, applied, changes, setWall } = night();
    n.update(false);
    setWall(at(11, 21, 7, 30));
    n.update(false);
    expect([n.on, n.asleep]).toEqual([false, false]);
    expect(changes).toEqual([true, false]);
    expect(applied.at(-1)).toEqual([1, Infinity]);
  });

  it('night mode off: never asleep', () => {
    const { n, applied, changes } = night(null);
    n.update(false);
    expect(n.asleep).toBe(false);
    expect(applied).toEqual([[1, Infinity]]);
    expect(changes).toEqual([]);
  });
});
