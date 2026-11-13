import { Capture } from './audio/capture';
import { Playback } from './audio/playback';
import {
  DEFAULT_DEVICE_CONFIG,
  PAGE_VERSION,
  RECORD_CAP_MS,
  SILENCE_RMS,
  fetchDeviceConfig,
  wsUrl,
} from './config';
import { Diag, onPress } from './diag';
import { FaultLine } from './fault';
import type { ConvState, ServerMessage, TurnDoneMsg } from './protocol';
import { BlobRenderer, type FrameInput } from './render/blob';
import { computeView, overlayActive, setsOverlay, type View } from './state';
import { decideTap } from './taps';
import { loadCredentials } from './token';
import { TurnClient } from './turn-client';
import { checkVersion } from './version';
import { keepAwake } from './wakelock';
import { BlobSocket, type SocketStatus } from './ws';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const creds = loadCredentials();
const faults = new FaultLine((text) => ($('fault').textContent = text));
const ctx = new AudioContext();
const playback = new Playback(ctx);
const capture = new Capture(ctx, RECORD_CAP_MS, SILENCE_RMS);

let socketStatus: SocketStatus = 'connecting';
let everOpen = false;
let conv: ConvState = 'idle';
let overlaySince: number | null = null;
let lastTurn: TurnDoneMsg | null = null;
let deviceConfig = DEFAULT_DEVICE_CONFIG;

// Audio is locked until a user gesture lets the AudioContext run.
const audioLocked = () => ctx.state !== 'running';
const syncAudioLock = () => faults.set('audio_locked', audioLocked());
ctx.onstatechange = syncAudioLock;
syncAudioLock();

const overlay = () => overlayActive(overlaySince, performance.now(), playback.playing);

function view(): View {
  return computeView({ online: socketStatus === 'open', conv, playing: playback.playing, overlay: overlay() });
}

function frameInput(): FrameInput {
  const v = view();
  faults.set('mic_denied', capture.status === 'denied');
  const level = v === 'listening' ? capture.level() : v === 'speaking' || v === 'error' ? playback.level() : 0;
  return { view: v, level };
}

const sock = new BlobSocket({
  url: wsUrl(),
  token: creds.token,
  device: creds.device,
  version: PAGE_VERSION,
  onHelloOk(m) {
    const action = checkVersion(m.version, PAGE_VERSION);
    if (action === 'reload') location.reload();
    if (action === 'stop') faults.set('version', true);
    return action === 'ok';
  },
  onStatus(s) {
    socketStatus = s;
    everOpen ||= s === 'open';
    faults.set('socket_down', s === 'down' || (s === 'connecting' && everOpen));
    faults.set('bad_token', s === 'bad_token');
    if (s !== 'open') {
      // The backend cancels the turn when the socket closes.
      turn.reset();
      playback.stopAll();
    }
  },
  onMessage: handle,
});

const turn = new TurnClient({
  send: (m, b) => sock.send(m, b),
  mic: capture,
  capMs: RECORD_CAP_MS,
  onTurn(t) {
    overlaySince = null;
    playback.newTurn(t);
  },
  onMicDenied() {
    faults.set('mic_denied', true);
    sock.send({ type: 'client_event', kind: 'fault', fault: 'mic_denied' });
  },
  onBusy: () => renderer?.flash(),
});

function handle(m: ServerMessage, binary: ArrayBuffer | null): void {
  switch (m.type) {
    case 'snapshot':
      conv = m.conv;
      turn.onState({ conv: m.conv, turn: null });
      break;
    case 'state':
      conv = m.conv;
      turn.onState(m);
      break;
    case 'tts':
      // S4: m.alert set means an alert read; not drawn or acked before S4.
      if (binary && m.alert === null) void playback.play(binary, m.turn);
      break;
    case 'turn_done':
      lastTurn = m;
      turn.onTurnDone(m);
      if (setsOverlay(m.reason)) overlaySince = performance.now();
      if (m.reason === 'tts_fail') void playback.beep();
      break;
    case 'error':
      turn.onError(m);
      if (m.code === 'not_ready') overlaySince = performance.now(); // models still loading: grey blob
      break;
    case 'hello_ok':
    case 'pong':
      break;
  }
}

function onTap(): void {
  if (diag.open) {
    diag.hide();
    return;
  }
  const locked = audioLocked();
  void ctx.resume(); // on every tap (design: Sound targets)
  const action = decideTap({ audioLocked: locked, overlay: overlay(), playing: playback.playing, phase: turn.phase });
  switch (action) {
    case 'stop_fallback':
      playback.stopAll();
      break;
    case 'stop_and_cancel':
    case 'cancel':
      playback.cancel();
      turn.cancel();
      break;
    case 'send_utterance':
      void turn.sendUtterance();
      break;
    case 'start_turn':
      turn.startTurn();
      break;
    case 'unlock':
    case 'ignore':
      break;
  }
}

let renderer: BlobRenderer | null = null;
try {
  renderer = new BlobRenderer($('blob') as HTMLCanvasElement, frameInput, (lost) => {
    faults.set('render', lost);
    if (lost) sock.send({ type: 'client_event', kind: 'fault', fault: 'webglcontextlost' });
  });
  renderer.start();
} catch {
  // No WebGL: the page still works by voice, with the fault line only.
  faults.set('render', true);
}

const diag = new Diag($('diag'), () => ({
  version: PAGE_VERSION,
  device: creds.device,
  socket: socketStatus,
  mic: capture.status,
  audio: ctx.state,
  view: view(),
  phase: turn.phase,
  fault: faults.current ?? 'none',
  frame_ms: renderer ? Math.round(renderer.frameMs * 10) / 10 : 'no WebGL',
  last_turn: lastTurn ? { turn: lastTurn.turn, reason: lastTurn.reason, timeout_kind: lastTurn.timeout_kind, ...lastTurn.timings } : 'none',
  device_config: deviceConfig,
}));

onPress(document.body, onTap, () => diag.show());
keepAwake();
void fetchDeviceConfig(creds.token, creds.device).then((c) => (deviceConfig = c));

// Hooks for the e2e tests and the screenshot scripts. Read-only except the
// debug clock (freeze, step) and the quality lock used by the film strip.
declare global {
  interface Window {
    blobDebug: Record<string, unknown>;
  }
}
window.blobDebug = {
  get view() {
    return view();
  },
  get audio() {
    return ctx.state;
  },
  get phase() {
    return turn.phase;
  },
  get started() {
    return playback.started;
  },
  get playing() {
    return playback.playing;
  },
  get maxLevel() {
    return renderer?.maxLevel ?? 0;
  },
  get fault() {
    return faults.current;
  },
  get renderLost() {
    return renderer?.lost ?? true;
  },
  get frameMs() {
    return renderer?.frameMs ?? 0;
  },
  get quality() {
    return renderer?.quality ?? -1;
  },
  setQuality(q: number) {
    if (!renderer) return;
    renderer.autoQuality = false;
    renderer.setQuality(q);
  },
  setDim(v: number) {
    if (renderer) renderer.dim = Math.max(0, Math.min(1, v));
  },
  freeze(v: View) {
    renderer?.freeze(v);
  },
  step(dtS: number, v: View, level: number, draw: boolean) {
    renderer?.step(dtS, { view: v, level }, draw);
  },
};
