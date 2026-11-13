import { AlertReader } from './alert-reader';
import { Capture } from './audio/capture';
import { CHIME_URL, ChimeRules } from './audio/chime';
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
import type { AlertItem, ConvState, ServerMessage, TurnDoneMsg } from './protocol';
import { BlobRenderer, type FrameInput } from './render/blob';
import { computeView, overlayActive, setsOverlay, topAlert, turnActive, type View } from './state';
import { decideTap } from './taps';
import { loadCredentials } from './token';
import { TurnClient, type TurnDeps } from './turn-client';
import { VadController } from './vad';
import type { Detector, WakeConfig } from './wake/detector';
import { FollowUp, wakeAllowed } from './wake/wake-gate';
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
let configLoaded = false;
let alerts: AlertItem[] = [];
let lastPlaybackEnd: number | null = null;

// Hands-free (device wake=true): shared mic, wake word and VAD in one worker.
let handsFree = false;
let detector: Detector | null = null;
let wakeCfg: WakeConfig | null = null;
let wakeReady = false;
let wakeOn = false; // the wake word ran on the last audio block
const wakeStats = { score: 0, max: 0, detections: 0 };
const followup = new FollowUp();
const vad = new VadController(() => detector?.reset(false, true));

// Audio is locked until a user gesture lets the AudioContext run.
const audioLocked = () => ctx.state !== 'running';
const syncAudioLock = () => faults.set('audio_locked', audioLocked());
ctx.onstatechange = syncAudioLock;
syncAudioLock();

const reader = new AlertReader({
  send: (m) => sock.send(m),
  play: (wav) => playback.play(wav, null),
  beep: () => void playback.effect('/beep.wav'),
});
const chime = new ChimeRules(() => deviceConfig);

// Playback of a turn reply (an alert being read aloud is not a turn).
const turnPlaying = () => playback.playing && !reader.reading;
const overlay = () => overlayActive(overlaySince, performance.now(), turnPlaying());

function view(): View {
  return computeView({ online: socketStatus === 'open', conv, playing: turnPlaying(), overlay: overlay(), alerts });
}

function frameInput(): FrameInput {
  const v = view();
  faults.set('mic_denied', capture.status === 'denied');
  const level =
    v === 'listening' ? capture.level() : v === 'speaking' || v === 'error' || v === 'alert' ? playback.level() : 0;
  return { view: v, level, alert: v === 'alert' ? topAlert(alerts) : null };
}

// Chime once per new alert, held while a turn is active (design, Display rules).
function checkChime(): void {
  if (!configLoaded) return; // the sound flag is not known yet
  const active = turnActive({ conv, playing: turnPlaying() }) || turn.phase !== 'idle';
  if (chime.update(alerts, active)) void playback.effect(CHIME_URL);
}

// After a reply with followup=true has played, listen once more without the wake word.
function maybeFollowup(): void {
  if (handsFree && followup.take(playback.playing, turn.phase) && !turn.startTurn('followup')) followup.clear();
}

const gateOpen = () =>
  wakeAllowed({
    enabled: handsFree && wakeReady,
    phase: turn.phase,
    conv,
    playing: playback.playing || reader.reading,
    lastPlaybackEnd,
    followup: followup.active,
    now: performance.now(),
  });

// Every 20 ms block of the shared stream: to the wake word (only while the gate
// is open) and to the VAD (only while a turn listens).
function routeAudio(pcm: Int16Array): void {
  const wake = gateOpen();
  if (wake && !wakeOn) detector?.reset(true, false); // no audio from before the mute
  wakeOn = wake;
  detector?.push(pcm, wake, vad.active);
}

function onWakeScore(score: number): void {
  wakeStats.score = score;
  wakeStats.max = Math.max(wakeStats.max, score);
  if (!wakeCfg || score < wakeCfg.threshold || !gateOpen()) return;
  if (turn.startTurn('wake')) {
    wakeStats.detections += 1;
    renderer?.flash();
  }
}

