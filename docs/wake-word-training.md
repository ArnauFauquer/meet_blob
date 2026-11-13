# Wake word: the "hey blob" model

The page listens for **"hey blob"** with `web/public/models/hey_blob.onnx`, an openWakeWord model
trained for this project on 2026-11-13 on the author's Windows PC (RTX 3080). This page says how
the page loads it, how well it does, how it was trained, and how to retrain it.

## How the page loads a wake model

*   Files are served from `web/public/models/` (copied to `dist/models/` at build).
*   `web/public/models/wake.json` picks the model:

    ```json
    { "model": "hey_blob.onnx", "phrase": "hey blob", "threshold": 0.5 }
    ```

*   The pipeline is openWakeWord's: `melspectrogram.onnx` and `embedding_model.onnx` (shared,
    keep them) feed a wake model whose input is `[1, 16, 96]` (16 embeddings of 96 values, 1.28 s)
    and whose output is one score `[1, 1]`. Tensor names are read from the file, so they do not
    matter.
*   `phrase` is shown in the diagnostics view only. `threshold` is the score that fires. Raise it
    if there are false accepts, lower it (0.3 to 0.4) if there are misses.
*   A device with `"wake": false` in `config/devices.json` loads none of this.
*   The stock `hey_jarvis_v0.1.onnx` stays in the folder: the pipeline unit test uses it, and
    pointing `wake.json` back at it (`"phrase": "hey jarvis"`) is the fallback.

To install another model: copy it to `web/public/models/`, point `wake.json` at it, add its
licence line and SHA-256 to `web/public/models/README.md`, rebuild the page (`npm run build`, or
the container image), and check the score in the diagnostics view (long press) while saying the
phrase. No code change is needed.

## How well it does (synthetic speech only)

Max score per clip through the same pipeline as the page (`tools/wake-word/eval_model.py`),
threshold 0.5:

| Test | Fired |
| --- | --- |
| "hey blob", new Piper clips not used in training (300) | 79 % (84 % at 0.3) |
| "hey blob", Piper validation clips, no noise (2000) | 93 % |
| "hey blob", **Kokoro** (another TTS engine), 31 voices x 2 speeds | 52 % (61 % at 0.3) |
| of which American voices (af, am) | 29 of 40 |
| of which British voices (bf, bm) | 1 of 16 |
| of which Spanish voices (ef, em) | 2 of 6 |
| "hey blob, what time is it?", Kokoro | 63 % |
| "hey blog" (Piper / Kokoro) | **75 % / 44 %** |
| "hey bob", "a blob", "hey rob", "hey globe" (Piper / Kokoro) | 0 to 10 % |
| "hey bulb", "oye bob", "hey jarvis", "blob", ordinary sentences | 0 % |
| openWakeWord's 11 h validation set (speech, noise, music) | 0.0 false accepts per hour |

What this means:

*   It does not fire on the near misses that broke the earlier CPU attempt, except "hey blog",
    which sounds almost the same.
*   It hears American "blob" far better than British "blob". The training voices (Piper
    LibriTTS-R) are American. The household speaks Spanish and Catalan, and their "o" is closer to
    the British vowel, so **real recall may be low**. This is the main risk.
*   It has not heard a real voice. The design test (SC2) still applies: on the tablet, fewer than
    1 false accept per day over 3 days with the TV on, and fewer than 2 misses in 10 attempts.
    Record the threshold and results in `docs/spikes/tablet-test.md`.
*   The e2e fixture `web/e2e/fixtures/hey-blob.wav` uses Kokoro's `am_puck` (score 0.93). The
    voice of the other fixtures, `am_adam`, scores 0.30 at normal speed and does not fire.

### Reading the wake log in production

A hands-free page reports what the wake word heard as `client_event` lines on the backend's
standard output (`kubectl -n blob logs deploy/blob | grep client_event`):

| `event` | Fields | Meaning |
| --- | --- | --- |
| `wake_peak` | `peak`, `ms`, `fired` | one attempt: a run of scores at or above 0.1, its highest score and length; `fired` when it reached the threshold. Ordinary speech and silence send nothing |
| `wake_gate` | `on`, `why` | the detector started (`why: open`) or stopped: `turn` (a turn of this page), `busy` (the backend's turn, maybe another device's), `playing`, `hangover` (0.5 s after playback), `followup`, `off` |
| `turn_start` | `turn`, `how` | the turn's id (matches the timing line) and how it started: `tap`, `wake` or `followup` |

Saying the phrase with no `wake_peak` line, or peaks under the threshold, means the model did
not hear it (lower the threshold or retrain). No `wake_gate on` after a turn means the detector
never restarted, and `why` on the last `wake_gate off` says what held it.

If misses are the problem, retrain with extra positives in the household's accent: Kokoro's
British and Spanish voices (`tools/wake-word/kokoro_clips.py`), or recordings of the household
saying the phrase, added to `positive_train` before `--augment_clips`. Recordings of real voices
stay outside the repository (`.gitignore` excludes `**/clips/`).

