// Shape morph state for the renderer: shape a is shown, b is being morphed to.
export const MORPH_S = 0.8; // duration of one morph (about 0.8 s, design)

export interface Morph {
  a: number;
  b: number;
  t: number; // progress 0..1 from a to b
}

// Advances the morph towards `target`. A morph in progress finishes before the
// next one starts, except a return to `a`, which reverses it smoothly.
export function stepMorph(m: Morph, target: number, dt: number): void {
  if (m.a === m.b) {
    if (target === m.a) return;
    m.b = target;
    m.t = 0;
  } else if (target === m.a) {
    [m.a, m.b] = [m.b, m.a];
    m.t = 1 - m.t;
  }
  m.t = Math.min(1, m.t + dt / MORPH_S);
  if (m.t >= 1) {
    m.a = m.b;
    m.t = 0;
  }
}

// uMix for the shader: eased progress (0 when no morph runs).
export function morphMix(m: Morph): number {
  return m.t * m.t * (3 - 2 * m.t);
}

// One full twirl about the vertical axis during a morph, landing facing front.
// A morph reversed mid-way unwinds the twirl instead of jumping.
export interface Twirl {
  angle: number; // radians
  e: number; // eased morph progress at the last step
  dir: number; // +1 or -1
  a: number; // the morph's shapes at the last step
  b: number;
}

export const newTwirl = (): Twirl => ({ angle: 0, e: 0, dir: 1, a: 0, b: 0 });

// Call after stepMorph each frame.
export function stepTwirl(tw: Twirl, m: Morph): void {
  if (m.a === m.b) {
    Object.assign(tw, newTwirl(), { a: m.a, b: m.b });
    return;
  }
  if (tw.a !== tw.b && m.a === tw.b && m.b === tw.a) {
    tw.dir = -tw.dir;
    tw.e = 1 - tw.e;
  }
  const e = morphMix(m);
  tw.angle += tw.dir * 2 * Math.PI * (e - tw.e);
  Object.assign(tw, { e, a: m.a, b: m.b });
}
