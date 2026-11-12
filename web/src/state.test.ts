import { describe, expect, it } from 'vitest';
import { computeView, overlayActive, setsOverlay, type ViewInput } from './state';
import { TURN_DONE_REASONS } from './protocol';

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
