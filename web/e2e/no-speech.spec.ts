// S3: no-speech limits with a silent fake microphone on hands-free devices.
// Against a real backend: hf-quiet needs wake=true in config/devices.json; the
// follow-up flow needs the mock (its reply carries followup=true) and is mock-only.
import { expect, test } from '@playwright/test';
import { micArgs } from './mics';
import { dbg, log, mockOnly, openBlob, recv, sent, tap, waitFor, waitView } from './helpers';

test.use({ launchOptions: { args: micArgs('silence') } });

async function ready(page: import('@playwright/test').Page, device: string) {
  await openBlob(page, device);
  await expect.poll(() => dbg<{ vad: boolean }>(page, 'handsFree'), { message: 'VAD loaded', timeout: 30_000 }).toMatchObject({ vad: true });
  await waitView(page, 'idle');
}

test('no speech within listen_no_speech_s (8 s): zero-length utterance, no binary frame, turn ends empty', async ({ page }) => {
  test.setTimeout(60_000);
  await ready(page, 'hf-quiet');
  await tap(page);
  let l = await waitFor(page, (l) => recv(l, 'state').some((e) => e.data?.conv === 'listening'), 'listening');
  const listenAt = recv(l, 'state').find((e) => e.data?.conv === 'listening')!.t;
  l = await waitFor(page, (l) => sent(l, 'utterance').length > 0, 'zero-length utterance');
  const i = l.findIndex((e) => e.dir === 'send' && e.data?.type === 'utterance');
  expect(l[i].data).toMatchObject({ dur_ms: 0, tail_silence_ms: 0, format: 'pcm_s16le', rate: 16000 });
  expect(l[i + 1]?.data?.binary).toBeUndefined();
  const waited = l[i].t - listenAt;
  expect(waited).toBeGreaterThan(7500);
  expect(waited).toBeLessThan(9500);
  l = await waitFor(page, (l) => recv(l, 'turn_done').length > 0, 'turn_done');
  expect(recv(l, 'turn_done')[0].data).toMatchObject({ reason: 'empty' });
  await waitView(page, 'idle');
});

test('follow-up: after a reply with followup=true the page sends wake{followup:true} and listens 6 s (mock)', async ({ page }) => {
  mockOnly();
  test.setTimeout(60_000);
  await ready(page, 'hf-followup');
  await tap(page);
  await waitFor(page, (l) => recv(l, 'state').some((e) => e.data?.conv === 'listening'), 'listening');
  await page.waitForTimeout(1000);
  await tap(page); // stop tap: the mock answers any audio with a question
  let l = await waitFor(page, (l) => recv(l, 'tts').some((e) => e.data?.followup === true), 'tts with followup');
  const ttsAt = recv(l, 'tts')[0].t;
  l = await waitFor(page, (l) => sent(l, 'wake').length > 0, 'wake{followup:true}');
  const wake = sent(l, 'wake')[0];
  expect(wake.data).toEqual({ type: 'wake', followup: true });
  expect(wake.t - ttsAt).toBeGreaterThan(2000); // after the 2.7 s reply finished playing
  expect(sent(l, 'tap')).toHaveLength(1); // no tap and no wake word for the follow-up
  l = await waitFor(page, (l) => recv(l, 'state').some((e) => e.t > wake.t && e.data?.conv === 'listening'), 'follow-up listening');
  const listenAt = recv(l, 'state').find((e) => e.t > wake.t && e.data?.conv === 'listening')!.t;
  expect(await dbg(page, 'turnKind')).toBe('followup');
  l = await waitFor(page, (l) => sent(l, 'utterance').some((e) => e.t > wake.t), 'zero-length utterance after 6 s');
  const u = sent(l, 'utterance').find((e) => e.t > wake.t)!;
  expect(u.data).toMatchObject({ dur_ms: 0 });
  expect(u.t - listenAt).toBeGreaterThan(5500);
  expect(u.t - listenAt).toBeLessThan(7500);
  await waitFor(page, (l) => recv(l, 'turn_done').filter((e) => e.data?.reason === 'empty').length > 0, 'turn_done empty');
  await waitView(page, 'idle');
  // the follow-up reply carried no followup (one per reply in the mock): no further wake
  await page.waitForTimeout(1500);
  expect(sent(await log(page), 'wake')).toHaveLength(1);
});
