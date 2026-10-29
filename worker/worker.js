// Dispo-API für die Berufsfeuerwehr NRW RP – Cloudflare Worker + D1.
//
// Prüft bei jeder Anfrage das Discord-Token des Nutzers, liest über den Bot
// seine Rollen auf dem Fraktionsserver und entscheidet daraus, was er darf:
//   • Mitglied            → Karte sehen, Fahrzeugstatus ändern
//   • Wachleiter im Dienst → zusätzlich Fahrzeuge verwalten
//   • Höherer Dienst       → Fahrzeuge verwalten (immer)
//   • Wachleiter & Höherer Dienst sehen die Aktivitäts-Auswertung
//
// Einstellungen (Cloudflare → Worker → Settings → Variables):
//   BOT_TOKEN        (Secret!) Token des Discord-Bots
//   GUILD_ID         ID des Fraktionsservers
//   ALLOWED_ORIGIN   z. B. https://nikesieg4.github.io
//   ROLLEN_HOEHERER_DIENST  Rollennamen oder -IDs, mit Komma getrennt
//   ROLLEN_WACHLEITER       Rollennamen oder -IDs, mit Komma getrennt
//   ROLLEN_FZF              Rollen, die als Fahrzeugführer wählbar sind
// Für die Besatzungsauswahl muss beim Bot der "Server Members Intent" an sein.
// Bindung: D1-Datenbank unter dem Namen DB.

let DISCORD = "https://discord.com/api/v10";
const DIENST_MAX_STUNDEN = 12;

const STANDARD_HOEHERER_DIENST =
  "Brandreferendar,Brandrat,Brandoberrat,Branddirektor,Abteilungsleiter EB,Abteilungsleiter Einsatzbetrieb,Stv. Kreisbranddirektor,Kreisbranddirektor";
