"""DEBUG_AUDIO_DIR: utterances kept as WAV files, only when switched on."""

import wave
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

from blob.debugaudio import AudioDump
from tests.conftest import wait_ready
from tests.test_hub import SPEECH, connect, tap, until, utterance


def test_saves_a_16k_wav_and_keeps_the_newest(tmp_path: Path) -> None:
    t = iter(range(1_700_000_000, 1_700_000_100))
    dump = AudioDump(str(tmp_path / "dbg"), keep=2, wall=lambda: next(t))
    for turn in (1, 2, 3):
        dump.save("tab/let", turn, SPEECH)
    files = sorted(p.name for p in (tmp_path / "dbg").glob("*.wav"))
    assert len(files) == 2
    assert files[0].endswith("_tab_let_turn2.wav") and files[1].endswith("_tab_let_turn3.wav")
    with wave.open(str(tmp_path / "dbg" / files[1]), "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000)
        assert w.readframes(w.getnframes()) == SPEECH


def test_unwritable_folder_does_not_raise(tmp_path: Path) -> None:
    (tmp_path / "file").write_text("x")
    assert AudioDump(str(tmp_path / "file" / "dbg"), keep=5).save("d", 1, SPEECH) is None


def test_hub_saves_the_utterance_only_when_on(app_factory: Any, tmp_path: Path) -> None:
    folder = tmp_path / "utterances"
    with TestClient(app_factory(debug_audio_dir=str(folder), debug_audio_keep=5)) as c:
        wait_ready(c)
        with connect(c, device="tablet") as ws:
            turn = tap(ws)
            utterance(ws, turn, SPEECH)
            assert until(ws, "turn_done")[-1]["reason"] == "ok"
    [f] = folder.glob("*.wav")
    assert f.name.endswith(f"_tablet_turn{turn}.wav")

    with TestClient(app_factory()) as c:  # DEBUG_AUDIO_DIR unset: nothing written anywhere
        wait_ready(c)
        with connect(c) as ws:
            utterance(ws, tap(ws), SPEECH)
            until(ws, "turn_done")
    assert len(list(tmp_path.rglob("*.wav"))) == 1
