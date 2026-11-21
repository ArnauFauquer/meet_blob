import { levelOf } from './pcm';
import type { SoundKind } from './volume';

// The peak limiter at the end of the chain. It only acts on what a volume
// boost (volume.ts) pushes above LIMIT_DBFS; Blob's sounds at 0 dB stay below
// it. A DynamicsCompressorNode adds a fixed makeup gain of
// 0.6 × |threshold| × (1 − 1/ratio) dB (Web Audio spec, measured in Chromium),
// which the bus gain in front of it takes back off, so audio below the
// threshold passes at exactly unity.
export const LIMIT_DBFS = -3;
export const LIMIT_RATIO = 20;
export const LIMIT_MAKEUP_DB = 0.6 * -LIMIT_DBFS * (1 - 1 / LIMIT_RATIO);

// Reply playback on the one AudioContext. Chunks are scheduled back to back
// (nextT = max(now, nextT) + duration). A new turn, a cancel or a tap stops
// every source and resets nextT; audio of a stale turn is dropped.
//
// Graph: reply sources → analyser (the blob's level) → voice gain → bus;
// effects → their own gain → bus; bus → limiter → speakers. The voice gain
// (adaptive volume) is taken only when nothing is playing, so it never changes
// inside a reply; an effect takes its gain when it starts.
export class Playback {
  private readonly ctx: BaseAudioContext;
  private readonly out: AnalyserNode;
  private readonly voice: GainNode;
  private readonly bus: GainNode;
  private voiceUntil = -Infinity; // context time the scheduled reply audio ends
  private effectUntil = -Infinity; // context time the last effect ends
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly buf = new Float32Array(1024);
  private nextT = 0;
  private turn: number | null = null;
  private cancelled = false;
  private gen = 0; // bumped by stopAll so a decode that finishes late is dropped
  private decoding = 0;
  private readonly files = new Map<string, Promise<ArrayBuffer | null>>();
  private readonly beepUrl: string;
  onIdle: () => void = () => {};
  started = 0; // sources started, for the diagnostics and the e2e tests
  effects = 0; // effect sounds started (e2e: the chime plays once)
  // The adaptive volume, as a linear gain for a sound that starts now.
  gainFor: (kind: SoundKind) => number = () => 1;

  constructor(ctx: BaseAudioContext, beepUrl = '/beep.wav') {
    this.ctx = ctx;
    this.beepUrl = beepUrl;
    this.out = ctx.createAnalyser();
    this.out.fftSize = 1024;
    this.voice = ctx.createGain();
    this.bus = ctx.createGain();
    this.bus.gain.value = 10 ** (-LIMIT_MAKEUP_DB / 20);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMIT_DBFS;
    limiter.knee.value = 0;
    limiter.ratio.value = LIMIT_RATIO;
    limiter.attack.value = 0.001; // measured in Chromium: no sample over full scale at +6 dB on Kokoro
    limiter.release.value = 0.15;
    this.out.connect(this.voice).connect(this.bus).connect(limiter).connect(ctx.destination);
  }

  // How long no sound of Blob's has been playing, in ms (0 while one plays).
  // The noise estimate (noise.ts) skips Blob's own sound and its echo.
  quietForMs(): number {
    return Math.max(0, (this.ctx.currentTime - Math.max(this.voiceUntil, this.effectUntil)) * 1000);
  }

  get playing(): boolean {
    return this.sources.size > 0 || this.decoding > 0;
  }

  // A new turn of this page starts: old audio stops.
  newTurn(turn: number): void {
    if (turn === this.turn) return;
    this.stopAll();
    this.turn = turn;
    this.cancelled = false;
  }

  cancel(): void {
    this.stopAll();
    this.cancelled = true;
  }

  // Plays one complete WAV for a turn. Returns false if it was dropped.
  async play(wav: ArrayBuffer, turn: number | null): Promise<boolean> {
    if (turn !== null) {
      if (this.turn !== null && turn < this.turn) return false;
      if (turn === this.turn && this.cancelled) return false;
      if (turn !== this.turn) this.newTurn(turn);
    }
    return this.decodeAndSchedule(wav);
  }

  // The local beep, played when speech output fails. It is not tied to a turn.
  async beep(): Promise<boolean> {
    const bytes = await this.file(this.beepUrl);
    return bytes ? this.decodeAndSchedule(bytes) : false;
  }

  // A short sound outside any turn (the alert chime, the beep for an alert that
  // cannot be read). It does not count as `playing` and stopAll does not stop it.
  async effect(url: string, gain = 1, rate = 1): Promise<boolean> {
    const bytes = await this.file(url);
    if (!bytes) return false;
    try {
      const audio = await this.ctx.decodeAudioData(bytes.slice(0));
      const src = this.ctx.createBufferSource();
      src.buffer = audio;
      src.playbackRate.value = rate;
      const g = this.ctx.createGain();
      g.gain.value = gain * this.gainFor('chime');
      src.connect(g).connect(this.bus);
      src.start();
      this.effectUntil = Math.max(this.effectUntil, this.ctx.currentTime + audio.duration / rate);
      this.effects += 1;
      return true;
    } catch {
      return false;
    }
  }

  private file(url: string): Promise<ArrayBuffer | null> {
    let f = this.files.get(url);
    if (!f) {
      f = fetch(url)
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .catch(() => null);
      this.files.set(url, f);
    }
    return f;
  }

  stopAll(): void {
    this.gen += 1;
    const wasPlaying = this.sources.size > 0;
    for (const s of this.sources) {
      s.onended = null;
      try {
        s.stop();
      } catch {
        // not started yet
      }
    }
    this.sources.clear();
    this.nextT = 0;
    this.voiceUntil = Math.min(this.voiceUntil, this.ctx.currentTime);
    if (wasPlaying) this.onIdle();
  }

  level(): number {
    if (!this.sources.size) return 0;
    this.out.getFloatTimeDomainData(this.buf);
    return levelOf(this.buf);
  }

  private async decodeAndSchedule(bytes: ArrayBuffer): Promise<boolean> {
    const gen = this.gen;
    this.decoding += 1;
    let audio: AudioBuffer;
    try {
      // decodeAudioData detaches its input and resamples to the context rate.
      audio = await this.ctx.decodeAudioData(bytes.slice(0));
    } catch {
      return false;
    } finally {
      this.decoding -= 1;
    }
    if (gen !== this.gen) {
      if (!this.playing) this.onIdle();
      return false;
    }
    this.schedule(audio);
    return true;
  }

  private schedule(audio: AudioBuffer): void {
    const src = this.ctx.createBufferSource();
    src.buffer = audio;
    src.connect(this.out);
    // A reply (or read, or beep) that starts from silence takes the volume for
    // all of it; chunks queued behind it keep that volume.
    if (!this.sources.size) this.voice.gain.setValueAtTime(this.gainFor('voice'), this.ctx.currentTime);
    const start = Math.max(this.ctx.currentTime, this.nextT);
    this.nextT = start + audio.duration;
    this.voiceUntil = this.nextT;
    src.onended = () => {
      this.sources.delete(src);
      if (!this.playing) {
        this.nextT = 0;
        this.onIdle();
      }
    };
    this.sources.add(src);
    src.start(start);
    this.started += 1;
  }
}
