// Little acts that give the blob a life of its own while it rests: it looks
// to a side, does a backflip, yawns, nods off... Each act is a pose over its
// own time that starts and ends at rest (angles up to whole turns), so acts
// chain without jumps. Animation rules: the eyes lead the body, a jump
// crouches first and lands with a squash (kicks on the squash spring).

export interface Pose {
  x: number; // body offset (the blob radius is 0.78), +y up, +z towards the camera
  y: number;
  z: number;
  yaw: number; // radians: + turns the face to the viewer's right
  pitch: number; // + nods the face down, - lifts it (a backflip is -2π)
  roll: number; // + tilts the top to the viewer's left
  sq: number; // + taller, - wider
  gx: number; // gaze offset
  gy: number;
  lid: number; // eye opening - 1: -1 closed, + wide
  happy: number; // towards happy arcs
  smile: number;
  mouth: number; // mouth opening
}

export const rest = (): Pose => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, sq: 0, gx: 0, gy: 0, lid: 0, happy: 0, smile: 0, mouth: 0 });

// The pose scaled towards rest by w (1 unchanged, 0 rest).
export function scaled(p: Pose, w: number): Pose {
  const out = rest();
  for (const k of Object.keys(out) as (keyof Pose)[]) out[k] = p[k] * w;
  return out;
}

export interface Act {
  dur: number; // s
  pose: (u: number) => Partial<Pose>; // u: seconds into the act
  kicks?: [number, number][]; // [time, impulse] on the squash spring
}

const TAU = 2 * Math.PI;
const sm = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const ramp = (u: number, a: number, b: number) => sm((u - a) / (b - a));
// Up from a to b, held, down from c to d.
const hold = (u: number, a: number, b: number, c: number, d: number) => ramp(u, a, b) * (1 - ramp(u, c, d));
// A jump's height between take-off a and landing b: a parabola, 1 at the top.
const arc = (u: number, a: number, b: number) => {
  const s = (u - a) / (b - a);
  return s <= 0 || s >= 1 ? 0 : 4 * s * (1 - s);
};
const wave = (u: number, hz: number) => Math.sin(TAU * hz * u);

const lookSide = (d: number): Act => ({
  dur: 2.6,
  pose: (u) => {
    const turn = hold(u, 0.12, 0.55, 1.85, 2.45);
    return { gx: d * 0.15 * hold(u, 0, 0.12, 1.9, 2.15), gy: 0.02 * turn, yaw: d * 0.5 * turn, roll: -d * 0.07 * turn, x: d * 0.03 * turn };
  },
  kicks: [[0.12, -1.2], [2.3, -0.8]],
});

