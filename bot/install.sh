#!/usr/bin/env bash
# Richtet den Bot auf einem Raspberry Pi (oder anderem Linux) als Dienst ein:
# startet automatisch beim Hochfahren und nach Abstürzen neu.
#
#   cd DispoSystem/bot
#   bash install.sh
set -euo pipefail
cd "$(dirname "$0")"
ORDNER="$(pwd)"
NUTZER="$(id -un)"

echo "== Pakete prüfen"
if ! python3 -m venv --help >/dev/null 2>&1; then
  sudo apt-get update && sudo apt-get install -y python3-venv
fi

echo "== Python-Umgebung einrichten"
python3 -m venv venv
venv/bin/pip install --quiet --upgrade pip
venv/bin/pip install --quiet -r requirements.txt

if [ ! -s .env ]; then
  echo "== Bot-Token eingeben (wird nicht angezeigt):"
  read -rs TOKEN
  echo
  printf 'DISCORD_TOKEN=%s\n' "$TOKEN" > .env
fi
chmod 600 .env

echo "== Dienst einrichten"
sudo tee /etc/systemd/system/dispo-bot.service >/dev/null <<UNIT
[Unit]
Description=Discord-Bot Zentraler Service IT
After=network-online.target
Wants=network-online.target

[Service]
User=$NUTZER
WorkingDirectory=$ORDNER
ExecStart=$ORDNER/venv/bin/python bot.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now dispo-bot
sleep 5
sudo systemctl --no-pager status dispo-bot | head -n 12
echo
echo "Fertig. Logs ansehen:  journalctl -u dispo-bot -f"
