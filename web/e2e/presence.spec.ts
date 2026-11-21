// Presence wake: POST /presence (a Home Assistant automation in real life) puts
// the idle screen to sleep (black, nothing drawn) and wakes it again. Mock-only:
// the mock gives devices named *presence* a 4 s presence_sleep_s.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ALERT_TOKEN, alertSource, dbg, log, mockOnly, openBlob, sent, shape, tap, waitView } from './helpers';

const headers = { Authorization: `Bearer ${ALERT_TOKEN}` };
const report = async (request: APIRequestContext, present: boolean) =>
  expect((await request.post('/presence', { headers, data: { present } })).status()).toBe(200);
const asleep = (page: Page) => dbg<{ asleep: boolean } | undefined>(page, 'screen').then((s) => s?.asleep);
const waitAsleep = (page: Page, want: boolean) =>
  expect.poll(() => asleep(page), { message: want ? 'screen dark' : 'screen lit', timeout: 30_000 }).toBe(want);
const bodyAsleep = (page: Page) => page.evaluate(() => document.body.classList.contains('asleep'));

test.beforeEach(() => mockOnly());
test.afterEach(async ({ request }) => {
  await request.delete('/presence', { headers });
});

test('without a sensor nothing changes: no presence message, the screen never sleeps', async ({ page }) => {
  await openBlob(page, 'e2e-presence-none');
  await waitView(page, 'idle');
  await page.waitForTimeout(6000); // past the 4 s sleep time this device would have
  expect(await asleep(page)).toBe(false);
  expect((await log(page)).filter((e) => e.dir === 'recv' && e.data?.type === 'presence')).toHaveLength(0);
});

test('nobody there: dark screen; someone arrives: the face; a tap on the dark screen only wakes it', async ({ page, request }) => {
  await openBlob(page, 'e2e-presence');
  await waitView(page, 'idle');
  await report(request, false);
  await waitAsleep(page, true);
  expect(await bodyAsleep(page)).toBe(true);
  expect(await dbg(page, 'view')).toBe('idle');
  // Frames at the minimum: once black, one frame every 5 s (DARK_FPS).
  await expect.poll(async () => (await dbg<{ maxFps: number }>(page, 'screen'))?.maxFps).toBe(0.2);
  const before = (await dbg<{ drawn: number }>(page, 'screen'))!.drawn;
  await page.waitForTimeout(3000);
  expect((await dbg<{ drawn: number }>(page, 'screen'))!.drawn - before).toBeLessThanOrEqual(1);

  await report(request, true);
  await waitAsleep(page, false);
  expect(await bodyAsleep(page)).toBe(false);
  expect((await dbg<{ maxFps: number }>(page, 'screen'))?.maxFps).toBe(Infinity); // the cap is gone
  await expect.poll(async () => (await shape(page))?.a, { message: 'the sphere, not the clock' }).toBe(0);

  await report(request, false);
  await waitAsleep(page, true);
  await tap(page);
  await waitAsleep(page, false);
  await page.waitForTimeout(500);
  expect(await dbg(page, 'phase')).toBe('idle');
  expect(sent(await log(page), 'tap')).toHaveLength(0); // the tap only woke the screen
  await waitAsleep(page, true); // and it sleeps again after the quiet time
});

test('someone already there: a repeated true does not pull the clock back to the face', async ({ page, request }) => {
  await openBlob(page, 'e2e-presence-pir');
  await waitView(page, 'idle');
  await report(request, true);
  await page.evaluate(() => (window as unknown as { blobDebug: { idleFor(ms: number): void } }).blobDebug.idleFor(5 * 60_000));
  await expect.poll(async () => { const s = await shape(page); return s?.a === 3 && s.mix === 0; }, { message: 'the clock' }).toBe(true);
  await report(request, true); // the PIR fires again
  await page.waitForTimeout(1500);
  expect((await shape(page))?.a).toBe(3); // still the clock (SHAPE.clock)
  expect(await asleep(page)).toBe(false);
});

test('an alert lights the dark screen; it sleeps again once the alert is gone', async ({ page, request }) => {
  const alerts = alertSource(request);
  await openBlob(page, 'e2e-presence-alert');
  await waitView(page, 'idle');
  await report(request, false);
  await waitAsleep(page, true);
  const key = await alerts.post('presence', { source: 'homeassistant' });
  await waitView(page, 'alert');
  await waitAsleep(page, false);
  await alerts.del(key);
  await waitView(page, 'idle');
  await waitAsleep(page, true);
});

test('DELETE /presence goes back to no sensor: the screen lights up', async ({ page, request }) => {
  await openBlob(page, 'e2e-presence-drop');
  await waitView(page, 'idle');
  await report(request, false);
  await waitAsleep(page, true);
  await request.delete('/presence', { headers });
  await waitAsleep(page, false);
});

test('at night: nobody there is black, someone there is the sleeping night blob, a true does not wake the face', async ({ page, request }) => {
  const night = () => dbg<{ asleep: boolean; dim: number; maxFps: number }>(page, 'night');
  await openBlob(page, 'e2e-night-presence'); // the mock gives "night" devices a night around now
  await waitView(page, 'idle');
  await expect.poll(async () => (await night())?.asleep, { message: 'night blob asleep' }).toBe(true);
  expect(await night()).toMatchObject({ dim: 0.2, maxFps: 10 });

  await report(request, false);
  await waitAsleep(page, true);
  expect(await night()).toMatchObject({ asleep: true, dim: 0, maxFps: 0.2 }); // the lowest wins: black

  await report(request, true);
  await waitAsleep(page, false);
  await page.waitForTimeout(1000);
  expect(await night()).toMatchObject({ asleep: true, dim: 0.2, maxFps: 10 }); // back to the night blob, not the face
  expect(await dbg(page, 'view')).toBe('idle');
  expect((await shape(page))?.b).toBe(0); // the sphere, no clock at night
});
