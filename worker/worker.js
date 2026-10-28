// Dispo-API für die Berufsfeuerwehr NRW RP – Cloudflare Worker + D1.
//
// Prüft bei jeder Anfrage das Discord-Token des Nutzers, liest über den Bot
// seine Rollen auf dem Fraktionsserver und entscheidet daraus, was er darf:
//   • Mitglied            → Karte sehen, Fahrzeugstatus ändern
//   • Wachleiter im Dienst → zusätzlich Fahrzeuge verwalten
//   • Höherer Dienst       → Fahrzeuge verwalten (immer)
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
    const r = await env.DB.prepare(
      `UPDATE fahrzeuge SET status = ?, einsatz = ?, lat = ?, lng = ?, geaendert_von = ?, geaendert_am = ? WHERE id = ?`
    )
      .bind(status, text(body.einsatz, 120), pos && pos[0], pos && pos[1], ich.name, jetzt(), m[1])
      .run();
    if (!r.meta.changes) throw fehler(404, "Fahrzeug nicht gefunden.");
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

    // Wer neu eingeteilt wird, wird aus anderen Fahrzeugen ausgetragen.
    const ids = [fzf, ...besatzung].filter((p) => p && p.userId).map((p) => p.userId);
    const { results } = await env.DB.prepare("SELECT id, fzf, besatzung FROM fahrzeuge WHERE id != ?").bind(m[1]).all();
    const updates = [];
    for (const f of results) {
      const altFzf = parse(f.fzf);
      const altBes = parse(f.besatzung) || [];
      const neuFzf = altFzf && ids.includes(altFzf.userId) ? null : altFzf;
      const neuBes = altBes.filter((p) => !ids.includes(p.userId));
      if (neuFzf !== altFzf || neuBes.length !== altBes.length) {
        updates.push(env.DB.prepare("UPDATE fahrzeuge SET fzf = ?, besatzung = ? WHERE id = ?")
          .bind(neuFzf ? JSON.stringify(neuFzf) : null, JSON.stringify(neuBes), f.id));
      }
    }
    updates.push(env.DB.prepare(
      "UPDATE fahrzeuge SET fzf = ?, besatzung = ?, geaendert_von = ?, geaendert_am = ? WHERE id = ?"
    ).bind(fzf ? JSON.stringify(fzf) : null, JSON.stringify(besatzung), ich.name, jetzt(), m[1]));
    const r = await env.DB.batch(updates);
    if (!r[r.length - 1].meta.changes) throw fehler(404, "Fahrzeug nicht gefunden.");
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
    await env.DB.prepare(
      `INSERT INTO fahrzeuge (id, rufname, typ, wache, status, geaendert_von, geaendert_am)
       VALUES (?, ?, ?, ?, 2, ?, ?)
       ON CONFLICT(id) DO UPDATE SET rufname = excluded.rufname, typ = excluded.typ, wache = excluded.wache,
         geaendert_von = excluded.geaendert_von, geaendert_am = excluded.geaendert_am`
    )
      .bind(m[1], rufname, typ, wache, ich.name, jetzt())
      .run();
    return json({ ok: true });
  }

  if (m && methode === "DELETE") {
    darfVerwalten(ich);
    await env.DB.prepare("DELETE FROM fahrzeuge WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  if (pfad === "/api/dienst" && methode === "GET") {
    return json({ imDienst: await dienstListe(env) });
  }

  if (pfad === "/api/dienst" && methode === "POST") {
    if (!ich.wachleiter) throw fehler(403, "Nur Wachleiter können sich in den Dienst melden.");
    const { aktiv } = await request.json();
    if (aktiv) {
      await env.DB.prepare("INSERT OR REPLACE INTO dienst (user_id, name, seit) VALUES (?, ?, ?)")
        .bind(ich.id, ich.name, jetzt())
        .run();
    } else {
      await env.DB.prepare("DELETE FROM dienst WHERE user_id = ?").bind(ich.id).run();
    }
    return json(await rechte(ich, env));
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
  await env.DB.prepare("DELETE FROM dienst WHERE seit < ?").bind(grenze).run();
  const { results } = await env.DB.prepare("SELECT * FROM dienst ORDER BY seit").all();
  return results.map((d) => ({ userId: d.user_id, name: d.name, seit: d.seit }));
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
