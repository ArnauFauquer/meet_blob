// AudioWorklet: microphone input to 16 kHz mono signed 16-bit PCM.
// Posts one Int16Array per 20 ms (320 samples); the main thread collects them.
import { Resampler, WINDOW_SAMPLES, toS16 } from '../pcm';

// AudioWorkletGlobalScope globals (not in the DOM lib).
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class CaptureProcessor extends AudioWorkletProcessor {
  private resampler = new Resampler(sampleRate);
  private buf = new Float32Array(WINDOW_SAMPLES * 2);
  private n = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch || !ch.length) return true;
    const out = this.resampler.push(ch);
    if (this.n + out.length > this.buf.length) {
      const bigger = new Float32Array(this.n + out.length);
      bigger.set(this.buf.subarray(0, this.n));
      this.buf = bigger;
    }
    this.buf.set(out, this.n);
    this.n += out.length;
    // Batches of 20 ms keep the message rate low for the wake word and VAD consumers.
    if (this.n >= WINDOW_SAMPLES) {
      const pcm = toS16(this.buf.subarray(0, this.n));
      this.n = 0;
      this.port.postMessage(pcm, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
