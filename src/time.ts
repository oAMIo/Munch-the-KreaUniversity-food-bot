/**
 * Timezone-aware date/time helpers, replacing Python's `zoneinfo.ZoneInfo`
 * usage throughout the old codebase. Every "what is today / what time is
 * it" call must go through here — never a naive `new Date()`.
 *
 * `today`-shaped values elsewhere in this codebase are UTC-midnight `Date`
 * objects standing in for a local calendar date (see menu.parseIsoDate) —
 * date-only arithmetic, not an instant. Use `localTodayIso`/`localNowHHMM`
 * to derive those from the wall clock in `config.timezone`.
 */

import { parseIsoDate } from "./menu";

/** Today's local calendar date, as 'YYYY-MM-DD', in the given IANA timezone. */
export function localTodayIso(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Current local wall-clock time, as 'HH:MM' (24-hour), in the given IANA timezone. */
export function localNowHHMM(timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
}

/** Today's local calendar date as a UTC-midnight Date (date-only arithmetic). */
export function localToday(timezone: string): Date {
  return parseIsoDate(localTodayIso(timezone));
}

/** Current local timestamp, ISO 8601 with the timezone's offset, for created_at columns. */
export function localNowIso(timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Full weekday name (UTC-rendered, since `date` is a date-only UTC-midnight value). */
export function formatWeekday(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(date);
}

/** 'DD Mon' (UTC-rendered), e.g. '05 Sep'. */
export function formatDayMonth(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).format(date);
}
