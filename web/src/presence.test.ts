import { describe, expect, it, vi } from 'vitest';
import { NIGHT_AWAKE_MS, NIGHT_DIM, NIGHT_FPS, NightMode } from './night';
import { DARK_FPS, PresenceMachine, REST_WHEN_EMPTY_MS, showScreen } from './presence';

const SLEEP_MS = 600_000;
const CLOCK_AFTER_MS = 300_000; // render/tables.ts
const S = 1000;

const machine = () => new PresenceMachine(() => SLEEP_MS);

describe('PresenceMachine without a sensor', () => {
  it('is always awake and rests on the usual clock timer', () => {
    const p = machine();
    for (const t of [0, CLOCK_AFTER_MS, SLEEP_MS, 10 * SLEEP_MS]) {
      expect(p.screen(t, 0, true)).toBe('awake');
      expect(p.restMs(t, 0, CLOCK_AFTER_MS)).toBe(t - CLOCK_AFTER_MS);
    }
    expect(p.tap(10 * SLEEP_MS, 0, true)).toBe(false);
  });

  it('goes back to that after the socket drops (null report)', () => {
    const p = machine();
    p.report(false, 0, 0);
    expect(p.screen(SLEEP_MS, 0, true)).toBe('sleep');
    p.report(null, null, SLEEP_MS);
    expect(p.screen(SLEEP_MS, 0, true)).toBe('awake');
    expect(p.restMs(SLEEP_MS, 0, CLOCK_AFTER_MS)).toBe(SLEEP_MS - CLOCK_AFTER_MS);
  });
});

describe('PresenceMachine, someone arrives', () => {
  it('turns the clock of an empty room back into the face', () => {
    const p = machine();
    p.report(false, 0, 0);
    const t = REST_WHEN_EMPTY_MS + 5 * S;
    expect(p.screen(t, 0, true)).toBe('rest');
    expect(p.restMs(t, 0, CLOCK_AFTER_MS)).toBeGreaterThan(0);
    p.report(true, 0, t, 0, true);
    expect(p.screen(t, 0, true)).toBe('awake');
    expect(p.restMs(t, 0, CLOCK_AFTER_MS)).toBe(-CLOCK_AFTER_MS);
    // While someone stays, the clock comes back on the usual timer.
    expect(p.restMs(t + CLOCK_AFTER_MS, 0, CLOCK_AFTER_MS)).toBe(0);
  });

  it('wakes the dark screen at once', () => {
    const p = machine();
    p.report(false, 0, 0);
    const t = SLEEP_MS + S;
    expect(p.screen(t, 0, true)).toBe('sleep');
    p.report(true, 0, t, 0, true);
    expect(p.screen(t, 0, true)).toBe('awake');
    expect(p.restMs(t, 0, CLOCK_AFTER_MS)).toBe(-CLOCK_AFTER_MS);
  });

  it('never sleeps while someone is there', () => {
    const p = machine();
    p.report(true, 0, 0, 0, true);
    expect(p.screen(100 * SLEEP_MS, 0, true)).toBe('awake');
  });

  it('a repeated true (a motion sensor firing again) does not interrupt the usual clock', () => {
    const p = machine();
    p.report(true, 0, 0, 0, true);
    const t = CLOCK_AFTER_MS + 60 * S; // idle since 0: the usual clock is up
    p.report(true, 60, t, 0, true);
    expect(p.restMs(t, 0, CLOCK_AFTER_MS)).toBe(60 * S);
    expect(p.screen(t, 0, true)).toBe('awake');
  });

  it('a first true after no report (Blob or the page restarted) does not interrupt the clock', () => {
    const p = machine();
    const t = CLOCK_AFTER_MS + 60 * S;
    p.report(true, 0, t, 0, true);
    expect(p.restMs(t, 0, CLOCK_AFTER_MS)).toBe(60 * S);
  });

  it('someone back while the face still shows keeps the usual clock timer', () => {
    const p = machine();
    p.report(false, 0, 0);
    const t = 10 * S; // under REST_WHEN_EMPTY_MS: still the face
    p.report(true, 0, t, 0, true);
    expect(p.restMs(t, 0, CLOCK_AFTER_MS)).toBe(t - CLOCK_AFTER_MS);
  });

  it('a true during an alert or a turn wakes nothing (the view is not idle)', () => {
    const p = machine();
    p.report(false, 0, 0);
    p.report(true, 0, 2 * SLEEP_MS, 0, false);
    // The alert ended at 2*SLEEP_MS: idle from then, someone there, the usual timer.
    expect(p.restMs(2 * SLEEP_MS, 2 * SLEEP_MS, CLOCK_AFTER_MS)).toBe(-CLOCK_AFTER_MS);
    expect(p.screen(2 * SLEEP_MS + 10 * SLEEP_MS, 2 * SLEEP_MS, true)).toBe('awake');
  });
});

