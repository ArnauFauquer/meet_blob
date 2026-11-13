// Page settings. Defaults here; the device flags and limits come from GET /device-config.

export const PAGE_VERSION: string = __BLOB_VERSION__;

export const RECORD_CAP_MS = 15_000;
export const SILENCE_RMS = 0.01;
export const OVERLAY_MIN_MS = 3_000;
export const LONG_PRESS_MS = 600;

export interface DeviceConfig {
  sound: boolean;
  wake: boolean;
  quiet_hours: string;
  followup_listen_s: number;
  listen_no_speech_s: number;
  silence_rms: number;
  debug_audio: boolean; // DEBUG_AUDIO_DIR is set on the backend: wake_clip audio is kept
}

export const DEFAULT_DEVICE = 'desktop';
export const DEFAULT_DEVICE_CONFIG: DeviceConfig = {
  sound: false,
  wake: false,
  quiet_hours: '',
  followup_listen_s: 6,
  listen_no_speech_s: 8,
  silence_rms: SILENCE_RMS,
  debug_audio: false,
};

export function wsUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

// Missing or failed config falls back to the defaults (sound and wake off).
export async function fetchDeviceConfig(token: string, device: string): Promise<DeviceConfig> {
  try {
    const r = await fetch(`/device-config?device=${encodeURIComponent(device)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return DEFAULT_DEVICE_CONFIG;
    return { ...DEFAULT_DEVICE_CONFIG, ...((await r.json()) as Partial<DeviceConfig>) };
  } catch {
    return DEFAULT_DEVICE_CONFIG;
  }
}
