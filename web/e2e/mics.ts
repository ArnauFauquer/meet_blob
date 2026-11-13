import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixtureAt48k, speechLike, wav } from './wav.ts';

// Fake microphones, looped by Chromium. Default: 1 s of a speech-like tone,
// then 1 s of silence. Hands-free specs pick another with micArgs():
// hey-blob, hey-jarvis and question are synthetic Kokoro speech (e2e/fixtures), silence is silence.
const cache = fileURLToPath(new URL('../node_modules/.cache/blob-e2e/', import.meta.url));
mkdirSync(cache, { recursive: true });
const fixture = (name: string) => fixtureAt48k(readFileSync(new URL(`./fixtures/${name}.wav`, import.meta.url)));
const mics = {
  default: wav(speechLike(48000, 1, 1), 48000),
  'hey-blob': fixture('hey-blob'),
  'hey-jarvis': fixture('hey-jarvis'),
  question: fixture('question'),
  silence: wav(new Float32Array(48000 * 2), 48000),
};
for (const [name, data] of Object.entries(mics)) writeFileSync(`${cache}mic-${name}.wav`, data);

export function micArgs(mic: keyof typeof mics = 'default'): string[] {
  return [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${cache}mic-${mic}.wav`,
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--autoplay-policy=no-user-gesture-required',
  ];
}
