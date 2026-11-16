// Film strips: the motion of idle, listening and speaking as contact sheets.
// The debug clock (blobDebug.freeze / step) advances the animation in fixed
// 1/30 s steps, so the sheets are the same on every run and every machine.
// Writes docs/screenshots/motion/<state>.png and prints the per-frame cost.
// Run: npm run screenshots (with the state screenshots) or
//      npx vite build && SCREENSHOTS=1 npx playwright test e2e/motion.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openBlob, waitView } from './helpers';

const OUT = fileURLToPath(new URL('../../docs/screenshots/motion/', import.meta.url));
const STEP_S = 1 / 30;
const FRAMES = 12;
const EVERY = 15; // one frame each 0.5 s: 12 frames over 6 s

// Speech-like level, 0..1: phrases of about 1.7 s with 0.6 s pauses,
// syllables near 4.7 Hz with uneven stress. Deterministic in t.
export function speechLevel(t: number): number {
  const ph = t % 2.3;
  if (ph > 1.7) return 0;
  const edge = Math.min(1, ph / 0.15, (1.7 - ph) / 0.2);
  const syl = 0.5 - 0.5 * Math.cos(2 * Math.PI * 4.7 * t);
  const stress = 0.6 + 0.4 * Math.sin(t * 2.9 + 1.3) * Math.sin(t * 1.1 + 0.4);
  return Math.max(0, Math.min(1, 0.85 * edge * syl * stress));
}

// Extra input for a sheet: the clock time, the alert, a view to start from
// (a morph strip starts in `from` and switches to `view` at t=0) and the
// number of 1/30 s steps per frame.
interface SheetOpts {
  clock?: string;
  alert?: { source: string; urgency: 'info' | 'urgent' };
  from?: string;
  every?: number;
  wide?: boolean; // 16:9 tiles, for the clock
}

async function sheet(page: Page, view: string, speech: boolean, name = view, dim = 1, o: SheetOpts = {}): Promise<void> {
  const png = await page.evaluate(
    async ({ view, speech, frames, every, step, levelSrc, dim, o }) => {
      const level = new Function(`return (${levelSrc})`)() as (t: number) => number;
      const d = (window as unknown as { blobDebug: Record<string, (...a: unknown[]) => void> }).blobDebug;
      const canvas = document.getElementById('blob') as HTMLCanvasElement;
      d.setDim(dim);
      d.freeze(o.from ?? view, o.clock, o.alert);
      const side = Math.round(canvas.height * 0.92);
      const aspect = o.wide ? 16 / 9 : 1;
      const tile = 260;
      const tileW = Math.round(tile * aspect);
      const cols = o.wide ? 4 : 6;
      const out = document.createElement('canvas');
      out.width = cols * tileW;
      out.height = Math.ceil(frames / cols) * tile;
      const g = out.getContext('2d')!;
      g.fillStyle = '#000';
      g.fillRect(0, 0, out.width, out.height);
      g.font = '13px monospace';
      let t = 0;
      for (let f = 0; f < frames; f++) {
        for (let i = 0; i < every; i++) {
          t += step;
          d.step(step, view, speech ? level(t) : 0, i === every - 1, o.clock, o.alert);
        }
        // Read the canvas in the same task as the draw (no preserveDrawingBuffer needed).
        const x = (f % cols) * tileW;
        const y = Math.floor(f / cols) * tile;
        const sw = Math.min(canvas.width, side * aspect);
        const sh = sw / aspect;
        g.drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh, x, y, tileW, tile);
        g.fillStyle = 'rgba(255,255,255,0.55)';
        g.fillText(`${view} t=${t.toFixed(1)}s${speech ? ` lvl=${level(t).toFixed(2)}` : ''}${dim < 1 ? ` dim=${dim}` : ''}`, x + 6, y + 16);
      }
      return out.toDataURL('image/png');
    },
    { view, speech, frames: FRAMES, every: o.every ?? EVERY, step: STEP_S, levelSrc: speechLevel.toString(), dim, o },
  );
  writeFileSync(`${OUT}${name}.png`, Buffer.from(png.split(',')[1], 'base64'));
}

// Milliseconds per drawn frame, synchronised with a 1-pixel readback. The
// fastest of n frames: other processes only ever add time, so the minimum is
// the steadiest figure on a shared machine.
async function frameCost(page: Page, view: string, level: number, n = 20): Promise<number> {
  return page.evaluate(
    ({ view, level, n }) => {
      const d = (window as unknown as { blobDebug: Record<string, (...a: unknown[]) => void> }).blobDebug;
      const gl = (document.getElementById('blob') as HTMLCanvasElement).getContext('webgl2')!;
      const px = new Uint8Array(4);
      d.freeze(view);
      d.step(1 / 30, view, level, true);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // warm-up and shader compile
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        d.step(1 / 30, view, level, true);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        ms.push(performance.now() - t0);
      }
      return Math.min(...ms);
    },
    { view, level, n },
  );
}

test('motion contact sheets', async ({ page }) => {
  test.setTimeout(240_000);
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 800, height: 600 });
  await openBlob(page, 'e2e-motion');
  await waitView(page, 'idle');
  await page.evaluate(() => (window as unknown as { blobDebug: { setQuality(q: number): void } }).blobDebug.setQuality(2));
  await sheet(page, 'idle', false);
  await sheet(page, 'listening', true);
  await sheet(page, 'speaking', true);
  await sheet(page, 'thinking', false);
  await sheet(page, 'error', false);
  await sheet(page, 'idle', false, 'idle-night-dim0.35', 0.35); // night dimming hook
  const timer = { source: 'timer', urgency: 'info' } as const;
  await sheet(page, 'idle', false, 'clock', 1, { clock: '2026-01-01T09:41', wide: true });
  await sheet(page, 'alert', false, 'alert-timer-info', 1, { alert: timer });
  await sheet(page, 'alert', false, 'alert-square-urgent', 1, { alert: { source: 'calendar', urgency: 'urgent' } });
  // The morph from the blob to the timer triangle: hop, twirl, landing jiggle, 0.1 s apart.
  await sheet(page, 'alert', false, 'morph-to-triangle', 1, { alert: timer, from: 'idle', every: 3 });
  await sheet(page, 'idle', false, 'morph-to-clock', 1, { clock: '2026-01-01T09:41', from: 'listening', every: 3, wide: true });
  expect(await page.evaluate(() => (window as unknown as { blobDebug: { quality: number } }).blobDebug.quality)).toBe(2);
});

test('frame cost at 1280x800 (SwiftShader, compare ratios only)', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await openBlob(page, 'e2e-cost');
  await waitView(page, 'idle');
  const rows: string[] = [];
  for (const q of [2, 1, 0]) {
    await page.evaluate((q) => (window as unknown as { blobDebug: { setQuality(q: number): void } }).blobDebug.setQuality(q), q);
    const idle = await frameCost(page, 'idle', 0);
    const listening = await frameCost(page, 'listening', 0.7);
    rows.push(`quality ${q}: idle ${idle.toFixed(1)} ms, listening(level 0.7) ${listening.toFixed(1)} ms`);
  }
  console.log(`frame cost per drawn frame:\n${rows.join('\n')}`);
});
