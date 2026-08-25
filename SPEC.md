# Mess Menu Telegram Bot — Build Specification

**Status:** Authoritative. This document is the single source of truth for what gets built.

**Instruction to the implementing agent:** Build exactly what is specified here. Do not substitute libraries, do not redesign the data model, do not add features that are not listed, and do not "improve" the architecture. If something in this spec is genuinely ambiguous or appears contradictory, **stop and ask the repo owner** rather than deciding for yourself. A list of the only permitted open decisions appears in §12.

---

## 1. What this bot does

A Telegram bot that lives in a university group chat and:

1. Posts the day's menu before each of the four daily meal windows (breakfast, lunch, snack, dinner).
2. Posts a rating prompt after each meal window closes, collecting 1–5 ratings via inline keyboard buttons.
3. Accepts direct messages from users reporting that a posted menu was wrong, and stores those reports for the admin.
4. Once every meal slot in the menu cycle has been rated at least once, starts including historical average ratings in the daily menu posts.

The menu is a two-week cycle (an **even week** and an **odd week**) that the repo owner hand-authors as a YAML file roughly every two months.

---

## 2. Technology stack — fixed, not negotiable

| Concern | Choice |
|---|---|
| Language | Python 3.11+ |
| Telegram library | `python-telegram-bot` v21+ (async API) |
| Scheduling | `python-telegram-bot`'s built-in `JobQueue` (`application.job_queue.run_daily`). Do **not** add a separate `APScheduler`, `schedule`, `celery`, or `cron` layer. PTB's JobQueue is APScheduler under the hood; one scheduler only. |
| Database | SQLite via the Python standard-library `sqlite3` module. No ORM. No SQLAlchemy. |
| Menu storage | A YAML file, parsed with `PyYAML` (`yaml.safe_load`) |
| Config | A YAML file, parsed with `PyYAML` |
| Secrets | Environment variables loaded from a `.env` file via `python-dotenv` |
| LLM | DeepSeek API (OpenAI-compatible) via the official `openai` Python SDK, pointed at `base_url="https://api.deepseek.com"` |
| Process management | `systemd` on the target VPS |

`requirements.txt` must pin these and nothing else beyond their transitive dependencies.

---

## 3. Repository layout — build exactly this

```
menubot/
├── bot.py                  # entrypoint: builds the Application, registers handlers + jobs, runs polling
├── config.py               # loads config.yaml + .env, exposes a Config object
├── menu.py                 # loads/reloads menu.yaml, resolves "what is today's menu"
├── db.py                   # all SQLite access: schema creation + every query function
├── ratings.py              # rating prompt construction, callback handling, coverage calibration, averages
├── reports.py              # DM report handling
├── llm.py                  # the deepseek phrasing pass
├── handlers.py             # Telegram command handlers (/start, /menu, /reloadmenu, /reports, /stats)
├── jobs.py                 # the scheduled job functions (menu post, rating prompt) + job registration
├── menu.yaml               # the menu data (hand-authored by the repo owner)
├── config.yaml             # non-secret configuration
├── .env.example            # template for secrets — never commit a real .env
├── requirements.txt
├── AGENTS.md
├── SPEC.md                 # this file
├── README.md               # short: what it is, how to run locally, how to deploy
└── deploy/
    └── menubot.service     # the systemd unit file
```

Do not create additional modules, packages, or subdirectories. Do not restructure into `src/`.

---

## 4. Data formats

### 4.1 `menu.yaml`

This file is **hand-authored by a human**. The agent must not write a parser that is clever or forgiving — it must expect exactly this structure and fail loudly if the structure is wrong.

```yaml
even_week:
  monday:
    breakfast: [Idli, Sambar, Coconut Chutney, Bread, Jam, Tea]
    lunch: [Rice, Dal Tadka, Aloo Gobi, Curd, Papad]
    snack: [Samosa, Tea]
    dinner: [Chapati, Paneer Butter Masala, Rice, Rasam]
  tuesday:
    breakfast: [...]
    lunch: [...]
    snack: [...]
    dinner: [...]
  wednesday: {...}
  thursday: {...}
  friday: {...}
  saturday: {...}
  sunday: {...}
odd_week:
  monday: {...}
  # ... all seven days, same shape
```

