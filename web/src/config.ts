// Page settings. S1 defaults; S2 reads the device flags from GET /device-config.

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
}

export const DEFAULT_DEVICE = 'desktop';
export const DEFAULT_DEVICE_CONFIG: DeviceConfig = {
  sound: false,
  wake: false,
  quiet_hours: '',
  followup_listen_s: 6,
  listen_no_speech_s: 8,
};

export function wsUrl(loc: Pick<Location, 'protocol' | 'host'> = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

// Missing or failed config falls back to the defaults: the flags only matter from S3/S4 on.
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
