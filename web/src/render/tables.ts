import type { AlertItem } from '../protocol';
import type { View } from '../state';

type Urgency = AlertItem['urgency'];

// Conversation state to colour and motion (design, Display rules), and the
// alert table: source and urgency to shape, colour and pulse speed.
export interface Look {
  color: [number, number, number]; // linear RGB, also tints the environment
  lava: [number, number, number]; // linear RGB of the glowing lava under the skin
  speed: number; // flow speed of the slow organic motion
  amp: number; // lobe and noise displacement
  breath: number; // breathing amplitude (fraction of the radius)
  breathHz: number; // breathing rate
  levelGain: number; // how much the mic or playback level deforms the surface
  glow: number; // inner glow and halo strength
  bright: number; // overall brightness
  // Lava face (units of the blob radius, y up). Eyes are ellipses that blend
  // into happy arcs; the mouth is a curve that can open into an ellipse.
  eyeW: number; // eye half width
  eyeH: number; // eye half height (blinks scale it)
  eyeY: number; // eye height above the centre
  gazeX: number; // where the face looks
  gazeY: number;
  happy: number; // 0 open eyes, 1 happy arcs
  smile: number; // mouth curvature: + smile, - frown
  mouth: number; // mouth opening, half height
  talk: number; // extra opening per unit of level
  face: number; // face strength, 0 hides it
}

type Face = Pick<Look, 'eyeW' | 'eyeH' | 'eyeY' | 'gazeX' | 'gazeY' | 'happy' | 'smile' | 'mouth' | 'talk' | 'face'>;
const FACE: Face = { eyeW: 0.11, eyeH: 0.16, eyeY: 0.075, gazeX: 0, gazeY: 0, happy: 0, smile: 1.9, mouth: 0, talk: 0, face: 1 };

export type LookRow = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export const STATE_LOOK: Record<LookRow, Look> = {
  idle: { color: [0.2, 0.13, 0.85], lava: [0.62, 0.22, 1.0], speed: 0.22, amp: 0.1, breath: 0.035, breathHz: 0.16, levelGain: 0, glow: 0.7, bright: 0.9, ...FACE },
  listening: { color: [0.08, 0.78, 1.0], lava: [0.1, 1.0, 0.75], speed: 0.45, amp: 0.12, breath: 0.012, breathHz: 0.3, levelGain: 1, glow: 0.95, bright: 1.0, ...FACE, eyeW: 0.135, eyeH: 0.21, eyeY: 0.12, smile: 1.2, face: 1.1 },
  thinking: { color: [1.0, 0.4, 0.02], lava: [1.0, 0.3, 0.03], speed: 0.32, amp: 0.13, breath: 0.05, breathHz: 0.42, levelGain: 0, glow: 1.2, bright: 1.0, ...FACE, eyeW: 0.1, eyeH: 0.14, gazeX: 0.1, gazeY: 0.18, smile: 0.3 },
  speaking: { color: [1.0, 0.88, 0.7], lava: [1.0, 0.78, 0.5], speed: 0.35, amp: 0.1, breath: 0.015, breathHz: 0.25, levelGain: 0.8, glow: 1.7, bright: 1.15, ...FACE, eyeY: 0.05, happy: 1, smile: 1.5, mouth: 0.06, talk: 0.12 },
  error: { color: [0.42, 0.42, 0.45], lava: [0.55, 0.55, 0.6], speed: 0.1, amp: 0.06, breath: 0.02, breathHz: 0.12, levelGain: 0.5, glow: 0.3, bright: 0.45, ...FACE, eyeH: 0.02, smile: -1.2, face: 0.5 },
};

export function lookFor(view: Exclude<View, 'alert'>): Look {
  return STATE_LOOK[view === 'offline' ? 'error' : view];
}

// Shape ids understood by shape() in blob.frag.
export const SHAPE = { sphere: 0, triangle: 1, square: 2, clock: 3, weather: 4 } as const;
export type ShapeId = (typeof SHAPE)[keyof typeof SHAPE];

// Clock: after CLOCK_AFTER_MS in idle the blob rests as a digital clock, in
// the idle colours with a calmer surface so the digits stay readable.
export const CLOCK_AFTER_MS = 5 * 60_000;
export const CLOCK_LOOK: Look = { ...STATE_LOOK.idle, speed: 0.15, amp: 0.04, breath: 0.012 };