export const ACTS: Record<string, Act> = {
  lookLeft: lookSide(-1),
  lookRight: lookSide(1),
  // Left, a blink while the head turns, right, back.
  lookAround: {
    dur: 4.2,
    pose: (u) => {
      const l = hold(u, 0.1, 0.5, 1.3, 1.75);
      const r = hold(u, 1.6, 2.1, 3.2, 3.8);
      return {
        gx: 0.15 * (hold(u, 1.45, 1.85, 3.1, 3.6) - hold(u, 0, 0.3, 1.2, 1.5)),
        yaw: 0.45 * (r - l),
        roll: 0.06 * (l - r),
        lid: -hold(u, 1.45, 1.52, 1.58, 1.66),
      };
    },
    kicks: [[0.1, -1], [1.6, -1]],
  },
  // Crouch, eyes squeezed; jump and turn over backwards; land, proud.
  backflip: {
    dur: 2.4,
    pose: (u) => {
      const crouch = hold(u, 0, 0.3, 0.34, 0.44);
      const proud = hold(u, 1.25, 1.4, 2.0, 2.4);
      return {
        y: -0.05 * crouch + 0.42 * arc(u, 0.4, 1.2),
        sq: -0.2 * crouch + 0.14 * arc(u, 0.38, 0.75),
        pitch: -TAU * ramp(u, 0.45, 1.15),
        lid: -0.75 * hold(u, 0.2, 0.32, 0.42, 0.6),
        happy: proud,
        smile: 0.6 * proud,
      };
    },
    kicks: [[0.4, 2.5], [1.2, -5]],
  },
  spinJump: {
    dur: 1.9,
    pose: (u) => {
      const crouch = hold(u, 0, 0.25, 0.3, 0.38);
      const proud = hold(u, 1.1, 1.2, 1.6, 1.9);
      return { y: -0.04 * crouch + 0.32 * arc(u, 0.35, 1.05), sq: -0.15 * crouch, yaw: TAU * ramp(u, 0.38, 1.02), happy: proud, smile: 0.4 * proud };
    },
    kicks: [[0.35, 2], [1.05, -4]],
  },
  hopHop: {
    dur: 1.7,
    pose: (u) => {
      const a = arc(u, 0.1, 0.5);
      const b = arc(u, 0.6, 1.0);
      const glad = hold(u, 0, 0.15, 1.3, 1.7);
      return { y: 0.14 * a + 0.18 * b, roll: 0.08 * (a - b), happy: glad, smile: 0.5 * glad };
    },
    kicks: [[0.1, 1.5], [0.5, -3], [0.6, 1.5], [1.0, -3.5]],
  },
  // A little dance: rocks and bobs, happy.
  wiggle: {
    dur: 2.6,
    pose: (u) => {
      const env = hold(u, 0, 0.3, 2.2, 2.6);
      const s = wave(u, 1.8);
      return { roll: 0.22 * s * env, x: -0.05 * s * env, y: 0.05 * Math.abs(s) * env, happy: env, smile: 0.5 * env, gx: 0.05 * s * env };
    },
  },
  // Head tilt, eyes wide and up, a small "o".
  curious: {
    dur: 2.6,
    pose: (u) => {
      const h = hold(u, 0.1, 0.5, 1.9, 2.4);
      return { roll: 0.3 * h, x: -0.04 * h, gy: 0.04 * h, gx: -0.03 * h, lid: 0.3 * h, mouth: 0.035 * hold(u, 0.4, 0.6, 1.4, 1.7), smile: -0.6 * h };
    },
    kicks: [[0.1, -1]],
  },
  // Stretches tall, eyes shut, mouth wide; then shakes it off.
  yawn: {
    dur: 3.4,
    pose: (u) => {
      const y = hold(u, 0.2, 1.0, 1.8, 2.3);
      return {
        sq: 0.2 * y,
        y: 0.04 * y,
        mouth: 0.14 * hold(u, 0.3, 0.9, 1.7, 2.1),
        smile: -1.2 * y,
        lid: -0.9 * hold(u, 0.3, 0.7, 1.9, 2.2),
        roll: 0.12 * wave(u, 5) * hold(u, 2.3, 2.4, 2.9, 3.2),
      };
    },
    kicks: [[2.3, -2]],
  },
  // Nods off slowly, then wakes with a start and shakes.
  doze: {
    dur: 4.5,
    pose: (u) => {
      const sleep = hold(u, 0.6, 2.2, 2.85, 3.0);
      return {
        lid: -0.92 * hold(u, 0, 1.8, 2.9, 3.0) + 0.35 * hold(u, 2.95, 3.05, 3.6, 4.2),
        pitch: 0.35 * sleep,
        smile: -1.2 * sleep,
        sq: -0.06 * sleep,
        y: -0.03 * sleep,
        roll: 0.1 * wave(u, 4) * hold(u, 3.0, 3.1, 3.6, 4.0),
        mouth: 0.05 * hold(u, 2.95, 3.05, 3.3, 3.7),
      };
    },
    kicks: [[2.9, 3]],
  },
  // Leans in to the camera: "hey!".
  peek: {
    dur: 2.0,
    pose: (u) => {
      const h = hold(u, 0.15, 0.45, 1.3, 1.8);
      return { z: 0.4 * h, y: 0.03 * h, lid: 0.3 * h, mouth: 0.05 * hold(u, 0.3, 0.45, 0.9, 1.2) };
    },
    kicks: [[0.15, -1.5], [1.4, -1]],
  },
  // Frantic: shakes side to side and hops, eyes wide.

  // Thinking: the blob ponders, calculates, gets an idea... (the thinking look
  // already looks up and to the right; these poses add to it).
  // "Hmm...": looks up to the other side, head tilted, eyes half shut, mouth flat.
  ponder: {
    dur: 3.2,
    pose: (u) => {
      const h = hold(u, 0.2, 0.7, 2.5, 3.1);
      return { gx: -0.14 * h, gy: 0.04 * h, roll: (0.18 + 0.04 * wave(u, 0.8)) * h, pitch: -0.12 * h, lid: -0.35 * h, smile: -0.8 * h };
    },
  },
  // Calculating: the eyes run left and right like reading lines, small ticks.
  compute: {
    dur: 2.8,
    pose: (u) => {
      const env = hold(u, 0, 0.2, 2.5, 2.8);
      const step = Math.tanh(6 * wave(u, 2.5));
      return { gx: 0.12 * step * env, gy: 0.04 * Math.cos(TAU * 0.6 * u) * env, yaw: 0.06 * step * env, y: 0.015 * Math.abs(wave(u, 5)) * env, lid: -0.2 * env, smile: -0.6 * env };
    },
  },
  // Impatient foot tapping while it waits for the answer.
  tap: {
    dur: 2.4,
    pose: (u) => {
      const env = hold(u, 0, 0.2, 2.1, 2.4);
      return { y: 0.025 * Math.max(0, wave(u, 4)) * env, roll: 0.04 * wave(u, 2) * env, gx: 0.1 * wave(u, 0.4) * env, lid: -0.15 * env };
    },
  },
  // Loading: the body and the eyes go round like a spinner.
  orbit: {
    dur: 2.6,
    pose: (u) => {
      const env = hold(u, 0, 0.3, 2.2, 2.6);
      const a = TAU * 1.2 * u;
      return { x: 0.05 * Math.cos(a) * env, y: 0.05 * Math.sin(a) * env, roll: 0.08 * Math.sin(a) * env, gx: 0.1 * Math.cos(TAU * 1.5 * u) * env, gy: 0.07 * Math.sin(TAU * 1.5 * u) * env };
    },
  },
  // Turns the idea over: one slow turn with the eyes shut.
  turnIdea: {
    dur: 3.0,
    pose: (u) => ({ yaw: TAU * ramp(u, 0.3, 2.6), lid: -0.8 * hold(u, 0.2, 0.5, 2.4, 2.7), sq: -0.05 * hold(u, 0.3, 0.8, 2.2, 2.6) }),
  },
  // Effort: squeezes, trembles, then lets go.
  strain: {
    dur: 2.4,
    pose: (u) => {
      const h = hold(u, 0.2, 0.6, 1.7, 1.9);
      return { sq: -0.1 * h, lid: -0.7 * h, smile: -1.0 * h, x: 0.012 * wave(u, 18) * h, roll: 0.02 * wave(u, 15) * h };
    },
    kicks: [[1.9, 3]],
  },
  // Got it! A squint, a pop and a jump, eyes wide, then pleased.
  eureka: {
    dur: 2.2,
    pose: (u) => {
      const squint = hold(u, 0, 0.3, 0.5, 0.58);
      const glad = hold(u, 1.1, 1.3, 1.8, 2.2);
      return {
        lid: -0.5 * squint + 0.4 * hold(u, 0.55, 0.65, 1.1, 1.4),
        sq: -0.08 * squint + 0.12 * arc(u, 0.55, 0.9),
        y: 0.22 * arc(u, 0.55, 1.05),
        mouth: 0.07 * hold(u, 0.55, 0.65, 0.9, 1.1),
        happy: glad,
        smile: 0.5 * glad,
      };
    },
    kicks: [[0.55, 2.5], [1.05, -3.5]],
  },
  // Stares at the ceiling.
  lookUp: {
    dur: 2.6,
    pose: (u) => {
      const h = hold(u, 0.1, 0.5, 2.0, 2.6);
      return { pitch: -0.3 * h, gy: 0.08 * h, gx: 0.06 * wave(u, 0.7) * h, roll: 0.05 * h };
    },
  },
  // Overthinking: wobbles, eyes going round, wavy mouth.
  dizzy: {
    dur: 2.6,
    pose: (u) => {
      const env = hold(u, 0, 0.3, 2.2, 2.6);
      return { roll: 0.15 * wave(u, 1.4) * env, x: 0.04 * wave(u, 0.7) * env, gx: 0.06 * Math.cos(TAU * 3 * u) * env, gy: 0.06 * Math.sin(TAU * 3 * u) * env, smile: -1.4 * env, mouth: 0.02 * env };
    },
  },
};

