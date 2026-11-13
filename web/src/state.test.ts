import { describe, expect, it } from 'vitest';
import { computeView, overlayActive, setsOverlay, topAlert, turnActive, type ViewInput } from './state';
import { TURN_DONE_REASONS, type AlertItem } from './protocol';

const base: ViewInput = { online: true, conv: 'idle', playing: false, overlay: false };

describe('computeView precedence', () => {
  it('offline wins over everything', () => {
    expect(computeView({ online: false, conv: 'speaking', playing: true, overlay: true })).toBe('offline');
  });
  it('the error overlay wins over the conversation turn', () => {
    expect(computeView({ ...base, overlay: true, conv: 'thinking', playing: true })).toBe('error');
  });
  it('keeps speaking while local playback runs, even after the backend went idle', () => {
    expect(computeView({ ...base, conv: 'idle', playing: true })).toBe('speaking');
  });
  it('shows the conversation state otherwise', () => {
    for (const conv of ['idle', 'listening', 'thinking', 'speaking'] as const) {
      expect(computeView({ ...base, conv })).toBe(conv);
    }
  });
  it('a mirror that never played audio shows speaking from the snapshot until the next one', () => {
    expect(computeView({ ...base, conv: 'speaking' })).toBe('speaking');
    expect(computeView({ ...base, conv: 'idle' })).toBe('idle');
  });
});

describe('error overlay', () => {
  it('is set only for failure reasons', () => {
    const set = TURN_DONE_REASONS.filter(setsOverlay);
    expect(set).toEqual(['stt_fail', 'hermes_fail', 'timeout', 'tts_fail']);
  });
  it('clears 3 s after it was set when nothing plays', () => {
    expect(overlayActive(null, 0, false)).toBe(false);
    expect(overlayActive(1000, 3999, false)).toBe(true);
    expect(overlayActive(1000, 4000, false)).toBe(false);
  });
  it('stays while local playback (fallback line or beep) runs', () => {
    expect(overlayActive(1000, 60_000, true)).toBe(true);
    expect(overlayActive(1000, 60_000, false)).toBe(false);
  });
});

const alert = (key: string, urgency: 'info' | 'urgent', activated_at: number, source = 'timer'): AlertItem => ({
  key, source, urgency, text: key, lang: 'es', late: false, activated_at,
});

describe('alerts in the view', () => {
  const a = [alert('t1', 'info', 100)];
  it('an alert shows when no turn is active', () => {
    expect(computeView({ ...base, alerts: a })).toBe('alert');
    expect(computeView({ ...base, alerts: [] })).toBe('idle');
  });
  it('precedence: offline > error overlay > turn > alert > idle', () => {
    expect(computeView({ ...base, alerts: a, online: false })).toBe('offline');
    expect(computeView({ ...base, alerts: a, overlay: true })).toBe('error');
    for (const conv of ['listening', 'thinking', 'speaking'] as const) {
      expect(computeView({ ...base, alerts: a, conv })).toBe(conv);
    }
    expect(computeView({ ...base, alerts: a, playing: true })).toBe('speaking');
  });
  it('an alert that arrives during a turn is held hidden until the turn ends', () => {
    const during = { ...base, conv: 'thinking' as const, alerts: a };
    expect(computeView(during)).toBe('thinking');
    expect(computeView({ ...during, conv: 'idle', playing: true })).toBe('speaking'); // reply still playing
    expect(computeView({ ...during, conv: 'idle' })).toBe('alert');
  });
  it('turnActive: backend not idle, or local reply still playing', () => {
    expect(turnActive({ conv: 'idle', playing: false })).toBe(false);
    expect(turnActive({ conv: 'listening', playing: false })).toBe(true);
    expect(turnActive({ conv: 'idle', playing: true })).toBe(true);
  });
});

describe('topAlert', () => {
  it('urgent before info, then oldest first', () => {
    const list = [alert('i-old', 'info', 1), alert('u-new', 'urgent', 30), alert('u-old', 'urgent', 20), alert('i-new', 'info', 5)];
    expect(topAlert(list)?.key).toBe('u-old');
    expect(topAlert(list.filter((x) => x.urgency === 'info'))?.key).toBe('i-old');
    expect(topAlert([])).toBeNull();
  });
  it('same urgency and age: key order, so every client agrees', () => {
    expect(topAlert([alert('b', 'info', 1), alert('a', 'info', 1)])?.key).toBe('a');
  });
});
