"""Telegram command handlers (/start, /menu, /reloadmenu, /reports, /stats, /resolve).

Phase 1 implements only /start. Later phases add the rest here, per
SPEC.md §3/§9.
"""

from __future__ import annotations

import logging

from telegram import Update
from telegram.ext import ContextTypes

logger = logging.getLogger(__name__)

START_MESSAGE = (
    "Hi! I post the mess menu before each meal and collect ratings afterwards. "
    "If a posted menu was wrong, just send me a message here (DM) describing "
    "the mistake and I'll pass it on."
)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_message is None:
        return
    await update.effective_message.reply_text(START_MESSAGE)
