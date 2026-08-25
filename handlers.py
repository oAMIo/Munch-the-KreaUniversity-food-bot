"""Telegram command handlers (/start, /menu, /reloadmenu, /reports, /stats, /resolve).

Phases 1-3 implement /start, /menu, /reloadmenu, /reports, /resolve.
/stats is added in phase 4, per SPEC.md §3/§9.
"""

from __future__ import annotations

import datetime
import logging
from zoneinfo import ZoneInfo

from telegram import Update
from telegram.ext import ContextTypes

import db
import jobs as jobs_module
import menu as menu_module

logger = logging.getLogger(__name__)

START_MESSAGE = (
    "Hi! I post the mess menu before each meal and collect ratings afterwards. "
    "If a posted menu was wrong, just send me a message here (DM) describing "
    "the mistake and I'll pass it on."
)

NO_MEALS_LEFT_MESSAGE = "That's everything for today — see you tomorrow!"


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_message is None:
        return
    await update.effective_message.reply_text(START_MESSAGE)


def _remaining_meals(cfg, now_hhmm: str) -> list[str]:
    """Meal keys, in order, whose post_at is still ahead of `now_hhmm`."""
    return [meal_key for meal_key, meal_cfg in cfg.meals.items() if meal_cfg.post_at > now_hhmm]


async def menu_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_message is None:
        return

    cfg = context.application.bot_data["config"]
    menu_data = context.application.bot_data["menu"]
    week_anchor_date = context.application.bot_data["week_anchor_date"]

    now = datetime.datetime.now(tz=ZoneInfo(cfg.timezone))
    today = now.date()
    remaining = _remaining_meals(cfg, now.strftime("%H:%M"))

    sent_any = False
    for meal_key in remaining:
        dishes = menu_module.get_menu(menu_data, today, week_anchor_date, meal_key)
        if not dishes:
            continue
        message = jobs_module.build_menu_message(cfg.meals[meal_key].label, today, dishes)
        await update.effective_message.reply_text(message, parse_mode="HTML")
        sent_any = True

    if not sent_any:
        await update.effective_message.reply_text(NO_MEALS_LEFT_MESSAGE)


def _is_admin(update: Update, cfg) -> bool:
    return update.effective_user is not None and update.effective_user.id == cfg.admin_user_id


def _is_dm(update: Update) -> bool:
    return update.effective_chat is not None and update.effective_chat.type == "private"


async def reloadmenu_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_message is None:
        return

    cfg = context.application.bot_data["config"]

    if not _is_dm(update) or not _is_admin(update, cfg):
        return

    try:
        new_menu = menu_module.load_menu(cfg.menu_path)
    except menu_module.MenuError as exc:
        logger.error("/reloadmenu failed validation: %s", exc)
        await update.effective_message.reply_text(f"Reload failed, previous menu stays active:\n{exc}")
        return

    context.application.bot_data["menu"] = new_menu
    logger.info("Menu reloaded from %s via /reloadmenu.", cfg.menu_path)
    await update.effective_message.reply_text("Menu reloaded successfully.")


NO_REPORTS_MESSAGE = "No unresolved reports right now."


def _format_report_line(row: tuple[int, int, str | None, str, str]) -> str:
    report_id, user_id, username, message, created_at = row
    who = f"@{username}" if username else f"user {user_id}"
    return f"#{report_id} — {who} — {created_at}\n{message}"


async def reports_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_message is None:
        return

    cfg = context.application.bot_data["config"]
    if not _is_dm(update) or not _is_admin(update, cfg):
        return

    conn = context.application.bot_data["db"]
    rows = db.recent_unresolved_reports(conn, limit=20)

    if not rows:
        await update.effective_message.reply_text(NO_REPORTS_MESSAGE)
        return

    body = "\n\n".join(_format_report_line(row) for row in rows)
    await update.effective_message.reply_text(body)


async def resolve_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_message is None:
        return

    cfg = context.application.bot_data["config"]
    if not _is_dm(update) or not _is_admin(update, cfg):
        return

    if not context.args or not context.args[0].isdigit():
        await update.effective_message.reply_text("Usage: /resolve <id>")
        return

    report_id = int(context.args[0])
    conn = context.application.bot_data["db"]
    resolved = db.resolve_report(conn, report_id)

    if resolved:
        logger.info("Report #%d marked resolved via /resolve.", report_id)
        await update.effective_message.reply_text(f"Report #{report_id} marked resolved.")
    else:
        await update.effective_message.reply_text(f"No report with id {report_id}.")
