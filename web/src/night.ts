import type { AlertItem } from './protocol';

// Night mode (NIGHT_HOURS, served as `night` by /device-config). The tablet is
// on all day and night: at night the blob sleeps, dark and still, at a low frame
// rate, to keep the panel cool and spare it. A tap or the wake word wakes it as
// usual; it dozes off again a little after going back to idle. Only urgent
// alerts show (and ring) at night; info alerts wait for the morning.

export interface NightHours {
  start: string; // HH:MM, browser local time
  end: string; // HH:MM; before start when the night crosses midnight
}

// How dark and how slow the sleeping blob is.
export const NIGHT_DIM = 0.2; // light given off while asleep (renderer.setDim, linear: about half as bright to the eye)
export const NIGHT_FPS = 10; // frame cap while asleep (renderer.setMaxFps); idle is 30
// After a tap, a turn or an urgent alert, stay awake this long once idle again.
export const NIGHT_AWAKE_MS = 20_000;

function minutes(hm: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(hm ?? '');
  if (!m) return null;
  const [h, mm] = [Number(m[1]), Number(m[2])];
  return h > 23 || mm > 59 ? null : h * 60 + mm;
}

// The night that `now` falls in, as two instants, or null by day (or when the
// hours are missing, malformed or zero-length).
//
// The start and end are wall-clock times on the night's own dates, resolved
// the way `new Date(y, m, d, h, min)` does: a time skipped by the spring
// change moves on by the gap (02:30 becomes 03:30), and a time
// repeated by the autumn change is its first occurrence. So a night that
// ends at 02:30 ends at the first 02:30 and does not come back for the
// repeated hour, and 23:00-07:30 lasts 8.5 h of wall clock either way (7.5
// or 9.5 real hours on the nights the clocks change).
export function nightWindow(hours: NightHours | null | undefined, now: Date): { start: Date; end: Date } | null {
  if (!hours) return null;
  const s = minutes(hours.start);
  const e = minutes(hours.end);
  if (s === null || e === null || s === e) return null;
  const crosses = e < s;
  // The night that started yesterday may still be on; then today's.
  for (const back of [1, 0]) {
    const y = now.getFullYear();
    const mo = now.getMonth();
    const d = now.getDate() - back;
    const start = new Date(y, mo, d, Math.floor(s / 60), s % 60);
    const end = new Date(y, mo, d + (crosses ? 1 : 0), Math.floor(e / 60), e % 60);
    if (start <= now && now < end) return { start, end };
  }
  return null;
}

export const isNight = (hours: NightHours | null | undefined, now: Date): boolean => nightWindow(hours, now) !== null;

// An alert that waits for the morning: anything but urgent (timers are urgent
// by default, so they still ring).
export const heldAtNight = (a: Pick<AlertItem, 'urgency'>): boolean => a.urgency !== 'urgent';

// The alerts the page shows (and may read, ring for) now.
export function shownAlerts<A extends Pick<AlertItem, 'urgency'>>(alerts: readonly A[], night: boolean): A[] {
  return night ? alerts.filter((a) => !heldAtNight(a)) : [...alerts];
}

export interface NightDeps {
  hours(): NightHours | null | undefined;
  // Brightness and frame cap of this source: (1, Infinity) when it lets go.
  apply(dim: number, fps: number): void;
  onChange?(night: boolean): void; // night began or ended
  now?(): Date; // wall clock
  clock?(): number; // monotonic ms
}

// Whether it is night, and whether the blob is asleep (night, and nothing has
// woken it lately). Call `update` on every frame (and from a timer, for when
// no frames are drawn) with whether something is going on.
export class NightMode {
  private readonly d: NightDeps;
  private lastActive = -Infinity;
  private applied = '';
  on = false;
  asleep = false;

  constructor(deps: NightDeps) {
    this.d = deps;
  }

  private ms(): number {
    return this.d.clock ? this.d.clock() : performance.now();
  }

  // A tap or the wake word: wake up now, even if nothing else happens.
  poke(): void {
    this.lastActive = this.ms();
  }

  // `active`: a turn, an alert being read or ringing, anything worth seeing.
  update(active: boolean): void {
    const now = this.ms();
    if (active) this.lastActive = now;
    const on = isNight(this.d.hours(), this.d.now ? this.d.now() : new Date());
    if (on !== this.on) {
      this.on = on;
      this.d.onChange?.(on);
    }
    this.asleep = on && now - this.lastActive >= NIGHT_AWAKE_MS;
    const key = this.asleep ? 'asleep' : 'awake';
    if (key === this.applied) return;
    this.applied = key;
    if (this.asleep) this.d.apply(NIGHT_DIM, NIGHT_FPS);
    else this.d.apply(1, Infinity);
  }
}
