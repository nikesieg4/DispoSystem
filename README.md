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

**Aktivität** (Verwaltung → *Aktivität ansehen*, für Wachleiter und den
Höheren Dienst): Rangliste für 7 Tage, 30 Tage oder gesamt mit der Zeit auf
Fahrzeugen (davon als FzF), Anzahl Zuteilungen, aktuellem Fahrzeug, wer
zuletzt zugeteilt hat, Dienstzeit als Wachleiter, Statusmeldungen und
Verwaltungsaktionen, dazu die letzten Aktionen im Protokoll. Beides als CSV
für Excel: die Rangliste und alle einzelnen Zuteilungen mit *zugeteilt von*
und *ausgetragen von*. Zuteilungen laufen, bis jemand ausgetragen wird.

**Einsätze** (Tab *Einsätze*): Der **Leitstellen-Disponent** legt Einsätze
mit Stichwort, Ort, Position und Bemerkung an und alarmiert Fahrzeuge. Die
Fahrzeuge setzen ihren Status selbst – mit Status 3 oder 4 gilt die
Alarmierung als quittiert, bis dahin steht beim Fahrzeug *wartet*. Der
Disponent kann nachalarmieren, Alarme zurücknehmen und Einsätze abschließen.
Dafür meldet er sich im Tab *Einsätze* in den **Leitstellendienst** (endet wie
der Wachleiter-Dienst spätestens nach 12 Stunden). Alle sehen dort, ob die
Leitstelle besetzt ist. Disponenten im Dienst bekommen bei **Status 0** ein
Popup mit Warnton, bei **Status 5** eine Meldung am Rand; die Seite
aktualisiert sich für sie alle 5 Sekunden.

**Durchsagen**: Disponenten im Dienst schicken mit **📢 Durchsage** eine
Nachricht an alle Fahrzeuge oder nur an eine Wache. Wer gerade als FzF oder
Besatzung auf einem passenden Fahrzeug eingeteilt ist, bekommt sie als Popup
mit Gong (bis 30 Minuten nach dem Senden) und bestätigt mit *Verstanden*. Unter
*Einsätze → Durchsagen* sehen Leitstelle, Wachleiter und Höherer Dienst die
Durchsagen der letzten 2 Stunden und wer sie gelesen hat.

**Mein Fahrzeug**: Wer als FzF oder Besatzung eingeteilt ist, sieht oben sein
Fahrzeug mit großen Status-Buttons 0–9 und dem aktuellen Alarm („Einsatzdaten
übernehmen“ füllt Einsatztext und Position vor). Auf dem Handy ganz oben.

**ER:LC live** (optional, mit `PRC_SERVER_KEY`): Alle Spieler im Team *Fire*
erscheinen live auf der Karte, Feuerwehr-Notrufe aus dem Spiel ebenfalls –
der Disponent macht daraus mit einem Klick einen Einsatz. Die Umrechnung der
Spielkoordinaten auf die Karte kalibriert sich automatisch über die
Postleitzahlen der Spieler (Daten von erlc.one); bis genug Daten da sind,
steht oben „Karte wird kalibriert“. Der Worker fragt die ER:LC-API höchstens
alle 5 Sekunden ab und hält sich an deren Rate-Limits.

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
   | `ROLLEN_DISPONENT` | Text (optional) | Standard: `Leitstellen Disponent` |
   | `PRC_SERVER_KEY` | **Secret** (optional) | Server-Key der ER:LC-API für Live-Spieler und Notrufe |

   Rollen können per Name (Abkürzungen wie `BD » [Branddirektor]` oder `[BD] Branddirektor` werden ignoriert) oder per
   Rollen-ID angegeben werden, mehrere mit Komma getrennt.
7. Die Worker-Adresse (z. B. `https://dispo-api.DEINNAME.workers.dev`) in
   `js/config.js` bei `apiUrl` eintragen und committen.

Danach erscheint für Wachleiter und den Höheren Dienst der Tab
**Verwaltung**. Beim ersten Mal können dort die Beispielfahrzeuge aus
`data/fahrzeuge.json` übernommen werden.

### Worker automatisch aktualisieren (GitHub Action)

`.github/workflows/worker-deploy.yml` deployt den Worker bei jedem Push, der
`worker/` ändert – Code bei Cloudflare einfügen ist dann nicht mehr nötig.
Einmalig im Repo unter **Settings → Secrets and variables → Actions → New
repository secret** anlegen:

| Secret | Woher |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare → *My Profile → API Tokens → Create Token* → Vorlage **Edit Cloudflare Workers** |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → *Workers & Pages* → rechts *Account ID* |
| `D1_DATABASE_ID` | Cloudflare → *Storage & Databases → D1 → dispo* → *Database ID* |

Variablen und Secrets des Workers (`BOT_TOKEN`, `PRC_SERVER_KEY`, …) bleiben
im Cloudflare-Dashboard und werden beim Deploy nicht verändert. Manuell
starten: *Actions → Worker deployen → Run workflow*.

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
| `status` | FMS-Status 0–9 |
| `position` | optional – ohne Position steht das Fahrzeug auf seiner Wache |
| `einsatz` | optional – kurzer Einsatztext |

**FMS-Status:** 0 Dringender Sprechwunsch · 1 Einsatzbereit über Funk ·
2 Einsatzbereit auf Wache · 3 Einsatzauftrag übernommen · 4 Am Einsatzziel
eingetroffen · 5 Sprechwunsch · 6 Befristete Außerdienststellung · 7 Mit einem
Patienten auf dem Weg ins Krankenhaus · 8 Mit einem Patienten im Krankenhaus
eingetroffen · 9 Anmeldung bei Fremdleitstelle

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
data/*.json       Wachen, Bereiche, Postleitzahlen (Kalibrierung), (ohne API:) Fahrzeuge
worker/worker.js  Dispo-API für Cloudflare Workers (Rollenprüfung per Bot, D1)
worker/wrangler.toml  Konfiguration für das automatische Deployment
.github/workflows/worker-deploy.yml  deployt den Worker bei jedem Push
bot/bot.py        hält den Bot dauerhaft online
bot/install.sh    richtet den Bot als Dienst auf dem Raspberry Pi ein
```

Karte: Leaflet 1.9.4 · Kartenkacheln und Bereichsnamen: erlc.one
