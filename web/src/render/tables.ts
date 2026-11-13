import type { View } from '../state';

// Conversation state to colour and motion (design, Display rules).
// S4 adds a second table: alert source and urgency to shape, colour and pulse.
export interface Look {
  color: [number, number, number]; // linear RGB, also tints the environment
  speed: number; // flow speed of the slow organic motion
  amp: number; // lobe and noise displacement
  breath: number; // breathing amplitude (fraction of the radius)
  breathHz: number; // breathing rate
  levelGain: number; // how much the mic or playback level deforms the surface
  glow: number; // inner glow and halo strength
  bright: number; // overall brightness
}

export type LookRow = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

export const STATE_LOOK: Record<LookRow, Look> = {
  idle: { color: [0.2, 0.13, 0.85], speed: 0.22, amp: 0.1, breath: 0.035, breathHz: 0.16, levelGain: 0, glow: 0.7, bright: 0.9 },
  listening: { color: [0.08, 0.78, 1.0], speed: 0.45, amp: 0.12, breath: 0.012, breathHz: 0.3, levelGain: 1, glow: 0.95, bright: 1.0 },
  thinking: { color: [1.0, 0.4, 0.02], speed: 0.32, amp: 0.13, breath: 0.05, breathHz: 0.42, levelGain: 0, glow: 1.2, bright: 1.0 },
  speaking: { color: [1.0, 0.88, 0.7], speed: 0.35, amp: 0.1, breath: 0.015, breathHz: 0.25, levelGain: 0.8, glow: 1.7, bright: 1.3 },
  error: { color: [0.42, 0.42, 0.45], speed: 0.1, amp: 0.06, breath: 0.02, breathHz: 0.12, levelGain: 0.5, glow: 0.3, bright: 0.45 },
};

export function lookFor(view: View): Look {
  return STATE_LOOK[view === 'offline' ? 'error' : view];
}

// Lava lobes for the shader (uLobes): centre in units of the blob radius and
// radius, for flow time `flow` and displacement `amp`. Each lobe rises and
// sinks on its own cycle (faster up, lazier down) and circles the vertical
// axis; the golden-angle phases keep any two lobes out of step.
export const LOBE_COUNT = 5;
export function lobes(flow: number, amp: number, out: Float32Array): void {
  const reach = 0.75 + amp * 3;
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
