import { defineConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { speechLike, wav } from './e2e/wav.ts';

// BLOB_URL unset: tests run against the mock backend (which serves dist/).
// BLOB_URL set: tests run against that backend (it must serve the built page);
// scenario-only tests are skipped unless BLOB_SCENARIOS=1.
const external = process.env.BLOB_URL;
const port = Number(process.env.MOCK_PORT ?? 8787);

// Fake microphone: 1 s of a speech-like tone, then 1 s of silence, looped by Chromium.
const micWav = fileURLToPath(new URL('./node_modules/.cache/blob-e2e/mic.wav', import.meta.url));
mkdirSync(fileURLToPath(new URL('./node_modules/.cache/blob-e2e/', import.meta.url)), { recursive: true });
writeFileSync(micWav, wav(speechLike(48000, 1, 1), 48000));

export const chromiumArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${micWav}`,
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--ignore-gpu-blocklist',
];

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1, // one backend, one turn lock
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: external ?? `http://localhost:${port}`,
    browserName: 'chromium',
    viewport: { width: 480, height: 360 },
    permissions: ['microphone'],
    launchOptions: { args: [...chromiumArgs, '--autoplay-policy=no-user-gesture-required'] },
  },
  testIgnore: process.env.SCREENSHOTS ? [] : ['screenshots.spec.ts', 'motion.spec.ts'],
  webServer: external
    ? undefined
    : {
        command: 'node e2e/mock-backend.ts',
        url: `http://localhost:${port}/healthz`,
        env: { PORT: String(port) },
        reuseExistingServer: false,
        stdout: 'pipe',
      },
});
