import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Endpointer, MIN_SPEECH_MS, SILENCE_END_MS, TOTAL_MS, VadController, type VadEnd } from './vad';

const FRAME = 32;

// Feeds `ms` of frames with probability p; returns the first end, if any.
function feed(ep: Endpointer, clock: { t: number }, p: number, ms: number): VadEnd | null {
  for (let i = 0; i < ms; i += FRAME) {
    clock.t += FRAME;
    const end = ep.push(p);
    if (end) return end;
  }
  return null;
}

function setup(noSpeechMs = 8000) {
  const clock = { t: 1000 };
  return { clock, ep: new Endpointer({ noSpeechMs }, () => clock.t) };
}

describe('Endpointer (VAD limits, injected clock)', () => {
  it('ends the utterance after 0.6 to 0.8 s of silence following speech', () => {
    const { clock, ep } = setup();
    expect(feed(ep, clock, 0.9, 1500)).toBeNull();
    expect(ep.speaking).toBe(true);
    const silenceStart = clock.t;
    expect(feed(ep, clock, 0.05, 2000)).toBe('speech_end');
    const took = clock.t - silenceStart;
    expect(SILENCE_END_MS).toBeGreaterThanOrEqual(600);
    expect(SILENCE_END_MS).toBeLessThanOrEqual(800);
    expect(took).toBeGreaterThanOrEqual(SILENCE_END_MS);
    expect(took).toBeLessThan(SILENCE_END_MS + FRAME);
  });
  it('short pauses inside speech do not end it (hysteresis between 0.35 and 0.5)', () => {
    const { clock, ep } = setup();
    feed(ep, clock, 0.9, 500);
    expect(feed(ep, clock, 0.05, 400)).toBeNull();
    expect(feed(ep, clock, 0.4, 600)).toBeNull(); // between the thresholds keeps speech alive
    expect(feed(ep, clock, 0.9, 300)).toBeNull();
    expect(feed(ep, clock, 0.1, 1000)).toBe('speech_end');
  });
  it('no speech within listen_no_speech_s (8 s): no_speech', () => {
    const { clock, ep } = setup(8000);
    expect(feed(ep, clock, 0.1, 7900)).toBeNull();
    expect(feed(ep, clock, 0.1, 200)).toBe('no_speech');
    expect(clock.t - 1000).toBeGreaterThanOrEqual(8000);
  });
  it('the follow-up window uses its own limit (6 s)', () => {
    const { clock, ep } = setup(6000);
    expect(feed(ep, clock, 0.1, 6100)).toBe('no_speech');
    expect(clock.t - 1000).toBeLessThan(6100);
  });
  it('a click shorter than the minimum speech is not speech', () => {
    const { clock, ep } = setup(2000);
    feed(ep, clock, 0.9, MIN_SPEECH_MS - FRAME);
    expect(ep.speaking).toBe(false);
    expect(feed(ep, clock, 0.1, 3000)).toBe('no_speech');
  });
  it('15 s in total ends it even while speech goes on', () => {
    const { clock, ep } = setup();
    expect(feed(ep, clock, 0.9, TOTAL_MS + 100)).toBe('cap');
    expect(clock.t - 1000).toBeGreaterThanOrEqual(TOTAL_MS);
  });
  it('time limits apply without frames (check)', () => {
    const { clock, ep } = setup(8000);
    clock.t += 8000;
    expect(ep.check()).toBe('no_speech');
  });
});

describe('VadController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resets the model, reports one end, then stops', () => {
    let t = 0;
    const reset = vi.fn();
    const vad = new VadController(reset, () => t);
    const ends: VadEnd[] = [];
    vad.start({ noSpeechMs: 6000 }, (e) => ends.push(e));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(vad.active).toBe(true);
    for (; t < 1000; t += 32) vad.onProb(0.9);
    for (; t < 2000; t += 32) vad.onProb(0.0);
    expect(ends).toEqual(['speech_end']);
    expect(vad.active).toBe(false);
    vad.onProb(0.0);
    expect(ends).toHaveLength(1);
  });
  it('the timer ends a window when frames stop coming', () => {
    let t = 0;
    const vad = new VadController(() => {}, () => t);
    const ends: VadEnd[] = [];
    vad.start({ noSpeechMs: 6000 }, (e) => ends.push(e));
    t = 6000;
    vi.advanceTimersByTime(300);
    expect(ends).toEqual(['no_speech']);
  });
  it('stop drops the pending end', () => {
    let t = 0;
    const vad = new VadController(() => {}, () => t);
    const onEnd = vi.fn();
    vad.start({ noSpeechMs: 100 }, onEnd);
    vad.stop();
    t = 1000;
    vi.advanceTimersByTime(1000);
    vad.onProb(0);
    expect(onEnd).not.toHaveBeenCalled();
  });
});