Rules:
- Top-level keys are exactly `even_week` and `odd_week`.
- Each week has exactly seven day keys, lowercase English day names: `monday` … `sunday`.
- Each day has exactly four meal keys, in this order: `breakfast`, `lunch`, `snack`, `dinner`.
- Each meal value is a flat list of dish-name strings. **There is no sub-grouping** — no counters, no stalls, no stations, no categories. A flat list of strings, nothing else.
- An empty meal is represented as an empty list `[]`, never `null` and never a missing key.

The loader must validate all of the above on load and raise a clear error naming the exact missing/malformed key. It must never silently fill in defaults.

Commit a complete `menu.yaml` with **placeholder dish names** (e.g. `Dish A`, `Dish B`) covering all 56 slots, so the repo is runnable out of the box and the owner can see the shape.

### 4.2 `config.yaml`

```yaml
timezone: "Asia/Kolkata"

# Anchor for even/odd week resolution. See §5.2.
# The ISO week containing this date is treated as an ODD week.
week_anchor_date: "2026-01-05"

# Times are local to `timezone`, 24-hour "HH:MM".
# post_at  = when the menu announcement goes out
# rate_at  = when the rating prompt goes out
meals:
  breakfast:
    label: "Breakfast"
    post_at: "07:00"
    rate_at: "09:30"
  lunch:
    label: "Lunch"
    post_at: "12:00"
    rate_at: "14:30"
  snack:
    label: "Snack"
    post_at: "16:30"
    rate_at: "18:00"
  dinner:
    label: "Dinner"
    post_at: "19:30"
    rate_at: "21:30"

llm:
  enabled: true
  model: "deepseek-v4-flash"
  max_tokens: 400
  # Free-text personality instruction for the phrasing pass. Owner-editable.
  persona: "Warm, brief, a little playful. Like a friend telling you what's for lunch."

ratings:
  scale_max: 5
  # Total slots that must each have >= 1 rating before averages are shown.
  # 7 days x 2 week types x 4 meals = 56. Do not hardcode this elsewhere; compute it.
  show_averages_when_calibrated: true
```

Every one of these values must be read from config at runtime. **No magic numbers or times anywhere in the code.**

