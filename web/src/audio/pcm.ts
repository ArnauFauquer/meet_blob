// Pure PCM helpers shared by the capture worklet and the main thread.
import { PCM_RATE } from '../protocol';

export const OUT_RATE = PCM_RATE;
export const WINDOW_SAMPLES = 320; // 20 ms at 16 kHz

export const msToSamples = (ms: number) => Math.round((ms * OUT_RATE) / 1000);
export const samplesToMs = (n: number) => Math.round((n * 1000) / OUT_RATE);

// RMS of 16-bit samples, in 0..1 of full scale (0 for no samples).
export function rmsS16(pcm: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 0x8000) ** 2;
  return pcm.length ? Math.sqrt(sum / pcm.length) : 0;
}

// Streaming resampler to 16 kHz mono. It averages the input samples that fall
// in each output step (a box filter, enough against aliasing for speech at
// 44.1/48 kHz input), and carries its position across blocks.
export class Resampler {
  private readonly step: number;
  private pos = 0; // position of the next output sample, in input samples, relative to the block start
  private acc = 0;
  private n = 0;

  constructor(inRate: number) {
    this.step = inRate / OUT_RATE;
  }

  push(input: Float32Array): Float32Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.n += 1;
      if (i + 1 >= this.pos + this.step) {
        out.push(this.acc / this.n);
        this.acc = 0;
        this.n = 0;
        this.pos += this.step;
      }
    }
    this.pos -= input.length;
    return Float32Array.from(out);
  }
}

export function toS16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export interface Recording {
  pcm: Int16Array;
  durMs: number;
  tailSilenceMs: number;
}

// Collects 16 kHz s16 samples up to a cap, and finds the last voiced 20 ms window.
export class Recorder {
  private chunks: Int16Array[] = [];
  private length = 0;
  private readonly cap: number;
  private readonly silenceRms: number;

  constructor(capMs: number, silenceRms: number) {
    this.cap = msToSamples(capMs);
    this.silenceRms = silenceRms;
  }

  get full(): boolean {
    return this.length >= this.cap;
  }

  push(s: Int16Array): void {
    const room = this.cap - this.length;
    if (room <= 0) return;
    const c = s.length > room ? s.slice(0, room) : s;
    this.chunks.push(c);
    this.length += c.length;
  }

  finish(): Recording {
    const pcm = new Int16Array(this.length);
    let o = 0;
    for (const c of this.chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    return {
      pcm,
      durMs: samplesToMs(pcm.length),
      tailSilenceMs: tailSilenceMs(pcm, this.silenceRms),
    };
  }
}

// Time from the end of the last 20 ms window whose RMS is above the threshold
// to the end of the buffer. No voiced window: the whole duration.
export function tailSilenceMs(pcm: Int16Array, silenceRms: number): number {
  const windows = Math.floor(pcm.length / WINDOW_SAMPLES);
  for (let w = windows - 1; w >= 0; w--) {
    const end = (w + 1) * WINDOW_SAMPLES;
    if (rmsS16(pcm.subarray(end - WINDOW_SAMPLES, end)) > silenceRms) return samplesToMs(pcm.length - end);
  }
  return samplesToMs(pcm.length);
}

// RMS of an analyser's time-domain buffer, mapped to 0..1 for the shader.
export function levelOf(buf: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.min(1, Math.sqrt(sum / buf.length) * 4);
}
