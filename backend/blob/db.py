"""SQLite store: one connection, one writer, default journal mode. Calls run in a thread."""

import asyncio
import json
import sqlite3
import threading
from pathlib import Path

from .schemas import Timings

# 1: turns (S1). 2: alerts (S4). A new version only adds tables or columns, so an older image
# still opens a newer file.
SCHEMA_VERSION = 2

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

_ALERTS = """
CREATE TABLE IF NOT EXISTS alerts (
    key TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    urgency TEXT NOT NULL,
    text TEXT NOT NULL,
    lang TEXT NOT NULL,
    state TEXT NOT NULL,
    fire_at INTEGER,
    ttl_s INTEGER,
    late INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    activated_at INTEGER,
    acked_at INTEGER
)
"""
ALERT_COLUMNS = (
    "key",
    "source",
    "urgency",
    "text",
    "lang",
    "state",
    "fire_at",
    "ttl_s",
    "late",
    "created_at",
    "activated_at",
    "acked_at",
)


class Db:
    def __init__(self, path: str) -> None:
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock, self._conn:
            self._conn.execute(_TURNS)
            self._conn.execute(_ALERTS)
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
        with self._lock:
            cur = self._conn.execute(
                "SELECT turn_id, ts, lang, user_text, reply_text, reason, timeout_kind, timings"
                " FROM turns ORDER BY turn_id"
            )
            cols = [c[0] for c in cur.description]
            rows = [dict(zip(cols, row, strict=True)) for row in cur.fetchall()]
        for row in rows:
            row["timings"] = json.loads(str(row["timings"]))
        return rows

    def load_alerts(self) -> list[dict[str, object]]:
        with self._lock:
            cur = self._conn.execute(f"SELECT {', '.join(ALERT_COLUMNS)} FROM alerts")
            return [dict(zip(ALERT_COLUMNS, row, strict=True)) for row in cur.fetchall()]

    def _write_alerts(self, save: list[dict[str, object]], delete: list[str]) -> None:
        cols = ", ".join(ALERT_COLUMNS)
        marks = ", ".join(f":{c}" for c in ALERT_COLUMNS)
        with self._lock, self._conn:
            self._conn.executemany(f"INSERT OR REPLACE INTO alerts ({cols}) VALUES ({marks})", save)
            self._conn.executemany("DELETE FROM alerts WHERE key = ?", [(k,) for k in delete])

    async def write_alerts(self, save: list[dict[str, object]], delete: list[str]) -> None:
        """Upsert and delete alert rows in one transaction."""
        await asyncio.to_thread(self._write_alerts, save, delete)

    def close(self) -> None:
        # Under the lock: closing while a worker thread writes crashes sqlite3 (seen at shutdown).
        # Later calls raise sqlite3.ProgrammingError, which turnlog logs.
        with self._lock:
            self._conn.close()
