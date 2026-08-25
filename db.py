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

# Ratings and reports query functions are added in phases 3-5, per
# SPEC.md §12's build order.
