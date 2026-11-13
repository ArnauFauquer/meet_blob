import type * as Ort from 'onnxruntime-web';
import type { OwwModels } from './oww';
import { EMB, FEATURES, MEL_BINS, MEL_WINDOW } from './oww';

type OrtModule = typeof Ort;

// Binds the three openWakeWord ONNX sessions to the pipeline. Input and output
// names are read from the sessions, so a custom-trained wake model drops in.
export function bindModels(ort: OrtModule, mel: Ort.InferenceSession, emb: Ort.InferenceSession, ww: Ort.InferenceSession): OwwModels {
  const run = async (s: Ort.InferenceSession, data: Float32Array, dims: number[]) => {
    const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', data, dims) });
    return out[s.outputNames[0]].data as Float32Array;
  };
  return {
    mel: (audio) => run(mel, audio.slice(), [1, audio.length]),
    embed: (m) => run(emb, m.slice(), [1, MEL_WINDOW, MEL_BINS, 1]),
    score: async (f) => (await run(ww, f.slice(), [1, FEATURES, EMB]))[0],
  };
}
