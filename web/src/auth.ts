// Sign-in: the backend runs the OpenID Connect login (Pocket ID) at /auth/login and sets an
// HttpOnly session cookie that rides on /device-config and the WebSocket upgrade. The page only
// sends the browser there when the backend says it is signed out.

export const SIGNIN_AT_KEY = 'blob.signinAt';
// A second redirect this soon means signing in did not help (e.g. a wrong PUBLIC_URL):
// stop and show the fault line instead of looping between Blob and the provider.
export const SIGNIN_RETRY_MS = 60_000;

export function signInUrl(loc: Pick<Location, 'pathname' | 'search'> = location): string {
  return `/auth/login?next=${encodeURIComponent(loc.pathname + loc.search)}`;
}

// Returns false when it did not redirect (a redirect happened moments ago).
export function goSignIn(
  storage: Pick<Storage, 'getItem' | 'setItem'> = sessionStorage,
  loc: Pick<Location, 'pathname' | 'search' | 'assign'> = location,
  now: number = Date.now(),
): boolean {
  let last = 0;
  try {
    last = Number(storage.getItem(SIGNIN_AT_KEY) ?? 0);
    storage.setItem(SIGNIN_AT_KEY, String(now));
  } catch {
    // No storage (private mode): redirect anyway; the provider's own session ends a loop.
  }
  if (now - last < SIGNIN_RETRY_MS) return false;
  loc.assign(signInUrl(loc));
  return true;
}
