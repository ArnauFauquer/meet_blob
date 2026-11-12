import { Recorder, levelOf, type Recording } from './pcm';
import type { Mic } from '../turn-client';
import workletUrl from './worklet/capture-processor.ts?worker&url';

// Opens the microphone only for one turn and closes it (tracks stopped) after.
// Capture and playback share the one AudioContext.
export class Capture implements Mic {
  private readonly ctx: AudioContext;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: Recorder | null = null;
  private moduleReady: Promise<void> | null = null;
  private readonly buf = new Float32Array(1024);
  status: 'off' | 'open' | 'denied' = 'off';

  private readonly capMs: number;
  private readonly silenceRms: number;

  constructor(ctx: AudioContext, capMs: number, silenceRms: number) {
    this.ctx = ctx;
    this.capMs = capMs;
    this.silenceRms = silenceRms;
  }

  get open(): boolean {
    return this.stream !== null;
  }

  // onCap is called when the 15 s cap is reached.
  async start(onCap: () => void): Promise<void> {
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
    const rec = new Recorder(this.capMs, this.silenceRms);
    this.recorder = rec;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.node = new AudioWorkletNode(this.ctx, 'capture-processor', { numberOfOutputs: 1 });
    this.node.port.onmessage = (ev: MessageEvent<Int16Array>) => {
      if (this.recorder !== rec) return;
      rec.push(ev.data);
      if (rec.full) onCap();
    };
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.node);
    this.source.connect(this.analyser);
    // The worklet writes no output; it is connected so the graph pulls it.
    this.node.connect(this.ctx.destination);
  }

  // Stops the microphone and returns what was recorded (empty if nothing).
  stop(): Recording {
    const rec = this.recorder;
    this.close();
    return (rec ?? new Recorder(0, 0)).finish();
  }

  close(): void {
    this.recorder = null;
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
}
