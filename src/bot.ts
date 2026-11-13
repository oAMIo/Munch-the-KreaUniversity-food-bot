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
import { listMenuFiles, loadMenu, MenuError } from "./menu";
import * as dbModule from "./db";
import * as ratingsModule from "./ratings";
import * as reportsModule from "./reports";
import * as handlers from "./handlers";
import type { IncomingMessage } from "./handlers";
import { registerJobs, type AppState } from "./jobs";
import { startControlServer } from "./control";
import { acquireInstanceLock, LockError } from "./lock";
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

type Sock = ReturnType<typeof makeWASocket>;

/** Everything a running connection needs to reconnect itself in place. */
interface RunningState {
  appState: AppState;
  authDir: string;
}

// Disconnect codes meaning the stored *credentials* are dead, not just
// the socket. No amount of retrying fixes these — they need a human to
// re-scan the QR code — and retrying would spin against WhatsApp's
// servers with credentials it has already rejected, risking a
// rate-limit/ban on the number.
const FATAL_DISCONNECT_CODES: ReadonlySet<number> = new Set([
  DisconnectReason.loggedOut,
  DisconnectReason.badSession,
  DisconnectReason.multideviceMismatch,
]);

const RECONNECT_DELAYS_SEC = [2, 5, 10, 20, 30, 60];
// `connectionReplaced` (440) means another connection took over this
// session — a stray `npm run dev`, or someone opening WhatsApp Web on the
// bot's number. The credentials are still good, so the bot reclaims the
// session rather than staying down; but it waits a while first, so two
// instances can't ping-pong kicking each other off several times a
// second. src/lock.ts prevents the common local cause outright.
const RECLAIM_DELAY_SEC = 60;
let reconnectAttempt = 0;
let reconnectTimer: NodeJS.Timeout | null = null;

function scheduleReconnect(rs: RunningState, delayOverrideSec?: number): void {
  if (reconnectTimer) return; // a reconnect is already queued
  const delaySec =
    delayOverrideSec ??
    RECONNECT_DELAYS_SEC[Math.min(reconnectAttempt, RECONNECT_DELAYS_SEC.length - 1)];
  reconnectAttempt += 1;
  logger.info(`Reconnecting to WhatsApp in ${delaySec}s (attempt ${reconnectAttempt}).`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect(rs).catch((err) => {
      logger.error({ err }, "Reconnect attempt failed to even establish a socket.");
      scheduleReconnect(rs);
    });
  }, delaySec * 1000);
}

/**
 * (Re-)establishes the WhatsApp socket for an already-built RunningState
 * and wires its event handlers. Baileys sockets are single-use — closed
 * ones can't be revived — so this is called once at startup and again on
 * every reconnect, but it deliberately touches nothing else: no config
 * reload, no DB reconnect, no `registerJobs`. Those used to happen on
 * every reconnect (the old code re-ran the whole of `main()`), which
 * meant every reconnect silently stacked a *second* set of cron jobs on
 * top of the first — duplicate menu posts and rating prompts in the
 * group after enough reconnects. Only `appState.sock` is swapped.
 */
