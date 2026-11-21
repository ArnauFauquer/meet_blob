import { Vector2, Vector3 } from 'three';
import type { TimerItem } from '../protocol';
import { morphMix, type Morph } from './morph';
import { ALERT_LAVA, SHAPE, type SkyParts } from './tables';

// Timer droplets: each pending timer is a small drop of the blob's own liquid
// that orbits the body. The drop shrinks as its time runs out, glows warmer and
// pulses in its last minute, and when the timer fires it falls back into the
// body (smooth-min in blob.frag) before the alert shape takes over. A timer
// that is cancelled instead fades away where it is.
//
// Everything here is in body units (the frame blob.frag draws the shapes in),
// so the drops hop, twirl and squash with the body.

export const MAX_DROPS = 6; // DROPS in blob.frag; the soonest timers get a drop
export const DROP_R_MIN = 0.07; // radius at 0 s left (the sphere's is 0.78)
export const DROP_R_MAX = 0.19; // radius at DROP_FULL_S or more
const DROP_FULL_S = 2 * 3600;
export const RIPE_S = 60; // the last minute: warmer and pulsing
export const DROP_LAVA = ALERT_LAVA.urgent; // a ripe drop glows towards the timer alert's colour
const SPHERE_R = 0.78; // uRadius: the volume every shape holds (#34)

// Drop size from the time left. Logarithmic, so both a 5 minute pasta and a
// 45 minute oven are clearly apart and still visibly shrink as they run;
// the power spreads the long timers out.
export function dropRadius(leftS: number): number {
  const f = Math.min(1, Math.log1p(Math.max(0, leftS) / 20) / Math.log1p(DROP_FULL_S / 20));
  return DROP_R_MIN + (DROP_R_MAX - DROP_R_MIN) * f ** 1.5;
}

// 0 until the last minute, then up to 1 when the timer fires.
export function ripeness(leftS: number): number {
  return 1 - Math.min(1, Math.max(0, leftS) / RIPE_S);
}

// Half width and height of a shape as blob.frag draws it (body units, with
// its lava bumps and breathing), and how round it is (1 an ellipse, 0 a box).
export interface Extent {
  w: number;
  h: number;
  round: number;
}

export function shapeExtent(shape: number, aspect: number, sky?: Pick<SkyParts, 'top' | 'bottom' | 'cloud'>): Extent {
  const narrow = (k: number) => Math.min(1, aspect / k); // the shader's fit to a narrow screen
  switch (shape) {
    case SHAPE.triangle:
      return { w: 1.0 * narrow(0.95), h: 0.92 * narrow(0.95), round: 0.3 };
    case SHAPE.square:
      return { w: 0.86 * narrow(0.95), h: 0.86 * narrow(0.95), round: 0.2 };
    case SHAPE.clock:
      return { w: 1.47 * narrow(1.3), h: 0.62 * narrow(1.3), round: 0 };
    case SHAPE.weather: {
      const top = sky?.top ?? 1.14;
      const s = narrow(0.9);
      // The falling drops reach far down; the orbit passes through the rain.
      return { w: (top + (1.2 - top) * (sky?.cloud ?? 0)) * s, h: Math.max(top, Math.min(-(sky?.bottom ?? -1), 1)) * s, round: 0.5 };
    }
    default:
      return { w: 0.84, h: 0.84, round: 1 };
  }
}

export function mixExtent(a: Extent, b: Extent, t: number): Extent {
  return { w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t, round: a.round + (b.round - a.round) * t };
}

// The orbit: a ring around the shape, seen from a little above, so a drop
// passes in front below the face and behind above it, and never covers the
// face or the clock digits. Semi axes a (x) and b (y), depth c, squircle
// exponent p (1 an ellipse; less hugs a box-like shape's corners), and the
// scale that fits the body and its orbit on the screen.
export interface Orbit {
  a: number;
  b: number;
  c: number;
  p: number;
  fit: number;
}

export const DROP_GAP = 0.16; // shape surface to drop surface, larger than the smooth-min reach
const HALF_VIEW = 1.417; // the camera sees +-1.417 world units at the body's depth
const DEPTH = 0.25; // small: a drop in front must not look like a bigger timer
const CAM_Z = 3.4; // camera distance in blob.frag

// `halfW`, `halfH`: the room around the body's centre, world units (the
// camera sees +-1.417 at the body's depth, times the aspect sideways).
export function orbitFor(ext: Extent, rMax: number, halfW: number, halfH: number): Orbit {
  const m = DROP_GAP + rMax;
  const b = ext.h + m;
  // Wider than tall where the screen has room: it reads as a ring in 3D.
  const a = Math.max(ext.w + m, Math.min(1.25 * b, halfW - 0.06 - rMax));
  const near = CAM_Z / (CAM_Z - DEPTH); // the drop passing in front looks bigger and lower
  const fit = Math.min(1, (halfW - 0.05) / (a + rMax), (halfH - 0.05) / ((b + rMax) * near));
  return { a, b, c: DEPTH, p: 0.45 + 0.55 * ext.round, fit };
}

