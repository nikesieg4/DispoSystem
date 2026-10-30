// Einstellungen der Dispo-Karte. Nach dem Anpassen einfach committen.
window.DISPO_CONFIG = {
  // Discord-Anwendung: https://discord.com/developers/applications → OAuth2
  // Die "Client ID" ist öffentlich und darf hier stehen (das Client Secret NIE!).
  discordClientId: "1564641901481566248",

  // Nur Mitglieder dieses Servers dürfen rein (Berufsfeuerwehr NRW RP).
  // Leer lassen ("") = jeder mit Discord-Account.
  guildId: "1506205676136038491",

  // Adresse der Dispo-API (Cloudflare Worker, siehe README). Leer = nur
  // Anzeige aus data/fahrzeuge.json, ohne Status ändern und Verwaltung.
  // Mit API prüft der Bot im Worker Mitgliedschaft und Rollen.
  apiUrl: "https://dispo-api.nikesieg0.workers.dev",

  // Nur ohne API: zusätzlich nur Mitglieder mit einer dieser Rollen-IDs.
  // Beispiel: ["123456789012345678"]. Leer = Servermitgliedschaft reicht.
  requiredRoleIds: [],

  // Wie oft die Fahrzeugstatus neu geladen werden (Sekunden).
  refreshSeconds: 15,

  // ER:LC-Livedaten (Spieler, Notrufe): Abfrage-Intervall in Sekunden.
  // Der Worker fragt die ER:LC-API trotzdem höchstens alle 5 s ab.
  liveSeconds: 5,

  // Umrechnung ER:LC-Koordinaten → Karte. null = automatisch kalibrieren
  // (über die Postleitzahlen der Spieler). Nur bei Bedarf fest eintragen,
  // z. B. { s: 1.0, cx: 2677.5, cz: 2677.5 }.
  prcKalibrierung: null,

  // Kartenkacheln von erlc.one (ER:LC Liberty County)
  tileUrl: "https://erlc-maps.pages.dev/map/{z}/{x}/{y}.png",
};

// FMS-Status (Funkmeldesystem)
window.FMS_STATUS = {
  0: { text: "Dringender Sprechwunsch", kurz: "Dringend", farbe: "#E5489C" },
  1: { text: "Einsatzbereit über Funk", kurz: "Frei Funk", farbe: "#3E9BF0" },
  2: { text: "Einsatzbereit auf Wache", kurz: "Wache", farbe: "#30A46C" },
  3: { text: "Einsatzauftrag übernommen", kurz: "Auftrag", farbe: "#F5A524" },
  4: { text: "Am Einsatzziel eingetroffen", kurz: "Einsatzziel", farbe: "#E5484D" },
  5: { text: "Sprechwunsch", kurz: "Sprechw.", farbe: "#B77CF2" },
  6: { text: "Befristete Außerdienststellung", kurz: "Außer Dienst", farbe: "#7C838D" },
  7: { text: "Mit einem Patienten auf dem Weg ins Krankenhaus", kurz: "Transport", farbe: "#12A594" },
  8: { text: "Mit einem Patienten im Krankenhaus eingetroffen", kurz: "Im KH", farbe: "#6E79D6" },
  9: { text: "Anmeldung bei Fremdleitstelle", kurz: "Fremd‑LS", farbe: "#C9A27E" },
};
