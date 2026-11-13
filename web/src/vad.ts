// End-of-speech detection while listening (design, Hands-free; entry 71).
// Silero (from @ricky0123/vad-web) runs in the audio model worker and posts one
// speech probability per 32 ms frame; this module turns them into an end.

export const POSITIVE = 0.5; // a frame at or above this is speech
export const NEGATIVE = 0.35; // after speech started, frames at or above this keep it going
export const MIN_SPEECH_MS = 90; // speech must last this long to count (clicks, taps)
export const SILENCE_END_MS = 700; // 0.6 to 0.8 s of silence ends the utterance
export const TOTAL_MS = 15_000;

export type VadEnd = 'speech_end' | 'no_speech' | 'cap';

export interface EndpointLimits {
  noSpeechMs: number; // listen_no_speech_s (8 s), or followup_listen_s (6 s) for a follow-up
  silenceMs?: number;
  totalMs?: number;
}

// Pure endpointing on speech probabilities with an injected clock.
export class Endpointer {
  private readonly lim: Required<EndpointLimits>;
  private readonly now: () => number;
  private readonly t0: number;
  private runStart: number | null = null; // start of the current run of speech frames
  private speechStarted = false;
  private lastVoiced = 0;

  constructor(limits: EndpointLimits, now: () => number) {
    this.lim = { silenceMs: SILENCE_END_MS, totalMs: TOTAL_MS, ...limits };
    this.now = now;
    this.t0 = now();
  }

  get speaking(): boolean {
    return this.speechStarted;
  }

  // One frame's probability; returns how the utterance ends, or null to go on.
  push(p: number): VadEnd | null {
    const t = this.now();
    if (!this.speechStarted) {
      if (p >= POSITIVE) {
        this.runStart ??= t;
        if (t - this.runStart >= MIN_SPEECH_MS) {
          this.speechStarted = true;
          this.lastVoiced = t;
        }
      } else {
        this.runStart = null;
      }
    } else if (p >= NEGATIVE) {
      this.lastVoiced = t;
    }
    return this.check(t);
  }

  // Time limits also apply when no frame arrives.
  check(t = this.now()): VadEnd | null {
    if (t - this.t0 >= this.lim.totalMs) return 'cap';
    if (this.speechStarted) return t - this.lastVoiced >= this.lim.silenceMs ? 'speech_end' : null;
    return t - this.t0 >= this.lim.noSpeechMs ? 'no_speech' : null;
  }
}

// What turn-client.ts needs from the VAD.
export interface Vad {
  start(limits: EndpointLimits, onEnd: (end: VadEnd) => void): void;
  stop(): void;
}

// Feeds worker probabilities to an Endpointer while a turn listens. `reset`
// clears the model state in the worker; a timer checks the time limits when
// frames stop coming.
export class VadController implements Vad {
  private ep: Endpointer | null = null;
  private onEnd: ((end: VadEnd) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  lastP = 0;
  private readonly reset: () => void;
  private readonly now: () => number;

  constructor(reset: () => void, now: () => number = () => performance.now()) {
    this.reset = reset;
    this.now = now;
  }

  get active(): boolean {
    return this.ep !== null;
  }

  start(limits: EndpointLimits, onEnd: (end: VadEnd) => void): void {
    this.stop();
    this.reset();
    this.ep = new Endpointer(limits, this.now);
    this.onEnd = onEnd;
    this.timer = setInterval(() => this.finish(this.ep?.check() ?? null), 250);
  }

  stop(): void {
    clearInterval(this.timer);
    this.ep = null;
    this.onEnd = null;
  }

  onProb(p: number): void {
    this.lastP = p;
    if (this.ep) this.finish(this.ep.push(p));
  }

  private finish(end: VadEnd | null): void {
    if (!end) return;
    const cb = this.onEnd;
    this.stop();
    cb?.(end);
  }
}
