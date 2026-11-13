// What the wake word heard, reduced to one line per attempt for the backend log
// (client_event `wake_peak`): each run of scores at or above PEAK_FLOOR becomes
// its peak, how long it lasted, and whether it reached the threshold. Silence
// and ordinary speech (scores near 0) send nothing.

export const PEAK_FLOOR = 0.1;

export interface WakePeak {
  peak: number; // highest score in the run, 3 decimals
  ms: number; // run length
  fired: boolean; // the peak reached the threshold
}

export class PeakTracker {
  private start: number | null = null;
  private peak = 0;
  private readonly threshold: number;
  private readonly floor: number;

  constructor(threshold: number, floor = PEAK_FLOOR) {
    this.threshold = threshold;
    this.floor = floor;
  }

  // One score (every 80 ms while the detector runs). Returns a finished run.
  score(s: number, now: number): WakePeak | null {
    if (s < this.floor) return this.flush(now);
    if (this.start === null) {
      this.start = now;
      this.peak = 0;
    }
    this.peak = Math.max(this.peak, s);
    return null;
  }

  // The detector stopped (gate closed) or the run ended: report it, if any.
  flush(now: number): WakePeak | null {
    if (this.start === null) return null;
    const p = { peak: Math.round(this.peak * 1000) / 1000, ms: Math.round(now - this.start), fired: this.peak >= this.threshold };
    this.start = null;
    return p;
  }
}
