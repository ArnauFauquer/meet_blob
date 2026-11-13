// Runs the real openWakeWord models (web/public/models) through OwwPipeline on
// the synthetic Kokoro clip, with onnxruntime-web's wasm backend in Node.
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web';
import { OwwPipeline } from './oww';
import { bindModels } from './models';

const file = (p: string) => readFileSync(new URL(p, import.meta.url));
const models = (name: string) => `../../public/models/${name}`;

function pcm16(wav: Buffer): Int16Array {
  const data = wav.indexOf('data') + 8;
  return new Int16Array(wav.buffer.slice(wav.byteOffset + data, wav.byteOffset + wav.length));
}

async function maxScore(clip: Int16Array, ww = 'hey_jarvis_v0.1.onnx'): Promise<number> {
  ort.env.wasm.numThreads = 1;
  const load = (n: string) => ort.InferenceSession.create(file(models(n)));
  const p = new OwwPipeline(bindModels(ort, await load('melspectrogram.onnx'), await load('embedding_model.onnx'), await load(ww)));
  let best = 0;
  for (let i = 0; i < clip.length; i += 320) for (const s of await p.push(clip.subarray(i, i + 320))) best = Math.max(best, s);
  return best;
}

describe('openWakeWord pipeline with the real models', () => {
  it('fires on "hey jarvis" (score matches the Python reference, 0.999)', async () => {
    expect(await maxScore(pcm16(file('../../e2e/fixtures/hey-jarvis.wav')))).toBeGreaterThan(0.9);
  }, 60_000);
  it('stays low on another sentence', async () => {
    expect(await maxScore(pcm16(file('../../e2e/fixtures/question.wav')))).toBeLessThan(0.1);
  }, 60_000);
  it('fires on "hey blob" with the trained hey_blob model (Python reference 0.928)', async () => {
    expect(await maxScore(pcm16(file('../../e2e/fixtures/hey-blob.wav')), 'hey_blob.onnx')).toBeGreaterThan(0.8);
  }, 60_000);
  it('hey_blob stays low on "hey jarvis" and another sentence', async () => {
    expect(await maxScore(pcm16(file('../../e2e/fixtures/hey-jarvis.wav')), 'hey_blob.onnx')).toBeLessThan(0.1);
    expect(await maxScore(pcm16(file('../../e2e/fixtures/question.wav')), 'hey_blob.onnx')).toBeLessThan(0.1);
  }, 60_000);
});
