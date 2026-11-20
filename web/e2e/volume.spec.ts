// Adaptive volume (audio/volume.ts) through its debug parameters: the night
// curve with a pretended clock, the noise estimate from a tap recording, and
// the gain the reply takes, logged as client_event `volume`.
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
  await openBlob(page, 'vol', undefined, '?volume=debug&volume_at=03:00');
  await waitView(page, 'idle');
  expect(await dbg<VolumeState>(page, 'volume')).toEqual({ noise_dbfs: null, night: 1, voice_db: -9, chime_db: -6 });
  await tap(page);
  await waitView(page, 'listening');
  await page.waitForTimeout(2500); // the fake mic: 1 s of tone, 1 s of digital silence
  await tap(page);
  const l = await waitFor(page, (l) => volumeEvents(l).some((e) => e.data?.event === 'apply'), 'a gain applied to the reply');
  const estimates = volumeEvents(l).filter((e) => e.data?.event === 'estimate');
  expect(estimates.length).toBeGreaterThan(0); // heard during the tap recording
  const apply = volumeEvents(l).find((e) => e.data?.event === 'apply')!.data!;
  // the quiet half of the fake mic is the background: no boost, just the night
  expect(apply).toMatchObject({ sound: 'voice', gain_db: -9, night: 1 });
  expect(apply.noise_dbfs as number).toBeLessThan(-60);
});

test('a noisy room raises the volume (?volume_noise), without the debug log', async ({ page }) => {
  await openBlob(page, 'vol-noisy', undefined, '?volume_at=12:00&volume_noise=-20');
  await waitView(page, 'idle');
  expect(await dbg<VolumeState>(page, 'volume')).toEqual({ noise_dbfs: -20, night: 0, voice_db: 6, chime_db: 9 });
  expect(volumeEvents(await log(page))).toHaveLength(0);
});
