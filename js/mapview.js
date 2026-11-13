/* =====================================================================
   mapview.js — Leaflet map, base maps, navigation, coordinate display,
   coordinate grid, search and go-to-coordinates.
   ===================================================================== */
"use strict";
(function (SM) {
  const mv = {};
  SM.mapview = mv;
  let baseGroup = null, currentBase = null, gridLayer = null, searchMarker = null;

  mv.init = function (cfg) {
    const view = cfg.defaultView || { center: [25.5941, 85.1376], zoom: 12 };
    const map = L.map("map", {
      center: view.center, zoom: view.zoom, minZoom: 2, maxZoom: 22,
      zoomControl: false, boxZoom: false, doubleClickZoom: true,
      zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90,
      worldCopyJump: true, preferCanvas: false, tapTolerance: 18,
    });
    SM.map = map;
    initRotation(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.control.scale({ position: "bottomleft", metric: true, imperial: true, maxWidth: 160 }).addTo(map);
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');

    buildBasemapMenu(cfg.providers || []);

    // ---- status bar ----
    const stCoords = SM.$("#st-coords");
    let lastLL = null;
    map.on("mousemove", (e) => { lastLL = e.latlng; stCoords.textContent = SM.fmtLatLng(e.latlng.lat, wrapLng(e.latlng.lng)); });
    stCoords.addEventListener("click", () => {
      SM.settings.coordFormat = SM.settings.coordFormat === "dd" ? "dms" : "dd";
      SM.saveSettings();
      if (lastLL) stCoords.textContent = SM.fmtLatLng(lastLL.lat, wrapLng(lastLL.lng));
    });
    const updateView = () => {
      const z = map.getZoom();
      SM.$("#st-zoom").textContent = "Zoom " + z.toFixed(2).replace(/\.?0+$/, "");
      SM.$("#st-scale").textContent = "1:" + niceScale(mv.screenScale());
      if (gridLayer) drawGrid();
    };
    map.on("zoomend moveend", updateView);
    updateView();
    map.on("moveend", SM.debounce(() => {
      const p = SM.state.project;
      if (p) p.viewport = mv.viewport();
    }, 300));
    // Leaflet's own controls live outside the map element so they never rotate with it
    const ctl = SM.el("div", { class: "leaflet-container sm-ctl-layer" });
    ctl.append(map._controlContainer);
    SM.$("#map-wrap").append(ctl);

    // ---- map controls ----
    SM.$("#btn-fit").addEventListener("click", mv.fitAll);
    SM.$("#btn-grid").addEventListener("click", () => mv.toggleGrid());
    SM.$("#btn-fullscreen").addEventListener("click", toggleFullscreen);
    SM.$("#btn-locate").addEventListener("click", locate);
    SM.$("#btn-goto").addEventListener("click", mv.gotoDialog);
    initCompass();
    window.addEventListener("resize", SM.debounce(() => { if (mv.bearing) mv.setBearing(mv.bearing); }, 200));
    document.addEventListener("fullscreenchange", () => setTimeout(() => map.invalidateSize(), 100));
    initSearch();
    return map;
  };

  /* ---------------- map rotation ----------------
     Leaflet cannot rotate, so the whole map element is turned with CSS. When
     rotated it is enlarged to the diagonal of the visible area (so no corners
     are empty) and mouse positions / drag distances are turned back before
     Leaflet sees them. Labels, pins and popups counter-rotate to stay upright. */
  mv.bearing = 0;
  mv.bearingRad = 0;
  // Dragging (map pan, vertex handles, markers): turn the mouse movement back.
  // Installed before any map exists, because Leaflet binds _onDown when dragging is enabled.
  if (!L.Draggable.prototype._smPatched) {
    L.Draggable.prototype._smPatched = true;
    const down = L.Draggable.prototype._onDown, move = L.Draggable.prototype._onMove;
    L.Draggable.prototype._onDown = function (e) {
      down.call(this, e);
      this._smRot = SM.map && mv.bearing && SM.map.getContainer().contains(this._element) ? mv.bearingRad : 0;
      if (this._smRot) this._parentScale = { x: 1, y: 1 };
    };
    L.Draggable.prototype._onMove = function (e) {
      if (!this._smRot || !this._startPoint || (e.touches && e.touches.length > 1)) return move.call(this, e);
      const first = e.touches && e.touches.length === 1 ? e.touches[0] : e;
      const dx = first.clientX - this._startPoint.x, dy = first.clientY - this._startPoint.y;
      const c = Math.cos(this._smRot), s = Math.sin(this._smRot);
      const fake = { clientX: this._startPoint.x + c * dx + s * dy, clientY: this._startPoint.y - s * dx + c * dy, target: e.target, srcElement: e.srcElement, type: e.type, preventDefault: () => e.preventDefault() };
      return move.call(this, fake);
    };
  }
  mv.viewport = () => ({ center: [SM.map.getCenter().lat, SM.map.getCenter().lng], zoom: SM.map.getZoom(), bearing: mv.bearing });
  function unrotate(clientX, clientY, el) {
    const r = el.getBoundingClientRect(), c = Math.cos(mv.bearingRad), s = Math.sin(mv.bearingRad);
    const dx = clientX - (r.left + r.width / 2), dy = clientY - (r.top + r.height / 2);
    return L.point(c * dx + s * dy + el.offsetWidth / 2, -s * dx + c * dy + el.offsetHeight / 2);
  }
  function initRotation(map) {
    const orig = map.mouseEventToContainerPoint;
    map.mouseEventToContainerPoint = function (e) {
      return mv.bearing ? unrotate(e.clientX, e.clientY, this._container) : orig.call(this, e);
    };
  }
  /** Rotate the map (degrees clockwise; 0 = north up). */
  mv.setBearing = function (deg, save) {
    deg = Math.round(((((+deg || 0) % 360) + 540) % 360 - 180) * 10) / 10;
    if (Math.abs(deg) < 0.05) deg = 0;
    const el = SM.$("#map"), wrap = SM.$("#map-wrap"), map = SM.map;
    const center = map.getCenter(), zoom = map.getZoom();
    if (!deg) {
      Object.assign(el.style, { left: "", top: "", width: "", height: "", right: "", bottom: "", transform: "" });
    } else {
      const W = wrap.clientWidth, H = wrap.clientHeight, D = Math.ceil(Math.hypot(W, H)) + 4;
      Object.assign(el.style, { left: (W - D) / 2 + "px", top: (H - D) / 2 + "px", width: D + "px", height: D + "px", right: "auto", bottom: "auto", transform: `rotate(${deg}deg)` });
    }
    el.style.setProperty("--map-rot", deg + "deg");
    mv.bearing = deg;
    mv.bearingRad = (deg * Math.PI) / 180;
    map.invalidateSize({ animate: false, pan: false });
    map.setView(center, zoom, { animate: false });
    const needle = SM.$("#compass-needle");
    if (needle) needle.style.transform = `rotate(${deg}deg)`;
    SM.$("#btn-compass") && SM.$("#btn-compass").classList.toggle("on", !!deg);
    if (SM.$("#rot-input")) { SM.$("#rot-input").value = deg; SM.$("#rot-range").value = deg; }
    if (save && SM.state.project) { SM.state.project.viewport = mv.viewport(); SM.store.markDirty(); }
    SM.bus.emit("bearing", deg);
  };
  /** Padding that keeps a fitted area inside the visible (unrotated) window. */
  mv.fitPadding = function () {
    if (!mv.bearing) return [60, 60];
    const wrap = SM.$("#map-wrap"), D = SM.map.getSize().x, s = Math.min(wrap.clientWidth, wrap.clientHeight) * 0.68;
    const p = Math.max(40, (D - s) / 2);
    return [p, p];
  };
  function initCompass() {
    const btn = SM.$("#btn-compass"), pop = SM.$("#rot-pop");
    if (!btn || !pop) return; // page from an older version still cached
    btn.addEventListener("click", (e) => { e.stopPropagation(); pop.classList.toggle("open"); if (pop.classList.contains("open")) { const r = btn.getBoundingClientRect(); pop.style.top = r.bottom + 6 + "px"; pop.style.left = Math.max(8, r.right - pop.offsetWidth) + "px"; } });
    pop.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => pop.classList.remove("open"));
    const range = SM.$("#rot-range"), inp = SM.$("#rot-input");
    range.addEventListener("input", () => mv.setBearing(+range.value, true));
    inp.addEventListener("change", () => mv.setBearing(+inp.value, true));
    SM.$$("#rot-pop [data-rot]").forEach((b) => b.addEventListener("click", () => {
      const v = b.dataset.rot;
      mv.setBearing(v === "0" ? 0 : mv.bearing + +v, true);
    }));
    SM.$("#rot-align").addEventListener("click", () => {
      const f = SM.store.selected().find((x) => x.geometry.type !== "Point");
      if (!f) { SM.toast("First select a line or shape (e.g. the site boundary or a road)"); return; }
      const c = f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates;
      // longest segment becomes horizontal on screen
      let best = 0, a = c[0], b = c[1];
      for (let i = 1; i < c.length; i++) { const d = SM.geo.distance(c[i - 1], c[i]); if (d > best) { best = d; a = c[i - 1]; b = c[i]; } }
      const pa = SM.xf.toMerc(a[1], a[0]), pb = SM.xf.toMerc(b[1], b[0]);
      let ang = (-Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) * 180) / Math.PI; // screen angle of the segment, clockwise
      let rot = -ang;
      while (rot > 90) rot -= 180;
      while (rot < -90) rot += 180;
      mv.setBearing(rot, true);
      SM.toast(`Map turned ${rot.toFixed(1)}° so the selected edge runs left–right`, "", 2500);
    });
  }

  const wrapLng = (lng) => ((((lng + 180) % 360) + 360) % 360) - 180;
  mv.wrapLng = wrapLng;

  /** Ground metres per CSS pixel at the map centre. */
  mv.metersPerPixel = function (lat, zoom) {
    lat = lat ?? SM.map.getCenter().lat;
    zoom = zoom ?? SM.map.getZoom();
    return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (256 * Math.pow(2, zoom));
  };
  /** Scale denominator of the screen at 96 dpi (CSS px = 0.2646 mm). */
  mv.screenScale = () => mv.metersPerPixel() / 0.00026458333;
  function niceScale(n) {
    if (n > 1e6) return (n / 1e6).toFixed(2) + "M";
    return Math.round(n).toLocaleString("en-IN");
  }

  /* ---------------- base maps ---------------- */
  mv.providers = [];
  let menuAttached = false;
  function buildBasemapMenu(providers) {
    mv.providers = providers;
    const menu = SM.$("#basemap-menu");
    menu.innerHTML = "";
    const kinds = { satellite: "Satellite imagery", street: "Street", terrain: "Terrain" };
    let lastKind = null;
    providers.forEach((p) => {
      if (p.kind !== lastKind) {
        if (lastKind) menu.append(SM.el("hr"));
        menu.append(SM.el("div", { class: "menu-note", style: { padding: "4px 10px", margin: 0 }, text: kinds[p.kind] || p.kind }));
        lastKind = p.kind;
      }
      const b = SM.el("button", { "data-id": p.id, disabled: !p.available, title: p.unavailable_reason || "" }, SM.icon("layers"), p.name);
      b.addEventListener("click", () => mv.setBasemap(p.id, true));
      menu.append(b);
      if (!p.available) menu.append(SM.el("div", { class: "menu-note", text: p.unavailable_reason }));
    });
    if (!menuAttached) { SM.attachMenu(SM.$("#btn-basemap"), menu); menuAttached = true; }
  }
  mv.setProviders = function (providers) {
    buildBasemapMenu(providers);
    mv.setBasemap(currentBase ? currentBase.id : SM.config.defaultBasemap);
  };

  mv.setBasemap = function (id, userAction) {
    const p = mv.providers.find((x) => x.id === id && x.available) || mv.providers.find((x) => x.available);
    if (!p) return;
    if (baseGroup) SM.map.removeLayer(baseGroup);
    baseGroup = L.layerGroup(p.layers.map((l, i) => L.tileLayer(l.url, {
      attribution: l.attribution, maxZoom: l.maxZoom || 22, maxNativeZoom: l.maxNativeZoom || 19,
      subdomains: l.subdomains || "abc", zIndex: i, detectRetina: false, keepBuffer: 3,
    })));
    baseGroup.addTo(SM.map);
    currentBase = p;
    SM.$("#basemap-label").textContent = p.name.replace(/\s*\(.*\)$/, "");
    SM.$$("#basemap-menu button").forEach((b) => b.classList.toggle("active", b.dataset.id === p.id));
    if (SM.state.project && SM.state.project.basemap !== p.id) {
      SM.state.project.basemap = p.id;
      if (userAction) SM.store.markDirty();
    }
  };
  mv.currentBasemap = () => currentBase;

  /* ---------------- fit / locate / fullscreen ---------------- */
  mv.boundsOf = function (feats) {
    let b = null;
    feats.forEach((f) => {
      const g = f.geometry;
      let fb;
      if (f.properties.kind === "circle") {
        const c = g.coordinates, r = f.properties.radius || 0;
        const n = SM.geo.destination(c, 0, r), s = SM.geo.destination(c, 180, r), e = SM.geo.destination(c, 90, r), w = SM.geo.destination(c, 270, r);
        fb = L.latLngBounds([s[1], w[0]], [n[1], e[0]]);
      } else {
        const pts = g.type === "Point" ? [g.coordinates] : g.type === "LineString" ? g.coordinates : g.coordinates[0];
        fb = L.latLngBounds(pts.map((c) => [c[1], c[0]]));
      }
      b = b ? b.extend(fb) : fb;
    });
    return b;
  };
  mv.fitFeatures = function (feats, maxZoom) {
    const b = mv.boundsOf(feats);
    if (!b) return false;
    if (b.getNorthEast().equals(b.getSouthWest())) SM.map.setView(b.getCenter(), Math.max(SM.map.getZoom(), 17));
    else SM.map.fitBounds(b, { padding: mv.fitPadding(), maxZoom: maxZoom || 19 });
    return true;
  };
  mv.fitAll = function () {
    const feats = SM.store.features().filter(SM.store.isVisible);
    if (!mv.fitFeatures(feats)) SM.toast("Nothing to zoom to yet — draw something first");
  };

  function toggleFullscreen() {
    const el = document.documentElement;
    if (!document.fullscreenElement) {
      if (el.requestFullscreen) el.requestFullscreen().catch(() => fallbackFull());
      else fallbackFull();
    } else document.exitFullscreen();
  }
  function fallbackFull() { // iOS Safari: hide panels instead
    SM.$("#left-panel").classList.toggle("collapsed");
    SM.$("#right-panel").classList.toggle("collapsed");
    setTimeout(() => SM.map.invalidateSize(), 250);
  }

  function locate() {
    if (!navigator.geolocation) { SM.toast("Location is not available in this browser", "error"); return; }
    SM.toast("Finding your location…", "", 1500);
    navigator.geolocation.getCurrentPosition(
      (pos) => mv.showPoint(pos.coords.latitude, pos.coords.longitude, 18, `My location (±${Math.round(pos.coords.accuracy)} m)`),
      (err) => SM.toast("Location failed: " + err.message, "error"),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  /** Fly to a point and show a temporary pin with an "Add marker" action. */
  mv.showPoint = function (lat, lng, zoom, title) {
    SM.map.setView([lat, lng], zoom || Math.max(SM.map.getZoom(), 17));
    if (searchMarker) SM.map.removeLayer(searchMarker);
    const div = SM.el("div", {},
      SM.el("b", { text: title || "Location" }), SM.el("br"),
      SM.el("span", { class: "muted", text: SM.fmtLatLng(lat, lng, "dd") }), SM.el("br"),
      SM.el("span", { class: "muted", text: SM.fmtLatLng(lat, lng, "dms") }), SM.el("br"));
    const add = SM.el("button", { class: "mini-btn primary", text: "Add marker here" });
    add.addEventListener("click", () => {
      const f = SM.store.addFeature({ type: "Point", coordinates: [lng, lat] }, "marker", { name: title && title.length < 60 ? title : "" });
      SM.store.select(f.properties.id);
      SM.map.removeLayer(searchMarker); searchMarker = null;
    });
    div.append(add);
    searchMarker = L.marker([lat, lng], { icon: L.divIcon({ className: "", html: '<div class="sm-search-pin"></div>', iconSize: [16, 16], iconAnchor: [8, 8] }), pmIgnore: true, interactive: true })
      .addTo(SM.map).bindPopup(div).openPopup();
    searchMarker.on("popupclose", () => setTimeout(() => { if (searchMarker && !searchMarker.isPopupOpen()) { SM.map.removeLayer(searchMarker); searchMarker = null; } }, 4000));
  };

  mv.gotoDialog = function () {
    const c = SM.map.getCenter();
    const lat = SM.el("input", { class: "field", type: "number", step: "any", value: c.lat.toFixed(6) });
    const lng = SM.el("input", { class: "field", type: "number", step: "any", value: c.lng.toFixed(6) });
    const any = SM.el("input", { class: "field", placeholder: "or paste e.g. 25°35′48″N 85°08′15″E" });
    const zoom = SM.el("input", { class: "field", type: "number", min: 2, max: 22, value: Math.max(17, Math.round(SM.map.getZoom())) });
    const mk = SM.el("input", { type: "checkbox" });
    const body = SM.el("div", { class: "form-grid" },
      SM.el("label", { text: "Latitude (°)" }), lat,
      SM.el("label", { text: "Longitude (°)" }), lng,
      SM.el("label", { text: "Any format" }), any,
      SM.el("label", { text: "Zoom" }), zoom,
      SM.el("label", { text: "" }), SM.el("label", { class: "check" }, mk, "Place a marker"));
    SM.modal({
      title: "Go to coordinates", body,
      buttons: [{ label: "Cancel" }, {
        label: "Go", cls: "primary", action: () => {
          let p = any.value.trim() ? SM.parseLatLng(any.value) : { lat: parseFloat(lat.value), lng: parseFloat(lng.value) };
          if (!p || !isFinite(p.lat) || !isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) { SM.toast("Enter a valid latitude (−90…90) and longitude (−180…180)", "error"); return false; }
          const z = SM.clamp(parseFloat(zoom.value) || 17, 2, 22);
          if (mk.checked) {
            SM.map.setView([p.lat, p.lng], z);
            const f = SM.store.addFeature({ type: "Point", coordinates: [p.lng, p.lat] }, "marker");
            SM.store.select(f.properties.id);
          } else mv.showPoint(p.lat, p.lng, z, "Coordinates");
        },
      }],
    });
  };

  /* ---------------- coordinate grid ---------------- */
  mv.toggleGrid = function (on) {
    on = on ?? !gridLayer;
    if (!on && gridLayer) { SM.map.removeLayer(gridLayer); gridLayer = null; }
    if (on && !gridLayer) { gridLayer = L.layerGroup().addTo(SM.map); drawGrid(); }
    SM.$("#btn-grid").classList.toggle("on", !!gridLayer);
  };
  mv.gridInterval = function (spanDeg) {
    const steps = [30, 10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001, 0.0005, 0.0002, 0.0001, 0.00005, 0.00002, 0.00001];
    for (const s of steps) if (spanDeg / s >= 4) return s;
    return steps[steps.length - 1];
  };
  function drawGrid() {
    gridLayer.clearLayers();
    const b = SM.map.getBounds();
    const step = mv.gridInterval(Math.min(b.getNorth() - b.getSouth(), b.getEast() - b.getWest()));
    const dec = Math.max(0, Math.ceil(-Math.log10(step)));
    const style = { color: "#ffffff", weight: 0.8, opacity: 0.6, interactive: false, pmIgnore: true, dashArray: "4 4" };
    for (let lat = Math.ceil(b.getSouth() / step) * step; lat <= b.getNorth(); lat += step) {
      gridLayer.addLayer(L.polyline([[lat, b.getWest() - 1], [lat, b.getEast() + 1]], style));
      gridLayer.addLayer(L.marker([lat, b.getWest()], { interactive: false, pmIgnore: true, icon: L.divIcon({ className: "sm-grid-label", html: lat.toFixed(dec) + "°", iconAnchor: [-4, 14] }) }));
    }
    for (let lng = Math.ceil(b.getWest() / step) * step; lng <= b.getEast(); lng += step) {
      gridLayer.addLayer(L.polyline([[b.getSouth() - 1, lng], [b.getNorth() + 1, lng]], style));
      gridLayer.addLayer(L.marker([b.getNorth(), lng], { interactive: false, pmIgnore: true, icon: L.divIcon({ className: "sm-grid-label", html: wrapLng(lng).toFixed(dec) + "°", iconAnchor: [-3, -4] }) }));
    }
  }

  /* ---------------- search (place / coordinates / objects) ---------------- */
  function initSearch() {
    const input = SM.$("#search-input"), box = SM.$("#search-results");
    let items = [], active = -1;
    const close = () => { box.classList.remove("open"); active = -1; };
    const render = (groups) => {
      box.innerHTML = ""; items = [];
      groups.forEach((g) => {
        if (!g.rows.length) return;
        box.append(SM.el("div", { class: "sr-head", text: g.title }));
        g.rows.forEach((r) => {
          const d = SM.el("div", { class: "sr" }, r.label, r.sub ? SM.el("small", { text: r.sub }) : null);
          d.addEventListener("mousedown", (e) => { e.preventDefault(); r.go(); close(); input.blur(); });
          box.append(d); items.push({ el: d, go: r.go });
        });
      });
      box.classList.toggle("open", items.length > 0);
    };
    const localRows = (q) => {
      const ql = q.toLowerCase();
      return SM.store.features().filter((f) => (f.properties.name + " " + f.properties.description + " " + (f.properties.label.text || "")).toLowerCase().includes(ql))
        .slice(0, 8).map((f) => ({
          label: f.properties.name || SM.KIND_NAMES[f.properties.kind],
          sub: (SM.KIND_NAMES[f.properties.kind] || "") + " · " + ((SM.store.layer(f.properties.layerId) || {}).name || ""),
          go: () => { SM.store.select(f.properties.id); mv.fitFeatures([f], 18); },
        }));
    };
    const runGeocode = SM.debounce(async (q) => {
      if (!SM.config.geocoder || q.length < 3) return;
      try {
        const res = await SM.api.geocode(q);
        if (input.value.trim() !== q) return;
        const places = res.map((r) => ({
          label: r.name.split(",")[0], sub: r.name,
          go: () => {
            if (r.bbox && r.bbox.length === 4) SM.map.fitBounds([[r.bbox[0], r.bbox[2]], [r.bbox[1], r.bbox[3]]], { maxZoom: 18 });
            mv.showPoint(r.lat, r.lng, r.bbox ? undefined : 16, r.name.split(",")[0]);
          },
        }));
        render([{ title: "Project objects", rows: localRows(q) }, { title: "Places", rows: places }]);
        if (!places.length && !localRows(q).length) { box.innerHTML = '<div class="sr"><small>No places found</small></div>'; box.classList.add("open"); }
      } catch (e) {
        render([{ title: "Project objects", rows: localRows(q) }]);
        SM.toast(e.message, "error");
      }
    }, 450);
    input.addEventListener("input", () => {
      const q = input.value.trim();
      if (!q) { close(); return; }
      const ll = SM.parseLatLng(q);
      const groups = [];
      if (ll) groups.push({ title: "Coordinates", rows: [{ label: "Go to " + ll.lat.toFixed(6) + ", " + ll.lng.toFixed(6), sub: ll.swapped ? "Interpreted as longitude, latitude" : SM.fmtLatLng(ll.lat, ll.lng, "dms"), go: () => mv.showPoint(ll.lat, ll.lng, Math.max(17, SM.map.getZoom()), "Coordinates") }] });
      groups.push({ title: "Project objects", rows: localRows(q) });
      render(groups);
      if (!ll) runGeocode(q);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!items.length) return;
        active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items.forEach((it, i) => it.el.classList.toggle("active", i === active));
      } else if (e.key === "Enter") {
        const it = items[active >= 0 ? active : 0];
        if (it) { it.go(); close(); input.blur(); }
      } else if (e.key === "Escape") { close(); input.blur(); }
    });
    input.addEventListener("blur", () => setTimeout(close, 150));
  }
})(window.SM);
