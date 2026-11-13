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

// Microphone health over a window (client_event `mic`): how many 20 ms blocks
// arrived and how loud the loudest sample was, in dBFS (-Infinity reported as
// null: digital silence, all zeros).
export class MicStats {
  private frames = 0;
  private peak = 0;

  add(pcm: Int16Array): void {
    this.frames += 1;
    for (let i = 0; i < pcm.length; i++) {
      const a = Math.abs(pcm[i]);
      if (a > this.peak) this.peak = a;
    }
  }

  take(): { frames: number; peak_dbfs: number | null } {
    const r = { frames: this.frames, peak_dbfs: this.peak > 0 ? Math.round(20 * Math.log10(this.peak / 32768) * 10) / 10 : null };
    this.frames = 0;
    this.peak = 0;
    return r;
  }
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
