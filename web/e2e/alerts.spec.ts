// S4 alert flows. Protocol-visible, so they also run against a real backend
// (BLOB_URL) when BLOB_ALERT_TOKEN is set; the synthesis-failure flow is mock-only.
import { expect, test } from '@playwright/test';
import { alertSource, dbg, external, log, mockOnly, needsAlerts, openBlob, recv, sent, shape, speak, tap, waitFor, waitView } from './helpers';

const SHAPE = { sphere: 0, triangle: 1, square: 2 };
let alerts: ReturnType<typeof alertSource>;

test.beforeEach(({ request }) => {
  needsAlerts();
  alerts = alertSource(request);
});
test.afterEach(async () => alerts?.cleanup());

// Waits until the morph to `id` has finished and returns the uniforms.
async function settledShape(page: import('@playwright/test').Page, id: number) {
  await expect.poll(async () => { const s = await shape(page); return s && s.a === id && s.mix === 0; }, { message: `shape ${id}` }).toBe(true);
  return (await shape(page))!;
}
const greenish = (c: number[]) => c[1] > c[0] * 2 && c[1] > c[2] * 2;
const reddish = (c: number[]) => c[0] > c[1] * 4 && c[0] > c[2] * 4;

test('an alert appears: timer triangle in green (info), then calendar square in red (urgent) on top', async ({ page }) => {
  await openBlob(page, 'e2e-alert-view');
  await waitView(page, 'idle');
  const t = await alerts.post('timer', { source: 'timer', urgency: 'info' });
  await waitView(page, 'alert');
  expect(await dbg(page, 'topAlert')).toBe(t);
  await expect.poll(async () => greenish((await shape(page))!.color), { message: 'green colour uniform' }).toBe(true);
  expect((await settledShape(page, SHAPE.triangle)).b).toBe(SHAPE.triangle);

  const c = await alerts.post('calendar', { source: 'calendar', urgency: 'urgent' });
  await expect.poll(() => dbg(page, 'topAlert')).toBe(c);
  // the morph runs through a mix between 0 and 1 (about 0.8 s)
  await expect.poll(async () => { const s = await shape(page); return s!.mix > 0 && s!.mix < 1 && s!.b === SHAPE.square; }).toBe(true);
  await settledShape(page, SHAPE.square);
  await expect.poll(async () => reddish((await shape(page))!.color), { message: 'red colour uniform' }).toBe(true);

  // cleared: back to the sphere
  await alerts.del(c);
  await alerts.del(t);
  await waitView(page, 'idle');
  await settledShape(page, SHAPE.sphere);
});

test('two alerts: urgent before info, then oldest first', async ({ page }) => {
  await openBlob(page, 'e2e-alert-order');
  await waitView(page, 'idle');
  const old = await alerts.post('info-old', { source: 'calendar', urgency: 'info' });
  await page.waitForTimeout(1100); // activated_at is in whole seconds
  const young = await alerts.post('info-new', { source: 'homeassistant', urgency: 'info' });
  await expect.poll(() => dbg<string[]>(page, 'alerts')).toEqual(expect.arrayContaining([old, young]));
  expect(await dbg(page, 'topAlert')).toBe(old);
  const urgent = await alerts.post('urgent', { source: 'timer', urgency: 'urgent' });
  await expect.poll(() => dbg(page, 'topAlert')).toBe(urgent);
  await alerts.del(urgent);
  await expect.poll(() => dbg(page, 'topAlert')).toBe(old);
});

test('a tap reads the alert: alert_read, the WAV plays, alert_ack after playback ends', async ({ page }) => {
  await openBlob(page, 'e2e-alert-read');
  await waitView(page, 'idle');
  const key = await alerts.post('read', { source: 'timer', urgency: 'urgent', text: 'The ten minute timer is done.' });
  await waitView(page, 'alert');
  const startedBefore = await dbg<number>(page, 'started');
  await tap(page);
  let l = await waitFor(page, (l) => sent(l, 'alert_read').length > 0, 'alert_read sent');
  expect(sent(l, 'alert_read')[0].data).toEqual({ type: 'alert_read', key });
  expect(sent(l, 'tap')).toHaveLength(0);
  l = await waitFor(page, (l) => recv(l, 'tts').some((e) => e.data?.alert === key), 'tts for the alert');
  const ti = l.findIndex((e) => e.dir === 'recv' && e.data?.type === 'tts');
  expect(l[ti].data).toMatchObject({ alert: key, turn: null, final: true });
  expect(l[ti + 1].data!.binary).toBeGreaterThan(44);
  await expect.poll(() => dbg<number>(page, 'started'), { message: 'the WAV plays' }).toBeGreaterThan(startedBefore);
  expect(await dbg(page, 'view')).toBe('alert'); // the alert stays on screen while it is read
  expect(sent(await log(page), 'alert_ack')).toHaveLength(0); // not before playback ends
  l = await waitFor(page, (l) => sent(l, 'alert_ack').length > 0, 'alert_ack sent');
  const ack = sent(l, 'alert_ack')[0];
  expect(ack.data).toEqual({ type: 'alert_ack', key });
  expect(await dbg(page, 'playing')).toBe(false);
  expect(ack.t - l[ti].t).toBeGreaterThan(external ? 300 : 1300); // mock WAV is 1.6 s
  await waitView(page, 'idle');
});

