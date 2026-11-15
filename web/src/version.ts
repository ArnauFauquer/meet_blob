export const RELOADED_FOR_KEY = 'blob.reloadedFor';

export type VersionAction = 'ok' | 'reload' | 'stop';

// Reload at most once per server version; a second mismatch stops the page.
export function checkVersion(serverVersion: string, pageVersion: string, storage: Storage = localStorage): VersionAction {
  if (serverVersion === pageVersion) return 'ok';
  if (storage.getItem(RELOADED_FOR_KEY) === serverVersion) return 'stop';
  storage.setItem(RELOADED_FOR_KEY, serverVersion);
  return 'reload';
}

// The built page's entry bundle (/assets/index-<hash>.js) in an index.html, or
// null on the dev server. It changes with every build that changes the page.
export function entryBundle(html: string): string | null {
  return html.match(/\/assets\/index-[\w-]+\.js/)?.[0] ?? null;
}
