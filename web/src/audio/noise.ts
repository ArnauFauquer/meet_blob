// Background noise from the microphone, for the adaptive volume (volume.ts).
//
// Every 20 ms block that is not Blob's own sound and not the user's speech
// gives one level in dBFS. The estimate is a low percentile of the last few
// seconds of such levels: a hood, a dishwasher or a TV sets it; a door, a
// cough, a word to the wake word or the user's question barely move it,
// because they fill only a few blocks of the window. The recording of a tap
// turn counts too (the moment before the user speaks and the gaps between
// words reach the low percentile), so a tap-only page gets an estimate as well.

export const BLOCK_MS = 20; // the worklet's block, nominal
export const NOISE_WINDOW_MS = 8_000; // how much eligible audio the estimate looks at
export const NOISE_PERCENTILE = 0.2;
export const NOISE_MIN_MS = 600; // less eligible audio than this: no estimate yet
export const NOISE_STALE_MS = 5 * 60_000; // no eligible audio for this long: the estimate is forgotten
// Blob's own sound (reply, alert read, chime, beep) and its echo in the room:
// blocks until this long after the last sound ended are not heard.
export const ECHO_HANGOVER_MS = 600;
export const SILENT_DBFS = -96; // digital silence (all zeros) counts as this

// RMS of one block, in dBFS (full-scale sine is -3).
export function blockDbfs(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 0x8000) ** 2;
  if (!pcm.length || sum === 0) return SILENT_DBFS;
  return Math.max(SILENT_DBFS, 10 * Math.log10(sum / pcm.length));
}

// Sliding window of block levels and its low percentile. `now` is in ms.
export class NoiseFloor {
  private readonly ring: Float32Array;
  private n = 0;
  private i = 0;
  private lastAt = -Infinity;
  private readonly percentile: number;

  constructor(windowMs = NOISE_WINDOW_MS, percentile = NOISE_PERCENTILE) {
    this.ring = new Float32Array(Math.max(1, Math.round(windowMs / BLOCK_MS)));
    this.percentile = percentile;
  }

  push(dbfs: number, now: number): void {
    this.ring[this.i] = dbfs;
    this.i = (this.i + 1) % this.ring.length;
    this.n = Math.min(this.n + 1, this.ring.length);
    this.lastAt = now;
  }

  // The background noise in dBFS (one decimal), or null when there is too
  // little recent audio to tell.
  estimate(now: number): number | null {
    if (this.n * BLOCK_MS < NOISE_MIN_MS || now - this.lastAt > NOISE_STALE_MS) return null;
    const s = Array.from(this.ring.subarray(0, this.n)).sort((a, b) => a - b);
    const v = s[Math.min(s.length - 1, Math.floor(this.percentile * s.length))];
    return Math.round(v * 10) / 10;
  }

  clear(): void {
    this.n = this.i = 0;
    this.lastAt = -Infinity;
  }
}

// Whether a block may be counted as background: Blob has been silent for the
// echo hangover and the voice-activity detector does not hear speech.
export function eligible(quietForMs: number, speech: boolean): boolean {
  return quietForMs >= ECHO_HANGOVER_MS && !speech;
}
