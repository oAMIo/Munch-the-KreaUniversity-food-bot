"""Loads/reloads menu.yaml and resolves "what is today's menu".

menu.yaml is hand-authored by a human (SPEC.md §4.1). The loader here is
intentionally strict: it validates the exact expected structure and raises
a clear error naming the offending key. It never fills in defaults and
never accepts a partial file.
"""

from __future__ import annotations

import datetime
import logging
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

WEEK_TYPES = ("even_week", "odd_week")
DAYS = ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")
MEALS = ("breakfast", "lunch", "snack", "dinner")

TOTAL_SLOTS = len(WEEK_TYPES) * len(DAYS) * len(MEALS)  # 56, computed, not hardcoded


class MenuError(RuntimeError):
    """Raised when menu.yaml is missing, malformed, or a requested slot is missing."""


def load_menu(menu_path: str | Path) -> dict:
    """Load and strictly validate menu.yaml. Returns the raw nested dict.

    Raises MenuError naming the exact missing/malformed key on any deviation
    from the structure defined in SPEC.md §4.1.
    """
    path = Path(menu_path)
    if not path.is_file():
        raise MenuError(f"menu.yaml not found at {path!s}.")

    with path.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f)

    if not isinstance(raw, dict):
        raise MenuError("menu.yaml: top level must be a mapping.")

    missing_weeks = [w for w in WEEK_TYPES if w not in raw]
    if missing_weeks:
        raise MenuError(f"menu.yaml: missing top-level key(s): {missing_weeks}.")

    extra_weeks = [k for k in raw if k not in WEEK_TYPES]
    if extra_weeks:
        raise MenuError(f"menu.yaml: unexpected top-level key(s): {extra_weeks}. Only {WEEK_TYPES} allowed.")

    for week_type in WEEK_TYPES:
        week_raw = raw[week_type]
        if not isinstance(week_raw, dict):
            raise MenuError(f"menu.yaml: {week_type!r} must be a mapping.")

        missing_days = [d for d in DAYS if d not in week_raw]
        if missing_days:
            raise MenuError(f"menu.yaml: {week_type}: missing day key(s): {missing_days}.")

        extra_days = [k for k in week_raw if k not in DAYS]
        if extra_days:
            raise MenuError(f"menu.yaml: {week_type}: unexpected day key(s): {extra_days}.")

        for day in DAYS:
            day_raw = week_raw[day]
            context = f"{week_type}.{day}"
            if not isinstance(day_raw, dict):
                raise MenuError(f"menu.yaml: {context} must be a mapping.")

            missing_meals = [m for m in MEALS if m not in day_raw]
            if missing_meals:
                raise MenuError(f"menu.yaml: {context}: missing meal key(s): {missing_meals}.")

            extra_meals = [k for k in day_raw if k not in MEALS]
            if extra_meals:
                raise MenuError(f"menu.yaml: {context}: unexpected meal key(s): {extra_meals}.")

            for meal in MEALS:
                dishes = day_raw[meal]
                meal_context = f"{context}.{meal}"
                if not isinstance(dishes, list):
                    raise MenuError(
                        f"menu.yaml: {meal_context} must be a list (use [] for an empty meal), got {dishes!r}."
                    )
                for i, dish in enumerate(dishes):
                    if not isinstance(dish, str) or not dish.strip():
                        raise MenuError(
                            f"menu.yaml: {meal_context}[{i}] must be a non-empty dish-name string, got {dish!r}."
                        )

    logger.info("menu.yaml loaded and validated (%d slots).", TOTAL_SLOTS)
    return raw


def resolve_week_type(today: datetime.date, week_anchor_date: datetime.date) -> str:
    """Resolve 'even_week' or 'odd_week' for `today`, relative to the anchor.

    The ISO week containing `week_anchor_date` is treated as an ODD week.
    Parity is derived from a *continuous* count of whole weeks between the
    anchor's ISO-week Monday and today's ISO-week Monday (SPEC.md §5.2),
    because raw ISO week numbers reset across year boundaries.

    This is the single implementation of week-type resolution. Call it
    everywhere; never reimplement it inline.
    """
    anchor_monday = week_anchor_date - datetime.timedelta(days=week_anchor_date.isocalendar()[2] - 1)
    today_monday = today - datetime.timedelta(days=today.isocalendar()[2] - 1)
    weeks_diff = (today_monday - anchor_monday).days // 7

    if weeks_diff % 2 == 0:
        return "odd_week"
    return "even_week"


def get_menu(menu: dict, today: datetime.date, week_anchor_date: datetime.date, meal: str) -> list[str]:
    """Resolve week type + weekday name for `today` and return the dish list.

    Raises MenuError if the slot is missing (should not happen against a
    validated menu, but guards against a partially-reloaded/corrupt dict).
    """
    if meal not in MEALS:
        raise MenuError(f"get_menu: unknown meal {meal!r}. Must be one of {MEALS}.")

    week_type = resolve_week_type(today, week_anchor_date)
    day = DAYS[today.weekday()]

    try:
        return menu[week_type][day][meal]
    except KeyError as exc:
        raise MenuError(f"menu: slot {week_type}.{day}.{meal} is missing.") from exc
