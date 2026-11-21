import type { NightHours } from './night';

// Page settings. Defaults here; the device flags and limits come from GET /device-config.

export const PAGE_VERSION: string = __BLOB_VERSION__;

export const RECORD_CAP_MS = 15_000;
export const SILENCE_RMS = 0.01;
export const OVERLAY_MIN_MS = 3_000;
export const LONG_PRESS_MS = 600;

export interface DeviceConfig {
  device: string; // the signed-in user's name
  sound: boolean;
  wake: boolean;
  quiet_hours: string;
  followup_listen_s: number;
  listen_no_speech_s: number;
  silence_rms: number;
  debug_audio: boolean; // DEBUG_AUDIO_DIR is set on the backend: wake_clip audio is kept
  night: NightHours | null; // night mode (NIGHT_HOURS), browser local time; null: off
  // Presence wake: with nobody in the room the screen goes dark this long after the last activity.
  presence_sleep_s: number;
}

export const DEFAULT_DEVICE_CONFIG: DeviceConfig = {
  device: '',
  sound: false,
  wake: false,
  quiet_hours: '',
  followup_listen_s: 6,
  listen_no_speech_s: 8,
  silence_rms: SILENCE_RMS,
  debug_audio: false,
  night: null,
  // Presence wake
  presence_sleep_s: 600,
};

export function wsUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

// 401 means signed out (the session cookie is missing or expired). Any other failure falls
// back to the defaults (sound and wake off).
export async function fetchDeviceConfig(): Promise<DeviceConfig | 'signed_out'> {
  try {
    const r = await fetch('/device-config', { credentials: 'same-origin', cache: 'no-store' });
    if (r.status === 401) return 'signed_out';
    if (!r.ok) return DEFAULT_DEVICE_CONFIG;
    return { ...DEFAULT_DEVICE_CONFIG, ...((await r.json()) as Partial<DeviceConfig>) };
  } catch {
    return DEFAULT_DEVICE_CONFIG;
  }
}
