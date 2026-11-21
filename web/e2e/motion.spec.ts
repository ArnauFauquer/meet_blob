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
  act?: string; // an act to start at t=0 (ACTS in render/acts.ts)
  frames?: number;
  sleep?: boolean; // night mode: the sleeping blob
  // Source of a function of t that overrides the view and alert, and gives the
  // pending timers and fired alert keys (the timer droplets).
  script?: string;
}

interface Scripted {
  view?: string;
  alert?: { source: string; urgency: 'info' | 'urgent' };
  timers?: { key: string; left_s: number }[];
  fired?: string[];
}

async function sheet(page: Page, view: string, speech: boolean, name = view, dim = 1, o: SheetOpts = {}): Promise<void> {
  const png = await page.evaluate(
    async ({ view, speech, frames, every, step, levelSrc, dim, o }) => {
      const level = new Function(`return (${levelSrc})`)() as (t: number) => number;
      const script = o.script ? (new Function(`return (${o.script})`)() as (t: number) => Scripted) : null;
      const d = (window as unknown as { blobDebug: Record<string, (...a: unknown[]) => void> }).blobDebug;
      const canvas = document.getElementById('blob') as HTMLCanvasElement;
      d.setDim(dim);
      d.freeze(o.from ?? view, o.clock, o.alert, undefined, o.sleep);
      if (o.act) d.act(o.act);
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
          const sc = script?.(t);
          d.step(step, sc?.view ?? view, speech ? level(t) : 0, i === every - 1, o.clock, sc?.alert ?? o.alert, undefined, o.sleep, sc?.timers, sc?.fired);
        }
        // Read the canvas in the same task as the draw (no preserveDrawingBuffer needed).
        const x = (f % cols) * tileW;
        const y = Math.floor(f / cols) * tile;
        const sw = Math.min(canvas.width, side * aspect);
        const sh = sw / aspect;
        g.drawImage(canvas, (canvas.width - sw) / 2, (canvas.height - sh) / 2, sw, sh, x, y, tileW, tile);
        g.fillStyle = 'rgba(255,255,255,0.55)';
        g.fillText(`${script?.(t).view ?? view} t=${t.toFixed(1)}s${speech ? ` lvl=${level(t).toFixed(2)}` : ''}${dim < 1 ? ` dim=${dim}` : ''}`, x + 6, y + 16);
      }
      return out.toDataURL('image/png');
    },
    { view, speech, frames: o.frames ?? FRAMES, every: o.every ?? EVERY, step: STEP_S, levelSrc: speechLevel.toString(), dim, o },
  );
  writeFileSync(`${OUT}${name}.png`, Buffer.from(png.split(',')[1], 'base64'));
}

// Milliseconds per drawn frame, synchronised with a 1-pixel readback. The
// fastest of n frames: other processes only ever add time, so the minimum is
// the steadiest figure on a shared machine.
async function frameCost(page: Page, view: string, level: number, n = 20, timers?: Scripted['timers']): Promise<number> {
  return page.evaluate(
    ({ view, level, n, timers }) => {
      const d = (window as unknown as { blobDebug: Record<string, (...a: unknown[]) => void> }).blobDebug;
      const gl = (document.getElementById('blob') as HTMLCanvasElement).getContext('webgl2')!;
      const px = new Uint8Array(4);
      d.freeze(view);
      for (let i = 0; i < (timers ? 60 : 0); i++) d.step(1 / 30, view, level, false, undefined, undefined, undefined, false, timers); // drops out on their orbit
      d.step(1 / 30, view, level, true, undefined, undefined, undefined, false, timers);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // warm-up and shader compile
      const ms: number[] = [];
      for (let i = 0; i < n; i++) {
        const t0 = performance.now();
        d.step(1 / 30, view, level, true, undefined, undefined, undefined, false, timers);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        ms.push(performance.now() - t0);
      }
      return Math.min(...ms);
    },
    { view, level, n, timers },
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
  await sheet(page, 'idle', false, 'idle-night', 0.2, { sleep: true, every: 30 }); // night mode: asleep at NIGHT_DIM, 1 s apart (a snooze)
  const timer = { source: 'timer', urgency: 'info' } as const;
  await sheet(page, 'idle', false, 'clock', 1, { clock: '2026-01-01T09:41', wide: true });
  await sheet(page, 'alert', false, 'alert-timer-info', 1, { alert: timer });
  await sheet(page, 'alert', false, 'alert-square-urgent', 1, { alert: { source: 'calendar', urgency: 'urgent' } });
  // The morph from the blob to the timer triangle: hop, twirl, landing jiggle, 0.1 s apart.
  await sheet(page, 'alert', false, 'morph-to-triangle', 1, { alert: timer, from: 'idle', every: 3 });
  await sheet(page, 'idle', false, 'morph-to-clock', 1, { clock: '2026-01-01T09:41', from: 'listening', every: 3, wide: true });
  // Acts at rest, 0.1 s apart.
  const square = { source: 'calendar', urgency: 'info' } as const;
  await sheet(page, 'alert', false, 'act-backflip-square', 1, { alert: square, act: 'backflip', every: 3, frames: 24 });
  await sheet(page, 'idle', false, 'act-look-around', 1, { act: 'lookAround', every: 6, frames: 24 });
  await sheet(page, 'idle', false, 'act-doze', 1, { act: 'doze', every: 6, frames: 24 });
  await sheet(page, 'alert', false, 'act-spin-triangle', 1, { alert: timer, act: 'spinJump', every: 3, frames: 18 });
  // Thinking: random acts back to back (ponder, compute, eureka...), 0.25 s apart.
  await sheet(page, 'thinking', false, 'thinking-acts', 1, { every: 8, frames: 36 });
  // Timer droplets, 0.2 s apart: a 4 s timer and a 25 minute one pinch off the
  // blob and orbit; the short one ripens (warmer, pulsing) and, when it fires,
  // falls back in before the blob turns into the timer triangle.
  const fire = ((t: number): Scripted => {
    const long = { key: 'oven', left_s: 1500 - t };
    if (t < 4.6) return { timers: [{ key: 'pasta', left_s: Math.max(0, 4.6 - t) }, long] };
    return { view: 'alert', alert: { source: 'timer', urgency: 'urgent' }, timers: [long], fired: ['pasta'] };
  }).toString();
  await sheet(page, 'idle', false, 'timer-droplets', 1, { script: fire, every: 6, frames: 36 });
  // A cancelled timer's drop fades where it is; a new one pinches off.
  const cancel = ((t: number): Scripted => ({
    timers: t < 2.5 ? [{ key: 'a', left_s: 600 }, { key: 'b', left_s: 3000 }] : [{ key: 'b', left_s: 3000 }, ...(t > 3.5 ? [{ key: 'c', left_s: 90 }] : [])],
  })).toString();
  await sheet(page, 'idle', false, 'timer-droplets-cancel', 1, { script: cancel, every: 6, frames: 30 });
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
    const timers = [{ key: 'a', left_s: 300 }, { key: 'b', left_s: 1800 }, { key: 'c', left_s: 40 }];
    const drops = await frameCost(page, 'idle', 0, 20, timers);
    rows.push(`quality ${q}: idle ${idle.toFixed(1)} ms, listening(level 0.7) ${listening.toFixed(1)} ms, idle with 3 droplets ${drops.toFixed(1)} ms`);
  }
  console.log(`frame cost per drawn frame:\n${rows.join('\n')}`);
});
