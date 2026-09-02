/**
 * The DeepSeek phrasing pass. The only place an LLM is used at runtime.
 *
 * Its job is presentation, nothing else (SPEC.md §7): it takes an already-
 * complete deterministic menu message and restyles it in the configured
 * persona. It is never given the database, never asked what the menu is,
 * and never used for ratings or reports.
 *
 * Called via the `openai` SDK pointed at DeepSeek's OpenAI-compatible API
 * (there is no dedicated DeepSeek SDK) — see SPEC.md §2 for why.
 */

import OpenAI from "openai";
import type { LLMConfig } from "./config";
import { logger } from "./logger";

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

function buildSystemPrompt(persona: string): string {
  return (
    "You rewrite a mess-menu announcement for a university WhatsApp group chat, in this persona: " +
    `${persona}\n\n` +
    "Rules:\n" +
    "- Keep every dish as its own separate bullet point. Never merge, combine, or abbreviate " +
    "two dishes into one line.\n" +
    "- Reproduce every dish name exactly as given — same spelling, same capitalisation. " +
    "Never add, remove, rename, translate, or invent a dish.\n" +
    "- Keep the rewritten intro under about 40 words; the dish list follows unchanged.\n" +
    "- Return only the message text. No preamble, no markdown fences, no explanations."
  );
}

function allDishesPresent(text: string, dishes: string[]): boolean {
  const textLower = text.toLowerCase();
  return dishes.every((dish) => textLower.includes(dish.toLowerCase()));
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

/**
 * Return a persona-phrased version of `baseMessage`, or null on any failure.
 *
 * null means "use the deterministic baseMessage instead" — the caller
 * (jobs.postMenuJob) owns that fallback, per SPEC.md §5.4 step 4. This
 * function never throws; every failure path is caught and logged here.
 */
export async function phraseMenuMessage(
  llmCfg: LLMConfig,
  apiKey: string | null,
  baseMessage: string,
  dishes: string[],
): Promise<string | null> {
  if (!llmCfg.enabled) return null;

  if (!apiKey) {
    logger.error("LLM phrasing pass skipped: llm.enabled is true but no DeepSeek API key is configured.");
    return null;
  }

  let phrased: string | null | undefined;
  try {
    const client = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL });
    const response = await withTimeout(
      client.chat.completions.create({
        model: llmCfg.model,
        max_tokens: llmCfg.maxTokens,
        messages: [
          { role: "system", content: buildSystemPrompt(llmCfg.persona) },
          { role: "user", content: baseMessage },
        ],
      }),
      llmCfg.timeoutSeconds,
    );
    phrased = response.choices?.[0]?.message?.content;
  } catch (err) {
    logger.error({ err }, "LLM phrasing pass call failed; falling back to deterministic message.");
    return null;
  }

  if (!phrased || !phrased.trim()) {
    logger.warn("LLM phrasing pass returned empty content; falling back to deterministic message.");
    return null;
  }

  phrased = phrased.trim();

  if (!allDishesPresent(phrased, dishes)) {
    const missing = dishes.filter((dish) => !phrased!.toLowerCase().includes(dish.toLowerCase()));
    logger.warn(
      { missing },
      "LLM phrasing pass dropped dish name(s); discarding output, falling back to deterministic message.",
    );
    return null;
  }

  return phrased;
}
