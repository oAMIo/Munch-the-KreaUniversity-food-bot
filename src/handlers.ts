/**
 * WhatsApp text-command handlers (/start, /menu, /reloadmenu, /reports,
 * /resolve, /stats). Direct port of handlers.py.
 *
 * WhatsApp has no slash-command framework, so these are dispatched by
 * plain-text prefix matching in bot.ts against each incoming message —
 * same command surface and admin gating as the Telegram version, just
 * matched against message text instead of PTB's CommandHandler.
 */

import type { WASocket } from "@whiskeysockets/baileys";
import type { AppState } from "./jobs";
import * as db from "./db";
import * as menuModule from "./menu";
import * as ratingsModule from "./ratings";
import * as jobsModule from "./jobs";
import { logger } from "./logger";
import { localNowHHMM, localToday } from "./time";
import type { MealName } from "./config";

export const START_MESSAGE =
  "Hi! I post the mess menu before each meal and collect ratings afterwards. " +
  "If a posted menu was wrong, just send me a message here (DM) describing " +
  "the mistake and I'll pass it on.";

export const NO_MEALS_LEFT_MESSAGE = "That's everything for today — see you tomorrow!";
export const NO_REPORTS_MESSAGE = "No unresolved reports right now.";

export interface IncomingMessage {
  chatJid: string; // group (@g.us) or DM (@s.whatsapp.net) this message arrived in
  senderJid: string;
  senderName: string | null;
  text: string;
}

export function isDm(jid: string): boolean {
  return jid.endsWith("@s.whatsapp.net");
}

export function isAdmin(msg: IncomingMessage, state: AppState): boolean {
  return msg.senderJid === state.config.whatsappAdminJid;
}

function remainingMeals(state: AppState, nowHHMM: string): MealName[] {
  return (Object.keys(state.config.meals) as MealName[]).filter((meal) => state.config.meals[meal].postAt > nowHHMM);
}

export async function startCommand(sock: WASocket, msg: IncomingMessage): Promise<void> {
  await sock.sendMessage(msg.chatJid, { text: START_MESSAGE });
}

export async function menuCommand(sock: WASocket, state: AppState, msg: IncomingMessage): Promise<void> {
  const cfg = state.config;
  const today = localToday(cfg.timezone);
  const nowHHMM = localNowHHMM(cfg.timezone);
  const remaining = remainingMeals(state, nowHHMM);

  const calibrated = ratingsModule.isCalibrated(state.db);
  const weekType = menuModule.resolveWeekType(today, state.weekAnchorDate);
  const day = menuModule.dayOf(today);

  let sentAny = false;
  for (const meal of remaining) {
    const dishes = menuModule.getMenu(state.menu, today, state.weekAnchorDate, meal);
    if (dishes.length === 0) continue;
    const average = calibrated ? ratingsModule.slotAverage(state.db, weekType, day, meal) : null;
    const message = jobsModule.buildMenuMessage(cfg.meals[meal].label, today, dishes, average);
    await sock.sendMessage(msg.chatJid, { text: message });
    sentAny = true;
  }

  if (!sentAny) {
    await sock.sendMessage(msg.chatJid, { text: NO_MEALS_LEFT_MESSAGE });
  }
}

export async function reloadmenuCommand(sock: WASocket, state: AppState, msg: IncomingMessage): Promise<void> {
  if (!isDm(msg.chatJid) || !isAdmin(msg, state)) return;

  try {
    state.menu = menuModule.loadMenu(state.config.menuPath);
  } catch (err) {
    if (err instanceof menuModule.MenuError) {
      logger.error(`/reloadmenu failed validation: ${err.message}`);
      await sock.sendMessage(msg.chatJid, { text: `Reload failed, previous menu stays active:\n${err.message}` });
      return;
    }
    throw err;
  }

  logger.info(`Menu reloaded from ${state.config.menuPath} via /reloadmenu.`);
  await sock.sendMessage(msg.chatJid, { text: "Menu reloaded successfully." });
}

function formatReportLine(row: db.ReportRow): string {
  const who = row.username ? `@${row.username}` : row.user_id;
  return `#${row.id} — ${who} — ${row.created_at}\n${row.message}`;
}

export async function reportsCommand(sock: WASocket, state: AppState, msg: IncomingMessage): Promise<void> {
  if (!isDm(msg.chatJid) || !isAdmin(msg, state)) return;

  const rows = db.recentUnresolvedReports(state.db, 20);
  if (rows.length === 0) {
    await sock.sendMessage(msg.chatJid, { text: NO_REPORTS_MESSAGE });
    return;
  }

  const body = rows.map(formatReportLine).join("\n\n");
  await sock.sendMessage(msg.chatJid, { text: body });
}

export async function resolveCommand(sock: WASocket, state: AppState, msg: IncomingMessage, args: string[]): Promise<void> {
  if (!isDm(msg.chatJid) || !isAdmin(msg, state)) return;

  if (args.length === 0 || !/^\d+$/.test(args[0])) {
    await sock.sendMessage(msg.chatJid, { text: "Usage: /resolve <id>" });
    return;
  }

  const reportId = Number(args[0]);
  const resolved = db.resolveReport(state.db, reportId);

  if (resolved) {
    logger.info(`Report #${reportId} marked resolved via /resolve.`);
    await sock.sendMessage(msg.chatJid, { text: `Report #${reportId} marked resolved.` });
  } else {
    await sock.sendMessage(msg.chatJid, { text: `No report with id ${reportId}.` });
  }
}

function formatSlotLine(row: db.SlotAverageRow): string {
  const [weekType, day, meal, avg, count] = row;
  return `${weekType} ${day} ${meal} — ${avg}/5 (${count} ratings)`;
}

export async function statsCommand(sock: WASocket, state: AppState, msg: IncomingMessage): Promise<void> {
  if (!isDm(msg.chatJid) || !isAdmin(msg, state)) return;

  const ratedSlots = db.distinctRatedSlotCount(state.db);
  const ranked = db.slotAveragesRanked(state.db);

  const lines = [`Calibration: ${ratedSlots}/${menuModule.TOTAL_SLOTS} slots rated`];

  if (ranked.length > 0) {
    const top5 = ranked.slice(0, 5);
    const bottom5 = ranked.slice(-5).reverse();
    lines.push("\nHighest rated:");
    lines.push(...top5.map((row, i) => `${i + 1}. ${formatSlotLine(row)}`));
    lines.push("\nLowest rated:");
    lines.push(...bottom5.map((row, i) => `${i + 1}. ${formatSlotLine(row)}`));
  } else {
    lines.push("\nNo ratings yet.");
  }

  await sock.sendMessage(msg.chatJid, { text: lines.join("\n") });
}
