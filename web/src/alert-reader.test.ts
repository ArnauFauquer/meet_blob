import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALERT_READ_TIMEOUT_MS, AlertReader } from './alert-reader';
import type { ClientMessage } from './protocol';

function setup(playOk = true) {
  const sent: ClientMessage[] = [];
  const deps = {
    send: (m: ClientMessage) => (sent.push(m), true),
    play: vi.fn(() => Promise.resolve(playOk)),
    beep: vi.fn(),
  };
  return { r: new AlertReader(deps), sent, deps };
}
const WAV = new ArrayBuffer(64);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('AlertReader (alert tap row)', () => {
  it('alert_read, plays the tts for that key, alert_ack only after playback ends', async () => {
    const { r, sent, deps } = setup();
    r.read('t1');
    expect(sent).toEqual([{ type: 'alert_read', key: 't1' }]);
    expect(r.reading).toBe(true);
    expect(r.onTts({ alert: 't1' }, WAV)).toBe(true);
    expect(deps.play).toHaveBeenCalledWith(WAV);
    await vi.runAllTicks();
    expect(sent).toHaveLength(1); // still playing: no ack yet
    r.onPlaybackIdle();
    expect(sent[1]).toEqual({ type: 'alert_ack', key: 't1' });
    expect(r.reading).toBe(false);
    expect(deps.beep).not.toHaveBeenCalled();
  });
  it('ignores turn tts and tts for another key', () => {
    const { r, deps } = setup();
    r.read('t1');
    expect(r.onTts({ alert: null }, WAV)).toBe(false);
    expect(r.onTts({ alert: 'other' }, WAV)).toBe(false);
    expect(deps.play).not.toHaveBeenCalled();
  });
  it('playback idle before the audio arrived does not ack (e.g. a reply ending)', () => {
    const { r, sent } = setup();
    r.read('t1');
    r.onPlaybackIdle();
    expect(sent).toHaveLength(1);
    expect(r.reading).toBe(true);
  });
  it('no frame within the timeout: keeps the alert, plays the beep, sends nothing else', () => {
    const { r, sent, deps } = setup();
    r.read('t1');
    vi.advanceTimersByTime(ALERT_READ_TIMEOUT_MS);
    expect(deps.beep).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    expect(r.reading).toBe(false);
  });
  it('error bad_message (synthesis failed, unknown key, turn running): beep, no ack', () => {
    const { r, sent, deps } = setup();
    r.read('t1');
    r.onError({ type: 'error', code: 'bad_message' });
    expect(deps.beep).toHaveBeenCalledTimes(1);
    r.onPlaybackIdle(); // the beep ends
    expect(sent).toHaveLength(1);
  });
  it('audio that cannot be decoded: beep, no ack', async () => {
    const { r, sent, deps } = setup(false);
    r.read('t1');
    r.onTts({ alert: 't1' }, WAV);
    await vi.runAllTicks();
    await Promise.resolve();
    expect(deps.beep).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });
  it('one read at a time; reset forgets it without acking', () => {
    const { r, sent } = setup();
    r.read('t1');
    r.read('t2');
    expect(sent).toHaveLength(1);
    r.reset();
    r.onPlaybackIdle();
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(ALERT_READ_TIMEOUT_MS * 2);
    expect(r.reading).toBe(false);
  });
});
