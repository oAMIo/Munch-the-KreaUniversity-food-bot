/**
 * Plato's voice: the intro above each menu post. The only place an LLM is
 * used at runtime.
 *
 * The model never rewrites the menu (SPEC.md §7). It writes a short, lively
 * opener (one or two lines); the caller puts it above the untouched
 * deterministic message (header, every dish, rating line). It is told how
 * students have rated this exact meal before, so it can hype a good one and
 * be honest about a bad one, and it is shown its own recent intros so it
 * doesn't repeat itself. A failed call or an intro that breaks a rule below
 * is retried once; after that a canned line is used, so a post always goes
 * out.
 *
 * Called via the `openai` SDK pointed at DeepSeek's OpenAI-compatible API
 * (there is no dedicated DeepSeek SDK) — see SPEC.md §2 for why.
 */

import OpenAI from "openai";
import type { LLMConfig, MealName } from "./config";
import type { DB } from "./db";
import * as db from "./db";
import { logger } from "./logger";
import { formatWeekday } from "./time";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const INTRO_MAX_CHARS = 280;
const INTRO_MAX_LINES = 2;
const HISTORY_KEY = "plato_recent_intros";
const HISTORY_SIZE = 12;
const ANGLE_HISTORY_KEY = "plato_recent_angles";
const ANGLE_HISTORY_SIZE = 5;

// Words that give away a meal or a time of day. An intro may not use another meal's words.
const MEAL_WORDS: Record<MealName, string[]> = {
  breakfast: ["breakfast", "brekkie", "morning"],
  lunch: ["lunch", "noon", "midday", "afternoon"],
  snack: ["snack", "snacks", "evening", "tea-time", "teatime"],
  dinner: ["dinner", "supper", "tonight", "night", "evening"],
};
const ALWAYS_BANNED = ["brunch", "tiffin"];

// One is picked at random per post so the voice keeps changing.
const ANGLES = [
  "an over-the-top hype man",
  "a deadpan, unimpressed friend",
  "a brutally honest food critic with a soft heart",
  "a dramatic movie-trailer narrator",
  "a mock-profound philosopher (you are Plato, after all)",
  "a gossiping insider sharing a tip",
  "a sports commentator calling the match",
  "an affectionate roast of the mess",
  "a weather forecaster predicting the meal",
  "a tiny one-line story",
  "a cheeky friend who is a little too excited",
  "a tired senior who has seen every menu twice",
];

// Used when DeepSeek is down or keeps breaking the rules. No meal words,
// so any of them fits any meal.
const FALLBACK_INTROS = [
  "Plato here. The mess has spoken, the menu is below, judge for yourselves 👇",
  "Fresh off the mess counter, no filter, no spin 🍽️",
  "Your daily briefing from Plato. Read it and plan accordingly 👀",
  "Here's what's cooking. Plato reports, you decide 😌",
  "Menu just dropped. Plato has opinions but is keeping quiet (for now) 🤐",
];

export interface IntroContext {
  dishes: string[];
  meal: MealName;
  label: string;
  date: Date;
  /** [average, count] of past ratings for this exact slot under the current menu, if any. */
  rating: [number, number] | null;
  scaleMax: number;
  recentIntros: string[];
  /** Angles used in the last few posts, so the style keeps changing. */
  recentAngles: string[];
}

/** null = acceptable, otherwise the reason the intro was rejected. */
export function introProblem(intro: string, meal: MealName, dishes: string[]): string | null {
  if (!intro) return "empty";
  if (intro.split("\n").filter((l) => l.trim()).length > INTRO_MAX_LINES) return "too_many_lines";
  if (intro.length > INTRO_MAX_CHARS) return "too_long";
  if (/\d/.test(intro)) return "digits"; // invented times, dates, ratings
  if (/[•*_~`#]/.test(intro)) return "markup";
  const words = new Set(intro.toLowerCase().match(/[a-z][a-z-]*/g) ?? []);
  const allowed = new Set(MEAL_WORDS[meal]);
  const banned = new Set(ALWAYS_BANNED);
  for (const [m, ws] of Object.entries(MEAL_WORDS)) {
    if (m === meal) continue;
    for (const w of ws) if (!allowed.has(w)) banned.add(w);
  }
  for (const w of words) if (banned.has(w)) return "wrong_meal_word";
  const lower = intro.toLowerCase();
  if (dishes.filter((d) => lower.includes(stripQuantity(d).toLowerCase())).length >= 3) return "lists_dishes";
  return null;
}

/** "Kadai Chicken (4 Pcs)" -> "Kadai Chicken": the model must not repeat numbers. */
function stripQuantity(dish: string): string {
  return dish.replace(/\s*\([^)]*\)\s*/g, " ").trim();
}

function describeRating(rating: [number, number] | null, scaleMax: number): string {
  if (!rating || rating[1] < 3) {
    return "There are no student ratings for this meal yet, so judge the dishes yourself.";
  }
  const share = rating[0] / scaleMax;
  const verdict =
    share >= 0.8
      ? "students LOVE this one, hype it"
      : share >= 0.65
        ? "students like this one"
        : share >= 0.5
          ? "students find this one just okay, be playful about it"
          : "students rate this one badly. Be honest that it's not the best day, with sympathy and humour, " +
            "but still tell them what's on";
  return `Past student ratings for this exact meal: ${verdict}.`;
}

function buildSystemPrompt(persona: string, ctx: IntroContext, angle: string): string {
  const recent = ctx.recentIntros.length
    ? "Your recent intros. Do NOT reuse their openings, jokes, emoji or structure:\n" +
      ctx.recentIntros.map((t) => `- ${t.replace(/\n/g, " / ")}`).join("\n")
    : "";
  return (
    `${persona}\n\n` +
    `You are writing the intro for today's ${ctx.label} post (${formatWeekday(ctx.date)}) in the student WhatsApp group. ` +
    "The full menu is posted right under your intro automatically.\n\n" +
    `Today's angle: ${angle}.\n\n` +
    "Rules:\n" +
    "- One or two short lines, at most 40 words in total.\n" +
    "- React to the actual food: you may call out one or two dishes by name (without quantities). " +
    "Never invent a dish and never list the whole menu.\n" +
    "- Be honest. If the food is good, celebrate it; if it's weak, say so with humour and still send them off to eat.\n" +
    `- Refer only to ${ctx.label}. Never mention another meal or a different time of day.\n` +
    "- No numbers, times, dates, prices or ratings. No formatting symbols (* _ ~ # •). One or two emoji is fine.\n" +
    "- Vary how you open and sign off; don't end every post with 'go eat'.\n" +
    "- Reply with the intro only: no quotes, no preamble.\n" +
    (recent ? `\n${recent}\n` : "")
  );
}

function withTimeout<T>(promise: Promise<T>, seconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`LLM call timed out after ${seconds}s`)), seconds * 1000);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