// Weather: the idle rest takes turns between the clock and the sky outside
// (CLOCK_TURN_MS of clock, then WEATHER_TURN_MS of weather).
export const CLOCK_TURN_MS = 30_000;
export const WEATHER_TURN_MS = 20_000;

export type WeatherKind = 'clear' | 'partly' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';
export interface Sky {
  kind: WeatherKind;
  day: boolean; // a clear night shows the moon
}

// Weights of the weather shape's parts (uSky, uFall in blob.frag) and where
// the face sits on it (uFaceT: offset, scale).
export interface SkyParts {
  sun: number;
  moon: number;
  cloud: number;
  fall: number; // drops (or flakes) falling
  snow: number; // 0 rain, 1 flakes
  faceX: number;
  faceY: number;
  faceS: number;
  size: number; // scale that gives the shape the sphere's volume (uSky.w)
  top: number; // highest and lowest reach of the shape, world units from its centre
  bottom: number;
}

// Scales that give each sky the sphere's volume (measured like VOL_* in
// blob.frag), and its reach up and down at that size: the drops do not count
// in the volume, they leave the body and come back, but they need room below.
const SKY_SIZE = { sun: 1.562, moon: 2.011, partly: 1.536, cloud: 1.674 };
const SKY_REACH = { sun: [1.14, -1.14], moon: [0.97, -0.97], partly: [1.17, -0.49], cloud: [0.8, -0.54], fall: -1.51 };

// Reach of the resting clock, up and down from its centre (world units).
export const CLOCK_REACH: [number, number] = [0.6, -0.6];

function reach(kind: WeatherKind, cloud: number, moon: number): { top: number; bottom: number } {
  const [top, bottom] = kind === 'partly' ? SKY_REACH.partly : cloud ? SKY_REACH.cloud : moon ? SKY_REACH.moon : SKY_REACH.sun;
  const falls = kind === 'rain' || kind === 'snow' || kind === 'storm';
  return { top, bottom: falls ? SKY_REACH.fall : bottom };
}

export function skyParts({ kind, day }: Sky): SkyParts {
  const orb = kind === 'clear' || kind === 'partly';
  const cloud = kind !== 'clear' ? 1 : 0;
  const moon = orb && !day ? 1 : 0;
  // Alone, the moon's face sits on the crescent left by the bite; with a cloud it sits on the cloud.
  const face = cloud ? { faceX: 0, faceY: -0.02, faceS: 0.8 } : moon ? { faceX: -0.36, faceY: -0.2, faceS: 0.5 } : { faceX: 0, faceY: 0, faceS: 0.9 };
  return {
    sun: orb && day ? 1 : 0,
    moon,
    cloud,
    fall: kind === 'rain' || kind === 'snow' || kind === 'storm' ? 1 : 0,
    snow: kind === 'snow' ? 1 : 0,
    ...face,
    size: kind === 'partly' ? SKY_SIZE.partly : cloud ? SKY_SIZE.cloud : moon ? SKY_SIZE.moon : SKY_SIZE.sun,
    ...reach(kind, cloud, moon),
  };
}

// Colours and faces of the weather: a warm, beaming sun; a sleepy moon; a
// calm grey-blue cloud; rain looking up at its drops; delighted snow; a
// startled storm.
const WEATHER_COLOR: Record<WeatherKind | 'night', [Look['color'], Look['lava'], Partial<Face>]> = {
  clear: [[1.0, 0.62, 0.08], [1.0, 0.72, 0.12], { happy: 1, smile: 2.1, eyeY: 0.06 }],
  night: [[0.25, 0.3, 0.95], [0.75, 0.8, 1.0], { happy: 1, smile: 1.2, eyeH: 0.02 }],
  partly: [[0.85, 0.6, 0.3], [1.0, 0.75, 0.35], { happy: 0.6, smile: 1.8 }],
  cloudy: [[0.42, 0.5, 0.75], [0.7, 0.78, 0.95], { smile: 1.1, eyeH: 0.13 }],
  fog: [[0.5, 0.52, 0.6], [0.75, 0.78, 0.85], { smile: 0.8, eyeH: 0.09 }],
  rain: [[0.1, 0.38, 1.0], [0.25, 0.6, 1.0], { smile: 0.6, gazeY: 0.08 }],
  snow: [[0.55, 0.8, 1.0], [0.85, 0.95, 1.0], { happy: 1, smile: 1.9 }],
  storm: [[0.48, 0.18, 0.9], [0.65, 0.4, 1.0], { eyeW: 0.13, eyeH: 0.15, smile: 0, mouth: 0.06 }],
};

