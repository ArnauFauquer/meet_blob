import { Recorder, levelOf, type Recording } from './pcm';
import type { Mic } from '../turn-client';
import workletUrl from './worklet/capture-processor.ts?worker&url';

// Tap mode: the microphone opens only for one turn and closes (tracks stopped)
// after it. Hands-free mode (wake=true, slice 3): openShared() opens one stream
// and one AudioWorklet that stay open; every 16 kHz block goes to `onFrame`
// (wake word and voice-activity detection) and a turn only starts and stops a
// recorder on it. Capture and playback share the one AudioContext.
export class Capture implements Mic {
  private readonly ctx: AudioContext;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: Recorder | null = null;
  private onCap: (() => void) | null = null;
  private moduleReady: Promise<void> | null = null;
  private shared = false;
  private readonly buf = new Float32Array(1024);
  status: 'off' | 'open' | 'denied' = 'off';
  onFrame: (pcm: Int16Array) => void = () => {};

  private readonly capMs: number;
  silenceRms: number; // from /device-config

  constructor(ctx: AudioContext, capMs: number, silenceRms: number) {
    this.ctx = ctx;
    this.capMs = capMs;
    this.silenceRms = silenceRms;
  }

  get open(): boolean {
    return this.stream !== null;
  }

  // The microphone track, for the mic log (muted, label, settings).
  get track(): MediaStreamTrack | null {
    return this.stream?.getAudioTracks()[0] ?? null;
  }

  // Hands-free: open the one stream for good.
  async openShared(): Promise<void> {
    this.shared = true;
    if (!this.stream) await this.openStream();
  }

  // onCap is called when the 15 s cap is reached.
  async start(onCap: () => void): Promise<void> {
    if (!this.stream) await this.openStream();
    this.recorder = new Recorder(this.capMs, this.silenceRms);
    this.onCap = onCap;
  }

  // Stops recording and returns what was recorded (empty if nothing).
  stop(): Recording {
    const rec = this.recorder;
    this.close();
    return (rec ?? new Recorder(0, 0)).finish();
  }

  // Ends the recording. In tap mode the tracks stop too; the shared stream stays.
  close(): void {
    this.recorder = null;
    this.onCap = null;
    if (this.shared) return;
    if (this.node) this.node.port.onmessage = null;
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = this.source = this.node = this.analyser = null;
    if (this.status === 'open') this.status = 'off';
  }

  level(): number {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.buf);
    return levelOf(this.buf);
  }

  private async openStream(): Promise<void> {
    this.moduleReady ??= this.ctx.audioWorklet.addModule(workletUrl);
    await this.moduleReady;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (e) {
      this.status = 'denied';
      throw e;
    }
    this.stream = stream;
    this.status = 'open';
    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', { numberOfOutputs: 1 });
    this.node.port.onmessage = (ev: MessageEvent<Int16Array>) => {
      const rec = this.recorder;
      if (rec) {
        rec.push(ev.data);
        if (rec.full) this.onCap?.();
      }
      if (this.shared) this.onFrame(ev.data);
    };
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.node);
    this.source.connect(this.analyser);
    // The worklet writes no output; it is connected so the graph pulls it.
    this.node.connect(this.ctx.destination);
  }
}
