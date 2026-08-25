"""Loads config.yaml + .env and exposes a single Config object.

Fails fast and loudly on any missing/malformed required value. Nothing in
this module invents defaults for values that are supposed to come from
config.yaml or the environment.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml
from dotenv import load_dotenv

MEAL_NAMES = ("breakfast", "lunch", "snack", "dinner")

# Env vars that must always be present, regardless of llm.enabled.
_REQUIRED_ENV_VARS = (
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_GROUP_CHAT_ID",
    "ADMIN_USER_ID",
)


class ConfigError(RuntimeError):
    """Raised when config.yaml, .env, or the environment is invalid."""


@dataclass(frozen=True)
class MealConfig:
    key: str
    label: str
    post_at: str  # "HH:MM"
    rate_at: str  # "HH:MM"


@dataclass(frozen=True)
class LLMConfig:
    enabled: bool
    model: str
    max_tokens: int
    persona: str


@dataclass(frozen=True)
class RatingsConfig:
    scale_max: int
    show_averages_when_calibrated: bool


@dataclass(frozen=True)
class Config:
    # From .env
    telegram_bot_token: str
    telegram_group_chat_id: int
    admin_user_id: int
    deepseek_api_key: str | None
    db_path: str
    menu_path: str
    config_path: str

    # From config.yaml
    timezone: str
    week_anchor_date: str
    meals: dict[str, MealConfig]
    llm: LLMConfig
    ratings: RatingsConfig


def _require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(
            f"Required environment variable {name!r} is missing or empty. "
            "Copy .env.example to .env and fill it in."
        )
    return value


def _require_int_env(name: str) -> int:
    raw = _require_env(name)
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"Environment variable {name!r} must be an integer, got {raw!r}.") from exc


def _require_key(d: dict, key: str, context: str) -> object:
    if key not in d:
        raise ConfigError(f"config.yaml: missing required key {key!r} in {context}.")
    return d[key]


def _require_str_key(d: dict, key: str, context: str) -> str:
    value = _require_key(d, key, context)
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"config.yaml: {context}.{key} must be a non-empty string, got {value!r}.")
    return value


def _parse_meals(raw: dict, context: str) -> dict[str, MealConfig]:
    meals_raw = _require_key(raw, "meals", context)
    if not isinstance(meals_raw, dict):
        raise ConfigError("config.yaml: 'meals' must be a mapping.")

    missing = [m for m in MEAL_NAMES if m not in meals_raw]
    if missing:
        raise ConfigError(f"config.yaml: 'meals' is missing required key(s): {missing}.")

    meals: dict[str, MealConfig] = {}
    for meal_key in MEAL_NAMES:
        meal_ctx = f"meals.{meal_key}"
        meal_raw = meals_raw[meal_key]
        if not isinstance(meal_raw, dict):
            raise ConfigError(f"config.yaml: {meal_ctx} must be a mapping.")
        label = _require_str_key(meal_raw, "label", meal_ctx)
        post_at = _require_str_key(meal_raw, "post_at", meal_ctx)
        rate_at = _require_str_key(meal_raw, "rate_at", meal_ctx)
        _validate_hhmm(post_at, f"{meal_ctx}.post_at")
        _validate_hhmm(rate_at, f"{meal_ctx}.rate_at")
        meals[meal_key] = MealConfig(key=meal_key, label=label, post_at=post_at, rate_at=rate_at)

    return meals


def _validate_hhmm(value: str, context: str) -> None:
    parts = value.split(":")
    if len(parts) != 2:
        raise ConfigError(f"config.yaml: {context} must be 'HH:MM', got {value!r}.")
    hour_str, minute_str = parts
    if not (hour_str.isdigit() and minute_str.isdigit()):
        raise ConfigError(f"config.yaml: {context} must be 'HH:MM', got {value!r}.")
    hour, minute = int(hour_str), int(minute_str)
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ConfigError(f"config.yaml: {context} must be a valid 24-hour time, got {value!r}.")


def _parse_llm(raw: dict) -> LLMConfig:
    context = "llm"
    llm_raw = _require_key(raw, "llm", "config.yaml")
    if not isinstance(llm_raw, dict):
        raise ConfigError("config.yaml: 'llm' must be a mapping.")

    enabled = _require_key(llm_raw, "enabled", context)
    if not isinstance(enabled, bool):
        raise ConfigError(f"config.yaml: {context}.enabled must be a boolean, got {enabled!r}.")

    model = _require_str_key(llm_raw, "model", context)

    max_tokens = _require_key(llm_raw, "max_tokens", context)
    if not isinstance(max_tokens, int) or isinstance(max_tokens, bool) or max_tokens <= 0:
        raise ConfigError(f"config.yaml: {context}.max_tokens must be a positive integer, got {max_tokens!r}.")

    persona = _require_str_key(llm_raw, "persona", context)

    return LLMConfig(enabled=enabled, model=model, max_tokens=max_tokens, persona=persona)


def _parse_ratings(raw: dict) -> RatingsConfig:
    context = "ratings"
    ratings_raw = _require_key(raw, "ratings", "config.yaml")
    if not isinstance(ratings_raw, dict):
        raise ConfigError("config.yaml: 'ratings' must be a mapping.")

    scale_max = _require_key(ratings_raw, "scale_max", context)
    if not isinstance(scale_max, int) or isinstance(scale_max, bool) or scale_max <= 0:
        raise ConfigError(f"config.yaml: {context}.scale_max must be a positive integer, got {scale_max!r}.")

    show_averages = _require_key(ratings_raw, "show_averages_when_calibrated", context)
    if not isinstance(show_averages, bool):
        raise ConfigError(
            f"config.yaml: {context}.show_averages_when_calibrated must be a boolean, got {show_averages!r}."
        )

    return RatingsConfig(scale_max=scale_max, show_averages_when_calibrated=show_averages)


def load_config(env_path: str | Path = ".env") -> Config:
    """Load .env and config.yaml, validate everything, return a Config.

    Raises ConfigError on any missing or malformed value.
    """
    load_dotenv(dotenv_path=env_path, override=False)

    for name in _REQUIRED_ENV_VARS:
        _require_env(name)

    telegram_bot_token = _require_env("TELEGRAM_BOT_TOKEN")
    telegram_group_chat_id = _require_int_env("TELEGRAM_GROUP_CHAT_ID")
    admin_user_id = _require_int_env("ADMIN_USER_ID")
    deepseek_api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip() or None
    db_path = os.environ.get("DB_PATH", "menubot.db")
    menu_path = os.environ.get("MENU_PATH", "menu.yaml")
    config_path = os.environ.get("CONFIG_PATH", "config.yaml")

    config_file = Path(config_path)
    if not config_file.is_file():
        raise ConfigError(f"config.yaml not found at {config_file!s}.")

    with config_file.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    if not isinstance(raw, dict):
        raise ConfigError("config.yaml: top level must be a mapping.")

    timezone = _require_str_key(raw, "timezone", "config.yaml")
    week_anchor_date = _require_str_key(raw, "week_anchor_date", "config.yaml")
    meals = _parse_meals(raw, "config.yaml")
    llm = _parse_llm(raw)
    ratings = _parse_ratings(raw)

    if llm.enabled and not deepseek_api_key:
        raise ConfigError(
            "config.yaml: llm.enabled is true but DEEPSEEK_API_KEY is missing/empty in the environment."
        )

    return Config(
        telegram_bot_token=telegram_bot_token,
        telegram_group_chat_id=telegram_group_chat_id,
        admin_user_id=admin_user_id,
        deepseek_api_key=deepseek_api_key,
        db_path=db_path,
        menu_path=menu_path,
        config_path=config_path,
        timezone=timezone,
        week_anchor_date=week_anchor_date,
        meals=meals,
        llm=llm,
        ratings=ratings,
    )
