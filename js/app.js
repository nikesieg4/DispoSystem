(function () {
  const cfg = window.DISPO_CONFIG;
  const FMS = window.FMS_STATUS;
  const $ = (s) => document.querySelector(s);

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const fmsColor = (s) => (FMS[s] || { farbe: "#7C838D" }).farbe;
  const fmsText = (s) => (FMS[s] || { text: "Unbekannt" }).text;

  const FUNKTIONEN = [
    "Maschinist", "Angriffstruppführer", "Angriffstruppmann", "Wassertruppführer", "Wassertruppmann",
    "Schlauchtruppführer", "Schlauchtruppmann", "Melder", "Rettungssanitäter", "Notfallsanitäter",
    "Notarzt", "Praktikant",
  ];

  // "FzF: Müller · 3 Besatzung"
  function crewKurz(f) {
    const n = (f.besatzung || []).length;
    const teile = [];
    if (f.fzf) teile.push("FzF: " + f.fzf.name);
    if (n) teile.push(n + (f.fzf ? " Besatzung" : n === 1 ? " Person" : " Personen"));
    return teile.join(" · ");
  }

  function crewHtml(f) {
    if (!f.fzf && !(f.besatzung || []).length) return "";
    const rows = (f.besatzung || []).map((p) => `<div>${esc(p.name)}${p.funktion ? ` <span class="muted">· ${esc(p.funktion)}</span>` : ""}</div>`).join("");
    return `<div class="popup-crew">${f.fzf ? `<div><b>FzF:</b> ${esc(f.fzf.name)}</div>` : ""}${rows}</div>`;
  }

  async function loadJson(path) {
    const r = await fetch(path + "?t=" + Date.now(), { cache: "no-store" });
    if (!r.ok) throw new Error(path + " konnte nicht geladen werden");
    return r.json();
  }

  // ---------- Start: Login prüfen ----------

  async function start() {
    let auth;
    try {
      auth = DispoAuth.handleCallback() || DispoAuth.stored();
    } catch (e) {
      return showLogin(e.message);
    }
    if (!auth) return showLogin();

    try {
      const user = await DispoAuth.verify(auth);
      showApp(user);
    } catch (e) {
      showLogin(e.message);
    }
  }

  function showLogin(error) {
    $("#login").hidden = false;
    $("#app").hidden = true;
    if (cfg.discordClientId === "DEINE_CLIENT_ID") {
      error = "Die Discord Client ID ist noch nicht in js/config.js eingetragen.";
      $("#login-btn").disabled = true;
    }
    if (error) {
      $("#login-error").textContent = error;
      $("#login-error").hidden = false;
    }
  }

  function showApp(user) {
    rechte = user.rechte || null;
    meId = user.id;
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#user-name").textContent = user.nick || user.global_name || user.username;
    $("#user-avatar").src = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
      : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(user.id) >> 22n) % 6}.png`;
    initMap();
  }

  $("#login-btn").addEventListener("click", DispoAuth.login);
  $("#logout-btn").addEventListener("click", DispoAuth.logout);

  // ---------- Karte ----------

  let map, wachen = {}, bereiche = [], fahrzeuge = [];
  let rechte = null; // nur mit API: { name, wachleiter, hoehererDienst, disponent, imDienst, verwaltung }
  let meId = null;
  let einsaetze = [];
  const mitApi = () => Boolean(cfg.apiUrl);
  const vehicleLayer = L.layerGroup();
  const areaLayer = L.layerGroup();
  const vehicleMarkers = {};
  const stationMarkers = {};
  const hiddenStatus = new Set();

  async function initMap() {
    const bounds = [[-256, 0], [0, 256]];
    map = L.map("map", {
      crs: L.CRS.Simple,
      minZoom: 1,
      maxZoom: 8,
      zoomSnap: 0.5,
      maxBounds: [[-300, -44], [44, 300]],
      attributionControl: true,
    });
    L.tileLayer(cfg.tileUrl, {
      bounds,
      noWrap: true,
      minNativeZoom: 0,
      maxNativeZoom: 6,
      maxZoom: 8,
      attribution: 'Karte: <a href="https://erlc.one" target="_blank" rel="noopener">erlc.one</a>',
    }).addTo(map);
    map.fitBounds([[-215, 40], [-25, 215]]);
    // Bereichsnamen erst ab etwas Zoom zeigen, sonst überlappen sie.
    const updateZoomClass = () => map.getContainer().classList.toggle("zoom-far", map.getZoom() < 1.5);
    map.on("zoomend", updateZoomClass);
    updateZoomClass();

    const [w, b] = await Promise.all([loadJson("data/wachen.json"), loadJson("data/bereiche.json")]);
    w.forEach((x) => (wachen[x.id] = x));
    bereiche = b;

    drawStations();
    drawAreas();
    areaLayer.addTo(map);
    vehicleLayer.addTo(map);
    initUi();

    await refresh();
    setInterval(refresh, cfg.refreshSeconds * 1000);
  }

  function stationIcon(w) {
    const label = w.typ === "krankenhaus" ? "KH" : w.id;
    const count = atStation(w.id).length;
    const badge = count ? `<span class="badge">${count}</span>` : "";
    return L.divIcon({
      className: "",
      html: `<div class="station-marker" style="background:${esc(w.farbe)}">${esc(label)}${badge}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  function drawStations() {
    Object.values(wachen).forEach((w) => {
      stationMarkers[w.id] = L.marker(w.position, { icon: stationIcon(w) })
        .bindPopup(() => stationPopup(w))
        .addTo(map);
    });
  }

  // Fahrzeuge ohne eigene Position stehen auf ihrer Wache.
  function atStation(id) {
    return fahrzeuge.filter((f) => f.wache === id && !Array.isArray(f.position) && !hiddenStatus.has(f.status));
  }

  function stationPopup(w) {
    const list = atStation(w.id);
    const edit = (f) => (mitApi() ? ` data-status-edit="${esc(f.id)}" class="popup-row popup-link"` : ' class="popup-row"');
    const rows = list.length
      ? '<div class="popup-row muted">Auf der Wache:</div>' + list.map((f) => `<div${edit(f)}><span class="fms" style="background:${fmsColor(f.status)};width:20px;height:20px;font-size:11px">${esc(f.status)}</span> ${esc(f.rufname)} · ${esc(f.typ)}${crewKurz(f) ? `<div class="muted small">${esc(crewKurz(f))}</div>` : ""}</div>`).join("")
      : '<div class="popup-row muted">Keine Fahrzeuge auf der Wache</div>';
    return `<div class="popup-title">${esc(w.name)}</div>${w.typ === "wache" ? rows : ""}`;
  }

  function drawAreas() {
    // Eigene Ebene unter den Markern, damit Namen keine Wachen verdecken.
    map.createPane("bereiche").style.zIndex = 450;
    bereiche.forEach((a) => {
      const farbe = wachen[a.wache] ? wachen[a.wache].farbe : "#A49A91";
      L.circleMarker(a.position, { radius: 0, opacity: 0, interactive: false })
        .bindTooltip(esc(a.name), {
          permanent: true,
          direction: "center",
          className: "area-label",
          pane: "bereiche",
        })
        .on("tooltipopen", (e) => (e.tooltip.getElement().style.borderLeftColor = farbe))
        .addTo(areaLayer);
    });
  }

  async function refresh() {
    try {
      const data = mitApi() ? await DispoAuth.api("/api/fahrzeuge") : await loadJson("data/fahrzeuge.json");
      fahrzeuge = data.fahrzeuge || [];
      einsaetze = data.einsaetze || [];
      $("#stand").textContent = "Stand: " + new Date(data.stand || Date.now()).toLocaleString("de-DE");
    } catch (e) {
      $("#stand").textContent = "Fahrzeugdaten konnten nicht geladen werden";
      return;
    }
    renderVehicles();
    renderVehicleList();
    if (mitApi()) {
      renderEinsaetze();
      renderMeinFahrzeug();
    }
    if (rechte && rechte.verwaltung) renderVerwaltungListe();
  }

  function renderVehicles() {
    vehicleLayer.clearLayers();
    Object.keys(vehicleMarkers).forEach((k) => delete vehicleMarkers[k]);
    Object.values(wachen).forEach((w) => stationMarkers[w.id] && stationMarkers[w.id].setIcon(stationIcon(w)));

    fahrzeuge.forEach((f) => {
      if (hiddenStatus.has(f.status) || !Array.isArray(f.position)) return;
      const pos = f.position;
      const color = fmsColor(f.status);
      const m = L.marker(pos, {
        icon: L.divIcon({
          className: "",
          html: `<div class="veh-marker" style="border-color:${color}"><span class="fms" style="background:${color}">${esc(f.status)}</span>${esc(f.typ)}</div>`,
          iconAnchor: [12, 12],
        }),
      }).bindPopup(
        `<div class="popup-title">${esc(f.rufname)}</div>
         <div class="popup-row">${esc(f.typ)} · ${esc(wachen[f.wache] ? wachen[f.wache].name : f.wache)}</div>
         <div class="popup-row"><span class="fms" style="background:${color};width:20px;height:20px;font-size:11px">${esc(f.status)}</span> ${esc(fmsText(f.status))}</div>
         ${f.einsatz ? `<div class="popup-row muted">${esc(f.einsatz)}</div>` : ""}
         ${offeneAlarme(f.id).map((e) => `<div class="popup-row alarm-text">ALARM #${e.id}: ${esc(e.stichwort)}</div>`).join("")}
         ${crewHtml(f)}
         ${mitApi() ? `<button type="button" class="btn-ghost copy" data-status-edit="${esc(f.id)}">Status ändern</button>` : ""}`
      );
      m.addTo(vehicleLayer);
      vehicleMarkers[f.id] = m;
    });
  }

  // ---------- Seitenleiste ----------

  function initUi() {
    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((x) => {
          x.classList.toggle("active", x === t);
          x.setAttribute("aria-selected", x === t);
        });
        document.querySelectorAll(".tab-panel").forEach((p) => (p.hidden = p.id !== "tab-" + t.dataset.tab));
      })
    );

    $("#status-filter").innerHTML = Object.entries(FMS)
      .map(([n, s]) => `<button type="button" class="chip" data-status="${n}" aria-pressed="true" title="${esc(s.text)}"><span class="dot" style="background:${s.farbe}"></span>${n} ${esc(s.text)}</button>`)
      .join("");
    $("#status-filter").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      const n = Number(chip.dataset.status);
      hiddenStatus.has(n) ? hiddenStatus.delete(n) : hiddenStatus.add(n);
      chip.setAttribute("aria-pressed", !hiddenStatus.has(n));
      renderVehicles();
      renderVehicleList();
    });

    $("#toggle-bereiche").addEventListener("change", (e) =>
      e.target.checked ? areaLayer.addTo(map) : areaLayer.remove()
    );

    renderAreaList();
    initCoordTool();
    if (mitApi()) {
      initStatusDialog();
      initEinsaetze();
      initMeinFahrzeug();
      startLive();
    }
    if (rechte && (rechte.wachleiter || rechte.hoehererDienst)) initVerwaltung();
    if (rechte) zeigeRechte();
  }

  // Hilft beim Einrichten: zeigt, welche Rollen der Bot erkennt.
  function zeigeRechte() {
    const r = rechte;
    $("#rechte-info").hidden = false;
    $("#rechte-text").textContent = r.hoehererDienst
      ? "Höherer Dienst – du kannst Fahrzeuge verwalten."
      : r.wachleiter
        ? "Wachleiter – im Dienst kannst du Fahrzeuge verwalten."
        : "Mitglied – du kannst Status ändern. Für die Verwaltung fehlt eine Wachleiter- oder Höherer-Dienst-Rolle.";
    if (r.disponent) $("#rechte-text").textContent += " Leitstelle – du kannst Einsätze anlegen und Fahrzeuge alarmieren.";
    $("#rechte-rollen").textContent = (r.rollen || []).join(", ") || "keine (Worker-Code aktuell?)";
  }

  function stationGroups(items, render) {
    return Object.values(wachen)
      .filter((w) => w.typ === "wache")
      .map((w) => {
        const list = items.filter((x) => x.wache === w.id);
        if (!list.length) return "";
        return `<div class="group"><h2><span class="dot" style="background:${esc(w.farbe)}"></span>${esc(w.name)}</h2>${list.map(render).join("")}</div>`;
      })
      .join("");
  }

  function renderVehicleList() {
    const visible = fahrzeuge.filter((f) => !hiddenStatus.has(f.status));
    $("#fahrzeug-liste").innerHTML =
      stationGroups(visible, (f) =>
        `<button type="button" class="item" data-veh="${esc(f.id)}">
          <span class="fms" style="background:${fmsColor(f.status)}">${esc(f.status)}</span>
          <span class="grow"><div class="title">${esc(f.rufname)}</div><div class="sub">${esc(f.typ)} · ${esc(f.einsatz || fmsText(f.status))}</div>${offeneAlarme(f.id).map((e) => `<div class="alarm">ALARM #${e.id} · ${esc(e.stichwort)}</div>`).join("")}${crewKurz(f) ? `<div class="crew">${esc(crewKurz(f))}</div>` : ""}</span>
        </button>`
      ) || '<p class="muted">Keine Fahrzeuge mit diesem Status.</p>';
  }

  $("#fahrzeug-liste").addEventListener("click", (e) => {
    const b = e.target.closest("[data-veh]");
    if (!b) return;
    const f = fahrzeuge.find((x) => x.id === b.dataset.veh);
    const m = vehicleMarkers[b.dataset.veh] || (f && stationMarkers[f.wache]);
    if (m) map.flyTo(m.getLatLng(), 5);
    if (mitApi() && f) openStatusDialog(f);
    else if (m) m.openPopup();
  });

  function renderAreaList() {
    $("#bereich-liste").innerHTML = stationGroups(bereiche, (a, i) =>
      `<button type="button" class="item" data-area="${esc(a.name)}"><span class="grow"><div class="title">${esc(a.name)}</div></span></button>`
    );
    $("#bereich-liste").addEventListener("click", (e) => {
      const b = e.target.closest("[data-area]");
      const a = b && bereiche.find((x) => x.name === b.dataset.area);
      if (a) map.flyTo(a.position, 4.5);
    });
  }

  // Klick auf die Karte zeigt die Koordinaten – praktisch zum Eintragen
  // von Fahrzeugpositionen oder neuen Bereichen in die JSON-Dateien.
  function initCoordTool() {
    const btn = $("#coord-btn");
    let active = false;
    btn.addEventListener("click", () => {
      active = !active;
      btn.setAttribute("aria-pressed", active);
      map.getContainer().style.cursor = active ? "crosshair" : "";
    });
    map.on("click", (e) => {
      if (!active || pickCallback) return;
      const text = `[${e.latlng.lat.toFixed(3)}, ${e.latlng.lng.toFixed(3)}]`;
      const nearest = bereiche.reduce((best, a) => {
        const d = Math.hypot(a.position[0] - e.latlng.lat, a.position[1] - e.latlng.lng);
        return !best || d < best.d ? { a, d } : best;
      }, null);
      const div = document.createElement("div");
      div.innerHTML = `<div class="popup-title">${text}</div>
        ${nearest ? `<div class="popup-row muted">Nähe: ${esc(nearest.a.name)}</div>` : ""}
        <button type="button" class="btn-ghost copy">Kopieren</button>`;
      div.querySelector(".copy").addEventListener("click", (ev) => {
        navigator.clipboard.writeText(text).then(() => (ev.target.textContent = "Kopiert"));
      });
      L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
    });
  }

  // ---------- Status ändern (nur mit API) ----------

  let pickCallback = null;
  let dialogFahrzeug = null;
  let dialogAuswahl = null; // { status, einsatz, position }

  function initStatusDialog() {
    $("#sd-status").innerHTML = Object.entries(FMS)
      .map(([n, s]) => `<button type="button" class="sd-btn" data-n="${n}" style="--c:${s.farbe}"><b>${n}</b><span>${esc(s.text)}</span></button>`)
      .join("");
    $("#sd-status").addEventListener("click", (e) => {
      const b = e.target.closest("[data-n]");
      if (!b) return;
      dialogAuswahl.status = Number(b.dataset.n);
      renderStatusDialog();
    });
    $("#sd-pick").addEventListener("click", () => {
      $("#status-dialog").close();
      startPick((latlng) => {
        dialogAuswahl.position = [Number(latlng.lat.toFixed(3)), Number(latlng.lng.toFixed(3))];
        renderStatusDialog();
        $("#status-dialog").showModal();
      }, "#status-dialog");
    });
    $("#sd-wache").addEventListener("click", () => {
      dialogAuswahl.position = null;
      renderStatusDialog();
    });
    $("#sd-cancel").addEventListener("click", () => $("#status-dialog").close());
    $("#status-dialog").addEventListener("submit", async (e) => {
      e.preventDefault();
      dialogAuswahl.einsatz = $("#sd-einsatz").value;
      $("#sd-save").disabled = true;
      try {
        await DispoAuth.api(`/api/fahrzeuge/${encodeURIComponent(dialogFahrzeug.id)}/status`, {
          method: "POST",
          body: dialogAuswahl,
        });
        $("#status-dialog").close();
        map.closePopup();
        await refresh();
      } catch (err) {
        $("#sd-error").textContent = err.message;
        $("#sd-error").hidden = false;
      } finally {
        $("#sd-save").disabled = false;
      }
    });
    $("#pick-cancel").addEventListener("click", () => stopPick(true));

    // "Status ändern" in Karten-Popups
    map.on("popupopen", (e) => {
      e.popup.getElement().querySelectorAll("[data-status-edit]").forEach((el) =>
        el.addEventListener("click", () => {
          const f = fahrzeuge.find((x) => x.id === el.dataset.statusEdit);
          if (f) openStatusDialog(f);
        })
      );
    });
  }

  function openStatusDialog(f, vorlage = {}) {
    dialogFahrzeug = f;
    dialogAuswahl = { status: f.status, einsatz: f.einsatz || "", position: f.position || null, ...vorlage };
    $("#sd-title").textContent = f.rufname;
    $("#sd-sub").textContent = `${f.typ} · ${wachen[f.wache] ? wachen[f.wache].name : f.wache}`;
    $("#sd-einsatz").value = dialogAuswahl.einsatz;
    const crew = [f.fzf ? "FzF " + f.fzf.name : "", ...(f.besatzung || []).map((p) => p.name)].filter(Boolean);
    $("#sd-crew").hidden = !crew.length;
    $("#sd-crew").innerHTML = `<b>Besatzung:</b> ${esc(crew.join(", "))}`;
    $("#sd-error").hidden = true;
    renderStatusDialog();
    $("#status-dialog").showModal();
  }

  function renderStatusDialog() {
    document.querySelectorAll(".sd-btn").forEach((b) =>
      b.setAttribute("aria-pressed", Number(b.dataset.n) === dialogAuswahl.status)
    );
    const p = dialogAuswahl.position;
    $("#sd-pos").textContent = p ? `Position: [${p[0]}, ${p[1]}]${naechsterBereich(p)}` : "Steht auf der Wache";
    $("#sd-wache").hidden = !p;
  }

  function naechsterBereich(p) {
    const n = bereiche.reduce((best, a) => {
      const d = Math.hypot(a.position[0] - p[0], a.position[1] - p[1]);
      return !best || d < best.d ? { a, d } : best;
    }, null);
    return n ? ` · Nähe ${n.a.name}` : "";
  }

  let pickDialog = null;

  function startPick(cb, dialog) {
    pickCallback = cb;
    pickDialog = dialog;
    $("#pick-banner").hidden = false;
    map.getContainer().style.cursor = "crosshair";
    map.once("click", (e) => {
      if (!pickCallback) return;
      const fn = pickCallback;
      stopPick(false);
      fn(e.latlng);
    });
  }

  function stopPick(reopen) {
    pickCallback = null;
    $("#pick-banner").hidden = true;
    map.getContainer().style.cursor = "";
    if (reopen && pickDialog) $(pickDialog).showModal();
  }

  // ---------- Einsätze (Leitstelle) ----------

  const einsatzLayer = L.layerGroup();
  let ezBearbeiten = null; // Einsatz beim Bearbeiten, null = neu
  let ezVorlage = {};      // { position, notrufNr } beim Anlegen

  const offeneAlarme = (fahrzeugId) =>
    einsaetze.filter((e) => e.offen && e.alarmiert.some((a) => a.fahrzeugId === fahrzeugId));

  function initEinsaetze() {
    $("#tab-btn-einsaetze").hidden = false;
    $("#ez-neu").hidden = !(rechte && rechte.disponent);
    einsatzLayer.addTo(map);

    $("#ez-neu").addEventListener("click", () => openEinsatzDialog(null));
    $("#ez-cancel").addEventListener("click", () => $("#ez-dialog").close());
    $("#ez-pick").addEventListener("click", () => {
      $("#ez-dialog").close();
      startPick((latlng) => {
        ezVorlage.position = [Number(latlng.lat.toFixed(3)), Number(latlng.lng.toFixed(3))];
        if (!$("#ez-ort").value.trim()) $("#ez-ort").value = naechsterBereich(ezVorlage.position).replace(" · Nähe ", "");
        renderEinsatzPos();
        $("#ez-dialog").showModal();
      }, "#ez-dialog");
    });
    $("#ez-dialog").addEventListener("submit", speichereEinsatz);

    const klick = async (e) => {
      const b = e.target.closest("[data-ez]");
      if (!b) return;
      const ez = einsaetze.find((x) => x.id === Number(b.dataset.ez));
      if (!ez) return;
      if (b.dataset.aktion === "karte" && ez.position) map.flyTo(ez.position, 5);
      if (b.dataset.aktion === "bearbeiten") openEinsatzDialog(ez);
      if (b.dataset.aktion === "abschluss" && confirm(`Einsatz #${ez.id} „${ez.stichwort}“ abschließen?`)) {
        try {
          await DispoAuth.api(`/api/einsaetze/${ez.id}/abschluss`, { method: "POST" });
          await refresh();
        } catch (err) {
          alert(err.message);
        }
      }
    };
    $("#ez-liste").addEventListener("click", klick);
    $("#ez-alt").addEventListener("click", klick);

    map.on("popupopen", (e) => {
      e.popup.getElement().querySelectorAll("[data-ez-edit]").forEach((el) =>
        el.addEventListener("click", () => openEinsatzDialog(einsaetze.find((x) => x.id === Number(el.dataset.ezEdit))))
      );
      e.popup.getElement().querySelectorAll("[data-notruf]").forEach((el) =>
        el.addEventListener("click", () => einsatzAusNotruf(Number(el.dataset.notruf)))
      );
    });
  }

  function alarmChips(ez) {
    return ez.alarmiert.map((a) => {
      const f = fahrzeuge.find((x) => x.id === a.fahrzeugId);
      if (!f) return "";
      const offen = ez.offen && !a.quittiertAm;
      return `<span class="ez-chip${offen ? " offen" : ""}" title="${offen ? "noch nicht quittiert" : "quittiert"}">
        <span class="fms" style="background:${fmsColor(f.status)}">${esc(f.status)}</span>${esc(f.rufname)}
        ${offen ? "<small>wartet</small>" : ""}</span>`;
    }).join("");
  }

  function einsatzKarte(ez) {
    const darf = rechte && rechte.disponent && ez.offen;
    return `<div class="ez-card${ez.offen ? "" : " zu"}">
      <div class="ez-kopf"><span class="ez-stw">#${ez.id} ${esc(ez.stichwort)}</span>
        <span class="ez-meta">${fmtUhr(ez.erstelltAm)}</span></div>
      ${ez.ort ? `<p>${esc(ez.ort)}</p>` : ""}
      ${ez.bemerkung ? `<p class="muted">${esc(ez.bemerkung)}</p>` : ""}
      <div class="ez-fz">${alarmChips(ez) || '<span class="muted small">Keine Fahrzeuge alarmiert</span>'}</div>
      <div class="ez-meta">Disponent: ${esc(ez.erstelltVon || "–")}${ez.offen ? "" : ` · abgeschlossen ${fmtUhr(ez.abgeschlossenAm)}`}</div>
      <div class="ez-aktionen">
        ${ez.position ? `<button type="button" class="btn-ghost" data-ez="${ez.id}" data-aktion="karte">Auf Karte</button>` : ""}
        ${darf ? `<button type="button" class="btn-ghost" data-ez="${ez.id}" data-aktion="bearbeiten">Bearbeiten / Alarmieren</button>
                  <button type="button" class="btn-ghost" data-ez="${ez.id}" data-aktion="abschluss">Abschließen</button>` : ""}
      </div>
    </div>`;
  }

  function renderEinsaetze() {
    const offen = einsaetze.filter((e) => e.offen);
    $("#ez-zahl").hidden = !offen.length;
    $("#ez-zahl").textContent = offen.length;
    $("#ez-liste").innerHTML = offen.map(einsatzKarte).join("") || '<p class="muted">Keine laufenden Einsätze.</p>';
    $("#ez-alt").innerHTML = einsaetze.filter((e) => !e.offen).map(einsatzKarte).join("") || '<p class="muted">Keine.</p>';

    einsatzLayer.clearLayers();
    offen.filter((e) => e.position).forEach((ez) => {
      L.marker(ez.position, {
        icon: L.divIcon({ className: "", html: `<div class="ez-marker">#${ez.id} ${esc(ez.stichwort.slice(0, 24))}</div>`, iconAnchor: [14, 12] }),
        zIndexOffset: 500,
      }).bindPopup(`<div class="popup-title">#${ez.id} ${esc(ez.stichwort)}</div>
        ${ez.ort ? `<div class="popup-row">${esc(ez.ort)}</div>` : ""}
        ${ez.bemerkung ? `<div class="popup-row muted">${esc(ez.bemerkung)}</div>` : ""}
        <div class="ez-fz">${alarmChips(ez)}</div>
        ${rechte && rechte.disponent ? `<button type="button" class="btn-ghost copy" data-ez-edit="${ez.id}">Bearbeiten / Alarmieren</button>` : ""}`)
        .addTo(einsatzLayer);
    });
    renderNotrufe();
  }

  function openEinsatzDialog(ez, vorlage = {}) {
    if (!ez && !(rechte && rechte.disponent)) return;
    ezBearbeiten = ez;
    ezVorlage = { position: ez ? ez.position || null : null, notrufNr: undefined, ...vorlage };
    $("#ez-title").textContent = ez ? `Einsatz #${ez.id} bearbeiten` : "Neuer Einsatz";
    $("#ez-save").textContent = ez ? "Speichern & alarmieren" : "Einsatz anlegen & alarmieren";
    $("#ez-stichwort").value = ez ? ez.stichwort : vorlage.stichwort || "";
    $("#ez-ort").value = ez ? ez.ort || "" : vorlage.ort || "";
    $("#ez-bemerkung").value = ez ? ez.bemerkung || "" : vorlage.bemerkung || "";
    $("#ez-error").hidden = true;

    const alarmiert = new Set(ez ? ez.alarmiert.map((a) => a.fahrzeugId) : []);
    const woanders = (f) => einsaetze.find((e) => e.offen && (!ez || e.id !== ez.id) && e.alarmiert.some((a) => a.fahrzeugId === f.id));
    $("#ez-fahrzeuge").innerHTML = Object.values(wachen).filter((w) => w.typ === "wache").map((w) => {
      const liste = fahrzeuge.filter((f) => f.wache === w.id);
      if (!liste.length) return "";
      return `<h3>${esc(w.name)}</h3>` + liste.map((f) => {
        const anderer = woanders(f);
        return `<label><input type="checkbox" value="${esc(f.id)}"${alarmiert.has(f.id) ? " checked" : ""}>
          <span class="fms" style="background:${fmsColor(f.status)}">${esc(f.status)}</span>${esc(f.rufname)} · ${esc(f.typ)}
          ${anderer ? `<small>im Einsatz #${anderer.id}</small>` : ""}</label>`;
      }).join("");
    }).join("") || '<p class="muted small">Noch keine Fahrzeuge eingetragen.</p>';

    renderEinsatzPos();
    $("#ez-dialog").showModal();
    $("#ez-stichwort").focus();
  }

  function renderEinsatzPos() {
    const p = ezVorlage.position;
    $("#ez-pos").textContent = p ? `Position gesetzt${naechsterBereich(p)}` : "Keine Position – Einsatz erscheint nicht auf der Karte";
  }

  async function speichereEinsatz(e) {
    e.preventDefault();
    const gewaehlt = [...document.querySelectorAll("#ez-fahrzeuge input:checked")].map((i) => i.value);
    const daten = {
      stichwort: $("#ez-stichwort").value.trim(),
      ort: $("#ez-ort").value.trim(),
      bemerkung: $("#ez-bemerkung").value.trim(),
      position: ezVorlage.position,
    };
    $("#ez-save").disabled = true;
    try {
      if (ezBearbeiten) {
        const vorher = ezBearbeiten.alarmiert.map((a) => a.fahrzeugId);
        await DispoAuth.api(`/api/einsaetze/${ezBearbeiten.id}`, { method: "PUT", body: daten });
        const hinzufuegen = gewaehlt.filter((id) => !vorher.includes(id));
        const entfernen = vorher.filter((id) => !gewaehlt.includes(id));
        if (hinzufuegen.length || entfernen.length) {
          await DispoAuth.api(`/api/einsaetze/${ezBearbeiten.id}/alarm`, { method: "POST", body: { hinzufuegen, entfernen } });
        }
      } else {
        await DispoAuth.api("/api/einsaetze", {
          method: "POST",
          body: { ...daten, fahrzeuge: gewaehlt, notrufNr: ezVorlage.notrufNr },
        });
      }
      $("#ez-dialog").close();
      await refresh();
    } catch (err) {
      zeigeFehler("#ez-error", err);
    } finally {
      $("#ez-save").disabled = false;
    }
  }

  function fmtUhr(iso) {
    return iso ? new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" }) : "";
  }

  // ---------- ER:LC live: Feuerwehr-Spieler & Notrufe ----------

  const KARTE = 5355 / 256; // Kartenbild in Pixeln / Leaflet-Einheiten
  const spielerLayer = L.layerGroup();
  const notrufLayer = L.layerGroup();
  let live = null;
  let postleitzahlen = {};
  let umrechnung = null;

  async function startLive() {
    try {
      postleitzahlen = await loadJson("data/postleitzahlen.json");
    } catch {
      postleitzahlen = {};
    }
    $("#toggle-spieler").addEventListener("change", (e) => (e.target.checked ? spielerLayer.addTo(map) : spielerLayer.remove()));
    $("#toggle-notrufe").addEventListener("change", (e) => (e.target.checked ? notrufLayer.addTo(map) : notrufLayer.remove()));
    spielerLayer.addTo(map);
    notrufLayer.addTo(map);
    await ladeLive();
    if (live && live.aktiv) setInterval(() => !document.hidden && ladeLive(), (cfg.liveSeconds || 5) * 1000);
  }

  async function ladeLive() {
    try {
      live = await DispoAuth.api("/api/live");
    } catch (err) {
      live = { aktiv: true, fehler: err.message };
    }
    if (!live.aktiv) return;
    $("#live-optionen").hidden = false;
    umrechnung = cfg.prcKalibrierung || kalibrieren(live.kalibrierung || []);
    renderLive();
  }

  // Bestimmt Maßstab und Mittelpunkt aus der mittleren Spielerposition je
  // Postleitzahl und der Lage der Postleitzahlen auf der Karte (lineare
  // Regression, gleicher Maßstab für X und Z). Jede Postleitzahl zählt gleich
  // viel – sonst zieht ein Spieler, der lange an einer Stelle steht, alles zu
  // sich –, und Ausreißer werden aussortiert.
  const KALIB_MIN_PUNKTE = 4;
  const KALIB_MIN_STREUUNG = 500; // Pixel: Orte müssen über die Karte verteilt sein

  function kalibrieren(werte) {
    let pkt = werte
      .filter((w) => postleitzahlen[w.postal] && Number.isFinite(w.x) && Number.isFinite(w.z))
      .map((w) => {
        const [lat, lng] = postleitzahlen[w.postal];
        return { X: w.x, Z: w.z, P: lng * KARTE, Q: -lat * KARTE };
      });
    if (pkt.length < KALIB_MIN_PUNKTE) return { fehlt: KALIB_MIN_PUNKTE - pkt.length };

    // Ausreißer: jeden Ort gegen eine Umrechnung ohne ihn prüfen (leave-one-out)
    // und den schlimmsten entfernen, solange er deutlich aus der Reihe fällt.
    for (let runde = 0; runde < 3 && pkt.length > KALIB_MIN_PUNKTE; runde++) {
      const abw = pkt.map((p, i) => {
        const ohne = regression(pkt.filter((_, j) => j !== i));
        return ohne ? Math.hypot(ohne.cx + ohne.s * p.X - p.P, ohne.cz + ohne.s * p.Z - p.Q) : 0;
      });
      const schlimmster = abw.indexOf(Math.max(...abw));
      const ohne = pkt.filter((_, i) => i !== schlimmster);
      const fitOhne = regression(ohne);
      // Nur entfernen, wenn der Rest ohne ihn gut zusammenpasst und er klar danebenliegt
      if (!fitOhne || abw[schlimmster] <= Math.max(3 * fitOhne.fehler, 150)) break;
      pkt = ohne;
    }
    const fit = regression(pkt);
    if (!fit) return { fehlt: 1 };
    if (fit.streuung < KALIB_MIN_STREUUNG) return { fehlt: 1, streuung: true };
    return fit;
  }

  function regression(pkt) {
    const n = pkt.length;
    const mw = (k) => pkt.reduce((s, p) => s + p[k], 0) / n;
    const [mX, mZ, mP, mQ] = ["X", "Z", "P", "Q"].map(mw);
    let zaehler = 0, nenner = 0, streuung = 0;
    for (const p of pkt) {
      zaehler += (p.X - mX) * (p.P - mP) + (p.Z - mZ) * (p.Q - mQ);
      nenner += (p.X - mX) ** 2 + (p.Z - mZ) ** 2;
      streuung += (p.P - mP) ** 2 + (p.Q - mQ) ** 2;
    }
    const s = zaehler / nenner;
    if (!(s > 0) || !Number.isFinite(s)) return null;
    const cx = mP - s * mX, cz = mQ - s * mZ;
    const fehler = Math.sqrt(pkt.reduce((t, p) => t + (cx + s * p.X - p.P) ** 2 + (cz + s * p.Z - p.Q) ** 2, 0) / n);
    return { s, cx, cz, punkte: n, streuung: Math.sqrt(streuung / n), fehler };
  }

  function spielZuKarte(x, z) {
    if (!umrechnung || !umrechnung.s || !Number.isFinite(x) || !Number.isFinite(z)) return null;
    const px = umrechnung.cx + umrechnung.s * x;
    const py = umrechnung.cz + umrechnung.s * z;
    return [-py / KARTE, px / KARTE];
  }

  function renderLive() {
    const info = $("#live-info");
    info.hidden = false;
    info.className = "live-info small";
    if (live.fehler) {
      info.classList.add("warn");
      info.textContent = live.fehler.startsWith("ER:LC") ? live.fehler : "ER:LC: " + live.fehler;
    } else if (!umrechnung || !umrechnung.s) {
      info.classList.add("warn");
      const anzahl = live.server.spieler != null ? `${live.server.spieler} Spieler · ` : "";
      const rest = !umrechnung ? "" : umrechnung.streuung
        ? " (Spieler an weiter entfernten Orten nötig)"
        : ` (noch ${umrechnung.fehlt} Postleitzahl(en))`;
      info.textContent = `ER:LC: ${anzahl}${live.server.feuerwehr} Feuerwehr · Karte wird kalibriert${rest}`;
    } else {
      info.classList.add("ok");
      info.textContent = `ER:LC: ${live.server.spieler}${live.server.max ? "/" + live.server.max : ""} Spieler · ${live.server.feuerwehr} Feuerwehr`;
      if (umrechnung.punkte) info.title = `Kalibriert über ${umrechnung.punkte} Postleitzahlen, mittlere Abweichung ca. ${Math.round(umrechnung.fehler)} px`;
    }

    spielerLayer.clearLayers();
    (live.spieler || []).forEach((p) => {
      const pos = spielZuKarte(p.x, p.z);
      if (!pos) return;
      const ort = [p.hausnr, p.strasse].filter(Boolean).join(" ") + (p.postal ? ` (Postal ${p.postal})` : "");
      L.marker(pos, {
        icon: L.divIcon({ className: "", html: '<div class="spieler-dot"></div>', iconSize: [12, 12], iconAnchor: [6, 6] }),
        zIndexOffset: 300,
      })
        .bindTooltip(`${esc(p.name)}${p.callsign ? " · " + esc(p.callsign) : ""}`, { direction: "top", offset: [0, -6] })
        .bindPopup(`<div class="popup-title">${esc(p.name)}</div>
          ${p.callsign ? `<div class="popup-row">Callsign: ${esc(p.callsign)}</div>` : ""}
          ${ort.trim() ? `<div class="popup-row muted">${esc(ort.trim())}</div>` : ""}
          ${rechte && (rechte.disponent || rechte.wachleiter || rechte.hoehererDienst)
            ? `<div class="popup-row muted small">API: X ${Math.round(p.x)}, Z ${Math.round(p.z)}</div>` : ""}`)
        .addTo(spielerLayer);
    });
    renderNotrufe();
  }

  function renderNotrufe() {
    if (!live || !live.aktiv) return;
    const notrufe = live.notrufe || [];
    const uebernommen = (nr) => einsaetze.find((e) => e.offen && e.notrufNr === nr);
    const darf = rechte && rechte.disponent;

    $("#notruf-box").hidden = !notrufe.length;
    $("#notruf-liste").innerHTML = notrufe.map((c) => {
      const ez = uebernommen(c.nr);
      return `<div class="notruf"><div class="grow">
          <div><b>Notruf ${esc(c.nr)}</b> <span class="muted small">${fmtSeit(c.seit)}</span></div>
          <div>${esc(c.beschreibung || "ohne Beschreibung")}</div>
          ${c.ort ? `<div class="muted small">${esc(c.ort)}</div>` : ""}
        </div>
        ${ez ? `<span class="muted small">→ Einsatz #${ez.id}</span>`
             : darf ? `<button type="button" class="btn-ghost" data-notruf-liste="${esc(c.nr)}">Einsatz anlegen</button>` : ""}
      </div>`;
    }).join("");
    $("#notruf-liste").querySelectorAll("[data-notruf-liste]").forEach((b) =>
      b.addEventListener("click", () => einsatzAusNotruf(Number(b.dataset.notrufListe)))
    );

    notrufLayer.clearLayers();
    notrufe.forEach((c) => {
      const pos = spielZuKarte(c.x, c.z);
      if (!pos || uebernommen(c.nr)) return;
      L.marker(pos, {
        icon: L.divIcon({ className: "", html: `<div class="notruf-marker">${esc(c.nr)}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
        zIndexOffset: 600,
      }).bindPopup(`<div class="popup-title">Notruf ${esc(c.nr)}</div>
        <div class="popup-row">${esc(c.beschreibung || "ohne Beschreibung")}</div>
        ${c.ort ? `<div class="popup-row muted">${esc(c.ort)}</div>` : ""}
        <div class="popup-row muted">${fmtSeit(c.seit)}</div>
        ${rechte && (rechte.disponent || rechte.wachleiter || rechte.hoehererDienst)
          ? `<div class="popup-row muted small">API: Position ${esc(JSON.stringify(c.roh ?? [c.x, c.z]))}${umrechnung && umrechnung.punkte ? ` · kalibriert über ${umrechnung.punkte} Orte, s=${umrechnung.s.toFixed(3)}` : ""}</div>` : ""}
        ${darf ? `<button type="button" class="btn-ghost copy" data-notruf="${esc(c.nr)}">Einsatz anlegen</button>` : ""}`)
        .addTo(notrufLayer);
    });
  }

  function einsatzAusNotruf(nr) {
    const c = (live && live.notrufe || []).find((x) => x.nr === nr);
    if (!c) return;
    const pos = spielZuKarte(c.x, c.z);
    map.closePopup();
    openEinsatzDialog(null, {
      ort: c.ort,
      bemerkung: c.beschreibung ? `Notruf ${c.nr}: ${c.beschreibung}` : `Notruf ${c.nr}`,
      position: pos ? [Number(pos[0].toFixed(3)), Number(pos[1].toFixed(3))] : null,
      notrufNr: c.nr,
    });
  }

  function fmtSeit(t) {
    if (!t) return "";
    const ms = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
    if (!Number.isFinite(ms)) return "";
    const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return min < 1 ? "gerade eben" : `vor ${min} min`;
  }

  // ---------- Mein Fahrzeug ----------

  let meinFahrzeug = null;

  function initMeinFahrzeug() {
    $("#mein-buttons").innerHTML = Object.entries(FMS)
      .map(([n, s]) => `<button type="button" data-n="${n}" style="--c:${s.farbe}" title="${esc(s.text)}">${n}<span>${esc(s.kurz || s.text)}</span></button>`)
      .join("");
    $("#mein-buttons").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-n]");
      if (!b || !meinFahrzeug) return;
      const status = Number(b.dataset.n);
      const f = meinFahrzeug;
      // 1/2 = frei: Einsatztext und Position zurücksetzen, sonst beibehalten
      const frei = status === 1 || status === 2;
      $("#mein-buttons").querySelectorAll("button").forEach((x) => (x.disabled = true));
      try {
        await DispoAuth.api(`/api/fahrzeuge/${encodeURIComponent(f.id)}/status`, {
          method: "POST",
          body: { status, einsatz: frei ? "" : f.einsatz || "", position: frei ? null : f.position || null },
        });
        $("#mein-error").hidden = true;
        await refresh();
      } catch (err) {
        zeigeFehler("#mein-error", err);
      } finally {
        $("#mein-buttons").querySelectorAll("button").forEach((x) => (x.disabled = false));
      }
    });
    $("#mein-details").addEventListener("click", () => meinFahrzeug && openStatusDialog(meinFahrzeug));
    $("#mein-alarm").addEventListener("click", (e) => {
      const b = e.target.closest("[data-uebernehmen]");
      const ez = b && einsaetze.find((x) => x.id === Number(b.dataset.uebernehmen));
      if (!ez || !meinFahrzeug) return;
      openStatusDialog(meinFahrzeug, {
        einsatz: [ez.stichwort, ez.ort].filter(Boolean).join(" – "),
        position: ez.position || meinFahrzeug.position || null,
      });
    });
  }

  function renderMeinFahrzeug() {
    const istMeins = (f) => (f.fzf && f.fzf.userId === meId) || (f.besatzung || []).some((p) => p.userId === meId);
    meinFahrzeug = meId ? fahrzeuge.find(istMeins) || null : null;
    $("#mein-fahrzeug").hidden = !meinFahrzeug;
    if (!meinFahrzeug) return;
    const f = meinFahrzeug;
    const ich = f.fzf && f.fzf.userId === meId ? null : (f.besatzung || []).find((p) => p.userId === meId);
    $("#mein-rolle").textContent = ich ? ich.funktion || "Besatzung" : "Fahrzeugführer";
    $("#mein-rufname").textContent = `${f.rufname} · ${f.typ}`;
    $("#mein-status").textContent = f.status;
    $("#mein-status").style.background = fmsColor(f.status);
    $("#mein-status").title = fmsText(f.status);
    $("#mein-buttons").querySelectorAll("[data-n]").forEach((b) => b.setAttribute("aria-pressed", Number(b.dataset.n) === f.status));

    const alarme = offeneAlarme(f.id);
    $("#mein-alarm").hidden = !alarme.length;
    $("#mein-alarm").innerHTML = alarme.map((ez) => `
      <div><b>ALARM #${ez.id}: ${esc(ez.stichwort)}</b></div>
      ${ez.ort ? `<div>${esc(ez.ort)}</div>` : ""}
      ${ez.bemerkung ? `<div class="muted">${esc(ez.bemerkung)}</div>` : ""}
      <div class="muted small">Alarmiert ${fmtUhr((ez.alarmiert.find((a) => a.fahrzeugId === f.id) || {}).alarmiertAm)} von ${esc(ez.erstelltVon || "Leitstelle")} – Status bitte selbst setzen (3 = übernommen).</div>
      <button type="button" class="btn-primary" data-uebernehmen="${ez.id}">Einsatzdaten übernehmen …</button>`).join("");
  }

  // ---------- Verwaltung: Dienst & Fahrzeuge ----------

  function initVerwaltung() {
    $("#tab-btn-verwaltung").hidden = false;
    $("#dienst-box").hidden = !rechte.wachleiter;
    $("#dienst-btn").addEventListener("click", async () => {
      $("#dienst-btn").disabled = true;
      try {
        rechte = await DispoAuth.api("/api/dienst", { method: "POST", body: { aktiv: !rechte.imDienst } });
        await renderVerwaltung();
      } catch (err) {
        zeigeFehler("#vw-error", err);
      } finally {
        $("#dienst-btn").disabled = false;
      }
    });

    $("#vw-wache").innerHTML = Object.values(wachen)
      .filter((w) => w.typ === "wache")
      .map((w) => `<option value="${esc(w.id)}">${esc(w.name)}</option>`)
      .join("");

    $("#vw-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const rufname = $("#vw-rufname").value.trim();
      const id = $("#vw-id").value || slug(rufname);
      try {
        await DispoAuth.api(`/api/fahrzeuge/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: { rufname, typ: $("#vw-typ").value.trim(), wache: $("#vw-wache").value },
        });
        formLeeren();
        await refresh();
      } catch (err) {
        zeigeFehler("#vw-error", err);
      }
    });
    $("#vw-reset").addEventListener("click", formLeeren);

    $("#vw-liste").addEventListener("click", async (e) => {
      const crew = e.target.closest("[data-crew]");
      if (crew) openCrewDialog(fahrzeuge.find((x) => x.id === crew.dataset.crew));
      const edit = e.target.closest("[data-edit]");
      const del = e.target.closest("[data-del]");
      if (edit) {
        const f = fahrzeuge.find((x) => x.id === edit.dataset.edit);
        $("#vw-id").value = f.id;
        $("#vw-rufname").value = f.rufname;
        $("#vw-typ").value = f.typ;
        $("#vw-wache").value = f.wache;
        $("#vw-submit").textContent = "Änderungen speichern";
        $("#vw-reset").hidden = false;
        $("#vw-rufname").focus();
      }
      if (del) {
        const f = fahrzeuge.find((x) => x.id === del.dataset.del);
        if (!f || !confirm(`${f.rufname} wirklich löschen?`)) return;
        try {
          await DispoAuth.api(`/api/fahrzeuge/${encodeURIComponent(f.id)}`, { method: "DELETE" });
          await refresh();
        } catch (err) {
          zeigeFehler("#vw-error", err);
        }
      }
    });

    $("#vw-import").addEventListener("click", async () => {
      if (!confirm("Die Fahrzeuge aus data/fahrzeuge.json übernehmen?")) return;
      try {
        const data = await loadJson("data/fahrzeuge.json");
        for (const f of data.fahrzeuge || []) {
          await DispoAuth.api(`/api/fahrzeuge/${encodeURIComponent(f.id)}`, {
            method: "PUT",
            body: { rufname: f.rufname, typ: f.typ, wache: f.wache },
          });
        }
        await refresh();
      } catch (err) {
        zeigeFehler("#vw-error", err);
      }
    });

    initCrewDialog();
    initAktivitaet();
    renderVerwaltung();
  }

  async function renderVerwaltung() {
    $("#vw-error").hidden = true;
    if (rechte.wachleiter) {
      $("#dienst-text").textContent = rechte.imDienst ? "Du bist im Dienst." : "Du bist nicht im Dienst.";
      $("#dienst-btn").textContent = rechte.imDienst ? "Dienst beenden" : "In den Dienst melden";
      $("#dienst-btn").classList.toggle("btn-primary", !rechte.imDienst);
    }
    try {
      const { imDienst } = await DispoAuth.api("/api/dienst");
      $("#dienst-liste").innerHTML = imDienst.length
        ? imDienst.map((d) => `<li>${esc(d.name)} <span class="muted small">seit ${new Date(d.seit).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}</span></li>`).join("")
        : '<li class="muted">Niemand</li>';
    } catch (err) {
      zeigeFehler("#vw-error", err);
    }
    $("#vw-gesperrt").hidden = rechte.verwaltung;
    $("#vw-bereich").hidden = !rechte.verwaltung;
    if (rechte.verwaltung) renderVerwaltungListe();
  }

  function renderVerwaltungListe() {
    $("#vw-import").hidden = fahrzeuge.length > 0;
    $("#vw-liste").innerHTML =
      stationGroups(fahrzeuge, (f) =>
        `<div class="item">
          <span class="fms" style="background:${fmsColor(f.status)}">${esc(f.status)}</span>
          <span class="grow"><div class="title">${esc(f.rufname)}</div><div class="sub">${esc(f.typ)}${f.geaendertVon ? " · zuletzt " + esc(f.geaendertVon) : ""}</div>${crewKurz(f) ? `<div class="crew">${esc(crewKurz(f))}</div>` : ""}</span>
          <span class="actions">
            <button type="button" class="btn-ghost" data-crew="${esc(f.id)}" aria-label="Besatzung von ${esc(f.rufname)}">Besatzung</button>
            <button type="button" class="btn-ghost" data-edit="${esc(f.id)}" aria-label="${esc(f.rufname)} bearbeiten">Bearbeiten</button>
            <button type="button" class="btn-ghost btn-danger" data-del="${esc(f.id)}" aria-label="${esc(f.rufname)} löschen">Löschen</button>
          </span>
        </div>`
      ) || '<p class="muted">Noch keine Fahrzeuge eingetragen.</p>';
  }

  function formLeeren() {
    $("#vw-form").reset();
    $("#vw-id").value = "";
    $("#vw-submit").textContent = "Fahrzeug eintragen";
    $("#vw-reset").hidden = true;
  }

  // ---------- Aktivität ----------

  let aktDaten = null;
  let aktSort = { key: "fahrzeugMs", desc: true };

  const AKT_AKTIONEN = { status: "Status", fahrzeug: "Fahrzeug", besatzung: "Besatzung", dienst: "Dienst", einsatz: "Einsatz" };

  function initAktivitaet() {
    $("#akt-btn").addEventListener("click", () => {
      $("#akt-dialog").showModal();
      ladeAktivitaet();
    });
    $("#akt-close").addEventListener("click", () => $("#akt-dialog").close());
    $("#akt-zeitraum").addEventListener("change", ladeAktivitaet);
    document.querySelectorAll("#akt-dialog [data-sort]").forEach((b) =>
      b.addEventListener("click", () => {
        const key = b.dataset.sort;
        aktSort = { key, desc: aktSort.key === key ? !aktSort.desc : !["name", "aktuellAuf", "zuletztZugeteiltVon"].includes(key) };
        renderAktivitaet();
      })
    );
    $("#akt-csv").addEventListener("click", () => aktDaten && csvRangliste());
    $("#akt-csv-zut").addEventListener("click", () => aktDaten && csvZuteilungen());
  }

  async function ladeAktivitaet() {
    $("#akt-error").hidden = true;
    $("#akt-body").innerHTML = '<tr><td colspan="10" class="leer">Lädt …</td></tr>';
    try {
      aktDaten = await DispoAuth.api("/api/aktivitaet?tage=" + $("#akt-zeitraum").value);
      renderAktivitaet();
    } catch (err) {
      aktDaten = null;
      $("#akt-body").innerHTML = "";
      zeigeFehler("#akt-error", err);
    }
  }

  function renderAktivitaet() {
    document.querySelectorAll("#akt-dialog [data-sort]").forEach((b) => {
      if (b.dataset.sort === aktSort.key) b.setAttribute("aria-sort", aktSort.desc ? "descending" : "ascending");
      else b.removeAttribute("aria-sort");
    });
    const { key, desc } = aktSort;
    const personen = [...aktDaten.personen].sort((a, b) => {
      const x = a[key] ?? "", y = b[key] ?? "";
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "de");
      return desc ? -c : c;
    });
    const leer = '<span class="leer">–</span>';
    $("#akt-body").innerHTML = personen.length
      ? personen.map((p) => `<tr>
          <td>${esc(p.name)}</td>
          <td class="num">${p.fahrzeugMs ? fmtDauer(p.fahrzeugMs) : leer}</td>
          <td class="num">${p.fzfMs ? fmtDauer(p.fzfMs) : leer}</td>
          <td class="num">${p.zuteilungen || leer}</td>
          <td>${p.aktuellAuf ? esc(p.aktuellAuf) : leer}</td>
          <td>${p.zuletztZugeteiltVon ? esc(p.zuletztZugeteiltVon) : leer}</td>
          <td class="num">${p.dienstMs ? fmtDauer(p.dienstMs) : leer}</td>
          <td class="num">${p.statusMeldungen || leer}</td>
          <td class="num">${p.verwaltung || leer}</td>
          <td>${p.zuletztAktiv ? fmtZeit(p.zuletztAktiv) : leer}</td>
        </tr>`).join("")
      : '<tr><td colspan="10" class="leer">In diesem Zeitraum gibt es noch keine Aktivität.</td></tr>';

    $("#akt-log").innerHTML = aktDaten.protokoll.length
      ? aktDaten.protokoll.map((e) =>
          `<li><time datetime="${esc(e.zeit)}">${fmtZeit(e.zeit)}</time><b>${esc(e.name)}</b> · ${esc(AKT_AKTIONEN[e.aktion] || e.aktion)}: ${esc(e.details)}</li>`
        ).join("")
      : '<li class="muted">Noch keine Aktionen.</li>';
  }

  function fmtDauer(ms) {
    const min = Math.round(ms / 60000);
    const h = Math.floor(min / 60);
    return h ? `${h} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`;
  }

  function fmtZeit(iso) {
    return new Date(iso).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  const stunden = (ms) => (ms / 3600000).toFixed(2).replace(".", ",");

  function csvRangliste() {
    const kopf = ["Name", "Discord-ID", "Zeit auf Fahrzeugen (Std.)", "davon FzF (Std.)", "Zuteilungen", "Aktuell auf",
      "Zuletzt zugeteilt von", "Dienst als Wachleiter (Std.)", "Statusmeldungen", "Verwaltungsaktionen", "Zuletzt aktiv"];
    const zeilen = aktDaten.personen.map((p) => [
      p.name, p.userId || "", stunden(p.fahrzeugMs), stunden(p.fzfMs), p.zuteilungen, p.aktuellAuf || "",
      p.zuletztZugeteiltVon || "", stunden(p.dienstMs), p.statusMeldungen, p.verwaltung,
      p.zuletztAktiv ? new Date(p.zuletztAktiv).toLocaleString("de-DE") : "",
    ]);
    csvHerunterladen("aktivitaet", [kopf, ...zeilen]);
  }

  function csvZuteilungen() {
    const kopf = ["Name", "Discord-ID", "Fahrzeug", "Rolle", "Von", "Bis", "Dauer (Std.)", "Zugeteilt von", "Ausgetragen von"];
    const zeilen = aktDaten.zuteilungen.map((z) => [
      z.name, z.userId || "", z.rufname || "", z.rolle || "",
      new Date(z.von).toLocaleString("de-DE"), z.bis ? new Date(z.bis).toLocaleString("de-DE") : "noch zugeteilt",
      stunden((z.bis ? Date.parse(z.bis) : Date.now()) - Date.parse(z.von)), z.zugeteiltVon || "", z.ausgetragenVon || "",
    ]);
    csvHerunterladen("zuteilungen", [kopf, ...zeilen]);
  }

  // Semikolon + BOM, damit Excel (deutsch) Umlaute und Spalten richtig erkennt.
  function csvHerunterladen(name, zeilen) {
    const zelle = (v) => {
      let s = String(v ?? "");
      if (/^[=+\-@]/.test(s)) s = "'" + s; // keine Formeln in Excel ausführen
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const inhalt = "\ufeff" + zeilen.map((z) => z.map(zelle).join(";")).join("\r\n");
    const zeitraum = { 7: "7-tage", 30: "30-tage", 0: "gesamt" }[$("#akt-zeitraum").value];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([inhalt], { type: "text/csv;charset=utf-8" }));
    a.download = `${name}_${zeitraum}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------- Besatzung zuteilen ----------

  let crewFahrzeug = null;
  let mitgliederListe = null; // [{ userId, name, fzf }] – null = noch nicht geladen

  function initCrewDialog() {
    $("#cd-add").addEventListener("click", () => crewZeile());
    $("#cd-leeren").addEventListener("click", () => {
      $("#cd-fzf").value = "";
      $("#cd-liste").innerHTML = "";
    });
    $("#cd-cancel").addEventListener("click", () => $("#crew-dialog").close());
    $("#cd-liste").addEventListener("click", (e) => {
      const b = e.target.closest("[data-entfernen]");
      if (b) b.closest(".cd-row").remove();
    });
    $("#crew-dialog").addEventListener("submit", async (e) => {
      e.preventDefault();
      const fzf = personAus($("#cd-fzf"));
      const besatzung = [...document.querySelectorAll("#cd-liste .cd-row")]
        .map((row) => {
          const p = personAus(row.querySelector("input"));
          return p && { ...p, funktion: row.querySelector("select").value || undefined };
        })
        .filter(Boolean);
      const namen = [fzf, ...besatzung].filter(Boolean).map((p) => p.userId || p.name.toLowerCase());
      if (new Set(namen).size !== namen.length) {
        return zeigeFehler("#cd-error", new Error("Eine Person ist doppelt eingetragen."));
      }
      $("#cd-save").disabled = true;
      try {
        await DispoAuth.api(`/api/fahrzeuge/${encodeURIComponent(crewFahrzeug.id)}/besatzung`, {
          method: "PUT",
          body: { fzf, besatzung },
        });
        $("#crew-dialog").close();
        await refresh();
      } catch (err) {
        zeigeFehler("#cd-error", err);
      } finally {
        $("#cd-save").disabled = false;
      }
    });
  }

  async function openCrewDialog(f) {
    if (!f) return;
    crewFahrzeug = f;
    $("#cd-title").textContent = f.rufname;
    $("#cd-sub").textContent = `${f.typ} · Besatzung zuteilen`;
    $("#cd-error").hidden = true;
    merke($("#cd-fzf"), f.fzf);
    $("#cd-liste").innerHTML = "";
    (f.besatzung || []).forEach((p) => crewZeile(p));
    $("#crew-dialog").showModal();

    try {
      if (!mitgliederListe) mitgliederListe = (await DispoAuth.api("/api/mitglieder")).mitglieder;
      $("#cd-hinweis").hidden = true;
    } catch (err) {
      mitgliederListe = [];
      $("#cd-hinweis").textContent = err.message + " Namen können trotzdem frei eingetippt werden.";
      $("#cd-hinweis").hidden = false;
    }
    fuelleOptionen();
  }

  // Vorschläge: wer schon auf einem anderen Fahrzeug sitzt, wird dazugeschrieben.
  function fuelleOptionen() {
    const sitztAuf = {};
    fahrzeuge.forEach((f) => {
      if (f.id === crewFahrzeug.id) return;
      [f.fzf, ...(f.besatzung || [])].forEach((p) => p && p.userId && (sitztAuf[p.userId] = f.rufname));
    });
    const option = (m) =>
      `<option value="${esc(m.name)}">${sitztAuf[m.userId] ? "sitzt auf " + esc(sitztAuf[m.userId]) : ""}</option>`;
    const fzfKandidaten = mitgliederListe.filter((m) => m.fzf);
    $("#cd-fzf-optionen").innerHTML = (fzfKandidaten.length ? fzfKandidaten : mitgliederListe).map(option).join("");
    $("#cd-optionen").innerHTML = mitgliederListe.map(option).join("");
  }

  function crewZeile(p = {}) {
    const row = document.createElement("div");
    row.className = "cd-row";
    row.innerHTML = `
      <input list="cd-optionen" maxlength="40" placeholder="Name" aria-label="Name" autocomplete="off" value="${esc(p.name || "")}">
      <select aria-label="Funktion"><option value="">Funktion …</option>${FUNKTIONEN.map((fn) => `<option${fn === p.funktion ? " selected" : ""}>${esc(fn)}</option>`).join("")}</select>
      <button type="button" class="btn-ghost" data-entfernen aria-label="Person entfernen">✕</button>`;
    $("#cd-liste").appendChild(row);
    merke(row.querySelector("input"), p);
    if (!p.name) row.querySelector("input").focus();
  }

  // Merkt sich die bisherige Person am Eingabefeld, damit ihre Discord-ID
  // erhalten bleibt, auch wenn die Mitgliederliste nicht geladen werden kann.
  function merke(input, p) {
    input.value = p && p.name ? p.name : "";
    input.dataset.name = input.value;
    input.dataset.userId = (p && p.userId) || "";
  }

  // Eingabefeld → Person; bekannte Mitglieder werden mit Discord-ID gespeichert.
  function personAus(input) {
    const name = input.value.trim();
    if (!name) return null;
    const m = (mitgliederListe || []).find((x) => x.name === name);
    if (m) return { userId: m.userId, name: m.name };
    if (name === input.dataset.name && input.dataset.userId) return { userId: input.dataset.userId, name };
    return { name };
  }

  function slug(s) {
    return s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "fahrzeug-" + Date.now();
  }

  function zeigeFehler(sel, err) {
    $(sel).textContent = err.message;
    $(sel).hidden = false;
  }

  start();
})();
