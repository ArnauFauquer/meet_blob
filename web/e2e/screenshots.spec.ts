// Renders the five states through real flows against the mock backend and
// writes docs/screenshots/<state>-<w>x<h>.png, plus the PWA icons.
// Run: npm run screenshots (SwiftShader software GL: slow, about a minute).
import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dbg, openBlob, tap, waitView } from './helpers';

const OUT = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));
const ICONS = fileURLToPath(new URL('../public/icons/', import.meta.url));

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
    await shot(page, 'idle', `idle-${w}x${h}`, 3000);
    await tap(page);
    await shot(page, 'listening', `listening-${w}x${h}`, 2500);
    await tap(page);
    await shot(page, 'thinking', `thinking-${w}x${h}`, 2200);
    await shot(page, 'speaking', `speaking-${w}x${h}`, 900);
    await waitView(page, 'idle');
    await page.goto('about:blank'); // a hash-only change would not reload the page
    await openBlob(page, 'hermes_fail');
    await waitView(page, 'idle');
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
  await page.waitForTimeout(3000);
  const src = `${OUT}../../web/node_modules/.cache/blob-e2e/icon-src.png`;
  await page.screenshot({ path: src });
  // Crop to the blob so it fills most of the icon, then scale.
  for (const size of [192, 512]) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', `crop=380:380,scale=${size}:${size}:flags=lanczos`, `${ICONS}icon-${size}.png`]);
  }
});
