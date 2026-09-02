# Mess Menu WhatsApp Bot — Build Specification

**Status:** Authoritative. This document is the single source of truth for what gets built.

**Instruction to the implementing agent:** Build exactly what is specified here. Do not substitute libraries, do not redesign the data model, do not add features that are not listed, and do not "improve" the architecture. If something in this spec is genuinely ambiguous or appears contradictory, **stop and ask the repo owner** rather than deciding for yourself. A list of the only permitted open decisions appears in §12.

---

## 1. What this bot does

A WhatsApp bot (via Baileys, run from a dedicated WhatsApp number) that lives in a university group chat and:

1. Posts the day's menu before each of the four daily meal windows (breakfast, lunch, snack, dinner).
2. Posts a rating prompt after each meal window closes, collecting 1–5 ratings via a native WhatsApp poll.
3. Accepts direct messages from users reporting that a posted menu was wrong, and stores those reports for the admin.
4. Once every meal slot in the menu cycle has been rated at least once, starts including historical average ratings in the daily menu posts.

The menu is a two-week cycle (an **even week** and an **odd week**) that the repo owner hand-authors as a YAML file roughly every two months.

**History:** this was originally built as a Telegram bot in Python (`python-telegram-bot`); that implementation is preserved, unmaintained, under `legacy/`. It was ported to WhatsApp because Baileys — the WhatsApp Web protocol library used here — has no Python binding, so the port is also a language change (Python → Node/TypeScript). Every other design decision in this spec carries over from the original unchanged unless a section below says otherwise.

---

## 2. Technology stack — fixed, not negotiable

| Concern | Choice |
|---|---|
| Language | Node.js 20+ LTS, TypeScript |
| WhatsApp library | `@whiskeysockets/baileys` (maintained Baileys fork), connected as the dedicated bot number via a linked-device (QR code) session |
| Scheduling | `node-cron`. Do **not** add a separate scheduler library or a system `cron` layer — one scheduler only. |
| Database | SQLite via `better-sqlite3` (synchronous API). No ORM. |
| Menu storage | A YAML file, parsed with `js-yaml` |
| Config | A YAML file, parsed with `js-yaml` |
| Secrets | Environment variables loaded from a `.env` file via `dotenv` |
| LLM | DeepSeek API (OpenAI-compatible) via the official `openai` npm SDK, pointed at `baseURL: "https://api.deepseek.com"` |
| Process management | `systemd` on the target VPS, running the `tsc`-compiled `dist/bot.js` |

`package.json` must pin these and nothing else beyond their transitive dependencies. Build with `npm run build` (`tsc`); do not add a bundler.

---

## 3. Repository layout — build exactly this

```
menubot/
├── src/
│   ├── bot.ts            # entrypoint: connects Baileys, registers the message dispatcher + jobs
│   ├── config.ts         # loads config.yaml + .env, exposes a Config object
│   ├── menu.ts           # loads/reloads menu.yaml, resolves "what is today's menu"
│   ├── time.ts           # timezone-aware date/time helpers (config.timezone via Intl, never a naive `new Date()`)
│   ├── db.ts             # all SQLite access: schema creation + every query function
│   ├── ratings.ts        # rating-poll construction, vote handling, coverage calibration, averages
│   ├── reports.ts        # DM report handling
│   ├── llm.ts            # the deepseek phrasing pass
│   ├── handlers.ts       # WhatsApp text-command handlers (/start, /menu, /reloadmenu, /reports, /resolve, /stats)
│   ├── jobs.ts           # the scheduled job functions (menu post, rating prompt) + job registration
│   └── logger.ts         # structured stdout logging (pino)
├── menu.yaml               # the menu data (hand-authored by the repo owner)
├── config.yaml             # non-secret configuration
├── .env.example            # template for secrets — never commit a real .env
├── package.json, tsconfig.json
├── AGENTS.md
├── SPEC.md                 # this file
├── README.md               # short: what it is, how to run locally, how to deploy
├── legacy/                 # the original Telegram/Python implementation — preserved, unmaintained
└── deploy/
    └── menubot.service     # the systemd unit file
```

