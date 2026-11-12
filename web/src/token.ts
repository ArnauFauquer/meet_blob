import { DEFAULT_DEVICE } from './config';

export const TOKEN_KEY = 'blob.token';
export const DEVICE_KEY = 'blob.device';

export interface Credentials {
  token: string;
  device: string;
}

// Reads #t=TOKEN&device=NAME once, stores both, and removes the hash so the
// secret does not stay in the address bar or the history.
export function loadCredentials(
  storage: Storage = localStorage,
  loc: Pick<Location, 'hash' | 'pathname' | 'search'> = location,
  hist: Pick<History, 'replaceState'> = history,
): Credentials {
  const params = new URLSearchParams(loc.hash.replace(/^#/, ''));
  const t = params.get('t');
  const d = params.get('device');
  if (t) storage.setItem(TOKEN_KEY, t);
  if (d) storage.setItem(DEVICE_KEY, d);
  if (t || d) hist.replaceState(null, '', loc.pathname + loc.search);
  return {
    token: storage.getItem(TOKEN_KEY) ?? '',
    device: storage.getItem(DEVICE_KEY) ?? DEFAULT_DEVICE,
  };
}
