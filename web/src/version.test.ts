import { beforeEach, describe, expect, it } from 'vitest';
import { RELOADED_FOR_KEY, checkVersion } from './version';

beforeEach(() => localStorage.clear());

describe('version guard', () => {
  it('accepts the same version', () => {
    expect(checkVersion('1.2.0', '1.2.0')).toBe('ok');
    expect(localStorage.getItem(RELOADED_FOR_KEY)).toBeNull();
  });
  it('reloads at most once per server version, then stops', () => {
    expect(checkVersion('1.3.0', '1.2.0')).toBe('reload');
    expect(localStorage.getItem(RELOADED_FOR_KEY)).toBe('1.3.0');
    expect(checkVersion('1.3.0', '1.2.0')).toBe('stop');
    expect(checkVersion('1.3.0', '1.2.0')).toBe('stop');
  });
  it('a newer server version gets its own reload', () => {
    checkVersion('1.3.0', '1.2.0');
    expect(checkVersion('1.4.0', '1.2.0')).toBe('reload');
  });
});