async function startHandsFree(): Promise<void> {
  handsFree = true;
  const { Detector, loadWakeConfig } = await import('./wake/detector');
  const cfg = await loadWakeConfig();
  wakeCfg = cfg;
  detector = new Detector(cfg, {
    onReady(wake, vadOk) {
      wakeReady = wake;
      if (vadOk) turnDeps.vad = vad;
    },
    onScore: onWakeScore,
    onVad: (p) => vad.onProb(p),
    onError(what, message) {
      if (what === 'wake') wakeReady = false;
      faults.set('wake', true);
      sock.send({ type: 'client_event', kind: 'fault', fault: `${what}_failed`, message });
    },
  });
  capture.onFrame = routeAudio;
  try {
    await capture.openShared();
  } catch {
    faults.set('mic_denied', true);
    sock.send({ type: 'client_event', kind: 'fault', fault: 'mic_denied' });
  }
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
      reader.reset();
      followup.clear();
      turn.reset();
      playback.stopAll();
    }
  },
  onMessage: handle,
});

const turnDeps: TurnDeps = {
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
  noSpeechMs: () => ({ listen: deviceConfig.listen_no_speech_s * 1000, followup: deviceConfig.followup_listen_s * 1000 }),
  onListenEnd(kind) {
    if (kind === 'followup') followup.closed();
  },
};
const turn = new TurnClient(turnDeps);

playback.onIdle = () => {
  lastPlaybackEnd = performance.now();
  reader.onPlaybackIdle();
  maybeFollowup();
  checkChime();
};

function handle(m: ServerMessage, binary: ArrayBuffer | null): void {
  switch (m.type) {
    case 'snapshot':
      conv = m.conv;
      alerts = Array.isArray(m.alerts) ? m.alerts : [];
      turn.onState({ conv: m.conv, turn: null });
      checkChime();
      break;
    case 'state':
      conv = m.conv;
      turn.onState(m);
      checkChime();
      break;
    case 'tts':
      if (m.alert != null) {
        reader.onTts(m, binary);
        break;
      }
      if (binary) void playback.play(binary, m.turn);
      // tts.followup is also set for wake=false devices; only a hands-free page acts on it.
      if (handsFree && m.turn === turn.turn) followup.onTts(m.followup === true);
      break;
    case 'turn_done':
      lastTurn = m;
      turn.onTurnDone(m);
      if (setsOverlay(m.reason)) overlaySince = performance.now();
      if (m.reason === 'tts_fail') void playback.beep();
      maybeFollowup();
      checkChime();
      break;
    case 'error':
      reader.onError(m);
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
  const action = decideTap({
    audioLocked: locked,
    overlay: overlay(),
    playing: turnPlaying(),
    phase: turn.phase,
    alert: view() === 'alert',
    alertReading: reader.reading,
  });
  switch (action) {
    case 'read_alert': {
      const a = topAlert(alerts);
      if (a) reader.read(a.key);
      break;
    }
    case 'stop_fallback':
      playback.stopAll();
      break;
    case 'stop_and_cancel':
    case 'cancel':
      followup.clear();
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
  alerts: alerts.map((a) => `${a.key}:${a.source}:${a.urgency}`).join(' ') || 'none',
  wake: handsFree
    ? { phrase: wakeCfg?.phrase, model: wakeCfg?.model, ready: wakeReady, running: wakeOn, score: +wakeStats.score.toFixed(3), max: +wakeStats.max.toFixed(3), detections: wakeStats.detections }
    : 'off (tap only)',
  vad: turnDeps.vad ? { listening: vad.active, p: +vad.lastP.toFixed(2) } : 'off',
}));

onPress(document.body, onTap, () => diag.show());
keepAwake();
void fetchDeviceConfig(creds.token, creds.device).then((c) => {
  deviceConfig = c;
  configLoaded = true;
  capture.silenceRms = c.silence_rms;
  checkChime();
  if (c.wake) void startHandsFree();
});

// Read-only hooks for the e2e tests and the screenshot script.
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
  get alerts() {
    return alerts.map((a) => a.key);
  },
  get topAlert() {
    return topAlert(alerts)?.key ?? null;
  },
  get shape() {
    const u = renderer?.uniforms;
    if (!u) return null;
    const c = u.uColor.value as { x: number; y: number; z: number };
    return { a: u.uShapeA.value, b: u.uShapeB.value, mix: u.uMix.value, color: [c.x, c.y, c.z] };
  },
  get effects() {
    return playback.effects;
  },
  get reading() {
    return reader.reading;
  },
  get handsFree() {
    return { on: handsFree, wakeReady, vad: !!turnDeps.vad, wakeOn, followup: followup.active, ...wakeStats };
  },
  get turnKind() {
    return turn.kind;
  },
  // Screenshot script only: hold the current frame (a mid-morph capture).
  freeze() {
    renderer?.stop();
  },
};