### 4.3 `.env.example`

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_GROUP_CHAT_ID=
ADMIN_USER_ID=
DEEPSEEK_API_KEY=
DB_PATH=menubot.db
MENU_PATH=menu.yaml
CONFIG_PATH=config.yaml
```

`TELEGRAM_GROUP_CHAT_ID` is the numeric chat ID of the group (negative for supergroups). `ADMIN_USER_ID` is the numeric Telegram user ID of the repo owner. Startup must fail immediately with a clear message if any of the first four are missing (`DEEPSEEK_API_KEY` is only required if `llm.enabled` is true).

---

## 5. Core logic

### 5.1 Meal slot identity

A **slot** is the tuple `(week_type, day, meal)` — e.g. `("even_week", "monday", "lunch")`. There are exactly 56 slots. Ratings, coverage, and averages are all keyed on slots, **not** on calendar dates. Calendar date is stored on each rating row for auditing and de-duplication only.

### 5.2 Resolving even vs. odd week

```
anchor_week = ISO week number of config.week_anchor_date
current_week = ISO week number of today (in config.timezone)
if (current_week - anchor_week) % 2 == 0:  week_type = "odd_week"
else:                                      week_type = "even_week"
```

Use `datetime.date.isocalendar()`. Implement this in exactly one function, `menu.resolve_week_type(today)`, and call it everywhere. Do not reimplement it inline.

⚠️ ISO week numbers reset across year boundaries. Compute the parity from a **continuous** count, not the raw week number: derive it from the number of whole weeks between the anchor's ISO-week Monday and the current ISO-week Monday. Write a unit-testable pure function.

### 5.3 Getting today's menu

`menu.get_menu(date, meal) -> list[str]` — resolves week type, resolves lowercase weekday name, returns the dish list. Raises if the slot is missing.

### 5.4 Menu posting job

For each meal, a daily job at `meals.<meal>.post_at` that:

1. Resolves today's slot and dish list.
2. If the dish list is empty, posts nothing and logs it. (Do not post "no menu today".)
3. Builds a deterministic base message (see §6).
4. If `llm.enabled`, passes it through the phrasing pass (§7). If the LLM call fails for any reason, **fall back to the deterministic message** and log the error. Never let an LLM failure block the post.
5. Sends to `TELEGRAM_GROUP_CHAT_ID`.

### 5.5 Rating prompt job

For each meal, a daily job at `meals.<meal>.rate_at` that:

1. Resolves today's slot. If the dish list was empty, skip.
2. Sends a message to the group with an inline keyboard: buttons `1` … `scale_max`.
3. Callback data format: `rate|{iso_date}|{week_type}|{day}|{meal}|{score}`. Parse defensively; ignore malformed callbacks.

### 5.6 Rating callback handling

On `callback_query`:

1. Parse the callback data.
2. `INSERT ... ON CONFLICT(date, meal, user_id) DO UPDATE SET score = excluded.score` — a user may change their rating for a given meal on a given day, but only ever holds one.
3. Answer the callback query with a short toast confirming the score (e.g. "Rated 4/5 — thanks!"). Do **not** post a new group message per rating; that would spam the chat.
4. Never reveal who rated what in the group.

### 5.7 Calibration

`ratings.is_calibrated()`:

```sql
SELECT COUNT(DISTINCT week_type || '|' || day || '|' || meal) FROM ratings
```

Compare to the total slot count computed from the menu structure (7 × 2 × 4 = 56, but **compute it**, don't hardcode). Once it reaches the total, write `calibrated = true` into the `state` table so the check becomes a cheap read afterwards and never regresses.

Until calibrated, menu posts contain **no** rating information at all. After calibration, each menu post includes that slot's historical average.

### 5.8 Average ratings

`ratings.slot_average(week_type, day, meal) -> float | None` — mean of all scores for that slot, rounded to one decimal, plus the count of ratings. Displayed as e.g. `★ 3.8 (12 ratings)`.

### 5.9 Report handling

Any **private** (non-group) text message to the bot that is not a command is treated as a menu-correction report:

1. Insert into `reports` with user id, username, message text, timestamp, `resolved = 0`.
2. Reply to the user confirming receipt.
3. Forward a copy to `ADMIN_USER_ID` as a DM.

---

## 6. Message formats

Deterministic base message for a menu post (this is what the LLM receives, and what is sent verbatim if the LLM is disabled or fails):

```
🍽️ {label} — {Weekday}, {DD Mon}

• Dish A
• Dish B
• Dish C
```

If calibrated, append:

```

