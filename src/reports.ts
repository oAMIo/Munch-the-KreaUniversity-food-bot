/**
 * DM report handling (SPEC.md §5.9).
 *
 * Any private, non-command text message to the bot's WhatsApp number is
 * treated as a menu-correction report: store it, confirm receipt to the
 * sender, and forward a copy to the admin. Direct port of reports.py.
 */

import type { WASocket } from "@whiskeysockets/baileys";
import type { DB } from "./db";
import * as db from "./db";
import type { Config } from "./config";
import { logger } from "./logger";
import { localNowIso } from "./time";

export const CONFIRMATION_MESSAGE = "Thanks — I've passed this along to the admin.";

function formatAdminForward(reportId: number, userId: string, username: string | null, message: string): string {
  const who = username ? `@${username}` : userId;
  return `New menu report #${reportId} from ${who}:\n\n${message}`;
}

export async function handleReportDm(
  sock: WASocket,
  cfg: Config,
  dbConn: DB,
  senderJid: string,
  senderName: string | null,
  messageText: string,
): Promise<void> {
  const createdAtIso = localNowIso(cfg.timezone);
  const reportId = db.insertReport(dbConn, {
    userId: senderJid,
    username: senderName,
    message: messageText,
    createdAtIso,
  });
  logger.info(`Stored report #${reportId} from user=${senderJid}.`);

  await sock.sendMessage(senderJid, { text: CONFIRMATION_MESSAGE });

  try {
    await sock.sendMessage(cfg.whatsappAdminJid, {
      text: formatAdminForward(reportId, senderJid, senderName, messageText),
    });
  } catch (err) {
    logger.error({ err }, `Failed to forward report #${reportId} to admin.`);
  }
}
