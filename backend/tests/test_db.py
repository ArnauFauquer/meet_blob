import sqlite3
from pathlib import Path

from blob.db import _TURNS, SCHEMA_VERSION, Db
from blob.schemas import Timings


async def test_schema_and_insert(tmp_path: Path) -> None:
    db = Db(str(tmp_path / "sub" / "blob.db"))
    assert db.user_version() == SCHEMA_VERSION == 2
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
    # A file written by a later version (user_version 3, an extra table) still opens.
    path = tmp_path / "blob.db"
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE later (x TEXT)")
    conn.execute("PRAGMA user_version = 3")
    conn.commit()
    conn.close()
    db = Db(str(path))
    assert db.user_version() == 3
    db.close()


async def test_s1_file_opens_with_s4_code(tmp_path: Path) -> None:
    # An S1 database (turns only, user_version 1) gains the alerts table and version 2.
    path = tmp_path / "blob.db"
    conn = sqlite3.connect(path)
    conn.execute(_TURNS)
    conn.execute(
        "INSERT INTO turns (ts, lang, user_text, reply_text, reason, timeout_kind, timings)"
        " VALUES (1, 'es', 'hola', 'adiós', 'ok', NULL, '{}')"
    )
    conn.execute("PRAGMA user_version = 1")
    conn.commit()
    conn.close()
    db = Db(str(path))
    assert db.user_version() == 2
    assert [r["user_text"] for r in db.turns()] == ["hola"]
    assert db.load_alerts() == []
    row = {
        "key": "k",
        "source": "timer",
        "urgency": "urgent",
        "text": "t",
        "lang": "es",
        "state": "pending",
        "fire_at": 10,
        "ttl_s": None,
        "late": False,
        "created_at": 1,
        "activated_at": None,
        "acked_at": None,
    }
    await db.write_alerts([row], [])
    assert db.load_alerts() == [{**row, "late": 0}]
    await db.write_alerts([], ["k"])
    assert db.load_alerts() == []
    db.close()


def test_reopen_keeps_rows(tmp_path: Path) -> None:
    path = str(tmp_path / "blob.db")
    db = Db(path)
    db._insert_turn(1, "en", "a", "b", "ok", None, Timings())
    db.close()
    assert len(Db(path).turns()) == 1


async def test_close_waits_for_a_running_write(tmp_path: Path) -> None:
    import asyncio

    db = Db(str(tmp_path / "blob.db"))
    writes = [db.insert_turn(i, None, "", "", "ok", None, Timings()) for i in range(200)]
    closer = asyncio.to_thread(db.close)
    results = await asyncio.gather(*writes, closer, return_exceptions=True)
    # Every write either landed before the close or failed cleanly after it; no crash.
    assert all(r is None or isinstance(r, sqlite3.ProgrammingError) for r in results)
