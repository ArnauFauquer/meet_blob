import { describe, expect, it } from 'vitest';
import {
  BLOCK_MS,
  ECHO_HANGOVER_MS,
  NOISE_MIN_MS,
  NOISE_STALE_MS,
  NoiseFloor,
  SILENT_DBFS,
  blockDbfs,
  eligible,
} from './noise';
import { block } from './blocks.testutil';

// Feeds `ms` of blocks at `db` and returns the clock after them.
function feed(f: NoiseFloor, db: number, ms: number, t0: number, wobbleDb = 2): number {
  let t = t0;
  for (let i = 0; i < ms / BLOCK_MS; i++) f.push(blockDbfs(block(db, wobbleDb)), (t += BLOCK_MS));
  return t;
}

describe('blockDbfs', () => {
  it('is the RMS level of the block in dBFS', () => {
    expect(blockDbfs(block(-3))).toBeCloseTo(-3, 1);
    expect(blockDbfs(block(-50))).toBeCloseTo(-50, 1);
  });
  it('counts digital silence and an empty block as the floor', () => {
    expect(blockDbfs(new Int16Array(320))).toBe(SILENT_DBFS);
    expect(blockDbfs(new Int16Array(0))).toBe(SILENT_DBFS);
  });
});

describe('NoiseFloor', () => {
  it('has no estimate until it has heard enough', () => {
    const f = new NoiseFloor();
    const t = feed(f, -50, NOISE_MIN_MS - BLOCK_MS, 0);
    expect(f.estimate(t)).toBeNull();
    feed(f, -50, BLOCK_MS, t);
    expect(f.estimate(t + BLOCK_MS)).not.toBeNull();
  });

  it('reads a steady background', () => {
    const f = new NoiseFloor();
    const t = feed(f, -48, 5000, 0);
    expect(f.estimate(t)).toBeGreaterThan(-50);
    expect(f.estimate(t)).toBeLessThan(-47);
  });

  it('is not moved by short loud sounds over the background (a door, a cough, the wake word)', () => {
    const f = new NoiseFloor();
    let t = feed(f, -55, 4000, 0);
    const before = f.estimate(t)!;
    t = feed(f, -15, 300, t); // a door
    t = feed(f, -55, 1000, t);
    t = feed(f, -25, 1200, t); // "hey jarvis"
    expect(Math.abs(f.estimate(t)! - before)).toBeLessThan(1.5);
  });

  it('reads the background under talk with pauses (a tap recording)', () => {
    const f = new NoiseFloor();
    let t = feed(f, -52, 300, 0); // before the user speaks
    for (let w = 0; w < 6; w++) {
      t = feed(f, -22, 350, t); // a word
      t = feed(f, -52, 120, t); // the gap after it
    }
    expect(f.estimate(t)).toBeLessThan(-49);
  });

  it('follows a lasting change within the window, rising slowly and falling sooner', () => {
    const f = new NoiseFloor();
    let t = feed(f, -55, 8000, 0);
    t = feed(f, -35, 3000, t); // the hood goes on
    expect(f.estimate(t)).toBeLessThan(-52);
    t = feed(f, -35, 4000, t);
    expect(f.estimate(t)).toBeGreaterThan(-38);
    t = feed(f, -55, 2000, t); // and off again: back down sooner (a fifth of the window)
    expect(f.estimate(t)).toBeLessThan(-52);
  });

  it('forgets an old estimate', () => {
    const f = new NoiseFloor();
    const t = feed(f, -40, 2000, 0);
    expect(f.estimate(t + NOISE_STALE_MS)).not.toBeNull();
    expect(f.estimate(t + NOISE_STALE_MS + 1)).toBeNull();
    f.clear();
    expect(f.estimate(t)).toBeNull();
  });
});

describe('eligible', () => {
  it('skips Blob playing, the echo after it, and speech', () => {
    expect(eligible(0, false)).toBe(false);
    expect(eligible(ECHO_HANGOVER_MS - 1, false)).toBe(false);
    expect(eligible(ECHO_HANGOVER_MS, false)).toBe(true);
    expect(eligible(Infinity, true)).toBe(false);
  });
});
