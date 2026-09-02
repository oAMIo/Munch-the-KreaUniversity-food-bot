/**
 * The scheduled job functions (menu post, rating prompt) + job registration.
 *
 * Direct port of jobs.py. Scheduling moves from PTB's JobQueue to
 * `node-cron` (SPEC.md §2's "one scheduler only" rule carries over — this
 * is the single scheduler in the Node port). Telegram HTML formatting is
 * replaced with WhatsApp's plain-text markup (`*bold*`); no escaping is
 * needed since WhatsApp has no markup-injection risk the way Telegram HTML
 * parse mode did.
 */

import cron from "node-cron";
import type { WASocket } from "@whiskeysockets/baileys";
import type { Config, MealConfig, MealName } from "./config";
import type { DB } from "./db";
import * as db from "./db";
import * as menuModule from "./menu";
import type { MenuData } from "./menu";
import * as ratingsModule from "./ratings";
import * as llmModule from "./llm";
import { logger } from "./logger";
import { formatDayMonth, formatWeekday, localNowIso, localToday } from "./time";

export interface AppState {
  config: Config;
  db: DB;
  menu: MenuData;
  weekAnchorDate: Date;
  sock: WASocket;
}

/**
 * Deterministic base menu message (SPEC.md §6).
 *
 * `average`, if given as [avg, count], is appended only once calibrated
 * (SPEC.md §5.7/§5.8) — until then menu posts carry no rating info.
 */
export function buildMenuMessage(
  label: string,
  date: Date,
  dishes: string[],
  average: [number, number] | null = null,
): string {
  const header = `🍽️ *${label}* — ${formatWeekday(date)}, ${formatDayMonth(date)}`;
  const lines = dishes.map((dish) => `• ${dish}`).join("\n");
  let message = `${header}\n\n${lines}`;
  if (average !== null) {
    const [avg, count] = average;
    message += `\n\n★ ${avg}/5 from ${count} ratings`;
  }
  return message;
}

/** Post today's menu for one meal, if there is one and it isn't already posted. */
export async function postMenuJob(state: AppState, meal: MealName): Promise<void> {
  const { config: cfg, db: dbConn, menu: menuData, weekAnchorDate, sock } = state;
  try {
    const today = localToday(cfg.timezone);
    const todayIso = today.toISOString().slice(0, 10);

    const dishes = menuModule.getMenu(menuData, today, weekAnchorDate, meal);
    if (dishes.length === 0) {
      logger.info(`No menu for ${meal} on ${todayIso}; skipping post.`);
      return;
    }

    if (db.hasPostedMenu(dbConn, meal, todayIso)) {
      logger.info(`Menu for ${meal} on ${todayIso} already posted; skipping duplicate fire.`);
      return;
    }

    let average: [number, number] | null = null;
    if (ratingsModule.isCalibrated(dbConn)) {
      const weekType = menuModule.resolveWeekType(today, weekAnchorDate);
      const day = menuModule.dayOf(today);
      average = ratingsModule.slotAverage(dbConn, weekType, day, meal);
    }

    const mealCfg = cfg.meals[meal];
    let message = buildMenuMessage(mealCfg.label, today, dishes, average);

    if (cfg.llm.enabled) {
      const phrased = await llmModule.phraseMenuMessage(cfg.llm, cfg.deepseekApiKey, message, dishes);
      if (phrased !== null) {
        message = phrased;
      }
    }

    await sock.sendMessage(cfg.whatsappGroupJid, { text: message });
    db.markPostedMenu(dbConn, meal, todayIso);
    logger.info(`Posted ${meal} menu for ${todayIso}.`);
  } catch (err) {
    logger.error({ err, meal }, "postMenuJob failed");
  }
}

/** Post a rating prompt poll (1..scaleMax) for one meal. */
export async function ratingPromptJob(state: AppState, meal: MealName): Promise<void> {
  const { config: cfg, db: dbConn, menu: menuData, weekAnchorDate, sock } = state;
  try {
    const today = localToday(cfg.timezone);
    const todayIso = today.toISOString().slice(0, 10);
    const weekType = menuModule.resolveWeekType(today, weekAnchorDate);
    const day = menuModule.dayOf(today);

    const dishes = menuModule.getMenu(menuData, today, weekAnchorDate, meal);
    if (dishes.length === 0) {
      logger.info(`No menu for ${meal} on ${todayIso}; skipping rating prompt.`);
      return;
    }

    const mealCfg = cfg.meals[meal];
    await ratingsModule.sendRatingPoll(sock, cfg.whatsappGroupJid, dbConn, {
      label: mealCfg.label,
      scaleMax: cfg.ratings.scaleMax,
      dateIso: todayIso,
      weekType,
      day,
      meal,
      createdAtIso: localNowIso(cfg.timezone),
    });
    logger.info(`Posted ${meal} rating prompt for ${todayIso}.`);
  } catch (err) {
    logger.error({ err, meal }, "ratingPromptJob failed");
  }
}

function hhmmToCron(hhmm: string): string {
  const [hour, minute] = hhmm.split(":");
  return `${Number(minute)} ${Number(hour)} * * *`;
}

/** Register the daily menu-post and rating-prompt cron jobs for each of the four meals. */
export function registerJobs(state: AppState): void {
  const { config: cfg } = state;

  for (const meal of Object.keys(cfg.meals) as MealName[]) {
    const mealCfg: MealConfig = cfg.meals[meal];

    cron.schedule(hhmmToCron(mealCfg.postAt), () => void postMenuJob(state, meal), { timezone: cfg.timezone });
    logger.info(`Registered menu-post job for ${meal} at ${mealCfg.postAt} (${cfg.timezone}).`);

    cron.schedule(hhmmToCron(mealCfg.rateAt), () => void ratingPromptJob(state, meal), { timezone: cfg.timezone });
    logger.info(`Registered rating-prompt job for ${meal} at ${mealCfg.rateAt} (${cfg.timezone}).`);
  }
}
