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

/**
 * The menu live today: from MENUS_DIR when set (re-read when a file is
 * added or changed, so a new menu needs no restart), else the single
 * menu.yaml loaded at startup. `since` scopes ratings to this menu.
 */
export function currentMenu(state: AppState, todayIso: string): { menu: MenuData; anchor: Date; since: string } {
  const dir = state.config.menusDir;
  if (dir) {
    const active = menuModule.activeMenu(dir, todayIso);
    return { menu: active.menu, anchor: active.anchor, since: active.startIso };
  }
  return { menu: state.menu, anchor: state.weekAnchorDate, since: "0000-00-00" };
}

/** Post today's menu for one meal, if there is one and it isn't already posted. */
export type PostResult = "posted" | "already_posted" | "no_menu" | "no_group" | "failed";

/**
 * `force` (manual `plato-post --again`) skips the once-a-day guard.
 * Returns what happened, for the manual trigger; scheduled runs ignore it.
 */
export async function postMenuJob(state: AppState, meal: MealName, force = false): Promise<PostResult> {
  const { config: cfg, db: dbConn, sock } = state;
  if (!cfg.whatsappGroupJid) {
    logger.warn(`Skipping ${meal} menu post: WHATSAPP_GROUP_JID is not set yet. See README "Getting WHATSAPP_GROUP_JID".`);
    return "no_group";
  }
  try {
    const today = localToday(cfg.timezone);
    const todayIso = today.toISOString().slice(0, 10);
    const { menu: menuData, anchor: weekAnchorDate, since } = currentMenu(state, todayIso);

    const dishes = menuModule.getMenu(menuData, today, weekAnchorDate, meal);
    if (dishes.length === 0) {
      logger.info(`No menu for ${meal} on ${todayIso}; skipping post.`);
      return "no_menu";
    }

    if (!force && db.hasPostedMenu(dbConn, meal, todayIso)) {
      logger.info(`Menu for ${meal} on ${todayIso} already posted; skipping duplicate fire.`);
      return "already_posted";
    }

    const weekType = menuModule.resolveWeekType(today, weekAnchorDate);
    const day = menuModule.dayOf(today);
    // Past ratings of this exact slot under the current menu. Shown in the
    // post only once calibrated, but always given to Plato for its intro.
    const history = ratingsModule.slotAverage(dbConn, weekType, day, meal, since);
    const average = ratingsModule.isCalibrated(dbConn, since) ? history : null;

    const mealCfg = cfg.meals[meal];
    let message = buildMenuMessage(mealCfg.label, today, dishes, average);

    if (cfg.llm.enabled) {
      const phrased = await llmModule.phraseMenuMessage(cfg.llm, cfg.deepseekApiKey, message, {
        dishes,
        meal,
        label: mealCfg.label,
        date: today,
        rating: history,
        scaleMax: cfg.ratings.scaleMax,
        recentIntros: llmModule.recentIntros(dbConn),
        recentAngles: llmModule.recentAngles(dbConn),
      });
      if (phrased !== null) {
        message = phrased.message;
        llmModule.rememberIntro(dbConn, phrased.intro, phrased.angle);
      }
    }

    await sock.sendMessage(cfg.whatsappGroupJid, { text: message });
    db.markPostedMenu(dbConn, meal, todayIso);
    logger.info(`Posted ${meal} menu for ${todayIso}.`);
    return "posted";
  } catch (err) {
    logger.error({ err, meal }, "postMenuJob failed");
    return "failed";
  }
}

/** Post a rating prompt poll (1..scaleMax) for one meal. */
export async function ratingPromptJob(state: AppState, meal: MealName): Promise<void> {
  const { config: cfg, db: dbConn, sock } = state;
  if (!cfg.whatsappGroupJid) {
    logger.warn(`Skipping ${meal} rating prompt: WHATSAPP_GROUP_JID is not set yet. See README "Getting WHATSAPP_GROUP_JID".`);
    return;
  }
  try {
    const today = localToday(cfg.timezone);
    const todayIso = today.toISOString().slice(0, 10);
    const { menu: menuData, anchor: weekAnchorDate } = currentMenu(state, todayIso);
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

  if (!cfg.whatsappGroupJid) {
    logger.warn(
      "WHATSAPP_GROUP_JID is not set — menu-post and rating-prompt jobs are registered but will skip every " +
        'fire until it is. Add the bot number to your group, send a message there, note the JID logged for ' +
        'that incoming message, set WHATSAPP_GROUP_JID in .env, and restart. See README "Getting WHATSAPP_GROUP_JID".',
    );
  }

  for (const meal of Object.keys(cfg.meals) as MealName[]) {
    const mealCfg: MealConfig = cfg.meals[meal];

    cron.schedule(hhmmToCron(mealCfg.postAt), () => void postMenuJob(state, meal), { timezone: cfg.timezone });
    logger.info(`Registered menu-post job for ${meal} at ${mealCfg.postAt} (${cfg.timezone}).`);

    cron.schedule(hhmmToCron(mealCfg.rateAt), () => void ratingPromptJob(state, meal), { timezone: cfg.timezone });
    logger.info(`Registered rating-prompt job for ${meal} at ${mealCfg.rateAt} (${cfg.timezone}).`);
  }
}
