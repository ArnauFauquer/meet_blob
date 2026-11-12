import { expect, test } from '@playwright/test';
import { openBlob, waitView } from './helpers';

test('production build loads without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(e.message));
  await openBlob(page, 'e2e-pwa');
  await waitView(page, 'idle');
  await page.waitForTimeout(1500);
  expect(errors).toEqual([]);
  expect(page.url()).not.toContain('#t='); // the token left the address bar
  expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length))).toBe(0);
});

test('manifest is valid and the icons exist', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel=manifest]').getAttribute('href');
  const res = await request.get(href!);
  expect(res.ok()).toBe(true);
  const m = await res.json();
  expect(m).toMatchObject({ display: 'fullscreen', start_url: '/', name: 'Blob' });
  expect(m.start_url).not.toContain('t=');
  for (const size of [192, 512]) {
    const icon = m.icons.find((i: { sizes: string }) => i.sizes === `${size}x${size}`);
    expect(icon, `${size} icon`).toBeTruthy();
    const png = await (await request.get(icon.src)).body();
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
  }
});
