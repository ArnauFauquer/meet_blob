// Mock Blob backend for the page e2e tests: serves web/dist and implements the
// WebSocket contract of protocol/messages.json with a real turn lock shared by
// all connections. The device name picks a scenario for flows a real backend
// cannot be told to produce:
//   empty, hermes_fail, tts_fail, not_ready, version (hello_ok with another
//   version), slow (5 s thinking, 8 s reply), drop (the first socket is killed after hello_ok).
// Any other name is a normal turn. Device flags (GET /device-config): a name
// starting with "hf-" has wake=true, a name containing "sound" has sound=true.
// A name containing "followup" gets tts.followup=true on a turn not started by
// a follow-up. Alerts (S4): POST/GET/DELETE /alerts with MOCK_ALERT_TOKEN; an
// alert_read of a key starting with "ttsfail" answers error{bad_message} (synthesis failure).
// Run: node e2e/mock-backend.ts (PORT, MOCK_TOKEN, MOCK_ALERT_TOKEN, MOCK_STATIC).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { speechLike, wav } from './wav.ts';

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.MOCK_TOKEN ?? 'test-token';
const ALERT_TOKEN = process.env.MOCK_ALERT_TOKEN ?? 'alert-token';
const STATIC = process.env.MOCK_STATIC ?? fileURLToPath(new URL('../dist', import.meta.url));
const MAX_FRAME = 1 << 20;

const REPLY = wav(speechLike(24000, 2.5, 0.2), 24000);
const LONG_REPLY = wav(speechLike(24000, 8, 0.2), 24000);
const FALLBACK = wav(speechLike(24000, 3.5, 0.1, 180), 24000); // about one spoken sentence
const ALERT_SPEECH = wav(speechLike(24000, 1.5, 0.1, 200), 24000);

interface Alert {
  key: string;
  source: string;
  urgency: 'info' | 'urgent';
  text: string;
  lang: string;
  late: boolean;
  activated_at: number;
  state: 'pending' | 'active' | 'acked';
  fire_at: number | null;
  timer?: ReturnType<typeof setTimeout>;
}
const alerts = new Map<string, Alert>();
const activeAlerts = () =>
  [...alerts.values()]
    .filter((a) => a.state === 'active')
    .sort((a, b) => a.activated_at - b.activated_at || (a.key < b.key ? -1 : 1))
    .map(({ key, source, urgency, text, lang, late, activated_at }) => ({ key, source, urgency, text, lang, late, activated_at }));

interface Conn {
  ws: WebSocket;
  hello: boolean;
  device: string;
  pendingUtterance: { turn: number; dur_ms: number } | null;
}
const wakeDevice = (d: string) => d.startsWith('hf-');
interface Turn {
  id: number;
  conn: Conn;
  followup: boolean; // started by wake{followup:true}
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
    send(c, { type: 'snapshot', conv, alerts: activeAlerts() });
  }
}
function broadcastSnapshot() {
  for (const c of conns) if (c.hello) send(c, { type: 'snapshot', conv, alerts: activeAlerts() });
}
function activate(a: Alert) {
  a.state = 'active';
  a.activated_at = Math.floor(Date.now() / 1000);
  broadcastSnapshot();
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
  const followup = scenario.includes('followup') && !t.followup;
  sendBinary(t.conn, { type: 'tts', turn: t.id, alert: null, seq: 0, final: true, followup }, scenario === 'slow' ? LONG_REPLY : REPLY);
  finish(t, 'ok');
}

// A tap, or a wake (allowed only for wake devices), starts a turn.
function startTurn(c: Conn, followup: boolean) {
  if (c.device === 'not_ready') return send(c, { type: 'error', code: 'not_ready' });
  if (turn) return send(c, { type: 'error', code: 'busy' });
  const t: Turn = { id: ++lastTurnId, conn: c, followup, done: false, watchdog: setTimeout(() => finish(t, 'timeout'), 30_000) };
  turn = t;
  setConv('listening', t.id);
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
    send(c, { type: 'snapshot', conv, alerts: activeAlerts() });
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
    case 'wake':
      console.log(JSON.stringify({ kind: 'mock_wake', device: c.device, followup: m.followup }));
      if (!wakeDevice(c.device)) return send(c, { type: 'error', code: 'bad_message' });
      return startTurn(c, m.followup === true);
    case 'tap':
      return startTurn(c, false);
    case 'alert_read': {
      const a = alerts.get(String(m.key));
      if (turn || !a || a.state !== 'active' || a.key.startsWith('ttsfail')) return send(c, { type: 'error', code: 'bad_message' });
      return sendBinary(c, { type: 'tts', turn: null, alert: a.key, seq: 0, final: true, followup: false }, ALERT_SPEECH);
    }
    case 'alert_ack': {
      const a = alerts.get(String(m.key));
      console.log(JSON.stringify({ kind: 'mock_alert_ack', key: m.key }));
      if (a && a.state === 'active') {
        a.state = 'acked';
        broadcastSnapshot();
      }
      return;
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
    const device = url.searchParams.get('device') ?? '';
    res.setHeader('content-type', 'application/json');
    return res.end(
      JSON.stringify({
        device,
        sound: device.includes('sound'),
        wake: wakeDevice(device),
        quiet_hours: '',
        followup_listen_s: 6,
        listen_no_speech_s: 8,
        silence_rms: 0.01,
      }),
    );
  }
  if (url.pathname === '/alerts' || url.pathname.startsWith('/alerts/')) return alertsApi(req, res, url);
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

// A small subset of the real /alerts API (docs/alerts.md): enough for the e2e flows.
async function alertsApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.headers.authorization !== `Bearer ${ALERT_TOKEN}`) return res.writeHead(401).end();
  res.setHeader('content-type', 'application/json');
  if (req.method === 'GET' && url.pathname === '/alerts') {
    return res.end(JSON.stringify([...alerts.values()].map(({ key, state, fire_at }) => ({ key, state, fire_at }))));
  }
  if (req.method === 'DELETE') {
    const key = decodeURIComponent(url.pathname.slice('/alerts/'.length));
    const a = alerts.get(key);
    clearTimeout(a?.timer);
    if (alerts.delete(key) && a?.state === 'active') broadcastSnapshot();
    return res.writeHead(204).end();
  }
  if (req.method !== 'POST' || url.pathname !== '/alerts') return res.writeHead(405).end();
  let body: Record<string, unknown>;
  try {
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return res.writeHead(422).end();
  }
  const key = String(body.key ?? '');
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(key) || typeof body.source !== 'string' || typeof body.text !== 'string') {
    return res.writeHead(422).end();
  }
  const old = alerts.get(key);
  clearTimeout(old?.timer);
  const inS = typeof body.in_s === 'number' ? body.in_s : 0;
  const a: Alert = {
    key,
    source: body.source,
    urgency: (body.urgency as Alert['urgency']) ?? (body.source === 'timer' ? 'urgent' : 'info'),
    text: body.text,
    lang: String(body.lang ?? 'es'),
    late: false,
    activated_at: 0,
    state: 'pending',
    fire_at: inS > 0 ? Math.floor(Date.now() / 1000) + inS : null,
  };
  alerts.set(key, a);
  if (inS > 0) a.timer = setTimeout(() => activate(a), inS * 1000);
  else activate(a);
  res.writeHead(old ? 200 : 201);
  return res.end(JSON.stringify({ key, state: a.state, fire_at: a.fire_at }));
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
