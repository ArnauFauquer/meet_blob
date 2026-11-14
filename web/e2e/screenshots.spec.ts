// Renders the five states and the alert shapes through real flows against the
// mock backend and writes docs/screenshots/<name>-<w>x<h>.png, plus the PWA icons.
// Run: npm run screenshots (SwiftShader software GL: slow, about a minute).
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { alertSource, dbg, openBlob, shape, tap, waitView } from './helpers';

const OUT = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));
const ICONS = fileURLToPath(new URL('../public/icons/', import.meta.url));

// Software GL is slow enough that the page would step its quality down;
// the screenshots show the default (full) quality.
const fullQuality = (page: Page) =>
  page.evaluate(() => (window as unknown as { blobDebug: { setQuality(q: number): void } }).blobDebug.setQuality(2));

async function shot(page: Page, view: string, name: string, settleMs: number) {
  await waitView(page, view);
  await page.waitForTimeout(settleMs); // let the colour crossfade finish
  expect(await dbg(page, 'view'), `${name} still in ${view} before the capture`).toBe(view);
  await page.screenshot({ path: `${OUT}${name}.png` });
}

for (const [w, h] of [
  [1280, 800],
  [1024, 768],
]) {
  test(`states at ${w}x${h}`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: w, height: h });
    await openBlob(page, 'slow'); // 5 s of thinking
    await waitView(page, 'idle');
    await fullQuality(page); // before the page measures itself slow: no shader rebuild later
    await shot(page, 'idle', `idle-${w}x${h}`, 3000);
    // The idle clock, 5 minutes later. It shows the time of the run.
    await page.evaluate(() => (window as unknown as { blobDebug: { idleFor(ms: number): void } }).blobDebug.idleFor(5 * 60_000));
    await shot(page, 'idle', `clock-${w}x${h}`, 3000);
    await tap(page);
    await shot(page, 'listening', `listening-${w}x${h}`, 2500);
    await tap(page);
    await shot(page, 'thinking', `thinking-${w}x${h}`, 2200);
    await shot(page, 'speaking', `speaking-${w}x${h}`, 900);
    await waitView(page, 'idle');
    await page.goto('about:blank'); // a hash-only change would not reload the page
    await openBlob(page, 'hermes_fail');
    await waitView(page, 'idle');
    await fullQuality(page);
    await tap(page);
    await waitView(page, 'listening');
    await page.waitForTimeout(800);
    await tap(page);
    await shot(page, 'error', `error-${w}x${h}`, 800);
  });
}

test('PWA icons from the idle blob', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 512, height: 512 });
  await openBlob(page, 'e2e-icon');
  await waitView(page, 'idle');
  await fullQuality(page);
  await page.waitForTimeout(3000);
  const src = `${OUT}../../web/node_modules/.cache/blob-e2e/icon-src.png`;
  await page.screenshot({ path: src });
  // Crop to the blob so it fills most of the icon, then scale.
  for (const size of [192, 512]) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', `crop=380:380,scale=${size}:${size}:flags=lanczos`, `${ICONS}icon-${size}.png`]);
  }
});

test('alert shapes and a morph at 1280x800', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const alerts = alertSource(request);
  const settled = (id: number) =>
    expect.poll(async () => { const s = await shape(page); return s?.a === id && s.mix === 0; }, { timeout: 20_000 }).toBe(true);
  try {
    await openBlob(page, 'e2e-shots');
    await waitView(page, 'idle');
    const timer = await alerts.post('timer', { source: 'timer', urgency: 'info', text: 'Timer.' });
    await settled(1);
    await shot(page, 'alert', 'alert-timer-info-1280x800', 3000);
    await alerts.post('timer', { source: 'timer', urgency: 'urgent', text: 'Timer, urgent.' }, timer);
    await shot(page, 'alert', 'alert-timer-urgent-1280x800', 3000);
    await alerts.post('calendar', { source: 'calendar', urgency: 'info', text: 'Calendar.' });
    await alerts.del(timer); // the calendar alert is now on top: triangle to square
    await expect.poll(async () => { const s = await shape(page); return !!s && s.b === 2 && s.mix > 0.3 && s.mix < 0.7; }, { timeout: 10_000, intervals: [20] }).toBe(true);
    await page.evaluate(() => (window as unknown as { blobDebug: { freeze(): void } }).blobDebug.freeze());
    const mid = await shape(page);
    await page.screenshot({ path: `${OUT}alert-morph-1280x800.png` });
    console.log(`morph frame: uMix=${mid?.mix.toFixed(2)} shapes ${mid?.a} -> ${mid?.b}`);
    await page.goto('about:blank');
    await openBlob(page, 'e2e-shots');
    await settled(2);
    await shot(page, 'alert', 'alert-calendar-info-1280x800', 3000);
  } finally {
    await alerts.cleanup();
  }
});
