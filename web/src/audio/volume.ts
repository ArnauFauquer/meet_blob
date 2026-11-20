// Adaptive volume: Blob speaks softly at night and a little louder over a
// noisy room, with no setting to touch.
//
// gain (dB) = curve.nightDb × nightness(time) + boost(background noise)
//
// Two curves: the voice (replies, alert reads, the tts_fail beep) and the
// chime (alarm bubbles, the beep for an alert that cannot be read). The chime
// drops less at night, so a timer still wakes someone up, and climbs more over
// noise, so it is heard across a kitchen with the hood on.
//
// Changes are smooth and predictable: nightness ramps over RAMP_MIN at the
// edges of the night, the noise estimate is a percentile over seconds of audio
// (noise.ts), and Playback takes a voice gain only when nothing is playing, so
// it never changes inside a reply. Each chime ring takes one value for the
// whole ring. Boosted audio goes through a peak limiter (playback.ts), so a
// boost never clips.

import { NoiseFloor, blockDbfs, eligible } from './noise';

export type SoundKind = 'voice' | 'chime';

export interface Curve {
  nightDb: number; // at full night (negative)
  boostMaxDb: number; // over a loud room (positive); also the overall cap
}
export const VOICE_CURVE: Curve = { nightDb: -9, boostMaxDb: 6 };
export const CHIME_CURVE: Curve = { nightDb: -6, boostMaxDb: 9 };

// Background noise (dBFS of the processed microphone signal) mapped to the
// boost: none at or below NOISE_QUIET_DBFS, the curve's maximum at or above
// NOISE_LOUD_DBFS, linear in dB between. Calibrate with ?volume=debug: the
// page logs the estimate (client_event `volume`) in a quiet room and with the
// hood, the dishwasher or the TV on.
export const NOISE_QUIET_DBFS = -56;
export const NOISE_LOUD_DBFS = -32;

export function boostDb(curve: Curve, noiseDbfs: number | null): number {
  if (noiseDbfs === null) return 0;
  const x = (noiseDbfs - NOISE_QUIET_DBFS) / (NOISE_LOUD_DBFS - NOISE_QUIET_DBFS);
  return curve.boostMaxDb * Math.min(1, Math.max(0, x));
}

export function gainDb(curve: Curve, nightness: number, noiseDbfs: number | null): number {
  const db = curve.nightDb * Math.min(1, Math.max(0, nightness)) + boostDb(curve, noiseDbfs);
  return Math.round(Math.min(curve.boostMaxDb, db) * 10) / 10;
}

export const dbToGain = (db: number) => 10 ** (db / 20);

// ---- Night -----------------------------------------------------------------
//
// UNIFY(night-mode): the night window belongs to the night-mode feature
// (feat/night-mode), which serves it from /device-config as
// `night: {start: "HH:MM", end: "HH:MM"}`, or `null` for no night. nightWindow()
// reads that field when it is there and falls back to DEFAULT_NIGHT when the
// backend does not send it yet. Only the curve (nightDb, RAMP_MIN) lives here.

export interface NightWindow {
  start: number; // minutes after midnight, local time
  end: number; // may be before start (the night crosses midnight)
}
export const DEFAULT_NIGHT: NightWindow = { start: 22 * 60, end: 8 * 60 };
// The volume eases down over this long after the night starts, and back up over
// this long before it ends; outside the window it is the day volume.
export const RAMP_MIN = 45;

