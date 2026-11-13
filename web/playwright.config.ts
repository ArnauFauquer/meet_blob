import { defineConfig } from '@playwright/test';
import { micArgs } from './e2e/mics.ts';

// BLOB_URL unset: tests run against the mock backend (which serves dist/).
// BLOB_URL set: tests run against that backend (it must serve the built page);
// scenario-only tests are skipped unless BLOB_SCENARIOS=1.
const external = process.env.BLOB_URL;
const port = Number(process.env.MOCK_PORT ?? 8787);

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1, // one backend, one turn lock
  fullyParallel: false,
  // The 2-core CI runner starts the fake mic late on the first turn (timing asserts); a retry shows as "flaky".
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: external ?? `http://localhost:${port}`,
    browserName: 'chromium',
    viewport: { width: 480, height: 360 },
    permissions: ['microphone'],
    launchOptions: { args: micArgs() },
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
