"""All SQLite access: schema creation + every query function.

Per AGENTS.md rule 4, all SQL lives here — nowhere else in the codebase.
Parameterised queries only, never string interpolation into SQL.
"""

from __future__ import annotations

import logging
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS ratings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT    NOT NULL,   -- ISO YYYY-MM-DD, local date of the meal
    week_type  TEXT    NOT NULL,   -- 'even_week' | 'odd_week'
    day        TEXT    NOT NULL,   -- 'monday' ... 'sunday'
    meal       TEXT    NOT NULL,   -- 'breakfast' | 'lunch' | 'snack' | 'dinner'
    user_id    INTEGER NOT NULL,
    score      INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    UNIQUE(date, meal, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_slot ON ratings(week_type, day, meal);

CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    username   TEXT,
    message    TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    resolved   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


def connect(db_path: str | Path) -> sqlite3.Connection:
    """Open the SQLite database, creating the schema if needed."""
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(_SCHEMA)
    conn.commit()
    logger.info("Database ready at %s", db_path)
    return conn


# --- state table -------------------------------------------------------

def get_state(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute("SELECT value FROM state WHERE key = ?", (key,)).fetchone()
    return row[0] if row is not None else None


def set_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO state (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )
    conn.commit()


# --- menu-post idempotency ---------------------------------------------
# One row per meal, holding the ISO date it was last posted on. A second
# job fire for the same (date, meal) is a no-op.

def _last_posted_menu_key(meal: str) -> str:
    return f"last_posted_menu:{meal}"


def has_posted_menu(conn: sqlite3.Connection, meal: str, date_iso: str) -> bool:
    return get_state(conn, _last_posted_menu_key(meal)) == date_iso


def mark_posted_menu(conn: sqlite3.Connection, meal: str, date_iso: str) -> None:
    set_state(conn, _last_posted_menu_key(meal), date_iso)


# --- reports -------------------------------------------------------------

def insert_report(
    conn: sqlite3.Connection,
    *,
    user_id: int,
    username: str | None,
    message: str,
    created_at_iso: str,
) -> int:
    cursor = conn.execute(
        "INSERT INTO reports (user_id, username, message, created_at, resolved) VALUES (?, ?, ?, ?, 0)",
        (user_id, username, message, created_at_iso),
    )
    conn.commit()
    return cursor.lastrowid


def recent_unresolved_reports(conn: sqlite3.Connection, limit: int = 20) -> list[tuple[int, int, str | None, str, str]]:
    """Most recent unresolved reports as (id, user_id, username, message, created_at)."""
    return conn.execute(
        "SELECT id, user_id, username, message, created_at FROM reports "
        "WHERE resolved = 0 ORDER BY created_at DESC LIMIT ?",
        (limit,),
    ).fetchall()


def resolve_report(conn: sqlite3.Connection, report_id: int) -> bool:
    """Mark a report resolved. Returns True if a matching report existed."""
    cursor = conn.execute("UPDATE reports SET resolved = 1 WHERE id = ?", (report_id,))
    conn.commit()
    return cursor.rowcount > 0


# --- ratings -------------------------------------------------------------

def upsert_rating(
    conn: sqlite3.Connection,
    *,
    date_iso: str,
    week_type: str,
    day: str,
    meal: str,
    user_id: int,
    score: int,
    created_at_iso: str,
) -> None:
    """Insert a rating, or update the score if this user already rated this (date, meal)."""
    conn.execute(
        """
        INSERT INTO ratings (date, week_type, day, meal, user_id, score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, meal, user_id) DO UPDATE SET score = excluded.score
        """,
        (date_iso, week_type, day, meal, user_id, score, created_at_iso),
    )
    conn.commit()


def distinct_rated_slot_count(conn: sqlite3.Connection) -> int:
    """Number of distinct (week_type, day, meal) slots with at least one rating."""
    row = conn.execute(
        "SELECT COUNT(DISTINCT week_type || '|' || day || '|' || meal) FROM ratings"
    ).fetchone()
    return row[0] if row is not None else 0


def slot_average(conn: sqlite3.Connection, week_type: str, day: str, meal: str) -> tuple[float, int] | None:
    """Mean score and rating count for one slot, or None if it has no ratings."""
    row = conn.execute(
        "SELECT AVG(score), COUNT(*) FROM ratings WHERE week_type = ? AND day = ? AND meal = ?",
        (week_type, day, meal),
    ).fetchone()
    if row is None or row[1] == 0:
        return None
    avg, count = row
    return round(avg, 1), count


def slot_averages_ranked(conn: sqlite3.Connection) -> list[tuple[str, str, str, float, int]]:
    """All rated slots as (week_type, day, meal, avg, count), highest average first."""
    rows = conn.execute(
        """
        SELECT week_type, day, meal, AVG(score), COUNT(*)
        FROM ratings
        GROUP BY week_type, day, meal
        ORDER BY AVG(score) DESC
        """
    ).fetchall()
    return [(wt, d, m, round(avg, 1), cnt) for wt, d, m, avg, cnt in rows]
