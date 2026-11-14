import { describe, expect, it } from 'vitest';
import { ALERT_COLOR, CLOCK_AFTER_MS, CLOCK_LOOK, SHAPE, STATE_LOOK, alertLook, alertShape, clockDigits } from './tables';

describe('alert table', () => {
  it('timer is a triangle, every other source a square', () => {
    expect(alertShape('timer')).toBe(SHAPE.triangle);
    for (const s of ['calendar', 'homeassistant', 'hermes', 'anything']) expect(alertShape(s)).toBe(SHAPE.square);
  });
  it('info is green, urgent is red', () => {
    const [ir, ig] = alertLook('info').color;
    const [ur, ug] = alertLook('urgent').color;
    expect(ig).toBeGreaterThan(ir);
    expect(ur).toBeGreaterThan(ug);
    expect(alertLook('info').color).toEqual(ALERT_COLOR.info);
  });
  it('urgent pulses at twice the rate of info', () => {
    expect(alertLook('urgent').breathHz).toBeCloseTo(alertLook('info').breathHz * 2);
  });
  it('returns a copy, so the renderer can ease it in place', () => {
    alertLook('info').color[0] = 9;
    expect(ALERT_COLOR.info[0]).not.toBe(9);
  });
});

describe('idle clock', () => {
  it('appears after five minutes, in the idle colours with a calmer surface', () => {
    expect(CLOCK_AFTER_MS).toBe(300_000);
    expect(CLOCK_LOOK.color).toEqual(STATE_LOOK.idle.color);
    expect(CLOCK_LOOK.amp).toBeLessThan(STATE_LOOK.idle.amp);
  });
  it('shows local HH:MM as four digits, with leading zeros', () => {
    expect(clockDigits(new Date(2026, 0, 1, 9, 41))).toEqual([0, 9, 4, 1]);
    expect(clockDigits(new Date(2026, 0, 1, 23, 5))).toEqual([2, 3, 0, 5]);
    expect(clockDigits(new Date(2026, 0, 1, 0, 0))).toEqual([0, 0, 0, 0]);
  });
});

describe('lava face', () => {
  it('only speaking smiles with happy eyes and moves the mouth with the level', () => {
    for (const [row, look] of Object.entries(STATE_LOOK)) {
      expect(look.happy > 0, row).toBe(row === 'speaking');
      expect(look.talk > 0, row).toBe(row === 'speaking');
    }
  });
  it('error frowns with closed eyes; alerts keep a face', () => {
    expect(STATE_LOOK.error.smile).toBeLessThan(0);
    expect(STATE_LOOK.error.eyeH).toBeLessThan(STATE_LOOK.idle.eyeH / 4);
    expect(alertLook('info').face).toBeGreaterThan(0);
    expect(alertLook('urgent').mouth).toBeGreaterThan(0);
  });
});
