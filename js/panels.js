/* =====================================================================
   panels.js — Layer Manager, object list, top-bar state, status bar
   ===================================================================== */
"use strict";
(function (SM) {
  const P = {};
  SM.panels = P;

  P.init = function () {
    SM.bus.on("change", SM.debounce(() => { renderLayers(); renderObjects(); updateCounts(); }, 30));
    SM.bus.on("selection", () => renderObjects());
    SM.bus.on("project", () => { SM.$("#project-name").value = SM.state.project.name; renderLayers(); renderObjects(); });
    SM.bus.on("history", updateHistory);
    SM.bus.on("savestate", updateSaveState);
    // status-bar unit switcher
    const st = SM.$("#st-units");
    const showUnits = () => { st.textContent = `Units: ${SM.unitShort("length")} · ${SM.unitShort("area")}`; };
    SM.bus.on("settings", showUnits); showUnits();
    st.addEventListener("click", (e) => {
      e.stopPropagation();
      SM.$$(".units-pop").forEach((m) => m.remove());
      const pop = SM.el("div", { class: "menu open units-pop" },
        SM.el("div", { class: "rot-head", text: "Measurement units" }),
        SM.el("label", { class: "muted", text: "Length" }), SM.unitSelect("length", "field"),
        SM.el("label", { class: "muted", text: "Area" }), SM.unitSelect("area", "field"),
        SM.el("div", { class: "menu-note", style: { padding: "6px 0 0" }, text: "Used in the panel, map labels, the measure tool and PNG/PDF exports. Files keep metres." }));
      pop.addEventListener("click", (ev) => ev.stopPropagation());
      document.body.append(pop);
      const r = st.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 280)) + "px";
      pop.style.top = r.top - pop.offsetHeight - 6 + "px";
      setTimeout(() => document.addEventListener("click", function h() { pop.remove(); document.removeEventListener("click", h); }), 0);
    });

    SM.$("#btn-add-layer").addEventListener("click", addLayer);
    SM.$("#object-filter").addEventListener("input", renderObjects);
    SM.$("#objects-all-layers").addEventListener("change", renderObjects);
    const nameInput = SM.$("#project-name");
    nameInput.addEventListener("change", () => {
      const v = nameInput.value.trim() || "Untitled project";
      nameInput.value = v;
      if (v !== SM.state.project.name) { SM.state.project.name = v; SM.store.markDirty(); }
    });
    nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") nameInput.blur(); });
  };

  function updateHistory() {
    SM.$("#btn-undo").disabled = !SM.store.canUndo();
    SM.$("#btn-redo").disabled = !SM.store.canRedo();
  }
  function updateSaveState() {
    const el = SM.$("#save-state"), s = SM.state;
    el.className = "save-state" + (s.saving ? " saving" : s.saveError && s.dirty ? " error" : s.dirty ? " dirty" : "");
    el.title = s.saving ? "Saving…" : s.saveError && s.dirty ? "Not saved: " + s.saveError : s.dirty ? "Unsaved changes (autosave pending)" : s.projectId ? "All changes saved" : "Not yet saved";
    el.textContent = s.saving ? "◌ saving" : s.dirty ? "● unsaved" : s.projectId ? "✓ saved" : "●";
  }
  function updateCounts() {
    const n = SM.store.features().length;
    SM.$("#st-count").textContent = n + " object" + (n === 1 ? "" : "s");
    const l = SM.store.activeLayer();
    SM.$("#st-layer").textContent = "Layer: " + (l ? l.name : "—");
  }
  P.refresh = () => { renderLayers(); renderObjects(); updateCounts(); updateHistory(); updateSaveState(); };

  /* ---------------- layers ---------------- */
  async function addLayer() {
    const n = SM.store.layers().length + 1;
    const lyr = { id: SM.uid(), name: "Layer " + n, visible: true, locked: false };
    SM.store.change((p) => { p.layers.push(lyr); p.activeLayerId = lyr.id; });
    setTimeout(() => startRename(lyr.id), 50);
  }
  P.setActiveLayer = function (lid) {
    if (SM.state.project.activeLayerId === lid) return;
    SM.state.project.activeLayerId = lid;
    SM.store.markDirty();
    renderLayers(); renderObjects(); updateCounts();
  };

  function renderLayers() {
    const ul = SM.$("#layer-list");
    if (!SM.state.project) return;
    const layers = SM.store.layers();
    const active = SM.state.project.activeLayerId;
    ul.innerHTML = "";
    [...layers].reverse().forEach((l) => {
      const count = SM.store.featuresInLayer(l.id).length;
      const li = SM.el("li", { class: (l.id === active ? "active " : "") + (l.visible ? "" : "hidden-layer"), draggable: "true", "data-id": l.id, title: "Click to make active · double-click to rename · drag to reorder" },
        SM.el("span", { class: "handle", text: "⋮⋮" }),
        ib(l.visible ? "eye" : "eyeoff", l.visible ? "Hide layer" : "Show layer", () => SM.store.change(() => { l.visible = !l.visible; }), l.visible),
        ib(l.locked ? "lock" : "unlock", l.locked ? "Unlock layer" : "Lock layer", () => SM.store.change(() => { l.locked = !l.locked; }), l.locked),
        SM.el("span", { class: "lname", text: l.name }),
        SM.el("span", { class: "lcount", text: count }),
        ib("up", "Move layer up (draw on top)", () => moveLayer(l.id, 1), false, "lx"),
        ib("down", "Move layer down", () => moveLayer(l.id, -1), false, "lx"),
        ib("menu", "Layer options", (e) => layerMenu(l, e.currentTarget), false, "lx"));
      li.addEventListener("click", (e) => { if (!e.target.closest(".ib")) P.setActiveLayer(l.id); });
      li.querySelector(".lname").addEventListener("dblclick", () => startRename(l.id));
      // drag & drop reordering
      li.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", l.id); e.dataTransfer.effectAllowed = "move"; });
      li.addEventListener("dragover", (e) => { e.preventDefault(); li.classList.add("drag-over"); });
      li.addEventListener("dragleave", () => li.classList.remove("drag-over"));
      li.addEventListener("drop", (e) => {
        e.preventDefault(); li.classList.remove("drag-over");
        const src = e.dataTransfer.getData("text/plain");
        if (src && src !== l.id) reorderLayer(src, l.id);
      });
      ul.append(li);
    });
    updateCounts();
  }
  function ib(icon, title, onclick, on, extra) {
    const b = SM.el("button", { class: "ib" + (on ? " on" : "") + (extra ? " " + extra : ""), title }, SM.icon(icon));
    b.addEventListener("click", (e) => { e.stopPropagation(); onclick(e); });
    return b;
  }
  function moveLayer(lid, dir) {
    const arr = SM.store.layers(), i = arr.findIndex((l) => l.id === lid), j = i + dir;
    if (j < 0 || j >= arr.length) return;
    SM.store.change((p) => { const [x] = p.layers.splice(i, 1); p.layers.splice(j, 0, x); });
  }
  function reorderLayer(srcId, targetId) {
    SM.store.change((p) => {
      const i = p.layers.findIndex((l) => l.id === srcId);
      const [x] = p.layers.splice(i, 1);
      const j = p.layers.findIndex((l) => l.id === targetId);
      p.layers.splice(j + 1, 0, x); // dropped onto a row = placed just above it
    });
  }
  function startRename(lid) {
    const li = SM.$(`#layer-list li[data-id="${lid}"]`);
    if (!li) return;
    const span = li.querySelector(".lname"), l = SM.store.layer(lid);
    const inp = SM.el("input", { value: l.name });
    span.innerHTML = ""; span.append(inp); inp.focus(); inp.select();
    li.draggable = false;
    const done = (save) => {
      const v = inp.value.trim();
      if (save && v && v !== l.name) SM.store.change(() => { l.name = v; });
      else renderLayers();
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); e.stopPropagation(); });
    inp.addEventListener("blur", () => done(true));
  }
  function layerMenu(l, anchor) {
    SM.$$(".menu.layer-ctx").forEach((m) => m.remove());
    const m = SM.el("div", { class: "menu open layer-ctx" });
    const item = (icon, label, fn) => { const b = SM.el("button", {}, SM.icon(icon), label); b.addEventListener("click", () => { m.remove(); fn(); }); m.append(b); };
    item("edit", "Rename", () => startRename(l.id));
    item("fit", "Zoom to layer", () => { if (!SM.mapview.fitFeatures(SM.store.featuresInLayer(l.id))) SM.toast("Layer is empty"); });
    item("select", "Select all objects in layer", () => SM.store.select(SM.store.featuresInLayer(l.id).filter(SM.store.isVisible).map((f) => f.properties.id)));
    item("copy", "Duplicate layer", () => duplicateLayer(l));
    item("download", "Export this layer as KML", () => SM.io.exportVector("kml", { layerIds: [l.id], onlyVisible: false }));
    m.append(SM.el("hr"));
    item("trash", "Delete layer…", () => deleteLayer(l));
    document.body.append(m);
    const r = anchor.getBoundingClientRect();
    m.style.top = r.bottom + 4 + "px";
    m.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 250)) + "px";
    setTimeout(() => document.addEventListener("click", function h() { m.remove(); document.removeEventListener("click", h); }), 0);
  }
  function duplicateLayer(l) {
    const nid = SM.uid();
    SM.store.change((p) => {
      const i = p.layers.findIndex((x) => x.id === l.id);
      p.layers.splice(i + 1, 0, { id: nid, name: l.name + " copy", visible: true, locked: false });
      SM.store.featuresInLayer(l.id).forEach((f) => {
        const c = SM.clone(f); c.properties.id = SM.uid(); c.properties.layerId = nid; c.properties.group = null; p.features.push(c);
      });
      p.activeLayerId = nid;
    });
  }
  async function deleteLayer(l) {
    if (SM.store.layers().length <= 1) { SM.toast("A project needs at least one layer"); return; }
    const n = SM.store.featuresInLayer(l.id).length;
    if (n && !(await SM.confirm("Delete layer", `Delete "${l.name}" and its ${n} object(s)? You can undo this.`, "Delete", true))) return;
    SM.store.change((p) => {
      p.features = p.features.filter((f) => f.properties.layerId !== l.id);
      p.layers = p.layers.filter((x) => x.id !== l.id);
      if (p.activeLayerId === l.id) p.activeLayerId = p.layers[p.layers.length - 1].id;
    });
    for (const id of [...SM.state.selection]) if (!SM.store.feature(id)) SM.state.selection.delete(id);
    SM.bus.emit("selection");
  }

  /* ---------------- objects ---------------- */
  const KIND_ICON = { polyline: "line", polygon: "polygon", rectangle: "rect", circle: "circle", marker: "marker", text: "text", freehand: "pen", arrow: "arrow" };
  function renderObjects() {
    const ul = SM.$("#object-list");
    if (!SM.state.project) return;
    const all = SM.$("#objects-all-layers").checked;
    const q = SM.$("#object-filter").value.trim().toLowerCase();
    const lid = SM.state.project.activeLayerId;
    let feats = SM.store.features().filter((f) => all || f.properties.layerId === lid);
    if (q) feats = feats.filter((f) => (f.properties.name + " " + f.properties.description + " " + (f.properties.label.text || "") + " " + f.properties.kind).toLowerCase().includes(q));
    ul.innerHTML = "";
    if (!feats.length) { ul.append(SM.el("li", { class: "empty", text: q ? "No matching objects" : "No objects in this layer yet — pick a tool and draw on the map" })); return; }
    const sel = SM.state.selection;
    [...feats].reverse().slice(0, 1500).forEach((f) => {
      const p = f.properties;
      const li = SM.el("li", { class: (sel.has(p.id) ? "sel " : "") + (p.hidden ? "is-hidden" : "") },
        SM.el("span", { class: "swatch", style: { background: p.kind === "text" ? p.label.color : (["polygon", "rectangle", "circle"].includes(p.kind) && p.style.fill ? p.style.fillColor : p.style.color) } }),
        SM.icon(KIND_ICON[p.kind] || "polygon", "ok"),
        SM.el("span", { class: "oname", text: (p.kind === "text" ? p.label.text : p.name) || SM.KIND_NAMES[p.kind] }),
        p.group ? SM.el("span", { title: "Grouped" }, SM.icon("group", "ok")) : null,
        ib(p.hidden ? "eyeoff" : "eye", p.hidden ? "Show" : "Hide", () => SM.store.updateFeature(p.id, (x) => { x.properties.hidden = !x.properties.hidden; })),
        ib(p.locked ? "lock" : "unlock", p.locked ? "Unlock" : "Lock", () => SM.store.updateFeature(p.id, (x) => { x.properties.locked = !x.properties.locked; }), p.locked));
      li.addEventListener("click", (e) => {
        if (e.target.closest(".ib")) return;
        if (e.shiftKey || e.ctrlKey || e.metaKey) SM.store.select(p.id, "toggle"); else SM.store.select(p.id);
      });
      li.addEventListener("dblclick", () => SM.mapview.fitFeatures([f], 19));
      ul.append(li);
    });
  }
})(window.SM);