export function parseHm(s: unknown): number | null {
  const m = typeof s === 'string' ? /^\s*(\d{1,2}):(\d{2})\s*$/.exec(s) : null;
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

// /device-config `night`: missing → DEFAULT_NIGHT, null → no night, a window →
// that window (malformed → DEFAULT_NIGHT).
export function nightWindow(v: unknown): NightWindow | null {
  if (v === undefined) return DEFAULT_NIGHT;
  if (v === null) return null;
  const o = v as { start?: unknown; end?: unknown };
  const start = parseHm(o.start);
  const end = parseHm(o.end);
  return start === null || end === null ? DEFAULT_NIGHT : { start, end };
}

const smoothstep = (x: number) => x * x * (3 - 2 * x);

// 0 in the day, 1 deep in the night, a smooth ramp at both edges.
export function nightness(now: Date, win: NightWindow | null, rampMin = RAMP_MIN): number {
  if (!win) return 0;
  const len = (win.end - win.start + 1440) % 1440;
  if (len === 0) return 0;
  const t = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const pos = (t - win.start + 1440) % 1440;
  if (pos >= len) return 0;
  const ramp = Math.min(rampMin, len / 2);
  return smoothstep(Math.min(1, Math.min(pos, len - pos) / ramp));
}

// ---- Debug -----------------------------------------------------------------

// Page parameters for trying it by hand:
//   ?volume=debug        log the estimate every 2 s and every gain applied
//                        (client_event `volume`, and the browser console)
//   &volume_at=23:30     pretend this is the local time (night curve)
//   &volume_noise=-35    pretend this is the background noise, in dBFS
export interface VolumeOptions {
  debug: boolean;
  at: number | null;
  noise: number | null;
}

export function volumeOptions(search: string): VolumeOptions {
  const q = new URLSearchParams(search);
  const noise = q.get('volume_noise');
  const n = noise === null || noise.trim() === '' ? NaN : Number(noise);
  return { debug: q.get('volume') === 'debug', at: parseHm(q.get('volume_at')), noise: Number.isFinite(n) ? n : null };
}

// ---- The page's adaptive volume ---------------------------------------------

export const DEBUG_LOG_MS = 2_000;

export interface VolumeDeps {
  quietForMs(): number; // how long Blob has been silent (0 while it plays)
  speech(): boolean; // the voice-activity detector hears speech now
  night(): unknown; // /device-config `night` (see nightWindow)
  log(e: Record<string, unknown>): void; // debug lines
  now?(): number; // ms, for the noise window
  date?(): Date; // local time, for the night
}

export interface VolumeState {
  noise_dbfs: number | null;
  night: number;
  voice_db: number;
  chime_db: number;
}

export class AdaptiveVolume {
  private readonly floor = new NoiseFloor();
  private readonly d: VolumeDeps;
  private readonly opt: VolumeOptions;
  private lastLog = -Infinity;

  constructor(deps: VolumeDeps, opt: VolumeOptions = { debug: false, at: null, noise: null }) {
    this.d = deps;
    this.opt = opt;
  }

  private now(): number {
    return this.d.now ? this.d.now() : performance.now();
  }

  private date(): Date {
    const d = this.d.date ? this.d.date() : new Date();
    if (this.opt.at !== null) d.setHours(Math.floor(this.opt.at / 60), this.opt.at % 60, 0, 0);
    return d;
  }

  // Every microphone block (hands-free stream or a tap recording).
  hear(pcm: Int16Array): void {
    const now = this.now();
    if (eligible(this.d.quietForMs(), this.d.speech())) this.floor.push(blockDbfs(pcm), now);
    if (this.opt.debug && now - this.lastLog >= DEBUG_LOG_MS) {
      this.lastLog = now;
      this.log({ event: 'estimate', ...this.state() });
    }
  }

  state(): VolumeState {
    const noise = this.opt.noise ?? this.floor.estimate(this.now());
    const night = nightness(this.date(), nightWindow(this.d.night()));
    return {
      noise_dbfs: noise,
      night: Math.round(night * 100) / 100,
      voice_db: gainDb(VOICE_CURVE, night, noise),
      chime_db: gainDb(CHIME_CURVE, night, noise),
    };
  }

  // The linear gain for a sound that starts now.
  gain(kind: SoundKind): number {
    const s = this.state();
    const db = kind === 'voice' ? s.voice_db : s.chime_db;
    if (this.opt.debug) this.log({ event: 'apply', sound: kind, gain_db: db, ...s });
    return dbToGain(db);
  }

  private log(e: Record<string, unknown>): void {
    this.d.log(e);
    console.debug('[volume]', JSON.stringify(e));
  }
}
