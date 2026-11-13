// Messages between the page and the audio model worker (wake/worker.ts).
export interface WorkerInit {
  type: 'init';
  base: string; // URL prefix of the model files, ends with '/'
  wakeModel: string; // wake word model file name
  verifier: string; // custom verifier JSON file name, '' for none
}
export type ToWorker =
  | WorkerInit
  | { type: 'audio'; pcm: Int16Array; wake: boolean; vad: boolean }
  | { type: 'reset'; wake: boolean; vad: boolean };

export type FromWorker =
  | { type: 'ready'; wake: boolean; vad: boolean; verifier: boolean }
  | { type: 'score'; score: number } // one per 80 ms chunk while the wake word runs
  | { type: 'vad'; p: number } // speech probability per 32 ms frame while the VAD runs
  | { type: 'error'; what: 'wake' | 'vad'; message: string };
