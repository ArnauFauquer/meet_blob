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
  thinking: { color: [1.0, 0.5, 0.06], speed: 0.32, amp: 0.13, breath: 0.05, breathHz: 0.42, levelGain: 0, glow: 0.9, bright: 0.95 },
  speaking: { color: [1.0, 0.86, 0.68], speed: 0.35, amp: 0.1, breath: 0.015, breathHz: 0.25, levelGain: 1, glow: 1.0, bright: 1.0 },
  error: { color: [0.42, 0.42, 0.45], speed: 0.1, amp: 0.06, breath: 0.02, breathHz: 0.12, levelGain: 0.5, glow: 0.3, bright: 0.45 },
};

export function lookFor(view: View): Look {
  return STATE_LOOK[view === 'offline' ? 'error' : view];
}
