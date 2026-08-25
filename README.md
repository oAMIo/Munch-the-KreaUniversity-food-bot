# Munch — Krea University mess menu bot

A Telegram bot for a university group chat that:

- Posts the day's mess menu before each of the four daily meal windows (breakfast, lunch, snack, dinner).
- Posts a rating prompt after each meal window closes, collecting 1–5 ratings via inline buttons.
- Accepts DM reports when a posted menu was wrong, and forwards them to the admin.
- Once every slot in the two-week menu cycle has been rated at least once, starts showing historical average ratings in the daily menu posts.
- Optionally rephrases menu posts in a configurable persona via the DeepSeek API — always falling back to a plain deterministic message if that call fails or would alter a dish name.

See `SPEC.md` for the full build specification and `AGENTS.md` for repository conventions.

## Running locally

Requires Python 3.11+.

```bash
git clone <repo> menubot && cd menubot
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt      # Windows: .venv\Scripts\pip install -r requirements.txt
cp .env.example .env && $EDITOR .env           # fill in real values (see below)
.venv/bin/python bot.py                        # Windows: .venv\Scripts\python bot.py
```

Build locally against a **separate test bot** (a second bot from @BotFather) in a private test group. Never develop against the live group.

### `.env` values

| Variable | Meaning |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather. |
| `TELEGRAM_GROUP_CHAT_ID` | Numeric chat ID of the group (negative for supergroups). |
| `ADMIN_USER_ID` | Numeric Telegram user ID of the repo owner. |
| `DEEPSEEK_API_KEY` | DeepSeek API key. Required only if `llm.enabled: true` in `config.yaml`. |
| `DB_PATH` | Path to the SQLite database file (default `menubot.db`). |
| `MENU_PATH` | Path to `menu.yaml`. |
| `CONFIG_PATH` | Path to `config.yaml`. |

Non-secret behaviour (meal times, timezone, LLM persona/model, rating scale) lives in `config.yaml`. The menu itself lives in `menu.yaml` — see `SPEC.md` §4.1 for its exact required structure.

## Deploying (systemd on a Linux VPS)

```bash
git clone <repo> /opt/menubot && cd /opt/menubot
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env && $EDITOR .env        # fill in real values
sudo cp deploy/menubot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now menubot
journalctl -u menubot -f                     # verify
```

**Update loop:** `git pull && sudo systemctl restart menubot`

**Menu-only update:** edit `menu.yaml`, then DM the bot `/reloadmenu` — no restart needed. If the new file fails validation, the previously loaded menu stays active and the bot replies with the exact error.

## Commands

| Command | Where | Who | Behaviour |
|---|---|---|---|
| `/start` | DM | anyone | Explains the bot and how to report a wrong menu. |
| `/menu` | group or DM | anyone | Posts today's remaining meals (or all four, if before breakfast). |
| `/reloadmenu` | DM | admin | Re-reads `menu.yaml` from disk. |
| `/reports` | DM | admin | Lists the 20 most recent unresolved reports. |
| `/resolve <id>` | DM | admin | Marks a report resolved. |
| `/stats` | DM | admin | Calibration progress and the five highest/lowest-rated slots. |
