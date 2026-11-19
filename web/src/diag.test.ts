import { afterEach, describe, expect, it, vi } from 'vitest';
import { Diag } from './diag';

describe('Diag', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stops refreshing once hidden, even after a second long press while open', () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const el = document.createElement('div');
    el.hidden = true;
    const source = vi.fn(() => ({ socket: 'open' }));
    const diag = new Diag(el, source);
    diag.show();
    diag.show(); // a long press while it is already open
    diag.hide();
    source.mockClear();
    vi.advanceTimersByTime(2000);
    expect(source).not.toHaveBeenCalled();
  });
});
