import sqlite3
from pathlib import Path

from blob.db import SCHEMA_VERSION, Db
from blob.schemas import Timings


async def test_schema_and_insert(tmp_path: Path) -> None:
    db = Db(str(tmp_path / "sub" / "blob.db"))
    assert db.user_version() == SCHEMA_VERSION == 1
    await db.insert_turn(100, "es", "hola", "adiós", "ok", None, Timings(stt_ms=5))
    [row] = db.turns()
    assert row["lang"] == "es" and row["user_text"] == "hola" and row["reason"] == "ok"
    assert row["timings"] == {
        "stt_ms": 5,
        "hermes_ms": None,
        "tts_ms": None,
        "first_audio_ms": None,
        "sc1_ms": None,
    }
    db.close()


async def test_delete_older(tmp_path: Path) -> None:
    db = Db(":memory:")
    now = 30 * 86400
    for ts in (now - 15 * 86400, now - 13 * 86400, now):
        await db.insert_turn(ts, None, "", "", "empty", None, Timings())
    assert await db.delete_turns_older_than(14, now) == 1
    assert len(db.turns()) == 2


def test_newer_file_keeps_its_version(tmp_path: Path) -> None:
    # A file written by a later slice (user_version 2, an extra table) still opens.
    path = tmp_path / "blob.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE alerts (key TEXT PRIMARY KEY)")
    conn.execute("PRAGMA user_version = 2")
    conn.commit()
    conn.close()
    db = Db(str(path))
    assert db.user_version() == 2
    db.close()


def test_reopen_keeps_rows(tmp_path: Path) -> None:
    path = str(tmp_path / "blob.db")
    db = Db(path)
    db._insert_turn(1, "en", "a", "b", "ok", None, Timings())
    db.close()
    assert len(Db(path).turns()) == 1
