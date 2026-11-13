/**
 * Stdlib-`logging`-equivalent: structured logging to stdout at INFO,
 * captured by systemd's journal. Never log secrets (bot session, API key).
 */

import pino from "pino";

// LOG_LEVEL raises/lowers verbosity without a code change ('debug' is
// useful when diagnosing which messages the bot is receiving and why it
// is or isn't acting on them).
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
});
