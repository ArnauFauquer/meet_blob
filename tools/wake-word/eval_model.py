"""Score wav files with a wake model through openWakeWord's pipeline (same as the page): max score per clip."""
import glob
import sys

import numpy as np
import onnxruntime as ort
import scipy.io.wavfile
from openwakeword.model import Model

model_path = sys.argv[1]
sess = ort.InferenceSession(model_path)
print("input", [(i.name, i.shape) for i in sess.get_inputs()], "output", [(o.name, o.shape) for o in sess.get_outputs()])
oww = Model(wakeword_models=[model_path], inference_framework="onnx")
name = list(oww.models.keys())[0]


def score(path):
    sr, a = scipy.io.wavfile.read(path)
    assert sr == 16000, (path, sr)
    if a.ndim > 1:
        a = a.mean(axis=1).astype(np.int16)
    a = np.concatenate([np.zeros(16000, np.int16), a, np.zeros(16000, np.int16)])
    oww.reset()
    best = 0.0
    for i in range(0, len(a) - 1280, 1280):
        best = max(best, oww.predict(a[i:i + 1280])[name])
    return best


for group in sys.argv[2:]:
    label, pattern = group.split("=", 1)
    files = sorted(glob.glob(pattern))
    s = np.array([score(f) for f in files])
    print(f"{label:28s} n={len(s):4d}  fired@0.5={np.mean(s >= 0.5):.2f}  @0.3={np.mean(s >= 0.3):.2f}  median={np.median(s):.3f}")