type Mode = 'orbit' | 'merge' | 'vanish';
export interface Drop {
  key: string;
  order: number; // creation order: the drop's place on the ring
  mode: Mode;
  r: number; // radius, eased towards dropRadius(left)
  left: number; // seconds left
  out: number; // 0 inside the body, 1 on the orbit
  fade: number; // 1, down to 0 while vanishing
  ang: number; // offset on the ring from the turning base angle
}

const ORBIT_W = 0.25; // rad/s: one turn in about 25 s
const BORN_S = 1.4; // a new drop pinches off the body and moves out
const MERGE_S = 1.1; // a fired timer's drop falls back in: reaches the body, then sinks in
const VANISH_S = 0.5; // a cancelled timer's drop fades away
const TAU = 2 * Math.PI;
const smooth = (x: number) => x * x * (3 - 2 * x);
const wrap = (x: number) => x - TAU * Math.round(x / TAU);
const TOUCH = 0.72; // share of the orbit's reach where a falling drop meets the body
const sinkPath = (out: number) => (out > 0.5 ? TOUCH + (1 - TOUCH) * smooth((out - 0.5) / 0.5) : TOUCH * smooth(out / 0.5));

export interface DropOut {
  n: number; // drops to draw (uDropN)
  reach: number; // body units: the farthest drop surface from the centre, 0 without drops
  vol: number; // scale that keeps body plus drops at the sphere's volume
}

// What the renderer knows each frame that the orbit depends on.
export interface DropFrame {
  timers: readonly TimerItem[];
  fired: readonly string[];
  morph: Morph; // the shape shown (both shapes of a morph)
  sky: SkyParts;
  rest: number; // scale of a resting shape fitted to its room (1 otherwise)
  roomH: number; // free half height around the body's centre, world units
  t: number; // animation time, s
}

type Uniforms = Record<string, { value: unknown }>;

export class Droplets {
  readonly drops: Drop[] = [];
  orbit: Orbit = { a: 1, b: 1, c: DEPTH, p: 1, fit: 1 };
  scale = 1; // body scale: the orbit's fit times the volume the drops took (one body, one volume)

  // The shader uniforms the drops write (blob.frag: uDrops...).
  static uniforms(): Uniforms {
    return {
      uDrops: { value: new Float32Array(MAX_DROPS * 4) },
      uDropGlow: { value: new Float32Array(MAX_DROPS * 2) },
      uDropN: { value: 0 },
      uDropReach: { value: 0 },
      uDropLava: { value: new Vector3(...DROP_LAVA) },
    };
  }

  // One frame: the orbit hugs the shape on screen, the drops move, the
  // uniforms are written. Returns the number of drops that landed back in the body.
  frame(dt: number, u: Uniforms, f: DropFrame): number {
    const res = u.uRes.value as Vector2;
    const aspect = res.y ? res.x / res.y : 1;
    const m = f.morph;
    const ext = mixExtent(shapeExtent(m.a, aspect, f.sky), shapeExtent(m.b, aspect, f.sky), morphMix(m));
    // A resting shape is already scaled to its room: the orbit fits what is left.
    const target = orbitFor(ext, this.rMax, (HALF_VIEW * aspect) / f.rest, f.roomH / f.rest);
    const gulps = this.step(dt, f.timers, f.fired, target);
    const out = this.write(f.t, u.uDrops.value as Float32Array, u.uDropGlow.value as Float32Array);
    u.uDropN.value = out.n;
    u.uDropReach.value = out.reach;
    this.scale = this.orbit.fit * out.vol;
    return gulps;
  }

  // For the e2e tests and the diagnostics.
  get summary(): { key: string; mode: string; r: number; out: number }[] {
    return this.drops.map(({ key, mode, r, out }) => ({ key, mode, r: +r.toFixed(3), out: +out.toFixed(2) }));
  }
  private base = 0; // turning angle of the ring
  private next = 0;
  private fresh = true; // the first orbit is taken as is, not eased

  // A drop is falling back into the body: the renderer holds the alert morph until it is in.
  get merging(): boolean {
    return this.drops.some((d) => d.mode === 'merge');
  }

