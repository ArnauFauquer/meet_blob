export const RELOADED_FOR_KEY = 'blob.reloadedFor';

export type VersionAction = 'ok' | 'reload' | 'stop';

// Reload at most once per server version; a second mismatch stops the page.
export function checkVersion(serverVersion: string, pageVersion: string, storage: Storage = localStorage): VersionAction {
  if (serverVersion === pageVersion) return 'ok';
  if (storage.getItem(RELOADED_FOR_KEY) === serverVersion) return 'stop';
  storage.setItem(RELOADED_FOR_KEY, serverVersion);
  return 'reload';
}
