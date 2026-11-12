import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_KEY, TOKEN_KEY, loadCredentials } from './token';

beforeEach(() => localStorage.clear());

describe('loadCredentials', () => {
  it('reads #t=TOKEN&device=NAME, stores both and removes the hash', () => {
    const replaceState = vi.fn();
    const c = loadCredentials(localStorage, { hash: '#t=s3cr%2Bt&device=tablet', pathname: '/', search: '' }, { replaceState });
    expect(c).toEqual({ token: 's3cr+t', device: 'tablet' });
    expect(localStorage.getItem(TOKEN_KEY)).toBe('s3cr+t');
    expect(localStorage.getItem(DEVICE_KEY)).toBe('tablet');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });
  it('uses the stored values when there is no hash and leaves the URL alone', () => {
    localStorage.setItem(TOKEN_KEY, 'old');
    const replaceState = vi.fn();
    const c = loadCredentials(localStorage, { hash: '', pathname: '/', search: '?x=1' }, { replaceState });
    expect(c).toEqual({ token: 'old', device: 'desktop' });
    expect(replaceState).not.toHaveBeenCalled();
  });
  it('keeps the stored device when only the token is given', () => {
    localStorage.setItem(DEVICE_KEY, 'tablet');
    const c = loadCredentials(localStorage, { hash: '#t=new', pathname: '/p', search: '?q' }, { replaceState: vi.fn() });
    expect(c).toEqual({ token: 'new', device: 'tablet' });
  });
  it('ignores an unrelated hash', () => {
    const replaceState = vi.fn();
    expect(loadCredentials(localStorage, { hash: '#foo', pathname: '/', search: '' }, { replaceState }).token).toBe('');
    expect(replaceState).not.toHaveBeenCalled();
  });
});
