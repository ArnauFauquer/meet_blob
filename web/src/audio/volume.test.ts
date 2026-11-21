import { describe, expect, it, vi } from 'vitest';
import { block } from './blocks.testutil';
import {
  AdaptiveVolume,
  CHIME_CURVE,
  DEBUG_LOG_MS,
  DEFAULT_NIGHT,
  NOISE_LOUD_DBFS,
  NOISE_QUIET_DBFS,
  RAMP_MIN,
  VOICE_CURVE,
  boostDb,
  dbToGain,
  gainDb,
  nightWindow,
  nightness,
  volumeOptions,
  type VolumeDeps,
} from './volume';

const at = (hm: string, s = 0) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(2026, 10, 20, h, m, s);
};

describe('gain curve', () => {
  it('day in a quiet room: the normal volume', () => {
    expect(gainDb(VOICE_CURVE, 0, -70)).toBe(0);
    expect(gainDb(VOICE_CURVE, 0, null)).toBe(0); // no estimate: no boost
    expect(gainDb(CHIME_CURVE, 0, NOISE_QUIET_DBFS)).toBe(0);
  });

  it('night in a quiet room: softer, the chime less so than the voice', () => {
    expect(gainDb(VOICE_CURVE, 1, -70)).toBe(VOICE_CURVE.nightDb);
    expect(gainDb(CHIME_CURVE, 1, -70)).toBe(CHIME_CURVE.nightDb);
    expect(CHIME_CURVE.nightDb).toBeGreaterThan(VOICE_CURVE.nightDb);
    expect(gainDb(VOICE_CURVE, 0.5, -70)).toBe(VOICE_CURVE.nightDb / 2);
  });

  it('a noisy room raises it, linearly in dB, up to a cap', () => {
    const mid = (NOISE_QUIET_DBFS + NOISE_LOUD_DBFS) / 2;
    expect(gainDb(VOICE_CURVE, 0, mid)).toBe(VOICE_CURVE.boostMaxDb / 2);
    expect(gainDb(VOICE_CURVE, 0, NOISE_LOUD_DBFS)).toBe(VOICE_CURVE.boostMaxDb);
    expect(gainDb(VOICE_CURVE, 0, -5)).toBe(VOICE_CURVE.boostMaxDb); // capped
    expect(gainDb(CHIME_CURVE, 0, -5)).toBe(CHIME_CURVE.boostMaxDb);
    // +6 dB for the chime too: more and the limiter shaves the bubbles' attack
    expect(CHIME_CURVE.boostMaxDb).toBe(6);
  });

  it('noise at night: the boost adds to the night drop', () => {
    expect(gainDb(VOICE_CURVE, 1, -5)).toBe(VOICE_CURVE.nightDb + VOICE_CURVE.boostMaxDb);
  });

  it('never decreases with noise, never increases with night', () => {
    for (const c of [VOICE_CURVE, CHIME_CURVE]) {
      let prev = -Infinity;
      for (let n = -90; n <= 0; n += 0.5) {
        const g = boostDb(c, n);
        expect(g).toBeGreaterThanOrEqual(prev);
        expect(g).toBeLessThanOrEqual(c.boostMaxDb);
        prev = g;
      }
      expect(gainDb(c, 1, -40)).toBeLessThan(gainDb(c, 0, -40));
    }
  });

  it('dB to a linear gain', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3);
    expect(dbToGain(6)).toBeCloseTo(1.995, 3);
  });
});

describe('night', () => {
  it('reads the night window from /device-config, or the default', () => {
    expect(nightWindow(undefined)).toEqual(DEFAULT_NIGHT);
    expect(nightWindow(null)).toBeNull();
    expect(nightWindow({ start: '23:15', end: '06:30' })).toEqual({ start: 23 * 60 + 15, end: 6 * 60 + 30 });
    expect(nightWindow({ start: '25:00', end: '06:30' })).toEqual(DEFAULT_NIGHT);
    expect(nightWindow('22-7')).toEqual(DEFAULT_NIGHT);
  });

  it('is 0 in the day and 1 deep in the night (22:00-08:00)', () => {
    expect(nightness(at('12:00'), DEFAULT_NIGHT)).toBe(0);
    expect(nightness(at('21:59'), DEFAULT_NIGHT)).toBe(0);
    expect(nightness(at('03:00'), DEFAULT_NIGHT)).toBe(1);
    expect(nightness(at('08:00'), DEFAULT_NIGHT)).toBe(0);
  });

  it('eases in after the start and out before the end', () => {
    expect(nightness(at('22:22', 30), DEFAULT_NIGHT)).toBeCloseTo(0.5, 5);
    expect(nightness(at('22:45'), DEFAULT_NIGHT)).toBe(1);
    expect(nightness(at('07:15'), DEFAULT_NIGHT)).toBe(1);
    expect(nightness(at('07:37', 30), DEFAULT_NIGHT)).toBeCloseTo(0.5, 5); // RAMP_MIN / 2 before the end
  });

  it('changes by little from one minute to the next, all day long', () => {
    let prev = nightness(at('00:00'), DEFAULT_NIGHT);
    let maxStep = 0;
    for (let m = 1; m <= 24 * 60; m++) {
      const v = nightness(new Date(2026, 10, 20, 0, m), DEFAULT_NIGHT);
      maxStep = Math.max(maxStep, Math.abs(v - prev));
      prev = v;
    }
    // 1.5 / RAMP_MIN is the steepest slope of a smoothstep over RAMP_MIN minutes.
    expect(maxStep).toBeLessThanOrEqual(1.5 / RAMP_MIN + 1e-9);
    expect(maxStep * Math.abs(VOICE_CURVE.nightDb)).toBeLessThan(0.31); // dB per minute
  });

  it('no night, and an empty window, are always day; a short window ramps over half its length', () => {
    expect(nightness(at('03:00'), null)).toBe(0);
    expect(nightness(at('03:00'), { start: 120, end: 120 })).toBe(0);
    const short = { start: 3 * 60, end: 3 * 60 + 30 };
    expect(nightness(at('03:15'), short)).toBe(1);
    expect(nightness(at('03:07', 30), short)).toBeCloseTo(0.5, 5);
  });
});

