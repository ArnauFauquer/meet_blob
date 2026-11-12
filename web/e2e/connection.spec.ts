import { expect, test } from '@playwright/test';
import { dbg, log, mockOnly, openBlob, recv, sent, waitFor, waitView } from './helpers';

test('bad token: close 4401, fault shown, no retry', async ({ page }) => {
  await openBlob(page, 'e2e-badtoken', 'wrong-token');
  const l = await waitFor(page, (l) => l.some((e) => e.dir === 'close'), 'socket closed');
  expect(l.find((e) => e.dir === 'close')!.code).toBe(4401);
  await expect.poll(() => dbg(page, 'fault')).toBe('bad_token');
  await expect(page.locator('#fault')).toContainText('token');
  await page.waitForTimeout(4000); // longer than the first two backoff steps
  expect((await log(page)).filter((e) => e.dir === 'connect')).toHaveLength(1);
  expect(await dbg(page, 'view')).toBe('offline');
});

test('reconnects after the socket drops', async ({ page }) => {
  mockOnly();
  await openBlob(page, 'drop');
  await waitFor(page, (l) => l.some((e) => e.dir === 'close'), 'socket dropped');
  await expect.poll(() => dbg(page, 'view')).toBe('offline');
  await expect(page.locator('#fault')).toContainText('Offline');
  const l = await waitFor(page, (l) => sent(l, 'hello').length >= 2 && recv(l, 'hello_ok').length >= 2, 'second hello_ok');
  expect(l.filter((e) => e.dir === 'connect')).toHaveLength(2);
  await waitView(page, 'idle');
  expect(await dbg(page, 'fault')).toBeNull();
});

test('hello/hello_ok version mismatch: one reload, then stop with the fault cue', async ({ page }) => {
  mockOnly();
  let loads = 0;
  page.on('load', () => (loads += 1));
  await openBlob(page, 'version');
  await expect.poll(() => dbg(page, 'fault'), { timeout: 20_000 }).toBe('version');
  expect(loads).toBe(2); // the first page plus one reload
  await page.waitForTimeout(3000);
  expect(loads).toBe(2);
  expect((await log(page)).filter((e) => e.dir === 'connect')).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem('blob.reloadedFor'))).toBe('mock-other-version');
});

test('webglcontextlost pauses drawing and recovers on restore', async ({ page }) => {
  await openBlob(page, 'e2e-gl');
  await waitView(page, 'idle');
  await page.evaluate(() => {
    const gl = (document.getElementById('blob') as HTMLCanvasElement).getContext('webgl2')!;
    const ext = gl.getExtension('WEBGL_lose_context')!;
    (window as unknown as { __ext: WEBGL_lose_context }).__ext = ext;
    ext.loseContext();
  });
  await expect.poll(() => dbg(page, 'renderLost')).toBe(true);
  expect(await dbg(page, 'fault')).toBe('render');
  await page.evaluate(() => (window as unknown as { __ext: WEBGL_lose_context }).__ext.restoreContext());
  await expect.poll(() => dbg(page, 'renderLost')).toBe(false);
  expect(await dbg(page, 'fault')).toBeNull();
  const before = await dbg<number>(page, 'frameMs');
  await page.waitForTimeout(1000);
  expect(await dbg<number>(page, 'frameMs')).toBeGreaterThan(0);
  expect(before).toBeGreaterThanOrEqual(0);
});

test('long press opens the diagnostics view without starting a turn; a tap closes it', async ({ page }) => {
  await openBlob(page, 'e2e-diag');
  await waitView(page, 'idle');
  await page.mouse.move(200, 150);
  await page.mouse.down();
  await page.waitForTimeout(900);
  await page.mouse.up();
  const diag = page.locator('#diag');
  await expect(diag).toBeVisible();
  await expect(diag).toContainText('version:');
  await expect(diag).toContainText('socket: open');
  await expect(diag).toContainText('hermes_reachable: true');
  await expect(diag.getByRole('button', { name: 'Copy report' })).toBeVisible();
  expect(sent(await log(page), 'tap')).toHaveLength(0);
  await page.mouse.click(400, 300);
  await expect(diag).toBeHidden();
  expect(sent(await log(page), 'tap')).toHaveLength(0);
});
