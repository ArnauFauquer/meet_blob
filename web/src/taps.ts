// The tap table (design, "Taps"). The first matching row wins.

// Local phase of this page's own turn (turn-client.ts).
export type TurnPhase = 'idle' | 'requested' | 'listening' | 'thinking';

export interface TapContext {
  audioLocked: boolean;
  overlay: boolean; // grey error overlay
  playing: boolean; // local playback running (reply, fallback line or beep)
  phase: TurnPhase;
  alert: boolean; // the view shows an alert
  alertReading: boolean; // an alert_read is waiting for its audio or playing it
}

export type TapAction =
  | 'unlock' // resume audio, nothing else
  | 'read_alert' // alert_read, play the reply, alert_ack after playback ends
  | 'stop_fallback' // stop the fallback audio, no message
  | 'stop_and_cancel' // speaking: stop playback, send cancel
  | 'cancel' // thinking: send cancel
  | 'send_utterance' // listening: stop the mic and send the audio
  | 'ignore' // a tap was sent and no state came back yet (double tap), or an alert is being read
  | 'start_turn'; // idle or error: send tap

export function decideTap(c: TapContext): TapAction {
  if (c.audioLocked) return 'unlock';
  if (c.alertReading) return 'ignore';
  if (c.alert) return 'read_alert';
  if (c.overlay && c.playing) return 'stop_fallback';
  if (c.playing) return 'stop_and_cancel';
  if (c.phase === 'thinking') return 'cancel';
  if (c.phase === 'listening') return 'send_utterance';
  if (c.phase === 'requested') return 'ignore';
  return 'start_turn';
}
