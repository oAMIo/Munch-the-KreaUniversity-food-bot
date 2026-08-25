"""Entrypoint: builds the Application, registers handlers + jobs, runs polling.

Startup sequence (SPEC.md §10): validate config, validate menu, connect DB,
register handlers, register the scheduled jobs, then start polling. Fail
fast and loudly on any validation error.
"""

from __future__ import annotations

import logging
import sys

from telegram.ext import Application, CommandHandler

import config as config_module
import menu as menu_module
import handlers

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


def main() -> None:
    try:
        cfg = config_module.load_config()
    except config_module.ConfigError as exc:
        logger.error("Config validation failed: %s", exc)
        raise SystemExit(1) from exc

    try:
        menu_module.load_menu(cfg.menu_path)
    except menu_module.MenuError as exc:
        logger.error("Menu validation failed: %s", exc)
        raise SystemExit(1) from exc

    logger.info("Config and menu validated. Building application.")

    application = Application.builder().token(cfg.telegram_bot_token).build()
    application.bot_data["config"] = cfg

    application.add_handler(CommandHandler("start", handlers.start_command))

    logger.info("Starting polling.")
    application.run_polling(allowed_updates=None)


if __name__ == "__main__":
    main()
