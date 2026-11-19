import { expect, test } from '@playwright/test';
import { mockOnly, openBlob, shape, waitView } from './helpers';

const CLOCK = 3; // SHAPE in render/tables.ts
const WEATHER = 4;
const REST_MS = 5 * 60_000; // CLOCK_AFTER_MS
const CLOCK_TURN_MS = 30_000;

test('the resting blob takes turns between the clock and the weather, with the week below', async ({ page }) => {
  mockOnly();
  await openBlob(page, 'e2e-weather');
  await waitView(page, 'idle');
  await expect.poll(() => page.evaluate(() => !!(window as unknown as { blobDebug: { weather: unknown } }).blobDebug.weather)).toBe(true);
  const idleFor = (ms: number) => page.evaluate((m) => (window as unknown as { blobDebug: { idleFor(ms: number): void } }).blobDebug.idleFor(m), ms);
  await idleFor(REST_MS);
  await expect.poll(async () => { const s = await shape(page); return s?.a === CLOCK && s.mix === 0; }, { timeout: 20_000 }).toBe(true);
  await expect(page.locator('#weather')).toHaveClass(/on/);
  await expect(page.locator('#weather .day')).toHaveCount(7);
  await idleFor(REST_MS + CLOCK_TURN_MS + 1000);
  await expect.poll(async () => { const s = await shape(page); return s?.a === WEATHER && s.mix === 0; }, { timeout: 20_000 }).toBe(true);
  await expect(page.locator('#weather .now')).not.toHaveClass(/off/);
  await expect(page.locator('#weather .now')).toHaveText('15°');
});
