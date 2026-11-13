import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TurnClient, type Mic, type TurnDeps } from './turn-client';
import type { ClientMessage } from './protocol';
import type { Recording } from './audio/pcm';
import type { EndpointLimits, Vad, VadEnd } from './vad';

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

describe('TurnClient hands-free (S3)', () => {
  function handsFree() {
    const t = setup();
    let end: (e: VadEnd) => void = () => {};
    const starts: EndpointLimits[] = [];
    const vad = {
      start: vi.fn((lim: EndpointLimits, cb: (e: VadEnd) => void) => {
        starts.push(lim);
        end = cb;
      }),
      stop: vi.fn(),
    } satisfies Vad;
    t.deps.vad = vad;
    t.deps.noSpeechMs = () => ({ listen: 8000, followup: 6000 });
    t.deps.onListenEnd = vi.fn();
    return { ...t, vad, starts, end: (e: VadEnd) => end(e) };
  }

  it('the wake word sends wake{followup:false} and listens with listen_no_speech_s', async () => {
    const { tc, sent, vad, starts } = handsFree();
    expect(tc.startTurn('wake')).toBe(true);
    expect(sent[0][0]).toEqual({ type: 'wake', followup: false });
    tc.onState({ conv: 'listening', turn: 3 });
    expect(vad.start).toHaveBeenCalledTimes(1);
    expect(starts[0].noSpeechMs).toBe(8000);
  });

  it('follow-up: wake{followup:true}, listens 6 s without the wake word', () => {
    const { tc, sent, starts, deps } = handsFree();
    tc.startTurn('followup');
    expect(sent[0][0]).toEqual({ type: 'wake', followup: true });
    tc.onState({ conv: 'listening', turn: 4 });
    expect(starts[0].noSpeechMs).toBe(6000);
    tc.onError({ type: 'error', code: 'busy' });
    expect(deps.onListenEnd).toHaveBeenCalledWith('followup');
  });

  it('VAD end of speech sends the utterance with its audio', async () => {
    const { tc, sent, vad, end, rec } = handsFree();
    tc.startTurn('wake');
    tc.onState({ conv: 'listening', turn: 5 });
    await vi.advanceTimersByTimeAsync(0);
    end('speech_end');
    await vi.advanceTimersByTimeAsync(0);
    const [u, bin] = sent[1];
    expect(u).toMatchObject({ type: 'utterance', turn: 5, dur_ms: rec.durMs });
    expect(bin).toBeDefined();
    expect(vad.stop).toHaveBeenCalled();
    expect(tc.phase).toBe('thinking');
  });

  it('no speech within the limit: zero-length utterance, no binary frame', async () => {
    const { tc, sent, mic, end, deps } = handsFree();
    tc.startTurn('wake');
    tc.onState({ conv: 'listening', turn: 6 });
    await vi.advanceTimersByTimeAsync(0);
    end('no_speech');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent[1]).toEqual([{ type: 'utterance', turn: 6, format: 'pcm_s16le', rate: 16000, dur_ms: 0, tail_silence_ms: 0 }, undefined]);
    expect(mic.stop).not.toHaveBeenCalled();
    expect(mic.close).toHaveBeenCalled();
    expect(deps.onListenEnd).toHaveBeenCalledWith('wake');
  });

  it('a VAD end after a stop tap sends nothing more', async () => {
    const { tc, sent, end } = handsFree();
    tc.startTurn();
    tc.onState({ conv: 'listening', turn: 7 });
    await vi.advanceTimersByTimeAsync(0);
    await tc.sendUtterance();
    end('no_speech');
    await vi.advanceTimersByTimeAsync(0);
    expect(types(sent)).toEqual(['tap', 'utterance']);
  });

  it('a refused wake (bad_message while requested) frees the client', () => {
    const { tc } = handsFree();
    tc.startTurn('wake');
    tc.onError({ type: 'error', code: 'bad_message' });
    expect(tc.phase).toBe('idle');
    expect(tc.startTurn('wake')).toBe(true);
  });

  it('a tap-only device has no VAD: the stop tap or the 15 s cap ends listening', async () => {
    const { tc, sent } = setup();
    tc.startTurn();
    tc.onState({ conv: 'listening', turn: 8 });
    await vi.advanceTimersByTimeAsync(CAP);
    expect(types(sent)).toEqual(['tap', 'utterance']);
  });
});
