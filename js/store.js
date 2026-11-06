/* =====================================================================
   store.js — project state, selection, undo/redo, autosave
   The project document (layers + GeoJSON features) is the single source
   of truth; map layers are always rebuilt from it (see render.js).
   ===================================================================== */
"use strict";
(function (SM) {
  const SESSION_KEY = "satmap.session";
  const MAX_UNDO = 120;

  const state = {
    project: null,     // { name, layers, features, viewport, basemap, activeLayerId, version }
    projectId: null,   // SQLite id (null until first saved)
    selection: new Set(),
    dirty: false,
    saving: false,
    saveError: null,
    styleClipboard: null,
    featureClipboard: null,
  };
  SM.state = state;

  const undoStack = [], redoStack = [];
  let lastCoalesce = null, lastCoalesceAt = 0;

  /* ---------- defaults ---------- */
  function defaultStyle(kind) {
    const s = SM.clone(SM.settings.defaultStyle);
    if (["polyline", "freehand", "arrow"].includes(kind)) s.fill = false;
    if (kind === "arrow") s.arrow = true;
    if (kind === "marker") s.color = s.color || "#e53935";
    return s;
  }
  function defaultLabel(kind) {
    return { text: kind === "text" ? "Text" : "", show: kind === "text", size: kind === "text" ? 18 : 13, color: "#ffffff", bold: kind === "text", italic: false, align: "center", halo: true, offset: [0, 0] };
  }
  const KIND_NAMES = { polyline: "Line", polygon: "Polygon", rectangle: "Rectangle", circle: "Circle", marker: "Marker", text: "Text", freehand: "Freehand", arrow: "Arrow" };
  SM.KIND_NAMES = KIND_NAMES;

  function newProjectData(name) {
    const lid = SM.uid();
    const cfg = SM.config || {};
    return {
      version: 1,
      name: name || "Untitled project",
      layers: [{ id: lid, name: "Layer 1", visible: true, locked: false }],
      activeLayerId: lid,
      features: [],
      viewport: SM.map ? { center: [SM.map.getCenter().lat, SM.map.getCenter().lng], zoom: SM.map.getZoom() } : (cfg.defaultView || { center: [25.5941, 85.1376], zoom: 12 }),
      basemap: (SM.state.project && SM.state.project.basemap) || cfg.defaultBasemap || "esri_imagery",
    };
  }

  /** Upgrade/repair a project document loaded from storage or a file. */
  function sanitize(p) {
    p = p || {};
    p.version = 1;
    p.name = p.name || "Untitled project";
    p.layers = Array.isArray(p.layers) && p.layers.length ? p.layers : [{ id: SM.uid(), name: "Layer 1", visible: true, locked: false }];
    p.layers.forEach((l) => { l.id = l.id || SM.uid(); l.name = l.name || "Layer"; l.visible = l.visible !== false; l.locked = !!l.locked; });
    const ids = new Set(p.layers.map((l) => l.id));
    p.features = (Array.isArray(p.features) ? p.features : []).filter((f) => f && f.geometry && f.properties);
    p.features.forEach((f) => {
      const pr = f.properties;
      pr.id = pr.id || SM.uid();
      if (!ids.has(pr.layerId)) pr.layerId = p.layers[0].id;
      pr.kind = pr.kind || ({ Point: "marker", LineString: "polyline", Polygon: "polygon" }[f.geometry.type]);
      pr.style = Object.assign(defaultStyle(pr.kind), pr.style || {});
      pr.label = Object.assign(defaultLabel(pr.kind), pr.label || {});
      if (!Array.isArray(pr.label.offset)) pr.label.offset = [0, 0];
      pr.name = pr.name || "";
      pr.description = pr.description || "";
    });
    if (!ids.has(p.activeLayerId)) p.activeLayerId = p.layers[p.layers.length - 1].id;
    // pictures placed on the map (overlays.js); drop images nothing refers to
    p.images = p.images && typeof p.images === "object" ? p.images : {};
    p.overlays = (Array.isArray(p.overlays) ? p.overlays : []).filter((o) => o && Array.isArray(o.P) && o.P.length === 6 && p.images[o.imageId]);
    p.overlays.forEach((o) => { o.id = o.id || "ov" + SM.uid(); o.opacity = o.opacity ?? 0.8; o.visible = o.visible !== false; o.locked = !!o.locked; o.name = o.name || "Image"; });
    const used = new Set(p.overlays.flatMap((o) => [o.imageId, o.origImageId]));
    Object.keys(p.images).forEach((k) => { if (!used.has(k)) delete p.images[k]; });
    return p;
  }

  /* ---------- accessors ---------- */
  const store = {
    get project() { return state.project; },
    features: () => state.project.features,
    layers: () => state.project.layers,
    feature: (id) => state.project.features.find((f) => f.properties.id === id),
    layer: (id) => state.project.layers.find((l) => l.id === id),
    activeLayer: () => store.layer(state.project.activeLayerId) || state.project.layers[state.project.layers.length - 1],
    featuresInLayer: (lid) => state.project.features.filter((f) => f.properties.layerId === lid),
    isEditable(f) {
      if (!f) return false;
      const l = store.layer(f.properties.layerId);
      return !f.properties.locked && !(l && l.locked);
    },
    isVisible(f) {
      const l = store.layer(f.properties.layerId);
      return !f.properties.hidden && !!l && l.visible;
    },
    selected: () => [...state.selection].map(store.feature).filter(Boolean),
    defaultStyle, defaultLabel,
  };
  SM.store = store;

  /* ---------- mutation with undo ---------- */
  function snapshot() {
    return JSON.stringify({ layers: state.project.layers, features: state.project.features, activeLayerId: state.project.activeLayerId, overlays: state.project.overlays || [] });
  }
  function restore(snap) {
    const s = JSON.parse(snap);
    state.project.layers = s.layers;
    state.project.features = s.features;
    state.project.activeLayerId = s.activeLayerId;
    state.project.overlays = s.overlays || []; // picture data (project.images) is kept, so undo can bring pictures back
    for (const id of [...state.selection]) if (!store.feature(id)) state.selection.delete(id);
  }

  /**
   * Apply a change. `fn` mutates state.project directly.
   * opts.coalesce: key — repeated changes with the same key within 1.2 s share
   * one undo step (used for sliders, typing, colour pickers).
   */
  store.change = function (fn, opts) {
    opts = opts || {};
    const now = Date.now();
    const coalesce = opts.coalesce && opts.coalesce === lastCoalesce && now - lastCoalesceAt < 1200;
    if (!coalesce) {
      undoStack.push(snapshot());
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack.length = 0;
    }
    lastCoalesce = opts.coalesce || null;
    lastCoalesceAt = now;
    fn(state.project);
    markDirty();
    SM.bus.emit("change", { source: opts.source || null, ids: opts.ids || null });
    SM.bus.emit("history");
  };
  store.canUndo = () => undoStack.length > 0;
  store.canRedo = () => redoStack.length > 0;
  store.undo = function () {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    lastCoalesce = null;
    markDirty();
    SM.bus.emit("change", { source: "undo" });
    SM.bus.emit("selection");
    SM.bus.emit("history");
  };
  store.redo = function () {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    lastCoalesce = null;
    markDirty();
    SM.bus.emit("change", { source: "redo" });
    SM.bus.emit("selection");
    SM.bus.emit("history");
  };

  /* ---------- feature helpers ---------- */
  store.addFeature = function (geometry, kind, extra) {
    const lyr = store.activeLayer();
    const props = Object.assign({
      id: SM.uid(), layerId: lyr.id, kind,
      name: "", description: "",
      style: defaultStyle(kind), label: defaultLabel(kind),
      hidden: false, locked: false, group: null,
    }, extra || {});
    const n = state.project.features.filter((f) => f.properties.kind === kind).length + 1;
    if (!props.name) props.name = (KIND_NAMES[kind] || kind) + " " + n;
    const feat = { type: "Feature", geometry, properties: props };
    store.change((p) => p.features.push(feat), { source: "add" });
    return feat;
  };
  store.updateFeature = function (id, fn, opts) {
    const f = store.feature(id);
    if (!f) return;
    store.change(() => fn(f), Object.assign({ ids: [id] }, opts || {}));
  };
  store.updateMany = function (ids, fn, opts) {
    const feats = ids.map(store.feature).filter(Boolean);
    if (!feats.length) return;
    store.change(() => feats.forEach(fn), Object.assign({ ids }, opts || {}));
  };
  store.deleteFeatures = function (ids) {
    const set = new Set(ids);
    const deletable = state.project.features.filter((f) => set.has(f.properties.id) && store.isEditable(f));
    if (!deletable.length) { if (ids.length) SM.toast("Locked objects cannot be deleted — unlock them first"); return 0; }
    const del = new Set(deletable.map((f) => f.properties.id));
    store.change((p) => { p.features = p.features.filter((f) => !del.has(f.properties.id)); });
    del.forEach((id) => state.selection.delete(id));
    SM.bus.emit("selection");
    return del.size;
  };

  /* ---------- selection ---------- */
  store.select = function (ids, mode) {
    // mode: replace (default) | add | toggle
    ids = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
    // expand groups
    const expanded = new Set(ids);
    for (const id of ids) {
      const f = store.feature(id);
      if (f && f.properties.group) state.project.features.forEach((g) => { if (g.properties.group === f.properties.group) expanded.add(g.properties.id); });
    }
    if (!mode || mode === "replace") state.selection = new Set(expanded);
    else if (mode === "add") expanded.forEach((id) => state.selection.add(id));
    else if (mode === "toggle") {
      const allIn = [...expanded].every((id) => state.selection.has(id));
      expanded.forEach((id) => (allIn ? state.selection.delete(id) : state.selection.add(id)));
    }
    if (state.overlaySel && expanded.size && SM.overlays) SM.overlays.select(null);
    SM.bus.emit("selection");
  };
  store.clearSelection = function () {
    // a clicked-away picture is deselected, but a CAD drawing being placed stays active
    if (state.overlaySel && SM.overlays && !(SM.overlays.temp() && SM.overlays.temp().id === state.overlaySel) && !SM.overlays.aligning()) SM.overlays.select(null);
    if (!state.selection.size) return;
    state.selection.clear();
    SM.bus.emit("selection");
  };

  /* ---------- project lifecycle ---------- */
  store.load = function (data, id) {
    state.project = sanitize(SM.clone(data));
    state.projectId = id || null;
    state.selection.clear();
    undoStack.length = 0; redoStack.length = 0;
    state.dirty = false;
    SM.bus.emit("project");
    SM.bus.emit("change", { source: "load" });
    SM.bus.emit("selection");
    SM.bus.emit("history");
    saveSessionNow();
    SM.bus.emit("savestate");
  };
  store.newProject = (name) => store.load(newProjectData(name), null);
  store.newProjectData = newProjectData;
  store.sanitize = sanitize;

  /* ---------- autosave: session draft + project storage (IndexedDB) ---------- */
  function markDirty() {
    state.dirty = true;
    SM.bus.emit("savestate");
    saveSession();
    scheduleServerSave();
  }
  store.markDirty = markDirty;

  // The pointer (which project, unsaved or not) lives in localStorage; the draft
  // project itself goes to IndexedDB, which has room for pictures.
  function saveSessionNow() {
    if (!state.project) return;
    const ptr = { projectId: state.projectId, dirty: state.dirty, savedAt: Date.now() };
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(ptr)); } catch (e) { /* storage blocked */ }
    if (SM.api && SM.api.saveDraft) SM.api.saveDraft({ ...ptr, project: state.project });
  }
  const saveSession = SM.debounce(saveSessionNow, 600);
  store.loadSession = async function () {
    let ptr = null;
    try { ptr = JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch (e) { ptr = null; }
    const draft = SM.api && SM.api.loadDraft ? await SM.api.loadDraft() : null;
    if (draft && draft.project && (!ptr || (draft.savedAt || 0) >= (ptr.savedAt || 0) - 5000)) return draft;
    return ptr && ptr.project ? ptr : (draft || ptr);
  };

  let saveTimer = null;
  function scheduleServerSave() {
    clearTimeout(saveTimer);
    const secs = Number(SM.settings.autosaveSeconds) || 0;
    if (secs <= 0) return;
    saveTimer = setTimeout(() => store.save({ silent: true }), secs * 1000);
  }

  store.save = async function (opts) {
    opts = opts || {};
    if (!state.project || state.saving) return;
    state.saving = true;
    SM.bus.emit("savestate");
    const p = state.project;
    if (SM.map) p.viewport = SM.mapview.viewport();
    try {
      if (state.projectId) {
        await SM.api.updateProject(state.projectId, p.name, p);
      } else {
        const r = await SM.api.createProject(p.name, p);
        state.projectId = r.id;
      }
      state.dirty = false;
      state.saveError = null;
      if (!opts.silent) SM.toast("Project saved", "ok", 1800);
    } catch (e) {
      state.saveError = e.message;
      SM.toast("Save failed: " + e.message + " — use Export → Project backup to keep a copy", "error", 6000);
    } finally {
      state.saving = false;
      saveSessionNow();
      SM.bus.emit("savestate");
    }
  };

  window.addEventListener("beforeunload", () => saveSessionNow());
})(window.SM);