export type Mood = 'idle' | 'info' | 'urgent' | 'clock' | 'thinking';

// What each mood does, with weights, and the pause between two acts (s).
export const REPERTOIRE: Record<Mood, { acts: [string, number][]; gap: [number, number] }> = {
  idle: {
    acts: [['lookLeft', 3], ['lookRight', 3], ['lookAround', 2], ['curious', 2], ['yawn', 1], ['doze', 1], ['wiggle', 1], ['hopHop', 1], ['backflip', 1], ['spinJump', 1], ['peek', 1]],
    gap: [2, 5],
  },
  // Alerts stay calm: small looks and wiggles with long rests, no flips or spins.
  info: { acts: [['wiggle', 2], ['lookLeft', 2], ['lookRight', 2], ['curious', 2], ['peek', 1]], gap: [4, 8] },
  urgent: { acts: [['peek', 2], ['curious', 2], ['wiggle', 1], ['lookLeft', 1], ['lookRight', 1]], gap: [3, 6] },
  thinking: {
    acts: [['ponder', 3], ['compute', 3], ['orbit', 2], ['tap', 2], ['lookUp', 2], ['turnIdea', 1], ['strain', 1], ['eureka', 1], ['dizzy', 1]],
    gap: [0.2, 0.9],
  },
  clock: { acts: [['hopHop', 2], ['wiggle', 2], ['curious', 1], ['spinJump', 1], ['backflip', 1]], gap: [7, 14] },
};

