import { AlertReader } from './alert-reader';
import { goSignIn } from './auth';
import { Capture } from './audio/capture';
import { ALARM_SOUNDS, Alarm, ChimeRules, pickRing } from './audio/chime';
import { msToSamples, samplesToMs } from './audio/pcm';
import { Playback } from './audio/playback';
import { AdaptiveVolume, volumeOptions } from './audio/volume';
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
import { PresenceMachine, showScreen } from './presence';
import type { AlertItem, ConvState, ServerMessage, TimerItem, TurnDoneMsg } from './protocol';
import { BlobRenderer, type FrameInput } from './render/blob';
import { CLOCK_AFTER_MS, CLOCK_TURN_MS, WEATHER_TURN_MS, type Sky } from './render/tables';
import { computeView, overlayActive, setsOverlay, timerText, timersNow, topAlert, turnActive, type View } from './state';
import { decideTap } from './taps';
import { TurnClient, type TurnDeps } from './turn-client';
import { NEGATIVE, VadController } from './vad';
import type { Detector, WakeConfig } from './wake/detector';
import { PcmRing, PhraseSegmenter, ScoreHistory } from './wake/clips';
import { FollowUp, gateReason, wakeAllowed } from './wake/wake-gate';
import { MicStats, PeakTracker, type WakePeak } from './wake/wake-log';
import { NightMode, shownAlerts } from './night';
import { checkVersion, entryBundle } from './version';
import { keepAwake } from './wakelock';
import { WEATHER_POLL_MS, fetchWeather, restShows, skyOf, stripHtml, type Weather } from './weather';
import { BlobSocket, type SocketStatus } from './ws';

const $ = (id: string) => document.getElementById(id) as HTMLElement;

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
let timers: TimerItem[] = [];
let timersAt = 0; // performance.now() when `timers` arrived
let lastPlaybackEnd: number | null = null;

// Hands-free (device wake=true): shared mic, wake word and VAD in one worker.
let handsFree = false;
let detector: Detector | null = null;
let wakeCfg: WakeConfig | null = null;
let wakeReady = false;
let wakeOn = false; // the wake word ran on the last audio block
let wakeVerifier = false; // the custom verifier loaded
const wakeStats = { score: 0, max: 0, detections: 0 };
let peaks: PeakTracker | null = null;
const mic = new MicStats();
const MIC_LOG_MS = 10_000;

// Wake word clips for retraining (wake_clip; the backend keeps them only with
// DEBUG_AUDIO_DIR set). Normal use: the last 3 s around each attempt the wake
// word heard. Enrollment (open the page with ?enroll=pos to say the wake phrase
// over and over, ?enroll=neg to talk about anything else): one clip per phrase,
// and no turns start.
const CLIP_MS = 3000;
const SCORE_LAG_MS = 1300; // the score peaks up to this long after the phrase
const enroll = ((l) => (l === 'pos' || l === 'neg' ? l : null))(new URLSearchParams(location.search).get('enroll'));
const ring = new PcmRing(msToSamples(CLIP_MS));
const segmenter = new PhraseSegmenter();
const scores = new ScoreHistory();
const enrolled = { sent: 0, last: 0 };

function sendClip(label: 'pos' | 'neg' | 'auto', peak: number, pcm: Int16Array): void {
  if (!deviceConfig.debug_audio || !pcm.length) return;
  const sent = sock.send({ type: 'wake_clip', label, peak, dur_ms: samplesToMs(pcm.length) }, pcm.buffer as ArrayBuffer);
  if (sent && label !== 'auto') {
    enrolled.sent += 1;
    enrolled.last = peak;
  }
  showEnroll();
}

function showEnroll(): void {
  if (!enroll) return;
  const el = $('enroll');
  el.hidden = false;
  el.textContent = !deviceConfig.debug_audio
    ? 'Enrollment needs DEBUG_AUDIO_DIR on the server'
    : `${enroll === 'pos' ? `Say "${wakeCfg?.phrase ?? 'hey blob'}", pause, repeat` : 'Talk about anything else'}` +
      ` · ${enrolled.sent} sent · last ${enrolled.last.toFixed(2)} · now ${wakeStats.score.toFixed(2)}`;
}

