"""The scheduled job functions (menu post, rating prompt) + job registration.

Phase 2 implements the menu-post job only. The rating-prompt job is added
in phase 4.
"""

from __future__ import annotations

import datetime
import html
import logging
from zoneinfo import ZoneInfo

from telegram.ext import Application, ContextTypes

import db
import menu as menu_module

logger = logging.getLogger(__name__)


def build_menu_message(label: str, date: datetime.date, dishes: list[str]) -> str:
    """Deterministic base menu message (SPEC.md §6). No averages yet (phase 5)."""
    header = f"\U0001F37D️ {html.escape(label)} — {date.strftime('%A')}, {date.strftime('%d %b')}"
    lines = "\n".join(f"• {html.escape(dish)}" for dish in dishes)
    return f"{header}\n\n{lines}"


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

        meal_cfg = cfg.meals[meal]
        message = build_menu_message(meal_cfg.label, today, dishes)

        await context.bot.send_message(
            chat_id=cfg.telegram_group_chat_id,
            text=message,
            parse_mode="HTML",
        )
        db.mark_posted_menu(conn, meal, today_iso)
        logger.info("Posted %s menu for %s.", meal, today_iso)
    except Exception:
        logger.exception("post_menu_job failed for meal=%s", meal)


def register_jobs(application: Application) -> None:
    """Register the daily menu-post job for each of the four meals."""
    cfg = application.bot_data["config"]
    tz = ZoneInfo(cfg.timezone)

    for meal_key, meal_cfg in cfg.meals.items():
        hour, minute = (int(part) for part in meal_cfg.post_at.split(":"))
        post_time = datetime.time(hour=hour, minute=minute, tzinfo=tz)
        application.job_queue.run_daily(
            post_menu_job,
            time=post_time,
            data={"meal": meal_key},
            name=f"post_menu_{meal_key}",
        )
        logger.info("Registered menu-post job for %s at %s (%s).", meal_key, meal_cfg.post_at, cfg.timezone)
