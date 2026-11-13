// S3: the voice-activity detector ends a tap turn after silence on a hands-free
// device (fake mic: synthetic Kokoro question, then 4 s of silence, looped).
// Against a real backend the device hf-vad needs wake=true in config/devices.json.
import { expect, test } from '@playwright/test';
import { micArgs } from './mics';
import { dbg, openBlob, recv, sent, tap, waitFor, waitView } from './helpers';

test.use({ launchOptions: { args: micArgs('question') } });

test('VAD: a tap turn ends by itself 0.6 to 0.8 s after the speech stops', async ({ page }) => {
  test.setTimeout(120_000);
  await openBlob(page, 'hf-vad');
  await expect.poll(() => dbg<{ vad: boolean }>(page, 'handsFree'), { message: 'VAD loaded', timeout: 30_000 }).toMatchObject({ vad: true });
  await waitView(page, 'idle');
  await tap(page);
  let l = await waitFor(page, (l) => recv(l, 'state').some((e) => e.data?.conv === 'listening'), 'listening');
  const listenAt = recv(l, 'state').find((e) => e.data?.conv === 'listening')!.t;
  l = await waitFor(page, (l) => sent(l, 'utterance').length > 0, 'utterance sent without a stop tap');
  const i = l.findIndex((e) => e.dir === 'send' && e.data?.type === 'utterance');
  const u = l[i].data!;
  expect(sent(l, 'tap')).toHaveLength(1);
  expect(u.dur_ms as number).toBeGreaterThan(800); // the question is in it
  expect(l[i + 1].data!.binary).toBeGreaterThan(0);
  // the clip's silence is digital zero, so tail_silence_ms is the time the VAD waited
  expect(u.tail_silence_ms as number).toBeGreaterThanOrEqual(500);
  expect(u.tail_silence_ms as number).toBeLessThan(1500);
  expect(l[i].t - listenAt).toBeLessThan(8000); // before the no-speech limit
});
