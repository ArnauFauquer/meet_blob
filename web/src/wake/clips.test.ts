import { describe, expect, it } from 'vitest';
import { PcmRing, PhraseSegmenter, ScoreHistory, msToSamples, samplesToMs } from './clips';

const block = (amp: number, n = 320) => {
  const b = new Int16Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.round(amp * 32767 * Math.sin(i / 3));
  return b;
};

// Feeds `ms` of audio at amplitude `amp` in 20 ms blocks; returns the clips cut.
function feed(seg: PhraseSegmenter, amp: number, ms: number): Int16Array[] {
  const out: Int16Array[] = [];
  for (let t = 0; t < ms; t += 20) {
    const c = seg.push(block(amp));
    if (c) out.push(c);
  }
  return out;
}

describe('PcmRing', () => {
  it('returns the most recent samples across the wrap', () => {
    const r = new PcmRing(5);
    r.push(Int16Array.from([1, 2, 3]));
    expect([...r.take(5)]).toEqual([1, 2, 3]);
    r.push(Int16Array.from([4, 5, 6, 7]));
    expect([...r.take(5)]).toEqual([3, 4, 5, 6, 7]);
    expect([...r.take(2)]).toEqual([6, 7]);
    r.push(Int16Array.from([8, 9, 10, 11, 12, 13]));
    expect([...r.take(9)]).toEqual([9, 10, 11, 12, 13]);
  });
});

describe('PhraseSegmenter', () => {
  it('cuts one clip per phrase, with the pre-roll and the quiet tail', () => {
    const seg = new PhraseSegmenter();
    expect(feed(seg, 0.001, 1000)).toEqual([]);
    expect(feed(seg, 0.2, 800)).toEqual([]);
    const [clip] = feed(seg, 0.001, 600);
    expect(samplesToMs(clip.length)).toBeGreaterThanOrEqual(800 + 400);
    expect(samplesToMs(clip.length)).toBeLessThanOrEqual(800 + 400 + 300 + 40);
    expect(feed(seg, 0.2, 700)).toEqual([]);
    expect(feed(seg, 0.001, 600)).toHaveLength(1); // the next phrase
  });

  it('drops clicks and cuts long speech at the cap', () => {
    const seg = new PhraseSegmenter();
    feed(seg, 0.001, 1000);
    feed(seg, 0.3, 120);
    expect(feed(seg, 0.001, 600)).toEqual([]);
    const capped = feed(seg, 0.2, 5000);
    expect(capped).toHaveLength(1);
    expect(capped[0].length).toBeLessThanOrEqual(msToSamples(3000 + 300 + 20));
    expect(feed(seg, 0.001, 600)).toEqual([]); // the rest of the long speech is not a phrase
  });

  it('follows a louder room', () => {
    const seg = new PhraseSegmenter();
    expect(feed(seg, 0.02, 20_000)).toEqual([]); // steady fan noise becomes the floor
    expect(feed(seg, 0.2, 600)).toEqual([]);
    expect(feed(seg, 0.02, 600)).toHaveLength(1);
  });
});

describe('ScoreHistory', () => {
  it('gives the peak over a time range and forgets old scores', () => {
    const h = new ScoreHistory(1000);
    h.add(0.2, 0);
    h.add(0.71234, 500);
    h.add(0.1, 1400);
    expect(h.peak(400, 2000)).toBe(0.712);
    expect(h.peak(0, 100)).toBe(0); // dropped after 1 s
  });
});
