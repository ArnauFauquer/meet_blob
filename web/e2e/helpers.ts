import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

export const TOKEN = process.env.BLOB_TOKEN ?? 'test-token';
export const external = !!process.env.BLOB_URL;

// Tests whose flow needs the mock's scenarios (picked by device name).
export function mockOnly(): void {
  test.skip(external && !process.env.BLOB_SCENARIOS, 'needs the mock backend scenarios');
}

export interface LogEntry {
  t: number;
  dir: 'send' | 'recv' | 'close' | 'connect' | 'gum';
  data?: { type?: string; binary?: number; rms?: number; [k: string]: unknown };
  code?: number;
}

// Records every WebSocket frame, close and getUserMedia call in the page, with
// timestamps, and keeps the mic tracks so the test can check they were stopped.
// Only protocol-visible behaviour, so the same tests run against a real backend.
function instrument() {
  const w = window as unknown as { __log: unknown[]; __tracks: MediaStreamTrack[] };
  w.__log = [];
  w.__tracks = [];
  const log = (e: object) => w.__log.push({ t: performance.now(), ...e });
  const decode = (d: unknown) => {
    if (typeof d === 'string') return JSON.parse(d);
    const buf = d instanceof ArrayBuffer ? d : (d as ArrayBufferView).buffer;
    const s = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
    let sum = 0;
    for (const v of s) sum += (v / 32768) ** 2;
    return { binary: buf.byteLength, rms: s.length ? Math.sqrt(sum / s.length) : 0 };
  };
  const Native = window.WebSocket;
  class Logged extends Native {
    constructor(url: string | URL, p?: string | string[]) {
      super(url, p);
      log({ dir: 'connect' });
      this.addEventListener('message', (ev) => log({ dir: 'recv', data: decode(ev.data) }));
      this.addEventListener('close', (ev) => log({ dir: 'close', code: ev.code }));
    }
    send(d: string | BufferSource | Blob) {
      log({ dir: 'send', data: decode(d) });
      super.send(d);
    }
  }
  window.WebSocket = Logged;
  const md = navigator.mediaDevices;
  const gum = md.getUserMedia.bind(md);
  md.getUserMedia = async (c) => {
    log({ dir: 'gum' });
    const s = await gum(c);
    w.__tracks.push(...s.getTracks());
    return s;
  };
}

export async function openBlob(page: Page, device: string, token = TOKEN): Promise<void> {
  await page.addInitScript(instrument);
  await page.goto(`/#t=${encodeURIComponent(token)}&device=${encodeURIComponent(device)}`);
}

export const log = (page: Page) => page.evaluate(() => (window as unknown as { __log: LogEntry[] }).__log);
// Reads a blobDebug field; undefined while the page is (re)loading.
export const dbg = <T = unknown>(page: Page, key: string) =>
  page
    .evaluate((k) => (window as unknown as { blobDebug?: Record<string, unknown> }).blobDebug?.[k], key)
    .catch(() => undefined) as Promise<T>;

export async function waitView(page: Page, view: string): Promise<void> {
  await expect.poll(() => dbg(page, 'view'), { message: `view ${view}` }).toBe(view);
}

export async function waitFor(page: Page, pred: (l: LogEntry[]) => boolean, message: string): Promise<LogEntry[]> {
  let last: LogEntry[] = [];
  await expect
    .poll(
      async () => {
        last = await log(page);
        return pred(last);
      },
      { message },
    )
    .toBe(true);
  return last;
}

export const sent = (l: LogEntry[], type: string) => l.filter((e) => e.dir === 'send' && e.data?.type === type);
export const recv = (l: LogEntry[], type: string) => l.filter((e) => e.dir === 'recv' && e.data?.type === type);

export async function tap(page: Page): Promise<void> {
  const v = page.viewportSize() ?? { width: 400, height: 300 };
  await page.mouse.click(v.width / 2, v.height / 2);
}

export async function tracksStopped(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks.every((t) => t.readyState === 'ended'),
  );
}

// tap -> listening (mic opened) -> wait -> tap -> utterance sent. Returns the turn id.
export async function speak(page: Page, ms = 1500): Promise<number> {
  await waitView(page, 'idle');
  await tap(page);
  const l = await waitFor(page, (l) => l.some((e) => e.dir === 'gum'), 'mic opened');
  const st = recv(l, 'state').find((e) => e.data?.conv === 'listening' && e.data?.turn != null);
  await page.waitForTimeout(ms);
  await tap(page);
  await waitFor(page, (l) => sent(l, 'utterance').length > 0, 'utterance sent');
  return st!.data!.turn as number;
}

// Alerts (S4): POST /alerts needs ALERT_TOKEN. The mock's is fixed; a real
// backend needs BLOB_ALERT_TOKEN, else the alert flows are skipped.
export const ALERT_TOKEN = process.env.BLOB_ALERT_TOKEN ?? (external ? '' : 'alert-token');

export function needsAlerts(): void {
  test.skip(!ALERT_TOKEN, 'set BLOB_ALERT_TOKEN to run the alert flows against a real backend');
}

// Creates alerts with unique keys and deletes them all in cleanup().
export function alertSource(request: APIRequestContext) {
  const keys: string[] = [];
  const headers = { Authorization: `Bearer ${ALERT_TOKEN}` };
  return {
    // `name` becomes a unique key, unless `key` is given (an update of that alert).
    async post(name: string, body: { source: string; urgency?: 'info' | 'urgent'; text?: string }, key = `e2e-${name}-${Date.now()}`): Promise<string> {
      const r = await request.post('/alerts', { headers, data: { key, text: `Alert ${name}.`, lang: 'en', ...body } });
      expect(r.status(), `POST /alerts ${key}`).toBeLessThan(300);
      keys.push(key);
      return key;
    },
    async del(key: string): Promise<void> {
      expect((await request.delete(`/alerts/${key}`, { headers })).status()).toBe(204);
    },
    async cleanup(): Promise<void> {
      for (const k of keys) await request.delete(`/alerts/${k}`, { headers });
    },
  };
}

export interface ShapeUniforms {
  a: number;
  b: number;
  mix: number;
  color: [number, number, number];
}
export const shape = (page: Page) => dbg<ShapeUniforms | null>(page, 'shape');
