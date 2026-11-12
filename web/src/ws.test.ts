import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BlobSocket, PING_MS, backoffMs, type SocketOptions } from './ws';
import type { ServerMessage } from './protocol';

class FakeSocket {
  static all: FakeSocket[] = [];
  readyState: number = WebSocket.CONNECTING;
  binaryType = '';
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  close() {
    this.readyState = WebSocket.CLOSED;
  }
  open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }
  json(m: object) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  bin(b: ArrayBuffer) {
    this.onmessage?.({ data: b });
  }
  drop(code = 1006) {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code });
  }
  sentJson() {
    return this.sent.filter((d) => typeof d === 'string').map((d) => JSON.parse(d as string));
  }
}

const last = () => FakeSocket.all[FakeSocket.all.length - 1];

function make(over: Partial<SocketOptions> = {}) {
  const got: [ServerMessage, ArrayBuffer | null][] = [];
  const statuses: string[] = [];
  const sock = new BlobSocket({
    url: 'ws://x/ws',
    token: 'tok',
    device: 'desk',
    version: '1.0',
    onMessage: (m, b) => got.push([m, b]),
    onStatus: (s) => statuses.push(s),
    onHelloOk: () => true,
    createSocket: (u) => new FakeSocket(u) as unknown as WebSocket,
    ...over,
  });
  return { sock, got, statuses };
}

function openAndHello(version = '1.0') {
  last().open();
  last().json({ type: 'hello_ok', version, ok: true });
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('BlobSocket', () => {
  it('sends hello first and is ready only after hello_ok', () => {
    const { sock, statuses } = make();
    last().open();
    expect(last().sentJson()[0]).toEqual({ type: 'hello', version: '1.0', token: 'tok', device: 'desk' });
    expect(sock.send({ type: 'tap' })).toBe(false);
    last().json({ type: 'hello_ok', version: '1.0', ok: true });
    expect(sock.send({ type: 'tap' })).toBe(true);
    expect(statuses).toContain('open');
  });

  it('stops without retry when the version guard refuses hello_ok', () => {
    const { statuses } = make({ onHelloOk: (m) => m.version === '1.0' });
    openAndHello('2.0');
    expect(statuses).toContain('stopped');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('pairs a tts header with the next binary frame', () => {
    const { got } = make();
    openAndHello();
    const wav = new ArrayBuffer(8);
    last().json({ type: 'tts', turn: 3, alert: null, seq: 0, final: true, followup: false });
    expect(got.filter(([m]) => m.type === 'tts')).toHaveLength(0);
    last().bin(wav);
    const tts = got.find(([m]) => m.type === 'tts');
    expect(tts?.[1]).toBe(wav);
  });

  it('drops an unannounced binary frame and a header without its frame', () => {
    const { got } = make();
    openAndHello();
    last().bin(new ArrayBuffer(4));
    last().json({ type: 'tts', turn: 3, alert: null, seq: 0, final: true, followup: false });
    last().json({ type: 'pong' });
    last().bin(new ArrayBuffer(4));
    expect(got.map(([m]) => m.type)).toEqual(['hello_ok', 'pong']);
  });

  it('sends a JSON header then its binary frame', () => {
    const { sock } = make();
    openAndHello();
    const pcm = new ArrayBuffer(320);
    sock.send({ type: 'utterance', turn: 1, format: 'pcm_s16le', rate: 16000, dur_ms: 10, tail_silence_ms: 0 }, pcm);
    const s = last().sent;
    expect(JSON.parse(s[s.length - 2] as string).type).toBe('utterance');
    expect(s[s.length - 1]).toBe(pcm);
  });

  it('reconnects with backoff from 1 s doubling to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    const { statuses } = make();
    last().drop();
    expect(statuses).toContain('down');
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    last().drop();
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    // a successful hello_ok resets the backoff
    openAndHello();
    last().drop();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it('does not retry after close code 4401', () => {
    const { statuses } = make();
    last().open();
    last().drop(4401);
    expect(statuses[statuses.length - 1]).toBe('bad_token');
    vi.advanceTimersByTime(120_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('pings every 20 s and reconnects when pongs stop', () => {
    make();
    openAndHello();
    vi.advanceTimersByTime(PING_MS);
    expect(last().sentJson().filter((m) => m.type === 'ping')).toHaveLength(1);
    last().json({ type: 'pong' });
    vi.advanceTimersByTime(PING_MS * 2);
    expect(FakeSocket.all).toHaveLength(1);
    // no pong for more than 45 s: the socket is dropped and a new one opens
    vi.advanceTimersByTime(PING_MS);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('ignores unknown and malformed server messages', () => {
    const { got } = make();
    openAndHello();
    last().json({ type: 'mystery' });
    last().onmessage?.({ data: '{bad' });
    expect(got.map(([m]) => m.type)).toEqual(['hello_ok']);
  });
});
