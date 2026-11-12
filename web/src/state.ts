import { OVERLAY_MIN_MS } from './config';
import type { ConvState, TurnDoneReason } from './protocol';

// What the renderer draws. 'offline' uses the error look (render/tables.ts).
// S4 adds an alert view between the conversation turn and idle.
export type View = ConvState | 'error' | 'offline';

export interface ViewInput {
  online: boolean;
  conv: ConvState; // from the last snapshot or state
  playing: boolean; // local playback queue not empty
  overlay: boolean; // error overlay active (see overlayActive)
}

// Precedence: offline, error overlay, conversation turn (speaking kept until
// local playback ends), idle.
export function computeView(i: ViewInput): View {
  if (!i.online) return 'offline';
  if (i.overlay) return 'error';
  if (i.playing) return 'speaking';
  return i.conv;
}

// Reasons that set the grey overlay.
export function setsOverlay(reason: TurnDoneReason): boolean {
  return reason !== 'ok' && reason !== 'empty' && reason !== 'cancel';
}

// The overlay stays while local playback (the fallback line or the beep) runs,
// and for at least 3 s after it was set.
export function overlayActive(since: number | null, now: number, playing: boolean): boolean {
  if (since === null) return false;
  return playing || now - since < OVERLAY_MIN_MS;
}
