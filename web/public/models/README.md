# Model files (served at `/models/`)

Loaded only on a device with `wake=true` (hands-free), by the audio model worker
(`web/src/wake/worker.ts`) on onnxruntime-web (wasm, one thread). A tap-only device never
downloads them.

| File | What | Source | Licence |
| --- | --- | --- | --- |
| `melspectrogram.onnx` | openWakeWord audio front end: 16 kHz audio to 32-bin mel frames | [openWakeWord v0.5.1 release](https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1) | openWakeWord states that its included pre-trained models are **CC BY-NC-SA 4.0** (README, "License"). The code is Apache-2.0. |
| `embedding_model.onnx` | openWakeWord shared speech embedding (76 mel frames to 96 values), a re-implementation of Google's `speech_embedding` (TF Hub, Apache-2.0) | same release | treated as **CC BY-NC-SA 4.0** with the other release models (the README gives the Apache-2.0 origin of the architecture and weights; the release itself does not license this file separately) |
| `hey_jarvis_v0.1.onnx` | stock wake word "hey jarvis" (16 embeddings to a score) | same release | **CC BY-NC-SA 4.0** (non-commercial, share-alike, attribution: David Scripka, openWakeWord) |
| `silero_vad_v5.onnx` | Silero voice-activity detector v5 (512-sample frames at 16 kHz) | copied from `@ricky0123/vad-web@0.0.31` (`dist/silero_vad_v5.onnx`), originally [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | **MIT** (silero-vad); vad-web is ISC |
| `wake.json` | which wake model file to load, its phrase and the score threshold | this repository | same as the repository |

SHA-256 of the files as committed:

```
ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f  melspectrogram.onnx
70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f  embedding_model.onnx
94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb  hey_jarvis_v0.1.onnx
2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f  silero_vad_v5.onnx
```

The CC BY-NC-SA 4.0 terms fit a private home assistant. They do not allow commercial use.
A custom "hey blob" model trained by the author with openWakeWord's training code is the
author's own model; see `docs/wake-word-training.md` for how to train one and drop it in here.

The onnxruntime-web runtime (`ort-wasm-simd-threaded.wasm`, MIT) is not in this folder: Vite
copies it from `node_modules/onnxruntime-web` into `dist/assets/` at build time.
