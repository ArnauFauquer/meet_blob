// Mock Blob backend for the page e2e tests: serves web/dist and implements the
// WebSocket contract of protocol/messages.json with a real turn lock shared by
// all connections. The device name picks a scenario for flows a real backend
// cannot be told to produce:
//   empty, hermes_fail, tts_fail, not_ready, version (hello_ok with another
//   version), slow (5 s thinking), drop (the first socket is killed after hello_ok).
// Any other name is a normal turn. Run: node e2e/mock-backend.ts (PORT, MOCK_TOKEN, MOCK_STATIC).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { speechLike, wav } from './wav.ts';

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.MOCK_TOKEN ?? 'test-token';
const STATIC = process.env.MOCK_STATIC ?? fileURLToPath(new URL('../dist', import.meta.url));
const MAX_FRAME = 1 << 20;

const REPLY = wav(speechLike(24000, 2.5, 0.2), 24000);
const FALLBACK = wav(speechLike(24000, 1.5, 0.1, 180), 24000);

interface Conn {
  ws: WebSocket;
  hello: boolean;
  device: string;
  pendingUtterance: { turn: number; dur_ms: number } | null;
}
interface Turn {
  id: number;
  conn: Conn;
  done: boolean;
  watchdog: ReturnType<typeof setTimeout>;
}

const conns = new Set<Conn>();
const dropped = new Set<string>();
let conv: 'idle' | 'listening' | 'thinking' | 'speaking' = 'idle';
let lastTurnId = 0;
let turn: Turn | null = null;

const send = (c: Conn, m: object) => c.ws.readyState === c.ws.OPEN && c.ws.send(JSON.stringify(m));
const sendBinary = (c: Conn, m: object, bin: Buffer) => {
  send(c, m);
  if (c.ws.readyState === c.ws.OPEN) c.ws.send(bin);
};
function setConv(next: typeof conv, id: number | null) {
  conv = next;
  for (const c of conns) {
    if (!c.hello) continue;
    send(c, { type: 'state', conv, turn: id });
    send(c, { type: 'snapshot', conv, alerts: [] });
  }
}

function finish(t: Turn, reason: string) {
  if (t.done) return;
  t.done = true;
  clearTimeout(t.watchdog);
  send(t.conn, {
    type: 'turn_done',
    turn: t.id,
    reason,
    timeout_kind: null,
    timings: { stt_ms: 120, hermes_ms: 300, tts_ms: 80, first_audio_ms: 500, sc1_ms: 700 },
  });
  if (turn === t) turn = null;
  setConv('idle', null);
}

async function runTurn(t: Turn, durMs: number) {
  if (durMs === 0) return finish(t, 'empty');
  setConv('thinking', t.id);
  const scenario = t.conn.device;
  await new Promise((r) => setTimeout(r, scenario === 'slow' ? 5000 : 400));
  if (t.done) return; // cancelled meanwhile
  if (scenario === 'empty') return finish(t, 'empty');
  if (scenario === 'tts_fail') return finish(t, 'tts_fail');
  if (scenario === 'hermes_fail') {
    setConv('speaking', t.id);
    sendBinary(t.conn, { type: 'tts', turn: t.id, alert: null, seq: 0, final: true, followup: false }, FALLBACK);
    return finish(t, 'hermes_fail');
  }
  setConv('speaking', t.id);
  sendBinary(t.conn, { type: 'tts', turn: t.id, alert: null, seq: 0, final: true, followup: false }, REPLY);
  finish(t, 'ok');
}

function onMessage(c: Conn, data: RawData, isBinary: boolean) {
  if (isBinary) {
    const u = c.pendingUtterance;
    c.pendingUtterance = null;
    const size = (data as Buffer).length;
    if (!u || !turn || turn.id !== u.turn) return send(c, { type: 'error', code: 'bad_message' });
    if (size > MAX_FRAME) {
      send(c, { type: 'error', code: 'bad_message' });
      return finish(turn, 'cancel');
    }
    console.log(JSON.stringify({ kind: 'mock_audio', turn: u.turn, bytes: size, dur_ms: u.dur_ms }));
    void runTurn(turn, u.dur_ms);
    return;
  }
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(String(data));
    if (typeof m !== 'object' || m === null || typeof m.type !== 'string') throw new Error();
  } catch {
    return send(c, { type: 'error', code: 'bad_message' });
  }
  if (!c.hello) {
    if (m.type !== 'hello') return c.ws.close(4400, 'message before hello');
    if (m.token !== TOKEN) return c.ws.close(4401, 'bad token');
    c.hello = true;
    c.device = String(m.device ?? '');
    send(c, { type: 'hello_ok', version: c.device === 'version' ? 'mock-other-version' : m.version, ok: true });
    send(c, { type: 'snapshot', conv, alerts: [] });
    if (c.device === 'drop' && !dropped.has(c.device)) {
      dropped.add(c.device);
      setTimeout(() => c.ws.terminate(), 300);
    }
    return;
  }
  switch (m.type) {
    case 'ping':
      return send(c, { type: 'pong' });
    case 'client_event':
      return console.log(JSON.stringify({ ...m, kind: 'client_event', event: m.kind }));
    case 'tap': {
      if (c.device === 'not_ready') return send(c, { type: 'error', code: 'not_ready' });
      if (turn) return send(c, { type: 'error', code: 'busy' });
      const t: Turn = { id: ++lastTurnId, conn: c, done: false, watchdog: setTimeout(() => finish(t, 'timeout'), 30_000) };
      turn = t;
      return setConv('listening', t.id);
    }
    case 'utterance': {
      const ok = turn && turn.conn === c && m.turn === turn.id && conv === 'listening' && m.format === 'pcm_s16le' && Number(m.rate) === 16000;
      if (!ok || typeof m.dur_ms !== 'number' || typeof m.tail_silence_ms !== 'number') {
        return send(c, { type: 'error', code: 'bad_message' });
      }
      console.log(JSON.stringify({ kind: 'mock_utterance', ...m }));
      if (m.dur_ms === 0) return void runTurn(turn!, 0);
      c.pendingUtterance = { turn: m.turn as number, dur_ms: m.dur_ms };
      return;
    }
    case 'cancel':
      // A cancel for a turn that is already over is ignored.
      if (turn && turn.conn === c && m.turn === turn.id) finish(turn, 'cancel');
      return;
    default:
      return send(c, { type: 'error', code: 'bad_message' });
  }
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
};

async function serve(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/healthz') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ alive: true, ready: true, hermes_reachable: true }));
  }
  if (url.pathname === '/device-config') {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(401).end();
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ sound: false, wake: false, quiet_hours: '', followup_listen_s: 6, listen_no_speech_s: 8 }));
  }
  const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(STATIC, rel));
    res.setHeader('content-type', TYPES[extname(rel)] ?? 'application/octet-stream');
    // Like the real backend: index.html is always revalidated, hashed assets are not.
    if (rel === '/index.html') res.setHeader('cache-control', 'no-cache');
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

const server = createServer((req, res) => void serve(req, res));
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  const c: Conn = { ws, hello: false, device: '', pendingUtterance: null };
  conns.add(c);
  ws.on('message', (d, isBinary) => onMessage(c, d, isBinary));
  ws.on('close', () => {
    conns.delete(c);
    if (turn && turn.conn === c) finish(turn, 'cancel');
  });
});
server.listen(PORT, () => console.log(`mock backend on http://localhost:${PORT} serving ${STATIC}`));