// Every 10 s on a hands-free page: is audio arriving, how loud, and the state
// of the AudioContext and the microphone track (client_event `mic`).
function logMic(): void {
  const t = capture.track;
  const s = t?.getSettings();
  sock.send({
    type: 'client_event',
    kind: 'mic',
    ...mic.take(),
    volume: volume.state(),
    ctx: ctx.state,
    rate: ctx.sampleRate,
    visible: document.visibilityState,
    track: t ? { label: t.label, muted: t.muted, enabled: t.enabled, state: t.readyState } : null,
    settings: s ? { rate: s.sampleRate, ec: s.echoCancellation, ns: s.noiseSuppression, agc: s.autoGainControl } : null,
  });
}
const followup = new FollowUp();
const vad = new VadController(() => detector?.reset(false, true));

// Adaptive volume (audio/volume.ts): softer at night, louder over a noisy room.
const volume = new AdaptiveVolume(
  {
    quietForMs: () => playback.quietForMs(),
    speech: () => vad.active && vad.lastP >= NEGATIVE,
    night: () => deviceConfig.night,
    log: (e) => sock.send({ type: 'client_event', kind: 'volume', ...e }),
  },
  volumeOptions(location.search),
);
playback.gainFor = (kind) => volume.gain(kind);
capture.onBlock = (pcm) => volume.hear(pcm);

// Audio is locked until a user gesture lets the AudioContext run.
const audioLocked = () => ctx.state !== 'running';
const syncAudioLock = () => faults.set('audio_locked', audioLocked());
ctx.onstatechange = () => {
  syncAudioLock();
  if (handsFree) sock.send({ type: 'client_event', kind: 'audio_ctx', state: ctx.state });
};
syncAudioLock();

// Set when the wake word read the alert: once it is read, listen for what the
// person wanted to say, without the wake word again.
let listenAfterRead = false;
const reader = new AlertReader({
  send: (m) => sock.send(m),
  play: (wav) => playback.play(wav, null),
  beep: () => {
    listenAfterRead = false;
    void playback.effect('/beep.wav');
  },
  read: () => {
    if (!listenAfterRead) return;
    listenAfterRead = false;
    if (handsFree) turn.startTurn('followup');
  },
});
const chime = new ChimeRules(() => deviceConfig);
// A turn is under way: the backend's, this page's reply playing, or this page's own request.
const turnBusy = () => turnActive({ conv, playing: turnPlaying() }) || turn.phase !== 'idle';
let lastRing = -1;
const alarm = new Alarm({
  ring: (gain) => {
    const r = pickRing(lastRing, ALARM_SOUNDS.length, Math.random);
    lastRing = r.index;
    void playback.effect(ALARM_SOUNDS[r.index], gain, r.rate);
  },
  hush: () => reader.reading || turnBusy(),
});

// Playback of a turn reply (an alert being read aloud is not a turn).
const turnPlaying = () => playback.playing && !reader.reading;
const overlay = () => overlayActive(overlaySince, performance.now(), turnPlaying());

// Night mode: the blob sleeps (dim, slow) and only urgent alerts show and ring.
const night = new NightMode({
  hours: () => deviceConfig.night,
  apply(dim, fps) {
    renderer?.setDim('night', dim);
    renderer?.setMaxFps('night', fps);
    document.body.classList.toggle('night', dim < 1);
  },
  onChange: () => checkChime(),
});
const shown = () => shownAlerts(alerts, night.on);
const nightTick = () => {
  const v = view();
  night.update((v !== 'idle' && v !== 'offline' && v !== 'alert') || alarm.ringing || reader.reading);
};
setInterval(nightTick, 250);

function view(): View {
  return computeView({ online: socketStatus === 'open', conv, playing: turnPlaying(), overlay: overlay(), alerts: shown() });
}

let idleSince = performance.now(); // start of the current unbroken idle stretch
const presence = new PresenceMachine(() => deviceConfig.presence_sleep_s * 1000); // room sensor: rest and sleep
let weather: Weather | null = null;
let stripRoom = 0.25; // share of the screen's height the weather strip takes at the bottom (measured)

// After CLOCK_AFTER_MS of idle the blob rests: as a clock, taking turns with
// the sky outside when the backend has the weather.
function rest(now: number): 'none' | 'clock' | 'weather' {
  const ms = presence.restMs(now, idleSince, CLOCK_AFTER_MS);
  if (ms < 0 || night.on) return 'none'; // at night the blob sleeps instead
  return weather ? restShows(ms, CLOCK_TURN_MS, WEATHER_TURN_MS) : 'clock';
}

