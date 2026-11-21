// Adaptive volume (audio/volume.ts) through its debug parameters: the night
// curve (the mock serves a night around now to a device named "night"), the
// debug log of a tap turn, and the gain the reply takes, logged as
// client_event `volume`. The background noise is pinned with ?volume_noise:
// how fast the real estimate (noise.ts, unit-tested) sees the quiet half of
// the fake mic depends on how many audio blocks a slow runner delivers.
import { expect, test } from '@playwright/test';
import { dbg, log, mockOnly, openBlob, sent, tap, waitFor, waitView } from './helpers';

interface VolumeState {
  noise_dbfs: number | null;
  night: number;
  voice_db: number;
  chime_db: number;
}

const volumeEvents = (l: Awaited<ReturnType<typeof log>>) => sent(l, 'client_event').filter((e) => e.data?.kind === 'volume');

test('at night the reply is softer; ?volume=debug logs the estimate and the gain applied', async ({ page }) => {
  mockOnly();
  // a quiet room (below NOISE_QUIET_DBFS): no boost, just the night
  await openBlob(page, 'vol-night', undefined, '?volume=debug&volume_noise=-70');
  await waitView(page, 'idle');
  expect(await dbg<VolumeState>(page, 'volume')).toEqual({ noise_dbfs: -70, night: 1, voice_db: -9, chime_db: -6 });
  await tap(page);
  await waitView(page, 'listening');
  // the first block the mic delivers logs an estimate
  await waitFor(page, (l) => volumeEvents(l).some((e) => e.data?.event === 'estimate'), 'an estimate logged while listening');
  await tap(page);
  const l = await waitFor(page, (l) => volumeEvents(l).some((e) => e.data?.event === 'apply'), 'a gain applied to the reply');
  const apply = volumeEvents(l).find((e) => e.data?.event === 'apply')!.data!;
  expect(apply).toMatchObject({ sound: 'voice', gain_db: -9, night: 1, noise_dbfs: -70 });
});

test('a noisy room raises the volume (?volume_noise), without the debug log', async ({ page }) => {
  await openBlob(page, 'vol-noisy', undefined, '?volume_noise=-20'); // no NIGHT_HOURS: day all day
  await waitView(page, 'idle');
  expect(await dbg<VolumeState>(page, 'volume')).toEqual({ noise_dbfs: -20, night: 0, voice_db: 6, chime_db: 6 });
  expect(volumeEvents(await log(page))).toHaveLength(0);
});
