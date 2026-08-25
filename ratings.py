"""Rating prompt construction, callback handling, coverage/calibration, averages.

Phase 4 implements the prompt message/keyboard builders, the callback
handler (parse, upsert, toast), and raw coverage counting for /stats.
is_calibrated()'s cached state flag and the averages-in-menu-posts wiring
are added in phase 5 (SPEC.md §12).
"""

from __future__ import annotations

import datetime
import logging
from zoneinfo import ZoneInfo

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ContextTypes

import db
import menu as menu_module

logger = logging.getLogger(__name__)

CALLBACK_PREFIX = "rate"


def build_rating_prompt_message(label: str) -> str:
    """Deterministic rating-prompt message (SPEC.md §6)."""
    return f"How was {label} today? Tap to rate."


def build_rating_keyboard(
    date_iso: str, week_type: str, day: str, meal: str, scale_max: int
) -> InlineKeyboardMarkup:
    buttons = [
        InlineKeyboardButton(
            str(score), callback_data=f"{CALLBACK_PREFIX}|{date_iso}|{week_type}|{day}|{meal}|{score}"
        )
        for score in range(1, scale_max + 1)
    ]
    return InlineKeyboardMarkup([buttons])


def _parse_rate_callback(data: str, scale_max: int) -> tuple[str, str, str, str, int] | None:
    """Parse 'rate|{iso_date}|{week_type}|{day}|{meal}|{score}'. None if malformed."""
    parts = data.split("|")
    if len(parts) != 6 or parts[0] != CALLBACK_PREFIX:
        return None

    _, date_iso, week_type, day, meal, score_str = parts

    try:
        datetime.date.fromisoformat(date_iso)
    except ValueError:
        return None

    if week_type not in menu_module.WEEK_TYPES:
        return None
    if day not in menu_module.DAYS:
        return None
    if meal not in menu_module.MEALS:
        return None
    if not score_str.isdigit():
        return None

    score = int(score_str)
    if not (1 <= score <= scale_max):
        return None

    return date_iso, week_type, day, meal, score


async def handle_rating_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or query.data is None:
        return

    cfg = context.application.bot_data["config"]
    parsed = _parse_rate_callback(query.data, cfg.ratings.scale_max)
    if parsed is None:
        logger.warning("Ignoring malformed rating callback: %r", query.data)
        await query.answer()
        return

    date_iso, week_type, day, meal, score = parsed
    conn = context.application.bot_data["db"]
    user_id = query.from_user.id
    created_at_iso = datetime.datetime.now(tz=ZoneInfo(cfg.timezone)).isoformat()

    db.upsert_rating(
        conn,
        date_iso=date_iso,
        week_type=week_type,
        day=day,
        meal=meal,
        user_id=user_id,
        score=score,
        created_at_iso=created_at_iso,
    )
    logger.info("Rating upserted: user_id=%s slot=%s/%s/%s score=%d", user_id, week_type, day, meal, score)

    await query.answer(text=f"Rated {score}/{cfg.ratings.scale_max} — thanks!")
