import { describe, expect, it } from 'vitest';
import { FAULTS, FaultLine } from './fault';

describe('FaultLine', () => {
  it('shows the most important active fault and notifies on change only', () => {
    const seen: string[] = [];
    const f = new FaultLine((t) => seen.push(t));
    f.set('audio_locked', true);
    f.set('audio_locked', true);
    expect(f.text).toBe(FAULTS.audio_locked);
    f.set('socket_down', true);
    expect(f.current).toBe('socket_down');
    f.set('socket_down', false);
    expect(f.current).toBe('audio_locked');
    f.set('audio_locked', false);
    expect(f.text).toBe('');
    expect(seen).toEqual([FAULTS.audio_locked, FAULTS.socket_down, FAULTS.audio_locked, '']);
  });
  it('orders bad token and version above a dropped socket', () => {
    const f = new FaultLine(() => {});
    f.set('socket_down', true);
    f.set('mic_denied', true);
    f.set('version', true);
    expect(f.current).toBe('version');
    f.set('bad_token', true);
    expect(f.current).toBe('bad_token');
  });
});
