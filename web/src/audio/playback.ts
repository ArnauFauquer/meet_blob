import { levelOf } from './pcm';

// Reply playback on the one AudioContext. Chunks are scheduled back to back
// (nextT = max(now, nextT) + duration). A new turn, a cancel or a tap stops
// every source and resets nextT; audio of a stale turn is dropped.
export class Playback {
  private readonly ctx: BaseAudioContext;
  private readonly out: AnalyserNode;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly buf = new Float32Array(1024);
  private nextT = 0;
  private turn: number | null = null;
  private cancelled = false;
  private gen = 0; // bumped by stopAll so a decode that finishes late is dropped
  private decoding = 0;
  private beepBytes: Promise<ArrayBuffer | null> | null = null;
  private readonly beepUrl: string;
  onIdle: () => void = () => {};
  started = 0; // sources started, for the diagnostics and the e2e tests

  constructor(ctx: BaseAudioContext, beepUrl = '/beep.wav') {
    this.ctx = ctx;
    this.beepUrl = beepUrl;
    this.out = ctx.createAnalyser();
    this.out.fftSize = 1024;
    this.out.connect(ctx.destination);
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
    this.beepBytes ??= fetch(this.beepUrl)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .catch(() => null);
    const bytes = await this.beepBytes;
    return bytes ? this.decodeAndSchedule(bytes) : false;
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
    const start = Math.max(this.ctx.currentTime, this.nextT);
    this.nextT = start + audio.duration;
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
