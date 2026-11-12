import {
  CLOSE_BAD_TOKEN,
  SERVER_BINARY_TYPES,
  parseServerMessage,
  type ClientMessage,
  type HelloOkMsg,
  type ServerMessage,
} from './protocol';

export type SocketStatus = 'connecting' | 'open' | 'down' | 'bad_token' | 'stopped';

export const PING_MS = 20_000;
export const PONG_TIMEOUT_MS = 45_000;
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

export function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** attempt);
}

export interface SocketOptions {
  url: string;
  token: string;
  device: string;
  version: string;
  onMessage(msg: ServerMessage, binary: ArrayBuffer | null): void;
  onStatus(status: SocketStatus): void;
  // Return false to stop for good (version guard); the socket is then closed.
  onHelloOk(msg: HelloOkMsg): boolean;
  createSocket?: (url: string) => WebSocket;
}

export class BlobSocket {
  status: SocketStatus = 'connecting';
  private ws: WebSocket | null = null;
  private ready = false;
  private attempt = 0;
  private pendingHeader: ServerMessage | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private lastPong = 0;
  private readonly opts: SocketOptions;

  constructor(opts: SocketOptions) {
    this.opts = opts;
    this.connect();
  }

  get isReady(): boolean {
    return this.ready;
  }

  // Sends a JSON message and, when given, its binary frame right after it.
  send(msg: ClientMessage, binary?: ArrayBuffer): boolean {
    if (!this.ws || !this.ready || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    if (binary) this.ws.send(binary);
    return true;
  }

  stop(): void {
    this.setStatus('stopped');
    this.teardown();
  }

  private connect(): void {
    this.setStatus('connecting');
    const ws = (this.opts.createSocket ?? ((u) => new WebSocket(u)))(this.opts.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', version: this.opts.version, token: this.opts.token, device: this.opts.device }));
      this.lastPong = Date.now();
      this.pingTimer = setInterval(() => this.ping(), PING_MS);
    };
    ws.onmessage = (ev: MessageEvent) => this.receive(ev.data);
    ws.onclose = (ev: CloseEvent) => this.closed(ev.code);
  }

  private ping(): void {
    if (Date.now() - this.lastPong > PONG_TIMEOUT_MS) {
      // Half-open socket (e.g. Wi-Fi dropped): do not wait for the browser to notice.
      this.teardown();
      this.closed(1006);
      return;
    }
    this.ws?.send(JSON.stringify({ type: 'ping' }));
  }

  private receive(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const header = this.pendingHeader;
      this.pendingHeader = null;
      if (header) this.opts.onMessage(header, data);
      return; // a frame without a header is dropped
    }
    const msg = parseServerMessage(String(data));
    if (!msg) return;
    this.pendingHeader = null; // a header not followed by its frame is dropped
    if (msg.type === 'pong') this.lastPong = Date.now();
    if (SERVER_BINARY_TYPES.includes(msg.type)) {
      this.pendingHeader = msg;
      return;
    }
    if (msg.type === 'hello_ok') {
      if (!this.opts.onHelloOk(msg)) {
        this.stop();
        return;
      }
      this.ready = true;
      this.attempt = 0;
      this.setStatus('open');
    }
    this.opts.onMessage(msg, null);
  }

  private closed(code: number): void {
    this.teardown();
    if (this.status === 'stopped' || this.status === 'bad_token') return;
    if (code === CLOSE_BAD_TOKEN) {
      this.setStatus('bad_token');
      return;
    }
    this.setStatus('down');
    this.retryTimer = setTimeout(() => this.connect(), backoffMs(this.attempt));
    this.attempt += 1;
  }

  private teardown(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    this.ready = false;
    this.pendingHeader = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  }

  private setStatus(s: SocketStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus(s);
  }
}
