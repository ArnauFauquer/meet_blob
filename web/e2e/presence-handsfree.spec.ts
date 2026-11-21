// Presence wake with hands-free on: the dark screen must not stop the wake word.
// Mock-only (a 4 s presence_sleep_s for devices named *presence*).
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { micArgs } from './mics';
import { ALERT_TOKEN, dbg, log, mockOnly, openBlob } from './helpers';

test.use({ launchOptions: { args: micArgs('silence') } });

const headers = { Authorization: `Bearer ${ALERT_TOKEN}` };
const report = async (request: APIRequestContext, present: boolean) =>
  expect((await request.post('/presence', { headers, data: { present } })).status()).toBe(200);
const asleep = (page: Page) => dbg<{ asleep: boolean } | undefined>(page, 'screen').then((s) => s?.asleep);
const waitAsleep = (page: Page, want: boolean) =>
  expect.poll(() => asleep(page), { message: want ? 'screen dark' : 'screen lit', timeout: 30_000 }).toBe(want);

test.beforeEach(() => mockOnly());
test.afterEach(async ({ request }) => {
  await request.delete('/presence', { headers });
});

test('the wake word keeps listening on the dark screen', async ({ page, request }) => {
  test.setTimeout(120_000);
  await openBlob(page, 'hf-presence');
  await expect.poll(() => dbg<{ wakeReady: boolean }>(page, 'handsFree'), { message: 'models loaded', timeout: 30_000 })
    .toMatchObject({ on: true, wakeReady: true });
  await report(request, false);
  await waitAsleep(page, true);
  await page.waitForTimeout(2000);
  expect(await asleep(page)).toBe(true);
  expect(await dbg(page, 'handsFree')).toMatchObject({ wakeOn: true }); // audio still reaches the open gate
  const gates = (await log(page)).filter((e) => e.dir === 'send' && e.data?.type === 'client_event' && e.data.kind === 'wake_gate');
  expect(gates.at(-1)?.data).toMatchObject({ on: true, why: 'open' });
  expect(await page.evaluate(() => (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks.every((tr) => tr.readyState === 'live'))).toBe(true);
});
