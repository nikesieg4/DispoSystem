"""
Hält den Bot "Zentraler Service IT" dauerhaft online.

Der Bot zeigt als Status "Schaut auf die Dispo-Karte" an. Damit er online
bleibt, muss dieses Programm durchgehend laufen.

Raspberry Pi / Linux als Dauerdienst einrichten:
  bash install.sh

Von Hand starten:
  pip install -r requirements.txt
  DISCORD_TOKEN=dein_token python bot.py

Der Token kann auch in einer Datei ".env" neben bot.py stehen:
  DISCORD_TOKEN=dein_token
"""
import os
import pathlib
import discord

STATUS_TEXT = "auf die Dispo-Karte"


def token_laden():
    token = os.environ.get("DISCORD_TOKEN")
    env = pathlib.Path(__file__).with_name(".env")
    if not token and env.exists():
        for zeile in env.read_text(encoding="utf-8").splitlines():
            if zeile.startswith("DISCORD_TOKEN="):
                token = zeile.split("=", 1)[1].strip().strip('"')
    if not token:
        raise SystemExit("Kein Token gefunden – DISCORD_TOKEN setzen oder .env anlegen.")
    return token


class DispoBot(discord.Client):
    async def on_ready(self):
        print(f"Online als {self.user} auf {len(self.guilds)} Server(n).")


bot = DispoBot(
    intents=discord.Intents.none(),
    status=discord.Status.online,
    activity=discord.Activity(type=discord.ActivityType.watching, name=STATUS_TEXT),
)
# discord.py verbindet sich nach Abbrüchen automatisch neu.
bot.run(token_laden())
