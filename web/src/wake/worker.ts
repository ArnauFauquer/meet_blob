// Web Worker: the wake word (openWakeWord) and the voice-activity detector
// (Silero, through @ricky0123/vad-web) on one onnxruntime-web instance with one
// thread. It gets 16 kHz int16 audio from the page and posts scores.
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { Silero } from '@ricky0123/vad-web/dist/models/silero';
import { bindModels } from './models';
import { OwwPipeline } from './oww';
import type { FromWorker, ToWorker } from './messages';

ort.env.wasm.numThreads = 1; // no SharedArrayBuffer, no cross-origin isolation needed
ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, self.location.href).href };

const VAD_FRAME = 512; // Silero v5 frame at 16 kHz (32 ms)

let oww: OwwPipeline | null = null;
let vad: Silero | null = null;
const vadBuf = new Float32Array(VAD_FRAME);
let vadFill = 0;
let queue: Promise<void> = Promise.resolve();

const post = (m: FromWorker) => postMessage(m);
const bytes = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
};

async function init(base: string, wakeModel: string): Promise<void> {
  const session = async (name: string) => ort.InferenceSession.create(await bytes(base + name));
  try {
    oww = new OwwPipeline(
      bindModels(ort, await session('melspectrogram.onnx'), await session('embedding_model.onnx'), await session(wakeModel)),
    );
  } catch (e) {
    post({ type: 'error', what: 'wake', message: String(e) });
  }
  try {
    vad = (await Silero.new(ort, async () => (await bytes(base + 'silero_vad_v5.onnx')).buffer as ArrayBuffer)) as Silero;
  } catch (e) {
    post({ type: 'error', what: 'vad', message: String(e) });
  }
  post({ type: 'ready', wake: oww !== null, vad: vad !== null });
}

async function audio(pcm: Int16Array, wake: boolean, runVad: boolean): Promise<void> {
  if (wake && oww) for (const score of await oww.push(pcm)) post({ type: 'score', score });
  if (runVad && vad) {
    for (let i = 0; i < pcm.length; i++) {
      vadBuf[vadFill++] = pcm[i] / 32768;
      if (vadFill === VAD_FRAME) {
        vadFill = 0;
        post({ type: 'vad', p: (await vad.process(vadBuf.slice())).isSpeech });
      }
    }
  }
}

// Messages run one at a time, in order (model calls are async).
self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  queue = queue
    .then(async () => {
      if (m.type === 'init') return init(m.base, m.wakeModel);
      if (m.type === 'audio') return audio(m.pcm, m.wake, m.vad);
      if (m.wake) oww?.reset();
      if (m.vad) {
        vad?.reset_state();
        vadFill = 0;
      }
    })
    .catch((e: unknown) => post({ type: 'error', what: m.type === 'audio' && m.vad ? 'vad' : 'wake', message: String(e) }));
};
