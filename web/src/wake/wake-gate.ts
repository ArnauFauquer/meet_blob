import type { ConvState } from '../protocol';
import type { TurnPhase } from '../taps';

// Pure rules for hands-free listening (design, Hands-free).

export const PLAYBACK_HANGOVER_MS = 500;

export interface GateInput {
  enabled: boolean; // device wake=true and the wake model loaded
  phase: TurnPhase; // this page's turn phase
  conv: ConvState; // backend conversation state
  playing: boolean; // any local playback (reply, fallback, alert read, beep)
  lastPlaybackEnd: number | null; // ms, when local playback last became empty
  followup: boolean; // a follow-up is due or its listening window is open
  now: number; // ms
}

// The wake detector runs only while the local state is idle: no turn of ours,
// no turn of another device, not during playback and 0.5 s after it, not during
// follow-up listening.
export function wakeAllowed(g: GateInput): boolean {
  if (!g.enabled || g.followup) return false;
  if (g.phase !== 'idle' || g.conv !== 'idle') return false;
  if (g.playing) return false;
  return g.lastPlaybackEnd === null || g.now - g.lastPlaybackEnd >= PLAYBACK_HANGOVER_MS;
}

// The follow-up window (design, Turn pipeline step 8): a `tts` of our turn with
// followup=true makes the page send wake{followup:true} once its playback has
// ended and its turn is over; the turn then listens without the wake word for
// followup_listen_s. A tap (cancel) or a dropped socket forgets it.
export class FollowUp {
  due = false; // waiting for playback end and turn end
  listening = false; // wake{followup} sent; its turn is requested or listening

  onTts(followup: boolean): void {
    if (followup) this.due = true;
  }

  // True: send wake{followup:true} now.
  take(playing: boolean, phase: TurnPhase): boolean {
    if (!this.due || playing || phase !== 'idle') return false;
    this.due = false;
    this.listening = true;
    return true;
  }

  // The follow-up turn left listening (utterance sent, no speech, refused).
  closed(): void {
    this.listening = false;
  }

  clear(): void {
    this.due = false;
    this.listening = false;
  }

  get active(): boolean {
    return this.due || this.listening;
  }
}
