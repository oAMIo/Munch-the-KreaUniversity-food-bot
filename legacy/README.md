# Legacy: Telegram/Python implementation

This is the original Telegram bot (Python 3.11+, `python-telegram-bot` v21), kept
here for reference after the WhatsApp/Node port (see the repo root `README.md`
and `SPEC.md`). It is not run or maintained — it's dead code, preserved in case
anything here is useful to cross-check against the new implementation.

To run it again, you'd need to recreate a virtualenv and `pip install -r
requirements.txt` from this directory, plus a `.env` with the old
`TELEGRAM_*`/`ADMIN_USER_ID` variables (see git history for the old
`.env.example`).
