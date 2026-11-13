// Wake word clips for retraining (client message `wake_clip`, only when the
// backend has DEBUG_AUDIO_DIR set): the audio around each attempt the wake word
// heard, and in enrollment mode (?enroll=pos|neg) every spoken phrase.

import { PCM_RATE } from '../protocol';

export const msToSamples = (ms: number) => Math.round((ms * PCM_RATE) / 1000);
export const samplesToMs = (n: number) => Math.round((n * 1000) / PCM_RATE);

// The last `capacity` samples of 16 kHz audio.
export class PcmRing {
  private readonly buf: Int16Array;
  private end = 0; // next write position
  private filled = 0;

  constructor(capacity: number) {
    this.buf = new Int16Array(capacity);
  }

  push(pcm: Int16Array): void {
    let src = pcm;
    if (src.length > this.buf.length) src = src.subarray(src.length - this.buf.length);
    const first = Math.min(src.length, this.buf.length - this.end);
    this.buf.set(src.subarray(0, first), this.end);
    this.buf.set(src.subarray(first), 0);
    this.end = (this.end + src.length) % this.buf.length;
    this.filled = Math.min(this.buf.length, this.filled + src.length);
  }

  // The most recent `n` samples (fewer if less audio arrived), oldest first.
  take(n: number): Int16Array {
    n = Math.min(n, this.filled);
    const out = new Int16Array(n);
    const start = (this.end - n + this.buf.length) % this.buf.length;
    const first = Math.min(n, this.buf.length - start);
    out.set(this.buf.subarray(start, start + first));
    out.set(this.buf.subarray(0, n - first), first);
    return out;
  }
}

export const SEG = {
  startRatio: 4, // a block this many times louder than the noise floor (+12 dB) is speech
  keepRatio: 2.5, // once speaking, blocks this much louder keep it going
  minRms: 0.003, // never speech below this (about -50 dBFS)
  startMs: 80, // loud blocks in a row needed to start
  endMs: 400, // quiet time that ends the phrase
  minMs: 250, // shorter phrases (clicks, knocks) are dropped
  maxMs: 3000, // a phrase is cut here
  prerollMs: 300, // audio kept before the start
};

function rmsOf(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2;
  return pcm.length ? Math.sqrt(sum / pcm.length) : 0;
}

// Enrollment: cuts the microphone audio into spoken phrases by loudness over an
// adaptive noise floor, so "hey blob ... hey blob ..." gives one clip per phrase.
export class PhraseSegmenter {
  private readonly ring = new PcmRing(msToSamples(SEG.maxMs + SEG.prerollMs + SEG.endMs));
  private floor = Infinity; // the quietest recent block; the first block sets it
  private loudRun = 0; // samples of loud blocks in a row before a start
  private speech = 0; // samples since the start (0 = not in a phrase)
  private quiet = 0; // samples of quiet blocks since the last loud one
  private capped = false; // cut at maxMs: wait for quiet before the next phrase

  // One block of audio; returns a finished phrase (pre-roll included), if any.
  push(pcm: Int16Array): Int16Array | null {
    this.ring.push(pcm);
    const rms = rmsOf(pcm);
    if (rms < this.floor) this.floor = Math.max(rms, 1e-5);
    else if (this.speech === 0) this.floor *= 1.002 ** (pcm.length / 320); // creeps up about 10 % per second

    if (this.capped) {
      if (rms < Math.max(this.floor * SEG.keepRatio, SEG.minRms)) this.quiet += pcm.length;
      else this.quiet = 0;
      if (this.quiet >= msToSamples(SEG.endMs)) this.capped = false;
      return null;
    }
    if (this.speech === 0) {
      if (rms >= Math.max(this.floor * SEG.startRatio, SEG.minRms)) this.loudRun += pcm.length;
      else this.loudRun = 0;
      if (this.loudRun >= msToSamples(SEG.startMs)) {
        this.speech = this.loudRun;
        this.quiet = 0;
      }
      return null;
    }
    this.speech += pcm.length;
    if (rms >= Math.max(this.floor * SEG.keepRatio, SEG.minRms)) this.quiet = 0;
    else this.quiet += pcm.length;
    if (this.quiet >= msToSamples(SEG.endMs)) return this.finish(false);
    if (this.speech >= msToSamples(SEG.maxMs)) return this.finish(true);
    return null;
  }

  private finish(capped: boolean): Int16Array | null {
    const voiced = this.speech - this.quiet;
    const clip = this.ring.take(this.speech + msToSamples(SEG.prerollMs));
    this.speech = this.loudRun = this.quiet = 0;
    this.capped = capped;
    return voiced >= msToSamples(SEG.minMs) ? clip : null;
  }
}

// Wake word scores with their times, to find the peak over a clip after the fact
// (the score rises up to about a second after the phrase ends).
export class ScoreHistory {
  private items: { t: number; s: number }[] = [];
  private readonly keepMs: number;

  constructor(keepMs = 10_000) {
    this.keepMs = keepMs;
  }

  add(s: number, t: number): void {
    this.items.push({ t, s });
    while (this.items.length && this.items[0].t < t - this.keepMs) this.items.shift();
  }

  peak(from: number, to: number): number {
    let p = 0;
    for (const { t, s } of this.items) if (t >= from && t <= to) p = Math.max(p, s);
    return Math.round(p * 1000) / 1000;
  }
}
