/**
 * Loads config.yaml + .env and exposes a single Config object.
 *
 * Fails fast and loudly on any missing/malformed required value. Nothing in
 * this module invents defaults for values that are supposed to come from
 * config.yaml or the environment. Direct port of the old config.py.
 */

import { existsSync, readFileSync } from "fs";
import * as yaml from "js-yaml";
import * as dotenv from "dotenv";

export const MEAL_NAMES = ["breakfast", "lunch", "snack", "dinner"] as const;
export type MealName = (typeof MEAL_NAMES)[number];

// Env vars that must always be present, regardless of llm.enabled.
const REQUIRED_ENV_VARS = ["WHATSAPP_GROUP_JID", "WHATSAPP_ADMIN_JID"] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface MealConfig {
  key: MealName;
  label: string;
  postAt: string; // "HH:MM"
  rateAt: string; // "HH:MM"
}

export interface LLMConfig {
  enabled: boolean;
  model: string;
  maxTokens: number;
  timeoutSeconds: number;
  persona: string;
}

export interface RatingsConfig {
  scaleMax: number;
  showAveragesWhenCalibrated: boolean;
}

export interface Config {
  // From .env
  whatsappGroupJid: string;
  whatsappAdminJid: string;
  deepseekApiKey: string | null;
  dbPath: string;
  menuPath: string;
  configPath: string;
  authDir: string;

  // From config.yaml
  timezone: string;
  weekAnchorDate: string;
  meals: Record<MealName, MealConfig>;
  llm: LLMConfig;
  ratings: RatingsConfig;
}