export function weatherLook({ kind, day }: Sky): Look {
  const night = !day && (kind === 'clear' || kind === 'partly');
  const [color, lava, face] = WEATHER_COLOR[night ? 'night' : kind];
  return { ...CLOCK_LOOK, ...FACE, ...face, color: [...color], lava: [...lava], speed: 0.2, amp: 0.05, glow: 0.9, bright: 0.95 };
}

// HH:MM in local time as four digits.
export function clockDigits(d: Date): [number, number, number, number] {
  const h = d.getHours();
  const m = d.getMinutes();
  return [Math.floor(h / 10), h % 10, Math.floor(m / 10), m % 10];
}

// Alert source to shape. Slice 4: timer is a triangle, every other source a square.
export const SOURCE_SHAPE: Record<string, ShapeId> = { timer: SHAPE.triangle };
export const DEFAULT_ALERT_SHAPE: ShapeId = SHAPE.square;

export const ALERT_COLOR: Record<Urgency, [number, number, number]> = {
  info: [0.1, 0.85, 0.28], // green
  urgent: [1.0, 0.07, 0.05], // red
};
export const ALERT_LAVA: Record<Urgency, [number, number, number]> = {
  info: [0.45, 1.0, 0.3],
  urgent: [1.0, 0.32, 0.1],
};
// A slow, deep breath like the other states (idle breathes at 0.16 Hz): the
// colour and the shape say "look at me", the motion stays calm.
export const INFO_PULSE_HZ = 0.22;
export const URGENT_PULSE_FACTOR = 1.5; // urgent breathes a little faster than info

const ALERT_MOTION = { speed: 0.24, amp: 0.09, breath: 0.035, levelGain: 0.6, glow: 1.1, bright: 1.05 };

export function alertShape(source: string): ShapeId {
  return SOURCE_SHAPE[source] ?? DEFAULT_ALERT_SHAPE;
}

// Info is a content face; urgent is attentive: round eyes, a small "oh".
const ALERT_FACE: Record<Urgency, Face> = {
  info: { ...FACE, eyeW: 0.12, eyeH: 0.17 },
  urgent: { ...FACE, eyeW: 0.13, eyeH: 0.15, smile: 0.4, mouth: 0.045 },
};

export function alertLook(urgency: Urgency): Look {
  const breathHz = urgency === 'urgent' ? INFO_PULSE_HZ * URGENT_PULSE_FACTOR : INFO_PULSE_HZ;
  return { ...ALERT_MOTION, ...ALERT_FACE[urgency], color: [...ALERT_COLOR[urgency]], lava: [...ALERT_LAVA[urgency]], breathHz };
}

// Lava lobes for the shader (uLobes): centre in units of the blob radius and
// radius, for flow time `flow` and displacement `amp`. Each lobe rises and
// sinks on its own cycle (faster up, lazier down) and circles the vertical
// axis; the golden-angle phases keep any two lobes out of step.
export const LOBE_COUNT = 5;
export function lobes(flow: number, amp: number, out: Float32Array): void {
  const reach = 0.95 + amp * 3;
  for (let i = 0; i < LOBE_COUNT; i++) {
    const ph = i * 2.39996;
    const t = flow * (0.8 + 0.13 * i) + ph;
    const y = Math.sin(t + 0.45 * Math.sin(t)) * 0.52;
    const a = ph * 1.3 + flow * (0.2 + 0.06 * i) * (i % 2 ? 1 : -1);
    const rad = 0.34 + 0.1 * Math.sin(i * 1.7 + flow * 0.13);
    out[i * 4] = Math.cos(a) * rad * reach;
    out[i * 4 + 1] = y * reach;
    out[i * 4 + 2] = Math.sin(a) * rad * reach;
    out[i * 4 + 3] = 0.44 + 0.07 * Math.sin(t * 1.6 + i);
  }
}
