import { describe, expect, it } from 'vitest';
import { CHUNK, EMB, FEATURES, OwwPipeline, isVerifier, verify, type OwwModels, type Verifier } from './oww';

const N = FEATURES * EMB;
const fake = (score: number): OwwModels => ({
  mel: async () => new Float32Array(8 * 32),
  embed: async () => new Float32Array(EMB).fill(1),
  score: async () => score,
});
const verifier = (over: Partial<Verifier> = {}): Verifier => ({
  gate: 0.1,
  mean: Array(N).fill(0),
  scale: Array(N).fill(1),
  coef: Array(N).fill(0),
  intercept: 2,
  ...over,
});

describe('custom verifier', () => {
  it('is logistic regression on the standardised features', () => {
    const f = new Float32Array(N).fill(1);
    expect(verify(verifier(), f)).toBeCloseTo(1 / (1 + Math.exp(-2)));
    const v = verifier({ intercept: 0, coef: Array(N).fill(0).map((_, i) => (i === 3 ? 4 : 0)), mean: Array(N).fill(0.5), scale: Array(N).fill(0.5) });
    expect(verify(v, f)).toBeCloseTo(1 / (1 + Math.exp(-4)));
  });

  it('replaces the score only from the gate up', async () => {
    const pcm = new Int16Array(CHUNK);
    expect(await new OwwPipeline(fake(0.3), verifier()).push(pcm)).toEqual([expect.closeTo(0.881, 3)]);
    expect(await new OwwPipeline(fake(0.05), verifier()).push(pcm)).toEqual([0.05]);
    expect(await new OwwPipeline(fake(0.3)).push(pcm)).toEqual([0.3]);
  });

  it('rejects a malformed file', () => {
    expect(isVerifier(verifier())).toBe(true);
    expect(isVerifier({ ...verifier(), coef: [1, 2] })).toBe(false);
    expect(isVerifier({ ...verifier(), gate: 'x' })).toBe(false);
    expect(isVerifier(null)).toBe(false);
  });
});
