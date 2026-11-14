import { expect, test } from '@playwright/test';
import { openBlob, shape, tap, waitView } from './helpers';

const CLOCK = 3; // SHAPE.clock in render/tables.ts

test('five minutes of idle turn the blob into a clock; a tap brings the blob back', async ({ page }) => {
  await openBlob(page, 'e2e-clock');
  await waitView(page, 'idle');
  expect((await shape(page))?.a).toBe(0);
  await page.evaluate(() => (window as unknown as { blobDebug: { idleFor(ms: number): void } }).blobDebug.idleFor(5 * 60_000));
  await expect.poll(async () => { const s = await shape(page); return s?.a === CLOCK && s.mix === 0; }, { timeout: 20_000 }).toBe(true);
  await tap(page);
  await waitView(page, 'listening');
  await expect.poll(async () => { const s = await shape(page); return s?.a === 0 && s.mix === 0; }, { timeout: 20_000 }).toBe(true);
});
