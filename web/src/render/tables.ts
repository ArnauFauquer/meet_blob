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
export const SHAPE = { sphere: 0, triangle: 1, square: 2 } as const;
export type ShapeId = (typeof SHAPE)[keyof typeof SHAPE];

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
export const INFO_PULSE_HZ = 0.45;
export const URGENT_PULSE_FACTOR = 2; // urgent pulses at twice the rate of info

const ALERT_MOTION = { speed: 0.25, amp: 0.05, breath: 0.07, levelGain: 0.6, glow: 1.1, bright: 1.05 };

export function alertShape(source: string): ShapeId {
  return SOURCE_SHAPE[source] ?? DEFAULT_ALERT_SHAPE;
}

// Info is a content face; urgent is surprised: round eyes, open mouth.
const ALERT_FACE: Record<Urgency, Face> = {
  info: { ...FACE, eyeW: 0.12, eyeH: 0.17 },
  urgent: { ...FACE, eyeW: 0.14, eyeH: 0.14, smile: 0, mouth: 0.13 },
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