async function askForIntro(
  llmCfg: LLMConfig,
  apiKey: string,
  ctx: IntroContext,
  angle: string,
): Promise<string | null> {
  const user =
    `Today's ${ctx.label} dishes: ${ctx.dishes.map(stripQuantity).join(", ")}.\n` +
    describeRating(ctx.rating, ctx.scaleMax);
  try {
    const client = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL, maxRetries: 0 });
    const response = await withTimeout(
      client.chat.completions.create({
        model: llmCfg.model,
        max_tokens: Math.min(llmCfg.maxTokens, 150),
        temperature: 1.2,
        messages: [
          { role: "system", content: buildSystemPrompt(llmCfg.persona, ctx, angle) },
          { role: "user", content: user },
        ],
      }),
      llmCfg.timeoutSeconds,
    );
    const raw = response.choices?.[0]?.message?.content ?? "";
    const intro = raw
      .trim()
      .split("\n")
      .map((l) => l.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim())
      .filter(Boolean)
      .join("\n");
    const problem = introProblem(intro, ctx.meal, ctx.dishes);
    if (problem) {
      logger.warn({ problem, intro, angle }, "Plato intro rejected.");
      return null;
    }
    logger.info({ angle }, "Plato intro accepted.");
    return intro;
  } catch (err) {
    logger.error({ err }, "Plato intro call failed.");
    return null;
  }
}

/**
 * Return the post with Plato's intro on top, plus the intro itself (so the
 * caller can remember it), or null when the LLM is switched off.
 * Never throws.
 */
export async function phraseMenuMessage(
  llmCfg: LLMConfig,
  apiKey: string | null,
  baseMessage: string,
  ctx: IntroContext,
): Promise<{ message: string; intro: string; angle: string | null } | null> {
  if (!llmCfg.enabled) return null;

  let intro: string | null = null;
  let chosenAngle: string | null = null;
  if (!apiKey) {
    logger.error("Plato intro skipped: llm.enabled is true but no DeepSeek API key is configured.");
  } else {
    const fresh = ANGLES.filter((a) => !ctx.recentAngles.includes(a));
    const angle = pick(fresh.length ? fresh : ANGLES);
    intro = (await askForIntro(llmCfg, apiKey, ctx, angle)) ?? (await askForIntro(llmCfg, apiKey, ctx, angle));
    if (intro !== null) chosenAngle = angle;
  }
  if (intro === null) {
    const unused = FALLBACK_INTROS.filter((t) => !ctx.recentIntros.includes(t));
    intro = pick(unused.length ? unused : FALLBACK_INTROS);
    logger.warn("Using a canned Plato intro.");
  }
  return { message: `${intro}\n\n${baseMessage}`, intro, angle: chosenAngle };
}

function readList(dbConn: DB, key: string): string[] {
  try {
    const parsed = JSON.parse(db.getState(dbConn, key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function recentIntros(dbConn: DB): string[] {
  return readList(dbConn, HISTORY_KEY);
}

export function recentAngles(dbConn: DB): string[] {
  return readList(dbConn, ANGLE_HISTORY_KEY);
}

/** Remember what Plato just said (and in which style) so the next posts differ. */
export function rememberIntro(dbConn: DB, intro: string, angle: string | null = null): void {
  db.setState(dbConn, HISTORY_KEY, JSON.stringify([...recentIntros(dbConn), intro].slice(-HISTORY_SIZE)));
  if (angle) {
    const angles = [...recentAngles(dbConn), angle].slice(-ANGLE_HISTORY_SIZE);
    db.setState(dbConn, ANGLE_HISTORY_KEY, JSON.stringify(angles));
  }
}
