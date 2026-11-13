import { OVERLAY_MIN_MS } from './config';
import type { AlertItem, ConvState, TurnDoneReason } from './protocol';

// What the renderer draws. 'offline' uses the error look (render/tables.ts);
// 'alert' draws the top alert (topAlert) with the alert table.
export type View = ConvState | 'error' | 'offline' | 'alert';

export interface ViewInput {
  online: boolean;
  conv: ConvState; // from the last snapshot or state
  playing: boolean; // local playback of a turn reply (or fallback line, beep) not empty
  overlay: boolean; // error overlay active (see overlayActive)
  alerts?: readonly AlertItem[]; // active alerts from the last snapshot
}

// A conversation turn is active while the backend is not idle or this page
// still plays its reply. Alerts are held hidden (and their chime held) meanwhile.
export function turnActive(i: Pick<ViewInput, 'conv' | 'playing'>): boolean {
  return i.conv !== 'idle' || i.playing;
}

// Precedence: offline, error overlay, conversation turn (speaking kept until
// local playback ends), top alert, idle.
export function computeView(i: ViewInput): View {
  if (!i.online) return 'offline';
  if (i.overlay) return 'error';
  if (i.playing) return 'speaking';
  if (i.conv !== 'idle') return i.conv;
  return i.alerts?.length ? 'alert' : 'idle';
}

// The alert to draw: urgent before info, then oldest first (key breaks ties).
export function topAlert(alerts: readonly AlertItem[]): AlertItem | null {
  let best: AlertItem | null = null;
  for (const a of alerts) {
    if (!best || rank(a, best) < 0) best = a;
  }
  return best;
}

function rank(a: AlertItem, b: AlertItem): number {
  const u = (a.urgency === 'urgent' ? 0 : 1) - (b.urgency === 'urgent' ? 0 : 1);
  if (u) return u;
  return a.activated_at - b.activated_at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
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
