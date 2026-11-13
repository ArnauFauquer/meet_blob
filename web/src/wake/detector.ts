import type { FromWorker, ToWorker } from './messages';

// Wake word settings: which model file in /models/ and the phrase it was
// trained for. Read from /models/wake.json so a custom model ("hey blob")
// drops in without a code change (docs/wake-word-training.md).
export interface WakeConfig {
  model: string;
  phrase: string;
  threshold: number;
}
export const DEFAULT_WAKE: WakeConfig = { model: 'hey_blob.onnx', phrase: 'hey blob', threshold: 0.5 };
export const MODELS_BASE = '/models/';

export async function loadWakeConfig(): Promise<WakeConfig> {
  try {
    const r = await fetch(`${MODELS_BASE}wake.json`);
    if (!r.ok) return DEFAULT_WAKE;
    return { ...DEFAULT_WAKE, ...((await r.json()) as Partial<WakeConfig>) };
  } catch {
    return DEFAULT_WAKE;
  }
}

export interface DetectorEvents {
  onReady(wake: boolean, vad: boolean): void;
  onScore(score: number): void;
  onVad(p: number): void;
  onError(what: 'wake' | 'vad', message: string): void;
}

// Page side of the audio model worker. The page decides per block whether the
// wake word and the VAD run (wake-gate.ts); audio is not sent when neither does.
export class Detector {
  private readonly worker: Worker;

  constructor(cfg: WakeConfig, ev: DetectorEvents) {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'ready') ev.onReady(m.wake, m.vad);
      else if (m.type === 'score') ev.onScore(m.score);
      else if (m.type === 'vad') ev.onVad(m.p);
      else ev.onError(m.what, m.message);
    };
    this.worker.onerror = (e) => ev.onError('wake', e.message || 'worker failed');
    this.post({ type: 'init', base: new URL(MODELS_BASE, location.href).href, wakeModel: cfg.model });
  }

  push(pcm: Int16Array, wake: boolean, vad: boolean): void {
    // Copied, not transferred: the turn recorder keeps the same block.
    if (wake || vad) this.post({ type: 'audio', pcm, wake, vad });
  }

  reset(wake: boolean, vad: boolean): void {
    this.post({ type: 'reset', wake, vad });
  }

  private post(m: ToWorker): void {
    this.worker.postMessage(m);
  }
}
