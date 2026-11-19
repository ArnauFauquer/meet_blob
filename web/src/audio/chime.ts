import type { AlertItem } from '../protocol';

// The alarm's sounds: liquid bubbles, like the blob (scripts/make_sounds.py).
export const ALARM_SOUNDS = ['/bubble-a.wav', '/bubble-b.wav', '/bubble-c.wav'] as const;
// Each ring is detuned by up to this much either way, so no two sound alike.
export const ALARM_DETUNE = 0.1;

// One ring's sound: any of the n except the one before, and a playback rate
// around 1. `rand` returns [0, 1).
export function pickRing(prev: number, n: number, rand: () => number): { index: number; rate: number } {
  let index = Math.floor(rand() * (n > 1 && prev >= 0 ? n - 1 : n));
  if (n > 1 && prev >= 0 && index >= prev) index += 1;
  return { index, rate: 1 + ALARM_DETUNE * (2 * rand() - 1) };
}

// quiet_hours "HH:MM-HH:MM" in the browser's local time; the window may cross
// midnight ("22:00-07:00"). Empty, malformed or zero-length: never quiet.
export function inQuietHours(spec: string, now: Date): boolean {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(spec ?? '');
  if (!m) return false;
  const [sh, sm, eh, em] = m.slice(1).map(Number);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return false;
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  const t = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}

export interface ChimeConfig {
  sound: boolean;
  quiet_hours: string;
}

// When the alert chime plays (design, Display rules): once per alert when it
// becomes active, on a client with sound=true; held while a turn is active and
// played at turn end only if the alert is still open; muted (dropped) inside
// quiet hours. Alerts that arrive together share one chime. A key that leaves
// the snapshot and comes back (acked, then re-raised) counts as a new alert.
export class ChimeRules {
  private readonly seen = new Set<string>();
  private readonly pending = new Set<string>();
  private readonly cfg: () => ChimeConfig;
  private readonly now: () => Date;
  fired: string[] = []; // the alerts the last `true` from update() was for

  constructor(cfg: () => ChimeConfig, now: () => Date = () => new Date()) {
    this.cfg = cfg;
    this.now = now;
  }

  // Call on every snapshot and when a turn may have ended. True: play the chime now.
  update(alerts: readonly AlertItem[], turnActive: boolean): boolean {
    const keys = new Set(alerts.map((a) => a.key));
    for (const k of this.seen) {
      if (!keys.has(k)) {
        this.seen.delete(k);
        this.pending.delete(k);
      }
    }
    for (const k of keys) {
      if (!this.seen.has(k)) {
        this.seen.add(k);
        this.pending.add(k);
      }
    }
    if (!this.pending.size || turnActive) return false;
    this.fired = [...this.pending];
    this.pending.clear();
    const c = this.cfg();
    return c.sound && !inQuietHours(c.quiet_hours, this.now());
  }
}

// How long the alarm for a new alert rings, and how often the chime repeats in
// it. Long enough to be heard from another room, short enough that nobody at
// home has it ringing on and on.
export const ALARM_MS = 30_000;
export const ALARM_EVERY_MS = 4_000;
// It starts soft and swells to full volume over this time, so it wakes gently.
export const ALARM_SWELL_MS = 12_000;
export const ALARM_START_GAIN = 0.35;

export function alarmGain(sinceStartMs: number): number {
  return ALARM_START_GAIN + (1 - ALARM_START_GAIN) * Math.min(1, Math.max(0, sinceStartMs / ALARM_SWELL_MS));
}

export interface AlarmDeps {
  ring(gain: number): void; // play the chime once, at this volume (0..1)
  hush(): boolean; // true: stop now (a turn started, the alert is being read)
  now?(): number;
}

// The alarm a ChimeRules "play" starts: the chime every ALARM_EVERY_MS for
// ALARM_MS, swelling from soft to full volume. It stops early on a tap, when a
// turn starts or the alert is read, and when every alert it rings for has left
// the snapshot (acked, deleted). A new alert while it rings joins it and gives
// it another ALARM_MS.
export class Alarm {
  private readonly keys = new Set<string>();
  private until = 0;
  private since = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly d: AlarmDeps;
  started = 0; // alarms started, for the diagnostics and the e2e tests

  constructor(deps: AlarmDeps) {
    this.d = deps;
  }

  get ringing(): boolean {
    return this.timer !== undefined;
  }

  private now(): number {
    return this.d.now ? this.d.now() : performance.now();
  }

  start(keys: Iterable<string>): void {
    for (const k of keys) this.keys.add(k);
    if (!this.keys.size) return;
    this.until = this.now() + ALARM_MS;
    if (this.ringing) return;
    this.started += 1;
    this.since = this.now();
    this.d.ring(alarmGain(0));
    this.timer = setInterval(() => this.tick(), ALARM_EVERY_MS);
  }

  // The open alerts after a snapshot.
  update(openKeys: Iterable<string>): void {
    if (!this.ringing) return;
    const open = new Set(openKeys);
    for (const k of this.keys) if (!open.has(k)) this.keys.delete(k);
    if (!this.keys.size) this.stop();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.keys.clear();
  }

  private tick(): void {
    if (this.d.hush() || this.now() >= this.until) this.stop();
    else this.d.ring(alarmGain(this.now() - this.since));
  }
}
