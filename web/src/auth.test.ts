import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNIN_AT_KEY, SIGNIN_RETRY_MS, goSignIn, signInUrl } from './auth';

beforeEach(() => sessionStorage.clear());

describe('sign-in redirect', () => {
  it('comes back to the same page and query', () => {
    expect(signInUrl({ pathname: '/', search: '?enroll=1' })).toBe('/auth/login?next=%2F%3Fenroll%3D1');
  });

  it('redirects once, then not again within the retry window', () => {
    const assign = vi.fn();
    const loc = { pathname: '/', search: '', assign };
    expect(goSignIn(sessionStorage, loc, 1_000_000)).toBe(true);
    expect(assign).toHaveBeenCalledWith('/auth/login?next=%2F');
    expect(sessionStorage.getItem(SIGNIN_AT_KEY)).toBe('1000000');
    expect(goSignIn(sessionStorage, loc, 1_000_000 + SIGNIN_RETRY_MS - 1)).toBe(false);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(goSignIn(sessionStorage, loc, 1_000_000 + 3 * SIGNIN_RETRY_MS)).toBe(true);
    expect(assign).toHaveBeenCalledTimes(2);
  });

  it('still redirects without storage', () => {
    const assign = vi.fn();
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(goSignIn(broken, { pathname: '/', search: '', assign }, 10_000_000)).toBe(true);
    expect(assign).toHaveBeenCalledOnce();
  });
});