## How it was trained

The official openWakeWord recipe (`train.py` with a YAML config; the
`notebooks/automatic_model_training.ipynb` notebook runs the same steps), run natively on Windows
in a folder outside this repository (`../blob-wakeword`). Everything needed to repeat it is in
`tools/wake-word/`.

| Item | Value |
| --- | --- |
| openWakeWord | https://github.com/dscripka/openWakeWord at `368c037`, plus `openwakeword-windows.patch` |
| Synthetic speech | https://github.com/rhasspy/piper-sample-generator at tag `v2.0.0` (the layout `train.py` imports), plus `piper-sample-generator-v2.patch` and `piper_phonemize.py`, with `en_US-libritts_r-medium.pt` from its v2.0.0 release (about 900 speakers) |
| Python | 3.10 venv; `torch==2.7.1` and `torchaudio==2.7.1` (cu126), `onnxruntime-gpu==1.22.0`, `numpy<2`, `pyarrow<15`, `setuptools<70`, the training pins from the notebook (`speechbrain==0.5.14`, `audiomentations==0.33.0`, `torch-audiomentations==0.11.0`, `datasets==2.14.6`, ...), `piper-tts==1.3.0`, `webrtcvad-wheels`. No TensorFlow: only the `.tflite` export needs it |
| Config | `tools/wake-word/hey_blob.yaml`: "hey blob"; 11 custom negatives ("hey bob", "hey blog", "a blob", "hey rob", ...); 50 000 positive and 50 000 adversarial clips (+ 2 000 each for validation); 50 000 steps; target 0.2 false accepts per hour |
| Data (about 25 GB) | `openwakeword_features_ACAV100M_2000_hrs_16bit.npy` (17 GB) and `validation_set_features.npy` from huggingface.co/datasets/davidscripka/openwakeword_features; 270 MIT room impulse responses; 3 000 AudioSet clips (6 balanced-train parquet parts, about 8 h) as background noise (`get_audio_data.py`) |
| Time on the RTX 3080 | clip generation about 15 min, augmentation and features about 15 min, training about 10 min |
| Result | training's own report: accuracy 0.72, recall 0.44 (on heavily augmented clips), 0.0 false accepts per hour |

Windows fixes (the notebook says "linux only"):

*   `piper-phonemize` has no Windows wheels. `piper_phonemize.py` is a stand-in that calls the
    espeak-ng bundled in `piper-tts` 1.3. Drop it next to `generate_samples.py`.
*   PyTorch 2.6+ loads `.pt` files with `weights_only=True`. The Piper generator is a pickled
    module, so `generate_samples.py` needs `weights_only=False`. That runs code from the file:
    only use the official rhasspy release file.
*   `train.py` hands a generator and lambdas to a multi-process `DataLoader`. Windows spawns
    processes and cannot pickle them, so the patch uses `num_workers=0` on Windows.
*   `trim_mmap` deletes and renames a memory-mapped file while it is still open, which Windows
    refuses. The patch closes the maps first (and fixes `.strip(".npy")`, which strips
    characters, not the suffix).
*   AudioSet on Hugging Face is now parquet, not `.tar`; `get_audio_data.py` reads the parquet.
*   `--convert_to_tflite` defaults to the string `"False"`, which is true, so `train.py` always
    tries the tflite export last and fails without TensorFlow. The `.onnx` is already written by
    then; ignore that error.
*   Keep `kokoro-onnx` in its own venv: it upgrades numpy to 2.x and installs the CPU
    onnxruntime over the GPU one.

To retrain, from `../blob-wakeword` with the patches applied:

```
.venv/Scripts/python openWakeWord/openwakeword/train.py --training_config hey_blob.yaml --generate_clips
.venv/Scripts/python openWakeWord/openwakeword/train.py --training_config hey_blob.yaml --augment_clips
.venv/Scripts/python openWakeWord/openwakeword/train.py --training_config hey_blob.yaml --train_model
```

Each step skips work already on disk. Delete `output/hey_blob/*.npy` (or pass `--overwrite`)
to recompute features after changing the clips.

Licence: the model is the author's own. Its training data has mixed licences (some
non-commercial), which matches openWakeWord's own CC BY-NC-SA 4.0 for its release models; fine
for a private home assistant.

## Earlier attempt (CPU only, 2026-11-12): not shipped

On a 12-core machine with no GPU, a reduced attempt used Kokoro clips (34 voices) as positives,
a few thousand negative windows from the same engine, and a small head trained in numpy. It
fired on 9 of 21 near misses and 7 of 24 ordinary sentences, with scores of 1.0: it had learned
"a short English phrase in a Kokoro voice", not "hey blob". The fix was the official recipe
above: about 2 000 hours of negative features, about 900 synthetic speakers, real noise and
room acoustics.