Do not create additional modules or subdirectories under `src/`. Do not restructure into `src/lib/`, `src/services/`, etc.

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
  model: "deepseek-chat"
  max_tokens: 400
  # Wall-clock timeout for the phrasing-pass API call, in seconds.
  timeout_seconds: 15
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
WHATSAPP_GROUP_JID=
WHATSAPP_ADMIN_JID=
DEEPSEEK_API_KEY=
DB_PATH=menubot.db
MENU_PATH=menu.yaml
CONFIG_PATH=config.yaml
AUTH_DIR=auth
```

`WHATSAPP_GROUP_JID` is the group's WhatsApp JID, e.g. `1234567890-1234567890@g.us`. It is **not** required at startup — it cannot be known before the bot has connected once and seen a message from the group (SPEC.md §5.0.1), so it is validated as optional and defaults to unset. `WHATSAPP_ADMIN_JID` is the repo owner's own WhatsApp JID, e.g. `919876543210@s.whatsapp.net` (E.164 digits, no `+`, suffixed `@s.whatsapp.net`), and **is** required at startup. `AUTH_DIR` is where the Baileys linked-device session is cached (SPEC.md §5.0) — never commit it, it's equivalent to a login session. Startup must fail immediately with a clear message if `WHATSAPP_ADMIN_JID` is missing (`DEEPSEEK_API_KEY` is only required if `llm.enabled` is true). While `WHATSAPP_GROUP_JID` is unset, the bot still connects and answers DMs, but every menu-post/rating-prompt job fire is skipped and logged as a warning.

---

## 5. Core logic

### 5.0 WhatsApp session

The bot connects as the dedicated WhatsApp number via Baileys' multi-file auth state (`useMultiFileAuthState(AUTH_DIR)`). On first run (no session cached yet) it prints a QR code to stdout; the owner scans it once from that number's WhatsApp app (Settings → Linked Devices). The session persists in `AUTH_DIR` across restarts and is never committed to git. A logged-out session requires deleting `AUTH_DIR` and re-scanning.

#### 5.0.1 Bootstrapping `WHATSAPP_GROUP_JID`

`WHATSAPP_GROUP_JID` cannot be known before the bot has connected once — it's the JID of a group the owner hasn't necessarily added the bot to yet. So it is not in the startup-required env vars (only `WHATSAPP_ADMIN_JID` is); the bot must start and connect fine with it unset. Every incoming message is logged with its `chatJid` regardless of content type, so the owner can add the bot to the group, send any message, and read the JID off the log. Until `WHATSAPP_GROUP_JID` is set, `jobs.registerJobs` still registers the cron jobs (so a later restart isn't required for the schedule itself), but `postMenuJob`/`ratingPromptJob` must check for it and skip with a logged warning on every fire, rather than throwing.

### 5.1 Meal slot identity

A **slot** is the tuple `(week_type, day, meal)` — e.g. `("even_week", "monday", "lunch")`. There are exactly 56 slots. Ratings, coverage, and averages are all keyed on slots, **not** on calendar dates. Calendar date is stored on each rating row for auditing and de-duplication only.

### 5.2 Resolving even vs. odd week

```
anchor_week = ISO week number of config.week_anchor_date
current_week = ISO week number of today (in config.timezone)
if (current_week - anchor_week) % 2 == 0:  week_type = "odd_week"
else:                                      week_type = "even_week"
```

Implement this in exactly one function, `menu.resolveWeekType(today, weekAnchorDate)`, and call it everywhere. Do not reimplement it inline.

⚠️ ISO week numbers reset across year boundaries. Compute the parity from a **continuous** count, not the raw week number: derive it from the number of whole weeks between the anchor's ISO-week Monday and the current ISO-week Monday. Write a unit-testable pure function.

### 5.3 Getting today's menu

`menu.getMenu(menu, today, weekAnchorDate, meal) -> string[]` — resolves week type, resolves lowercase weekday name, returns the dish list. Throws if the slot is missing.

### 5.4 Menu posting job

For each meal, a daily cron job at `meals.<meal>.post_at` that:

1. Resolves today's slot and dish list.
2. If the dish list is empty, posts nothing and logs it. (Do not post "no menu today".)
3. Builds a deterministic base message (see §6).
4. If `llm.enabled`, passes it through the phrasing pass (§7). If the LLM call fails for any reason, **fall back to the deterministic message** and log the error. Never let an LLM failure block the post.
5. Sends to `WHATSAPP_GROUP_JID`.

### 5.5 Rating prompt job

For each meal, a daily cron job at `meals.<meal>.rate_at` that:

1. Resolves today's slot. If the dish list was empty, skip.
2. Sends a **native WhatsApp poll message** to the group: question = the rating-prompt text (§6), single-select options `"1"` … `"{scale_max}"`.
3. Registers the sent poll's message id in the `poll_votes` table, mapped to `(date, week_type, day, meal, scale_max)` — this is the WhatsApp-adapted replacement for Telegram's `rate|{iso_date}|{week_type}|{day}|{meal}|{score}` callback_data, since a poll option carries no payload of its own. Also keeps the full poll message in memory (needed to decrypt later votes; see §5.6).

### 5.6 Rating vote handling

On a `messages.update` event carrying `pollUpdates` (one `proto.IPollUpdate` per vote):

1. Look up the vote's poll message id in `poll_votes`. If not found (not one of our rating polls, or from before this process started), ignore it.
2. Feed the vote into Baileys' `updateMessageWithPollUpdate` against the in-memory poll message, then re-aggregate with `getAggregateVotesInPollMessage` to get the current per-option voter list.
3. For each option/voter pair: `INSERT ... ON CONFLICT(date, meal, user_id) DO UPDATE SET score = excluded.score` — a user may change their vote for a given meal on a given day, but only ever holds one rating.
4. Never post a new group message per vote — WhatsApp polls already keep votes silent by design, so this is a purely silent DB write (no per-vote toast exists on WhatsApp the way Telegram's callback-answer toast did).
5. Never reveal who rated what in the group.

⚠️ The in-memory poll-message cache does not survive a restart: a poll posted before a restart can no longer register new votes after the process comes back up (Baileys needs the original poll message object, not just its id, to decrypt). This is a known limitation of the WhatsApp port with no equivalent in the Telegram version, where callback_data was self-contained.

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

Any **private** (non-group; a JID ending `@s.whatsapp.net` rather than `@g.us`) text message to the bot that is not a command is treated as a menu-correction report:

1. Insert into `reports` with sender JID, pushname, message text, timestamp, `resolved = 0`.
2. Reply to the sender confirming receipt.
3. Forward a copy to `WHATSAPP_ADMIN_JID` as a DM.

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

Rating prompt: a native WhatsApp poll (§5.5) whose question text is:

```
How was {label} today? Tap to rate.
```

and whose options are `"1"` … `"{scale_max}"`.

Use WhatsApp's plain-text markup (`*bold*` for the header) instead of Telegram HTML — no escaping is needed for dish names, since WhatsApp text has no markup-injection risk the way Telegram's HTML parse mode did.

---

## 7. The LLM phrasing pass

This is the **only** place an LLM is used at runtime. Its job is presentation, nothing else.

- Model, `max_tokens`, and persona come from `config.yaml`.
- Call made via the `openai` npm SDK's `new OpenAI({ apiKey, baseURL: "https://api.deepseek.com" })` client (DeepSeek's API is OpenAI-compatible; there is no dedicated DeepSeek SDK).
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

Create on startup with `CREATE TABLE IF NOT EXISTS`. Exactly these four tables:

```sql
CREATE TABLE IF NOT EXISTS ratings (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    date       TEXT    NOT NULL,   -- ISO YYYY-MM-DD, local date of the meal
    week_type  TEXT    NOT NULL,   -- 'even_week' | 'odd_week'
    day        TEXT    NOT NULL,   -- 'monday' ... 'sunday'
    meal       TEXT    NOT NULL,   -- 'breakfast' | 'lunch' | 'snack' | 'dinner'
    user_id    TEXT    NOT NULL,   -- voter's WhatsApp JID
    score      INTEGER NOT NULL,
    created_at TEXT    NOT NULL,
    UNIQUE(date, meal, user_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_slot ON ratings(week_type, day, meal);

CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,   -- reporter's WhatsApp JID
    username   TEXT,
    message    TEXT    NOT NULL,
    created_at TEXT    NOT NULL,
    resolved   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- WhatsApp-specific: maps an open rating poll's message id back to the
-- slot it was asking about (§5.5/§5.6) — the replacement for Telegram's
-- self-contained callback_data, since a poll option carries no payload.
CREATE TABLE IF NOT EXISTS poll_votes (
    poll_message_id TEXT PRIMARY KEY,
    date            TEXT    NOT NULL,
    week_type       TEXT    NOT NULL,
    day             TEXT    NOT NULL,
    meal            TEXT    NOT NULL,
    scale_max       INTEGER NOT NULL,
    created_at      TEXT    NOT NULL
);
```

All SQL lives in `db.ts`. No SQL strings anywhere else in the codebase. Use parameterised queries exclusively.

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

Admin-only commands must check `senderJid === WHATSAPP_ADMIN_JID` and silently ignore (or politely refuse) otherwise. WhatsApp has no slash-command framework — these are dispatched by plain-text prefix matching on incoming messages.

---

## 10. Operational requirements

- **Logging:** structured logging to stdout at INFO (`pino`). systemd captures it into the journal. Log every scheduled post, every reload, every LLM fallback, every report. Never log the WhatsApp session contents or the API key.
- **Timezone:** every date/time operation must use `config.timezone` via the `Intl` helpers in `time.ts`. Never use a naive `new Date()` for "what is today"/"what time is it".
- **Crash safety:** the bot must survive a malformed poll vote, a WhatsApp connection drop, or an LLM outage without exiting. Scheduled jobs must each catch their own exceptions. A dropped connection should attempt reconnection unless the session was explicitly logged out.
- **Idempotency:** the menu-post job must not double-post if it somehow fires twice. Track the last posted `(date, meal)` in the `state` table and skip if already posted.
- **Startup:** validate config, validate menu, connect DB, connect WhatsApp (§5.0), register the message dispatcher, register the 8 daily jobs, then run. Fail fast and loudly on any validation error.

---

## 11. Deployment

Build locally against a **separate WhatsApp number** in a private test group. Never develop against the live group.

`deploy/menubot.service`:

```ini
[Unit]
Description=Mess Menu WhatsApp Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=menubot
WorkingDirectory=/opt/menubot
EnvironmentFile=/opt/menubot/.env
ExecStart=/usr/bin/node /opt/menubot/dist/bot.js
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
npm install
npm run build                                # compiles src/ -> dist/
cp .env.example .env && $EDITOR .env         # fill in real values
sudo cp deploy/menubot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now menubot
journalctl -u menubot -f                     # verify — scan the printed QR code on first run
```

Update loop: `git pull && npm install && npm run build && sudo systemctl restart menubot`
Menu-only update: edit `menu.yaml`, then DM the bot `/reloadmenu` — **no restart**.

---

## 12. Build order

Implement in this order, and make the repo runnable at the end of each phase.

1. **Skeleton** — `config.ts`, `.env` loading, `menu.ts` with loader + validation + `resolveWeekType`, placeholder `menu.yaml`. A `bot.ts` that starts, validates, connects to WhatsApp (QR pairing), and responds to `/start`.
2. **Menu posting** — `db.ts` schema, `jobs.ts` menu-post job registered for all four meals, `/menu` command, idempotency guard. No LLM yet — deterministic messages only.
3. **Reports** — `reports.ts`, DM handler, `/reports`, `/resolve`, admin forwarding.
4. **Ratings** — rating-prompt poll job, vote handling, upsert, `/stats`.
5. **Calibration + averages** — coverage query, `state` flag, averages appended to menu posts.
6. **LLM pass** — `llm.ts`, the verification check, the fallback path, wired into the menu-post job last.
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
