// Discord-Login per OAuth2 (Implicit Grant) – läuft komplett im Browser,
// daher funktioniert es auch auf GitHub Pages ohne eigenen Server.
(function () {
  const API = "https://discord.com/api/v10";
  const KEY = "dispo.auth";
  const cfg = window.DISPO_CONFIG;

  function redirectUri() {
    return location.origin + location.pathname;
  }

  function scopes() {
    const s = ["identify"];
    if (cfg.guildId) s.push(cfg.requiredRoleIds.length ? "guilds.members.read" : "guilds");
    return s.join(" ");
  }

  function login() {
    const state = crypto.getRandomValues(new Uint32Array(4)).join("-");
    sessionStorage.setItem(KEY + ".state", state);
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: cfg.discordClientId,
      response_type: "token",
      redirect_uri: redirectUri(),
      scope: scopes(),
      state,
      prompt: "none",
    });
    location.href = url.toString();
  }

  function logout() {
    sessionStorage.removeItem(KEY);
    location.hash = "";
    location.reload();
  }

  // Liest das Token aus der URL nach der Rückkehr von Discord.
  function handleCallback() {
    if (!location.hash.includes("access_token") && !location.hash.includes("error")) return null;
    const p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, "", location.pathname + location.search);
    if (p.get("error")) throw new Error(p.get("error_description") || "Anmeldung abgebrochen.");
    const expected = sessionStorage.getItem(KEY + ".state");
    sessionStorage.removeItem(KEY + ".state");
    if (!expected || p.get("state") !== expected) throw new Error("Ungültige Anmeldung (state). Bitte erneut versuchen.");
    const auth = {
      token: p.get("access_token"),
      expires: Date.now() + Number(p.get("expires_in") || 3600) * 1000,
    };
    sessionStorage.setItem(KEY, JSON.stringify(auth));
    return auth;
  }

  function stored() {
    try {
      const a = JSON.parse(sessionStorage.getItem(KEY));
      return a && a.expires > Date.now() ? a : null;
    } catch {
      return null;
    }
  }

  async function api(path, token) {
    const r = await fetch(API + path, { headers: { Authorization: "Bearer " + token } });
    if (r.status === 401) {
      sessionStorage.removeItem(KEY);
      throw new Error("Sitzung abgelaufen. Bitte neu anmelden.");
    }
    return r;
  }

  // Liefert den Discord-Benutzer oder wirft einen Fehler mit Begründung.
  async function verify(auth) {
    const r = await api("/users/@me", auth.token);
    if (!r.ok) throw new Error("Discord-Profil konnte nicht geladen werden.");
    const user = await r.json();

    if (cfg.guildId && cfg.requiredRoleIds.length) {
      const m = await api(`/users/@me/guilds/${cfg.guildId}/member`, auth.token);
      if (!m.ok) throw new Error("Du bist kein Mitglied des Fraktionsservers.");
      const member = await m.json();
      if (!member.roles.some((id) => cfg.requiredRoleIds.includes(id))) {
        throw new Error("Dir fehlt die nötige Rolle für die Dispo-Karte.");
      }
      user.nick = member.nick;
    } else if (cfg.guildId) {
      const g = await api("/users/@me/guilds", auth.token);
      if (!g.ok) throw new Error("Serverliste konnte nicht geladen werden.");
      if (!(await g.json()).some((x) => x.id === cfg.guildId)) {
        throw new Error("Du bist kein Mitglied des Fraktionsservers.");
      }
    }
    return user;
  }

  window.DispoAuth = { login, logout, handleCallback, stored, verify };
})();
