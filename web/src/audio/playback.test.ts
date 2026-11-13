import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Playback } from './playback';

// Minimal Web Audio fake: buffers carry their duration in the first byte.
class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt = -1;
  stopped = false;
  connect() {}
  start(t: number) {
    this.startedAt = t;
  }
  stop() {
    this.stopped = true;
  }
  end() {
    this.onended?.();
  }
}
class FakeCtx {
  currentTime = 0;
  sources: FakeSource[] = [];
  destination = {};
  decodeAudioData = vi.fn(async (b: ArrayBuffer) => ({ duration: new Uint8Array(b)[0] }));
  createAnalyser() {
    return { fftSize: 0, connect() {}, getFloatTimeDomainData: (a: Float32Array) => a.fill(0.1) };
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

const wav = (seconds: number) => Uint8Array.of(seconds).buffer;

let ctx: FakeCtx;
let pb: Playback;
beforeEach(() => {
  ctx = new FakeCtx();
  pb = new Playback(ctx as unknown as BaseAudioContext, '/beep.wav');
});

describe('Playback', () => {
  it('schedules chunks back to back: nextT = max(now, nextT) + duration', async () => {
    pb.newTurn(1);
    ctx.currentTime = 10;
    await pb.play(wav(2), 1);
    await pb.play(wav(3), 1);
    expect(ctx.sources.map((s) => s.startedAt)).toEqual([10, 12]);
    ctx.currentTime = 20; // queue drained: starts now, not at 15
    ctx.sources.forEach((s) => s.end());
    await pb.play(wav(1), 1);
    expect(ctx.sources[2].startedAt).toBe(20);
  });

  it('is playing until the last source ends, then calls onIdle', async () => {
    const idle = vi.fn();
    pb.onIdle = idle;
    await pb.play(wav(1), 1);
    await pb.play(wav(1), 1);
    expect(pb.playing).toBe(true);
    ctx.sources[0].end();
    expect(idle).not.toHaveBeenCalled();
    ctx.sources[1].end();
    expect(pb.playing).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('drops audio of a stale turn', async () => {
    pb.newTurn(5);
    expect(await pb.play(wav(1), 4)).toBe(false);
    expect(ctx.sources).toHaveLength(0);
    expect(await pb.play(wav(1), 5)).toBe(true);
  });

  it('a new turn stops the old audio and resets nextT', async () => {
    await pb.play(wav(5), 1);
    pb.newTurn(2);
    expect(ctx.sources[0].stopped).toBe(true);
    expect(pb.playing).toBe(false);
    ctx.currentTime = 1;
    await pb.play(wav(1), 2);
    expect(ctx.sources[1].startedAt).toBe(1);
  });

  it('cancel stops everything and drops later chunks of that turn', async () => {
    await pb.play(wav(5), 3);
    pb.cancel();
    expect(ctx.sources[0].stopped).toBe(true);
    expect(await pb.play(wav(1), 3)).toBe(false);
    expect(await pb.play(wav(1), 4)).toBe(true); // the next turn plays again
  });

  it('drops a chunk whose decode finishes after a stop', async () => {
    let release: (v: { duration: number }) => void = () => {};
    ctx.decodeAudioData.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const p = pb.play(wav(1), 1);
    expect(pb.playing).toBe(true); // decoding counts as playing
    pb.stopAll();
    release({ duration: 1 });
    expect(await p).toBe(false);
    expect(ctx.sources).toHaveLength(0);
  });

  it('plays the local beep on demand, and the beep can be stopped', async () => {
    const fetchMock = vi.fn(async () => new Response(wav(1)));
    vi.stubGlobal('fetch', fetchMock);
    expect(await pb.beep()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/beep.wav');
    expect(pb.playing).toBe(true);
    pb.stopAll();
    expect(ctx.sources[0].stopped).toBe(true);
    expect(pb.playing).toBe(false);
    await pb.beep();
    expect(fetchMock).toHaveBeenCalledTimes(1); // fetched once
    vi.unstubAllGlobals();
  });

  it('fallback audio (a turn reply under the overlay) is stoppable like any source', async () => {
    await pb.play(wav(3), 8);
    pb.stopAll();
    expect(ctx.sources[0].stopped).toBe(true);
    expect(pb.playing).toBe(false);
  });

  it('reports the output level only while playing', async () => {
    expect(pb.level()).toBe(0);
    await pb.play(wav(1), 1);
    expect(pb.level()).toBeCloseTo(0.4);
  });

  it('an effect (chime) plays outside any turn: not playing, not stopped by stopAll', async () => {
    const fetchMock = vi.fn(async () => new Response(wav(1)));
    vi.stubGlobal('fetch', fetchMock);
    expect(await pb.effect('/chime.wav')).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/chime.wav');
    expect(pb.effects).toBe(1);
    expect(pb.playing).toBe(false);
    pb.stopAll();
    expect(ctx.sources[0].stopped).toBe(false);
    await pb.effect('/chime.wav');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