describe('PresenceMachine, nobody there', () => {
  it('rests as the clock soon, then goes dark', () => {
    const p = machine();
    p.report(false, 0, 0);
    expect(p.screen(REST_WHEN_EMPTY_MS - 1, 0, true)).toBe('awake');
    expect(p.restMs(REST_WHEN_EMPTY_MS - 1, 0, CLOCK_AFTER_MS)).toBeLessThan(0);
    expect(p.screen(REST_WHEN_EMPTY_MS, 0, true)).toBe('rest');
    expect(p.restMs(REST_WHEN_EMPTY_MS, 0, CLOCK_AFTER_MS)).toBe(0);
    expect(p.screen(SLEEP_MS - 1, 0, true)).toBe('rest');
    expect(p.screen(SLEEP_MS, 0, true)).toBe('sleep');
  });

  it('counts from the latest of idle start, emptying and the last sign of someone', () => {
    const p = machine();
    p.report(true, 0, 0);
    p.report(false, 0, 100 * S);
    const idleSince = 200 * S; // a turn ended then
    expect(p.screen(200 * S + SLEEP_MS - 1, idleSince, true)).toBe('rest');
    expect(p.screen(200 * S + SLEEP_MS, idleSince, true)).toBe('sleep');
  });

  it('uses since_s, so a reload into an empty room does not start over', () => {
    const p = machine();
    p.report(false, 3600, 4_000 * S);
    // Idle since the page loaded at 3990 s: the quiet counts from there.
    expect(p.screen(3_990 * S + SLEEP_MS, 3_990 * S, true)).toBe('sleep');
  });

  it('a repeated "nobody" keeps the time the room emptied', () => {
    const p = machine();
    p.report(false, 0, 0);
    p.report(false, 0, 300 * S); // even if since_s were wrong
    expect(p.screen(SLEEP_MS, 0, true)).toBe('sleep');
  });

  it('shows anything that is not idle: an alert, a turn, an error, offline', () => {
    const p = machine();
    p.report(false, 0, 0);
    expect(p.screen(10 * SLEEP_MS, 0, false)).toBe('awake');
  });

  it('after an alert or a turn ends, sleeps again only after a full quiet stretch', () => {
    const p = machine();
    p.report(false, 0, 0);
    const end = 2 * SLEEP_MS; // the view was not idle until then
    expect(p.screen(end, end, true)).toBe('awake');
    expect(p.screen(end + REST_WHEN_EMPTY_MS, end, true)).toBe('rest');
    expect(p.screen(end + SLEEP_MS, end, true)).toBe('sleep');
  });

  it('a tap on the dark screen only wakes it, and it sleeps again later', () => {
    const p = machine();
    p.report(false, 0, 0);
    const t = SLEEP_MS + 5 * S;
    expect(p.tap(t, 0, true)).toBe(true);
    expect(p.screen(t, 0, true)).toBe('awake');
    expect(p.restMs(t, 0, CLOCK_AFTER_MS)).toBe(-REST_WHEN_EMPTY_MS);
    // The next tap is an ordinary tap.
    expect(p.tap(t + S, 0, true)).toBe(false);
    expect(p.screen(t + SLEEP_MS, 0, true)).toBe('sleep');
  });

  it('a tap on the resting clock is an ordinary tap', () => {
    const p = machine();
    p.report(false, 0, 0);
    expect(p.tap(REST_WHEN_EMPTY_MS, 0, true)).toBe(false);
  });

  it('reads the sleep time when asked (from /device-config)', () => {
    let sleep = SLEEP_MS;
    const p = new PresenceMachine(() => sleep);
    p.report(false, 0, 0);
    expect(p.screen(60 * S, 0, true)).toBe('rest');
    sleep = 60 * S;
    expect(p.screen(60 * S, 0, true)).toBe('sleep');
  });
});

