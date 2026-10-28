(function () {
  const cfg = window.DISPO_CONFIG;
  const FMS = window.FMS_STATUS;
  const $ = (s) => document.querySelector(s);

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const fmsColor = (s) => (FMS[s] || { farbe: "#7C838D" }).farbe;
  const fmsText = (s) => (FMS[s] || { text: "Unbekannt" }).text;

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
  let rechte = null; // nur mit API: { name, wachleiter, hoehererDienst, imDienst, verwaltung }
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
      ? '<div class="popup-row muted">Auf der Wache:</div>' + list.map((f) => `<div${edit(f)}><span class="fms" style="background:${fmsColor(f.status)};width:20px;height:20px;font-size:11px">${esc(f.status)}</span> ${esc(f.rufname)} · ${esc(f.typ)}</div>`).join("")
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
      $("#stand").textContent = "Stand: " + new Date(data.stand || Date.now()).toLocaleString("de-DE");
    } catch (e) {
      $("#stand").textContent = "Fahrzeugdaten konnten nicht geladen werden";
      return;
    }
    renderVehicles();
    renderVehicleList();
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
    if (mitApi()) initStatusDialog();
    if (rechte && (rechte.wachleiter || rechte.hoehererDienst)) initVerwaltung();
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
          <span class="grow"><div class="title">${esc(f.rufname)}</div><div class="sub">${esc(f.typ)} · ${esc(f.einsatz || fmsText(f.status))}</div></span>
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
      });
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

  function openStatusDialog(f) {
    dialogFahrzeug = f;
    dialogAuswahl = { status: f.status, einsatz: f.einsatz || "", position: f.position || null };
    $("#sd-title").textContent = f.rufname;
    $("#sd-sub").textContent = `${f.typ} · ${wachen[f.wache] ? wachen[f.wache].name : f.wache}`;
    $("#sd-einsatz").value = dialogAuswahl.einsatz;
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

  function startPick(cb) {
    pickCallback = cb;
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
    if (reopen) $("#status-dialog").showModal();
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
          <span class="grow"><div class="title">${esc(f.rufname)}</div><div class="sub">${esc(f.typ)}${f.geaendertVon ? " · zuletzt " + esc(f.geaendertVon) : ""}</div></span>
          <button type="button" class="btn-ghost" data-edit="${esc(f.id)}" aria-label="${esc(f.rufname)} bearbeiten">Bearbeiten</button>
          <button type="button" class="btn-ghost btn-danger" data-del="${esc(f.id)}" aria-label="${esc(f.rufname)} löschen">Löschen</button>
        </div>`
      ) || '<p class="muted">Noch keine Fahrzeuge eingetragen.</p>';
  }

  function formLeeren() {
    $("#vw-form").reset();
    $("#vw-id").value = "";
    $("#vw-submit").textContent = "Fahrzeug eintragen";
    $("#vw-reset").hidden = true;
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
