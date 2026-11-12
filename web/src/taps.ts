// The tap table (design, "Taps"). The first matching row wins.
// S4 inserts the alert row ("an alert is showing": read it, then alert_ack)
// right after the audio-locked row.

// Local phase of this page's own turn (turn-client.ts).
export type TurnPhase = 'idle' | 'requested' | 'listening' | 'thinking';

export interface TapContext {
  audioLocked: boolean;
  overlay: boolean; // grey error overlay
  playing: boolean; // local playback running (reply, fallback line or beep)
  phase: TurnPhase;
}

export type TapAction =
  | 'unlock' // resume audio, nothing else
  | 'stop_fallback' // stop the fallback audio, no message
  | 'stop_and_cancel' // speaking: stop playback, send cancel
  | 'cancel' // thinking: send cancel
  | 'send_utterance' // listening: stop the mic and send the audio
  | 'ignore' // a tap was sent and no state came back yet (double tap)
  | 'start_turn'; // idle or error: send tap

export function decideTap(c: TapContext): TapAction {
  if (c.audioLocked) return 'unlock';
  if (c.overlay && c.playing) return 'stop_fallback';
  if (c.playing) return 'stop_and_cancel';
  if (c.phase === 'thinking') return 'cancel';
  if (c.phase === 'listening') return 'send_utterance';
  if (c.phase === 'requested') return 'ignore';
  return 'start_turn';
}