describe('volumeOptions', () => {
  it('parses the debug parameters', () => {
    expect(volumeOptions('')).toEqual({ debug: false, at: null, noise: null });
    expect(volumeOptions('?volume=debug&volume_at=23:30&volume_noise=-35')).toEqual({ debug: true, at: 23 * 60 + 30, noise: -35 });
    expect(volumeOptions('?volume_at=nope&volume_noise=')).toEqual({ debug: false, at: null, noise: null });
  });
});

describe('AdaptiveVolume', () => {
  function make(over: Partial<VolumeDeps> = {}, opt = volumeOptions('')) {
    let t = 0;
    const log = vi.fn<(e: Record<string, unknown>) => void>();
    const deps: VolumeDeps = {
      quietForMs: () => Infinity,
      speech: () => false,
      night: () => undefined,
      log,
      now: () => t,
      date: () => at('12:00'),
      ...over,
    };
    const v = new AdaptiveVolume(deps, opt);
    const hear = (db: number, ms: number) => {
      for (let i = 0; i < ms / 20; i++) {
        t += 20;
        v.hear(block(db, 2));
      }
    };
    return { v, log, hear };
  }

  it('a quiet day: the normal volume', () => {
    const { v, hear } = make();
    hear(-65, 3000);
    expect(v.gain('voice')).toBe(1);
    expect(v.state()).toMatchObject({ night: 0, voice_db: 0, chime_db: 0 });
  });

  it('the hood on: louder, the voice and the chime alike', () => {
    const { v, hear } = make();
    hear(-36, 8000);
    const s = v.state();
    expect(s.noise_dbfs).toBeGreaterThan(-39);
    expect(s.voice_db).toBeGreaterThan(4);
    expect(s.chime_db).toBe(s.voice_db);
    expect(v.gain('voice')).toBeCloseTo(dbToGain(s.voice_db), 6);
  });

  it('does not count Blob own sound, its echo, or the user speaking', () => {
    let quiet = Infinity;
    let speech = false;
    const { v, hear } = make({ quietForMs: () => quiet, speech: () => speech });
    hear(-62, 3000);
    quiet = 0; // a reply plays, loud in the microphone
    hear(-20, 6000);
    quiet = 300; // its echo
    hear(-30, 300);
    quiet = Infinity;
    speech = true; // the user's question
    hear(-22, 4000);
    expect(v.state().noise_dbfs).toBeLessThan(-59);
    expect(v.state().voice_db).toBe(0);
  });

  it('at night: softer, with the window from /device-config when it is there', () => {
    const { v } = make({ date: () => at('02:00') });
    expect(v.state()).toMatchObject({ night: 1, voice_db: VOICE_CURVE.nightDb, chime_db: CHIME_CURVE.nightDb });
    const off = make({ date: () => at('02:00'), night: () => null }).v;
    expect(off.state().voice_db).toBe(0);
    const late = make({ date: () => at('22:30'), night: () => ({ start: '23:30', end: '07:00' }) }).v;
    expect(late.state().night).toBe(0);
  });

  it('?volume_at and ?volume_noise pretend the time and the noise', () => {
    const { v } = make({}, volumeOptions('?volume_at=03:00&volume_noise=-20'));
    expect(v.state()).toMatchObject({ noise_dbfs: -20, night: 1, voice_db: VOICE_CURVE.nightDb + VOICE_CURVE.boostMaxDb });
  });

  it('?volume=debug logs the estimate every 2 s and every gain applied', () => {
    const { v, log, hear } = make({}, volumeOptions('?volume=debug'));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    hear(-60, 2 * DEBUG_LOG_MS);
    v.gain('chime');
    const events = log.mock.calls.map((c) => c[0]);
    expect(events.filter((e) => e.event === 'estimate')).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ event: 'apply', sound: 'chime', gain_db: 0, night: 0 });
    expect(debug).toHaveBeenCalled();
    debug.mockRestore();
  });

  it('logs nothing without the debug parameter', () => {
    const { v, log, hear } = make();
    hear(-60, 5000);
    v.gain('voice');
    expect(log).not.toHaveBeenCalled();
  });
});
