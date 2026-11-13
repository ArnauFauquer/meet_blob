"""Train the page's custom verifier for the wake word from real clips (web/src/wake/oww.ts).

openWakeWord's custom verifier idea (train_custom_verifier): a logistic regression on the 16 x 96
features the wake model sees, trained on one household's voices and microphone. The page applies it
whenever the base model scores at least `gate`, and its output replaces the score.

The clips come from the tablet with DEBUG_AUDIO_DIR on (docs/wake-word-training.md, "Personal
verifier"): <dir>/wake/pos/*.wav (the wake phrase, ?enroll=pos), <dir>/wake/neg/*.wav (other
speech, ?enroll=neg). Extra negatives: any folder of 16 kHz WAVs (TV, confusable phrases).

Run from the training workspace (openWakeWord and scikit-learn installed):
    python train_verifier.py --model output/hey_blob.onnx --pos debug-audio/wake/pos \
        --neg debug-audio/wake/neg --out hey_blob_verifier.json
"""

import argparse
import glob
import json
import os
import time

import numpy as np
import scipy.io.wavfile
from openwakeword.model import Model
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

CHUNK = 1280  # 80 ms, one score


def wavs(folders: list[str]) -> list[str]:
    return sorted(
        f for d in folders for f in glob.glob(os.path.join(d, "**", "*.wav"), recursive=True)
    )


def frames(oww: Model, name: str, path: str, offset: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Scores and features (n x 1536) per 80 ms step of one clip, padded with 1 s of silence."""
    sr, a = scipy.io.wavfile.read(path)
    assert sr == 16000, (path, sr)
    if a.ndim > 1:
        a = a.mean(axis=1).astype(np.int16)
    pad = np.zeros(16000, np.int16)
    a = np.concatenate([pad, a, pad])[offset:]
    oww.reset()
    scores, feats = [], []
    for i in range(0, len(a) - CHUNK, CHUNK):
        scores.append(oww.predict(a[i : i + CHUNK])[name])
        feats.append(oww.preprocessor.get_features(16).reshape(-1))
    return np.array(scores), np.array(feats)


def clip_features(oww: Model, name: str, path: str, positive: bool, gate: float) -> np.ndarray:
    """Positive: the frames near the clip's peak (5 start offsets). Negative: every gated frame."""
    out = []
    for offset in (0, 256, 512, 768, 1024) if positive else (0,):
        s, f = frames(oww, name, path, offset)
        keep = s >= max(gate, 0.5 * s.max()) if positive else s >= gate * 0.5
        out.append(f[keep])
    return np.vstack(out) if out else np.empty((0, 16 * 96))


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--model", required=True, help="the base wake model (.onnx) the page uses")
    ap.add_argument("--pos", nargs="+", required=True, help="folders of wake phrase clips")
    ap.add_argument("--neg", nargs="+", required=True, help="folders of other speech / noise clips")
    ap.add_argument("--out", required=True, help="verifier JSON for web/public/models/")
    ap.add_argument(
        "--gate", type=float, default=0.1, help="base score from which the verifier decides"
    )
    ap.add_argument(
        "--c", type=float, default=0.01, help="inverse regularisation of the regression"
    )
    args = ap.parse_args()

    oww = Model(wakeword_models=[args.model], inference_framework="onnx")
    name = next(iter(oww.models))
    pos, neg = wavs(args.pos), wavs(args.neg)
    print(f"{len(pos)} positive clips, {len(neg)} negative clips")
    feats = {p: clip_features(oww, name, p, True, args.gate) for p in pos}
    feats |= {p: clip_features(oww, name, p, False, args.gate) for p in neg}
    missed = [p for p in pos if len(feats[p]) == 0]
    if missed:
        print(
            f"{len(missed)} positive clips never reach the gate {args.gate} (no verifier can help):"
        )
        for p in missed:
            print("   ", p)

    def fit(train: list[str]) -> tuple[StandardScaler, LogisticRegression]:
        x = np.vstack([feats[p] for p in train])
        y = np.concatenate([np.full(len(feats[p]), p in set(pos), float) for p in train])
        sc = StandardScaler().fit(x)
        sc.scale_[sc.scale_ == 0] = 1.0
        lr = LogisticRegression(C=args.c, max_iter=5000, class_weight="balanced").fit(
            sc.transform(x), y
        )
        return sc, lr

    def clip_score(sc: StandardScaler, lr: LogisticRegression, p: str) -> float:
        f = feats[p]
        return float(lr.predict_proba(sc.transform(f))[:, 1].max()) if len(f) else 0.0

    # Held-out check: 5 folds over clips (not frames), max verified score per clip.
    rng = np.random.default_rng(0)
    clips = [p for p in pos + neg if len(feats[p])]
    order = rng.permutation(len(clips))
    held = {}
    for k in range(5):
        test = [clips[i] for i in order[k::5]]
        train = [p for p in clips if p not in set(test)]
        if not any(p in set(pos) for p in train) or not any(p not in set(pos) for p in train):
            continue
        sc, lr = fit(train)
        held |= {p: clip_score(sc, lr, p) for p in test}
    for label, group in (("positive", pos), ("negative", neg)):
        s = np.array([held.get(p, 0.0) for p in group])
        if len(s):
            print(
                f"held-out {label:8s} n={len(s):4d}  >=0.5: {np.mean(s >= 0.5):.2f}  "
                f">=0.35: {np.mean(s >= 0.35):.2f}  median {np.median(s):.3f}"
            )

    sc, lr = fit(clips)
    out = {
        "gate": args.gate,
        "mean": [round(float(v), 6) for v in sc.mean_],
        "scale": [round(float(v), 6) for v in sc.scale_],
        "coef": [round(float(v), 6) for v in lr.coef_[0]],
        "intercept": round(float(lr.intercept_[0]), 6),
        "trained": time.strftime("%Y-%m-%d"),
        "base_model": os.path.basename(args.model),
        "clips": {"pos": len(pos), "neg": len(neg)},
    }
    with open(args.out, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print("wrote", args.out)


if __name__ == "__main__":
    main()
