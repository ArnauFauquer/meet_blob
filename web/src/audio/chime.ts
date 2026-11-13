import type { AlertItem } from '../protocol';

export const CHIME_URL = '/chime.wav';

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
    this.pending.clear();
    const c = this.cfg();
    return c.sound && !inQuietHours(c.quiet_hours, this.now());
  }
}
