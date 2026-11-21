import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMIT_DBFS, LIMIT_MAKEUP_DB, Playback } from './playback';

// Minimal Web Audio fake: buffers carry their duration in the first byte.
class FakeSource {
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  startedAt = -1;
  stopped = false;
  playbackRate = { value: 1 };
  to: unknown = null;
  connect<T>(n: T): T {
    this.to = n;
    return n;
  }
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
// A gain whose automation is reduced to "value from time t on".
class FakeGain {
  events: [number, number][] = [];
  gain: { value: number; setValueAtTime: (v: number, t: number) => void };
  constructor() {
    this.gain = {
      value: 1,
      setValueAtTime: (v, t) => {
        this.events.push([v, t]);
        this.gain.value = v;
      },
    };
  }
  connect<T>(n: T): T {
    return n;
  }
}
class FakeCtx {
  currentTime = 0;
  sources: FakeSource[] = [];
  destination = {};
  decodeAudioData = vi.fn(async (b: ArrayBuffer) => ({ duration: new Uint8Array(b)[0] }));
  createAnalyser() {
    return { fftSize: 0, connect: <T>(n: T) => n, getFloatTimeDomainData: (a: Float32Array) => a.fill(0.1) };
  }
  gains: FakeGain[] = [];
  compressors: Record<string, { value: number }>[] = [];
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createDynamicsCompressor() {
    const c = { threshold: { value: 0 }, knee: { value: 0 }, ratio: { value: 0 }, attack: { value: 0 }, release: { value: 0 } };
    this.compressors.push(c);
    return { ...c, connect: <T>(n: T) => n };
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

  it('an effect can play softer and detuned (the alarm)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wav(1))));
    await pb.effect('/bubble-a.wav', 0.5, 1.1);
    const s = ctx.sources[0];
    expect(s.playbackRate.value).toBe(1.1);
    expect((s.to as { gain: { value: number } }).gain.value).toBe(0.5);
    vi.unstubAllGlobals();
  });
});

describe('Playback volume', () => {
  // gains[0] is the voice gain, gains[1] the bus in front of the limiter.
  const voice = () => ctx.gains[0];

  it('takes the voice gain when a reply starts from silence and keeps it for the whole reply', async () => {
    let g = 0.5;
    pb.gainFor = vi.fn(() => g);
    ctx.currentTime = 3;
    await pb.play(wav(2), 1);
    g = 2; // the noise estimate moves while the reply plays
    await pb.play(wav(2), 1); // next chunk of the same reply
    expect(voice().events).toEqual([[0.5, 3]]);
    expect(pb.gainFor).toHaveBeenCalledTimes(1);
    expect(pb.gainFor).toHaveBeenCalledWith('voice');
  });

  it('takes a new voice gain for the next reply, once the last one ended or was stopped', async () => {
    let g = 0.5;
    pb.gainFor = () => g;
    await pb.play(wav(1), 1);
    ctx.sources[0].end();
    g = 1.5;
    ctx.currentTime = 10;
    await pb.play(wav(1), 2);
    pb.newTurn(3); // stopped by a new turn
    g = 0.8;
    await pb.play(wav(1), 3);
    expect(voice().events).toEqual([
      [0.5, 0],
      [1.5, 10],
      [0.8, 10],
    ]);
  });

  it('an effect takes the chime gain on top of its own', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wav(1))));
    pb.gainFor = (k) => (k === 'chime' ? 2 : 0.1);
    await pb.effect('/bubble-a.wav', 0.5);
    expect((ctx.sources[0].to as FakeGain).gain.value).toBe(1);
    vi.unstubAllGlobals();
  });

  it('the limiter: threshold, and the bus takes its makeup gain back off', () => {
    expect(ctx.compressors[0].threshold.value).toBe(LIMIT_DBFS);
    expect(LIMIT_MAKEUP_DB).toBeCloseTo(1.71, 2); // 0.6 × 3 × 0.95, as Chromium applies it
    expect(20 * Math.log10(ctx.gains[1].gain.value)).toBeCloseTo(-LIMIT_MAKEUP_DB, 6);
  });

  it('reports how long it has been silent, for the noise estimate', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(wav(1))));
    expect(pb.quietForMs()).toBe(Infinity);
    ctx.currentTime = 5;
    await pb.play(wav(2), 1);
    ctx.currentTime = 6;
    expect(pb.quietForMs()).toBe(0); // playing until 7
    ctx.currentTime = 7.5;
    expect(pb.quietForMs()).toBe(500);
    await pb.play(wav(3), 2);
    ctx.currentTime = 8;
    pb.stopAll(); // a tap stops the reply at 8
    ctx.currentTime = 8.25;
    expect(pb.quietForMs()).toBe(250);
    await pb.effect('/bubble-a.wav', 1, 0.5); // 1 s at half speed: 2 s, until 10.25
    ctx.currentTime = 10;
    expect(pb.quietForMs()).toBe(0);
    ctx.currentTime = 11.25;
    expect(pb.quietForMs()).toBe(1000);
    vi.unstubAllGlobals();
  });
});
