import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALARM_DETUNE, ALARM_EVERY_MS, pickRing, ALARM_MS, ALARM_START_GAIN, Alarm, alarmGain, ChimeRules, inQuietHours, type ChimeConfig } from './chime';
import type { AlertItem } from '../protocol';

const at = (h: number, m = 0) => new Date(2026, 10, 12, h, m);
const alert = (key: string): AlertItem => ({ key, source: 'timer', urgency: 'urgent', text: '', lang: 'es', late: false, activated_at: 1 });

function rules(cfg: Partial<ChimeConfig> = {}, now = at(12)) {
  const c: ChimeConfig = { sound: true, quiet_hours: '', ...cfg };
  let clock = now;
  const r = new ChimeRules(() => c, () => clock);
  return { r, c, setClock: (d: Date) => (clock = d) };
}

describe('inQuietHours', () => {
  it('a window that crosses midnight', () => {
    expect(inQuietHours('22:00-07:00', at(21, 59))).toBe(false);
    expect(inQuietHours('22:00-07:00', at(22, 0))).toBe(true);
    expect(inQuietHours('22:00-07:00', at(3))).toBe(true);
    expect(inQuietHours('22:00-07:00', at(6, 59))).toBe(true);
    expect(inQuietHours('22:00-07:00', at(7, 0))).toBe(false);
  });
  it('a window inside one day', () => {
    expect(inQuietHours('13:30-15:00', at(13, 29))).toBe(false);
    expect(inQuietHours('13:30-15:00', at(14))).toBe(true);
    expect(inQuietHours('13:30-15:00', at(15))).toBe(false);
  });
  it('empty, malformed or zero-length: never quiet', () => {
    for (const s of ['', 'night', '25:00-07:00', '22:00', '22:00-22:00', '22:61-07:00']) {
      expect(inQuietHours(s, at(23))).toBe(false);
    }
  });
});

describe('ChimeRules', () => {
  it('plays once per alert when it becomes active', () => {
    const { r } = rules();
    expect(r.update([alert('a')], false)).toBe(true);
    expect(r.update([alert('a')], false)).toBe(false); // next snapshot, same alert
    expect(r.update([alert('a'), alert('b')], false)).toBe(true); // a new one
    expect(r.update([alert('a'), alert('b')], false)).toBe(false);
  });
  it('alerts that arrive together share one chime', () => {
    const { r } = rules();
    expect(r.update([alert('a'), alert('b')], false)).toBe(true);
    expect(r.update([alert('a'), alert('b')], false)).toBe(false);
  });
  it('is held during a turn and plays at turn end if the alert is still open', () => {
    const { r } = rules();
    expect(r.update([alert('a')], true)).toBe(false);
    expect(r.update([alert('a')], true)).toBe(false);
    expect(r.update([alert('a')], false)).toBe(true);
    expect(r.update([alert('a')], false)).toBe(false);
  });
  it('is skipped if the alert is gone when the turn ends', () => {
    const { r } = rules();
    expect(r.update([alert('a')], true)).toBe(false);
    expect(r.update([], true)).toBe(false);
    expect(r.update([], false)).toBe(false);
  });
  it('a re-raised alert (gone, then back) chimes again', () => {
    const { r } = rules();
    expect(r.update([alert('a')], false)).toBe(true);
    expect(r.update([], false)).toBe(false);
    expect(r.update([alert('a')], false)).toBe(true);
  });
  it('never plays on a device with sound=false', () => {
    const { r } = rules({ sound: false });
    expect(r.update([alert('a')], false)).toBe(false);
  });
  it('is muted inside quiet hours (browser local time) and not replayed later', () => {
    const { r, setClock } = rules({ quiet_hours: '22:00-07:00' }, at(23));
    expect(r.update([alert('a')], false)).toBe(false);
    setClock(at(8));
    expect(r.update([alert('a')], false)).toBe(false);
    expect(r.update([alert('a'), alert('b')], false)).toBe(true);
  });
});

describe('Alarm', () => {
  function alarm() {
    let t = 0;
    let hush = false;
    let rings = 0;
    const gains: number[] = [];
    const a = new Alarm({ ring: (g) => (rings += 1, gains.push(g)), hush: () => hush, now: () => t });
    const advance = (ms: number) => {
      for (let i = 0; i < ms; i += 100) {
        t += 100;
        vi.advanceTimersByTime(100);
      }
    };
    return { a, advance, gains, rings: () => rings, setHush: (h: boolean) => (hush = h) };
  }
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('repeats the sound for 30 s, then stops', () => {
    const { a, advance, rings } = alarm();
    a.start(['a']);
    expect(rings()).toBe(1);
    advance(ALARM_EVERY_MS);
    expect(rings()).toBe(2);
    advance(ALARM_MS);
    expect(a.ringing).toBe(false);
    const n = rings();
    expect(n).toBe(Math.ceil(ALARM_MS / ALARM_EVERY_MS));
    advance(10_000);
    expect(rings()).toBe(n);
  });
  it('starts soft and swells to full volume', () => {
    const { a, advance, gains } = alarm();
    a.start(['a']);
    advance(ALARM_MS);
    expect(gains[0]).toBe(ALARM_START_GAIN);
    for (let i = 1; i < gains.length; i++) expect(gains[i]).toBeGreaterThanOrEqual(gains[i - 1]);
    expect(gains.at(-1)).toBe(1);
    expect(alarmGain(-5)).toBe(ALARM_START_GAIN);
  });
  it('stops when its alerts leave the snapshot', () => {
    const { a, rings, advance } = alarm();
    a.start(['a', 'b']);
    a.update(['b', 'c']);
    expect(a.ringing).toBe(true);
    a.update(['c']);
    expect(a.ringing).toBe(false);
    advance(ALARM_EVERY_MS * 3);
    expect(rings()).toBe(1);
  });
  it('stops when hushed (a turn, a read) or on stop()', () => {
    const { a, advance, setHush } = alarm();
    a.start(['a']);
    setHush(true);
    advance(ALARM_EVERY_MS);
    expect(a.ringing).toBe(false);
    setHush(false);
    a.start(['b']);
    a.stop();
    expect(a.ringing).toBe(false);
  });
  it('a new alert while ringing joins it and gives it another 30 s', () => {
    const { a, advance } = alarm();
    a.start(['a']);
    advance(20_000);
    a.start(['b']);
    expect(a.started).toBe(1);
    advance(20_000);
    expect(a.ringing).toBe(true);
    advance(10_000 + ALARM_EVERY_MS);
    expect(a.ringing).toBe(false);
  });
  it('remembers which alerts a play was for', () => {
    const { r } = rules();
    r.update([alert('a'), alert('b')], false);
    expect(r.fired).toEqual(['a', 'b']);
  });
});

describe('pickRing', () => {
  it('never repeats the previous sound and uses them all', () => {
    const seen = new Set<number>();
    let prev = -1;
    for (let i = 0; i < 200; i++) {
      const { index } = pickRing(prev, 3, Math.random);
      expect(index).not.toBe(prev);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(3);
      seen.add(index);
      prev = index;
    }
    expect(seen.size).toBe(3);
  });
  it('detunes within the limit', () => {
    expect(pickRing(-1, 3, () => 0).rate).toBeCloseTo(1 - ALARM_DETUNE);
    expect(pickRing(-1, 3, () => 0.999999).rate).toBeCloseTo(1 + ALARM_DETUNE);
    expect(pickRing(2, 3, () => 0.999999).index).toBe(1);
    expect(pickRing(0, 1, () => 0.5).index).toBe(0);
  });
});
