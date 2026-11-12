import { expect, test } from '@playwright/test';
import { dbg, log, mockOnly, openBlob, recv, sent, speak, tap, tracksStopped, waitFor, waitView } from './helpers';

test('normal turn: mic after the state, utterance + PCM, reply plays, back to idle', async ({ page }) => {
  await openBlob(page, 'e2e-normal');
  await waitView(page, 'idle');
  await tap(page);
  let l = await waitFor(page, (l) => l.some((e) => e.dir === 'gum'), 'mic opened');
  const tapAt = sent(l, 'tap')[0].t;
  const stateAt = recv(l, 'state').find((e) => e.data?.conv === 'listening' && e.data?.turn != null);
  const gumAt = l.find((e) => e.dir === 'gum')!.t;
  expect(stateAt, 'state listening with a turn id').toBeTruthy();
  expect(gumAt).toBeGreaterThan(stateAt!.t); // never before the state
  expect(stateAt!.t).toBeGreaterThan(tapAt);
  await waitView(page, 'listening');

  await page.waitForTimeout(2000);
  const stopAt = Date.now();
  await tap(page);
  l = await waitFor(page, (l) => sent(l, 'utterance').length > 0, 'utterance sent');
  const i = l.findIndex((e) => e.dir === 'send' && e.data?.type === 'utterance');
  const u = l[i].data!;
  const frame = l[i + 1];
  expect(u).toMatchObject({ turn: stateAt!.data!.turn, format: 'pcm_s16le', rate: 16000 });
  const dur = u.dur_ms as number;
  const tail = u.tail_silence_ms as number;
  // the mic opened after the first tap and recorded until the second (about 2 s)
  expect(dur).toBeGreaterThan(1200);
  expect(dur).toBeLessThan(4000);
  expect(tail).toBeGreaterThanOrEqual(0);
  expect(tail).toBeLessThanOrEqual(dur);
  expect(frame.dir).toBe('send');
  expect(frame.data!.binary).toBeDefined();
  expect(Math.abs(frame.data!.binary! / 32 - dur)).toBeLessThanOrEqual(1); // 16 kHz s16 = 32 bytes per ms
  expect(frame.data!.rms).toBeGreaterThan(0.01); // the fake mic signal is in it
  expect(Date.now() - stopAt).toBeLessThan(10_000);
  expect(await tracksStopped(page)).toBe(true);

  // reply: tts header + WAV frame, played on the AudioContext
  l = await waitFor(page, (l) => recv(l, 'turn_done').length > 0, 'turn_done');
  const tts = l.findIndex((e) => e.dir === 'recv' && e.data?.type === 'tts');
  expect(tts).toBeGreaterThan(-1);
  expect(l[tts + 1].data!.binary).toBeGreaterThan(44);
  expect(recv(l, 'turn_done')[0].data).toMatchObject({ reason: 'ok' });
  await expect.poll(() => dbg<number>(page, 'started')).toBeGreaterThan(0);
  expect(await dbg(page, 'audio')).toBe('running');
  await waitView(page, 'speaking');
  await expect.poll(() => dbg<number>(page, 'maxLevel'), { message: 'playback level uniform moved' }).toBeGreaterThan(0.05);
  await waitView(page, 'idle');
  expect(await tracksStopped(page)).toBe(true);
});

test('tap during speaking stops the audio and sends cancel', async ({ page }) => {
  await openBlob(page, 'e2e-speaking-tap');
  const turn = await speak(page);
  await expect.poll(() => dbg(page, 'playing'), { message: 'reply playing' }).toBe(true);
  await tap(page);
  const l = await waitFor(page, (l) => sent(l, 'cancel').length > 0, 'cancel sent');
  expect(sent(l, 'cancel')[0].data).toEqual({ type: 'cancel', turn });
  expect(await dbg(page, 'playing')).toBe(false);
  await waitView(page, 'idle');
  expect(await tracksStopped(page)).toBe(true);
});

