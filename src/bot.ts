/**
 * Entrypoint: connects the Baileys WhatsApp socket, registers the message
 * dispatcher + scheduled jobs, and keeps the connection alive.
 *
 * Startup sequence (mirrors SPEC.md §10 / the old bot.py): validate config,
 * validate menu, connect DB, connect WhatsApp, register handlers/jobs, run.
 * Fail fast and loudly on any validation error.
 */

import { existsSync, mkdirSync } from "fs";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import qrcodeTerminal from "qrcode-terminal";

import { loadConfig, ConfigError } from "./config";
import { loadMenu, MenuError } from "./menu";
import * as dbModule from "./db";
import * as ratingsModule from "./ratings";
import * as reportsModule from "./reports";
import * as handlers from "./handlers";
import type { IncomingMessage } from "./handlers";
import { registerJobs, type AppState } from "./jobs";
import { logger } from "./logger";
import { localNowIso } from "./time";

function extractText(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  return m.conversation ?? m.extendedTextMessage?.text ?? null;
}

function parseIncoming(msg: WAMessage): IncomingMessage | null {
  const chatJid = msg.key.remoteJid;
  if (!chatJid) return null;
  const senderJid = msg.key.participant ?? chatJid;
  const text = extractText(msg);
  if (text === null) return null;
  return { chatJid, senderJid, senderName: msg.pushName ?? null, text: text.trim() };
}

async function dispatchCommand(sock: ReturnType<typeof makeWASocket>, state: AppState, incoming: IncomingMessage): Promise<void> {
  const [rawCommand, ...args] = incoming.text.split(/\s+/);
  const command = rawCommand.toLowerCase();

  switch (command) {
    case "/start":
      await handlers.startCommand(sock, incoming);
      return;
    case "/menu":
      await handlers.menuCommand(sock, state, incoming);
      return;
    case "/reloadmenu":
      await handlers.reloadmenuCommand(sock, state, incoming);
      return;
    case "/reports":
      await handlers.reportsCommand(sock, state, incoming);
      return;
    case "/resolve":
      await handlers.resolveCommand(sock, state, incoming, args);
      return;
    case "/stats":
      await handlers.statsCommand(sock, state, incoming);
      return;
    default:
      // Unknown command: ignore, same as the Telegram version (no handler matches).
      return;
  }
}

async function main(): Promise<void> {
  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.error(`Config validation failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  let menuData;
  try {
    menuData = loadMenu(cfg.menuPath);
  } catch (err) {
    if (err instanceof MenuError) {
      logger.error(`Menu validation failed: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  logger.info("Config and menu validated. Connecting database.");
  const db = dbModule.connect(cfg.dbPath);

  if (!existsSync(cfg.authDir)) {
    mkdirSync(cfg.authDir, { recursive: true });
  }
  const { state: authState, saveCreds } = await useMultiFileAuthState(cfg.authDir);

  logger.info("Connecting to WhatsApp.");
  // Baileys' own log stream is very chatty at info level; give it our
  // structured logger but pinned to 'warn' so only real problems surface.
  const baileysLogger = logger.child({ module: "baileys" });
  baileysLogger.level = "warn";
  const sock = makeWASocket({
    auth: authState,
    logger: baileysLogger as never,
    printQRInTerminal: false,
  });

  const weekAnchorDate = new Date(cfg.weekAnchorDate + "T00:00:00Z");
  const appState: AppState = { config: cfg, db, menu: menuData, weekAnchorDate, sock };

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("Scan this QR code from the bot number's WhatsApp app (Linked Devices):");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.error({ statusCode }, "WhatsApp connection closed.");
      if (shouldReconnect) {
        logger.info("Reconnecting.");
        void main();
      } else {
        logger.error("Logged out — delete the auth directory and re-scan the QR code to relink.");
        process.exit(1);
      }
    } else if (connection === "open") {
      logger.info("WhatsApp connection open.");
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      void handleIncomingMessage(sock, appState, msg);
    }
  });

  sock.ev.on("messages.update", (updates) => {
    for (const update of updates) {
      const pollUpdates = update.update.pollUpdates;
      if (!pollUpdates) continue;
      for (const pollUpdate of pollUpdates) {
        void ratingsModule.handlePollVoteUpdate(db, pollUpdate, localNowIso(cfg.timezone));
      }
    }
  });

  registerJobs(appState);
  logger.info("Bot ready.");
}

async function handleIncomingMessage(
  sock: ReturnType<typeof makeWASocket>,
  state: AppState,
  msg: WAMessage,
): Promise<void> {
  try {
    // Logged unconditionally (any message, any content type) so the group
    // JID can be discovered by sending anything in the group once the bot
    // is a member — see README "Getting WHATSAPP_GROUP_JID".
    if (msg.key.remoteJid) {
      logger.info(
        { chatJid: msg.key.remoteJid, isGroup: msg.key.remoteJid.endsWith("@g.us") },
        "Incoming message.",
      );
    }

    const incoming = parseIncoming(msg);
    if (incoming === null || !incoming.text) return;

    if (incoming.text.startsWith("/")) {
      await dispatchCommand(sock, state, incoming);
      return;
    }

    // Any non-command private text message is a menu-correction report.
    if (handlers.isDm(incoming.chatJid)) {
      await reportsModule.handleReportDm(
        sock,
        state.config,
        state.db,
        incoming.senderJid,
        incoming.senderName,
        incoming.text,
      );
    }
  } catch (err) {
    logger.error({ err }, "Failed to handle incoming message.");
  }
}

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup.");
  process.exit(1);
});
