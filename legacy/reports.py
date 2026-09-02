"""DM report handling (SPEC.md §5.9).

Any private, non-command text message to the bot is treated as a
menu-correction report: store it, confirm receipt to the sender, and
forward a copy to the admin.
"""

from __future__ import annotations

import datetime
import logging
from zoneinfo import ZoneInfo

from telegram import Update
from telegram.ext import ContextTypes

import db

logger = logging.getLogger(__name__)

CONFIRMATION_MESSAGE = "Thanks — I've passed this along to the admin."


def _format_admin_forward(report_id: int, user_id: int, username: str | None, message: str) -> str:
    who = f"@{username}" if username else f"user {user_id}"
    return f"New menu report #{report_id} from {who}:\n\n{message}"


async def handle_report_dm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_message is None or update.effective_user is None:
        return

    message_text = update.effective_message.text
    if not message_text:
        return

    cfg = context.application.bot_data["config"]
    conn = context.application.bot_data["db"]
    user = update.effective_user

    created_at_iso = datetime.datetime.now(tz=ZoneInfo(cfg.timezone)).isoformat()
    report_id = db.insert_report(
        conn,
        user_id=user.id,
        username=user.username,
        message=message_text,
        created_at_iso=created_at_iso,
    )
    logger.info("Stored report #%d from user_id=%s.", report_id, user.id)

    await update.effective_message.reply_text(CONFIRMATION_MESSAGE)

    try:
        await context.bot.send_message(
            chat_id=cfg.admin_user_id,
            text=_format_admin_forward(report_id, user.id, user.username, message_text),
        )
    except Exception:
        logger.exception("Failed to forward report #%d to admin.", report_id)
