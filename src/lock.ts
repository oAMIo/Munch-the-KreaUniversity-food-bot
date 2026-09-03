/**
 * Single-instance lock, guarding the WhatsApp auth session.
 *
 * WhatsApp permits exactly one live connection per linked device. If two
 * processes share one auth directory, each connect forcibly kicks the
 * other off (`stream:error conflict type="replaced"`, status 440) and the
 * two fight indefinitely — the bot appears to randomly drop offline. The
 * usual way to get there is running `npm run dev` while the systemd
 * service is already running the same session.
 *
 * So: whoever holds the lock owns the session, and a second process
 * refuses to start with an explanation instead of silently knocking the
 * live bot off WhatsApp.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

export class LockError extends Error {}

const LOCK_FILENAME = ".instance.lock";

interface LockContents {
  pid: number;
  startedAt: string;
}

/**
 * Is `pid` a live process that looks like this bot?
 *
 * `kill(pid, 0)` alone would be fooled by PID reuse — a recycled PID
 * belonging to some unrelated process would keep us locked out forever.
 * On Linux we can confirm via /proc what the process actually is; where
 * that isn't readable we fall back to liveness alone.
 */
function isBotProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, doesn't kill
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM: alive, just owned by another user — still a live process.
  }

  const cmdlinePath = `/proc/${pid}/cmdline`;
  if (!existsSync(cmdlinePath)) return true;
  try {
    const cmdline = readFileSync(cmdlinePath, "utf8");
    return cmdline.includes("bot.js") || cmdline.includes("bot.ts");
  } catch {
    return true;
  }
}

/**
 * Claims the session for this process, or throws LockError if another
 * live instance already holds it. Releases automatically on exit.
 */
export function acquireInstanceLock(authDir: string): void {
  const lockPath = join(authDir, LOCK_FILENAME);

  if (existsSync(lockPath)) {
    let holder: LockContents | null = null;
    try {
      holder = JSON.parse(readFileSync(lockPath, "utf8")) as LockContents;
    } catch {
      holder = null; // unreadable/corrupt lock — treat as stale
    }

    if (holder !== null && isBotProcessAlive(holder.pid)) {
      throw new LockError(
        `Another instance of the bot (pid ${holder.pid}, started ${holder.startedAt}) is already ` +
          `using the WhatsApp session in ${authDir}.\n` +
          "WhatsApp allows only one connection per linked device, so starting a second instance " +
          "would kick the running one off WhatsApp and the two would fight over the session.\n" +
          "If that is the systemd service, stop it first (`sudo systemctl stop menubot`) before " +
          "running a dev instance, and start it again afterwards.",
      );
    }
  }

  const contents: LockContents = { pid: process.pid, startedAt: new Date().toISOString() };
  writeFileSync(lockPath, JSON.stringify(contents), "utf8");

  const release = (): void => {
    try {
      // Only drop the lock if it is still ours — never clear a lock a
      // successor process has since taken over.
      const current = JSON.parse(readFileSync(lockPath, "utf8")) as LockContents;
      if (current.pid === process.pid) unlinkSync(lockPath);
    } catch {
      // Already gone, or unreadable: nothing useful to do while exiting.
    }
  };

  process.on("exit", release);
  // Signals don't run 'exit' handlers on their own; exit explicitly so the
  // lock is cleaned up when systemd stops us or the terminal is Ctrl-C'd.
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
}
