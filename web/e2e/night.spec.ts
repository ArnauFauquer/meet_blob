// Night mode against the mock: devices named with "night" get a night from an
// hour ago to an hour from now. The schedule itself (midnight, clock changes)
// is unit-tested in src/night.test.ts.
import { expect, test } from '@playwright/test';
import { alertSource, dbg, mockOnly, openBlob, shape, tap, waitView } from './helpers';

interface Night {
  on: boolean;
  asleep: boolean;
  dim: number;
  maxFps: number;
  shown: string[];
}
const night = (page: import('@playwright/test').Page) => dbg<Night>(page, 'night');

test.beforeEach(() => mockOnly());

test('at night the blob sleeps (dim, 10 fps, no clock), and a tap wakes it', async ({ page }) => {
  await openBlob(page, 'e2e-night');
  await waitView(page, 'idle');
  await expect.poll(async () => (await night(page))?.asleep, { message: 'asleep' }).toBe(true);
  const n = (await night(page))!;
  expect([n.on, n.dim, n.maxFps]).toEqual([true, 0.2, 10]);
  // No clock at night: five minutes of idle and the blob is still a sphere.
  await page.evaluate(() => (window as unknown as { blobDebug: { idleFor(ms: number): void } }).blobDebug.idleFor(6 * 60_000));
  await page.waitForTimeout(1500);
  expect((await shape(page))?.b).toBe(0);
  expect(await page.evaluate(() => document.body.classList.contains('night'))).toBe(true);

  await tap(page);
  await waitView(page, 'listening'); // it answers as usual
  const awake = (await night(page))!;
  expect([awake.asleep, awake.dim, awake.maxFps]).toEqual([false, 1, Infinity]);
  expect(await page.evaluate(() => document.body.classList.contains('night'))).toBe(false);
});

test('at night an info alert waits silently, an urgent one shows and rings', async ({ page, request }) => {
  const alerts = alertSource(request);
  try {
    await openBlob(page, 'e2e-night-sound');
    await waitView(page, 'idle');
    await expect.poll(async () => (await night(page))?.asleep).toBe(true);
    const info = await alerts.post('night-info', { source: 'homeassistant', urgency: 'info' });
    await expect.poll(() => dbg<string[]>(page, 'alerts')).toContain(info);
    await page.waitForTimeout(1000);
    expect(await dbg(page, 'view'), 'the info alert is held').toBe('idle');
    expect(await dbg<number>(page, 'alarms'), 'and silent').toBe(0);
    expect((await night(page))!.shown).toEqual([]);

    const timer = await alerts.post('night-timer', { source: 'timer' }); // urgent by default
    await waitView(page, 'alert');
    expect(await dbg(page, 'topAlert')).toBe(timer);
    await expect.poll(() => dbg<number>(page, 'alarms'), { message: 'the timer rings' }).toBe(1);
    await expect.poll(async () => (await night(page))?.asleep, { message: 'awake while it rings' }).toBe(false);
    expect((await night(page))!.shown).toEqual([timer]);
  } finally {
    await alerts.cleanup();
  }
});