describe('showScreen', () => {
  const renderer = () => ({ setDim: vi.fn(), setMaxFps: vi.fn(), dark: false });

  it('fades the presence source to black, caps the frames only once black, hides the strips', () => {
    const r = renderer();
    showScreen('sleep', r);
    expect(r.setDim).toHaveBeenLastCalledWith('presence', 0);
    expect(r.setMaxFps).toHaveBeenLastCalledWith('presence', Infinity); // still fading
    expect(document.body.classList.contains('asleep')).toBe(true);
    r.dark = true;
    showScreen('sleep', r);
    expect(r.setMaxFps).toHaveBeenLastCalledWith('presence', DARK_FPS);
  });

  it('lets go of the dim and the frame cap as soon as the screen is not asleep', () => {
    const r = { ...renderer(), dark: true };
    showScreen('sleep', r);
    for (const s of ['rest', 'awake'] as const) {
      showScreen(s, r);
      expect(r.setDim).toHaveBeenLastCalledWith('presence', 1);
      expect(r.setMaxFps).toHaveBeenLastCalledWith('presence', Infinity);
      expect(document.body.classList.contains('asleep')).toBe(false);
    }
    showScreen('awake', null); // no WebGL
    expect(document.body.classList.contains('asleep')).toBe(false);
  });
});

// Night mode (#12) and presence share the renderer's dim and frame cap; the
// lowest of every source wins. The fake keeps that rule (BlobRenderer.setDim and
// setMaxFps) and treats a dim of 0 as already faded to black.
describe('night mode and presence together', () => {
  class Screen {
    private readonly dims = new Map<string, number>();
    private readonly caps = new Map<string, number>();
    setDim(source: string, v: number): void {
      if (v >= 1) this.dims.delete(source);
      else this.dims.set(source, v);
    }
    setMaxFps(source: string, fps: number): void {
      if (!(fps > 0) || fps === Infinity) this.caps.delete(source);
      else this.caps.set(source, fps);
    }
    get dim(): number {
      return Math.min(1, ...this.dims.values());
    }
    get maxFps(): number {
      return Math.min(Infinity, ...this.caps.values());
    }
    get dark(): boolean {
      return this.dim <= 0;
    }
  }

  function setup() {
    let t = 0;
    const screen = new Screen();
    const night = new NightMode({
      hours: () => ({ start: '23:00', end: '07:30' }),
      apply: (dim, fps) => {
        screen.setDim('night', dim);
        screen.setMaxFps('night', fps);
      },
      now: () => new Date(2026, 10, 21, 2, 0), // 02:00, night
      clock: () => t,
    });
    const presence = machine();
    // One frame of the page: idle since 0, nothing going on.
    const frame = () => {
      night.update(false);
      showScreen(presence.screen(t, 0, true), screen);
      showScreen(presence.screen(t, 0, true), screen); // the next frame sees the black one drawn
    };
    return { screen, night, presence, frame, at: (ms: number) => (t = ms) };
  }

  it('at night with someone there: the sleeping blob of night mode', () => {
    const { screen, night, presence, frame, at } = setup();
    presence.report(true, 0, 0, 0, true);
    at(10 * SLEEP_MS);
    frame();
    expect(night.asleep).toBe(true);
    expect([screen.dim, screen.maxFps]).toEqual([NIGHT_DIM, NIGHT_FPS]);
  });

  it('at night with nobody there: the black screen wins', () => {
    const { screen, night, presence, frame, at } = setup();
    presence.report(false, 0, 0);
    at(SLEEP_MS);
    frame();
    expect(night.asleep).toBe(true);
    expect([screen.dim, screen.maxFps]).toEqual([0, DARK_FPS]);
  });

  it('a true at night lights the screen only as far as the sleeping night blob', () => {
    const { screen, night, presence, frame, at } = setup();
    presence.report(false, 0, 0);
    at(SLEEP_MS);
    frame();
    expect(screen.dim).toBe(0);
    presence.report(true, 0, SLEEP_MS, 0, true);
    frame();
    expect(night.asleep).toBe(true); // presence does not wake night mode
    expect([screen.dim, screen.maxFps]).toEqual([NIGHT_DIM, NIGHT_FPS]);
    at(SLEEP_MS + NIGHT_AWAKE_MS + 1);
    frame();
    expect(night.asleep).toBe(true);
  });
});
