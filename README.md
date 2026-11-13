# Munch — Krea University mess menu bot

A WhatsApp bot (via Baileys) for a university group chat that:

- Posts the day's mess menu before each of the four daily meal windows (breakfast, lunch, snack, dinner).
- Posts a rating prompt after each meal window closes, collecting 1–5 ratings via a native WhatsApp poll.
- Accepts DM reports when a posted menu was wrong, and forwards them to the admin.
- Once every slot in the two-week menu cycle has been rated at least once, starts showing historical average ratings in the daily menu posts.
- Optionally rephrases menu posts in a configurable persona via the DeepSeek API — always falling back to a plain deterministic message if that call fails or would alter a dish name.

See `SPEC.md` for the full build specification and `AGENTS.md` for repository conventions. The original Telegram/Python implementation is preserved, unmaintained, under `legacy/`.

## Running on the server (Plato)

The bot runs as `plato.service` (user `apps`): code in `/srv/plato`, settings in `/etc/plato/env`, database and WhatsApp session in `/var/lib/plato`. Ship code changes from this repo with `sudo bash deploy/deploy.sh`. It runs on the owner's personal WhatsApp number, so incoming messages are ignored (no DM reports or commands; `MUNCH_HANDLE_MESSAGES=on` would bring them back on a dedicated number).

### Changing the menu

```bash
plato-menu ~/Downloads/new-menu.pdf "20 Nov"   # read, check, show, confirm, schedule
plato-menu list                                # which menu is live, which are scheduled
plato-menu show                                # print the live menu
plato-menu remove "20 Nov"                     # drop a menu that hasn't gone live
```

Menus live in `/srv/plato/menus/<go-live date>.yaml`; the bot switches on that date with no restart. The week containing the go-live date is Week 1 of the new two-week cycle. Ratings and averages restart with each new menu.

## Running locally

Requires Node.js 20+.

```bash
git clone <repo> menubot && cd menubot
npm install
cp .env.example .env && $EDITOR .env       # fill in WHATSAPP_ADMIN_JID at least — see below
npm run dev                                 # tsx src/bot.ts, no build step
```

Build locally against a **separate WhatsApp number** in a private test group. Never develop against the live group.

`WHATSAPP_GROUP_JID` can't be known before the bot has connected once, so the first run only needs `WHATSAPP_ADMIN_JID` set — see the bootstrap order below.

### First run: linking the WhatsApp session

On first run (no `auth/` folder yet), the bot prints a QR code to the terminal. From the **dedicated bot number's** phone:

1. Open WhatsApp → Settings → Linked Devices → Link a Device.
2. Scan the QR code printed in the terminal.

The session is then cached under `auth/` (gitignored — treat it like a credential, it's equivalent to a login session for that number) and persists across restarts. You only need to re-scan if the session is explicitly logged out or invalidated.

### Getting `WHATSAPP_GROUP_JID`

With `WHATSAPP_GROUP_JID` still empty, the bot runs fine and responds to DMs, but logs a warning and skips every menu-post/rating-prompt job (there's nowhere configured to post to yet). To fill it in:

1. Leave the bot running (QR already scanned).
2. Add the bot number to the target group (private test group first, then later the live one).
3. Send any message in that group.
4. Watch the logs (stdout, or `journalctl -u menubot -f` in production) for a line like `"msg":"Incoming message.","chatJid":"1234567890-1234567890@g.us","isGroup":true` — that `chatJid` is your `WHATSAPP_GROUP_JID`.
5. Set it in `.env` and restart the bot.

### Getting `WHATSAPP_ADMIN_JID`

The repo owner's own WhatsApp number, in E.164 digits (no `+`, no spaces), suffixed with `@s.whatsapp.net` — e.g. `919876543210@s.whatsapp.net`. Required from the first run (admin commands and report forwarding depend on it).

### `.env` values

| Variable | Meaning |
|---|---|
| `WHATSAPP_GROUP_JID` | JID of the group the bot posts to (see above). |
| `WHATSAPP_ADMIN_JID` | JID of the repo owner, used for admin commands and report forwarding. |
| `DEEPSEEK_API_KEY` | DeepSeek API key. Required only if `llm.enabled: true` in `config.yaml`. |
| `DB_PATH` | Path to the SQLite database file (default `menubot.db`). |
| `MENU_PATH` | Path to `menu.yaml`. |
| `CONFIG_PATH` | Path to `config.yaml`. |
| `AUTH_DIR` | Folder for the cached WhatsApp session (default `auth`). |

Non-secret behaviour (meal times, timezone, LLM persona/model, rating scale) lives in `config.yaml`. The menu itself lives in `menu.yaml` — see `SPEC.md` §4.1 for its exact required structure. Both are unchanged from the original Telegram version.

## Deploying (systemd on a Linux VPS)

```bash
git clone <repo> /opt/menubot && cd /opt/menubot
npm install
npm run build                                # compiles src/ -> dist/
cp .env.example .env && $EDITOR .env         # fill in real values
sudo cp deploy/menubot.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now menubot
journalctl -u menubot -f                     # verify — scan the printed QR code on first run
```

**Update loop:** `git pull && npm install && npm run build && sudo systemctl restart menubot`

**Menu-only update:** edit `menu.yaml`, then DM the bot `/reloadmenu` — no restart needed. If the new file fails validation, the previously loaded menu stays active and the bot replies with the exact error.

## Commands

Sent as plain WhatsApp text messages (WhatsApp has no native slash-command UI).

| Command | Where | Who | Behaviour |
|---|---|---|---|
| `/start` | DM | anyone | Explains the bot and how to report a wrong menu. |
| `/menu` | group or DM | anyone | Posts today's remaining meals (or all four, if before breakfast). |
| `/reloadmenu` | DM | admin | Re-reads `menu.yaml` from disk. |
| `/reports` | DM | admin | Lists the 20 most recent unresolved reports. |
| `/resolve <id>` | DM | admin | Marks a report resolved. |
| `/stats` | DM | admin | Calibration progress and the five highest/lowest-rated slots. |
