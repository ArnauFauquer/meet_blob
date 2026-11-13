import { describe, expect, it } from 'vitest';
import { PeakTracker } from './wake-log';

describe('PeakTracker', () => {
  it('reports nothing for scores below the floor', () => {
    const p = new PeakTracker(0.5);
    for (let t = 0; t < 1000; t += 80) expect(p.score(0.001, t)).toBeNull();
    expect(p.flush(1000)).toBeNull();
  });
  it('one run above the floor becomes its peak when the score drops', () => {
    const p = new PeakTracker(0.5);
    expect(p.score(0.2, 0)).toBeNull();
    expect(p.score(0.4123, 80)).toBeNull();
    expect(p.score(0.3, 160)).toBeNull();
    expect(p.score(0.01, 240)).toEqual({ peak: 0.412, ms: 240, fired: false });
    expect(p.score(0.01, 320)).toBeNull();
  });
  it('a run reaching the threshold is marked fired', () => {
    const p = new PeakTracker(0.5);
    p.score(0.9, 0);
    expect(p.score(0, 80)).toEqual({ peak: 0.9, ms: 80, fired: true });
  });
  it('flush ends a run cut by the gate closing, once', () => {
    const p = new PeakTracker(0.5);
    p.score(0.7, 100);
    expect(p.flush(180)).toEqual({ peak: 0.7, ms: 80, fired: true });
    expect(p.flush(260)).toBeNull();
  });
});
