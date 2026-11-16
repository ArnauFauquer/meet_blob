import { describe, expect, it } from 'vitest';
import { ACTS, Actor, REPERTOIRE, rest, type Pose } from './acts';

const TAU = 2 * Math.PI;
const ANGLES = new Set(['yaw', 'pitch', 'roll']);
// Distance from rest; angles count up to whole turns.
const offRest = (p: Partial<Pose>) =>
  Math.max(...Object.entries(p).map(([k, v]) => Math.abs(ANGLES.has(k) ? v - TAU * Math.round(v / TAU) : v)));

describe('acts', () => {
  it.each(Object.keys(ACTS))('%s starts and ends at rest, with no jumps', (name) => {
    const act = ACTS[name];
    expect(offRest(act.pose(0))).toBeLessThan(1e-6);
    expect(offRest(act.pose(act.dur))).toBeLessThan(1e-6);
    let prev = act.pose(0);
    for (let u = 1 / 60; u <= act.dur; u += 1 / 60) {
      const p = act.pose(u);
      for (const k of Object.keys(p) as (keyof Pose)[]) expect(Math.abs((p[k] ?? 0) - (prev[k] ?? 0)), `${name}.${k} at ${u}`).toBeLessThan(0.5);
      prev = p;
    }
  });
  it('every repertoire names real acts', () => {
    for (const { acts } of Object.values(REPERTOIRE)) for (const [a] of acts) expect(ACTS[a]).toBeDefined();
  });
});

describe('Actor', () => {
  const run = (a: Actor, mood: Parameters<Actor['step']>[1], s: number) => {
    const names: string[] = [];
    let kicks = 0;
    for (let t = 0; t < s; t += 1 / 30) {
      const { kick } = a.step(1 / 30, mood);
      kicks += kick;
      if (a.name && names[names.length - 1] !== a.name) names.push(a.name);
    }
    return { names, kicks };
  };
  it('acts at rest, never the same act twice in a row, and kicks the spring', () => {
    const { names, kicks } = run(new Actor(), 'idle', 60);
    expect(names.length).toBeGreaterThan(6);
    for (let i = 1; i < names.length; i++) expect(names[i]).not.toBe(names[i - 1]);
    expect(kicks).not.toBe(0);
  });
  it('is reproducible', () => {
    expect(run(new Actor(), 'info', 30).names).toEqual(run(new Actor(), 'info', 30).names);
  });
  it('without a mood finishes the act and starts no new one', () => {
    const a = new Actor();
    a.play('backflip');
    const { names } = run(a, null, 10);
    expect(names).toEqual(['backflip']);
    expect(a.busy).toBe(false);
    expect(a.step(1 / 30, null).pose).toEqual(rest());
  });
});