  // `timers`: pending timers with the seconds left now. `fired`: keys of the
  // active alerts (a timer that left the list and is among them has fired).
  // Returns the number of drops that finished falling back in this step.
  step(dt: number, timers: readonly TimerItem[], fired: readonly string[], target: Orbit): number {
    const want = [...timers].sort((x, y) => x.left_s - y.left_s).slice(0, MAX_DROPS);
    const keep = new Set(want.map((t) => t.key));
    for (const d of this.drops) {
      if (d.mode === 'orbit' && !keep.has(d.key)) d.mode = fired.includes(d.key) ? 'merge' : 'vanish';
    }
    for (const t of want) {
      let d = this.drops.find((x) => x.key === t.key);
      if (!d) {
        d = { key: t.key, order: this.next++, mode: 'orbit', r: dropRadius(t.left_s), left: t.left_s, out: 0, fade: 1, ang: NaN };
        this.drops.push(d);
      }
      d.mode = 'orbit'; // a timer set again before its drop was gone
      d.left = t.left_s;
    }

    // Places on the ring: evenly spread in creation order. The set of places
    // turns to where the drops already are (their circular mean), so a drop
    // that comes or goes moves the others the least, never half a turn back.
    const ring = this.drops.filter((d) => d.mode === 'orbit').sort((x, y) => x.order - y.order);
    const slot = (i: number) => (TAU * i) / ring.length;
    let sx = 0;
    let sy = 0;
    ring.forEach((d, i) => {
      if (Number.isNaN(d.ang)) return;
      sx += Math.cos(d.ang - slot(i));
      sy += Math.sin(d.ang - slot(i));
    });
    const turn = sx || sy ? Math.atan2(sy, sx) : 0;
    const ka = 1 - Math.exp(-dt / 0.9);
    ring.forEach((d, i) => {
      const to = turn + slot(i);
      d.ang = Number.isNaN(d.ang) ? to : d.ang + wrap(to - d.ang) * ka;
    });
    this.base = (this.base + dt * ORBIT_W) % TAU;

    const kr = 1 - Math.exp(-dt / 0.5);
    let gulps = 0;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      if (d.mode === 'orbit') {
        d.r += (dropRadius(d.left) - d.r) * kr;
        d.out = Math.min(1, d.out + dt / BORN_S);
        d.fade = Math.min(1, d.fade + dt / VANISH_S);
      } else if (d.mode === 'merge') {
        d.out -= dt / MERGE_S;
        if (d.out <= 0) {
          this.drops.splice(i, 1);
          gulps++;
        }
      } else {
        d.fade -= dt / VANISH_S;
        if (d.fade <= 0) this.drops.splice(i, 1);
      }
    }

    const ko = this.fresh ? 1 : 1 - Math.exp(-dt / 0.6);
    this.fresh = false;
    const o = this.orbit;
    o.a += (target.a - o.a) * ko;
    o.b += (target.b - o.b) * ko;
    o.c = target.c;
    o.p += (target.p - o.p) * ko;
    // Without drops the body goes back to its own size.
    const fitTo = this.drops.length ? target.fit : 1;
    o.fit += (fitTo - o.fit) * ko;
    return gulps;
  }

  // Largest radius among the timers on the ring (sizes the orbit).
  get rMax(): number {
    let r = 0;
    for (const d of this.drops) if (d.mode !== 'vanish') r = Math.max(r, d.r);
    return r || DROP_R_MAX;
  }

  // Writes uDrops (centre xyz, radius) and uDropGlow (glow, ripeness) for time `t`.
  write(t: number, drops: Float32Array, glow: Float32Array): DropOut {
    const o = this.orbit;
    let n = 0;
    let reach = 0;
    let outside = 0; // volume of the drops off the body, in units of the sphere's
    for (const d of this.drops) {
      if (n >= MAX_DROPS) break;
      const th = this.base + (Number.isNaN(d.ang) ? 0 : d.ang);
      const cs = Math.cos(th);
      const sn = Math.sin(th);
      // Moving out along a slow ease, so the neck to the body shows. Falling
      // in: to the body's surface in the first half, then sinking in slowly.
      const e = d.mode === 'merge' ? sinkPath(d.out) : smooth(d.out);
      const away = d.mode === 'vanish' ? 1 + 0.25 * (1 - d.fade) : 1;
      const x = o.a * Math.sign(cs) * Math.abs(cs) ** o.p * e * away;
      const y = (-o.b * Math.sign(sn) * Math.abs(sn) ** o.p + 0.025 * Math.sin(t * 1.1 + d.order * 2.3)) * e * away;
      const z = o.c * sn * e * away;
      const r = d.r * (d.mode === 'vanish' ? smooth(Math.max(0, d.fade)) : 1);
      drops.set([x, y, z, r], n * 4);
      const ripe = ripeness(d.left);
      // Breathes faster as the end nears: once every 2 s, up to twice a second.
      const pulse = ripe > 0 ? 0.5 + 0.5 * Math.sin(t * TAU * (0.5 + 1.5 * ripe)) : 0;
      glow[n * 2] = 0.45 + 0.55 * ripe * (0.6 + 0.4 * pulse);
      glow[n * 2 + 1] = ripe;
      reach = Math.max(reach, Math.hypot(x, y, z) + r);
      outside += (r / SPHERE_R) ** 3 * smooth(Math.min(1, d.out));
      n++;
    }
    return { n, reach: n ? reach + 0.05 : 0, vol: Math.cbrt(1 / (1 + outside)) };
  }

  reset(): void {
    this.drops.length = 0;
    this.base = 0;
    this.next = 0;
    this.fresh = true;
    this.orbit.fit = 1;
    this.scale = 1;
  }
}
