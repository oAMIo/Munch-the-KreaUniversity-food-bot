/**
 * All SQLite access: schema creation + every query function.
 *
 * Per AGENTS.md, all SQL lives here — nowhere else in the codebase.
 * Parameterised queries only, never string interpolation into SQL.
 * Direct port of the old db.py, plus one new table (`poll_votes`) that
 * replaces Telegram's callback_data: it maps a WhatsApp poll message's
 * stanza id back to the (date, week_type, day, meal) slot it was asking
 * about, since WhatsApp poll options carry no payload of their own.
 */

import Database from "better-sqlite3";
import type { MealName } from "./config";
import type { Day, WeekType } from "./menu";

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ratings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT    NOT NULL,   -- ISO YYYY-MM-DD, local date of the meal
    week_type  TEXT    NOT NULL,   -- 'even_week' | 'odd_week'
    day        TEXT    NOT NULL,   -- 'monday' ... 'sunday'
    meal       TEXT    NOT NULL,   -- 'breakfast' | 'lunch' | 'snack' | 'dinner'
    user_id    TEXT    NOT NULL,   -- WhatsApp JID of the voter
    score      INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    UNIQUE(date, meal, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_slot ON ratings(week_type, day, meal);

CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,   -- WhatsApp JID of the reporter
    username   TEXT,
    message    TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    resolved   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_message_id TEXT PRIMARY KEY,  -- Baileys message key id of the poll
    date            TEXT    NOT NULL,
    week_type       TEXT    NOT NULL,
    day             TEXT    NOT NULL,
    meal            TEXT    NOT NULL,
    scale_max       INTEGER NOT NULL,
    created_at      TEXT    NOT NULL
);
`;

export function connect(dbPath: string): DB {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

// --- state table -------------------------------------------------------

export function getState(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// --- menu-post idempotency ---------------------------------------------
// One row per meal, holding the ISO date it was last posted on. A second
// job fire for the same (date, meal) is a no-op.

function lastPostedMenuKey(meal: MealName): string {
  return `last_posted_menu:${meal}`;
}

export function hasPostedMenu(db: DB, meal: MealName, dateIso: string): boolean {
  return getState(db, lastPostedMenuKey(meal)) === dateIso;
}

export function markPostedMenu(db: DB, meal: MealName, dateIso: string): void {
  setState(db, lastPostedMenuKey(meal), dateIso);
}

// --- reports -------------------------------------------------------------

export interface ReportRow {
  id: number;
  user_id: string;
  username: string | null;
  message: string;
  created_at: string;
}

export function insertReport(
  db: DB,
  args: { userId: string; username: string | null; message: string; createdAtIso: string },
): number {
  const result = db
    .prepare("INSERT INTO reports (user_id, username, message, created_at, resolved) VALUES (?, ?, ?, ?, 0)")
    .run(args.userId, args.username, args.message, args.createdAtIso);
  return Number(result.lastInsertRowid);
}

export function recentUnresolvedReports(db: DB, limit = 20): ReportRow[] {
  return db
    .prepare(
      "SELECT id, user_id, username, message, created_at FROM reports WHERE resolved = 0 ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as ReportRow[];
}

export function resolveReport(db: DB, reportId: number): boolean {
  const result = db.prepare("UPDATE reports SET resolved = 1 WHERE id = ?").run(reportId);
  return result.changes > 0;
}

// --- ratings -------------------------------------------------------------

export function upsertRating(
  db: DB,
  args: {
    dateIso: string;
    weekType: WeekType;
    day: Day;
    meal: MealName;
    userId: string;
    score: number;
    createdAtIso: string;
  },
): void {
  db.prepare(
    `INSERT INTO ratings (date, week_type, day, meal, user_id, score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, meal, user_id) DO UPDATE SET score = excluded.score`,
  ).run(args.dateIso, args.weekType, args.day, args.meal, args.userId, args.score, args.createdAtIso);
}

// `since` (YYYY-MM-DD) limits to ratings from the current menu onwards, so
// a new menu's averages aren't mixed with a previous menu's food.
export function distinctRatedSlotCount(db: DB, since = "0000-00-00"): number {
  const row = db
    .prepare("SELECT COUNT(DISTINCT week_type || '|' || day || '|' || meal) AS n FROM ratings WHERE date >= ?")
    .get(since) as { n: number };
  return row.n;
}

export function slotAverage(
  db: DB,
  weekType: WeekType,
  day: Day,
  meal: MealName,
  since = "0000-00-00",
): [number, number] | null {
  const row = db
    .prepare(
      "SELECT AVG(score) AS avg, COUNT(*) AS count FROM ratings WHERE week_type = ? AND day = ? AND meal = ? AND date >= ?",
    )
    .get(weekType, day, meal, since) as { avg: number | null; count: number };
  if (!row || row.count === 0) return null;
  return [Math.round(row.avg! * 10) / 10, row.count];
}

export type SlotAverageRow = [WeekType, Day, MealName, number, number];

export function slotAveragesRanked(db: DB): SlotAverageRow[] {
  const rows = db
    .prepare(
      `SELECT week_type, day, meal, AVG(score) AS avg, COUNT(*) AS count
       FROM ratings
       GROUP BY week_type, day, meal
       ORDER BY AVG(score) DESC`,
    )
    .all() as { week_type: WeekType; day: Day; meal: MealName; avg: number; count: number }[];
  return rows.map((r) => [r.week_type, r.day, r.meal, Math.round(r.avg * 10) / 10, r.count]);
}

// --- poll_votes ------------------------------------------------------------
// Replaces Telegram's callback_data: maps a poll message id back to the
// slot it was asking about, since WhatsApp poll options carry no payload.

export interface PollVoteRow {
  poll_message_id: string;
  date: string;
  week_type: WeekType;
  day: Day;
  meal: MealName;
  scale_max: number;
  created_at: string;
}

export function insertPollVoteMapping(
  db: DB,
  args: {
    pollMessageId: string;
    dateIso: string;
    weekType: WeekType;
    day: Day;
    meal: MealName;
    scaleMax: number;
    createdAtIso: string;
  },
): void {
  db.prepare(
    `INSERT INTO poll_votes (poll_message_id, date, week_type, day, meal, scale_max, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(poll_message_id) DO NOTHING`,
  ).run(args.pollMessageId, args.dateIso, args.weekType, args.day, args.meal, args.scaleMax, args.createdAtIso);
}

export function getPollVoteMapping(db: DB, pollMessageId: string): PollVoteRow | null {
  const row = db.prepare("SELECT * FROM poll_votes WHERE poll_message_id = ?").get(pollMessageId) as
    | PollVoteRow
    | undefined;
  return row ?? null;
}
