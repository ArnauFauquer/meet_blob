import { describe, expect, it } from 'vitest';
import {
  DROP_GAP,
  DROP_R_MAX,
  DROP_R_MIN,
  Droplets,
  MAX_DROPS,
  dropRadius,
  dropText,
  orbitFor,
  ripeness,
  shapeExtent,
  textScale,
  textString,
  type Orbit,
} from './droplets';
import { SHAPE } from './tables';

const ORBIT: Orbit = { a: 1.2, b: 1.0, c: 0.25, p: 1, fit: 1 };
const run = (d: Droplets, s: number, timers: { key: string; left_s: number }[], fired: string[] = [], dt = 1 / 30) => {
  let gulps = 0;
  for (let t = 0; t < s; t += dt) gulps += d.step(dt, timers, fired, ORBIT);
  return gulps;
};
const write = (d: Droplets, t = 0) => {
  const drops = new Float32Array(MAX_DROPS * 4);
  const glow = new Float32Array(MAX_DROPS * 2);
  return { ...d.write(t, drops, glow), drops, glow };
};

describe('dropRadius', () => {
  it('shrinks with the time left, between the two bounds', () => {
    expect(dropRadius(0)).toBeCloseTo(DROP_R_MIN);
    expect(dropRadius(7200)).toBeCloseTo(DROP_R_MAX);
    expect(dropRadius(1e6)).toBeCloseTo(DROP_R_MAX);
    expect(dropRadius(-5)).toBeCloseTo(DROP_R_MIN);
    let last = 0;
    for (const s of [0, 10, 60, 300, 600, 1800, 3600, 7200]) {
      expect(dropRadius(s)).toBeGreaterThan(last);
      last = dropRadius(s);
    }
  });

  it('tells a pasta from an oven at a glance', () => {
    // 8 minutes against 45: the oven's drop holds over twice the volume.
    expect((dropRadius(45 * 60) / dropRadius(8 * 60)) ** 3).toBeGreaterThan(2);
  });
});