function frameInput(): FrameInput {
  const v = view();
  const now = performance.now();
  if (v !== 'idle') idleSince = now;
  showScreen(presence.screen(now, idleSince, v === 'idle'), renderer);
  faults.set('mic_denied', capture.status === 'denied');
  const level =
    v === 'listening' ? capture.level() : v === 'speaking' || v === 'error' || v === 'alert' ? playback.level() : 0;
  const r = rest(now);
  const sky: Sky | null = r === 'weather' && weather ? skyOf(weather) : null;
  return {
    view: v,
    level,
    alert: v === 'alert' ? topAlert(shown()) : null,
    clock: r !== 'none' ? new Date() : null,
    weather: sky,
    room: weather && r !== 'none' ? stripRoom : 0,
    sleep: night.asleep,
    timers: timersNow(timers, (now - timersAt) / 1000),
    fired: alerts.map((a) => a.key),
  };
}

// The strip under the resting blob: the next hours beside the clock, the week (and the
// temperature now) beside the sky.
let weatherShown = '';
function showWeather(): void {
  const el = $('weather');
  const r = view() === 'idle' ? rest(performance.now()) : 'none';
  const html = weather && r !== 'none' ? stripHtml(weather, r) : '';
  el.classList.toggle('on', !!html);
  if (html && html !== weatherShown) el.innerHTML = weatherShown = html;
  if (html) stripRoom = Math.min(0.5, Math.max(0, 1 - el.getBoundingClientRect().top / innerHeight));
}
setInterval(showWeather, 500);

async function pollWeather(): Promise<void> {
  weather = (await fetchWeather()) ?? weather;
}
void pollWeather();
setInterval(() => void pollWeather(), WEATHER_POLL_MS);

// A new alert rings a calm alarm (random bubbles for up to 30 s, swelling), held
// while a turn is active (design, Display rules). It stops early on a tap, a
// turn, or once the alert is gone.
function checkChime(): void {
  alarm.update(shown().map((a) => a.key)); // an info alert ringing at nightfall goes quiet
  if (!configLoaded) return; // the sound flag is not known yet
  const active = turnBusy();
  if (active) alarm.stop();
  if (chime.update(alerts, active, night.on)) alarm.start(chime.fired);
}

// After a reply with followup=true has played, listen once more without the wake word.
function maybeFollowup(): void {
  if (handsFree && followup.take(playback.playing, turn.phase) && !turn.startTurn('followup')) followup.clear();
}

const gateInput = () => ({
  enabled: handsFree && wakeReady,
  phase: turn.phase,
  conv,
  playing: playback.playing || reader.reading,
  lastPlaybackEnd,
  followup: followup.active,
  now: performance.now(),
});
const gateOpen = () => wakeAllowed(gateInput());

// Wake log (backend standard output, client_event lines): each attempt's peak
// score, and when and why the detector stops and starts.
function logPeak(p: WakePeak | null): void {
  if (!p) return;
  sock.send({ type: 'client_event', kind: 'wake_peak', ...p });
  if (!enroll) sendClip('auto', p.peak, ring.take(msToSamples(CLIP_MS)));
}

// Every 20 ms block of the shared stream: to the wake word (only while the gate
// is open) and to the VAD (only while a turn listens).
function routeAudio(pcm: Int16Array): void {
  mic.add(pcm);
  ring.push(pcm);
  const phrase = enroll ? segmenter.push(pcm) : null;
  if (phrase && enroll) {
    const end = performance.now();
    const from = end - samplesToMs(phrase.length);
    setTimeout(() => sendClip(enroll, scores.peak(from, end + SCORE_LAG_MS), phrase), SCORE_LAG_MS);
  }
  const why = gateReason(gateInput());
  const wake = why === 'open';
  if (wake && !wakeOn) detector?.reset(true, false); // no audio from before the mute
  if (wake !== wakeOn && wakeReady) {
    if (!wake) logPeak(peaks?.flush(performance.now()) ?? null);
    sock.send({ type: 'client_event', kind: 'wake_gate', on: wake, why });
  }
  wakeOn = wake;
  detector?.push(pcm, wake, vad.active);
}

