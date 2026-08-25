"""The scheduled job functions (menu post, rating prompt) + job registration."""

from __future__ import annotations

import datetime
import html
import logging
from zoneinfo import ZoneInfo

from telegram.ext import Application, ContextTypes

import db
import llm as llm_module
import menu as menu_module
import ratings as ratings_module

logger = logging.getLogger(__name__)


def build_menu_message(
    label: str,
    date: datetime.date,
    dishes: list[str],
    average: tuple[float, int] | None = None,
) -> str:
    """Deterministic base menu message (SPEC.md §6).

    `average`, if given as (avg, count), is appended only once calibrated
    (SPEC.md §5.7/§5.8) — until then menu posts carry no rating info.
    """
    header = f"\U0001F37D️ {html.escape(label)} — {date.strftime('%A')}, {date.strftime('%d %b')}"
    lines = "\n".join(f"• {html.escape(dish)}" for dish in dishes)
    message = f"{header}\n\n{lines}"
    if average is not None:
        avg, count = average
        message += f"\n\n★ {avg}/5 from {count} ratings"
    return message


async def post_menu_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    """Post today's menu for one meal, if there is one and it isn't already posted."""
    meal = context.job.data["meal"]
    try:
        cfg = context.application.bot_data["config"]
        conn = context.application.bot_data["db"]
        menu_data = context.application.bot_data["menu"]
        week_anchor_date = context.application.bot_data["week_anchor_date"]

        today = datetime.datetime.now(tz=ZoneInfo(cfg.timezone)).date()
        today_iso = today.isoformat()

        dishes = menu_module.get_menu(menu_data, today, week_anchor_date, meal)
        if not dishes:
            logger.info("No menu for %s on %s; skipping post.", meal, today_iso)
            return

        if db.has_posted_menu(conn, meal, today_iso):
            logger.info("Menu for %s on %s already posted; skipping duplicate fire.", meal, today_iso)
            return

        average = None
        if ratings_module.is_calibrated(conn):
            week_type = menu_module.resolve_week_type(today, week_anchor_date)
            day = menu_module.DAYS[today.weekday()]
            average = ratings_module.slot_average(conn, week_type, day, meal)

        meal_cfg = cfg.meals[meal]
        message = build_menu_message(meal_cfg.label, today, dishes, average)

        if cfg.llm.enabled:
            phrased = await llm_module.phrase_menu_message(cfg.llm, cfg.deepseek_api_key, message, dishes)
            if phrased is not None:
                # Re-escape: the phrased text is untrusted-ish LLM output and
                # must still be safe under Telegram's HTML parse mode.
                message = html.escape(phrased)

        await context.bot.send_message(
            chat_id=cfg.telegram_group_chat_id,
            text=message,
            parse_mode="HTML",
        )
        db.mark_posted_menu(conn, meal, today_iso)
        logger.info("Posted %s menu for %s.", meal, today_iso)
    except Exception:
        logger.exception("post_menu_job failed for meal=%s", meal)


async def rating_prompt_job(context: ContextTypes.DEFAULT_TYPE) -> None:
    """Post a rating prompt with an inline 1..scale_max keyboard for one meal."""
    meal = context.job.data["meal"]
    try:
        cfg = context.application.bot_data["config"]
        menu_data = context.application.bot_data["menu"]
        week_anchor_date = context.application.bot_data["week_anchor_date"]

        today = datetime.datetime.now(tz=ZoneInfo(cfg.timezone)).date()
        today_iso = today.isoformat()
        week_type = menu_module.resolve_week_type(today, week_anchor_date)
        day = menu_module.DAYS[today.weekday()]

        dishes = menu_module.get_menu(menu_data, today, week_anchor_date, meal)
        if not dishes:
            logger.info("No menu for %s on %s; skipping rating prompt.", meal, today_iso)
            return

        meal_cfg = cfg.meals[meal]
        message = ratings_module.build_rating_prompt_message(meal_cfg.label)
        keyboard = ratings_module.build_rating_keyboard(
            today_iso, week_type, day, meal, cfg.ratings.scale_max
        )

        await context.bot.send_message(
            chat_id=cfg.telegram_group_chat_id,
            text=message,
            reply_markup=keyboard,
        )
        logger.info("Posted %s rating prompt for %s.", meal, today_iso)
    except Exception:
        logger.exception("rating_prompt_job failed for meal=%s", meal)


def register_jobs(application: Application) -> None:
    """Register the daily menu-post and rating-prompt jobs for each of the four meals."""
    cfg = application.bot_data["config"]
    tz = ZoneInfo(cfg.timezone)

    for meal_key, meal_cfg in cfg.meals.items():
        post_hour, post_minute = (int(part) for part in meal_cfg.post_at.split(":"))
        post_time = datetime.time(hour=post_hour, minute=post_minute, tzinfo=tz)
        application.job_queue.run_daily(
            post_menu_job,
            time=post_time,
            data={"meal": meal_key},
            name=f"post_menu_{meal_key}",
        )
        logger.info("Registered menu-post job for %s at %s (%s).", meal_key, meal_cfg.post_at, cfg.timezone)

        rate_hour, rate_minute = (int(part) for part in meal_cfg.rate_at.split(":"))
        rate_time = datetime.time(hour=rate_hour, minute=rate_minute, tzinfo=tz)
        application.job_queue.run_daily(
            rating_prompt_job,
            time=rate_time,
            data={"meal": meal_key},
            name=f"rate_prompt_{meal_key}",
        )
        logger.info("Registered rating-prompt job for %s at %s (%s).", meal_key, meal_cfg.rate_at, cfg.timezone)
