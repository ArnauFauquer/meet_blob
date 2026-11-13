// openWakeWord streaming feature pipeline (same maths as openwakeword.utils.AudioFeatures):
// 16 kHz int16 audio in 80 ms chunks -> melspectrogram model (8 frames x 32
// bins per chunk, scaled x/10 + 2) -> embedding model on the last 76 frames
// (96 values) -> wake word model on the last 16 embeddings -> score 0..1.

export const CHUNK = 1280; // 80 ms at 16 kHz
export const MEL_CONTEXT = 480; // 3 hops of overlap with the previous chunk
export const MEL_BINS = 32;
export const MEL_WINDOW = 76; // frames per embedding
export const EMB = 96;
export const FEATURES = 16; // embeddings per wake word prediction

// The three ONNX models, as plain functions (the worker binds them to onnxruntime-web).
export interface OwwModels {
  mel(audio: Float32Array): Promise<Float32Array>; // (CHUNK + MEL_CONTEXT) samples -> frames x 32, raw model output
  embed(mel: Float32Array): Promise<Float32Array>; // 76 x 32 -> 96
  score(features: Float32Array): Promise<number>; // 16 x 96 -> score
}

export class OwwPipeline {
  private readonly m: OwwModels;
  private raw = new Float32Array(CHUNK + MEL_CONTEXT);
  private pending = new Float32Array(CHUNK);
  private filled = 0;
  private mel = new Float32Array(MEL_WINDOW * MEL_BINS);
  private feats = new Float32Array(FEATURES * EMB);

  constructor(models: OwwModels) {
    this.m = models;
    this.reset();
  }

  // Forget all audio (used when the detector is unmuted, so speech from before
  // the mute cannot fire it). Zero features score about 0 with the stock models.
  reset(): void {
    this.raw.fill(0);
    this.filled = 0;
    this.mel.fill(1);
    this.feats.fill(0);
  }

  // Feeds 16 kHz int16 audio; returns one score per completed 80 ms chunk.
  async push(pcm: Int16Array): Promise<number[]> {
    const scores: number[] = [];
    let i = 0;
    while (i < pcm.length) {
      const n = Math.min(CHUNK - this.filled, pcm.length - i);
      for (let k = 0; k < n; k++) this.pending[this.filled + k] = pcm[i + k];
      this.filled += n;
      i += n;
      if (this.filled === CHUNK) {
        this.filled = 0;
        scores.push(await this.chunk());
      }
    }
    return scores;
  }

  private async chunk(): Promise<number> {
    this.raw.copyWithin(0, CHUNK);
    this.raw.set(this.pending, MEL_CONTEXT);
    const frames = await this.m.mel(this.raw);
    const n = Math.floor(frames.length / MEL_BINS);
    shiftIn(this.mel, frames.map((v) => v / 10 + 2), n * MEL_BINS);
    shiftIn(this.feats, await this.m.embed(this.mel), EMB);
    return this.m.score(this.feats);
  }
}

// Drops the oldest `n` values of a rolling buffer and appends the last `n` of `src`.
function shiftIn(buf: Float32Array, src: Float32Array, n: number): void {
  n = Math.min(n, buf.length, src.length);
  buf.copyWithin(0, n);
  buf.set(src.subarray(src.length - n), buf.length - n);
}