describe('dropText', () => {
  const show = (s: number) => textString(dropText(s));

  it('reads like a kitchen timer: m:ss, then 1h30 from an hour, seconds alone in the last minute', () => {
    expect(show(45 * 60)).toBe('45:00');
    expect(show(8 * 60)).toBe('8:00');
    expect(show(479.2)).toBe('8:00'); // rounds up, like timerText
    expect(show(61)).toBe('1:01');
    expect(show(60)).toBe('1:00');
    expect(show(59.5)).toBe('1:00');
    expect(show(59)).toBe('59');
    expect(show(5)).toBe('5');
    expect(show(0)).toBe('0');
    expect(show(-3)).toBe('0');
    expect(show(3600)).toBe('1h00');
    expect(show(90 * 60)).toBe('1h30');
    expect(show(12 * 3600)).toBe('12h');
  });

  it('never shows more than four glyphs', () => {
    for (const s of [0, 9, 59, 60, 599, 600, 3599, 3600, 35999, 36000, 1e7]) {
      expect(dropText(s).glyphs.length).toBeLessThanOrEqual(4);
      expect(dropText(s).glyphs.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('fits the text inside the drop, longer text smaller', () => {
    const a = textScale(dropText(45 * 60));
    const b = textScale(dropText(8 * 60));
    const c = textScale(dropText(30));
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    // Half width of "45:00" (four glyphs, a colon, the strokes) inside the drop.
    expect(((3 * 1.6 + 0.55 + 2 * 0.67) / 2) * a).toBeLessThan(0.9);
  });
});

describe('ripeness', () => {
  it('is 0 until the last minute, then rises to 1', () => {
    expect(ripeness(600)).toBe(0);
    expect(ripeness(60)).toBe(0);
    expect(ripeness(30)).toBeCloseTo(0.5);
    expect(ripeness(0)).toBe(1);
  });
});

describe('orbitFor', () => {
  it('clears the shape by the gap and fits a landscape screen, the body barely smaller', () => {
    const ext = shapeExtent(SHAPE.sphere, 1.6);
    const o = orbitFor(ext, DROP_R_MAX, 1.417 * 1.6, 1.36);
    expect(o.a - DROP_R_MAX - ext.w).toBeGreaterThanOrEqual(DROP_GAP - 1e-9);
    expect(o.b - DROP_R_MAX - ext.h).toBeGreaterThanOrEqual(DROP_GAP - 1e-9);
    // Only for the drops passing above and below, and only this much with the
    // largest drops (a two hour timer), which hold the time in digits.
    expect(o.fit).toBeGreaterThan(0.8);
    expect((o.b + DROP_R_MAX) * (3.4 / (3.4 - o.c)) * o.fit).toBeLessThanOrEqual(1.36 - 0.05 + 1e-9);
    expect(orbitFor(shapeExtent(SHAPE.triangle, 1.6), 0.1, 1.417 * 1.6, 1.36).fit).toBeGreaterThan(0.9);
  });

  it('shrinks the body on a portrait screen so the drops stay on it', () => {
    const aspect = 800 / 1280;
    const halfW = 1.417 * aspect;
    const o = orbitFor(shapeExtent(SHAPE.sphere, aspect), DROP_R_MAX, halfW, 1.36);
    expect(o.fit).toBeLessThan(1);
    expect((o.a + DROP_R_MAX) * o.fit).toBeLessThanOrEqual(halfW - 0.05 + 1e-9);
  });

  it('goes round the wide clock, below and above the digits', () => {
    const o = orbitFor(shapeExtent(SHAPE.clock, 1.6), 0.12, 1.417 * 1.6, 1.36);
    expect(o.a).toBeGreaterThan(1.47 + 0.12);
    expect(o.b).toBeGreaterThan(0.62 + 0.12);
    expect(o.p).toBeLessThan(1); // hugs the corners of the box
  });

  it('keeps every drop clear of the clock, corners included', () => {
    // The clock pill as blob.frag draws it at full width: a rounded box.
    const [w, h, rc] = [1.434, 0.6, 0.36];
    const sdBox = (x: number, y: number) => {
      const qx = Math.abs(x) - (w - rc);
      const qy = Math.abs(y) - (h - rc);
      return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rc;
    };
    for (const r of [DROP_R_MIN, 0.12, DROP_R_MAX]) {
      const o = orbitFor(shapeExtent(SHAPE.clock, 1.6), r, 1.417 * 1.6, 1.36);
      for (let i = 0; i < 360; i++) {
        const th = (i / 360) * 2 * Math.PI;
        const x = o.a * Math.sign(Math.cos(th)) * Math.abs(Math.cos(th)) ** o.p;
        const y = o.b * Math.sign(Math.sin(th)) * Math.abs(Math.sin(th)) ** o.p;
        expect(sdBox(x, y) - r).toBeGreaterThan(0.13);
      }
    }
  });
});

describe('Droplets', () => {
  it('gives each pending timer a drop that pinches off the body and moves out', () => {
    const d = new Droplets();
    run(d, 0.1, [{ key: 'pasta', left_s: 480 }, { key: 'oven', left_s: 2700 }]);
    expect(d.drops.map((x) => x.key).sort()).toEqual(['oven', 'pasta']);
    expect(d.drops.every((x) => x.out > 0 && x.out < 0.2)).toBe(true);
    run(d, 2, [{ key: 'pasta', left_s: 478 }, { key: 'oven', left_s: 2698 }]);
    expect(d.drops.every((x) => x.out === 1)).toBe(true);
    const oven = d.drops.find((x) => x.key === 'oven')!;
    const pasta = d.drops.find((x) => x.key === 'pasta')!;
    expect(oven.r).toBeGreaterThan(pasta.r);
  });

  it('spreads the drops evenly round the ring', () => {
    const d = new Droplets();
    run(d, 6, ['a', 'b', 'c'].map((key, i) => ({ key, left_s: 600 * (i + 1) })));
    const angles = d.drops.map((x) => x.ang).sort((x, y) => x - y);
    const gap = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    expect(gap(angles[1] - angles[0])).toBeCloseTo((2 * Math.PI) / 3, 1);
    expect(gap(angles[2] - angles[1])).toBeCloseTo((2 * Math.PI) / 3, 1);
  });

  it('draws the soonest timers only, up to MAX_DROPS', () => {
    const d = new Droplets();
    const timers = Array.from({ length: MAX_DROPS + 3 }, (_, i) => ({ key: `t${i}`, left_s: 1000 - i * 10 }));
    run(d, 0.1, timers);
    expect(d.drops).toHaveLength(MAX_DROPS);
    expect(d.drops.map((x) => x.key)).not.toContain('t0'); // the latest one waits
  });

  it('a fired timer falls back into the body, and counts one gulp', () => {
    const d = new Droplets();
    run(d, 2, [{ key: 'pasta', left_s: 1 }]);
    expect(run(d, 0.1, [], ['pasta'])).toBe(0);
    expect(d.merging).toBe(true);
    expect(d.drops[0].mode).toBe('merge');
    expect(run(d, 1.5, [], ['pasta'])).toBe(1);
    expect(d.drops).toHaveLength(0);
    expect(d.merging).toBe(false);
  });

  it('a cancelled timer fades away instead, with no gulp', () => {
    const d = new Droplets();
    run(d, 2, [{ key: 'pasta', left_s: 100 }]);
    expect(run(d, 0.1, [])).toBe(0);
    expect(d.drops[0].mode).toBe('vanish');
    expect(d.merging).toBe(false);
    expect(run(d, 1, [])).toBe(0);
    expect(d.drops).toHaveLength(0);
  });

  it('a timer set again while its drop leaves keeps the drop', () => {
    const d = new Droplets();
    run(d, 2, [{ key: 'pasta', left_s: 100 }]);
    run(d, 0.2, []);
    run(d, 0.5, [{ key: 'pasta', left_s: 300 }]);
    expect(d.drops).toHaveLength(1);
    expect(d.drops[0].mode).toBe('orbit');
  });

  it('writes drops on the orbit, away from the body, and ripe drops glow', () => {
    const d = new Droplets();
    run(d, 3, [{ key: 'tea', left_s: 20 }, { key: 'oven', left_s: 2700 }]);
    const w = write(d, 1);
    expect(w.n).toBe(2);
    for (let i = 0; i < 2; i++) {
      const [x, y, z, r] = w.drops.slice(i * 4, i * 4 + 4);
      expect(Math.hypot(x, y, z) - r).toBeGreaterThan(0.78); // outside the sphere
      expect(w.reach).toBeGreaterThanOrEqual(Math.hypot(x, y, z) + r);
    }
    const ripe = [w.glow[1], w.glow[3]].sort();
    expect(ripe[0]).toBe(0); // the oven
    expect(ripe[1]).toBeCloseTo(ripeness(20)); // the tea, in its last minute
  });

  it('keeps the sphere volume: the body gives up what the drops hold', () => {
    const d = new Droplets();
    expect(write(d).vol).toBe(1);
    expect(write(d).reach).toBe(0);
    run(d, 3, [{ key: 'oven', left_s: 7200 }]);
    const { vol, drops } = write(d);
    const r = drops[3];
    // body (vol^3 of the sphere) plus the drop (also scaled by vol) = the sphere.
    expect(vol ** 3 * (0.78 ** 3 + r ** 3)).toBeCloseTo(0.78 ** 3, 6);
    expect(vol).toBeLessThan(1);
  });
});
