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
