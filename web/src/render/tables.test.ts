import { describe, expect, it } from 'vitest';
import { ALERT_COLOR, SHAPE, alertLook, alertShape } from './tables';

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