const STANDARD_WACHLEITER = "Wachleiter";
const STANDARD_FZF = "Fahrzeugführer";
const MAX_BESATZUNG = 12;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fahrzeuge (
     id TEXT PRIMARY KEY, rufname TEXT NOT NULL, typ TEXT NOT NULL, wache TEXT NOT NULL,
     status INTEGER NOT NULL DEFAULT 2, einsatz TEXT, lat REAL, lng REAL,
     geaendert_von TEXT, geaendert_am TEXT)`,
  `CREATE TABLE IF NOT EXISTS dienst (
     user_id TEXT PRIMARY KEY, name TEXT NOT NULL, seit TEXT NOT NULL)`,
  // Aktivität: wer war wann auf welchem Fahrzeug, wer war im Dienst, wer hat was getan
  `CREATE TABLE IF NOT EXISTS zuteilungen (
     id INTEGER PRIMARY KEY AUTOINCREMENT, person TEXT NOT NULL, user_id TEXT, name TEXT NOT NULL,
     fahrzeug_id TEXT NOT NULL, rufname TEXT, rolle TEXT, von TEXT NOT NULL, bis TEXT,
     zugeteilt_von TEXT, ausgetragen_von TEXT)`,
  "CREATE INDEX IF NOT EXISTS zuteilungen_offen ON zuteilungen (fahrzeug_id, person, bis)",
  "CREATE INDEX IF NOT EXISTS zuteilungen_bis ON zuteilungen (bis)",
  `CREATE TABLE IF NOT EXISTS dienstzeiten (
     id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT NOT NULL,
     von TEXT NOT NULL, bis TEXT, beendet TEXT)`,
  `CREATE TABLE IF NOT EXISTS protokoll (
     id INTEGER PRIMARY KEY AUTOINCREMENT, zeit TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL,
     aktion TEXT NOT NULL, details TEXT)`,
  "CREATE INDEX IF NOT EXISTS protokoll_zeit ON protokoll (zeit)",
];
// Spalten, die später dazugekommen sind (für bestehende Datenbanken)
const NEUE_SPALTEN = { fzf: "TEXT", besatzung: "TEXT" };

// Kurzzeit-Caches pro Worker-Instanz, damit nicht jede Anfrage Discord fragt.
const tokenCache = new Map(); // token -> { user, bis }
const memberCache = new Map(); // userId -> { member, bis }
const rollenCache = { bis: 0, rollen: [] };
const mitgliederCache = { bis: 0, liste: null };
let schemaBereit = false;

export default {
  async fetch(request, env) {
    if (env.DISCORD_API) DISCORD = env.DISCORD_API; // nur für lokale Tests
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (!schemaBereit) {
        await env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s)));
        const { results } = await env.DB.prepare("PRAGMA table_info(fahrzeuge)").all();
        for (const [spalte, typ] of Object.entries(NEUE_SPALTEN)) {
          if (!results.some((c) => c.name === spalte)) {
            await env.DB.prepare(`ALTER TABLE fahrzeuge ADD COLUMN ${spalte} ${typ}`).run();
          }
        }
        schemaBereit = true;
      }
      const res = await route(request, env);
      Object.entries(cors).forEach(([k, v]) => res.headers.set(k, v));
      return res;
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json({ fehler: status === 500 ? "Interner Fehler" : e.message }, status, cors);
    }
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const pfad = url.pathname.replace(/\/+$/, "");
  const methode = request.method;

  const ich = await anmelden(request, env);

  if (pfad === "/api/ich" && methode === "GET") return json(ich);

  if (pfad === "/api/fahrzeuge" && methode === "GET") {
    const { results } = await env.DB.prepare("SELECT * FROM fahrzeuge ORDER BY wache, rufname").all();
    return json({ stand: new Date().toISOString(), fahrzeuge: results.map(ausDb) });
  }

  let m = pfad.match(/^\/api\/fahrzeuge\/([A-Za-z0-9_-]{1,40})\/status$/);
  if (m && methode === "POST") {
    const body = await request.json();
    const status = Number(body.status);
    if (!Number.isInteger(status) || status < 1 || status > 8) throw fehler(400, "Status muss 1–8 sein.");
    const pos = position(body.position);
    const f = await env.DB.prepare("SELECT rufname FROM fahrzeuge WHERE id = ?").bind(m[1]).first();
    if (!f) throw fehler(404, "Fahrzeug nicht gefunden.");
    const einsatz = text(body.einsatz, 120);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE fahrzeuge SET status = ?, einsatz = ?, lat = ?, lng = ?, geaendert_von = ?, geaendert_am = ? WHERE id = ?`
      ).bind(status, einsatz, pos && pos[0], pos && pos[1], ich.name, jetzt(), m[1]),
      protokoll(env, ich, "status", `${f.rufname}: Status ${status}${einsatz ? " – " + einsatz : ""}`),
    ]);
    return json({ ok: true });
  }

  m = pfad.match(/^\/api\/fahrzeuge\/([A-Za-z0-9_-]{1,40})\/besatzung$/);
  if (m && methode === "PUT") {
    darfVerwalten(ich);
    const b = await request.json();
    const fzf = person(b.fzf);
    const besatzung = (Array.isArray(b.besatzung) ? b.besatzung : []).map(person).filter(Boolean);
    if (besatzung.length > MAX_BESATZUNG) throw fehler(400, `Höchstens ${MAX_BESATZUNG} Personen Besatzung.`);
    for (const p of besatzung) p.funktion = text(p.funktion, 30);

    const { results } = await env.DB.prepare("SELECT id, rufname, fzf, besatzung FROM fahrzeuge").all();
    const dieses = results.find((f) => f.id === m[1]);
    if (!dieses) throw fehler(404, "Fahrzeug nicht gefunden.");

    // Wer neu eingeteilt wird, wird aus anderen Fahrzeugen ausgetragen.
    const ids = [fzf, ...besatzung].filter((p) => p && p.userId).map((p) => p.userId);
    const updates = [];
    for (const f of results) {
      if (f.id === m[1]) continue;
      const altFzf = parse(f.fzf);
      const altBes = parse(f.besatzung) || [];
      const neuFzf = altFzf && ids.includes(altFzf.userId) ? null : altFzf;
      const neuBes = altBes.filter((p) => !ids.includes(p.userId));
      if (neuFzf !== altFzf || neuBes.length !== altBes.length) {
        updates.push(env.DB.prepare("UPDATE fahrzeuge SET fzf = ?, besatzung = ? WHERE id = ?")
          .bind(neuFzf ? JSON.stringify(neuFzf) : null, JSON.stringify(neuBes), f.id));
        updates.push(...zuteilungenAbgleichen(env, ich, f, [altFzf, altBes], [neuFzf, neuBes]));
      }
    }
    updates.push(env.DB.prepare(
      "UPDATE fahrzeuge SET fzf = ?, besatzung = ?, geaendert_von = ?, geaendert_am = ? WHERE id = ?"
    ).bind(fzf ? JSON.stringify(fzf) : null, JSON.stringify(besatzung), ich.name, jetzt(), m[1]));
    updates.push(...zuteilungenAbgleichen(env, ich, dieses,
      [parse(dieses.fzf), parse(dieses.besatzung) || []], [fzf, besatzung]));
    await env.DB.batch(updates);
    return json({ ok: true });
  }

  if (pfad === "/api/mitglieder" && methode === "GET") {
    darfVerwalten(ich);
    return json({ mitglieder: await mitglieder(env) });
  }

  m = pfad.match(/^\/api\/fahrzeuge\/([A-Za-z0-9_-]{1,40})$/);
  if (m && methode === "PUT") {
    darfVerwalten(ich);
    const b = await request.json();
    const rufname = text(b.rufname, 40);
    const typ = text(b.typ, 30);
    const wache = String(b.wache || "");
    if (!rufname || !typ) throw fehler(400, "Rufname und Typ sind Pflicht.");
    if (!/^[A-Z0-9]{1,8}$/.test(wache)) throw fehler(400, "Ungültige Wache.");
    const gab = await env.DB.prepare("SELECT 1 FROM fahrzeuge WHERE id = ?").bind(m[1]).first();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO fahrzeuge (id, rufname, typ, wache, status, geaendert_von, geaendert_am)
         VALUES (?, ?, ?, ?, 2, ?, ?)
         ON CONFLICT(id) DO UPDATE SET rufname = excluded.rufname, typ = excluded.typ, wache = excluded.wache,
           geaendert_von = excluded.geaendert_von, geaendert_am = excluded.geaendert_am`
      ).bind(m[1], rufname, typ, wache, ich.name, jetzt()),
      protokoll(env, ich, "fahrzeug", `${rufname} (${typ}, ${wache}) ${gab ? "geändert" : "angelegt"}`),
    ]);
    return json({ ok: true });
  }

  if (m && methode === "DELETE") {
    darfVerwalten(ich);
    const f = await env.DB.prepare("SELECT rufname FROM fahrzeuge WHERE id = ?").bind(m[1]).first();
    if (!f) return json({ ok: true });
    await env.DB.batch([
      env.DB.prepare("UPDATE zuteilungen SET bis = ?, ausgetragen_von = ? WHERE fahrzeug_id = ? AND bis IS NULL")
        .bind(jetzt(), ich.name, m[1]),
      env.DB.prepare("DELETE FROM fahrzeuge WHERE id = ?").bind(m[1]),
      protokoll(env, ich, "fahrzeug", `${f.rufname} gelöscht`),
    ]);
    return json({ ok: true });
  }

  if (pfad === "/api/dienst" && methode === "GET") {
    return json({ imDienst: await dienstListe(env) });
  }

  if (pfad === "/api/dienst" && methode === "POST") {
    if (!ich.wachleiter) throw fehler(403, "Nur Wachleiter können sich in den Dienst melden.");
    const { aktiv } = await request.json();
    if (aktiv && !ich.imDienst) {
      await env.DB.batch([
        env.DB.prepare("INSERT OR REPLACE INTO dienst (user_id, name, seit) VALUES (?, ?, ?)").bind(ich.id, ich.name, jetzt()),
        env.DB.prepare("INSERT INTO dienstzeiten (user_id, name, von) VALUES (?, ?, ?)").bind(ich.id, ich.name, jetzt()),
        protokoll(env, ich, "dienst", "Dienst angetreten"),
      ]);
    } else if (!aktiv && ich.imDienst) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM dienst WHERE user_id = ?").bind(ich.id),
        env.DB.prepare("UPDATE dienstzeiten SET bis = ?, beendet = 'selbst' WHERE user_id = ? AND bis IS NULL")
          .bind(jetzt(), ich.id),
        protokoll(env, ich, "dienst", "Dienst beendet"),
      ]);
    }
    return json(await rechte(ich, env));
  }

  if (pfad === "/api/aktivitaet" && methode === "GET") {
    if (!ich.wachleiter && !ich.hoehererDienst) {
      throw fehler(403, "Die Aktivität sehen nur Wachleiter und der Höhere Dienst.");
    }
    const tage = Math.max(0, Math.min(3650, Number(url.searchParams.get("tage")) || 0));
    return json(await aktivitaet(env, tage));
  }

  throw fehler(404, "Unbekannter Pfad.");
}

// ---------- Anmeldung & Rechte ----------

async function anmelden(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw fehler(401, "Nicht angemeldet.");

  let eintrag = tokenCache.get(token);
  if (!eintrag || eintrag.bis < Date.now()) {
    const r = await fetch(DISCORD + "/users/@me", { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) throw fehler(401, "Discord-Anmeldung ungültig oder abgelaufen.");
    eintrag = { user: await r.json(), bis: Date.now() + 5 * 60 * 1000 };
    tokenCache.set(token, eintrag);
    if (tokenCache.size > 500) tokenCache.delete(tokenCache.keys().next().value);
  }
  const user = eintrag.user;

  // Mitgliedschaft und Rollen liest der Bot – das kann der Nutzer nicht fälschen.
  let m = memberCache.get(user.id);
  if (!m || m.bis < Date.now()) {
    const r = await fetch(`${DISCORD}/guilds/${env.GUILD_ID}/members/${user.id}`, {
      headers: { Authorization: "Bot " + env.BOT_TOKEN },
    });
    if (r.status === 404) throw fehler(403, "Du bist kein Mitglied des Fraktionsservers.");
    if (!r.ok) throw fehler(502, "Discord-Rollen konnten nicht gelesen werden.");
    m = { member: await r.json(), bis: Date.now() + 60 * 1000 };
    memberCache.set(user.id, m);
    if (memberCache.size > 500) memberCache.delete(memberCache.keys().next().value);
  }
  const member = m.member;

  const alleRollen = await serverRollen(env);
  const namen = member.roles.map((id) => {
    const rolle = alleRollen.find((x) => x.id === id);
    return { id, name: rolle ? normalisieren(rolle.name) : "" };
  });
  const passt = (liste) => {
    const ziele = liste.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return namen.some((r) => ziele.includes(r.id) || ziele.includes(r.name.toLowerCase()));
  };

  const ich = {
    id: user.id,
    name: member.nick || user.global_name || user.username,
    hoehererDienst: passt(env.ROLLEN_HOEHERER_DIENST || STANDARD_HOEHERER_DIENST),
    wachleiter: passt(env.ROLLEN_WACHLEITER || STANDARD_WACHLEITER),
    rollen: namen.map((r) => r.name).filter(Boolean),
  };
  return rechte(ich, env);
}

async function rechte(ich, env) {
  const imDienst = ich.wachleiter && (await dienstListe(env)).some((d) => d.userId === ich.id);
  return { ...ich, imDienst, verwaltung: ich.hoehererDienst || imDienst };
}

function darfVerwalten(ich) {
  if (!ich.verwaltung) {
    throw fehler(403, ich.wachleiter
      ? "Melde dich zuerst in den Dienst, um Fahrzeuge zu verwalten."
      : "Nur Wachleiter im Dienst oder der Höhere Dienst dürfen Fahrzeuge verwalten.");
  }
}

async function serverRollen(env) {
  if (rollenCache.bis > Date.now()) return rollenCache.rollen;
  const r = await fetch(`${DISCORD}/guilds/${env.GUILD_ID}/roles`, {
    headers: { Authorization: "Bot " + env.BOT_TOKEN },
  });
  if (!r.ok) throw fehler(502, "Serverrollen konnten nicht gelesen werden – ist der Bot auf dem Server?");
  rollenCache.rollen = await r.json();
  rollenCache.bis = Date.now() + 5 * 60 * 1000;
  return rollenCache.rollen;
}

// "BD » [Branddirektor]", "[BD] Branddirektor", "BD ┃ Branddirektor",
// "⭐︱Branddirektor" → "Branddirektor"
function normalisieren(name) {
  const n = name.trim().replace(/^.*?[»︱┃│]\s*/, "");
  const geklammert = n.match(/^\[([^\]]+)\]$/);
  return (geklammert ? geklammert[1] : n.replace(/^\[[^\]]*\]\s*/, "")).trim();
}

// Alle Servermitglieder für die Besatzungsauswahl (braucht den Members Intent).
async function mitglieder(env) {
  if (mitgliederCache.bis > Date.now()) return mitgliederCache.liste;
  const alleRollen = await serverRollen(env);
  const fzfZiele = (env.ROLLEN_FZF || STANDARD_FZF).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const fzfRollen = alleRollen
    .filter((r) => fzfZiele.includes(r.id) || fzfZiele.includes(normalisieren(r.name).toLowerCase()))
    .map((r) => r.id);

  const liste = [];
  let after = "0";
  for (let seite = 0; seite < 10; seite++) {
    const r = await fetch(`${DISCORD}/guilds/${env.GUILD_ID}/members?limit=1000&after=${after}`, {
      headers: { Authorization: "Bot " + env.BOT_TOKEN },
    });
    if (r.status === 403) {
      throw fehler(502, "Mitgliederliste gesperrt – im Discord Developer Portal beim Bot den \"Server Members Intent\" einschalten.");
    }
    if (!r.ok) throw fehler(502, "Mitgliederliste konnte nicht geladen werden.");
    const teil = await r.json();
    for (const mb of teil) {
      if (mb.user.bot) continue;
      liste.push({
        userId: mb.user.id,
        name: mb.nick || mb.user.global_name || mb.user.username,
        fzf: mb.roles.some((id) => fzfRollen.includes(id)),
      });
    }
    if (teil.length < 1000) break;
    after = teil[teil.length - 1].user.id;
  }
  liste.sort((a, b) => a.name.localeCompare(b.name, "de"));
  mitgliederCache.liste = liste;
  mitgliederCache.bis = Date.now() + 2 * 60 * 1000;
  return liste;
}

async function dienstListe(env) {
  const grenze = new Date(Date.now() - DIENST_MAX_STUNDEN * 3600 * 1000).toISOString();
  const { results: abgelaufen } = await env.DB.prepare("SELECT * FROM dienst WHERE seit < ?").bind(grenze).all();
  if (abgelaufen.length) {
    // Dienstzeit endet nach DIENST_MAX_STUNDEN, nicht erst beim nächsten Aufruf
    await env.DB.batch(abgelaufen.flatMap((d) => [
      env.DB.prepare("UPDATE dienstzeiten SET bis = ?, beendet = 'automatisch' WHERE user_id = ? AND bis IS NULL")
        .bind(new Date(Date.parse(d.seit) + DIENST_MAX_STUNDEN * 3600 * 1000).toISOString(), d.user_id),
      env.DB.prepare("DELETE FROM dienst WHERE user_id = ?").bind(d.user_id),
    ]));
  }
  const { results } = await env.DB.prepare("SELECT * FROM dienst ORDER BY seit").all();
  return results.map((d) => ({ userId: d.user_id, name: d.name, seit: d.seit }));
}

// ---------- Aktivität ----------

const personKey = (p) => p.userId || "name:" + p.name.toLowerCase();

function protokoll(env, ich, aktion, details) {
  return env.DB.prepare("INSERT INTO protokoll (zeit, user_id, name, aktion, details) VALUES (?, ?, ?, ?, ?)")
    .bind(jetzt(), ich.id, ich.name, aktion, details);
}

// Vergleicht die alte und neue Besatzung eines Fahrzeugs und schreibt die
// Zuteilungen fort: Neue bekommen eine offene Zuteilung, Ausgetragene eine Endzeit.
function zuteilungenAbgleichen(env, ich, fahrzeug, [altFzf, altBes], [neuFzf, neuBes]) {
  const liste = (fzf, bes) => {
    const map = new Map();
    if (fzf) map.set(personKey(fzf), { p: fzf, rolle: "FzF" });
    for (const p of bes) map.set(personKey(p), { p, rolle: p.funktion || "Besatzung" });
    return map;
  };
  const alt = liste(altFzf, altBes);
  const neu = liste(neuFzf, neuBes);
  const t = jetzt();
  const stmts = [];

  for (const [key, { p }] of alt) {
    if (neu.has(key)) continue;
    stmts.push(env.DB.prepare(
      "UPDATE zuteilungen SET bis = ?, ausgetragen_von = ? WHERE fahrzeug_id = ? AND person = ? AND bis IS NULL"
    ).bind(t, ich.name, fahrzeug.id, key));
    stmts.push(protokoll(env, ich, "besatzung", `${p.name} von ${fahrzeug.rufname} ausgetragen`));
  }
  for (const [key, { p, rolle }] of neu) {
    const vorher = alt.get(key);
    // Offene Zuteilung anlegen, falls es noch keine gibt (auch für Besatzungen von vor dem Tracking)
    stmts.push(env.DB.prepare(
      `INSERT INTO zuteilungen (person, user_id, name, fahrzeug_id, rufname, rolle, von, zugeteilt_von)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS
         (SELECT 1 FROM zuteilungen WHERE fahrzeug_id = ? AND person = ? AND bis IS NULL)`
    ).bind(key, p.userId || null, p.name, fahrzeug.id, fahrzeug.rufname, rolle, t, ich.name, fahrzeug.id, key));
    if (!vorher) {
      stmts.push(protokoll(env, ich, "besatzung", `${p.name} auf ${fahrzeug.rufname} eingeteilt (${rolle})`));
    } else if (vorher.rolle !== rolle) {
      stmts.push(env.DB.prepare(
        "UPDATE zuteilungen SET rolle = ? WHERE fahrzeug_id = ? AND person = ? AND bis IS NULL"
      ).bind(rolle, fahrzeug.id, key));
      stmts.push(protokoll(env, ich, "besatzung", `${p.name} auf ${fahrzeug.rufname}: ${vorher.rolle} → ${rolle}`));
    }
  }
  return stmts;
}

// Auswertung für die Verwaltung: Zeiten pro Person im gewählten Zeitraum (0 = gesamt).
async function aktivitaet(env, tage) {
  const nun = Date.now();
  const start = tage ? nun - tage * 86400 * 1000 : 0;
  const startIso = new Date(start).toISOString();

  const [zut, dienste, zaehler, letzte] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM zuteilungen WHERE bis IS NULL OR bis >= ? ORDER BY von DESC LIMIT 5000").bind(startIso),
    env.DB.prepare("SELECT * FROM dienstzeiten WHERE bis IS NULL OR bis >= ?").bind(startIso),
    env.DB.prepare(
      "SELECT user_id, MAX(name) AS name, aktion, COUNT(*) AS n, MAX(zeit) AS letzte FROM protokoll WHERE zeit >= ? GROUP BY user_id, aktion"
    ).bind(startIso),
    env.DB.prepare("SELECT zeit, name, aktion, details FROM protokoll WHERE zeit >= ? ORDER BY id DESC LIMIT 100").bind(startIso),
  ]);

  const dauer = (von, bis) =>
    Math.max(0, Math.min(bis ? Date.parse(bis) : nun, nun) - Math.max(Date.parse(von), start));
  const personen = new Map();
  const hole = (key, name) => {
    if (!personen.has(key)) {
      personen.set(key, {
        key, userId: key.startsWith("name:") ? null : key, name,
        fahrzeugMs: 0, fzfMs: 0, zuteilungen: 0, aktuellAuf: null, zuletztZugeteiltVon: null,
        dienstMs: 0, statusMeldungen: 0, verwaltung: 0, zuletztAktiv: null,
      });
    }
    return personen.get(key);
  };
  const aktiv = (p, zeit) => {
    if (zeit && (!p.zuletztAktiv || zeit > p.zuletztAktiv)) p.zuletztAktiv = zeit;
  };

  for (const z of zut.results) { // neueste zuerst
    const p = hole(z.person, z.name);
    const ms = dauer(z.von, z.bis);
    p.fahrzeugMs += ms;
    if (z.rolle === "FzF") p.fzfMs += ms;
    p.zuteilungen += 1;
    if (!z.bis && !p.aktuellAuf) p.aktuellAuf = z.rufname;
    if (!p.zuletztZugeteiltVon) p.zuletztZugeteiltVon = z.zugeteilt_von;
    aktiv(p, z.bis || new Date(nun).toISOString());
  }
  for (const d of dienste.results) {
    const p = hole(d.user_id, d.name);
    p.dienstMs += dauer(d.von, d.bis);
    aktiv(p, d.bis || new Date(nun).toISOString());
  }
  for (const c of zaehler.results) {
    const p = hole(c.user_id, c.name);
    if (c.aktion === "status") p.statusMeldungen += c.n;
    if (c.aktion === "fahrzeug" || c.aktion === "besatzung") p.verwaltung += c.n;
    aktiv(p, c.letzte);
  }

  return {
    von: tage ? startIso : null,
    bis: new Date(nun).toISOString(),
    personen: [...personen.values()].sort((a, b) => b.fahrzeugMs - a.fahrzeugMs || b.dienstMs - a.dienstMs),
    zuteilungen: zut.results.map((z) => ({
      name: z.name, userId: z.user_id, rufname: z.rufname, rolle: z.rolle, von: z.von, bis: z.bis,
      zugeteiltVon: z.zugeteilt_von, ausgetragenVon: z.ausgetragen_von,
    })),
    protokoll: letzte.results,
  };
}

// ---------- Hilfsfunktionen ----------

function ausDb(f) {
  return {
    id: f.id, rufname: f.rufname, typ: f.typ, wache: f.wache, status: f.status,
    einsatz: f.einsatz || undefined,
    position: f.lat == null ? undefined : [f.lat, f.lng],
    geaendertVon: f.geaendert_von, geaendertAm: f.geaendert_am,
    fzf: parse(f.fzf) || undefined,
    besatzung: parse(f.besatzung) || [],
  };
}

function parse(s) {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

// { userId?, name, funktion? } – userId nur, wenn die Person aus der Liste gewählt wurde.
function person(p) {
  if (!p || typeof p !== "object") return null;
  const name = text(p.name, 40);
  if (!name) return null;
  const userId = /^\d{5,25}$/.test(String(p.userId || "")) ? String(p.userId) : undefined;
  return { userId, name, funktion: p.funktion };
}

function position(p) {
  if (!Array.isArray(p)) return null;
  const [lat, lng] = p.map(Number);
  if (!(lat >= -256 && lat <= 0 && lng >= 0 && lng <= 256)) throw fehler(400, "Position liegt außerhalb der Karte.");
  return [lat, lng];
}

function text(v, max) {
  const s = String(v ?? "").trim().slice(0, max);
  return s || null;
}

const jetzt = () => new Date().toISOString();

function fehler(status, message) {
  return Object.assign(new Error(message), { status });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const erlaubt = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim());
  return {
    "Access-Control-Allow-Origin": erlaubt.includes(origin) ? origin : erlaubt[0] || "",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
