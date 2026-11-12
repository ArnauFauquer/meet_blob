"""SQLite store: one connection, one writer, default journal mode. Calls run in a thread."""

import asyncio
import json
import sqlite3
import threading
from pathlib import Path

from .schemas import Timings

SCHEMA_VERSION = 1

_TURNS = """
CREATE TABLE IF NOT EXISTS turns (
    turn_id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    lang TEXT,
    user_text TEXT,
    reply_text TEXT,
    reason TEXT NOT NULL,
    timeout_kind TEXT,
    timings TEXT NOT NULL
)
"""


class Db:
    def __init__(self, path: str) -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock, self._conn:
            self._conn.execute(_TURNS)
            # A newer file keeps its version: later versions only add tables or columns.
            if self.user_version() < SCHEMA_VERSION:
                self._conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def user_version(self) -> int:
        return int(self._conn.execute("PRAGMA user_version").fetchone()[0])

    def _insert_turn(
        self,
        ts: int,
        lang: str | None,
        user_text: str,
        reply_text: str,
        reason: str,
        timeout_kind: str | None,
        timings: Timings,
    ) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT INTO turns (ts, lang, user_text, reply_text, reason, timeout_kind, timings)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (ts, lang, user_text, reply_text, reason, timeout_kind, timings.model_dump_json()),
            )

    async def insert_turn(
        self,
        ts: int,
        lang: str | None,
        user_text: str,
        reply_text: str,
        reason: str,
        timeout_kind: str | None,
        timings: Timings,
    ) -> None:
        await asyncio.to_thread(
            self._insert_turn, ts, lang, user_text, reply_text, reason, timeout_kind, timings
        )

    def _delete_older(self, cutoff: int) -> int:
        with self._lock, self._conn:
            return self._conn.execute("DELETE FROM turns WHERE ts < ?", (cutoff,)).rowcount

    async def delete_turns_older_than(self, days: int, now: float) -> int:
        return await asyncio.to_thread(self._delete_older, int(now - days * 86400))

    def turns(self) -> list[dict[str, object]]:
        cur = self._conn.execute(
            "SELECT turn_id, ts, lang, user_text, reply_text, reason, timeout_kind, timings"
            " FROM turns ORDER BY turn_id"
        )
        cols = [c[0] for c in cur.description]
        rows = [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]
        for row in rows:
            row["timings"] = json.loads(str(row["timings"]))
        return rows

    def close(self) -> None:
        self._conn.close()
