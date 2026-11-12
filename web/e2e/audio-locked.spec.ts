import { expect, test } from '@playwright/test';
import { dbg, log, openBlob, sent, tap, waitFor, waitView } from './helpers';

// Headless Chromium ignores --autoplay-policy and starts every AudioContext
// running. To get the state a tablet has after a reboot, the context is
// suspended right after creation; only resume() (called by the page on a tap)
// runs it again.
function lockAudio() {
  const Native = window.AudioContext;
  window.AudioContext = class extends Native {
    constructor(o?: AudioContextOptions) {
      super(o);
      void this.suspend();
    }
  };
}

test('audio locked: the cue shows and the first tap only unlocks audio', async ({ page }) => {
  await page.addInitScript(lockAudio);
  await openBlob(page, 'e2e-locked');
  await waitView(page, 'idle');
  await expect.poll(() => dbg(page, 'audio')).toBe('suspended');
  expect(await dbg(page, 'fault')).toBe('audio_locked');
  await expect(page.locator('#fault')).toContainText('Audio locked');
  await tap(page);
  await expect.poll(() => dbg(page, 'audio')).toBe('running');
  await expect.poll(() => dbg(page, 'fault')).toBeNull();
  await page.waitForTimeout(500);
  expect(sent(await log(page), 'tap')).toHaveLength(0);
  expect(await dbg(page, 'phase')).toBe('idle');
  await tap(page);
  await waitFor(page, (l) => sent(l, 'tap').length === 1, 'second tap starts a turn');
  await waitFor(page, (l) => l.some((e) => e.dir === 'gum'), 'mic opened');
  await tap(page); // finish the turn so the lock is released for the next test
  await waitFor(page, (l) => l.some((e) => e.dir === 'recv' && e.data?.type === 'turn_done'), 'turn_done');
});