★ {avg}/5 from {n} ratings
```

Rating prompt message:

```
How was {label} today? Tap to rate.
```

Use Telegram HTML parse mode. Escape dish names — they come from a hand-edited file and may contain `&`, `<`, `>`.

---

## 7. The LLM phrasing pass

This is the **only** place an LLM is used at runtime. Its job is presentation, nothing else.

- Model, `max_tokens`, and persona come from `config.yaml`.
- Call made via the `openai` SDK's `OpenAI(api_key=..., base_url="https://api.deepseek.com")` client (DeepSeek's API is OpenAI-compatible; there is no dedicated DeepSeek SDK).
- System prompt must instruct the model, in substance:
  - Rewrite the given menu announcement in the given persona.
  - **Reproduce every dish name exactly as given. Never add, remove, rename, translate, or invent a dish.**
  - Keep it under ~40 words plus the dish list.
  - Return only the message text, no preamble, no markdown fences.
- After the call, run a **verification check**: confirm every dish string from the source list appears in the LLM output. If any is missing, discard the LLM output and send the deterministic message instead. Log the discrepancy.
- Wrap the whole call in a timeout and a try/except. Any failure → deterministic fallback.

The LLM must never be asked what the menu is, never be given the database, and never be used for ratings or reports.

---

## 8. Database schema

Create on startup with `CREATE TABLE IF NOT EXISTS`. Exactly these three tables:

```sql
CREATE TABLE IF NOT EXISTS ratings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT    NOT NULL,   -- ISO YYYY-MM-DD, local date of the meal
    week_type  TEXT    NOT NULL,   -- 'even_week' | 'odd_week'
    day        TEXT    NOT NULL,   -- 'monday' ... 'sunday'
    meal       TEXT    NOT NULL,   -- 'breakfast' | 'lunch' | 'snack' | 'dinner'
    user_id    INTEGER NOT NULL,
    score      INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    UNIQUE(date, meal, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_slot ON ratings(week_type, day, meal);

CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    username   TEXT,
    message    TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    resolved   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

All SQL lives in `db.py`. No SQL strings anywhere else in the codebase. Use parameterised queries exclusively.

---

## 9. Commands

| Command | Where | Who | Behaviour |
|---|---|---|---|
| `/start` | DM | anyone | One-line explanation + tells them they can DM menu corrections here. |
| `/menu` | group or DM | anyone | Posts today's remaining meals (or all four, if before breakfast). Deterministic format, no LLM. |
| `/reloadmenu` | DM | admin only | Re-reads `menu.yaml` from disk into memory. Replies with success, or the exact validation error on failure. **The previously loaded menu stays active if the new file is invalid.** |
| `/reports` | DM | admin only | Lists the 20 most recent unresolved reports with their IDs. |
| `/resolve <id>` | DM | admin only | Marks a report resolved. |
| `/stats` | DM | admin only | Calibration progress (`n/56 slots rated`) and the five highest- and lowest-rated slots. |

Admin-only commands must check `update.effective_user.id == ADMIN_USER_ID` and silently ignore (or politely refuse) otherwise.

---

## 10. Operational requirements

- **Logging:** use the stdlib `logging` module to stdout at INFO. systemd captures it into the journal. Log every scheduled post, every reload, every LLM fallback, every report. Never log the bot token or API key.
- **Timezone:** every date/time operation must use `config.timezone` via `zoneinfo.ZoneInfo`. Never use naive `datetime.now()`.
- **Crash safety:** the bot must survive a malformed callback, a Telegram API error, or an LLM outage without exiting. Scheduled jobs must each catch their own exceptions.
- **Idempotency:** the menu-post job must not double-post if it somehow fires twice. Track the last posted `(date, meal)` in the `state` table and skip if already posted.
- **Startup:** validate config, validate menu, connect DB, register handlers, register the 8 daily jobs, then start polling. Fail fast and loudly on any validation error.

---

## 11. Deployment

Build locally against a **separate test bot** (a second bot from @BotFather) in a private test group. Never develop against the live group.

`deploy/menubot.service`:

```ini
[Unit]
Description=Mess Menu Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=menubot
WorkingDirectory=/opt/menubot
EnvironmentFile=/opt/menubot/.env
ExecStart=/opt/menubot/.venv/bin/python /opt/menubot/bot.py
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

`README.md` must document exactly this deploy sequence:

```bash
git clone <repo> /opt/menubot && cd /opt/menubot
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env && $EDITOR .env        # fill in real values
sudo cp deploy/menubot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now menubot
journalctl -u menubot -f                     # verify
```

Update loop: `git pull && sudo systemctl restart menubot`
Menu-only update: edit `menu.yaml`, then DM the bot `/reloadmenu` — **no restart**.

---

## 12. Build order

Implement in this order, and make the repo runnable at the end of each phase.

1. **Skeleton** — `config.py`, `.env` loading, `menu.py` with loader + validation + `resolve_week_type`, placeholder `menu.yaml`. A `bot.py` that starts, validates, connects to Telegram, and responds to `/start`.
2. **Menu posting** — `db.py` schema, `jobs.py` menu-post job registered for all four meals, `/menu` command, idempotency guard. No LLM yet — deterministic messages only.
3. **Reports** — `reports.py`, DM handler, `/reports`, `/resolve`, admin forwarding.
4. **Ratings** — rating-prompt job, inline keyboard, callback handler, upsert, `/stats`.
5. **Calibration + averages** — coverage query, `state` flag, averages appended to menu posts.
6. **LLM pass** — `llm.py`, the verification check, the fallback path, wired into the menu-post job last.
7. **Deploy artefacts** — `menubot.service`, `README.md`.

---

## 13. Permitted open decisions

The agent may decide, without asking, **only** these:

- Internal function signatures and private helper names not specified above.
- Exact wording of log lines and user-facing confirmation/toast text.
- Exact emoji choices in messages.
- Docstring and comment content.
- Test file organisation, if tests are added.

**Everything else is specified.** Anything not covered here and not on this list → stop and ask the repo owner. In particular: do not add a web dashboard, do not add webhooks (use polling), do not add per-dish rating breakdowns, do not add user profiles, do not add a Docker setup, do not swap SQLite for anything else, and do not add an LLM anywhere beyond §7.