function onWakeScore(score: number): void {
  wakeStats.score = score;
  wakeStats.max = Math.max(wakeStats.max, score);
  scores.add(score, performance.now());
  logPeak(peaks?.score(score, performance.now()) ?? null);
  if (enroll) return showEnroll(); // enrollment: scores only, no turns
  if (!wakeCfg || score < wakeCfg.threshold || !gateOpen()) return;
  night.poke();
  nightTick();
  logPeak(peaks?.flush(performance.now()) ?? null); // the detector stops now: report this attempt first
  // An alert waiting (its alarm may be ringing): read it first, then listen.
  const a = view() === 'alert' ? topAlert(shown()) : null;
  if (a) {
    alarm.stop();
    reader.read(a.key);
    if (reader.key === a.key) {
      listenAfterRead = true;
      wakeStats.detections += 1;
      renderer?.flash();
    }
    return;
  }
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
  peaks = new PeakTracker(cfg.threshold);
  detector = new Detector(cfg, {
    onReady(wake, vadOk, verifierOk) {
      wakeReady = wake;
      wakeVerifier = verifierOk;
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
    const t = capture.track;
    for (const ev of ['mute', 'unmute', 'ended'] as const) {
      t?.addEventListener(ev, () => sock.send({ type: 'client_event', kind: 'mic_track', event: ev, ctx: ctx.state }));
    }
    setInterval(logMic, MIC_LOG_MS);
  } catch {
    micDenied();
  }
}

function micDenied(): void {
  faults.set('mic_denied', true);
  sock.send({ type: 'client_event', kind: 'fault', fault: 'mic_denied' });
}

// A reconnect usually means a deploy. PAGE_VERSION is the protocol version, so
// hello_ok does not reload a page built before it: compare the entry bundle.
async function reloadIfRebuilt(): Promise<void> {
  const mine = entryBundle(document.documentElement.outerHTML);
  if (!mine) return;
  try {
    const res = await fetch('/', { cache: 'no-store' });
    const served = res.ok ? entryBundle(await res.text()) : null;
    if (served && served !== mine) location.reload();
  } catch {
    // Offline again: the next reconnect checks again.
  }
}

// Signed out (no session cookie, or it expired): off to Pocket ID, back here afterwards.
function signedOut(): void {
  faults.set('signed_out', true);
  goSignIn();
}

const sock = new BlobSocket({
  url: wsUrl(),
  version: PAGE_VERSION,
  onHelloOk(m) {
    const action = checkVersion(m.version, PAGE_VERSION);
    if (action === 'reload') location.reload();
    if (action === 'stop') faults.set('version', true);
    return action === 'ok';
  },
  onStatus(s) {
    socketStatus = s;
    if (s === 'open' && everOpen) void reloadIfRebuilt();
    everOpen ||= s === 'open';
    faults.set('socket_down', s === 'down' || (s === 'connecting' && everOpen));
    if (s === 'signed_out') signedOut();
    if (s !== 'open') {
      presence.report(null, null, performance.now()); // unknown until the backend says again
      // The backend cancels the turn when the socket closes.
      reader.reset();
      listenAfterRead = false;
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
    // How the turn started (tap, wake, followup), next to the backend's timing line for turn t.
    sock.send({ type: 'client_event', kind: 'turn_start', turn: t, how: turn.kind });
  },
  onMicDenied: micDenied,
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
      timers = Array.isArray(m.timers) ? m.timers : [];
      timersAt = performance.now();
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
    case 'presence':
      presence.report(m.present, m.since_s, performance.now(), idleSince, view() === 'idle');
      break;
    case 'hello_ok':
    case 'pong':
      break;
  }
}

function onTap(): void {
  alarm.stop(); // any tap silences a ringing alert
  night.poke(); // and wakes a sleeping blob
  nightTick();
  if (diag.open) {
    diag.hide();
    return;
  }
  const locked = audioLocked();
  void ctx.resume(); // on every tap (design: Sound targets)
  if (presence.tap(performance.now(), idleSince, view() === 'idle')) return; // the dark screen only wakes
  if (enroll) return; // enrollment: a tap only unlocks the audio
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
      const a = topAlert(shown());
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
  device: deviceConfig.device || 'unknown',
  socket: socketStatus,
  mic: capture.status,
  audio: ctx.state,
  view: view(),
  phase: turn.phase,
  fault: faults.current ?? 'none',
  frame_ms: renderer ? Math.round(renderer.frameMs * 10) / 10 : 'no WebGL',
  last_turn: lastTurn
    ? { turn: lastTurn.turn, reason: lastTurn.reason, timeout_kind: lastTurn.timeout_kind, ...lastTurn.timings }
    : 'none',
  device_config: deviceConfig,
  alerts: alerts.map((a) => `${a.key}:${a.source}:${a.urgency}`).join(' ') || 'none',
  night: deviceConfig.night ? { on: night.on, asleep: night.asleep, dim: renderer?.dim, max_fps: renderer?.maxFps } : 'off',
  timers: timerText(timers, (performance.now() - timersAt) / 1000) || 'none',
  wake: handsFree
    ? {
        phrase: wakeCfg?.phrase,
        model: wakeCfg?.model,
        verifier: wakeCfg?.verifier ? wakeVerifier : 'none',
        threshold: wakeCfg?.threshold,
        enroll: enroll ?? 'off',
        ready: wakeReady,
        running: wakeOn,
        score: +wakeStats.score.toFixed(3),
        max: +wakeStats.max.toFixed(3),
        detections: wakeStats.detections,
      }
    : 'off (tap only)',
  vad: turnDeps.vad ? { listening: vad.active, p: +vad.lastP.toFixed(2) } : 'off',
  presence: { present: presence.present, screen: presence.screen(performance.now(), idleSince, view() === 'idle') },
  volume: volume.state(),
}));

onPress(document.body, onTap, () => diag.show());
keepAwake();
void fetchDeviceConfig().then((c) => {
  if (c === 'signed_out') return signedOut();
  deviceConfig = c;
  configLoaded = true;
  capture.silenceRms = c.silence_rms;
  checkChime();
  showEnroll();
  if (c.wake || enroll) void startHandsFree();
});

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
  // setDim(v) for the film strip, or setDim(source, v) like night mode does.
  setDim(a: number | string, b?: number) {
    if (typeof a === 'string') renderer?.setDim(a, b ?? 1);
    else renderer?.setDim('debug', a);
  },
  get night() {
    return { on: night.on, asleep: night.asleep, dim: renderer?.dim ?? 1, maxFps: renderer?.maxFps ?? Infinity, shown: shown().map((a) => a.key) };
  },
  // `clock`: a local time such as '2026-01-01T09:41', to draw the idle clock.
  // `alert`: the top alert drawn when `v` is 'alert'.
  // `weather`: the sky drawn when `v` is 'idle' (before the clock).
  // `sleep`: night mode's sleeping blob. `timers`, `fired`: pending timers (seconds left) and active alert keys, for the droplets.
  step(dtS: number, v: View, level: number, draw: boolean, clock?: string, alert?: FrameInput['alert'], weather?: Sky, sleep?: boolean, timers?: FrameInput['timers'], fired?: FrameInput['fired']) {
    renderer?.step(dtS, { view: v, level, clock: clock ? new Date(clock) : null, alert, weather, sleep, timers, fired }, draw);
  },
  // Pretends the page has been idle for `ms` (the clock appears after CLOCK_AFTER_MS).
  idleFor(ms: number) {
    idleSince = performance.now() - ms;
  },
  get alerts() {
    return alerts.map((a) => a.key);
  },
  get droplets() {
    return renderer?.droplets ?? [];
  },
  get topAlert() {
    return topAlert(shown())?.key ?? null;
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
  get volume() {
    return volume.state();
  },
  get alarms() {
    return alarm.started;
  },
  get alarmRinging() {
    return alarm.ringing;
  },
  get reading() {
    return reader.reading;
  },
  get handsFree() {
    return { on: handsFree, wakeReady, vad: !!turnDeps.vad, wakeOn, followup: followup.active, threshold: wakeCfg?.threshold, ...wakeStats };
  },
  get screen() {
    return { presence: presence.present, asleep: renderer?.dark ?? false, dim: renderer?.dim ?? 1, maxFps: renderer?.maxFps ?? Infinity, drawn: renderer?.drawn ?? 0 };
  },
  get turnKind() {
    return turn.kind;
  },
  // Starts a little act now (names in ACTS, render/acts.ts).
  act(name: string) {
    renderer?.play(name);
  },
  get weather() {
    return weather;
  },
  // Screenshot scripts only. No view: hold the current frame (a mid-morph
  // capture). With a view: stop and restart that view's motion at zero (film strip).
  freeze(v?: View, clock?: string, alert?: FrameInput['alert'], sky?: Sky, sleep?: boolean) {
    if (v) renderer?.freeze(v, clock ? new Date(clock) : null, alert, sky, sleep);
    else renderer?.stop();
  },
};
