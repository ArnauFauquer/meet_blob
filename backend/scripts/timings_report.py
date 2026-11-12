"""Median and 90th percentile of sc1_ms, and counts by reason and by language, from the turns table.

uv run python scripts/timings_report.py [--db /data/blob.db] [--last 20]
"""

import argparse
import json
import sqlite3
import statistics
from collections import Counter


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--db", default="/data/blob.db")
    p.add_argument("--last", type=int, default=0, help="only the last N turns (0 = all)")
    a = p.parse_args()
    conn = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    rows = conn.execute("SELECT reason, lang, timings FROM turns ORDER BY turn_id").fetchall()
    if a.last:
        rows = rows[-a.last :]
    sc1 = sorted(t["sc1_ms"] for r in rows if (t := json.loads(r[2]))["sc1_ms"] is not None)
    print(f"turns: {len(rows)}  with sc1_ms: {len(sc1)}")
    if sc1:
        p90 = sc1[min(len(sc1) - 1, round(0.9 * (len(sc1) - 1)))]
        print(f"sc1_ms median: {statistics.median(sc1):.0f}  p90: {p90}")
    print("by reason:", dict(Counter(r[0] for r in rows)))
    print("by lang:", dict(Counter(r[1] for r in rows)))


if __name__ == "__main__":
    main()