test('an alert raised during a turn is held hidden until the turn ends', async ({ page }) => {
  await openBlob(page, 'e2e-alert-held');
  await speak(page);
  const key = await alerts.post('held', { source: 'timer', urgency: 'urgent' });
  const l = await waitFor(page, (l) => recv(l, 'snapshot').some((e) => (e.data?.alerts as { key: string }[])?.some((a) => a.key === key)), 'snapshot with the alert');
  expect(l.length).toBeGreaterThan(0);
  // the turn (thinking or speaking) is drawn while it runs, not the alert
  const views = new Set<string>();
  while ((await dbg(page, 'view')) !== 'alert') {
    views.add(String(await dbg(page, 'view')));
    await page.waitForTimeout(50);
    expect(views.has('idle'), 'never idle between the turn and the alert').toBe(false);
  }
  expect([...views].some((v) => v === 'thinking' || v === 'speaking')).toBe(true);
  expect(recv(await log(page), 'turn_done')).toHaveLength(1);
});

test('the chime plays once per alert on a sound=true device, held during a turn', async ({ page }) => {
  await openBlob(page, 'e2e-sound');
  await waitView(page, 'idle');
  await page.waitForTimeout(500); // /device-config read
  const a = await alerts.post('chime-a', { source: 'calendar' });
  await expect.poll(() => dbg<number>(page, 'effects'), { message: 'chime played' }).toBe(1);
  await alerts.post('chime-a', { source: 'calendar', text: 'Updated text.' }, a); // same alert, new snapshot
  await page.waitForTimeout(1000);
  expect(await dbg<number>(page, 'effects'), 'no second chime for the same alert').toBe(1);
  await tap(page); // reads it and acks it
  await waitFor(page, (l) => sent(l, 'alert_ack').length > 0, 'alert_ack');
  await waitView(page, 'idle');
  // an alert raised during a turn chimes only when the turn ends
  await speak(page);
  await alerts.post('chime-b', { source: 'timer' });
  await waitFor(page, (l) => recv(l, 'snapshot').some((e) => (e.data?.alerts as unknown[])?.length), 'snapshot with the alert');
  expect(await dbg<number>(page, 'effects'), 'held during the turn').toBe(1);
  await waitView(page, 'alert');
  await expect.poll(() => dbg<number>(page, 'effects')).toBe(2);
});

test('alert synthesis fails: the alert stays, the beep plays, no alert_ack (mock)', async ({ page }) => {
  mockOnly();
  await openBlob(page, 'e2e-alert-fail');
  await waitView(page, 'idle');
  const r = await page.request.post('/alerts', {
    headers: { Authorization: 'Bearer alert-token' },
    data: { key: 'ttsfail-1', source: 'calendar', text: 'x' },
  });
  expect(r.status()).toBeLessThan(300);
  try {
    await waitView(page, 'alert');
    await tap(page);
    const l = await waitFor(page, (l) => recv(l, 'error').length > 0, 'error bad_message');
    expect(recv(l, 'error')[0].data).toEqual({ type: 'error', code: 'bad_message' });
    await expect.poll(() => dbg<number>(page, 'effects'), { message: 'beep' }).toBe(1);
    await page.waitForTimeout(500);
    expect(sent(await log(page), 'alert_ack')).toHaveLength(0);
    expect(await dbg(page, 'view')).toBe('alert');
  } finally {
    await page.request.delete('/alerts/ttsfail-1', { headers: { Authorization: 'Bearer alert-token' } });
  }
});