function requireEnv(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new ConfigError(
      `Required environment variable '${name}' is missing or empty. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function requireKey(d: Record<string, unknown>, key: string, context: string): unknown {
  if (!(key in d)) {
    throw new ConfigError(`config.yaml: missing required key '${key}' in ${context}.`);
  }
  return d[key];
}

function requireStrKey(d: Record<string, unknown>, key: string, context: string): string {
  const value = requireKey(d, key, context);
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigError(`config.yaml: ${context}.${key} must be a non-empty string, got ${JSON.stringify(value)}.`);
  }
  return value;
}

function validateHHMM(value: string, context: string): void {
  const parts = value.split(":");
  if (parts.length !== 2) {
    throw new ConfigError(`config.yaml: ${context} must be 'HH:MM', got ${JSON.stringify(value)}.`);
  }
  const [hourStr, minuteStr] = parts;
  if (!/^\d+$/.test(hourStr) || !/^\d+$/.test(minuteStr)) {
    throw new ConfigError(`config.yaml: ${context} must be 'HH:MM', got ${JSON.stringify(value)}.`);
  }
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
    throw new ConfigError(`config.yaml: ${context} must be a valid 24-hour time, got ${JSON.stringify(value)}.`);
  }
}

function parseMeals(raw: Record<string, unknown>, context: string): Record<MealName, MealConfig> {
  const mealsRaw = requireKey(raw, "meals", context);
  if (typeof mealsRaw !== "object" || mealsRaw === null || Array.isArray(mealsRaw)) {
    throw new ConfigError("config.yaml: 'meals' must be a mapping.");
  }
  const mealsRawObj = mealsRaw as Record<string, unknown>;

  const missing = MEAL_NAMES.filter((m) => !(m in mealsRawObj));
  if (missing.length > 0) {
    throw new ConfigError(`config.yaml: 'meals' is missing required key(s): ${JSON.stringify(missing)}.`);
  }

  const meals = {} as Record<MealName, MealConfig>;
  for (const mealKey of MEAL_NAMES) {
    const mealCtx = `meals.${mealKey}`;
    const mealRaw = mealsRawObj[mealKey];
    if (typeof mealRaw !== "object" || mealRaw === null || Array.isArray(mealRaw)) {
      throw new ConfigError(`config.yaml: ${mealCtx} must be a mapping.`);
    }
    const mealRawObj = mealRaw as Record<string, unknown>;
    const label = requireStrKey(mealRawObj, "label", mealCtx);
    const postAt = requireStrKey(mealRawObj, "post_at", mealCtx);
    const rateAt = requireStrKey(mealRawObj, "rate_at", mealCtx);
    validateHHMM(postAt, `${mealCtx}.post_at`);
    validateHHMM(rateAt, `${mealCtx}.rate_at`);
    meals[mealKey] = { key: mealKey, label, postAt, rateAt };
  }

  return meals;
}

function parseLLM(raw: Record<string, unknown>): LLMConfig {
  const context = "llm";
  const llmRaw = requireKey(raw, "llm", "config.yaml");
  if (typeof llmRaw !== "object" || llmRaw === null || Array.isArray(llmRaw)) {
    throw new ConfigError("config.yaml: 'llm' must be a mapping.");
  }
  const llmRawObj = llmRaw as Record<string, unknown>;

  const enabled = requireKey(llmRawObj, "enabled", context);
  if (typeof enabled !== "boolean") {
    throw new ConfigError(`config.yaml: ${context}.enabled must be a boolean, got ${JSON.stringify(enabled)}.`);
  }

  const model = requireStrKey(llmRawObj, "model", context);

  const maxTokens = requireKey(llmRawObj, "max_tokens", context);
  if (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new ConfigError(
      `config.yaml: ${context}.max_tokens must be a positive integer, got ${JSON.stringify(maxTokens)}.`,
    );
  }

  const timeoutSeconds = requireKey(llmRawObj, "timeout_seconds", context);
  if (typeof timeoutSeconds !== "number" || !Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new ConfigError(
      `config.yaml: ${context}.timeout_seconds must be a positive integer, got ${JSON.stringify(timeoutSeconds)}.`,
    );
  }

  const persona = requireStrKey(llmRawObj, "persona", context);

  return { enabled, model, maxTokens, timeoutSeconds, persona };
}

function parseRatings(raw: Record<string, unknown>): RatingsConfig {
  const context = "ratings";
  const ratingsRaw = requireKey(raw, "ratings", "config.yaml");
  if (typeof ratingsRaw !== "object" || ratingsRaw === null || Array.isArray(ratingsRaw)) {
    throw new ConfigError("config.yaml: 'ratings' must be a mapping.");
  }
  const ratingsRawObj = ratingsRaw as Record<string, unknown>;

  const scaleMax = requireKey(ratingsRawObj, "scale_max", context);
  if (typeof scaleMax !== "number" || !Number.isInteger(scaleMax) || scaleMax <= 0) {
    throw new ConfigError(
      `config.yaml: ${context}.scale_max must be a positive integer, got ${JSON.stringify(scaleMax)}.`,
    );
  }

  const showAverages = requireKey(ratingsRawObj, "show_averages_when_calibrated", context);
  if (typeof showAverages !== "boolean") {
    throw new ConfigError(
      `config.yaml: ${context}.show_averages_when_calibrated must be a boolean, got ${JSON.stringify(showAverages)}.`,
    );
  }

  return { scaleMax, showAveragesWhenCalibrated: showAverages };
}

export function loadConfig(envPath = ".env"): Config {
  dotenv.config({ path: envPath, override: false });

  for (const name of REQUIRED_ENV_VARS) {
    requireEnv(name);
  }

  const whatsappGroupJid = requireEnv("WHATSAPP_GROUP_JID");
  const whatsappAdminJid = requireEnv("WHATSAPP_ADMIN_JID");
  const deepseekApiKey = (process.env.DEEPSEEK_API_KEY ?? "").trim() || null;
  const dbPath = process.env.DB_PATH ?? "menubot.db";
  const menuPath = process.env.MENU_PATH ?? "menu.yaml";
  const configPath = process.env.CONFIG_PATH ?? "config.yaml";
  const authDir = process.env.AUTH_DIR ?? "auth";

  if (!existsSync(configPath)) {
    throw new ConfigError(`config.yaml not found at ${configPath}.`);
  }

  const raw = yaml.load(readFileSync(configPath, "utf-8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("config.yaml: top level must be a mapping.");
  }
  const rawObj = raw as Record<string, unknown>;

  const timezone = requireStrKey(rawObj, "timezone", "config.yaml");
  const weekAnchorDate = requireStrKey(rawObj, "week_anchor_date", "config.yaml");
  const meals = parseMeals(rawObj, "config.yaml");
  const llm = parseLLM(rawObj);
  const ratings = parseRatings(rawObj);

  if (llm.enabled && !deepseekApiKey) {
    throw new ConfigError("config.yaml: llm.enabled is true but DEEPSEEK_API_KEY is missing/empty in the environment.");
  }

  return {
    whatsappGroupJid,
    whatsappAdminJid,
    deepseekApiKey,
    dbPath,
    menuPath,
    configPath,
    authDir,
    timezone,
    weekAnchorDate,
    meals,
    llm,
    ratings,
  };
}
