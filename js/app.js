/* =====================================================================
   app.js — bootstrap, session restore, keyboard shortcuts, panel toggles
   ===================================================================== */
"use strict";
(function (SM) {
  async function boot() {
    const cfg = await SM.api.config();
    SM.config = cfg;

    SM.mapview.init(cfg);
    SM.render.init();
    SM.overlays.init();
    SM.tools.init();
    SM.panels.init();
    SM.props.init();
    SM.io.init();
    initShortcuts();
    initPanels();

    await restoreSession(cfg);
    SM.panels.refresh();
    SM.props.render();
  }

  async function restoreSession(cfg) {
    const s = await SM.store.loadSession();
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
    SM.mapview.setBasemap(p.basemap || cfg.defaultBasemap);
    if (!SM.state.projectId) SM.store.save({ silent: true });
  }

  /* ---------------- keyboard ---------------- */
  const TOOL_KEYS = { v: "select", g: "move", e: "edit", f: "freehand", l: "polyline", p: "polygon", r: "rectangle", c: "circle", m: "marker", t: "text", a: "arrow", d: "measure", x: "delete" };
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
