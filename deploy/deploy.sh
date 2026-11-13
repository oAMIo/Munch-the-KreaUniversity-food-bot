#!/usr/bin/env bash
# Deploy Plato from this repo to the host service. Run: sudo bash deploy/deploy.sh
# First run also migrates the old "munch" install (service, /srv, /etc, /var/lib).
# Safe to re-run: later runs just ship code changes and restart.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

# --- one-time migration munch -> plato -------------------------------------
if [ -e /etc/systemd/system/munch.service ]; then
  echo "Migrating munch -> plato"
  systemctl disable --now munch 2>/dev/null || true
  rm -f /etc/systemd/system/munch.service
  [ -d /var/lib/munch ] && [ ! -e /var/lib/plato ] && mv /var/lib/munch /var/lib/plato
  [ -d /etc/munch ] && [ ! -e /etc/plato ] && mv /etc/munch /etc/plato
  rm -rf /srv/munch
fi

# --- settings ---------------------------------------------------------------
install -d -o root -g apps -m 750 /etc/plato
touch /etc/plato/env
setenv() { # key value: set or add a line in /etc/plato/env
  if grep -q "^$1=" /etc/plato/env; then sed -i "s|^$1=.*|$1=$2|" /etc/plato/env; else echo "$1=$2" >> /etc/plato/env; fi
}
setenv DB_PATH /var/lib/plato/menubot.db
setenv AUTH_DIR /var/lib/plato/auth
setenv MENU_PATH /srv/plato/menu.yaml
setenv CONFIG_PATH /srv/plato/config.yaml
setenv MENUS_DIR /srv/plato/menus
setenv WHATSAPP_PAIRING_NUMBER 918148922385
chown root:apps /etc/plato/env; chmod 640 /etc/plato/env
# plato-menu runs as romulus and needs the DeepSeek key + MENUS_DIR
setfacl -m u:romulus:rx /etc/plato
setfacl -m u:romulus:r /etc/plato/env

# --- code -------------------------------------------------------------------
install -d -o apps -g apps -m 755 /srv/plato
rsync -a --delete \
  --exclude .env --exclude '*.db' --exclude auth/ --exclude menus/ --exclude .git/ --exclude .claude/ \
  "$REPO/" /srv/plato/
chown -R apps:apps /srv/plato
# Menus: written by romulus (plato-menu), read by the service (group apps).
if [ ! -d /srv/plato/menus ]; then
  install -d -o romulus -g apps -m 2750 /srv/plato/menus
  install -o romulus -g apps -m 640 "$REPO/menu.yaml" /srv/plato/menus/2026-01-05.yaml
fi
chown romulus:apps /srv/plato/menus

# --- state ------------------------------------------------------------------
install -d -o apps -g apps -m 700 /var/lib/plato
# A half-finished phone link leaves unusable creds: start linking fresh.
if [ -f /var/lib/plato/auth/creds.json ] && ! grep -q '"registered":true' /var/lib/plato/auth/creds.json; then
  rm -rf /var/lib/plato/auth
fi

# --- command + service --------------------------------------------------------
cat > /usr/local/bin/plato-menu <<'SH'
#!/bin/sh
exec /usr/bin/node /srv/plato/dist/cli/menu.js "$@"
SH
chmod 755 /usr/local/bin/plato-menu
install -o root -g root -m 755 "$REPO/deploy/plato-post" /usr/local/bin/plato-post
install -o root -g root -m 644 "$REPO/deploy/plato.service" /etc/systemd/system/plato.service
systemctl daemon-reload
systemctl enable plato >/dev/null 2>&1
systemctl restart plato
sleep 8
systemctl --no-pager --lines=0 status plato | head -3
journalctl -u plato -o cat -n 30 --no-pager | grep -o '"msg":"[^"]*"' | sed 's/"msg"://' | tail -6
