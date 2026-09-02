/**
 * Stdlib-`logging`-equivalent: structured logging to stdout at INFO,
 * captured by systemd's journal. Never log secrets (bot session, API key).
 */

import pino from "pino";

export const logger = pino({
  level: "info",
  timestamp: pino.stdTimeFunctions.isoTime,
});
