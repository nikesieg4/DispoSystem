# Dispo-Karte · Berufsfeuerwehr NRW RP

Webseite für GitHub Pages: Anmeldung mit Discord, danach eine Karte von
Liberty County (ER:LC) mit den Feuerwachen, den FMS-Status aller Fahrzeuge
und den Bereichen (Wachbezirken). Kartenkacheln und Bereichsnamen stammen
von [erlc.one](https://erlc.one).

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

## Daten pflegen

Alles liegt als JSON im Ordner `data/` und kann direkt auf GitHub bearbeitet
werden (Datei öffnen → Stift-Symbol → Commit). Die Seite lädt die Fahrzeuge
alle 30 Sekunden neu.

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
js/auth.js        Discord-Login (OAuth2 Implicit Grant, nur im Browser)
js/app.js         Karte, Fahrzeuge, Bereiche
data/*.json       Wachen, Bereiche, Fahrzeuge
```

Karte: Leaflet 1.9.4 · Kartenkacheln und Bereichsnamen: erlc.one
