import { describe, expect, it } from 'vitest';
import { ChimeRules, inQuietHours, type ChimeConfig } from './chime';
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
