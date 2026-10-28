# Dispo-Karte · Berufsfeuerwehr NRW RP

Webseite für GitHub Pages: Anmeldung mit Discord, danach eine Karte von
Liberty County (ER:LC) mit den Feuerwachen, den FMS-Status aller Fahrzeuge
und den Bereichen (Wachbezirken). Kartenkacheln und Bereichsnamen stammen
von [erlc.one](https://erlc.one).

Mit der **Dispo-API** (Cloudflare Worker, siehe unten) kommt dazu:

| Wer | Darf |
|---|---|
| Mitglied des Fraktionsservers | Karte sehen, Fahrzeugstatus ändern (Status, Einsatztext, Position) |
| Wachleiter | sich in den Dienst melden |
| Wachleiter **im Dienst** | Fahrzeuge eintragen, bearbeiten, löschen |
| Höherer Dienst | Fahrzeuge eintragen, bearbeiten, löschen (immer) |

Wachleiter im Dienst und der Höhere Dienst teilen außerdem jedem Fahrzeug
einen **Fahrzeugführer (FzF)** und die **Besatzung** mit Funktion zu
(Verwaltung → *Besatzung*). Vorgeschlagen werden die Mitglieder des
Discord-Servers, als FzF alle mit der Rolle *Fahrzeugführer*. Wer neu
eingeteilt wird, wird automatisch von seinem bisherigen Fahrzeug
ausgetragen. Die Besatzung sehen alle in der Fahrzeugliste, auf der Karte
und im Status-Fenster.

Die Rollen liest der Discord-Bot auf dem Server aus – sie lassen sich im
Browser nicht fälschen. Eine Dienstmeldung läuft nach 12 Stunden ab.

## Einrichtung

### 1. Discord-Anwendung

1. https://discord.com/developers/applications → **New Application**
2. **OAuth2 → Redirects** → die Adresse der Seite eintragen, genau so wie sie
   im Browser steht, z. B. `https://nikesieg4.github.io/DispoSystem/`
3. Die **Client ID** (OAuth2 → General) in `js/config.js` bei
   `discordClientId` eintragen. Das *Client Secret* wird **nicht** gebraucht
   und gehört nie in dieses Repo.

### 2. GitHub Pages

Repo → **Settings → Pages** → *Source: Deploy from a branch* → Branch `main`,
Ordner `/ (root)` → Save. Nach ca. einer Minute ist die Seite unter
`https://nikesieg4.github.io/DispoSystem/` erreichbar.

### 3. Zugang einschränken (`js/config.js`)

- `guildId` – nur Mitglieder dieses Discord-Servers kommen rein
  (voreingestellt: Berufsfeuerwehr NRW RP).
- `requiredRoleIds` – optional zusätzlich nur bestimmte Rollen,
  z. B. `["123456789012345678"]` (Rollen-ID per Rechtsklick → „ID kopieren“
  im Entwicklermodus).

> Hinweis: GitHub Pages ist statisch. Der Login entscheidet, wer die Karte
> **angezeigt** bekommt – die JSON-Dateien im Repo sind trotzdem öffentlich
> abrufbar, solange das Repo öffentlich ist. Keine geheimen Daten eintragen.

### 4. Dispo-API einrichten (Status ändern & Verwaltung)

Kostenlos über Cloudflare, alles im Browser:

1. **Bot vorbereiten:** Discord-Anwendung → **Bot** → *Reset Token* → Token
   kopieren. Den Bot mit diesem Link auf den Server einladen (keine extra
   Rechte nötig, er liest nur Rollen):
   `https://discord.com/oauth2/authorize?client_id=1564641901481566248&scope=bot&permissions=0`
   Für die Namensvorschläge bei der Besatzung unter **Bot → Privileged
   Gateway Intents** den **Server Members Intent** einschalten. Ohne ihn
   können Namen nur frei eingetippt werden.
2. **Konto:** https://dash.cloudflare.com → kostenlos registrieren.
3. **Datenbank:** *Storage & Databases → D1 → Create* → Name `dispo`.
   Die Tabellen legt der Worker beim ersten Aufruf selbst an.
4. **Worker:** *Compute (Workers) → Create → Start with Hello World* →
   Name `dispo-api` → *Deploy* → *Edit code* → den kompletten Inhalt von
   `worker/worker.js` hineinkopieren → *Deploy*.
5. **Datenbank verbinden:** Worker → *Bindings → Add binding → D1 database*
   → Variablenname `DB`, Datenbank `dispo`.
6. **Einstellungen:** Worker → *Settings → Variables and Secrets*:

   | Name | Typ | Wert |
   |---|---|---|
   | `BOT_TOKEN` | **Secret** | Bot-Token aus Schritt 1 |
   | `GUILD_ID` | Text | `1506205676136038491` |
   | `ALLOWED_ORIGIN` | Text | `https://nikesieg4.github.io` |
   | `ROLLEN_HOEHERER_DIENST` | Text (optional) | Standard: `Brandreferendar,Brandrat,Brandoberrat,Branddirektor,Abteilungsleiter Einsatzbetrieb,Stv. Kreisbranddirektor,Kreisbranddirektor` |
   | `ROLLEN_WACHLEITER` | Text (optional) | Standard: `Wachleiter` |
   | `ROLLEN_FZF` | Text (optional) | Standard: `Fahrzeugführer` |

   Rollen können per Name (Abkürzungen wie `BD » [Branddirektor]` oder `[BD] Branddirektor` werden ignoriert) oder per
   Rollen-ID angegeben werden, mehrere mit Komma getrennt.
7. Die Worker-Adresse (z. B. `https://dispo-api.DEINNAME.workers.dev`) in
   `js/config.js` bei `apiUrl` eintragen und committen.

Danach erscheint für Wachleiter und den Höheren Dienst der Tab
**Verwaltung**. Beim ersten Mal können dort die Beispielfahrzeuge aus
`data/fahrzeuge.json` übernommen werden.

### 5. Bot dauerhaft online (Raspberry Pi)

Der Worker braucht den Bot nur zum Lesen der Rollen – dafür muss er nicht
online sein. Damit er trotzdem als **online** mit dem Status *„Schaut auf die
Dispo-Karte“* erscheint, läuft `bot/bot.py` dauerhaft, z. B. auf einem
Raspberry Pi:

```bash
git clone https://github.com/nikesieg4/DispoSystem.git
cd DispoSystem/bot
bash install.sh        # fragt einmal nach dem Bot-Token
```

Der Bot startet danach automatisch beim Hochfahren und nach Abstürzen neu.
Logs: `journalctl -u dispo-bot -f` · Neustart: `sudo systemctl restart dispo-bot`
· Update: `git pull && sudo systemctl restart dispo-bot`

## Daten pflegen

Mit API werden Fahrzeuge im Tab **Verwaltung** eingetragen und Status per
Klick auf ein Fahrzeug geändert. Ohne API gilt das Folgende:

Alles liegt als JSON im Ordner `data/` und kann direkt auf GitHub bearbeitet
werden (Datei öffnen → Stift-Symbol → Commit). Die Seite lädt die Fahrzeuge
alle 15 Sekunden neu.

### `data/fahrzeuge.json`

```json
{
  "stand": "2026-10-28T16:00:00+01:00",
  "fahrzeuge": [
    {"id": "1-46-1", "rufname": "Florian NRW 1/46-1", "typ": "HLF 20", "wache": "FW1", "status": 2},
    {"id": "1-83-1", "rufname": "Florian NRW 1/83-1", "typ": "RTW", "wache": "FW1", "status": 4,
     "position": [-178.0, 88.5], "einsatz": "VU mit eingeklemmter Person"}
  ]
}
```

| Feld | Bedeutung |
|---|---|
| `id` | eindeutige Kennung, frei wählbar |
| `rufname`, `typ` | Anzeige in Liste und Karte |
| `wache` | `FW1`, `FW2` oder `FW3` (siehe `data/wachen.json`) |
| `status` | FMS-Status 1–8 |
| `position` | optional – ohne Position steht das Fahrzeug auf seiner Wache |
| `einsatz` | optional – kurzer Einsatztext |

**FMS-Status:** 1 Einsatzbereit über Funk · 2 Einsatzbereit auf Wache ·
3 Einsatz übernommen · 4 Am Einsatzort · 5 Sprechwunsch ·
6 Nicht einsatzbereit · 7 Patient aufgenommen · 8 Am Transportziel

**Koordinaten finden:** Auf der Karte oben rechts **Koordinaten** anklicken,
dann auf die gewünschte Stelle klicken und den Wert kopieren.

### `data/wachen.json` und `data/bereiche.json`

Wachen (mit Farbe) und Bereiche. Jeder Bereich gehört über `wache` zu einem
Wachbezirk – die Zuordnung ist nach der nächstgelegenen Wache vorbelegt und
kann frei geändert werden.

## Lokal testen

```bash
python3 -m http.server 8000
```

Dann `http://localhost:8000/` öffnen und `http://localhost:8000/` zusätzlich
als Redirect in der Discord-Anwendung eintragen.

## Aufbau

```
index.html        Seite (Login + Karte)
css/style.css     Aussehen
js/config.js      Einstellungen (Client ID, Server, Rollen, FMS-Farben)
js/auth.js        Discord-Login (OAuth2 Implicit Grant) + Aufrufe der API
js/app.js         Karte, Fahrzeuge, Bereiche, Status-Dialog, Verwaltung
data/*.json       Wachen, Bereiche, (ohne API:) Fahrzeuge
worker/worker.js  Dispo-API für Cloudflare Workers (Rollenprüfung per Bot, D1)
worker/wrangler.toml  nur für Einrichtung per Kommandozeile
bot/bot.py        hält den Bot dauerhaft online
bot/install.sh    richtet den Bot als Dienst auf dem Raspberry Pi ein
```

Karte: Leaflet 1.9.4 · Kartenkacheln und Bereichsnamen: erlc.one
