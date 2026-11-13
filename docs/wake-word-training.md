# Wake word: training "hey blob" and dropping it in

The page ships with the stock openWakeWord model **"hey jarvis"** (`hey_jarvis_v0.1.onnx`). Say
"hey jarvis" to start a turn. The design phrase "hey blob" needs a custom model. This page says
what was tried on the development machine, and exactly how to train and install a real one.

## How the page loads a wake model

*   Files are served from `web/public/models/` (copied to `dist/models/` at build).
*   `web/public/models/wake.json` picks the model:

    ```json
    { "model": "hey_jarvis_v0.1.onnx", "phrase": "hey jarvis", "threshold": 0.5 }
    ```

*   The pipeline is openWakeWord's: `melspectrogram.onnx` and `embedding_model.onnx` (shared,
    keep them) feed a wake model whose input is `[1, 16, 96]` (16 embeddings of 96 values, 1.28 s)
    and whose output is one score `[1, 1]`. Any model trained with openWakeWord's training code
    has this shape. Tensor names are read from the file, so they do not matter.
*   `phrase` is shown in the diagnostics view only. `threshold` is the score that fires (0.5 is
    openWakeWord's default; raise it if there are false accepts, lower it if there are misses).
*   Only a device with `"wake": true` in `config/devices.json` loads any of this.

To install a model: copy `hey_blob.onnx` to `web/public/models/`, set
`{"model": "hey_blob.onnx", "phrase": "hey blob", "threshold": 0.5}` in `wake.json`, add its
licence line to `web/public/models/README.md`, rebuild the page (`npm run build`, or the
container image), and check the score in the diagnostics view (long press) while saying the
phrase. No code change is needed.

## Train a real "hey blob" model (recommended path)

openWakeWord trains a small model on top of its frozen embedding model, from fully synthetic
positive clips plus large negative datasets. The official recipe:

1.  Use openWakeWord's notebook `notebooks/automatic_model_training.ipynb`
    (https://github.com/dscripka/openWakeWord). It runs on Google Colab with a GPU; locally it
    needs an NVIDIA GPU with CUDA for the clip generation to finish in hours rather than days.
2.  In its config set `target_phrase: ["hey blob"]` and a model name `hey_blob`. Add the
    Spanish and Catalan ways the household says it if needed (for example `["hey blob", "ei blob"]`).
    Keep the default negative phrases and add the near misses that matter here:
    "hey bob", "hey blog", "a blob", "oye bob", "hey Rob".
3.  It downloads what it needs: `piper-sample-generator` with the LibriTTS-R Piper model
    (thousands of synthetic speakers), room impulse responses, background noise and music
    (AudioSet, FMA), and the precomputed negative features
    `openwakeword_features_ACAV100M_2000_hrs_16bit.npy` (about 2000 hours, about 17 GB) and
    `validation_set_features.npy`. Budget about 40 GB of disk.
4.  Defaults that work: `n_samples: 50000` positive clips, `steps: 50000`,
    `target_false_positives_per_hour: 0.2`. It writes `hey_blob.onnx` (and a tflite file, not
    needed here).
5.  Test before trusting it (design SC2): fewer than 1 false accept per day over 3 days with
    the TV on, and fewer than 2 misses in 10 attempts, on the tablet. Record the threshold and
    results in `docs/spikes/tablet-test.md`.

Licence: a model you train is yours. The training data the notebook downloads has mixed
licences (some non-commercial), which matches openWakeWord's own CC BY-NC-SA 4.0 for its
release models; fine for a private home assistant.

Alternative engine: microWakeWord (design, Alternative H3) has its own training recipe and runs
on TFLite; the page does not support it, and switching would mean a new worker pipeline.

## What was tried on this machine (CPU only, one hour): not good enough, not shipped

The machine has 12 CPU cores, 15 GB of RAM and no GPU. The official recipe above needs the
Piper LibriTTS generator (slow on a CPU for 50 000 clips), PyTorch and about 17 GB of negative
features, which does not fit a one-hour box. A reduced attempt was made instead, in about
35 minutes of work (scripts kept outside the repository):

1.  **Positives:** Kokoro (the backend's speech model) said "Hey Blob." in 4 spellings with
    31 English voices and 3 Spanish voices at speeds 0.85, 1.0 and 1.2, each augmented 3 times
    (gain from -12 to +3 dB, white noise from -60 to -30 dB). 5 voices were held out for testing.
2.  **Negatives:** the same voices saying 25 other phrases, including near misses ("hey Bob",
    "hey blog", "a blob", "oye Bob", "hey Jarvis") and Spanish sentences, plus 200 noise-only
    clips and the silence around the positives.
3.  **Features:** the stock `melspectrogram.onnx` and `embedding_model.onnx`, with the same
    16 x 96 windows the page computes. 3 276 positive and 23 893 negative training windows;
    11 minutes on the CPU.
4.  **Model:** an openWakeWord-style head (1536 to 32 to 32 to 1, sigmoid) trained in numpy
    (Adam, 40 epochs, seconds) and exported to ONNX with the stock input shape `[1, 16, 96]`.
    It ran through the Python reference of the page's pipeline (same maths); it was not loaded
    in the page itself.

Results on clips it never saw:

| Test | Fired (score ≥ 0.5) |
| --- | --- |
| "Hey Blob." by 5 held-out voices | 5 of 5 |
| near misses ("hey Bob", "hey blog", "a blob", "hey Rob", "hey globe", "oye Bob", "hey, block that"), 3 voices | **9 of 21** |
| ordinary sentences it never heard ("the bulb is broken", "bring the bottle", a Spanish sentence...), 4 voices | **7 of 24** |
| the e2e clips "Hey Jarvis. What time is it?" and the question clip | 0 of 2 |

The false-accept scores are 1.0, so no threshold fixes them. With a few thousand negative
windows from one TTS engine the head learns "a short English phrase in a Kokoro voice", not
"hey blob". It would fire many times a day on the TV. **It was not shipped.** The page ships
with "hey jarvis" and the pipeline above; a real model needs the official recipe (large
negative features, many synthetic speakers, real noise), run on a GPU or on Colab.

What the attempt does show: a head exported to `[1, 16, 96] -> [1, 1]` with its own tensor
names runs through the same feature pipeline, and the page reads tensor names from the
session, so installing a properly trained `hey_blob.onnx` should only need the `wake.json`
edit described above (not verified in the page with a custom file).
