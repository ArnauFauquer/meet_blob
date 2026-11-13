import { describe, expect, it } from 'vitest';
import { MORPH_S, morphMix, stepMorph, type Morph } from './morph';

const run = (m: Morph, target: number, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) stepMorph(m, target, dt);
};

describe('shape morph', () => {
  it('stays still when the target is the shown shape', () => {
    const m = { a: 0, b: 0, t: 0 };
    run(m, 0, 2);
    expect(m).toEqual({ a: 0, b: 0, t: 0 });
  });
  it('morphs sphere to triangle in about 0.8 s, mid-way at 0.4 s', () => {
    const m = { a: 0, b: 0, t: 0 };
    run(m, 1, MORPH_S / 2);
    expect(m.b).toBe(1);
    expect(morphMix(m)).toBeGreaterThan(0.4);
    expect(morphMix(m)).toBeLessThan(0.6);
    run(m, 1, MORPH_S / 2 + 0.05);
    expect(m).toEqual({ a: 1, b: 1, t: 0 });
    expect(morphMix(m)).toBe(0);
  });
  it('back to the sphere when the alert is cleared', () => {
    const m = { a: 2, b: 2, t: 0 };
    run(m, 0, MORPH_S + 0.05);
    expect(m.a).toBe(0);
  });
  it('a return to the old shape mid-morph reverses without a jump', () => {
    const m = { a: 0, b: 1, t: 0.25 };
    const before = morphMix(m);
    stepMorph(m, 0, 0);
    expect(m.a).toBe(1);
    expect(m.b).toBe(0);
    expect(1 - morphMix(m)).toBeCloseTo(before); // same picture
  });
  it('a new target mid-morph waits until the current morph ends', () => {
    const m = { a: 0, b: 1, t: 0.5 };
    stepMorph(m, 2, 0.1);
    expect(m.b).toBe(1);
    run(m, 2, MORPH_S * 1.5);
    expect(m.a).toBe(2);
  });
});