test('tap during thinking sends cancel and the turn ends cancel', async ({ page }) => {
  mockOnly();
  await openBlob(page, 'slow');
  const turn = await speak(page);
  await waitView(page, 'thinking');
  await tap(page);
  const l = await waitFor(page, (l) => recv(l, 'turn_done').length > 0, 'turn_done');
  expect(sent(l, 'cancel')[0].data).toEqual({ type: 'cancel', turn });
  expect(recv(l, 'turn_done')[0].data).toMatchObject({ turn, reason: 'cancel' });
  await waitView(page, 'idle');
  await page.waitForTimeout(500);
  expect(await dbg(page, 'started')).toBe(0); // nothing played
  expect(await tracksStopped(page)).toBe(true);
});

test('empty: no overlay, back to idle', async ({ page }) => {
  mockOnly();
  await openBlob(page, 'empty');
  await speak(page);
  const l = await waitFor(page, (l) => recv(l, 'turn_done').length > 0, 'turn_done');
  expect(recv(l, 'turn_done')[0].data).toMatchObject({ reason: 'empty' });
  await waitView(page, 'idle');
  for (let i = 0; i < 5; i++) {
    expect(await dbg(page, 'view')).toBe('idle');
    await page.waitForTimeout(200);
  }
  expect(await tracksStopped(page)).toBe(true);
});

test('hermes_fail: fallback line plays under the grey overlay; a tap stops it without cancel', async ({ page }) => {
  mockOnly();
  await openBlob(page, 'hermes_fail');
  await speak(page);
  const l = await waitFor(page, (l) => recv(l, 'turn_done').length > 0, 'turn_done');
  expect(recv(l, 'tts')).toHaveLength(1);
  expect(recv(l, 'turn_done')[0].data).toMatchObject({ reason: 'hermes_fail' });
  await waitView(page, 'error');
  await expect.poll(() => dbg(page, 'playing')).toBe(true);
  await tap(page);
  expect(await dbg(page, 'playing')).toBe(false);
  await page.waitForTimeout(300);
  expect(sent(await log(page), 'cancel')).toHaveLength(0);
  expect(sent(await log(page), 'tap')).toHaveLength(1);
  // the overlay clears 3 s after it was set
  await waitView(page, 'idle');
});

test('tts_fail: local beep and grey overlay, then idle', async ({ page }) => {
  mockOnly();
  await openBlob(page, 'tts_fail');
  await speak(page);
  const l = await waitFor(page, (l) => recv(l, 'turn_done').length > 0, 'turn_done');
  expect(recv(l, 'tts')).toHaveLength(0);
  expect(recv(l, 'turn_done')[0].data).toMatchObject({ reason: 'tts_fail' });
  await waitView(page, 'error');
  await expect.poll(() => dbg<number>(page, 'started'), { message: 'beep played' }).toBe(1);
  const t0 = Date.now();
  await waitView(page, 'idle');
  expect(Date.now() - t0).toBeGreaterThan(1500); // held for about 3 s
});

test('busy: a second device tapping during a turn gets busy and opens no mic', async ({ browser }) => {
  const a = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  const b = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  await openBlob(a, 'e2e-busy-a');
  await openBlob(b, 'e2e-busy-b');
  await waitView(a, 'idle');
  await waitView(b, 'idle');
  await tap(a);
  await waitFor(a, (l) => l.some((e) => e.dir === 'gum'), 'A mic opened');
  await waitView(b, 'listening'); // B mirrors the state
  await tap(b);
  const lb = await waitFor(b, (l) => recv(l, 'error').length > 0, 'B got an error');
  expect(recv(lb, 'error')[0].data).toEqual({ type: 'error', code: 'busy' });
  expect(lb.some((e) => e.dir === 'gum')).toBe(false);
  expect(await dbg(b, 'phase')).toBe('idle');
  // A finishes normally
  await tap(a);
  await waitFor(a, (l) => recv(l, 'turn_done').length > 0, 'A turn_done');
  await waitView(a, 'idle');
  await a.context().close();
  await b.context().close();
});

test('not_ready: grey blob, no mic', async ({ page }) => {
  mockOnly();
  await openBlob(page, 'not_ready');
  await waitView(page, 'idle');
  await tap(page);
  const l = await waitFor(page, (l) => recv(l, 'error').length > 0, 'error');
  expect(recv(l, 'error')[0].data).toEqual({ type: 'error', code: 'not_ready' });
  await waitView(page, 'error');
  expect(l.some((e) => e.dir === 'gum')).toBe(false);
  await waitView(page, 'idle');
});