async function connect(rs: RunningState): Promise<void> {
  const { appState } = rs;
  const cfg = appState.config;

  const { state: authState, saveCreds } = await useMultiFileAuthState(rs.authDir);

  logger.info("Connecting to WhatsApp.");
  // Baileys' own log stream is very chatty at info level; give it our
  // structured logger but pinned to 'warn' so only real problems surface.
  // BAILEYS_LOG_LEVEL overrides it — set it to 'debug' to see every frame
  // sent and received, which is how you tell "WhatsApp isn't delivering
  // to us" apart from "we received it and dropped it".
  const baileysLogger = logger.child({ module: "baileys" });
  baileysLogger.level = process.env.BAILEYS_LOG_LEVEL ?? "warn";
  const sock = makeWASocket({
    auth: authState,
    logger: baileysLogger as never,
    printQRInTerminal: false,
    // Personal number: don't show as "online" all the time, which would also
    // stop the owner's phone from getting notifications.
    markOnlineOnConnect: false,
  });
  appState.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  // WHATSAPP_PAIRING_NUMBER (digits only, with country code) links by
  // code instead of QR: the bot logs an 8-character code, and on the bot
  // number's phone you go to Linked Devices → Link a Device → "Link with
  // phone number instead" and type it. Only used while not yet linked.
  const pairingNumber = (process.env.WHATSAPP_PAIRING_NUMBER ?? "").replace(/\D/g, "");
  let pairingRequested = false;

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && pairingNumber && !authState.creds.registered) {
      if (!pairingRequested) {
        pairingRequested = true;
        sock
          .requestPairingCode(pairingNumber)
          .then((code) => logger.info({ pairingCode: code }, `WhatsApp pairing code for ${pairingNumber}: ${code}`))
          .catch((err) => logger.error({ err }, "Requesting a WhatsApp pairing code failed."));
      }
    } else if (qr) {
      logger.info("Scan this QR code from the bot number's WhatsApp app (Linked Devices):");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
      logger.error({ statusCode }, "WhatsApp connection closed.");

      if (pairingNumber && !authState.creds.registered) {
        // Linking wasn't finished in time. Stop cleanly (exit 0, so systemd
        // doesn't restart-loop and request code after code from WhatsApp).
        logger.error("Phone linking wasn't completed. Restart the service for a fresh pairing code.");
        process.exit(0);
        return;
      }

      if (statusCode !== undefined && FATAL_DISCONNECT_CODES.has(statusCode)) {
        logger.error(
          { statusCode },
          "WhatsApp rejected the stored credentials (logged out / bad session) — retrying can't " +
            "fix this. Delete the auth directory and re-scan the QR code to relink.",
        );
        process.exit(1);
        return;
      }

      if (statusCode === DisconnectReason.connectionReplaced) {
        logger.error(
          "Session taken over by another connection — either a second copy of this bot is " +
            "running against the same auth directory, or WhatsApp Web/a linked device was opened " +
            `on the bot's number. Reclaiming the session in ${RECLAIM_DELAY_SEC}s.`,
        );
        scheduleReconnect(rs, RECLAIM_DELAY_SEC);
        return;
      }

      scheduleReconnect(rs);
    } else if (connection === "open") {
      reconnectAttempt = 0;
      logger.info("WhatsApp connection open.");
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    // Logged before any filtering: if the bot looks unresponsive, this
    // says whether messages are arriving at all, and if so which filter
    // below is dropping them. `type` is 'notify' for live messages and
    // 'append' for ones synced after the fact.
    logger.debug(
      {
        type,
        count: messages.length,
        keys: messages.map((m) => ({ remoteJid: m.key.remoteJid, fromMe: m.key.fromMe })),
      },
      "messages.upsert received.",
    );

    // Munch runs on the owner's personal WhatsApp, so it must never act on
    // incoming messages: no DM reports, no commands, no replies. It only
    // posts the scheduled menus and rating polls. Set MUNCH_HANDLE_MESSAGES=on
    // to bring the old report/command handling back on a dedicated number.
    if (process.env.MUNCH_HANDLE_MESSAGES !== "on") return;
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
        void ratingsModule.handlePollVoteUpdate(appState.db, pollUpdate, localNowIso(cfg.timezone));
      }
    }
  });
}

async function dispatchCommand(sock: Sock, state: AppState, incoming: IncomingMessage): Promise<void> {
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
    if (cfg.menusDir) {
      // Validate every scheduled menu up front so a broken file shows up now,
      // not at 07:00 on its go-live day. Jobs pick the live one each time.
      const files = listMenuFiles(cfg.menusDir);
      if (files.length === 0) throw new MenuError(`no menu files in ${cfg.menusDir}.`);
      for (const f of files) loadMenu(f.path);
      menuData = loadMenu(files[0].path);
      logger.info({ menus: files.map((f) => f.startIso) }, "Scheduled menus found.");
    } else {
      menuData = loadMenu(cfg.menuPath);
    }
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

  // Claimed before connecting: two instances sharing one auth directory
  // would kick each other off WhatsApp indefinitely. See src/lock.ts.
  try {
    acquireInstanceLock(cfg.authDir);
  } catch (err) {
    if (err instanceof LockError) {
      logger.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const weekAnchorDate = new Date(cfg.weekAnchorDate + "T00:00:00Z");
  // `sock` is filled in by `connect()` below before this is read anywhere:
  // `connect` assigns it synchronously (no `await` in between) as soon as
  // `makeWASocket` returns, and everything below awaits `connect` first.
  const appState = { config: cfg, db, menu: menuData, weekAnchorDate } as AppState;
  const rs: RunningState = { appState, authDir: cfg.authDir };

  await connect(rs);
  // Registered once, here, at process startup — not inside `connect()` —
  // so a reconnect never re-registers cron jobs on top of the existing
  // ones. See the comment on `connect()`.
  registerJobs(appState);
  startControlServer(appState);
  logger.info("Bot ready.");
}

async function handleIncomingMessage(
  sock: Sock,
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

// Baileys occasionally throws from deep inside its own internals (e.g. a
// message-decryption retry request firing on a socket that just closed),
// well outside the `connection.update` event flow our reconnect logic
// watches. Node's default behaviour for an uncaught exception/rejection is
// to kill the process outright, which is what took the bot down. Rather
// than try to limp along with unknown internal state, log loudly and exit
// so the process supervisor (systemd, Restart=always) brings up a clean
// process — see deploy/menubot.service.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — exiting for the process supervisor to restart.");
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "Unhandled rejection — exiting for the process supervisor to restart.");
  process.exit(1);
});

main().catch((err) => {
  logger.error({ err }, "Fatal error during startup.");
  process.exit(1);
});
