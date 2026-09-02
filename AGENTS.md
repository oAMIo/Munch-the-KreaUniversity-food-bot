# AGENTS.md

Conventions for any AI coding agent working in this repository.

## Read this first

**`SPEC.md` is the authoritative specification for this project.** Read it in full before writing any code. It defines the architecture, the data model, the file layout, the message formats, and the build order. It is not a suggestion or a starting point — it is the design.

If you find yourself about to make an architectural decision, that is a signal that you have missed something in `SPEC.md`. Go re-read the relevant section. If it genuinely is not covered there and it is not on the permitted-decisions list in `SPEC.md` §13, **stop and ask the repo owner**. Do not guess, do not pick a "sensible default", and do not leave a `TODO` and carry on.

## What this project is

A WhatsApp bot (via Baileys, from a dedicated WhatsApp number) for a university group chat. It posts the day's mess menu before each of four daily meals, collects 1–5 ratings after each meal via a native WhatsApp poll, accepts menu-correction reports via DM, and starts showing historical averages once every slot in the two-week menu cycle has been rated at least once. It runs as a systemd service on a Linux VPS.

It was originally a Telegram/Python bot; that implementation is preserved, unmaintained, under `legacy/`, kept for reference only. It was ported to WhatsApp/Node+TypeScript because Baileys (the WhatsApp library used here) has no Python binding.

## Hard rules

1. **Do not change the stack.** Node.js 20+ LTS, TypeScript, `@whiskeysockets/baileys`, `node-cron`, `better-sqlite3`, `js-yaml`, `dotenv`, the `openai` npm SDK pointed at DeepSeek's OpenAI-compatible endpoint (`baseURL: "https://api.deepseek.com"`). No ORM. No second scheduler. No Docker. No web framework. No bundler.
2. **Do not change the file layout.** The module list in `SPEC.md` §3 is exhaustive. No subdirectories under `src/`, no new packages, no splitting a module "for clarity". Do not touch `legacy/` except to delete it wholesale if the repo owner asks.
3. **Do not add features.** If it is not in `SPEC.md`, it does not get built. This includes dashboards, analytics pages, per-dish breakdowns, user profiles, streaks, leaderboards, and webhook support.
4. **All SQL lives in `db.ts`.** Nowhere else. Parameterised queries only — never string interpolation into SQL.
5. **No magic values.** Every time, meal name, model name, scale bound, and path comes from `config.yaml` or the environment. If you are typing a number or a time into a `.ts` file, you are doing it wrong.
6. **The LLM only rephrases.** It is used in exactly one place (`llm.ts`, called from the menu-post job) and only to restyle an already-complete message. It never sources menu data, never touches the database, never handles ratings or reports. Every LLM call must have a deterministic fallback and a post-call check that no dish name was dropped or invented.
7. **Never commit secrets.** `.env` is gitignored. Only `.env.example` is committed, with empty values. Never log the WhatsApp session (`AUTH_DIR`) or the API key. `AUTH_DIR` itself is also gitignored — it's equivalent to a login session for the bot's WhatsApp number.
8. **Timezone-aware always.** Every date and time operation uses the `Intl`-based helpers in `time.ts` with `config.timezone`. A naive `new Date()` used for "what is today"/"what time is it" is a bug.

## Code conventions

- Async throughout for I/O (WhatsApp sends, DB reads are synchronous via `better-sqlite3` by design — don't wrap them in promises for no reason).
- Type hints (explicit types) on all exported function signatures; `strict` mode in `tsconfig.json` stays on.
- The structured `logger` (`logger.ts`, pino) to stdout at INFO. No `console.log`.
- Keep functions small and single-purpose. One concept, one function — `resolveWeekType` is implemented once and called everywhere; never reimplemented inline.
- Fail fast and loudly at startup (bad config, bad menu). Fail soft and logged at runtime (a WhatsApp hiccup or LLM outage must never kill the process).
- Every scheduled job catches its own exceptions.

## The menu file

`menu.yaml` is **hand-authored by a human**, roughly every two months. Its structure is fixed and defined in `SPEC.md` §4.1: two week types, seven days each, four meals each, and each meal is a **flat list of dish-name strings**. There is no sub-grouping within a meal — no counters, stations, or categories.

The loader validates this structure strictly and reports the exact offending key on failure. It never fills in defaults, never coerces `null` to `[]`, and never accepts a partial file. On `/reloadmenu`, if the new file fails validation, the previously loaded menu stays live.

## Working method

- Follow the build order in `SPEC.md` §12. The repo must run at the end of every phase.
- Commit per phase, with a message naming the phase.
- Test against a **separate WhatsApp number** in a private test group. Never point a work-in-progress build at the live group chat.
- When you finish a phase, state which spec sections you implemented and anything you had to leave open.

## When you are unsure

Ask. A short question to the repo owner costs a minute. An invented architecture costs a rewrite.
