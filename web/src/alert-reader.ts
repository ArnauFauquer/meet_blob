import type { ClientMessage, ErrorMsg, TtsMsg } from './protocol';

// No tts for our alert_read within this time counts as a failed synthesis.
export const ALERT_READ_TIMEOUT_MS = 10_000;

export interface AlertReaderDeps {
  send(msg: ClientMessage): boolean;
  play(wav: ArrayBuffer): Promise<boolean>; // false when the WAV could not be played
  beep(): void;
}

// The alert tap row (design, Alerts and timers): alert_read, play the returned
// tts WAV, alert_ack after playback ends. If synthesis fails (error, no frame,
// undecodable audio) the alert is kept, the beep plays and nothing else is sent.
export class AlertReader {
  key: string | null = null; // alert being read
  private playingAudio = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly d: AlertReaderDeps;

  constructor(deps: AlertReaderDeps) {
    this.d = deps;
  }

  get reading(): boolean {
    return this.key !== null;
  }

  read(key: string): void {
    if (this.key !== null) return;
    if (!this.d.send({ type: 'alert_read', key })) return;
    this.key = key;
    this.playingAudio = false;
    this.timer = setTimeout(() => this.fail(), ALERT_READ_TIMEOUT_MS);
  }

  // A tts header with its frame. Returns true when it was ours.
  onTts(m: Pick<TtsMsg, 'alert'>, wav: ArrayBuffer | null): boolean {
    if (m.alert === null || m.alert !== this.key || this.playingAudio) return false;
    clearTimeout(this.timer);
    if (!wav) {
      this.fail();
      return true;
    }
    this.playingAudio = true;
    const key = this.key;
    void this.d.play(wav).then((ok) => {
      if (!ok && this.key === key) this.fail();
    });
    return true;
  }

  // The server refused the read (unknown key, a turn running) or failed.
  onError(m: ErrorMsg): void {
    if (this.key !== null && !this.playingAudio && m.code === 'bad_message') this.fail();
  }

  // Local playback became empty.
  onPlaybackIdle(): void {
    if (this.key === null || !this.playingAudio) return;
    this.d.send({ type: 'alert_ack', key: this.key });
    this.finish();
  }

  // Socket dropped: forget the read, the alert stays.
  reset(): void {
    this.finish();
  }

  private fail(): void {
    this.finish();
    this.d.beep();
  }

  private finish(): void {
    clearTimeout(this.timer);
    this.key = null;
    this.playingAudio = false;
  }
}
