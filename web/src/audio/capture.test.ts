import { describe, expect, it } from 'vitest';
import { OUT_RATE, Recorder, Resampler, levelOf, tailSilenceMs, toS16 } from './pcm';

const tone = (n: number, amp = 0.5, rate = OUT_RATE, f = 200) =>
  Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / rate));

describe('Resampler', () => {
  it.each([48000, 44100, 16000])('turns %i Hz into 16 kHz across 128-sample blocks', (rate) => {
    const r = new Resampler(rate);
    let out = 0;
    const seconds = 2;
    const input = tone(rate * seconds, 0.5, rate);
    for (let i = 0; i < input.length; i += 128) out += r.push(input.subarray(i, i + 128)).length;
    expect(Math.abs(out - OUT_RATE * seconds)).toBeLessThanOrEqual(1);
  });
  it('keeps a low tone and its level', () => {
    const r = new Resampler(48000);
    const out = r.push(tone(48000, 0.5, 48000, 200));
    const rms = Math.sqrt(out.reduce((s, v) => s + v * v, 0) / out.length);
    expect(rms).toBeGreaterThan(0.33);
    expect(rms).toBeLessThan(0.37);
  });
});

describe('toS16', () => {
  it('clips and scales', () => {
    expect(Array.from(toS16(Float32Array.from([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
  });
});

describe('Recorder', () => {
  it('caps the recording at 15 s', () => {
    const r = new Recorder(15_000, 0.01);
    const block = toS16(tone(16000));
    for (let i = 0; i < 20; i++) r.push(block);
    expect(r.full).toBe(true);
    const rec = r.finish();
    expect(rec.pcm.length).toBe(15 * OUT_RATE);
    expect(rec.durMs).toBe(15_000);
  });
  it('reports dur_ms and tail_silence_ms of a synthetic buffer', () => {
    const r = new Recorder(15_000, 0.01);
    r.push(toS16(tone(16000))); // 1 s voiced
    r.push(new Int16Array(8000)); // 0.5 s silence
    const rec = r.finish();
    expect(rec.durMs).toBe(1500);
    expect(rec.tailSilenceMs).toBe(500);
  });
  it('an empty recording is 0 ms long', () => {
    const rec = new Recorder(15_000, 0.01).finish();
    expect(rec).toMatchObject({ durMs: 0, tailSilenceMs: 0 });
  });
});

describe('tailSilenceMs', () => {
  it('is the whole length when nothing is above the threshold', () => {
    expect(tailSilenceMs(toS16(tone(16000, 0.005)), 0.01)).toBe(1000);
  });
  it('is 0 when the last window is voiced', () => {
    expect(tailSilenceMs(toS16(tone(3200)), 0.01)).toBe(0);
  });
  it('counts whole 20 ms windows after the last voiced one', () => {
    const pcm = new Int16Array(16000);
    pcm.set(toS16(tone(320 * 10))); // 200 ms voiced, then 800 ms silence
    expect(tailSilenceMs(pcm, 0.01)).toBe(800);
  });
});

describe('levelOf', () => {
  it('maps RMS to 0..1', () => {
    expect(levelOf(new Float32Array(64))).toBe(0);
    expect(levelOf(Float32Array.from({ length: 64 }, () => 1))).toBe(1);
    expect(levelOf(tone(1600, 0.1))).toBeCloseTo(0.283, 2);
  });
});
