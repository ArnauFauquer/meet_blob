// AudioWorklet: microphone input to 16 kHz mono signed 16-bit PCM.
// Posts one Int16Array per render block; the main thread collects them.
import { Resampler, toS16 } from '../pcm';

// AudioWorkletGlobalScope globals (not in the DOM lib).
declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class CaptureProcessor extends AudioWorkletProcessor {
  private resampler = new Resampler(sampleRate);

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (ch && ch.length) {
      const pcm = toS16(this.resampler.push(ch));
      if (pcm.length) this.port.postMessage(pcm, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
