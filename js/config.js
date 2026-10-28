// Einstellungen der Dispo-Karte. Nach dem Anpassen einfach committen.
window.DISPO_CONFIG = {
  // Discord-Anwendung: https://discord.com/developers/applications → OAuth2
  // Die "Client ID" ist öffentlich und darf hier stehen (das Client Secret NIE!).
  discordClientId: "DEINE_CLIENT_ID",

  // Nur Mitglieder dieses Servers dürfen rein (Berufsfeuerwehr NRW RP).
  // Leer lassen ("") = jeder mit Discord-Account.
  guildId: "1506205676136038491",

  // Optional: nur Mitglieder mit mindestens einer dieser Rollen-IDs.
  // Beispiel: ["123456789012345678"]. Leer = Servermitgliedschaft reicht.
  requiredRoleIds: [],

  // Wie oft die Fahrzeugstatus neu geladen werden (Sekunden).
  refreshSeconds: 30,

  // Kartenkacheln von erlc.one (ER:LC Liberty County)
  tileUrl: "https://erlc-maps.pages.dev/map/{z}/{x}/{y}.png",
};

// FMS-Status (Funkmeldesystem)
window.FMS_STATUS = {
  1: { text: "Einsatzbereit über Funk", farbe: "#3E9BF0" },
  2: { text: "Einsatzbereit auf Wache", farbe: "#30A46C" },
  3: { text: "Einsatz übernommen", farbe: "#F5A524" },
  4: { text: "Am Einsatzort", farbe: "#E5484D" },
  5: { text: "Sprechwunsch", farbe: "#B77CF2" },
  6: { text: "Nicht einsatzbereit", farbe: "#7C838D" },
  7: { text: "Patient aufgenommen", farbe: "#12A594" },
  8: { text: "Am Transportziel", farbe: "#6E79D6" },
};
