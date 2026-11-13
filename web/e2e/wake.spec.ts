// S3: the wake word from a fake microphone playing synthetic Kokoro speech
// ("Hey Blob.", then "What time is it?", then silence, looped), with the trained
// hey_blob model that wake.json selects. Against a real backend the device hf-wake
// needs wake=true in config/devices.json.
import { expect, test } from '@playwright/test';
import { micArgs } from './mics';
import { dbg, openBlob, recv, sent, tracksStopped, waitFor } from './helpers';

test.use({ launchOptions: { args: micArgs('hey-blob') } });

test('wake word: "hey blob" sends wake, the turn listens, the VAD ends it, nothing is sent before', async ({ page }) => {
  test.setTimeout(120_000);
  await openBlob(page, 'hf-wake');
  await expect.poll(() => dbg<{ wakeReady: boolean; vad: boolean }>(page, 'handsFree'), { message: 'models loaded', timeout: 30_000 })
    .toMatchObject({ on: true, wakeReady: true, vad: true });
  let l = await waitFor(page, (l) => sent(l, 'wake').length > 0, 'wake sent');
  const wake = sent(l, 'wake')[0];
  expect(wake.data).toEqual({ type: 'wake', followup: false });
  // nothing reached the server before the wake word: no tap, no utterance, no binary frame
  const before = l.filter((e) => e.t < wake.t && e.dir === 'send');
  expect(before.map((e) => e.data?.type ?? 'binary')).toEqual(expect.not.arrayContaining(['tap', 'utterance', 'binary']));
  expect(before.every((e) => e.data?.binary === undefined)).toBe(true);
  // one shared stream, opened at load, not per turn
  expect(l.filter((e) => e.dir === 'gum')).toHaveLength(1);
  expect((await dbg<{ max: number }>(page, 'handsFree')).max).toBeGreaterThan(0.5);

  await waitFor(page, (l) => recv(l, 'state').some((e) => e.t > wake.t && e.data?.conv === 'listening'), 'listening');
  expect(await dbg(page, 'turnKind')).toBe('wake');
  l = await waitFor(page, (l) => sent(l, 'utterance').length > 0, 'utterance sent by the VAD (no stop tap)');
  const i = l.findIndex((e) => e.dir === 'send' && e.data?.type === 'utterance');
  expect(l[i].data!.dur_ms as number).toBeGreaterThan(300);
  expect(l[i + 1].data!.binary).toBeGreaterThan(0);
  expect(sent(l, 'tap')).toHaveLength(0);
  await waitFor(page, (l) => recv(l, 'turn_done').length > 0, 'turn_done');
  expect(await tracksStopped(page)).toBe(false); // the shared stream stays open for the wake word

  // the wake log: the gate opened, the attempt's peak fired, the gate closed for the turn, the turn says how it started
  const ev = (await waitFor(page, (l) => sent(l, 'client_event').some((e) => e.data?.kind === 'turn_start'), 'turn_start'))
    .filter((e) => e.dir === 'send' && e.data?.type === 'client_event')
    .map((e) => e.data!);
  expect(ev).toContainEqual(expect.objectContaining({ kind: 'wake_gate', on: true, why: 'open' }));
  expect(ev).toContainEqual(expect.objectContaining({ kind: 'wake_peak', fired: true }));
  expect(ev).toContainEqual(expect.objectContaining({ kind: 'wake_gate', on: false, why: 'turn' }));
  expect(ev).toContainEqual(expect.objectContaining({ kind: 'turn_start', turn: expect.any(Number), how: 'wake' }));
});
