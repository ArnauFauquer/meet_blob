import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnClient, type Mic, type TurnDeps } from './turn-client';
import type { ClientMessage } from './protocol';
import type { Recording } from './audio/pcm';

const CAP = 15_000;

function setup(micResult: 'ok' | 'denied' = 'ok') {
  const sent: [ClientMessage, ArrayBuffer | undefined][] = [];
  const rec: Recording = { pcm: new Int16Array(16_000), durMs: 1000, tailSilenceMs: 240 };
  let onCap = () => {};
  const mic = {
    start: vi.fn((cb: () => void) => {
      onCap = cb;
      return micResult === 'ok' ? Promise.resolve() : Promise.reject(new DOMException('denied', 'NotAllowedError'));
    }),
    stop: vi.fn(() => rec),
    close: vi.fn(),
  } satisfies Mic;
  const deps: TurnDeps = {
    send: (m, b) => {
      sent.push([m, b]);
      return true;
    },
    mic,
    capMs: CAP,
    onTurn: vi.fn(),
    onMicDenied: vi.fn(),
    onBusy: vi.fn(),
  };
  const tc = new TurnClient(deps);
  return { tc, sent, mic, deps, rec, cap: () => onCap() };
}

const types = (sent: [ClientMessage, unknown][]) => sent.map(([m]) => m.type);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('TurnClient', () => {
  it('opens the mic only on the first state listening with a turn id', async () => {
    const { tc, sent, mic, deps } = setup();
    tc.startTurn();
    expect(types(sent)).toEqual(['tap']);
    expect(tc.phase).toBe('requested');
    tc.onState({ conv: 'listening', turn: null }); // a snapshot-like state without turn id
    tc.onState({ conv: 'idle', turn: null });
    expect(mic.start).not.toHaveBeenCalled();
    tc.onState({ conv: 'listening', turn: 7 });
    expect(mic.start).toHaveBeenCalledTimes(1);
    expect(deps.onTurn).toHaveBeenCalledWith(7);
    expect(tc.phase).toBe('listening');
    tc.onState({ conv: 'listening', turn: 7 }); // repeated state: no second mic
    expect(mic.start).toHaveBeenCalledTimes(1);
  });

  it('a double tap before the state arrives sends one tap', () => {
    const { tc, sent } = setup();
    tc.startTurn();
    tc.startTurn();
    expect(types(sent)).toEqual(['tap']);
  });

  it('the stop tap sends utterance with dur_ms and tail_silence_ms, then the PCM', async () => {
    const { tc, sent, mic, rec } = setup();
    tc.startTurn();
    tc.onState({ conv: 'listening', turn: 3 });
    await tc.sendUtterance();
    expect(mic.stop).toHaveBeenCalled();
    const [msg, bin] = sent[1];
    expect(msg).toEqual({ type: 'utterance', turn: 3, format: 'pcm_s16le', rate: 16000, dur_ms: 1000, tail_silence_ms: 240 });
    expect(bin).toBe(rec.pcm.buffer);
    expect(tc.phase).toBe('thinking');
    await tc.sendUtterance(); // a second stop does nothing
    expect(sent).toHaveLength(2);
  });

  it('sends no binary frame for a zero-length utterance', async () => {
    const { tc, sent, mic } = setup();
    mic.stop.mockReturnValue({ pcm: new Int16Array(0), durMs: 0, tailSilenceMs: 0 });
    tc.startTurn();
    tc.onState({ conv: 'listening', turn: 3 });
    await tc.sendUtterance();
    expect(sent[1]).toEqual([expect.objectContaining({ type: 'utterance', dur_ms: 0 }), undefined]);
  });

  it('stops at the 15 s cap', async () => {
    const { tc, sent } = setup();
    tc.startTurn();
    tc.onState({ conv: 'listening', turn: 1 });
    await vi.advanceTimersByTimeAsync(CAP - 1);
    expect(types(sent)).toEqual(['tap']);
    await vi.advanceTimersByTimeAsync(1);
    expect(types(sent)).toEqual(['tap', 'utterance']);
  });

  it('stops when the recorder reports the cap first', async () => {
    const { tc, sent, cap } = setup();
    tc.startTurn();
    tc.onState({ conv: 'listening', turn: 1 });
    cap();
    await vi.advanceTimersByTimeAsync(0);
    expect(types(sent)).toEqual(['tap', 'utterance']);
    await vi.advanceTimersByTimeAsync(CAP);
    expect(types(sent)).toEqual(['tap', 'utterance']);
  });

  it('on busy ignores the tap, flashes, and closes a mic opened for another device', () => {
    const { tc, deps, mic } = setup();
    tc.startTurn();
    tc.onError({ type: 'error', code: 'busy' });
    expect(tc.phase).toBe('idle');
    expect(deps.onBusy).toHaveBeenCalled();
    tc.startTurn();
    tc.onState({ conv: 'listening', turn: 9 });
    tc.onError({ type: 'error', code: 'busy' });
    expect(mic.close).toHaveBeenCalled();
    expect(tc.phase).toBe('idle');
  });

  it('not_ready ends the request without a flash', () => {
    const { tc, deps } = setup();
    tc.startTurn();
    tc.onError({ type: 'error', code: 'not_ready' });
    expect(tc.phase).toBe('idle');
    expect(deps.onBusy).not.toHaveBeenCalled();
  });

  it('on mic denial sends cancel and reports the fault', async () => {
    const { tc, sent, deps } = setup('denied');
    tc.startTurn();
    tc.onState({ conv: 'listening', turn: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[1][0]).toEqual({ type: 'cancel', turn: 4 });
    expect(deps.onMicDenied).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CAP); // no utterance from the cap timer
    expect(types(sent)).toEqual(['tap', 'cancel']);
    tc.onTurnDone({ type: 'turn_done', turn: 4, reason: 'cancel', timeout_kind: null, timings: { stt_ms: null, hermes_ms: null, tts_ms: null, first_audio_ms: null, sc1_ms: null } });
    expect(tc.phase).toBe('idle');
  });

  it('cancel while thinking sends cancel once and waits for turn_done', async () => {
    const { tc, sent } = setup();
    tc.startTurn();
    tc.onState({ conv: 'listening', turn: 5 });
    await tc.sendUtterance();
    tc.cancel();
    expect(sent[2][0]).toEqual({ type: 'cancel', turn: 5 });
    expect(tc.phase).toBe('thinking');
    tc.onState({ conv: 'idle', turn: null });
    expect(tc.phase).toBe('idle');
  });

  it('cancel after turn_done (speaking tap) still names the turn', async () => {
    const { tc, sent } = setup();
    tc.startTurn();
    tc.onState({ conv: 'listening', turn: 6 });
    await tc.sendUtterance();
    tc.onTurnDone({ type: 'turn_done', turn: 6, reason: 'ok', timeout_kind: null, timings: { stt_ms: 1, hermes_ms: 1, tts_ms: 1, first_audio_ms: 1, sc1_ms: 1 } });
    tc.cancel();
    expect(sent[sent.length - 1][0]).toEqual({ type: 'cancel', turn: 6 });
  });

  it('reset closes the mic (socket dropped)', () => {
    const { tc, mic } = setup();
    tc.startTurn();
    tc.onState({ conv: 'listening', turn: 1 });
    tc.reset();
    expect(mic.close).toHaveBeenCalled();
    expect(tc.phase).toBe('idle');
  });

  it('does not send a tap while the socket is not ready', () => {
    const { tc, deps } = setup();
    deps.send = () => false;
    tc.startTurn();
    expect(tc.phase).toBe('idle');
  });
});
