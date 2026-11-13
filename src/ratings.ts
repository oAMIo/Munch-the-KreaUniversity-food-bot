/**
 * Rating prompt construction, poll-vote handling, coverage/calibration, averages.
 *
 * WhatsApp has no inline-keyboard equivalent, so the rating prompt is a
 * native WhatsApp poll (question + options "1".."scaleMax", single-select)
 * instead of Telegram's inline keyboard + callback_data. The poll message's
 * own id (kept in the `poll_votes` table, see db.ts) is what
 * `rate|{date}|{week_type}|{day}|{meal}|{score}` callback_data used to
 * carry — see SPEC.md §5.5/§5.6 for the WhatsApp-adapted flow.
 */

import type { AnyMessageContent, WAMessage, WASocket } from "@whiskeysockets/baileys";
import { getAggregateVotesInPollMessage, updateMessageWithPollUpdate, proto } from "@whiskeysockets/baileys";
import type { DB } from "./db";
import * as db from "./db";
import * as menuModule from "./menu";
import type { Day, WeekType } from "./menu";
import type { MealName } from "./config";
import { logger } from "./logger";

const CALIBRATED_STATE_KEY = "calibrated";

// In-memory cache of open poll creation messages, keyed by message id.
// Needed to decrypt subsequent vote updates (getAggregateVotesInPollMessage
// requires the original poll message, not just its id) — Baileys does not
// persist this for you. Lost on restart: a poll posted before a restart
// will stop registering new votes after the process comes back up. This is
// the one piece of state SPEC.md's Telegram design didn't need to worry
// about, since Telegram callback_data was self-contained.
const openPolls = new Map<string, WAMessage>();

export function isCalibrated(dbConn: DB, since = "0000-00-00"): boolean {
  // Calibration is per menu: a new menu starts uncalibrated.
  const key = since === "0000-00-00" ? CALIBRATED_STATE_KEY : `${CALIBRATED_STATE_KEY}:${since}`;
  if (db.getState(dbConn, key) === "true") {
    return true;
  }
  if (db.distinctRatedSlotCount(dbConn, since) >= menuModule.TOTAL_SLOTS) {
    db.setState(dbConn, key, "true");
    logger.info(`Calibration reached: all ${menuModule.TOTAL_SLOTS} slots have been rated at least once.`);
    return true;
  }
  return false;
}

export function slotAverage(
  dbConn: DB,
  weekType: WeekType,
  day: Day,
  meal: MealName,
  since = "0000-00-00",
): [number, number] | null {
  return db.slotAverage(dbConn, weekType, day, meal, since);
}

// Plato's rating questions; one is picked at random so the poll doesn't
// read the same every day. `{meal}` becomes the meal label.
const RATING_QUESTIONS = [
  "How was {meal} today? Tap to rate.",
  "Verdict time: rate today's {meal} 👇",
  "Be honest, Plato can take it. How was {meal}?",
  "{meal} report card, you're the examiner ✍️",
  "Did {meal} slap or was it a crime? Rate it 👇",
  "Plato wants to know: how was {meal} today?",
  "Rate {meal}. Your vote shapes what Plato says next time 👀",
  "Quick one: how was {meal}? Tap a number.",
];

/** Rating-prompt poll question (SPEC.md §6), varied by Plato. */
export function buildRatingPromptMessage(label: string): string {
  return RATING_QUESTIONS[Math.floor(Math.random() * RATING_QUESTIONS.length)].replace("{meal}", label);
}

export function buildRatingPollContent(label: string, scaleMax: number): AnyMessageContent {
  return {
    poll: {
      name: buildRatingPromptMessage(label),
      values: Array.from({ length: scaleMax }, (_, i) => String(i + 1)),
      selectableCount: 1,
    },
  };
}

/** Register a just-sent rating poll so incoming votes can be resolved back to its slot. */
export function registerRatingPoll(
  dbConn: DB,
  args: {
    pollMessage: WAMessage;
    dateIso: string;
    weekType: WeekType;
    day: Day;
    meal: MealName;
    scaleMax: number;
    createdAtIso: string;
  },
): void {
  const pollMessageId = args.pollMessage.key.id;
  if (!pollMessageId) {
    logger.error("Sent rating poll has no message id; cannot register it for vote tracking.");
    return;
  }
  openPolls.set(pollMessageId, args.pollMessage);
  db.insertPollVoteMapping(dbConn, {
    pollMessageId,
    dateIso: args.dateIso,
    weekType: args.weekType,
    day: args.day,
    meal: args.meal,
    scaleMax: args.scaleMax,
    createdAtIso: args.createdAtIso,
  });
}

/**
 * Handle an incoming poll-vote update from Baileys' `messages.update` event
 * (one `proto.IPollUpdate` per vote). Resolves the vote to its slot,
 * decodes the chosen score, and upserts it. Mirrors Telegram's
 * handle_rating_callback (SPEC.md §5.6): a voter's score is upserted
 * (INSERT ... ON CONFLICT ... DO UPDATE) so changing a vote updates rather
 * than duplicates their rating, and no group message is posted per vote —
 * WhatsApp polls already keep votes silent by design.
 */
export async function handlePollVoteUpdate(
  dbConn: DB,
  pollUpdate: proto.IPollUpdate,
  createdAtIso: string,
): Promise<void> {
  const pollMessageId = pollUpdate.pollUpdateMessageKey?.id;
  if (!pollMessageId) return;

  const mapping = db.getPollVoteMapping(dbConn, pollMessageId);
  if (mapping === null) {
    // Not one of our rating polls (or predates this process' knowledge of it).
    return;
  }

  const pollCreationMessage = openPolls.get(pollMessageId);
  if (!pollCreationMessage) {
    logger.warn(
      { pollMessageId },
      "Vote received for a rating poll not held in memory (likely posted before a restart); cannot decode.",
    );
    return;
  }

  // Baileys decrypts votes incrementally: accumulate this update into the
  // stored poll message's `pollUpdates`, then re-aggregate the full tally.
  updateMessageWithPollUpdate(pollCreationMessage, pollUpdate);
  const aggregate = getAggregateVotesInPollMessage({
    message: pollCreationMessage.message,
    pollUpdates: pollCreationMessage.pollUpdates,
  });

  for (const option of aggregate) {
    const score = Number(option.name);
    if (!Number.isInteger(score) || score < 1 || score > mapping.scale_max) continue;

    for (const voterJid of option.voters) {
      db.upsertRating(dbConn, {
        dateIso: mapping.date,
        weekType: mapping.week_type,
        day: mapping.day,
        meal: mapping.meal,
        userId: voterJid,
        score,
        createdAtIso,
      });
      logger.info(
        `Rating upserted: user=${voterJid} slot=${mapping.week_type}/${mapping.day}/${mapping.meal} score=${score}`,
      );
    }
  }
}

export async function sendRatingPoll(
  sock: WASocket,
  groupJid: string,
  dbConn: DB,
  args: { label: string; scaleMax: number; dateIso: string; weekType: WeekType; day: Day; meal: MealName; createdAtIso: string },
): Promise<void> {
  const sent = await sock.sendMessage(groupJid, buildRatingPollContent(args.label, args.scaleMax));
  if (!sent) {
    logger.error(`Failed to send rating poll for ${args.meal} on ${args.dateIso}.`);
    return;
  }
  registerRatingPoll(dbConn, {
    pollMessage: sent,
    dateIso: args.dateIso,
    weekType: args.weekType,
    day: args.day,
    meal: args.meal,
    scaleMax: args.scaleMax,
    createdAtIso: args.createdAtIso,
  });
}
