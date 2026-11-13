"""Download MIT room impulse responses and a slice of AudioSet, saved as 16 kHz mono int16 WAVs."""
import io
import os
import sys
import urllib.request
from math import gcd

import numpy as np
import scipy.io.wavfile
import scipy.signal
import soundfile as sf
from tqdm import tqdm

DATA = sys.argv[1]
AUDIOSET_PARTS = ["00.parquet", "06.parquet", "12.parquet", "18.parquet", "24.parquet", "30.parquet"]


def to_16k_int16(audio, sr):
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        g = gcd(sr, 16000)
        audio = scipy.signal.resample_poly(audio, 16000 // g, sr // g)
    return (np.clip(audio, -1, 1) * 32767).astype(np.int16)


def rirs():
    import datasets
    out = os.path.join(DATA, "mit_rirs")
    os.makedirs(out, exist_ok=True)
    if len(os.listdir(out)) > 200:
        return
    ds = datasets.load_dataset("davidscripka/MIT_environmental_impulse_responses", split="train", streaming=True)
    for row in tqdm(ds, desc="mit_rirs"):
        name = row["audio"]["path"].split("/")[-1]
        a = to_16k_int16(np.asarray(row["audio"]["array"], dtype=np.float32), row["audio"]["sampling_rate"])
        scipy.io.wavfile.write(os.path.join(out, name), 16000, a)


def audioset():
    out = os.path.join(DATA, "audioset_16k")
    os.makedirs(out, exist_ok=True)
    import pyarrow.parquet as pq
    for part in AUDIOSET_PARTS:
        url = "https://huggingface.co/datasets/agkphysics/AudioSet/resolve/main/data/bal_train/" + part
        tmp = os.path.join(DATA, "audioset_" + part)
        if not os.path.exists(tmp + ".done"):
            print("downloading", part, flush=True)
            urllib.request.urlretrieve(url, tmp)
            table = pq.read_table(tmp)
            print(part, table.schema, flush=True)
            col = [c for c in table.column_names if c == "audio" or c == "flac"][0]
            for i, rec in enumerate(tqdm(table.column(col).to_pylist(), desc=part)):
                name = f"{part.split('.')[0]}_{i:05d}.wav"
                try:
                    data = rec["bytes"] if isinstance(rec, dict) else rec
                    audio, sr = sf.read(io.BytesIO(data), dtype="float32")
                    scipy.io.wavfile.write(os.path.join(out, name), 16000, to_16k_int16(audio, sr))
                except Exception as e:  # a few clips are broken
                    print("skip", name, e)
            del table
            open(tmp + ".done", "w").close()
            os.remove(tmp)


if __name__ == "__main__":
    rirs()
    audioset()
    for d in ("mit_rirs", "audioset_16k"):
        print(d, len(os.listdir(os.path.join(DATA, d))))