// Fixed pseudo-random 0..1, so film strips stay reproducible.
const rnd = (n: number, k: number) => {
  const x = Math.sin(n * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};

// Plays acts from the mood's repertoire, one at a time, with pauses between.
// No mood: the act stops (blob.ts fades its last pose out) and none starts;
// a new mood starts its first act soon.
export class Actor {
  name: string | null = null;
  private act: Act | null = null;
  private t = 0;
  private wait = 0.8; // until the next act
  private n = 0;
  private last = '';
  private mood: Mood | null = null;

  play(name: string): void {
    this.name = this.last = name;
    this.act = ACTS[name] ?? null;
    this.t = 0;
  }

  // Advances by dt; returns the pose and the sum of the kicks due this frame.
  step(dt: number, mood: Mood | null): { pose: Pose; kick: number } {
    const pose = rest();
    let kick = 0;
    if (mood !== this.mood) {
      this.mood = mood;
      this.wait = Math.min(this.wait, 0.4);
      if (!mood) this.stop();
    }
    if (!this.act) {
      if (!mood) return { pose, kick };
      this.wait -= dt;
      if (this.wait > 0) return { pose, kick };
      this.play(this.pick(mood));
      const [lo, hi] = REPERTOIRE[mood].gap;
      this.wait = lo + (hi - lo) * rnd(this.n, 7);
    }
    const act = this.act;
    if (!act) return { pose, kick }; // play() was given an unknown name
    const t0 = this.t;
    this.t += dt;
    for (const [at, v] of act.kicks ?? []) if (t0 <= at && at < this.t) kick += v;
    if (this.t >= act.dur) {
      this.stop();
      return { pose, kick };
    }
    Object.assign(pose, act.pose(this.t));
    return { pose, kick };
  }

  private stop(): void {
    this.act = null;
    this.name = null;
  }

  get busy(): boolean {
    return this.act !== null;
  }

  // Weighted pick, never the same act twice in a row.
  private pick(mood: Mood): string {
    const list = REPERTOIRE[mood].acts.filter(([a]) => a !== this.last);
    const total = list.reduce((s, [, w]) => s + w, 0);
    let r = rnd(++this.n, 3) * total;
    for (const [a, w] of list) if ((r -= w) < 0) return a;
    return list[list.length - 1][0];
  }
}
