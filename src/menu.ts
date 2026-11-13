/**
 * Loads/reloads menu.yaml and resolves "what is today's menu".
 *
 * menu.yaml is hand-authored by a human (SPEC.md §4.1). The loader here is
 * intentionally strict: it validates the exact expected structure and raises
 * a clear error naming the offending key. It never fills in defaults and
 * never accepts a partial file. Direct port of the old menu.py.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import * as yaml from "js-yaml";
import type { MealName } from "./config";

export const WEEK_TYPES = ["even_week", "odd_week"] as const;
export type WeekType = (typeof WEEK_TYPES)[number];

export const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
export type Day = (typeof DAYS)[number];

export const MEALS: readonly MealName[] = ["breakfast", "lunch", "snack", "dinner"];

// 56, computed, not hardcoded.
export const TOTAL_SLOTS = WEEK_TYPES.length * DAYS.length * MEALS.length;

export type MenuData = Record<WeekType, Record<Day, Record<MealName, string[]>>>;

export class MenuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MenuError";
  }
}

/**
 * Load and strictly validate menu.yaml. Returns the raw nested object.
 *
 * Throws MenuError naming the exact missing/malformed key on any deviation
 * from the structure defined in SPEC.md §4.1.
 */
export function loadMenu(menuPath: string): MenuData {
  if (!existsSync(menuPath)) {
    throw new MenuError(`menu.yaml not found at ${menuPath}.`);
  }

  const raw = yaml.load(readFileSync(menuPath, "utf-8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MenuError("menu.yaml: top level must be a mapping.");
  }
  const rawObj = raw as Record<string, unknown>;

  const missingWeeks = WEEK_TYPES.filter((w) => !(w in rawObj));
  if (missingWeeks.length > 0) {
    throw new MenuError(`menu.yaml: missing top-level key(s): ${JSON.stringify(missingWeeks)}.`);
  }

  const extraWeeks = Object.keys(rawObj).filter((k) => !(WEEK_TYPES as readonly string[]).includes(k));
  if (extraWeeks.length > 0) {
    throw new MenuError(
      `menu.yaml: unexpected top-level key(s): ${JSON.stringify(extraWeeks)}. Only ${JSON.stringify(WEEK_TYPES)} allowed.`,
    );
  }

  for (const weekType of WEEK_TYPES) {
    const weekRaw = rawObj[weekType];
    if (typeof weekRaw !== "object" || weekRaw === null || Array.isArray(weekRaw)) {
      throw new MenuError(`menu.yaml: '${weekType}' must be a mapping.`);
    }
    const weekRawObj = weekRaw as Record<string, unknown>;

    const missingDays = DAYS.filter((d) => !(d in weekRawObj));
    if (missingDays.length > 0) {
      throw new MenuError(`menu.yaml: ${weekType}: missing day key(s): ${JSON.stringify(missingDays)}.`);
    }

    const extraDays = Object.keys(weekRawObj).filter((k) => !(DAYS as readonly string[]).includes(k));
    if (extraDays.length > 0) {
      throw new MenuError(`menu.yaml: ${weekType}: unexpected day key(s): ${JSON.stringify(extraDays)}.`);
    }

    for (const day of DAYS) {
      const dayRaw = weekRawObj[day];
      const context = `${weekType}.${day}`;
      if (typeof dayRaw !== "object" || dayRaw === null || Array.isArray(dayRaw)) {
        throw new MenuError(`menu.yaml: ${context} must be a mapping.`);
      }
      const dayRawObj = dayRaw as Record<string, unknown>;

      const missingMeals = MEALS.filter((m) => !(m in dayRawObj));
      if (missingMeals.length > 0) {
        throw new MenuError(`menu.yaml: ${context}: missing meal key(s): ${JSON.stringify(missingMeals)}.`);
      }

      const extraMeals = Object.keys(dayRawObj).filter((k) => !(MEALS as readonly string[]).includes(k));
      if (extraMeals.length > 0) {
        throw new MenuError(`menu.yaml: ${context}: unexpected meal key(s): ${JSON.stringify(extraMeals)}.`);
      }

      for (const meal of MEALS) {
        const dishes = dayRawObj[meal];
        const mealContext = `${context}.${meal}`;
        if (!Array.isArray(dishes)) {
          throw new MenuError(
            `menu.yaml: ${mealContext} must be a list (use [] for an empty meal), got ${JSON.stringify(dishes)}.`,
          );
        }
        dishes.forEach((dish, i) => {
          if (typeof dish !== "string" || !dish.trim()) {
            throw new MenuError(
              `menu.yaml: ${mealContext}[${i}] must be a non-empty dish-name string, got ${JSON.stringify(dish)}.`,
            );
          }
        });
      }
    }
  }

  return rawObj as unknown as MenuData;
}

/**
 * Resolve 'even_week' or 'odd_week' for `today`, relative to the anchor.
 *
 * The ISO week containing `weekAnchorDate` is treated as an ODD week.
 * Parity is derived from a *continuous* count of whole weeks between the
 * anchor's ISO-week Monday and today's ISO-week Monday (SPEC.md §5.2),
 * because raw ISO week numbers reset across year boundaries.
 *
 * This is the single implementation of week-type resolution. Call it
 * everywhere; never reimplement it inline.
 */
export function resolveWeekType(today: Date, weekAnchorDate: Date): WeekType {
  const isoWeekday = (d: Date): number => {
    // Monday=1 ... Sunday=7, matching Python's date.isocalendar()[2].
    const jsDay = d.getUTCDay(); // Sunday=0 ... Saturday=6
    return jsDay === 0 ? 7 : jsDay;
  };
  const mondayOf = (d: Date): Date => {
    const delta = isoWeekday(d) - 1;
    const monday = new Date(d);
    monday.setUTCDate(monday.getUTCDate() - delta);
    return monday;
  };

  const anchorMonday = mondayOf(weekAnchorDate);
  const todayMonday = mondayOf(today);
  const msPerDay = 24 * 60 * 60 * 1000;
  const weeksDiff = Math.floor((todayMonday.getTime() - anchorMonday.getTime()) / (7 * msPerDay));

  return weeksDiff % 2 === 0 ? "odd_week" : "even_week";
}

/** Parse an ISO 'YYYY-MM-DD' local-date string into a UTC-midnight Date, for date-only arithmetic. */
export function parseIsoDate(dateIso: string): Date {
  const [year, month, day] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Resolve week type + weekday name for `today` and return the dish list.
 *
 * Throws MenuError if the slot is missing (should not happen against a
 * validated menu, but guards against a partially-reloaded/corrupt object).
 */
export function getMenu(
  menu: MenuData,
  today: Date,
  weekAnchorDate: Date,
  meal: MealName,
): string[] {
  if (!(MEALS as readonly string[]).includes(meal)) {
    throw new MenuError(`getMenu: unknown meal '${meal}'. Must be one of ${JSON.stringify(MEALS)}.`);
  }

  const weekType = resolveWeekType(today, weekAnchorDate);
  const day = dayOf(today);

  const slot = menu[weekType]?.[day]?.[meal];
  if (slot === undefined) {
    throw new MenuError(`menu: slot ${weekType}.${day}.${meal} is missing.`);
  }
  return slot;
}

/** The lowercase weekday name (DAYS entry) for a date-only UTC-midnight Date. */
export function dayOf(d: Date): Day {
  const jsDay = d.getUTCDay(); // Sunday=0 ... Saturday=6
  const index = jsDay === 0 ? 6 : jsDay - 1; // 0=monday ... 6=sunday
  return DAYS[index];
}

// --- scheduled menus ------------------------------------------------------
// MENUS_DIR holds one file per menu, named by its go-live date:
// `2026-11-20.yaml`. On any day the live menu is the file with the latest
// date that is <= today. A menu's two-week cycle starts on its go-live date:
// the ISO week containing that date is its odd_week (week 1).

export const MENU_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.yaml$/;

export interface MenuFile {
  startIso: string;
  path: string;
}

export interface ActiveMenu {
  menu: MenuData;
  startIso: string;
  anchor: Date;
}

export function listMenuFiles(dir: string): MenuFile[] {
  if (!existsSync(dir)) throw new MenuError(`menus folder not found at ${dir}.`);
  return readdirSync(dir)
    .map((name) => ({ name, m: MENU_FILE_RE.exec(name) }))
    .filter((x) => x.m !== null)
    .map((x) => ({ startIso: x.m![1], path: join(dir, x.name) }))
    .sort((a, b) => a.startIso.localeCompare(b.startIso));
}

const menuCache = new Map<string, { mtimeMs: number; menu: MenuData }>();

/** Load a menu file, re-reading it only when it changed on disk. */
function loadMenuCached(path: string): MenuData {
  const mtimeMs = statSync(path).mtimeMs;
  const hit = menuCache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.menu;
  const menu = loadMenu(path);
  menuCache.set(path, { mtimeMs, menu });
  return menu;
}

/** The menu live on `todayIso` (YYYY-MM-DD). Throws MenuError if none has started yet. */
export function activeMenu(dir: string, todayIso: string): ActiveMenu {
  const started = listMenuFiles(dir).filter((f) => f.startIso <= todayIso);
  const current = started[started.length - 1];
  if (!current) throw new MenuError(`no menu in ${dir} has gone live by ${todayIso}.`);
  return { menu: loadMenuCached(current.path), startIso: current.startIso, anchor: parseIsoDate(current.startIso) };
}
