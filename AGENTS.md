# AGENTS.md

Conventions for any AI coding agent working in this repository.

## Read this first

**`SPEC.md` is the authoritative specification for this project.** Read it in full before writing any code. It defines the architecture, the data model, the file layout, the message formats, and the build order. It is not a suggestion or a starting point — it is the design.

If you find yourself about to make an architectural decision, that is a signal that you have missed something in `SPEC.md`. Go re-read the relevant section. If it genuinely is not covered there and it is not on the permitted-decisions list in `SPEC.md` §13, **stop and ask the repo owner**. Do not guess, do not pick a "sensible default", and do not leave a `TODO` and carry on.

## What this project is

A Telegram bot for a university group chat. It posts the day's mess menu before each of four daily meals, collects 1–5 ratings after each meal, accepts menu-correction reports via DM, and starts showing historical averages once every slot in the two-week menu cycle has been rated at least once. It runs as a systemd service on a Linux VPS.

## Hard rules

1. **Do not change the stack.** Python 3.11+, `python-telegram-bot` v21+, PTB's built-in `JobQueue`, stdlib `sqlite3`, `PyYAML`, `python-dotenv`, the `openai` SDK pointed at DeepSeek's OpenAI-compatible endpoint (`base_url="https://api.deepseek.com"`). No ORM. No second scheduler. No Docker. No web framework. No async DB driver.
2. **Do not change the file layout.** The module list in `SPEC.md` §3 is exhaustive. No `src/` directory, no new packages, no splitting a module "for clarity".
3. **Do not add features.** If it is not in `SPEC.md`, it does not get built. This includes dashboards, analytics pages, per-dish breakdowns, user profiles, streaks, leaderboards, and webhook support.
4. **All SQL lives in `db.py`.** Nowhere else. Parameterised queries only — never string interpolation into SQL.
5. **No magic values.** Every time, meal name, model name, scale bound, and path comes from `config.yaml` or the environment. If you are typing a number or a time into a `.py` file, you are doing it wrong.
6. **The LLM only rephrases.** It is used in exactly one place (`llm.py`, called from the menu-post job) and only to restyle an already-complete message. It never sources menu data, never touches the database, never handles ratings or reports. Every LLM call must have a deterministic fallback and a post-call check that no dish name was dropped or invented.
7. **Never commit secrets.** `.env` is gitignored. Only `.env.example` is committed, with empty values. Never log the bot token or the API key.
8. **Timezone-aware always.** Every date and time operation uses `zoneinfo.ZoneInfo(config.timezone)`. Naive `datetime.now()` is a bug.

## Code conventions

- Async throughout — PTB v21 is async-first. Handlers and jobs are `async def`.
- Type hints on all function signatures.
- Standard library `logging` to stdout at INFO. No `print()`.
- Keep functions small and single-purpose. One concept, one function — `resolve_week_type` is implemented once and called everywhere; never reimplemented inline.
- Fail fast and loudly at startup (bad config, bad menu). Fail soft and logged at runtime (a Telegram hiccup or LLM outage must never kill the process).
- Every scheduled job catches its own exceptions.

## The menu file

`menu.yaml` is **hand-authored by a human**, roughly every two months. Its structure is fixed and defined in `SPEC.md` §4.1: two week types, seven days each, four meals each, and each meal is a **flat list of dish-name strings**. There is no sub-grouping within a meal — no counters, stations, or categories.

The loader validates this structure strictly and reports the exact offending key on failure. It never fills in defaults, never coerces `null` to `[]`, and never accepts a partial file. On `/reloadmenu`, if the new file fails validation, the previously loaded menu stays live.

## Working method

- Follow the build order in `SPEC.md` §12. The repo must run at the end of every phase.
- Commit per phase, with a message naming the phase.
- Test against a **separate test bot** in a private test group. Never point a work-in-progress build at the live group chat.
- When you finish a phase, state which spec sections you implemented and anything you had to leave open.

## When you are unsure

Ask. A short question to the repo owner costs a minute. An invented architecture costs a rewrite.
