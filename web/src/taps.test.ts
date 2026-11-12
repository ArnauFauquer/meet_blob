import { describe, expect, it } from 'vitest';
import { decideTap, type TapContext } from './taps';

const idle: TapContext = { audioLocked: false, overlay: false, playing: false, phase: 'idle' };

describe('tap table (first matching row wins)', () => {
  it('audio locked: only unlocks, whatever else is true', () => {
    expect(decideTap({ ...idle, audioLocked: true })).toBe('unlock');
    expect(decideTap({ audioLocked: true, overlay: true, playing: true, phase: 'listening' })).toBe('unlock');
  });
  it('fallback audio playing under the grey overlay: stops it', () => {
    expect(decideTap({ ...idle, overlay: true, playing: true })).toBe('stop_fallback');
  });
  it('speaking: stops playback and cancels', () => {
    expect(decideTap({ ...idle, playing: true })).toBe('stop_and_cancel');
    expect(decideTap({ ...idle, playing: true, phase: 'thinking' })).toBe('stop_and_cancel');
  });
  it('thinking: cancels', () => {
    expect(decideTap({ ...idle, phase: 'thinking' })).toBe('cancel');
  });
  it('listening: sends the utterance', () => {
    expect(decideTap({ ...idle, phase: 'listening' })).toBe('send_utterance');
  });
  it('a second tap before the state arrives is ignored', () => {
    expect(decideTap({ ...idle, phase: 'requested' })).toBe('ignore');
  });
  it('idle, or error overlay with nothing playing: starts a turn', () => {
    expect(decideTap(idle)).toBe('start_turn');
    expect(decideTap({ ...idle, overlay: true })).toBe('start_turn');
  });
});
