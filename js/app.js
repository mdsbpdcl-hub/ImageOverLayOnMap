/* =====================================================================
   app.js — bootstrap, session restore, keyboard shortcuts, panel toggles
   ===================================================================== */
"use strict";
(function (SM) {
  /** Startup problems are shown on screen instead of leaving a blank page. */
  function startupError(title, detail, files) {
    if (document.getElementById("boot-error")) return;
    const box = document.createElement("div");
    box.id = "boot-error";
    box.innerHTML = `<div class="be-card"><h2></h2><p class="be-detail"></p>${files ? '<ul class="be-files"></ul>' : ""}
      <p class="be-tips">Try these, in order:</p>
      <ol><li>Close every other SatMap tab or window.</li><li>Press <b>Ctrl + F5</b> (Mac: Cmd + Shift + R) to reload without the old copy.</li>
      <li>If you updated the website: wait 2–3 minutes after uploading, then reload.</li>
      <li>Check that the folders <b>css</b>, <b>js</b> and <b>vendor</b> are in your GitHub repository next to index.html.</li></ol>
      <div class="be-actions"><button id="be-reload" class="btn primary">Reload</button><button id="be-reset" class="btn">Reset settings and reload</button></div>
      <p class="be-note">“Reset” clears only this browser’s settings and unsaved draft — your saved projects are kept.</p></div>`;
    box.querySelector("h2").textContent = title;
    box.querySelector(".be-detail").textContent = detail;
    if (files) files.forEach((f) => { const li = document.createElement("li"); li.textContent = f; box.querySelector(".be-files").append(li); });
    document.body.append(box);
    box.querySelector("#be-reload").onclick = () => location.reload();
    box.querySelector("#be-reset").onclick = () => {
      try { ["satmap.session", "satmap.settings", "satmap.rightCollapsed"].forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
      try { const r = indexedDB.open("satmap"); r.onsuccess = () => { try { const t = r.result.transaction("drafts", "readwrite"); t.objectStore("drafts").clear(); t.oncomplete = () => location.reload(); } catch (e) { location.reload(); } }; r.onerror = () => location.reload(); } catch (e) { location.reload(); }
    };
  }
  SM.startupError = startupError;

  /** Which script files failed to load (missing upload, blocked, or cached mix-up). */
  function missingFiles() {
    const need = { "vendor/leaflet/leaflet.js": "L", "vendor/geoman/leaflet-geoman.min.js": () => window.L && L.PM, "vendor/turf/turf.min.js": "turf",
      "vendor/jspdf/jspdf.umd.min.js": "jspdf", "vendor/fflate/fflate.min.js": "fflate", "vendor/proj4/proj4.js": "proj4", "vendor/dxf-parser/dxf-parser.js": "DxfParser",
      "js/config.js": () => SM.APP_CONFIG, "js/geodesy.js": () => SM.geo, "js/transform.js": () => SM.xf, "js/crs.js": () => SM.crs, "js/gis.js": () => SM.gis,
      "js/shp.js": () => SM.shp, "js/api.js": () => SM.api, "js/store.js": () => SM.store, "js/mapview.js": () => SM.mapview, "js/render.js": () => SM.render,
      "js/overlays.js": () => SM.overlays, "js/cad.js": () => SM.cad, "js/tools.js": () => SM.tools, "js/areaops.js": () => SM.areaops, "js/panels.js": () => SM.panels,
      "js/props.js": () => SM.props, "js/io.js": () => SM.io, "js/print.js": () => SM.print };
    return Object.entries(need).filter(([, t]) => !(typeof t === "string" ? window[t] : t())).map(([f]) => f);
  }

  async function boot() {
    const missing = missingFiles();
    if (missing.length) { startupError("SatMap could not start — some files did not load", "These files are missing or could not be read:", missing); return; }
    let cfg;
    try {
      cfg = await SM.api.config();
      SM.config = cfg;
      SM.mapview.init(cfg);
      SM.mapview.setBasemap(cfg.defaultBasemap); // the map shows straight away, before projects are read
    } catch (e) {
      console.error(e);
      startupError("SatMap could not start the map", (e && e.message) || String(e));
      return;
    }
    // the remaining parts are independent: one failing must not blank the page
    const parts = [["render", () => SM.render.init()], ["pictures", () => SM.overlays.init()], ["tools", () => SM.tools.init()], ["select area", () => SM.areaops.init()],
      ["panels", () => SM.panels.init()], ["properties", () => SM.props.init()], ["import/export", () => SM.io.init()], ["keyboard", initShortcuts], ["panel buttons", initPanels]];
    const failed = [];
    parts.forEach(([name, fn]) => { try { fn(); } catch (e) { console.error(name, e); failed.push(name + ": " + e.message); } });

    // open saved work, but never wait for ever (an older SatMap tab can block the storage)
    let blockedNote = null;
    SM.bus.on("storage-blocked", (why) => {
      if (why === "newer") { SM.toast("SatMap was updated in another tab — reload this page", "error", 10000); return; }
      blockedNote = blockedNote || SM.toast("Another SatMap tab with the older version is open. Close it — this page will continue by itself.", "error", 15000) || true;
    });
    const timeout = new Promise((r) => setTimeout(() => r("timeout"), 6000));
    let result;
    try { result = await Promise.race([restoreSession(cfg).then(() => "ok"), timeout]); }
    catch (e) { console.error(e); result = "error"; failed.push("saved work: " + e.message); }
    if (result !== "ok") restoreState.gaveUp = true;
    if (result !== "ok" && !SM.state.project) {
      SM.store.newProject("Unsaved map");
      SM.toast(result === "timeout"
        ? "Your saved projects are not available yet — close other SatMap tabs/windows, then reload. You can still draw; use Export to keep your work."
        : "Saved projects could not be opened. You can still draw; use Export to keep your work.", "error", 12000);
    }
    try { SM.panels.refresh(); SM.props.render(); } catch (e) { failed.push("refresh: " + e.message); }
    if (failed.length) { console.warn("SatMap started with problems:", failed); SM.toast("Some parts did not start (" + failed.join("; ") + "). Press Ctrl+F5 to reload.", "error", 12000); }
  }
  window.addEventListener("error", (e) => {
    if (!SM.map) startupError("SatMap could not start", (e.message || "Unknown error") + (e.filename ? " — " + e.filename.split("/").slice(-2).join("/") : ""));
  });

  const restoreState = { gaveUp: false };
  async function restoreSession(cfg) {
    const s = await SM.store.loadSession();
    if (restoreState.gaveUp) {
      // storage answered late: never replace what the user drew meanwhile
      const p = SM.state.project, n = p && p.features ? p.features.length : 0;
      if (n || (p && p.overlays && p.overlays.length)) { SM.toast("Storage is available again — your saved projects are in Projects (this map is kept).", "ok", 8000); return; }
      SM.toast("Storage is available again — your last map was reopened.", "ok", 6000);
    }
    let loaded = false;
    if (s && s.project) {
      // the browser copy is newest when it had unsaved changes
      if (s.projectId && !s.dirty) {
        try {
          const r = await SM.api.getProject(s.projectId);
          SM.store.load(r.data, r.id);
          loaded = true;
        } catch (e) { /* project was deleted: fall back to the session copy */ }
      }
      if (!loaded) {
        SM.store.load(s.project, s.projectId || null);
        if (s.dirty) { SM.store.markDirty(); }
        loaded = true;
      }
    }
    if (!loaded) {
      SM.store.newProject("My first map");
      SM.state.project.viewport = cfg.defaultView;
    }
    const p = SM.state.project;
    if (p.viewport && p.viewport.center) SM.map.setView(p.viewport.center, p.viewport.zoom, { animate: false });
    SM.mapview.setBearing((p.viewport && p.viewport.bearing) || 0);
    SM.mapview.setBasemap(p.basemap || cfg.defaultBasemap);
    if (!SM.state.projectId) SM.store.save({ silent: true });
  }

  /* ---------------- keyboard ---------------- */
  const TOOL_KEYS = { s: "area", v: "select", g: "move", e: "edit", f: "freehand", l: "polyline", p: "polygon", r: "rectangle", c: "circle", m: "marker", t: "text", a: "arrow", d: "measure", x: "delete" };
  function initShortcuts() {
    document.addEventListener("keydown", (e) => {
      const t = e.target && e.target.tagName ? e.target : document.activeElement || {};
      const typing = /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable || /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName);
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === "s") { e.preventDefault(); SM.store.save(); return; }
      if (SM.$(".modal-back")) return;
      if (typing) return;
      const drawing = SM.map.pm.globalDrawModeEnabled() || SM.tools.current.startsWith("measure");
      if (mod && key === "z" && !e.shiftKey) { e.preventDefault(); if (drawing) SM.tools.undoPoint(); else SM.store.undo(); return; }
      if (mod && (key === "y" || (key === "z" && e.shiftKey))) { e.preventDefault(); SM.store.redo(); return; }
      if (mod && key === "d") { e.preventDefault(); SM.props.duplicate(); return; }
      if (mod && key === "c") {
        const sel = SM.store.selected();
        if (sel.length) { SM.state.featureClipboard = SM.clone(sel); SM.toast(sel.length + " object(s) copied", "", 1200); }
        return;
      }
      if (mod && key === "v") return; // handled by the "paste" event (screenshots or copied objects)
      if (mod && key === "a") {
        e.preventDefault();
        SM.store.select(SM.store.featuresInLayer(SM.state.project.activeLayerId).filter(SM.store.isVisible).map((f) => f.properties.id));
        return;
      }
      const ov = SM.overlays.selected();
      if (SM.overlays.aligning()) {
        if (e.key === "Escape") SM.overlays.endAlign(false);
        else if (e.key === "Enter") SM.overlays.endAlign(true);
        else if (mod && key === "z") { e.preventDefault(); SM.overlays.alignUndo(); }
        return;
      }
      if (ov && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        if (ov === SM.overlays.temp()) SM.overlays.setTemp(null); else { SM.overlays.remove(ov.id); SM.toast("Picture deleted (Ctrl+Z to undo)", "", 1800); }
        return;
      }
      if (ov && e.key === "Escape" && ov !== SM.overlays.temp()) { SM.overlays.select(null); return; }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (SM.state.selection.size) { e.preventDefault(); const n = SM.store.deleteFeatures([...SM.state.selection]); if (n) SM.toast(n + " deleted (Ctrl+Z to undo)", "", 1800); }
        return;
      }
      if (e.key === "Escape") {
        if (SM.tools.current !== "select") SM.tools.cancel(); else SM.store.clearSelection();
        return;
      }
      if (e.key === "Enter" && drawing) { SM.tools.finish(); return; }
      if (e.key.startsWith("Arrow") && SM.state.selection.size && !mod) {
        // nudge selected objects by 1 px (Shift: 10 px)
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        const ids = [...SM.state.selection].filter((id) => SM.store.isEditable(SM.store.feature(id)));
        SM.store.updateMany(ids, (f) => { f.geometry = SM.render.translateGeom(f.geometry, d[0], d[1]); }, { coalesce: "nudge" });
        return;
      }
      if (mod || e.altKey) return;
      if (key === "d" && e.shiftKey) { SM.tools.set("measure-area"); return; }
      if (key === "[" || key === "]") { SM.mapview.setBearing(SM.mapview.bearing + (key === "]" ? 5 : -5), true); return; }
      if (key === "n") { SM.mapview.setBearing(0, true); return; }
      if (TOOL_KEYS[key]) SM.tools.set(TOOL_KEYS[key]);
    });
    document.addEventListener("paste", (e) => {
      if (/INPUT|TEXTAREA/.test((document.activeElement || {}).tagName) || SM.$(".modal-back")) return;
      if (SM.overlays.pasteImage(e)) return;
      if (SM.state.featureClipboard) { e.preventDefault(); pasteFeatures(); }
    });
    SM.$("#btn-undo").addEventListener("click", () => SM.store.undo());
    SM.$("#btn-redo").addEventListener("click", () => SM.store.redo());
  }
  function pasteFeatures() {
    const cb = SM.state.featureClipboard;
    if (!cb || !cb.length) return;
    const lid = SM.store.activeLayer().id, ids = [];
    SM.store.change((p) => {
      cb.forEach((f) => {
        const c = SM.clone(f);
        c.properties.id = SM.uid(); c.properties.layerId = lid; c.properties.locked = false; c.properties.group = null;
        c.geometry = SM.render.translateGeom(c.geometry, 24, 24);
        p.features.push(c); ids.push(c.properties.id);
      });
    });
    SM.state.featureClipboard = cb.map((f) => Object.assign(SM.clone(f), { geometry: SM.render.translateGeom(f.geometry, 24, 24) }));
    SM.store.select(ids);
  }

  /* ---------------- panel toggles ---------------- */
  function initPanels() {
    const left = SM.$("#left-panel"), right = SM.$("#right-panel");
    const mobile = () => window.innerWidth <= 760;
    const resize = () => setTimeout(() => SM.map.invalidateSize(), 230);
    SM.$("#btn-right-toggle").addEventListener("click", () => {
      if (mobile()) { right.classList.toggle("mobile-open"); left.classList.remove("mobile-open"); }
      else { right.classList.toggle("collapsed"); resize(); }
    });
    SM.$("#btn-left-toggle").addEventListener("click", () => { left.classList.toggle("mobile-open"); right.classList.remove("mobile-open"); });
    SM.map.on("click", () => { if (mobile()) { left.classList.remove("mobile-open"); } });
    try {
      if (localStorage.getItem("satmap.rightCollapsed") === "1" && !mobile()) right.classList.add("collapsed");
    } catch (e) { /* ignore */ }
    new MutationObserver(() => { try { localStorage.setItem("satmap.rightCollapsed", right.classList.contains("collapsed") ? "1" : "0"); } catch (e) { /* ignore */ } })
      .observe(right, { attributes: true, attributeFilter: ["class"] });
    // mobile overflow menu forwards to the regular buttons
    SM.attachMenu(SM.$("#btn-mobile-more"), SM.$("#mobile-menu"));
    SM.$$("#mobile-menu button[data-proxy]").forEach((b) => b.addEventListener("click", () => SM.$("#" + b.dataset.proxy).click()));
    SM.$$("#mobile-menu button[data-proxy-export]").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.proxyExport;
      if (k === "kml") SM.io.exportDialog("kml"); else SM.print.dialog(k);
    }));
    window.addEventListener("resize", SM.debounce(() => SM.map.invalidateSize(), 150));
  }

  document.addEventListener("DOMContentLoaded", boot);
})(window.SM);
