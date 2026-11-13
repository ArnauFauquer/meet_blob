import { describe, expect, it } from 'vitest';
import { FollowUp, PLAYBACK_HANGOVER_MS, wakeAllowed, type GateInput } from './wake-gate';

const idle: GateInput = { enabled: true, phase: 'idle', conv: 'idle', playing: false, lastPlaybackEnd: null, followup: false, now: 10_000 };

describe('wakeAllowed', () => {
  it('runs in local idle on a wake device', () => {
    expect(wakeAllowed(idle)).toBe(true);
  });
  it('never on a device with wake=false or before the model loaded', () => {
    expect(wakeAllowed({ ...idle, enabled: false })).toBe(false);
  });
  it('only while the local state is idle', () => {
    for (const phase of ['requested', 'listening', 'thinking'] as const) expect(wakeAllowed({ ...idle, phase })).toBe(false);
    for (const conv of ['listening', 'thinking', 'speaking'] as const) expect(wakeAllowed({ ...idle, conv })).toBe(false);
  });
  it('muted during playback and for 0.5 s after it', () => {
    expect(wakeAllowed({ ...idle, playing: true })).toBe(false);
    const end = idle.now - PLAYBACK_HANGOVER_MS + 1;
    expect(wakeAllowed({ ...idle, lastPlaybackEnd: end })).toBe(false);
    expect(wakeAllowed({ ...idle, lastPlaybackEnd: idle.now - PLAYBACK_HANGOVER_MS })).toBe(true);
  });
  it('muted while a follow-up is due or its window is open', () => {
    expect(wakeAllowed({ ...idle, followup: true })).toBe(false);
  });
});

describe('FollowUp', () => {
  it('a tts with followup=true opens the window once playback and the turn have ended', () => {
    const f = new FollowUp();
    f.onTts(true);
    expect(f.active).toBe(true);
    expect(f.take(true, 'idle')).toBe(false); // reply still playing
    expect(f.take(false, 'thinking')).toBe(false); // turn_done not yet here
    expect(f.take(false, 'idle')).toBe(true);
    expect(f.listening).toBe(true);
    expect(f.take(false, 'idle')).toBe(false); // once per reply
    f.closed();
    expect(f.active).toBe(false);
  });
  it('a tts without followup opens nothing', () => {
    const f = new FollowUp();
    f.onTts(false);
    expect(f.take(false, 'idle')).toBe(false);
    expect(f.active).toBe(false);
  });
  it('a cancel tap or a dropped socket forgets it', () => {
    const f = new FollowUp();
    f.onTts(true);
    f.clear();
    expect(f.take(false, 'idle')).toBe(false);
  });
});
